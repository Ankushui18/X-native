//! Library lifecycle end-to-end (review item: "local vs library" done
//! deliberately — versioning first, review-accept updates, no silent
//! changes, no object copying).

use std::collections::HashMap;
use x_native::fileio::{
    library_hash, load_x, load_xlib, save_x, save_xlib, verify_dependency,
    verify_document_libraries, IntegrityStatus,
};
use x_native::{
    accept_update, bind_style, diff_library, resolve_library_style, resolve_library_styles, Color,
    Document, LegacyStyle, Library, LibraryChange, LibraryDependency, LibraryRef, Node, Paint,
};

fn brand(version: u32, primary: Color) -> Library {
    let mut l = Library {
        library_id: "brand-system".into(),
        name: "Brand System".into(),
        version,
        ..Default::default()
    };
    l.styles.insert(
        "Primary/500".into(),
        LegacyStyle::Paint {
            fill: Paint::Solid(primary),
        },
    );
    l.variables.numbers.insert("radius".into(), 8.0);
    l.components.push(
        Node::component("m-btn", "Button", 100.0, 40.0)
            .child(Node::rect("bg", 0.0, 0.0, 100.0, 40.0, primary)),
    );
    l
}

#[test]
fn full_lifecycle_link_pin_update_review_accept_persist() {
    // 1. a library ships as .xlib (byte-stable artifact)
    let v1 = brand(1, Color::from_rgb8(0x33, 0x66, 0xFF));
    let xlib_text = save_xlib(&v1);
    let loaded = load_xlib(&xlib_text).expect("xlib loads");
    assert_eq!(loaded.version, 1);

    // 2. a document links it: pinned dep + snapshot + library:// binding
    let mut doc = Document::new();
    doc.pages
        .push(Node::frame("p1", 400.0, 300.0).child(Node::rect(
            "hero",
            20.0,
            20.0,
            100.0,
            60.0,
            Color::BLACK,
        )));
    doc.library_deps.push(LibraryDependency {
        library_id: "brand-system".into(),
        resolved_version: 1,
        snapshot_hash: x_native::fileio::library_hash(&v1),
        source_path: "brand.xlib".into(),
    });
    doc.library_snapshots.insert("brand-system".into(), loaded);
    let r = LibraryRef::style("brand-system", "Primary/500");
    let def = resolve_library_style(&doc.library_snapshots, &r)
        .unwrap()
        .clone();
    bind_style(&mut doc.pages[0].children[0], &r.uri(), &def);
    assert_eq!(
        doc.pages[0].children[0].fill,
        Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF))
    );

    // 3. persistence: .x carries dep + snapshot; reload works WITHOUT the
    //    .xlib file existing anywhere (self-contained document)
    let text = save_x(&doc);
    assert!(text.contains("\"libraries\":["));
    assert!(text.contains("library://brand-system/style/Primary/500"));
    let mut re = load_x(&text).expect("reload");
    assert_eq!(re.library_deps.len(), 1);
    assert_eq!(re.library_deps[0].resolved_version, 1);
    assert!(
        re.library_snapshots.contains_key("brand-system"),
        "snapshot restored"
    );
    assert_eq!(save_x(&re), text, "byte-stable with libraries present");
    // resolving from the restored snapshot still lands v1's color
    let n = resolve_library_styles(&mut re.pages[0], &re.library_snapshots);
    assert_eq!(n, 1);
    assert_eq!(
        re.pages[0].children[0].fill,
        Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF))
    );

    // 4. v2 appears on disk. NOTHING changes until review+accept.
    let v2 = brand(2, Color::from_rgb8(0x66, 0x33, 0xFF));
    resolve_library_styles(&mut re.pages[0], &re.library_snapshots);
    assert_eq!(
        re.pages[0].children[0].fill,
        Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF)),
        "pinned v1 protects the document from v2's existence"
    );

    // 5. review: diff between pinned snapshot and v2
    let pinned = re.library_snapshots.get("brand-system").unwrap();
    let changes = diff_library(pinned, &v2);
    assert_eq!(
        changes,
        vec![LibraryChange::StyleModified("Primary/500".into())]
    );

    // 6. accept: repin + update consumers
    let mut dep = re.library_deps[0].clone();
    let mut snapshots = re.library_snapshots.clone();
    let mut pages = re.pages.clone();
    let (accepted, updated) = accept_update(&mut dep, &mut snapshots, &mut pages, v2);
    assert_eq!(accepted.len(), 1);
    assert_eq!(dep.resolved_version, 2);
    assert_eq!(updated, 1);
    assert_eq!(
        pages[0].children[0].fill,
        Paint::Solid(Color::from_rgb8(0x66, 0x33, 0xFF))
    );

    // 7. the updated pin persists
    let mut doc2 = Document::new();
    doc2.pages = pages;
    doc2.library_deps = vec![dep];
    doc2.library_snapshots = snapshots;
    let text2 = save_x(&doc2);
    let re2 = load_x(&text2).unwrap();
    assert_eq!(re2.library_deps[0].resolved_version, 2);
}

