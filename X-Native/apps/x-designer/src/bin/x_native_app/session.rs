//! Testable session policy: document history, clipboard, native saves and recovery.
//! No window, GPU or file-dialog dependency here.
use crate::state::{App, OpenDoc, RecentFile};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use x_native::{editor::Editor, Document, Node};

pub fn new_recovery_path() -> PathBuf {
    x_native::fileio::user_data_dir()
        .join("recovery")
        .join(format!("{}.x", x_native::fresh_id("unsaved")))
}

#[derive(Clone)]
struct Snapshot {
    doc: Document,
    editors: Vec<Editor>,
    page: usize,
    name: String,
}

#[derive(Clone)]
enum Change {
    Page { id: String, steps: usize },
    Document(Box<Snapshot>),
}

#[derive(Clone)]
struct Entry {
    change: Change,
    before: u64,
    after: u64,
}

pub struct History {
    undo: Vec<Entry>,
    redo: Vec<Entry>,
    seen: HashMap<String, u64>,
    pub revision: u64,
    pub saved_revision: Option<u64>,
    next_revision: u64,
}

impl Default for History {
    fn default() -> Self {
        Self {
            undo: vec![],
            redo: vec![],
            seen: HashMap::new(),
            revision: 0,
            saved_revision: Some(0),
            next_revision: 0,
        }
    }
}

impl OpenDoc {
    pub fn require_save(&mut self) {
        self.history.saved_revision = None;
        self.dirty = true;
    }

    fn remember_serials(&mut self) {
        self.history.seen = self
            .editors
            .iter()
            .map(|e| (e.root.id.clone(), e.edit_serial))
            .collect();
    }

    fn bump_revision(&mut self) -> (u64, u64) {
        let before = self.history.revision;
        self.history.next_revision += 1;
        self.history.revision = self.history.next_revision;
        (before, self.history.revision)
    }

    pub fn record_page_changes(&mut self, coalesce: bool) {
        for i in 0..self.editors.len() {
            let ed = &self.editors[i];
            let id = ed.root.id.clone();
            let last = self.history.seen.get(&id).copied().unwrap_or(0);
            let steps = ed.edit_serial.saturating_sub(last) as usize;
            if steps == 0 {
                continue;
            }
            let steps = steps.min(ed.undo_depth());
            if steps == 0 {
                continue;
            }
            let (before, after) = self.bump_revision();
            let merged = coalesce
                && self.history.saved_revision != Some(before)
                && self.history.undo.last().is_some_and(
                    |e| matches!(&e.change, Change::Page { id: prev, .. } if *prev == id),
                );
            if merged {
                let entry = self.history.undo.last_mut().unwrap();
                if let Change::Page { steps: n, .. } = &mut entry.change {
                    *n += steps;
                }
                entry.after = after;
            } else {
                self.history.undo.push(Entry {
                    change: Change::Page { id, steps },
                    before,
                    after,
                });
            }
            self.history.redo.clear();
        }
        self.remember_serials();
        self.trim_history();
    }

    fn snapshot(&mut self) -> Snapshot {
        self.sync();
        // Assets are an additive, content-addressed store, not copied into
        // every metadata undo point. Undo may leave unused bytes; never a
        // dangling live asset reference.
        let assets = std::mem::take(&mut self.doc.assets);
        let doc = self.doc.clone();
        self.doc.assets = assets;
        Snapshot {
            doc,
            editors: self.editors.clone(),
            page: self.page,
            name: self.name.clone(),
        }
    }

    /// Start one page/comment/document transaction, after validating the action.
    pub fn checkpoint(&mut self) {
        self.record_page_changes(false);
        let snapshot = self.snapshot();
        let (before, after) = self.bump_revision();
        self.history.undo.push(Entry {
            change: Change::Document(Box::new(snapshot)),
            before,
            after,
        });
        self.history.redo.clear();
        self.dirty = true;
        self.trim_history();
    }

