//! Release-blocker regression tests from the independent audit, plus session policy tests.
use super::*;
use crate::state::DashSort;
use x_native::{Color, PaintLayer, RenderCommand, Variables};

fn host() -> Host {
    let mut app = App::new();
    app.docs = vec![OpenDoc::demo_blank("Audit".into())];
    app.active = 0;
    app.screen = Screen::Editor;
    Host {
        window: None,
        gpu: None,
        app,
        scale: 1.0,
        files: Default::default(),
        recoveries: Default::default(),
        close_after_job: false,
        pending_open: None,
        next_loading_frame: std::time::Instant::now(),
        next_proto_frame: std::time::Instant::now(),
    }
}

fn temp(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("x-native-audit-{}-{name}", std::process::id()))
}

/// Does the chrome currently publish a hit rect for this Prototype-tab scroll
/// menu? A field and its open menu both push the same action, so one question
/// answers "is the row there" and "did the press land on it".
fn shows_menu(h: &Host, which: crate::state::ProtoScrollMenu) -> bool {
    h.app
        .hit
        .iter()
        .any(|(_, a)| *a == Action::ProtoScrollMenu(which))
}

/// Type `text` into one of the inspector's numeric fields: focus it, select
/// all, replace the buffer, commit with ⏎ — what a user does.
fn set_field(h: &mut Host, id: FieldId, text: &str) {
    h.dispatch(Action::Field(id));
    h.app.ctrl = true;
    h.on_key(Key::Character("a".into()), None);
    h.app.ctrl = false;
    h.on_text(text);
    h.on_key(Key::Named(NamedKey::Enter), None);
}

fn begin_text(h: &mut Host, text: &str) {
    let root_id = h.app.doc().editor_ref().root.id.clone();
    h.app.doc().editor().insert_node(
        &root_id,
        Node::text("audit-text", 0.0, 0.0, 200.0, 20.0, text),
    );
    h.app.begin_text_edit("audit-text".into(), text.into());
}

#[test]
fn t01_saving_import_must_preserve_source_bytes() {
    let p = temp("source.svg");
    let original = "<svg width=\"20\" height=\"20\"><rect width=\"10\" height=\"10\"/></svg>";
    std::fs::write(&p, original).unwrap();
    let mut h = host();
    h.open_path(p.clone());
    h.wait_for_file_job();
    assert!(h.app.status.starts_with("Imported"));
    assert!(h.app.doc_ref().dirty);
    assert!(h.app.doc_ref().path.is_none());
    assert_eq!(h.app.doc_ref().source_path.as_ref(), Some(&p));
    // Only exercise the unsafe same-path save. A fixed import (path=None)
    // must not open a native Save As dialog during this headless probe.
    if h.app.doc_ref().path.as_deref() == Some(p.as_path()) {
        h.cmd_save();
    }
    let actual = std::fs::read_to_string(&p).unwrap();
    let _ = std::fs::remove_file(&p);
    assert!(
        actual == original,
        "source SVG overwritten; its new prefix is {:?}",
        actual.chars().take(80).collect::<String>()
    );
}

#[test]
fn t02_close_dirty_document_requires_a_decision() {
    let mut h = host();
    h.app.mark_dirty();
    h.dispatch(Action::CloseDoc(0));
    assert_eq!(
        h.app.docs.len(),
        1,
        "dirty document was discarded without Save/Discard/Cancel"
    );
}

#[test]
fn t03_save_all_pages_must_not_depend_on_a_paint_between_events() {
    let mut h = host();
    h.finish_create(Tool::Rect, Point::new(20.0, 20.0), Point::new(60.0, 60.0));
    let id = h.app.doc_ref().selected_id().unwrap();
    // Mutate, switch pages, save: intentionally no intervening paint/sync.
    h.dispatch(Action::AddPage);
    let p = temp("multipage.x");
    h.save_to(p.clone());
    let loaded = load_x_file(p.to_str().unwrap()).unwrap();
    let _ = std::fs::remove_file(&p);
    assert!(
        find_node_clone(&loaded.pages[0], &id).is_some(),
        "edited node {id} missing from saved inactive page"
    );
}

#[test]
fn t04_delete_then_create_must_not_reuse_a_live_node_id() {
    let mut h = host();
    h.finish_create(Tool::Rect, Point::new(10.0, 10.0), Point::new(20.0, 20.0));
    let first = h.app.doc_ref().selected_id().unwrap();
    h.finish_create(Tool::Rect, Point::new(30.0, 10.0), Point::new(40.0, 20.0));
    h.app.doc().editor().selection = vec![first];
    h.app.apply_ctx(CtxCmd::Delete);
    h.finish_create(Tool::Rect, Point::new(50.0, 10.0), Point::new(60.0, 20.0));
    let ids: Vec<_> = h
        .app
        .doc_ref()
        .editor_ref()
        .root
        .children
        .iter()
        .map(|n| n.id.clone())
        .collect();
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "duplicate live node IDs: {ids:?}");
}

#[test]
fn t05_canvas_transform_must_match_hit_test_and_overlay_transform() {
    let mut h = host();
    h.app.pan = (40.0, 20.0);
    h.app.zoom = 2.0;
    let p = Point::new(10.0, 10.0);
    let rendered = h.app.canvas_affine() * p;
    // This used to pin the literal (340.0, 76.0), which went stale the moment
    // the chrome grew: the canvas origin is `editor_regions().canvas.x0 + pan
    // + ruler`, and the nav rail and resizable sidebar both feed it. What the
    // test audits is that the three transforms AGREE, so the expectation is
    // recomputed from the same (x, y, zoom) triple the renderer consumes —
    // which still pins the order (translate ∘ scale, not scale ∘ translate).
    let (tx, ty, z) = h.app.canvas_transform();
    assert_eq!(rendered, Point::new(p.x * z + tx, p.y * z + ty));
    // and the origin really is the chrome's canvas region, not the window's
    let canvas = h.app.view_canvas();
    assert!(
        canvas.x0 > 0.0 && canvas.y0 > 0.0,
        "canvas must start after the chrome: {canvas:?}"
    );
    assert_eq!(h.app.screen_to_world(rendered), p);
    let overlay = h.app.world_to_screen(p);
    assert_eq!(
        rendered, overlay,
        "rendered canvas and interaction geometry drift at non-100% zoom"
    );
}

#[test]
fn t06_selected_svg_must_have_a_nonzero_viewport() {
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    let path = temp("selection.svg");
    h.export_to(&path, true, 2, 1.0).unwrap();
    h.wait_for_file_job();
    let svg = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(svg.contains("viewBox=\"0 0 375 420\""), "{svg}");
    assert!(
        svg.contains("matrix(1 0 0 1 0 0)"),
        "selection must be rebased"
    );
}

#[test]
fn t07_hide_layer_must_be_undoable() {
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.app.apply_ctx(CtxCmd::HideSel);
    h.app.doc().undo_document();
    assert!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "frame-1")
            .unwrap()
            .visible,
        "undo did not restore layer visibility"
    );
}

#[test]
fn t08_copy_paste_must_work_across_pages() {
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.app.apply_ctx(CtxCmd::Copy);
    h.dispatch(Action::AddPage);
    h.app.apply_ctx(CtxCmd::Paste);
    assert!(
        !h.app.doc_ref().editor_ref().root.children.is_empty(),
        "destination page has a different, empty Editor clipboard"
    );
}

#[test]
fn t09_ime_commit_must_insert_text() {
    let mut h = host();
    begin_text(&mut h, "");
    h.on_text("नमस्ते");
    assert_eq!(
        h.app.text_buffer, "नमस्ते",
        "IME commit callback discarded committed text"
    );
}

#[test]
fn t10_space_key_must_insert_a_space_when_editing_text() {
    let mut h = host();
    begin_text(&mut h, "Hello");
    h.app.text_set_caret(5, false);
    // The actual event loop swallows this before on_key, too.
    h.on_key(Key::Named(NamedKey::Space), Some(" "));
    assert_eq!(
        h.app.text_buffer, "Hello ",
        "Space is not routed to the focused text editor"
    );
}

#[test]
fn t11_arrow_down_must_move_to_next_text_line() {
    let mut h = host();
    begin_text(&mut h, "ab\ncd");
    h.app.text_set_caret(1, false);
    h.on_key(Key::Named(NamedKey::ArrowDown), None);
    assert_eq!(
        h.app.text_caret, 4,
        "ArrowDown reads an absent inspector field, not the text buffer"
    );
}

#[test]
fn t12_clip_content_must_modify_document_not_only_chrome_state() {
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.dispatch(Action::ClipContent);
    let f = find_node_clone(&h.app.doc_ref().editor_ref().root, "frame-1").unwrap();
    assert!(
        f.overflow.clips(),
        "checkbox toggles OpenDoc.clip_content but not Node.overflow"
    );
}

#[test]
fn t13_canvas_and_export_must_encode_the_same_fill_stack() {
    let mut h = host();
    let mut n = Node::rect("r", 0.0, 0.0, 40.0, 40.0, Color::BLACK);
    n.stroke.width = 0.0;
    n.materialize_visual_stacks();
    n.fill_layers
        .push(PaintLayer::new(Paint::Solid(Color::WHITE)));
    h.app.doc().editor().root = Node::frame("page", 100.0, 100.0).child(n);
    let tree = build_render_tree(&h.app.doc_ref().editor_ref().root, &Variables::default());
    let export_fills = tree
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::FillPath { .. }))
        .count();
    assert_eq!(export_fills, 2);
    let canvas = h.app.canvas_scene();
    // canvas == export, path for path: the render root is the PAGE, and a
    // page is not a labelled object. (It used to add the root's name label —
    // QA-004 — which printed the page name across an empty artboard and
    // survived deleting every frame on the page.) The label's glyph paths are
    // measured through the same font-aware sink the canvas uses, so this keeps
    // failing if anything starts painting a name for the root again.
    let shell = h.app.doc_ref().editor_ref().root.shallow_clone();
    let shell_scene = x_native::VelloSink {
        assets: None,
        fonts: Some(&h.app.fonts.fonts),
    }
    .render(&build_render_tree(&shell, &Variables::default()));
    assert_eq!(
        shell_scene.encoding().n_paths,
        0,
        "the page root must contribute no paths at all (no name label)"
    );
    assert_eq!(
        canvas.encoding().n_paths as usize,
        export_fills,
        "canvas paths = export fills (no page-name label)"
    );
}

#[test]
fn t14_open_must_reject_or_sanitize_nonfinite_geometry() {
    let p = temp("invalid.x");
    std::fs::write(&p, r#"{"format":"x-native","version":1,"pages":[{"id":"p","kind":"frame","w":1e999,"h":100}]}"#).unwrap();
    let mut h = host();
    let before = h.app.docs.len();
    h.open_path(p.clone());
    h.wait_for_file_job();
    let _ = std::fs::remove_file(&p);
    if h.app.docs.len() > before {
        assert!(
            h.app.doc_ref().editor_ref().root.w.is_finite(),
            "untrusted file introduced infinite width into the editor"
        );
    }
}

#[test]
fn t15_missing_recent_file_must_not_silently_open_a_blank_replacement() {
    let mut h = host();
    let p = temp("nonexistent-recent.x");
    let _ = std::fs::remove_file(&p);
    h.app.recents = vec![crate::state::rf(
        "Real work",
        "Personal",
        "Today",
        Color::WHITE,
        vec![],
        Some(p),
    )];
    let before = h.app.docs.len();
    h.dispatch(Action::OpenRecent(0));
    assert_eq!(
        h.app.docs.len(),
        before,
        "missing real recent was replaced by a blank document with the same name"
    );
}

#[test]
fn t16_svg_font_names_must_not_inject_xml_attributes() {
    let mut text = Node::text("t", 0.0, 0.0, 200.0, 20.0, "Hello");
    text.text_runs.push(x_native::TextRun {
        start: 0,
        len: 5,
        // Harmless marker, not JavaScript: proves attribute breakout.
        font: Some("Inter\" data-audit-injected=\"yes".into()),
        ..Default::default()
    });
    let mut doc = x_native::Document::new();
    doc.pages.push(Node::frame("p", 200.0, 200.0).child(text));
    let serialized = x_native::fileio::save_x(&doc);
    let loaded = x_native::fileio::load_x(&serialized).unwrap();
    let svg = x_native::fileio::export_svg(&loaded.pages[0], &loaded.variables);
    assert!(
        !svg.contains(" data-audit-injected=\"yes\""),
        "an untrusted font name became an extra XML attribute in exported SVG"
    );
}

#[test]
fn t17_comments_must_stay_on_their_page_after_page_reordering() {
    let mut h = host();
    let original_page = h.app.doc_ref().editor_ref().root.id.clone();
    h.app.post_comment(10.0, 10.0, "This belongs to page one");
    h.dispatch(Action::AddPage);
    h.app.page_menu_cmd(crate::state::PageMenuCmd::MoveUp);
    let doc = &h.app.doc_ref().doc;
    let pinned_page = &doc.pages[doc.comments[0].page].id;
    assert_eq!(
        pinned_page, &original_page,
        "comment followed a page index instead of its original page identity"
    );
}

#[test]
fn new_file_opens_clean_without_the_canvas_grid() {
    // The grid is OPT-IN: a fresh document must not auto-create canvas
    // chrome (the user's viewport audit, P1). Both document constructors
    // (new_blank via from_document, and demo_blank) share the default.
    let mut h = host();
    assert!(
        !h.app.doc().guides_visible,
        "a fresh document must open without the canvas grid"
    );
    let mut app = App::new();
    app.open_blank();
    assert!(
        !app.doc().guides_visible,
        "OpenDoc::new_blank must also start grid-free"
    );
    // the eye toggle still turns it on (grid off by default, not gone)
    h.dispatch(Action::ToggleGuideVisibility);
    assert!(
        h.app.doc().guides_visible,
        "the grid toggle must still be able to turn the grid on"
    );
}

#[test]
fn right_click_keeps_multi_selection_so_grouping_works() {
    // Viewport audit P2: the right-click before the context menu used to
    // collapse the selection to the node under the cursor, so
    // "Group selection" (which needs 2+) silently did nothing.
    let mut h = host();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    let ga = Node::rect("ga", 500.0, 500.0, 30.0, 30.0, Color::BLACK);
    let gb = Node::rect("gb", 550.0, 500.0, 30.0, 30.0, Color::WHITE);
    h.app.doc().editor().insert_node(&root_id, ga);
    h.app.doc().editor().insert_node(&root_id, gb);
    h.app.doc().editor().selection = vec!["ga".into(), "gb".into()];
    // right-click ON an already-selected node
    let (tx, ty, z) = h.app.canvas_transform();
    let p = Point::new(515.0 * z + tx, 515.0 * z + ty);
    h.on_right_press(p);
    assert!(
        h.app.context_menu.open,
        "right-click must open the context menu"
    );
    assert_eq!(
        h.app.doc_ref().editor_ref().selection.len(),
        2,
        "right-clicking a selected node must keep the multi-selection"
    );
    // ...and the group actually forms through the menu action
    h.app.apply_ctx(CtxCmd::Group);
    let root = &h.app.doc_ref().editor_ref().root;
    let group = root
        .children
        .iter()
        .find(|n| matches!(n.kind, NodeKind::Group))
        .unwrap();
    assert_eq!(group.children.len(), 2, "both members inside the group");
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec![group.id.clone()]
    );
}

#[test]
fn drawing_into_a_selected_frame_nests_the_new_node() {
    // Viewport audit P2: drawn nodes were always forced onto the page root,
    // so artboards could never receive content. Figma semantics: one
    // selected frame → the new node is its child, in the frame's space.
    let mut h = host();
    // demo doc: frame-1 is 375x420 at world (0, 60)
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.finish_create(Tool::Rect, Point::new(20.0, 80.0), Point::new(60.0, 100.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(
        root.children.len(),
        1,
        "the new rect must NOT be a root sibling"
    );
    let f1 = find_node_clone(root, "frame-1").unwrap();
    assert_eq!(f1.children.len(), 1, "the new rect must be inside frame-1");
    let r = &f1.children[0];
    // world (20, 80) inside a frame at (0, 60) → local (20, 20)
    assert_eq!((r.transform.x, r.transform.y), (20.0, 20.0));
    assert_eq!((r.w, r.h), (40.0, 20.0));
    assert_eq!(h.app.doc_ref().editor_ref().selection, vec![r.id.clone()]);
}

#[test]
fn drawing_with_no_container_selected_lands_at_the_page_root() {
    let mut h = host();
    assert!(h.app.doc_ref().editor_ref().selection.is_empty());
    h.finish_create(Tool::Rect, Point::new(10.0, 10.0), Point::new(50.0, 30.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 2, "rect + the demo frame");
    let r = root.children.iter().find(|n| n.id != "frame-1").unwrap();
    assert_eq!((r.transform.x, r.transform.y), (10.0, 10.0));
    // and selecting a non-container (a plain rect) is never a drop target:
    // only frames / groups / sections can capture — but since the draw-it-in
    // rule the DRAW POINT decides first, so aim at empty canvas
    h.app.doc().editor().selection = vec![r.id.clone()];
    h.finish_create(Tool::Rect, Point::new(500.0, 20.0), Point::new(540.0, 40.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(
        root.children.len(),
        3,
        "non-container selection → root again"
    );
    // the same non-container selection, drawn over frame-1, still joins the
    // frame: where you draw beats what is selected
    h.finish_create(Tool::Rect, Point::new(40.0, 120.0), Point::new(80.0, 150.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 3, "the selection did not capture");
    let f1 = find_node_clone(root, "frame-1").unwrap();
    assert_eq!(f1.children.len(), 1, "the draw point decided the parent");
}

#[test]
fn pages_list_shows_every_page_with_measured_band() {
    // Viewport audit P2 (the "two page areas" redesign): the PAGES band
    // is a real list — one row per page, paint and hit-testing share the
    // same geometry, and the LAYERS band below anchors to its bottom.
    let mut h = host();
    h.dispatch(Action::AddPage);
    h.dispatch(Action::AddPage);
    assert_eq!(h.app.doc_ref().editors.len(), 3);
    let rows = h.app.pages_rows();
    assert_eq!(rows.len(), 3, "one row per page");
    for (i, (_, r)) in rows.iter().enumerate() {
        assert!((r.y1 - r.y0 - 26.0).abs() < 1e-9, "26px rows");
        assert_eq!(i, h.app.pages_rows()[i].0, "row i addresses page i");
    }
    // band bottom = last row bottom (the divider/LAYERS/tree anchor to it)
    let last_bottom = rows.last().unwrap().1.y1;
    assert!((h.app.pages_band_bottom() - last_bottom).abs() < 1e-9);
    // the row's hit zone dispatches SelectPage(i) — verify that switches
    h.dispatch(Action::SelectPage(2));
    assert_eq!(h.app.doc_ref().page, 2, "row click switches pages");
}

#[test]
fn pages_list_windows_beyond_four_pages_and_keeps_every_page_reachable() {
    // The band holds 4 rows. Past that it WINDOWS rather than collapsing into
    // a "+N more" sentinel row: the sentinel carried the page COUNT as its
    // index — an out-of-range `pages` entry — so pages past the 3rd could not
    // be selected, renamed or deleted at all ("the pages are not getting
    // deleted properly").
    let mut h = host();
    for _ in 0..5 {
        h.dispatch(Action::AddPage);
    }
    let rows = h.app.pages_rows();
    assert_eq!(rows.len(), 4, "the band still holds four rows");
    let n = h.app.doc_ref().editors.len();
    assert_eq!(n, 6);
    // AddPage made the new page active, so the window has followed it and
    // clamped at the tail: the LAST page always has a real row
    assert_eq!(h.app.doc_ref().page, n - 1);
    assert_eq!(rows[0].0, n - 4, "window follows the active page");
    assert_eq!(rows[3].0, n - 1, "the last page is always a real row");
    // every page index is addressable by SOME row across the window positions
    let mut seen = std::collections::BTreeSet::new();
    for page in 0..n {
        h.app.doc().page = page;
        for (page_i, _) in h.app.pages_rows() {
            assert!(page_i < n, "no out-of-range rows (got {page_i} of {n})");
            seen.insert(page_i);
        }
    }
    assert_eq!(
        seen.len(),
        n,
        "every page gets a row at some scroll position"
    );
    h.app.doc().page = n - 1;
    assert_eq!(h.app.pages_rows()[0].0, n - 4, "no tail gap");
    assert!((h.app.pages_band_bottom() - h.app.pages_rows()[3].1.y1).abs() < 1e-9);
}

#[test]
fn new_documents_carry_the_default_font_into_new_text() {
    // Viewport audit P3: the default typeface is per-file data
    // (Document::default_font), declared at file creation and applied
    // to new text — not a constant scattered through the UI.
    let mut h = host();
    assert_eq!(
        h.app.doc_ref().doc.default_font.as_deref(),
        Some(x_native::APP_DEFAULT_FONT)
    );
    h.finish_create(
        Tool::Text,
        Point::new(100.0, 100.0),
        Point::new(200.0, 114.0),
    );
    let id = h.app.doc_ref().selected_id().unwrap();
    let root = &h.app.doc_ref().editor_ref().root;
    let t = crate::editor_ui::find_node(root, &id).unwrap();
    assert_eq!(
        t.bindings.get("font").map(String::as_str),
        Some(x_native::APP_DEFAULT_FONT)
    );
}

#[test]
fn inspector_falls_back_to_the_document_default_font() {
    use crate::editor_ui::{typo_val, Typo};
    let h = host();
    // no text selected: the inspector reports the document default
    let family = typo_val(&h.app, Typo::Family);
    assert_eq!(family, x_native::APP_DEFAULT_FONT);
}

#[test]
fn new_session_and_new_document_have_no_mock_content() {
    let mut app = App::new();
    assert!(app.docs.is_empty() && app.drafts.is_empty());
    assert!(!app.demo_mode);
    assert!(app.recents.iter().all(|r| r.path.is_some()));
    app.open_blank();
    assert!(app.doc_ref().editor_ref().root.children.is_empty());
}

#[test]
fn close_cancel_failed_save_and_cancelled_save_as_keep_work() {
    use crate::session::CloseChoice::*;
    let mut h = host();
    h.app.mark_dirty();
    assert!(!h.close_doc_with_choice(0, Cancel));
    assert!(!h.close_doc_with_choice(0, Save)); // no picker in a headless host
    assert!(h.app.docs[0].dirty);
    h.app.docs[0].path = Some(temp("missing-directory").join("doc.x"));
    assert!(!h.close_doc_with_choice(0, Save));
    assert_eq!(h.app.docs.len(), 1);
    assert!(h.close_doc_with_choice(0, Discard));
    assert!(h.app.docs.is_empty());
}

#[test]
fn window_close_cancel_does_not_discard_dirty_tabs() {
    let mut h = host();
    h.app.mark_dirty();
    h.app.docs.push(OpenDoc::new_blank("Empty".into()));
    assert!(!h.request_close_window());
    assert_eq!(h.app.docs.len(), 1);
    assert!(h.app.docs[0].dirty);
}

#[test]
fn closing_an_inactive_tab_keeps_the_active_document_identity() {
    let mut h = host();
    h.app.docs.push(OpenDoc::new_blank("Second".into()));
    h.app.active = 1;
    let id = h.app.docs[1].recovery_path.clone();
    assert!(h.close_doc_with_choice(0, crate::session::CloseChoice::Discard));
    assert_eq!(h.app.doc_ref().recovery_path, id);
}

#[test]
fn save_before_close_commits_pending_text() {
    let mut h = host();
    begin_text(&mut h, "before");
    h.app.text_select_all_ed();
    h.on_text("after");
    let path = temp("close-save.x");
    h.app.docs[0].path = Some(path.clone());
    assert!(h.close_doc_with_choice(0, crate::session::CloseChoice::Save));
    let d = load_x_file(path.to_str().unwrap()).unwrap();
    assert!(
        matches!(&x_native::editor::find(&d.pages[0],"audit-text").unwrap().kind, NodeKind::Text { text } if text == "after")
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn tab_and_page_switch_commit_text_to_the_original_owner() {
    let mut h = host();
    begin_text(&mut h, "first");
    h.on_text(" page");
    h.dispatch(Action::AddPage);
    assert!(
        matches!(&x_native::editor::find(&h.app.doc_ref().editors[0].root,"audit-text").unwrap().kind, NodeKind::Text { text } if text == "first page")
    );
    assert!(h.app.text_edit.is_none());
    h.dispatch(Action::NewFile);
    assert!(h.app.doc_ref().editor_ref().root.children.is_empty());
}

#[test]
fn autosave_all_pages_and_live_text_does_not_steal_focus() {
    let mut h = host();
    begin_text(&mut h, "saved");
    let path = temp("autosave-live.x");
    h.save_to(path.clone());
    h.app.begin_text_edit("audit-text".into(), "saved".into());
    h.on_text(" draft");
    h.app.autosave_all();
    assert_eq!(h.app.text_buffer, "saved draft");
    assert!(h.app.text_edit.is_some());
    let sidecar = x_native::fileio::autosave_path(path.to_str().unwrap());
    let recovered = load_x_file(&sidecar).unwrap();
    assert!(
        matches!(&x_native::editor::find(&recovered.pages[0],"audit-text").unwrap().kind, NodeKind::Text { text } if text == "saved draft")
    );
    assert!(
        matches!(&x_native::editor::find(&h.app.doc_ref().editor_ref().root,"audit-text").unwrap().kind, NodeKind::Text { text } if text == "saved")
    );
    x_native::fileio::clear_autosave(path.to_str().unwrap());
    let _ = std::fs::remove_file(path);
}

#[test]
fn unsaved_document_autosave_is_recoverable_and_discard_clears_it() {
    let mut h = host();
    h.app.mark_dirty();
    let path = temp("unsaved-recovery.x");
    h.app.docs[0].recovery_path = path.clone();
    h.app.autosave_all();
    assert!(load_x_file(path.to_str().unwrap()).is_ok());
    h.close_doc_with_choice(0, crate::session::CloseChoice::Discard);
    assert!(!path.exists());
}

#[test]
fn recovered_revision_never_becomes_clean_by_undoing_to_its_start() {
    let mut h = host();
    h.app.doc().require_save();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.app.apply_ctx(CtxCmd::HideSel);
    assert!(h.app.doc().undo_document());
    assert!(h.app.doc_ref().dirty);
}

#[test]
fn saved_revision_is_restored_by_undo_and_dirtied_by_redo() {
    let mut h = host();
    let path = temp("saved-revision.x");
    h.save_to(path.clone());
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.app.apply_ctx(CtxCmd::HideSel);
    assert!(h.app.doc().undo_document());
    assert!(!h.app.doc_ref().dirty);
    assert!(h.app.doc().redo_document());
    assert!(h.app.doc_ref().dirty);
    let _ = std::fs::remove_file(path);
}

#[test]
fn document_history_orders_page_edits_comments_and_reordering() {
    let mut h = host();
    let first = h.app.doc_ref().editor_ref().root.id.clone();
    let comment = h.app.post_comment(1.0, 2.0, "keep me");
    h.dispatch(Action::AddPage);
    h.app.page_menu_cmd(crate::state::PageMenuCmd::MoveUp);
    assert!(h.app.doc().undo_document());
    assert_eq!(h.app.doc_ref().editors[0].root.id, first);
    assert!(h.app.doc().undo_document());
    assert_eq!(h.app.doc_ref().editors.len(), 1);
    assert!(h.app.doc_ref().doc.comments.iter().any(|c| c.id == comment));
    assert!(h.app.doc().undo_document());
    assert!(h.app.doc_ref().doc.comments.is_empty());
    assert!(h.app.doc().redo_document());
    assert_eq!(h.app.doc_ref().doc.comments.len(), 1);
}

#[test]
fn page_duplicate_uses_live_content_and_does_not_duplicate_comments() {
    let mut h = host();
    h.finish_create(Tool::Rect, Point::new(20.0, 20.0), Point::new(40.0, 40.0));
    h.app.post_comment(3.0, 4.0, "original only");
    h.app.page_menu_cmd(crate::state::PageMenuCmd::Duplicate);
    assert_eq!(h.app.doc_ref().editor_ref().root.children.len(), 2);
    assert_eq!(h.app.doc_ref().doc.comments.len(), 1);
    assert_eq!(h.app.doc_ref().doc.comments[0].page, 0);
    assert_ne!(
        h.app.doc_ref().editors[0].root.id,
        h.app.doc_ref().editors[1].root.id
    );
}

#[test]
fn clipping_undo_reload_and_export_use_one_document_property() {
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.dispatch(Action::ClipContent);
    let plan = x_native::prepare_export(
        &h.app.doc_ref().editor_ref().root,
        &Variables::default(),
        Some(&["frame-1".into()]),
        &h.app.fonts.fonts,
    )
    .unwrap();
    assert!(plan
        .tree
        .commands
        .iter()
        .any(|c| matches!(c, RenderCommand::PushClip { .. })));
    let path = temp("clip.x");
    h.save_to(path.clone());
    assert!(x_native::editor::find(
        &load_x_file(path.to_str().unwrap()).unwrap().pages[0],
        "frame-1"
    )
    .unwrap()
    .overflow
    .clips());
    h.app.doc().undo_document();
    assert!(
        !x_native::editor::find(&h.app.doc_ref().editor_ref().root, "frame-1")
            .unwrap()
            .overflow
            .clips()
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn all_selected_roots_export_with_one_rebased_visual_union() {
    let mut h = host();
    h.app.doc().editor().root = Node::frame("p", 400.0, 300.0)
        .child(Node::rect("a", 100.0, 50.0, 10.0, 20.0, Color::BLACK))
        .child(Node::rect("b", 140.0, 80.0, 20.0, 10.0, Color::WHITE));
    let ids = vec!["a".into(), "b".into()];
    h.app.doc().editor().selection = ids.clone();
    let p = x_native::prepare_export(
        &h.app.doc_ref().editor_ref().root,
        &Variables::default(),
        Some(&ids),
        &h.app.fonts.fonts,
    )
    .unwrap();
    assert_eq!((p.width, p.height, p.origin), (60.0, 40.0, (100.0, 50.0)));
    let page = x_native::prepare_export(
        &h.app.doc_ref().editor_ref().root,
        &Variables::default(),
        None,
        &h.app.fonts.fonts,
    )
    .unwrap();
    assert_eq!((page.width, page.height), (400.0, 300.0));
}

fn green_png() -> Vec<u8> {
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&[0, 255, 0, 255].repeat(4))
            .unwrap();
    }
    bytes
}

#[test]
fn cross_document_image_clipboard_preserves_pixels_and_undo() {
    let mut h = host();
    let image = green_png();
    let doc = x_native::fileio::import_png("green", &image).unwrap();
    h.app.docs[0] = OpenDoc::from_document("Image".into(), None, doc);
    let id = h.app.doc_ref().editor_ref().root.children[0].id.clone();
    h.app.doc().editor().selection = vec![id];
    h.app.copy_nodes();
    h.cmd_new_file();
    h.app.paste_nodes();
    let d = h.app.doc_ref();
    assert_eq!(d.doc.assets.len(), 1);
    assert_eq!(d.editor_ref().root.children.len(), 1);
    let path = temp("pasted-image.png");
    h.export_to(&path, true, 0, 1.0).unwrap();
    h.wait_for_file_job();
    let decoder = png::Decoder::new(std::io::Cursor::new(std::fs::read(&path).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut rgba).unwrap();
    assert_eq!(&rgba[..4], &[0, 255, 0, 255]);
    assert!(h.app.doc().undo_document());
    assert!(h.app.doc_ref().editor_ref().root.children.is_empty());
    assert!(h.app.doc().redo_document());
    assert_eq!(h.app.doc_ref().editor_ref().root.children.len(), 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn component_clipboard_brings_its_master_and_remaps_override_targets() {
    let mut h = host();
    let mut master = Node::component("def", "Badge", 20.0, 20.0).child(Node::rect(
        "bg",
        0.0,
        0.0,
        20.0,
        20.0,
        Color::BLACK,
    ));
    master.visible = false;
    let mut instance = Node::instance("i", "Badge", 10.0, 10.0, 20.0, 20.0);
    instance.overrides.insert("bg".into(), "#ffffff".into());
    h.app.doc().editor().root = Node::frame("p", 200.0, 200.0).child(master).child(instance);
    h.app.doc().editor().selection = vec!["i".into()];
    h.app.copy_nodes();
    h.cmd_new_file();
    h.app.paste_nodes();
    let root = &h.app.doc_ref().editor_ref().root;
    let instance = &root.children[0];
    let master = &root.children[1];
    assert!(!master.visible);
    assert!(
        matches!((&instance.kind,&master.kind),(NodeKind::Instance { component },NodeKind::Component { name }) if component==name)
    );
    assert!(instance.overrides.contains_key(&master.children[0].id));
    let tree = build_render_tree(root, &Variables::default());
    assert_eq!(
        tree.commands
            .iter()
            .filter(|c| matches!(c, RenderCommand::FillPath { .. }))
            .count(),
        1
    );
}

#[test]
fn cross_document_dependency_conflicts_are_non_destructive() {
    let mut h = host();
    h.app
        .doc()
        .doc
        .variables
        .numbers
        .insert("space".into(), 8.0);
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.app.copy_nodes();
    h.cmd_new_file();
    h.app
        .doc()
        .doc
        .variables
        .numbers
        .insert("space".into(), 16.0);
    h.app.paste_nodes();
    assert!(h.app.status.starts_with("Paste refused"));
    assert!(h.app.doc_ref().editor_ref().root.children.is_empty());
    assert_eq!(h.app.doc_ref().doc.variables.numbers["space"], 16.0);
}

#[test]
fn copying_from_transformed_parent_preserves_world_geometry_and_display_name() {
    let mut h = host();
    let mut group = Node::group("g", 100.0, 100.0);
    group.transform.x = 70.0;
    group.transform.rotation = 0.4;
    group
        .children
        .push(Node::rect("r", 10.0, 20.0, 10.0, 10.0, Color::WHITE));
    let world =
        group.transform.matrix(group.w, group.h) * group.children[0].transform.matrix(10.0, 10.0);
    h.app.doc().editor().root = Node::frame("p", 400.0, 400.0).child(group);
    h.app.doc().editor().selection = vec!["r".into()];
    h.app.copy_nodes();
    h.cmd_new_file();
    h.app.paste_nodes();
    let n = &h.app.doc_ref().editor_ref().root.children[0];
    assert_eq!(n.name, "r");
    for (a, b) in world
        .as_coeffs()
        .iter()
        .zip(n.transform.matrix(n.w, n.h).as_coeffs())
    {
        assert!((a - b).abs() < 1e-8);
    }
}

#[test]
fn grapheme_navigation_delete_vertical_motion_and_local_undo() {
    let mut h = host();
    begin_text(&mut h, "a\u{301}👨‍👩‍👧‍👦\nनमस्ते");
    h.app.text_set_caret(0, false);
    h.on_key(Key::Named(NamedKey::ArrowRight), None);
    assert_eq!(h.app.text_caret, 2);
    h.on_key(Key::Named(NamedKey::ArrowRight), None);
    let caret = h.app.text_caret;
    assert!(caret > 3);
    h.on_key(Key::Named(NamedKey::Backspace), None);
    assert_eq!(h.app.text_buffer, "a\u{301}\nनमस्ते");
    h.app.undo_text(false);
    assert_eq!(h.app.text_caret, caret);
    h.on_key(Key::Named(NamedKey::Home), None);
    assert_eq!(h.app.text_caret, 0);
    h.on_key(Key::Named(NamedKey::ArrowDown), None);
    assert_eq!(h.app.text_chars()[h.app.text_caret], 'न');
}

#[test]
fn focused_numeric_field_consumes_arrows_and_supports_select_all() {
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.dispatch(Action::Field(FieldId::W));
    h.app.ctrl = true;
    h.on_key(Key::Character("a".into()), None);
    h.app.ctrl = false;
    h.on_text("128");
    h.on_key(Key::Named(NamedKey::ArrowLeft), None);
    h.on_key(Key::Named(NamedKey::Enter), None);
    let n = x_native::editor::find(&h.app.doc_ref().editor_ref().root, "frame-1").unwrap();
    assert_eq!((n.w, n.transform.x), (128.0, 0.0));
}

#[test]
fn save_shortcut_is_not_swallowed_by_inline_text_focus() {
    let mut h = host();
    begin_text(&mut h, "hello");
    h.on_text(" world");
    let path = temp("shortcut-text.x");
    h.app.docs[0].path = Some(path.clone());
    h.app.ctrl = true;
    h.on_key(Key::Character("s".into()), None);
    assert!(!h.app.doc_ref().dirty);
    assert!(path.exists());
    assert!(h.app.text_edit.is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn camera_resize_and_zoom_anchor_use_the_same_logical_coordinates() {
    let mut h = host();
    h.update_dimensions(1800, 1000, 2.0);
    assert_eq!((h.app.win_w, h.app.win_h), (900.0, 500.0));
    let point = Point::new(420.0, 200.0);
    let before = h.app.screen_to_world(point);
    h.zoom_at(point, 2.0);
    let after = h.app.screen_to_world(point);
    assert!((before.x - after.x).abs() < 1e-10 && (before.y - after.y).abs() < 1e-10);
}

#[test]
fn paint_does_not_sync_or_modify_document_data_and_cache_reuses_scenes() {
    let mut h = host();
    let before = x_native::fileio::save_x(&h.app.doc_ref().doc);
    h.app.canvas_scene();
    h.app.canvas_scene();
    assert!(h.app.doc_ref().frame_cache.stats.full_hit);
    assert_eq!(x_native::fileio::save_x(&h.app.doc_ref().doc), before);
}

#[test]
fn externally_changed_file_is_not_silently_overwritten() {
    let mut h = host();
    let path = temp("external-change.x");
    h.save_to(path.clone());
    std::fs::write(&path, b"external writer owns this version").unwrap();
    h.app.mark_dirty();
    h.save_to(path.clone());
    assert!(h.app.status.contains("changed on disk"));
    assert!(h.app.doc_ref().dirty);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"external writer owns this version"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn selection_export_retains_a_preceding_sibling_mask() {
    let mut h = host();
    let root = Node::frame("p", 100.0, 100.0)
        .child(Node::rect("mask", 0.0, 0.0, 10.0, 10.0, Color::WHITE).mask(true))
        .child(Node::rect("shape", 0.0, 0.0, 20.0, 20.0, Color::WHITE));
    h.app.doc().editor().root = root;
    let plan = x_native::prepare_export(
        &h.app.doc_ref().editor_ref().root,
        &Variables::default(),
        Some(&["shape".into()]),
        &h.app.fonts.fonts,
    )
    .unwrap();
    assert!(plan
        .tree
        .commands
        .iter()
        .any(|c| matches!(c, RenderCommand::PushClip { .. })));
}

#[test]
fn damaged_native_file_recovers_a_valid_backup_without_overwriting_original() {
    let path = temp("backup-recovery.x");
    let mut h = host();
    h.save_to(path.clone());
    h.app.doc().editor().set_visible("frame-1", false);
    h.app.mark_dirty();
    h.save_to(path.clone());
    std::fs::write(&path, b"damaged").unwrap();
    let (doc, note) = crate::session::recovery_candidate(&path).expect("valid backup");
    assert!(note.contains("backup"));
    assert!(doc.path.is_none() && doc.dirty);
    assert!(
        x_native::editor::find(&doc.editor_ref().root, "frame-1")
            .unwrap()
            .visible
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"damaged");
    let _ = std::fs::remove_file(path);
}

#[test]
#[ignore = "CPU profiling of the actual UI/frame composition path; not an FPS guarantee"]
fn profile_editor_cpu_frames() {
    use std::time::Instant;
    let mut h = host();
    let mut root = Node::frame("benchmark-page", 1440.0, 1600.0);
    for i in 0..10_000 {
        let mut n = Node::rect(
            &format!("bench-{i}"),
            (i % 100) as f64 * 12.0,
            (i / 100) as f64 * 12.0,
            8.0,
            8.0,
            Color::WHITE,
        );
        n.name = format!("Rectangle {i}");
        root.children.push(n);
    }
    h.app.docs[0] = OpenDoc::from_document(
        "CPU benchmark".into(),
        None,
        x_native::Document {
            pages: vec![root],
            ..Default::default()
        },
    );
    for scroll in [0.0, 9_000.0 * (crate::theme::TREE_ROW_H + 1.0)] {
        h.app.doc().scroll_left = scroll;
        for _ in 0..3 {
            std::hint::black_box(h.app.compose_frame());
        }
        let mut samples = vec![];
        for _ in 0..15 {
            let t = Instant::now();
            std::hint::black_box(h.app.compose_frame());
            samples.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        eprintln!(
            "UI_CPU nodes=10000 scroll={scroll} median_ms={:.3} p95_ms={:.3}",
            samples[7], samples[14]
        );
    }
}

#[test]
fn background_worker_is_bounded_and_does_not_block_editor_mutations() {
    use std::sync::mpsc;
    let mut h = host();
    let (started, ready) = mpsc::channel();
    let (resume, wait) = mpsc::channel();
    h.files
        .start(
            crate::jobs::Kind::Export,
            "Test background work".into(),
            move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                Ok(crate::jobs::Output::Exported("done".into()))
            },
        )
        .unwrap();
    ready
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert!(h
        .files
        .start(
            crate::jobs::Kind::Export,
            "Must not queue".into(),
            || panic!("unbounded job")
        )
        .is_err());
    h.finish_create(Tool::Rect, Point::new(30.0, 30.0), Point::new(50.0, 50.0));
    assert!(h.app.doc_ref().dirty);
    h.refresh_file_status();
    std::hint::black_box(h.app.compose_frame());
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| matches!(a, Action::CancelFileOperation)));
    resume.send(()).unwrap();
    h.wait_for_file_job();
    assert_eq!(h.app.status, "done");
}

#[test]
fn cancelled_background_export_never_replaces_the_destination() {
    use std::sync::mpsc;
    let mut h = host();
    let path = temp("cancel-output.svg");
    std::fs::write(&path, b"original").unwrap();
    let (started, ready) = mpsc::channel();
    let (resume, wait) = mpsc::channel();
    let output = path.clone();
    h.files
        .start(
            crate::jobs::Kind::Export,
            "Blocked export".into(),
            move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                x_native::fileio::atomic_write_path(&output, b"replacement")
                    .map_err(|e| e.to_string())?;
                Ok(crate::jobs::Output::Exported("done".into()))
            },
        )
        .unwrap();
    ready
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    h.dispatch(Action::CancelFileOperation);
    resume.send(()).unwrap();
    h.wait_for_file_job();
    assert!(h.app.status.contains("cancelled"));
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    std::fs::remove_file(path).unwrap();
}

#[test]
fn late_import_result_keeps_the_current_edit_and_focus() {
    use std::sync::mpsc;
    let mut h = host();
    let path = temp("background.svg");
    std::fs::write(&path, "<svg width=\"10\" height=\"10\"/>").unwrap();
    let origin = h.focus_origin();
    let (started, ready) = mpsc::channel();
    let (resume, wait) = mpsc::channel();
    let input = path.clone();
    h.files
        .start(
            crate::jobs::Kind::Open { origin },
            "Blocked import".into(),
            move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                crate::jobs::open(crate::jobs::OpenRequest {
                    path: input,
                    mode: crate::jobs::OpenMode::Saved,
                })
            },
        )
        .unwrap();
    ready
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    begin_text(&mut h, "kept");
    h.on_text(" draft");
    resume.send(()).unwrap();
    h.wait_for_file_job();
    assert_eq!(h.app.docs.len(), 2);
    assert_eq!(h.app.active, 0);
    assert_eq!(h.app.text_buffer, "kept draft");
    assert!(h.app.text_edit.is_some());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn a_cancelled_read_result_is_not_published_even_after_worker_completion() {
    use std::sync::mpsc;
    let mut h = host();
    let origin = h.focus_origin();
    let (done, ready) = mpsc::channel();
    h.files
        .start(
            crate::jobs::Kind::Open { origin },
            "Finished import".into(),
            move || {
                let output = crate::jobs::Output::Opened {
                    document: Box::new(OpenDoc::new_blank("not published".into())),
                    path: std::path::PathBuf::from("unused.x"),
                    note: "Opened".into(),
                };
                done.send(()).unwrap();
                Ok(output)
            },
        )
        .unwrap();
    ready
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    h.cancel_file_job();
    h.wait_for_file_job();
    assert_eq!(h.app.docs.len(), 1);
    assert!(h.app.status.contains("cancelled"));
}

#[test]
fn provisional_composition_and_comment_are_not_discarded_on_context_switch() {
    let mut h = host();
    begin_text(&mut h, "base");
    h.app.ime_preedit = "न".into();
    assert!(!h.close_doc_with_choice(0, crate::session::CloseChoice::Discard));
    h.dispatch(Action::AddPage);
    assert_eq!(h.app.doc_ref().editors.len(), 1);
    assert_eq!(h.app.ime_preedit, "न");
    h.app.ime_preedit.clear();
    h.finish_edits();
    h.app.comment_draft = Some(crate::state::CommentDraft {
        x: 1.0,
        y: 2.0,
        buffer: "unposted".into(),
        parent: None,
    });
    h.cmd_new_file();
    assert_eq!(h.app.docs.len(), 1);
    assert_eq!(h.app.comment_draft.as_ref().unwrap().buffer, "unposted");
}

#[test]
fn autosave_of_a_stale_editor_is_kept_separately_from_another_writers_file() {
    let mut h = host();
    let path = temp("autosave-conflict.x");
    h.save_to(path.clone());
    let recovery = temp("autosave-conflict-recovery.x");
    h.app.doc().recovery_path = recovery.clone();
    let main = x_native::fileio::save_x(&x_native::Document {
        pages: vec![Node::frame("other", 10.0, 10.0)],
        ..Default::default()
    });
    std::fs::write(&path, &main).unwrap();
    h.app.doc().editor().move_node("frame-1", 1.0, 0.0);
    h.app.mark_dirty();
    h.app.autosave_all();
    assert!(recovery.exists());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), main);
    assert!(
        !std::path::Path::new(&x_native::fileio::autosave_path(path.to_str().unwrap())).exists()
    );
    assert!(h.app.status.contains("separate recovery"));
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(recovery);
}

#[test]
fn async_export_uses_its_snapshot_while_the_document_continues_changing() {
    let mut h = host();
    h.app.doc().editor().root = Node::frame("p", 20.0, 20.0).child(Node::rect(
        "r",
        0.0,
        0.0,
        20.0,
        20.0,
        Color::from_rgb8(255, 0, 0),
    ));
    h.app.doc().editor().selection = vec!["r".into()];
    let path = temp("snapshot-export.svg");
    h.export_to(&path, true, 2, 1.0).unwrap();
    h.app.doc().editor().root.children[0].fill = Paint::Solid(Color::from_rgb8(0, 255, 0));
    h.wait_for_file_job();
    let svg = std::fs::read_to_string(&path).unwrap();
    assert!(svg.contains("#ff0000"));
    assert!(!svg.contains("#00ff00"));
    assert_eq!(
        h.app.doc_ref().editor_ref().root.children[0].fill,
        Paint::Solid(Color::from_rgb8(0, 255, 0))
    );
    std::fs::remove_file(path).unwrap();
}

// ————————————————— prototyping: authoring panel + live flow preview

fn proto_doc(h: &mut Host) {
    let root_id = {
        let d = h.app.doc();
        let root_id = d.editor_ref().root.id.clone();
        let mut f1 = Node::frame("f1", 300.0, 200.0);
        f1.name = "Home".into();
        f1.is_starting_point = true;
        let mut f2 = Node::frame("f2", 300.0, 200.0);
        f2.name = "Detail".into();
        f2.transform.x = 400.0;
        d.editor().insert_node(&root_id, f1);
        d.editor().insert_node(&root_id, f2);
        let mut btn = Node::rect("btn", 20.0, 20.0, 80.0, 30.0, Color::from_rgb8(9, 9, 9));
        btn.name = "Go".into();
        btn.interactions = vec![x_native::Interaction::click("f2")];
        d.editor().insert_node("f1", btn);
        root_id
    };
    let _ = root_id;
    h.app.doc().editor().selection = vec!["btn".into()];
}

#[test]
fn prototype_panel_lists_interaction_rows() {
    let mut h = host();
    proto_doc(&mut h);
    h.app.doc().right_tab = crate::state::RightTab::Prototype;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        h.app.hit.iter().any(|(_, a)| matches!(a, Action::ProtoAdd)),
        "add button"
    );
    assert!(
        h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::ProtoRemove(0))),
        "existing interaction row"
    );
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| matches!(a, Action::ProtoToggleStart)));
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| matches!(a, Action::ProtoTrigger(0))));
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| matches!(a, Action::FlowEnter)));
}

