//! Production reliability (beta checklist):
//!
//! * `atomic_write` — write-to-temp + fsync + rename; a crash mid-save
//!   can never leave a half-written document (partial writes were the
//!   review's corruption vector).
//! * autosave — periodic snapshot to `<doc>.autosave` via atomic_write;
//!   `check_crash_recovery` offers it back when it's newer than the doc.
//! * rolling backups — `<doc>.bak1..bakN` rotate on every explicit save,
//!   giving a recovery HISTORY, not just the latest state.
//! * corruption recovery — the lenient loader already exists
//!   (`load_x_lenient`); `open_with_recovery` chains: exact parse →
//!   autosave → lenient recovery → newest backup.
//! * `upgrade_legacy_library_hashes` — pre-integrity documents get
//!   hashes computed from their (trusted-on-first-open) snapshots, so
//!   the LegacyUnhashed state converges to Verified.
//! * recent files — tiny MRU list under the user cache dir.

use crate::xlib::library_hash;
use std::io::Write;
use std::path::{Path, PathBuf};
use x_core::Document;

// ------------------------------------------------------------ atomic write

/// Write-to-temp + fsync + atomic rename. Same-directory temp file so the
/// rename cannot cross filesystems.
pub fn atomic_write(path: &str, contents: &[u8]) -> std::io::Result<()> {
    atomic_write_path(Path::new(path), contents)
}

