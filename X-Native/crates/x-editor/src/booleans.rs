//! Editor integration for vector booleans. The geometry core lives in
//! `x_core::booleans` (shared with the format importers — Sketch boolean
//! shapeGroups flatten through it); this module keeps the historical
//! `x_editor::booleans` path alive and adds the undoable editor command.

pub use x_core::booleans::{
    boolean, boolean_paths, boolean_with, node_to_path, path_is_closed, path_to_polylines,
    stroke_outline, Backend, BoolOp, BooleanResult, PositionedPath,
};

use crate::{find, parent_id, Command, Editor};
use x_core::Node;
use x_core::{NodeKind, PathCmd};

impl Editor {
    /// Boolean the two selected nodes -> one new Vector node (undoable).
    /// Keeps the FIRST node's fill; deletes both inputs.
    pub fn boolean_selected(&mut self, op: BoolOp) -> Option<String> {
        if self.selection.len() != 2 {
            return None;
        }
        let (ida, idb) = (self.selection[0].clone(), self.selection[1].clone());
        let na = find(&self.root, &ida)?.clone();
        let nb = find(&self.root, &idb)?.clone();
        let pa = node_to_path(&na)?;
        let pb = node_to_path(&nb)?;
        let res = boolean(
            op,
            &PositionedPath {
                cmds: pa,
                offset: (na.transform.x, na.transform.y),
            },
            &PositionedPath {
                cmds: pb,
                offset: (nb.transform.x, nb.transform.y),
            },
        );
        let (path, origin, size) = (res.cmds, res.origin, res.size);
        if path.is_empty() {
            return None;
        }
        let new_id = x_core::fresh_id("bool");
        let mut v = Node::vector(&new_id, 0.0, 0.0, size.0, size.1, path);
        v.transform.x = origin.0;
        v.transform.y = origin.1;
        v.fill = na.fill.clone();
        // undoable: delete both inputs, insert result (snapshot style)
        let parent_id = self.root.id.clone();
        let idx_a = self.root.children.iter().position(|c| c.id == ida)?;
        let node_a = self.root.children[idx_a].clone();
        let idx_b0 = self.root.children.iter().position(|c| c.id == idb)?;
        let node_b = self.root.children[idx_b0].clone();
        // delete higher index first
        let (first, second) = if idx_a > idx_b0 {
            (idx_a, idx_b0)
        } else {
            (idx_b0, idx_a)
        };
        let (nfirst, nsecond) = if idx_a > idx_b0 {
            (node_a.clone(), node_b.clone())
        } else {
            (node_b.clone(), node_a.clone())
        };
        self.push_cmds(vec![
            Command::Delete {
                parent_id: parent_id.clone(),
                index: first,
                node: nfirst,
            },
            Command::Delete {
                parent_id: parent_id.clone(),
                index: second,
                node: nsecond,
            },
            Command::Insert {
                parent_id,
                index: second,
                node: v,
            },
        ]);
        self.selection = vec![new_id.clone()];
        Some(new_id)
    }

    /// Replace one child of `parent` with `node` at the same index,
    /// undoable, and select the new node.
    fn replace_child(&mut self, parent: &str, id: &str, node: Node) -> Option<String> {
        let (idx, old) = {
            let p = find(&self.root, parent)?;
            let idx = p.children.iter().position(|c| c.id == id)?;
            (idx, p.children[idx].clone())
        };
        let new_id = node.id.clone();
        self.push_cmds(vec![
            Command::Delete {
                parent_id: parent.to_string(),
                index: idx,
                node: old,
            },
            Command::Insert {
                parent_id: parent.to_string(),
                index: idx,
                node,
            },
        ]);
        self.selection = vec![new_id.clone()];
        Some(new_id)
    }

