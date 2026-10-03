use x_core::kurbo::{Affine, Point, Rect};

#[allow(unused_imports)]
use crate::*;
use x_core::*;

// -------------------------------------------------------------- hit testing

/// Topmost hittable node id at `point` (world coords). Children are on top
/// of parents; the last one PAINTED is the one you hit, so this walks
/// `paint_order` — document order normally, reversed in an auto-layout frame
/// whose canvas stacking is *First on top*. Locked / hidden nodes (and their
/// subtrees, if hidden) are skipped.
pub fn hit_test(root: &Node, point: Point) -> Option<String> {
    fn walk(node: &Node, parent: Affine, point: Point, out: &mut Option<String>) {
        if !node.visible {
            return;
        }
        let world = parent * node.transform.matrix(node.w, node.h);
        // children first? No — paint order is parent, then children in order,
        // so later hits simply overwrite `out`.
        if !node.locked {
            let local = world.inverse() * point;
            let inside = match &node.kind {
                NodeKind::Ellipse => {
                    let (rx, ry) = (node.w / 2.0, node.h / 2.0);
                    let (dx, dy) = ((local.x - rx) / rx, (local.y - ry) / ry);
                    dx * dx + dy * dy <= 1.0
                }
                // the arc is a FILLED region — the wedge through the
                // centre, or the ring its ratio leaves — so its own area
                // answers the click and both the gap and the ring's hole pass
                // through to whatever is underneath, like an ellipse with a
                // bite taken out. The stroke's slop rides on the boundary.
                NodeKind::Arc { start, end, ratio } => {
                    let (rx, ry) = (node.w / 2.0, node.h / 2.0);
                    if rx < 1e-6 || ry < 1e-6 {
                        false
                    } else {
                        let (dx, dy) = (local.x - rx, local.y - ry);
                        let (nx, ny) = (dx / rx, dy / ry);
                        let r = (nx * nx + ny * ny).sqrt();
                        let slop = ((node.stroke.width.max(4.0) / 2.0 + 4.0) / rx.min(ry))
                            .clamp(0.02, 0.5);
                        let sweep = x_core::booleans::arc_sweep(*start, *end);
                        let ang = dy.atan2(dx).to_degrees();
                        let along = if sweep >= 0.0 {
                            (ang - start).rem_euclid(360.0)
                        } else {
                            (start - ang).rem_euclid(360.0)
                        };
                        let in_arc = sweep.abs() >= 360.0 - 1e-9 || along <= sweep.abs();
                        in_arc && r <= 1.0 + slop && r >= ratio - slop
                    }
                }
                // the polygon and star are closed outlines: the shape's
                // own ink answers the click — a click in the corner of the
                // triangle's box is NOT on the triangle — and the stroke's
                // slop rides on the boundary.
                NodeKind::Poly { sides } => x_core::booleans::path_hit(
                    &x_core::booleans::poly_path_cmds(node.w, node.h, *sides),
                    local.x,
                    local.y,
                    node.stroke.width.max(4.0) / 2.0 + 4.0,
                ),
                NodeKind::Star { points, ratio } => x_core::booleans::path_hit(
                    &x_core::booleans::star_path_cmds(node.w, node.h, *points, *ratio),
                    local.x,
                    local.y,
                    node.stroke.width.max(4.0) / 2.0 + 4.0,
                ),
                // A vector's box is a wrapper, not its ink: a Line's box is 0
                // units high, so the box test would only ever answer on its
                // exact edge. A path with no fill count under it — a stroke
                // this thin is what the Line and Arrow tools land — is clicked
                // the way the arc is, with the stroke's own slop; a filled
                // path (the pencil's and brush's marks, a closed shape) keeps
                // the box test.
                NodeKind::Vector { path } => {
                    let ink = node
                        .active_strokes()
                        .iter()
                        .map(|l| l.stroke.width)
                        .fold(node.stroke.width, f64::max);
                    let filled = match &node.fill {
                        Paint::Solid(c) => c.components[3] > 0.0,
                        _ => true,
                    };
                    if !filled && ink <= 2.0 {
                        near_path(path, local) <= ink / 2.0 + 4.0
                    } else {
                        local.x >= 0.0 && local.y >= 0.0 && local.x <= node.w && local.y <= node.h
                    }
                }
                // Plain Groups have no paintable body (no fill/stroke of their
                // own in the model), so clicks pass through empty group
                // area to whatever is beneath. Frames, master Components, and
                // Instances DO have a real fill/stroke — like , clicking
                // their body OR their stroke/border must select and let the
                // user drag the container itself, not just its children.
                NodeKind::Group => false,
                NodeKind::Section
                | NodeKind::Frame { .. }
                | NodeKind::Component { .. }
                | NodeKind::Instance { .. } => {
                    local.x >= 0.0 && local.y >= 0.0 && local.x <= node.w && local.y <= node.h
                }
                _ => local.x >= 0.0 && local.y >= 0.0 && local.x <= node.w && local.y <= node.h,
            };
            if inside {
                *out = Some(node.id.clone());
            }
        }
        for i in paint_order(node) {
            walk(&node.children[i], world, point, out);
        }
    }
    let mut out = None;
    // The document root is the canvas, not a selectable object. Nested
    // frames/components remain hittable via `walk`.
    let world = Affine::IDENTITY * root.transform.matrix(root.w, root.h);
    for i in paint_order(root) {
        walk(&root.children[i], world, point, &mut out);
    }
    out
}

