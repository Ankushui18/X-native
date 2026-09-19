#[allow(unused_imports)]
use crate::*;
use std::collections::HashMap;
use vello::kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use vello::peniko::{Brush, Fill};
use vello::Scene;
use x_core::*;

// ----------------------------------------------------------------- encoding

pub fn build_scene(
    root: &Node,
    viewport: Option<Viewport>,
    vars: &Variables,
) -> (Scene, SceneStats) {
    build_scene_with_assets(root, viewport, vars, None)
}

/// Phase 4.2: like `build_scene`, but Image nodes whose `asset` is present
/// in `assets` render the actual decoded bitmap instead of a placeholder.
pub fn build_scene_with_assets(
    root: &Node,
    viewport: Option<Viewport>,
    vars: &Variables,
    assets: Option<&Assets>,
) -> (Scene, SceneStats) {
    build_scene_full(root, viewport, vars, assets, None)
}

/// Full pipeline: assets + real typography. When `fonts` is Some, Text
/// nodes render with real TTF outlines (kerned, word-wrapped to node
/// width); otherwise the built-in stroke font keeps working.
pub fn build_scene_full(
    root: &Node,
    viewport: Option<Viewport>,
    vars: &Variables,
    assets: Option<&Assets>,
    fonts: Option<&x_text::FontManager>,
) -> (Scene, SceneStats) {
    let mut scene = Scene::new();
    let mut stats = SceneStats::default();
    let mut registry = ComponentRegistry::new();
    collect_components(root, &mut registry);
    let empty = HashMap::new();
    let ctx = EncodeCtx { assets, fonts };
    encode(
        &mut scene,
        root,
        Affine::IDENTITY,
        viewport,
        vars,
        &mut stats,
        &registry,
        &empty,
        0,
        false,
        &ctx,
    );
    (scene, stats)
}

pub struct EncodeCtx<'a> {
    pub assets: Option<&'a Assets>,
    pub fonts: Option<&'a x_text::FontManager>,
}

/// The ink of outline view — the hairline that draws each layer's outline
/// instead of its paint. White, the wireframe ink outline mode reads with on
/// the dark canvas. A named peniko constant, so it carries no literal of its
/// own for the design sheet to own.
pub const OUTLINE_COLOR: Color = Color::WHITE;

/// Figma's outline mode (⌘Y): a stripped **copy** of `root` in which the
/// canvas renders each layer as a wireframe — fills, images, blends and
/// effects are not painted, only the outline. Per node: the fill, stroke and
/// effect stacks (and the legacy single-paint fallback) are cleared, the
/// blend goes back to Normal, and the stroke becomes a solid hairline in
/// [`OUTLINE_COLOR`] at `width` — the app passes `1.0 / zoom`, so the line
/// stays ≈1 screen pixel at any zoom. Image and Text nodes paint themselves
/// (a bitmap, glyphs) and would swallow the stroke, so they become plain
/// `Rect { radius: 0.0 }` — the layer's own box (the named delta: Figma
/// outlines the glyphs). Children are stripped recursively, so an instance
/// resolves from the stripped registry — the master's children in the copy —
/// and nothing in the original document moves. A render mode, not a document
/// property: the same contract `FrameCache` keeps for `presenting` and
/// `hidden_text`.
///
/// The ONE exception to "per node": the render ROOT. On the canvas the root
/// is the PAGE, and the page is not a layer — Figma's outline mode outlines
/// layers, and our page frame is the canvas itself, so outlining it would
/// ring the whole window.
pub fn outline_view(root: &Node, width: f64) -> Node {
    let mut n = strip_for_outlines(root, width);
    n.stroke = Stroke::default();
    n
}

fn strip_for_outlines(node: &Node, width: f64) -> Node {
    let mut n = node.clone();
    if matches!(n.kind, NodeKind::Image { .. } | NodeKind::Text { .. }) {
        n.kind = NodeKind::Rect { radius: 0.0 };
    }
    n.fill = Paint::Solid(Color::TRANSPARENT);
    n.fill_layers.clear();
    n.stroke_layers.clear();
    n.effect_layers.clear();
    n.effects.clear();
    n.visual_stacks_materialized = false;
    n.blend = BlendKind::default();
    n.stroke = Stroke::solid(OUTLINE_COLOR, width);
    for c in n.children.iter_mut() {
        *c = strip_for_outlines(c, width);
    }
    n
}