    /// Flatten Selection (Figma): bake a shape primitive or a group of
    /// shapes into ONE editable vector path. Returns the new node id
    /// (None = nothing to flatten: already a path, or non-shape content).
    pub fn flatten_selected(&mut self) -> Option<String> {
        if self.selection.len() != 1 {
            return None;
        }
        let id = self.selection[0].clone();
        let n = find(&self.root, &id)?.clone();
        let parent = parent_id(&self.root, &id)?;
        let mut subs: Vec<Vec<PathCmd>> = vec![];
        match &n.kind {
            NodeKind::Vector { .. } => return None, // already flat
            NodeKind::Group => {
                fn collect(node: &Node, ox: f64, oy: f64, subs: &mut Vec<Vec<PathCmd>>) {
                    let (cx, cy) = (ox + node.transform.x, oy + node.transform.y);
                    if let Some(p) = node_to_path(node) {
                        subs.push(p.into_iter().map(|c| c_shift(c, cx, cy)).collect());
                    }
                    for c in &node.children {
                        collect(c, cx, cy, subs);
                    }
                }
                for c in &n.children {
                    collect(c, n.transform.x, n.transform.y, &mut subs);
                }
            }
            _ => subs.push(node_to_path(&n)?),
        }
        if subs.is_empty() {
            return None;
        }
        // bounds over every subpath's points
        let (mut minx, mut miny, mut maxx, mut maxy) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        let mut see = |x: f64, y: f64| {
            minx = minx.min(x);
            miny = miny.min(y);
            maxx = maxx.max(x);
            maxy = maxy.max(y);
        };
        for sub in &subs {
            for c in sub {
                match *c {
                    PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => see(x, y),
                    PathCmd::CurveTo(a, b, _, _, x, y) => {
                        see(a, b);
                        see(x, y);
                    }
                    PathCmd::Close => {}
                }
            }
        }
        let cmds: Vec<PathCmd> = subs
            .into_iter()
            .flat_map(|sub| {
                sub.into_iter()
                    .map(|c| c_shift(c, -minx, -miny))
                    .collect::<Vec<_>>()
            })
            .collect();
        // a fresh id, NOT one derived from the undo depth: two flattens at the
        // same depth would otherwise mint the same id, and a duplicate id makes
        // every `find` in the engine ambiguous
        let new_id = x_core::fresh_id("flat");
        let mut v = Node::vector(
            &new_id,
            0.0,
            0.0,
            (maxx - minx).max(1.0),
            (maxy - miny).max(1.0),
            cmds,
        );
        v.transform.x = minx;
        v.transform.y = miny;
        v.name = n.name.clone();
        v.fill = n.fill.clone();
        v.stroke = n.stroke.clone();
        // flattening must not silently drop the layer's other appearance: the
        // opacity and the effect stack always travel with the baked path, and a
        // single shape's paint stacks travel too. A GROUP's stacks describe the
        // group, not its children's geometry, so they are left behind rather
        // than being applied twice.
        v.opacity = n.opacity;
        v.effects = n.effects.clone();
        v.effect_layers = n.effect_layers.clone();
        if !matches!(n.kind, NodeKind::Group) {
            v.fill_layers = n.fill_layers.clone();
            v.stroke_layers = n.stroke_layers.clone();
            v.visual_stacks_materialized = n.visual_stacks_materialized;
        }
        self.replace_child(&parent, &id, v)
    }

    /// Outline Stroke (Figma): replace the single selected shape with its
    /// stroke's outline. Returns the new node id (None when the selection is not
    /// exactly one node, or that node refuses outlining).
    pub fn outline_stroke_selected(&mut self) -> Option<String> {
        if self.selection.len() != 1 {
            return None;
        }
        let id = self.selection[0].clone();
        self.outline_stroke_node(&id)
    }

