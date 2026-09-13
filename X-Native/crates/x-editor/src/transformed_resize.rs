//! Transformed resize: corner-drag geometry that respects a node's transform.
//!
//! `Command::Resize` only writes `w`/`h` and leaves `transform.x`/`y` alone.
//! That is exactly right while `rotation == 0`, and wrong the moment a layer
//! is rotated: the box grows along the node's LOCAL axes, so the corner the
//! designer is NOT dragging — the one they expect to stay pinned — swings
//! away, and the shape slides off its own selection outline.
//!
//! The fix is to do the drag math in the node's local frame and then solve
//! for the position that keeps the anchor corner fixed in WORLD space:
//!
//! ```text
//! W(q) = (x + ox·w, y + oy·h) + M · (q − (ox·w, oy·h))     M = R·S·K
//! A    = W(anchor)                                          (world, pinned)
//! x'   = A.x − ox·w' − [M · ((ax−ox)·w', (ay−oy)·h')].x     (same for y')
//! ```
//!
//! `M` is the node's linear part (rotation · scale · skew) — the same matrix
//! `Transform::matrix` builds, minus its translation — so resizing stays
//! consistent with what the renderer draws.
//!
//! Everything here is pure geometry plus one undoable editor op, so it is
//! testable headlessly (no window, no display).

#[allow(unused_imports)]
use crate::*;
use crate::{find, Command, Corner, Editor};
use x_core::{Affine, Node, Point};

/// The result of a corner drag: the new size AND the position that keeps the
/// anchor corner where it was.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResizePlan {
    pub w: f64,
    pub h: f64,
    pub x: f64,
    pub y: f64,
}

/// The app's corner-handle numbering (see `Drag::ResizeSel` and the selection
/// handles painted in `editor_ui`): 0 = TL, 1 = TR, 2 = BL, 3 = BR.
pub fn corner_from_index(i: usize) -> Corner {
    match i {
        0 => Corner::TopLeft,
        1 => Corner::TopRight,
        2 => Corner::BottomLeft,
        _ => Corner::BottomRight,
    }
}

/// Inverse of [`corner_from_index`].
pub fn corner_index(c: Corner) -> usize {
    match c {
        Corner::TopLeft => 0,
        Corner::TopRight => 1,
        Corner::BottomLeft => 2,
        Corner::BottomRight => 3,
    }
}

/// Normalized (0..1) local coordinates of the handle being dragged.
pub fn handle_norm(handle: Corner) -> (f64, f64) {
    match handle {
        Corner::TopLeft => (0.0, 0.0),
        Corner::TopRight => (1.0, 0.0),
        Corner::BottomLeft => (0.0, 1.0),
        Corner::BottomRight => (1.0, 1.0),
    }
}

/// Normalized local coordinates of the corner that stays pinned — the one
/// diagonally opposite the dragged handle.
pub fn anchor_norm(handle: Corner) -> (f64, f64) {
    match handle {
        Corner::TopLeft => (1.0, 1.0),
        Corner::TopRight => (0.0, 1.0),
        Corner::BottomLeft => (1.0, 0.0),
        Corner::BottomRight => (0.0, 0.0),
    }
}

/// The node's linear transform part: rotation · scale · skew, no translation.
pub fn linear(n: &Node) -> Affine {
    let t = n.transform;
    Affine::rotate(t.rotation)
        * Affine::scale_non_uniform(t.scale_x, t.scale_y)
        * Affine::skew(t.skew_x, t.skew_y)
}

fn apply(m: Affine, x: f64, y: f64) -> (f64, f64) {
    let p = m.transform_point(Point::new(x, y));
    (p.x, p.y)
}

/// A point of the node's box in WORLD coordinates. `ax`/`ay` are normalized
/// (0 = left/top edge, 1 = right/bottom edge), so `(0,0)` is the top-left
/// corner and `(0.5, 0.5)` the center.
pub fn world_point(n: &Node, ax: f64, ay: f64) -> (f64, f64) {
    local_to_world(n, ax * n.w, ay * n.h)
}

