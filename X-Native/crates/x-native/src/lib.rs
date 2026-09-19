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
                fonts,
                parts,
                size,
                max_width,
                font,
                0.0,
                1.2,
                wrap,
                0.0,
                0.0,
                0.0,
                false,
                0.0,
                0.0,
                0,
                x_text::Align::Left,
                None,
                0.0,
                x_core::TextDecoration::None,
                x_core::ListStyle::None,
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

/// TEXT-TO-VECTOR glue: outline a Text node's glyphs into ONE editable vector
/// path — Figma's "Outline text" (⌥⌘O), which turns type into geometry you can
/// node-edit, boolean and offset.
///
/// This lives in the facade for the same dependency-direction reason as
/// [`svg_text_outliner`]: x-editor must not depend on x-text/x-render, so the
/// editor cannot resolve glyphs itself. Glyph outlines come from the very same
/// `node_text_outlines` pipeline the canvas, the PDF sink and the SVG exporter
/// consume, with the same parameter derivation x-render's IR uses (`fs` /
/// `fontsize`, `ls` / `letterspacing`, `lh` + `lineheight`, `tw` wrap, `font`
/// family, `ws`/`ps`/`bs`, small caps, `opsz`/`wdth` axes) — so the outlined
/// shape matches what was on screen, wrapping and per-run styling included.
/// TrueType quadratics are elevated to cubics exactly (no re-fitting), because
/// `PathCmd` has no quad.
///
/// The result is a `Vector` node in the text node's own local space, carrying
/// its transform, name, opacity and paint (the text colour becomes the path
/// fill), with w/h grown to cover the glyphs. Feed it to
/// `editor::Editor::replace_node` to make the swap one undo step.
///
/// Returns None when the node is not text, its string is empty or whitespace, or
/// no font resolves — the caller should say so instead of quietly keeping the
/// text layer.
pub fn outline_text_node(
    node: &Node,
    fonts: &x_text::FontManager,
    vars: &Variables,
) -> Option<Node> {
    let NodeKind::Text { text } = &node.kind else {
        return None;
    };
    if text.trim().is_empty() {
        return None;
    }
    // typography bindings, derived exactly like x-render's IR does
    let fs_binding = node
        .bindings
        .get("fs")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v > 0.0);
    let size = node.bound_number("fontsize", vars, fs_binding.unwrap_or(node.h * 0.72));
    let typo_num = |k: &str| node.bindings.get(k).and_then(|v| v.parse::<f64>().ok());
    let ls = node.bound_number("letterspacing", vars, typo_num("ls").unwrap_or(0.0));
    let font = node.bindings.get("font").cloned();
    let (lh_mode, lh_value) = match node
        .bindings
        .get("lineheight")
        .and_then(|name| vars.numbers.get(name))
    {
        Some(px) if *px > 0.0 => (1u8, *px),
        _ => node.lh_mode_value(),
    };
    // a px / percent line-height is a BOX; the shaper wants a multiplier of the
    // face's natural line height — the same conversion the sinks perform
    let nat = x_text::resolve_natural_line_height(fonts, font.as_deref(), size).max(0.1);
    let lh = match lh_mode {
        1 => lh_value.max(1.0) / nat,
        2 => (lh_value / 100.0 * size / nat).max(0.1),
        _ => typo_num("lh").unwrap_or(1.2),
    };
    let wrap = node.text_wrap();
    let (ws, ps, bs) = (
        typo_num("ws").unwrap_or(0.0),
        typo_num("ps").unwrap_or(0.0),
        typo_num("bs").unwrap_or(0.0),
    );
    let small_caps = node.bindings.get("tc").map(String::as_str) == Some("sc");
    let (opsz, wdth) = (
        typo_num("opsz").unwrap_or(0.0) as f32,
        typo_num("wdth").unwrap_or(0.0) as f32,
    );
    // Runs, derived exactly like x-render's IR: rich runs only when the node
    // carries them; a node-level weight with no runs is synthesized into one, so
    // "Inter 600" outlines as the 600 face and not the 400. Instance text
    // overrides are NOT resolvable from a bare node — outlining an overridden
    // instance's text uses the component's own string, which is the honest
    // limit of a node-level API.
    let parts: Vec<TextPart> = if !node.text_runs.is_empty() {
        resolve_text_parts(text, &node.text_runs)
    } else {
        match node
            .bindings
            .get("fw")
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|w| *w != 400)
        {
            Some(w) => vec![TextPart {
                text: text.clone(),
                color: None,
                size: None,
                font: None,
                weight: Some(w),
                italic: None,
                ls: None,
            }],
            None => vec![],
        }
    };
    // empty runs = the plain pipeline, the same branch the canvas/PDF/SVG sinks
    // take, so all four agree on the glyph geometry. Alignment, the line
    // cap, paragraph indent and decoration ride along too — the outline is
    // the rendered shape, so it must carry everything the canvas renders.
    let glyphs = if parts.is_empty() {
        x_text::node_text_outlines_styled(
            fonts,
            text,
            size,
            node.w.max(1.0),
            font.as_deref(),
            vello::peniko::Color::BLACK,
            ls,
            lh,
            wrap,
            ws,
            ps,
            bs,
            small_caps,
            opsz,
            wdth,
            lh_mode,
            x_text::Align::from(node.text_align),
            node.max_lines,
            node.paragraph_indent,
            node.text_decoration,
            node.list_style,
        )?
    } else {
        x_text::node_text_outlines_rich(
            fonts,
            &parts,
            size,
            node.w.max(1.0),
            font.as_deref(),
            ls,
            lh,
            wrap,
            ws,
            ps,
            bs,
            small_caps,
            opsz,
            wdth,
            lh_mode,
            x_text::Align::from(node.text_align),
            node.max_lines,
            node.paragraph_indent,
            node.text_decoration,
            node.list_style,
        )?
    };
    let (glyphs, block_h) = glyphs;
    // the sinks place the block vertically inside the node box; the
    // outline must sit where the text sits
    let dy = match node.text_align_vertical {
        TextAlignVertical::Top => 0.0,
        TextAlignVertical::Middle => (node.h - block_h) / 2.0,
        TextAlignVertical::Bottom => node.h - block_h,
    };
    let vshift = vello::kurbo::Affine::translate((0.0, dy));
    if glyphs.is_empty() {
        return None;
    }
    // glyph space -> node-local space, then into PathCmds
    let mut cmds: Vec<PathCmd> = vec![];
    for g in &glyphs {
        let mut p = g.path.clone();
        p.apply_affine(vshift * g.transform);
        cmds.extend(bez_to_path_cmds(&p));
    }
    if cmds.is_empty() {
        return None;
    }
    // grow-only bounds, the same contract the editor's path ops use
    let (mut maxx, mut maxy) = (node.w, node.h);
    for c in &cmds {
        for (x, y) in path_cmd_points(*c) {
            maxx = maxx.max(x);
            maxy = maxy.max(y);
        }
    }
    let mut v = Node::vector(
        &fresh_id("outline"),
        node.transform.x,
        node.transform.y,
        maxx.max(1.0),
        maxy.max(1.0),
        cmds,
    );
    v.transform = node.transform;
    v.name = node.name.clone();
    v.opacity = node.opacity;
    v.visible = node.visible;
    // the text colour becomes the path fill (both the simple and the ordered
    // stack, so a text layer with several fill layers keeps all of them)
    v.fill = node.fill.clone();
    v.fill_layers = node.fill_layers.clone();
    Some(v)
}

