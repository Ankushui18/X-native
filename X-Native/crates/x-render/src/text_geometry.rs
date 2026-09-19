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

/// Outlined strokes make transformed widths, dashes and asymmetric caps
/// portable across SVG/PDF and give export bounds the actual visual geometry.
pub fn outline_strokes(tree: &mut RenderTree) {
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
            *command = RenderCommand::FillPath {
                key: key.clone(),
                transform: *transform,
                brush: brush.clone(),
                path: stroke(path.iter(), &style, &StrokeOpts::default(), 0.05),
            };
        }
    }
}