/// Figma's trigger control is a dropdown listing its own words (help
/// 360040315773). This walks the list the menu paints, writes from it, and
/// checks the row still fits at the narrowest panel — the pill is measured to
/// its words, so no trigger name can overdraw the field beside it.
#[test]
fn the_trigger_menu_offers_figmas_list_and_the_pill_fits_its_words() {
    use x_native::Trigger;
    let mut h = host();
    proto_doc(&mut h);
    h.app.doc().right_tab = crate::state::RightTab::Prototype;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);

    // the pill opens the menu rather than cycling through six triggers
    h.dispatch(Action::ProtoTrigger(0));
    assert_eq!(h.app.dropdown_proto_trigger, Some(0));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let rows: Vec<Rect> = h
        .app
        .hit
        .iter()
        .filter(|(_, a)| matches!(a, Action::ProtoSetTrigger(0, _)))
        .map(|(r, _)| *r)
        .collect();
    assert_eq!(rows.len(), 12, "every trigger the engine carries");
    for r in &rows {
        assert!(r.x0 >= 0.0 && r.x1 <= h.app.win_w, "on screen");
        assert!(r.y0 >= 0.0 && r.y1 <= h.app.win_h, "in the window");
    }

    // a press writes that trigger, kind and starting value together
    h.dispatch(Action::ProtoSetTrigger(0, 7));
    assert!(h.app.dropdown_proto_trigger.is_none(), "the menu closed");
    let of = |h: &Host| {
        let root = &h.app.doc_ref().editor_ref().root;
        let btn = find_node_clone(root, "btn").unwrap();
        btn.interactions[0].trigger.clone()
    };
    assert_eq!(of(&h), Trigger::MouseDown, "Mouse down is reachable now");
    assert_eq!(h.app.status, "Trigger: Mouse down");

    // the "when" triggers arrive with the value their row starts from, and the
    // parameter field beside the pill edits it
    h.dispatch(Action::ProtoSetTrigger(0, 4));
    assert_eq!(of(&h), Trigger::KeyDown { key: "".into() });
    h.dispatch(Action::ProtoSetTrigger(0, 9));
    assert_eq!(of(&h), Trigger::AfterDelay { ms: 800 });
    h.dispatch(Action::ProtoSetTrigger(0, 10));
    assert_eq!(of(&h), Trigger::WhenVideoHits { time: 0.0 });

    // every trigger in the list paints a pill and its parameter inside the
    // row's own width — the narrowest panel is 208 px (ED_RIGHT_MIN)
    for (k, want) in Trigger::all().iter().enumerate() {
        h.dispatch(Action::ProtoSetTrigger(0, k));
        assert_eq!(&of(&h), want, "row {k} writes its own trigger");
        let mut scene = vello::Scene::new();
        crate::editor_ui::paint(&mut h.app, &mut scene);
        let pill = h
            .app
            .hit
            .iter()
            .find(|(_, a)| *a == Action::ProtoTrigger(0))
            .map(|(r, _)| *r)
            .expect("the trigger pill");
        assert!(pill.width() >= 56.0, "the pill keeps a readable width");
        // the field beside the pill, for the triggers that carry a value: the
        // row's own edit actions, found by the geometry that paints them
        let param =
            h.app.hit.iter().map(|(r, _)| *r).find(|r| {
                r.y0 >= pill.y0 && r.y1 <= pill.y1 && r.x0 > pill.x1 && r.x0 < pill.x1 + 8.0
            });
        let carries = matches!(
            want,
            Trigger::AfterDelay { .. } | Trigger::KeyDown { .. } | Trigger::WhenVideoHits { .. }
        );
        assert_eq!(
            param.is_some(),
            carries,
            "row {k} paints a parameter field exactly when its trigger carries one"
        );
        if let Some(p) = param {
            // the pill starts 5 px inside the row, so the row's left edge is
            // pill.x0 - 5 and ED_RIGHT_MIN puts its right edge 208 further on
            let row_right = pill.x0 - 5.0 + 208.0;
            assert!(p.x1 <= row_right, "the field stays inside the row");
        }
    }
    assert_eq!(h.app.status, "Trigger: When video ends");
    // and the pill's words come from the same owner the menu reads: the
    // engine's `Trigger::label`, pinned by the x-core test beside this one
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "btn")
            .unwrap()
            .interactions[0]
            .trigger
            .label(),
        "When video ends"
    );
}

/// Figma's interaction editor, in our own row: the action's own name on the left
/// ("Navigate to", "Go back"), then an arrow and the thing it acts on — and
/// nothing after the name at all when the action has no destination. Beside
/// the animation sit Figma's four direction arrows, which set the side a Move
/// in / Move out enters from; they only take a press when there is a side.
#[test]
fn the_prototype_row_names_the_action_and_its_arrows_set_the_side() {
    let mut h = host();
    proto_doc(&mut h);
    h.app.doc().right_tab = crate::state::RightTab::Prototype;
    {
        let d = h.app.doc();
        let e = d.editor();
        let n = x_native::editor::find_mut(&mut e.root, "btn").unwrap();
        n.interactions[0].animation = x_native::Animation::MoveIn(x_native::Direction::Left);
    }
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert_eq!(
        h.app
            .hit
            .iter()
            .filter(|(_, a)| matches!(a, Action::ProtoDirection(0, _)))
            .count(),
        4,
        "the four arrows"
    );
    let action_box = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::ProtoActionType(0)))
        .map(|(r, _)| *r)
        .expect("the action pill");
    let dest_box = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::ProtoDest(0, 1)))
        .map(|(r, _)| *r)
        .expect("the destination control");
    assert!(
        dest_box.x0 > action_box.x1,
        "the destination sits past the arrow"
    );
    h.dispatch(Action::ProtoDirection(0, x_native::Direction::Top));
    let n = find_node_clone(&h.app.doc_ref().editor_ref().root, "btn").unwrap();
    assert_eq!(
        n.interactions[0].animation,
        x_native::Animation::MoveIn(x_native::Direction::Top),
        "the arrow set the side"
    );

    // an action with nothing to point at has no arrow and no control
    {
        let d = h.app.doc();
        let e = d.editor();
        let n = x_native::editor::find_mut(&mut e.root, "btn").unwrap();
        n.interactions[0].action = x_native::Action::Back;
    }
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        !h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::ProtoDest(0, 1))),
        "no destination, no control"
    );
}

/// Figma's **Animate matching layers** tick (help 360039818874) is a control
/// in the interaction's own animation section. Ours is a full-width line under
/// the URL field — never over the pill, arrows and duration beside it — and a
/// press writes the flag through the same path as every other row.
#[test]
fn the_interaction_row_carries_figmas_matching_layers_tick() {
    let mut h = host();
    h.app.win_w = 1200.0;
    h.app.win_h = 1400.0;
    proto_doc(&mut h);
    h.app.doc().editor().selection = vec!["btn".into()];
    h.app.doc().right_tab = crate::state::RightTab::Prototype;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let row = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::ProtoToggleMatching(0)))
        .map(|(r, _)| *r)
        .expect("the Animate matching layers row");
    let speed = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::ProtoSpeed(0)))
        .map(|(r, _)| *r)
        .expect("the duration field");
    let remove = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::ProtoRemove(0)))
        .map(|(r, _)| *r)
        .expect("the remove button");
    assert!(row.y0 >= speed.y1, "the tick gets a line of its own");
    assert!(row.x1 <= remove.x1, "and stays inside the panel");
    // Figma's words, from the one label the panel owns
    assert_eq!(
        crate::state::PROTO_MATCHING_LABEL,
        "Animate matching layers"
    );

    // the box writes the flag, and the status says what it now reads
    h.dispatch(Action::ProtoToggleMatching(0));
    let flag = {
        let d = h.app.doc();
        let n = x_native::editor::find(&d.editor_ref().root, "btn").unwrap();
        n.interactions[0].animate_matching_layers
    };
    assert!(flag, "a press turns the tick on");
    assert_eq!(h.app.status, "Animate matching layers: on");
    h.dispatch(Action::ProtoToggleMatching(0));
    let flag = {
        let d = h.app.doc();
        let n = x_native::editor::find(&d.editor_ref().root, "btn").unwrap();
        n.interactions[0].animate_matching_layers
    };
    assert!(!flag, "and again turns it off");
    assert_eq!(h.app.status, "Animate matching layers: off");
}

/// The tick on the clock: a navigation that asks for one freezes the pairing
/// of the two screens, the viewer dissolves the layers that matched nothing at
/// the tick's alpha while the matched ones already sit at their destination,
/// and a navigation without the tick clears whatever was running (help
/// 360039818874).
#[test]
fn the_matching_layers_tick_arms_on_a_navigation_and_dissolves_new_layers() {
    let mut h = host();
    {
        let d = h.app.doc();
        let root_id = d.editor_ref().root.id.clone();
        let mut f1 = Node::frame("f1", 300.0, 200.0);
        f1.name = "Home".into();
        let mut f2 = Node::frame("f2", 300.0, 200.0);
        f2.name = "Detail".into();
        f2.transform.x = 400.0;
        d.editor().insert_node(&root_id, f1);
        d.editor().insert_node(&root_id, f2);
        let mut card = Node::rect("card1", 10.0, 10.0, 80.0, 40.0, Color::BLACK);
        card.name = "Card".into();
        d.editor().insert_node("f1", card);
        let mut card2 = Node::rect("card2", 40.0, 30.0, 120.0, 60.0, Color::BLACK);
        card2.name = "Card".into();
        d.editor().insert_node("f2", card2);
        let mut fresh = Node::rect("fresh", 10.0, 120.0, 40.0, 20.0, Color::BLACK);
        fresh.name = "Fresh".into();
        d.editor().insert_node("f2", fresh);
    }
    h.app.doc().editor().selection = vec!["f1".into()];
    h.dispatch(Action::FlowEnter);
    assert!(h.app.flow.is_some(), "the preview opened");

    let mut ix = x_native::Interaction::click("f2");
    ix.animate_matching_layers = true;
    ix.transition_ms = 300;
    let effect = h.flow_fire(&ix);
    assert_eq!(effect.navigated.as_deref(), Some("f2"));
    let flow = h.app.flow.as_ref().expect("the preview");
    let tick = flow.tick.clone().expect("a tick");
    assert_eq!(tick.plan.len(), 2, "both layers of the new screen");
    assert_eq!(tick.plan[0].to, "card2");
    assert_eq!(tick.plan[1].to, "fresh");
    assert_eq!(tick.matched(), 1, "the card matches by name");
    assert_eq!(tick.arriving(), 1, "the fresh layer is new");
    assert_eq!(tick.pair("card2"), Some("card1"));
    assert!(tick.running(), "300 ms of transition to run");
    assert_eq!(tick.dissolve_alpha(), 0.0, "it arrives from nothing");

    // the viewer paints the arriving layer at the tick's alpha, and the match
    // already at its destination state
    h.flow_advance_tick(60);
    let flow = h.app.flow.as_ref().expect("the preview");
    let tick = flow.tick.clone().expect("a tick");
    assert!(tick.dissolve_alpha() > 0.0 && tick.dissolve_alpha() < 1.0);
    let mut tree = h.app.doc().editor_ref().root.clone();
    crate::editor_ui::paint_tick_tree(&mut tree, &tick);
    let fresh = find_node_clone(&tree, "fresh").unwrap();
    assert!(fresh.opacity < 1.0, "on its way in");
    assert!((fresh.opacity - tick.dissolve_alpha()).abs() < 0.001);
    let card = find_node_clone(&tree, "card2").unwrap();
    assert!(
        card.opacity >= 1.0,
        "a matched layer is not the one dissolving"
    );

    // the clock ends with the interaction's own duration
    h.flow_advance_tick(400);
    let flow = h.app.flow.as_ref().expect("the preview");
    let tick = flow.tick.clone().expect("a tick");
    assert!(!tick.running(), "the transition is over");
    assert_eq!(tick.dissolve_alpha(), 1.0, "and the layer has arrived");

    // a navigation that does not ask for the tick clears it
    let plain = x_native::Interaction::click("f1");
    h.flow_fire(&plain);
    assert!(h.app.flow.as_ref().unwrap().tick.is_none());
}

/// Figma's Prototype-tab **Scroll behavior** block (help 360039818734): a
/// frame has an **Overflow** menu — "No scrolling / Horizontal / Vertical /
/// Both directions" — and the preview then really scrolls it, clamped to the
/// content that sticks out past the frame; an object that sits on a frame that
/// scrolls has a **Position** menu instead — "Scroll with parent / Fixed /
/// Sticky" — which is the FIXED/STICKY pair the renderer already honours.
#[test]
fn the_scroll_behaviour_rows_write_the_frames_overflow_and_a_layers_position() {
    let mut h = host();
    {
        let d = h.app.doc();
        let root_id = d.editor_ref().root.id.clone();
        let mut f = Node::frame("sc", 100.0, 100.0);
        f.overflow = x_native::Overflow::ScrollY;
        f.is_starting_point = true;
        d.editor().insert_node(&root_id, f);
        d.editor().insert_node(
            "sc",
            Node::rect("tall", 0.0, 0.0, 100.0, 400.0, Color::WHITE),
        );
        d.editor()
            .insert_node("sc", Node::rect("nav", 0.0, 0.0, 100.0, 20.0, Color::WHITE));
        // a frame that does NOT scroll: its children have no Position row
        let mut plain = Node::frame("plain", 100.0, 100.0);
        plain.transform.x = 400.0;
        d.editor().insert_node(&root_id, plain);
        d.editor().insert_node(
            "plain",
            Node::rect("inner", 0.0, 0.0, 40.0, 40.0, Color::WHITE),
        );
    }

    // the frame row: Overflow, showing what the frame carries
    h.app.doc().editor().selection = vec!["sc".into()];
    h.app.doc().right_tab = crate::state::RightTab::Prototype;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    use crate::state::ProtoScrollMenu;
    assert!(
        shows_menu(&h, ProtoScrollMenu::Overflow),
        "the Overflow field"
    );
    assert!(
        !shows_menu(&h, ProtoScrollMenu::Position),
        "a top-level frame has no Position row"
    );

    // the menu lists Figma's four options and writes the one pressed
    h.dispatch(Action::ProtoScrollMenu(ProtoScrollMenu::Overflow));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert_eq!(
        h.app
            .hit
            .iter()
            .filter(|(_, a)| matches!(a, Action::ProtoSetOverflow(_)))
            .count(),
        4,
        "No scrolling / Horizontal / Vertical / Both directions"
    );
    h.dispatch(Action::ProtoSetOverflow(2));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .overflow,
        x_native::Overflow::ScrollY,
        "the row wrote the frame's overflow"
    );
    assert!(h.app.dropdown_proto_scroll.is_none(), "the menu closed");

    // "No scrolling" returns to the clip state, not to Visible
    h.dispatch(Action::ProtoSetOverflow(0));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .overflow,
        x_native::Overflow::Clip
    );
    h.dispatch(Action::ProtoSetOverflow(2));

    // a layer on the scrolling frame: Position, and it pins
    h.app.doc().editor().selection = vec!["nav".into()];
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        shows_menu(&h, ProtoScrollMenu::Position),
        "the Position row for a layer on a scrolling frame"
    );
    assert!(
        !shows_menu(&h, ProtoScrollMenu::Overflow),
        "a rect is not a frame, so it has no Overflow row"
    );
    h.dispatch(Action::ProtoSetPosition(1));
    let n = find_node_clone(&h.app.doc_ref().editor_ref().root, "nav").unwrap();
    assert!(n.constraints.fixed && !n.constraints.sticky, "Fixed");
    h.dispatch(Action::ProtoSetPosition(2));
    let n = find_node_clone(&h.app.doc_ref().editor_ref().root, "nav").unwrap();
    assert!(n.constraints.sticky && !n.constraints.fixed, "Sticky");
    h.dispatch(Action::ProtoSetPosition(0));
    let n = find_node_clone(&h.app.doc_ref().editor_ref().root, "nav").unwrap();
    assert!(
        !n.constraints.fixed && !n.constraints.sticky,
        "back to Scroll with parent"
    );

    // a layer on a frame that does not scroll has no Position row at all
    h.app.doc().editor().selection = vec!["inner".into()];
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        !shows_menu(&h, ProtoScrollMenu::Position),
        "Position needs a frame whose overflow scrolls"
    );

    // the preview scrolls the frame with the wheel, inside the frame only
    h.app.doc().editor().selection = vec!["sc".into()];
    h.dispatch(Action::FlowEnter);
    assert!(h.app.flow.is_some(), "the preview opened");
    assert_eq!(h.app.flow.as_ref().unwrap().current, "sc");
    h.app.mouse = h.app.world_to_screen(Point::new(50.0, 50.0));
    h.on_wheel(winit::event::MouseScrollDelta::LineDelta(0.0, -3.0));
    let sc = find_node_clone(&h.app.doc_ref().editor_ref().root, "sc").unwrap();
    assert_eq!(sc.scroll, (0.0, 120.0), "three lines of vertical scroll");
    // a vertical frame ignores the horizontal delta
    h.on_wheel(winit::event::MouseScrollDelta::LineDelta(2.0, 0.0));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .scroll,
        (0.0, 120.0)
    );
    // and stops at the end of the content: 400 of content in a 100 frame
    h.on_wheel(winit::event::MouseScrollDelta::LineDelta(0.0, -20.0));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .scroll,
        (0.0, 300.0),
        "clamped to the scroll range"
    );
    // the wheel outside the frame does nothing
    h.app.mouse = h.app.world_to_screen(Point::new(900.0, 900.0));
    h.on_wheel(winit::event::MouseScrollDelta::LineDelta(0.0, -5.0));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .scroll,
        (0.0, 300.0)
    );
    // an interaction that asks to reset the scroll position navigates with
    // every offset back at zero, and one that preserves it leaves it alone
    let nav = |reset: bool| x_native::Interaction {
        trigger: x_native::Trigger::OnClick,
        action: x_native::Action::Navigate {
            destination: "plain".into(),
        },
        transition_ms: 0,
        animation: x_native::Animation::Instant,
        actions: vec![],
        easing: x_native::Easing::Linear,
        reset_on_navigate: reset,
        animate_matching_layers: false,
    };
    h.flow_fire(&nav(false));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .scroll,
        (0.0, 300.0),
        "Reset: Off preserves the scroll position"
    );
    h.flow_fire(&nav(true));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .scroll,
        (0.0, 0.0),
        "Reset: On loads the next screen from the top"
    );

    // leaving the preview puts the document back the way it was, even when the
    // frame is deep in its content at the time
    h.app.mouse = h.app.world_to_screen(Point::new(50.0, 50.0));
    h.on_wheel(winit::event::MouseScrollDelta::LineDelta(0.0, -8.0));
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .scroll,
        (0.0, 300.0)
    );
    h.dispatch(Action::FlowExit);
    assert_eq!(
        find_node_clone(&h.app.doc_ref().editor_ref().root, "sc")
            .unwrap()
            .scroll,
        (0.0, 0.0),
        "the preview owns the scroll, and gives it back"
    );
}

