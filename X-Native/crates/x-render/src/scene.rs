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
        &ctx,
    );
    (scene, stats)
}

pub struct EncodeCtx<'a> {
    pub assets: Option<&'a Assets>,
    pub fonts: Option<&'a x_text::FontManager>,
}

fn shape_for_rect(node: &Node, radius: f64) -> vello::kurbo::BezPath {
    if let Some([tl, tr, br, bl]) = node.corner_radii {
        RoundedRect::from_rect(
            Rect::new(0.0, 0.0, node.w, node.h),
            RoundedRectRadii::new(tl, tr, br, bl),
        )
        .into_path(0.1)
    } else if radius > 0.0 {
        RoundedRect::new(0.0, 0.0, node.w, node.h, radius).into_path(0.1)
    } else {
        Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1)
    }
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
            } else if let Some(c) = raw.strip_prefix("stroke:").and_then(|v| parse_hex_color(v)) {
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
        NodeKind::Image { asset, .. } => {
            if let Some(img) = ctx.assets.and_then(|a| a.get(asset)) {
                // draw the decoded bitmap scaled into the node's box
                let sx = node.w / img.image.width as f64;
                let sy = node.h / img.image.height as f64;
                scene.draw_image(img, world * Affine::scale_non_uniform(sx, sy));
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
            let fs_px = node
                .bindings
                .get("fs")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| *v > 0.0)
                .unwrap_or(node.h * 0.72);
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
                    let (lh_mode, lh_value) = node.lh_mode_value();
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
                            build_rich_spans_px(node, content, color, fm, font, fs_px)
                        };
                        let (n, _) = x_text::encode_rich_text(
                            scene,
                            fm,
                            &spans,
                            font,
                            world,
                            &x_text::TextBlockStyle {
                                lh_mode,
                                max_width: node.w.max(8.0),
                                line_height: lh_mult,
                                align: x_text::Align::Left,
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
                            },
                        );
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
            // Phase 2.6: real editable vector paths render as filled shapes.
            if !path.is_empty() {
                let bez = path_to_bez(path);
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
        }
        NodeKind::Arc { start, end } => {
            // arc primitive: shared bezier geometry, chord fill + stroke
            let bez = path_to_bez(&x_core::booleans::arc_path_cmds(
                node.w, node.h, *start, *end,
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

            // QA-004 FIX: Render frame name label (same as Section nodes)
            // This ensures frame names appear on the canvas like in Figma
            let name = if node.name.is_empty() {
                "Frame"
            } else {
                node.name.as_str()
            };
            let label_color =
                Color::from_rgba8(0x4b, 0x55, 0x63, 0xff).multiply_alpha(node.opacity.min(0.7));
            let t = world * Affine::translate((14.0, 20.0));
            let drew = if let Some(fm) = ctx.fonts {
                if let Some(font) = fm.default_font() {
                    stats.paths += fm.encode_text_block(
                        scene,
                        name,
                        t,
                        font,
                        14.0,
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
                stats.paths += x_text::encode_text(scene, name, t, 16.0, label_color);
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
            // header label: node name, 18px, padded top-left
            let name = if node.name.is_empty() {
                "Section"
            } else {
                node.name.as_str()
            };
            let label_color =
                Color::from_rgba8(0x4b, 0x55, 0x63, 0xff).multiply_alpha(node.opacity);
            let t = world * Affine::translate((14.0, 10.0));
            let drew = if let Some(fm) = ctx.fonts {
                if let Some(font) = fm.default_font() {
                    stats.paths += fm.encode_text_block(
                        scene,
                        name,
                        t,
                        font,
                        18.0,
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
                stats.paths += x_text::encode_text(scene, name, t, 20.0, label_color);
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
    for child in &node.children {
        encode(
            scene, child, world, viewport, vars, stats, registry, overrides, depth, ctx,
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
    sc || opsz > 0.0 || wdth > 0.0 || node.has_explicit_lh()
}

pub(crate) fn build_rich_spans_px(
    node: &Node,
    text: &str,
    base_color: Color,
    fm: &x_text::FontManager,
    _default_font: usize,
    base_size_px: f64,
) -> Vec<x_text::Span> {
    let node_ls = node.bindings.get("ls").and_then(|v| v.parse::<f64>().ok());
    x_core::resolve_text_parts(text, &node.text_runs)
        .iter()
        .map(|p| {
            // per-part px sizes (base is already real px — see fs_px)
            let mut span = x_text::Span::new(&p.text, p.size.unwrap_or(base_size_px))
                .color(p.color.unwrap_or(base_color));
            if let Some(ls) = p.ls.or(node_ls) {
                span = span.letter_spacing(ls);
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