fn shape_for_rect(node: &Node, radius: f64) -> vello::kurbo::BezPath {
    let radii = if let Some([tl, tr, br, bl]) = node.corner_radii {
        [tl, tr, br, bl]
    } else if radius > 0.0 {
        [radius; 4]
    } else {
        [0.0; 4]
    };

    // Use squircle (superellipse) geometry when corner_smoothing > 0
    if node.corner_smoothing > 0.0 && radii.iter().any(|&r| r > 0.0) {
        squircle_path(node.w, node.h, radii, node.corner_smoothing)
    } else if radii.iter().any(|&r| r > 0.0) {
        RoundedRect::from_rect(
            Rect::new(0.0, 0.0, node.w, node.h),
            RoundedRectRadii::new(radii[0], radii[1], radii[2], radii[3]),
        )
        .into_path(0.1)
    } else {
        Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1)
    }
}

/// Generate a squircle (superellipse) path with smooth corners.
///
/// `smoothing` (0.0–1.0) controls how "iOS-like" the corners are:
/// - 0.0 = standard circular corner
/// - 0.6–0.8 = continuous curvature (superellipse, n ≈ 4–5)
/// - 1.0 = maximum smoothing (very round transition)
///
/// Uses a parametric superellipse: |x/a|^n + |y/b|^n = 1
/// where n = 2 + 4 * smoothing (range: 2.0–6.0)
fn squircle_path(w: f64, h: f64, radii: [f64; 4], smoothing: f64) -> vello::kurbo::BezPath {
    use vello::kurbo::BezPath;

    let [tl, tr, br, bl] = radii;
    let n = 2.0 + 4.0 * smoothing; // superellipse exponent
    let segments = 12; // points per corner (higher = smoother)
    let mut path = BezPath::new();

    // Generate points for each corner using superellipse formula
    let corners = [
        (w - tr, tr, tr),     // top-right
        (w - br, h - br, br), // bottom-right
        (bl, h - bl, bl),     // bottom-left
        (tl, tl, tl),         // top-left
    ];

    for (corner_idx, &(cx, cy, radius)) in corners.iter().enumerate() {
        let start_angle = corner_idx as f64 * std::f64::consts::FRAC_PI_2;
        let end_angle = start_angle + std::f64::consts::FRAC_PI_2;

        for i in 0..=segments {
            let t = i as f64 / segments as f64;
            let angle = start_angle + t * (end_angle - start_angle);

            // Superellipse parametric form
            let cos_a = angle.cos();
            let sin_a = angle.sin();
            let sign_x = if cos_a >= 0.0 { 1.0 } else { -1.0 };
            let sign_y = if sin_a >= 0.0 { 1.0 } else { -1.0 };

            let x = sign_x * cos_a.abs().powf(2.0 / n);
            let y = sign_y * sin_a.abs().powf(2.0 / n);

            let px = cx + x * radius;
            let py = cy + y * radius;

            if corner_idx == 0 && i == 0 {
                path.move_to((px, py));
            } else {
                path.line_to((px, py));
            }
        }
    }

    path.close_path();
    path
}

fn encode_drop_shadows(
    scene: &mut Scene,
    node: &Node,
    world: Affine,
    shape: &impl Shape,
    stats: &mut SceneStats,
) {
    for effect in &node.effects {
        if let Effect::DropShadow {
            dx,
            dy,
            blur,
            color,
        } = effect
        {
            // No blur primitive in Vello 0.1: widen by the blur radius and
            // reduce alpha, which reads as a soft-ish shadow at small radii.
            let grow = blur * 0.5;
            let b = shape.bounding_box();
            let sx = if b.width() > 0.0 {
                (b.width() + grow * 2.0) / b.width()
            } else {
                1.0
            };
            let sy = if b.height() > 0.0 {
                (b.height() + grow * 2.0) / b.height()
            } else {
                1.0
            };
            let t = world
                * Affine::translate((dx - grow, dy - grow))
                * Affine::scale_non_uniform(sx, sy);
            scene.fill(
                Fill::NonZero,
                t,
                color.multiply_alpha(0.55 * node.opacity),
                None,
                shape,
            );
            stats.paths += 1;
        }
    }
}

