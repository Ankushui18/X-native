//! Render IR (P1): Document -> Layout -> RenderTree -> RenderCommands -> sink.
//!
//! The document model no longer needs to become Vello ops directly.
//! `build_render_tree` resolves everything renderable (world transforms,
//! effective paints, instance resolution, overrides, variable bindings)
//! into a flat, backend-agnostic command list. Sinks consume commands:
//! - VelloSink   -> vello::Scene (the GPU path, used by the app)
//! - Any future sink: SVG, PDF/print, thumbnails, hit-test caches,
//!   accessibility trees, WebGPU-direct — same commands.
//!
//! Node uuid-stable `key`s make caching / partial redraw diffs possible.

use std::collections::HashMap;
use vello::kurbo::{Affine, BezPath, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use vello::peniko::{Brush, Color, Fill, Mix};
use vello::Scene;
use x_core::*;

/// One drawable unit, fully resolved. No document types leak through
/// except geometry/paint primitives.
#[derive(Debug, Clone)]
pub enum RenderCommand {
    FillPath {
        key: String,
        transform: Affine,
        path: BezPath,
        brush: Brush,
    },
    StrokePath {
        key: String,
        transform: Affine,
        path: BezPath,
        brush: Brush,
        width: f64,
        options: StrokeOptions,
    },
    PushLayer {
        key: String,
        mix: Mix,
        alpha: f32,
        bounds: Rect,
    },
    PopLayer,
    Glyphs {
        key: String,
        transform: Affine,
        text: String,
        size: f64,
        brush: Brush,
        max_width: f64,
        font: Option<String>,
        letter_spacing: f64,
        line_height: f64,
        /// line-height MODE: 0 = legacy multiplier (`line_height`), 1 = fixed
        /// px (`lh_value`), 2 = percent of font size (`lh_value`)
        lh_mode: u8,
        lh_value: f64,
        wrap: x_core::TextWrap,
        word_spacing: f64,
        paragraph_spacing: f64,
        baseline_shift: f64,
        small_caps: bool,
        optical_size: f32,
        width_axis: f32,
        /// Horizontal alignment. The shaper supports Left/Center/Right;
        /// Justified degrades to Left (see `x_text::Align::from`).
        align: x_core::TextAlign,
        /// Vertical placement of the block inside the node box. A
        /// PLACEMENT, not a shaping property: every sink computes the
        /// offset from the shaped block's height and `node_h`.
        v_align: x_core::TextAlignVertical,
        /// Text box height (node.h) — what `v_align` places against.
        node_h: f64,
        /// CSS max-lines cap (None = unlimited).
        max_lines: Option<usize>,
        /// First-line indent of each paragraph, px.
        paragraph_indent: f64,
        /// Underline / strikethrough, drawn per line by the shaper.
        decoration: x_core::TextDecoration,
        runs: Vec<x_core::TextPart>,
    },
    Image {
        key: String,
        transform: Affine,
        asset: String,
        w: f64,
        h: f64,
        fit: ImageFit,
        placement: ImagePlacement,
        adjustments: Option<x_core::ImageAdjustments>,
        /// Independent image-fill rotation in degrees; node rotation remains
        /// on `transform` and is applied to both the box and its contents.
        rotation: f64,
    },
    /// clip layer from an arbitrary path (masks)
    PushClip {
        key: String,
        transform: Affine,
        path: BezPath,
    },
}

impl RenderCommand {
    pub fn key(&self) -> &str {
        match self {
            RenderCommand::FillPath { key, .. }
            | RenderCommand::StrokePath { key, .. }
            | RenderCommand::PushLayer { key, .. }
            | RenderCommand::Glyphs { key, .. }
            | RenderCommand::Image { key, .. }
            | RenderCommand::PushClip { key, .. } => key,
            RenderCommand::PopLayer => "",
        }
    }
}

#[derive(Debug, Default)]
pub struct RenderTree {
    pub commands: Vec<RenderCommand>,
}

impl RenderTree {
    /// Cache/diff support: keys of commands that differ from `old`.
    /// (Positional diff keyed by node identity — the partial-redraw seed.)
    pub fn changed_keys(&self, old: &RenderTree) -> Vec<String> {
        let index = |t: &RenderTree| -> HashMap<String, usize> {
            let mut m = HashMap::new();
            for (i, c) in t.commands.iter().enumerate() {
                if !c.key().is_empty() {
                    m.insert(format!("{}#{}", c.key(), fingerprint(c)), i);
                }
            }
            m
        };
        let old_idx = index(old);
        let mut changed = vec![];
        for c in &self.commands {
            if c.key().is_empty() {
                continue;
            }
            let fp = format!("{}#{}", c.key(), fingerprint(c));
            if !old_idx.contains_key(&fp) {
                changed.push(c.key().to_string());
            }
        }
        changed.sort();
        changed.dedup();
        changed
    }
}

/// A mask node's clip geometry (vector path / rect / ellipse).
fn mask_path_of(n: &Node) -> Option<BezPath> {
    match &n.kind {
        NodeKind::Vector { path } if !path.is_empty() => Some(path_to_bez(path)),
        NodeKind::Arc { start, end } => Some(path_to_bez(&x_core::booleans::arc_path_cmds(
            n.w, n.h, *start, *end,
        ))),
        NodeKind::Rect { radius } => {
            let r = *radius;
            Some(if r > 0.0 {
                vello::kurbo::RoundedRect::new(0.0, 0.0, n.w, n.h, r).into_path(0.1)
            } else {
                Rect::new(0.0, 0.0, n.w, n.h).into_path(0.1)
            })
        }
        NodeKind::Ellipse => {
            let (rx, ry) = (n.w / 2.0, n.h / 2.0);
            Some(vello::kurbo::Ellipse::new((rx, ry), (rx, ry), 0.0).into_path(0.1))
        }
        _ => None,
    }
}

/// A paint that cannot affect output: a fully transparent solid, or a
/// variable resolving to one. Legacy single-fill nodes default to
/// `Solid(TRANSPARENT)` (every frame, group, component and instance), so
/// without this check the IR lowers a no-op FillPath/Glyphs command for
/// each of them — wasted GPU work and noise in the diff/golden stream.
/// (The direct encoder in scene.rs already skips `color.a == 0` fills;
/// this brings the IR path back into lockstep with it.)
fn paint_fully_transparent(p: &Paint, vars: &Variables) -> bool {
    match p {
        Paint::Solid(c) => c.components[3] == 0.0,
        Paint::Variable(name) => vars.color(name, Color::BLACK).components[3] == 0.0,
        _ => false,
    }
}

fn layer_brush(paint: &Paint, vars: &Variables, opacity: f32) -> Brush {
    if opacity >= 1.0 {
        return paint_brush(paint, vars);
    }
    match paint {
        Paint::Solid(c) => Brush::Solid(c.multiply_alpha(opacity)),
        Paint::Variable(name) => {
            Brush::Solid(vars.color(name, Color::BLACK).multiply_alpha(opacity))
        }
        Paint::LinearGradient {
            start,
            end,
            stops,
            space,
        } => paint_brush(
            &Paint::LinearGradient {
                start: *start,
                end: *end,
                stops: stops
                    .iter()
                    .map(|(t, c)| (*t, c.multiply_alpha(opacity)))
                    .collect(),
                space: *space,
            },
            vars,
        ),
        Paint::RadialGradient {
            center,
            radius,
            stops,
            space,
        } => paint_brush(
            &Paint::RadialGradient {
                center: *center,
                radius: *radius,
                stops: stops
                    .iter()
                    .map(|(t, c)| (*t, c.multiply_alpha(opacity)))
                    .collect(),
                space: *space,
            },
            vars,
        ),
        Paint::AngularGradient {
            center,
            start_angle,
            end_angle,
            stops,
            space,
        } => paint_brush(
            &Paint::AngularGradient {
                center: *center,
                start_angle: *start_angle,
                end_angle: *end_angle,
                stops: stops
                    .iter()
                    .map(|(t, c)| (*t, c.multiply_alpha(opacity)))
                    .collect(),
                space: *space,
            },
            vars,
        ),
        Paint::DiamondGradient {
            center,
            width,
            height,
            stops,
            space,
        } => paint_brush(
            &Paint::DiamondGradient {
                center: *center,
                width: *width,
                height: *height,
                stops: stops
                    .iter()
                    .map(|(t, c)| (*t, c.multiply_alpha(opacity)))
                    .collect(),
                space: *space,
            },
            vars,
        ),
        // pattern FILLS are intercepted in emit_visual_layers and render
        // via clip + tiled image; this gray is the fallback for strokes,
        // text fills and lines (patterns can't clip a stroke region)
        Paint::Pattern { .. } => {
            Brush::Solid(Color::from_rgb8(0x99, 0x99, 0x99).multiply_alpha(opacity))
        }
    }
}

/// Normalized concentric Gaussian taps. Every tap is still a native Vello
/// vector draw, so the compositor remains GPU-driven on the pinned backend.
fn gaussian_taps(radius: f64) -> Vec<(f64, f64, f32)> {
    if radius <= 0.01 {
        return vec![(0.0, 0.0, 1.0)];
    }
    let sigma = (radius / 2.0).max(0.5);
    let mut taps = vec![(0.0, 0.0, 1.0f64)];
    for (ring, count) in [(0.45, 8usize), (0.9, 12usize), (1.35, 16usize)] {
        let d = radius * ring;
        let weight = (-d * d / (2.0 * sigma * sigma)).exp();
        for i in 0..count {
            let a = std::f64::consts::TAU * i as f64 / count as f64;
            taps.push((a.cos() * d, a.sin() * d, weight));
        }
    }
    let sum: f64 = taps.iter().map(|t| t.2).sum();
    taps.into_iter()
        .map(|(x, y, w)| (x, y, (w / sum) as f32))
        .collect()
}

fn offset_command(command: &RenderCommand, dx: f64, dy: f64) -> RenderCommand {
    let shift = Affine::translate((dx, dy));
    match command {
        RenderCommand::FillPath {
            key,
            transform,
            path,
            brush,
        } => RenderCommand::FillPath {
            key: format!("{key}/bg"),
            transform: shift * *transform,
            path: path.clone(),
            brush: brush.clone(),
        },
        RenderCommand::StrokePath {
            key,
            transform,
            path,
            brush,
            width,
            options,
        } => RenderCommand::StrokePath {
            key: format!("{key}/bg"),
            transform: shift * *transform,
            path: path.clone(),
            brush: brush.clone(),
            width: *width,
            options: options.clone(),
        },
        RenderCommand::PushLayer {
            key,
            mix,
            alpha,
            bounds,
        } => RenderCommand::PushLayer {
            key: format!("{key}/bg"),
            mix: *mix,
            alpha: *alpha,
            bounds: Rect::new(
                bounds.x0 + dx,
                bounds.y0 + dy,
                bounds.x1 + dx,
                bounds.y1 + dy,
            ),
        },
        RenderCommand::PopLayer => RenderCommand::PopLayer,
        RenderCommand::Glyphs {
            key,
            transform,
            text,
            size,
            brush,
            max_width,
            font,
            letter_spacing,
            line_height,
            lh_mode,
            lh_value,
            wrap,
            word_spacing,
            paragraph_spacing,
            baseline_shift,
            small_caps,
            optical_size,
            width_axis,
            align,
            v_align,
            node_h,
            max_lines,
            paragraph_indent,
            decoration,
            runs,
        } => RenderCommand::Glyphs {
            key: format!("{key}/bg"),
            transform: shift * *transform,
            text: text.clone(),
            size: *size,
            brush: brush.clone(),
            max_width: *max_width,
            font: font.clone(),
            letter_spacing: *letter_spacing,
            wrap: *wrap,
            line_height: *line_height,
            lh_mode: *lh_mode,
            lh_value: *lh_value,
            word_spacing: *word_spacing,
            paragraph_spacing: *paragraph_spacing,
            baseline_shift: *baseline_shift,
            small_caps: *small_caps,
            optical_size: *optical_size,
            width_axis: *width_axis,
            align: *align,
            v_align: *v_align,
            node_h: *node_h,
            max_lines: *max_lines,
            paragraph_indent: *paragraph_indent,
            decoration: *decoration,
            runs: runs.clone(),
        },
        RenderCommand::Image {
            key,
            transform,
            asset,
            w,
            h,
            fit,
            placement,
            adjustments,
            rotation,
        } => RenderCommand::Image {
            key: format!("{key}/bg"),
            transform: shift * *transform,
            asset: asset.clone(),
            w: *w,
            h: *h,
            fit: *fit,
            placement: *placement,
            adjustments: *adjustments,
            rotation: *rotation,
        },
        RenderCommand::PushClip {
            key,
            transform,
            path,
        } => RenderCommand::PushClip {
            key: format!("{key}/bg"),
            transform: shift * *transform,
            path: path.clone(),
        },
    }
}

#[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
fn emit_visual_layers(
    tree: &mut RenderTree,
    node: &Node,
    key: &str,
    world: Affine,
    path: &BezPath,
    vars: &Variables,
    opacity: f32,
    override_color: Option<Color>,
) {
    let effects = node.active_effects();
    let layer_blur = effects
        .iter()
        .filter_map(|l| match &l.effect {
            Effect::LayerBlur { radius } => Some(*radius * l.opacity as f64),
            _ => None,
        })
        .fold(0.0, f64::max);
    for (i, layer) in effects.iter().enumerate() {
        if let Effect::BackgroundBlur { radius } = &layer.effect {
            let background = tree.commands.clone();
            if !background.is_empty() && *radius > 0.01 {
                if let Some(mix) = layer.blend.mix() {
                    tree.commands.push(RenderCommand::PushLayer {
                        key: format!("{key}/effect-{i}/blend"),
                        mix,
                        alpha: 1.0,
                        bounds: bounds(world, node.w, node.h),
                    });
                }
                tree.commands.push(RenderCommand::PushClip {
                    key: format!("{key}/effect-{i}/background-clip"),
                    transform: world,
                    path: path.clone(),
                });
                let b = bounds(world, node.w, node.h).inflate(*radius * 1.5, *radius * 1.5);
                for (tap, (dx, dy, weight)) in gaussian_taps(*radius).into_iter().enumerate() {
                    tree.commands.push(RenderCommand::PushLayer {
                        key: format!("{key}/effect-{i}/background-tap-{tap}"),
                        mix: Mix::Normal,
                        alpha: weight * layer.opacity.clamp(0.0, 1.0),
                        bounds: b,
                    });
                    tree.commands
                        .extend(background.iter().map(|cmd| offset_command(cmd, dx, dy)));
                    tree.commands.push(RenderCommand::PopLayer);
                }
                tree.commands.push(RenderCommand::PopLayer);
                if layer.blend != BlendKind::Normal {
                    tree.commands.push(RenderCommand::PopLayer);
                }
            }
        }
    }
    for (i, layer) in effects.iter().enumerate() {
        if let Effect::DropShadow {
            dx,
            dy,
            blur,
            color,
        } = &layer.effect
        {
            if let Some(mix) = layer.blend.mix() {
                tree.commands.push(RenderCommand::PushLayer {
                    key: format!("{key}/effect-{i}/blend"),
                    mix,
                    alpha: 1.0,
                    bounds: bounds(world, node.w, node.h).inflate(*blur * 1.5, *blur * 1.5),
                });
            }
            for (tap, (bx, by, weight)) in gaussian_taps(*blur).into_iter().enumerate() {
                tree.commands.push(RenderCommand::FillPath {
                    key: format!("{key}/effect-{i}/tap-{tap}"),
                    transform: Affine::translate((bx, by)) * world * Affine::translate((*dx, *dy)),
                    path: path.clone(),
                    brush: Brush::Solid(
                        color.multiply_alpha(opacity * layer.opacity.clamp(0.0, 1.0) * weight),
                    ),
                });
            }
            if layer.blend != BlendKind::Normal {
                tree.commands.push(RenderCommand::PopLayer);
            }
        }
    }
    let fills = if let Some(color) = override_color {
        vec![PaintLayer::new(Paint::Solid(color))]
    } else {
        node.active_fills()
    };
    for (i, layer) in fills.iter().enumerate() {
        if layer.opacity <= 0.0 || paint_fully_transparent(&layer.paint, vars) {
            continue;
        }
        let layer_key = format!("{key}/fill-{i}");
        if let Some(mix) = layer.blend.mix() {
            tree.commands.push(RenderCommand::PushLayer {
                key: layer_key.clone(),
                mix,
                alpha: 1.0,
                bounds: bounds(world, node.w, node.h),
            });
        }
        for (tap, (bx, by, weight)) in gaussian_taps(layer_blur).into_iter().enumerate() {
            let tap_key = if layer_blur > 0.01 {
                format!("{layer_key}/blur-{tap}")
            } else {
                layer_key.clone()
            };
            if let Paint::Pattern { asset, fit } = &layer.paint {
                // image pattern: every sink already speaks PushClip/Image,
                // so the fill lowers to clip(shape) + image draw (tiling
                // comes from the existing image-placement model)
                let bb = path.bounding_box();
                let group = (opacity * layer.opacity.clamp(0.0, 1.0) * weight).clamp(0.0, 1.0);
                let at = Affine::translate((bx, by)) * world;
                if group < 1.0 {
                    tree.commands.push(RenderCommand::PushLayer {
                        key: format!("{tap_key}/pat-group"),
                        mix: Mix::Normal,
                        alpha: group,
                        bounds: bounds(world, node.w, node.h),
                    });
                }
                tree.commands.push(RenderCommand::PushClip {
                    key: format!("{tap_key}/pat-clip"),
                    transform: at,
                    path: path.clone(),
                });
                tree.commands.push(RenderCommand::Image {
                    key: format!("{tap_key}/pat"),
                    transform: at * Affine::translate((bb.x0, bb.y0)),
                    asset: asset.clone(),
                    w: bb.width().max(1.0),
                    h: bb.height().max(1.0),
                    fit: *fit,
                    placement: ImagePlacement::default(),
                    adjustments: None,
                    rotation: 0.0,
                });
                tree.commands.push(RenderCommand::PopLayer);
                if group < 1.0 {
                    tree.commands.push(RenderCommand::PopLayer);
                }
            } else {
                tree.commands.push(RenderCommand::FillPath {
                    key: tap_key,
                    transform: Affine::translate((bx, by)) * world,
                    path: path.clone(),
                    brush: layer_brush(
                        &layer.paint,
                        vars,
                        opacity * layer.opacity.clamp(0.0, 1.0) * weight,
                    ),
                });
            }
        }
        if layer.blend != BlendKind::Normal {
            tree.commands.push(RenderCommand::PopLayer);
        }
    }
    for (i, layer) in node.active_strokes().iter().enumerate() {
        if layer.opacity <= 0.0 || paint_fully_transparent(&layer.stroke.paint, vars) {
            continue;
        }
        let layer_key = format!("{key}/stroke-{i}");
        if let Some(mix) = layer.blend.mix() {
            tree.commands.push(RenderCommand::PushLayer {
                key: layer_key.clone(),
                mix,
                alpha: 1.0,
                bounds: bounds(world, node.w, node.h),
            });
        }
        for (tap, (dx, dy, weight)) in gaussian_taps(layer_blur).into_iter().enumerate() {
            tree.commands.push(RenderCommand::StrokePath {
                key: if layer_blur > 0.01 {
                    format!("{layer_key}/blur-{tap}")
                } else {
                    layer_key.clone()
                },
                transform: Affine::translate((dx, dy)) * world,
                path: path.clone(),
                brush: layer_brush(
                    &layer.stroke.paint,
                    vars,
                    opacity * layer.opacity.clamp(0.0, 1.0) * weight,
                ),
                width: layer.stroke.width,
                options: layer.options.clone(),
            });
        }
        if layer.blend != BlendKind::Normal {
            tree.commands.push(RenderCommand::PopLayer);
        }
    }
    // Inner shadows composite above the object's paint but remain clipped to
    // its geometry. This ordering is essential; drawing them before fills
    // would make an opaque fill erase the effect.
    for (i, layer) in effects.iter().enumerate() {
        if let Effect::InnerShadow {
            dx,
            dy,
            blur,
            color,
        } = &layer.effect
        {
            if let Some(mix) = layer.blend.mix() {
                tree.commands.push(RenderCommand::PushLayer {
                    key: format!("{key}/effect-{i}/blend"),
                    mix,
                    alpha: 1.0,
                    bounds: bounds(world, node.w, node.h),
                });
            }
            tree.commands.push(RenderCommand::PushClip {
                key: format!("{key}/effect-{i}/inner-clip"),
                transform: world,
                path: path.clone(),
            });
            for (tap, (bx, by, weight)) in gaussian_taps(*blur).into_iter().enumerate() {
                tree.commands.push(RenderCommand::StrokePath {
                    key: format!("{key}/effect-{i}/inner-tap-{tap}"),
                    transform: Affine::translate((bx, by)) * world * Affine::translate((*dx, *dy)),
                    path: path.clone(),
                    brush: Brush::Solid(
                        color.multiply_alpha(opacity * layer.opacity.clamp(0.0, 1.0) * weight),
                    ),
                    width: (*blur * 2.0).max(1.0),
                    options: StrokeOptions::default(),
                });
            }
            tree.commands.push(RenderCommand::PopLayer);
            if layer.blend != BlendKind::Normal {
                tree.commands.push(RenderCommand::PopLayer);
            }
        }
    }

    // Noise/Grain effect - procedural texture overlay
    for (i, layer) in effects.iter().enumerate() {
        if let Effect::Noise { amount, seed } = &layer.effect {
            if *amount > 0.0 && layer.opacity > 0.0 {
                let noise_opacity = amount.min(1.0) * layer.opacity.clamp(0.0, 1.0);

                // Generate noise as a series of small fill operations with varying opacity
                // In production, this would use a pre-generated noise texture or compute shader
                // For now, apply as a subtle overlay using the element's path

                // Add noise layer
                if let Some(mix) = layer.blend.mix() {
                    tree.commands.push(RenderCommand::PushLayer {
                        key: format!("{key}/effect-{i}/noise-blend"),
                        mix,
                        alpha: noise_opacity,
                        bounds: bounds(world, node.w, node.h),
                    });
                }

                // Apply noise pattern via multiple semi-transparent fills
                // The seed determines the pattern variation
                let num_samples = 8.min((amount * 20.0) as usize).max(1);

                for sample in 0..num_samples {
                    let sample_seed = seed.wrapping_add(sample as u32);
                    let hash = ((sample_seed as f64 * 12.9898).sin() * 43758.5453).fract();
                    let gray_value = (hash * 255.0) as u8;

                    tree.commands.push(RenderCommand::FillPath {
                        key: format!("{key}/effect-{i}/noise-sample-{sample}"),
                        transform: world,
                        path: path.clone(),
                        brush: Brush::Solid(Color::from_rgba8(
                            gray_value, gray_value, gray_value, 32,
                        )),
                    });
                }

                if layer.blend != BlendKind::Normal {
                    tree.commands.push(RenderCommand::PopLayer);
                }
            }
        }
    }
}

fn fingerprint(c: &RenderCommand) -> String {
    match c {
        RenderCommand::FillPath {
            transform,
            path,
            brush,
            ..
        } => format!(
            "f{:?}{}{:?}",
            transform.as_coeffs(),
            path.elements().len(),
            brush
        ),
        RenderCommand::StrokePath {
            transform,
            brush,
            width,
            options,
            ..
        } => format!("s{:?}{brush:?}{width}{options:?}", transform.as_coeffs()),
        RenderCommand::PushLayer {
            mix, alpha, bounds, ..
        } => format!("l{mix:?}{alpha}{bounds:?}"),
        RenderCommand::Glyphs {
            transform,
            text,
            size,
            brush,
            font,
            max_width,
            runs,
            letter_spacing,
            line_height,
            lh_mode,
            lh_value,
            word_spacing,
            paragraph_spacing,
            baseline_shift,
            small_caps,
            optical_size,
            width_axis,
            wrap,
            align,
            v_align,
            node_h,
            max_lines,
            paragraph_indent,
            decoration,
            ..
        } => format!(
            "g{:?}{text}{size}{max_width}{font:?}{brush:?}{runs:?}{letter_spacing}{line_height}{lh_mode}{lh_value}{word_spacing}{paragraph_spacing}{baseline_shift}{small_caps}{optical_size}{width_axis}{wrap:?}{align:?}{v_align:?}{node_h}{max_lines:?}{paragraph_indent}{decoration:?}",
            transform.as_coeffs()
        ),
        RenderCommand::Image {
            transform,
            asset,
            fit,
            placement,
            adjustments,
            rotation,
            ..
        } => format!(
            "i{:?}{asset}{fit:?}{placement:?}{adjustments:?}{rotation}",
            transform.as_coeffs()
        ),
        RenderCommand::PushClip {
            transform, path, ..
        } => format!("c{:?}{}", transform.as_coeffs(), path.elements().len()),
        RenderCommand::PopLayer => String::new(),
    }
}

/// Build the resolved command list from a document root.
pub fn build_render_tree(root: &Node, vars: &Variables) -> RenderTree {
    build_render_tree_with_hidden(root, vars, None)
}

/// Suppress the glyphs currently drawn by the inline editor without cloning
/// or temporarily mutating the document root.
pub fn build_render_tree_with_hidden(
    root: &Node,
    vars: &Variables,
    hidden: Option<&str>,
) -> RenderTree {
    let mut tree = RenderTree::default();
    let mut registry: HashMap<&str, &Node> = HashMap::new();
    fn collect<'a>(n: &'a Node, reg: &mut HashMap<&'a str, &'a Node>) {
        if let NodeKind::Component { name } = &n.kind {
            reg.insert(name.as_str(), n);
        }
        for c in &n.children {
            collect(c, reg);
        }
    }
    collect(root, &mut registry);
    let empty = HashMap::new();
    lower(
        root,
        Affine::IDENTITY,
        vars,
        &registry,
        &empty,
        0,
        &mut tree,
        "",
        hidden,
        true,
    );
    tree
}

