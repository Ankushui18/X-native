//! Vector editing (P0): the designer pen/node workflow on PathCmd data.
//!
//! Pen -> node selection -> bezier handles -> convert point -> join ->
//! split -> (boolean/flatten/outline-stroke are the remaining stages).
//! Everything operates on `NodeKind::Vector { path }` in local coords and
//! goes through the command log via ReplaceNode, so it is fully undoable.

use crate::booleans::c_shift;
use crate::{find, find_mut, parent_id, Command, Editor};
use x_core::{Node, NodeKind, PathCmd, StrokeJoin, Transform};

/// An editable anchor extracted from a path: its position plus which
/// command owns it and the incoming control points (if the segment
/// arriving at this anchor is a cubic).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub cmd_index: usize,
    pub x: f64,
    pub y: f64,
    /// control handle of the INCOMING cubic (c2), if any
    pub in_handle: Option<(f64, f64)>,
}

/// List the anchors of a vector node's path.
pub fn anchors(path: &[PathCmd]) -> Vec<Anchor> {
    let mut out = vec![];
    for (i, c) in path.iter().enumerate() {
        match *c {
            PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => out.push(Anchor {
                cmd_index: i,
                x,
                y,
                in_handle: None,
            }),
            PathCmd::CurveTo(_, _, x2, y2, x, y) => out.push(Anchor {
                cmd_index: i,
                x,
                y,
                in_handle: Some((x2, y2)),
            }),
            PathCmd::Close => {}
        }
    }
    out
}

/// Index of the anchor within `radius` of (x, y), if any.
pub fn anchor_at(path: &[PathCmd], x: f64, y: f64, radius: f64) -> Option<usize> {
    anchors(path)
        .iter()
        .position(|a| ((a.x - x).powi(2) + (a.y - y).powi(2)).sqrt() <= radius)
}

/// Squared distance from (x, y) to the segment (ax,ay)-(bx,by).
fn dist2_to_seg(x: f64, y: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= f64::EPSILON {
        0.0
    } else {
        (((x - ax) * dx + (y - ay) * dy) / len2).clamp(0.0, 1.0)
    };
    let (px, py) = (ax + dx * t, ay + dy * t);
    (x - px).powi(2) + (y - py).powi(2)
}

/// Index of the path segment within `radius` of (x, y): the returned
/// index is the END ANCHOR of the hit segment (1..) — matching
/// [`Editor::erase_segments`] addressing. Anchor 0 is returned only for
/// the implicit closing segment of a closed path. Cubics are sampled at
/// 16 points; lines are exact.
pub fn segment_at(path: &[PathCmd], x: f64, y: f64, radius: f64) -> Option<usize> {
    let list = anchors(path);
    let r2 = radius * radius;
    let closed = matches!(path.last(), Some(PathCmd::Close));
    // closing segment: last anchor -> first anchor (straight)
    if closed {
        if let (Some(first), Some(last)) = (list.first(), list.last()) {
            if dist2_to_seg(x, y, last.x, last.y, first.x, first.y) <= r2 {
                return Some(0);
            }
        }
    }
    for i in 1..list.len() {
        let (prev, cur) = (list[i - 1], list[i]);
        let hit = match path[cur.cmd_index] {
            PathCmd::LineTo(bx, by) => dist2_to_seg(x, y, prev.x, prev.y, bx, by) <= r2,
            PathCmd::CurveTo(c1x, c1y, c2x, c2y, bx, by) => {
                let (mut px, mut py) = (prev.x, prev.y);
                let mut hit = false;
                for k in 1..=16 {
                    let t = k as f64 / 16.0;
                    let mt = 1.0 - t;
                    let bx_ = mt * mt * mt * prev.x
                        + 3.0 * mt * mt * t * c1x
                        + 3.0 * mt * t * t * c2x
                        + t * t * t * bx;
                    let by_ = mt * mt * mt * prev.y
                        + 3.0 * mt * mt * t * c1y
                        + 3.0 * mt * t * t * c2y
                        + t * t * t * by;
                    if dist2_to_seg(x, y, px, py, bx_, by_) <= r2 {
                        hit = true;
                        break;
                    }
                    px = bx_;
                    py = by_;
                }
                hit
            }
            _ => continue,
        };
        if hit {
            return Some(i);
        }
    }
    None
}

fn set_anchor_pos(path: &mut [PathCmd], cmd_index: usize, nx: f64, ny: f64) {
    // move the endpoint; incoming cubic's c2 moves rigidly with it
    match &mut path[cmd_index] {
        PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
            *x = nx;
            *y = ny;
        }
        PathCmd::CurveTo(_, _, x2, y2, x, y) => {
            let (dx, dy) = (nx - *x, ny - *y);
            *x2 += dx;
            *y2 += dy;
            *x = nx;
            *y = ny;
        }
        PathCmd::Close => {}
    }
    // the OUTGOING cubic's c1 belongs to the next command and is moved by
    // `move_anchor`, which knows the anchor's pre-move position
}

impl Editor {
    /// Pen tool: append an anchor to a vector node (line segment), or
    /// start a new subpath if the path is empty. Undoable.
    pub fn pen_add_anchor(&mut self, id: &str, x: f64, y: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            if path.is_empty() {
                p.push(PathCmd::MoveTo(x, y));
            } else {
                p.push(PathCmd::LineTo(x, y));
            }
        }
        grow_bounds(&mut after);
        self.push_replace(id, before, after);
        true
    }

    /// pen tool: append an anchor, arriving via a cubic curve
    /// when `out_c1` is given (the c1 control point, pulled out by the
    /// PREVIOUS anchor's placement drag). A plain click with no drag on
    /// the previous point still yields a straight `LineTo`.
    pub fn pen_add_anchor_curved(
        &mut self,
        id: &str,
        x: f64,
        y: f64,
        out_c1: Option<(f64, f64)>,
    ) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            if path.is_empty() {
                p.push(PathCmd::MoveTo(x, y));
            } else if let Some((c1x, c1y)) = out_c1 {
                // c2 starts collapsed onto the new endpoint (no arrival
                // bend yet); dragging while placing THIS anchor shapes it
                // via `pen_shape_incoming`, mirroring Figma's pen tool.
                p.push(PathCmd::CurveTo(c1x, c1y, x, y, x, y));
            } else {
                p.push(PathCmd::LineTo(x, y));
            }
        }
        grow_bounds(&mut after);
        self.push_replace(id, before, after);
        true
    }

    /// pen tool: while placing anchor `anchor_idx`, a
    /// click-drag shapes the curve arriving at it — the incoming handle is
    /// pulled to the opposite side of the drag vector `(dx, dy)` (a corner
    /// point becomes a smooth one, mirroring the departure/arrival
    /// tangent through the anchor). No-op for the path's first anchor,
    /// which has no incoming segment.
    pub fn pen_shape_incoming(&mut self, id: &str, anchor_idx: usize, dx: f64, dy: f64) -> bool {
        if anchor_idx == 0 {
            return false;
        }
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        let list = anchors(path);
        let (Some(a), Some(prev)) = (
            list.get(anchor_idx).copied(),
            list.get(anchor_idx - 1).copied(),
        ) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        let mut changed = false;
        if let NodeKind::Vector { path: p } = &mut after.kind {
            match p[a.cmd_index] {
                PathCmd::LineTo(ex, ey) => {
                    p[a.cmd_index] = PathCmd::CurveTo(prev.x, prev.y, ex - dx, ey - dy, ex, ey);
                    changed = true;
                }
                PathCmd::CurveTo(c1x, c1y, _, _, ex, ey) => {
                    p[a.cmd_index] = PathCmd::CurveTo(c1x, c1y, ex - dx, ey - dy, ex, ey);
                    changed = true;
                }
                _ => {}
            }
        }
        if !changed {
            return false;
        }
        self.push_replace(id, before, after);
        true
    }

    /// Close the current subpath (pen click on the first anchor).
    pub fn pen_close(&mut self, id: &str) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        if path.is_empty() || matches!(path.last(), Some(PathCmd::Close)) {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            p.push(PathCmd::Close);
        }
        self.push_replace(id, before, after);
        true
    }

    /// Node tool: move an anchor (rigidly carrying its cubic handles).
    pub fn move_anchor(&mut self, id: &str, anchor_idx: usize, nx: f64, ny: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        let Some(a) = anchors(path).get(anchor_idx).copied() else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            set_anchor_pos(p, a.cmd_index, nx, ny);
            // outgoing segment's c1 moves rigidly too
            if a.cmd_index + 1 < p.len() {
                let (dx, dy) = (nx - a.x, ny - a.y);
                if let PathCmd::CurveTo(x1, y1, _, _, _, _) = &mut p[a.cmd_index + 1] {
                    *x1 += dx;
                    *y1 += dy;
                }
            }
        }
        grow_bounds(&mut after);
        self.push_replace(id, before, after);
        true
    }

    /// Node tool: move a bezier CONTROL HANDLE independently. The geometry is
    /// [`move_handle_in`]; this is the undoable, one-entry-per-call form. For an
    /// interactive drag use [`Editor::live_rewrite_path`] with the same function
    /// inside a gesture, so the whole drag is ONE undo step.
    pub fn move_handle(
        &mut self,
        id: &str,
        anchor_idx: usize,
        outgoing: bool,
        nx: f64,
        ny: f64,
        mirror: bool,
    ) -> bool {
        self.rewrite_path(id, |path| {
            move_handle_in(path, anchor_idx, outgoing, nx, ny, mirror)
        })
    }

    /// The outgoing handle position of an anchor, if its next segment is
    /// a cubic (c1 of that segment).
    pub fn out_handle(&self, id: &str, anchor_idx: usize) -> Option<(f64, f64)> {
        let n = find(&self.root, id)?;
        let NodeKind::Vector { path } = &n.kind else {
            return None;
        };
        let a = anchors(path).get(anchor_idx).copied()?;
        match path.get(a.cmd_index + 1) {
            Some(PathCmd::CurveTo(x1, y1, ..)) => Some((*x1, *y1)),
            _ => None,
        }
    }

    /// Delete an anchor; joins its neighbors with a line.
    pub fn delete_anchor(&mut self, id: &str, anchor_idx: usize) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        // guard BEFORE cloning so a refused delete never reaches the undo stack
        if anchors(path).len() <= 2 || path.is_empty() {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        let done = if let NodeKind::Vector { path: p } = &mut after.kind {
            delete_anchor_in(p, anchor_idx)
        } else {
            false
        };
        if !done {
            return false;
        }
        self.push_replace(id, before, after);
        true
    }

    /// Convert point (Figma/Illustrator "convert anchor"): straight <-> smooth.
    /// A LineTo becomes a CurveTo with auto handles at 1/3rds; a CurveTo
    /// collapses back to a LineTo.
    pub fn convert_anchor(&mut self, id: &str, anchor_idx: usize) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        let list = anchors(path);
        let Some(a) = list.get(anchor_idx).copied() else {
            return false;
        };
        // previous anchor position (segment start)
        let prev = if anchor_idx == 0 {
            None
        } else {
            list.get(anchor_idx - 1).copied()
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            match p[a.cmd_index] {
                PathCmd::LineTo(x, y) => {
                    let (px, py) = prev.map(|pa| (pa.x, pa.y)).unwrap_or((x, y));
                    let c1 = (px + (x - px) / 3.0, py + (y - py) / 3.0);
                    let c2 = (px + 2.0 * (x - px) / 3.0, py + 2.0 * (y - py) / 3.0);
                    p[a.cmd_index] = PathCmd::CurveTo(c1.0, c1.1, c2.0, c2.1, x, y);
                }
                PathCmd::CurveTo(_, _, _, _, x, y) => {
                    p[a.cmd_index] = PathCmd::LineTo(x, y);
                }
                _ => return false,
            }
        }
        self.push_replace(id, before, after);
        true
    }

    /// Split a segment: insert a new anchor at the midpoint of the segment
    /// ENDING at `anchor_idx` (pen click on a segment).
    pub fn split_segment(&mut self, id: &str, anchor_idx: usize) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        let Some(split) = split_segment_at(path, anchor_idx) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            *p = split;
        }
        self.push_replace(id, before, after);
        true
    }

    /// Vector eraser (Figma Draw / node-edit Shift+E): erase the
    /// segments ENDING at each listed anchor index (0 = the implicit
    /// closing segment of a closed path). The path splits where
    /// segments are removed — the following drawing command becomes a
    /// new MoveTo — and a closed path opens up. ONE undo step for the
    /// whole drag.
    pub fn erase_segments(&mut self, id: &str, ends: &[usize]) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        if ends.is_empty() {
            return false;
        }
        let list = anchors(path);
        let closed = matches!(path.last(), Some(PathCmd::Close));
        // command indices to remove, plus the split-fixup set
        let mut remove: Vec<usize> = vec![];
        let mut open_close = false;
        for &i in ends {
            if i == 0 {
                if closed {
                    open_close = true; // erase the closing segment
                }
                continue;
            }
            let Some(a) = list.get(i) else {
                continue;
            };
            match path[a.cmd_index] {
                PathCmd::LineTo(..) | PathCmd::CurveTo(..) => {
                    if !remove.contains(&a.cmd_index) {
                        remove.push(a.cmd_index);
                    }
                    // splitting a closed loop also opens it
                    if closed {
                        open_close = true;
                    }
                }
                _ => {}
            }
        }
        if remove.is_empty() && !open_close {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            let mut out: Vec<PathCmd> = vec![];
            for (ci, cmd) in p.iter().enumerate() {
                if remove.contains(&ci) {
                    continue;
                }
                if matches!(cmd, PathCmd::Close) && open_close {
                    continue;
                }
                let mut cmd = *cmd;
                // the drawing command after a removed segment starts a
                // new subpath (the path splits there)
                if ci > 0 && remove.contains(&(ci - 1)) {
                    match cmd {
                        PathCmd::LineTo(x, y) => cmd = PathCmd::MoveTo(x, y),
                        PathCmd::CurveTo(_, _, _, _, x, y) => cmd = PathCmd::MoveTo(x, y),
                        _ => {}
                    }
                }
                out.push(cmd);
            }
            *p = out;
        }
        self.push_replace(id, before, after);
        true
    }

    pub fn push_replace(&mut self, id: &str, before: Box<Node>, after: Node) {
        self.push_cmds(vec![Command::ReplaceNode {
            id: id.into(),
            before,
            after: Box::new(after),
        }]);
    }
}