    fn swap_snapshot(&mut self, state: &mut Snapshot) {
        let current = self.snapshot();
        let assets = std::mem::take(&mut self.doc.assets);
        let incoming = std::mem::replace(state, current);
        self.doc = incoming.doc;
        self.doc.assets = assets;
        self.editors = incoming.editors;
        self.page = incoming.page;
        self.name = incoming.name;
        self.frame_cache = x_native::FrameCache::new();
    }

    pub fn finish_document_edit(&mut self) {
        self.remember_serials();
        self.sync();
        self.trim_history();
    }

    pub fn undo_document(&mut self) -> bool {
        self.history_step(false)
    }
    pub fn redo_document(&mut self) -> bool {
        self.history_step(true)
    }

    fn history_step(&mut self, redo: bool) -> bool {
        self.record_page_changes(false);
        let entry = if redo {
            self.history.redo.pop()
        } else {
            self.history.undo.pop()
        };
        let Some(mut entry) = entry else {
            return false;
        };
        match &mut entry.change {
            Change::Page { id, steps } => {
                let Some(i) = self.editors.iter().position(|e| e.root.id == *id) else {
                    return false;
                };
                self.page = i;
                let editor = &mut self.editors[i];
                for _ in 0..*steps {
                    if redo {
                        editor.redo();
                    } else {
                        editor.undo();
                    }
                }
                editor
                    .selection
                    .retain(|id| x_native::editor::find(&editor.root, id).is_some());
            }
            Change::Document(state) => self.swap_snapshot(state),
        }
        self.history.revision = if redo { entry.after } else { entry.before };
        if redo {
            self.history.undo.push(entry);
        } else {
            self.history.redo.push(entry);
        }
        self.remember_serials();
        self.sync();
        self.dirty = Some(self.history.revision) != self.history.saved_revision;

        // QA-003 FIX: Invalidate frame cache to force full re-render
        // This ensures Vello rebuilds the scene from the reverted state
        self.frame_cache = x_native::FrameCache::new();

        true
    }

    fn trim_history(&mut self) {
        fn node_bytes(n: &Node) -> usize {
            std::mem::size_of::<Node>()
                + n.id.len()
                + n.name.len()
                + n.children.iter().map(node_bytes).sum::<usize>()
        }
        let memory = |d: &OpenDoc| {
            d.editors.iter().map(Editor::history_bytes).sum::<usize>()
                + d.history
                    .undo
                    .iter()
                    .chain(&d.history.redo)
                    .map(|e| match &e.change {
                        Change::Page { .. } => 128,
                        Change::Document(s) => {
                            s.doc.memory_breakdown().total()
                                + s.editors
                                    .iter()
                                    .map(|e| node_bytes(&e.root) + e.history_bytes())
                                    .sum::<usize>()
                        }
                    })
                    .sum::<usize>()
        };
        // Preserve at least the newest transaction, even if it alone exceeds
        // this soft budget. Oldest complete transactions are evicted first.
        while self.history.undo.len() > 1
            && (self.history.undo.len() > 128 || memory(self) > 64 * 1024 * 1024)
        {
            let entry = self.history.undo.remove(0);
            if let Change::Page { id, steps } = entry.change {
                if let Some(ed) = self.editors.iter_mut().find(|e| e.root.id == id) {
                    ed.discard_oldest_undo(steps);
                }
            }
        }
    }

