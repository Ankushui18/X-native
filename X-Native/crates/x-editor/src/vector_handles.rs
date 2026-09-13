//! World-space vector handle editing.
//!
//! `vector_edit` has had the full node/pen workflow for a while — move an
//! anchor, drag a bezier handle, convert a point, split a segment, all
//! undoable. What it operates on is `NodeKind::Vector { path }` in the node's
//! LOCAL coordinate space, and its hit-testers (`anchor_at`, `segment_at`)
//! take local coordinates too.
//!
//! The pointer is never in local space. A vector node sits at
//! `transform.x/y`, and can be rotated and scaled like anything else, so
//! asking "is the cursor on anchor 3?" in local coordinates answers the wrong
//! question — on a node placed at (400, 300) every handle misses by exactly
//! that offset, and once the node is rotated the handles are not merely
//! offset but on the wrong side of the shape.
//!
//! This module is the missing coordinate layer: it maps path geometry into
//! world space for hit-testing and painting, and maps the pointer back into
//! local space before handing the drag to the existing (already undoable)
//! `vector_edit` operations. No path math is duplicated here.

#[allow(unused_imports)]
use crate::*;
use crate::transformed_resize::{linear, local_point, local_to_world};
use crate::{anchors, find, Anchor, Editor};
use x_core::{Node, NodeKind, PathCmd};

/// A bezier control handle that was hit, and which side of its anchor it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandleHit {
    pub anchor: usize,
    /// false = incoming handle (c2 of the segment arriving at the anchor),
    /// true = outgoing handle (c1 of the segment leaving it).
    pub outgoing: bool,
}

/// An anchor with its world-space position, ready to paint or hit-test.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnchorWorld {
    pub index: usize,
    pub x: f64,
    pub y: f64,
}

fn path_of(n: &Node) -> Option<&[PathCmd]> {
    match &n.kind {
        NodeKind::Vector { path } => Some(path),
        _ => None,
    }
}

/// The node's anchors in world coordinates.
pub fn anchors_world(n: &Node) -> Vec<AnchorWorld> {
    let Some(path) = path_of(n) else {
        return vec![];
    };
    anchors(path)
        .into_iter()
        .enumerate()
        .map(|(index, a)| {
            let (x, y) = local_to_world(n, a.x, a.y);
            AnchorWorld { index, x, y }
        })
        .collect()
}

/// Every draggable control handle in world coordinates:
/// `(anchor index, outgoing?, world position)`.
pub fn handles_world(n: &Node) -> Vec<(usize, bool, (f64, f64))> {
    let Some(path) = path_of(n) else {
        return vec![];
    };
    let mut out = vec![];
    for (i, a) in anchors(path).into_iter().enumerate() {
        if let Some((hx, hy)) = a.in_handle {
            out.push((i, false, local_to_world(n, hx, hy)));
        }
        // the outgoing handle is c1 of the NEXT command (vector_edit's
        // addressing), which on a closed path is `Close` — no handle there
        if let Some(PathCmd::CurveTo(x1, y1, _, _, _, _)) = path.get(a.cmd_index + 1) {
            out.push((i, true, local_to_world(n, *x1, *y1)));
        }
    }
    out
}

/// The anchor under a world point, if any is within `tol` px.
pub fn anchor_at_world(n: &Node, wx: f64, wy: f64, tol: f64) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for a in anchors_world(n) {
        let d = ((a.x - wx).powi(2) + (a.y - wy).powi(2)).sqrt();
        if d <= tol && best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((a.index, d));
        }
    }
    best.map(|(i, _)| i)
}

/// The control handle under a world point, if any is within `tol` px.
/// Handles are checked before anchors by the caller's convention (they are
/// the smaller target sitting on top of the anchor's tangent line).
pub fn handle_at_world(n: &Node, wx: f64, wy: f64, tol: f64) -> Option<HandleHit> {
    let mut best: Option<(HandleHit, f64)> = None;
    for (anchor, outgoing, (hx, hy)) in handles_world(n) {
        let d = ((hx - wx).powi(2) + (hy - wy).powi(2)).sqrt();
        if d <= tol && best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((HandleHit { anchor, outgoing }, d));
        }
    }
    best.map(|(h, _)| h)
}