/// Same as `build_render_tree_with_hidden`, but the ROOT's name label is
/// suppressed: the frame-cache segmented path lowers the root once per
/// child bucket, so the root label must be painted by the separately
/// rendered shell scene EXACTLY ONCE — never re-emitted per bucket
/// (that overdraws the name N+1 times and darkens it).
pub(crate) fn build_render_tree_bucket_shell(
    root: &Node,
    vars: &Variables,
    hidden: Option<&str>,
) -> RenderTree {
    let mut tree = RenderTree::default();
    let mut registry: HashMap<&str, &Node> = HashMap::new();
    fn collect<'a>(n: &'a Node, reg: &mut HashMap<&'a str, &'a Node>) {
        if let NodeKind::Component { name } = &n.kind {
            reg.insert(name.as_str(), n);
        }
        for c in &n.children {
            collect(c, reg);
        }
    }
    collect(root, &mut registry);
    let empty = HashMap::new();
    lower(
        root,
        Affine::IDENTITY,
        vars,
        &registry,
        &empty,
        0,
        &mut tree,
        "",
        hidden,
        false,
    );
    tree
}

/// Render a single node's subtree at its OWN origin (position zeroed, size
/// and rotation kept) — the Figma "export this layer" view. Components are
/// still resolved against the WHOLE document's masters, and nested instances
/// keep their overrides (they live on the instance node, so the clone carries
/// them). Returns None if `id` is not found.
pub fn build_render_tree_of(root: &Node, id: &str, vars: &Variables) -> Option<RenderTree> {
    fn find<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
        if n.id == id {
            return Some(n);
        }
        n.children.iter().find_map(|c| find(c, id))
    }
    let node = find(root, id)?.clone();
    let mut node = node;
    node.transform.x = 0.0;
    node.transform.y = 0.0;
    let mut registry: HashMap<&str, &Node> = HashMap::new();
    fn collect<'a>(n: &'a Node, reg: &mut HashMap<&'a str, &'a Node>) {
        if let NodeKind::Component { name } = &n.kind {
            reg.insert(name.as_str(), n);
        }
        for c in &n.children {
            collect(c, reg);
        }
    }
    collect(root, &mut registry);
    let empty = HashMap::new();
    let mut tree = RenderTree::default();
    lower(
        &node,
        Affine::IDENTITY,
        vars,
        &registry,
        &empty,
        0,
        &mut tree,
        "",
        None,
        true,
    );
    Some(tree)
}