    pub fn save_to(&mut self, path: &Path) -> Result<(), String> {
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("x"))
        {
            return Err("native documents must be saved with a .x extension".into());
        }
        if self
            .source_path
            .as_ref()
            .is_some_and(|p| same_path(p, path))
        {
            return Err("refusing to overwrite an imported source".into());
        }
        self.record_page_changes(false);
        self.sync();
        x_native::fileio::validate_admission(&self.doc)?;
        if self.name.len() > 1024 {
            return Err("document title exceeds 1024-byte budget".into());
        }
        let bytes = self.serialized();
        x_native::fileio::admission::validate_encoded(&bytes)?;
        if bytes.len() > x_native::fileio::admission::MAX_INPUT_BYTES {
            return Err("document exceeds the 64 MiB native-file budget".into());
        }
        let expected = self
            .path
            .as_ref()
            .filter(|p| same_path(p, path))
            .and(self.disk_hash.as_deref());
        x_native::fileio::save_with_backups_checked(path, bytes.as_bytes(), expected)
            .map_err(|e| e.to_string())?;
        self.disk_hash = Some(x_native::hash_bytes(bytes.as_bytes()));
        if let Some(old) = &self.path {
            x_native::fileio::clear_autosave(&old.to_string_lossy());
        }
        x_native::fileio::clear_autosave(&path.to_string_lossy());
        self.path = Some(path.to_owned());
        self.canonical_path = path.canonicalize().ok();
        self.file_label = None;
        self.history.saved_revision = Some(self.history.revision);
        self.dirty = false;
        self.last_autosave_revision = Some(self.history.revision);
        let _ = std::fs::remove_file(&self.recovery_path);
        Ok(())
    }

    pub fn autosave_now(&mut self) -> Result<bool, String> {
        self.record_page_changes(false);
        if !self.dirty || self.last_autosave_revision == Some(self.history.revision) {
            return Ok(false);
        }
        self.sync();
        x_native::fileio::validate_admission(&self.doc)?;
        if self.name.len() > 1024 {
            return Err("document title exceeds 1024-byte budget".into());
        }
        let bytes = self.serialized();
        x_native::fileio::admission::validate_encoded(&bytes)?;
        if bytes.len() > x_native::fileio::admission::MAX_INPUT_BYTES {
            return Err("autosave exceeds native-file budget".into());
        }
        let native_saved = if let Some(path) = &self.path {
            x_native::fileio::autosave_if_current(path, self.disk_hash.as_deref(), bytes.as_bytes())
                .map_err(|e| e.to_string())?
        } else {
            false
        };
        self.autosave_note = None;
        if native_saved {
            let _ = std::fs::remove_file(&self.recovery_path);
        } else {
            let parent = self.recovery_path.parent().ok_or("invalid recovery path")?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            x_native::fileio::atomic_write_path(&self.recovery_path, bytes.as_bytes())
                .map_err(|e| e.to_string())?;
            if self.path.is_some() {
                self.autosave_note=Some("Native file changed or is busy; unsaved work kept in a separate recovery copy. Use Save As to reconcile.".into());
            }
        }
        self.last_autosave_revision = Some(self.history.revision);
        Ok(true)
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b
        || a.canonicalize()
            .ok()
            .zip(b.canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
}

impl App {
    pub fn reload_recents(&mut self) {
        let stars = x_native::fileio::starred_files();
        self.recents = x_native::fileio::recent_files()
            .into_iter()
            .map(|path| {
                let starred = stars.contains(&path);
                let path = PathBuf::from(path);
                RecentFile {
                    name: path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    team: "Local file".into(),
                    edited: "Open from disk".into(),
                    color: crate::theme::C_DIM,
                    members: vec![],
                    starred,
                    path: Some(path),
                    icon: "file",
                }
            })
            .collect();
    }
}

/// Close policy defaults to Cancel; only a successful save or an explicit
/// Discard permits removal. Used by both tab and whole-window close.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseChoice {
    Save,
    Discard,
    Cancel,
}
pub fn permits_close(dirty: bool, choice: CloseChoice, save: impl FnOnce() -> bool) -> bool {
    if !dirty {
        return true;
    }
    match choice {
        CloseChoice::Save => save(),
        CloseChoice::Discard => true,
        CloseChoice::Cancel => false,
    }
}