/// Expand node w/h to contain the path (pen can draw outside the box).
fn grow_bounds(n: &mut Node) {
    if let NodeKind::Vector { path } = &n.kind {
        let (mut mx, mut my) = (n.w, n.h);
        for c in path {
            let pts: Vec<(f64, f64)> = match *c {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => vec![(x, y)],
                PathCmd::CurveTo(a, b, c2, d, e, f) => vec![(a, b), (c2, d), (e, f)],
                PathCmd::Close => vec![],
            };
            for (x, y) in pts {
                mx = mx.max(x);
                my = my.max(y);
            }
        }
        n.w = mx;
        n.h = my;
    }
}

// ---------------------------------------------------------------------------
// Batch path operations
//
// Figma's node surface is multi-select: you drag three anchors at once, delete
// a set of points, simplify the whole path, reverse it, split it, join two of
// them. Each of those is ONE gesture, so each one rewrites the path in a single
// pass through [`Editor::rewrite_path`] instead of looping per anchor — a loop
// would leave N entries on the undo stack for one drag.
//
// Indices in this section are ANCHOR indices, the numbering [`anchors`] and
// [`Editor::select_vector_point`] use, never raw command indices: a path with a
// `Close` (or with several subpaths) has more commands than anchors.
// ---------------------------------------------------------------------------

/// Move several anchors — and the cubic handles attached to them — by (dx, dy).
///
/// Out-of-range indices are ignored and a zero delta is a no-op. A handle that
/// belongs to the moved anchor travels with it (rigidly, exactly the
/// single-anchor rule in [`Editor::move_anchor`], applied to a set): the
/// incoming c2 through [`set_anchor_pos`], the outgoing c1 through the next
/// command. A handle belonging to a NON-selected neighbour keeps its absolute
/// position, which is what bends the segment between the two.
pub fn move_anchors_by(path: &mut Vec<PathCmd>, idxs: &[usize], dx: f64, dy: f64) {
    if idxs.is_empty() || (dx == 0.0 && dy == 0.0) {
        return;
    }
    let list = anchors(path);
    for &i in idxs {
        let Some(a) = list.get(i).copied() else {
            continue;
        };
        set_anchor_pos(path, a.cmd_index, a.x + dx, a.y + dy);
        // the outgoing cubic's c1 lives in the NEXT command
        if let Some(PathCmd::CurveTo(x1, y1, ..)) = path.get_mut(a.cmd_index + 1) {
            *x1 += dx;
            *y1 += dy;
        }
    }
}

/// Delete several anchors at once, highest index first so the earlier indices
/// stay valid. Returns false — changing nothing — when the list is empty or the
/// deletion would leave fewer than two anchors, since a one-anchor path has no
/// segment to be. Figma refuses the same delete.
pub fn delete_anchors(path: &mut Vec<PathCmd>, idxs: &[usize]) -> bool {
    let n = anchors(path).len();
    let mut uniq: Vec<usize> = idxs.iter().copied().filter(|&i| i < n).collect();
    uniq.sort_unstable();
    uniq.dedup();
    if uniq.is_empty() || n - uniq.len() < 2 {
        return false;
    }
    for &i in uniq.iter().rev() {
        delete_anchor_in(path, i);
    }
    true
}

/// Remove the anchor at `idx`, re-rooting the subpath when the deleted anchor
/// owned its `MoveTo` (the next drawing command becomes the new start). Refuses
/// when fewer than two anchors would survive.
fn delete_anchor_in(path: &mut Vec<PathCmd>, idx: usize) -> bool {
    let list = anchors(path);
    if list.len() <= 2 {
        return false; // keep at least a segment
    }
    let Some(a) = list.get(idx) else {
        return false;
    };
    let was_move = matches!(path[a.cmd_index], PathCmd::MoveTo(..));
    path.remove(a.cmd_index);
    if was_move {
        // next drawing command becomes the new MoveTo
        if let Some(next) = path.get_mut(a.cmd_index) {
            let (nx, ny) = match *next {
                PathCmd::LineTo(x, y) => (x, y),
                PathCmd::CurveTo(_, _, _, _, x, y) => (x, y),
                _ => (0.0, 0.0),
            };
            *next = PathCmd::MoveTo(nx, ny);
        }
    }
    true
}

/// Insert a new anchor at the midpoint of the segment ENDING at anchor `idx`
/// (pen click on a segment). A cubic is split with de Casteljau at t=0.5, so
/// both halves keep the original curve's shape exactly and its endpoints do not
/// move. Returns None when `idx` is 0, out of range, or not a drawable segment.
pub fn split_segment_at(path: &[PathCmd], idx: usize) -> Option<Vec<PathCmd>> {
    if idx == 0 {
        return None;
    }
    let list = anchors(path);
    let a = list.get(idx).copied()?;
    let prev = list.get(idx - 1).copied()?;
    let mut p = path.to_vec();
    match p[a.cmd_index] {
        PathCmd::LineTo(x, y) => {
            let mid = ((prev.x + x) / 2.0, (prev.y + y) / 2.0);
            p.insert(a.cmd_index, PathCmd::LineTo(mid.0, mid.1));
        }
        PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
            // de Casteljau split at t=0.5
            let l = |a: f64, b: f64| (a + b) / 2.0;
            let (p0x, p0y) = (prev.x, prev.y);
            let (q0x, q0y) = (l(p0x, x1), l(p0y, y1));
            let (q1x, q1y) = (l(x1, x2), l(y1, y2));
            let (q2x, q2y) = (l(x2, x), l(y2, y));
            let (r0x, r0y) = (l(q0x, q1x), l(q0y, q1y));
            let (r1x, r1y) = (l(q1x, q2x), l(q1y, q2y));
            let (mx, my) = (l(r0x, r1x), l(r0y, r1y));
            p[a.cmd_index] = PathCmd::CurveTo(r1x, r1y, q2x, q2y, x, y);
            p.insert(a.cmd_index, PathCmd::CurveTo(q0x, q0y, r0x, r0y, mx, my));
        }
        _ => return None,
    }
    Some(p)
}

/// Perpendicular distance from `p` to the infinite line through `a` and `b`.
fn perp_dist(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx.hypot(dy);
    if len < 1e-12 {
        return (p.0 - a.0).hypot(p.1 - a.1);
    }
    ((p.0 - a.0) * dy - (p.1 - a.1) * dx).abs() / len
}