/// Encode a vector's ordered visual layers for the legacy/direct sink.
/// Keeping this lowering next to the IR call site makes both public render
/// entry points honor the same node model; the canvas path remains the
/// authoritative geometry implementation while this sink only performs
/// backend encoding.
fn encode_vector_layers(
    scene: &mut Scene,
    node: &Node,
    world: Affine,
    path: &vello::kurbo::BezPath,
    override_color: Option<Color>,
    vars: &Variables,
    stats: &mut SceneStats,
) {
    let node_alpha = node.opacity.clamp(0.0, 1.0);
    for (index, layer) in node.active_fills().iter().enumerate() {
        if !layer.visible || layer.opacity <= 0.0 {
            continue;
        }
        let paint = if index == 0 {
            override_color
                .map(Paint::Solid)
                .unwrap_or_else(|| layer.paint.clone())
        } else {
            layer.paint.clone()
        };
        if matches!(&paint, Paint::Solid(color) if color.components[3] == 0.0) {
            continue;
        }
        if let Some(mix) = layer.blend.mix() {
            scene.push_layer(
                Fill::NonZero,
                mix,
                1.0,
                Affine::IDENTITY,
                &bounds(world, node.w, node.h),
            );
        }
        scene.fill(
            Fill::NonZero,
            world,
            &brush_with_alpha(
                paint_brush(&paint, vars),
                node_alpha * layer.opacity.clamp(0.0, 1.0),
            ),
            None,
            path,
        );
        stats.paths += 1;
        if layer.blend.mix().is_some() {
            scene.pop_layer();
        }
    }
    for layer in node.active_strokes().iter() {
        if !layer.visible || layer.opacity <= 0.0 || layer.stroke.width <= 0.0 {
            continue;
        }
        if matches!(&layer.stroke.paint, Paint::Solid(color) if color.components[3] == 0.0) {
            continue;
        }
        if let Some(mix) = layer.blend.mix() {
            scene.push_layer(
                Fill::NonZero,
                mix,
                1.0,
                Affine::IDENTITY,
                &bounds(world, node.w, node.h),
            );
        }
        let stroke = crate::text_geometry::stroke_style(layer.stroke.width, &layer.options);
        scene.stroke(
            &stroke,
            world,
            &brush_with_alpha(
                paint_brush(&layer.stroke.paint, vars),
                node_alpha * layer.opacity.clamp(0.0, 1.0),
            ),
            None,
            path,
        );
        stats.paths += 1;
        if layer.blend.mix().is_some() {
            scene.pop_layer();
        }
    }
}