pub fn swap_comment_pages(doc: &mut Document, a: usize, b: usize) {
    for c in &mut doc.comments {
        if c.page == a {
            c.page = b;
        } else if c.page == b {
            c.page = a;
        }
    }
}

#[derive(Clone, Default)]
pub struct Envelope {
    pub uuid: String,
    pub fonts: Vec<(String, String, String)>,
    pub assets: Vec<(String, String, String, String)>,
    pub uuids: std::collections::BTreeMap<String, String>,
}

pub fn load_document_with_progress(
    read_path: &Path,
    extension: &str,
    original: &Path,
    progress: &dyn Fn(crate::loading::Stage),
) -> Result<OpenDoc, String> {
    use crate::loading::Stage;
    progress(Stage::Reading);
    // Bind the conflict fingerprint to the bytes actually decoded, not a
    // second read that might see another writer's newer version.
    let recovery_base = if extension == "x" && read_path != original {
        x_native::fileio::read_bounded(original)
            .ok()
            .map(|b| x_native::hash_bytes(&b))
    } else {
        None
    };
    let bytes = x_native::fileio::read_bounded(read_path)?;
    let disk_hash = if extension == "x" && read_path == original {
        Some(x_native::hash_bytes(&bytes))
    } else {
        recovery_base
    };
    let as_text = || std::str::from_utf8(&bytes).map_err(|e| e.to_string());
    let stem = original
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    progress(if extension == "sketch" {
        Stage::Decompressing
    } else {
        Stage::Parsing
    });
    let (doc, envelope, title) = match extension {
        "x" => {
            let d = x_native::fileio::load_x_any(as_text()?)?;
            let title = if d.metadata.name.is_empty() || d.metadata.name == "Untitled" {
                stem
            } else {
                d.metadata.name
            };
            (
                d.doc,
                Envelope {
                    uuid: d.metadata.uuid,
                    fonts: d.fonts,
                    assets: d.assets,
                    uuids: d.uuids,
                },
                title,
            )
        }
        "svg" => {
            let page = x_native::fileio::import_svg(as_text()?)?;
            (
                Document {
                    pages: vec![page],
                    ..Default::default()
                },
                Envelope::default(),
                stem,
            )
        }
        "png" => (
            x_native::fileio::import_png(&stem, &bytes)?,
            Envelope::default(),
            stem,
        ),
        "sketch" => (
            x_native::fileio::import_sketch(&bytes)?,
            Envelope::default(),
            stem,
        ),
        "fig" => (
            x_native::fileio::import_fig_bytes(&bytes)?,
            Envelope::default(),
            stem,
        ),
        "json" => (
            x_native::fileio::import_figma_json(as_text()?)?,
            Envelope::default(),
            stem,
        ),
        other => return Err(format!("unsupported file type .{other}")),
    };
    progress(Stage::Validating);
    x_native::fileio::validate_admission(&doc)?;
    progress(Stage::Building);
    let native = extension == "x";
    let mut open = OpenDoc::from_document(title, native.then(|| original.to_owned()), doc);
    open.envelope = envelope;
    open.disk_hash = disk_hash;
    open.source_path = (!native).then(|| original.to_owned());
    if !native {
        open.require_save();
    }
    progress(Stage::Assets);
    open.assets.sync_store_cancellable(
        &open.doc.assets,
        &x_native::fileio::cancellation::is_cancelled,
    )?;
    x_native::fileio::cancellation::checkpoint()?;
    Ok(open)
}