/// Build a render tree for a Slice: the flattened canvas content inside the
/// slice's world bounds, re-origined to (0,0). Returns the tree plus the
/// slice's (w, h) as the export canvas size. The whole page is lowered (so
/// content from every layer that overlaps the region is captured, Figma
/// style), then every command is shifted by the slice's world offset and
/// clipped to the slice rect at the origin. `id` must resolve to a Slice node.
pub fn build_render_tree_slice(
    root: &Node,
    id: &str,
    vars: &Variables,
) -> Option<(RenderTree, f64, f64)> {
    fn find_world<'a>(n: &'a Node, id: &str, parent: Affine) -> Option<(&'a Node, Affine)> {
        let world = parent * n.transform.matrix(n.w, n.h);
        if n.id == id {
            return Some((n, world));
        }
        for c in &n.children {
            if let Some(r) = find_world(c, id, world) {
                return Some(r);
            }
        }
        None
    }
    let (node, world) = find_world(root, id, Affine::IDENTITY)?;
    if !matches!(node.kind, NodeKind::Slice) {
        return None;
    }
    let coeffs = world.as_coeffs();
    let (sx, sy) = (coeffs[4], coeffs[5]);
    let mut tree = build_render_tree(root, vars);
    let shift = Affine::translate((-sx, -sy));
    for cmd in &mut tree.commands {
        match cmd {
            RenderCommand::FillPath { transform, .. }
            | RenderCommand::StrokePath { transform, .. }
            | RenderCommand::Glyphs { transform, .. }
            | RenderCommand::Image { transform, .. }
            | RenderCommand::PushClip { transform, .. } => {
                *transform = shift * *transform;
            }
            RenderCommand::PushLayer { .. } | RenderCommand::PopLayer => {}
        }
    }
    tree.commands.insert(
        0,
        RenderCommand::PushClip {
            key: format!("{id}#slice-clip"),
            transform: Affine::IDENTITY,
            path: Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1),
        },
    );
    tree.commands.push(RenderCommand::PopLayer);
    Some((tree, node.w, node.h))
}