/// Every point a PathCmd carries (anchors and control points), for bounds.
fn path_cmd_points(c: PathCmd) -> Vec<(f64, f64)> {
    match c {
        PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => vec![(x, y)],
        PathCmd::CurveTo(a, b, c2, d, e, f) => vec![(a, b), (c2, d), (e, f)],
        PathCmd::Close => vec![],
    }
}

/// BezPath -> PathCmd. Font outlines are quadratic (TrueType) or cubic (CFF), so
/// quads are elevated to cubics with the exact 2/3 rule — the curve is
/// identical, not approximated.
fn bez_to_path_cmds(p: &vello::kurbo::BezPath) -> Vec<PathCmd> {
    use vello::kurbo::PathEl;
    let mut out: Vec<PathCmd> = vec![];
    let mut cur = (0.0f64, 0.0f64);
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                out.push(PathCmd::MoveTo(a.x, a.y));
                cur = (a.x, a.y);
            }
            PathEl::LineTo(a) => {
                out.push(PathCmd::LineTo(a.x, a.y));
                cur = (a.x, a.y);
            }
            PathEl::QuadTo(a, b) => {
                let c1 = (
                    cur.0 + 2.0 / 3.0 * (a.x - cur.0),
                    cur.1 + 2.0 / 3.0 * (a.y - cur.1),
                );
                let c2 = (b.x + 2.0 / 3.0 * (a.x - b.x), b.y + 2.0 / 3.0 * (a.y - b.y));
                out.push(PathCmd::CurveTo(c1.0, c1.1, c2.0, c2.1, b.x, b.y));
                cur = (b.x, b.y);
            }
            PathEl::CurveTo(a, b, c) => {
                out.push(PathCmd::CurveTo(a.x, a.y, b.x, b.y, c.x, c.y));
                cur = (c.x, c.y);
            }
            PathEl::ClosePath => out.push(PathCmd::Close),
        }
    }
    out
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
