//! Vector editing (P0): the designer pen/node workflow on PathCmd data.
//!
//! Pen -> node selection -> bezier handles -> convert point -> join ->
//! split -> (boolean/flatten/outline-stroke are the remaining stages).
//! Everything operates on `NodeKind::Vector { path }` in local coords and
//! goes through the command log via ReplaceNode, so it is fully undoable.

use crate::{find, Command, Editor};
use x_core::{Node, NodeKind, PathCmd};

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

    /// Node tool: move a bezier CONTROL HANDLE independently.
    /// `outgoing`: false = incoming handle (c2 of the segment ending at
    /// the anchor), true = outgoing handle (c1 of the next segment).
    /// `mirror`: when true (the default drag, i.e. Alt is NOT held), the
    /// opposite handle is moved to match — same distance from the
    /// anchor, opposite angle — so the point stays smooth, same as every
    /// major vector tool. Pass false (Alt held) to break the tangent and
    /// move only this one handle, leaving the other untouched.
    pub fn move_handle(
        &mut self,
        id: &str,
        anchor_idx: usize,
        outgoing: bool,
        nx: f64,
        ny: f64,
        mirror: bool,
    ) -> bool {
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
        let before = Box::new(n.clone());
        let mut after = n.clone();
        let mut changed = false;
        if let NodeKind::Vector { path: p } = &mut after.kind {
            if outgoing {
                if a.cmd_index + 1 < p.len() {
                    if let PathCmd::CurveTo(x1, y1, _, _, _, _) = &mut p[a.cmd_index + 1] {
                        *x1 = nx;
                        *y1 = ny;
                        changed = true;
                    }
                }
            } else if let PathCmd::CurveTo(_, _, x2, y2, _, _) = &mut p[a.cmd_index] {
                *x2 = nx;
                *y2 = ny;
                changed = true;
            }
            if changed && mirror {
                // reflect through the anchor: same distance, opposite side
                let (mx, my) = (2.0 * a.x - nx, 2.0 * a.y - ny);
                if outgoing {
                    if let PathCmd::CurveTo(_, _, x2, y2, _, _) = &mut p[a.cmd_index] {
                        *x2 = mx;
                        *y2 = my;
                    }
                } else if a.cmd_index + 1 < p.len() {
                    if let PathCmd::CurveTo(x1, y1, _, _, _, _) = &mut p[a.cmd_index + 1] {
                        *x1 = mx;
                        *y1 = my;
                    }
                }
            }
        }
        if !changed {
            return false;
        }
        // A control handle pulled outside the box extends the shape's real
        // extent even though no ANCHOR moved — the same reason `move_anchor`
        // regrows. Without this the curve is clipped by the node's stale
        // w/h, and hit-testing / marquee miss the new bulge.
        grow_bounds(&mut after);
        self.push_replace(id, before, after);
        true
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
        let list = anchors(path);
        let Some(a) = list.get(anchor_idx).copied() else {
            return false;
        };
        if list.len() <= 2 {
            return false;
        } // keep at least a segment
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Vector { path: p } = &mut after.kind {
            let was_move = matches!(p[a.cmd_index], PathCmd::MoveTo(..));
            p.remove(a.cmd_index);
            if was_move {
                // next drawing command becomes the new MoveTo
                if let Some(next) = p.get_mut(a.cmd_index) {
                    let (nx, ny) = match *next {
                        PathCmd::LineTo(x, y) => (x, y),
                        PathCmd::CurveTo(_, _, _, _, x, y) => (x, y),
                        _ => (0.0, 0.0),
                    };
                    *next = PathCmd::MoveTo(nx, ny);
                }
            }
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
        if let NodeKind::Vector { path: p } = &mut after.kind {
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
                _ => return false,
            }
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
}