/// The distance from `p` to the segment `a`–`b`.
fn dist_to_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt();
    }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0);
    let cx = a.0 + dx * t;
    let cy = a.1 + dy * t;
    ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt()
}

/// How far `p` is from a path's ink. Each cubic is measured against its
/// control polygon, which contains the curve — so a click beside a curvy path
/// counts rather than being missed.
fn near_path(path: &[PathCmd], p: Point) -> f64 {
    let (mut cur, mut start) = ((0.0, 0.0), (0.0, 0.0));
    let mut best = f64::MAX;
    for c in path {
        match *c {
            PathCmd::MoveTo(x, y) => {
                cur = (x, y);
                start = (x, y);
            }
            PathCmd::LineTo(x, y) => {
                best = best.min(dist_to_segment((p.x, p.y), cur, (x, y)));
                cur = (x, y);
            }
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                best = best.min(dist_to_segment((p.x, p.y), cur, (x1, y1)));
                best = best.min(dist_to_segment((p.x, p.y), (x1, y1), (x2, y2)));
                best = best.min(dist_to_segment((p.x, p.y), (x2, y2), (x, y)));
                cur = (x, y);
            }
            PathCmd::Close => {
                best = best.min(dist_to_segment((p.x, p.y), cur, start));
                cur = start;
            }
        }
    }
    best
}

/// All node ids whose world AABB is selected by the marquee `rect`. The root
/// page/canvas is excluded (it can't be marquee-selected, like ), and a
/// locked node is skipped; a Group answers like any other layer.
/// `contained`: the Alt-drag mode — only nodes FULLY inside the rect are
/// selected (default is overlap/intersection).
/// `deep`: the ⌘/Ctrl-drag mode. Without it only the page's TOP-LEVEL
/// objects answer — a marquee over a frame picks the frame, never the layers
/// nested inside it — and with it the walk keeps descending, which is the one
/// thing the ⌘/Ctrl drag adds to a plain marquee.
pub fn hit_test_rect(root: &Node, rect: Rect, contained: bool, deep: bool) -> Vec<String> {
    fn walk(
        node: &Node,
        parent: Affine,
        rect: Rect,
        contained: bool,
        deep: bool,
        out: &mut Vec<String>,
    ) {
        if !node.visible {
            return;
        }
        let world = parent * node.transform.matrix(node.w, node.h);
        // A Group has bounds like any other layer, so it answers a marquee —
        //  selects a group that way. It is a *click* that falls through a
        // group's empty area (see `hit_test`, where a Group has no body).
        if !node.locked {
            let b = bounds(world, node.w, node.h);
            let hit = if contained {
                b.x0 >= rect.x0 && b.x1 <= rect.x1 && b.y0 >= rect.y0 && b.y1 <= rect.y1
            } else {
                b.x0 < rect.x1 && b.x1 > rect.x0 && b.y0 < rect.y1 && b.y1 > rect.y0
            };
            if hit {
                out.push(node.id.clone());
            }
        }
        if deep {
            for child in &node.children {
                walk(child, world, rect, contained, deep, out);
            }
        }
    }
    let mut out = vec![];
    let root_world = Affine::IDENTITY * root.transform.matrix(root.w, root.h);
    for child in &root.children {
        walk(child, root_world, rect, contained, deep, &mut out);
    }
    out
}