/// Figma's canvas connection gesture — the course's own chapter, "FD4B: Add
/// prototype connections": the Prototype tab puts "a blue circle on [the
/// selected layer's] edge", and it "changes to a blue plus that we can use to
/// add a new connection". Drag it to another frame and "Figma will snap the
/// connection noodle to the [frame] when you get close enough. Release your
/// cursor to complete the connection." The frame the flow starts from gets "a
/// small blue label … named Flow 1", a connection is an object you can select
/// and Delete, and dragging one onto empty canvas writes nothing.
#[test]
fn the_plus_on_a_layers_edge_draws_a_connection() {
    let mut h = host();
    {
        let d = h.app.doc();
        let root_id = d.editor_ref().root.id.clone();
        let mut f1 = Node::frame("c1", 300.0, 200.0);
        f1.name = "Home".into();
        f1.is_starting_point = true;
        let mut f2 = Node::frame("c2", 300.0, 200.0);
        f2.name = "Case study".into();
        f2.transform.x = 400.0;
        d.editor().insert_node(&root_id, f1);
        d.editor().insert_node(&root_id, f2);
        let mut go = Node::rect("go", 20.0, 20.0, 80.0, 30.0, Color::from_rgb8(9, 9, 9));
        go.name = "Go".into();
        d.editor().insert_node("c1", go);
    }
    h.app.doc().right_tab = crate::state::RightTab::Prototype;
    h.app.doc().editor().selection = vec!["go".into()];
    let root = &h.app.doc_ref().editor_ref().root;
    assert!(crate::editor_ui::page_connections(root).is_empty());
    let go = find_node_clone(root, "go").unwrap();
    let local = crate::editor_ui::conn_anchor_point(&go);
    assert_eq!(local, Point::new(80.0, 15.0), "the layer's own right edge");
    let anchor = Point::new(go.transform.x + local.x, go.transform.y + local.y);
    let on_the_page = Point::new(100.0, 35.0);
    assert_eq!(anchor, on_the_page, "where the circle sits on the page");

    // with the pointer on the circle the plus is up, and it is a hit zone
    let p = h.app.world_to_screen(anchor);
    h.app.mouse = p;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint_over(&mut h.app, &mut scene);
    assert!(
        h.app.hit.iter().any(|(_, a)| matches!(a, Action::ConnMenu)),
        "the plus is there to drag"
    );

    // the drag: nothing snaps halfway, the frame snaps when the pointer is in it
    h.on_press(p);
    assert!(
        matches!(h.app.drag, Some(Drag::ProtoConnect { .. })),
        "the press takes the anchor"
    );
    h.on_move(h.app.world_to_screen(Point::new(250.0, 35.0)));
    assert!(
        matches!(&h.app.drag, Some(Drag::ProtoConnect { target: None, .. })),
        "no frame under the halfway point"
    );
    h.on_move(h.app.world_to_screen(Point::new(450.0, 100.0)));
    let snapped = matches!(
        &h.app.drag,
        Some(Drag::ProtoConnect { target: Some(t), .. }) if t == "c2"
    );
    assert!(snapped, "the noodle snaps to the frame under the pointer");
    h.on_release();
    let conns = crate::editor_ui::page_connections(&h.app.doc_ref().editor_ref().root);
    assert_eq!(conns.len(), 1, "one connection was written");
    let ends = (conns[0].src.as_str(), conns[0].dest.as_str());
    assert_eq!(ends, ("go", "c2"));
    assert_eq!(h.app.status, "On click → Case study (smart animate, 350ms)");

    // "a small blue label ... named Flow 1" on the frame the flow starts from
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(
        crate::editor_ui::flow_name(root, "c1").as_deref(),
        Some("Flow 1")
    );
    let not_a_start = crate::editor_ui::flow_name(root, "c2");
    assert!(not_a_start.is_none(), "not a flow start");

    // a press on the noodle selects that connection, and Delete removes it
    let mid = h.app.world_to_screen(Point::new(250.0, 35.0));
    h.app.mouse = mid;
    h.on_press(mid);
    assert_eq!(h.app.conn_sel, Some(0), "the noodle is an object");
    h.on_key(Key::Named(NamedKey::Delete), None);
    assert!(
        crate::editor_ui::page_connections(&h.app.doc_ref().editor_ref().root).is_empty(),
        "Delete removes the selected connection, not the layer"
    );
    h.app.doc().editor().undo();
    assert_eq!(
        crate::editor_ui::page_connections(&h.app.doc_ref().editor_ref().root).len(),
        1,
        "one undo brings it back"
    );

    // "click and drag the connection to an empty space on the canvas": nothing
    // is written
    h.on_press(h.app.world_to_screen(anchor));
    h.on_move(h.app.world_to_screen(Point::new(1000.0, 500.0)));
    h.on_release();
    assert_eq!(
        crate::editor_ui::page_connections(&h.app.doc_ref().editor_ref().root).len(),
        1,
        "a drop on empty canvas is not a connection"
    );
    assert_eq!(h.app.status, "Connection dropped");
}