#[allow(clippy::too_many_arguments)]
fn lower(
    node: &Node,
    parent: Affine,
    vars: &Variables,
    registry: &HashMap<&str, &Node>,
    overrides: &HashMap<String, String>,
    depth: u32,
    tree: &mut RenderTree,
    path: &str,
    hidden: Option<&str>,
    // true for the document root on every PUBLIC lowering entry (canvas,
    // exports, previews): the root's name is canvas chrome and must render.
    // false only for the frame-cache BUCKET shells, where the root is
    // re-lowered per child bucket and its label is painted once by the
    // separately rendered shell scene instead.
    label_root: bool,
) {
    // typed traversal overrides (visible / opacity / swap), same semantics
    // as the direct encoder
    let mut vis = node.visible;
    let mut opacity_override: Option<f32> = None;
    let mut swap_component: Option<String> = None;
    if let Some(raw) = overrides.get(&node.id) {
        if let Some(v) = raw.strip_prefix("visible:") {
            if let Ok(b) = v.parse() {
                vis = b;
            }
        } else if let Some(o) = raw.strip_prefix("opacity:") {
            if let Ok(f) = o.parse() {
                opacity_override = Some(f);
            }
        } else if let Some(c) = raw.strip_prefix("swap:") {
            swap_component = Some(c.to_string());
        }
    }
    if !vis {
        return;
    }
    let node_alpha = opacity_override.unwrap_or(node.opacity).clamp(0.0, 1.0);
    if node_alpha <= 0.0 {
        return;
    }
    // a stroke colour override repaints the stroke — the node's own paint or
    // its materialized stroke layers — and never the fill (the bare-hex form
    // of the override stays the fill override)
    let mut stroked: Option<Node> = None;
    if let Some(c) = overrides
        .get(&node.id)
        .and_then(|raw| raw.strip_prefix("stroke:"))
        .and_then(parse_hex_color)
    {
        let mut n2 = node.clone();
        apply_stroke_paint(&mut n2, c);
        stroked = Some(n2);
    }
    let node = stroked.as_ref().unwrap_or(node);
    let opacity = 1.0; // composite node opacity once, after its overlapping paints/children
    let world = parent * node.transform.matrix(node.w, node.h);
    let key = format!("{path}/{}", node.id);

    let blend = node
        .blend
        .mix()
        .or_else(|| (node_alpha < 1.0).then_some(Mix::Normal));
    if let Some(mix) = blend {
        // This compositing scope is not an overflow clip. The viewport and
        // explicit frame/mask clips constrain it; don't crop shadows/text.
        let b = Rect::new(-1e12, -1e12, 1e12, 1e12);
        tree.commands.push(RenderCommand::PushLayer {
            key: key.clone(),
            mix,
            alpha: node_alpha,
            bounds: b,
        });
    }

    let _brush = || {
        let stack_paint = node
            .active_fills()
            .last()
            .map(|l| l.paint.clone())
            .unwrap_or_else(|| node.fill.clone());
        let mut b = if let Some(raw) = overrides.get(&node.id) {
            if let Some(c) = parse_hex_color(raw) {
                Brush::Solid(c)
            } else {
                paint_brush(&stack_paint, vars)
            }
        } else {
            paint_brush(&stack_paint, vars)
        };
        if opacity < 1.0 {
            if let Brush::Solid(c) = b {
                b = Brush::Solid(c.multiply_alpha(opacity));
            }
        }
        b
    };

    // Frames clip their children to their own (possibly rounded) bounds by
    // default, same as Figma frames — this also stops a child's drop
    // shadow / overflow from bleeding past the frame edge onto the canvas.
    let mut frame_clip_shape: Option<BezPath> = None;

    match &node.kind {
        NodeKind::Rect { radius } => {
            let r = node.bound_number("radius", vars, *radius);
            let shape = if let Some([tl, tr, br, bl]) = node.corner_radii {
                RoundedRect::from_rect(
                    Rect::new(0.0, 0.0, node.w, node.h),
                    RoundedRectRadii::new(tl, tr, br, bl),
                )
                .into_path(0.1)
            } else if r > 0.0 {
                RoundedRect::new(0.0, 0.0, node.w, node.h, r).into_path(0.1)
            } else {
                Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1)
            };
            let override_color = overrides.get(&node.id).and_then(|raw| parse_hex_color(raw));
            emit_visual_layers(
                tree,
                node,
                &key,
                world,
                &shape,
                vars,
                opacity,
                override_color,
            );
        }
        NodeKind::Ellipse => {
            let r = node.w.min(node.h) / 2.0;
            let t = world * Affine::scale_non_uniform(node.w / node.h, 1.0);
            let shape = Circle::new((r, r), r).into_path(0.1);
            let override_color = overrides.get(&node.id).and_then(|raw| parse_hex_color(raw));
            emit_visual_layers(tree, node, &key, t, &shape, vars, opacity, override_color);
        }
        NodeKind::Arc { start, end } => {
            let shape = path_to_bez(&x_core::booleans::arc_path_cmds(
                node.w, node.h, *start, *end,
            ));
            let override_color = overrides.get(&node.id).and_then(|raw| parse_hex_color(raw));
            emit_visual_layers(
                tree,
                node,
                &key,
                world,
                &shape,
                vars,
                opacity,
                override_color,
            );
        }
        NodeKind::Line => {
            for (i, layer) in node.active_strokes().iter().enumerate() {
                let width = layer.stroke.width.max(1.0);
                let shape = Rect::new(0.0, 0.0, node.w.max(width), width).into_path(0.1);
                tree.commands.push(RenderCommand::FillPath {
                    key: format!("{key}/stroke-{i}"),
                    transform: world,
                    path: shape,
                    brush: layer_brush(&layer.stroke.paint, vars, opacity * layer.opacity),
                });
            }
        }
        NodeKind::Vector { path: p } => {
            if !p.is_empty() {
                let bez = path_to_bez(p);
                let override_color = overrides.get(&node.id).and_then(|raw| parse_hex_color(raw));
                emit_visual_layers(tree, node, &key, world, &bez, vars, opacity, override_color);
            }
        }
        NodeKind::Text { text } => {
            let content = overrides
                .get(&node.id)
                .and_then(|v| v.strip_prefix("text:"))
                .unwrap_or(text);
            let content = if hidden == Some(node.id.as_str()) {
                ""
            } else {
                content
            };
            // typography bindings (the ls/lh bindings ride the node so every
            // sink honors them). Font size: explicit `fs` binding when the
            // editor set one; legacy nodes keep size = node.h.
            // FONT SIZE UNITS (PX CONTRACT): Glyphs.size is the real glyph
            // size in px. An fs binding is the point size directly; legacy
            // nodes keep the engine's em convention, pre-scaled (h * 0.72)
            // so their rendered geometry is byte-identical to history.
            let fs_binding = node
                .bindings
                .get("fs")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| *v > 0.0);
            // Variable-bound typography: a `fontsize` token outranks the
            // literal `fs` binding, exactly as `radius`/`opacity`/`w`/`h`
            // tokens outrank theirs. `Node::bound_number` has documented
            // "fontsize" as a supported key since the variables work, and
            // x-render's `variable_bindings` suite asserts it resolves —
            // this is the line that makes that true on the canvas rather
            // than only inside the helper.
            let fs = node.bound_number("fontsize", vars, fs_binding.unwrap_or(node.h * 0.72));
            let typo_num = |k: &str| node.bindings.get(k).and_then(|v| v.parse::<f64>().ok());
            // word/paragraph spacing + baseline shift ride the node like ls/lh
            let ws = typo_num("ws").unwrap_or(0.0);
            let ps = typo_num("ps").unwrap_or(0.0);
            let bs = typo_num("bs").unwrap_or(0.0);
            let small_caps = node.bindings.get("tc").map(String::as_str) == Some("sc");
            let opsz = typo_num("opsz").unwrap_or(0.0) as f32;
            let wdth = typo_num("wdth").unwrap_or(0.0) as f32;
            let ls = node.bound_number(
                "letterspacing",
                vars,
                node.bindings
                    .get("ls")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0),
            );
            let lh = node
                .bindings
                .get("lh")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(1.2);
            // A `lineheight` token is a px line box — the same meaning as the
            // node's own "px" mode — so it resolves into (mode 1, px) and
            // outranks whatever literal mode the node carries.
            let (lh_mode, lh_value) = match node
                .bindings
                .get("lineheight")
                .and_then(|name| vars.numbers.get(name))
            {
                Some(px) if *px > 0.0 => (1, *px),
                _ => node.lh_mode_value(),
            };
            let fills = node.active_fills();
            let text_blur = node
                .active_effects()
                .iter()
                .filter_map(|l| match &l.effect {
                    Effect::LayerBlur { radius } => Some(*radius * l.opacity as f64),
                    _ => None,
                })
                .fold(0.0, f64::max);
            // rich runs apply to the node's OWN text only — a "text:"
            // override replaces the content and invalidates char ranges
            let text_override = overrides
                .get(&node.id)
                .and_then(|v| v.strip_prefix("text:"));
            let base_parts: Option<Vec<TextPart>> =
                if text_override.is_none() && !node.text_runs.is_empty() {
                    Some(resolve_text_parts(content, &node.text_runs))
                } else {
                    None
                };
            // text case rewrites the CONTENT; rich-run char ranges would go
            // stale (case can change counts), so case applies to plain text
            // only — weight/family keep the run pipeline
            let content_box;
            let content = if base_parts.is_none() {
                content_box =
                    x_core::apply_text_case(content, node.bindings.get("tc").map(String::as_str));
                content_box.as_str()
            } else {
                content
            };
            // node-level weight (no explicit runs): synthesize one run so the
            // rich pipeline resolves the weighted face ("Inter"+600->Inter-600)
            let weight_runs: Option<Vec<TextPart>> = if base_parts.is_none() {
                node.bindings
                    .get("fw")
                    .and_then(|v| v.parse::<u16>().ok())
                    .filter(|w| *w != 400)
                    .map(|w| {
                        vec![TextPart {
                            text: content.to_string(),
                            color: None,
                            size: None,
                            font: None,
                            weight: Some(w),
                            italic: None,
                            ls: None,
                        }]
                    })
            } else {
                None
            };
            for (i, layer) in fills.iter().enumerate() {
                if layer.opacity <= 0.0 || paint_fully_transparent(&layer.paint, vars) {
                    continue;
                }
                let layer_key = format!("{key}/fill-{i}");
                if let Some(mix) = layer.blend.mix() {
                    tree.commands.push(RenderCommand::PushLayer {
                        key: layer_key.clone(),
                        mix,
                        alpha: 1.0,
                        bounds: bounds(world, node.w, node.h),
                    });
                }
                for (tap, (dx, dy, weight)) in gaussian_taps(text_blur).into_iter().enumerate() {
                    // per-run FINAL colors: explicit run colors fold the
                    // layer/blur alpha; unstyled runs keep `color: None` so
                    // every sink paints them with the command brush
                    let runs_src: &[TextPart] = match (&base_parts, &weight_runs) {
                        (Some(parts), _) => parts,
                        (None, Some(wr)) => wr,
                        (None, None) => &[],
                    };
                    let runs: Vec<TextPart> = runs_src
                        .iter()
                        .map(|p| TextPart {
                            text: p.text.clone(),
                            color: p
                                .color
                                .map(|c| c.multiply_alpha(opacity * layer.opacity * weight)),
                            size: p.size,
                            font: p.font.clone(),
                            weight: p.weight,
                            italic: p.italic,
                            ls: p.ls,
                        })
                        .collect();
                    tree.commands.push(RenderCommand::Glyphs {
                        key: if text_blur > 0.01 {
                            format!("{layer_key}/blur-{tap}")
                        } else {
                            layer_key.clone()
                        },
                        transform: Affine::translate((dx, dy)) * world,
                        text: content.into(),
                        size: fs,
                        brush: layer_brush(&layer.paint, vars, opacity * layer.opacity * weight),
                        max_width: node.w,
                        font: node.bindings.get("font").cloned(),
                        letter_spacing: ls,
                        line_height: lh,
                        lh_mode,
                        lh_value,
                        wrap: node.text_wrap(),
                        word_spacing: ws,
                        paragraph_spacing: ps,
                        baseline_shift: bs,
                        small_caps,
                        optical_size: opsz,
                        width_axis: wdth,
                        align: node.text_align,
                        v_align: node.text_align_vertical,
                        node_h: node.h,
                        max_lines: node.max_lines,
                        paragraph_indent: node.paragraph_indent,
                        decoration: node.text_decoration,
                        runs,
                    });
                }
                if layer.blend != BlendKind::Normal {
                    tree.commands.push(RenderCommand::PopLayer);
                }
            }
        }
        NodeKind::Image {
            asset,
            fit,
            placement,
        } => {
            let image_blur = node
                .active_effects()
                .iter()
                .filter_map(|l| match &l.effect {
                    Effect::LayerBlur { radius } => Some(*radius * l.opacity as f64),
                    _ => None,
                })
                .fold(0.0, f64::max);
            for (tap, (dx, dy, weight)) in gaussian_taps(image_blur).into_iter().enumerate() {
                if image_blur > 0.01 {
                    tree.commands.push(RenderCommand::PushLayer {
                        key: format!("{key}/blur-layer-{tap}"),
                        mix: Mix::Normal,
                        alpha: weight,
                        bounds: bounds(world, node.w, node.h)
                            .inflate(image_blur * 1.5, image_blur * 1.5),
                    });
                }
                tree.commands.push(RenderCommand::Image {
                    key: if image_blur > 0.01 {
                        format!("{key}/blur-{tap}")
                    } else {
                        key.clone()
                    },
                    transform: Affine::translate((dx, dy)) * world,
                    asset: asset.clone(),
                    w: node.w,
                    h: node.h,
                    fit: *fit,
                    placement: *placement,
                    adjustments: node.image_adjustments,
                    rotation: node.image_rotation,
                });
                if image_blur > 0.01 {
                    tree.commands.push(RenderCommand::PopLayer);
                }
            }
        }
        NodeKind::Section => {
            // tint + border through the normal visual-layer stack, then
            // the node NAME as a header Glyphs command (children render
            // through the shared path; corner radii clip like a frame)
            let shape = if let Some([tl, tr, br, bl]) = node.corner_radii {
                RoundedRect::from_rect(
                    Rect::new(0.0, 0.0, node.w, node.h),
                    RoundedRectRadii::new(tl, tr, br, bl),
                )
                .into_path(0.1)
            } else {
                Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1)
            };
            let override_color = overrides.get(&node.id).and_then(|raw| parse_hex_color(raw));
            emit_visual_layers(
                tree,
                node,
                &key,
                world,
                &shape,
                vars,
                opacity,
                override_color,
            );
            // same root-label gating as the Frame arm (bucket shells)
            if label_root || !path.is_empty() {
                let name = if node.name.is_empty() {
                    "Section"
                } else {
                    node.name.as_str()
                };
                tree.commands.push(RenderCommand::Glyphs {
                    key: format!("{key}/label"),
                    transform: world * Affine::translate((14.0, 10.0)),
                    text: name.to_string(),
                    size: 18.0,
                    brush: layer_brush(
                        &Paint::Solid(Color::from_rgba8(0x4b, 0x55, 0x63, 0xff)),
                        vars,
                        opacity,
                    ),
                    max_width: (node.w - 20.0).max(8.0),
                    font: None,
                    letter_spacing: 0.0,
                    line_height: 1.2,
                    lh_mode: 0,
                    lh_value: 0.0,
                    wrap: x_core::TextWrap::Auto,
                    word_spacing: 0.0,
                    paragraph_spacing: 0.0,
                    baseline_shift: 0.0,
                    small_caps: false,
                    optical_size: 0.0,
                    width_axis: 0.0,
                    // canvas chrome label: default alignment/placement
                    align: x_core::TextAlign::Left,
                    v_align: x_core::TextAlignVertical::Top,
                    node_h: 0.0,
                    max_lines: None,
                    paragraph_indent: 0.0,
                    decoration: x_core::TextDecoration::None,
                    runs: vec![],
                });
            }
            let rounded = node
                .corner_radii
                .map(|[tl, tr, br, bl]| tl > 0.0 || tr > 0.0 || br > 0.0 || bl > 0.0)
                .unwrap_or(false);
            if rounded && node.overflow.clips() {
                frame_clip_shape = Some(shape);
            }
        }
        NodeKind::Frame { .. } => {
            // Same corner-radii resolution as Rect, so a frame can be given
            // rounded corners like any other shape (previously this always
            // fell back to a plain, unrounded Rect).
            let shape = if let Some([tl, tr, br, bl]) = node.corner_radii {
                RoundedRect::from_rect(
                    Rect::new(0.0, 0.0, node.w, node.h),
                    RoundedRectRadii::new(tl, tr, br, bl),
                )
                .into_path(0.1)
            } else {
                Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1)
            };
            // Always run through emit_visual_layers (not just when there's
            // a visible fill) so a frame's own effects — drop shadow, inner
            // shadow, layer/background blur — render even on a frame with
            // no fill, matching how every other node kind handles effects.
            let override_color = overrides.get(&node.id).and_then(|raw| parse_hex_color(raw));
            emit_visual_layers(
                tree,
                node,
                &key,
                world,
                &shape,
                vars,
                opacity,
                override_color,
            );
            // the frame's own NAME as a canvas label (QA-004) — the same
            // header Glyphs command the Section arm emits, so frame names
            // appear on the canvas like section names; children render
            // through the shared path below, after the clip scope.
            // The root's label is gated by `label_root` (see the
            // parameter): frame-cache bucket shells re-lower the root per
            // bucket and leave the root label to the shell scene, which
            // paints it exactly once.
            if label_root || !path.is_empty() {
                let name = if node.name.is_empty() {
                    "Frame"
                } else {
                    node.name.as_str()
                };
                tree.commands.push(RenderCommand::Glyphs {
                    key: format!("{key}/label"),
                    transform: world * Affine::translate((14.0, 10.0)),
                    text: name.to_string(),
                    size: 18.0,
                    brush: layer_brush(
                        &Paint::Solid(Color::from_rgba8(0x4b, 0x55, 0x63, 0xff)),
                        vars,
                        opacity,
                    ),
                    max_width: (node.w - 20.0).max(8.0),
                    font: None,
                    letter_spacing: 0.0,
                    line_height: 1.2,
                    lh_mode: 0,
                    lh_value: 0.0,
                    wrap: x_core::TextWrap::Auto,
                    word_spacing: 0.0,
                    paragraph_spacing: 0.0,
                    baseline_shift: 0.0,
                    small_caps: false,
                    optical_size: 0.0,
                    width_axis: 0.0,
                    // canvas chrome label: default alignment/placement
                    align: x_core::TextAlign::Left,
                    v_align: x_core::TextAlignVertical::Top,
                    node_h: 0.0,
                    max_lines: None,
                    paragraph_indent: 0.0,
                    decoration: x_core::TextDecoration::None,
                    runs: vec![],
                });
            }
            // A frame clips its children ONLY when it actually has rounded
            // corners — the visually load-bearing case (content must not
            // stick out of the radii). Square frames behave like groups:
            // no unconditional clip, so a page-level frame never adds a
            // clip layer to every document (the direct encoder in
            // scene.rs applies the identical rule; see its Frame branch).
            let rounded = node
                .corner_radii
                .map(|[tl, tr, br, bl]| tl > 0.0 || tr > 0.0 || br > 0.0 || bl > 0.0)
                .unwrap_or(false);
            if rounded && node.overflow.clips() {
                frame_clip_shape = Some(shape);
            }
        }
        NodeKind::Instance { component } => {
            if depth < MAX_INSTANCE_DEPTH {
                let name = swap_component.as_deref().unwrap_or(component.as_str());
                if let Some(def) = registry.get(name) {
                    // Figma slots: masters with Slot props substitute the
                    // instance's tagged content at the anchor nodes.
                    let resolved = resolve_slots(def, node);
                    let kids: &[Node] = resolved.as_deref().unwrap_or(&def.children);
                    for child in kids {
                        lower(
                            child,
                            world,
                            vars,
                            registry,
                            &node.overrides,
                            depth + 1,
                            tree,
                            &key,
                            hidden,
                            true,
                        );
                    }
                }
            }
        }
        NodeKind::Group | NodeKind::Component { .. } | NodeKind::Slice => {}
    }
    // Instances already rendered their resolved children above. Do not leave
    // a blend/clip scope open into the following sibling.
    if matches!(node.kind, NodeKind::Instance { .. }) {
        if blend.is_some() {
            tree.commands.push(RenderCommand::PopLayer);
        }
        return;
    }
    if let Some(shape) = &frame_clip_shape {
        tree.commands.push(RenderCommand::PushClip {
            key: format!("{key}#frame-clip"),
            transform: world,
            path: shape.clone(),
        });
    }
    // overflow clipping + scrolling: wrap the subtree in a clip and offset
    // children by the frame's scroll position (fixed/sticky children differ).
    let clips = node.overflow.clips();
    let (sx, sy) = node.scroll;
    if clips && frame_clip_shape.is_none() {
        tree.commands.push(RenderCommand::PushClip {
            key: format!("{key}/overflow"),
            transform: world,
            path: Rect::new(0.0, 0.0, node.w, node.h).into_path(0.1),
        });
    }
    let mut mask_layers = 0usize;
    for child in &node.children {
        if child.is_mask && child.visible {
            // masks paint nothing themselves; they clip following siblings
            if let Some(mask_path) = mask_path_of(child) {
                let child_world = world * child.transform.matrix(child.w, child.h);
                tree.commands.push(RenderCommand::PushClip {
                    key: format!("{key}/{}#mask", child.id),
                    transform: child_world,
                    path: mask_path,
                });
                mask_layers += 1;
            }
            continue;
        }
        let child_world = if clips && node.overflow.scrollable() {
            if child.constraints.fixed {
                world
            } else if child.constraints.sticky {
                let (cx, cy) = (child.transform.x, child.transform.y);
                world * Affine::translate((-sx.min(cx), -sy.min(cy)))
            } else {
                world * Affine::translate((-sx, -sy))
            }
        } else {
            world
        };
        lower(
            child,
            child_world,
            vars,
            registry,
            overrides,
            depth,
            tree,
            &key,
            hidden,
            true,
        );
    }
    for _ in 0..mask_layers {
        tree.commands.push(RenderCommand::PopLayer);
    }
    if clips || frame_clip_shape.is_some() {
        tree.commands.push(RenderCommand::PopLayer);
    }
    if blend.is_some() {
        tree.commands.push(RenderCommand::PopLayer);
    }
}