/// The path segment under a world point (indexing matches
/// `vector_edit::segment_at`: the END anchor of the hit segment, with 0 for
/// the implicit closing segment of a closed path).
pub fn segment_at_world(n: &Node, wx: f64, wy: f64, tol: f64) -> Option<usize> {
    let path = path_of(n)?;
    let (lx, ly) = local_point(n, wx, wy);
    // the tolerance is a SCREEN distance, so it has to shrink in local space
    // when the node is scaled up (and grow when it is scaled down)
    crate::segment_at(path, lx, ly, tol / local_scale(n))
}

/// The node's uniform world/local scale factor (rotation drops out of a
/// length; anisotropic scale is approximated by its mean).
pub fn local_scale(n: &Node) -> f64 {
    let [a, b, c, d, _, _] = linear(n).as_coeffs();
    let sx = (a * a + b * b).sqrt();
    let sy = (c * c + d * d).sqrt();
    let s = (sx + sy) / 2.0;
    if s > 1e-9 {
        s
    } else {
        1.0
    }
}

impl Editor {
    /// Pen tool click in WORLD space: append an anchor to a vector node.
    pub fn pen_add_anchor_world(&mut self, id: &str, wx: f64, wy: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let (lx, ly) = local_point(n, wx, wy);
        self.pen_add_anchor(id, lx, ly)
    }

    /// Node tool drag in WORLD space: move an anchor.
    pub fn drag_anchor_world(&mut self, id: &str, anchor: usize, wx: f64, wy: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let (lx, ly) = local_point(n, wx, wy);
        self.move_anchor(id, anchor, lx, ly)
    }

    /// Node tool drag in WORLD space: move a bezier control handle.
    /// `mirror` follows Figma — the default drag keeps the point smooth, Alt
    /// breaks the tangent (see [`Editor::move_handle`]).
    pub fn drag_handle_world(
        &mut self,
        id: &str,
        anchor: usize,
        outgoing: bool,
        wx: f64,
        wy: f64,
        mirror: bool,
    ) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let (lx, ly) = local_point(n, wx, wy);
        self.move_handle(id, anchor, outgoing, lx, ly, mirror)
    }

    /// Cut a segment at the point under the cursor (world space).
    pub fn split_segment_world(&mut self, id: &str, wx: f64, wy: f64, tol: f64) -> Option<usize> {
        let n = find(&self.root, id)?;
        let seg = segment_at_world(n, wx, wy, tol)?;
        if seg == 0 {
            // 0 addresses the implicit closing segment, which has no anchor
            // to split at
            return None;
        }
        if self.split_segment(id, seg) {
            Some(seg)
        } else {
            None
        }
    }
}

/// Convenience for the canvas: the anchors of a node in the editor's tree.
pub fn anchors_world_of(ed: &Editor, id: &str) -> Vec<AnchorWorld> {
    find(&ed.root, id).map(anchors_world).unwrap_or_default()
}