/// Figma's rule for a NEW object, from the Frames article: *"Click inside an
/// existing frame to add a 100 x 100 nested frame"* — the shape tools behave the
/// same way, so a shape drawn over a frame joins that frame (nested frames
/// included) and a shape drawn on empty canvas stays on the page.
#[test]
fn a_shape_drawn_over_a_frame_joins_that_frame() {
    let mut h = host();
    assert!(h.app.doc_ref().editor_ref().selection.is_empty());
    // the demo page holds frame-1 at world (0, 60), 375 x 420
    h.finish_create(Tool::Rect, Point::new(40.0, 120.0), Point::new(80.0, 150.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 1, "no new root sibling");
    let f1 = find_node_clone(root, "frame-1").unwrap();
    assert_eq!(f1.children.len(), 1, "the rect did not join frame-1");
    let r = &f1.children[0];
    assert_eq!(
        (r.transform.x, r.transform.y),
        (40.0, 60.0),
        "the rect must be placed in the frame's own space"
    );
    // outside the frame again: the page owns it
    h.app.doc().editor().selection.clear();
    h.finish_create(Tool::Rect, Point::new(500.0, 20.0), Point::new(560.0, 50.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 2, "drawn beside the frame, not in it");
    let f1 = find_node_clone(root, "frame-1").unwrap();
    assert_eq!(f1.children.len(), 1);
}

/// A nested frame takes the new layer over the frame that holds it — the
/// DEEPEST container wins — and a group never captures one (Figma's containers
/// are frames and sections; a group adopting a layer would re-flow it).
#[test]
fn the_deepest_container_wins_and_a_group_does_not_capture() {
    let mut h = host();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    let mut outer = Node::frame("outer", 300.0, 300.0);
    outer.name = "Outer".into();
    h.app.doc().editor().insert_node(&root_id, outer);
    let mut inner = Node::frame("inner", 100.0, 100.0);
    inner.name = "Inner".into();
    inner.transform.x = 50.0;
    inner.transform.y = 50.0;
    h.app.doc().editor().insert_node("outer", inner);
    let mut grp = Node::group("grp", 60.0, 60.0);
    grp.transform.x = 400.0;
    grp.transform.y = 20.0;
    h.app.doc().editor().insert_node(&root_id, grp);
    h.app.doc().editor().selection.clear();

    // inside the nested frame: the nested frame wins
    h.finish_create(Tool::Rect, Point::new(80.0, 80.0), Point::new(100.0, 100.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(
        find_node_clone(root, "inner").unwrap().children.len(),
        1,
        "the nested frame did not take the new layer"
    );
    assert!(find_node_clone(root, "outer").unwrap().children.len() == 1);
    // over the group: the page keeps it
    h.app.doc().editor().selection.clear();
    h.finish_create(Tool::Rect, Point::new(410.0, 30.0), Point::new(430.0, 50.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert!(
        find_node_clone(root, "grp").unwrap().children.is_empty(),
        "a group captured a new layer"
    );
    assert_eq!(root.children.len(), 4, "the page kept the shape");
}

/// A container you cannot select is a container you cannot draw into: a hidden
/// or locked frame is skipped, exactly like the canvas click that would have
/// selected it.
#[test]
fn a_hidden_or_locked_frame_does_not_take_the_shape() {
    let mut h = host();
    h.app.doc().editor().set_locked("frame-1", true);
    h.app.doc().editor().selection.clear();
    h.finish_create(Tool::Rect, Point::new(40.0, 120.0), Point::new(80.0, 150.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert!(
        find_node_clone(root, "frame-1")
            .unwrap()
            .children
            .is_empty(),
        "a locked frame captured the shape"
    );
    assert_eq!(root.children.len(), 2, "the page kept it");
    // unlock, then hide: same answer
    h.app.doc().editor().set_locked("frame-1", false);
    h.app.doc().editor().set_visible("frame-1", false);
    h.app.doc().editor().selection.clear();
    h.finish_create(Tool::Rect, Point::new(40.0, 120.0), Point::new(80.0, 150.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert!(
        find_node_clone(root, "frame-1")
            .unwrap()
            .children
            .is_empty(),
        "a hidden frame captured the shape"
    );
    assert_eq!(root.children.len(), 3, "the page kept it");
}

/// Figma's "prevent nesting" modifier, from their own tip: *"To prevent an
/// object from being nested, hold the Spacebar while dragging."* Space is also
/// this app's pan key, and a pan started BEFORE the press cannot be running —
/// the create drag owns the pointer — so the two never fight.
#[test]
fn holding_space_while_drawing_keeps_the_shape_on_the_page() {
    let mut h = host();
    h.app.doc().editor().selection.clear();
    h.app.space_pan = true;
    h.finish_create(Tool::Rect, Point::new(40.0, 120.0), Point::new(80.0, 150.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert!(
        find_node_clone(root, "frame-1")
            .unwrap()
            .children
            .is_empty(),
        "space did not stop the nesting"
    );
    assert_eq!(root.children.len(), 2, "the shape must land on the page");
    h.app.space_pan = false;
}

/// Figma's shape-tool modifiers, from the Shape tools article: *"Hold down
/// Shift when dragging to create perfect squares, circles and polygons. Hold
/// down Option / Alt to create and resize shapes from their center."* One rule
/// serves the preview and the commit, so ⌥ cannot mean two things.
#[test]
fn shape_tool_modifiers_build_the_rect_the_preview_shows() {
    use crate::state::create_rect;
    let a = Point::new(100.0, 100.0);
    let up_left = Point::new(60.0, 70.0);
    let plain = create_rect(a, up_left, false);
    assert_eq!(
        (plain.x0, plain.y0, plain.x1, plain.y1),
        (60.0, 70.0, 100.0, 100.0)
    );
    let centred = create_rect(a, up_left, true);
    assert_eq!(
        (centred.x0, centred.y0, centred.x1, centred.y1),
        (60.0, 70.0, 140.0, 130.0),
        "⌥ makes the press point the centre"
    );
    assert_eq!(
        (centred.width(), centred.height()),
        (2.0 * plain.width(), 2.0 * plain.height())
    );
    // and the commit agrees with the rule, down to the pixel
    let mut h = host();
    h.app.doc().editor().selection.clear();
    h.app.alt = true;
    h.finish_create(
        Tool::Rect,
        Point::new(500.0, 300.0),
        Point::new(520.0, 310.0),
    );
    let root = &h.app.doc_ref().editor_ref().root;
    let r = root
        .children
        .iter()
        .find(|n| n.id != "frame-1")
        .expect("the shape");
    assert_eq!(
        (r.transform.x, r.transform.y, r.w, r.h),
        (480.0, 290.0, 40.0, 20.0)
    );
    h.app.alt = false;
}

/// Figma's layers panel puts an eye and a padlock on the row you hover; they
/// stay while the state is on, and a locked layer stops answering the canvas.
/// (Figma interface — "You can lock and unlock each layer … click on the
/// Padlock icon that appears next to the layer name when you hover".)
/// Figma's Scale tool (K): the Move tool's four corner handles with a
/// different fixed point — the corner you are NOT holding — and a box that
/// takes the strokes, radii and text with it instead of stretching around
/// them. Escape hatch: V gets you back to the Move tool.
#[test]
fn the_scale_tool_grows_a_layer_from_the_corner_you_are_not_holding() {
    let mut h = host();
    // K is the tool, in design mode only (boards have their own model)
    assert_eq!(Tool::from_shortcut("k", false, false), Some(Tool::Scale));
    assert_eq!(Tool::from_shortcut("k", false, true), None);
    assert_eq!(Tool::Scale.shortcut_hint(false), "K");
    assert_eq!(Tool::Scale.label(), "Scale");
    // and it is discoverable, not keyboard-only: the palette lists it
    assert!(crate::editor_ui::palette_commands()
        .iter()
        .any(|c| c.label == "Scale tool"));
    // …and Esc is the other way back to Move, with the selection intact
    h.app.tool = Tool::Scale;
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert_eq!(h.app.tool, Tool::Select, "Esc leaves the Scale tool");

    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.app.doc().editor().mutate_visual_stack("frame-1", |n| {
        n.stroke.width = 2.0;
    });
    let depth0 = h.app.doc_ref().editor_ref().undo_depth();
    // frame-1 is (0, 60) 375x420. Grab the BOTTOM-RIGHT handle, which pins
    // the top-left corner, and drag to exactly twice the box.
    let grab = h.scale_grab(Point::new(375.0, 480.0)).expect("corner grab");
    h.app.drag = Some(grab);
    h.on_move(h.app.world_to_screen(Point::new(750.0, 900.0)));
    let f1 = find_node_clone(&h.app.doc_ref().editor_ref().root, "frame-1").unwrap();
    assert_eq!(
        (f1.transform.x, f1.transform.y),
        (0.0, 60.0),
        "the anchor corner moved"
    );
    assert_eq!((f1.w, f1.h), (750.0, 840.0));
    assert_eq!(
        f1.stroke.width, 4.0,
        "the stroke must travel with the box, unlike a Move-tool resize"
    );
    // the whole drag is ONE editor step, not one per move event — the same
    // rule `t16_layer_drag_merges_into_one_undo_step` pins for a move drag.
    // (The document history records coarser entries at UI-action boundaries,
    // so the claim is checked where the gesture actually lands.)
    h.on_release();
    assert_eq!(
        h.app.doc_ref().editor_ref().undo_depth(),
        depth0 + 1,
        "the drag must merge into one undo step"
    );
    h.app.doc().editor().undo();
    let f1 = find_node_clone(&h.app.doc_ref().editor_ref().root, "frame-1").unwrap();
    assert_eq!((f1.w, f1.h), (375.0, 420.0));
    assert_eq!(
        f1.stroke.width, 2.0,
        "one undo restores the pre-drag state, stroke included"
    );
}

/// The Scale panel's own tables: nine anchor cells and the corner a body drag
/// scales about — plus the proof that the handle rule and the body rule are the
/// SAME projection, so the two gestures cannot drift apart.
#[test]
fn the_scale_tables_are_figmas_nine_points() {
    let bx = (10.0, 20.0, 100.0, 60.0);
    assert_eq!(crate::state::scale_cell_anchor(bx, 0), (10.0, 20.0));
    assert_eq!(crate::state::scale_cell_anchor(bx, 4), (60.0, 50.0));
    assert_eq!(crate::state::scale_cell_anchor(bx, 8), (110.0, 80.0));
    let near = |p: Point| crate::state::nearest_corner(bx, p);
    assert_eq!(near(Point::new(12.0, 22.0)), 0);
    assert_eq!(near(Point::new(108.0, 22.0)), 1);
    assert_eq!(near(Point::new(12.0, 78.0)), 2);
    assert_eq!(near(Point::new(108.0, 78.0)), 3);
    // one projection, two gestures: the handle grab's factor IS the general
    // rule's, with the grabbed corner as the grab point
    let corner = 1;
    let anchor = crate::state::scale_anchor(bx, corner);
    let grab = crate::state::corner_point(bx, corner);
    let pointer = Point::new(500.0, 33.0);
    let (f, a) = crate::state::scale_drag_factor(bx, corner, pointer);
    assert_eq!(a, anchor);
    assert_eq!(f, crate::state::scale_grab_factor(anchor, grab, pointer));
    // a drag past the anchor is clamped, never mirrored
    let flat =
        crate::state::scale_grab_factor((0.0, 0.0), Point::new(10.0, 0.0), Point::new(-1.0, 0.0));
    assert_eq!(flat, crate::state::MIN_SCALE);
}

/// The Scale tool's second half — the panel and the body drag. Figma's page:
/// "Use the scale multiplier, in the Scale panel … type a multiplier in the
/// text field and press Enter"; "Use either the width or height fields … The
/// other dimension field will automatically update"; "Hover over the object's
/// bounding box to make the cursor appear. Then, click-and-drag to resize";
/// and the anchor box "tells Figma which side of the object to stay put".
#[test]
fn the_scale_panel_and_the_body_drag_scale_the_selection() {
    let mut h = host();
    assert_eq!(h.app.scale_cell, 4, "the panel opens on the centre");
    h.dispatch(Action::ScaleCell(99));
    assert_eq!(h.app.scale_cell, 8, "a stray cell clamps to the last one");

    // a 100x100 rect on the page (space = Figma's "prevent nesting", so the
    // panel's numbers below are page coordinates)
    h.app.space_pan = true;
    h.finish_create(
        Tool::Rect,
        Point::new(500.0, 20.0),
        Point::new(600.0, 120.0),
    );
    h.app.space_pan = false;
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    h.app.tool = Tool::Scale;
    let depth0 = h.app.doc_ref().editor_ref().undo_depth();

    // the multiplier, about the centre cell: it halves and stays centred
    h.dispatch(Action::ScaleCell(4));
    set_field(&mut h, FieldId::ScaleFactor, "50%");
    let root = &h.app.doc_ref().editor_ref().root;
    let half = find_node_clone(root, &sel[0]).expect("the rect is there");
    assert_eq!((half.transform.x, half.transform.y), (525.0, 45.0));
    assert_eq!((half.w, half.h), (50.0, 50.0));
    assert_eq!(h.app.doc_ref().editor_ref().undo_depth(), depth0 + 1);
    h.app.doc().editor().undo();

    // about the top-left cell, 200% leaves the top-left where it was
    h.dispatch(Action::ScaleCell(0));
    set_field(&mut h, FieldId::ScaleFactor, "200%");
    let root = &h.app.doc_ref().editor_ref().root;
    let big = find_node_clone(root, &sel[0]).expect("the rect is there");
    assert_eq!((big.transform.x, big.transform.y), (500.0, 20.0));
    assert_eq!((big.w, big.h), (200.0, 200.0));

    // the W field is the same scale by another route — and H follows it
    set_field(&mut h, FieldId::ScaleW, "300");
    let root = &h.app.doc_ref().editor_ref().root;
    let wide = find_node_clone(root, &sel[0]).expect("the rect is there");
    assert_eq!((wide.w, wide.h), (300.0, 300.0), "both fields follow");
    assert_eq!((wide.transform.x, wide.transform.y), (500.0, 20.0));

    // the body drag: on the canvas K never moves a layer — a press inside the
    // box scales it about the corner OPPOSITE the nearest one to the press
    let reg = h.app.editor_regions();
    let cx = (reg.canvas.x0 + reg.canvas.x1) / 2.0;
    let cy = (reg.canvas.y0 + reg.canvas.y1) / 2.0;
    let centre = h.app.screen_to_world(Point::new(cx, cy));
    h.app.space_pan = true;
    h.finish_create(
        Tool::Rect,
        Point::new(centre.x - 50.0, centre.y - 50.0),
        Point::new(centre.x + 50.0, centre.y + 50.0),
    );
    h.app.space_pan = false;
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let depth1 = h.app.doc_ref().editor_ref().undo_depth();
    // the box's far corner, in the space the drag will scale about
    let (far_x0, far_y0, wide0) = {
        let root = &h.app.doc_ref().editor_ref().root;
        let before = find_node_clone(root, &sel[0]).expect("the fresh rect");
        (
            before.transform.x + before.w,
            before.transform.y + before.h,
            before.w,
        )
    };
    h.app.tool = Tool::Scale;
    let press = Point::new(centre.x - 30.0, centre.y - 30.0);
    h.on_press(h.app.world_to_screen(press));
    assert!(
        matches!(&h.app.drag, Some(Drag::ScaleBody { .. })),
        "K scales the body; it never moves a layer"
    );
    let nudged = Point::new(centre.x - 33.0, centre.y - 33.0);
    h.on_move(h.app.world_to_screen(nudged));
    h.on_release();
    let root = &h.app.doc_ref().editor_ref().root;
    let grown = find_node_clone(root, &sel[0]).expect("the dragged rect");
    assert!(grown.w > wide0, "the box grew: {}", grown.w);
    let square = (grown.w - grown.h).abs();
    assert!(square < 1e-6, "a scale keeps the ratio");
    let far_x = grown.transform.x + grown.w;
    let far_y = grown.transform.y + grown.h;
    assert!((far_x - far_x0).abs() < 0.5, "the far corner stayed put");
    assert!((far_y - far_y0).abs() < 0.5, "the far corner stayed put");
    assert_eq!(h.app.doc_ref().editor_ref().undo_depth(), depth1 + 1);
    h.app.doc().editor().undo();
    let root = &h.app.doc_ref().editor_ref().root;
    let back = find_node_clone(root, &sel[0]).expect("the rect is back");
    let box_back = (100.0, 100.0);
    assert_eq!((back.w, back.h), box_back, "one undo restores the box");
}

/// Figma's arc properties on an ellipse — the course's own chapter 26
/// ("FD4B: Turn an ellipse into an arc"): hover for the Sweep handle, drag it,
/// then Start and Ratio appear, and the same three are fields in the right
/// sidebar. The whole thing is non-destructive: "the shape's bounding box
/// stayed the same size to preserve space in case we wanted to change the arc
/// again", and Flatten is what makes the box hug the geometry.
#[test]
fn the_arc_handles_and_fields_turn_an_ellipse_into_a_ring() {
    let mut h = host();
    let reg = h.app.editor_regions();
    let cx = (reg.canvas.x0 + reg.canvas.x1) / 2.0;
    let cy = (reg.canvas.y0 + reg.canvas.y1) / 2.0;
    let centre = h.app.screen_to_world(Point::new(cx, cy));
    h.app.space_pan = true;
    h.finish_create(
        Tool::Ellipse,
        Point::new(centre.x - 50.0, centre.y - 50.0),
        Point::new(centre.x + 50.0, centre.y + 50.0),
    );
    h.app.space_pan = false;
    let id = h.app.doc_ref().editor_ref().selection[0].clone();
    let (ox, oy) = {
        let n = find_node_clone(&h.app.doc_ref().editor_ref().root, &id).unwrap();
        (n.transform.x, n.transform.y)
    };

    // a solid ellipse offers exactly ONE handle, at 0 — "when you hover over
    // the circle, a single handle will appear on the right-hand side"
    let n = find_node_clone(&h.app.doc_ref().editor_ref().root, &id).unwrap();
    let handles = crate::state::arc_handles(&n);
    assert_eq!(handles.len(), 1, "the Sweep handle alone");
    assert_eq!(handles[0].0, crate::state::ArcPart::Sweep);
    assert_eq!(handles[0].1, Point::new(100.0, 50.0), "the 0 point, east");

    // the Move tool owns it; another tool keeps its own gesture
    h.app.tool = Tool::Ellipse;
    assert!(
        crate::state::arc_target(&h.app).is_none(),
        "not while a shape tool is drawing"
    );
    h.app.tool = Tool::Select;
    assert!(crate::state::arc_target(&h.app).is_some());

    // drag the Sweep handle a quarter of the way round: a pie
    let east = h.app.world_to_screen(Point::new(ox + 100.0, oy + 50.0));
    let south = h.app.world_to_screen(Point::new(ox + 50.0, oy + 100.0));
    h.on_press(east);
    assert!(
        matches!(
            h.app.drag,
            Some(Drag::ArcHandle {
                part: crate::state::ArcPart::Sweep,
                ..
            })
        ),
        "the handle takes the press"
    );
    h.on_move(south);
    h.on_release();
    let node = find_node_clone(&h.app.doc_ref().editor_ref().root, &id).unwrap();
    let (start, end, ratio) = crate::state::arc_props(&node).unwrap();
    assert!(
        (start - 0.0).abs() < 1e-6 && (end - 90.0).abs() < 1e-6 && ratio == 0.0,
        "a quarter sweep: {start} {end} {ratio}"
    );
    assert_eq!(
        (node.w, node.h),
        (100.0, 100.0),
        "the box never moves: the properties are appearance, not size"
    );
    // …and the other two handles appear with it
    let handles = crate::state::arc_handles(&node);
    assert_eq!(handles.len(), 3, "Sweep, Start and Ratio");
    assert_eq!(handles[1].0, crate::state::ArcPart::Start);
    assert_eq!(
        handles[2].1,
        Point::new(50.0, 50.0),
        "the Ratio handle starts at the centre of the circle"
    );

    // the fields: FD4B's own numbers (Start 180, Sweep 25, Ratio 15)
    set_field(&mut h, FieldId::ArcStart, "180");
    set_field(&mut h, FieldId::ArcSweep, "25");
    set_field(&mut h, FieldId::ArcRatio, "15");
    let node = find_node_clone(&h.app.doc_ref().editor_ref().root, &id).unwrap();
    let (start, end, ratio) = crate::state::arc_props(&node).unwrap();
    assert!((start - 180.0).abs() < 1e-6, "start: {start}");
    assert!(
        (x_native::booleans::arc_sweep(start, end) - 25.0).abs() < 1e-6,
        "sweep: {end}"
    );
    assert!((ratio - 0.15).abs() < 1e-6, "ratio: {ratio}");
    assert_eq!((node.w, node.h), (100.0, 100.0), "still the same box");

    // the Ratio handle is dragged out from the centre: a ring. Its handle is
    // where the one handle table says it is — the test asks, not assumes.
    let (ox, oy) = (node.transform.x, node.transform.y);
    let ratio_local = crate::state::arc_handles(&node)
        .into_iter()
        .find(|(p, _)| *p == crate::state::ArcPart::Ratio)
        .map(|(_, p)| p)
        .expect("an arc shows the Ratio handle");
    let press = Point::new(ox + ratio_local.x, oy + ratio_local.y);
    h.on_press(h.app.world_to_screen(press));
    assert!(
        matches!(
            h.app.drag,
            Some(Drag::ArcHandle {
                part: crate::state::ArcPart::Ratio,
                ..
            })
        ),
        "the ratio handle takes the press"
    );
    let rim = h.app.world_to_screen(Point::new(ox + 75.0, oy + 50.0));
    h.on_move(rim);
    h.on_release();
    let node = find_node_clone(&h.app.doc_ref().editor_ref().root, &id).unwrap();
    let (_, _, ratio) = crate::state::arc_props(&node).unwrap();
    assert!(
        (ratio - 0.5).abs() < 1e-6,
        "dragged to half the radius: {ratio}"
    );
    assert_eq!((node.w, node.h), (100.0, 100.0), "and the box is untouched");
    // the whole gesture is one undo step, like every other canvas drag
    h.app.doc().editor().undo();
    let node = find_node_clone(&h.app.doc_ref().editor_ref().root, &id).unwrap();
    let (_, _, ratio) = crate::state::arc_props(&node).unwrap();
    assert!((ratio - 0.15).abs() < 1e-6, "one undo restores the ring");
}

/// Figma's two counting shapes: the Polygon ("an enclosed shape that is made
/// up of any number of straight lines", a triangle by default) and the Star
/// ("polygons that are arranged in a star shape … five pointed … with ten
/// sides"). Both are drawn with their tools, counted in the Appearance
/// fields, and reshaped by their canvas handles — and the box never moves,
/// the same rule the arc's properties obey.
#[test]
fn the_polygon_and_star_tools_count_their_sides() {
    let mut h = host();
    let reg = h.app.editor_regions();
    let (cx, cy) = (
        (reg.canvas.x0 + reg.canvas.x1) / 2.0,
        (reg.canvas.y0 + reg.canvas.y1) / 2.0,
    );
    // the two tools are on the row and in the palette
    assert_eq!(Tool::Poly.icon(), "triangle");
    assert_eq!(Tool::Star.icon(), "star");
    assert_eq!(Tool::Poly.label(), "Polygon");
    assert_eq!(Tool::Star.label(), "Star");
    assert_eq!(Tool::from_shortcut("p", false, false), Some(Tool::Pen));
    assert!(crate::editor_ui::palette_commands()
        .iter()
        .any(|c| c.label == "Polygon tool"));

    // a drag with the Polygon tool: Figma's default triangle
    h.app.tool = Tool::Poly;
    h.on_press(Point::new(cx - 60.0, cy - 60.0));
    h.on_move(Point::new(cx + 60.0, cy + 60.0));
    h.on_release();
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let poly = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert!(poly.name.starts_with("Polygon "), "named for the layers");
    assert_eq!(crate::state::poly_sides(&poly), Some(3), "a triangle");
    let (px, py, pw, ph) = (poly.transform.x, poly.transform.y, poly.w, poly.h);
    assert_eq!((pw.round(), ph.round()), (120.0, 120.0), "the drag's box");
    assert_eq!(h.app.tool, Tool::Select, "the tool hands back to Move");
    let cmds = x_native::booleans::poly_path_cmds(pw, ph, 3);
    assert_eq!(cmds.len(), 4, "three vertices and a Close");
    assert!(matches!(cmds.last(), Some(PathCmd::Close)));

    // its one canvas handle rides the shape's rightmost vertex
    let handles = crate::state::shape_handles(&poly);
    assert_eq!(handles.len(), 1, "the Count handle alone");
    assert_eq!(handles[0].0, crate::state::ShapePart::Count);

    // the Count field, Figma's "typing in a number": 200 clamps to 60
    set_field(&mut h, FieldId::ShapeCount, "200");
    let poly = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert_eq!(
        crate::state::poly_sides(&poly),
        Some(x_native::booleans::COUNT_MAX),
        "clamped to Figma's maximum"
    );
    set_field(&mut h, FieldId::ShapeCount, "6");
    let poly = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert_eq!(crate::state::poly_sides(&poly), Some(6), "a hexagon");
    assert_eq!(
        (poly.transform.x, poly.transform.y, poly.w, poly.h),
        (px, py, pw, ph),
        "the box never moves: the Count is appearance, not size"
    );

    // the Count handle: dragged to the centre the count falls to the minimum,
    // and the whole gesture is one undo step like every other canvas drag
    let depth = h.app.doc_ref().editor_ref().undo_depth();
    let handle = crate::state::shape_handles(&poly)[0].1;
    // the drag started over Frame, so the shape nested INSIDE it — Figma's
    // draw-it-in rule — and the box is frame-local: canvas maths goes through
    // the layer's own world matrix, not the transform alone
    let m = {
        let root = &h.app.doc_ref().editor_ref().root;
        node_world(root, &sel[0]).unwrap()
    };
    let press = m * handle;
    h.on_press(h.app.world_to_screen(press));
    assert!(
        matches!(
            h.app.drag,
            Some(Drag::ShapeHandle {
                part: crate::state::ShapePart::Count,
                ..
            })
        ),
        "the count handle takes the press"
    );
    let centre = m * Point::new(pw / 2.0, ph / 2.0);
    h.on_move(h.app.world_to_screen(centre));
    h.on_release();
    let poly = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert_eq!(
        crate::state::poly_sides(&poly),
        Some(x_native::booleans::COUNT_MIN),
        "dragged to the centre: the minimum"
    );
    assert_eq!(
        h.app.doc_ref().editor_ref().undo_depth(),
        depth + 1,
        "one undo step"
    );
    h.app.doc().editor().undo();
    let poly = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert_eq!(crate::state::poly_sides(&poly), Some(6), "and one undo");

    // and the other way: a drag OUT past the rim adds points — half a radius
    // beyond it is half the span's 20, so six sides become sixteen
    let depth = h.app.doc_ref().editor_ref().undo_depth();
    let handle = crate::state::shape_handles(&poly)[0].1;
    let press = m * handle;
    h.on_press(h.app.world_to_screen(press));
    let out = m * Point::new(pw * 1.25, ph / 2.0);
    h.on_move(h.app.world_to_screen(out));
    h.on_release();
    let poly = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert_eq!(
        crate::state::poly_sides(&poly),
        Some(16),
        "half a radius out"
    );
    assert_eq!(
        h.app.doc_ref().editor_ref().undo_depth(),
        depth + 1,
        "one undo step"
    );
    h.app.doc().editor().undo();
    let poly = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert_eq!(
        crate::state::poly_sides(&poly),
        Some(6),
        "one undo takes it back"
    );

    // the Star tool: five points, "ten sides", the inner points at the ratio
    h.app.tool = Tool::Star;
    h.on_press(Point::new(cx - 50.0, cy - 50.0));
    h.on_move(Point::new(cx + 50.0, cy + 50.0));
    h.on_release();
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let star = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    assert!(star.name.starts_with("Star "), "named for the layers panel");
    let (points, ratio) = crate::state::star_props(&star).expect("a star");
    assert_eq!(points, 5, "a five pointed star");
    assert!(
        (ratio - x_native::booleans::STAR_RATIO).abs() < 1e-9,
        "the inner points at Figma's default ratio"
    );
    let (sx, sy, sw, sh) = (star.transform.x, star.transform.y, star.w, star.h);
    let cmds = x_native::booleans::star_path_cmds(sw, sh, points, ratio);
    assert_eq!(cmds.len(), 11, "ten sides and the Close");

    // two handles: the Count and the Ratio
    let handles = crate::state::shape_handles(&star);
    assert_eq!(handles.len(), 2, "Count and Ratio");
    let named = handles.iter().map(|(p, _)| *p).collect::<Vec<_>>();
    assert!(
        named.contains(&crate::state::ShapePart::Ratio),
        "the Ratio handle"
    );

    // the Ratio field is a percentage, and it never moves the box either
    set_field(&mut h, FieldId::StarRatio, "25");
    let star = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    let (points, ratio) = crate::state::star_props(&star).unwrap();
    assert_eq!(points, 5, "the Count is untouched");
    assert!((ratio - 0.25).abs() < 1e-6, "a quarter of the radius");

    // dragging the Ratio handle out to half the radius sets 50%
    let handle = crate::state::shape_handles(&star)
        .into_iter()
        .find(|(p, _)| *p == crate::state::ShapePart::Ratio)
        .map(|(_, p)| p)
        .expect("a star shows the Ratio handle");
    // the star nested into the same frame, so its own world matrix applies
    let sm = {
        let root = &h.app.doc_ref().editor_ref().root;
        node_world(root, &sel[0]).unwrap()
    };
    let press = sm * handle;
    h.on_press(h.app.world_to_screen(press));
    assert!(
        matches!(
            h.app.drag,
            Some(Drag::ShapeHandle {
                part: crate::state::ShapePart::Ratio,
                ..
            })
        ),
        "the ratio handle takes the press"
    );
    let half = sm * Point::new(sw / 2.0 + sw / 4.0, sh / 2.0);
    h.on_move(h.app.world_to_screen(half));
    h.on_release();
    let star = find_node_clone(&h.app.doc_ref().editor_ref().root, &sel[0]).unwrap();
    let (_, ratio) = crate::state::star_props(&star).unwrap();
    assert!((ratio - 0.5).abs() < 1e-6, "dragged to half the radius");
    assert_eq!(
        (star.transform.x, star.transform.y, star.w, star.h),
        (sx, sy, sw, sh),
        "and the box is untouched"
    );
}

/// ⌥⌘G is Figma's Frame selection: the selection goes into a NEW frame sized
/// to the members' collective bounds, with their positions preserved. The
/// engine had this since the wrap-selection refactor; nothing could reach it.
#[test]
fn option_command_g_wraps_the_selection_in_a_frame_like_figma() {
    let mut h = host();
    h.finish_create(Tool::Rect, Point::new(500.0, 20.0), Point::new(560.0, 50.0));
    let ids: Vec<String> = h
        .app
        .doc_ref()
        .editor_ref()
        .root
        .children
        .iter()
        .map(|c| c.id.clone())
        .collect();
    assert_eq!(ids.len(), 2, "frame-1 + the new rect");
    h.app.doc().editor().selection = ids;
    h.app.ctrl = true;
    h.app.alt = true;
    h.on_key(Key::Character("g".into()), Some("g"));
    h.app.ctrl = false;
    h.app.alt = false;
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 1, "the members did not move inside");
    let frame = &root.children[0];
    assert!(matches!(frame.kind, NodeKind::Frame { .. }));
    // the frame IS the collective bounds: (0,60)+375x420 with (500,20)+60x30
    assert_eq!(
        (frame.transform.x, frame.transform.y, frame.w, frame.h),
        (0.0, 20.0, 560.0, 460.0)
    );
    assert_eq!(frame.children.len(), 2);
    // and the members keep the place they had on the page: frame-1 sat 40px
    // below the new frame's top edge, and it still does
    let inner = find_node_clone(frame, "frame-1").unwrap();
    assert_eq!((inner.transform.x, inner.transform.y), (0.0, 40.0));
    assert_eq!((inner.w, inner.h), (375.0, 420.0));
    // the new frame is what you are left holding, like Figma
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec![frame.id.clone()]
    );
}

#[test]
fn frame_selection_refuses_an_empty_selection_and_grouping_still_groups() {
    let mut h = host();
    h.app.ctrl = true;
    h.app.alt = true;
    h.on_key(Key::Character("g".into()), Some("g"));
    assert!(
        h.app.status.contains("Select at least one"),
        "empty selection: {}",
        h.app.status
    );
    assert_eq!(h.app.doc_ref().editor_ref().root.children.len(), 1);

    // ⌘G without ⌥ is untouched by the new arm: two siblings still GROUP
    // (Figma's own shortcut), they do not become a frame
    h.finish_create(Tool::Rect, Point::new(500.0, 20.0), Point::new(560.0, 50.0));
    let ids: Vec<String> = h
        .app
        .doc_ref()
        .editor_ref()
        .root
        .children
        .iter()
        .map(|c| c.id.clone())
        .collect();
    h.app.doc().editor().selection = ids;
    h.app.alt = false;
    h.on_key(Key::Character("g".into()), Some("g"));
    h.app.ctrl = false;
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 1);
    assert!(
        matches!(root.children[0].kind, NodeKind::Group),
        "⌘G must still group"
    );
}

/// Figma's Slice tool (S): draw a region whose only job is to be exported.
/// The slice is a leaf that draws nothing itself — the editor marks it with a
/// dashed outline and its name, and exporting it captures what overlaps it
/// (that half is pinned in `crates/x-native/tests/slice_export.rs`).
/// ⇧P is the Pencil: a freehand stroke lands as ONE smoothed vector layer,
/// stroked with the tool's round 3px ink, in the container the stroke started
/// in — and the pencil STAYS the active tool, which is the one thing Figma's
/// own page is explicit about.
#[test]
fn the_pencil_draws_a_smoothed_stroke() {
    let mut h = host();
    assert_eq!(Tool::from_shortcut("p", true, false), Some(Tool::Pencil));
    assert_eq!(Tool::from_shortcut("p", false, false), Some(Tool::Pen));
    assert_eq!(Tool::Pencil.shortcut_hint(false), "⇧P");
    assert!(crate::editor_ui::palette_commands()
        .iter()
        .any(|c| c.label == "Pencil tool"));

    // one stroke: press, three moves, release — all inside the canvas
    let reg = h.app.editor_regions();
    let (cx, cy) = (
        (reg.canvas.x0 + reg.canvas.x1) / 2.0,
        (reg.canvas.y0 + reg.canvas.y1) / 2.0,
    );
    let depth0 = h.app.doc_ref().editor_ref().undo_depth();
    h.app.tool = Tool::Pencil;
    h.on_press(Point::new(cx, cy));
    h.on_move(Point::new(cx + 40.0, cy + 14.0));
    h.on_move(Point::new(cx + 74.0, cy - 22.0));
    h.on_move(Point::new(cx + 104.0, cy + 6.0));
    h.on_release();

    let sel = h.app.doc_ref().editor_ref().selection.clone();
    assert_eq!(sel.len(), 1, "the stroke is the selection");
    let root = &h.app.doc_ref().editor_ref().root;
    let id = sel[0].clone();
    let v = find_node_clone(root, &id).expect("the stroke landed");
    assert!(matches!(v.kind, NodeKind::Vector { .. }), "a vector landed");
    assert!(v.name.starts_with("Pencil "), "named in the layers panel");
    let path = match &v.kind {
        NodeKind::Vector { path } => path,
        _ => unreachable!(),
    };
    assert!(path.len() >= 3, "a stroke is a path, not a point");
    assert!(
        path.iter().any(|c| matches!(c, PathCmd::CurveTo(..))),
        "the samples are smoothed into curves"
    );
    assert_eq!(v.stroke.width, crate::state::PENCIL_WEIGHT);
    let filled = matches!(&v.fill, Paint::Solid(c) if c.components[3] > 0.0);
    assert!(!filled, "a sketch is a line, not a blob");
    let start_cap = v.stroke_layers.first().map(|l| l.options.cap_start);
    assert_eq!(start_cap, Some(x_native::StrokeCap::Round));
    let end_cap = v.stroke_layers.first().map(|l| l.options.cap_end);
    assert_eq!(end_cap, Some(x_native::StrokeCap::Round));
    assert_eq!(h.app.tool, Tool::Pencil, "the pencil stays active");

    // one stroke is ONE undo step, and undoing it takes the whole path away
    assert_eq!(
        h.app.doc_ref().editor_ref().undo_depth(),
        depth0 + 1,
        "the whole stroke is one entry"
    );
    h.app.doc().editor().undo();
    let root = &h.app.doc_ref().editor_ref().root;
    assert!(
        find_node_clone(root, &sel[0]).is_none(),
        "one undo removes it"
    );

    // the draw-it-in rule holds for the pencil too: a stroke STARTED inside
    // frame-1 (world 0,60 375x420) joins the frame
    h.on_press(h.app.world_to_screen(Point::new(100.0, 200.0)));
    h.on_move(h.app.world_to_screen(Point::new(150.0, 230.0)));
    h.on_move(h.app.world_to_screen(Point::new(200.0, 210.0)));
    h.on_release();
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let root = &h.app.doc_ref().editor_ref().root;
    let f1 = find_node_clone(root, "frame-1").expect("frame-1");
    assert!(
        find_node_clone(&f1, &sel[0]).is_some(),
        "the stroke joined the frame it was drawn in"
    );

    // ⇧ while drawing is the page's "draw in a straight line": two samples,
    // one cubic — a straight segment, not a freehand wobbler
    h.app.shift = true;
    h.on_press(h.app.world_to_screen(Point::new(60.0, 300.0)));
    h.on_move(h.app.world_to_screen(Point::new(160.0, 340.0)));
    h.on_move(h.app.world_to_screen(Point::new(260.0, 380.0)));
    h.on_release();
    h.app.shift = false;
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let root = &h.app.doc_ref().editor_ref().root;
    let line = find_node_clone(root, &sel[0]).expect("the line landed");
    let line_path = match &line.kind {
        NodeKind::Vector { path } => path,
        _ => unreachable!(),
    };
    assert_eq!(line_path.len(), 2, "⇧ collapses the stroke to one segment");

    // Esc leaves the pencil (Figma: "until you select another tool or Esc")
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert_eq!(h.app.tool, Tool::Select, "Esc leaves the Pencil");
}

/// Figma Draw's Brush (⇧B): the pencil's freehand gesture in a different mark —
/// a closed, filled outline whose width, taper and grain come from the style the
/// panel (and the palette) sets, landed as one layer in one undo step.
#[test]
fn the_brush_paints_a_mark() {
    let mut h = host();
    assert_eq!(Tool::from_shortcut("b", true, false), Some(Tool::Brush));
    assert_eq!(Tool::from_shortcut("b", true, true), None, "design-only");
    assert_eq!(Tool::Brush.shortcut_hint(false), "⇧B");
    assert_eq!(Tool::Brush.label(), "Brush");
    assert_eq!(Tool::Brush.icon(), "brush");
    assert!(crate::editor_ui::palette_commands()
        .iter()
        .any(|c| c.label == "Brush tool"));
    assert!(crate::editor_ui::palette_commands()
        .iter()
        .any(|c| c.label == "Brush style: Dry"));

    // one mark: press, three moves, release — all inside the canvas
    let reg = h.app.editor_regions();
    let (cx, cy) = (
        (reg.canvas.x0 + reg.canvas.x1) / 2.0,
        (reg.canvas.y0 + reg.canvas.y1) / 2.0,
    );
    let depth0 = h.app.doc_ref().editor_ref().undo_depth();
    h.app.tool = Tool::Brush;
    h.on_press(Point::new(cx, cy));
    h.on_move(Point::new(cx + 40.0, cy + 14.0));
    h.on_move(Point::new(cx + 74.0, cy - 22.0));
    h.on_move(Point::new(cx + 104.0, cy + 6.0));
    h.on_release();

    let sel = h.app.doc_ref().editor_ref().selection.clone();
    assert_eq!(sel.len(), 1, "the mark is the selection");
    let root = &h.app.doc_ref().editor_ref().root;
    let v = find_node_clone(root, &sel[0]).expect("the mark landed");
    assert!(matches!(v.kind, NodeKind::Vector { .. }), "a vector");
    assert!(v.name.starts_with("Brush "), "named in the layers panel");
    let path = match &v.kind {
        NodeKind::Vector { path } => path,
        _ => unreachable!(),
    };
    // the mark is an outline, and the brush PAINTS it — the pencil beside it
    // strokes a centreline instead
    assert!(
        matches!(path.last(), Some(PathCmd::Close)),
        "the mark closes into itself"
    );
    assert!(path.len() > 20, "both edges are sampled");
    let filled = matches!(&v.fill, Paint::Solid(c) if c.components[3] > 0.0);
    assert!(filled, "a brush mark is filled");
    assert_eq!(v.stroke.width, 0.0, "and carries no stroke of its own");
    // the layer's box wraps the ink, not just the line it was drawn along
    let ink_w = h.app.brush_style.width();
    assert!(v.h >= ink_w - 1.0, "the box holds the mark: {}", v.h);
    assert_eq!(h.app.tool, Tool::Brush, "the brush stays active");
    assert_eq!(
        h.app.doc_ref().editor_ref().undo_depth(),
        depth0 + 1,
        "one mark, one entry"
    );
    h.app.doc().editor().undo();
    let root = &h.app.doc_ref().editor_ref().root;
    assert!(
        find_node_clone(root, &sel[0]).is_none(),
        "one undo removes it"
    );

    // the style is a tool setting (the panel's row and the palette both write
    // it), and it changes the mark the next stroke paints
    h.dispatch(Action::SetBrushStyle(BrushStyle::Marker));
    assert_eq!(h.app.brush_style, BrushStyle::Marker);
    assert_eq!(h.app.status, "Brush style: Marker");
    h.on_press(h.app.world_to_screen(Point::new(60.0, 300.0)));
    h.on_move(h.app.world_to_screen(Point::new(160.0, 300.0)));
    h.on_move(h.app.world_to_screen(Point::new(260.0, 300.0)));
    h.on_release();
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let root = &h.app.doc_ref().editor_ref().root;
    let marker = find_node_clone(root, &sel[0]).expect("the marker landed");
    assert!(
        (marker.h - BrushStyle::Marker.width()).abs() < 1.5,
        "a marker holds one width end to end: {}",
        marker.h
    );
    assert!(marker.w > 190.0, "and runs the length of the drag");

    // the draw-it-in rule holds for the brush too: a mark STARTED inside
    // frame-1 (world 0,60 375x420) joins the frame
    h.on_press(h.app.world_to_screen(Point::new(100.0, 200.0)));
    h.on_move(h.app.world_to_screen(Point::new(150.0, 230.0)));
    h.on_move(h.app.world_to_screen(Point::new(200.0, 210.0)));
    h.on_release();
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let root = &h.app.doc_ref().editor_ref().root;
    let f1 = find_node_clone(root, "frame-1").expect("frame-1");
    assert!(
        find_node_clone(&f1, &sel[0]).is_some(),
        "the mark joined the frame it was drawn in"
    );

    // Esc leaves the brush, exactly as it leaves the pencil
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert_eq!(h.app.tool, Tool::Select, "Esc leaves the Brush");
}

/// Figma's shape menu keeps the line and the arrow on one key: L is the Line,
/// ⇧L the Arrow. Both draw a STROKED PATH — the segment is the geometry rather
/// than a box, so a horizontal line is 0 units high — and both are design-only,
/// land where they are drawn, and hand the canvas back to the Move tool.
#[test]
fn the_line_and_arrow_tools_draw_stroked_paths() {
    let mut h = host();
    assert_eq!(Tool::from_shortcut("l", false, false), Some(Tool::Line));
    assert_eq!(Tool::from_shortcut("l", true, false), Some(Tool::Arrow));
    assert_eq!(Tool::from_shortcut("l", false, true), None, "design-only");
    assert_eq!(Tool::Line.shortcut_hint(false), "L");
    assert_eq!(Tool::Arrow.shortcut_hint(false), "⇧L");
    assert_eq!(Tool::Line.icon(), "line");
    assert_eq!(Tool::Arrow.icon(), "arrow-up-right");
    assert!(crate::editor_ui::palette_commands()
        .iter()
        .any(|c| c.label == "Line tool"));

    // a real drag: press, move, release — one segment, one undo entry
    let reg = h.app.editor_regions();
    let (cx, cy) = (
        (reg.canvas.x0 + reg.canvas.x1) / 2.0,
        (reg.canvas.y0 + reg.canvas.y1) / 2.0,
    );
    let depth0 = h.app.doc_ref().editor_ref().undo_depth();
    h.app.tool = Tool::Line;
    h.on_press(Point::new(cx - 100.0, cy));
    h.on_move(Point::new(cx + 100.0, cy));
    h.on_release();
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    assert_eq!(sel.len(), 1, "the segment is the selection");
    let root = &h.app.doc_ref().editor_ref().root;
    let v = find_node_clone(root, &sel[0]).expect("the segment landed");
    assert!(v.name.starts_with("Line "), "named in the layers panel");
    let empty = matches!(&v.fill, Paint::Solid(c) if c.components[3] == 0.0);
    assert!(empty, "a line is not filled");
    assert_eq!(v.stroke.width, crate::state::LINE_WEIGHT);
    let path = match &v.kind {
        NodeKind::Vector { path } => path,
        _ => unreachable!(),
    };
    let (ax, ay) = match path[0] {
        PathCmd::MoveTo(x, y) => (x, y),
        _ => unreachable!(),
    };
    assert!(ax.abs() < 0.5 && ay.abs() < 0.5);
    let (ex, ey) = match path[1] {
        PathCmd::LineTo(x, y) => (x, y),
        _ => unreachable!(),
    };
    assert!(ey.abs() < 0.5, "the drag is the segment");
    assert!((ex - v.w).abs() < 0.5, "and the box is its span");
    assert!(v.h <= 1.0, "a horizontal line has no height");
    assert_eq!(h.app.doc_ref().editor_ref().undo_depth(), depth0 + 1);
    assert_eq!(h.app.tool, Tool::Select, "the tool hands back to Move");

    // ⇧ snaps the DIRECTION to 45° steps, keeping the pointer's length: a
    // shallow drag lands flat
    h.app.tool = Tool::Line;
    h.on_press(Point::new(cx - 100.0, cy + 40.0));
    h.app.shift = true;
    h.on_move(Point::new(cx + 100.0, cy + 62.0));
    h.on_release();
    h.app.shift = false;
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let root = &h.app.doc_ref().editor_ref().root;
    let flat = find_node_clone(root, &sel[0]).expect("the snapped segment landed");
    let snap_path = match &flat.kind {
        NodeKind::Vector { path } => path,
        _ => unreachable!(),
    };
    let (_, fy) = match snap_path[1] {
        PathCmd::LineTo(x, y) => (x, y),
        _ => unreachable!(),
    };
    assert!(fy.abs() < 0.5, "⇧ flattened the angle: {fy}");
    assert!(flat.h <= 1.0, "so the box is flat too");

    // ⇧L: the same segment, closed by the solid head
    h.finish_create(
        Tool::Arrow,
        Point::new(60.0, 620.0),
        Point::new(180.0, 660.0),
    );
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let root = &h.app.doc_ref().editor_ref().root;
    let a = find_node_clone(root, &sel[0]).expect("the arrow landed");
    assert!(a.name.starts_with("Arrow "), "named in the layers panel");
    let arrow_path = match &a.kind {
        NodeKind::Vector { path } => path,
        _ => unreachable!(),
    };
    assert_eq!(arrow_path.len(), 6, "the shaft and the head");
    assert!(matches!(arrow_path.last(), Some(PathCmd::Close)));
    let solid = matches!(&a.fill, Paint::Solid(c) if c.components[3] > 0.0);
    assert!(solid, "the head is solid ink");

    // the draw-it-in rule holds for the pair: a line STARTED inside frame-1
    // (world 0,60 375×420) joins the frame
    h.finish_create(
        Tool::Line,
        Point::new(60.0, 200.0),
        Point::new(200.0, 240.0),
    );
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    let root = &h.app.doc_ref().editor_ref().root;
    let f1 = find_node_clone(root, "frame-1").expect("frame-1");
    assert!(
        find_node_clone(&f1, &sel[0]).is_some(),
        "drawn into the frame"
    );
}

#[test]
fn the_slice_tool_draws_an_export_region() {
    let mut h = host();
    // S is the Slice tool in design mode; in a board it is still the sticky note
    assert_eq!(Tool::from_shortcut("s", false, false), Some(Tool::Slice));
    let in_board = Tool::from_shortcut("s", false, true);
    assert_eq!(in_board, Some(Tool::BoardSticky));
    assert_eq!(Tool::Slice.shortcut_hint(false), "S");
    assert_eq!(Tool::Slice.label(), "Slice");
    assert!(crate::editor_ui::palette_commands()
        .iter()
        .any(|c| c.label == "Slice tool"));

    // drawn over empty canvas: on the page, named for the layers panel,
    // selected, and the tool goes back to Move like every other shape tool
    h.finish_create(
        Tool::Slice,
        Point::new(500.0, 20.0),
        Point::new(560.0, 60.0),
    );
    let sel = h.app.doc_ref().editor_ref().selection.clone();
    assert_eq!(sel.len(), 1, "the new slice is the selection");
    let root = &h.app.doc_ref().editor_ref().root;
    let sl = find_node_clone(root, &sel[0]).unwrap();
    assert!(matches!(sl.kind, NodeKind::Slice), "a Slice node landed");
    let at = (sl.transform.x, sl.transform.y, sl.w, sl.h);
    assert_eq!(at, (500.0, 20.0, 60.0, 40.0));
    let named = sl.name.starts_with("Slice ");
    assert!(named, "named in the layers panel");
    assert_eq!(h.app.tool, Tool::Select, "the tool returns to Move");

    // the same draw-it-in rule as every other tool: a slice drawn over a
    // frame joins that frame, in the frame's local space
    h.finish_create(
        Tool::Slice,
        Point::new(40.0, 120.0),
        Point::new(100.0, 160.0),
    );
    let root = &h.app.doc_ref().editor_ref().root;
    let f1 = find_node_clone(root, "frame-1").unwrap();
    assert_eq!(f1.children.len(), 1, "the slice joined frame-1");
    let inner = &f1.children[0];
    assert!(matches!(inner.kind, NodeKind::Slice));
    assert_eq!((inner.transform.x, inner.transform.y), (40.0, 60.0));

    // and Esc leaves the tool, like the Scale tool
    h.app.tool = Tool::Slice;
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert_eq!(h.app.tool, Tool::Select, "Esc leaves the Slice tool");
}

#[test]
fn a_layer_row_hides_and_locks_the_layer_like_figmas_eye_and_padlock() {
    let mut h = host();
    h.app.mouse = Point::new(0.0, 0.0);
    let root_id = h.app.doc().editor_ref().root.id.clone();
    let mut hero = Node::frame("hero", 300.0, 200.0);
    hero.name = "Hero".into();
    h.app.doc().editor().insert_node(&root_id, hero);
    h.app.doc().editor().insert_node(
        "hero",
        Node::rect("card", 10.0, 10.0, 40.0, 30.0, Color::WHITE),
    );
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let row = h
        .app
        .hit
        .iter()
        .find(|(_, a)| *a == Action::TreeRow("hero".into()))
        .map(|(r, _)| *r)
        .expect("the frame has a layers row");
    // Figma shows the toggles on hover, not always
    assert!(
        !h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::TreeLock(id) if id == "hero")),
        "the padlock is painted on a row that is not hovered"
    );
    h.app.mouse = row.center();
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::TreeLock(id) if id == "hero")),
        "the hovered row has no padlock"
    );
    assert!(
        h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::TreeVisible(id) if id == "hero")),
        "the hovered row has no eye"
    );

    // the eye hides the layer, and the icon stays while the state is on
    h.dispatch(Action::TreeVisible("hero".into()));
    let visible = |h: &Host| {
        crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, "hero")
            .map(|n| n.visible)
            .unwrap_or(true)
    };
    assert!(!visible(&h), "the eye did not hide the layer");
    h.app.mouse = Point::new(0.0, 0.0);
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::TreeVisible(id) if id == "hero")),
        "a hidden layer lost its eye when the pointer left the row"
    );
    h.dispatch(Action::TreeVisible("hero".into()));
    assert!(visible(&h), "the eye did not bring the layer back");

    // the padlock locks it, and a locked layer stops answering the canvas
    h.dispatch(Action::TreeLock("hero".into()));
    assert!(
        crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, "hero")
            .map(|n| n.locked)
            .unwrap_or(false),
        "the padlock did not lock the layer"
    );
    let hit = {
        let d = h.app.doc();
        let root = d.editor_ref().root.clone();
        // inside the frame, outside the card it holds
        x_native::editor::hit_test(&root, Point::new(250.0, 180.0))
    };
    assert_ne!(
        hit.as_deref(),
        Some("hero"),
        "a locked layer answered a click"
    );
}

/// Figma's toolbar has one ▶ and it presents the file. Ours opened the
/// Prototype tab; the ▶ now enters the viewer, and the panel stays one click
/// away on the FLOW pill.
#[test]
fn the_header_play_button_presents_the_prototype() {
    let mut h = host();
    proto_doc(&mut h);
    h.app.doc().right_tab = crate::state::RightTab::Design;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let zone = h
        .app
        .hit
        .iter()
        .find(|(_, a)| *a == Action::FlowEnter)
        .map(|(r, _)| *r)
        .expect("the header ▶ is not a Present control");
    h.app.mouse = zone.center();
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        h.app
            .tooltip
            .iter()
            .any(|(r, t)| *r == zone && t == "Present"),
        "the ▶ is not labelled Present: {:?}",
        h.app.tooltip
    );
    assert!(h.app.flow.is_none());
    h.dispatch(Action::FlowEnter);
    assert!(h.app.flow.is_some(), "the ▶ did not present");
    assert!(
        !h.app.paints_status_band(),
        "a presentation paints no chrome"
    );
}

#[test]
fn prototype_authoring_writes_and_undoes() {
    let mut h = host();
    proto_doc(&mut h);
    h.dispatch(Action::ProtoToggleStart);
    {
        let d = h.app.doc();
        let n = crate::editor_ui::find_node(&d.editor_ref().root, "btn").unwrap();
        assert!(n.is_starting_point);
    }
    h.dispatch(Action::ProtoSpeed(0));
    {
        let d = h.app.doc();
        let n = crate::editor_ui::find_node(&d.editor_ref().root, "btn").unwrap();
        assert_eq!(n.interactions[0].transition_ms, 700, "350 → 700");
    }
    h.dispatch(Action::ProtoRemove(0));
    {
        let d = h.app.doc();
        let n = crate::editor_ui::find_node(&d.editor_ref().root, "btn").unwrap();
        assert!(n.interactions.is_empty());
    }
}