#[test]
fn library_refs_are_not_copies() {
    // the document's style registry stays EMPTY — the binding points at
    // the library uri; only the snapshot holds the definition
    let v1 = brand(1, Color::from_rgb8(0x33, 0x66, 0xFF));
    let mut doc = Document::new();
    doc.pages
        .push(Node::frame("p", 100.0, 100.0).child(Node::rect(
            "a",
            0.0,
            0.0,
            10.0,
            10.0,
            Color::BLACK,
        )));
    doc.library_snapshots.insert(v1.library_id.clone(), v1);
    let r = LibraryRef::style("brand-system", "Primary/500");
    let def = resolve_library_style(&doc.library_snapshots, &r)
        .unwrap()
        .clone();
    bind_style(&mut doc.pages[0].children[0], &r.uri(), &def);
    assert!(doc.styles.is_empty(), "no local copy of the library style");
    assert_eq!(
        doc.pages[0].children[0]
            .bindings
            .get("style:paint")
            .map(String::as_str),
        Some("library://brand-system/style/Primary/500"),
        "binding stores the stable library uri"
    );
}

#[test]
fn integrity_verification_catches_corruption() {
    let v1 = brand(1, Color::from_rgb8(0x33, 0x66, 0xFF));
    let hash = library_hash(&v1);
    let dep = LibraryDependency {
        library_id: "brand-system".into(),
        resolved_version: 1,
        snapshot_hash: hash.clone(),
        source_path: "brand.xlib".into(),
    };
    // intact snapshot verifies
    assert_eq!(
        verify_dependency(&dep, Some(&v1)),
        IntegrityStatus::Verified
    );
    // any mutation is caught (a hand-edited style value)
    let mut tampered = v1.clone();
    tampered.styles.insert(
        "Primary/500".into(),
        LegacyStyle::Paint {
            fill: Paint::Solid(Color::BLACK),
        },
    );
    match verify_dependency(&dep, Some(&tampered)) {
        IntegrityStatus::Corrupt { expected, actual } => {
            assert_eq!(expected, hash);
            assert_ne!(actual, hash);
        }
        other => panic!("expected Corrupt, got {other:?}"),
    }
    // missing snapshot + legacy (no hash) statuses
    assert_eq!(
        verify_dependency(&dep, None),
        IntegrityStatus::MissingSnapshot
    );
    let legacy = LibraryDependency {
        snapshot_hash: String::new(),
        ..dep.clone()
    };
    assert_eq!(
        verify_dependency(&legacy, Some(&v1)),
        IntegrityStatus::LegacyUnhashed
    );
}