/// A point in the node's local PIXEL space (0..w, 0..h — the space path data
/// and child coordinates are stored in) mapped to world coordinates.
pub fn local_to_world(n: &Node, lx: f64, ly: f64) -> (f64, f64) {
    let t = n.transform;
    let (px, py) = (t.origin_x * n.w, t.origin_y * n.h);
    let (dx, dy) = apply(linear(n), lx - px, ly - py);
    (t.x + px + dx, t.y + py + dy)
}

/// The four corners in world space, in the app's handle order
/// (TL, TR, BL, BR). These are what the selection outline and the corner
/// handles must be drawn through once a node can be rotated.
pub fn world_corners(n: &Node) -> [(f64, f64); 4] {
    [
        world_point(n, 0.0, 0.0),
        world_point(n, 1.0, 0.0),
        world_point(n, 0.0, 1.0),
        world_point(n, 1.0, 1.0),
    ]
}

/// Inverse of [`world_point`]: a world coordinate expressed in the node's
/// local, untransformed box space (0..w, 0..h). Vector/pen editing needs this
/// — path data is stored in local coordinates while the pointer is not.
pub fn local_point(n: &Node, wx: f64, wy: f64) -> (f64, f64) {
    let t = n.transform;
    let (px, py) = (t.origin_x * n.w, t.origin_y * n.h);
    let (dx, dy) = apply(linear(n).inverse(), wx - (t.x + px), wy - (t.y + py));
    (dx + px, dy + py)
}

/// Which corner handle (if any) is under a world point, within `tol` px.
pub fn corner_at(n: &Node, wx: f64, wy: f64, tol: f64) -> Option<Corner> {
    let mut best: Option<(Corner, f64)> = None;
    for c in [
        Corner::TopLeft,
        Corner::TopRight,
        Corner::BottomLeft,
        Corner::BottomRight,
    ] {
        let (ax, ay) = handle_norm(c);
        let (cx, cy) = world_point(n, ax, ay);
        let d = ((wx - cx) * (wx - cx) + (wy - cy) * (wy - cy)).sqrt();
        if d <= tol && best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((c, d));
        }
    }
    best.map(|(c, _)| c)
}

/// Plan a corner drag on a (possibly rotated) node.
///
/// * `wx`, `wy` — the pointer in world space.
/// * `keep_aspect` — ⇧: lock the node's original aspect ratio.
/// * `min` — smallest accepted edge; the drag is refused (None) below it,
///   which is how an inside-out box is prevented.
pub fn plan_resize(
    n: &Node,
    handle: Corner,
    wx: f64,
    wy: f64,
    keep_aspect: bool,
    min: f64,
) -> Option<ResizePlan> {
    if !(n.w > 0.0) || !(n.h > 0.0) {
        return None;
    }
    let (ax, ay) = anchor_norm(handle);
    let anchor = world_point(n, ax, ay);
    let m = linear(n);
    // pointer offset from the pinned corner, measured along the node's own axes
    let (lx, ly) = apply(m.inverse(), wx - anchor.0, wy - anchor.1);
    // +1 where the handle sits on the far edge from the anchor, −1 where it
    // sits on the near edge (so the size is always the positive extent)
    let sx = 1.0 - 2.0 * ax;
    let sy = 1.0 - 2.0 * ay;
    let mut w = lx * sx;
    let mut h = ly * sy;
    if keep_aspect {
        let ratio = n.h / n.w;
        if w.abs() / n.w >= h.abs() / n.h {
            h = w * ratio;
        } else {
            w = h / ratio;
        }
    }
    if !(w >= min) || !(h >= min) {
        return None;
    }
    let t = n.transform;
    let (px, py) = (t.origin_x * w, t.origin_y * h);
    let (qx, qy) = apply(m, (ax - t.origin_x) * w, (ay - t.origin_y) * h);
    Some(ResizePlan {
        w,
        h,
        x: anchor.0 - px - qx,
        y: anchor.1 - py - qy,
    })
}