/// Ramer-Douglas-Peucker as a KEEP MASK (first and last always kept). The same
/// algorithm as `x_core::simplify_polyline`, but it answers "which of these
/// points survive" instead of handing back a fresh polyline — that is what lets
/// [`simplify_path`] keep each survivor's ORIGINAL command, so a simplified
/// curve stays a curve. Iterative (explicit stack): a 10k-anchor path cannot
/// overflow it.
fn rdp_keep(pts: &[(f64, f64)], tol: f64) -> Vec<bool> {
    let n = pts.len();
    let mut keep = vec![false; n];
    if n == 0 {
        return keep;
    }
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (mut worst, mut worst_d) = (a, 0.0f64);
        for i in a + 1..b {
            let d = perp_dist(pts[i], pts[a], pts[b]);
            if d > worst_d {
                worst = i;
                worst_d = d;
            }
        }
        if worst_d > tol {
            keep[worst] = true;
            stack.push((a, worst));
            stack.push((worst, b));
        }
    }
    keep
}

/// The point an anchor command lands on (its endpoint).
fn anchor_point(c: PathCmd) -> (f64, f64) {
    match c {
        PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => (x, y),
        PathCmd::CurveTo(_, _, _, _, x, y) => (x, y),
        PathCmd::Close => (0.0, 0.0),
    }
}

/// Simplify a vector path (Figma: Edit object > Simplify). Per subpath, drop
/// the anchors that sit within `tolerance` (the node's local units) of the chord
/// between their surviving neighbours.
///
/// Survivors keep their ORIGINAL command, so this reduces points rather than
/// flattening: a curve stays a cubic, and an anchor bounding a segment that
/// bulges more than `tolerance` off its chord always survives (a curve is never
/// simplified into a straight line). Two consequences worth stating plainly — a
/// subpath's first and last anchors always survive, and dropping an anchor
/// leaves the following cubic's control points where they were, so a simplified
/// curve approximates the original bend instead of re-fitting it.
/// `tolerance <= 0` returns the input unchanged.
pub fn simplify_path(cmds: &[PathCmd], tolerance: f64) -> Vec<PathCmd> {
    if !(tolerance > 0.0) {
        return cmds.to_vec();
    }
    let mut out: Vec<PathCmd> = vec![];
    let mut group: Vec<usize> = vec![];
    for (i, c) in cmds.iter().enumerate() {
        match c {
            PathCmd::Close => {
                emit_simplified(&mut out, cmds, &group, tolerance);
                group.clear();
                out.push(PathCmd::Close);
            }
            PathCmd::MoveTo(..) => {
                // a new subpath starts here even without a Close
                emit_simplified(&mut out, cmds, &group, tolerance);
                group.clear();
                group.push(i);
            }
            _ => group.push(i),
        }
    }
    emit_simplified(&mut out, cmds, &group, tolerance);
    out
}

/// Push `group`'s surviving commands onto `out` (see [`simplify_path`]).
fn emit_simplified(out: &mut Vec<PathCmd>, cmds: &[PathCmd], group: &[usize], tolerance: f64) {
    if group.is_empty() {
        return;
    }
    if group.len() < 3 {
        // nothing to drop: a two-anchor segment IS its own chord
        out.extend(group.iter().map(|&i| cmds[i]));
        return;
    }
    let pts: Vec<(f64, f64)> = group.iter().map(|&i| anchor_point(cmds[i])).collect();
    let keep = rdp_keep(&pts, tolerance);
    // Curve guard. RDP measures ANCHOR positions, so a cubic that bulges far off
    // a straight chord between two collinear anchors would look redundant and be
    // dropped — simplifying would flatten the curve into a line. Any anchor that
    // bounds a segment bulging more than the tolerance therefore survives.
    let mut forced = vec![false; group.len()];
    for (k, w) in group.windows(2).enumerate() {
        if segment_deviation(cmds[w[1]], anchor_point(cmds[w[0]])) > tolerance {
            forced[k] = true;
            forced[k + 1] = true;
        }
    }
    for (i, &ci) in group.iter().enumerate() {
        if keep[i] || forced[i] {
            out.push(cmds[ci]);
        }
    }
}

/// How far a segment bulges away from the straight chord between its own
/// anchors: exactly 0 for a line, the sampled maximum for a cubic (16 samples,
/// the same resolution [`segment_at`] hit-tests at).
fn segment_deviation(cmd: PathCmd, from: (f64, f64)) -> f64 {
    let PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y) = cmd else {
        return 0.0;
    };
    // Pinned to f64 on purpose: rustc resolves an inherent method call from the
    // receiver alone, so `worst.max(..)` on a bare `0.0` literal is E0689
    // ("ambiguous numeric type {float}") even though every operand here is f64.
    let mut worst: f64 = 0.0;
    for k in 1..16 {
        let t = k as f64 / 16.0;
        let mt = 1.0 - t;
        let px = mt * mt * mt * from.0
            + 3.0 * mt * mt * t * c1x
            + 3.0 * mt * t * t * c2x
            + t * t * t * x;
        let py = mt * mt * mt * from.1
            + 3.0 * mt * mt * t * c1y
            + 3.0 * mt * t * t * c2y
            + t * t * t * y;
        worst = worst.max(perp_dist((px, py), from, (x, y)));
    }
    worst
}

/// One segment of a subpath, with the control points that shaped it, so it can
/// be re-emitted travelling the other way.
#[derive(Debug, Clone, Copy)]
struct RevSeg {
    from: (f64, f64),
    ctrl: Option<((f64, f64), (f64, f64))>,
    to: (f64, f64),
}

/// Reverse a path's direction of travel (Figma: Edit object > Reverse) — what
/// turns a contour into a hole under even-odd fill, and what swaps an open
/// stroke's start and end caps.
///
/// Every subpath is re-emitted from its last anchor back to its first. A cubic
/// keeps its exact shape because traversing it backwards swaps its two control
/// points; closed subpaths stay closed. A malformed path whose drawing commands
/// arrive without a `MoveTo` is re-rooted at its first point rather than
/// dropped.
pub fn reverse_path(cmds: &[PathCmd]) -> Vec<PathCmd> {
    let mut out: Vec<PathCmd> = vec![];
    let mut start: Option<(f64, f64)> = None;
    let mut cur = (0.0, 0.0);
    let mut segs: Vec<RevSeg> = vec![];
    let mut closed = false;
    for c in cmds {
        match *c {
            PathCmd::MoveTo(x, y) => {
                reverse_subpath(&mut out, start, &segs, closed);
                segs.clear();
                closed = false;
                start = Some((x, y));
                cur = (x, y);
            }
            PathCmd::LineTo(x, y) => {
                if start.is_none() {
                    start = Some(cur);
                }
                segs.push(RevSeg {
                    from: cur,
                    ctrl: None,
                    to: (x, y),
                });
                cur = (x, y);
            }
            PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y) => {
                if start.is_none() {
                    start = Some(cur);
                }
                segs.push(RevSeg {
                    from: cur,
                    ctrl: Some(((c1x, c1y), (c2x, c2y))),
                    to: (x, y),
                });
                cur = (x, y);
            }
            PathCmd::Close => {
                closed = true;
                reverse_subpath(&mut out, start, &segs, closed);
                segs.clear();
                closed = false;
                start = None;
                cur = (0.0, 0.0);
            }
        }
    }
    reverse_subpath(&mut out, start, &segs, closed);
    out
}

/// Emit one subpath backwards (see [`reverse_path`]).
fn reverse_subpath(
    out: &mut Vec<PathCmd>,
    start: Option<(f64, f64)>,
    segs: &[RevSeg],
    closed: bool,
) {
    let Some(first) = start else {
        return;
    };
    if segs.is_empty() {
        out.push(PathCmd::MoveTo(first.0, first.1));
        if closed {
            out.push(PathCmd::Close);
        }
        return;
    }
    let last = segs[segs.len() - 1].to;
    out.push(PathCmd::MoveTo(last.0, last.1));
    for seg in segs.iter().rev() {
        match seg.ctrl {
            // backwards through a cubic: swap c1 and c2, land on the old start
            Some((c1, c2)) => out.push(PathCmd::CurveTo(
                c2.0, c2.1, c1.0, c1.1, seg.from.0, seg.from.1,
            )),
            None => out.push(PathCmd::LineTo(seg.from.0, seg.from.1)),
        }
    }
    if closed {
        out.push(PathCmd::Close);
    }
}

/// Split a path at an anchor into two OPEN paths (Figma: split; Illustrator's
/// scissors). The anchor itself ends the first half and starts the second, so no
/// geometry is lost. `Close` is dropped from both halves — a split loop becomes
/// two open strokes, which is the point of splitting. With several subpaths,
/// everything before the cut stays in the first half and everything after it
/// goes to the second (both remain valid paths).
///
/// Returns None when there is nothing to split: fewer than three anchors, or
/// `anchor_idx` is the first or the last anchor.
pub fn split_path_at(cmds: &[PathCmd], anchor_idx: usize) -> Option<(Vec<PathCmd>, Vec<PathCmd>)> {
    let list = anchors(cmds);
    if list.len() < 3 || anchor_idx == 0 || anchor_idx + 1 >= list.len() {
        return None;
    }
    let cut = list[anchor_idx].cmd_index;
    let (mut a, mut b) = (vec![], vec![]);
    for (i, c) in cmds.iter().enumerate() {
        if matches!(c, PathCmd::Close) {
            continue;
        }
        if i < cut {
            a.push(*c);
        } else if i == cut {
            a.push(*c);
            let (x, y) = anchor_point(*c);
            b.push(PathCmd::MoveTo(x, y));
        } else {
            b.push(*c);
        }
    }
    if a.len() < 2 || b.len() < 2 {
        return None;
    }
    Some((a, b))
}

/// Translate every point of a path — anchors AND control points — by (dx, dy).
pub fn translate_path(cmds: &[PathCmd], dx: f64, dy: f64) -> Vec<PathCmd> {
    cmds.iter().map(|&c| c_shift(c, dx, dy)).collect()
}