#[test]
fn integrity_survives_x_roundtrip_and_detects_hand_edits() {
    let v1 = brand(1, Color::from_rgb8(0x33, 0x66, 0xFF));
    let mut doc = Document::new();
    doc.pages.push(Node::frame("p", 100.0, 100.0));
    doc.library_deps.push(LibraryDependency {
        library_id: "brand-system".into(),
        resolved_version: 1,
        snapshot_hash: library_hash(&v1),
        source_path: "brand.xlib".into(),
    });
    doc.library_snapshots.insert("brand-system".into(), v1);
    let text = save_x(&doc);
    // clean reload verifies
    let re = load_x(&text).unwrap();
    let statuses = verify_document_libraries(&re);
    assert_eq!(
        statuses,
        vec![("brand-system".to_string(), IntegrityStatus::Verified)]
    );
    // hand-edit the embedded snapshot color inside the raw .x text —
    // the id is re-derived fine, but the HASH catches the change
    let tampered_text = text.replace("#3366ff", "#000000");
    assert_ne!(
        tampered_text, text,
        "fixture assumes the color appears in .x"
    );
    let tampered = load_x(&tampered_text).unwrap();
    let statuses = verify_document_libraries(&tampered);
    assert!(
        matches!(statuses[0].1, IntegrityStatus::Corrupt { .. }),
        "hand-edited snapshot flagged: {statuses:?}"
    );
    // partial write: truncate the snapshot object -> parse drops it ->
    // MissingSnapshot (never a silent wrong render)
    let cut = &text[..text.find("\"styles\"").unwrap() + 10];
    // outer Err = panic; inner Err = parse error (equally acceptable)
    if let Ok(Ok(d)) = std::panic::catch_unwind(|| load_x(cut)) {
        let st = verify_document_libraries(&d);
        for (_, s) in st {
            assert_ne!(
                s,
                IntegrityStatus::Verified,
                "truncated file must not verify"
            );
        }
    }
}

#[test]
fn accept_update_propagates_component_masters() {
    use x_native::{accept_update, refresh_library_masters};
    let v1 = brand(1, Color::from_rgb8(0x33, 0x66, 0xFF));
    let mut snapshots = HashMap::new();
    snapshots.insert("brand-system".to_string(), v1.clone());
    // page with a placed registry master + instance (the app's layout)
    let mut master = v1.components[0].clone();
    master.id = "libmaster-brand-system-Button".into();
    master.visible = false;
    let mut pages = vec![Node::frame("p", 400.0, 300.0)
        .child(master)
        .child(Node::instance("i1", "Button", 50.0, 50.0, 100.0, 40.0))];
    // v2 recolors the Button master's bg
    let mut v2 = brand(2, Color::from_rgb8(0x66, 0x33, 0xFF));
    v2.components[0].children[0].fill = Paint::Solid(Color::from_rgb8(0x11, 0x22, 0x33));
    let mut dep = LibraryDependency {
        library_id: "brand-system".into(),
        resolved_version: 1,
        snapshot_hash: String::new(),
        source_path: "b.xlib".into(),
    };
    let (_, updated) = accept_update(&mut dep, &mut snapshots, &mut pages, v2);
    assert!(updated >= 1, "master refresh counted");
    let m = x_native::editor::find(&pages[0], "libmaster-brand-system-Button").unwrap();
    assert_eq!(
        m.children[0].fill,
        Paint::Solid(Color::from_rgb8(0x11, 0x22, 0x33)),
        "registry master now carries v2's definition — instances re-render"
    );
    // refresh is idempotent
    assert_eq!(
        refresh_library_masters(&mut pages[0], "brand-system", &snapshots),
        1
    );
}

#[test]
fn freeze_on_corrupt_keeps_values_and_blocks_resolution() {
    use x_native::freeze_unverified;
    let v1 = brand(1, Color::from_rgb8(0x33, 0x66, 0xFF));
    let mut snapshots = HashMap::new();
    snapshots.insert("brand-system".to_string(), v1.clone());
    let mut page =
        Node::frame("p", 100.0, 100.0).child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::BLACK));
    let r = LibraryRef::style("brand-system", "Primary/500");
    let def = resolve_library_style(&snapshots, &r).unwrap().clone();
    bind_style(&mut page.children[0], &r.uri(), &def);
    // corrupt verdict -> library frozen out of the snapshot map
    let frozen = freeze_unverified(&mut snapshots, &[("brand-system".to_string(), false)]);
    assert_eq!(frozen, vec!["brand-system".to_string()]);
    // resolution now SKIPS the binding: last-applied value stays put
    let n = resolve_library_styles(&mut page, &snapshots);
    assert_eq!(n, 0);
    assert_eq!(
        page.children[0].fill,
        Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF)),
        "frozen: value kept, corrupt data never applied"
    );
    // verified libraries survive the freeze pass
    let mut snaps2 = HashMap::new();
    snaps2.insert("ok-lib".to_string(), brand(1, Color::BLACK));
    assert!(freeze_unverified(&mut snaps2, &[("ok-lib".to_string(), true)]).is_empty());
    assert_eq!(snaps2.len(), 1);
}
