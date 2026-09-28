//! One shaping key and glyph geometry for the canvas and every export sink.
use crate::{RenderCommand, RenderTree};
use std::sync::Arc;
use vello::{
    kurbo::*,
    peniko::{Brush, Color},
};

pub fn shaped_block(
    command: &RenderCommand,
    fm: &x_text::FontManager,
) -> Option<Arc<x_text::ShapedBlock>> {
    let RenderCommand::Glyphs {
        text,
        size,
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
        max_lines,
        paragraph_indent,
        decoration,
        list,
        runs,
        ..
    } = command
    else {
        return None;
    };
    let natural = x_text::resolve_natural_line_height(fm, font.as_deref(), *size).max(0.1);
    let line_height = match lh_mode {
        1 => lh_value.max(1.0) / natural,
        2 => (lh_value / 100.0 * size / natural).max(0.1),
        _ => *line_height,
    };
    // alignment: the shaper's own enum (Justified degrades to Left there)
    let align = x_text::Align::from(*align);
    let key = if runs.is_empty() {
        x_text::TextLayoutKey::new_styled(
            text,
            *size,
            *max_width,
            font.as_deref(),
            Color::WHITE,
            fm.epoch(),
            *letter_spacing,
            line_height,
            *wrap,
            *word_spacing,
            *paragraph_spacing,
            *baseline_shift,
            *small_caps,
            *optical_size,
            *width_axis,
            *lh_mode,
            align,
            *max_lines,
            *paragraph_indent,
            *decoration,
            *list,
        )
    } else {
        x_text::TextLayoutKey::new_rich(
            runs,
            *size,
            *max_width,
            font.as_deref(),
            fm.epoch(),
            *letter_spacing,
            line_height,
            *wrap,
            *word_spacing,
            *paragraph_spacing,
            *baseline_shift,
            *small_caps,
            *optical_size,
            *width_axis,
            *lh_mode,
            align,
            *max_lines,
            *paragraph_indent,
            *decoration,
            *list,
        )
    };
    x_text::ShapedTextCache::global().get_or_shape(fm, key)
}

/// Resolve typography into paths once for export geometry, including rich-run
/// colors, weight, wrapping and explicit line height. Never silently substitute
/// rectangles when an export cannot resolve a font.
pub fn outline_text(tree: &RenderTree, fonts: &x_text::FontManager) -> Result<RenderTree, String> {
    let mut commands = Vec::new();
    for command in &tree.commands {
        if let RenderCommand::Glyphs {
            key,
            transform,
            brush,
            runs,
            text,
            v_align,
            node_h,
            ..
        } = command
        {
            if text.is_empty() {
                continue;
            }
            let block = shaped_block(command, fonts)
                .ok_or_else(|| format!("cannot resolve font for {key}"))?;
            // same vertical placement the canvas sink applies (Top / Middle /
            // Bottom inside the node box) so exports agree with the screen
            let dy = match v_align {
                x_core::TextAlignVertical::Top => 0.0,
                x_core::TextAlignVertical::Middle => (*node_h - block.height) / 2.0,
                x_core::TextAlignVertical::Bottom => *node_h - block.height,
            };
            let vshift = Affine::translate((0.0, dy));
            for (i, glyph) in block.glyphs.iter().enumerate() {
                commands.push(RenderCommand::FillPath {
                    key: format!("{key}/glyph-{i}"),
                    transform: *transform * vshift * glyph.transform,
                    path: glyph.path.clone(),
                    brush: if !runs.is_empty() && glyph.color.components[3] != 0.0 {
                        Brush::Solid(glyph.color)
                    } else {
                        brush.clone()
                    },
                });
            }
        } else {
            commands.push(command.clone());
        }
    }
    Ok(RenderTree { commands })
}