/// Bend the corner at anchor `idx` into a smooth point by placing a handle at
/// `pos` — Figma's drag on a corner point, and the whole of "add a handle".
///
/// The segment the user drags on gets the handle; with `mirror` (the default
/// drag, Alt NOT held) the opposite handle follows as the reflection of `pos`
/// through the anchor, so the point stays smooth. Still-straight segments are
/// promoted to cubics with the same one-third handles [`Editor::convert_anchor`]
/// uses, which is what makes a corner point become a curve point in ONE undo
/// step. Anchor 0 of an open path has no incoming segment, so the handle goes
/// on the outgoing one. Returns None when the anchor does not exist.
pub fn bend_anchor(
    path: &[PathCmd],
    idx: usize,
    pos: (f64, f64),
    mirror: bool,
) -> Option<Vec<PathCmd>> {
    let list = anchors(path);
    let a = list.get(idx).copied()?;
    let prev = if idx > 0 {
        list.get(idx - 1).copied()
    } else {
        None
    };
    let mut p = path.to_vec();
    let third = |from: (f64, f64), to: (f64, f64)| {
        (
            from.0 + (to.0 - from.0) / 3.0,
            from.1 + (to.1 - from.1) / 3.0,
            from.0 + 2.0 * (to.0 - from.0) / 3.0,
            from.1 + 2.0 * (to.1 - from.1) / 3.0,
        )
    };
    // incoming segment: the command that LANDS on this anchor
    if prev.is_some() {
        if let PathCmd::LineTo(x, y) = p[a.cmd_index] {
            let (c1x, c1y, c2x, c2y) = third((prev.map(|q| (q.x, q.y)).unwrap_or((x, y))), (x, y));
            p[a.cmd_index] = PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y);
        }
        if let PathCmd::CurveTo(c1x, c1y, _, _, x, y) = p[a.cmd_index] {
            p[a.cmd_index] = PathCmd::CurveTo(c1x, c1y, pos.0, pos.1, x, y);
        }
    }
    // outgoing segment: only touched when the handle is mirrored through the
    // anchor, or when there is no incoming segment to put it on
    let want_out = (mirror && prev.is_some()) || prev.is_none();
    if want_out {
        if let Some(&next) = p.get(a.cmd_index + 1) {
            let end = match next {
                PathCmd::LineTo(x, y) | PathCmd::CurveTo(_, _, _, _, x, y) => Some((x, y)),
                PathCmd::MoveTo(..) | PathCmd::Close => None,
            };
            if let Some((x, y)) = end {
                let promoted = match next {
                    PathCmd::LineTo(..) => {
                        let (c1x, c1y, c2x, c2y) = third((a.x, a.y), (x, y));
                        PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y)
                    }
                    other => other,
                };
                let c1 = if prev.is_some() {
                    (2.0 * a.x - pos.0, 2.0 * a.y - pos.1)
                } else {
                    pos
                };
                if let PathCmd::CurveTo(_, _, c2x, c2y, ex, ey) = promoted {
                    p[a.cmd_index + 1] = PathCmd::CurveTo(c1.0, c1.1, c2x, c2y, ex, ey);
                }
            }
        }
    }
    Some(p)
}

/// Move one bezier control handle inside a path: the pure half of
/// [`Editor::move_handle`], factored out so an interactive drag can reuse the
/// exact same geometry through [`Editor::live_rewrite_path`] instead of
/// duplicating it.
///
/// `outgoing`: false = the INCOMING handle (c2 of the segment arriving at the
/// anchor), true = the OUTGOING one (c1 of the segment leaving it). With
/// `mirror` (the default drag, Alt NOT held) the opposite handle is reflected
/// through the anchor — same distance, opposite angle — so the point stays
/// smooth; pass false (Alt held) to break the tangent and move only this one.
/// Returns None when the anchor or that handle does not exist, i.e. when
/// nothing would change — which is what keeps a no-op off the undo stack.
pub fn move_handle_in(
    path: &[PathCmd],
    anchor_idx: usize,
    outgoing: bool,
    nx: f64,
    ny: f64,
    mirror: bool,
) -> Option<Vec<PathCmd>> {
    let a = anchors(path).get(anchor_idx).copied()?;
    let mut p = path.to_vec();
    let mut changed = false;
    if outgoing {
        if let Some(PathCmd::CurveTo(x1, y1, _, _, _, _)) = p.get_mut(a.cmd_index + 1) {
            *x1 = nx;
            *y1 = ny;
            changed = true;
        }
    } else if let Some(PathCmd::CurveTo(_, _, x2, y2, _, _)) = p.get_mut(a.cmd_index) {
        *x2 = nx;
        *y2 = ny;
        changed = true;
    }
    if !changed {
        return None;
    }
    if mirror {
        // reflect through the anchor: same distance, opposite side
        let (mx, my) = (2.0 * a.x - nx, 2.0 * a.y - ny);
        if outgoing {
            if let Some(PathCmd::CurveTo(_, _, x2, y2, _, _)) = p.get_mut(a.cmd_index) {
                *x2 = mx;
                *y2 = my;
            }
        } else if let Some(PathCmd::CurveTo(x1, y1, _, _, _, _)) = p.get_mut(a.cmd_index + 1) {
            *x1 = mx;
            *y1 = my;
        }
    }
    Some(p)
}

/// True when a transform is a pure translation, i.e. when a node's local path
/// can be moved into another node's local space by adding an offset.
fn translate_only(t: &Transform) -> bool {
    t.rotation.abs() < 1e-9
        && (t.scale_x - 1.0).abs() < 1e-9
        && (t.scale_y - 1.0).abs() < 1e-9
        && t.skew_x.abs() < 1e-9
        && t.skew_y.abs() < 1e-9
}