/// The `Anchor` list of a node, for callers that want the raw local data.
pub fn anchors_of(n: &Node) -> Vec<Anchor> {
    path_of(n).map(anchors).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node, PathCmd};

    fn vec_node(x: f64, y: f64, path: Vec<PathCmd>) -> Node {
        Node::vector("v", x, y, 100.0, 100.0, path)
    }

    fn curve() -> Vec<PathCmd> {
        vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::CurveTo(10.0, 0.0, 40.0, 50.0, 50.0, 50.0),
            PathCmd::CurveTo(60.0, 50.0, 90.0, 0.0, 100.0, 0.0),
        ]
    }

    #[test]
    fn anchors_land_where_the_node_was_placed() {
        let n = vec_node(400.0, 300.0, curve());
        let list = anchors_world(&n);
        assert_eq!(list.len(), 3);
        assert_eq!((list[0].x, list[0].y), (400.0, 300.0));
        assert_eq!((list[1].x, list[1].y), (450.0, 350.0));
        assert_eq!((list[2].x, list[2].y), (500.0, 300.0));
        // local hit-testing would have missed all of them
        assert_eq!(crate::anchor_at(&curve(), 400.0, 300.0, 4.0), None);
        assert_eq!(anchor_at_world(&n, 400.0, 300.0, 4.0), Some(0));
    }

    #[test]
    fn rotated_node_handles_follow_the_rotation() {
        let mut n = vec_node(0.0, 0.0, curve());
        n.transform.rotation = std::f64::consts::FRAC_PI_2;
        // anchor 1 is local (50,50) = the center, so a 90° turn about the
        // center leaves it put, while anchor 0 (local 0,0) swings to (100,0)
        let list = anchors_world(&n);
        assert!((list[1].x - 50.0).abs() < 1e-9 && (list[1].y - 50.0).abs() < 1e-9);
        assert!((list[0].x - 100.0).abs() < 1e-9 && (list[0].y - 0.0).abs() < 1e-9);
        assert_eq!(anchor_at_world(&n, 100.0, 0.0, 2.0), Some(0));
        assert_eq!(anchor_at_world(&n, 0.0, 0.0, 2.0), None, "old spot is empty");
    }

    #[test]
    fn control_handles_are_reported_on_both_sides() {
        let n = vec_node(10.0, 20.0, curve());
        let handles = handles_world(&n);
        // anchor 1 has an incoming c2 (40,50) and an outgoing c1 (60,50);
        // anchor 2 has an incoming c2 (90,0) and NO outgoing (end of path);
        // anchor 0 is a MoveTo: outgoing only
        assert_eq!(handles.len(), 4, "{handles:?}");
        assert!(handles.contains(&(0, true, (20.0, 20.0))));
        assert!(handles.contains(&(1, false, (50.0, 70.0))));
        assert!(handles.contains(&(1, true, (70.0, 70.0))));
        assert!(handles.contains(&(2, false, (100.0, 20.0))));
        // and they hit-test where they are drawn
        let hit = handle_at_world(&n, 70.0, 70.0, 2.0).unwrap();
        assert_eq!(hit, HandleHit { anchor: 1, outgoing: true });
        assert_eq!(
            handle_at_world(&n, 500.0, 500.0, 2.0),
            None,
            "far away hits nothing"
        );
    }

    #[test]
    fn a_closed_path_exposes_no_handle_on_its_closing_segment() {
        let mut path = curve();
        path.push(PathCmd::Close);
        let n = vec_node(0.0, 0.0, path);
        let handles = handles_world(&n);
        // anchor 2's next command is Close -> no outgoing handle
        assert!(!handles.iter().any(|(a, outgoing, _)| *a == 2 && *outgoing));
        // but the closing segment itself is still erasable/hittable
        assert_eq!(segment_at_world(&n, 50.0, -1.0, 3.0), Some(0));
    }

    #[test]
    fn drags_are_mapped_back_into_local_space() {
        let mut page = Node::frame("page", 800.0, 600.0);
        page.children = vec![vec_node(400.0, 300.0, curve())];
        let mut ed = Editor::new(page);

        // drag anchor 1 from world (450,350) to (455,360) == local (55,60)
        assert!(ed.drag_anchor_world("v", 1, 455.0, 360.0));
        let n = find(&ed.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!()
        };
        // exactly the local-space result vector_edit's own test expects
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 45.0, 60.0, 55.0, 60.0));
        assert_eq!(path[2], PathCmd::CurveTo(65.0, 60.0, 90.0, 0.0, 100.0, 0.0));

        // undoable, as always
        ed.undo();
        let n = find(&ed.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 40.0, 50.0, 50.0, 50.0));
    }

    #[test]
    fn handle_drags_map_through_the_placement_too() {
        let mut page = Node::frame("page", 800.0, 600.0);
        page.children = vec![vec_node(400.0, 300.0, curve())];
        let mut ed = Editor::new(page);
        // incoming handle of anchor 1, dragged to world (430,380) = local (30,80)
        assert!(ed.drag_handle_world("v", 1, false, 430.0, 380.0, false));
        let n = find(&ed.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 30.0, 80.0, 50.0, 50.0));
        // outgoing untouched because mirror is off
        assert_eq!(path[2], PathCmd::CurveTo(60.0, 50.0, 90.0, 0.0, 100.0, 0.0));
    }

    #[test]
    fn pen_clicks_use_world_coordinates() {
        let mut page = Node::frame("page", 800.0, 600.0);
        page.children = vec![vec_node(100.0, 100.0, vec![])];
        let mut ed = Editor::new(page);
        assert!(ed.pen_add_anchor_world("v", 100.0, 100.0));
        assert!(ed.pen_add_anchor_world("v", 200.0, 100.0));
        assert!(ed.pen_add_anchor_world("v", 200.0, 180.0));
        let n = find(&ed.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!()
        };
        assert_eq!(path[0], PathCmd::MoveTo(0.0, 0.0), "stored in LOCAL space");
        assert_eq!(path[1], PathCmd::LineTo(100.0, 0.0));
        assert_eq!(path[2], PathCmd::LineTo(100.0, 80.0));
    }

    #[test]
    fn split_by_click_finds_the_segment_under_the_cursor() {
        let mut page = Node::frame("page", 800.0, 600.0);
        page.children = vec![vec_node(
            200.0,
            200.0,
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)],
        )];
        let mut ed = Editor::new(page);
        // world (250,200) is the middle of the only segment
        let seg = ed.split_segment_world("v", 250.0, 200.0, 3.0).expect("hit");
        assert_eq!(seg, 1);
        let n = find(&ed.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!()
        };
        assert_eq!(path.len(), 3);
        assert_eq!(path[1], PathCmd::LineTo(50.0, 0.0));
        // a click on nothing splits nothing
        assert!(ed.split_segment_world("v", 900.0, 900.0, 3.0).is_none());
    }

    #[test]
    fn tolerances_are_screen_distances() {
        // Anchors are compared in WORLD space, so a tolerance is already a
        // screen distance: 4 screen px from an anchor is inside a 6px band
        // no matter how the node is scaled.
        let mut big = vec_node(0.0, 0.0, curve());
        big.transform.scale_x = 4.0;
        big.transform.scale_y = 4.0;
        assert!((local_scale(&big) - 4.0).abs() < 1e-9);
        let a1 = local_to_world(&big, 50.0, 50.0);
        assert_eq!(anchor_at_world(&big, a1.0 + 4.0, a1.1, 6.0), Some(1));
        assert_eq!(anchor_at_world(&big, a1.0 + 16.0, a1.1, 6.0), None);

        // `segment_at` takes LOCAL coordinates, so the screen band has to be
        // divided by the scale first. 4 local px off the line is 16 screen px
        // at 4x — a 6px screen tolerance must NOT reach it (passing 6.0
        // through unscaled would).
        let far = local_to_world(&big, 25.0, 29.0);
        assert_eq!(segment_at_world(&big, far.0, far.1, 6.0), None);
        // 1 local px off the line is 4 screen px: inside the band
        let near = local_to_world(&big, 25.0, 26.0);
        assert_eq!(segment_at_world(&big, near.0, near.1, 6.0), Some(1));

        // unscaled, the same 4px offset is 4 screen px -> inside the band
        let small = vec_node(0.0, 0.0, curve());
        assert_eq!(anchor_at_world(&small, 54.0, 50.0, 6.0), Some(1));
    }

    #[test]
    fn non_vector_nodes_have_nothing_to_edit() {
        let r = Node::rect("r", 0.0, 0.0, 50.0, 50.0, Color::BLACK);
        assert!(anchors_world(&r).is_empty());
        assert!(handles_world(&r).is_empty());
        assert_eq!(anchor_at_world(&r, 10.0, 10.0, 5.0), None);
        assert!(anchors_of(&r).is_empty());
        let mut ed = Editor::new(Node::frame("page", 100.0, 100.0).child(r));
        assert!(!ed.drag_anchor_world("r", 0, 1.0, 1.0));
        assert!(!ed.drag_handle_world("r", 0, true, 1.0, 1.0, false));
        assert!(!ed.pen_add_anchor_world("r", 1.0, 1.0));
    }
}