/// Apply a plan to a node (used by the command and by tests).
pub fn apply_plan(n: &mut Node, p: &ResizePlan) {
    n.w = p.w.max(1.0);
    n.h = p.h.max(1.0);
    n.transform.x = p.x;
    n.transform.y = p.y;
    n.dirty = true;
}

impl Editor {
    /// Rotation-aware corner resize, as ONE undoable step. Returns false when
    /// the node is missing or the drag would invert the box (see `min`).
    pub fn resize_transformed(
        &mut self,
        id: &str,
        handle: Corner,
        wx: f64,
        wy: f64,
        keep_aspect: bool,
        min: f64,
    ) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let Some(plan) = plan_resize(n, handle, wx, wy, keep_aspect, min) else {
            return false;
        };
        let from = ((n.w, n.h), (n.transform.x, n.transform.y));
        let to = ((plan.w, plan.h), (plan.x, plan.y));
        self.push_cmds(vec![Command::ResizeTransformed {
            id: id.into(),
            from,
            to,
        }]);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node, Transform};

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Node {
        Node::rect("r", x, y, w, h, Color::from_rgb8(10, 20, 30))
    }

    /// Assert the anchor corner does not move when a plan is applied.
    fn assert_anchor_pinned(n: &Node, handle: Corner, plan: &ResizePlan) {
        let (ax, ay) = anchor_norm(handle);
        let before = world_point(n, ax, ay);
        let mut moved = n.clone();
        apply_plan(&mut moved, plan);
        let after = world_point(&moved, ax, ay);
        assert!(
            (before.0 - after.0).abs() < 1e-9 && (before.1 - after.1).abs() < 1e-9,
            "anchor moved from {before:?} to {after:?}"
        );
    }

    #[test]
    fn unrotated_drag_is_the_plain_resize_everyone_expects() {
        let n = rect(100.0, 50.0, 80.0, 40.0);
        // grab BR (180, 90), drag to (200, 110) -> 100 x 60, origin unchanged
        let p = plan_resize(&n, Corner::BottomRight, 200.0, 110.0, false, 1.0).unwrap();
        assert_eq!((p.w, p.h), (100.0, 60.0));
        assert_eq!((p.x, p.y), (100.0, 50.0));
        // and the TL corner is the pinned one
        assert_anchor_pinned(&n, Corner::BottomRight, &p);
    }

    #[test]
    fn rotated_drag_keeps_the_opposite_corner_pinned() {
        let mut n = rect(100.0, 50.0, 80.0, 40.0);
        n.transform.rotation = std::f64::consts::FRAC_PI_4; // 45°
                                                            // aim beyond the dragged corner along BOTH local axes, so the drag is
                                                            // a valid outward resize whatever the rotation happens to be
        let (tx, ty) = world_point(&n, 1.5, 1.5);
        // a plain resize would leave x/y alone; the transformed plan must not
        let p = plan_resize(&n, Corner::BottomRight, tx, ty, false, 1.0).unwrap();
        assert_anchor_pinned(&n, Corner::BottomRight, &p);
        // the box grew 1.5x along its own axes, not along the screen's
        assert!((p.w - 120.0).abs() < 1e-9, "w = {}", p.w);
        assert!((p.h - 60.0).abs() < 1e-9, "h = {}", p.h);
        // ... and the position really did have to change
        assert!(
            (p.x - n.transform.x).abs() > 1e-6 || (p.y - n.transform.y).abs() > 1e-6,
            "rotated resize should reposition the node (x {} -> {})",
            n.transform.x,
            p.x
        );
        // the dragged corner lands exactly under the pointer
        let mut moved = n.clone();
        apply_plan(&mut moved, &p);
        let dragged = world_point(&moved, 1.0, 1.0);
        assert!((dragged.0 - tx).abs() < 1e-9 && (dragged.1 - ty).abs() < 1e-9);
    }

    #[test]
    fn rotated_drag_extends_along_the_local_axes() {
        // 90° rotation: the node's local +x axis points down the screen, so
        // dragging the BR handle straight DOWN grows the WIDTH, not the height
        let mut n = rect(200.0, 200.0, 100.0, 40.0);
        n.transform.rotation = std::f64::consts::FRAC_PI_2;
        let start = world_point(&n, 1.0, 1.0);
        let p = plan_resize(&n, Corner::BottomRight, start.0, start.1 + 30.0, false, 1.0).unwrap();
        assert!((p.w - 130.0).abs() < 1e-9, "w = {}", p.w);
        assert!((p.h - 40.0).abs() < 1e-9, "h = {}", p.h);
        assert_anchor_pinned(&n, Corner::BottomRight, &p);
    }

    #[test]
    fn every_handle_pins_its_own_diagonal() {
        let mut n = rect(10.0, 20.0, 120.0, 70.0);
        n.transform.rotation = 0.7;
        for handle in [
            Corner::TopLeft,
            Corner::TopRight,
            Corner::BottomLeft,
            Corner::BottomRight,
        ] {
            let (hx, hy) = handle_norm(handle);
            let (cx, cy) = world_point(&n, hx, hy);
            // drag the handle 25px outward along both local axes
            let target = world_point(&n, hx * 1.0 + 0.2, hy * 1.0 + 0.2);
            let p = plan_resize(&n, handle, target.0, target.1, false, 1.0)
                .unwrap_or_else(|| panic!("no plan for {handle:?} from ({cx},{cy})"));
            assert_anchor_pinned(&n, handle, &p);
        }
    }

    #[test]
    fn shift_locks_the_aspect_ratio() {
        let n = rect(0.0, 0.0, 100.0, 50.0);
        // dragged to (150,150): vertically that is 3x the height, horizontally
        // only 1.5x the width, so HEIGHT drives and width follows at 2:1
        let p = plan_resize(&n, Corner::BottomRight, 150.0, 150.0, true, 1.0).unwrap();
        assert!((p.h - 150.0).abs() < 1e-9, "h = {}", p.h);
        assert!((p.w - 300.0).abs() < 1e-9, "w = {}", p.w);
        assert!((p.h / p.w - 0.5).abs() < 1e-12);
        // when the horizontal delta dominates, width drives instead
        let q = plan_resize(&n, Corner::BottomRight, 300.0, 60.0, true, 1.0).unwrap();
        assert!((q.w - 300.0).abs() < 1e-9, "w = {}", q.w);
        assert!((q.h - 150.0).abs() < 1e-9, "h = {}", q.h);
    }

    #[test]
    fn inverted_or_tiny_drags_are_refused() {
        let n = rect(100.0, 100.0, 80.0, 60.0);
        // drag BR back past the TL anchor -> negative extents
        assert!(plan_resize(&n, Corner::BottomRight, 90.0, 90.0, false, 2.0).is_none());
        // 1px edge is below the app's 2px floor
        assert!(plan_resize(&n, Corner::BottomRight, 101.0, 101.0, false, 2.0).is_none());
        // a degenerate node can never be resized
        let flat = rect(0.0, 0.0, 0.0, 40.0);
        assert!(plan_resize(&flat, Corner::BottomRight, 10.0, 10.0, false, 1.0).is_none());
    }

    #[test]
    fn corner_handles_hit_test_in_the_rotated_frame() {
        let mut n = rect(0.0, 0.0, 100.0, 40.0);
        n.transform.rotation = std::f64::consts::FRAC_PI_2;
        // the axis-aligned box would put TL at (0,0); rotated 90° about the
        // center it lands at (100,0)-ish instead — hit-test must follow it
        let (tx, ty) = world_point(&n, 0.0, 0.0);
        assert_eq!(corner_at(&n, tx, ty, 2.0), Some(Corner::TopLeft));
        assert_eq!(corner_at(&n, tx + 30.0, ty + 30.0, 2.0), None);
        // index mapping matches the app's 0 TL / 1 TR / 2 BL / 3 BR
        assert_eq!(corner_index(corner_from_index(2)), 2);
        assert_eq!(corner_from_index(3), Corner::BottomRight);
    }

    #[test]
    fn local_and_world_roundtrip() {
        let mut n = rect(120.0, 80.0, 90.0, 30.0);
        n.transform.rotation = 1.1;
        for (ax, ay) in [(0.0, 0.0), (1.0, 1.0), (0.25, 0.75)] {
            let (wx, wy) = world_point(&n, ax, ay);
            let (lx, ly) = local_point(&n, wx, wy);
            assert!((lx - ax * n.w).abs() < 1e-9, "lx {lx} vs {}", ax * n.w);
            assert!((ly - ay * n.h).abs() < 1e-9, "ly {ly} vs {}", ay * n.h);
        }
    }

    #[test]
    fn editor_op_is_one_undoable_step_that_restores_position_too() {
        let mut n = rect(100.0, 50.0, 80.0, 40.0);
        n.transform.rotation = std::f64::consts::FRAC_PI_3;
        let (tx, ty) = world_point(&n, 1.5, 1.5);
        let mut ed = Editor::new(Node::frame("page", 800.0, 600.0).child(n.clone()));
        let depth_before = ed.undo_depth();
        assert!(ed.resize_transformed("r", Corner::BottomRight, tx, ty, false, 1.0));
        assert_eq!(
            ed.undo_depth(),
            depth_before + 1,
            "one drag = one undo step"
        );
        let after = find(&ed.root, "r").unwrap().clone();
        assert!((after.w - 120.0).abs() < 1e-9 && (after.h - 60.0).abs() < 1e-9);
        assert!(
            (after.transform.x - n.transform.x).abs() > 1e-6
                || (after.transform.y - n.transform.y).abs() > 1e-6,
            "the position is part of the command, not just the size"
        );
        ed.undo();
        let back = find(&ed.root, "r").unwrap();
        assert_eq!((back.w, back.h), (n.w, n.h));
        assert!((back.transform.x - n.transform.x).abs() < 1e-12);
        assert!((back.transform.y - n.transform.y).abs() < 1e-12);
    }

    #[test]
    fn missing_node_and_degenerate_geometry_return_false() {
        let mut ed =
            Editor::new(Node::frame("page", 800.0, 600.0).child(rect(0.0, 0.0, 10.0, 10.0)));
        assert!(!ed.resize_transformed("nope", Corner::TopLeft, 1.0, 1.0, false, 1.0));
        // drag past the anchor -> refused, and nothing was pushed
        let depth = ed.undo_depth();
        assert!(!ed.resize_transformed("r", Corner::BottomRight, -5.0, -5.0, false, 2.0));
        assert_eq!(ed.undo_depth(), depth);
    }

    #[test]
    fn scale_and_origin_participate_like_the_renderer() {
        // the renderer builds world = translate(x+px,y+py)·R·S·K·translate(-px,-py);
        // a non-default origin and a 2x scale must both survive the roundtrip
        let mut n = rect(10.0, 10.0, 60.0, 40.0);
        n.transform = Transform {
            origin_x: 0.0,
            origin_y: 1.0,
            scale_x: 2.0,
            scale_y: 2.0,
            rotation: 0.4,
            ..Default::default()
        };
        let p = plan_resize(&n, Corner::TopRight, 200.0, 10.0, false, 1.0).unwrap();
        assert_anchor_pinned(&n, Corner::TopRight, &p);
        let mut moved = n.clone();
        apply_plan(&mut moved, &p);
        let dragged = world_point(&moved, 1.0, 0.0);
        assert!((dragged.0 - 200.0).abs() < 1e-9 && (dragged.1 - 10.0).abs() < 1e-9);
    }
}
