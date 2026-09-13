//! Parametric resize: sizes driven by variables, and the dependents that have
//! to move with them.
//!
//! `Node::bind("w", "card-width")` has existed since the variables work, and
//! the binding round-trips through the file format — but nothing ever READ it
//! back. A node bound to a number variable behaved exactly like an unbound
//! one: resize it and the variable stayed stale; change the variable and the
//! node stayed put. That is the gap this module closes.
//!
//! Two directions, one step:
//!
//! * **write-back** — a manual resize of a bound axis updates the variable,
//!   so every OTHER node bound to it follows. This is the "synchronization":
//!   one drag moves the whole family, and the token panel shows the truth.
//! * **resolve** — the variable table is then applied back over the document,
//!   which is also how a variable edited in the panel reaches the canvas.
//!
//! On top of the variable sync, the resize itself drags its dependents along:
//! pinned children (`apply_constraints`) and the corner radii that would
//! otherwise exceed the new, smaller box.
//!
//! The whole thing lands as ONE undoable step (`ReplaceNode` on the root), so
//! ⌘Z restores the size, the position of every pinned child, the radii and
//! the tree — not just `w`/`h`.
//!
//! Not bound here, deliberately: `fontsize`. Font size lives on the per-run
//! rich-text style (`text_runs[].size`), not on a node field, so binding it
//! needs the run-level patch path instead of a plain assignment.

#[allow(unused_imports)]
use crate::*;
use crate::{apply_constraints, find_mut, Editor};
use x_core::{apply_auto_layout, Node, NodeKind, Sizing, Value, Variables};

/// The size axes a node can bind to a number variable.
pub const SIZE_BINDINGS: [&str; 2] = ["w", "h"];

/// Every numeric property a binding can drive. (`Node::bind` also documents
/// `"fontsize"`; see the module note for why it is not resolved here.)
pub const NUMERIC_BINDINGS: [&str; 4] = ["w", "h", "radius", "opacity"];

/// What a parametric resize did, so the UI can report it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParametricReport {
    /// Variables rewritten from the node's new size: (name, value).
    pub vars_updated: Vec<(String, f64)>,
    /// Nodes whose bound properties were re-applied (the synchronized family).
    pub nodes_synced: Vec<String>,
    /// The size the target node ended up at.
    pub size: Option<(f64, f64)>,
}

/// The variable name bound to `prop` on this node, if any.
pub fn bound_var<'a>(n: &'a Node, prop: &str) -> Option<&'a str> {
    n.bindings.get(prop).map(String::as_str).filter(|s| !s.is_empty())
}

/// Clamp corner radii to what the box can actually show. A 40px radius on a
/// 30px-tall rectangle is nonsense geometry; Figma clamps, so we clamp.
pub fn clamp_radii(n: &mut Node) {
    let limit = (n.w.min(n.h) / 2.0).max(0.0);
    if let NodeKind::Rect { radius } = &mut n.kind {
        *radius = radius.min(limit).max(0.0);
    }
    if let Some(radii) = &mut n.corner_radii {
        for r in radii.iter_mut() {
            *r = r.min(limit).max(0.0);
        }
    }
}

/// Apply one node's numeric bindings from the variable table (variable ->
/// node). Returns true when anything changed.
pub fn apply_numeric_bindings(n: &mut Node, vars: &Variables) -> bool {
    let mut changed = false;
    for prop in NUMERIC_BINDINGS {
        let Some(name) = bound_var(n, prop) else {
            continue;
        };
        match prop {
            "w" => {
                let v = vars.number(name, n.w).max(1.0);
                if (v - n.w).abs() > f64::EPSILON {
                    n.w = v;
                    changed = true;
                }
            }
            "h" => {
                let v = vars.number(name, n.h).max(1.0);
                if (v - n.h).abs() > f64::EPSILON {
                    n.h = v;
                    changed = true;
                }
            }
            "radius" => {
                let v = vars.number(name, 0.0).max(0.0);
                if let NodeKind::Rect { radius } = &mut n.kind {
                    if (*radius - v).abs() > f64::EPSILON {
                        *radius = v;
                        changed = true;
                    }
                }
            }
            "opacity" => {
                let v = (vars.number(name, n.opacity as f64).clamp(0.0, 1.0)) as f32;
                if (v - n.opacity).abs() > f32::EPSILON {
                    n.opacity = v;
                    changed = true;
                }
            }
            _ => {}
        }
    }
    if changed {
        clamp_radii(n);
        n.dirty = true;
    }
    changed
}

