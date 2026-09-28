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
    export_pdf_with_assets, outline_view, render_via_ir, thumbnail_scene, FrameCache,
    FrameCacheStats, RenderCommand, RenderTree, SceneCache, VelloSink, OUTLINE_COLOR,
};
pub use x_render::{
    encode_jpg, encode_png, export_raster, export_raster_cancellable, RasterFormat, RasterSink,
};
// Canvas frame-name labels: the canvas overlay paints them in screen space
// (constant 11px at any zoom, blue when selected), reading the engine's one
// size/offset/ink rule and target list — never its own copies.
pub use x_render::ir::{
    frame_label_targets, label_ink, label_ink_selected, FrameLabelTarget, LABEL_ABOVE_Y,
    LABEL_FONT_SIZE, LABEL_OFFSET_Y, LABEL_SIZE,
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

/// Outline a Text node into one editable vector, retaining the historic
/// Flatten-compatible behavior. New callers that need Figma-style per-glyph
/// layers should use [`outline_text_glyph_nodes`] instead.
///
/// This facade owns shaping because x-editor must not depend on x-text. It
/// shares the canvas/PDF/SVG `node_text_outlines` inputs (font, wrapping,
/// spacing, rich runs and axes), elevates TrueType quadratics exactly, and
/// rebases its local vector bounds without moving transformed text on canvas.
/// Returns `None` for non-text, blank, or unresolved-font nodes.
pub fn outline_text_node(
    node: &Node,
    fonts: &x_text::FontManager,
    vars: &Variables,
) -> Option<Node> {
    let (glyphs, vshift) = shaped_text_outline_glyphs(node, fonts, vars)?;
    let mut cmds: Vec<PathCmd> = vec![];
    for glyph in &glyphs {
        let mut path = glyph.path.clone();
        path.apply_affine(vshift * glyph.transform);
        cmds.extend(bez_to_path_cmds(&path));
    }
    (!cmds.is_empty()).then(|| text_vector_node(node, "outline", cmds, None))
}

/// Outline a Text node into distinct editable glyph layers.
///
/// This facade owns font shaping because `x-editor` intentionally does not
/// depend on `x-text`; callers feed the resulting nodes to
/// `Editor::replace_node_with_siblings` for one atomic command/history entry.
/// A grapheme/ligature shares one output node, whitespace creates no empty
/// layer, and a numbered-list counter stays together. Each vector gets cloned
/// style/effects/transform state rather than aliases to the source node.
pub fn outline_text_glyph_nodes(
    node: &Node,
    fonts: &x_text::FontManager,
    vars: &Variables,
) -> Option<Vec<Node>> {
    let (glyphs, vshift) = shaped_text_outline_glyphs(node, fonts, vars)?;
    let mut groups: Vec<(usize, Option<Color>, Vec<PathCmd>)> = Vec::new();
    for glyph in glyphs {
        let mut path = glyph.path.clone();
        path.apply_affine(vshift * glyph.transform);
        let commands = bez_to_path_cmds(&path);
        if commands.is_empty() {
            continue;
        }
        // Plain shaping carries BLACK as its internal brush marker; only a
        // real rich-text run color overrides the cloned source fill stack.
        let color =
            (!node.text_runs.is_empty() && glyph.color.components[3] != 0.0).then_some(glyph.color);
        match groups.last_mut() {
            Some((group, prior_color, paths)) if *group == glyph.group => {
                // A grapheme normally has one style. If a fallback shaper did
                // expose conflicting run colors, keeping the source fill is
                // less surprising than silently picking one partial outline.
                if *prior_color != color {
                    *prior_color = None;
                }
                paths.extend(commands);
            }
            _ => groups.push((glyph.group, color, commands)),
        }
    }
    if groups.is_empty() {
        return None;
    }
    let nodes = groups
        .into_iter()
        .enumerate()
        .map(|(index, (_, color, commands))| {
            let mut vector = text_vector_node(node, "glyph", commands, color);
            vector.name = format!("{} glyph {}", node.name, index + 1);
            vector
        })
        .collect::<Vec<_>>();
    Some(nodes)
}

/// Shape and replace a text layer with its editable glyph siblings in one
/// editor command. This is the public end-to-end Outline Text entry point;
/// failure is side-effect free (non-text/empty/unresolved-font nodes leave the
/// document and history unchanged).
pub fn outline_text_glyph_layers(
    editor: &mut x_editor::Editor,
    id: &str,
    fonts: &x_text::FontManager,
    vars: &Variables,
) -> Option<Vec<String>> {
    let source = x_core::find_node(&editor.root, id)?.clone();
    let glyphs = outline_text_glyph_nodes(&source, fonts, vars)?;
    editor.replace_node_with_siblings(id, glyphs)
}

/// Resolve the exact same typography inputs that x-render uses and return
/// block-local glyph geometry plus the vertical placement affine. Keeping this
/// private helper shared by merged and per-glyph outlining prevents font/wrap
/// drift between the two public conversion modes.
fn shaped_text_outline_glyphs(
    node: &Node,
    fonts: &x_text::FontManager,
    vars: &Variables,
) -> Option<(Vec<x_text::OutlineGlyph>, vello::kurbo::Affine)> {
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
    let typo_num = |key: &str| node.bindings.get(key).and_then(|v| v.parse::<f64>().ok());
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
    let natural = x_text::resolve_natural_line_height(fonts, font.as_deref(), size).max(0.1);
    let lh = match lh_mode {
        1 => lh_value.max(1.0) / natural,
        2 => (lh_value / 100.0 * size / natural).max(0.1),
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
    let parts: Vec<TextPart> = if !node.text_runs.is_empty() {
        resolve_text_parts(text, &node.text_runs)
    } else {
        match node
            .bindings
            .get("fw")
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|weight| *weight != 400)
        {
            Some(weight) => vec![TextPart {
                text: text.clone(),
                color: None,
                size: None,
                font: None,
                weight: Some(weight),
                italic: None,
                ls: None,
            }],
            None => vec![],
        }
    };
    let shaped = if parts.is_empty() {
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
    let (glyphs, block_h) = shaped;
    if glyphs.is_empty() {
        return None;
    }
    let dy = match node.text_align_vertical {
        TextAlignVertical::Top => 0.0,
        TextAlignVertical::Middle => (node.h - block_h) / 2.0,
        TextAlignVertical::Bottom => node.h - block_h,
    };
    Some((glyphs, vello::kurbo::Affine::translate((0.0, dy))))
}

/// Preserve the source's world affine while making an individual glyph's path
/// local to its tight bounds. Text nodes can be rotated, flipped or skewed, so
/// changing `w`/`h` without solving the origin-pivot translation would move the
/// glyph on canvas.
fn text_vector_node(
    node: &Node,
    prefix: &str,
    commands: Vec<PathCmd>,
    color: Option<Color>,
) -> Node {
    let (min_x, min_y, max_x, max_y) =
        path_cmd_bounds(&commands).expect("shaped text paths contain finite anchors");
    let old_matrix = node.transform.matrix(node.w, node.h);
    let [a, b, c, d, e, f] = old_matrix.as_coeffs();
    let w = (max_x - min_x).max(1.0);
    let h = (max_y - min_y).max(1.0);
    let pivot_x = node.transform.origin_x * w;
    let pivot_y = node.transform.origin_y * h;
    let target_x = a * min_x + c * min_y + e;
    let target_y = b * min_x + d * min_y + f;

    let mut vector = node.clone();
    vector.id = fresh_id(prefix);
    vector.kind = NodeKind::Vector {
        path: commands
            .into_iter()
            .map(|command| shift_path_cmd(command, -min_x, -min_y))
            .collect(),
    };
    vector.w = w;
    vector.h = h;
    vector.transform.x = target_x - pivot_x + a * pivot_x + c * pivot_y;
    vector.transform.y = target_y - pivot_y + b * pivot_x + d * pivot_y;
    vector.children.clear();
    vector.text_runs.clear();
    vector.baseline = None;
    vector.corner_radii = None;
    vector.corner_smoothing = 0.0;
    vector.dirty = true;
    if let Some(color) = color {
        vector.fill = Paint::Solid(color);
        vector.visual_stacks_materialized = true;
        vector.fill_layers = vec![PaintLayer::new(vector.fill.clone())];
    }
    vector
}

fn path_cmd_bounds(commands: &[PathCmd]) -> Option<(f64, f64, f64, f64)> {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut seen = false;
    for command in commands {
        for (x, y) in path_cmd_points(*command) {
            if !x.is_finite() || !y.is_finite() {
                return None;
            }
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            seen = true;
        }
    }
    seen.then_some((min_x, min_y, max_x, max_y))
}

fn shift_path_cmd(command: PathCmd, dx: f64, dy: f64) -> PathCmd {
    match command {
        PathCmd::MoveTo(x, y) => PathCmd::MoveTo(x + dx, y + dy),
        PathCmd::LineTo(x, y) => PathCmd::LineTo(x + dx, y + dy),
        PathCmd::CurveTo(a, b, c, d, x, y) => {
            PathCmd::CurveTo(a + dx, b + dy, c + dx, d + dy, x + dx, y + dy)
        }
        PathCmd::Close => PathCmd::Close,
    }
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
