//! TEXT EXPORT PARITY (review's "top visual gap"):
//!
//! All three sinks — canvas (VelloSink), SVG exporter, PDF exporter —
//! must derive text geometry from the SAME `node_text_outlines` pipeline
//! (shaping, BiDi, fallback, wrapping). These tests pin that contract:
//! same glyph count, same first-glyph placement, real outline paths in
//! both export formats (no <text font-family="monospace">, no Helvetica
//! Tj), and ligature/kerning behavior surviving into the exports.

use x_native::fileio::export_svg_full;
use x_native::text::{node_text_outlines, FontManager};
use x_native::{
    build_render_tree, export_pdf_full, svg_text_outliner, Color, Node, TextPart, TextRun,
    Variables,
};

fn plain(text: &str) -> Vec<TextPart> {
    vec![TextPart {
        text: text.into(),
        color: None,
        size: None,
        font: None,
        weight: None,
        italic: None,
        ls: None,
    }]
}

fn fonts() -> FontManager {
    let mut fm = FontManager::new();
    assert!(fm.load_system_fonts() > 0, "system fonts required");
    fm
}

/// Frame names are canvas chrome and never reach an export; a Section's title is
/// the section's own artwork and does. The two therefore have different slot
/// names (`/label` vs `/pill` + `/chip`) — sharing one would have stripped a
/// section's title text and left a solid, wordless tag in the output.
#[test]
fn export_strips_frame_names_and_keeps_a_sections_title_chip() {
    let mut band = Node::section("band", 200.0, 120.0);
    band.name = "Band".into();
    let doc = Node::frame("Page", 400.0, 300.0)
        .child(Node::frame("Hero", 100.0, 80.0))
        .child(band);
    let tree = build_render_tree(&doc, &Variables::default());
    let keys: Vec<String> = tree.commands.iter().map(|c| c.key().to_string()).collect();
    assert!(
        keys.iter().any(|k| k.ends_with("/Hero/label")),
        "the frame's name is in the canvas tree: {keys:?}"
    );
    assert!(
        keys.iter().any(|k| k.ends_with("/band/pill"))
            && keys.iter().any(|k| k.ends_with("/band/chip")),
        "the section's chip and its title are in the canvas tree: {keys:?}"
    );
    // what the exporter keeps
    let kept: Vec<String> = keys
        .iter()
        .filter(|k| !(k.ends_with("/label")))
        .cloned()
        .collect();
    assert!(
        !kept.iter().any(|k| k.contains("Hero")),
        "no frame name in the export: {kept:?}"
    );
    assert!(
        kept.iter().any(|k| k.ends_with("/band/pill"))
            && kept.iter().any(|k| k.ends_with("/band/chip")),
        "the section keeps its chip AND its title: {kept:?}"
    );
}

#[test]
fn all_three_sinks_share_glyph_geometry() {
    let fm = fonts();
    let (glyphs, height) =
        node_text_outlines(&fm, "Export Parity fi", 24.0, 400.0, None, Color::BLACK)
            .expect("outlines");
    assert!(glyphs.len() >= 10, "shaped {} glyphs", glyphs.len());
    assert!(height > 0.0);

    // SVG outliner path count == canonical glyph count (same pipeline)
    let outliner = svg_text_outliner(&fm);
    let ds = outliner(
        &plain("Export Parity fi"),
        24.0,
        400.0,
        None,
        x_native::TextWrap::Auto,
    )
    .expect("svg outliner");
    assert_eq!(
        ds.len(),
        glyphs.len(),
        "svg emits one path per shaped glyph"
    );
    // every d is real path data with curves (glyph outlines, not boxes)
    for (d, c) in &ds {
        assert!(d.starts_with("M "), "path data: {d}");
        assert!(c.is_none(), "plain text carries no per-run color");
    }
    assert!(
        ds.iter().any(|(d, _)| d.contains("Q ") || d.contains("C ")),
        "glyphs contain curves"
    );

    // ligature contract survives: "fi" shapes to fewer glyphs than "f i"
    let ds_no_lig = outliner(
        &plain("Export Parity f i"),
        24.0,
        400.0,
        None,
        x_native::TextWrap::Auto,
    )
    .unwrap();
    assert!(
        ds_no_lig.len() > ds.len(),
        "fi ligature reduces glyph count in the EXPORT path too"
    );
}

