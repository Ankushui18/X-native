use x_core::kurbo::Rect;

#[allow(unused_imports)]
use crate::*;
use x_core::*;

// ----------------------------------------------------------------- snapping

/// Phase 2.10: snap a proposed position to the pixel grid and to other
/// nodes' edges/centers within `threshold`. Returns the snapped value and
/// (for smart guides) which other node id it snapped to, if any.
pub struct Snapper {
    pub grid: f64,
    pub threshold: f64,
}
impl Default for Snapper {
    fn default() -> Self {
        Self {
            grid: 1.0,
            threshold: 6.0,
        }
    }
}
impl Snapper {
    pub fn snap_x(
        &self,
        proposed: f64,
        moving_w: f64,
        others: &[(String, Rect)],
    ) -> (f64, Option<String>) {
        // The moving object's left edge, center, and right edge can each
        // snap to any other object's left edge, center, or right edge.
        let candidates = [proposed, proposed + moving_w / 2.0, proposed + moving_w];
        let mut best: Option<(f64, f64, String)> = None; // (|delta|, corrected_x, id)
        for (id, r) in others {
            for edge in [r.x0, (r.x0 + r.x1) / 2.0, r.x1] {
                for (ci, c) in candidates.iter().enumerate() {
                    let d = edge - c;
                    if d.abs() <= self.threshold {
                        let corrected_x = match ci {
                            0 => edge,
                            1 => edge - moving_w / 2.0,
                            _ => edge - moving_w,
                        };
                        if best.as_ref().is_none_or(|(bd, _, _)| d.abs() < *bd) {
                            best = Some((d.abs(), corrected_x, id.clone()));
                        }
                    }
                }
            }
        }
        match best {
            Some((_, x, id)) => (x, Some(id)),
            None => ((proposed / self.grid).round() * self.grid, None),
        }
    }
}

/// Phase 2.10: smart guides. Compare the moving node's world AABB against
/// every other visible node's; return guide lines (vertical?, coordinate)
/// wherever an edge or center matches within `tol`. The UI draws these as
/// the red alignment lines while dragging.
pub fn alignment_guides(root: &Node, moving_id: &str, tol: f64) -> Vec<(bool, f64)> {
    let Some((world, w, h)) = ({
        fn wt(node: &Node, parent: Affine, id: &str) -> Option<(Affine, f64, f64)> {
            let world = parent * node.transform.matrix(node.w, node.h);
            if node.id == id {
                return Some((world, node.w, node.h));
            }
            node.children.iter().find_map(|c| wt(c, world, id))
        }
        wt(root, Affine::IDENTITY, moving_id)
    }) else {
        return vec![];
    };
    let mb = bounds(world, w, h);
    let m_xs = [mb.x0, (mb.x0 + mb.x1) / 2.0, mb.x1];
    let m_ys = [mb.y0, (mb.y0 + mb.y1) / 2.0, mb.y1];

    let mut guides = vec![];
    fn walk(
        node: &Node,
        parent: Affine,
        skip: &str,
        m_xs: &[f64; 3],
        m_ys: &[f64; 3],
        tol: f64,
        out: &mut Vec<(bool, f64)>,
    ) {
        if !node.visible {
            return;
        }
        let world = parent * node.transform.matrix(node.w, node.h);
        if node.id != skip && !matches!(node.kind, NodeKind::Frame { .. } | NodeKind::Group) {
            let b = bounds(world, node.w, node.h);
            for edge in [b.x0, (b.x0 + b.x1) / 2.0, b.x1] {
                if m_xs.iter().any(|x| (x - edge).abs() <= tol) {
                    out.push((true, edge));
                }
            }
            for edge in [b.y0, (b.y0 + b.y1) / 2.0, b.y1] {
                if m_ys.iter().any(|y| (y - edge).abs() <= tol) {
                    out.push((false, edge));
                }
            }
        }
        for c in &node.children {
            walk(c, world, skip, m_xs, m_ys, tol, out);
        }
    }
    walk(
        root,
        Affine::IDENTITY,
        moving_id,
        &m_xs,
        &m_ys,
        tol,
        &mut guides,
    );
    // total_cmp: a NaN guide coordinate must not panic the smart-guide sort
    guides.sort_by(|a, b| a.total_cmp(b));
    guides.dedup_by(|a, b| a.0 == b.0 && (a.1 - b.1).abs() < 0.5);
    guides
}

/// Figma-style magnetic snap during move: given the moving node's would-be
/// AABB, returns (dx, dy) corrections that snap edges/centers to other
/// nodes' edges/centers within `tol`. Zero when nothing is close.
pub fn snap_delta(root: &Node, moving_id: &str, tol: f64) -> (f64, f64) {
    let Some((world, w, h)) = ({
        fn wt(node: &Node, parent: Affine, id: &str) -> Option<(Affine, f64, f64)> {
            let world = parent * node.transform.matrix(node.w, node.h);
            if node.id == id {
                return Some((world, node.w, node.h));
            }
            node.children.iter().find_map(|c| wt(c, world, id))
        }
        wt(root, Affine::IDENTITY, moving_id)
    }) else {
        return (0.0, 0.0);
    };
    let mb = bounds(world, w, h);
    let m_xs = [mb.x0, (mb.x0 + mb.x1) / 2.0, mb.x1];
    let m_ys = [mb.y0, (mb.y0 + mb.y1) / 2.0, mb.y1];
    let (mut best_dx, mut best_dy): (Option<f64>, Option<f64>) = (None, None);
    #[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
    fn walk(
        node: &Node,
        parent: Affine,
        skip: &str,
        m_xs: &[f64; 3],
        m_ys: &[f64; 3],
        tol: f64,
        bx: &mut Option<f64>,
        by: &mut Option<f64>,
    ) {
        if !node.visible {
            return;
        }
        let world = parent * node.transform.matrix(node.w, node.h);
        if node.id != skip && !matches!(node.kind, NodeKind::Frame { .. } | NodeKind::Group) {
            let b = bounds(world, node.w, node.h);
            for edge in [b.x0, (b.x0 + b.x1) / 2.0, b.x1] {
                for m in m_xs {
                    let d = edge - m;
                    if d.abs() <= tol && bx.is_none_or(|cur| d.abs() < cur.abs()) {
                        *bx = Some(d);
                    }
                }
            }
            for edge in [b.y0, (b.y0 + b.y1) / 2.0, b.y1] {
                for m in m_ys {
                    let d = edge - m;
                    if d.abs() <= tol && by.is_none_or(|cur| d.abs() < cur.abs()) {
                        *by = Some(d);
                    }
                }
            }
        }
        for c in &node.children {
            walk(c, world, skip, m_xs, m_ys, tol, bx, by);
        }
    }
    walk(
        root,
        Affine::IDENTITY,
        moving_id,
        &m_xs,
        &m_ys,
        tol,
        &mut best_dx,
        &mut best_dy,
    );
    (best_dx.unwrap_or(0.0), best_dy.unwrap_or(0.0))
}
