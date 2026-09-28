//! Offset editing is a single Rust ReplaceNode command. The geometry is
//! computed in x-core; the layer retains its identity, paint, flags and sibling
//! position. Neither the application nor the WASM adapter keeps a shadow undo.

use crate::{find, Editor};
use x_core::booleans::node_to_path;
use x_core::offset_path::offset_filled_path;
use x_core::{Node, NodeKind, Paint, PathCmd, StrokeJoin};

impl Editor {
    /// Pure, single-layer preview for the web equivalence guard. Returns the
    /// very same proposed node the command will commit; no history or root
    /// clone, and zero distance returns None. Never paints this optimistically.
    pub fn preview_filled_offset(
        &self,
        id: &str,
        distance: f64,
        join: StrokeJoin,
    ) -> Result<Option<Node>, &'static str> {
        let before = find(&self.root, id).ok_or("offset target not found")?;
        if !matches!(
            &before.kind,
            NodeKind::Rect { .. }
                | NodeKind::Ellipse
                | NodeKind::Vector { .. }
                | NodeKind::Poly { .. }
                | NodeKind::Star { .. }
        ) || !before.children.is_empty()
            || before.stroke.width != 0.0
            || !before.stroke_layers.is_empty()
            || !before.fill_layers.is_empty()
            || !before.effect_layers.is_empty()
            || !before.effects.is_empty()
            || !matches!(&before.fill, Paint::Solid(_))
        {
            return Err("offset requires a plain filled shape without a stroke or effects");
        }
        if distance == 0.0 {
            return Ok(None);
        }
        let source = node_to_path(before).ok_or("unsupported offset source")?;
        let rings = offset_filled_path(&source, distance, join)?;
        let mut next = before.clone();
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for &(x, y) in rings.iter().flatten() {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        let mut cmds = Vec::new();
        if min_x.is_finite() {
            for ring in &rings {
                for (index, &(x, y)) in ring.iter().enumerate() {
                    let (x, y) = (x - min_x, y - min_y);
                    cmds.push(if index == 0 {
                        PathCmd::MoveTo(x, y)
                    } else {
                        PathCmd::LineTo(x, y)
                    });
                }
                cmds.push(PathCmd::Close);
            }
            next.transform.x += min_x;
            next.transform.y += min_y;
            next.w = (max_x - min_x).max(1.0);
            next.h = (max_y - min_y).max(1.0);
        } else {
            // No contour survived an inward offset. The stable layer ID and
            // its position remain meaningful for undo; no inverted region.
            next.w = 1.0;
            next.h = 1.0;
        }
        next.kind = NodeKind::Vector { path: cmds };
        Ok(Some(next))
    }

    /// Commit the exact preflight result as one ReplaceNode undo step.
    pub fn offset_filled_node(
        &mut self,
        id: &str,
        distance: f64,
        join: StrokeJoin,
    ) -> Result<bool, &'static str> {
        let Some(next) = self.preview_filled_offset(id, distance, join)? else {
            return Ok(false);
        };
        let before = find(&self.root, id).ok_or("offset target not found")?.clone();
        self.push_replace(id, Box::new(before), next);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    #[test]
    fn all_five_shapes_keep_paint_and_identity_across_one_undo_step() {
        let shapes = [
            Node::rect("target", 10.0, 20.0, 100.0, 80.0, Color::BLACK),
            Node::ellipse("target", 10.0, 20.0, 100.0, 80.0, Color::BLACK),
            Node::poly("target", 10.0, 20.0, 100.0, 80.0, 5, Color::BLACK),
            Node::star("target", 10.0, 20.0, 100.0, 80.0, 5, 0.4, Color::BLACK),
            Node::vector(
                "target",
                10.0,
                20.0,
                100.0,
                80.0,
                vec![
                    PathCmd::MoveTo(0.0, 0.0),
                    PathCmd::LineTo(100.0, 0.0),
                    PathCmd::LineTo(100.0, 80.0),
                    PathCmd::LineTo(0.0, 80.0),
                    PathCmd::Close,
                ],
            ),
        ];
        for shape in shapes {
            let original = shape.clone();
            let mut editor = Editor::new(Node::frame("page", 400.0, 300.0).child(shape));
            assert_eq!(
                editor.offset_filled_node("target", 5.0, StrokeJoin::Round),
                Ok(true)
            );
            assert_eq!(editor.undo_depth(), 1);
            let result = find(&editor.root, "target").unwrap();
            assert_eq!(result.id, original.id);
            assert_eq!(result.fill, original.fill);
            assert!(
                matches!(&result.kind, NodeKind::Vector { path } if path.last() == Some(&PathCmd::Close))
            );
            assert!(editor.undo());
            let restored = find(&editor.root, "target").unwrap();
            assert_eq!(restored.kind, original.kind);
            assert_eq!(restored.transform, original.transform);
            assert_eq!((restored.w, restored.h), (original.w, original.h));
            assert_eq!(restored.fill, original.fill);
            assert!(editor.redo());
            assert!(matches!(
                &find(&editor.root, "target").unwrap().kind,
                NodeKind::Vector { .. }
            ));
        }
    }

    #[test]
    fn no_op_and_invalid_geometry_never_push_history() {
        let mut editor = Editor::new(Node::frame("page", 80.0, 80.0).child(Node::rect(
            "box",
            0.0,
            0.0,
            10.0,
            10.0,
            Color::BLACK,
        )));
        assert_eq!(
            editor.offset_filled_node("box", 0.0, StrokeJoin::Miter),
            Ok(false)
        );
        assert!(editor
            .offset_filled_node("box", f64::NAN, StrokeJoin::Miter)
            .is_err());
        assert_eq!(editor.undo_depth(), 0);
        assert!(editor
            .offset_filled_node("box", -10.0, StrokeJoin::Bevel)
            .unwrap());
        assert!(
            matches!(&find(&editor.root, "box").unwrap().kind, NodeKind::Vector { path } if path.is_empty())
        );
        assert!(editor.undo());
        assert!(matches!(
            find(&editor.root, "box").unwrap().kind,
            NodeKind::Rect { .. }
        ));
    }
}