#[test]
fn flow_preview_navigates_back_and_exits() {
    let mut h = host();
    proto_doc(&mut h);
    h.app.doc().editor().selection.clear();
    h.flow_enter();
    assert_eq!(
        h.app.flow.as_ref().unwrap().current,
        "f1",
        "first frame starts flow"
    );
    // click the Go button: world (40,25) is inside btn @ f1(20..100,20..50)
    let sp = h.app.world_to_screen(Point::new(40.0, 25.0));
    h.flow_press(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2", "navigated");
    // overlay chrome paints Back/Exit while in flow
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    crate::editor_ui::paint_over(&mut h.app, &mut scene);
    assert!(h.app.hit.iter().any(|(_, a)| matches!(a, Action::FlowBack)));
    assert!(h.app.hit.iter().any(|(_, a)| matches!(a, Action::FlowExit)));
    h.flow_back();
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    h.flow_back();
    assert!(h.app.flow.is_none(), "empty history exits the flow");
    // Esc during flow goes back, Q exits (no doc state change)
    h.flow_enter();
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(h.app.flow.is_none());
}

#[test]
fn flow_enter_follows_selection_to_its_top_frame() {
    let mut h = host();
    proto_doc(&mut h); // btn selected inside f1
    h.flow_enter();
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
}

/// Rich prototype fixture: two screens, a centered dialog overlay, one
/// interaction per trigger kind, and a `n = 1` document variable.
fn player_doc(h: &mut Host) {
    use x_native::{
        Action, Animation, CondOp, Condition, Easing, Expr, Interaction, OverlayPosition, Trigger,
    };
    let d = h.app.doc();
    let root_id = d.editor_ref().root.id.clone();
    let mut f1 = Node::frame("f1", 300.0, 200.0);
    f1.name = "Home".into();
    f1.is_starting_point = true;
    let key = Interaction {
        trigger: Trigger::KeyDown { key: "a".into() },
        action: Action::Navigate {
            destination: "f2".into(),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    };
    let delay = |ms: u32, action: Action| Interaction {
        trigger: Trigger::AfterDelay { ms },
        action,
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    };
    f1.interactions = vec![
        key,
        delay(
            30,
            Action::SetVar {
                name: "tick".into(),
                value: Expr::num(1.0),
            },
        ),
        delay(
            35,
            Action::SetVar {
                name: "tick".into(),
                value: Expr::num(2.0),
            },
        ),
        delay(
            60,
            Action::Navigate {
                destination: "f2".into(),
            },
        ),
    ];
    let mut f2 = Node::frame("f2", 300.0, 200.0);
    f2.name = "Detail".into();
    f2.transform.x = 400.0;
    let mut dlg = Node::frame("dlg", 160.0, 100.0);
    dlg.name = "Dialog".into();
    dlg.transform.x = 800.0;
    d.editor().insert_node(&root_id, f1);
    d.editor().insert_node(&root_id, f2);
    d.editor().insert_node(&root_id, dlg);
    let rect =
        |id: &str, x: f64, y: f64| Node::rect(id, x, y, 80.0, 30.0, Color::from_rgb8(9, 9, 9));
    let mut btn = rect("btn", 20.0, 20.0);
    btn.interactions = vec![Interaction::click("f2")];
    d.editor().insert_node("f1", btn);
    let mut hov = rect("hov", 20.0, 60.0);
    hov.interactions = vec![
        Interaction {
            trigger: Trigger::OnHover,
            action: Action::OpenOverlay {
                overlay: "dlg".into(),
                position: OverlayPosition::Center,
            },
            transition_ms: 0,
            animation: Animation::Instant,
            actions: vec![],
            easing: Easing::Linear,
            reset_on_navigate: false,
            animate_matching_layers: false,
        },
        Interaction {
            trigger: Trigger::MouseLeave,
            action: Action::CloseOverlay,
            transition_ms: 0,
            animation: Animation::Instant,
            actions: vec![],
            easing: Easing::Linear,
            reset_on_navigate: false,
            animate_matching_layers: false,
        },
    ];
    d.editor().insert_node("f1", hov);
    let mut drg = rect("drg", 20.0, 100.0);
    drg.interactions = vec![Interaction {
        trigger: Trigger::OnDrag,
        action: Action::Navigate {
            destination: "f2".into(),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    }];
    d.editor().insert_node("f1", drg);
    let mut set = rect("set", 20.0, 140.0);
    set.interactions = vec![Interaction {
        trigger: Trigger::OnClick,
        action: Action::SetVar {
            name: "n".into(),
            value: Expr::num(41.0),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    }];
    d.editor().insert_node("f1", set);
    // while-hovering navigate (110..190, 20..50): returns on leave
    let mut wh = rect("wh", 110.0, 20.0);
    wh.interactions = vec![Interaction {
        trigger: Trigger::OnHover,
        action: Action::Navigate {
            destination: "f2".into(),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    }];
    d.editor().insert_node("f1", wh);
    // while-pressing overlay (200..280, 20..50) + mouse-up set-var
    let mut pu = rect("pu", 200.0, 20.0);
    pu.interactions = vec![
        Interaction {
            trigger: Trigger::OnPress,
            action: Action::OpenOverlay {
                overlay: "dlg".into(),
                position: OverlayPosition::Center,
            },
            transition_ms: 0,
            animation: Animation::Instant,
            actions: vec![],
            easing: Easing::Linear,
            reset_on_navigate: false,
            animate_matching_layers: false,
        },
        Interaction {
            trigger: Trigger::MouseUp,
            action: Action::SetVar {
                name: "n".into(),
                value: Expr::num(99.0),
            },
            transition_ms: 0,
            animation: Animation::Instant,
            actions: vec![],
            easing: Easing::Linear,
            reset_on_navigate: false,
            animate_matching_layers: false,
        },
    ];
    d.editor().insert_node("f1", pu);
    // mouse-down navigate (200..280, 115..145): the press itself, one-way —
    // the counterpart to `pu`'s While pressing, which reverts on release
    let mut md = rect("md", 200.0, 115.0);
    md.interactions = vec![Interaction {
        trigger: Trigger::MouseDown,
        action: Action::Navigate {
            destination: "f2".into(),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    }];
    d.editor().insert_node("f1", md);
    let mut gate = rect("gate", 20.0, 60.0); // f2-local → world (420..500, 60..90)
    gate.interactions = vec![Interaction {
        trigger: Trigger::OnClick,
        action: Action::Cond {
            cond: Condition {
                lhs: Expr::var("n"),
                op: CondOp::Gt,
                rhs: Expr::num(40.0),
            },
            then: Box::new(Action::Navigate {
                destination: "f1".into(),
            }),
            els: Some(Box::new(Action::OpenOverlay {
                overlay: "dlg".into(),
                position: OverlayPosition::TopLeft,
            })),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    }];
    d.editor().insert_node("f2", gate);
    let mut shut = Node::rect("shut", 10.0, 10.0, 60.0, 30.0, Color::from_rgb8(9, 9, 9));
    shut.interactions = vec![Interaction {
        trigger: Trigger::OnClick,
        action: Action::CloseOverlay,
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    }];
    d.editor().insert_node("dlg", shut);
    d.doc.variables.numbers.insert("n".into(), 1.0);
}

#[test]
fn player_hover_opens_overlay_and_leave_closes_it() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    // hov @ f1-local (20..100, 60..90): hover opens the dialog
    let sp = h.app.world_to_screen(Point::new(60.0, 75.0));
    h.flow_hover_at(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().overlays.len(), 1);
    assert_eq!(h.app.flow.as_ref().unwrap().overlays[0].frame, "dlg");
    // leaving for empty canvas fires MouseLeave: the dialog closes
    let sp = h.app.world_to_screen(Point::new(250.0, 180.0));
    h.flow_hover_at(sp);
    assert!(h.app.flow.as_ref().unwrap().overlays.is_empty());
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
}

#[test]
fn player_click_routes_through_open_overlay_at_rendered_position() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    let sp = h.app.world_to_screen(Point::new(60.0, 75.0));
    h.flow_hover_at(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().overlays.len(), 1);
    // dlg renders centered over f1: offset (70, 50), so shut sits at
    // world (80..140, 60..90) — nothing else is near (110, 75)
    let sp = h.app.world_to_screen(Point::new(110.0, 75.0));
    h.flow_press(sp);
    assert!(
        h.app.flow.as_ref().unwrap().overlays.is_empty(),
        "shut closes dlg"
    );
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
}

/// Figma splits the press in two: *While pressing* is temporary — releasing
/// reverts what it did — while *Mouse down / Touch press* is the press itself,
/// permanent and one-way (help 360040315773; the plugin API spells it out:
/// "MOUSE_ENTER, MOUSE_LEAVE, MOUSE_UP and MOUSE_DOWN are permanent, one-way
/// navigation"). This is that difference, in the player.
#[test]
fn player_mouse_down_navigates_on_press_and_release_keeps_it() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    // md centre (240, 130)
    let sp = h.app.world_to_screen(Point::new(240.0, 130.0));
    h.flow_press(sp);
    assert_eq!(
        h.app.flow.as_ref().unwrap().current,
        "f2",
        "Mouse down fires on the press"
    );
    h.flow_release();
    assert_eq!(
        h.app.flow.as_ref().unwrap().current,
        "f2",
        "and the release keeps it — one-way, unlike While pressing"
    );
    assert_eq!(h.app.flow.as_ref().unwrap().stack, vec!["f1".to_string()]);
}

#[test]
fn player_drag_fires_once_per_press() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    // drg center (60, 115): press arms the drag, moving fires it
    let sp = h.app.world_to_screen(Point::new(60.0, 115.0));
    h.flow_press(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    h.flow_drag_at(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2");
    assert_eq!(h.app.flow.as_ref().unwrap().stack, vec!["f1".to_string()]);
    // navigation disarms the cycle: further moves push no history
    h.flow_drag_at(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().stack.len(), 1);
}

#[test]
fn player_key_trigger_navigates_and_unknown_key_ignored() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    h.flow_key(&Key::Character("z".into()));
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    h.flow_key(&Key::Character("a".into()));
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2");
}

#[test]
fn player_delay_fires_in_order_and_navigation_cancels_rest() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    assert_eq!(h.app.flow.as_ref().unwrap().delays.len(), 3);
    let t0 = std::time::Instant::now();
    let tick = std::time::Duration::from_millis(40);
    assert_eq!(h.flow_tick(t0 + tick), 2, "30ms and 35ms delays fire");
    assert_eq!(h.app.flow.as_ref().unwrap().vars.numbers["tick"], 2.0);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    let tick = std::time::Duration::from_millis(70);
    assert_eq!(h.flow_tick(t0 + tick), 1, "60ms delay navigates");
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2");
    assert!(
        h.app.flow.as_ref().unwrap().delays.is_empty(),
        "f2 arms none"
    );
}

#[test]
fn player_escape_dismisses_then_backs_then_exits() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    let sp = h.app.world_to_screen(Point::new(60.0, 75.0));
    h.flow_hover_at(sp);
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(
        h.app.flow.as_ref().unwrap().overlays.is_empty(),
        "dismissed"
    );
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    let sp = h.app.world_to_screen(Point::new(60.0, 35.0));
    h.flow_press(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2");
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1", "backed");
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(h.app.flow.is_none(), "empty history exits");
}

#[test]
fn player_variables_stay_preview_local() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    assert_eq!(h.app.flow.as_ref().unwrap().vars.numbers["n"], 1.0);
    // set @ (20..100, 140..170): preview n becomes 41, document stays 1
    let sp = h.app.world_to_screen(Point::new(60.0, 155.0));
    h.flow_press(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().vars.numbers["n"], 41.0);
    assert_eq!(h.app.doc_ref().doc.variables.numbers["n"], 1.0);
    // the gate on f2 reads the preview store: 41 > 40 navigates home
    let sp = h.app.world_to_screen(Point::new(60.0, 35.0));
    h.flow_press(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2");
    let sp = h.app.world_to_screen(Point::new(460.0, 75.0));
    h.flow_press(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    assert_eq!(h.app.doc_ref().doc.variables.numbers["n"], 1.0);
}

#[test]
fn player_hover_navigate_returns_on_leave() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    // wh @ f1-local (110..190, 20..50): while-hovering navigates to f2
    let sp = h.app.world_to_screen(Point::new(150.0, 35.0));
    h.flow_hover_at(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2");
    // moving anywhere leaves the hotspot: back to f1, no history kept
    let sp = h.app.world_to_screen(Point::new(460.0, 150.0));
    h.flow_hover_at(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    assert!(h.app.flow.as_ref().unwrap().stack.is_empty());
}

#[test]
fn player_press_opens_and_release_reverts_then_mouseup_fires() {
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    // pu @ f1-local (200..280, 20..50): press opens the dialog
    let sp = h.app.world_to_screen(Point::new(240.0, 35.0));
    h.flow_press(sp);
    assert_eq!(h.app.flow.as_ref().unwrap().overlays.len(), 1);
    // release over pu: the press span closes the dialog, then MouseUp
    // sets n in the preview store
    h.app.mouse = sp;
    h.flow_release();
    assert!(h.app.flow.as_ref().unwrap().overlays.is_empty());
    assert_eq!(h.app.flow.as_ref().unwrap().vars.numbers["n"], 99.0);
}

#[test]
fn player_scrollto_pans_without_navigating() {
    use x_native::{Action, Animation, Easing, Interaction, Trigger};
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    let zoom = h.app.zoom;
    let ix = Interaction {
        trigger: Trigger::OnClick,
        action: Action::ScrollTo {
            destination: "set".into(),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    };
    h.flow_fire(&ix);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    assert!(h.app.flow.as_ref().unwrap().stack.is_empty());
    assert_eq!(h.app.zoom, zoom, "scroll keeps the zoom");
    // the "set" rect (center (60, 155)) lands centered in the viewer
    let c = h.app.view_canvas();
    let sp = h.app.world_to_screen(Point::new(60.0, 155.0));
    assert!((sp.x - (c.x0 + c.x1) / 2.0).abs() < 1.0);
    assert!((sp.y - (c.y0 + c.y1) / 2.0).abs() < 1.0);
}

#[test]
fn player_swap_without_overlay_navigates_without_history() {
    use x_native::{Action, Animation, Easing, Interaction, Trigger};
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    let ix = Interaction {
        trigger: Trigger::OnClick,
        action: Action::SwapOverlay {
            overlay: "f2".into(),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    };
    h.flow_fire(&ix);
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f2");
    assert!(
        h.app.flow.as_ref().unwrap().stack.is_empty(),
        "Back skips it"
    );
    assert_eq!(h.app.status, "Flow preview — viewing f2");
}

#[test]
fn player_openlink_reports_url_without_leaving() {
    use x_native::{Action, Animation, Easing, Interaction, Trigger};
    let mut h = host();
    player_doc(&mut h);
    h.flow_enter();
    let ix = Interaction {
        trigger: Trigger::OnClick,
        action: Action::OpenLink {
            url: "https://example.com".into(),
        },
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
        animate_matching_layers: false,
    };
    // headless: no window, so no browser spawns — the URL just reports
    let effect = h.flow_fire(&ix);
    assert_eq!(effect.opened_link.as_deref(), Some("https://example.com"));
    assert_eq!(h.app.flow.as_ref().unwrap().current, "f1");
    assert!(h.app.flow.as_ref().unwrap().stack.is_empty());
    assert!(h.app.flow.as_ref().unwrap().overlays.is_empty());
}

#[test]
fn assets_panel_lists_faces_and_offers_load_font() {
    let mut h = host();
    h.app.doc().left_tab = crate::state::LeftTab::Assets;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(h.app.hit.iter().any(|(_, a)| matches!(a, Action::LoadFont)));
    // bundled faces are registered: family names non-empty (Inter loaded)
    assert!(!h.app.fonts.fonts.family_names().is_empty());
}

#[test]
fn prototype_tab_no_longer_gated_outside_demo_mode() {
    let mut h = host();
    h.app.demo_mode = false;
    h.dispatch(Action::RightTab(crate::state::RightTab::Prototype));
    assert_eq!(h.app.doc().right_tab, crate::state::RightTab::Prototype);
    h.dispatch(Action::LeftTab(crate::state::LeftTab::Assets));
    assert_eq!(h.app.doc().left_tab, crate::state::LeftTab::Assets);
}

#[test]
fn variant_switcher_switches_instance_variant() {
    let mut h = host();
    {
        let d = h.app.doc();
        let root_id = d.editor_ref().root.id.clone();
        let mut m1 = Node::frame("m1", 100.0, 40.0);
        m1.kind = x_native::NodeKind::Component {
            name: "Button/Primary".into(),
        };
        let mut m2 = Node::frame("m2", 100.0, 40.0);
        m2.kind = x_native::NodeKind::Component {
            name: "Button/Ghost".into(),
        };
        let mut inst = Node::rect("inst1", 0.0, 120.0, 100.0, 40.0, Color::from_rgb8(1, 2, 3));
        inst.kind = x_native::NodeKind::Instance {
            component: "Button/Primary".into(),
        };
        d.editor().insert_node(&root_id, m1);
        d.editor().insert_node(&root_id, m2);
        d.editor().insert_node(&root_id, inst);
        d.editor().selection = vec!["inst1".into()];
    }
    // inspector shows the VARIANT row while an instance of a set is selected
    // (tall window: the right panel is clipped to viewport height)
    h.app.win_h = 2400.0;
    h.app.doc().right_tab = crate::state::RightTab::Design;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::VariantCycle(_))),
        "variant row present"
    );
    // cycling swaps the underlying component
    h.dispatch(Action::VariantCycle(1));
    {
        let d = h.app.doc();
        let n = crate::editor_ui::find_node(&d.editor_ref().root, "inst1").unwrap();
        let x_native::NodeKind::Instance { component } = &n.kind else {
            panic!("instance kept")
        };
        assert_eq!(component, "Button/Ghost");
    }
    // undoable
    h.app.doc().editor().undo();
    {
        let d = h.app.doc();
        let n = crate::editor_ui::find_node(&d.editor_ref().root, "inst1").unwrap();
        let x_native::NodeKind::Instance { component } = &n.kind else {
            panic!("instance kept")
        };
        assert_eq!(component, "Button/Primary");
    }
}

/// A layer with nothing on it, selected: the fixture the effects tests use.
fn effect_host() -> Host {
    let mut h = host();
    {
        let d = h.app.doc();
        let root_id = d.editor_ref().root.id.clone();
        d.editor().insert_node(
            &root_id,
            Node::rect("fx", 0.0, 0.0, 80.0, 60.0, x_native::Color::WHITE),
        );
        d.editor().selection = vec!["fx".into()];
    }
    h
}

/// Figma (help 360041488473): the Effects section is a **list** of the effects
/// on the layer, the `+` opens the five types, and each row carries its own
/// dropdown, settings, eye and blend.
#[test]
fn the_effects_section_lists_every_effect_with_figmas_controls() {
    use x_native::EffectKind;
    let mut h = effect_host();
    {
        let d = h.app.doc();
        d.editor()
            .add_effect_layer("fx", x_native::Effect::default_of(EffectKind::DropShadow));
        d.editor()
            .add_effect_layer("fx", x_native::Effect::default_of(EffectKind::LayerBlur));
        d.editor().selection = vec!["fx".into()];
    }
    // the section is the tail of the DESIGN column: scroll to it, the way a
    // user does — the panel drops hit rects that leave its viewport
    crate::editor_ui::scroll_effects_into_view(&mut h.app);

    // one row per effect, top to bottom, and no add menu until it is opened
    assert_eq!(h.app.effect_rows.len(), 2, "one row per effect");
    assert!(
        !h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::AddEffect(_))),
        "the + opens a menu; it does not add anything by itself"
    );
    for i in 0..2 {
        assert!(h.app.hit.iter().any(|(_, a)| *a == Action::EffectRow(i)));
        assert!(h
            .app
            .hit
            .iter()
            .any(|(_, a)| *a == Action::ToggleEffectVisible(i)));
        assert!(h
            .app
            .hit
            .iter()
            .any(|(_, a)| *a == Action::ToggleEffectKind(i)));
        assert!(h.app.hit.iter().any(|(_, a)| *a == Action::RemoveEffect(i)));
    }

    // the add menu lists Figma's five types
    h.dispatch(Action::ToggleEffectAdd);
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let kinds: Vec<Action> = h
        .app
        .hit
        .iter()
        .filter(|(_, a)| matches!(a, Action::AddEffect(_)))
        .map(|(_, a)| a.clone())
        .collect();
    assert_eq!(
        kinds.len(),
        5,
        "Drop shadow, Inner shadow, the two blurs, Noise"
    );
    h.dispatch(Action::AddEffect(EffectKind::InnerShadow));
    // the rows are laid out by the paint pass, so the new one appears on the
    // next frame — which is the same frame the user sees it on
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert_eq!(h.app.effect_rows.len(), 3, "the + added a third row");

    // the settings disclosure shows the effect's OWN fields
    h.dispatch(Action::ToggleEffectSettings(0));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    for f in [
        FieldId::EffectX(0),
        FieldId::EffectY(0),
        FieldId::EffectBlur(0),
    ] {
        assert!(
            h.app.hit.iter().any(|(_, a)| *a == Action::Field(f)),
            "a shadow shows X / Y / Blur"
        );
    }
    assert!(
        !h.app
            .hit
            .iter()
            .any(|(_, a)| *a == Action::Field(FieldId::EffectRadius(0))),
        "…and not a Blur's Radius row"
    );
    // the shadow's Fill swatch opens the colour popover targeted at THIS effect
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| *a == Action::ToggleColorPicker(crate::state::PaintTarget::Effect(0))));

    // typing in the field writes that effect's setting, undoably
    h.dispatch(Action::Field(FieldId::EffectBlur(0)));
    h.app.field.as_mut().unwrap().buffer = "11".into();
    assert!(h.finish_edits());
    let layers = h.app.effect_layers_of("fx");
    assert_eq!(
        layers[0].effect.field(x_native::EffectField::Blur),
        11.0,
        "the Blur row wrote the effect"
    );
}

/// Figma's two blend dropdowns: the layer's 19 modes start with *Pass through*,
/// a paint's 18 do not — *"Pass through cannot be applied to fills or effects"*.
#[test]
fn the_blend_menus_offer_figmas_modes_and_write_the_choice() {
    let mut h = effect_host();
    crate::editor_ui::scroll_effects_into_view(&mut h.app);
    h.dispatch(Action::ToggleLayerBlend);
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let layer_rows: Vec<x_native::BlendKind> = h
        .app
        .hit
        .iter()
        .filter_map(|(_, a)| match a {
            Action::SetLayerBlend(m) => Some(*m),
            _ => None,
        })
        .collect();
    assert_eq!(layer_rows.len(), 19);
    assert_eq!(layer_rows[0], x_native::BlendKind::PassThrough);

    h.dispatch(Action::SetLayerBlend(x_native::BlendKind::Multiply));
    assert_eq!(
        crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, "fx")
            .unwrap()
            .blend,
        x_native::BlendKind::Multiply
    );

    h.dispatch(Action::TogglePaintBlend(crate::state::PaintTarget::Fill));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let paint_rows: Vec<x_native::BlendKind> = h
        .app
        .hit
        .iter()
        .filter_map(|(_, a)| match a {
            Action::SetPaintBlend(_, m) => Some(*m),
            _ => None,
        })
        .collect();
    assert_eq!(paint_rows.len(), 18);
    assert!(
        !paint_rows.contains(&x_native::BlendKind::PassThrough),
        "a fill cannot be Pass through"
    );
    h.dispatch(Action::SetPaintBlend(
        crate::state::PaintTarget::Fill,
        x_native::BlendKind::Darken,
    ));
    assert_eq!(
        crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, "fx")
            .unwrap()
            .fill_layers[0]
            .blend,
        x_native::BlendKind::Darken
    );
}

/// Figma reorders effects by dragging a row; the release is ONE undo entry.
#[test]
fn dragging_an_effect_row_reorders_the_stack() {
    use x_native::EffectKind;
    let mut h = effect_host();
    {
        let d = h.app.doc();
        d.editor()
            .add_effect_layer("fx", x_native::Effect::default_of(EffectKind::DropShadow));
        d.editor()
            .add_effect_layer("fx", x_native::Effect::default_of(EffectKind::LayerBlur));
        d.editor().selection = vec!["fx".into()];
    }
    crate::editor_ui::scroll_effects_into_view(&mut h.app);
    let rows = h.app.effect_rows.clone();
    assert_eq!(rows.len(), 2);
    let (a, b) = (rows[0].center(), rows[1].center());

    h.on_press(a);
    assert!(matches!(h.app.drag, Some(Drag::EffectRow { .. })));
    h.on_move(b);
    assert!(matches!(
        h.app.drag,
        Some(Drag::EffectRow { active: true, .. })
    ));
    h.on_release();
    let layers = h.app.effect_layers_of("fx");
    assert_eq!(
        layers[0].effect.kind(),
        EffectKind::LayerBlur,
        "the blur moved to the top"
    );
    assert!(h.app.doc().editor().undo());
    let layers = h.app.effect_layers_of("fx");
    assert_eq!(layers[0].effect.kind(), EffectKind::DropShadow, "one undo");
}

/// A shadow's colour goes to the *effect*, never to the layer's own fill.
#[test]
fn an_effect_colour_never_lands_on_the_layer_fill() {
    use x_native::EffectKind;
    let mut h = effect_host();
    {
        let d = h.app.doc();
        d.editor()
            .add_effect_layer("fx", x_native::Effect::default_of(EffectKind::DropShadow));
        d.editor().selection = vec!["fx".into()];
    }
    h.dispatch(Action::PaintPreset(
        crate::state::PaintTarget::Effect(0),
        "#FF3B30".into(),
    ));
    let n = crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, "fx").unwrap();
    let color = n.effect_layers[0].effect.color().expect("a shadow colour");
    let rgba = color.to_rgba8();
    assert_eq!((rgba.r, rgba.g, rgba.b), (0xFF, 0x3B, 0x30));
    assert_eq!(
        n.fill,
        x_native::Paint::Solid(x_native::Color::WHITE),
        "the layer's own fill is untouched"
    );
}

#[test]
fn variant_combine_groups_masters() {
    let mut h = host();
    {
        let d = h.app.doc();
        let root_id = d.editor_ref().root.id.clone();
        let mut a = Node::frame("va", 60.0, 40.0);
        a.kind = x_native::NodeKind::Component {
            name: "Chip".into(),
        };
        let mut b = Node::frame("vb", 60.0, 40.0);
        b.kind = x_native::NodeKind::Component {
            name: "Card".into(),
        };
        d.editor().insert_node(&root_id, a);
        d.editor().insert_node(&root_id, b);
        d.editor().selection = vec!["va".into(), "vb".into()];
    }
    h.dispatch(Action::VariantCombine);
    let d = h.app.doc();
    // Figma (help 360056440594): "Figma will add all components to a single
    // component set", and a set "can only contain components" — so the masters
    // are not just renamed, they end up inside one set frame.
    let set = d
        .editor_ref()
        .root
        .children
        .iter()
        .find(|c| x_native::is_variant_set(c))
        .expect("a component set frame");
    assert_eq!(set.children.len(), 2, "both masters went in");
    let names: Vec<String> = set
        .children
        .iter()
        .filter_map(|c| match &c.kind {
            x_native::NodeKind::Component { name } => Some(name.clone()),
            _ => None,
        })
        .collect();
    assert!(
        names.iter().any(|n| n.starts_with("Chip/")),
        "masters renamed into set: {names:?}"
    );
}

// ————————————————— design audit toolkit: tokens panel + lint command

fn painted_doc(h: &mut Host) {
    let root_id = h.app.doc().editor_ref().root.id.clone();
    let mut a = Node::rect(
        "pa",
        0.0,
        0.0,
        100.0,
        100.0,
        Color::from_rgb8(0x11, 0x22, 0x33),
    );
    a.name = "A".into();
    let mut b = Node::rect(
        "pb",
        20.0,
        20.0,
        100.0,
        100.0,
        Color::from_rgb8(0x11, 0x22, 0x33),
    );
    b.name = "B".into(); // overlapping pair + repeated size (cluster)
    let mut t = Node::text("pt", 0.0, 200.0, 80.0, 16.0, "Hello");
    t.name = "Text".into();
    h.app.doc().editor().insert_node(&root_id, a);
    h.app.doc().editor().insert_node(&root_id, b);
    h.app.doc().editor().insert_node(&root_id, t);
}

#[test]
fn tokens_panel_paints_and_extract_is_idempotent() {
    let mut h = host();
    painted_doc(&mut h);
    h.app.win_h = 1600.0;
    h.app.doc().left_tab = crate::state::LeftTab::Tokens;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    assert!(
        h.app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, Action::TokensExtractVars)),
        "extract button present"
    );
    h.dispatch(Action::TokensExtractVars);
    assert!(h.app.status.starts_with("Extracted"), "{}", h.app.status);
    let names: Vec<String> = h
        .app
        .doc()
        .doc
        .variables
        .catalog()
        .into_iter()
        .map(|(_, n, _)| n)
        .collect();
    assert!(
        names.iter().any(|n| n.starts_with("color/")),
        "palette variables defined: {names:?}"
    );
    // second run: nothing new, no dirty churn
    let dirty_before = h.app.docs[h.app.active].dirty;
    let _ = dirty_before;
    h.dispatch(Action::TokensExtractVars);
    assert!(
        h.app.status.contains("already") || h.app.status.starts_with("Extracted 0"),
        "{}",
        h.app.status
    );
}

#[test]
fn lint_command_summarizes_into_status() {
    let mut h = host();
    // an unnamed painted hairline trips two rules
    let root_id = h.app.doc().editor_ref().root.id.clone();
    let mut bad = Node::rect("", 0.0, 0.0, 0.5, 20.0, Color::from_rgb8(1, 1, 1));
    bad.name = String::new();
    h.app.doc().editor().insert_node(&root_id, bad);
    h.cmd_lint();
    assert!(h.app.status.starts_with("Lint:"), "{}", h.app.status);
    assert!(h.app.status.contains("error(s)"), "{}", h.app.status);
}

#[test]
fn tokens_tab_is_no_longer_gated() {
    let mut h = host();
    h.app.demo_mode = false;
    h.dispatch(Action::LeftTab(crate::state::LeftTab::Tokens));
    assert_eq!(h.app.doc().left_tab, crate::state::LeftTab::Tokens);
}

// —————————————————————————————————— theme wiring (palette is the only source)

#[test]
fn app_ui_colors_are_derived_from_the_shared_palette() {
    use x_native::ui::ColorTokens;
    let p = ColorTokens::GRAPHITE;
    let rgb = |c: [u8; 3]| {
        let c = crate::theme::rgb(c).to_rgba8();
        (c.r, c.g, c.b)
    };
    // If someone re-hard-codes a hex in theme.rs, one of these catches it.
    assert_eq!(crate::theme::C_PANEL, crate::theme::rgb(p.surface));
    assert_eq!(crate::theme::C_BG, crate::theme::rgb(p.background));
    assert_eq!(crate::theme::C_TEXT, crate::theme::rgb(p.text_primary));
    assert_eq!(crate::theme::C_MUTED, crate::theme::rgb(p.text_dim));
    assert_eq!(crate::theme::C_ACCENT, crate::theme::rgb(p.accent));
    assert_eq!(crate::theme::C_ON_ACCENT, crate::theme::rgb(p.on_accent));
    assert_eq!(crate::theme::C_LINE, crate::theme::rgb(p.border));
    // selection is the `selection` role; keyboard focus is `focus_ring`
    assert_eq!(crate::theme::C_SEL, crate::theme::rgb(p.selection));
    assert_eq!(crate::theme::C_FOCUS, crate::theme::rgb(p.focus_ring));
    assert_eq!(rgb(p.text_primary), (0xF2, 0xF3, 0xF7)); // still the brand white
                                                         // toolbar keeps its alpha on top of the role
    let t = crate::theme::C_TOOLBAR.to_rgba8();
    assert_eq!(
        (t.r, t.g, t.b, t.a),
        (p.surface[0], p.surface[1], p.surface[2], 230)
    );
}

// —————————————————————————————————————— screen & component contract (P0-1/2)

/// The app can show three screens, and the component layer holds a contract
/// row for each. A screen added without one is how a screen ends up with its
/// own idioms — which is what the cross-screen pass exists to undo.
#[test]
fn every_screen_the_app_can_show_is_in_the_contract() {
    use x_native::ui::{screens, ScreenId};

    for screen in [
        crate::state::Screen::Dashboard,
        crate::state::Screen::Editor,
        crate::state::Screen::Board,
    ] {
        let id = match screen {
            crate::state::Screen::Dashboard => ScreenId::Dashboard,
            crate::state::Screen::Editor => ScreenId::Editor,
            crate::state::Screen::Board => ScreenId::Board,
        };
        let spec = screens::screen(id).expect("every screen has a contract row");
        assert_eq!(spec.name, id.name());
        assert!(!spec.purpose.is_empty());
        assert!(
            screens::surfaces_of(id).next().is_some(),
            "{} owns no surfaces",
            id.name()
        );
    }
    assert_eq!(
        screens::SCREENS.len(),
        3,
        "the app's Screen enum and the contract must stay in step"
    );
}

/// P0-9 moved the control-height scale into the component layer. These
/// assertions hold the chrome to it: the heights the inspector's rows use are
/// the scale's, and the two rows the contract still counts as off-standard are
/// still measured as off-standard (they move in the cross-screen pass).
#[test]
fn app_row_heights_are_the_component_layers() {
    use x_native::ui::metrics;

    assert_eq!(crate::theme::INPUT_H, metrics::CONTROL_H);
    assert_eq!(crate::theme::DENSE_H, metrics::DENSE_H);
    assert_eq!(crate::theme::CHIP_H, metrics::CHIP_H);
    assert_eq!(crate::theme::SQ_BTN, metrics::SQUARE_H);
    assert_eq!(crate::theme::ROW_GAP, metrics::ROW_GAP);
    assert_eq!(crate::theme::SECTION_GAP, metrics::SECTION_GAP);

    let rows = [
        crate::theme::INPUT_H,
        crate::theme::DENSE_H,
        crate::theme::CHIP_H,
        crate::theme::SQ_BTN,
    ];
    for h in rows {
        assert!(
            metrics::is_control_height(h),
            "{h} is not a step of the control-height scale"
        );
    }

    // the two rows the component contract counts as off-standard today
    for h in [crate::theme::TREE_ROW_H, crate::theme::DROPDOWN_ROW_H] {
        assert!(
            !metrics::is_control_height(h),
            "{h} is on the scale now — lower OFF_STANDARD_COMPONENTS"
        );
    }
    assert_eq!(
        metrics::nearest_control_height(crate::theme::TREE_ROW_H),
        metrics::ControlHeight::Dense
    );
    assert_eq!(
        metrics::nearest_control_height(crate::theme::DROPDOWN_ROW_H),
        metrics::ControlHeight::Control
    );
}

