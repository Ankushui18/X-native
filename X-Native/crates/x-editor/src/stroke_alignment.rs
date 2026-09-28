//! Undoable rectangle stroke styles. The two geometric boundaries are
//! calculated by x-core and sent as a bounded projection by DocumentSession;
//! there is no second document or web-side stroke history.

use crate::{find, Editor};
use x_core::stroke_alignment::aligned_stroke_band;
use x_core::{Color, NodeKind, Paint, PaintLayer, Stroke, StrokeAlign, StrokeJoin, StrokeLayer};

impl Editor {
    /// Set a single, solid, uniform stroke on a plain rectangle. Zero width
    /// removes the stroke. Unsupported layer stacks are refused, not flattened.
    /// The style lives in both the legacy stroke and the materialized stack so
    /// native painting, .x checkpoints and web decoding all see the same edit.
    pub fn set_aligned_rect_stroke(
        &mut self,
        id: &str,
        width: f64,
        color: Color,
        align: StrokeAlign,
        join: StrokeJoin,
    ) -> Result<bool, &'static str> {
        let node = find(&self.root, id).ok_or("stroke target not found")?;
        if !matches!(&node.kind, NodeKind::Rect { radius } if *radius == 0.0)
            || !node.children.is_empty()
            || !matches!(&node.fill, Paint::Solid(_))
            || !node.effects.is_empty()
            || !node.effect_layers.is_empty()
            || node.stroke_layers.len() > 1
            || node.fill_layers.len() > 1
            || node.corner_radii.is_some()
            || node.corner_smoothing != 0.0
        {
            return Err("stroke edit requires one plain rectangle");
        }
        if node.visual_stacks_materialized {
            let Some(layer) = node.stroke_layers.first() else {
                return Err("stroke edit cannot flatten an unrelated materialized stack");
            };
            let mut canonical = StrokeLayer::new(node.stroke.clone());
            canonical.options.align = layer.options.align;
            canonical.options.join = layer.options.join;
            if node.fill_layers.len() != 1
                || node.fill_layers[0] != PaintLayer::new(node.fill.clone())
                || node.stroke_layers.len() != 1
                || node.stroke_layers[0] != canonical
                || layer.options.join == StrokeJoin::Round
            {
                return Err("stroke edit cannot flatten an unrelated materialized stack");
            }
        } else if !node.fill_layers.is_empty() || !node.stroke_layers.is_empty() {
            return Err("stroke edit cannot flatten an unrelated materialized stack");
        }
        if !width.is_finite() || !(0.0..=2048.0).contains(&width) || color.to_rgba8().a != 255 {
            return Err("stroke width/color must be finite, bounded and opaque");
        }
        if join == StrokeJoin::Round {
            return Err("round joins require a separate geometry proof");
        }
        if width > 0.0 {
            let corners = [(0.0, 0.0), (node.w, 0.0), (node.w, node.h), (0.0, node.h)];
            aligned_stroke_band(&corners, width, align, join, 4.0)?;
        }
        let mut after = node.clone();
        if width == 0.0 {
            after.stroke = Stroke::default();
            after.stroke_layers.clear();
            after.fill_layers.clear();
            after.visual_stacks_materialized = false;
        } else {
            after.stroke = Stroke::solid(color, width);
            after.visual_stacks_materialized = true;
            after.fill_layers = vec![PaintLayer::new(after.fill.clone())];
            let mut layer = StrokeLayer::new(after.stroke.clone());
            layer.options.align = align;
            layer.options.join = join;
            after.stroke_layers = vec![layer];
        }
        if after.stroke == node.stroke
            && after.stroke_layers == node.stroke_layers
            && after.fill_layers == node.fill_layers
            && after.visual_stacks_materialized == node.visual_stacks_materialized
        {
            return Ok(false);
        }
        Ok(self.replace_node(id, after))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::Node;

    #[test]
    fn style_is_one_undo_step_and_no_op_does_not_push_history() {
        let root = Node::frame("root", 400.0, 300.0).child(Node::rect("box", 10.0, 20.0, 100.0, 80.0, Color::WHITE));
        let mut editor = Editor::new(root);
        let set = |editor: &mut Editor| editor.set_aligned_rect_stroke("box", 12.0, Color::BLACK, StrokeAlign::Outside, StrokeJoin::Bevel);
        assert_eq!(set(&mut editor), Ok(true));
        assert_eq!(set(&mut editor), Ok(false));
        assert_eq!(editor.undo_depth(), 1);
        assert!(editor.undo());
        assert_eq!(find(&editor.root, "box").unwrap().stroke.width, 0.0);
        assert!(editor.redo());
        let node = find(&editor.root, "box").unwrap();
        assert_eq!(node.stroke.width, 12.0);
        assert_eq!(node.stroke_layers[0].options.align, StrokeAlign::Outside);
        assert_eq!(node.stroke_layers[0].options.join, StrokeJoin::Bevel);
        assert!(node.visual_stacks_materialized);
        assert_eq!(editor.set_aligned_rect_stroke("box", 0.0, Color::BLACK, StrokeAlign::Center, StrokeJoin::Miter), Ok(true));
        assert!(find(&editor.root, "box").unwrap().stroke_layers.is_empty());
    }
}
