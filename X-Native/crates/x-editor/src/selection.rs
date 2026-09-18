use x_core::kurbo::{Affine, Point, Rect};

#[allow(unused_imports)]
use crate::*;
use x_core::*;

// -------------------------------------------------------------- hit testing

/// Topmost hittable node id at `point` (world coords). Children are on top
/// of parents; later siblings are on top of earlier ones (paint order).
/// Locked / hidden nodes (and their subtrees, if hidden) are skipped.
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
            let inside = match node.kind {
                NodeKind::Ellipse => {
                    let (rx, ry) = (node.w / 2.0, node.h / 2.0);
                    let (dx, dy) = ((local.x - rx) / rx, (local.y - ry) / ry);
                    dx * dx + dy * dy <= 1.0
                }
                // Arcs hit as a band around the swept part of the ellipse
                // ring (stroke-aware slop), not the full interior — clicks
                // in the empty bite pass through to whatever is beneath.
                NodeKind::Arc { start, end } => {
                    let (rx, ry) = (node.w / 2.0, node.h / 2.0);
                    if rx < 1e-6 || ry < 1e-6 {
                        false
                    } else {
                        let (dx, dy) = (local.x - rx, local.y - ry);
                        let (nx, ny) = (dx / rx, dy / ry);
                        let r = (nx * nx + ny * ny).sqrt();
                        let tol = ((node.stroke.width.max(4.0) / 2.0 + 4.0) / rx.min(ry))
                            .clamp(0.02, 0.5);
                        let on_ring = (r - 1.0).abs() <= tol;
                        let ang = dy.atan2(dx).to_degrees().rem_euclid(360.0);
                        let sweep = (end - start).rem_euclid(360.0);
                        let in_arc = if sweep == 0.0 {
                            true
                        } else {
                            (ang - start).rem_euclid(360.0) <= sweep
                        };
                        on_ring && in_arc
                    }
                }
                // Plain Groups have no paintable body (no fill/stroke of their
                // own in Figma's model), so clicks pass through empty group
                // area to whatever is beneath. Frames, master Components, and
                // Instances DO have a real fill/stroke — like Figma, clicking
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
        for child in &node.children {
            walk(child, world, point, out);
        }
    }
    let mut out = None;
    // The document root is the canvas, not a selectable object. Nested
    // frames/components remain hittable via `walk`.
    let world = Affine::IDENTITY * root.transform.matrix(root.w, root.h);
    for child in &root.children {
        walk(child, world, point, &mut out);
    }
    out
}

/// All node ids whose world AABB is selected by the marquee `rect`. The root
/// page/canvas is excluded (it can't be marquee-selected, like Figma).
/// `contained`: Figma's Alt-drag mode — only nodes FULLY inside the rect are
/// selected (default is overlap/intersection).
/// `deep`: Figma's ⌘/Ctrl-drag mode. Without it only the page's TOP-LEVEL
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
        if !node.locked && !matches!(node.kind, NodeKind::Group) {
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