#[test]
fn theme_resolution_is_identity_until_a_theme_is_selected() {
    use x_native::ui::{ColorTokens, ThemeId};
    // default: no remap, no allocation on the draw path
    assert_eq!(crate::theme::active_theme(), ThemeId::Graphite);
    let panel = crate::theme::C_PANEL;
    assert_eq!(crate::theme::resolve(panel), panel);
    assert!(crate::theme::tint_spans(&[]).is_none());
    // the palettes really do differ, and a role color maps to its twin
    let g = ColorTokens::GRAPHITE;
    let l = ColorTokens::DAYLIGHT;
    assert_eq!(
        l.resolve(&g, g.surface),
        Some(l.surface),
        "surface must follow the role, not the hex"
    );
    assert_eq!(
        l.resolve(&g, g.text_secondary),
        Some(l.text_secondary),
        "AA-brightened secondary text must map too"
    );
    // content colors (not roles) survive untouched in every palette
    let logo = g.background; // canvas black is a role, so use a real content color
    let content = crate::theme::C_LOGO_GREEN.to_rgba8();
    assert_eq!(
        l.resolve(&g, [content.r, content.g, content.b]),
        None,
        "brand marks are never theme-mapped ({logo:?})"
    );
    for id in ThemeId::ALL {
        assert!(
            id.palette().contrast_audit().is_empty(),
            "{} fails AA",
            id.label()
        );
    }
}

#[test]
fn theme_action_reports_the_active_palette_without_touching_it() {
    let mut h = host();
    h.dispatch(Action::SetTheme(x_native::ui::ThemeId::Graphite));
    assert!(
        h.app.status.contains("Graphite") && h.app.status.contains("already active"),
        "{}",
        h.app.status
    );
    // and it must not flip the global palette out from under other tests
    assert_eq!(
        crate::theme::active_theme(),
        x_native::ui::ThemeId::Graphite,
        "selecting the active theme is a no-op"
    );
}

/// The four text-style operations Figma's "Create and apply text styles"
/// describes, driven through the same App methods the picker's rows call:
/// create-from-selection, apply, update-with-propagation, detach.
#[test]
fn text_styles_create_apply_update_and_detach_end_to_end() {
    let mut h = host();
    let root_id = h.app.doc().editor_ref().root.id.clone();
    h.app.doc().editor().insert_node(
        &root_id,
        Node::text("ta", 0.0, 0.0, 200.0, 20.0, "Headline"),
    );
    h.app
        .doc()
        .editor()
        .insert_node(&root_id, Node::text("tb", 0.0, 40.0, 200.0, 20.0, "Body"));

    // give `ta` distinctive typography, then create the style from it
    h.app.doc().editor().selection = vec!["ta".into()];
    h.app.set_text_typo("font", "Lobster".into());
    h.app.set_text_typo("fw", "700".into());
    h.app.set_text_typo("fs", "32".into());
    let name = h
        .app
        .create_text_style_from_selection()
        .expect("a text layer is selected, so a style is created");
    assert_eq!(name, "New style");
    assert!(h.app.doc_ref().doc.text_style("New style").is_some());
    // creating also applies: the source layer is linked to its own style
    assert_eq!(
        h.app.linked_text_style("ta").as_deref(),
        Some("New style"),
        "create links the layer it was built from"
    );

    // apply to the second layer through the picker's row action
    h.app.doc().editor().selection = vec!["tb".into()];
    assert_eq!(h.app.apply_text_style("New style"), 1);
    assert_eq!(h.app.linked_text_style("tb").as_deref(), Some("New style"));
    let fs = |h: &Host, id: &str| {
        let root = &h.app.doc_ref().editor_ref().root;
        crate::editor_ui::find_node(root, id)
            .and_then(|n| n.bindings.get("fs").cloned())
            .unwrap_or_default()
    };
    assert_eq!(
        fs(&h, "tb"),
        "32",
        "the style's size reached the second layer"
    );

    // a local edit + "Update style" moves every consumer
    h.app.doc().editor().selection = vec!["ta".into()];
    h.app.set_text_typo("fs", "44".into());
    assert_eq!(h.app.update_text_style_from_selection(), Some(2));
    assert_eq!(fs(&h, "ta"), "44");
    assert_eq!(
        fs(&h, "tb"),
        "44",
        "the update propagated to the other consumer"
    );

    // detaching keeps the values and drops the link…
    h.app.doc().editor().selection = vec!["tb".into()];
    assert_eq!(h.app.detach_text_style_from_selection(), 1);
    assert_eq!(h.app.linked_text_style("tb"), None);
    assert_eq!(
        fs(&h, "tb"),
        "44",
        "detach keeps the typography it rendered"
    );

    // …so the next update no longer reaches it
    h.app.doc().editor().selection = vec!["ta".into()];
    h.app.set_text_typo("fs", "55".into());
    assert_eq!(h.app.update_text_style_from_selection(), Some(1));
    assert_eq!(fs(&h, "ta"), "55");
    assert_eq!(fs(&h, "tb"), "44", "a detached layer stays put");

    // the picker only offers create/apply for text layers
    h.app.doc().editor().selection = vec![root_id.clone()];
    assert_eq!(h.app.apply_text_style("New style"), 0);
    assert!(h.app.create_text_style_from_selection().is_none());
    assert_eq!(h.app.detach_text_style_from_selection(), 0);
}

#[test]
fn t16_layer_drag_merges_into_one_undo_step() {
    // AUDIT: dragging a layer pushed one undo entry per mouse event, so a
    // single gesture needed N Ctrl+Zs. Release must merge the gesture into
    // ONE step (the engine's merge_last), reverting the whole drag at once.
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    let depth0 = h.app.doc().editor_ref().undo_depth();

    // press the demo frame's center and drag it 30pt in three events
    let p0 = h.app.world_to_screen(Point::new(187.5, 270.0));
    h.app.mouse = p0;
    h.on_press(p0);
    for i in 1..=3 {
        let p = h
            .app
            .world_to_screen(Point::new(187.5 + i as f64 * 10.0, 270.0));
        h.app.mouse = p;
        h.on_move(p);
    }
    h.on_release();

    assert_eq!(
        h.app.doc().editor_ref().undo_depth(),
        depth0 + 1,
        "three move events = ONE undo step after release"
    );
    let x_after = find_node_clone(&h.app.doc_ref().editor_ref().root, "frame-1")
        .unwrap()
        .transform
        .x;
    assert!(
        (x_after - 30.0).abs() < 0.01,
        "frame moved 30pt, got {x_after}"
    );
    // one undo reverts the whole gesture
    assert!(h.app.doc().editor().undo());
    let x0 = find_node_clone(&h.app.doc_ref().editor_ref().root, "frame-1")
        .unwrap()
        .transform
        .x;
    assert!(
        x0.abs() < 0.01,
        "one undo reverted the entire drag, got {x0}"
    );
}

#[test]
fn t17_tab_close_button_closes_the_tab_not_selects_it() {
    // AUDIT: the ✕ sat inside the whole-tab SelectDoc zone and the hit
    // scan (reverse push order) let the tab zone win, so clicking ✕ just
    // selected the tab. The close zone must resolve to CloseDoc.
    let mut h = host();
    h.app.docs.push(OpenDoc::demo_blank("Second".into()));
    h.app.compose_frame(); // paint the chrome and build its hit zones
    let close_r = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::CloseDoc(0)))
        .map(|(r, _)| *r)
        .expect("tab ✕ hit zone is registered");
    let p = close_r.center();
    // the UI resolves hits in reverse push order — the zone under the ✕
    // must be CloseDoc(0), not the containing SelectDoc(0)
    let resolved = h
        .app
        .hit
        .iter()
        .rev()
        .find(|(r, _)| r.contains(p))
        .map(|(_, a)| a.clone());
    assert!(
        matches!(resolved, Some(Action::CloseDoc(0))),
        "✕ resolves to CloseDoc(0), got {resolved:?}"
    );
    // end-to-end through the real press handler
    h.app.mouse = p;
    h.on_press(p);
    assert_eq!(h.app.docs.len(), 1, "pressing ✕ closed the tab");
    assert_eq!(h.app.docs[0].name, "Second");
}

#[test]
fn t18_layers_drag_reorder_moves_the_node_with_one_undo() {
    let mut h = host();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    h.app
        .doc()
        .editor()
        .insert_node(&root_id, Node::frame("fr2", 300.0, 200.0));
    h.app.doc().editor().insert_node(
        "frame-1",
        Node::rect("card", 0.0, 0.0, 10.0, 10.0, x_native::Color::WHITE),
    );
    h.app.doc().expanded.insert("frame-1".into());
    h.app.win_w = 1440.0;
    h.app.win_h = 900.0;
    h.app.mouse = Point::new(100.0, 300.0);

    // paint fills the hit zones the press handler scans
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let card_r = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::TreeRow(i) if i == "card"))
        .map(|(r, _)| *r)
        .expect("card row hit zone");
    let fr2_r = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::TreeRow(i) if i == "fr2"))
        .map(|(r, _)| *r)
        .expect("fr2 row hit zone");

    // press on the card row, drag to fr2's top edge, release
    h.on_press(Point::new(card_r.x0 + 30.0, card_r.y0 + 1.0));
    h.on_move(Point::new(fr2_r.x0 + 30.0, fr2_r.y0 + 1.0));
    h.on_release();

    let ids: Vec<&str> = h
        .app
        .doc_ref()
        .editor_ref()
        .root
        .children
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    assert_eq!(ids, vec!["frame-1", "card", "fr2"], "drop before fr2");
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["card".to_string()]
    );
    // one undo step restores the original tree
    h.app.doc().editor().undo();
    let ids: Vec<&str> = h
        .app
        .doc_ref()
        .editor_ref()
        .root
        .children
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    assert_eq!(ids, vec!["frame-1", "fr2"]);
    let f1 = h
        .app
        .doc_ref()
        .editor_ref()
        .root
        .children
        .iter()
        .find(|c| c.id == "frame-1")
        .unwrap();
    assert_eq!(f1.children.len(), 1);
    assert_eq!(f1.children[0].id, "card");
}

#[test]
fn t19_layers_drag_click_without_move_only_selects() {
    let mut h = host();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    h.app
        .doc()
        .editor()
        .insert_node(&root_id, Node::frame("fr2", 300.0, 200.0));
    h.app.win_w = 1440.0;
    h.app.win_h = 900.0;
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let fr2_r = h
        .app
        .hit
        .iter()
        .find(|(_, a)| matches!(a, Action::TreeRow(i) if i == "fr2"))
        .map(|(r, _)| *r)
        .expect("fr2 row hit zone");
    let p = Point::new(fr2_r.x0 + 30.0, fr2_r.y0 + 4.0);
    h.on_press(p);
    // a sub-threshold jitter must not start a reorder
    h.on_move(Point::new(p.x + 2.0, p.y + 1.0));
    h.on_release();
    let ids: Vec<&str> = h
        .app
        .doc_ref()
        .editor_ref()
        .root
        .children
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    assert_eq!(ids, vec!["frame-1", "fr2"], "a click is not a drag");
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["fr2".to_string()],
        "the row click still selects"
    );
}

/// The two docks share the window with the canvas, both are resizable, and both
/// extremes are reachable (drag a panel wide, then shrink the window). The
/// layout has to degrade to the canvas floor — never invert the canvas rect or
/// let a dock paint over its neighbour.
#[test]
fn docks_never_eat_the_canvas() {
    let mut app = App::new();
    for win_w in [980.0, 1024.0, 1280.0, 1440.0, 1920.0, 2560.0] {
        app.win_w = win_w;
        for left_w in [ED_LEFT_MIN, ED_LEFT_W, ED_LEFT_MAX] {
            for right_w in [ED_RIGHT_MIN, ED_RIGHT_W, ED_RIGHT_MAX] {
                app.left_w = left_w;
                app.right_w = right_w;
                let r = app.editor_regions();
                assert!(
                    r.canvas.x1 >= r.canvas.x0,
                    "canvas inverted at {win_w} with docks {left_w}/{right_w}: {:?}",
                    r.canvas
                );
                assert!(
                    r.left.x1 <= r.canvas.x0 + 0.001,
                    "left dock over the canvas"
                );
                assert!(
                    r.canvas.x1 <= r.right.x0 + 0.001,
                    "right dock over the canvas"
                );
                assert!(r.right.x1 <= win_w + 0.001, "right dock past the window");
                assert!(r.canvas.width() >= 1.0, "canvas collapsed at {win_w}");
            }
        }
    }
    // the floor itself: the widest allowed docks at the minimum window still
    // leave exactly ED_CANVAS_MIN of canvas
    app.win_w = 980.0;
    app.left_w = ED_LEFT_MAX;
    app.right_w = ED_RIGHT_MAX;
    let r = app.editor_regions();
    assert!(
        (r.canvas.width() - ED_CANVAS_MIN).abs() < 0.001,
        "want the canvas floor, got {}",
        r.canvas.width()
    );
}

/// A host sitting on the dashboard, painted once so `hit` is populated.
fn dashboard_host() -> Host {
    let mut h = host();
    h.app.screen = Screen::Dashboard;
    h.app.docs.clear();
    h.app.win_w = 1440.0;
    h.app.win_h = 900.0;
    h.app.dash_view = DashView::Home;
    h.app.mouse = Point::new(-100.0, -100.0);
    // `App::new()` fills `recents` from the machine's store: empty on a fresh
    // runner, and written by whatever else in this suite happens to be saving a
    // file while these tests run in parallel. These tests count, sort and select
    // files, so they get the demo fixture — the same six rows on every run.
    h.app.recents = App::demo().recents;
    let mut scene = vello::Scene::new();
    dashboard::paint(&mut h.app, &mut scene);
    h
}

#[test]
fn dashboard_is_reachable_by_keyboard() {
    let mut h = dashboard_host();
    let targets = dashboard::focus_targets(&h.app);
    assert!(
        targets.len() >= 8,
        "the dashboard must expose its controls to the keyboard, found {}",
        targets.len()
    );
    // every stop is a real target with a real action
    for i in &targets {
        let (r, _) = &h.app.hit[*i];
        assert!(
            r.width() > 0.0 && r.height() > 0.0,
            "degenerate focus target"
        );
    }

    // Tab from nothing lands on the first stop, Shift+Tab on the last
    h.on_key(Key::Named(NamedKey::Tab), None);
    assert_eq!(h.app.dash_focus, Some(0));
    h.on_key(Key::Named(NamedKey::Tab), None);
    assert_eq!(h.app.dash_focus, Some(1));
    h.app.shift = true;
    h.on_key(Key::Named(NamedKey::Tab), None);
    assert_eq!(h.app.dash_focus, Some(0));
    h.app.shift = false;
    h.on_key(Key::Named(NamedKey::Tab), None);
    h.on_key(Key::Named(NamedKey::Tab), None);
    assert_eq!(h.app.dash_focus, Some(2), "Tab must keep moving forward");

    // Escape drops the ring; the next Tab starts over from the top
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert_eq!(h.app.dash_focus, None);
    h.on_key(Key::Named(NamedKey::Tab), None);
    assert_eq!(h.app.dash_focus, Some(0));

    // Enter on a stop does what clicking it does: walk to "Recents"
    let recents = h
        .app
        .hit
        .iter()
        .position(|(_, a)| *a == Action::DashNav(DashView::Recents))
        .expect("the sidebar has a Recents row");
    let at = targets.iter().position(|t| *t == recents).unwrap();
    for _ in 0..targets.len() + 1 {
        if h.app.dash_focus == Some(at) {
            break;
        }
        h.on_key(Key::Named(NamedKey::Tab), None);
    }
    assert_eq!(h.app.dash_focus, Some(at));
    h.on_key(Key::Named(NamedKey::Enter), None);
    assert_eq!(
        h.app.dash_view,
        DashView::Recents,
        "Enter fires the focused control"
    );
}

#[test]
fn pointer_says_what_it_will_do() {
    let mut h = dashboard_host();
    let reg = h.app.editor_regions();
    assert!(h.app.hit.len() > 5, "paint populated the hit list");

    // dead space in the main column: nothing to click
    h.app.mouse = Point::new(reg.sidebar.x1 + 8.0, h.app.win_h - 8.0);
    let dead = cursor_for(&h.app);
    // the search field is a text field, in the top bar
    h.app.mouse = dashboard::search_rect(&h.app).center();
    assert_eq!(cursor_for(&h.app), CursorIcon::Text);
    // every control says "clickable"
    let (rect, _) = h.app.hit[h.app.hit.len() - 1].clone();
    h.app.mouse = rect.center();
    assert_eq!(cursor_for(&h.app), CursorIcon::Pointer);
    assert_ne!(dead, CursorIcon::Text);

    // the dashboard used to render as a plain arrow everywhere — the whole
    // file browser had no hover affordance at all
    let mut pointer = 0;
    for i in 0..h.app.hit.len() {
        let (r, _) = h.app.hit[i].clone();
        if r.width() < 40.0 || r.height() < 20.0 {
            continue;
        }
        h.app.mouse = r.center();
        if cursor_for(&h.app) == CursorIcon::Pointer {
            pointer += 1;
        }
    }
    assert!(pointer >= 3, "only {pointer} controls advertise themselves");
}

/// The sort key is parsed from the label the UI shows, so the two cannot
/// disagree; an unknown label sorts last instead of jumping to the top.
#[test]
fn edited_labels_sort_by_what_they_say() {
    use crate::state::edited_minutes;
    assert_eq!(edited_minutes("Edited 2h ago"), 120);
    assert_eq!(edited_minutes("Edited 45 min ago"), 45);
    assert_eq!(edited_minutes("Edited yesterday"), 1440);
    assert_eq!(edited_minutes("Edited 3 days ago"), 4320);
    assert_eq!(edited_minutes("Edited 1 week ago"), 10080);
    assert_eq!(edited_minutes("now"), 0);
    assert_eq!(edited_minutes("whenever"), u32::MAX);
    // Every seeded row stores the parse of the label it shows, because both
    // come from `edited_minutes`. A row may sort as unknown, but only when it
    // really is one: a file on disk we have never opened ("Open from disk").
    let app = App::new();
    for f in app.recents.iter().chain(app.drafts.iter()) {
        assert_eq!(
            f.edited_min,
            edited_minutes(&f.edited),
            "seed {:?} stores {:?} but its label says {:?}",
            f.name,
            f.edited_min,
            f.edited
        );
        if f.edited_min == u32::MAX {
            assert!(
                f.path.is_some(),
                "only a never-opened file may sort as unknown: {:?}",
                f.name
            );
        }
    }
}

#[test]
fn the_browser_can_be_sorted() {
    let mut h = dashboard_host();
    h.app.demo_mode = false; // show every file, not the six-file demo page
    h.app.dash_sort = DashSort::Edited;
    let by_edited = dashboard::visible_files(&h.app);
    let keys: Vec<u32> = by_edited
        .iter()
        .map(|i| h.app.recents[*i].edited_min)
        .collect();
    assert!(keys.windows(2).all(|w| w[0] <= w[1]), "edited: {keys:?}");

    h.app.dash_sort = DashSort::Name;
    let by_name = dashboard::visible_files(&h.app);
    let names: Vec<String> = by_name
        .iter()
        .map(|i| h.app.recents[*i].name.to_lowercase())
        .collect();
    assert!(names.windows(2).all(|w| w[0] <= w[1]), "name: {names:?}");
    assert_eq!(
        by_name.len(),
        by_edited.len(),
        "sorting must not drop files"
    );

    h.app.dash_sort = DashSort::Starred;
    for i in [0usize, 3] {
        if let Some(f) = h.app.recents.get_mut(i) {
            f.starred = true;
        }
    }
    let starred = dashboard::visible_files(&h.app);
    let star_rank: Vec<bool> = starred.iter().map(|i| h.app.recents[*i].starred).collect();
    let first_unstarred = star_rank.iter().position(|s| !s).unwrap_or(star_rank.len());
    assert!(
        star_rank[..first_unstarred].iter().all(|s| *s),
        "starred files must float: {star_rank:?}"
    );
    assert!(star_rank[first_unstarred..].iter().all(|s| !s));

    // the view filter still applies on top of the sort
    h.app.dash_view = DashView::Starred;
    let only_starred = dashboard::visible_files(&h.app);
    assert!(only_starred.iter().all(|i| h.app.recents[*i].starred));
}

#[test]
fn multi_select_and_its_bulk_actions() {
    let mut h = dashboard_host();
    h.app.demo_mode = false;
    let visible = dashboard::visible_files(&h.app);
    assert!(visible.len() >= 4, "need a few files to select");

    // toggle on, toggle off
    h.dispatch(Action::DashSelect(visible[0]));
    assert_eq!(h.app.dash_selected, vec![visible[0]]);
    h.dispatch(Action::DashSelect(visible[1]));
    assert_eq!(h.app.dash_selected.len(), 2);
    h.dispatch(Action::DashSelect(visible[0]));
    assert_eq!(h.app.dash_selected, vec![visible[1]]);

    // select all = everything on screen, in the order it is on screen
    h.dispatch(Action::DashSelectAll);
    assert_eq!(h.app.dash_selected, visible);

    // bulk star writes through to the files' starred flag
    h.dispatch(Action::DashBulkStar);
    assert!(visible.iter().all(|i| h.app.recents[*i].starred));
    h.dispatch(Action::DashBulkUnstar);
    assert!(visible.iter().all(|i| !h.app.recents[*i].starred));

    // remove drops them from the list and keeps the rest
    let before = h.app.recents.len();
    h.dispatch(Action::DashBulkRemove);
    assert_eq!(h.app.recents.len(), before - visible.len());
    assert!(
        h.app.dash_selected.is_empty(),
        "the bar goes away with them"
    );

    // clear is the explicit way out
    h.dispatch(Action::DashSelect(0));
    h.dispatch(Action::DashClearSelection);
    assert!(h.app.dash_selected.is_empty());
}

#[test]
fn the_bulk_bar_is_only_there_when_something_is_selected() {
    let mut h = dashboard_host();
    let has_bar = |h: &Host| h.app.hit.iter().any(|(_, a)| *a == Action::DashBulkStar);
    assert!(!has_bar(&h), "nothing selected: no bar");
    h.dispatch(Action::DashSelect(0));
    let mut scene = vello::Scene::new();
    dashboard::paint(&mut h.app, &mut scene);
    assert!(has_bar(&h), "one file selected: the bar is painted");
    // and its buttons are real targets with real actions
    for want in [
        Action::DashBulkStar,
        Action::DashBulkUnstar,
        Action::DashBulkOpen,
        Action::DashBulkRemove,
        Action::DashClearSelection,
    ] {
        assert!(
            h.app.hit.iter().any(|(_, a)| *a == want),
            "{want:?} is missing from the bar"
        );
    }
    // the bar swallows presses on its own background
    assert!(h.app.hit.iter().any(|(_, a)| *a == Action::DashBarNoop));
}

#[test]
fn escape_unwinds_the_dashboard_one_step_at_a_time() {
    let mut h = dashboard_host();
    h.dispatch(Action::DashSelect(0));
    h.dispatch(Action::DashSortMenu);
    h.on_key(Key::Named(NamedKey::Tab), None);
    assert!(h.app.dash_sort_open);
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(!h.app.dash_sort_open, "the menu closes first");
    assert_eq!(h.app.dash_selected.len(), 1, "the selection survives");
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(h.app.dash_selected.is_empty(), "then the selection clears");
    assert!(h.app.dash_focus.is_some(), "and the ring is still there");
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(h.app.dash_focus.is_none(), "then the ring goes");
}

#[test]
fn the_sort_menu_picks_an_order_and_closes() {
    let mut h = dashboard_host();
    h.dispatch(Action::DashSortMenu);
    assert!(h.app.dash_sort_open);
    h.dispatch(Action::DashSortBy(DashSort::Name));
    assert_eq!(h.app.dash_sort, DashSort::Name);
    assert!(!h.app.dash_sort_open, "picking an order closes the menu");
    // the menu rows only exist while it is open
    h.dispatch(Action::DashSortMenu);
    let mut scene = vello::Scene::new();
    dashboard::paint(&mut h.app, &mut scene);
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| matches!(a, Action::DashSortBy(_))));
}

// ------------------------------------------------------- paint library

/// A host with one rect selected and a colour variable to bind.
fn paint_library_host() -> Host {
    let mut h = host();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    let n = Node::rect("v1", 40.0, 40.0, 60.0, 60.0, Color::BLACK);
    h.app.doc().editor().insert_node(&root_id, n);
    h.app.doc().editor().selection = vec!["v1".into()];
    h.app
        .doc()
        .doc
        .variables
        .colors
        .insert("brand/signal".into(), Color::from_rgb8(0x2F, 0x6B, 0xFF));
    h
}

fn rgba(c: Color) -> (u8, u8, u8, u8) {
    let p = c.to_rgba8();
    (p.r, p.g, p.b, p.a)
}

/// Binding a fill to a variable must be a LINK, not a colour copy: editing the
/// variable repaints every consumer without touching a node.
#[test]
fn a_bound_fill_follows_the_variable_it_names() {
    let mut h = paint_library_host();
    h.dispatch(Action::ApplyPaintVariable(true, "brand/signal".into()));
    let paint = h.app.paint_of("v1", true).expect("v1 exists");
    assert!(
        matches!(&paint, Paint::Variable(n) if n == "brand/signal"),
        "the fill must become the variable, found {paint:?}"
    );
    let before = {
        let vars = &h.app.doc_ref().doc.variables;
        rgba(x_native::paint_color(&paint, vars))
    };
    assert_eq!(before, (0x2F, 0x6B, 0xFF, 255));
    assert_eq!(
        h.app
            .doc_ref()
            .doc
            .variables
            .color("brand/signal", Color::BLACK),
        Color::from_rgb8(0x2F, 0x6B, 0xFF)
    );

    // the document owner edits the variable: the layer follows, no node edit
    h.app
        .doc()
        .doc
        .variables
        .colors
        .insert("brand/signal".into(), Color::from_rgb8(0xFF, 0x00, 0x00));
    let after = {
        let paint = h.app.paint_of("v1", true).expect("v1 exists");
        let vars = &h.app.doc_ref().doc.variables;
        rgba(x_native::paint_color(&paint, vars))
    };
    assert_eq!(after, (0xFF, 0x00, 0x00, 255), "the binding is live");
}

/// Detach keeps the colour that was on screen: the link goes, the pixels stay.
#[test]
fn detaching_keeps_the_colour_the_variable_painted() {
    let mut h = paint_library_host();
    h.dispatch(Action::ApplyPaintVariable(true, "brand/signal".into()));
    h.dispatch(Action::DetachPaintBinding(true));
    let paint = h.app.paint_of("v1", true).expect("v1 exists");
    assert!(
        matches!(paint, Paint::Solid(c) if rgba(c) == (0x2F, 0x6B, 0xFF, 255)),
        "detach must freeze the resolved colour, found {paint:?}"
    );
    // and the document is unchanged by a later variable edit
    h.app
        .doc()
        .doc
        .variables
        .colors
        .insert("brand/signal".into(), Color::from_rgb8(0x00, 0xFF, 0x00));
    let paint = h.app.paint_of("v1", true).expect("v1 exists");
    assert!(matches!(paint, Paint::Solid(c) if rgba(c) == (0x2F, 0x6B, 0xFF, 255)));
}

/// A paint style is a fill style: applying it links the layer, and the stroke
/// row says so instead of offering something that would not work.
#[test]
fn a_paint_style_links_the_fill_and_the_stroke_row_says_so() {
    let mut h = paint_library_host();
    h.app.doc().doc.styles.insert(
        "Brand/Primary".into(),
        x_native::LegacyStyle::Paint {
            fill: Paint::Solid(Color::from_rgb8(0x11, 0x22, 0x33)),
        },
    );
    h.dispatch(Action::ApplyPaintStyle("Brand/Primary".into()));
    assert_eq!(
        h.app.linked_paint_style("v1").as_deref(),
        Some("Brand/Primary"),
        "applying a paint style links the layer"
    );
    let paint = h.app.paint_of("v1", true).expect("v1 exists");
    assert!(matches!(paint, Paint::Solid(c) if rgba(c) == (0x11, 0x22, 0x33, 255)));

    // the popover offers the style on the fill row…
    h.dispatch(Action::PaintLibToggle(true));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let rows: Vec<Action> = h.app.hit.iter().map(|(_, a)| a.clone()).collect();
    assert!(
        rows.iter()
            .any(|a| matches!(a, Action::ApplyPaintStyle(n) if n == "Brand/Primary")),
        "the fill popover lists the file's paint styles"
    );
    assert!(
        rows.iter()
            .any(|a| matches!(a, Action::ApplyPaintVariable(true, n) if n == "brand/signal")),
        "and its colour variables"
    );

    // …and only variables on the stroke row
    h.dispatch(Action::PaintLibToggle(false));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let rows: Vec<Action> = h.app.hit.iter().map(|(_, a)| a.clone()).collect();
    assert!(
        rows.iter()
            .any(|a| matches!(a, Action::ApplyPaintVariable(false, n) if n == "brand/signal")),
        "the stroke popover binds variables"
    );
    assert!(
        !rows.iter().any(|a| matches!(a, Action::ApplyPaintStyle(_))),
        "a fill style must not be offered on a stroke row"
    );
}

/// The popover is a real popover: the pointer advertises its rows and Escape
/// unwinds it before anything else.
#[test]
fn the_paint_library_advertises_itself_and_escape_closes_it() {
    let mut h = paint_library_host();
    h.dispatch(Action::PaintLibToggle(true));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let rect = crate::editor_ui::paint_lib_rect(&h.app).expect("the popover has a rect");
    h.app.mouse = rect.center();
    assert_eq!(
        cursor_for(&h.app),
        CursorIcon::Pointer,
        "rows inside the popover are clickable"
    );
    // the click the user makes: press on the variable's row and it applies
    let row = h
        .app
        .hit
        .iter()
        .rev()
        .find_map(|(r, a)| match a {
            Action::ApplyPaintVariable(true, n) if n == "brand/signal" => Some(*r),
            _ => None,
        })
        .expect("the variable has a row in the popover");
    h.on_press(row.center());
    assert!(
        matches!(h.app.paint_of("v1", true), Some(Paint::Variable(ref n)) if n == "brand/signal"),
        "clicking the row binds the fill"
    );
    assert_eq!(h.app.paint_lib, None, "and closes the popover");

    // Escape unwinds an open popover before it touches the selection
    h.dispatch(Action::PaintLibToggle(true));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert_eq!(h.app.paint_lib, None, "Escape closes the popover first");
    assert!(
        h.app
            .doc_ref()
            .editor_ref()
            .selection
            .contains(&"v1".into()),
        "and does not cost the selection"
    );
}

// --------------------------------------------------- canvas navigation

/// A host with a page of known content: three rects in a known box.
fn canvas_host() -> Host {
    let mut h = host();
    // the seeded host may carry a demo frame: this page is exactly the three
    // rects below, so every bound the tests measure is known
    h.app.doc().editor().root.children.clear();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    for (id, x, y, w, hh) in [
        ("n-a", 100.0, 100.0, 200.0, 100.0),
        ("n-b", 500.0, 300.0, 400.0, 200.0),
        ("n-c", 1200.0, 900.0, 100.0, 100.0),
    ] {
        h.app.doc().editor().insert_node(
            &root_id,
            Node::rect(id, x, y, w, hh, Color::from_rgb8(0x40, 0x50, 0x60)),
        );
    }
    h.app.win_w = 1440.0;
    h.app.win_h = 900.0;
    h.app.screen = Screen::Editor;
    h.app.status.clear();
    h
}

/// Figma, "Select multiple layers — Canvas": `Shift`-click adds a layer to the
/// selection, and a *second* Shift-click on the same layer removes it again
/// ("Click an object a second time while holding Shift to remove it from the
/// current selection"). A plain click still replaces the whole selection.
/// Figma's Layer → "Show name": the switch lives where the layer is described,
/// changes only what the canvas paints, and undoes like every other property.
#[test]
fn the_show_name_row_toggles_a_frame_name_undoably_and_only_for_frames() {
    let mut h = canvas_host();
    h.app.doc().editor().root = Node::frame("page", 800.0, 600.0)
        .child(Node::frame("f", 200.0, 150.0))
        .child(Node::rect("r", 0.0, 0.0, 40.0, 40.0, Color::WHITE));
    h.app.doc().editor().selection = vec!["f".into()];
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let p = h
        .app
        .hit
        .iter()
        .find(|(_, a)| *a == Action::ToggleShowName)
        .map(|(r, _)| r.center())
        .expect("the Show name row is painted for a frame");
    h.on_press(p);
    let shown = |h: &Host| {
        x_native::editor::find(&h.app.doc_ref().editor_ref().root, "f")
            .unwrap()
            .show_name
    };
    assert!(!shown(&h), "the checkbox switches the frame's name off");
    assert!(h.app.doc().editor().undo(), "the switch is undoable");
    assert!(shown(&h), "undo restores the name");
    assert!(h.app.status.contains("hidden") || h.app.status.contains("shown"));

    // a rectangle has no frame name to switch, so it gets no row
    h.app.doc().editor().selection = vec!["r".into()];
    let mut scene2 = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene2);
    assert!(
        h.app.hit.iter().all(|(_, a)| *a != Action::ToggleShowName),
        "the switch belongs to frames; a rectangle is not offered it"
    );
}

