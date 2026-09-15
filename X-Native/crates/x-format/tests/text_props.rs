//! Figma text-properties parity for the `.x` format: every typed text
//! field must survive save -> load byte-for-byte, and legacy bindings
//! round-trip unchanged (old documents keep rendering).

use x_core::{
    Color, Document, HangingPunctuation, ListStyle, Node, TextAlign, TextAlignVertical, TextCase,
    TextDecoration, TextTruncation, TextWrap, WrapStyle,
};
use x_format::{load_x, save_x};

fn text_doc() -> Document {
    let mut t = Node::text("t", 10.0, 20.0, 240.0, 90.0, "Round trip");
    t.text_align = TextAlign::Right;
    t.text_align_vertical = TextAlignVertical::Bottom;
    t.text_decoration = TextDecoration::Strikethrough;
    t.text_case = TextCase::Title;
    t.text_truncation = TextTruncation::Middle;
    t.max_lines = Some(4);
    t.paragraph_spacing = 7.5;
    t.paragraph_indent = 18.0;
    t.hanging_punctuation = HangingPunctuation {
        quotes: true,
        lists: true,
    };
    t.list_style = ListStyle::Bulleted;
    t.wrap_style = WrapStyle::BreakWord;
    t.text_wrap = TextWrap::Pretty;
    t.line_height = 1.75;
    t.letter_spacing = 1.25;
    t.font_size = 26.0;
    t.vertical_trim = true;
    // small caps is a shaping MODE and stays binding-only (legacy shape)
    t.bindings.insert("sc".into(), "1".into());
    let mut page = Node::frame("page", 400.0, 300.0);
    page.children.push(t);
    let mut doc = Document::new();
    doc.pages.push(page);
    doc
}

#[test]
fn typed_text_properties_roundtrip() {
    let doc = text_doc();
    let text = save_x(&doc);
    let re = load_x(&text).expect("reloads");
    let t = &re.pages[0].children[0];
    assert_eq!(t.text_align, TextAlign::Right);
    assert_eq!(t.text_align_vertical, TextAlignVertical::Bottom);
    assert_eq!(t.text_decoration, TextDecoration::Strikethrough);
    assert_eq!(t.text_case, TextCase::Title);
    assert_eq!(t.text_truncation, TextTruncation::Middle);
    assert_eq!(t.max_lines, Some(4));
    assert_eq!(t.paragraph_spacing, 7.5);
    assert_eq!(t.paragraph_indent, 18.0);
    assert!(t.hanging_punctuation.quotes && t.hanging_punctuation.lists);
    assert_eq!(t.list_style, ListStyle::Bulleted);
    assert_eq!(t.wrap_style, WrapStyle::BreakWord);
    assert_eq!(t.text_wrap, TextWrap::Pretty);
    assert_eq!(t.line_height, 1.75);
    assert_eq!(t.letter_spacing, 1.25);
    assert_eq!(t.font_size, 26.0);
    assert!(t.vertical_trim);
    assert!(t.resolved_small_caps());
    assert_eq!(t.resolved_text_case(), TextCase::Title);
    // saving twice is byte-stable (no field-order drift)
    assert_eq!(text, save_x(&re));
}

#[test]
fn default_text_nodes_do_not_grow_the_format() {
    // a plain text node must not serialize any of the new keys
    let mut t = Node::text("t", 0.0, 0.0, 100.0, 20.0, "plain");
    t.fill = x_core::Paint::Solid(Color::BLACK);
    let mut page = Node::frame("page", 200.0, 200.0);
    page.children.push(t);
    let mut doc = Document::new();
    doc.pages.push(page);
    let text = save_x(&doc);
    for key in [
        "text_align",
        "text_decoration",
        "text_case",
        "max_lines",
        "vertical_trim",
        "font_size",
        "text_wrap",
    ] {
        assert!(!text.contains(key), "`{key}` leaked into a plain save");
    }
}