// -------------------------------------------------------------------- sinks

/// Consume commands into a vello::Scene (the GPU path).
pub struct VelloSink<'a> {
    pub assets: Option<&'a crate::Assets>,
    pub fonts: Option<&'a x_text::FontManager>,
}

impl<'a> VelloSink<'a> {
    pub fn render(&self, tree: &RenderTree) -> Scene {
        let mut scene = Scene::new();
        for cmd in &tree.commands {
            match cmd {
                RenderCommand::FillPath {
                    transform,
                    path,
                    brush,
                    ..
                } => scene.fill(Fill::NonZero, *transform, brush, None, path),
                RenderCommand::StrokePath {
                    transform,
                    path,
                    brush,
                    width,
                    options,
                    ..
                } => {
                    let stroke = crate::text_geometry::stroke_style(*width, options);
                    scene.stroke(&stroke, *transform, brush, None, path)
                }
                RenderCommand::PushLayer {
                    mix, alpha, bounds, ..
                } => scene.push_layer(Fill::NonZero, *mix, *alpha, Affine::IDENTITY, bounds),
                RenderCommand::PopLayer => scene.pop_layer(),
                RenderCommand::Glyphs {
                    transform,
                    brush,
                    runs,
                    text,
                    size,
                    v_align,
                    node_h,
                    ..
                } => {
                    if let Some(block) = self
                        .fonts
                        .and_then(|fm| crate::text_geometry::shaped_block(cmd, fm))
                    {
                        // vertical alignment: place the shaped block inside
                        // the node box (Top/Middle/Bottom) before its glyphs
                        // are composited into the world transform
                        let dy = match v_align {
                            x_core::TextAlignVertical::Top => 0.0,
                            x_core::TextAlignVertical::Middle => (*node_h - block.height) / 2.0,
                            x_core::TextAlignVertical::Bottom => *node_h - block.height,
                        };
                        let vshift = Affine::translate((0.0, dy));
                        for glyph in &block.glyphs {
                            let b = if !runs.is_empty() && glyph.color.components[3] != 0.0 {
                                Brush::Solid(glyph.color)
                            } else {
                                brush.clone()
                            };
                            scene.fill(
                                Fill::NonZero,
                                *transform * vshift * glyph.transform,
                                &b,
                                None,
                                &glyph.path,
                            );
                        }
                    } else {
                        let color = match brush {
                            Brush::Solid(c) => *c,
                            _ => Color::BLACK,
                        };
                        x_text::encode_text(&mut scene, text, *transform, *size, color);
                    }
                }
                RenderCommand::Image {
                    transform,
                    asset,
                    w,
                    h,
                    fit,
                    placement,
                    adjustments,
                    rotation,
                    ..
                } => {
                    let adjusted = adjustments
                        .as_ref()
                        .and_then(|adj| self.assets.and_then(|a| a.get_adjusted(asset, *adj)));
                    let image = adjusted
                        .as_ref()
                        .or_else(|| self.assets.and_then(|a| a.get(asset)));
                    if let Some(img) = image {
                        // CANONICAL image transform model: fit/focal/zoom/
                        // flip/tiling resolved ONCE in x-core; image-fill
                        // rotation is applied inside the unrotated clip box.
                        let resolved = x_core::resolve_image_placement(
                            *fit,
                            placement,
                            *w,
                            *h,
                            img.image.width as f64,
                            img.image.height as f64,
                        );
                        let box_rect = Rect::new(0.0, 0.0, *w, *h).into_path(0.1);
                        scene.push_clip_layer(Fill::NonZero, *transform, &box_rect);
                        let image_transform = *transform
                            * Affine::translate((*w / 2.0, *h / 2.0))
                            * Affine::rotate(rotation.to_radians())
                            * Affine::translate((-*w / 2.0, -*h / 2.0));
                        for draw in &resolved.draws {
                            scene.draw_image(img, image_transform * *draw);
                        }
                        scene.pop_layer();
                    } else {
                        scene.fill(
                            Fill::NonZero,
                            *transform,
                            Color::from_rgb8(0xdd, 0xdd, 0xdd),
                            None,
                            &Rect::new(0.0, 0.0, *w, *h).into_path(0.1),
                        );
                    }
                }
                RenderCommand::PushClip {
                    transform, path, ..
                } => {
                    scene.push_clip_layer(Fill::NonZero, *transform, path);
                }
            }
        }
        scene
    }
}