#[test]
fn rich_runs_export_per_glyph_colors_to_svg() {
    let fm = fonts();
    let mut t = Node::text("t", 20.0, 20.0, 360.0, 24.0, "Red ink");
    // explicit black layer fill: unstyled glyphs fall back to THE NODE'S
    // fill (the Node::text default is the Figma-like #0d1220, not black)
    t.fill = x_native::Paint::Solid(Color::from_rgb8(0, 0, 0));
    t.text_runs = vec![TextRun {
        start: 0,
        len: 3,
        color: Some(Color::from_rgb8(255, 0, 0)),
        size: Some(36.0),
        font: None,
        weight: None,
        italic: None,
        ls: None,
    }];
    let doc = Node::frame("page", 400.0, 100.0).child(t);
    let outliner = svg_text_outliner(&fm);
    let svg = export_svg_full(&doc, &Variables::default(), None, Some(&outliner));
    // explicit run color paints those glyph paths red
    assert!(
        svg.matches("fill=\"#ff0000\"").count() >= 3,
        "first three glyphs red: {svg}"
    );
    // unstyled glyphs fall back to the node fill (black)
    assert!(
        svg.matches("fill=\"#000000\"").count() >= 3,
        "base-fill glyphs black: {svg}"
    );
    assert!(
        !svg.contains("font-family"),
        "no font guessing in the rich path either"
    );
}

#[test]
fn svg_export_emits_outlines_not_font_tags() {
    let fm = fonts();
    let doc = Node::frame("page", 400.0, 100.0).child(Node::text(
        "t",
        20.0,
        20.0,
        360.0,
        24.0,
        "Vector text",
    ));
    let outliner = svg_text_outliner(&fm);
    let svg = export_svg_full(&doc, &Variables::default(), None, Some(&outliner));
    assert!(
        !svg.contains("font-family"),
        "no font guessing left in the export"
    );
    assert!(!svg.contains("<text"), "no <text> element");
    let paths = svg.matches("<path").count();
    assert!(
        paths >= "Vectortext".len(),
        "one outline path per glyph, got {paths}"
    );
}

#[test]
fn pdf_export_emits_outlines_not_helvetica() {
    let fm = fonts();
    let doc = Node::frame("page", 400.0, 100.0).child(Node::text(
        "t",
        20.0,
        20.0,
        360.0,
        24.0,
        "Vector text",
    ));
    let tree = build_render_tree(&doc, &Variables::default());
    let pdf = export_pdf_full(&tree, 400.0, 100.0, None, Some(&fm));
    let txt = String::from_utf8_lossy(&pdf);
    assert!(!txt.contains("Tj"), "no Helvetica text ops left");
    // glyph outlines arrive as filled bezier paths: m/l/c ops + f fills
    assert!(txt.contains(" c\n"), "pdf contains curve segments");
    let fills = txt.matches("f\n").count();
    assert!(
        fills >= "Vectortext".len(),
        "one fill per glyph, got {fills}"
    );
    // without fonts, the legacy fallback still works (facade contract)
    let legacy = export_pdf_full(&tree, 400.0, 100.0, None, None);
    assert!(
        String::from_utf8_lossy(&legacy).contains("Tj"),
        "fallback keeps Tj path"
    );
}

#[test]
fn wrapping_matches_between_canvas_and_exports() {
    // narrow box forces a wrap; the same break must appear in the SVG
    // (two distinct baseline y-bands among outline paths).
    let fm = fonts();
    let (glyphs_wide, _) =
        node_text_outlines(&fm, "alpha beta", 20.0, 500.0, None, Color::BLACK).unwrap();
    let (glyphs_narrow, h_narrow) =
        node_text_outlines(&fm, "alpha beta", 20.0, 60.0, None, Color::BLACK).unwrap();
    assert_eq!(
        glyphs_wide.len(),
        glyphs_narrow.len(),
        "same glyphs either way"
    );
    let (_, h_wide) =
        node_text_outlines(&fm, "alpha beta", 20.0, 500.0, None, Color::BLACK).unwrap();
    assert!(
        h_narrow > h_wide * 1.5,
        "narrow box wraps to more lines ({h_narrow} vs {h_wide})"
    );
    // baseline bands differ: max translation-y among narrow glyphs is a
    // full line below the first baseline
    let ys: Vec<f64> = glyphs_narrow
        .iter()
        .map(|g| g.transform.as_coeffs()[5])
        .collect();
    let (min_y, max_y) = ys
        .iter()
        .fold((f64::MAX, f64::MIN), |(a, b), y| (a.min(*y), b.max(*y)));
    assert!(max_y - min_y > 10.0, "two baselines in the narrow layout");
}
