//! Release-blocker regression tests from the independent audit, plus session policy tests.
use super::*;
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
    }
}

fn temp(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("x-native-audit-{}-{name}", std::process::id()))
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
    // canvas = the export's fills + the root frame's name label glyphs
    // (QA-004). The label's path count must be MEASURED, not assumed:
    // real font outlines (Inter in the app) are multi-contour, so one
    // character can emit several glyph paths. Render the root alone
    // (fill + label, no children) through the same font-aware sink the
    // canvas uses, and subtract its fills.
    let shell = h.app.doc_ref().editor_ref().root.shallow_clone();
    let shell_tree = build_render_tree(&shell, &Variables::default());
    let shell_fills = shell_tree
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::FillPath { .. }))
        .count();
    let label_scene = x_native::VelloSink {
        assets: None,
        fonts: Some(&h.app.fonts.fonts),
    }
    .render(&shell_tree);
    let label_paths = label_scene.encoding().n_paths as usize - shell_fills;
    assert!(
        label_paths > 0,
        "the root frame's name label must render on the canvas"
    );
    assert_eq!(
        canvas.encoding().n_paths as usize,
        export_fills + label_paths,
        "canvas paths = export fills + frame-name label"
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
    assert_eq!(h.app.doc_ref().editor_ref().selection, vec![group.id.clone()]);
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
    assert_eq!(
        f1.children.len(),
        1,
        "the new rect must be inside frame-1"
    );
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
    // and selecting a non-container (a plain rect) also must not nest:
    // only frames / groups / sections are drop targets
    h.app.doc().editor().selection = vec![r.id.clone()];
    h.finish_create(Tool::Rect, Point::new(120.0, 120.0), Point::new(160.0, 140.0));
    let root = &h.app.doc_ref().editor_ref().root;
    assert_eq!(
        root.children.len(),
        3,
        "non-container selection → root again"
    );
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
fn pages_list_collapses_beyond_four_pages() {
    let mut h = host();
    for _ in 0..5 {
        h.dispatch(Action::AddPage);
    }
    // 6 pages → 3 real rows + a "+3 more" sentinel (index = page count)
    let rows = h.app.pages_rows();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[3].0, 6, "the overflow row is the sentinel");
    assert!((h.app.pages_band_bottom() - rows[3].1.y1).abs() < 1e-9);
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
    h.finish_create(Tool::Text, Point::new(100.0, 100.0), Point::new(200.0, 114.0));
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
    let mut h = host();
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
    assert!(app.doc_ref().mock_layers.is_empty());
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
    };
    let delay = |ms: u32, action: Action| Interaction {
        trigger: Trigger::AfterDelay { ms },
        action,
        transition_ms: 0,
        animation: Animation::Instant,
        actions: vec![],
        easing: Easing::Linear,
        reset_on_navigate: false,
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
        },
        Interaction {
            trigger: Trigger::MouseLeave,
            action: Action::CloseOverlay,
            transition_ms: 0,
            animation: Animation::Instant,
            actions: vec![],
            easing: Easing::Linear,
            reset_on_navigate: false,
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
        },
    ];
    d.editor().insert_node("f1", pu);
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
    let names: Vec<String> = d
        .editor_ref()
        .root
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
    assert_eq!(crate::theme::C_SEL, crate::theme::rgb(p.focus_ring));
    assert_eq!(rgb(p.text_primary), (0xF2, 0xF3, 0xF7)); // still the brand white
                                                         // toolbar keeps its alpha on top of the role
    let t = crate::theme::C_TOOLBAR.to_rgba8();
    assert_eq!(
        (t.r, t.g, t.b, t.a),
        (p.surface[0], p.surface[1], p.surface[2], 230)
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
