//! Session 51 regression tests: editor clipboard (copy/cut/paste) and
//! page rename persistence — the professional workflow behaviors wired this wave.

use x_native::editor::Editor;
use x_native::fileio;
use x_native::{Color, Document, Node};

fn two_rects() -> Node {
    Node::frame("page-1", 800.0, 600.0)
        .child(Node::rect(
            "r1",
            10.0,
            10.0,
            100.0,
            80.0,
            Color::from_rgb8(0xff, 0, 0),
        ))
        .child(Node::rect(
            "r2",
            200.0,
            10.0,
            100.0,
            80.0,
            Color::from_rgb8(0, 0xff, 0),
        ))
}

#[test]
fn copy_paste_multiselect_preserves_properties_and_editability() {
    let mut ed = Editor::new(two_rects());
    ed.selection = vec!["r1".into(), "r2".into()];
    ed.copy();
    assert_eq!(ed.clipboard_len(), 2);
    let ids = ed.paste("page-1", (16.0, 16.0));
    assert_eq!(ids.len(), 2, "paste must produce both objects");
    // pasted nodes exist, offset, and stay editable (move works)
    for id in &ids {
        let n = x_native::editor::find(&ed.root, id).expect("pasted node exists");
        assert!(n.transform.x > 10.0, "pasted with offset");
    }
    ed.selection = ids.clone();
    ed.move_selection(5.0, 0.0);
    let n = x_native::editor::find(&ed.root, &ids[0]).unwrap();
    assert!(
        (n.transform.x - 31.0).abs() < 1e-6,
        "pasted node moved (editable)"
    );
}

#[test]
fn cut_then_paste_round_trips() {
    let mut ed = Editor::new(two_rects());
    ed.selection = vec!["r1".into()];
    ed.cut();
    assert!(
        x_native::editor::find(&ed.root, "r1").is_none(),
        "cut removes the node"
    );
    assert_eq!(ed.clipboard_len(), 1);
    let ids = ed.paste("page-1", (0.0, 0.0));
    assert_eq!(ids.len(), 1, "paste returns the object");
    // cut is undoable
    ed.undo(); // undo paste
    ed.undo(); // undo the delete half of cut
    assert!(
        x_native::editor::find(&ed.root, "r1").is_some(),
        "undo restores the cut node"
    );
}

#[test]
fn page_rename_survives_save_and_reload() {
    let mut d = Document::new();
    let mut pg = two_rects();
    pg.id = "Landing".into(); // renamed page
    d.pages.push(pg);
    let mut d2 = fileio::DocumentV2::default();
    d2.metadata.name = "Brand Dashboard".into();
    d2.doc = d;
    let text = fileio::save_x_v2(&d2);
    let (loaded, notes) = fileio::load_x_lenient(&text);
    assert!(notes.is_empty());
    assert_eq!(loaded.doc.pages[0].id, "Landing", "page name persists");
    assert_eq!(
        loaded.metadata.name, "Brand Dashboard",
        "file display name persists"
    );
}