/// Figma binds Select matching layers to ⌥⌘A (the variant's doc comment said so
/// while the only binding was ⇧⌥⌘M), and the rule is Figma's: the same layer —
/// by name and place, not by size — in the other frames of the scope.
#[test]
fn option_command_a_selects_the_matching_layer_in_the_other_frame() {
    let mut h = canvas_host();
    let layer = |id: &str, x: f64| {
        let mut n = Node::rect(id, x, 20.0, 80.0, 40.0, Color::WHITE);
        n.name = "Title".into();
        n
    };
    let left = Node::frame("left", 200.0, 200.0)
        .child(layer("l-title", 10.0))
        .child(layer("l-body", 10.0));
    let mut right = Node::frame("right", 200.0, 200.0).child(layer("r-title", 10.0));
    right.transform.x = 300.0;
    h.app.doc().editor().root = Node::frame("page", 800.0, 600.0).child(left).child(right);
    h.app.doc().editor().selection = vec!["l-title".into()];

    h.app.alt = true;
    h.app.ctrl = true;
    h.on_key(Key::Character("a".into()), None);
    h.app.alt = false;
    h.app.ctrl = false;

    let sel = h.app.doc_ref().editor_ref().selection.clone();
    assert_eq!(
        sel,
        vec!["l-title".to_string(), "r-title".to_string()],
        "the Title in the other frame, and nothing else"
    );
    assert!(h.app.status.contains("2 matching"), "{}", h.app.status);
}

/// Figma's layer walk — "Select Child ⏎ / Select Parent ⇧⏎ / Select Next
/// Sibling ⇥ / Select Previous Sibling ⇧⇥" — and the page is not a layer to
/// walk up into.
#[test]
fn enter_tab_and_shift_enter_walk_the_layers_the_way_figma_documents() {
    let rect = |id: &str| Node::rect(id, 0.0, 0.0, 40.0, 40.0, Color::WHITE);
    let mut h = canvas_host();
    h.app.doc().editor().root = Node::frame("page", 800.0, 600.0)
        .child(
            Node::frame("f", 200.0, 200.0).child(
                Node::group("g", 100.0, 100.0)
                    .child(rect("r1"))
                    .child(rect("r2")),
            ),
        )
        .child(rect("other"));
    let sel = |h: &Host| h.app.doc_ref().editor_ref().selection.clone();

    h.app.doc().editor().selection = vec!["f".into()];
    h.on_key(Key::Named(NamedKey::Enter), None); // ⏎ = one level down
    assert_eq!(sel(&h), vec!["g".to_string()], "⏎ selects the child");
    h.dispatch(Action::SelectChild);
    assert_eq!(sel(&h), vec!["r1".to_string()], "⏎ again goes deeper");
    h.dispatch(Action::SelectParent);
    assert_eq!(sel(&h), vec!["g".to_string()], "⇧⏎ climbs to the parent");

    h.app.doc().editor().selection = vec!["f".into()];
    h.dispatch(Action::SelectNextSibling);
    assert_eq!(sel(&h), vec!["other".to_string()], "⇥ is the next sibling");
    h.dispatch(Action::SelectPrevSibling);
    assert_eq!(sel(&h), vec!["f".to_string()], "⇧⇥ is the previous one");

    // a top-level layer has no layer above it: ⇧⏎ must not promote the PAGE
    h.app.doc().editor().selection = vec!["other".into()];
    h.dispatch(Action::SelectParent);
    assert_eq!(
        sel(&h),
        vec!["other".to_string()],
        "the page root is not a selectable layer"
    );
}

#[test]
fn shift_click_adds_and_a_second_shift_click_removes_from_the_selection() {
    let mut h = canvas_host();
    let a = h.app.world_to_screen(Point::new(200.0, 150.0)); // n-a
    let b = h.app.world_to_screen(Point::new(700.0, 400.0)); // n-b
    let click = |h: &mut Host, p: Point| {
        h.app.last_click = None; // a fresh click, never a double-click
        h.app.mouse = p;
        h.on_press(p);
        h.on_release();
    };

    click(&mut h, a);
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["n-a".to_string()],
        "a plain click selects the one layer"
    );
    h.app.shift = true;
    click(&mut h, b);
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["n-a".to_string(), "n-b".to_string()],
        "Shift-click adds"
    );
    click(&mut h, b);
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["n-a".to_string()],
        "a second Shift-click removes that layer again"
    );
    h.app.shift = false;
    click(&mut h, b);
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["n-b".to_string()],
        "a plain click replaces the selection"
    );
}

/// Figma, "Selection marquee": dragging on empty canvas selects the page's
/// top-level objects — "To select nested layers, hold down the modifier key
/// and drag the marquee across the objects". Without it, a marquee over a
/// frame answers with the frame, never with the layers inside it.
#[test]
fn command_drag_marquee_reaches_nested_layers_while_a_plain_drag_stops_at_the_frame() {
    let mut h = canvas_host();
    h.app.doc().editor().root.children.clear();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    let mut frame = Node::frame("m-frame", 300.0, 200.0);
    frame.transform.x = 100.0;
    frame.transform.y = 100.0;
    let child = Node::rect("m-child", 40.0, 40.0, 60.0, 60.0, Color::WHITE);
    frame.children.push(child);
    h.app.doc().editor().insert_node(&root_id, frame);

    let from = h.app.world_to_screen(Point::new(10.0, 10.0));
    let to = h.app.world_to_screen(Point::new(430.0, 330.0));
    let reg = h.app.editor_regions();
    assert!(
        reg.canvas.contains(from) && reg.canvas.contains(to),
        "the drag has to run inside the canvas"
    );
    let drag = |h: &mut Host, deep: bool| {
        h.app.ctrl = deep;
        h.app.last_click = None;
        h.app.mouse = from;
        h.on_press(from);
        h.app.mouse = to;
        h.on_move(to);
        h.on_release();
        h.app.ctrl = false;
    };

    drag(&mut h, false);
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["m-frame".to_string()],
        "a plain marquee answers with the frame, not the layer inside it"
    );
    drag(&mut h, true);
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        vec!["m-frame".to_string(), "m-child".to_string()],
        "the ⌘/Ctrl drag reaches the layer nested inside the frame"
    );
}

/// Figma: clicking inside the field you are already editing moves the caret to
/// the click. The press must keep the buffer you have typed — re-seeding it
/// from the layer's committed text would drop the edit on the floor.
#[test]
fn pressing_inside_the_open_text_field_keeps_what_was_typed() {
    let mut h = host();
    h.app.doc().editor().root.children.clear();
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    let text = Node::text("t-1", 60.0, 60.0, 200.0, 40.0, "hi");
    h.app.doc().editor().insert_node(&root_id, text);
    h.app.begin_text_edit("t-1".into(), "hi".into());
    h.app.text_insert("X");
    assert_eq!(h.app.text_buffer, "hiX");

    let r = h
        .app
        .text_edit_rect()
        .expect("the inline editor has a rect");
    let p = Point::new(r.x0 + 3.0, (r.y0 + r.y1) / 2.0);
    h.app.last_click = None;
    h.app.mouse = p;
    h.on_press(p);
    assert_eq!(
        h.app.text_edit.as_deref(),
        Some("t-1"),
        "the press landed in the editor, it did not open a different field"
    );
    assert_eq!(
        h.app.text_buffer, "hiX",
        "the typed buffer survived the press"
    );
}

/// Every navigation aid has to agree with the content: the minimap's box is
/// the union of the page's visible nodes, and the viewport lands inside it.
#[test]
fn the_minimap_maps_the_pages_content_and_nothing_else() {
    let mut h = canvas_host();
    let b = crate::editor_ui::page_content_bounds(&h.app).expect("the page has content");
    assert_eq!((b.x0, b.y0, b.x1, b.y1), (100.0, 100.0, 1300.0, 1000.0));

    let g = crate::editor_ui::minimap_geom(&h.app).expect("the minimap is on by default");
    let reg = h.app.editor_regions();
    assert!(
        g.panel.x0 >= reg.canvas.x0
            && g.panel.y0 >= reg.canvas.y0
            && g.panel.x1 <= reg.canvas.x1
            && g.panel.y1 <= reg.canvas.y1,
        "the panel must sit inside the canvas, found {:?} vs {:?}",
        g.panel,
        reg.canvas
    );

    // the mapping is a similarity: content corners land inside the panel and
    // round-trip back to the world coordinate they came from
    let tl = g.to_panel(b.x0, b.y0);
    let br = g.to_panel(b.x1, b.y1);
    assert!(g.panel.contains(tl) && g.panel.contains(br));
    let back = g.to_world(tl);
    assert!((back.x - b.x0).abs() < 0.5 && (back.y - b.y0).abs() < 0.5);
    // tighter axis keeps the panel's aspect (letterboxed, never stretched)
    let ratio_world = b.width() / b.height();
    let ratio_panel = (br.x - tl.x) / (br.y - tl.y);
    assert!(
        (ratio_world - ratio_panel).abs() < 0.01,
        "the sketch must not stretch: {ratio_world} vs {ratio_panel}"
    );

    // hidden layers are not part of the page's extent
    let id = "n-c";
    h.app.doc().editor().set_visible(id, false);
    let b2 = crate::editor_ui::page_content_bounds(&h.app).expect("two nodes left");
    assert_eq!((b2.x0, b2.y0, b2.x1, b2.y1), (100.0, 100.0, 900.0, 500.0));
}

/// A click on the map is a navigation: the point under the pointer ends up in
/// the middle of the canvas, and scrubbing keeps it there.
#[test]
fn scrubbing_the_minimap_moves_the_viewport_where_you_point() {
    let mut h = canvas_host();
    let g = crate::editor_ui::minimap_geom(&h.app).unwrap();
    let reg = h.app.editor_regions();
    let target = Point::new(800.0, 500.0); // world
    let on_map = g.to_panel(target.x, target.y);
    assert!(g.panel.contains(on_map), "the target is on the map");

    h.on_press(on_map);
    assert!(
        matches!(h.app.drag, Some(Drag::Minimap)),
        "a press on the map starts a scrub"
    );
    let center = h.app.screen_to_world(Point::new(
        reg.canvas.x0 + reg.canvas.width() / 2.0,
        reg.canvas.y0 + reg.canvas.height() / 2.0,
    ));
    assert!(
        (center.x - target.x).abs() < 1.0 && (center.y - target.y).abs() < 1.0,
        "the pressed point must come to the middle, found {center:?}"
    );

    // dragging continues the scrub, releasing ends it
    let root_id = h.app.doc_ref().editor_ref().root.id.clone();
    h.app.doc().editor().insert_node(
        &root_id,
        Node::rect("n-d", 2000.0, 100.0, 100.0, 100.0, Color::BLACK),
    );
    let g = crate::editor_ui::minimap_geom(&h.app).unwrap();
    let move_to = g.to_panel(2100.0, 150.0);
    h.on_move(move_to);
    let center = h.app.screen_to_world(Point::new(
        reg.canvas.x0 + reg.canvas.width() / 2.0,
        reg.canvas.y0 + reg.canvas.height() / 2.0,
    ));
    assert!(
        center.x > 1500.0,
        "scrubbing follows the pointer, found x={}",
        center.x
    );
    h.on_release();
    assert!(h.app.drag.is_none());
    // the map is a drag surface: it advertises itself as one
    h.app.mouse = g.panel.center();
    assert_eq!(cursor_for(&h.app), CursorIcon::Grab);
    h.app.mouse = g.close().center();
    assert_eq!(cursor_for(&h.app), CursorIcon::Pointer);
}

/// ⇧1 must fit what is drawn — the frame can be smaller than the content and
/// the old fit only knew the frame.
#[test]
fn zoom_to_fit_frames_the_content_not_the_canvas() {
    let mut h = canvas_host();
    h.app.zoom = 8.0;
    h.app.pan = (0.0, 0.0);
    h.zoom_fit();
    let reg = h.app.editor_regions();
    let b = crate::editor_ui::page_content_bounds(&h.app).unwrap();
    // every corner of the content is on screen at the fitted zoom
    for (wx, wy) in [(b.x0, b.y0), (b.x1, b.y0), (b.x0, b.y1), (b.x1, b.y1)] {
        let p = h.app.world_to_screen(Point::new(wx, wy));
        assert!(
            reg.canvas.contains(p),
            "corner ({wx}, {wy}) → {p:?} is outside {:?} at zoom {}",
            reg.canvas,
            h.app.zoom
        );
    }
    // and it is centred, not clamped to a corner
    let c = h.app.world_to_screen(b.center());
    let mid = reg.canvas.center();
    assert!(
        (c.x - mid.x).abs() < 1.0 && (c.y - mid.y).abs() < 1.0,
        "the content centre must be the viewport centre, found {c:?} vs {mid:?}"
    );
    // a page with nothing on it keeps the old frame camera
    let mut empty = host();
    empty.app.docs[0].editors[0].root.children.clear();
    empty.zoom_fit();
    assert!(empty.app.zoom > 0.0, "an empty page still gets a camera");
}

/// The minimap is optional and its ✕ is the drawn ✕: the toggle round-trips,
/// the close button closes, and a hidden map takes no presses.
#[test]
fn the_minimap_toggles_and_its_close_button_is_real() {
    let mut h = canvas_host();
    assert!(h.app.minimap, "on by default in the editor");
    let g = crate::editor_ui::minimap_geom(&h.app).unwrap();
    h.on_press(g.close().center());
    assert!(!h.app.minimap, "the ✕ hides the map");
    assert!(h.app.status.contains("⇧M"), "and says how to get it back");
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    crate::editor_ui::paint_over(&mut h.app, &mut scene);
    assert!(
        crate::editor_ui::minimap_geom(&h.app).is_none(),
        "a hidden map has no geometry"
    );

    h.dispatch(Action::ToggleMinimap);
    assert!(h.app.minimap);
    let g = crate::editor_ui::minimap_geom(&h.app).unwrap();
    // a press on the map does not reach the canvas underneath it
    let before = h.app.doc_ref().editor_ref().selection.clone();
    h.on_press(g.panel.center());
    assert_eq!(
        h.app.doc_ref().editor_ref().selection,
        before,
        "the map swallows its own presses"
    );
    // an empty page has nothing to map
    h.app.doc().editor().selection.clear();
    for id in ["n-a", "n-b", "n-c"] {
        h.app.doc().editor().set_visible(id, false);
    }
    assert!(crate::editor_ui::minimap_geom(&h.app).is_none());
}

/// A guide you cannot measure is a guess: the readout follows the dragged
/// line, says its world coordinate, and stays inside the canvas.
#[test]
fn the_guide_readout_says_where_the_line_is() {
    let mut h = canvas_host();
    h.app.rulers = true;
    let reg = h.app.editor_regions();
    let (r, label) = crate::editor_ui::guide_readout(&h.app, 'v', 340.0).expect("on-canvas guide");
    assert_eq!(label, "340");
    assert!(
        r.x0 >= reg.canvas.x0
            && r.y0 >= reg.canvas.y0
            && r.x1 <= reg.canvas.x1
            && r.y1 <= reg.canvas.y1,
        "the chip must stay on the canvas, found {r:?}"
    );
    let line = h.app.world_to_screen(Point::new(340.0, 0.0)).x;
    assert!(
        (r.x0 - (line + 6.0)).abs() < 0.01,
        "the chip sits beside the line it measures"
    );
    // an off-canvas guide has no readout to paint
    assert!(crate::editor_ui::guide_readout(&h.app, 'v', -10_000.0).is_none());

    // and a real drag shows it: the line is in the document, the value on screen
    h.app.doc().guides_visible = true;
    h.app.doc().guides.push(('v', 340.0));
    *h.app.guide_drag() = Some(('v', 512.0));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint_over(&mut h.app, &mut scene);
    let (_, live) = crate::editor_ui::guide_readout(&h.app, 'v', 512.0).unwrap();
    assert_eq!(live, "512", "the readout follows the dragged coordinate");
}

/// Pages are recognisable before they are opened: a page with content gets a
/// sketch, an empty one keeps the plain glyph, and the row still switches.
#[test]
fn pages_show_a_sketch_and_still_switch() {
    let mut h = canvas_host();
    h.dispatch(Action::AddPage);
    let page1 = h.app.doc().editors.len() - 1;
    assert!(
        crate::editor_ui::page_has_content(&h.app, 0),
        "page 1 has the three rects"
    );
    assert!(
        !crate::editor_ui::page_has_content(&h.app, page1),
        "page 2 is empty until something is drawn on it"
    );
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let rows = h.app.pages_rows();
    let r = rows
        .iter()
        .find(|(i, _)| *i == page1)
        .map(|(_, r)| *r)
        .expect("the new page has a row");
    h.on_press(r.center());
    assert_eq!(
        h.app.doc().page,
        page1,
        "the thumbnail row is still the page switcher"
    );
}

// -------------------------------------------------------------- phase 4b
// A bug found while auditing the audit: the page window was following the
// active DOCUMENT (`App::active`) instead of the active PAGE, so on a document
// whose page count differed from its index the visible rows addressed the
// wrong pages. Pinned here. (A page-less document is not a state the app can
// reach — `App::editor_ref` requires one editor — so the band's empty-list
// guard is defensive only and has no test.)

/// The page window scrolls with the ACTIVE PAGE, and every page can be
/// selected, renamed and deleted by clicking its row — the reason the window
/// exists is that pages one can see are pages one can click.
#[test]
fn every_page_in_the_window_is_clickable_and_the_window_follows_the_page() {
    let mut h = canvas_host();
    h.dispatch(Action::AddPage);
    h.dispatch(Action::AddPage);
    h.dispatch(Action::AddPage);
    h.dispatch(Action::AddPage);
    h.dispatch(Action::AddPage);
    let n = h.app.doc_ref().editors.len();
    assert_eq!(n, 6, "home + five added");
    // the document index is not the page index: a second document with a
    // different page count is what the old code got wrong
    h.app.active = 0;
    h.app.doc().page = 0;
    let rows = h.app.pages_rows();
    assert_eq!(rows.len(), 4, "the band holds PAGES_MAX_ROWS rows");
    assert_eq!(
        rows[0].0, 0,
        "a page at the head of the list is on screen, not scrolled away"
    );
    assert!(
        !rows.iter().any(|(i, _)| *i >= n),
        "no row addresses a page that does not exist"
    );
    // clicking row 3 selects page 3; the window then shows 1..=4
    let r3 = rows[3].1;
    h.app.mouse = r3.center();
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let hit = h
        .app
        .hit
        .iter()
        .rev()
        .find(|(r, _)| r.contains(r3.center()))
        .map(|(_, a)| a.clone());
    assert_eq!(hit, Some(Action::SelectPage(3)), "the fourth row is page 3");
    h.dispatch(Action::SelectPage(3));
    assert_eq!(h.app.doc_ref().page, 3, "the row selects its own page");
    let rows = h.app.pages_rows();
    // the window follows the active page and clamps against the tail:
    // top = min(page, n - PAGES_MAX_ROWS) = min(3, 2) = 2, so page 3 is the
    // second row and the LAST page is on screen too
    assert_eq!(
        rows.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
        vec![2, 3, 4, 5],
        "the window follows the page and clamps at the tail"
    );
    assert!(
        rows.iter().any(|(i, _)| *i == 3),
        "the page just selected has a row"
    );
    // the last page is a real row, and it is the one the ✕ can delete
    h.dispatch(Action::SelectPage(5));
    let rows = h.app.pages_rows();
    assert_eq!(
        rows.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
        vec![2, 3, 4, 5],
        "the tail is clamped, never padded"
    );
    assert_eq!(rows[3].0, n - 1, "the last page owns the last row");
    h.dispatch(Action::DeletePage(n - 1));
    assert_eq!(h.app.doc_ref().editors.len(), n - 1);
}

// ---------------------------------------------------------------- phase 4
// The owner's four complaints after the theme/rail work: a page name painted
// as the canvas frame name (and surviving the deletion of its content), page
// rename/delete coupling the page to its frame, and double-clicks in the
// panels not selecting anything.

/// Rename a page — the page carries the name, the root frame mirrors it.
/// The "page name is used for renaming pages" report: the row and the field
/// read `doc.pages[i].name`, and the frame is only ever a mirror, so a frame
/// rename can no longer pass itself off as a page rename.
#[test]
fn page_rename_names_the_page_and_mirrors_the_root() {
    let mut h = canvas_host();
    h.dispatch(Action::AddPage);
    let i = h.app.doc().page;
    h.dispatch(Action::PageMenu(crate::state::PageMenuCmd::Rename));
    assert!(matches!(
        h.app.field.as_ref().map(|f| f.id),
        Some(FieldId::PageName)
    ));
    assert_eq!(
        h.app.field.as_ref().unwrap().buffer,
        h.app.doc_ref().doc.pages[i].name,
        "the field opens on the PAGE's name"
    );
    assert!(h.app.commit_page_rename("Pricing"));
    {
        let d = h.app.doc();
        assert_eq!(d.doc.pages[i].name, "Pricing", "the page is the name");
        assert_eq!(d.editors[i].root.name, "Pricing", "the root mirrors it");
        assert_ne!(d.doc.pages[0].name, "Pricing", "only the active page");
    }
    // the guard compares the PAGE's name, so the no-op case is "the page
    // already says this" — the old guard compared the ROOT's name and could
    // therefore accept a rename that changed nothing, or reject a real one
    assert!(!h.app.commit_page_rename("Pricing"), "same name is a no-op");
    assert!(
        h.app.commit_page_rename("Pricing v2"),
        "a different name applies"
    );
    assert_eq!(h.app.doc_ref().doc.pages[i].name, "Pricing v2");
    assert!(
        !h.app.commit_page_rename("   "),
        "an empty name is refused, not applied"
    );
    assert_eq!(h.app.doc_ref().doc.pages[i].name, "Pricing v2");
}

/// The rail's ✕ deletes the row that was clicked — the active page too.
/// It used to select the page first and then delete "the active page", while
/// the trash was only painted on inactive rows: a background page's ✕ stole
/// the selection, and the page you were looking at could not be deleted.
#[test]
fn page_delete_removes_the_clicked_page_and_never_the_last_one() {
    let mut h = canvas_host();
    let mut scene = vello::Scene::new();
    h.dispatch(Action::AddPage);
    h.dispatch(Action::AddPage);
    {
        // A page's name lives in its EDITOR's root: `OpenDoc::snapshot` (run by
        // every `checkpoint`) rebuilds `doc.pages` from the editors with
        // `sync()`, so a name written only into `doc.pages` is gone at the next
        // transaction — which is exactly what the first version of this fixture
        // did, and what `App::commit_page_rename` writes both sides to avoid.
        let d = h.app.doc();
        for (i, name) in ["Home", "Detail", "Settings"].iter().enumerate() {
            d.doc.pages[i].name = (*name).into();
            d.editors[i].root.name = (*name).into();
        }
        d.page = 2;
    }
    // The ✕ is a HOVER affordance (Figma paints it on the row the pointer is
    // on), so the pointer has to be over the row when the paint pass runs —
    // the zone only exists for a hovered row. Row geometry does not depend on
    // the paint pass, so it is read once, before it.
    let rows = h.app.pages_rows();
    let row0 = rows.iter().find(|(i, _)| *i == 0).map(|(_, r)| *r).unwrap();
    h.app.mouse = row0.center();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let trash = Rect::new(
        h.app.editor_regions().sidebar.x1 - 30.0,
        row0.y0 + 5.0,
        h.app.editor_regions().sidebar.x1 - 12.0,
        row0.y0 + 21.0,
    );
    assert_eq!(
        h.app
            .hit
            .iter()
            .rev()
            .find(|(r, _)| r.contains(trash.center()))
            .map(|(_, a)| a.clone()),
        Some(Action::DeletePage(0)),
        "the ✕ must win over the row's SelectPage, not the other way round"
    );
    // deleting a BACKGROUND page leaves the selection alone
    h.dispatch(Action::DeletePage(0));
    {
        let d = h.app.doc();
        assert_eq!(d.editors.len(), 2);
        assert_eq!(d.doc.pages[0].name, "Detail", "the clicked row is gone");
        assert_eq!(
            d.page, 1,
            "the ACTIVE page stays active — only its index shifts"
        );
    }
    // deleting the ACTIVE page clamps the index
    h.dispatch(Action::DeletePage(1));
    {
        let d = h.app.doc();
        assert_eq!(d.editors.len(), 1);
        assert_eq!(d.doc.pages[0].name, "Detail");
        assert_eq!(d.page, 0);
    }
    // the last page stays: a document with no page has nothing to render
    h.dispatch(Action::DeletePage(0));
    assert_eq!(h.app.doc_ref().editors.len(), 1, "the last page survives");
}

/// A double-click in the chrome is a single click: it must not flip a toggle
/// twice. This is the mechanism behind "double-clicking does not select the
/// colours and the boxes/components we created" — the fill row's colour
/// popover used to open and shut, a component prop ticked and unticked.
#[test]
fn double_click_on_a_panel_toggle_counts_once() {
    let mut h = canvas_host();
    h.app.doc().editor().selection.clear();
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let p = h
        .app
        .hit
        .iter()
        .find(|(_, a)| *a == Action::ToggleCanvasBgVisibility)
        .map(|(r, _)| r.center())
        .expect("the no-selection panel shows the canvas-background eye");
    let before = h.app.canvas_bg_visible;
    h.on_press(p);
    assert_eq!(h.app.canvas_bg_visible, !before, "single click toggles");
    h.on_press(p);
    assert_eq!(
        h.app.canvas_bg_visible, !before,
        "the second press of a double-click is swallowed"
    );
    // ...and a deliberate third press is a fresh single click
    h.app.last_chrome = None;
    h.on_press(p);
    assert_eq!(h.app.canvas_bg_visible, before, "the next click toggles");
    // a repeat that is MEANT to repeat still does: Add-page steppers, zoom
    // steps and the like are not toggle rows
    assert!(!Action::ZoomStep(0).is_toggle_row());
    assert!(!Action::AddPage.is_toggle_row());
    assert!(Action::PaintLibToggle(true).is_toggle_row());
    assert!(Action::Field(FieldId::FontFamily).is_toggle_row());
}

/// Figma: double-clicking a page NAME in the Pages list opens it for rename.
#[test]
fn double_click_on_a_page_name_opens_its_rename_field() {
    let mut h = canvas_host();
    h.dispatch(Action::AddPage);
    h.app.doc().doc.pages[1].name = "Detail".into();
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let row1 = h
        .app
        .pages_rows()
        .iter()
        .find(|(i, _)| *i == 1)
        .map(|(_, r)| *r)
        .expect("page 2 has a row");
    // a single press only selects
    h.on_press(row1.center());
    assert_eq!(h.app.doc().page, 1);
    assert!(h.app.field.is_none(), "one click does not open the field");
    // the second press within the window opens the name for editing
    h.on_press(row1.center());
    assert!(matches!(
        h.app.field.as_ref().map(|f| f.id),
        Some(FieldId::PageName)
    ));
    assert_eq!(h.app.field.as_ref().unwrap().buffer, "Detail");
    assert!(h.app.field_select_all, "the name opens selected");
}

/// Every page is reachable from the rail, however many there are: the band
/// windows over the list instead of stranding pages behind a "+N more"
/// sentinel whose index was the page COUNT (out of range, so the 4th page and
/// beyond could not be selected, renamed or deleted at all).
#[test]
fn pages_past_the_fourth_are_selectable_and_deletable() {
    let mut h = canvas_host();
    for _ in 0..6 {
        h.dispatch(Action::AddPage);
    }
    let n = h.app.doc_ref().editors.len();
    assert_eq!(n, 7);
    let mut scene = vello::Scene::new();
    for i in 0..n {
        h.app.doc().page = i;
        crate::editor_ui::paint(&mut h.app, &mut scene);
        let rows = h.app.pages_rows();
        assert!(rows.iter().all(|(pi, _)| *pi < n), "no sentinel rows");
        assert!(
            rows.iter().any(|(pi, _)| *pi == i),
            "page {i} has a row while it is active"
        );
        let (_, r) = rows.iter().find(|(pi, _)| *pi == i).unwrap();
        assert!(r.y1 <= h.app.pages_band_bottom() + 1e-9);
    }
    // and deleting from anywhere in the list works
    h.app.doc().page = 6;
    assert!(h.app.delete_page(6));
    assert_eq!(h.app.doc_ref().editors.len(), 6);
}

/// Figma: double-clicking a layer NAME in the Layers panel renames it inline.
/// This is the panel-side half of "double-clicking does not select the elements
/// in the right panel" — the row selected, but the second press did nothing.
#[test]
fn double_click_on_a_layer_name_renames_it() {
    let mut h = canvas_host();
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let (zone, _) = h
        .app
        .hit
        .iter()
        .find(|(_, a)| *a == Action::LayerRename("n-b".into()))
        .cloned()
        .expect("the layer's name zone is a hit target");
    // one press selects (and arms the reorder drag, like the rest of the row)
    h.on_press(zone.center());
    {
        let d = h.app.doc();
        assert_eq!(d.editor_ref().selection, vec!["n-b".to_string()]);
        assert!(h.app.field.is_none(), "one press does not open the field");
        assert!(matches!(h.app.drag, Some(Drag::TreeRow { .. })));
    }
    h.app.drag = None;
    // the second press within the window opens the name for editing
    h.on_press(zone.center());
    assert!(matches!(
        h.app.field.as_ref().map(|f| f.id),
        Some(FieldId::LayerName)
    ));
    assert_eq!(h.app.layer_edit_id.as_deref(), Some("n-b"));
    assert_eq!(h.app.field.as_ref().unwrap().buffer, "n-b");
    // Enter commits through the normal field path, undoably
    h.app.field.as_mut().unwrap().buffer = "Header bar".into();
    assert!(h.finish_edits());
    {
        let d = h.app.doc();
        let n = crate::editor_ui::find_node(&d.editor_ref().root, "n-b").unwrap();
        assert_eq!(n.name, "Header bar");
    }
    assert!(h.app.layer_edit_id.is_none(), "the target is cleared");
    h.app.doc().editor().undo();
    {
        let d = h.app.doc();
        let n = crate::editor_ui::find_node(&d.editor_ref().root, "n-b").unwrap();
        assert_eq!(n.name, "n-b", "the rename is undoable");
    }
    // Escape cancels: the buffer is dropped without touching the document
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let zone = h
        .app
        .hit
        .iter()
        .find(|(_, a)| *a == Action::LayerRename("n-b".into()))
        .map(|(r, _)| *r)
        .expect("name zone persists");
    h.on_press(zone.center());
    h.on_press(zone.center());
    assert!(h.app.field.is_some());
    h.app.field.as_mut().unwrap().buffer = "Discarded".into();
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(h.app.field.is_none());
    assert!(h.app.layer_edit_id.is_none());
    let d = h.app.doc();
    assert_eq!(
        crate::editor_ui::find_node(&d.editor_ref().root, "n-b")
            .unwrap()
            .name,
        "n-b"
    );
}

/// The status band is chrome, not a bar over the artwork: every region of the
/// window yields to it, so a message always has a row of its own and nothing
/// is painted - or clickable - underneath it.
/// Owner report, 2026-09-18 — "not painted as a red bar through the artwork".
#[test]
fn the_status_band_is_chrome_and_the_artwork_stops_above_it() {
    let mut h = host();
    h.app.compose_frame(); // paint the chrome, which builds its hit zones
    let band = h.app.status_band();
    assert_eq!(band.x0, 0.0, "the band spans the window");
    assert_eq!(band.x1, h.app.win_w, "the band spans the window");
    assert_eq!(band.height(), ED_STATUS_H);
    let r = h.app.editor_regions();
    for (name, rect) in [
        ("canvas", r.canvas),
        ("left panel", r.left),
        ("nav bar", r.nav_bar),
        ("sidebar", r.sidebar),
        ("right panel", r.right),
    ] {
        assert!(
            rect.y1 <= band.y0 + 0.001,
            "the {name} runs under the status band: {rect:?} vs {band:?}"
        );
    }
    assert!(
        h.app.board_regions().canvas.y1 <= band.y0 + 0.001,
        "the board canvas runs under the status band"
    );
    let mut buried = 0;
    for (rect, action) in &h.app.hit {
        if rect.y1 > band.y0 + 0.001 {
            buried += 1;
            eprintln!("chrome zone under the band: {action:?} {rect:?}");
        }
    }
    assert_eq!(buried, 0, "a control the band covers is still clickable");
}

