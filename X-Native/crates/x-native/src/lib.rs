//! x-native — facade crate: one `x_native` surface over the workspace.
pub use x_core::*;
pub use x_text::{small_caps_segments, SMALL_CAPS_RATIO};
pub mod export;
pub mod html_export;
pub use html_export::{export_html, HtmlExportOptions, HtmlExportReport};
pub mod mcp;
pub mod svg_ir;
pub use export::{prepare_export, ExportPlan};
pub use svg_ir::export_svg_ir;
pub mod components {
    pub use x_components::*;
}
pub use x_components::{resolve_instance_layout, sync_instance_sizes, MeasureFn};
pub use x_render::{
    benchmark_scene, build_scene, build_scene_full, build_scene_with_assets, Assets, EncodeCtx,
};
pub use x_render::{
    build_render_tree, build_render_tree_of, build_render_tree_slice, export_pdf,
    export_pdf_with_assets, render_via_ir, thumbnail_scene, FrameCache, FrameCacheStats,
    RenderCommand, RenderTree, SceneCache, VelloSink,
};
pub use x_render::{
    encode_jpg, encode_png, export_raster, export_raster_cancellable, RasterFormat, RasterSink,
};
pub mod editor {
    pub use x_editor::*;
}
pub mod fileio {
    pub use x_format::*;
}
pub use x_format::{node_to_jsx, node_to_tailwind, selection_to_jsx, selection_to_tailwind};
pub mod text {
    pub use x_text::*;
}
pub mod ui {
    pub use x_ui::*;
}

pub use x_render::export_pdf_full;

/// TEXT PARITY glue: build an `SvgTextOutliner` closure over a
/// FontManager. This is the facade's job precisely because x-format is
/// not allowed to depend on x-text (dependency direction is
/// test-enforced): the exporter takes an injected callback, and this is
/// the one canonical implementation of it — same `node_text_outlines`
/// pipeline as the canvas and PDF sinks.
/// What the SVG exporter asks for per glyph: path data + optional
/// per-run color (None = paint with the layer fill).
pub type SvgGlyphOutlines = Vec<(String, Option<Color>)>;

pub fn svg_text_outliner(
    fonts: &x_text::FontManager,
) -> impl Fn(&[TextPart], f64, f64, Option<&str>, x_core::TextWrap) -> Option<SvgGlyphOutlines> + '_
{
    move |parts: &[TextPart],
          size: f64,
          max_width: f64,
          font: Option<&str>,
          wrap: x_core::TextWrap| {
        // unstyled single-part text keeps the plain pipeline (and its
        // ls=0/lh=1.2 defaults); anything styled goes through the rich
        // shaper (same 0.72 em + letter-spacing contract)
        let plain = parts.len() == 1
            && parts[0].color.is_none()
            && parts[0].size.is_none()
            && parts[0].font.is_none();
        let glyphs = if plain {
            let (glyphs, _) = x_text::node_text_outlines(
                fonts,
                &parts[0].text,
                size,
                max_width,
                font,
                vello::peniko::Color::BLACK,
            )?;
            glyphs
        } else {
            let (glyphs, _) = x_text::node_text_outlines_rich(
                fonts, parts, size, max_width, font, 0.0, 1.2, wrap, 0.0, 0.0, 0.0, false, 0.0,
                0.0, 0, x_text::Align::Left, 0, &x_text::TextLayout::default(),
            )?;
            glyphs
        };
        Some(
            glyphs
                .iter()
                .map(|g| {
                    // apply the glyph's local transform to its path, then write
                    // node-local SVG path data (the exporter's <g> handles x/y).
                    let mut p = g.path.clone();
                    p.apply_affine(g.transform);
                    // plain text never carries per-run colors; rich text maps the
                    // fully-transparent "no explicit color" marker to None
                    let color = if !plain && g.color.components[3] != 0.0 {
                        Some(g.color)
                    } else {
                        None
                    };
                    (svg_path_data(&p), color)
                })
                .collect(),
        )
    }
}

fn svg_path_data(p: &vello::kurbo::BezPath) -> String {
    use vello::kurbo::PathEl::*;
    let mut d = String::new();
    for el in p.elements() {
        match el {
            MoveTo(a) => d.push_str(&format!("M {:.2} {:.2} ", a.x, a.y)),
            LineTo(a) => d.push_str(&format!("L {:.2} {:.2} ", a.x, a.y)),
            QuadTo(a, b) => d.push_str(&format!("Q {:.2} {:.2} {:.2} {:.2} ", a.x, a.y, b.x, b.y)),
            CurveTo(a, b, c) => d.push_str(&format!(
                "C {:.2} {:.2} {:.2} {:.2} {:.2} {:.2} ",
                a.x, a.y, b.x, b.y, c.x, c.y
            )),
            ClosePath => d.push_str("Z "),
        }
    }
    d.trim_end().to_string()
}