/// `in_frame` mirrors `ir::lower`'s flag: true when a FRAME already encloses
/// this node in this render, so the direct encoder draws the same labels the IR
/// path draws (Figma names a page's outermost frames only).
#[allow(clippy::too_many_arguments)]
fn encode(
    scene: &mut Scene,
    node: &Node,
    parent: Affine,
    viewport: Option<Viewport>,
    vars: &Variables,
    stats: &mut SceneStats,
    registry: &ComponentRegistry,
    overrides: &HashMap<String, String>,
    depth: u32,
    in_frame: bool,
    ctx: &EncodeCtx,
) {
    stats.nodes += 1;
    if node.dirty {
        stats.dirty_nodes += 1;
    }
    // typed overrides that alter traversal: visible / opacity / swap
    let mut swapped: Option<Node> = None;
    let node = {
        let mut effective_visible = node.visible;
        let mut effective_opacity: Option<f32> = None;
        if let Some(raw) = overrides.get(&node.id) {
            if let Some(v) = raw.strip_prefix("visible:") {
                if let Ok(b) = v.parse::<bool>() {
                    effective_visible = b;
                }
            } else if let Some(o) = raw.strip_prefix("opacity:") {
                if let Ok(f) = o.parse::<f32>() {
                    effective_opacity = Some(f);
                }
            } else if let Some(c) = raw.strip_prefix("swap:") {
                if matches!(node.kind, NodeKind::Instance { .. }) {
                    let mut n2 = node.clone();
                    n2.kind = NodeKind::Instance {
                        component: c.to_string(),
                    };
                    swapped = Some(n2);
                }
            } else if let Some(c) = raw.strip_prefix("stroke:").and_then(parse_hex_color) {
                // a stroke colour override repaints the stroke, never the
                // fill (the bare-hex form above is the fill override)
                let mut n2 = node.clone();
                apply_stroke_paint(&mut n2, c);
                swapped = Some(n2);
            }
        }
        if !effective_visible {
            return;
        }
        if let Some(op) = effective_opacity {
            let mut n2 = swapped.take().unwrap_or_else(|| node.clone());
            n2.opacity = op.clamp(0.0, 1.0);
            swapped = Some(n2);
        }
        swapped.as_ref().unwrap_or(node)
    };
    if !node.visible {
        return;
    }
    let world = parent * node.transform.matrix(node.w, node.h);
    // P1 binding: opacity -> number variable (0..1)
    let node_storage;
    let node = if node.bindings.contains_key("opacity") {
        let mut n2 = node.clone();
        n2.opacity = node.bound_number("opacity", vars, node.opacity as f64) as f32;
        node_storage = n2;
        &node_storage
    } else {
        node
    };
    let b = bounds(world, node.w, node.h);
    if let Some(v) = viewport {
        if !intersects(b, Rect::new(v.x, v.y, v.x + v.w, v.y + v.h)) {
            stats.culled += 1;
            return;
        }
    }

    // Phase 4: blend layer around this node + its subtree.
    let blend = node.blend.mix();
    if let Some(mix) = blend {
        scene.push_layer(Fill::NonZero, mix, 1.0, Affine::IDENTITY, &b);
    }

    let mut frame_clip_shape: Option<vello::kurbo::BezPath> = None;

    match &node.kind {
        NodeKind::Rect { radius } => {
            let bound_radius = node.bound_number("radius", vars, *radius);
            let shape = shape_for_rect(node, bound_radius);
            encode_drop_shadows(scene, node, world, &shape, stats);
            scene.fill(
                Fill::NonZero,
                world,
                &brush_with_alpha(effective_brush(node, overrides, vars), node.opacity),
                None,
                &shape,
            );
            if node.stroke.width > 0.0 {
                scene.stroke(
                    &vello::kurbo::Stroke::new(node.stroke.width),
                    world,
                    &brush_with_alpha(paint_brush(&node.stroke.paint, vars), node.opacity),
                    None,
                    &shape,
                );
                stats.paths += 1;
            }
            stats.paths += 1;
        }
        NodeKind::Ellipse => {
            let r = node.w.min(node.h) / 2.0;
            let shape = Circle::new((r, r), r);
            let t = world * Affine::scale_non_uniform(node.w / node.h, 1.0);
            encode_drop_shadows(scene, node, t, &shape.into_path(0.1), stats);
            scene.fill(
                Fill::NonZero,
                t,
                &brush_with_alpha(effective_brush(node, overrides, vars), node.opacity),
                None,
                &shape,
            );
            stats.paths += 1;
        }
        NodeKind::Line => {
            let shape = Rect::new(
                0.0,
                0.0,
                node.w.max(node.stroke.width),
                node.stroke.width.max(1.0),
            )
            .into_path(0.1);
            scene.fill(
                Fill::NonZero,
                world,
                &brush_with_alpha(paint_brush(&node.stroke.paint, vars), node.opacity),
                None,
                &shape,
            );
            stats.paths += 1;
        }
        NodeKind::Image {
            asset,
            fit,
            placement,
        } => {
            let adjusted = node
                .image_adjustments
                .and_then(|adj| ctx.assets.and_then(|a| a.get_adjusted(asset, adj)));
            let image = adjusted
                .as_ref()
                .or_else(|| ctx.assets.and_then(|a| a.get(asset)));
            if let Some(img) = image {
                let resolved = x_core::resolve_image_placement(
                    *fit,
                    placement,
                    node.w,
                    node.h,
                    img.image.width as f64,
                    img.image.height as f64,
                );
                let box_rect = Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1);
                scene.push_clip_layer(Fill::NonZero, world, &box_rect);
                let image_transform = world
                    * Affine::translate((node.w / 2.0, node.h / 2.0))
                    * Affine::rotate(node.image_rotation.to_radians())
                    * Affine::translate((-node.w / 2.0, -node.h / 2.0));
                for draw in &resolved.draws {
                    scene.draw_image(img, image_transform * *draw);
                }
                scene.pop_layer();
                stats.paths += 1;
            } else {
                let shape = Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1);
                scene.fill(
                    Fill::NonZero,
                    world,
                    &effective_brush(node, overrides, vars),
                    None,
                    &shape,
                );
                stats.paths += 1;
            }
        }
        NodeKind::Text { text } => {
            let raw = effective_text(node, overrides).unwrap_or(text);
            // text case transforms the CONTENT (only when there are no rich
            // runs — case can change char counts)
            // text case transforms the CONTENT (only when there are no rich
            // runs — case can change char counts)
            let cased;
            let content: &str = if node.text_runs.is_empty() {
                cased = x_core::apply_text_case(raw, node.bindings.get("tc").map(String::as_str));
                cased.as_str()
            } else {
                raw
            };
            let color = effective_fill(node, overrides, vars).multiply_alpha(node.opacity);
            // Real typography when a FontManager is present. Font size in
            // REAL px: an fs binding is the point size directly; legacy
            // nodes keep the engine em convention (0.72 * node.h px).
            // Rich-text runs (node.text_runs) split the block into
            // per-style parts.
            // a `fontsize` token outranks the literal `fs` binding (same
            // contract as ir.rs, so both sinks agree on the size)
            let fs_px = node.bound_number(
                "fontsize",
                vars,
                node.bindings
                    .get("fs")
                    .and_then(|v| v.parse::<f64>().ok())
                    .filter(|v| *v > 0.0)
                    .unwrap_or(node.h * 0.72),
            );
            let fw = node.bindings.get("fw").and_then(|v| v.parse::<u16>().ok());
            let needs_styled = text_needs_styled(node);
            let drew = if let Some(fm) = ctx.fonts {
                if let Some(font) = node
                    .bindings
                    .get("font")
                    .and_then(|f| match fw {
                        Some(w) => fm.resolve_face(f, w),
                        None => fm.resolve_font_name(f),
                    })
                    // static faces ignore wght variations: weight renders
                    // only through a real face switch (Family-<weight>)
                    .or_else(|| fm.default_font_weighted(fw.unwrap_or(400)))
                {
                    // line box: legacy multiplier, or a MODE — fixed px /
                    // percent of font size (converted with the face's
                    // natural line box, the same one the pipeline uses)
                    let nat_lh = fm.line_height(font, fs_px).max(0.1);
                    // a `lineheight` token is a px line box: mode 1 semantics,
                    // outranking the literal mode on the node
                    let (lh_mode, lh_value) = match node
                        .bindings
                        .get("lineheight")
                        .and_then(|name| vars.numbers.get(name))
                    {
                        Some(px) if *px > 0.0 => (1, *px),
                        _ => node.lh_mode_value(),
                    };
                    let lh_mult = match lh_mode {
                        1 => lh_value.max(1.0) / nat_lh,
                        2 => (lh_value / 100.0 * fs_px / nat_lh).max(0.1),
                        _ => node
                            .bindings
                            .get("lh")
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(1.2),
                    };
                    if node.text_runs.is_empty() && !needs_styled {
                        stats.paths += fm.encode_text_block(
                            scene,
                            content,
                            world,
                            font,
                            fs_px,
                            Some(node.w.max(8.0)),
                            color,
                        );
                    } else {
                        let spans = if node.text_runs.is_empty() {
                            // styled defaults without runs (sc / variable axes)
                            vec![x_text::Span::new(content, fs_px).color(color)]
                        } else {
                            build_rich_spans_px(node, content, color, fm, font, fs_px, vars)
                        };
                        // shape first so the vertical alignment can place the
                        // block inside the node box before encoding
                        let (glyphs, height) = x_text::glyph_outlines(
                            fm,
                            &spans,
                            font,
                            &x_text::TextBlockStyle {
                                lh_mode,
                                max_width: node.w.max(8.0),
                                line_height: lh_mult,
                                align: x_text::Align::from(node.text_align),
                                wrap: node.text_wrap(),
                                paragraph_spacing: node
                                    .bindings
                                    .get("ps")
                                    .and_then(|v| v.parse::<f64>().ok())
                                    .unwrap_or(0.0),
                                baseline_shift: node
                                    .bindings
                                    .get("bs")
                                    .and_then(|v| v.parse::<f64>().ok())
                                    .unwrap_or(0.0),
                                small_caps: node.bindings.get("tc").map(String::as_str)
                                    == Some("sc"),
                                optical_size: node
                                    .bindings
                                    .get("opsz")
                                    .and_then(|v| v.parse::<f32>().ok())
                                    .unwrap_or(0.0),
                                width_axis: node
                                    .bindings
                                    .get("wdth")
                                    .and_then(|v| v.parse::<f32>().ok())
                                    .unwrap_or(0.0),
                                max_lines: node.max_lines,
                                paragraph_indent: node.paragraph_indent,
                                decoration: node.text_decoration,
                                list: node.list_style,
                            },
                        );
                        let dy = match node.text_align_vertical {
                            x_core::TextAlignVertical::Top => 0.0,
                            x_core::TextAlignVertical::Middle => (node.h - height) / 2.0,
                            x_core::TextAlignVertical::Bottom => node.h - height,
                        };
                        let vshift = Affine::translate((0.0, dy));
                        let n = glyphs.len();
                        for g in &glyphs {
                            scene.fill(
                                Fill::NonZero,
                                world * vshift * g.transform,
                                g.color,
                                None,
                                &g.path,
                            );
                        }
                        stats.paths += n;
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if !drew {
                stats.paths += x_text::encode_text(scene, content, world, node.h, color);
            }
        }
        NodeKind::Vector { path } => {
            // Vectors use the same materialized fill/stroke stacks as the IR
            // renderer. The old direct encoder read only `node.fill` and
            // `node.stroke`, which made thumbnails/PDFs disagree with the
            // canvas as soon as a vector had a second paint, gradient, layer
            // opacity, blend mode, or custom cap/join.
            if !path.is_empty() {
                let bez = path_to_bez(path);
                encode_drop_shadows(scene, node, world, &bez, stats);
                encode_vector_layers(
                    scene,
                    node,
                    world,
                    &bez,
                    overrides.get(&node.id).and_then(|raw| parse_hex_color(raw)),
                    vars,
                    stats,
                );
            }
        }
        NodeKind::Poly { sides } => {
            // polygon primitive: the same box-local outline the Boolean ops and
            // the export read, filled + stroked like any other shape
            let bez = path_to_bez(&x_core::booleans::poly_path_cmds(node.w, node.h, *sides));
            encode_drop_shadows(scene, node, world, &bez, stats);
            scene.fill(
                Fill::NonZero,
                world,
                &brush_with_alpha(effective_brush(node, overrides, vars), node.opacity),
                None,
                &bez,
            );
            if node.stroke.width > 0.0 {
                scene.stroke(
                    &vello::kurbo::Stroke::new(node.stroke.width),
                    world,
                    &brush_with_alpha(paint_brush(&node.stroke.paint, vars), node.opacity),
                    None,
                    &bez,
                );
                stats.paths += 1;
            }
            stats.paths += 1;
        }
        NodeKind::Star { points, ratio } => {
            let cmds = x_core::booleans::star_path_cmds(node.w, node.h, *points, *ratio);
            let bez = path_to_bez(&cmds);
            encode_drop_shadows(scene, node, world, &bez, stats);
            scene.fill(
                Fill::NonZero,
                world,
                &brush_with_alpha(effective_brush(node, overrides, vars), node.opacity),
                None,
                &bez,
            );
            if node.stroke.width > 0.0 {
                scene.stroke(
                    &vello::kurbo::Stroke::new(node.stroke.width),
                    world,
                    &brush_with_alpha(paint_brush(&node.stroke.paint, vars), node.opacity),
                    None,
                    &bez,
                );
                stats.paths += 1;
            }
            stats.paths += 1;
        }
        NodeKind::Arc { start, end, ratio } => {
            // arc primitive: the shared wedge/ring outline, filled + stroked
            let bez = path_to_bez(&x_core::booleans::arc_path_cmds(
                node.w, node.h, *start, *end, *ratio,
            ));
            encode_drop_shadows(scene, node, world, &bez, stats);
            scene.fill(
                Fill::NonZero,
                world,
                &brush_with_alpha(effective_brush(node, overrides, vars), node.opacity),
                None,
                &bez,
            );
            if node.stroke.width > 0.0 {
                scene.stroke(
                    &vello::kurbo::Stroke::new(node.stroke.width),
                    world,
                    &brush_with_alpha(paint_brush(&node.stroke.paint, vars), node.opacity),
                    None,
                    &bez,
                );
                stats.paths += 1;
            }
            stats.paths += 1;
        }
        NodeKind::Instance { component } => {
            if depth < MAX_INSTANCE_DEPTH {
                // swap override targeting THIS instance id (set by a parent
                // instance) has already been applied by the parent pass;
                // here resolve our own component name.
                if let Some(def) = registry.get(component.as_str()) {
                    // Figma slots: masters with Slot props substitute the
                    // instance's tagged content at the anchor nodes.
                    let resolved = resolve_slots(def, node);
                    let kids: &[Node] = resolved.as_deref().unwrap_or(&def.children);
                    for child in kids {
                        encode(
                            scene,
                            child,
                            world,
                            viewport,
                            vars,
                            stats,
                            registry,
                            &node.overrides,
                            depth + 1,
                            // a master's internal frames are never named
                            true,
                            ctx,
                        );
                    }
                }
            }
        }
        NodeKind::Frame { .. } => {
            // Frames draw their background fill when it isn't transparent
            // (matches Figma: frames have fills; groups do not). Corner
            // radii apply here too, same as a Rect node.
            let color = effective_fill(node, overrides, vars);
            let shape = shape_for_rect(node, 0.0);
            if color.components[3] > 0.0 {
                encode_drop_shadows(scene, node, world, &shape, stats);
                scene.fill(
                    Fill::NonZero,
                    world,
                    &brush_with_alpha(effective_brush(node, overrides, vars), node.opacity),
                    None,
                    &shape,
                );
                stats.paths += 1;
            }
            // Clip children to the frame's own (rounded) bounds ONLY when
            // it actually has corner radii — the case where clipping is
            // visually load-bearing. Square frames behave like groups
            // (no unconditional clip), which also keeps the direct
            // encoder in lockstep with the IR lowering in ir.rs.
            let rounded = node
                .corner_radii
                .map(|[tl, tr, br, bl]| tl > 0.0 || tr > 0.0 || br > 0.0 || bl > 0.0)
                .unwrap_or(false);
            if rounded {
                frame_clip_shape = Some(shape);
            }

            // QA-004: a frame's name is drawn like a section's — in the
            // gutter ABOVE the frame's top-left corner, never inside the
            // frame's own content, and never for
            //   * the root of the render (on the canvas the root is the page,
            //     whose name belongs in the pages list; it used to print
            //     across an empty artboard and stay there after everything on
            //     the page was deleted), or
            //   * a frame nested inside another frame (Figma names a page's
            //     outermost frames only — `in_frame`), or
            //   * a frame whose own **Show name** switch is off (Figma's right
            //     sidebar: Layer → "Show name").
            if depth > 0 && !in_frame && node.show_name {
                let name = if node.name.is_empty() {
                    "Frame"
                } else {
                    node.name.as_str()
                };
                let label_color = crate::ir::label_ink().multiply_alpha(node.opacity);
                let t = world * Affine::translate((0.0, crate::ir::LABEL_ABOVE_Y));
                let drew = if let Some(fm) = ctx.fonts {
                    if let Some(font) = fm.default_font() {
                        stats.paths += fm.encode_text_block(
                            scene,
                            name,
                            t,
                            font,
                            crate::ir::LABEL_SIZE,
                            Some((node.w - 20.0).max(8.0)),
                            label_color,
                        );
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if !drew {
                    stats.paths +=
                        x_text::encode_text(scene, name, t, crate::ir::LABEL_SIZE, label_color);
                }
            }
        }
        NodeKind::Section => {
            // Figma-style section: tinted rounded container, hairline
            // border, and the node NAME as a header label above the
            // content (children render through the shared path below).
            let color = effective_fill(node, overrides, vars);
            let shape = shape_for_rect(node, 0.0).into_path(0.1);
            if color.components[3] > 0.0 {
                scene.fill(
                    Fill::NonZero,
                    world,
                    &brush_with_alpha(effective_brush(node, overrides, vars), node.opacity),
                    None,
                    &shape,
                );
                stats.paths += 1;
            }
            if node.stroke.width > 0.0 {
                scene.stroke(
                    &vello::kurbo::Stroke::new(node.stroke.width),
                    world,
                    &brush_with_alpha(paint_brush(&node.stroke.paint, vars), node.opacity),
                    None,
                    &shape,
                );
                stats.paths += 1;
            }
            // Header: Figma draws a Section's name as a filled chip in the
            // section's own colour, and — unlike a frame name, which is chrome —
            // a section's chip IS part of its export. The geometry comes from
            // `crate::ir::section_pill_*`, so the direct encoder and the IR
            // encoder draw the same chip. A section is labelled wherever it
            // appears (Figma: "in sections, frame name is always visible"); only
            // the root of the render is silent, because on the canvas the root is
            // the page itself.
            if depth > 0 {
                let name = if node.name.is_empty() {
                    "Section"
                } else {
                    node.name.as_str()
                };
                let pill = crate::ir::section_pill_rect(name, node.w);
                let radius = crate::ir::SECTION_PILL_R;
                let shape = RoundedRect::from_rect(
                    pill,
                    RoundedRectRadii::new(radius, radius, radius, radius),
                )
                .into_path(0.1);
                scene.fill(
                    Fill::NonZero,
                    world,
                    crate::ir::section_pill_fill().multiply_alpha(node.opacity),
                    None,
                    &shape,
                );
                let label_color = crate::ir::section_pill_ink().multiply_alpha(node.opacity);
                let t = world
                    * Affine::translate((
                        crate::ir::SECTION_PILL_PAD_X,
                        crate::ir::section_pill_top() + crate::ir::SECTION_PILL_TEXT_DY,
                    ));
                let drew = if let Some(fm) = ctx.fonts {
                    if let Some(font) = fm.default_font() {
                        stats.paths += fm.encode_text_block(
                            scene,
                            name,
                            t,
                            font,
                            crate::ir::SECTION_LABEL_SIZE,
                            Some((node.w - 20.0).max(8.0)),
                            label_color,
                        );
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if !drew {
                    stats.paths += x_text::encode_text(
                        scene,
                        name,
                        t,
                        crate::ir::SECTION_LABEL_SIZE,
                        label_color,
                    );
                }
            }
        }
        NodeKind::Group | NodeKind::Component { .. } | NodeKind::Slice => {}
    }
    // Clip children to the frame's own rounded bounds (only set when the
    // frame has corner radii), so a child's shadow/overflow can't bleed
    // past the rounded corner — see the Frame branch above.
    if let Some(shape) = &frame_clip_shape {
        scene.push_clip_layer(Fill::NonZero, world, shape);
    }
    // Instance children are slot content: they render only via the
    // substitution in the Instance arm above, never directly.
    if matches!(node.kind, NodeKind::Instance { .. }) {
        return;
    }
    // Sort children for paint order: z_index first (higher paints on top),
    // then the container's own canvas stacking — `paint_order` is the one
    // owner of that rule, and for a frame that has not touched the setting it
    // is document order, exactly as before.
    let ranks = paint_ranks(node);
    let mut indexed_children: Vec<(usize, &Node)> = node.children.iter().enumerate().collect();
    indexed_children.sort_by(|(i_a, a), (i_b, b)| {
        let z_a = a.z_index.unwrap_or(0);
        let z_b = b.z_index.unwrap_or(0);
        z_a.cmp(&z_b).then(ranks[*i_a].cmp(&ranks[*i_b]))
    });
    // same nesting rule as `ir::lower`: a frame's children count as "inside a
    // frame" unless this frame IS the render root (the page), and a Section
    // resets the flag so frames sitting in a section keep their names
    let child_in_frame = if matches!(node.kind, NodeKind::Frame { .. }) {
        depth > 0
    } else if matches!(node.kind, NodeKind::Section) {
        false
    } else {
        in_frame
    };
    for (_, child) in indexed_children {
        encode(
            scene,
            child,
            world,
            viewport,
            vars,
            stats,
            registry,
            overrides,
            depth,
            child_in_frame,
            ctx,
        );
    }
    if frame_clip_shape.is_some() {
        scene.pop_layer();
    }

    if blend.is_some() {
        scene.pop_layer();
    }
}

/// Split a Text node into shaping [`x_text::Span`]s from its rich-text runs
/// (`Node::text_runs`, resolved through `resolve_text_parts` — the same
/// char-index model every sink uses). Each part's style (family/weight/
/// italic/size/color/letter-spacing) overrides the node defaults; unset
/// fields inherit the base (size = node.h, color = base_color, default font).
/// Text nodes that must render through the styled pipeline: synthesized
/// small caps, variable-font axes, or an EXPLICIT line-height (the plain
/// block path always uses the face's natural line box).
pub(crate) fn text_needs_styled(node: &Node) -> bool {
    let sc = node.bindings.get("tc").map(String::as_str) == Some("sc");
    let opsz = node
        .bindings
        .get("opsz")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(0.0);
    let wdth = node
        .bindings
        .get("wdth")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(0.0);
    // the fast path renders plain left-set, unclipped, undecorated text;
    // any node carrying one of these must take the full shaper
    let typed = node.text_align != x_core::TextAlign::Left
        || node.text_align_vertical != x_core::TextAlignVertical::Top
        || node.max_lines.is_some()
        || node.paragraph_indent != 0.0
        || node.text_decoration != x_core::TextDecoration::None
        // a list takes the styled path too: the fast path has no marker
        // column and would drop the bullets
        || node.list_style != x_core::ListStyle::None;
    sc || opsz > 0.0 || wdth > 0.0 || node.has_explicit_lh() || typed
}

pub(crate) fn build_rich_spans_px(
    node: &Node,
    text: &str,
    base_color: Color,
    fm: &x_text::FontManager,
    _default_font: usize,
    base_size_px: f64,
    vars: &Variables,
) -> Vec<x_text::Span> {
    // a `letterspacing` token outranks the node's literal `ls`
    let node_ls = node
        .bindings
        .get("letterspacing")
        .and_then(|name| vars.numbers.get(name))
        .copied()
        .or_else(|| node.bindings.get("ls").and_then(|v| v.parse::<f64>().ok()));
    // word spacing: node-level only (TextPart carries no run ws), read
    // exactly like the IR path (ir.rs lower: typo_num("ws")) so the canvas
    // agrees with exports
    let node_ws = node.bindings.get("ws").and_then(|v| v.parse::<f64>().ok());
    x_core::resolve_text_parts(text, &node.text_runs)
        .iter()
        .map(|p| {
            // per-part px sizes (base is already real px — see fs_px)
            let mut span = x_text::Span::new(&p.text, p.size.unwrap_or(base_size_px))
                .color(p.color.unwrap_or(base_color));
            if let Some(ls) = p.ls.or(node_ls) {
                span = span.letter_spacing(ls);
            }
            if let Some(ws) = node_ws {
                span = span.word_spacing(ws);
            }
            // Font resolution: the run's family or the node's, at the
            // run's weight (real face switch — static faces ignore wght
            // variations), with the VF axes kept for variable fonts.
            let italic = p.italic.unwrap_or(false);
            let fam = p
                .font
                .clone()
                .or_else(|| node.bindings.get("font").cloned());
            let w = p.weight.unwrap_or(400);
            let mut chosen = fam
                .as_deref()
                .and_then(|f| fm.resolve_face(f, w))
                .or_else(|| fam.as_deref().and_then(|f| fm.resolve_font_name(f)))
                .or_else(|| fm.default_font_weighted(w));
            if chosen.is_none() && italic {
                chosen = fam
                    .as_deref()
                    .and_then(|f| fm.font_index(&format!("{f}-Oblique")))
                    .or_else(|| fm.font_index("DejaVuSans-Oblique"));
            }
            if let Some(fi) = chosen {
                span = span.font(fi);
            }
            if let Some(w) = p.weight {
                span = span.variation("wght", w as f32);
            }
            if italic {
                span = span.variation("ital", 1.0);
            }
            span
        })
        .collect()
}

fn brush_with_alpha(brush: Brush, alpha: f32) -> Brush {
    if alpha >= 1.0 {
        return brush;
    }
    match brush {
        Brush::Solid(c) => Brush::Solid(c.multiply_alpha(alpha)),
        Brush::Gradient(mut g) => {
            for stop in g.stops.iter_mut() {
                stop.color = stop.color.multiply_alpha(alpha);
            }
            Brush::Gradient(g)
        }
        other => other,
    }
}