/// Walk the tree applying every numeric binding. Returns the ids of the nodes
/// that changed — the family a variable edit just synchronized.
pub fn resolve_parametric(root: &mut Node, vars: &Variables) -> Vec<String> {
    let mut out = vec![];
    fn walk(n: &mut Node, vars: &Variables, out: &mut Vec<String>) {
        if apply_numeric_bindings(n, vars) {
            out.push(n.id.clone());
        }
        for c in &mut n.children {
            walk(c, vars, out);
        }
    }
    walk(root, vars, &mut out);
    out
}

/// Push a node's bound size axes back into the variable table (node ->
/// variable). Returns the variables that were rewritten.
pub fn write_back_size(vars: &mut Variables, n: &Node) -> Vec<(String, f64)> {
    let mut out = vec![];
    for (prop, value) in [("w", n.w), ("h", n.h)] {
        let Some(name) = bound_var(n, prop) else {
            continue;
        };
        // a variable that does not exist yet reads back as NaN, which never
        // compares unequal — so "missing" has to be tested separately or the
        // first resize of a freshly bound node would silently not stick
        let current = vars.number(name, f64::NAN);
        if current.is_nan() || (current - value).abs() > f64::EPSILON {
            vars.set(name, Value::Num(value));
            out.push((name.to_string(), value));
        }
    }
    out
}

