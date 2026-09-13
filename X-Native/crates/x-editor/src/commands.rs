#[allow(unused_imports)]
use crate::*;
use x_core::*;

// ----------------------------------------------------------------- commands

/// Phase 2.4: every mutation is a Command; undo/redo replays inverses.
/// Command-log architecture (not snapshots) — the roadmap's decision point,
/// resolved: logs stay cheap at 100K-node documents.
#[derive(Debug, Clone)]
pub enum Command {
    Move {
        id: String,
        dx: f64,
        dy: f64,
    },
    Resize {
        id: String,
        from: (f64, f64),
        to: (f64, f64),
    },
    /// Rotation-aware corner resize: `((w, h), (x, y))` before and after.
    /// Unlike `Resize` this also repositions the node, because a rotated box
    /// that grows along its local axes has to move to keep the corner the
    /// user is NOT dragging pinned in world space. See `transformed_resize`.
    ResizeTransformed {
        id: String,
        from: ((f64, f64), (f64, f64)),
        to: ((f64, f64), (f64, f64)),
    },
    Rotate {
        id: String,
        from: f64,
        to: f64,
    },
    Skew {
        id: String,
        from: (f64, f64),
        to: (f64, f64),
    },
    SetOrigin {
        id: String,
        from: (f64, f64),
        to: (f64, f64),
    },
    /// Corner radius: (uniform radius, per-corner overrides). `None` corners
    /// = uniform mode.
    SetCorners {
        id: String,
        from: (f64, Option<[f64; 4]>),
        to: (f64, Option<[f64; 4]>),
    },
    SetFill {
        id: String,
        from: Paint,
        to: Paint,
    },
    SetText {
        id: String,
        from: String,
        to: String,
    },
    /// Rich-text style overrides (whole-vec swap; undoable).
    SetTextRuns {
        id: String,
        from: Vec<TextRun>,
        to: Vec<TextRun>,
    },
    SetOpacity {
        id: String,
        from: f32,
        to: f32,
    },
    /// Generic whole-node swap: used where a mutation has wide side effects
    /// (e.g. auto-layout repositioning every child). Clean inverse by swap.
    ReplaceNode {
        id: String,
        before: Box<Node>,
        after: Box<Node>,
    },
    SetPrototype {
        id: String,
        from: Option<x_core::PrototypeAction>,
        to: Option<x_core::PrototypeAction>,
    },
    Reorder {
        id: String,
        from: usize,
        to: usize,
    },
    Delete {
        parent_id: String,
        index: usize,
        node: Node,
    },
    Insert {
        parent_id: String,
        index: usize,
        node: Node,
    },
    Group {
        parent_id: String,
        indices: Vec<usize>,
        group_id: String,
    },
    /// Figma "Frame selection" (⌥⌘G / ⌘⇧A): wrap the selection (1+ nodes) in
    /// a Frame sized to the members' collective AABB, white-filled.
    FrameSelection {
        parent_id: String,
        indices: Vec<usize>,
        frame_id: String,
    },
    /// Wrap the selection in a labelled Section container (Object menu).
    SectionSelection {
        parent_id: String,
        indices: Vec<usize>,
        section_id: String,
    },
}