impl OpenDoc {
    fn serialized(&mut self) -> String {
        if self.envelope.uuid.is_empty() {
            self.envelope.uuid = x_native::fresh_id("document");
        }
        let mut live = std::collections::BTreeMap::new();
        for page in &self.doc.pages {
            x_native::fileio::v2::backfill_uuids(page, &mut live);
        }
        for (key, value) in &mut live {
            if let Some(previous) = self.envelope.uuids.get(key) {
                *value = previous.clone();
            }
        }
        self.envelope.uuids = live;
        let d = x_native::fileio::DocumentV2 {
            doc: self.doc.clone(),
            metadata: x_native::fileio::Metadata {
                name: self.name.clone(),
                uuid: self.envelope.uuid.clone(),
                app_version: env!("CARGO_PKG_VERSION").into(),
            },
            fonts: self.envelope.fonts.clone(),
            assets: self.envelope.assets.clone(),
            uuids: self.envelope.uuids.clone(),
        };
        x_native::fileio::save_x_v2(&d)
    }

    pub fn asset_warnings(&self) -> String {
        let mut missing = std::collections::HashSet::new();
        fn refs(
            n: &Node,
            assets: &x_native::Assets,
            missing: &mut std::collections::HashSet<String>,
        ) {
            if let x_native::NodeKind::Image { asset, .. } = &n.kind {
                if assets.get(asset).is_none() {
                    missing.insert(asset.clone());
                }
            }
            for paint in n
                .active_fills()
                .iter()
                .map(|p| &p.paint)
                .chain(n.active_strokes().iter().map(|s| &s.stroke.paint))
            {
                if let x_native::Paint::Pattern { asset, .. } = paint {
                    if assets.get(asset).is_none() {
                        missing.insert(asset.clone());
                    }
                }
            }
            for c in &n.children {
                refs(c, assets, missing);
            }
        }
        for e in &self.editors {
            refs(&e.root, &self.assets, &mut missing);
        }
        for r in self.doc.assets.iter_sorted() {
            if r.mime.starts_with("image/") && self.assets.get(&r.id).is_none() {
                missing.insert(r.id.clone());
            }
        }
        if missing.is_empty() {
            String::new()
        } else {
            format!(
                "{} missing, unsupported or invalid image asset(s)",
                missing.len()
            )
        }
    }
}

/// Safe recovery candidate: a valid complete backup first; explicitly labelled
/// prefix repair only if no backup is usable. Always requires Save As.
#[cfg(test)]
pub fn recovery_candidate(path: &Path) -> Option<(OpenDoc, String)> {
    recovery_candidate_with_progress(path, &|_| {})
}
pub fn recovery_candidate_with_progress(
    path: &Path,
    progress: &dyn Fn(crate::loading::Stage),
) -> Option<(OpenDoc, String)> {
    for backup in x_native::fileio::list_backups(&path.to_string_lossy()) {
        if let Ok(mut doc) = load_document_with_progress(Path::new(&backup), "x", path, progress) {
            doc.path = None;
            doc.canonical_path = None;
            doc.source_path = Some(path.to_owned());
            doc.require_save();
            doc.name = format!(
                "{} recovered",
                doc.name.chars().take(240).collect::<String>()
            );
            return Some((doc, format!("an intact backup: {backup}")));
        }
    }
    progress(crate::loading::Stage::Reading);
    let bytes = x_native::fileio::read_bounded(path).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    progress(crate::loading::Stage::Validating);
    let (d, notes) = x_native::fileio::load_x_lenient(text);
    if d.doc.pages.is_empty() || x_native::fileio::validate_admission(&d.doc).is_err() {
        return None;
    }
    let name = format!("{} recovered", path.file_stem()?.to_string_lossy());
    progress(crate::loading::Stage::Building);
    let mut open = OpenDoc::from_document(name, None, d.doc);
    open.envelope = Envelope {
        uuid: d.metadata.uuid,
        fonts: d.fonts,
        assets: d.assets,
        uuids: d.uuids,
    };
    open.source_path = Some(path.to_owned());
    open.require_save();
    progress(crate::loading::Stage::Assets);
    open.assets.sync_store(&open.doc.assets);
    Some((
        open,
        format!(
            "a partial repair ({} recovery notes); some content may be missing",
            notes.len()
        ),
    ))
}