/// Materialize a profiled stroke through x-core's bounded editable geometry.
///
/// Vello/tiny-skia only accept uniform-width `Stroke`s. A persisted profile is
/// therefore filled from exactly the same caps, joins, dash phase and stations
/// that Outline Stroke uses; an empty profile keeps the fast native stroke
/// path. Invalid profiles are rejected at format admission; a damaged
/// in-memory profiled stroke becomes an empty fill rather than incorrectly
/// falling back to a uniform native stroke.
pub fn variable_stroke_outline(
    path: &BezPath,
    width: f64,
    options: &x_core::StrokeOptions,
) -> Option<BezPath> {
    if options.width_profile.is_empty() {
        return None;
    }
    let mut commands = Vec::new();
    for element in path.elements() {
        match *element {
            PathEl::MoveTo(point) => commands.push(x_core::PathCmd::MoveTo(point.x, point.y)),
            PathEl::LineTo(point) => commands.push(x_core::PathCmd::LineTo(point.x, point.y)),
            PathEl::QuadTo(control, point) => {
                // Core PathCmd has cubics only. Elevate the quadratic exactly,
                // just as text outlining does, rather than flattening before
                // the common Outline Stroke implementation sees it.
                let current = match commands.last().copied() {
                    Some(x_core::PathCmd::MoveTo(x, y) | x_core::PathCmd::LineTo(x, y)) => (x, y),
                    Some(x_core::PathCmd::CurveTo(_, _, _, _, x, y)) => (x, y),
                    // A malformed in-memory path must never silently turn a
                    // variable stroke back into a uniform native stroke.
                    _ => return Some(BezPath::new()),
                };
                commands.push(x_core::PathCmd::CurveTo(
                    current.0 + (control.x - current.0) * 2.0 / 3.0,
                    current.1 + (control.y - current.1) * 2.0 / 3.0,
                    point.x + (control.x - point.x) * 2.0 / 3.0,
                    point.y + (control.y - point.y) * 2.0 / 3.0,
                    point.x,
                    point.y,
                ));
            }
            PathEl::CurveTo(a, b, point) => commands.push(x_core::PathCmd::CurveTo(
                a.x, a.y, b.x, b.y, point.x, point.y,
            )),
            PathEl::ClosePath => commands.push(x_core::PathCmd::Close),
        }
    }
    let outline = match x_core::outline_stroke_path(&commands, width, options) {
        Ok(outline) => outline,
        // A nonempty profile deliberately takes the materialized-fill path.
        // Admission normally excludes this branch; rendering an empty path is
        // safer than incorrectly painting an invalid/tapered profile as the
        // legacy uniform stroke.
        Err(_) => return Some(BezPath::new()),
    };
    let mut result = BezPath::new();
    for command in outline.path {
        match command {
            x_core::PathCmd::MoveTo(x, y) => result.move_to((x, y)),
            x_core::PathCmd::LineTo(x, y) => result.line_to((x, y)),
            x_core::PathCmd::CurveTo(a, b, c, d, x, y) => result.curve_to((a, b), (c, d), (x, y)),
            x_core::PathCmd::Close => result.close_path(),
        }
    }
    Some(result)
}

pub fn stroke_style(width: f64, options: &x_core::StrokeOptions) -> Stroke {
    let cap = |cap| match cap {
        x_core::StrokeCap::Round => Cap::Round,
        x_core::StrokeCap::Square => Cap::Square,
        _ => Cap::Butt,
    };
    let join = match options.join {
        x_core::StrokeJoin::Round => Join::Round,
        x_core::StrokeJoin::Bevel => Join::Bevel,
        x_core::StrokeJoin::Miter => Join::Miter,
    };
    let mut stroke = Stroke::new(width)
        .with_start_cap(cap(options.cap_start))
        .with_end_cap(cap(options.cap_end))
        .with_join(join)
        .with_miter_limit(options.miter_limit);
    if !options.dash.is_empty() {
        stroke = stroke.with_dashes(options.dash_offset, options.dash.iter().copied());
    }
    stroke
}