pub fn atomic_write_path(p: &Path, contents: &[u8]) -> std::io::Result<()> {
    crate::cancellation::checkpoint().map_err(std::io::Error::other)?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = p
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let (tmp, mut f) = loop {
        let mut name = std::ffi::OsString::from(".");
        name.push(p.file_name().unwrap_or(std::ffi::OsStr::new("out")));
        name.push(format!(
            ".tmp{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let tmp = dir.join(name);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&tmp) {
            Ok(f) => break (tmp, f),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    let result = (|| {
        if let Ok(meta) = std::fs::metadata(p) {
            f.set_permissions(meta.permissions())?;
        }
        for chunk in contents.chunks(64 * 1024) {
            crate::cancellation::checkpoint().map_err(std::io::Error::other)?;
            f.write_all(chunk)?;
        }
        f.sync_all()?;
        drop(f);
        crate::cancellation::commit(|| {
            std::fs::rename(&tmp, p)?;
            #[cfg(unix)]
            std::fs::File::open(dir)?.sync_all()?;
            Ok(())
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Serialize explicit saves within this process. Never replace the document
/// unless retaining the previous version has succeeded.
pub fn save_with_backups(path: &str, contents: &[u8]) -> std::io::Result<()> {
    save_with_backups_checked(Path::new(path), contents, None)
}

/// Serialize cooperating processes and reject externally changed native files.
/// OS advisory locks release automatically after a crash; the zero-byte sidecar
/// may remain, but does not become a stale lock.
pub fn save_with_backups_checked(
    path: &Path,
    contents: &[u8],
    expected_hash: Option<&str>,
) -> std::io::Result<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _lock = native_save_lock(path)?;
    let old = match crate::read_bounded(path) {
        Ok(bytes) => Some(bytes),
        Err(_) if !path.exists() => None,
        Err(e) => return Err(std::io::Error::other(e)),
    };
    if let Some(expected) = expected_hash {
        if old
            .as_ref()
            .is_none_or(|bytes| x_core::hash_bytes(bytes) != expected && bytes != contents)
        {
            return Err(std::io::Error::other("file changed on disk; use Save As or reopen before overwriting another writer's work"));
        }
    }
    let backup = |n| {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".bak{n}"));
        PathBuf::from(name)
    };
    if let Some(old) = old {
        for n in (1..BACKUP_DEPTH).rev() {
            let src = backup(n);
            if src.exists() {
                std::fs::rename(src, backup(n + 1))?;
            }
        }
        atomic_write_path(&backup(1), &old)?;
    }
    atomic_write_path(path, contents)
}

fn native_save_lock(path: &Path) -> std::io::Result<std::fs::File> {
    let mut lock_name = path.as_os_str().to_owned();
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    if std::fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(std::io::Error::other("refusing symlinked save lock"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(&lock_path)?;
    lock.try_lock().map_err(|e| {
        std::io::Error::other(format!("another process may be saving this file: {e}"))
    })?;
    Ok(lock)
}

/// Only attach recovery to the native file when it is still the version that
/// this editor loaded. A conflict/busy writer sends the caller to its private
/// recovery file instead of creating a misleading newer native sidecar.
pub fn autosave_if_current(
    path: &Path,
    expected_hash: Option<&str>,
    contents: &[u8],
) -> std::io::Result<bool> {
    let Some(expected) = expected_hash else {
        return Ok(false);
    };
    let Ok(_lock) = native_save_lock(path) else {
        return Ok(false);
    };
    let matches = crate::read_bounded(path)
        .ok()
        .is_some_and(|bytes| x_core::hash_bytes(&bytes) == expected);
    if !matches {
        return Ok(false);
    }
    let mut sidecar = path.as_os_str().to_owned();
    sidecar.push(".autosave");
    atomic_write_path(Path::new(&sidecar), contents)?;
    Ok(true)
}

/// Platform-appropriate local application storage. Override for portable mode/tests.
pub fn user_data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("X_NATIVE_DATA_DIR") {
        return p.into();
    }
    #[cfg(target_os = "windows")]
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(p).join("X-Native");
    }
    #[cfg(target_os = "macos")]
    if let Some(p) = std::env::var_os("HOME") {
        return PathBuf::from(p).join("Library/Application Support/X-Native");
    }
    if let Some(p) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(p).join("x-native");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".local/share/x-native")
}

// ---------------------------------------------------------------- autosave

pub fn autosave_path(doc_path: &str) -> String {
    format!("{doc_path}.autosave")
}

/// Atomic autosave snapshot. Returns bytes written.
pub fn autosave(doc_path: &str, serialized: &str) -> std::io::Result<usize> {
    atomic_write(&autosave_path(doc_path), serialized.as_bytes())?;
    Ok(serialized.len())
}

/// After a clean save the autosave is stale — drop it so crash recovery
/// never offers an OLDER state than the document itself.
pub fn clear_autosave(doc_path: &str) {
    let _ = std::fs::remove_file(autosave_path(doc_path));
}

/// Crash recovery check: an autosave file that exists at startup means
/// the last session did NOT exit through a clean save.
pub fn check_crash_recovery(doc_path: &str) -> Option<String> {
    let path = autosave_path(doc_path);
    let auto = std::fs::metadata(&path).ok()?.modified().ok()?;
    if let Ok(main) = std::fs::metadata(doc_path).and_then(|m| m.modified()) {
        if auto <= main {
            return None;
        }
    }
    String::from_utf8(crate::read_bounded(Path::new(&path)).ok()?).ok()
}

// ----------------------------------------------------------------- backups

pub const BACKUP_DEPTH: usize = 3;

fn backup_path(doc_path: &str, n: usize) -> String {
    format!("{doc_path}.bak{n}")
}

/// Rotate backups before an explicit save: bak2->bak3, bak1->bak2,
/// current doc -> bak1. Recovery HISTORY, not just latest.
pub fn rotate_backups(doc_path: &str) {
    for n in (1..BACKUP_DEPTH).rev() {
        let _ = std::fs::rename(backup_path(doc_path, n), backup_path(doc_path, n + 1));
    }
    if Path::new(doc_path).exists() {
        let _ = std::fs::copy(doc_path, backup_path(doc_path, 1));
    }
}

/// List existing backups, newest first.
pub fn list_backups(doc_path: &str) -> Vec<String> {
    (1..=BACKUP_DEPTH)
        .map(|n| backup_path(doc_path, n))
        .filter(|p| Path::new(p).exists())
        .collect()
}

// ------------------------------------------------------------ open chain

/// What `open_with_recovery` had to do to produce a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenOutcome {
    Clean,
    /// autosave was newer/present — crash recovery applied
    RecoveredFromAutosave,
    /// lenient brace-balance recovery on the main file
    RecoveredLenient(usize),
    /// fell back to a rolling backup
    RecoveredFromBackup(String),
}

/// The full recovery chain: exact parse → autosave → lenient → backups.
pub fn open_with_recovery(doc_path: &str) -> Option<(Document, OpenOutcome)> {
    // 0. crash marker: an autosave beats the main file when present
    if let Some(auto_text) = check_crash_recovery(doc_path) {
        if let Ok(d) = crate::load_x_any(&auto_text).map(|d| d.doc) {
            if !d.pages.is_empty() && crate::validate_admission(&d).is_ok() {
                return Some((d, OpenOutcome::RecoveredFromAutosave));
            }
        }
    }
    let text = crate::read_bounded(Path::new(doc_path))
        .ok()
        .and_then(|b| String::from_utf8(b).ok());
    if let Some(t) = &text {
        // 1. exact
        if let Ok(d) = crate::load_x_any(t).map(|d| d.doc) {
            if !d.pages.is_empty() && crate::validate_admission(&d).is_ok() {
                return Some((d, OpenOutcome::Clean));
            }
        }
        // 2. lenient
        let (d2, notes) = crate::load_x_lenient(t);
        if !d2.doc.pages.is_empty() && crate::validate_admission(&d2.doc).is_ok() {
            return Some((d2.doc, OpenOutcome::RecoveredLenient(notes.len())));
        }
    }
    // 3. backups, newest first
    for b in list_backups(doc_path) {
        if let Some(bt) = crate::read_bounded(Path::new(&b))
            .ok()
            .and_then(|v| String::from_utf8(v).ok())
        {
            if let Ok(d) = crate::load_x_any(&bt).map(|d| d.doc) {
                if !d.pages.is_empty() && crate::validate_admission(&d).is_ok() {
                    return Some((d, OpenOutcome::RecoveredFromBackup(b)));
                }
            }
        }
    }
    None
}

// ----------------------------------------------- legacy integrity upgrade

/// Pre-integrity documents carry snapshots but empty hashes. On first
/// open we trust the embedded snapshot (it's what the doc was rendering
/// all along) and pin its hash so future tampering IS detected.
/// Returns upgraded library ids.
pub fn upgrade_legacy_library_hashes(doc: &mut Document) -> Vec<String> {
    let mut upgraded = vec![];
    for dep in &mut doc.library_deps {
        if dep.snapshot_hash.is_empty() {
            if let Some(snap) = doc.library_snapshots.get(&dep.library_id) {
                dep.snapshot_hash = library_hash(snap);
                upgraded.push(dep.library_id.clone());
            }
        }
    }
    upgraded
}

// ------------------------------------------------------------ recent files

fn recent_path() -> PathBuf {
    user_data_dir().join("recent.txt")
}

const MAX_RECENTS: usize = 24;

fn read_path_list(path: &Path) -> Vec<String> {
    let Some(bytes) = crate::read_bounded(path)
        .ok()
        .filter(|b| b.len() < 1024 * 1024)
    else {
        return vec![];
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return vec![];
    };
    if text.trim_start().starts_with('[') {
        crate::json::parse(&text)
            .ok()
            .and_then(|v| v.arr().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.str().map(str::to_owned))
            .take(MAX_RECENTS)
            .collect()
    } else {
        text.lines()
            .filter(|l| !l.is_empty())
            .take(MAX_RECENTS)
            .map(str::to_owned)
            .collect()
    }
}
fn write_path_list(path: &Path, paths: &[String]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = format!(
        "[{}]",
        paths
            .iter()
            .map(|p| format!("\"{}\"", crate::serialize::esc(p)))
            .collect::<Vec<_>>()
            .join(",")
    );
    atomic_write_path(path, text.as_bytes())
}
pub fn recent_files() -> Vec<String> {
    read_path_list(&recent_path())
}

static RECENTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn try_push_recent(path: &str) -> std::io::Result<()> {
    let _guard = RECENTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut files = recent_files();
    files.retain(|f| f != path);
    files.insert(0, path.to_owned());
    files.truncate(MAX_RECENTS);
    write_path_list(&recent_path(), &files)
}
pub fn push_recent(path: &str) {
    let _ = try_push_recent(path);
}

/// Drop one path from the MRU list (a Recents card whose file is gone).
pub fn try_forget_recent(path: &str) -> std::io::Result<()> {
    let _guard = RECENTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut files = recent_files();
    let before = files.len();
    files.retain(|f| f != path);
    if files.len() == before {
        return Ok(());
    }
    write_path_list(&recent_path(), &files)
}
pub fn forget_recent(path: &str) {
    let _ = try_forget_recent(path);
}

/// Paths that still exist as files — Recents must never keep a ghost.
pub fn keep_existing_paths(files: Vec<String>) -> Vec<String> {
    files
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .collect()
}

/// Rewrite the MRU list without missing files. Returns how many were dropped.
pub fn prune_missing_recents() -> usize {
    let _guard = RECENTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let files = recent_files();
    let kept = keep_existing_paths(files.clone());
    let n = files.len() - kept.len();
    if n > 0 {
        let _ = write_path_list(&recent_path(), &kept);
    }
    n
}
pub fn starred_files() -> Vec<String> {
    read_path_list(&user_data_dir().join("starred.json"))
}
pub fn set_starred(path: &str, starred: bool) -> std::io::Result<()> {
    let mut files = starred_files();
    files.retain(|f| f != path);
    if starred {
        files.insert(0, path.into());
    }
    files.truncate(MAX_RECENTS);
    write_path_list(&user_data_dir().join("starred.json"), &files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    fn tmp(name: &str) -> String {
        format!(
            "{}/xn-rel-{}-{name}",
            std::env::temp_dir().display(),
            std::process::id()
        )
    }

    fn doc() -> Document {
        let mut d = Document::new();
        d.pages
            .push(Node::frame("p", 100.0, 100.0).child(Node::rect(
                "r",
                0.0,
                0.0,
                10.0,
                10.0,
                Color::BLACK,
            )));
        d
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp() {
        let p = tmp("atomic.x");
        atomic_write(&p, b"one").unwrap();
        atomic_write(&p, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let dir = std::path::Path::new(&p).parent().unwrap();
        let leftovers = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("atomic.x.tmp"))
            .count();
        assert_eq!(leftovers, 0, "no temp files left behind");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn crash_recovery_prefers_autosave_and_clean_save_clears_it() {
        let p = tmp("crash.x");
        let older = crate::save_x(&doc());
        atomic_write(&p, older.as_bytes()).unwrap();
        // Deterministic freshness, including filesystems with coarse mtimes.
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(60),
                ),
            )
            .unwrap();
        // "crash": autosave with an extra page exists
        let mut newer = doc();
        newer.pages.push(Node::frame("p2", 50.0, 50.0));
        autosave(&p, &crate::save_x(&newer)).unwrap();
        let (d, outcome) = open_with_recovery(&p).unwrap();
        assert_eq!(outcome, OpenOutcome::RecoveredFromAutosave);
        assert_eq!(d.pages.len(), 2, "autosave content won");
        // clean save clears the marker -> next open is Clean
        clear_autosave(&p);
        let (_, outcome) = open_with_recovery(&p).unwrap();
        assert_eq!(outcome, OpenOutcome::Clean);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn recovery_chain_lenient_then_backup() {
        let p = tmp("chain.x");
        let good = crate::save_x(&doc());
        // backup holds a good copy; main file is 75% truncated
        atomic_write(&p, good.as_bytes()).unwrap();
        rotate_backups(&p); // -> bak1
        let cut = &good[..good.len() * 3 / 4];
        atomic_write(&p, cut.as_bytes()).unwrap();
        let (d, outcome) = open_with_recovery(&p).unwrap();
        match outcome {
            OpenOutcome::RecoveredLenient(_) | OpenOutcome::RecoveredFromBackup(_) => {}
            other => panic!("expected recovery, got {other:?}"),
        }
        assert!(!d.pages.is_empty());
        // fully garbage main file -> backup is the only path
        atomic_write(&p, b"@@@@ not json at all").unwrap();
        let (d2, outcome2) = open_with_recovery(&p).unwrap();
        assert!(
            matches!(outcome2, OpenOutcome::RecoveredFromBackup(_)),
            "got {outcome2:?}"
        );
        assert!(!d2.pages.is_empty());
        for b in list_backups(&p) {
            let _ = std::fs::remove_file(b);
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn backups_rotate_with_history() {
        let p = tmp("rot.x");
        for i in 0..4 {
            atomic_write(&p, format!("gen{i}").as_bytes()).unwrap();
            rotate_backups(&p);
        }
        // after 4 gens: bak1=gen3? NO — rotate happens BEFORE next write in
        // real flow; here bak1 holds the most recently rotated content
        let baks = list_backups(&p);
        assert_eq!(baks.len(), BACKUP_DEPTH, "history depth capped");
        let b1 = std::fs::read_to_string(&baks[0]).unwrap();
        let b2 = std::fs::read_to_string(&baks[1]).unwrap();
        assert_ne!(b1, b2, "distinct generations retained");
        for b in baks {
            let _ = std::fs::remove_file(b);
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn legacy_hash_upgrade_converges_to_verified() {
        use x_core::{Library, LibraryDependency, Paint};
        let mut lib = Library {
            library_id: "L".into(),
            name: "L".into(),
            version: 1,
            ..Default::default()
        };
        lib.styles.insert(
            "s".into(),
            x_core::LegacyStyle::Paint {
                fill: Paint::Solid(Color::BLACK),
            },
        );
        let mut d = doc();
        d.library_deps.push(LibraryDependency {
            library_id: "L".into(),
            resolved_version: 1,
            snapshot_hash: String::new(),
            source_path: "l.xlib".into(),
        });
        d.library_snapshots.insert("L".into(), lib);
        // legacy: unhashed
        let st = crate::verify_document_libraries(&d);
        assert_eq!(st[0].1, crate::IntegrityStatus::LegacyUnhashed);
        let upgraded = upgrade_legacy_library_hashes(&mut d);
        assert_eq!(upgraded, vec!["L".to_string()]);
        let st = crate::verify_document_libraries(&d);
        assert_eq!(st[0].1, crate::IntegrityStatus::Verified, "converged");
    }
}

#[cfg(test)]
mod safety_regressions {
    use super::*;
    fn path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{}-{name}", x_core::fresh_id("persistence-test")))
    }
    #[test]
    fn failed_backup_rotation_preserves_main_bytes() {
        let p = path("doc.x");
        let s = p.to_string_lossy();
        std::fs::write(&p, b"original").unwrap();
        std::fs::write(backup_path(&s, 2), b"backup").unwrap();
        let blocked = backup_path(&s, 3);
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(Path::new(&blocked).join("keep"), b"x").unwrap();
        assert!(save_with_backups(&s, b"replacement").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"original");
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(backup_path(&s, 2));
        let _ = std::fs::remove_dir_all(blocked);
    }
    #[test]
    fn stale_autosave_cannot_replace_a_newer_main() {
        let p = path("main.x");
        let s = p.to_string_lossy();
        std::fs::write(&p, b"newer").unwrap();
        autosave(&s, "older").unwrap();
        std::fs::File::options()
            .write(true)
            .open(autosave_path(&s))
            .unwrap()
            .set_times(
                std::fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(60),
                ),
            )
            .unwrap();
        assert!(check_crash_recovery(&s).is_none());
        clear_autosave(&s);
        let _ = std::fs::remove_file(p);
    }
    #[test]
    fn recent_path_serialization_roundtrips_quotes_newlines_and_unicode() {
        let p = path("recent.json");
        let paths = vec![
            "/tmp/a\"b.x".into(),
            "/tmp/a\nb.x".into(),
            "/tmp/नमस्ते.x".into(),
        ];
        write_path_list(&p, &paths).unwrap();
        assert_eq!(read_path_list(&p), paths);
        let _ = std::fs::remove_file(p);
    }
    #[test]
    fn keep_existing_paths_drops_missing_files() {
        let p = path("exists.x");
        std::fs::write(&p, b"ok").unwrap();
        let missing = path("gone.x");
        let kept = keep_existing_paths(vec![
            p.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ]);
        assert_eq!(kept, vec![p.to_string_lossy().to_string()]);
        let _ = std::fs::remove_file(&p);
    }
    #[test]
    fn held_os_save_lock_prevents_an_overwrite() {
        let p = path("locked.x");
        let s = p.to_string_lossy();
        std::fs::write(&p, b"original").unwrap();
        let lock = std::fs::File::create(format!("{s}.lock")).unwrap();
        lock.try_lock().unwrap();
        assert!(save_with_backups(&s, b"new").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"original");
        drop(lock);
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(format!("{s}.lock"));
    }
}
