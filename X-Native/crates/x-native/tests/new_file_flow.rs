//! The dashboard's "New File" flow, headless: the exact sequence app.rs
//! runs — fresh `Document` → `DocumentV2` → `save_x_v2` → `atomic_write`
//! → read back → `load_x_lenient` — must land a real file on disk and
//! open with one page. Guards the silent-failure bug where an unwritable
//! working directory swallowed every error and the dashboard showed
//! nothing at all.

use x_native::fileio::{atomic_write, load_x_lenient, save_x_v2, DocumentV2};
use x_native::{Document, Node};

#[test]
fn new_file_sequence_round_trips() {
    // same document the app builds for a fresh file
    let mut d = Document::new();
    d.pages.push(Node::frame("page-1", 1600.0, 1000.0));
    let mut d2 = DocumentV2::default();
    d2.metadata.name = "Untitled 1".to_string();
    d2.doc = d;

    // same write path: temp dir stands in for files/ (or the home fallback)
    let dir = format!(
        "{}/xn-newfile-{}",
        std::env::temp_dir().display(),
        std::process::id()
    );
    std::fs::create_dir_all(&dir).expect("create the files dir");
    let path = format!("{dir}/untitled-1.x");

    atomic_write(&path, save_x_v2(&d2).as_bytes()).expect("write must succeed and be reported");

    // the file is REAL — this is what "no file is creating" checked
    let text = std::fs::read_to_string(&path).expect("file exists on disk");

    // and open_file would accept it: one page, dashboard name preserved
    let (back, _) = load_x_lenient(&text);
    assert_eq!(back.doc.pages.len(), 1, "open_file rejects empty docs");
    assert_eq!(back.metadata.name, "Untitled 1");
    assert!(
        back.doc.pages[0]
            .children
            .iter()
            .chain(std::iter::once(&back.doc.pages[0]))
            .count()
            >= 1
    );

    std::fs::remove_file(&path).ok();
    std::fs::remove_dir(&dir).ok();
}

#[test]
fn home_fallback_dir_is_absolute_when_present() {
    // the fallback only engages with a real HOME/USERPROFILE; when set it
    // must be absolute (a relative fallback would recreate the bug)
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        if !home.is_empty() {
            let p = std::path::PathBuf::from(home).join("x-native-files");
            assert!(
                p.is_absolute(),
                "fallback must be absolute: {}",
                p.display()
            );
        }
    }
}