    /// Outline Stroke for an EXPLICIT node — the same operation the selection
    /// entry point performs, addressable by id so the canvas menu, the keyboard
    /// shortcut and vector-edit mode can all reach it without touching the
    /// selection. Replaces the node with its stroke's outline as a filled vector
    /// path (miter joins, butt caps; the fill takes the stroke's paint, and the
    /// stroke itself goes away). Returns the new node id, or None when the node
    /// is missing, has no path geometry, or has no stroke width to outline.
    pub fn outline_stroke_node(&mut self, id: &str) -> Option<String> {
        let n = find(&self.root, id)?.clone();
        let parent = parent_id(&self.root, id)?;
        if n.stroke.width <= 0.0 {
            return None;
        }
        let cmds = node_to_path(&n)?;
        let closed = path_is_closed(&cmds);
        let mut out: Vec<PathCmd> = vec![];
        for poly in path_to_polylines(&cmds, 12) {
            out.extend(stroke_outline(&poly, n.stroke.width, closed));
        }
        if out.is_empty() {
            return None;
        }
        let (mut minx, mut miny, mut maxx, mut maxy) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for c in &out {
            match *c {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
                    minx = minx.min(x);
                    miny = miny.min(y);
                    maxx = maxx.max(x);
                    maxy = maxy.max(y);
                }
                _ => {}
            }
        }
        let new_id = format!("outline-{}", self.undo_depth());
        let mut v = Node::vector(
            &new_id,
            0.0,
            0.0,
            (maxx - minx).max(1.0),
            (maxy - miny).max(1.0),
            out.into_iter().map(|c| c_shift(c, -minx, -miny)).collect(),
        );
        v.transform.x = minx + n.transform.x;
        v.transform.y = miny + n.transform.y;
        v.fill = n.stroke.paint.clone();
        self.replace_child(&parent, id, v)
    }
}

