//! Native text outlining keeps shaping in x-text, vector structure/history in
//! x-editor, and does not fall back to a browser glyph rasterizer.

use x_native::editor::Editor;
use x_native::text::FontManager;
use x_native::{
    outline_text_glyph_layers, outline_text_glyph_nodes, Color, Node, NodeKind, Paint, Variables,
};

fn fonts() -> FontManager {
    let mut fonts = FontManager::new();
    assert!(fonts.load_system_fonts() > 0, "system fonts required");
    fonts
}

#[test]
fn text_outlines_to_ordered_editable_glyph_vectors() {
    let fonts = fonts();
    let mut text = Node::text("title", 25.0, 35.0, 200.0, 48.0, "Hi i");
    text.name = "Headline".into();
    text.fill = Paint::Solid(Color::from_rgb8(0x12, 0x34, 0x56));
    text.opacity = 0.72;
    text.transform.rotation = 0.2;
    text.transform.origin_x = 0.25;
    text.transform.origin_y = 0.75;

    let glyphs = outline_text_glyph_nodes(&text, &fonts, &Variables::default()).expect("glyph paths");
    // The space advances but has no outline; H, i and i each remain editable
    // groups (the dot and stem of each i stay in the same vector node).
    assert_eq!(glyphs.len(), 3);
    let mut ids = std::collections::HashSet::new();
    for (index, glyph) in glyphs.iter().enumerate() {
        assert!(ids.insert(&glyph.id), "fresh vector IDs");
        assert_eq!(glyph.name, format!("Headline glyph {}", index + 1));
        assert_eq!(glyph.opacity, 0.72);
        assert!(matches!(&glyph.kind, NodeKind::Vector { path } if !path.is_empty()));
        assert_eq!(glyph.fill, text.fill, "plain text retains cloned paint");
        assert!(glyph.text_runs.is_empty(), "no stale editable text runs");
    }
}

#[test]
fn glyph_outline_replaces_one_sibling_slot_with_one_undo_entry() {
    let fonts = fonts();
    let before = Node::rect("before", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
    let text = Node::text("title", 20.0, 10.0, 180.0, 40.0, "Hi");
    let after = Node::rect("after", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
    let mut editor = Editor::new(Node::frame("page", 300.0, 100.0).child(before).child(text).child(after));

    let ids = outline_text_glyph_layers(&mut editor, "title", &fonts, &Variables::default())
        .expect("atomic text outline");
    assert_eq!(ids.len(), 2);
    assert_eq!(
        editor.root.children.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
        vec!["before", ids[0].as_str(), ids[1].as_str(), "after"],
        "glyph siblings replace the text at its original stacking slot"
    );
    assert_eq!(editor.selection, ids);
    assert!(editor.undo(), "all glyph siblings undo together");
    assert!(matches!(&editor.root.children[1].kind, NodeKind::Text { text } if text == "Hi"));
    assert!(editor.redo(), "all glyph siblings redo together");
    assert!(editor.root.children[1..3]
        .iter()
        .all(|node| matches!(&node.kind, NodeKind::Vector { .. })));
}