/// industry-standard selection model: a plain click selects the TOP-LEVEL object
/// (direct child of the page) that contains the hit; only deep-select
/// (Ctrl/Cmd+click) or double-click drills into nested children.
/// Maps a (deep) hit id to its top-level ancestor's id.
/// The nearest ancestor of `id` — or `id` itself — that is an instance. Used
/// by the *select inside* gesture:  lets a layer inside an instance be
/// selected and edited, so a hit has to be attributed to the instance it
/// belongs to.
pub fn instance_ancestor(root: &Node, id: &str) -> Option<String> {
    fn walk(node: &Node, id: &str, last: Option<String>) -> Option<String> {
        let here = match node.kind {
            NodeKind::Instance { .. } => Some(node.id.clone()),
            _ => last,
        };
        if node.id == id {
            return here;
        }
        for c in &node.children {
            if let Some(found) = walk(c, id, here.clone()) {
                return Some(found);
            }
        }
        None
    }
    walk(root, id, None)
}

/// Replace the node `id` with `after`; the replacement keeps `after`'s id.
/// Used to hit-test *through* an instance: the instance is swapped for its
/// resolved subtree, so the point can be answered with a master layer's id.
pub fn replace_in_tree(root: &mut Node, id: &str, after: Node) -> bool {
    fn walk(node: &mut Node, id: &str, after: &mut Option<Node>) -> bool {
        if let Some(pos) = node.children.iter().position(|c| c.id == id) {
            if let Some(a) = after.take() {
                node.children[pos] = a;
            }
            return true;
        }
        for c in &mut node.children {
            if walk(c, id, after) {
                return true;
            }
        }
        false
    }
    if root.id == id {
        return false;
    }
    let mut slot = Some(after);
    walk(root, id, &mut slot)
}

pub fn top_level_ancestor(root: &Node, id: &str) -> Option<String> {
    for child in &root.children {
        if child.id == id || find(child, id).is_some() {
            return Some(child.id.clone());
        }
    }
    None
}

// ------------------------------------------------------------ tree plumbing

pub fn find<'a>(node: &'a Node, id: &str) -> Option<&'a Node> {
    if node.id == id {
        return Some(node);
    }
    node.children.iter().find_map(|c| find(c, id))
}
pub fn find_mut<'a>(node: &'a mut Node, id: &str) -> Option<&'a mut Node> {
    if node.id == id {
        return Some(node);
    }
    node.children.iter_mut().find_map(|c| find_mut(c, id))
}
pub(crate) fn find_parent_mut<'a>(node: &'a mut Node, id: &str) -> Option<&'a mut Node> {
    if node.children.iter().any(|c| c.id == id) {
        return Some(node);
    }
    node.children
        .iter_mut()
        .find_map(|c| find_parent_mut(c, id))
}

/// The id of `id`'s direct parent within `root` (None for the root itself).
pub fn parent_id(root: &Node, id: &str) -> Option<String> {
    fn walk(n: &Node, id: &str, parent: Option<&str>, out: &mut Option<String>) {
        if out.is_some() {
            return;
        }
        if n.id == id {
            *out = parent.map(Into::into);
            return;
        }
        for c in &n.children {
            walk(c, id, Some(&n.id), out);
        }
    }
    let mut out = None;
    walk(root, id, None, &mut out);
    out
}

pub fn nearest_group_ancestor(root: &Node, id: &str) -> Option<String> {
    let mut path: Vec<String> = vec![];
    fn walk(node: &Node, id: &str, path: &mut Vec<String>) -> bool {
        path.push(node.id.clone());
        if node.id == id {
            return true;
        }
        for c in &node.children {
            if walk(c, id, path) {
                return true;
            }
        }
        path.pop();
        false
    }
    if !walk(root, id, &mut path) {
        return None;
    }
    // closest group to the leaf (skip the leaf itself — it's never a Group,
    // since groups pass through hit-testing)
    for pid in path.iter().rev().skip(1) {
        if let Some(n) = find(root, pid) {
            if matches!(n.kind, NodeKind::Group) {
                return Some(pid.clone());
            }
        }
    }
    None
}