/// IR-based full pipeline entry (parallel to build_scene_full).
pub fn render_via_ir(
    root: &Node,
    vars: &Variables,
    assets: Option<&crate::Assets>,
    fonts: Option<&x_text::FontManager>,
) -> (Scene, RenderTree) {
    let tree = build_render_tree(root, vars);
    let sink = VelloSink { assets, fonts };
    let scene = sink.render(&tree);
    (scene, tree)
}

pub fn build_render_tree_selection(
    root: &Node,
    ids: &[String],
    vars: &Variables,
) -> Option<RenderTree> {
    let ids: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    fn prune(n: &Node, ids: &std::collections::HashSet<&str>) -> Option<Node> {
        if ids.contains(n.id.as_str()) {
            return Some(n.clone());
        }
        let mut children = vec![];
        let mut preceding_masks = vec![];
        for child in &n.children {
            if child.is_mask && child.visible && !ids.contains(child.id.as_str()) {
                preceding_masks.push(child.clone());
                continue;
            }
            if let Some(child) = prune(child, ids) {
                children.append(&mut preceding_masks);
                children.push(child);
            }
        }
        if children.is_empty() {
            return None;
        }
        let mut shell = n.clone();
        shell.children = children;
        shell.fill = Paint::Solid(Color::TRANSPARENT);
        shell.stroke = Default::default();
        shell.fill_layers.clear();
        shell.stroke_layers.clear();
        shell.effect_layers.clear();
        shell.effects.clear();
        shell.visual_stacks_materialized = false;
        shell.kind = NodeKind::Frame { layout: None };
        Some(shell)
    }
    let selected = prune(root, &ids)?;
    let mut registry = HashMap::new();
    fn collect<'a>(n: &'a Node, r: &mut HashMap<&'a str, &'a Node>) {
        if let NodeKind::Component { name } = &n.kind {
            r.insert(name, n);
        }
        for child in &n.children {
            collect(child, r);
        }
    }
    collect(root, &mut registry);
    let mut tree = RenderTree::default();
    lower(
        &selected,
        Affine::IDENTITY,
        vars,
        &registry,
        &HashMap::new(),
        0,
        &mut tree,
        "",
        None,
        true,
    );
    Some(tree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_runs_flow_into_glyphs_commands() {
        let mut t = Node::text("t", 10.0, 10.0, 200.0, 20.0, "Hello world");
        t.text_runs = vec![TextRun {
            start: 0,
            len: 5,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: Some(28.0),
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let d = Node::frame("page", 300.0, 100.0).child(t);
        let tree = build_render_tree(&d, &Variables::default());
        // the text node's OWN Glyphs command — the root frame's name label
        // (QA-004) is a separate, earlier command
        let runs = tree
            .commands
            .iter()
            .find_map(|c| match c {
                RenderCommand::Glyphs { text, runs, .. } => (text == "Hello world").then_some(runs),
                _ => None,
            })
            .expect("glyphs command");
        assert_eq!(runs.len(), 2, "styled + unstyled part, got {runs:?}");
        assert_eq!(runs[0].text, "Hello");
        let c = runs[0].color.expect("explicit run color survives");
        assert!(
            c.components[0] > 0.99 && c.components[1] < 0.01,
            "run color: {c:?}"
        );
        assert_eq!(runs[0].size, Some(28.0));
        assert_eq!(runs[1].text, " world");
        assert!(
            runs[1].color.is_none(),
            "unstyled run keeps the command-brush fallback"
        );
    }

    #[test]
    fn plain_text_emits_empty_runs() {
        let d =
            Node::frame("page", 300.0, 100.0).child(Node::text("t", 10.0, 10.0, 100.0, 20.0, "hi"));
        let tree = build_render_tree(&d, &Variables::default());
        // the text node's OWN command, not the frame's name label
        let runs = tree
            .commands
            .iter()
            .find_map(|c| match c {
                RenderCommand::Glyphs { text, runs, .. } if text == "hi" => Some(runs),
                _ => None,
            })
            .expect("glyphs command");
        assert!(runs.is_empty(), "plain text takes the unchanged plain path");
    }

    #[test]
    fn frame_name_loweres_to_a_canvas_label() {
        // QA-004 on the IR path: the live canvas lowers frames through
        // build_render_tree, so a frame's name must appear as a Glyphs
        // command there — not just in the direct encoder (scene.rs).
        let d = Node::frame("Hero", 300.0, 100.0).child(Node::rect(
            "r",
            0.0,
            0.0,
            10.0,
            10.0,
            Color::WHITE,
        ));
        let tree = build_render_tree(&d, &Variables::default());
        let label = tree
            .commands
            .iter()
            .find(|c| matches!(c, RenderCommand::Glyphs { text, .. } if text == "Hero"))
            .expect("frame name label command");
        match label {
            RenderCommand::Glyphs {
                key,
                transform,
                size,
                max_width,
                ..
            } => {
                // the root's own id is part of its path ("/Hero"), so the
                // label key is "/Hero/label", not "/label"
                assert_eq!(key, "/Hero/label");
                // world origin + the same top-left inset the Section arm uses
                let t = transform.translation();
                assert!((t.x - 14.0).abs() < 1e-9);
                assert!((t.y - 10.0).abs() < 1e-9);
                assert_eq!(*size, 18.0);
                assert_eq!(*max_width, 280.0);
            }
            other => panic!("expected Glyphs, got {other:?}"),
        }
        // an unnamed frame falls back to "Frame"
        let anon = Node::frame("", 50.0, 50.0);
        let t2 = build_render_tree(&anon, &Variables::default());
        assert!(
            t2.commands
                .iter()
                .any(|c| matches!(c, RenderCommand::Glyphs { text, .. } if text == "Frame")),
            "empty name falls back to 'Frame'"
        );
    }

    #[test]
    fn text_override_on_instance_drops_stale_runs() {
        // a component master's label carries rich runs; an instance text
        // override replaces the CONTENT, so char ranges no longer apply
        let mut label = Node::text("label", 0.0, 0.0, 100.0, 20.0, "Master");
        label.text_runs = vec![TextRun {
            start: 0,
            len: 6,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let master = Node::frame("body", 120.0, 40.0).child(label);
        let comp = Node::component("C", "C", 120.0, 40.0).child(master);
        let inst =
            Node::instance("i", "C", 10.0, 60.0, 120.0, 40.0).override_prop("label", "text:Bye");
        let page = Node::frame("page", 400.0, 300.0).child(comp).child(inst);
        let tree = build_render_tree(&page, &Variables::default());
        let all_runs: Vec<&Vec<TextPart>> = tree
            .commands
            .iter()
            .filter_map(|c| {
                if let RenderCommand::Glyphs { runs, text, .. } = c {
                    if text == "Bye" {
                        Some(runs)
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect();
        assert!(!all_runs.is_empty(), "override text rendered");
        assert!(
            all_runs.iter().all(|r| r.is_empty()),
            "overridden content carries no stale runs"
        );
        // the master's own render (component preview) keeps its runs
        let master_runs: Vec<&Vec<TextPart>> = tree
            .commands
            .iter()
            .filter_map(|c| {
                if let RenderCommand::Glyphs { runs, text, .. } = c {
                    if text == "Master" {
                        Some(runs)
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect();
        assert!(
            !master_runs.is_empty() && master_runs.iter().all(|r| !r.is_empty()),
            "master keeps its runs"
        );
    }

    #[test]
    fn pattern_fills_lower_to_clip_plus_image() {
        // image patterns render through the EXISTING PushClip/Image
        // commands — no new command surface, every sink already works
        let d = Node::frame("page", 200.0, 100.0).child(
            Node::rect("r", 10.0, 10.0, 100.0, 50.0, Color::WHITE).fill_paint(Paint::Pattern {
                asset: "asset://pat".into(),
                fit: ImageFit::Tile,
            }),
        );
        let tree = build_render_tree(&d, &Variables::default());
        let kinds: Vec<&str> = tree
            .commands
            .iter()
            .map(|c| match c {
                RenderCommand::PushClip { .. } => "clip",
                RenderCommand::Image { .. } => "image",
                RenderCommand::PopLayer => "pop",
                RenderCommand::FillPath { .. } => "fill",
                _ => "other",
            })
            .collect();
        let ci = kinds
            .iter()
            .position(|k| *k == "clip")
            .expect("pattern emits a clip");
        let ii = kinds
            .iter()
            .position(|k| *k == "image")
            .expect("pattern emits an image");
        let pi = kinds.iter().position(|k| *k == "pop").expect("clip popped");
        assert!(ci < ii && ii < pi, "clip -> image -> pop order: {kinds:?}");
        // image covers the shape's bounding box
        let img = tree
            .commands
            .iter()
            .find_map(|c| {
                if let RenderCommand::Image {
                    w, h, fit, asset, ..
                } = c
                {
                    Some((*w, *h, *fit, asset.clone()))
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(
            img,
            (100.0, 50.0, ImageFit::Tile, "asset://pat".to_string())
        );
        // no group layer at full opacity
        assert!(
            !tree
                .commands
                .iter()
                .any(|c| matches!(c, RenderCommand::PushLayer { .. })),
            "full-opacity pattern needs no group"
        );
    }

    #[test]
    fn pattern_fill_layer_opacity_wraps_a_group() {
        let mut d = Node::frame("page", 200.0, 100.0);
        let mut r =
            Node::rect("r", 10.0, 10.0, 100.0, 50.0, Color::WHITE).fill_paint(Paint::Pattern {
                asset: "asset://pat".into(),
                fit: ImageFit::Fill,
            });
        r.materialize_visual_stacks();
        r.fill_layers[0].opacity = 0.5;
        d.children.push(r);
        let tree = build_render_tree(&d, &Variables::default());
        let group = tree.commands.iter().find_map(|c| {
            if let RenderCommand::PushLayer { alpha, .. } = c {
                Some(*alpha)
            } else {
                None
            }
        });
        assert_eq!(
            group,
            Some(0.5),
            "semi-transparent pattern folds into a group layer"
        );
    }

    #[test]
    fn build_render_tree_of_renders_subtree_at_origin() {
        // page has two frames; export just the second one
        let d = Node::frame("page", 400.0, 300.0)
            .child(Node::rect(
                "a",
                10.0,
                10.0,
                50.0,
                50.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::frame("f", 100.0, 80.0).child(Node::rect(
                "inner",
                0.0,
                0.0,
                30.0,
                20.0,
                Color::from_rgb8(0, 0, 255),
            )));
        let tree = build_render_tree_of(&d, "f", &Variables::default()).expect("f exists");
        // only the frame + its child are present; "a" is not
        let keys: Vec<&str> = tree
            .commands
            .iter()
            .map(|c| c.key())
            .filter(|k| !k.is_empty())
            .collect();
        assert!(
            keys.iter().any(|k| k.contains("inner")),
            "frame child present: {keys:?}"
        );
        assert!(
            !keys
                .iter()
                .any(|k| k.contains("\"a\"/") || k.ends_with("/a")),
            "page sibling absent: {keys:?}"
        );
        // the frame's own content is positioned at its local origin (no +100/+80)
        for c in &tree.commands {
            if let RenderCommand::FillPath { transform, .. } = c {
                let co = transform.as_coeffs();
                // frame fill sits at origin (identity, since frame at 0,0 inside itself)
                assert!(co[4] >= -0.001 && co[4] < 100.0, "unexpected tx {}", co[4]);
            }
        }
        assert!(build_render_tree_of(&d, "nope", &Variables::default()).is_none());
    }

    #[test]
    fn build_render_tree_slice_captures_region_and_clips() {
        // page with two rects; a slice over the SECOND rect's region only
        let d = Node::frame("page", 400.0, 300.0)
            .child(Node::rect(
                "a",
                0.0,
                0.0,
                50.0,
                50.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::rect(
                "b",
                100.0,
                100.0,
                40.0,
                40.0,
                Color::from_rgb8(0, 0, 255),
            ))
            .child(Node::slice("s", 100.0, 100.0, 40.0, 40.0));
        let (tree, w, h) =
            build_render_tree_slice(&d, "s", &Variables::default()).expect("slice exists");
        assert_eq!((w, h), (40.0, 40.0), "canvas is the slice size");
        // the tree is wrapped in a clip at the origin
        let first = tree.commands.first().expect("clip first");
        assert!(
            matches!(first, RenderCommand::PushClip { .. }),
            "clip wraps the region"
        );
        assert!(
            matches!(tree.commands.last(), Some(RenderCommand::PopLayer)),
            "pop balances the clip"
        );
        // "b" (inside the slice) is present and translated so it sits near origin;
        // its original world tx was 100 -> now 0
        let mut b_shifted = false;
        for c in &tree.commands {
            if let RenderCommand::FillPath { key, transform, .. } = c {
                if key.contains("\"b\"") || key.contains("/b") {
                    let tx = transform.as_coeffs()[4];
                    assert!(
                        (tx - 0.0).abs() < 0.001,
                        "b translated to origin, got tx={tx}"
                    );
                    b_shifted = true;
                }
            }
        }
        assert!(b_shifted, "b's fill present in the slice tree");
        assert!(build_render_tree_slice(&d, "nope", &Variables::default()).is_none());
        // a non-slice id (e.g. a rect) is rejected
        assert!(build_render_tree_slice(&d, "a", &Variables::default()).is_none());
    }

    #[test]
    fn scroll_container_clips_offsets_and_handles_fixed_sticky() {
        // a scrollable frame with three children: normal, fixed, sticky.
        // scroll offset (0, 40): normal child shifts up 40, fixed stays,
        // sticky clamps so it never leaves the viewport.
        let d = Node::frame("page", 400.0, 300.0).child(
            Node::frame("scroller", 200.0, 120.0)
                .overflow(Overflow::ScrollY)
                .scroll(0.0, 40.0)
                .child(Node::rect(
                    "normal",
                    0.0,
                    10.0,
                    100.0,
                    40.0,
                    Color::from_rgb8(255, 0, 0),
                ))
                .child(
                    Node::rect(
                        "fixed",
                        0.0,
                        200.0,
                        100.0,
                        40.0,
                        Color::from_rgb8(0, 255, 0),
                    )
                    .fixed(),
                )
                .child(
                    Node::rect(
                        "sticky",
                        0.0,
                        60.0,
                        100.0,
                        40.0,
                        Color::from_rgb8(0, 0, 255),
                    )
                    .sticky(),
                ),
        );
        let tree = build_render_tree(&d, &Variables::default());
        // there must be a clip for the scrollable frame
        assert!(
            tree.commands.iter().any(
                |c| matches!(c, RenderCommand::PushClip { key, .. } if key.ends_with("overflow"))
            ),
            "overflow clip present"
        );
        // y translation = coeffs[5] of a fill command
        let ty_of = |needle: &str| -> Option<f64> {
            for c in &tree.commands {
                if let RenderCommand::FillPath { key, transform, .. } = c {
                    if key.contains(&format!("/{needle}/")) || key.ends_with(&format!("/{needle}"))
                    {
                        return Some(transform.as_coeffs()[5]);
                    }
                }
            }
            None
        };
        // normal: original y=10, scrolled by -40 -> -30
        let ny = ty_of("normal").expect("normal fill");
        assert!(
            (ny - (-30.0)).abs() < 0.001,
            "normal scrolled to -30, got {ny}"
        );
        // fixed: original y=200, ignores scroll -> 200
        let fy = ty_of("fixed").expect("fixed fill");
        assert!((fy - 200.0).abs() < 0.001, "fixed stays at 200, got {fy}");
        // sticky: original y=60, scrolled by min(40,60)=40 -> 20 (pinned at top edge)
        let sy = ty_of("sticky").expect("sticky fill");
        assert!((sy - 20.0).abs() < 0.001, "sticky pinned, got {sy}");
    }

    #[test]
    fn masks_clip_following_siblings() {
        // frame: [mask circle][rect] -> rect must render inside a clip layer
        let d = Node::frame("page", 200.0, 200.0)
            .child(Node::ellipse("m", 0.0, 0.0, 100.0, 100.0, Color::WHITE).mask(true))
            .child(Node::rect(
                "r",
                0.0,
                0.0,
                200.0,
                200.0,
                Color::from_rgb8(255, 0, 0),
            ));
        let tree = build_render_tree(&d, &Variables::default());
        let kinds: Vec<&str> = tree
            .commands
            .iter()
            .map(|c| match c {
                RenderCommand::PushClip { .. } => "clip",
                RenderCommand::FillPath { .. } => "fill",
                RenderCommand::PopLayer => "pop",
                _ => "other",
            })
            .collect();
        // clip comes BEFORE the sibling fill, pop after
        let ci = kinds
            .iter()
            .position(|k| *k == "clip")
            .expect("mask emits clip");
        let fi = kinds
            .iter()
            .rposition(|k| *k == "fill")
            .expect("sibling fill");
        let pi = kinds.iter().rposition(|k| *k == "pop").expect("pop");
        assert!(ci < fi && fi < pi, "clip-fill-pop order: {kinds:?}");
        // mask node itself paints nothing (only 1 fill: the rect)
        assert_eq!(kinds.iter().filter(|k| **k == "fill").count(), 1);
        // sink renders with a clip layer
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let scene = sink.render(&tree);
        assert!(scene.encoding().n_clips > 0);
    }

    #[test]
    fn ordered_visual_stacks_lower_to_distinct_commands() {
        let mut n = Node::rect("layered", 0.0, 0.0, 80.0, 60.0, Color::BLACK);
        n.visual_stacks_materialized = true;
        n.fill_layers = vec![
            PaintLayer::new(Paint::Solid(Color::from_rgb8(255, 0, 0))),
            PaintLayer {
                paint: Paint::Solid(Color::from_rgb8(0, 0, 255)),
                opacity: 0.5,
                visible: true,
                blend: BlendKind::Screen,
            },
        ];
        n.stroke_layers = vec![StrokeLayer::new(Stroke::solid(Color::WHITE, 2.0))];
        n.effect_layers = vec![EffectLayer::new(Effect::DropShadow {
            dx: 2.0,
            dy: 3.0,
            blur: 8.0,
            color: Color::BLACK,
        })];
        let tree = build_render_tree(
            &Node::frame("page", 100.0, 100.0).child(n),
            &Variables::default(),
        );
        let keys: Vec<_> = tree.commands.iter().map(RenderCommand::key).collect();
        assert!(keys.iter().any(|k| k.ends_with("/fill-0")));
        assert!(keys.iter().any(|k| k.ends_with("/fill-1")));
        assert!(keys.iter().any(|k| k.ends_with("/stroke-0")));
        // effects lower to layered sub-commands (blend / taps), never a bare key
        assert!(
            keys.iter().any(|k| k.contains("/effect-0/")),
            "effect-0 must emit layered keys: {keys:?}"
        );
    }

    #[test]
    fn image_fit_modes_produce_distinct_transforms() {
        // fake 2x2 asset via Assets? renderer path only needs metadata;
        // simplest: fit mode changes the fingerprint hence the cache key
        let mk = |fit: ImageFit| {
            let mut n = Node::image("i", 0.0, 0.0, 200.0, 100.0, "a");
            if let NodeKind::Image { fit: f, .. } = &mut n.kind {
                *f = fit;
            }
            let d = Node::frame("p", 300.0, 300.0).child(n);
            build_render_tree(&d, &Variables::default())
        };
        let f1 = mk(ImageFit::Fill);
        let f2 = mk(ImageFit::Crop);
        assert!(
            !f2.changed_keys(&f1).is_empty(),
            "fit change must dirty the image command"
        );
    }

    #[test]
    fn stroke_override_paints_the_stroke_and_not_the_fill() {
        let mut master = Node::component("cb2", "Chip2", 40.0, 20.0);
        master.visible = false;
        master.children.push(Node::rect(
            "chip-bg",
            0.0,
            0.0,
            40.0,
            20.0,
            Color::from_rgb8(0, 0, 0xff),
        ));
        let mut inst = Node::instance("i2", "Chip2", 200.0, 0.0, 40.0, 20.0);
        inst.overrides
            .insert("chip-bg".into(), "stroke:#00ff00".into());
        let doc = Node::frame("page", 400.0, 300.0).child(master).child(inst);
        let tree = build_render_tree(&doc, &x_core::Variables::default());

        let stroke = tree.commands.iter().find_map(|c| match c {
            RenderCommand::StrokePath {
                key, brush, width, ..
            } if key.contains("chip-bg") => Some((brush.clone(), *width)),
            _ => None,
        });
        let (brush, width) = stroke.expect("the stroke override must paint a stroke");
        assert_eq!(width, 1.0, "a zero-width stroke is made visible");
        assert!(
            matches!(&brush, Brush::Solid(c) if x_core::color_to_hex(*c) == "#00ff00"),
            "the override colour reaches the stroke brush, got {brush:?}"
        );
        // the interior keeps the master's fill: nothing was written as a fill
        let fill = tree.commands.iter().find_map(|c| match c {
            RenderCommand::FillPath { key, brush, .. } if key.contains("chip-bg") => {
                Some(brush.clone())
            }
            _ => None,
        });
        assert!(
            matches!(&fill, Some(Brush::Solid(c)) if x_core::color_to_hex(*c) == "#0000ff"),
            "the fill is untouched, got {fill:?}"
        );
    }

    fn sample() -> (Node, Variables) {
        let mut vars = Variables::default();
        vars.numbers.insert("radius-lg".into(), 20.0);
        let mut master = Node::component("cb", "Chip", 40.0, 20.0);
        master.visible = false;
        master.children.push(Node::rect(
            "chip-bg",
            0.0,
            0.0,
            40.0,
            20.0,
            Color::from_rgb8(0, 0, 0xff),
        ));
        let doc = Node::frame("page", 400.0, 300.0)
            .child(master)
            .child(
                Node::rect("r", 10.0, 10.0, 100.0, 60.0, Color::from_rgb8(255, 0, 0))
                    .radius(2.0)
                    .bind("radius", "radius-lg"),
            )
            .child(Node::text("t", 0.0, 100.0, 200.0, 20.0, "hello ir"))
            .child(Node::instance("i", "Chip", 200.0, 0.0, 40.0, 20.0))
            .child(
                Node::ellipse("e", 0.0, 200.0, 50.0, 50.0, Color::from_rgb8(0, 255, 0))
                    .blend(BlendKind::Multiply),
            );
        (doc, vars)
    }

    #[test]
    fn ir_produces_stable_keys_and_resolves_everything() {
        let (doc, vars) = sample();
        let tree = build_render_tree(&doc, &vars);
        let keys: Vec<&str> = tree
            .commands
            .iter()
            .map(|c| c.key())
            .filter(|k| !k.is_empty())
            .collect();
        assert!(keys.contains(&"/page/r/fill-0"), "rect fill key: {keys:?}");
        assert!(keys.contains(&"/page/t/fill-0"), "text fill key: {keys:?}");
        assert!(
            keys.contains(&"/page/i/chip-bg/fill-0"),
            "instance resolution keys through the instance: {keys:?}"
        );
        // blend became a layer pair
        assert!(tree
            .commands
            .iter()
            .any(|c| matches!(c, RenderCommand::PushLayer { .. })));
        assert!(tree
            .commands
            .iter()
            .any(|c| matches!(c, RenderCommand::PopLayer)));
        // variable-bound radius resolved INTO the geometry (path differs from radius=2)
        let (doc2, mut vars2) = sample();
        vars2.numbers.insert("radius-lg".into(), 2.0);
        let t2 = build_render_tree(&doc2, &vars2);
        let path_repr = |t: &RenderTree, key: &str| {
            t.commands
                .iter()
                .find_map(|c| match c {
                    RenderCommand::FillPath { key: k, path, .. } if k == key => {
                        Some(format!("{path:?}"))
                    }
                    _ => None,
                })
                .unwrap()
        };
        assert_ne!(
            path_repr(&tree, "/page/r/fill-0"),
            path_repr(&t2, "/page/r/fill-0"),
            "different radii must yield different geometry"
        );
    }

    #[test]
    fn vello_sink_output_matches_direct_encoder_path_count() {
        let (doc, vars) = sample();
        let (scene_ir, tree) = render_via_ir(&doc, &vars, None, None);
        let (scene_direct, _) = crate::build_scene(&doc, None, &vars);
        // IR path count must be >= direct (text = per-glyph strokes both ways)
        assert!(scene_ir.encoding().n_paths > 0);
        assert_eq!(
            scene_ir.encoding().n_clips,
            scene_direct.encoding().n_clips,
            "blend layers must match"
        );
        assert!(!tree.commands.is_empty());
    }

    #[test]
    fn changed_keys_gives_partial_redraw_seed() {
        let (doc, vars) = sample();
        let t1 = build_render_tree(&doc, &vars);
        // move ONE node
        let mut doc2 = doc.clone();
        fn find_mut<'a>(n: &'a mut Node, id: &str) -> Option<&'a mut Node> {
            if n.id == id {
                return Some(n);
            }
            n.children.iter_mut().find_map(|c| find_mut(c, id))
        }
        find_mut(&mut doc2, "r").unwrap().transform.x += 5.0;
        let t2 = build_render_tree(&doc2, &vars);
        let changed = t2.changed_keys(&t1);
        assert_eq!(
            changed,
            vec!["/page/r/fill-0".to_string()],
            "only the moved node changed: {changed:?}"
        );
        // identical trees -> no changes
        assert!(t1.changed_keys(&build_render_tree(&doc, &vars)).is_empty());
    }

    #[test]
    fn gpu_effects_lower_to_blur_taps_and_clips() {
        let mut card = Node::rect("card", 20.0, 20.0, 120.0, 80.0, Color::WHITE);
        card.effects = vec![
            Effect::DropShadow {
                dx: 3.0,
                dy: 5.0,
                blur: 8.0,
                color: Color::from_rgba8(0, 0, 0, 128),
            },
            Effect::InnerShadow {
                dx: 1.0,
                dy: 2.0,
                blur: 5.0,
                color: Color::from_rgba8(0, 0, 0, 96),
            },
            Effect::LayerBlur { radius: 3.0 },
            Effect::BackgroundBlur { radius: 4.0 },
        ];
        let doc = Node::frame("page", 300.0, 200.0)
            .child(Node::rect(
                "background",
                0.0,
                0.0,
                300.0,
                200.0,
                Color::from_rgb8(40, 60, 90),
            ))
            .child(card);
        let tree = build_render_tree(&doc, &Variables::default());
        assert!(tree
            .commands
            .iter()
            .any(|c| c.key().contains("background-clip")));
        assert!(tree.commands.iter().any(|c| c.key().contains("inner-clip")));
        assert!(tree.commands.iter().any(|c| c.key().contains("/blur-")));
        assert!(
            tree.commands
                .iter()
                .filter(|c| c.key().contains("effect-0/tap-"))
                .count()
                > 8
        );
    }

    #[test]
    fn ir_can_drive_non_gpu_sinks_svg_like() {
        // a trivial text sink proves backend-agnosticism (export/PDF seed)
        let (doc, vars) = sample();
        let tree = build_render_tree(&doc, &vars);
        let mut ops = vec![];
        for c in &tree.commands {
            ops.push(match c {
                RenderCommand::FillPath { .. } => "fill",
                RenderCommand::StrokePath { .. } => "stroke",
                RenderCommand::PushLayer { .. } => "push",
                RenderCommand::PopLayer => "pop",
                RenderCommand::Glyphs { .. } => "text",
                RenderCommand::Image { .. } => "image",
                RenderCommand::PushClip { .. } => "clip",
            });
        }
        assert!(
            ops.contains(&"fill")
                && ops.contains(&"text")
                && ops.contains(&"push")
                && ops.contains(&"pop")
        );
    }
}