impl Editor {
    /// Resize a node AND keep its parametric world in sync, as one undo step.
    ///
    /// Order matters: the node takes the new size first, its bound axes are
    /// written back into `vars`, then the whole document is re-resolved from
    /// the table — so the resized node stays where the user put it and every
    /// sibling bound to the same variable follows.
    ///
    /// Returns `None` if the node does not exist.
    pub fn resize_parametric(
        &mut self,
        id: &str,
        w: f64,
        h: f64,
        vars: &mut Variables,
    ) -> Option<ParametricReport> {
        let root_id = self.root.id.clone();
        if find_mut(&mut self.root, id).is_none() {
            return None;
        }
        let before = Box::new(self.root.clone());
        let mut after = self.root.clone();

        let mut report = ParametricReport::default();
        {
            let n = find_mut(&mut after, id)?;
            let (old_w, old_h) = (n.w, n.h);
            let (nw, nh) = (w.max(1.0), h.max(1.0));
            // bound axes are driven BY the variable, so the manual size is
            // what the variable now means
            n.w = nw;
            n.h = nh;
            n.dirty = true;
            clamp_radii(n);
            report.vars_updated = write_back_size(vars, n);
            // dependents inside this node: pinned children follow the new box
            if !n.children.is_empty() {
                apply_constraints(n, old_w, old_h);
            }
            // A Fixed auto-layout frame distributes its children within the
            // size the user just authored. A Hug frame OWNS its size (it is
            // derived from content), so re-flowing it here would silently
            // revert the resize — leave those to the layout pass.
            let reflow = matches!(
                &n.kind,
                NodeKind::Frame {
                    layout: Some(l)
                } if l.sizing == Sizing::Fixed
            );
            if reflow {
                apply_auto_layout(n, vars);
            }
            report.size = Some((n.w, n.h));
        }
        report.nodes_synced = resolve_parametric(&mut after, vars);

        self.push_replace(&root_id, before, after);
        Some(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::find;
    use x_core::{Color, HPin, Node, Variables};

    fn vars_with(pairs: &[(&str, f64)]) -> Variables {
        let mut v = Variables::default();
        for (name, n) in pairs {
            v.set(name, Value::Num(*n));
        }
        v
    }

    #[test]
    fn resizing_a_bound_node_rewrites_the_variable() {
        let card = Node::rect("card", 0.0, 0.0, 100.0, 50.0, Color::BLACK).bind("w", "card-w");
        let mut ed = Editor::new(Node::frame("page", 800.0, 600.0).child(card));
        let mut vars = vars_with(&[("card-w", 100.0)]);

        let report = ed.resize_parametric("card", 240.0, 50.0, &mut vars).unwrap();
        assert_eq!(report.vars_updated, vec![("card-w".to_string(), 240.0)]);
        assert_eq!(vars.number("card-w", -1.0), 240.0);
        assert_eq!(report.size, Some((240.0, 50.0)));
        // unbound axis is untouched by the variable system
        assert_eq!(report.nodes_synced.len(), 0, "{:?}", report.nodes_synced);
    }

    #[test]
    fn every_other_node_bound_to_the_same_variable_follows() {
        let a = Node::rect("a", 0.0, 0.0, 100.0, 50.0, Color::BLACK).bind("w", "card-w");
        let b = Node::rect("b", 0.0, 100.0, 100.0, 50.0, Color::BLACK).bind("w", "card-w");
        let c = Node::rect("c", 0.0, 200.0, 100.0, 50.0, Color::BLACK); // not bound
        let mut page = Node::frame("page", 800.0, 600.0);
        page.children = vec![a, b, c];
        let mut ed = Editor::new(page);
        let mut vars = vars_with(&[("card-w", 100.0)]);

        ed.resize_parametric("a", 300.0, 50.0, &mut vars).unwrap();
        assert_eq!(find(&ed.root, "b").unwrap().w, 300.0);
        assert_eq!(find(&ed.root, "c").unwrap().w, 100.0, "unbound stays put");
    }

    #[test]
    fn a_variable_edit_reaches_the_canvas_through_resolve() {
        let a = Node::rect("a", 0.0, 0.0, 100.0, 50.0, Color::BLACK)
            .bind("w", "card-w")
            .bind("radius", "r-lg")
            .bind("opacity", "dim");
        let mut ed = Editor::new(Node::frame("page", 800.0, 600.0).child(a));
        let mut vars = vars_with(&[("card-w", 100.0), ("r-lg", 8.0), ("dim", 1.0)]);

        // the panel edits the token, not the node
        vars.set("card-w", Value::Num(180.0));
        vars.set("r-lg", Value::Num(24.0));
        vars.set("dim", Value::Num(0.4));
        let synced = resolve_parametric(&mut ed.root, &vars);
        assert_eq!(synced, vec!["a".to_string()]);

        let n = find(&ed.root, "a").unwrap();
        assert_eq!(n.w, 180.0);
        assert!((n.opacity - 0.4).abs() < 1e-6, "opacity {}", n.opacity);
        match &n.kind {
            NodeKind::Rect { radius } => assert_eq!(*radius, 24.0),
            other => panic!("expected a rect, got {other:?}"),
        }
    }

    #[test]
    fn pinned_children_move_with_their_frame() {
        let mut page = Node::frame("page", 800.0, 600.0);
        let mut frame = Node::frame("frame", 200.0, 100.0);
        let mut right = Node::rect("right", 150.0, 0.0, 40.0, 40.0, Color::BLACK);
        right.pin = (HPin::Right, x_core::VPin::Top);
        let mut stretch = Node::rect("stretch", 0.0, 60.0, 200.0, 20.0, Color::BLACK);
        stretch.pin = (HPin::StretchH, x_core::VPin::Top);
        frame.children = vec![right, stretch];
        page.children = vec![frame];

        let mut ed = Editor::new(page);
        let mut vars = Variables::default();
        ed.resize_parametric("frame", 300.0, 100.0, &mut vars).unwrap();

        let r = find(&ed.root, "right").unwrap();
        assert_eq!(r.transform.x, 250.0, "right-pinned child follows +100");
        let s = find(&ed.root, "stretch").unwrap();
        assert_eq!(s.w, 300.0, "stretch-h child absorbs the width delta");
    }

    #[test]
    fn radii_are_clamped_when_the_box_shrinks() {
        let mut r = Node::rect("r", 0.0, 0.0, 100.0, 100.0, Color::BLACK);
        if let NodeKind::Rect { radius } = &mut r.kind {
            *radius = 40.0;
        }
        let mut ed = Editor::new(Node::frame("page", 800.0, 600.0).child(r));
        let mut vars = Variables::default();
        ed.resize_parametric("r", 40.0, 20.0, &mut vars).unwrap();
        let n = find(&ed.root, "r").unwrap();
        match &n.kind {
            NodeKind::Rect { radius } => assert_eq!(*radius, 10.0, "clamped to min(w,h)/2"),
            other => panic!("expected a rect, got {other:?}"),
        }
    }

    #[test]
    fn the_whole_sync_is_one_undo_step() {
        let a = Node::rect("a", 0.0, 0.0, 100.0, 50.0, Color::BLACK).bind("w", "card-w");
        let b = Node::rect("b", 0.0, 100.0, 100.0, 50.0, Color::BLACK).bind("w", "card-w");
        let mut page = Node::frame("page", 800.0, 600.0);
        page.children = vec![a, b];
        let mut ed = Editor::new(page);
        let mut vars = vars_with(&[("card-w", 100.0)]);
        let depth = ed.undo_depth();

        ed.resize_parametric("a", 260.0, 50.0, &mut vars).unwrap();
        assert_eq!(ed.undo_depth(), depth + 1, "one resize = one undo step");
        assert_eq!(find(&ed.root, "b").unwrap().w, 260.0);

        ed.undo();
        assert_eq!(find(&ed.root, "a").unwrap().w, 100.0);
        assert_eq!(find(&ed.root, "b").unwrap().w, 100.0, "the family rolls back too");
        // the variable table is not part of the document undo — say so loudly
        assert_eq!(vars.number("card-w", -1.0), 260.0);
    }

    #[test]
    fn hug_frames_are_not_reflowed_over_the_users_resize() {
        let mut page = Node::frame("page", 800.0, 600.0);
        let mut hug = Node::frame("hug", 200.0, 100.0);
        if let NodeKind::Frame { layout } = &mut hug.kind {
            let mut l = x_core::AutoLayout::default();
            l.sizing = Sizing::Hug;
            *layout = Some(l);
        }
        hug.children = vec![Node::rect("kid", 0.0, 0.0, 40.0, 40.0, Color::BLACK)];
        page.children = vec![hug];

        let mut ed = Editor::new(page);
        let mut vars = Variables::default();
        let report = ed.resize_parametric("hug", 320.0, 180.0, &mut vars).unwrap();
        assert_eq!(report.size, Some((320.0, 180.0)));
        let n = find(&ed.root, "hug").unwrap();
        assert_eq!((n.w, n.h), (320.0, 180.0), "a Hug frame keeps the authored size");
    }

    #[test]
    fn unknown_ids_and_tiny_sizes_are_handled() {
        let mut ed = Editor::new(
            Node::frame("page", 800.0, 600.0).child(Node::rect("r", 0.0, 0.0, 50.0, 50.0, Color::BLACK)),
        );
        let mut vars = Variables::default();
        assert!(ed.resize_parametric("nope", 10.0, 10.0, &mut vars).is_none());
        let report = ed.resize_parametric("r", 0.0, -5.0, &mut vars).unwrap();
        assert_eq!(report.size, Some((1.0, 1.0)), "clamped to the 1px floor");
    }
}