/// Translate a PathCmd by (dx, dy). Shared with `vector_edit` (join/offset
/// move paths between node-local spaces), so it is crate-visible rather than
/// a second copy of the same match.
pub(crate) fn c_shift(c: PathCmd, dx: f64, dy: f64) -> PathCmd {
    match c {
        PathCmd::MoveTo(x, y) => PathCmd::MoveTo(x + dx, y + dy),
        PathCmd::LineTo(x, y) => PathCmd::LineTo(x + dx, y + dy),
        PathCmd::CurveTo(a, b, e, f, x, y) => {
            PathCmd::CurveTo(a + dx, b + dy, e + dx, f + dy, x + dx, y + dy)
        }
        PathCmd::Close => PathCmd::Close,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, NodeKind, PathCmd};

    #[test]
    fn flatten_group_bakes_children_into_one_vector() {
        let mut g = x_core::Node::group("g", 0.0, 0.0);
        g.transform.x = 100.0;
        g.transform.y = 50.0;
        let mut r = x_core::Node::rect("r", 0.0, 0.0, 40.0, 20.0, Color::from_rgb8(255, 0, 0));
        r.transform.x = 10.0;
        r.transform.y = 20.0;
        let mut e = x_core::Node::ellipse("e", 0.0, 0.0, 30.0, 30.0, Color::from_rgb8(0, 0, 255));
        e.transform.x = 60.0;
        e.transform.y = 10.0;
        g.children = vec![r, e];
        let page = x_core::Node::frame("page", 400.0, 300.0).child(g);
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["g".into()];
        let id = ed.flatten_selected().expect("flatten");
        assert_eq!(ed.selection, vec![id.clone()], "new node selected");
        let n = crate::find(&ed.root, &id).unwrap();
        // same parent, same slot
        assert_eq!(n.id, "flat-0");
        assert_eq!(ed.root.children.len(), 1, "group replaced in place");
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        // rect contributed 4 LineTo + Close, ellipse 4 curves + Close
        assert_eq!(
            path.iter().filter(|c| matches!(c, PathCmd::Close)).count(),
            2
        );
        assert!(path.iter().any(|c| matches!(c, PathCmd::CurveTo(..))));
        // r sits at group(100,50)+own(10,20) = (110,70); normalized path
        // starts at 0 and the node carries the min corner
        assert_eq!(n.transform.x, 110.0);
        assert_eq!(n.transform.y, 60.0); // min(70, 50+10)
                                         // fill preserved from the group
        assert_eq!(n.fill, x_core::Node::group("x", 0.0, 0.0).fill);
    }

    #[test]
    fn flatten_vector_is_noop_and_line_flattens() {
        let page = x_core::Node::frame("page", 400.0, 300.0)
            .child(x_core::Node::line("l", 5.0, 10.0, 30.0, 40.0, Color::BLACK))
            .child(x_core::Node::vector(
                "v",
                0.0,
                0.0,
                10.0,
                10.0,
                vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(10.0, 0.0)],
            ));
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["v".into()];
        assert!(ed.flatten_selected().is_none(), "already a vector: no-op");
        ed.selection = vec!["l".into()];
        let id = ed.flatten_selected().expect("line flattens");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        assert_eq!(
            path,
            &vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(30.0, 40.0)]
        );
    }

    #[test]
    fn outline_stroke_turns_line_into_thick_poly() {
        let mut l = x_core::Node::line("l", 0.0, 0.0, 20.0, 0.0, Color::BLACK);
        l.stroke.paint = x_core::Paint::Solid(x_core::Color::from_rgb8(9, 8, 7));
        l.stroke.width = 4.0;
        let page = x_core::Node::frame("page", 400.0, 300.0).child(l);
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["l".into()];
        let id = ed.outline_stroke_selected().expect("outline");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        // filled band: 4 corners (MoveTo + 3 LineTo + Close), one
        // stroke-width tall, normalized to the min corner
        assert_eq!(path.len(), 5);
        assert_eq!(n.w, 20.0);
        assert!((n.h - 4.0).abs() < 1e-9, "band is one stroke-width tall");
        assert_eq!(
            n.fill,
            x_core::Paint::Solid(x_core::Color::from_rgb8(9, 8, 7))
        );
        assert_eq!(n.stroke.width, 0.0, "no stroke on the outline itself");
    }

    #[test]
    fn outline_stroke_closed_makes_ring_and_zero_width_noop() {
        let mut r = x_core::Node::rect("r", 0.0, 0.0, 20.0, 20.0, Color::BLACK);
        r.stroke.paint = x_core::Paint::Solid(Color::BLACK);
        r.stroke.width = 2.0;
        let page = x_core::Node::frame("page", 400.0, 300.0).child(r);
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["r".into()];
        let id = ed.outline_stroke_selected().expect("outline");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        // rect is closed -> two subpaths (outer + reversed inner)
        assert_eq!(
            path.iter().filter(|c| matches!(c, PathCmd::Close)).count(),
            2
        );
        assert!(ed.undo(), "undo restores the rect");
        assert_eq!(ed.root.children[0].id, "r", "undo restores the rect");
        // zero-width stroke -> no-op
        ed.root.children[0].stroke.width = 0.0;
        ed.selection = vec!["r".into()];
        assert!(ed.outline_stroke_selected().is_none());
    }

    #[test]
    fn arc_flattens_and_outlines() {
        let mut a = x_core::Node::arc("a", 0.0, 0.0, 100.0, 100.0, 0.0, 270.0, Color::BLACK);
        a.stroke.paint = x_core::Paint::Solid(Color::from_rgb8(1, 2, 3));
        a.stroke.width = 6.0;
        let page = x_core::Node::frame("page", 400.0, 300.0).child(a);
        let mut ed = crate::Editor::new(page);

        // flatten: arc -> editable vector, 3 quarter curves
        ed.selection = vec!["a".into()];
        let id = ed.flatten_selected().expect("flatten arc");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        assert_eq!(
            path.iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count(),
            3,
            "270-deg sweep -> 3 curve segments"
        );
        assert!(!path.iter().any(|c| matches!(c, PathCmd::Close)));

        // outline stroke on a fresh arc: filled band, stroke paint as fill
        let mut b = x_core::Node::arc("b", 0.0, 0.0, 100.0, 100.0, 0.0, 180.0, Color::BLACK);
        b.stroke.paint = x_core::Paint::Solid(Color::from_rgb8(4, 5, 6));
        b.stroke.width = 4.0;
        let page2 = x_core::Node::frame("page", 400.0, 300.0).child(b);
        let mut ed2 = crate::Editor::new(page2);
        ed2.selection = vec!["b".into()];
        let id2 = ed2.outline_stroke_selected().expect("outline arc");
        let n2 = crate::find(&ed2.root, &id2).unwrap();
        let x_core::NodeKind::Vector { path: p2 } = &n2.kind else {
            panic!("not a vector")
        };
        // open arc -> one closed quad band
        assert_eq!(p2.iter().filter(|c| matches!(c, PathCmd::Close)).count(), 1);
        assert_eq!(
            n2.fill,
            x_core::Paint::Solid(Color::from_rgb8(4, 5, 6)),
            "outline takes the stroke paint"
        );
    }

    #[test]
    fn booleans_2_0_default_backend_preserves_curves_end_to_end() {
        // ellipse ∪ rect through the DEFAULT backend: the result path must
        // still contain CurveTo commands (the old polygon default emitted
        // only LineTo) — this is the review's "Bezier output" requirement
        // verified at the boolean_selected level the app actually calls.
        let page = x_core::Node::frame("page", 400.0, 300.0)
            .child(x_core::Node::ellipse(
                "e",
                40.0,
                40.0,
                120.0,
                120.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(x_core::Node::rect(
                "r",
                100.0,
                40.0,
                120.0,
                120.0,
                Color::from_rgb8(0, 0, 255),
            ));
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["e".into(), "r".into()];
        let id = ed.boolean_selected(BoolOp::Union).expect("union");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        let curves = path
            .iter()
            .filter(|c| matches!(c, PathCmd::CurveTo(..)))
            .count();
        assert!(
            curves >= 2,
            "union of ellipse+rect keeps {curves} real curve segments"
        );
        // and a SECOND boolean on the result still preserves curves
        // (the anti-degradation property, applied through the real API)
        let idx = ed.root.children.iter().position(|c| c.id == id).unwrap();
        let mut bite = x_core::Node::rect("bite", 60.0, 90.0, 40.0, 40.0, Color::BLACK);
        bite.transform.x = 60.0;
        bite.transform.y = 90.0;
        ed.root.children.insert(idx, bite);
        ed.selection = vec![id.clone(), "bite".into()];
        let id2 = ed.boolean_selected(BoolOp::Subtract).expect("second op");
        let n2 = crate::find(&ed.root, &id2).unwrap();
        let x_core::NodeKind::Vector { path: p2 } = &n2.kind else {
            panic!()
        };
        let curves2 = p2
            .iter()
            .filter(|c| matches!(c, PathCmd::CurveTo(..)))
            .count();
        assert!(
            curves2 >= 2,
            "second-generation boolean still has {curves2} curves"
        );
    }

    #[test]
    fn editor_boolean_replaces_selection_undoably() {
        let mut e = Editor::new(
            Node::frame("page", 400.0, 300.0)
                .child(Node::rect(
                    "a",
                    10.0,
                    10.0,
                    100.0,
                    100.0,
                    Color::from_rgb8(255, 0, 0),
                ))
                .child(Node::ellipse(
                    "b",
                    60.0,
                    10.0,
                    100.0,
                    100.0,
                    Color::from_rgb8(0, 255, 0),
                )),
        );
        e.selection = vec!["a".into(), "b".into()];
        let id = e.boolean_selected(BoolOp::Union).expect("union");
        assert!(find(&e.root, "a").is_none() && find(&e.root, "b").is_none());
        let v = find(&e.root, &id).unwrap();
        assert!(matches!(&v.kind, NodeKind::Vector { path } if !path.is_empty()));
        assert!(
            matches!(&v.fill, x_core::Paint::Solid(c) if c.to_rgba8().r == 255),
            "keeps A's fill"
        );
        // one undo restores both inputs and removes the result
        e.undo();
        assert!(find(&e.root, "a").is_some() && find(&e.root, "b").is_some());
        assert!(find(&e.root, &id).is_none());
    }
}