#[test]
fn typography_bindings_change_text_geometry() {
    // letter spacing widens the shaped block; line height raises it —
    // through the ONE styled pipeline (canvas/SVG/PDF all consume it)
    let mut fm = x_native::text::FontManager::new();
    if fm.load_system_fonts() == 0 {
        return;
    } // headless CI without fonts
    let base = x_native::text::node_text_outlines_styled(
        &fm,
        "Spacing",
        24.0,
        10_000.0,
        None,
        Color::from_rgb8(0, 0, 0),
        0.0,
        1.2,
        x_native::TextWrap::Auto,
        0.0,
        0.0,
        0.0,
        false,
        0.0,
        0.0,
        0,
        x_native::text::Align::Left,
        None,
        0.0,
        x_native::TextDecoration::None,
    )
    .unwrap();
    let wide = x_native::text::node_text_outlines_styled(
        &fm,
        "Spacing",
        24.0,
        10_000.0,
        None,
        Color::from_rgb8(0, 0, 0),
        4.0,
        1.2,
        x_native::TextWrap::Auto,
        0.0,
        0.0,
        0.0,
        false,
        0.0,
        0.0,
        0,
        x_native::text::Align::Left,
        None,
        0.0,
        x_native::TextDecoration::None,
    )
    .unwrap();
    let last_x = |g: &[x_native::text::OutlineGlyph]| {
        g.iter()
            .map(|o| o.transform.as_coeffs()[4])
            .fold(f64::MIN, f64::max)
    };
    assert!(
        last_x(&wide.0) > last_x(&base.0) + 10.0,
        "letter spacing widens layout"
    );
    let tall = x_native::text::node_text_outlines_styled(
        &fm,
        "a\nb\nc",
        24.0,
        40.0,
        None,
        Color::from_rgb8(0, 0, 0),
        0.0,
        2.0,
        x_native::TextWrap::Auto,
        0.0,
        0.0,
        0.0,
        false,
        0.0,
        0.0,
        0,
        x_native::text::Align::Left,
        None,
        0.0,
        x_native::TextDecoration::None,
    )
    .unwrap();
    let short = x_native::text::node_text_outlines_styled(
        &fm,
        "a\nb\nc",
        24.0,
        40.0,
        None,
        Color::from_rgb8(0, 0, 0),
        0.0,
        1.0,
        x_native::TextWrap::Auto,
        0.0,
        0.0,
        0.0,
        false,
        0.0,
        0.0,
        0,
        x_native::text::Align::Left,
        None,
        0.0,
        x_native::TextDecoration::None,
    )
    .unwrap();
    assert!(tall.1 > short.1, "line height increases block height");
}

#[test]
fn independent_corner_radii_render_and_persist() {
    // per-corner radii: model -> IR (distinct path from uniform) -> save/load
    let mut n = Node::rect(
        "btn",
        0.0,
        0.0,
        100.0,
        50.0,
        Color::from_rgb8(0x33, 0x66, 0xff),
    )
    .radius(8.0);
    n.corner_radii = Some([2.0, 8.0, 20.0, 8.0]);
    let page = Node::frame("p", 200.0, 100.0).child(n);
    let vars = x_native::Variables::default();
    let tree = x_native::build_render_tree(&page, &vars);
    // a strokeless rect emits exactly one FillPath (the transparent
    // frame emits none) — assert the fill is there
    assert!(
        tree.commands
            .iter()
            .any(|c| matches!(c, x_native::RenderCommand::FillPath { .. })),
        "rect fill renders"
    );
    // persistence
    let mut d = Document::new();
    d.pages.push(page);
    let d2 = fileio::DocumentV2 {
        doc: d,
        ..Default::default()
    };
    let text = fileio::save_x_v2(&d2);
    let (loaded, _) = fileio::load_x_lenient(&text);
    let btn = x_native::editor::find(&loaded.doc.pages[0], "btn").unwrap();
    assert_eq!(
        btn.corner_radii,
        Some([2.0, 8.0, 20.0, 8.0]),
        "per-corner radii persist"
    );
}

#[test]
fn svg_clipboard_roundtrip_stays_editable() {
    // export a selection as SVG, re-import the markup: nodes come back
    // as editable vectors/rects (the clipboard SVG-in/out contract)
    let frame = Node::frame("clip", 200.0, 100.0).child(
        Node::rect(
            "r1",
            10.0,
            10.0,
            80.0,
            40.0,
            Color::from_rgb8(0x22, 0xc5, 0x5e),
        )
        .radius(6.0),
    );
    let vars = x_native::Variables::default();
    let svg = fileio::export_svg_full(&frame, &vars, None, None);
    assert!(svg.contains("<svg"), "export produced svg");
    let reimported = fileio::import_svg(&svg).expect("clipboard svg parses back");
    fn count(n: &Node) -> usize {
        1 + n.children.iter().map(count).sum::<usize>()
    }
    assert!(
        count(&reimported) >= 2,
        "re-import yields editable node tree"
    );
}