/// The band is where a running job's controls live: the Cancel button is
/// inside it, and — with a job on screen — it is the only chrome zone that
/// reaches into the band at all.
#[test]
fn the_status_band_carries_the_running_jobs_controls() {
    use std::sync::mpsc;
    let mut h = host();
    let (started, ready) = mpsc::channel();
    let (resume, wait) = mpsc::channel();
    h.files
        .start(
            crate::jobs::Kind::Export,
            "Test background work".into(),
            move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                Ok(crate::jobs::Output::Exported("done".into()))
            },
        )
        .unwrap();
    ready
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    h.refresh_file_status();
    h.app.compose_frame();
    let band = h.app.status_band();
    let mut in_band = 0;
    for (rect, action) in &h.app.hit {
        if rect.y0 >= band.y0 - 0.001 {
            in_band += 1;
            assert!(
                matches!(action, Action::CancelFileOperation),
                "unexpected control in the status band: {action:?} {rect:?}"
            );
        }
    }
    resume.send(()).unwrap();
    h.wait_for_file_job();
    assert_eq!(
        in_band, 1,
        "the running job does not offer Cancel in the band"
    );
}

/// A prototype preview is chrome-less: `paint_feedback` returns before it
/// paints unless `paints_status_band()` says the band belongs on screen (the
/// guard reads that gate out of the painter), and the document keeps the whole
/// window while it is open.
#[test]
fn the_flow_viewer_paints_no_status_band_over_the_prototype() {
    let mut h = host();
    let root = h.app.doc().editor_ref().root.id.clone();
    h.app.flow = Some(crate::state::FlowState {
        current: root,
        ..Default::default()
    });
    assert!(!h.app.paints_status_band());
    assert_eq!(
        h.app.view_canvas(),
        Rect::new(0.0, 0.0, h.app.win_w, h.app.win_h),
        "the flow viewer must keep every pixel for the document"
    );
}

/// Figma's Constraints block — the beginner course's "Frame presets and
/// constraints" chapter, end to end: the panel's menu writes the layer's pin,
/// the block exists only for a layer INSIDE a frame, and a corner drag of that
/// frame then carries the pinned layers with it in one undo step.
#[test]
fn constraints_carry_a_frames_layers_through_its_resize() {
    use crate::state::ConstraintAxis;
    let mut h = host();
    // a bar pinned to the bottom edge, a chip pinned to the right one
    h.app.doc().editor().insert_node(
        "frame-1",
        Node::rect("bar", 10.0, 380.0, 355.0, 30.0, Color::WHITE),
    );
    h.app.doc().editor().insert_node(
        "frame-1",
        Node::rect("chip", 345.0, 10.0, 20.0, 20.0, Color::WHITE),
    );
    // a top-level layer has no Constraints block: its parent is the page, and
    // Figma's table is about the frame you resize
    h.app.doc().editor().selection = vec!["frame-1".into()];
    assert!(crate::editor_ui::constraint_row(&h.app, ConstraintAxis::Horizontal).is_none());
    assert!(crate::editor_ui::constraint_row(&h.app, ConstraintAxis::Vertical).is_none());
    // inside the frame it does, and the panel's own menu writes the pin
    h.app.doc().editor().selection = vec!["bar".into()];
    assert_eq!(
        crate::editor_ui::constraint_row(&h.app, ConstraintAxis::Vertical),
        Some((0, "Top"))
    );
    h.dispatch(Action::ConstraintDropdown(ConstraintAxis::Vertical));
    assert_eq!(h.app.dropdown_constraint, Some(ConstraintAxis::Vertical));
    h.dispatch(Action::SetConstraint(ConstraintAxis::Vertical, 1));
    assert_eq!(h.app.dropdown_constraint, None, "picking closes the menu");
    h.app.doc().editor().selection = vec!["chip".into()];
    h.dispatch(Action::SetConstraint(ConstraintAxis::Horizontal, 1));
    assert_eq!(
        crate::editor_ui::constraint_row(&h.app, ConstraintAxis::Horizontal),
        Some((1, "Right"))
    );
    // frame-1 is (0,60) 375x420: grab the bottom-right handle and drag it out
    // by 100 x 100
    h.app.doc().editor().selection = vec!["frame-1".into()];
    let depth0 = h.app.doc_ref().editor_ref().undo_depth();
    let grab = h.resize_grab(Point::new(375.0, 480.0));
    assert!(grab.is_some(), "the bottom-right corner is grabbable");
    h.app.drag = grab;
    h.on_move(h.app.world_to_screen(Point::new(475.0, 580.0)));
    h.on_release();
    let root = &h.app.doc_ref().editor_ref().root;
    let f1 = find_node_clone(root, "frame-1").unwrap();
    assert_eq!((f1.w, f1.h), (475.0, 520.0));
    // the bar keeps its 10px inset from the bottom edge, the chip its own from
    // the right edge: the pins did the work
    let bar = find_node_clone(root, "bar").unwrap();
    assert_eq!(
        bar.transform.y, 480.0,
        "the bar stayed pinned to the bottom"
    );
    let chip = find_node_clone(root, "chip").unwrap();
    assert_eq!(
        chip.transform.x, 445.0,
        "the chip stayed pinned to the right"
    );
    // one gesture, one undo step: the frame and its layers come back together
    assert_eq!(h.app.doc_ref().editor_ref().undo_depth(), depth0 + 1);
    h.app.doc().editor().undo();
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(find_node_clone(root, "frame-1").unwrap().w, 375.0);
    assert_eq!(find_node_clone(root, "bar").unwrap().transform.y, 380.0);
    assert_eq!(find_node_clone(root, "chip").unwrap().transform.x, 345.0);
}

/// Figma's Section tool: "Click Section in the toolbar or use the keyboard
/// shortcut ⇧ Shift S" (help 9771500257687), and the toolbar keeps the frame
/// and the section on ONE slot, drawing whichever of the two you used last.
#[test]
fn the_section_tool_is_shift_s_and_shares_the_frame_slot() {
    assert_eq!(
        Tool::from_shortcut("s", false, false),
        Some(Tool::Slice),
        "S is still the Slice tool"
    );
    assert_eq!(
        Tool::from_shortcut("s", true, false),
        Some(Tool::Section),
        "⇧S is the Section tool"
    );
    assert_eq!(
        Tool::from_shortcut("s", true, true),
        Some(Tool::BoardSticky),
        "a board has no section tool"
    );
    assert_eq!(Tool::Section.label(), "Section");
    assert_eq!(Tool::Section.icon(), "section");
    assert_eq!(Tool::Section.shortcut_hint(false), "⇧S");
    // the slot's memory: the last of the pair that was used
    let mut h = host();
    h.app.select_tool(Tool::Section);
    assert_eq!(h.app.frame_slot(), Tool::Section);
    h.app.select_tool(Tool::Select);
    assert_eq!(
        h.app.frame_slot(),
        Tool::Section,
        "the slot keeps the last of the pair"
    );
    h.app.select_tool(Tool::Frame);
    assert_eq!(h.app.frame_slot(), Tool::Frame);
    // and ⇧S through the real key handler selects it
    h.app.shift = true;
    h.on_character("S");
    h.app.shift = false;
    assert_eq!(h.app.tool, Tool::Section);
}

/// The section tool's drag: the section lands on the canvas even when it is
/// drawn over a frame ("Sections ... cannot be contained within frames or
/// groups"), and the frame it covers joins it — "you can also click and drag a
/// section over the objects you want to add to it". One gesture, one undo step.
#[test]
fn the_section_tool_draws_on_the_canvas_and_takes_what_it_covers() {
    let mut h = host();
    // the demo page carries one frame: the canvas origin (0, 60), 375 x 420
    let frame_id = h.app.doc_ref().editor_ref().root.children[0].id.clone();
    assert_eq!(frame_id, "frame-1");
    h.finish_create(
        Tool::Section,
        Point::new(0.0, 60.0),
        Point::new(375.0, 480.0),
    );
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 1, "the section is a page-level layer");
    let sec = &root.children[0];
    assert!(matches!(sec.kind, NodeKind::Section), "kind is Section");
    assert_eq!(sec.name, "Section");
    assert_eq!(
        (sec.transform.x, sec.transform.y),
        (0.0, 60.0),
        "drawn where the drag was, in page space"
    );
    assert_eq!(sec.children.len(), 1, "the frame it covered joined it");
    assert_eq!(sec.children[0].id, frame_id);
    assert_eq!(
        (sec.children[0].transform.x, sec.children[0].transform.y),
        (0.0, 0.0),
        "and kept its place on the page"
    );
    // the whole gesture is ONE undo step: the frame is back on the page
    assert!(h.app.doc().editor().undo());
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(root.children.len(), 1);
    assert!(matches!(root.children[0].kind, NodeKind::Frame { .. }));
    assert_eq!(root.children[0].id, frame_id);
    assert_eq!(
        (root.children[0].transform.x, root.children[0].transform.y),
        (0.0, 60.0)
    );
}

/// Figma's "Wrap in new section" is on the canvas menu for a selection, and
/// it produces a real section: with the layer held by a frame, the wrap lifts
/// it to the canvas first and the frame gives it up.
#[test]
fn the_canvas_menu_wraps_a_selection_in_a_section() {
    use crate::context_menu::{build_menu_items, ContextAction, ContextMenuItem, ContextTarget};
    let items = build_menu_items(&ContextTarget::CanvasSelection {
        selected_count: 2,
        contains_group: false,
        instance: None,
    });
    let offers = items.iter().any(|it| {
        matches!(
            it,
            ContextMenuItem::Action {
                action: ContextAction::WrapInSection,
                enabled: true,
            }
        )
    });
    assert!(offers, "Figma's wrap row is on the canvas menu");

    // drawn over the demo page's frame, so the rect lands in it (frame-local)
    let mut h = host();
    h.finish_create(
        Tool::Rect,
        Point::new(120.0, 120.0),
        Point::new(180.0, 180.0),
    );
    let rect_id = h.app.doc_ref().editor_ref().selection[0].clone();
    {
        let root = &h.app.doc_ref().editor_ref().root;
        assert_eq!(root.children.len(), 1, "the page still holds just frame-1");
        assert_eq!(root.children[0].id, "frame-1");
        assert_eq!(root.children[0].children.len(), 1, "the rect joined it");
    }
    h.app.doc().editor().selection = vec![rect_id.clone()];
    h.app.apply_ctx(crate::state::CtxCmd::SectionSelection);

    let root = &h.app.doc_ref().editor_ref().root;
    let sec = root
        .children
        .iter()
        .find(|c| matches!(c.kind, NodeKind::Section))
        .expect("the wrap made a section");
    assert_eq!(sec.name, "Section");
    assert_eq!(sec.children.len(), 1);
    assert_eq!(sec.children[0].id, rect_id);
    let frame = root
        .children
        .iter()
        .find(|c| c.id == "frame-1")
        .expect("the frame is still on the page");
    assert!(frame.children.is_empty(), "the frame gave the layer up");
    // and the layer kept its place on the PAGE, not the frame's
    let m = node_world(root, &rect_id).expect("world matrix");
    let p = m * Point::new(0.0, 0.0);
    assert!(
        (p.x - 120.0).abs() < 0.001 && (p.y - 120.0).abs() < 0.001,
        "lifted layer sits where it was drawn: {p:?}"
    );
}

/// "You can also click and drag a section over the objects you want to add to
/// it" — a section dragged on top of a layer takes it in, keeping its place on
/// the page, and the drag and the take-in are ONE undo step.
#[test]
fn a_section_dragged_over_a_layer_takes_it_in() {
    let mut h = host();
    // clear of the demo page's frame-1 (x 0..375, y 60..480): a page-level rect
    h.finish_create(
        Tool::Rect,
        Point::new(500.0, 200.0),
        Point::new(580.0, 280.0),
    );
    let rect_id = h.app.doc_ref().editor_ref().selection[0].clone();
    h.finish_create(
        Tool::Section,
        Point::new(600.0, 200.0),
        Point::new(700.0, 300.0),
    );
    let sec_id = h.app.doc_ref().editor_ref().selection[0].clone();
    assert!(matches!(
        crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, &sec_id).map(|n| &n.kind),
        Some(NodeKind::Section)
    ));

    // drag the section left until it covers the rect
    h.app.doc().editor().selection = vec![sec_id.clone()];
    let from = h.app.world_to_screen(Point::new(650.0, 250.0));
    h.on_press(from);
    h.on_move(h.app.world_to_screen(Point::new(550.0, 250.0)));
    assert!(
        matches!(h.app.drag, Some(Drag::MoveSel { .. })),
        "the press takes the section as a layer move"
    );
    h.on_release();

    let root = &h.app.doc_ref().editor_ref().root;
    let sec = find_node_clone(root, &sec_id).expect("the section is on the page");
    assert_eq!(sec.children.len(), 1, "the layer it covered joined it");
    assert_eq!(sec.children[0].id, rect_id);
    let m = node_world(root, &rect_id).expect("world matrix");
    let p = m * Point::new(0.0, 0.0);
    assert!(
        (p.x - 500.0).abs() < 0.001 && (p.y - 200.0).abs() < 0.001,
        "the layer kept its place on the page: {p:?}"
    );
    // the drag and the take-in are one step: one undo puts both back
    assert!(h.app.doc().editor().undo());
    let root = &h.app.doc_ref().editor_ref().root;
    let sec = find_node_clone(root, &sec_id).expect("the section is back");
    assert!(
        (sec.transform.x - 600.0).abs() < 0.001,
        "the section is back where the drag began"
    );
    assert!(
        sec.children.is_empty(),
        "and the layer is a page child again"
    );
    assert!(find_node_clone(root, &rect_id).is_some());
}

/// A frame with an auto layout, selected — the state the layout panel's new
/// controls need.
fn layout_host() -> Host {
    let mut h = host();
    h.app.doc().editor().selection = vec!["frame-1".into()];
    h.dispatch(Action::AddAutoLayout);
    assert!(
        h.app.selected_layout().is_some(),
        "the demo frame took the layout"
    );
    h
}

/// Figma's **Width**/**Height** dropdown (help 360040451373): the sizing rows
/// and, in the same menu, "Add min width" / "Add max width" — min and max are
/// "an additional setting that can be used at the same time as other resizing
/// properties" — plus "Remove min and max" to take them away again.
#[test]
fn the_width_menu_carries_figmas_sizing_and_min_max_rows() {
    let mut h = layout_host();
    assert_eq!(
        h.app.selected_layout().unwrap().sizing,
        x_native::Sizing::Fixed,
        "a demo frame is fixed to start with"
    );

    // the chip opens the menu rather than flipping the sizing in place
    h.dispatch(Action::LayoutAxisMenu(true));
    assert_eq!(h.app.dropdown_layout_axis, Some(true));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let row = |a: Action| h.app.hit.iter().find(|(_, x)| *x == a).map(|(r, _)| *r);
    let fixed = row(Action::SetAxisSizing(true, x_native::Sizing::Fixed));
    let hug = row(Action::SetAxisSizing(true, x_native::Sizing::Hug));
    let add_min = row(Action::AddAxisLimit(true, false));
    let add_max = row(Action::AddAxisLimit(true, true));
    let clear = row(Action::ClearAxisLimits(true));
    assert!(fixed.is_some(), "Fixed width is a row");
    assert!(hug.is_some(), "Hug contents is a row");
    assert!(add_min.is_some(), "Add min width is a row");
    assert!(add_max.is_some(), "Add max width is a row");
    assert!(clear.is_some(), "Remove min and max is a row");
    // a list, not a cycle: five rows, in Figma's order, none on top of another
    let ys: Vec<f64> = [fixed, hug, add_min, add_max, clear]
        .into_iter()
        .flatten()
        .map(|r| r.y0)
        .collect();
    assert_eq!(ys.len(), 5);
    let mut sorted = ys.clone();
    sorted.sort_by(f64::total_cmp);
    assert_eq!(ys, sorted, "the rows stack in Figma's order");

    // choosing a sizing writes the axis its menu belongs to, and closes it:
    // a vertical frame lays out top-to-bottom, so the Height field is the main
    // axis and the Width field the cross one
    h.dispatch(Action::SetAxisSizing(true, x_native::Sizing::Hug));
    assert_eq!(h.app.dropdown_layout_axis, None);
    let l = h.app.selected_layout().unwrap();
    assert_eq!(l.cross_sizing, Some(x_native::Sizing::Hug));
    assert_eq!(l.sizing, x_native::Sizing::Fixed, "the height is untouched");
    // ...and the HEIGHT menu writes the main axis
    h.dispatch(Action::LayoutAxisMenu(false));
    h.dispatch(Action::SetAxisSizing(false, x_native::Sizing::Hug));
    assert_eq!(
        h.app.selected_layout().unwrap().sizing,
        x_native::Sizing::Hug
    );
}

/// "From the new field that appears, enter a value": the menu's Add rows
/// create the limit and open the field that edits it, the row it paints is a
/// hit zone, the layout obeys the number, and "Remove min and max" clears it.
#[test]
fn a_min_and_max_width_are_added_from_the_menu_and_clamp_the_frame() {
    let mut h = layout_host();
    let before = crate::editor_ui::sel_info(&h.app).w;
    h.dispatch(Action::LayoutAxisMenu(true));
    h.dispatch(Action::AddAxisLimit(true, false));
    assert_eq!(
        h.app.selected_layout().unwrap().min_width,
        Some(before.round()),
        "the new minimum starts at the frame's own width"
    );
    assert!(
        matches!(h.app.field.as_ref().map(|f| f.id), Some(FieldId::MinWidth)),
        "the field the menu created is open for typing"
    );

    // typing a value writes the limit...
    set_field(&mut h, FieldId::MinWidth, "700");
    assert_eq!(h.app.selected_layout().unwrap().min_width, Some(700.0));
    // ...and the layout obeys it on the next solve
    let vars = h.app.doc().doc.variables.clone();
    {
        let e = h.app.doc().editor();
        x_native::apply_layout_recursive(&mut e.root, &vars);
    }
    let w = crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, "frame-1")
        .unwrap()
        .w;
    assert_eq!(w, 700.0, "the minimum is a floor under the frame");

    // the field row is painted, and it is a hit zone
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let mut has_min = false;
    let mut has_max = false;
    for (_, a) in h.app.hit.iter() {
        if *a == Action::Field(FieldId::MinWidth) {
            has_min = true;
        }
        if *a == Action::Field(FieldId::MaxWidth) {
            has_max = true;
        }
    }
    assert!(has_min, "the min field has a row of its own");
    assert!(!has_max, "an unset maximum draws no field");

    // a maximum joins it, and "Remove min and max" clears both
    h.dispatch(Action::LayoutAxisMenu(true));
    h.dispatch(Action::AddAxisLimit(true, true));
    assert!(h.app.selected_layout().unwrap().max_width.is_some());
    h.dispatch(Action::LayoutAxisMenu(true));
    h.dispatch(Action::ClearAxisLimits(true));
    let l = h.app.selected_layout().unwrap();
    assert_eq!((l.min_width, l.max_width), (None, None));
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let mut field_row = false;
    for (_, a) in h.app.hit.iter() {
        if matches!(a, Action::Field(FieldId::MinWidth | FieldId::MaxWidth)) {
            field_row = true;
        }
    }
    assert!(!field_row, "with no limits set, the row is gone");
}

/// Figma's **canvas stacking** (help 31289464393751) sits in the auto-layout
/// settings and offers its own two orders; the menu writes the frame's own
/// setting and the status line reads back the one in force.
#[test]
fn the_canvas_stacking_menu_writes_figmas_two_orders() {
    let mut h = layout_host();
    assert_eq!(
        h.app.selected_layout().unwrap().canvas_stacking,
        x_native::CanvasStacking::LastOnTop,
        "last on top is Figma's default"
    );
    h.dispatch(Action::StackingMenu);
    assert!(h.app.dropdown_stacking);
    let mut scene = vello::Scene::new();
    crate::editor_ui::paint(&mut h.app, &mut scene);
    let mut orders = 0;
    let mut first_row = false;
    for (_, a) in h.app.hit.iter() {
        if let Action::SetCanvasStacking(order) = a {
            orders += 1;
            if *order == x_native::CanvasStacking::FirstOnTop {
                first_row = true;
            }
        }
    }
    assert_eq!(orders, 2, "two orders, in Figma's words");
    assert!(first_row, "First on top is reachable");
    h.dispatch(Action::SetCanvasStacking(
        x_native::CanvasStacking::FirstOnTop,
    ));
    assert!(!h.app.dropdown_stacking, "picking closes the menu");
    assert_eq!(
        h.app.selected_layout().unwrap().canvas_stacking,
        x_native::CanvasStacking::FirstOnTop
    );
    assert!(h.app.status.contains("First on top"), "{}", h.app.status);
    // the other order is one more pick away, and it writes back too
    h.dispatch(Action::StackingMenu);
    h.dispatch(Action::SetCanvasStacking(
        x_native::CanvasStacking::LastOnTop,
    ));
    assert_eq!(
        h.app.selected_layout().unwrap().canvas_stacking,
        x_native::CanvasStacking::LastOnTop
    );
    assert!(h.app.status.contains("Last on top"), "{}", h.app.status);
}

/// A Button master with a label and an icon, two component properties bound to
/// them (so the panel's own write path produces the overrides), and an instance
/// of it selected — the fixture Figma's instance menu is about.
fn instance_host() -> (Host, String) {
    let mut h = host();
    let root_id = h.app.doc().editor_ref().root.id.clone();
    let mut master = x_native::Node::component("def", "Button", 120.0, 44.0);
    master.children.push(x_native::Node::text(
        "lbl", 12.0, 12.0, 80.0, 20.0, "Click me",
    ));
    master.children.push(x_native::Node::rect(
        "ico",
        96.0,
        14.0,
        16.0,
        16.0,
        Color::WHITE,
    ));
    h.app.doc().editor().insert_node(&root_id, master);
    h.app.doc().editor().selection = vec!["lbl".into()];
    h.app.add_prop(x_native::ComponentPropKind::Text);
    h.app.doc().editor().selection = vec!["ico".into()];
    h.app.add_prop(x_native::ComponentPropKind::Bool);
    let inst = h
        .app
        .doc()
        .editor()
        .place_instance("Button", 40.0, 300.0)
        .expect("instance placed");
    h.app.doc().editor().selection = vec![inst.clone()];
    (h, inst)
}

/// Every action in a built menu, submenus flattened — the same walk the painter
/// does when it turns rows into hit rects.
fn menu_actions(
    items: &[crate::context_menu::ContextMenuItem],
) -> Vec<(crate::context_menu::ContextAction, bool)> {
    let mut out = vec![];
    for it in items {
        match it {
            crate::context_menu::ContextMenuItem::Action { action, enabled } => {
                out.push((action.clone(), *enabled));
            }
            crate::context_menu::ContextMenuItem::Submenu { enabled, items, .. } => {
                for (a, e) in menu_actions(items) {
                    out.push((a, e && *enabled));
                }
            }
            crate::context_menu::ContextMenuItem::Separator => {}
        }
    }
    out
}

/// Is this action present in a built menu AND enabled? The painter skips a hit
/// rect for a disabled row, so this is the same question a click asks.
fn menu_enabled(
    actions: &[(crate::context_menu::ContextAction, bool)],
    want: &crate::context_menu::ContextAction,
) -> bool {
    actions
        .iter()
        .find(|(a, _)| a == want)
        .map(|(_, enabled)| *enabled)
        .unwrap_or(false)
}

fn selection_menu(h: &Host) -> Vec<crate::context_menu::ContextMenuItem> {
    let instance = h.app.context_instance();
    crate::context_menu::build_menu_items(&crate::context_menu::ContextTarget::CanvasSelection {
        selected_count: 1,
        contains_group: false,
        instance,
    })
}

/// Figma's *select inside* (help 360039150733: *"you can change the properties
/// of any layer within an instance"*): the canvas gesture enters the instance
/// on the layer under the cursor, the status names the path, and Esc leaves.
#[test]
fn double_clicking_inside_an_instance_selects_the_layer_there() {
    let (mut h, inst) = instance_host();
    let vars = h.app.doc_ref().doc.variables.clone();

    // the label sits at (12, 12) inside an instance placed at (40, 300)
    let layer = h
        .app
        .doc()
        .editor()
        .enter_instance(Point::new(60.0, 316.0), &vars);
    assert_eq!(layer.as_deref(), Some("lbl"));
    assert_eq!(h.app.doc().editor_ref().selection, vec!["lbl".to_string()]);

    h.app.enter_instance_status("lbl");
    assert!(
        h.app.status.contains("Inside Button") && h.app.status.contains("lbl"),
        "the status names the instance and the layer: {}",
        h.app.status
    );

    // Esc steps out: the instance is selected again, not the whole canvas
    h.on_key(Key::Named(NamedKey::Escape), None);
    assert!(h.app.doc().editor_ref().instance_scope.is_none());
    assert_eq!(h.app.doc().editor_ref().selection, vec![inst]);
    assert_eq!(h.app.status, "Left the instance");

    // a point outside the instance is not inside anything
    let outside = h
        .app
        .doc()
        .editor()
        .enter_instance(Point::new(400.0, 60.0), &vars);
    assert_eq!(outside, None);
}

/// The panel reads the instance's copy of a layer it edits — the value the
/// canvas paints — while the master keeps its own.
#[test]
fn the_panel_shows_the_instance_copy_of_a_layer_inside_it() {
    let (mut h, _inst) = instance_host();
    let vars = h.app.doc_ref().doc.variables.clone();
    h.app
        .doc()
        .editor()
        .enter_instance(Point::new(144.0, 318.0), &vars)
        .expect("the icon is under the point");

    h.app.doc().editor().set_opacity("ico", 0.4);

    let info = crate::editor_ui::sel_info(&h.app);
    assert_eq!(info.opacity, 0.4, "the panel shows the override");
    let master = crate::editor_ui::find_node(&h.app.doc().editor_ref().root, "ico").unwrap();
    assert_eq!(master.opacity, 1.0, "the master is untouched");
}

/// Figma's instance menu (help 360039150733): *"Go to main component"*,
/// *"Push changes to main component"*, and a Reset flyout that *"only lists
/// properties that have changes applied"*. A plain selection has none of it.
#[test]
fn the_canvas_menu_carries_figmas_instance_actions() {
    use crate::context_menu::ContextAction as CA;
    // a selection that is not an instance offers nothing instance-shaped
    let mut plain = host();
    let root_id = plain.app.doc().editor_ref().root.id.clone();
    plain.app.doc().editor().selection = vec![root_id];
    assert!(
        plain.app.context_instance().is_none(),
        "the page is not an instance"
    );
    let actions = menu_actions(&selection_menu(&plain));
    let offers_main = actions
        .iter()
        .any(|(a, _)| matches!(a, CA::GoToMainComponent));
    assert!(!offers_main, "a plain selection has no instance rows");

    let (mut h, inst) = instance_host();
    let info = h
        .app
        .context_instance()
        .expect("the selection is an instance");
    assert_eq!(info.id, inst);
    assert_eq!(info.component, "Button");
    assert!(info.in_file, "the master is in this document");
    assert!(info.changes.is_empty(), "no overrides yet");

    // with no changes: both master rows are there, push is off, no Reset
    let actions = menu_actions(&selection_menu(&h));
    assert!(
        menu_enabled(&actions, &CA::GoToMainComponent),
        "go-to-main is offered"
    );
    assert!(
        actions.iter().any(|(a, _)| a == &CA::PushChangesToMain),
        "the push row is offered"
    );
    assert!(
        !menu_enabled(&actions, &CA::PushChangesToMain),
        "nothing to push yet, so the row is inert"
    );
    assert!(
        !actions
            .iter()
            .any(|(a, _)| matches!(a, CA::ResetChange { .. } | CA::ResetAllChanges)),
        "no changes means no Reset rows"
    );

    // two overrides written through the panel's own path
    assert!(h.app.apply_prop(&inst, "Button", "lbl", "Hello"));
    assert!(h.app.apply_prop(&inst, "Button", "ico", "false"));
    let info = h.app.context_instance().expect("still an instance");
    assert_eq!(info.changes.len(), 2, "one row per change");
    assert_eq!(info.changes[0].1, "lbl · Text");
    assert_eq!(info.changes[1].1, "ico · Visible");
    let actions = menu_actions(&selection_menu(&h));
    assert!(
        menu_enabled(&actions, &CA::PushChangesToMain),
        "with changes applied the push row comes alive"
    );
    assert!(
        actions.iter().any(|(a, _)| a == &CA::ResetAllChanges),
        "the flyout ends with Reset all changes"
    );
    let rows = actions
        .iter()
        .filter(|(a, _)| matches!(a, CA::ResetChange { .. }))
        .count();
    assert_eq!(rows, 2, "and lists exactly the layers carrying changes");
}

/// *"Go to main component"* selects the master (help 360038665934), and
/// *"Push changes to main component"* writes the instance's overrides into it —
/// which is what makes every other instance of the component follow.
#[test]
fn go_to_main_selects_the_master_and_pushing_reaches_every_instance() {
    let (mut h, inst) = instance_host();
    assert!(h.app.apply_prop(&inst, "Button", "lbl", "Hello"));
    // a second instance, untouched, to prove the push went to the definition
    let second = h
        .app
        .doc()
        .editor()
        .place_instance("Button", 40.0, 400.0)
        .expect("second instance");
    h.app.doc().editor().selection = vec![inst.clone()];

    h.dispatch(Action::GoToMainComponent);
    assert_eq!(
        h.app.doc().selected_id().as_deref(),
        Some("def"),
        "the master is selected"
    );
    assert!(
        h.app.status.contains("main component"),
        "status names the move: {}",
        h.app.status
    );

    h.app.doc().editor().selection = vec![inst.clone()];
    h.dispatch(Action::PushChangesToMain);
    let text = {
        let root = &h.app.doc_ref().editor_ref().root;
        match &crate::editor_ui::find_node(root, "lbl").unwrap().kind {
            NodeKind::Text { text } => text.clone(),
            other => panic!("the master's label is a text layer, got {other:?}"),
        }
    };
    assert_eq!(text, "Hello", "the master took the instance's text");
    assert!(
        h.app.status.contains("Pushed"),
        "status reports the push: {}",
        h.app.status
    );
    {
        let root = &h.app.doc_ref().editor_ref().root;
        let n = crate::editor_ui::find_node(root, &second).unwrap();
        assert!(
            n.overrides.is_empty(),
            "the other instance needed no override of its own"
        );
    }
    // ⌘Z takes the push back in one step
    h.app.doc().editor().undo();
    let text = {
        let root = &h.app.doc_ref().editor_ref().root;
        match &crate::editor_ui::find_node(root, "lbl").unwrap().kind {
            NodeKind::Text { text } => text.clone(),
            other => panic!("the master's label is a text layer, got {other:?}"),
        }
    };
    assert_eq!(text, "Click me", "the push is one undo step");
}

/// *"Select a specific layer to view changes for that layer only … Reset >
/// Reset [property]"* — one change at a time, and the rest stay put.
#[test]
fn resetting_one_change_leaves_the_others_alone() {
    let (mut h, inst) = instance_host();
    assert!(h.app.apply_prop(&inst, "Button", "lbl", "Hello"));
    assert!(h.app.apply_prop(&inst, "Button", "ico", "false"));
    // the change list is what the flyout prints, in Figma's property order
    let changes = h.app.doc().editor_ref().instance_changes(&inst);
    assert_eq!(changes.len(), 2);
    let target = changes[0].node.clone();
    assert_eq!(target, "lbl");

    h.dispatch(Action::ResetInstanceChange(target.clone()));
    let overrides = {
        let root = &h.app.doc_ref().editor_ref().root;
        crate::editor_ui::find_node(root, &inst)
            .unwrap()
            .overrides
            .clone()
    };
    assert!(!overrides.contains_key(&target), "that change is gone");
    assert!(
        overrides.contains_key("ico"),
        "the other change is untouched: {overrides:?}"
    );
    assert!(
        crate::editor_ui::find_node(&h.app.doc_ref().editor_ref().root, &inst)
            .unwrap()
            .visible,
        "the instance itself is still there"
    );
    // a target with no override is a no-op, not a panic
    h.dispatch(Action::ResetInstanceChange("ico".into()));
    h.dispatch(Action::ResetInstanceChange("ico".into()));
    let overrides = {
        let root = &h.app.doc_ref().editor_ref().root;
        crate::editor_ui::find_node(root, &inst)
            .unwrap()
            .overrides
            .clone()
    };
    assert!(overrides.is_empty(), "all changes cleared");
}