/// Ray-cast point-in-polygon test (even-odd), used by the lasso.
pub fn point_in_polygon(p: (f64, f64), poly: &[(f64, f64)]) -> bool {
    if poly.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > p.1) != (yj > p.1) && p.0 < (xj - xi) * (p.1 - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

impl Editor {
    /// Rewrite one vector node's path through `f` as ONE undo step — the single
    /// funnel every path-level operation goes through.
    ///
    /// `f` returns `None` to decline (nothing to do, degenerate result), and
    /// then NOTHING is pushed: a refused operation never dirties the undo stack,
    /// so Undo always undoes something the user actually did. On success the
    /// node's stored w/h grow to cover the new path — the same grow-only
    /// contract [`Editor::move_anchor`] has.
    pub fn rewrite_path(
        &mut self,
        id: &str,
        f: impl FnOnce(&[PathCmd]) -> Option<Vec<PathCmd>>,
    ) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Vector { path } = &n.kind else {
            return false;
        };
        let Some(next) = f(path) else {
            return false;
        };
        if next.is_empty() {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            *p = next;
        }
        grow_bounds(&mut after);
        self.push_replace(id, before, after);
        true
    }

    /// Drag every selected anchor of the node in vector edit mode (Figma: node
    /// tool with several points selected, or arrow-key nudge). ONE undo step for
    /// the whole drag. False when not in vector edit mode or nothing is
    /// selected.
    pub fn move_vector_points(&mut self, dx: f64, dy: f64) -> bool {
        let Some(id) = self.vector_edit_node.clone() else {
            return false;
        };
        let idxs = self.vector_edit_selected_points.clone();
        if idxs.is_empty() || (dx == 0.0 && dy == 0.0) {
            return false;
        }
        self.rewrite_path(&id, |path| {
            let mut p = path.to_vec();
            let was = p.clone();
            move_anchors_by(&mut p, &idxs, dx, dy);
            (p != was).then_some(p)
        })
    }

    /// Delete the selected anchors (Figma: Backspace in node edit mode). ONE
    /// undo step; refuses — leaving the selection alone — when fewer than two
    /// anchors would survive.
    pub fn delete_vector_points(&mut self) -> bool {
        let Some(id) = self.vector_edit_node.clone() else {
            return false;
        };
        let idxs = self.vector_edit_selected_points.clone();
        if idxs.is_empty() {
            return false;
        }
        let done = self.rewrite_path(&id, |path| {
            let mut p = path.to_vec();
            delete_anchors(&mut p, &idxs).then_some(p)
        });
        if done {
            self.vector_edit_selected_points.clear();
        }
        done
    }

    /// Add an anchor on the segment ENDING at `segment_idx` and place it at
    /// `position` — the two halves of one pen click on a segment, so ONE undo
    /// step. `segment_idx` uses [`segment_at`]'s addressing: the END anchor of
    /// the hit segment (0 = the implicit closing segment, which cannot take a
    /// point this way).
    pub fn add_vector_point(&mut self, segment_idx: usize, position: (f64, f64)) -> bool {
        let Some(id) = self.vector_edit_node.clone() else {
            return false;
        };
        self.rewrite_path(&id, |path| {
            let mut p = split_segment_at(path, segment_idx)?;
            // the inserted anchor took `segment_idx`; the old end anchor moved
            // up one. Place the new one where the user clicked.
            let new_a = anchors(&p).get(segment_idx).copied()?;
            move_anchors_by(
                &mut p,
                &[segment_idx],
                position.0 - new_a.x,
                position.1 - new_a.y,
            );
            Some(p)
        })
    }

    /// Simplify a path (Figma: Edit object > Simplify): the node in vector edit
    /// mode, else the single selected node. `tolerance` is in local units; see
    /// [`simplify_path`] for what survives and what approximates.
    pub fn simplify_vector(&mut self, tolerance: f64) -> bool {
        let Some(id) = self
            .vector_edit_node
            .clone()
            .or_else(|| self.selection.first().cloned())
        else {
            return false;
        };
        self.rewrite_path(&id, |path| {
            let p = simplify_path(path, tolerance);
            // only worth an undo entry when it actually removed something
            (p.len() < path.len()).then_some(p)
        })
    }

    /// Offset a vector path along its normals (Figma: Object > Offset path).
    /// Positive `distance` grows a closed path outward and moves an open one to
    /// the left of travel; `join` picks the corner treatment. The result
    /// replaces the path in place — ONE undo step. Curves come back polygonal
    /// (the same trade Figma makes when it re-authors the path).
    pub fn offset_vector(&mut self, node_id: &str, distance: f64, join: StrokeJoin) -> bool {
        // A zero offset is not a no-op: it would re-author the path through the
        // flattener and hand back the same shape with its curves polygonised.
        // Refused instead, which also keeps it off the undo stack.
        if distance == 0.0 {
            return false;
        }
        self.rewrite_path(node_id, |path| {
            let p = x_core::booleans::offset_path(path, distance, join);
            (!p.is_empty()).then_some(p)
        })
    }

    /// Reverse a path's direction (Figma: Edit object > Reverse). ONE undo step.
    pub fn reverse_path_direction(&mut self, node_id: &str) -> bool {
        self.rewrite_path(node_id, |path| {
            (!path.is_empty()).then(|| reverse_path(path))
        })
    }

    /// Split a path at an anchor into TWO vector nodes (Figma: split /
    /// Illustrator's scissors). The second half is inserted right after the
    /// first and selected; both keep the original's paint, stroke and
    /// transform. ONE undo step. Returns the new node's id.
    pub fn split_vector_path(&mut self, node_id: &str, anchor_idx: usize) -> Option<String> {
        let n = find(&self.root, node_id)?.clone();
        let NodeKind::Vector { path } = &n.kind else {
            return None;
        };
        let (pa, pb) = split_path_at(path, anchor_idx)?;
        let parent = parent_id(&self.root, node_id)?;
        let index = {
            let p = find(&self.root, &parent)?;
            p.children.iter().position(|c| c.id == node_id)?
        };
        let new_id = x_core::fresh_id("split");
        let mut second = n.clone();
        second.id = new_id.clone();
        second.name = format!("{} 2", n.name);
        if let NodeKind::Vector { path: p } = &mut second.kind {
            *p = pb;
        }
        grow_bounds(&mut second);
        let mut first = n.clone();
        if let NodeKind::Vector { path: p } = &mut first.kind {
            *p = pa;
        }
        self.push_cmds(vec![
            Command::ReplaceNode {
                id: node_id.to_string(),
                before: Box::new(n),
                after: Box::new(first),
            },
            Command::Insert {
                parent_id: parent,
                index: index + 1,
                node: second,
            },
        ]);
        self.selection = vec![new_id.clone()];
        Some(new_id)
    }

    /// Join two vector paths end to end into ONE node (Figma: Edit object > Join
    /// selection): the END of `a` connects to the START of `b`, and `b` is
    /// removed. Both paths live in their own node's local space, so `b` is
    /// translated by the difference of the two origins; a node that is rotated,
    /// scaled or skewed cannot be mapped by translation alone, and the join is
    /// REFUSED (None) rather than silently producing wrong geometry. ONE undo
    /// step. Returns the surviving node's id.
    pub fn join_paths(&mut self, a: &str, b: &str) -> Option<String> {
        if a == b {
            return None;
        }
        let na = find(&self.root, a)?.clone();
        let nb = find(&self.root, b)?.clone();
        let NodeKind::Vector { path: pa } = &na.kind else {
            return None;
        };
        let NodeKind::Vector { path: pb } = &nb.kind else {
            return None;
        };
        if pa.is_empty() || pb.is_empty() {
            return None;
        }
        if !translate_only(&na.transform) || !translate_only(&nb.transform) {
            return None;
        }
        let mut joined = pa.clone();
        // the two become ONE continuous stroke: a trailing Close would cut it
        if matches!(joined.last(), Some(PathCmd::Close)) {
            joined.pop();
        }
        let mut tail = translate_path(
            pb,
            nb.transform.x - na.transform.x,
            nb.transform.y - na.transform.y,
        );
        // Where the two ends already meet they become ONE anchor; otherwise the
        // gap between them is bridged with a straight segment. Either way the
        // stroke is continuous, and b's opening MoveTo is never kept (a MoveTo
        // in the middle of a path would start a second subpath).
        let meets = match (joined.last().map(|&c| anchor_point(c)), tail.first()) {
            (Some((lx, ly)), Some(&PathCmd::MoveTo(x, y))) => (lx - x).hypot(ly - y) < 1e-6,
            _ => false,
        };
        if meets {
            tail.remove(0);
        } else if let Some(&PathCmd::MoveTo(x, y)) = tail.first() {
            tail[0] = PathCmd::LineTo(x, y);
        }
        joined.append(&mut tail);
        let parent = parent_id(&self.root, b)?;
        let index = {
            let p = find(&self.root, &parent)?;
            p.children.iter().position(|c| c.id == b)?
        };
        let mut after = na.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            *p = joined;
        }
        grow_bounds(&mut after);
        self.push_cmds(vec![
            Command::ReplaceNode {
                id: a.to_string(),
                before: Box::new(na),
                after: Box::new(after),
            },
            Command::Delete {
                parent_id: parent,
                index,
                node: nb,
            },
        ]);
        self.selection = vec![a.to_string()];
        Some(a.to_string())
    }

    /// Lasso-select anchors (Figma: drag a marquee in node edit mode). The
    /// boundary is in WORLD space, the same space [`crate::vector_handles`] hits
    /// in, so the answer is the list of ANCHOR indices inside it. Cheap and
    /// side-effect free: the caller decides whether to replace or extend the
    /// selection.
    pub fn lasso_select_points(&self, node_id: &str, boundary: &[(f64, f64)]) -> Vec<usize> {
        if boundary.len() < 3 {
            return vec![];
        }
        let Some(n) = find(&self.root, node_id) else {
            return vec![];
        };
        crate::vector_handles::anchors_world(n)
            .into_iter()
            .filter(|a| point_in_polygon((a.x, a.y), boundary))
            .map(|a| a.index)
            .collect()
    }

    /// Drag a handle out of a corner point (Figma: pen/node tool drag on a
    /// point that has no handles). `handle_pos` is in the node's LOCAL space,
    /// matching [`Editor::move_handle`]. ONE undo step, and the point stays
    /// smooth because the opposite handle mirrors by default.
    pub fn add_bezier_handle(
        &mut self,
        node_id: &str,
        anchor_idx: usize,
        handle_pos: (f64, f64),
    ) -> bool {
        self.rewrite_path(node_id, |path| {
            bend_anchor(path, anchor_idx, handle_pos, true)
        })
    }

    /// Move one bezier handle of an anchor: `handle_idx` 0 = incoming (the
    /// segment arriving at the point), 1 = outgoing. Mirrored by default, so the
    /// point stays smooth — the Alt-drag that breaks the tangent is
    /// [`Editor::move_handle`] with `mirror: false`.
    pub fn adjust_bezier_handle(
        &mut self,
        node_id: &str,
        anchor_idx: usize,
        handle_idx: usize,
        new_pos: (f64, f64),
    ) -> bool {
        self.move_handle(
            node_id,
            anchor_idx,
            handle_idx == 1,
            new_pos.0,
            new_pos.1,
            true,
        )
    }

    /// Take the handles away from an anchor: a curve point collapses back to a
    /// corner (Figma's "convert point", the same operation from the other
    /// direction). ONE undo step.
    ///
    /// [`Editor::convert_anchor`] only straightens the INCOMING segment, which
    /// would leave the point half-curved; a corner has no handles on EITHER
    /// side, so both are collapsed here and refused when there was nothing to
    /// collapse (nothing pushed, as everywhere else).
    pub fn remove_bezier_handles(&mut self, node_id: &str, anchor_idx: usize) -> bool {
        self.rewrite_path(node_id, |path| {
            let a = anchors(path).get(anchor_idx).copied()?;
            let mut p = path.to_vec();
            let mut changed = false;
            if let PathCmd::CurveTo(_, _, _, _, x, y) = p[a.cmd_index] {
                p[a.cmd_index] = PathCmd::LineTo(x, y);
                changed = true;
            }
            if let Some(PathCmd::CurveTo(_, _, _, _, x, y)) = p.get(a.cmd_index + 1) {
                let (x, y) = (*x, *y);
                p[a.cmd_index + 1] = PathCmd::LineTo(x, y);
                changed = true;
            }
            changed.then_some(p)
        })
    }
}

// ---------------------------------------------------------------------------
// Interactive path gestures: ONE undo entry per drag, not per mouse-move event
// ---------------------------------------------------------------------------

impl Editor {
    /// Open an interactive path gesture (dragging anchors, dragging a handle,
    /// pulling a handle out of a corner) on a vector node.
    ///
    /// A mouse drag fires hundreds of move events. If each one pushed a
    /// `ReplaceNode`, Undo would crawl back through the gesture a pixel at a
    /// time — so the gesture snapshots the node here, the live mutators
    /// ([`Editor::live_rewrite_path`]) change the tree WITHOUT pushing, and
    /// [`Editor::end_path_gesture`] commits the whole drag as the single undo
    /// entry it is. Only one gesture can be open at a time; a second `begin`
    /// returns false and leaves the FIRST snapshot alone, so a stray press
    /// mid-drag cannot lose where the drag started. Refuses anything that is
    /// not a vector node.
    pub fn begin_path_gesture(&mut self, node_id: &str) -> bool {
        if self.path_gesture.is_some() {
            return false;
        }
        let Some(n) = find(&self.root, node_id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Vector { .. }) {
            return false;
        }
        self.path_gesture = Some((node_id.to_string(), n.clone()));
        true
    }

    /// True while a gesture snapshot is open.
    pub fn path_gesture_active(&self) -> bool {
        self.path_gesture.is_some()
    }

    /// Change a path WITHOUT touching the undo log: the live half of a gesture.
    ///
    /// Identical to [`Editor::rewrite_path`] except that it pushes nothing and
    /// writes in place (no clone of the node, no command). Bracket it with
    /// [`Editor::begin_path_gesture`] / [`Editor::end_path_gesture`] — a live
    /// rewrite outside a gesture still lands in the tree, because the tree is
    /// what the canvas paints, but it is then not undoable.
    pub fn live_rewrite_path(
        &mut self,
        id: &str,
        f: impl FnOnce(&[PathCmd]) -> Option<Vec<PathCmd>>,
    ) -> bool {
        let next = {
            let Some(n) = find(&self.root, id) else {
                return false;
            };
            let NodeKind::Vector { path } = &n.kind else {
                return false;
            };
            let Some(next) = f(path) else {
                return false;
            };
            if next.is_empty() {
                return false;
            }
            next
        };
        let Some(n) = find_mut(&mut self.root, id) else {
            return false;
        };
        if let NodeKind::Vector { path: p } = &mut n.kind {
            *p = next;
        }
        grow_bounds(n);
        true
    }

    /// Commit the open gesture as ONE undo entry. Returns false — pushing
    /// nothing — when no gesture is open, when its node has gone away, or when
    /// the path came back to exactly what it was (a press that never moved is
    /// not an edit, and must not consume an Undo).
    pub fn end_path_gesture(&mut self) -> bool {
        let Some((id, before)) = self.path_gesture.take() else {
            return false;
        };
        let Some(now) = find(&self.root, &id) else {
            return false;
        };
        // `Node` has no PartialEq, and the gesture only ever moves path data,
        // so the paths are what gets compared
        let moved = match (&now.kind, &before.kind) {
            (NodeKind::Vector { path: a }, NodeKind::Vector { path: b }) => a != b,
            _ => true,
        };
        if !moved {
            return false;
        }
        let after = now.clone();
        self.push_replace(&id, Box::new(before), after);
        true
    }