/// Materialize only variable-width strokes as filled paths.
///
/// Vello/tiny-skia/PDF's ordinary stroke operators cannot express a profile.
/// Keep uniform strokes as `StrokePath` so sinks that have native dashing and
/// gradient-stroke support retain their compact, higher-fidelity path; a
/// nonempty profile must never silently fall through to a uniform stroke.
pub fn materialize_variable_strokes(tree: &mut RenderTree) {
    for command in &mut tree.commands {
        let RenderCommand::StrokePath {
            key,
            transform,
            path,
            brush,
            width,
            options,
        } = command
        else {
            continue;
        };
        if options.width_profile.is_empty() {
            continue;
        }
        // `variable_stroke_outline` returns `Some`, including an intentionally
        // empty path for malformed in-memory profile data. Keep this total if
        // that contract changes: retaining the command is safer than a sink
        // panic, while valid nonempty profiles always take the fill route.
        let Some(outlined) = variable_stroke_outline(path, *width, options) else {
            continue;
        };
        *command = RenderCommand::FillPath {
            key: key.clone(),
            transform: *transform,
            brush: brush.clone(),
            path: outlined,
        };
    }
}

/// Outline every stroke for consumers that cannot encode any stroke operator.
///
/// This broader export helper builds on [`materialize_variable_strokes`], then
/// converts the remaining uniform strokes with kurbo's native stroker.
pub fn outline_strokes(tree: &mut RenderTree) {
    materialize_variable_strokes(tree);
    for command in &mut tree.commands {
        if let RenderCommand::StrokePath {
            key,
            transform,
            path,
            brush,
            width,
            options,
        } = command
        {
            let style = stroke_style(*width, options);
            let outlined = stroke(path.iter(), &style, &StrokeOpts::default(), 0.05);
            *command = RenderCommand::FillPath {
                key: key.clone(),
                transform: *transform,
                brush: brush.clone(),
                path: outlined,
            };
        }
    }
}

#[cfg(test)]
mod variable_stroke_tests {
    use super::*;

    #[test]
    fn profiled_dash_strokes_materialize_as_filled_paths() {
        let mut path = BezPath::new();
        path.move_to((0.0, 0.0));
        path.line_to((70.0, 0.0));
        let options = x_core::StrokeOptions {
            cap_start: x_core::StrokeCap::Round,
            cap_end: x_core::StrokeCap::Square,
            join: x_core::StrokeJoin::Round,
            dash: vec![12.0, 6.0],
            width_profile: vec![
                x_core::VariableWidthPoint {
                    position: 0.0,
                    width_multiplier: 0.5,
                },
                x_core::VariableWidthPoint {
                    position: 0.5,
                    width_multiplier: 2.0,
                },
                x_core::VariableWidthPoint {
                    position: 1.0,
                    width_multiplier: 0.75,
                },
            ],
            ..Default::default()
        };
        let outline =
            variable_stroke_outline(&path, 8.0, &options).expect("profile takes fill path");
        assert!(
            outline
                .elements()
                .iter()
                .filter(|el| matches!(el, PathEl::ClosePath))
                .count()
                >= 3,
            "each painted dash is a closed filled contour"
        );
        let bounds = outline.bounding_box();
        assert!(
            bounds.height() > 12.0,
            "mid-path width peak survives: {bounds:?}"
        );
        assert!(bounds.x0 < -1.9, "round start cap survives");

        let uniform = x_core::StrokeOptions::default();
        assert!(variable_stroke_outline(&path, 8.0, &uniform).is_none());
    }

    #[test]
    fn malformed_profile_does_not_fall_back_to_a_uniform_stroke() {
        let mut path = BezPath::new();
        path.move_to((0.0, 0.0));
        path.line_to((10.0, 0.0));
        let options = x_core::StrokeOptions {
            width_profile: vec![x_core::VariableWidthPoint {
                position: f64::NAN,
                width_multiplier: 1.0,
            }],
            ..Default::default()
        };
        let outline =
            variable_stroke_outline(&path, 2.0, &options).expect("nonempty profile is handled");
        assert!(outline.elements().is_empty());
    }
}