pub(crate) fn apply(root: &mut Node, cmd: &Command) -> bool {
    match cmd {
        Command::Move { id, dx, dy } => {
            if let Some(n) = find_mut(root, id) {
                n.transform.x += dx;
                n.transform.y += dy;
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::Resize { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.w = to.0.max(1.0);
                n.h = to.1.max(1.0);
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::ResizeTransformed { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.w = to.0 .0.max(1.0);
                n.h = to.0 .1.max(1.0);
                n.transform.x = to.1 .0;
                n.transform.y = to.1 .1;
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::Rotate { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.transform.rotation = *to;
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::Skew { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.transform.skew_x = to.0;
                n.transform.skew_y = to.1;
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::SetOrigin { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.transform.origin_x = to.0.clamp(0.0, 1.0);
                n.transform.origin_y = to.1.clamp(0.0, 1.0);
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::SetCorners { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                if let NodeKind::Rect { radius } = &mut n.kind {
                    *radius = to.0.max(0.0);
                    n.corner_radii = to.1.map(|c| c.map(|v| v.max(0.0)));
                    n.dirty = true;
                    return true;
                }
            }
            false
        }
        Command::SetFill { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.fill = to.clone();
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::SetText { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                if let NodeKind::Text { text } = &mut n.kind {
                    *text = to.clone();
                    // clamp rich-text runs to the new length (CHAR indices),
                    // dropping any that shrink to empty / fall out of range.
                    let len = text.chars().count();
                    n.text_runs.retain_mut(|r| {
                        r.start = r.start.min(len);
                        r.len = r.len.min(len.saturating_sub(r.start));
                        r.len > 0
                    });
                    n.dirty = true;
                    return true;
                }
            }
            false
        }
        Command::SetTextRuns { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.text_runs = to.clone();
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::SetOpacity { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.opacity = to.clamp(0.0, 1.0);
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::ReplaceNode { id, after, .. } => {
            if let Some(n) = find_mut(root, id) {
                *n = (**after).clone();
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::SetPrototype { id, to, .. } => {
            if let Some(n) = find_mut(root, id) {
                n.prototype = to.clone();
                n.dirty = true;
                true
            } else {
                false
            }
        }
        Command::Reorder { id, to, .. } => {
            if let Some(p) = find_parent_mut(root, id) {
                if let Some(from) = p.children.iter().position(|c| &c.id == id) {
                    let to = (*to).min(p.children.len() - 1);
                    let n = p.children.remove(from);
                    p.children.insert(to, n);
                    return true;
                }
            }
            false
        }
        Command::Delete {
            parent_id, index, ..
        } => {
            if let Some(p) = find_mut(root, parent_id) {
                if *index < p.children.len() {
                    p.children.remove(*index);
                    return true;
                }
            }
            false
        }
        Command::Insert {
            parent_id,
            index,
            node,
        } => {
            if let Some(p) = find_mut(root, parent_id) {
                p.children
                    .insert((*index).min(p.children.len()), node.clone());
                return true;
            }
            false
        }
        Command::Group {
            parent_id,
            indices,
            group_id,
        } => wrap_selection(root, parent_id, indices, group_id, WrapKind::Group),
        Command::FrameSelection {
            parent_id,
            indices,
            frame_id,
        } => wrap_selection(root, parent_id, indices, frame_id, WrapKind::Frame),
        Command::SectionSelection {
            parent_id,
            indices,
            section_id,
        } => wrap_selection(root, parent_id, indices, section_id, WrapKind::Section),
    }
}

enum WrapKind {
    Group,
    Frame,
    Section,
}

/// Shared implementation for Group / FrameSelection: pull the members out of
/// `parent_id` at `indices`, wrap them in a new container (group or frame)
/// sized to their collective AABB, and re-insert at the first index. Members
/// are re-offset relative to the container. Returns false if nothing moved.
fn wrap_selection(
    root: &mut Node,
    parent_id: &str,
    indices: &[usize],
    container_id: &str,
    kind: WrapKind,
) -> bool {
    let Some(p) = find_mut(root, parent_id) else {
        return false;
    };
    let mut taken: Vec<Node> = vec![];
    let mut sorted = indices.to_vec();
    sorted.sort_unstable();
    for &i in sorted.iter().rev() {
        if i < p.children.len() {
            taken.insert(0, p.children.remove(i));
        }
    }
    if taken.is_empty() {
        return false;
    }
    // Container wraps the members' collective AABB.
    let x0 = taken
        .iter()
        .map(|n| n.transform.x)
        .fold(f64::INFINITY, f64::min);
    let y0 = taken
        .iter()
        .map(|n| n.transform.y)
        .fold(f64::INFINITY, f64::min);
    let x1 = taken
        .iter()
        .map(|n| n.transform.x + n.w)
        .fold(f64::NEG_INFINITY, f64::max);
    let y1 = taken
        .iter()
        .map(|n| n.transform.y + n.h)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut c = match kind {
        WrapKind::Frame => {
            // Figma frames default to a white fill.
            let mut f = Node::frame(container_id, x1 - x0, y1 - y0);
            f.fill = Paint::Solid(Color::WHITE);
            f
        }
        WrapKind::Group => Node::group(container_id, x1 - x0, y1 - y0),
        WrapKind::Section => Node::section(container_id, x1 - x0, y1 - y0),
    };
    c.transform.x = x0;
    c.transform.y = y0;
    for mut m in taken {
        m.transform.x -= x0;
        m.transform.y -= y0;
        c.children.push(m);
    }
    p.children.insert(sorted[0], c);
    true
}

pub(crate) fn invert(cmd: &Command) -> Command {
    match cmd {
        Command::Move { id, dx, dy } => Command::Move {
            id: id.clone(),
            dx: -dx,
            dy: -dy,
        },
        Command::Resize { id, from, to } => Command::Resize {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::ResizeTransformed { id, from, to } => Command::ResizeTransformed {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::Rotate { id, from, to } => Command::Rotate {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::Skew { id, from, to } => Command::Skew {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::SetOrigin { id, from, to } => Command::SetOrigin {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::SetCorners { id, from, to } => Command::SetCorners {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::SetFill { id, from, to } => Command::SetFill {
            id: id.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        Command::SetText { id, from, to } => Command::SetText {
            id: id.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        Command::SetTextRuns { id, from, to } => Command::SetTextRuns {
            id: id.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        Command::SetOpacity { id, from, to } => Command::SetOpacity {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::ReplaceNode { id, before, after } => {
            if before.id == after.id {
                Command::ReplaceNode {
                    id: id.clone(),
                    before: after.clone(),
                    after: before.clone(),
                }
            } else {
                // id-changing replacement (e.g. detach: instance -> group):
                // the tree now holds the AFTER id, so undo must find it
                // by that, not by the original id
                Command::ReplaceNode {
                    id: after.id.clone(),
                    before: after.clone(),
                    after: before.clone(),
                }
            }
        }
        Command::SetPrototype { id, from, to } => Command::SetPrototype {
            id: id.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        Command::Reorder { id, from, to } => Command::Reorder {
            id: id.clone(),
            from: *to,
            to: *from,
        },
        Command::Delete {
            parent_id,
            index,
            node,
        } => Command::Insert {
            parent_id: parent_id.clone(),
            index: *index,
            node: node.clone(),
        },
        Command::Insert {
            parent_id,
            index,
            node,
        } => Command::Delete {
            parent_id: parent_id.clone(),
            index: *index,
            node: node.clone(),
        },
        // Group / FrameSelection inversion = restore snapshot via history
        // (handled by Editor's snapshot stash); simplest correct inverse:
        Command::Group { .. } => unreachable!("Group is inverted via snapshot in Editor"),
        Command::FrameSelection { .. } | Command::SectionSelection { .. } => {
            unreachable!("FrameSelection is inverted via snapshot in Editor")
        }
    }
}