    /// Abandon the gesture: put the snapshot back WITHOUT pushing, so Esc
    /// mid-drag leaves no trace in the tree and nothing on the undo stack.
    pub fn cancel_path_gesture(&mut self) {
        if let Some((id, before)) = self.path_gesture.take() {
            if let Some(n) = find_mut(&mut self.root, &id) {
                *n = before;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    fn editor_with_vec() -> Editor {
        Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            10.0,
            10.0,
            vec![],
        )))
    }

    #[test]
    fn pen_builds_a_path_click_by_click_and_closes() {
        let mut e = editor_with_vec();
        assert!(e.pen_add_anchor("v", 0.0, 0.0));
        assert!(e.pen_add_anchor("v", 100.0, 0.0));
        assert!(e.pen_add_anchor("v", 100.0, 80.0));
        assert!(e.pen_close("v"));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path.len(), 4);
        assert_eq!(path[0], PathCmd::MoveTo(0.0, 0.0));
        assert_eq!(*path.last().unwrap(), PathCmd::Close);
        // whole pen session unwinds through undo
        e.undo();
        e.undo();
        e.undo();
        e.undo();
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert!(path.is_empty());
    }

    #[test]
    fn move_anchor_carries_handles_rigidly() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::CurveTo(10.0, 0.0, 40.0, 50.0, 50.0, 50.0),
                PathCmd::CurveTo(60.0, 50.0, 90.0, 0.0, 100.0, 0.0),
            ],
        )));
        // anchor 1 = end of first cubic at (50,50); move to (55,60)
        assert!(e.move_anchor("v", 1, 55.0, 60.0));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        // incoming c2 moved by (+5,+10)
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 45.0, 60.0, 55.0, 60.0));
        // outgoing c1 moved rigidly too
        assert_eq!(path[2], PathCmd::CurveTo(65.0, 60.0, 90.0, 0.0, 100.0, 0.0));
        e.undo();
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 40.0, 50.0, 50.0, 50.0));
    }

    #[test]
    fn bezier_handles_drag_independently() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::CurveTo(10.0, 0.0, 40.0, 50.0, 50.0, 50.0),
                PathCmd::CurveTo(60.0, 50.0, 90.0, 0.0, 100.0, 0.0),
            ],
        )));
        // anchor 1 at (50,50): incoming handle = (40,50), outgoing = (60,50)
        assert_eq!(e.out_handle("v", 1), Some((60.0, 50.0)));
        // drag the INCOMING handle only
        assert!(e.move_handle("v", 1, false, 30.0, 80.0, false));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 30.0, 80.0, 50.0, 50.0));
        // outgoing untouched
        assert_eq!(path[2], PathCmd::CurveTo(60.0, 50.0, 90.0, 0.0, 100.0, 0.0));
        // drag the OUTGOING handle only
        assert!(e.move_handle("v", 1, true, 70.0, 90.0, false));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[2], PathCmd::CurveTo(70.0, 90.0, 90.0, 0.0, 100.0, 0.0));
        // both undoable
        e.undo();
        e.undo();
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 40.0, 50.0, 50.0, 50.0));
        assert_eq!(path[2], PathCmd::CurveTo(60.0, 50.0, 90.0, 0.0, 100.0, 0.0));
        // line segments have no handles -> refused
        let mut e2 = Editor::new(Node::frame("p", 100.0, 100.0).child(Node::vector(
            "l",
            0.0,
            0.0,
            50.0,
            50.0,
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(50.0, 0.0)],
        )));
        assert!(!e2.move_handle("l", 1, false, 1.0, 1.0, false));
    }

    #[test]
    fn bezier_handle_mirrors_by_default_like_figma() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::CurveTo(10.0, 0.0, 40.0, 50.0, 50.0, 50.0),
                PathCmd::CurveTo(60.0, 50.0, 90.0, 0.0, 100.0, 0.0),
            ],
        )));
        // anchor 1 at (50,50); drag the incoming handle to (30,80) with
        // mirroring on (the default, un-Alted drag) — the outgoing handle
        // should jump to the reflection of (30,80) through (50,50).
        assert!(e.move_handle("v", 1, false, 30.0, 80.0, true));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::CurveTo(10.0, 0.0, 30.0, 80.0, 50.0, 50.0));
        assert_eq!(path[2], PathCmd::CurveTo(70.0, 20.0, 90.0, 0.0, 100.0, 0.0));
    }

    #[test]
    fn convert_point_roundtrips_line_and_curve() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(90.0, 0.0)],
        )));
        assert!(e.convert_anchor("v", 1));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::CurveTo(30.0, 0.0, 60.0, 0.0, 90.0, 0.0));
        assert!(e.convert_anchor("v", 1));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[1], PathCmd::LineTo(90.0, 0.0));
    }

    #[test]
    fn split_segment_inserts_midpoint_and_preserves_curve_shape_ends() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)],
        )));
        assert!(e.split_segment("v", 1));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path.len(), 3);
        assert_eq!(path[1], PathCmd::LineTo(50.0, 0.0));
        assert_eq!(path[2], PathCmd::LineTo(100.0, 0.0));
        // cubic split keeps endpoints
        let mut e2 = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "c",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::CurveTo(0.0, 100.0, 100.0, 100.0, 100.0, 0.0),
            ],
        )));
        assert!(e2.split_segment("c", 1));
        let NodeKind::Vector { path } = &find(&e2.root, "c").unwrap().kind else {
            panic!()
        };
        assert_eq!(path.len(), 3);
        assert!(matches!(path[1], PathCmd::CurveTo(..)));
        if let PathCmd::CurveTo(_, _, _, _, x, y) = path[2] {
            assert_eq!((x, y), (100.0, 0.0));
        }
        // midpoint of this symmetric curve is (50, 75)
        if let PathCmd::CurveTo(_, _, _, _, mx, my) = path[1] {
            assert_eq!((mx, my), (50.0, 75.0));
        }
    }

    #[test]
    fn delete_anchor_and_anchor_hit_test() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(50.0, 50.0),
                PathCmd::LineTo(100.0, 0.0),
            ],
        )));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(anchor_at(path, 51.0, 49.0, 5.0), Some(1));
        assert_eq!(anchor_at(path, 200.0, 200.0, 5.0), None);
        assert!(e.delete_anchor("v", 1));
        let NodeKind::Vector { path } = &find(&e.root, "v").unwrap().kind else {
            panic!()
        };
        assert_eq!(path.len(), 2);
        // deleting the MoveTo re-roots the path
        let mut e2 = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v2",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(50.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
            ],
        )));
        assert!(e2.delete_anchor("v2", 0));
        let NodeKind::Vector { path } = &find(&e2.root, "v2").unwrap().kind else {
            panic!()
        };
        assert_eq!(path[0], PathCmd::MoveTo(50.0, 0.0));
        let _ = Color::BLACK;
    }

    // ---- batch path operations (Figma node-edit parity) -------------------

    /// The path of a vector node, cloned out so assertions can borrow `e`.
    fn path_of(e: &Editor, id: &str) -> Vec<PathCmd> {
        let NodeKind::Vector { path } = &find(&e.root, id).unwrap().kind else {
            panic!("{id} is not a vector")
        };
        path.clone()
    }

    /// An open three-anchor line: (0,0) -> (50,0) -> (100,0).
    fn three_anchors() -> Editor {
        Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(50.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
            ],
        )))
    }

    #[test]
    fn dragging_several_anchors_is_one_undo_step() {
        let mut e = three_anchors();
        assert!(e.enter_vector_edit_mode("v"));
        assert!(e.select_vector_point(0, false));
        assert!(
            e.select_vector_point(1, true),
            "shift adds to the selection"
        );
        assert_eq!(e.vector_edit_selected_points, vec![0, 1]);
        // a stale index (there is no anchor 9) is refused, not mis-applied
        assert!(!e.select_vector_point(9, true));
        let depth = e.undo_depth();
        assert!(e.move_vector_points(0.0, 10.0));
        assert_eq!(
            path_of(&e, "v"),
            vec![
                PathCmd::MoveTo(0.0, 10.0),
                PathCmd::LineTo(50.0, 10.0),
                PathCmd::LineTo(100.0, 0.0),
            ],
            "both selected anchors moved, the unselected one stayed"
        );
        assert_eq!(e.undo_depth(), depth + 1, "one drag, one undo entry");
        assert!(e.undo());
        assert_eq!(
            path_of(&e, "v"),
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(50.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
            ]
        );
    }

    #[test]
    fn a_refused_edit_never_reaches_the_undo_stack() {
        let mut e = three_anchors();
        e.enter_vector_edit_mode("v");
        let depth = e.undo_depth();
        assert!(!e.move_vector_points(0.0, 0.0), "a zero nudge is a no-op");
        assert!(!e.delete_vector_points(), "nothing is selected");
        e.select_vector_point(0, false);
        e.select_vector_point(1, true);
        assert!(
            !e.delete_vector_points(),
            "deleting two of three anchors would leave no segment"
        );
        assert!(
            !e.add_vector_point(0, (1.0, 1.0)),
            "segment 0 cannot take one"
        );
        assert_eq!(e.undo_depth(), depth, "undo still undoes real work only");
        // the refused delete left the selection intact, so a real move works
        assert!(e.move_vector_points(5.0, 0.0));
        assert_eq!(path_of(&e, "v")[0], PathCmd::MoveTo(5.0, 0.0));
        assert_eq!(e.undo_depth(), depth + 1);
        // outside vector edit mode nothing is addressable
        let mut e2 = three_anchors();
        assert!(!e2.move_vector_points(1.0, 1.0));
        assert!(!e2.delete_vector_points());
    }

    #[test]
    fn deleting_anchors_keeps_a_segment_and_re_roots_a_move_to() {
        let mut e = three_anchors();
        e.enter_vector_edit_mode("v");
        e.select_vector_point(1, false);
        assert!(e.delete_vector_points());
        assert_eq!(
            path_of(&e, "v"),
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)]
        );
        assert!(
            e.vector_edit_selected_points.is_empty(),
            "deleted anchors leave the selection"
        );
        // deleting the MoveTo re-roots the subpath onto the next anchor
        let mut e2 = three_anchors();
        e2.enter_vector_edit_mode("v");
        e2.select_vector_point(0, false);
        assert!(e2.delete_vector_points());
        assert_eq!(
            path_of(&e2, "v"),
            vec![PathCmd::MoveTo(50.0, 0.0), PathCmd::LineTo(100.0, 0.0)],
            "the path still starts with a MoveTo"
        );
        assert!(e2.undo());
        assert_eq!(path_of(&e2, "v").len(), 3);
    }

    #[test]
    fn adding_a_point_places_it_where_the_pen_clicked() {
        let mut e = three_anchors();
        e.enter_vector_edit_mode("v");
        // segment 1 runs (0,0) -> (50,0); the click is off the chord
        assert!(e.add_vector_point(1, (25.0, 10.0)));
        assert_eq!(
            path_of(&e, "v"),
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(25.0, 10.0),
                PathCmd::LineTo(50.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
            ],
            "the new anchor sits at the click, not at the midpoint"
        );
        assert!(e.undo());
        assert_eq!(path_of(&e, "v").len(), 3, "one gesture, one undo step");
    }

    #[test]
    fn simplify_drops_collinear_anchors_but_never_a_curve() {
        let p = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(25.0, 0.0),
            PathCmd::LineTo(50.0, 0.0),
            PathCmd::LineTo(50.0, 20.0),
            PathCmd::LineTo(100.0, 20.0),
        ];
        assert_eq!(
            simplify_path(&p, 0.5),
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(50.0, 0.0),
                PathCmd::LineTo(50.0, 20.0),
                PathCmd::LineTo(100.0, 20.0),
            ],
            "the collinear midpoint goes, the corner stays"
        );
        assert_eq!(
            simplify_path(&p, 0.0),
            p,
            "a zero tolerance changes nothing"
        );
        assert_eq!(
            simplify_path(&p, -1.0),
            p,
            "and neither does a negative one"
        );
        // a cubic whose ANCHORS look collinear keeps both anchors and its
        // command: simplifying must never flatten a curve into a line
        let c = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::CurveTo(0.0, 40.0, 60.0, 40.0, 60.0, 0.0),
            PathCmd::LineTo(61.0, 0.0),
            PathCmd::LineTo(120.0, 0.0),
        ];
        let s = simplify_path(&c, 1.0);
        assert!(
            matches!(s.get(1), Some(PathCmd::CurveTo(..))),
            "the curve survives: {s:?}"
        );
        assert_eq!(s.len(), 3, "the collinear line anchors collapse: {s:?}");
        // through the editor it is one undo step, and a no-op pushes nothing
        let mut e = Editor::new(
            Node::frame("page", 800.0, 600.0).child(Node::vector("v", 0.0, 0.0, 200.0, 40.0, c)),
        );
        e.selection = vec!["v".into()];
        let depth = e.undo_depth();
        assert!(!e.simplify_vector(0.0), "a zero tolerance removes nothing");
        assert_eq!(e.undo_depth(), depth, "so nothing is pushed");
        assert!(e.simplify_vector(1.0));
        assert_eq!(e.undo_depth(), depth + 1, "one gesture, one undo step");
        assert!(e.undo());
        assert_eq!(path_of(&e, "v").len(), 4);
    }

    #[test]
    fn reverse_flips_direction_and_keeps_curve_shape() {
        let sq = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(10.0, 0.0),
            PathCmd::LineTo(10.0, 10.0),
            PathCmd::Close,
        ];
        assert_eq!(
            reverse_path(&sq),
            vec![
                PathCmd::MoveTo(10.0, 10.0),
                PathCmd::LineTo(10.0, 0.0),
                PathCmd::LineTo(0.0, 0.0),
                PathCmd::Close,
            ],
            "the loop runs the other way and stays closed"
        );
        let c = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::CurveTo(10.0, 20.0, 30.0, 40.0, 50.0, 60.0),
        ];
        assert_eq!(
            reverse_path(&c),
            vec![
                PathCmd::MoveTo(50.0, 60.0),
                PathCmd::CurveTo(30.0, 40.0, 10.0, 20.0, 0.0, 0.0),
            ],
            "backwards through a cubic swaps its control points"
        );
        // one undo step through the editor
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            20.0,
            20.0,
            sq.clone(),
        )));
        let depth = e.undo_depth();
        assert!(e.reverse_path_direction("v"));
        assert_eq!(e.undo_depth(), depth + 1);
        assert!(e.undo());
        assert_eq!(path_of(&e, "v"), sq);
        assert!(
            !e.reverse_path_direction("nope"),
            "an unknown node is refused"
        );
    }

    #[test]
    fn split_makes_two_open_paths_sharing_the_cut_anchor() {
        let p = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(50.0, 0.0),
            PathCmd::LineTo(100.0, 0.0),
            PathCmd::Close,
        ];
        let (a, b) = split_path_at(&p, 1).expect("splits at the middle anchor");
        assert_eq!(
            a,
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(50.0, 0.0)]
        );
        assert_eq!(
            b,
            vec![PathCmd::MoveTo(50.0, 0.0), PathCmd::LineTo(100.0, 0.0)]
        );
        assert!(
            split_path_at(&p, 0).is_none(),
            "the first anchor cannot split"
        );
        assert!(split_path_at(&p, 2).is_none(), "nor can the last");
        // through the editor: two layers, one undo step, the new one selected
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            10.0,
            p.clone(),
        )));
        e.selection = vec!["v".into()];
        let new_id = e.split_vector_path("v", 1).expect("split");
        assert_eq!(e.root.children.len(), 2, "the second half is a sibling");
        assert_eq!(e.root.children[1].id, new_id);
        assert_eq!(
            e.selection,
            vec![new_id.clone()],
            "the new layer is selected"
        );
        assert_eq!(
            path_of(&e, "v"),
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(50.0, 0.0)]
        );
        assert_eq!(path_of(&e, &new_id), b);
        assert!(e.undo());
        assert_eq!(
            e.root.children.len(),
            1,
            "one undo restores the closed path"
        );
        assert_eq!(path_of(&e, "v"), p);
    }

    #[test]
    fn join_connects_two_paths_and_removes_the_second() {
        let page = Node::frame("page", 800.0, 600.0)
            .child(Node::vector(
                "a",
                0.0,
                0.0,
                100.0,
                10.0,
                vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)],
            ))
            .child(Node::vector(
                "b",
                100.0,
                0.0,
                100.0,
                10.0,
                vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)],
            ));
        let mut e = Editor::new(page);
        let depth = e.undo_depth();
        let id = e.join_paths("a", "b").expect("join");
        assert_eq!(id, "a", "the first layer survives");
        assert!(find(&e.root, "b").is_none(), "the second is removed");
        assert_eq!(e.root.children.len(), 1);
        assert_eq!(
            path_of(&e, "a"),
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
                PathCmd::LineTo(200.0, 0.0),
            ],
            "coincident ends become ONE anchor, not a zero-length segment"
        );
        assert_eq!(
            e.undo_depth(),
            depth + 1,
            "replace + delete = one undo step"
        );
        assert!(e.undo());
        assert!(find(&e.root, "a").is_some() && find(&e.root, "b").is_some());
    }

    #[test]
    fn join_adds_a_connecting_segment_when_the_ends_apart() {
        let page = Node::frame("page", 800.0, 600.0)
            .child(Node::vector(
                "a",
                0.0,
                0.0,
                50.0,
                10.0,
                vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(50.0, 0.0)],
            ))
            .child(Node::vector(
                "b",
                100.0,
                0.0,
                50.0,
                10.0,
                vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(50.0, 0.0)],
            ));
        let mut e = Editor::new(page);
        assert!(e.join_paths("a", "b").is_some());
        assert_eq!(
            path_of(&e, "a"),
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(50.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
                PathCmd::LineTo(150.0, 0.0),
            ],
            "the gap between the two ends becomes a straight segment"
        );
    }

    #[test]
    fn join_refuses_what_it_cannot_map_between_local_spaces() {
        let mut b = Node::vector(
            "b",
            100.0,
            0.0,
            100.0,
            10.0,
            vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)],
        );
        b.transform.rotation = 0.5;
        let page = Node::frame("page", 800.0, 600.0)
            .child(Node::vector(
                "a",
                0.0,
                0.0,
                100.0,
                10.0,
                vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)],
            ))
            .child(b)
            .child(Node::rect(
                "r",
                0.0,
                0.0,
                10.0,
                10.0,
                Color::from_rgb8(1, 2, 3),
            ));
        let mut e = Editor::new(page);
        let depth = e.undo_depth();
        assert!(
            e.join_paths("a", "b").is_none(),
            "a rotated node is refused"
        );
        assert!(e.join_paths("a", "r").is_none(), "so is a non-vector");
        assert!(
            e.join_paths("a", "a").is_none(),
            "and joining a node to itself"
        );
        assert!(find(&e.root, "b").is_some(), "nothing was removed");
        assert_eq!(e.undo_depth(), depth, "nothing was pushed");
    }

    #[test]
    fn bending_a_corner_makes_it_smooth_with_mirrored_handles() {
        let mut e = three_anchors();
        // drag a handle out of the middle corner at (50,0)
        assert!(e.add_bezier_handle("v", 1, (50.0, -20.0)));
        let p = path_of(&e, "v");
        assert_eq!(
            p[1],
            PathCmd::CurveTo(50.0 / 3.0, 0.0, 50.0, -20.0, 50.0, 0.0),
            "the straight incoming segment became a cubic ending on the handle"
        );
        assert_eq!(
            p[2],
            PathCmd::CurveTo(50.0, 20.0, 50.0 + 2.0 * 50.0 / 3.0, 0.0, 100.0, 0.0),
            "the outgoing handle mirrors through the anchor, so it stays smooth"
        );
        assert!(e.undo(), "one drag, one undo step");
        assert!(matches!(path_of(&e, "v")[1], PathCmd::LineTo(..)));
        // removing the handles collapses the point back to a corner on BOTH sides
        assert!(e.add_bezier_handle("v", 1, (50.0, -20.0)));
        assert!(e.remove_bezier_handles("v", 1));
        assert!(
            matches!(path_of(&e, "v")[1], PathCmd::LineTo(..)),
            "the incoming segment is straight again"
        );
        assert!(
            matches!(path_of(&e, "v")[2], PathCmd::LineTo(..)),
            "and so is the outgoing one: no half-curved corner"
        );
        assert!(
            !e.remove_bezier_handles("v", 1),
            "a corner has nothing left to remove"
        );
        // dragging an existing handle mirrors through the anchor
        assert!(e.add_bezier_handle("v", 1, (50.0, -20.0)));
        assert!(e.adjust_bezier_handle("v", 1, 1, (70.0, -5.0)));
        let p = path_of(&e, "v");
        assert_eq!(
            p[2],
            PathCmd::CurveTo(70.0, -5.0, 50.0 + 2.0 * 50.0 / 3.0, 0.0, 100.0, 0.0),
            "the outgoing handle went where it was dragged"
        );
        assert_eq!(
            p[1],
            PathCmd::CurveTo(50.0 / 3.0, 0.0, 30.0, 5.0, 50.0, 0.0),
            "the incoming one mirrored through the anchor"
        );
    }

    #[test]
    fn lasso_picks_the_anchors_inside_a_world_boundary() {
        let mut e = three_anchors();
        e.enter_vector_edit_mode("v");
        let box_lasso = vec![(-10.0, -10.0), (60.0, -10.0), (60.0, 10.0), (-10.0, 10.0)];
        assert_eq!(e.lasso_select_points("v", &box_lasso), vec![0, 1]);
        let triangle = vec![(-5.0, -5.0), (5.0, -5.0), (5.0, 5.0)];
        assert_eq!(e.lasso_select_points("v", &triangle), vec![0]);
        assert!(
            e.lasso_select_points("v", &[(0.0, 0.0), (1.0, 1.0)])
                .is_empty(),
            "a degenerate lasso selects nothing"
        );
        assert!(
            e.lasso_select_points("nope", &box_lasso).is_empty(),
            "an unknown node selects nothing"
        );
    }

    #[test]
    fn offset_vector_grows_the_path_outward_as_one_undo_step() {
        let square = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(100.0, 0.0),
            PathCmd::LineTo(100.0, 100.0),
            PathCmd::LineTo(0.0, 100.0),
            PathCmd::Close,
        ];
        let mut e = Editor::new(
            Node::frame("page", 800.0, 600.0)
                .child(Node::vector("v", 0.0, 0.0, 100.0, 100.0, square)),
        );
        let depth = e.undo_depth();
        assert!(e.offset_vector("v", 10.0, StrokeJoin::Miter));
        let p = path_of(&e, "v");
        let a = anchors(&p);
        assert!(a.len() >= 4, "the ring still has its four corners: {a:?}");
        let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for pt in &a {
            minx = minx.min(pt.x);
            miny = miny.min(pt.y);
            maxx = maxx.max(pt.x);
            maxy = maxy.max(pt.y);
        }
        assert!(
            (minx + 10.0).abs() < 1e-6 && (miny + 10.0).abs() < 1e-6,
            "the ring grew outward: top-left is {minx},{miny}"
        );
        assert!(
            (maxx - 110.0).abs() < 1e-6 && (maxy - 110.0).abs() < 1e-6,
            "on every side: bottom-right is {maxx},{maxy}"
        );
        assert!(
            matches!(p.last(), Some(PathCmd::Close)),
            "a closed path stays closed"
        );
        assert_eq!(e.undo_depth(), depth + 1, "one gesture, one undo step");
        assert!(e.undo());
        assert_eq!(path_of(&e, "v").len(), 5);
        // a zero distance would only polygonise the path: refused, nothing pushed
        assert!(!e.offset_vector("v", 0.0, StrokeJoin::Miter));
        assert_eq!(e.undo_depth(), depth);
    }

    // ---- interactive gestures ---------------------------------------------

    /// Twenty live moves inside one gesture must land in the tree immediately
    /// (the canvas paints the tree) but reach the undo log ONCE.
    #[test]
    fn an_interactive_drag_is_one_undo_entry() {
        let mut e = three_anchors();
        e.enter_vector_edit_mode("v");
        e.select_vector_point(0, false);
        assert!(e.begin_path_gesture("v"));
        assert!(e.path_gesture_active());
        // a second begin must not lose where the drag started
        assert!(!e.begin_path_gesture("v"));
        let idxs = e.vector_edit_selected_points.clone();
        for _ in 0..20 {
            assert!(e.live_rewrite_path("v", |p| {
                let mut p = p.to_vec();
                move_anchors_by(&mut p, &idxs, 1.0, 0.0);
                Some(p)
            }));
        }
        assert_eq!(
            path_of(&e, "v")[0],
            PathCmd::MoveTo(20.0, 0.0),
            "the tree follows the pointer while the drag is live"
        );
        assert_eq!(e.undo_depth(), 0, "twenty live moves pushed nothing");
        assert!(e.end_path_gesture(), "the gesture commits");
        assert_eq!(e.undo_depth(), 1, "one drag, one undo entry");
        assert!(!e.path_gesture_active());
        assert!(e.undo());
        assert_eq!(
            path_of(&e, "v")[0],
            PathCmd::MoveTo(0.0, 0.0),
            "undo restores where the drag STARTED, not one pixel of it"
        );
    }

    #[test]
    fn a_gesture_that_never_moved_pushes_nothing() {
        let mut e = three_anchors();
        assert!(e.begin_path_gesture("v"));
        assert!(
            !e.end_path_gesture(),
            "a press that never moved is not an edit"
        );
        assert_eq!(e.undo_depth(), 0);
        assert!(
            !e.end_path_gesture(),
            "and the gesture is closed either way"
        );
        assert!(!e.path_gesture_active());
        // a live rewrite outside a gesture still lands in the tree (the canvas
        // paints the tree) but is never logged
        assert!(e.live_rewrite_path("v", |p| Some(p.to_vec())));
        assert_eq!(e.undo_depth(), 0, "a live rewrite never logs");
        assert!(
            !e.live_rewrite_path("v", |_| None),
            "declining changes nothing"
        );
        assert!(
            !e.live_rewrite_path("v", |_| Some(vec![])),
            "an empty path is refused"
        );
        assert!(!e.live_rewrite_path("nope", |p| Some(p.to_vec())));
    }

    #[test]
    fn cancelling_a_gesture_puts_the_path_back() {
        let mut e = three_anchors();
        let before = path_of(&e, "v");
        assert!(e.begin_path_gesture("v"));
        assert!(e.live_rewrite_path("v", |p| {
            let mut p = p.to_vec();
            move_anchors_by(&mut p, &[1], 50.0, 50.0);
            Some(p)
        }));
        assert_ne!(path_of(&e, "v"), before, "the live move did land");
        e.cancel_path_gesture();
        assert_eq!(path_of(&e, "v"), before, "cancel leaves no trace");
        assert_eq!(e.undo_depth(), 0, "and nothing to undo");
        assert!(!e.path_gesture_active());
    }

    #[test]
    fn a_gesture_only_opens_on_a_vector_node() {
        let mut e = three_anchors();
        assert!(
            !e.begin_path_gesture("page"),
            "a frame has no anchors to drag"
        );
        assert!(!e.begin_path_gesture("nope"));
        assert!(!e.path_gesture_active());
    }

    #[test]
    fn undo_abandons_an_open_gesture() {
        // committing a snapshot against a tree that undo just replaced would
        // resurrect the undone edit, so undo drops the gesture
        let mut e = three_anchors();
        e.enter_vector_edit_mode("v");
        e.select_vector_point(1, false);
        assert!(e.move_vector_points(0.0, 5.0));
        assert_eq!(e.undo_depth(), 1);
        assert!(e.begin_path_gesture("v"));
        assert!(e.undo());
        assert!(!e.path_gesture_active(), "the stale snapshot is gone");
        assert!(!e.end_path_gesture());
    }

    #[test]
    fn move_handle_in_moves_one_handle_and_mirrors_its_partner() {
        let p = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::CurveTo(10.0, 0.0, 40.0, 0.0, 50.0, 0.0),
            PathCmd::CurveTo(60.0, 0.0, 90.0, 0.0, 100.0, 0.0),
        ];
        // anchor 1 sits at (50,0) with c2 = (40,0) incoming and c1 = (60,0) out
        let m = move_handle_in(&p, 1, true, 60.0, -30.0, true).expect("the handle exists");
        assert_eq!(
            m[2],
            PathCmd::CurveTo(60.0, -30.0, 90.0, 0.0, 100.0, 0.0),
            "the dragged handle went where the pointer is"
        );
        assert_eq!(
            m[1],
            PathCmd::CurveTo(10.0, 0.0, 40.0, 30.0, 50.0, 0.0),
            "its partner mirrored through the anchor, so the point stays smooth"
        );
        // Alt (mirror = false) breaks the tangent: only the dragged handle moves
        let b = move_handle_in(&p, 1, true, 60.0, -30.0, false).expect("exists");
        assert_eq!(b[1], p[1], "the incoming handle is untouched");
        assert_eq!(b[2], PathCmd::CurveTo(60.0, -30.0, 90.0, 0.0, 100.0, 0.0));
        // the same anchor from its incoming side mirrors the other way
        let i = move_handle_in(&p, 1, false, 40.0, 25.0, true).expect("exists");
        assert_eq!(i[1], PathCmd::CurveTo(10.0, 0.0, 40.0, 25.0, 50.0, 0.0));
        assert_eq!(
            i[2],
            PathCmd::CurveTo(60.0, -25.0, 90.0, 0.0, 100.0, 0.0),
            "mirrored onto the outgoing side"
        );
        // refusals: a handle that is not there is never invented
        let open = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::CurveTo(10.0, 0.0, 40.0, 0.0, 50.0, 0.0),
        ];
        assert!(
            move_handle_in(&open, 0, false, 1.0, 1.0, false).is_none(),
            "anchor 0 of an open path has no incoming segment"
        );
        assert!(
            move_handle_in(&open, 0, true, 1.0, 1.0, true).is_some(),
            "but it does have an outgoing one"
        );
        assert!(
            move_handle_in(&p, 9, true, 1.0, 1.0, false).is_none(),
            "no such anchor"
        );
    }

    #[test]
    fn a_handle_drag_lives_inside_a_gesture_too() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::CurveTo(10.0, 0.0, 40.0, 0.0, 50.0, 0.0),
                PathCmd::CurveTo(60.0, 0.0, 90.0, 0.0, 100.0, 0.0),
            ],
        )));
        assert!(e.begin_path_gesture("v"));
        // three pointer moves, one commit
        for dy in [10.0, 20.0, 30.0] {
            assert!(e.live_rewrite_path("v", |p| move_handle_in(p, 1, true, 60.0, -dy, true)));
        }
        assert_eq!(e.undo_depth(), 0);
        assert!(e.end_path_gesture());
        assert_eq!(e.undo_depth(), 1);
        let p = path_of(&e, "v");
        assert_eq!(p[2], PathCmd::CurveTo(60.0, -30.0, 90.0, 0.0, 100.0, 0.0));
        assert!(e.undo());
        assert_eq!(
            path_of(&e, "v")[2],
            PathCmd::CurveTo(60.0, 0.0, 90.0, 0.0, 100.0, 0.0)
        );
    }
}
