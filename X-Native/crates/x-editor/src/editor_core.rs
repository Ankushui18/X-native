#[allow(unused_imports)]
use crate::*;
use x_core::*;

/// Collect every id in a subtree (for copy-id allocation).
fn collect_ids(n: &Node, set: &mut std::collections::HashSet<String>) {
    set.insert(n.id.clone());
    for c in &n.children {
        collect_ids(c, set);
    }
}

/// Fresh, unique "<old>-copy" id for a pasted node.
fn next_copy_id(taken: &mut std::collections::HashSet<String>, old: &str) -> String {
    let mut candidate = format!("{old}-copy");
    let mut i = 1;
    while taken.contains(&candidate) {
        i += 1;
        candidate = format!("{old}-copy-{i}");
    }
    taken.insert(candidate.clone());
    candidate
}

/// Overlay a rich-text style onto CHAR range `[start, end)` within `runs`:
/// existing runs are clipped around the range and any part they cover is
/// dropped, then a fresh run for the range is appended (the renderer's
/// last-run-wins rule makes the overlay win inside the range).
fn overlay_run(runs: &mut Vec<TextRun>, start: usize, end: usize, patch: TextRun) {
    if start >= end {
        return;
    }
    let mut kept = vec![];
    for r in runs.drain(..) {
        let (rs, re) = (r.start, r.start.saturating_add(r.len));
        if re <= start || rs >= end {
            // no overlap
            kept.push(r);
        } else if rs >= start && re <= end {
            // fully covered — drop
        } else if rs < start && re > end {
            // contains the range — split into left + right
            kept.push(TextRun {
                start: rs,
                len: start - rs,
                ..r.clone()
            });
            kept.push(TextRun {
                start: end,
                len: re - end,
                ..r
            });
        } else if rs < start {
            // overlaps on the left — trim end
            kept.push(TextRun {
                start: rs,
                len: start - rs,
                ..r
            });
        } else {
            // overlaps on the right — trim start
            kept.push(TextRun {
                start: end,
                len: re - end,
                ..r
            });
        }
    }
    kept.push(TextRun {
        start,
        len: end - start,
        ..patch
    });
    kept.sort_by_key(|r| r.start);
    *runs = kept;
}

// ------------------------------------------------------------------- editor

/// Phase 2: selection + undoable document mutations + Phase 10 checkpoints.
#[derive(Clone)]
pub struct Editor {
    /// Monotonic command serial, independent of undo depth and history pruning.
    pub edit_serial: u64,
    pub root: Node,
    pub selection: Vec<String>,
    undo_stack: Vec<Vec<Command>>,
    redo_stack: Vec<Vec<Command>>,
    /// Group/Ungroup are structural; store whole-tree snapshots for them.
    snapshots: Vec<(usize, Node)>,
    /// Phase 10.2: named version checkpoints.
    pub checkpoints: Vec<(String, Node)>,
    /// Phase 2.7: internal clipboard (copied subtrees).
    clipboard: Vec<Node>,
    /// Phase P0: text editing mode
    text_edit_mode: Option<TextEditState>,
    /// Phase P0: corner drag state
    corner_drag_state: Option<CornerDragState>,
    /// Eraser tool state (Figma-like eraser + image support)
    pub erase_stroke: Option<EraserStroke>,
    /// Tool state flags
    pub tool_state: ToolState,
    /// Vector edit mode state (Figma parity)
    pub vector_edit_active: bool,
    pub vector_edit_node: Option<String>,
    pub vector_edit_selected_points: Vec<usize>,
    /// Snapshot taken when an interactive path drag starts, so the whole
    /// gesture commits as ONE undo entry: `(node id, node as it was)`. See
    /// [`Editor::begin_path_gesture`].
    pub path_gesture: Option<(String, Node)>,
}

/// Tool state flags for various tools
#[derive(Debug, Clone, Default)]
pub struct ToolState {
    pub eraser_active: bool,
    pub pen_active: bool,
    pub vector_edit_active: bool,
}

/// Phase P0: Text edit mode state
#[derive(Debug, Clone)]
pub struct TextEditState {
    pub node_id: String,
    pub selection_start: usize,
    pub selection_end: usize,
    pub cursor_visible: bool,
}

/// Phase P0: Corner drag state for radius adjustment
#[derive(Debug, Clone)]
pub struct CornerDragState {
    pub node_id: String,
    pub corner: Corner,
    pub initial_radius: f64,
    pub initial_mouse_pos: (f64, f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomRight,
    BottomLeft,
}

/// Give a subtree fresh ids via `rename`; only the subtree ROOT's new id is
/// recorded into `out` (that's what selection/paste callers care about).
fn remap_ids(node: &mut Node, rename: &mut impl FnMut(&str) -> String, out: &mut Vec<String>) {
    x_core::remap_node_ids(node, rename);
    out.push(node.id.clone());
}

impl Editor {
    /// Rename a layer's DISPLAY NAME (Figma parity). The node's `id` — the
    /// identity every reference points at (prototype destinations, instance
    /// overrides, render keys) — is left untouched, so renaming can never
    /// break a link. Names may duplicate (Figma allows duplicate layer
    /// names); only empty and no-op renames are refused.
    pub fn rename_node(&mut self, id: &str, new_name: &str) -> bool {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return false;
        }
        let Some(node) = find(&self.root, id) else {
            return false;
        };
        if node.name == new_name {
            return false;
        }
        let before = Box::new(self.root.clone());
        let mut after = self.root.clone();
        if let Some(node) = find_mut(&mut after, id) {
            node.name = new_name.to_string();
        }
        let root_id = self.root.id.clone();
        self.push_replace(&root_id, before, after);
        true
    }
    pub fn new(root: Node) -> Self {
        Self {
            root,
            edit_serial: 0,
            selection: vec![],
            undo_stack: vec![],
            redo_stack: vec![],
            snapshots: vec![],
            checkpoints: vec![],
            clipboard: vec![],
            text_edit_mode: None,
            corner_drag_state: None,
            erase_stroke: None,
            tool_state: ToolState::default(),
            vector_edit_active: false,
            vector_edit_node: None,
            vector_edit_selected_points: vec![],
            path_gesture: None,
        }
    }

    // -- selection ---------------------------------------------------------
    /// industry-standard click: plain click selects the top-level object under the
    /// cursor; `deep` (Ctrl+click) selects the exact nested node;
    /// `shift` toggles membership.
    pub fn click_select(&mut self, p: Point, shift: bool, deep: bool) {
        let hit = hit_test(&self.root, p);
        let target = match hit {
            Some(id) if !deep => top_level_ancestor(&self.root, &id).unwrap_or(id),
            Some(id) => id,
            None => {
                if !shift {
                    self.selection.clear();
                }
                return;
            }
        };
        // Page root is the canvas, not a layer — never select it
        if target == self.root.id {
            if !shift {
                self.selection.clear();
            }
            return;
        }
        if shift {
            if let Some(i) = self.selection.iter().position(|s| s == &target) {
                self.selection.remove(i);
            } else {
                self.selection.push(target);
            }
        } else {
            self.selection = vec![target];
        }
    }

    /// double-click to drill: drill one level deeper from the current
    /// selection toward the deep hit. Returns the newly selected id.
    pub fn drill_into(&mut self, p: Point) -> Option<String> {
        let deep = hit_test(&self.root, p)?;
        // path from root to deep node
        fn path_to(node: &Node, id: &str, path: &mut Vec<String>) -> bool {
            if node.id == id {
                return true;
            }
            for c in &node.children {
                path.push(c.id.clone());
                if path_to(c, id, path) {
                    return true;
                }
                path.pop();
            }
            false
        }
        let mut path = vec![];
        path_to(&self.root, &deep, &mut path);
        // current selection position along the path -> next one deeper
        let cur = self.selection.first();
        let idx = cur.and_then(|c| path.iter().position(|p| p == c));
        let next = match idx {
            Some(i) if i + 1 < path.len() => path[i + 1].clone(),
            Some(_) => deep,
            None => path.first().cloned().unwrap_or(deep),
        };
        self.selection = vec![next.clone()];
        Some(next)
    }

    pub fn click(&mut self, p: Point, shift: bool) {
        match hit_test(&self.root, p) {
            Some(id) => {
                if shift {
                    if let Some(i) = self.selection.iter().position(|s| s == &id) {
                        self.selection.remove(i);
                    } else {
                        self.selection.push(id);
                    }
                } else {
                    self.selection = vec![id];
                }
            }
            None => {
                if !shift {
                    self.selection.clear();
                }
            }
        }
    }
    /// Figma's plain marquee: the page's top-level objects only.
    pub fn marquee(&mut self, rect: Rect) {
        self.selection = hit_test_rect(&self.root, rect, false, false);
    }
    /// Figma's ⌘/Ctrl-drag marquee: the nested layers answer too.
    pub fn marquee_deep(&mut self, rect: Rect) {
        self.selection = hit_test_rect(&self.root, rect, false, true);
    }
    /// Figma Alt-drag marquee: select only fully-contained nodes.
    pub fn marquee_contained(&mut self, rect: Rect) {
        self.selection = hit_test_rect(&self.root, rect, true, false);
    }

    // -- undoable ops ------------------------------------------------------
    pub(crate) fn push_cmds(&mut self, cmds: Vec<Command>) {
        self.push(cmds);
    }

    fn clear_redo_history(&mut self) {
        self.redo_stack.clear();
        // Abandoned structural redo states must not keep entire trees alive.
        self.snapshots.retain(|(depth, _)| *depth != usize::MAX);
    }

    fn push(&mut self, cmds: Vec<Command>) {
        let applied: Vec<Command> = cmds
            .into_iter()
            .filter(|c| apply(&mut self.root, c))
            .collect();
        if !applied.is_empty() {
            self.edit_serial = self.edit_serial.wrapping_add(1);
            self.undo_stack.push(applied);
            self.clear_redo_history();
        }
    }

    /// Move a single node (undoable), used by corner-resize and alignment.
    pub fn move_node(&mut self, id: &str, dx: f64, dy: f64) {
        if dx == 0.0 && dy == 0.0 {
            return;
        }
        self.push(vec![Command::Move {
            id: id.into(),
            dx,
            dy,
        }]);
    }

    /// Align every selected node to the union bounds of the selection.
    /// `col`: 0 left / 1 center-x / 2 right; `row`: 0 top / 1 center-y /
    /// 2 bottom (0 = no-op keeps that axis untouched). Undoable.
    pub fn align_selection(&mut self, col: usize, row: usize) {
        let ids = self.selection.clone();
        if ids.is_empty() || col == usize::MAX {
            return;
        }
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        let mut rects = Vec::new();
        for id in &ids {
            if let Some(n) = find(&self.root, id) {
                rects.push((id.clone(), n.transform.x, n.transform.y, n.w, n.h));
                min_x = min_x.min(n.transform.x);
                min_y = min_y.min(n.transform.y);
                max_x = max_x.max(n.transform.x + n.w);
                max_y = max_y.max(n.transform.y + n.h);
            }
        }
        if rects.is_empty() {
            return;
        }
        let mut cmds = Vec::new();
        for (id, x, y, w, h) in rects {
            let tx = match col {
                1 => min_x + (max_x - min_x - w) / 2.0,
                2 => max_x - w,
                _ => min_x,
            };
            let ty = match row {
                1 => min_y + (max_y - min_y - h) / 2.0,
                2 => max_y - h,
                _ => min_y,
            };
            if (tx - x).abs() > 0.5 || (ty - y).abs() > 0.5 {
                cmds.push(Command::Move {
                    id,
                    dx: tx - x,
                    dy: ty - y,
                });
            }
        }
        if !cmds.is_empty() {
            self.push(cmds);
        }
    }

    /// Visibility is a persisted, undoable document edit.
    pub fn set_visible(&mut self, id: &str, v: bool) {
        if let Some(n) = find(&self.root, id).filter(|n| n.visible != v) {
            let mut after = n.clone();
            after.visible = v;
            self.replace_node(id, after);
        }
    }

    /// Locking changes hit testing, but must still participate in undo.
    pub fn set_locked(&mut self, id: &str, v: bool) {
        if let Some(n) = find(&self.root, id).filter(|n| n.locked != v) {
            let mut after = n.clone();
            after.locked = v;
            self.replace_node(id, after);
        }
    }

    pub fn move_selection(&mut self, dx: f64, dy: f64) {
        let cmds = self
            .selection
            .iter()
            .map(|id| Command::Move {
                id: id.clone(),
                dx,
                dy,
            })
            .collect();
        self.push(cmds);
    }
    pub fn resize(&mut self, id: &str, w: f64, h: f64) {
        if let Some(n) = find(&self.root, id) {
            let cmd = Command::Resize {
                id: id.into(),
                from: (n.w, n.h),
                to: (w, h),
            };
            self.push(vec![cmd]);
        }
    }
    pub fn rotate(&mut self, id: &str, angle: f64) {
        if let Some(n) = find(&self.root, id) {
            let cmd = Command::Rotate {
                id: id.into(),
                from: n.transform.rotation,
                to: angle,
            };
            self.push(vec![cmd]);
        }
    }
    /// Set a node's skew (shear) angles in radians (undoable).
    pub fn skew(&mut self, id: &str, sx: f64, sy: f64) {
        if let Some(n) = find(&self.root, id) {
            let cmd = Command::Skew {
                id: id.into(),
                from: (n.transform.skew_x, n.transform.skew_y),
                to: (sx, sy),
            };
            self.push(vec![cmd]);
        }
    }
    /// Set a Rect node's corner radius: uniform `radius` + optional per-corner
    /// overrides (None = uniform mode). Undoable.
    pub fn set_corners(&mut self, id: &str, radius: f64, corners: Option<[f64; 4]>) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Rect { .. }) {
            return false;
        }
        let from = match &n.kind {
            NodeKind::Rect { radius } => (*radius, n.corner_radii),
            _ => unreachable!(),
        };
        self.push(vec![Command::SetCorners {
            id: id.into(),
            from,
            to: (radius, corners),
        }]);
        true
    }

    /// Set a node's transform-origin (normalized 0..1, clamped). Undoable.
    pub fn set_origin(&mut self, id: &str, ox: f64, oy: f64) {
        if let Some(n) = find(&self.root, id) {
            let cmd = Command::SetOrigin {
                id: id.into(),
                from: (n.transform.origin_x, n.transform.origin_y),
                to: (ox, oy),
            };
            self.push(vec![cmd]);
        }
    }
    pub fn set_fill(&mut self, id: &str, paint: Paint) {
        if let Some(n) = find(&self.root, id) {
            if !n.visual_stacks_materialized {
                let cmd = Command::SetFill {
                    id: id.into(),
                    from: n.fill.clone(),
                    to: paint,
                };
                self.push(vec![cmd]);
            } else {
                let _ = self.mutate_visual_stack(id, move |node| {
                    if let Some(layer) = node.fill_layers.last_mut() {
                        layer.paint = paint;
                    } else {
                        node.fill_layers.push(PaintLayer::new(paint));
                    }
                });
            }
        }
    }

    /// Ordered visual-stack mutation. Every operation swaps the whole node,
    /// so add/remove/reorder/toggle remain one atomic undo step.
    pub fn mutate_visual_stack(&mut self, id: &str, f: impl FnOnce(&mut Node)) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.materialize_visual_stacks();
        f(&mut after);
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }

    pub fn add_fill_layer(&mut self, id: &str, paint: Paint) -> bool {
        self.mutate_visual_stack(id, move |n| n.fill_layers.push(PaintLayer::new(paint)))
    }
    pub fn add_stroke_layer(&mut self, id: &str, stroke: Stroke) -> bool {
        self.mutate_visual_stack(id, move |n| n.stroke_layers.push(StrokeLayer::new(stroke)))
    }
    pub fn add_effect_layer(&mut self, id: &str, effect: Effect) -> bool {
        self.mutate_visual_stack(id, move |n| n.effect_layers.push(EffectLayer::new(effect)))
    }
    pub fn remove_fill_layer(&mut self, id: &str, index: usize) -> bool {
        self.mutate_visual_stack(id, move |n| {
            if index < n.fill_layers.len() {
                n.fill_layers.remove(index);
            }
        })
    }
    pub fn remove_stroke_layer(&mut self, id: &str, index: usize) -> bool {
        self.mutate_visual_stack(id, move |n| {
            if index < n.stroke_layers.len() {
                n.stroke_layers.remove(index);
            }
        })
    }
    pub fn remove_effect_layer(&mut self, id: &str, index: usize) -> bool {
        self.mutate_visual_stack(id, move |n| {
            if index < n.effect_layers.len() {
                n.effect_layers.remove(index);
            }
        })
    }
    pub fn move_fill_layer(&mut self, id: &str, from: usize, to: usize) -> bool {
        self.mutate_visual_stack(id, move |n| {
            if from < n.fill_layers.len() && to < n.fill_layers.len() {
                let v = n.fill_layers.remove(from);
                n.fill_layers.insert(to, v);
            }
        })
    }
    pub fn move_stroke_layer(&mut self, id: &str, from: usize, to: usize) -> bool {
        self.mutate_visual_stack(id, move |n| {
            if from < n.stroke_layers.len() && to < n.stroke_layers.len() {
                let v = n.stroke_layers.remove(from);
                n.stroke_layers.insert(to, v);
            }
        })
    }
    pub fn move_effect_layer(&mut self, id: &str, from: usize, to: usize) -> bool {
        self.mutate_visual_stack(id, move |n| {
            if from < n.effect_layers.len() && to < n.effect_layers.len() {
                let v = n.effect_layers.remove(from);
                n.effect_layers.insert(to, v);
            }
        })
    }
    pub fn set_text(&mut self, id: &str, text: &str) {
        let Some(mut after) = find(&self.root, id).cloned() else {
            return;
        };
        let NodeKind::Text { text: old } = &mut after.kind else {
            return;
        };
        if old == text {
            return;
        }
        *old = text.into();
        let len = text.chars().count();
        after.text_runs.retain_mut(|r| {
            r.start = r.start.min(len);
            r.len = r.len.min(len.saturating_sub(r.start));
            r.len > 0
        });
        self.replace_node(id, after);
    }
    /// Replace a Text node's entire rich-text run list (undoable).
    pub fn set_text_runs(&mut self, id: &str, runs: Vec<TextRun>) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Text { .. }) {
            return false;
        }
        let cmd = Command::SetTextRuns {
            id: id.into(),
            from: n.text_runs.clone(),
            to: runs,
        };
        self.push(vec![cmd]);
        true
    }
    /// Toggle a boolean-ish style (bold or italic) over a CHAR range: if
    /// every char in the range already carries the flag, turn it off; else on.
    pub fn toggle_span_style(&mut self, id: &str, start: usize, end: usize, bold: bool) -> bool {
        if start >= end {
            return false;
        }
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Text { .. }) {
            return false;
        }
        let len = match &n.kind {
            NodeKind::Text { text } => text.chars().count(),
            _ => 0,
        };
        let (s, e) = (start.min(len), end.min(len));
        if s >= e {
            return false;
        }
        let active = (s..e).all(|i| {
            n.text_runs.iter().any(|r| {
                r.start <= i && i < r.start.saturating_add(r.len) && {
                    if bold {
                        r.weight.unwrap_or(400) >= 600
                    } else {
                        r.italic == Some(true)
                    }
                }
            })
        });
        let patch = if bold {
            TextRun {
                start: 0,
                len: 0,
                weight: Some(if active { 400 } else { 700 }),
                ..Default::default()
            }
        } else {
            TextRun {
                start: 0,
                len: 0,
                italic: Some(!active),
                ..Default::default()
            }
        };
        self.apply_run_style(id, s, e, patch)
    }

    /// Apply a rich-text style patch to a CHAR range within a Text node
    /// (undoable). The patch merges over the range's current effective
    /// style (last-run-wins, same rule as the renderer), then overlapping
    /// runs are clipped around the range and it is overlaid (Figma's
    /// style-override semantics).
    pub fn apply_run_style(&mut self, id: &str, start: usize, end: usize, patch: TextRun) -> bool {
        if start >= end {
            return false;
        }
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Text { .. }) {
            return false;
        }
        let len = match &n.kind {
            NodeKind::Text { text } => text.chars().count(),
            _ => 0,
        };
        let (s, e) = (start.min(len), end.min(len));
        if s >= e {
            return false;
        }
        // effective style at the range's first char (fields not in the patch
        // carry over, so bolding a colored run keeps its color).
        let eff = n
            .text_runs
            .iter()
            .rev()
            .find(|r| r.start <= s && s < r.start.saturating_add(r.len))
            .cloned()
            .unwrap_or_default();
        let merged = TextRun {
            color: patch.color.or(eff.color),
            size: patch.size.or(eff.size),
            font: patch.font.clone().or(eff.font.clone()),
            weight: patch.weight.or(eff.weight),
            italic: patch.italic.or(eff.italic),
            ls: patch.ls.or(eff.ls),
            ..Default::default()
        };
        let from = n.text_runs.clone();
        let mut to = from.clone();
        overlay_run(&mut to, s, e, merged);
        self.push(vec![Command::SetTextRuns {
            id: id.into(),
            from,
            to,
        }]);
        true
    }
    /// Set (or clear, with None) a frame's auto layout, re-solve child
    /// positions immediately, all as ONE undoable ReplaceNode command.
    pub fn set_auto_layout(
        &mut self,
        id: &str,
        layout: Option<x_core::AutoLayout>,
        vars: &Variables,
    ) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Frame { .. }) {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.kind = NodeKind::Frame {
            layout: layout.clone(),
        };
        if layout.is_some() {
            x_core::apply_auto_layout(&mut after, vars);
        }
        let cmd = Command::ReplaceNode {
            id: id.into(),
            before,
            after: Box::new(after),
        };
        self.push(vec![cmd]);
        true
    }

    /// Set a child's auto-layout constraints (align_self / grow / shrink /
    /// basis / absolute / fixed / sticky), then re-solve the parent frame —
    /// one undo step (Figma's constraint edits re-flow immediately).
    pub fn set_child_constraints(
        &mut self,
        id: &str,
        constraints: x_core::ChildConstraints,
        vars: &Variables,
    ) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let mut after = n.clone();
        after.constraints = constraints.clone();
        after.dirty = true;
        let mut cmds = vec![Command::ReplaceNode {
            id: id.into(),
            before: Box::new(n.clone()),
            after: Box::new(after),
        }];

        // Re-layout the parent frame (if it has auto layout) using a working
        // parent that already carries the child's new constraints.
        if let Some(pid) = crate::selection::parent_id(&self.root, id) {
            if let Some(p) = find(&self.root, &pid) {
                if matches!(p.kind, NodeKind::Frame { layout: Some(_) }) {
                    let mut pafter = p.clone();
                    if let Some(c) = find_mut(&mut pafter, id) {
                        c.constraints = constraints;
                    }
                    x_core::apply_auto_layout(&mut pafter, vars);
                    cmds.push(Command::ReplaceNode {
                        id: pid.clone(),
                        before: Box::new(p.clone()),
                        after: Box::new(pafter),
                    });
                }
            }
        }
        self.push(cmds);
        true
    }

    /// Current per-child constraints of a node.
    pub fn child_constraints_of(&self, id: &str) -> Option<x_core::ChildConstraints> {
        find(&self.root, id).map(|n| n.constraints.clone())
    }

    /// Current auto layout of a frame, if any.
    pub fn auto_layout_of(&self, id: &str) -> Option<x_core::AutoLayout> {
        match find(&self.root, id)?.kind {
            NodeKind::Frame { ref layout } => layout.clone(),
            _ => None,
        }
    }

    /// Phase 2.3 (Scale tool): scale a node AND its whole subtree
    /// uniformly — sizes, child offsets, strokes, corner radii. One
    /// undoable ReplaceNode.
    pub fn scale_node(&mut self, id: &str, factor: f64) -> bool {
        if factor <= 0.0 {
            return false;
        }
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        fn scale_subtree(n: &mut Node, f: f64, scale_own_pos: bool) {
            if scale_own_pos {
                n.transform.x *= f;
                n.transform.y *= f;
            }
            n.w *= f;
            n.h *= f;
            n.stroke.width *= f;
            if let NodeKind::Rect { radius } = &mut n.kind {
                *radius *= f;
            }
            if let Some(r) = &mut n.corner_radii {
                for v in r.iter_mut() {
                    *v *= f;
                }
            }
            if let NodeKind::Vector { path } = &mut n.kind {
                for c in path.iter_mut() {
                    match c {
                        x_core::PathCmd::MoveTo(x, y) | x_core::PathCmd::LineTo(x, y) => {
                            *x *= f;
                            *y *= f;
                        }
                        x_core::PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                            *x1 *= f;
                            *y1 *= f;
                            *x2 *= f;
                            *y2 *= f;
                            *x *= f;
                            *y *= f;
                        }
                        x_core::PathCmd::Close => {}
                    }
                }
            }
            for c in &mut n.children {
                scale_subtree(c, f, true);
            }
        }
        // the root of the scale keeps its own x/y (scales in place)
        scale_subtree(&mut after, factor, false);
        let cmd = Command::ReplaceNode {
            id: id.into(),
            before,
            after: Box::new(after),
        };
        self.push(vec![cmd]);
        true
    }

    /// Flip a layer without flattening it. Negative transform scale preserves
    /// editability and is serialized like any other transform.
    pub fn flip_node(&mut self, id: &str, horizontal: bool) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if horizontal {
            after.transform.scale_x *= -1.0;
        } else {
            after.transform.scale_y *= -1.0;
        }
        self.push_replace(id, before, after);
        true
    }

    /// Phase 8: set/clear a prototype link (click -> navigate to destination).
    pub fn set_prototype(&mut self, id: &str, action: Option<x_core::PrototypeAction>) {
        if let Some(n) = find(&self.root, id) {
            let cmd = Command::SetPrototype {
                id: id.into(),
                from: n.prototype.clone(),
                to: action,
            };
            self.push(vec![cmd]);
        }
    }

    /// Set a frame's clip/scroll overflow behavior (one undoable ReplaceNode).
    pub fn set_overflow(&mut self, id: &str, overflow: x_core::Overflow) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.overflow = overflow;
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }

    /// Set a frame's scroll offset (authoring/preview state, undoable).
    pub fn set_scroll(&mut self, id: &str, x: f64, y: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.scroll = (x, y);
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }

    /// Replace a node's prototyping interactions (one undoable ReplaceNode).
    pub fn set_interactions(&mut self, id: &str, interactions: Vec<x_core::Interaction>) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.interactions = interactions;
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }

    /// Toggle a frame's flow starting-point flag (one undoable ReplaceNode).
    pub fn set_starting_point(&mut self, id: &str, value: bool) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.is_starting_point = value;
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }

    pub fn set_opacity(&mut self, id: &str, v: f32) {
        if let Some(n) = find(&self.root, id) {
            let cmd = Command::SetOpacity {
                id: id.into(),
                from: n.opacity,
                to: v,
            };
            self.push(vec![cmd]);
        }
    }
    /// Replace a node's per-node export settings (one undoable ReplaceNode).
    pub fn set_export_settings(&mut self, id: &str, settings: Vec<x_core::ExportSettings>) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.export_settings = settings;
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }
    fn selected_roots(&self) -> Vec<String> {
        fn visit(n: &Node, selected: &[String], out: &mut Vec<String>) {
            if selected.contains(&n.id) {
                out.push(n.id.clone());
                return;
            }
            for c in &n.children {
                visit(c, selected, out);
            }
        }
        let mut out = vec![];
        visit(&self.root, &self.selection, &mut out);
        out
    }
    pub fn delete_selection(&mut self) {
        let mut cmds = vec![];
        for id in self.selected_roots() {
            if let Some(p) = find_parent_mut(&mut self.root, &id) {
                if let Some(i) = p.children.iter().position(|c| c.id == id) {
                    cmds.push(Command::Delete {
                        parent_id: p.id.clone(),
                        index: i,
                        node: p.children[i].clone(),
                    });
                }
            }
        }
        // Delete back-to-front so stored indices stay valid.
        cmds.sort_by(|a, b| match (a, b) {
            (Command::Delete { index: ia, .. }, Command::Delete { index: ib, .. }) => ib.cmp(ia),
            _ => std::cmp::Ordering::Equal,
        });
        self.push(cmds);
        self.selection.clear();
    }
    /// Phase 2.8: z-order. bring_to_front / send_to_back.
    pub fn bring_to_front(&mut self, id: &str) {
        if let Some(p) = find_parent_mut(&mut self.root, id) {
            let last = p.children.len() - 1;
            if let Some(from) = p.children.iter().position(|c| c.id == id) {
                if from != last {
                    self.push(vec![Command::Reorder {
                        id: id.into(),
                        from,
                        to: last,
                    }]);
                }
            }
        }
    }
    pub fn send_to_back(&mut self, id: &str) {
        if let Some(p) = find_parent_mut(&mut self.root, id) {
            if let Some(from) = p.children.iter().position(|c| c.id == id) {
                if from != 0 {
                    self.push(vec![Command::Reorder {
                        id: id.into(),
                        from,
                        to: 0,
                    }]);
                }
            }
        }
    }
    /// Move one step forward in z-order (swap with the next-higher
    /// sibling) — Figma's plain ⌘] "Bring Forward", distinct from the
    /// full jump-to-front above.
    pub fn bring_forward(&mut self, id: &str) {
        if let Some(p) = find_parent_mut(&mut self.root, id) {
            if let Some(from) = p.children.iter().position(|c| c.id == id) {
                let to = from + 1;
                if to < p.children.len() {
                    self.push(vec![Command::Reorder {
                        id: id.into(),
                        from,
                        to,
                    }]);
                }
            }
        }
    }
    /// Move one step backward in z-order (swap with the next-lower
    /// sibling) — Figma's plain ⌘[ "Send Backward".
    pub fn send_backward(&mut self, id: &str) {
        if let Some(p) = find_parent_mut(&mut self.root, id) {
            if let Some(from) = p.children.iter().position(|c| c.id == id) {
                if from > 0 {
                    self.push(vec![Command::Reorder {
                        id: id.into(),
                        from,
                        to: from - 1,
                    }]);
                }
            }
        }
    }
    /// Phase 2.9: group the current selection (snapshot-undo).
    pub fn group_selection(&mut self, group_id: &str) {
        if group_id.is_empty() || find(&self.root, group_id).is_some() {
            return;
        }
        if self.selection.len() < 2 {
            return;
        }
        let snapshot = self.root.clone();
        // find common parent of first selected node; require all share it.
        let first = self.selection[0].clone();
        let parent_id = match find_parent_mut(&mut self.root, &first) {
            Some(p) => p.id.clone(),
            None => return,
        };
        let indices: Vec<usize> = {
            // stale parent id (undo/redo race, async UI): no-op, not a panic
            let Some(p) = find(&self.root, &parent_id) else {
                return;
            };
            self.selection
                .iter()
                .filter_map(|id| p.children.iter().position(|c| &c.id == id))
                .collect()
        };
        if indices.len() != self.selection.len() {
            return;
        } // not siblings
        let cmd = Command::Group {
            parent_id,
            indices,
            group_id: group_id.into(),
        };
        if apply(&mut self.root, &cmd) {
            self.snapshots.push((self.undo_stack.len(), snapshot));
            self.edit_serial = self.edit_serial.wrapping_add(1);
            self.undo_stack.push(vec![cmd]);
            self.clear_redo_history();
            self.selection = vec![group_id.to_string()];
        }
    }

    /// Figma "Frame selection" (⌥⌘G / ⌘⇧A): wrap the current selection in a
    /// new Frame sized to the members' collective AABB. Works with a single
    /// node (unlike group, which needs 2+). Snapshot-undo, like group.
    /// Wrap the current selection in a labelled Section container.
    pub fn section_selection(&mut self, section_id: &str) {
        if section_id.is_empty() || find(&self.root, section_id).is_some() {
            return;
        }
        if self.selection.is_empty() {
            return;
        }
        let snapshot = self.root.clone();
        let first = self.selection[0].clone();
        let parent_id = match find_parent_mut(&mut self.root, &first) {
            Some(p) => p.id.clone(),
            None => return,
        };
        let indices: Vec<usize> = {
            // stale parent id (undo/redo race, async UI): no-op, not a panic
            let Some(p) = find(&self.root, &parent_id) else {
                return;
            };
            self.selection
                .iter()
                .filter_map(|id| p.children.iter().position(|c| &c.id == id))
                .collect()
        };
        if indices.len() != self.selection.len() {
            return;
        } // not siblings
        let cmd = Command::SectionSelection {
            parent_id,
            indices,
            section_id: section_id.into(),
        };
        if apply(&mut self.root, &cmd) {
            self.snapshots.push((self.undo_stack.len(), snapshot));
            self.edit_serial = self.edit_serial.wrapping_add(1);
            self.undo_stack.push(vec![cmd]);
            self.clear_redo_history();
            self.selection = vec![section_id.to_string()];
        }
    }

    pub fn frame_selection(&mut self, frame_id: &str) {
        if frame_id.is_empty() || find(&self.root, frame_id).is_some() {
            return;
        }
        if self.selection.is_empty() {
            return;
        }
        let snapshot = self.root.clone();
        let first = self.selection[0].clone();
        let parent_id = match find_parent_mut(&mut self.root, &first) {
            Some(p) => p.id.clone(),
            None => return,
        };
        let indices: Vec<usize> = {
            // stale parent id (undo/redo race, async UI): no-op, not a panic
            let Some(p) = find(&self.root, &parent_id) else {
                return;
            };
            self.selection
                .iter()
                .filter_map(|id| p.children.iter().position(|c| &c.id == id))
                .collect()
        };
        if indices.len() != self.selection.len() {
            return;
        } // not siblings
        let cmd = Command::FrameSelection {
            parent_id,
            indices,
            frame_id: frame_id.into(),
        };
        if apply(&mut self.root, &cmd) {
            self.snapshots.push((self.undo_stack.len(), snapshot));
            self.edit_serial = self.edit_serial.wrapping_add(1);
            self.undo_stack.push(vec![cmd]);
            self.clear_redo_history();
            self.selection = vec![frame_id.to_string()];
        }
    }

    /// Figma Ctrl+Shift+G: dissolve a group/frame, re-parenting children to
    /// the grandparent at the group's spot with positions preserved.
    pub fn ungroup(&mut self, id: &str) -> bool {
        let Some(g) = find(&self.root, id) else {
            return false;
        };
        if !matches!(
            g.kind,
            NodeKind::Group | NodeKind::Section | NodeKind::Frame { .. }
        ) {
            return false;
        }
        let snapshot = self.root.clone();
        let (gx, gy) = (g.transform.x, g.transform.y);
        let Some(parent) = find_parent_mut(&mut self.root, id) else {
            return false;
        };
        let Some(pos) = parent.children.iter().position(|c| c.id == id) else {
            return false;
        };
        let mut group = parent.children.remove(pos);
        let mut ids = vec![];
        for mut child in group.children.drain(..) {
            child.transform.x += gx;
            child.transform.y += gy;
            ids.push(child.id.clone());
            parent.children.insert(pos, child);
        }
        self.snapshots.push((self.undo_stack.len(), snapshot));
        self.edit_serial = self.edit_serial.wrapping_add(1);
        self.undo_stack.push(vec![Command::Group {
            parent_id: String::new(),
            indices: vec![],
            group_id: id.into(),
        }]);
        self.clear_redo_history();
        self.selection = ids;
        true
    }

    /// Figma Ctrl+A: select all top-level children of the page (or of the
    /// selected frame if one frame is selected).
    pub fn select_all(&mut self) {
        let scope = if self.selection.len() == 1 {
            find(&self.root, &self.selection[0]).filter(|n| {
                matches!(n.kind, NodeKind::Frame { .. } | NodeKind::Group) && !n.children.is_empty()
            })
        } else {
            None
        };
        let source = scope.unwrap_or(&self.root);
        self.selection = source
            .children
            .iter()
            .filter(|c| c.visible && !c.locked)
            .map(|c| c.id.clone())
            .collect();
    }

    /// Smart selection: select every node in the document whose shape
    /// signature (kind + fill + stroke paint/width) matches the first
    /// selected node. Returns the new selection size.
    pub fn select_similar(&mut self) -> usize {
        let Some(first) = self.selection.first().cloned() else {
            return 0;
        };
        let Some(src) = find(&self.root, &first) else {
            return 0;
        };
        let sig = shape_signature(src);
        fn walk(n: &Node, sig: &Sig, out: &mut Vec<String>) {
            if n.visible && !n.locked && shape_signature(n) == *sig {
                out.push(n.id.clone());
            }
            for c in &n.children {
                walk(c, sig, out);
            }
        }
        let mut out = vec![];
        for c in &self.root.children {
            walk(c, &sig, &mut out);
        }
        if out.is_empty() {
            out.push(first);
        }
        let n = out.len();
        self.selection = out;
        n
    }

    /// Select-inside: replace each selected container (group / frame /
    /// section / component / instance) with its children — one level
    /// deep, Figma's deep-select. Returns the new selection size.
    pub fn select_inside(&mut self) -> usize {
        let mut out = vec![];
        for id in self.selection.clone() {
            if let Some(n) = find(&self.root, &id) {
                let kids: Vec<String> = n
                    .children
                    .iter()
                    .filter(|c| c.visible && !c.locked)
                    .map(|c| c.id.clone())
                    .collect();
                if kids.is_empty() {
                    out.push(id);
                } else {
                    out.extend(kids);
                }
            }
        }
        let n = out.len();
        if n > 0 {
            self.selection = out;
        }
        n
    }

    /// Figma-style Tidy Up: rearrange the selected siblings (or the
    /// children of one selected container) into a near-square grid with
    /// uniform gaps, sizes preserved. One undo step.
    /// Returns (moved, cols, rows).
    pub fn tidy_up(&mut self) -> Option<(usize, usize, usize)> {
        // targets: children of a single selected container, else the
        // selection itself (which must be siblings)
        let targets: Vec<String> = if self.selection.len() == 1 {
            let n = find(&self.root, &self.selection[0])?;
            match &n.kind {
                NodeKind::Group | NodeKind::Section | NodeKind::Frame { .. }
                    if n.children.len() >= 2 =>
                {
                    n.children.iter().map(|c| c.id.clone()).collect()
                }
                _ => return None,
            }
        } else if self.selection.len() >= 2 {
            self.selection.clone()
        } else {
            return None;
        };
        // geometry snapshot (targets may be nested; positions are
        // relative to their own parents, which is what Move edits)
        let mut items: Vec<(String, f64, f64, f64, f64)> = targets
            .iter()
            .filter_map(|id| {
                find(&self.root, id).map(|n| (id.clone(), n.transform.x, n.transform.y, n.w, n.h))
            })
            .collect();
        if items.len() < 2 {
            return None;
        }
        // reading order: top-to-bottom rows, left-to-right inside a row
        // total_cmp: NaN coordinates (from a hostile/malformed import)
        // must sort deterministically, not panic
        items.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.2.total_cmp(&b.2)));
        let n = items.len();
        let cols = (n as f64).sqrt().ceil() as usize;
        let rows = n.div_ceil(cols);
        let max_w = items.iter().map(|i| i.3).fold(0.0_f64, f64::max);
        let max_h = items.iter().map(|i| i.4).fold(0.0_f64, f64::max);
        // uniform gap: median of the ORIGINAL horizontal neighbour gaps
        // where items share a row band; 20.0 when nothing aligns
        let avg_h = items.iter().map(|i| i.4).sum::<f64>() / n as f64;
        let mut gaps: Vec<f64> = vec![];
        for w in items.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if (a.2 - b.2).abs() < avg_h * 0.6 {
                gaps.push((b.1 - (a.1 + a.3)).max(0.0));
            }
        }
        gaps.sort_by(f64::total_cmp);
        let gap = if gaps.is_empty() {
            20.0
        } else {
            gaps[gaps.len() / 2]
        };
        // keep the grid's top-left at the collective min corner
        let x0 = items.iter().map(|i| i.1).fold(f64::INFINITY, f64::min);
        let y0 = items.iter().map(|i| i.2).fold(f64::INFINITY, f64::min);
        let mut cmds = vec![];
        for (i, (id, x, y, _, _)) in items.iter().enumerate() {
            let (col, row) = (i % cols, i / cols);
            let tx = x0 + col as f64 * (max_w + gap);
            let ty = y0 + row as f64 * (max_h + gap);
            if (tx - x).abs() > 0.01 || (ty - y).abs() > 0.01 {
                cmds.push(Command::Move {
                    id: id.clone(),
                    dx: tx - x,
                    dy: ty - y,
                });
            }
        }
        let moved = cmds.len();
        self.push_cmds(cmds);
        Some((moved, cols, rows))
    }

    /// Undoable constraint-pin change (Figma constraints panel).
    pub fn set_pin(&mut self, id: &str, h: x_core::HPin, v: x_core::VPin) {
        if let Some(n) = find(&self.root, id) {
            let before = Box::new(n.clone());
            let mut after = n.clone();
            after.pin = (h, v);
            self.push(vec![Command::ReplaceNode {
                id: id.into(),
                before,
                after: Box::new(after),
            }]);
        }
    }

    pub fn undo(&mut self) -> bool {
        // an open interactive drag is abandoned: its snapshot no longer
        // describes the tree undo is about to restore
        self.path_gesture = None;
        let Some(cmds) = self.undo_stack.pop() else {
            return false;
        };
        // Structural command? restore the snapshot taken before it.
        if matches!(
            cmds.first(),
            Some(
                Command::Group { .. }
                    | Command::FrameSelection { .. }
                    | Command::SectionSelection { .. }
            )
        ) {
            if let Some(pos) = self
                .snapshots
                .iter()
                .rposition(|(depth, _)| *depth == self.undo_stack.len())
            {
                let (_, snap) = self.snapshots.remove(pos);
                let redo_state = self.root.clone();
                self.root = snap;
                self.redo_stack.push(cmds);
                self.snapshots.push((usize::MAX, redo_state)); // stash for redo
                return true;
            }
        }
        for cmd in cmds.iter().rev() {
            apply(&mut self.root, &invert(cmd));
        }
        self.redo_stack.push(cmds);
        true
    }
    pub fn redo(&mut self) -> bool {
        self.path_gesture = None;
        let Some(cmds) = self.redo_stack.pop() else {
            return false;
        };
        if matches!(
            cmds.first(),
            Some(
                Command::Group { .. }
                    | Command::FrameSelection { .. }
                    | Command::SectionSelection { .. }
            )
        ) {
            if let Some(pos) = self.snapshots.iter().rposition(|(d, _)| *d == usize::MAX) {
                let (_, state) = self.snapshots.remove(pos);
                self.snapshots
                    .push((self.undo_stack.len(), self.root.clone()));
                self.root = state;
                self.edit_serial = self.edit_serial.wrapping_add(1);
                self.undo_stack.push(cmds);
                return true;
            }
        }
        for cmd in &cmds {
            apply(&mut self.root, cmd);
        }
        self.edit_serial = self.edit_serial.wrapping_add(1);
        self.undo_stack.push(cmds);
        true
    }

    /// Merge the last `n` undo entries into a single undo step. UI drags
    /// call move/resize once per mouse event (each pushing an entry);
    /// on mouse-up they merge the whole gesture so one Ctrl+Z reverts it.
    pub fn merge_last(&mut self, n: usize) {
        if n <= 1 || self.undo_stack.len() < n {
            return;
        }
        let at = self.undo_stack.len() - n;
        let mut merged = vec![];
        for group in self.undo_stack.drain(at..) {
            merged.extend(group);
        }
        self.undo_stack.push(merged);
    }
    /// Number of undo entries (lets the UI count a gesture's commands).
    pub fn undo_depth(&self) -> usize {
        self.undo_stack.len()
    }

    /// Drop oldest undo groups together with their structural snapshots.
    /// Called by the session's bounded, cross-page history coordinator.
    pub fn discard_oldest_undo(&mut self, count: usize) {
        let n = count.min(self.undo_stack.len());
        self.undo_stack.drain(..n);
        self.snapshots.retain_mut(|(depth, _)| {
            if *depth == usize::MAX {
                true
            } else if *depth < n {
                false
            } else {
                *depth -= n;
                true
            }
        });
    }

    /// Approximate undo-history bytes (ReplaceNode snapshots dominate).
    pub fn history_bytes(&self) -> usize {
        fn cmds_bytes(cmds: &[Command]) -> usize {
            cmds.iter()
                .map(|c| match c {
                    Command::ReplaceNode { before, after, .. } => {
                        node_size(before) + node_size(after) + 64
                    }
                    Command::Delete { node, .. } | Command::Insert { node, .. } => {
                        node_size(node) + 64
                    }
                    _ => 96,
                })
                .sum()
        }
        fn node_size(n: &x_core::Node) -> usize {
            let mut b = std::mem::size_of::<x_core::Node>() + n.id.len();
            b += n.children.iter().map(node_size).sum::<usize>();
            b
        }
        self.undo_stack.iter().map(|g| cmds_bytes(g)).sum::<usize>()
            + self.redo_stack.iter().map(|g| cmds_bytes(g)).sum::<usize>()
            + self
                .snapshots
                .iter()
                .map(|(_, n)| node_size(n))
                .sum::<usize>()
    }

    /// Insert a new node under `parent_id` (undoable). Returns success.
    /// Undoable whole-node swap (mask flags, image placement, style binds…).
    pub fn replace_node(&mut self, id: &str, after: Node) -> bool {
        let Some(before) = find(&self.root, id) else {
            return false;
        };
        let cmd = Command::ReplaceNode {
            id: id.into(),
            before: Box::new(before.clone()),
            after: Box::new(after),
        };
        self.push(vec![cmd]);
        true
    }

    /// Reset an instance's overrides (Figma "reset overrides"). Slot
    /// content is kept. Undoable.
    pub fn reset_instance_overrides(&mut self, id: &str) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, x_core::NodeKind::Instance { .. }) {
            return false;
        }
        let mut after = n.clone();
        x_core::reset_overrides(&mut after);
        self.replace_node(id, after)
    }

    /// Detach an instance into a resolved group (overrides + slot content
    /// applied). Undoable; returns the detached group's id.
    pub fn detach(&mut self, id: &str, vars: &x_core::Variables) -> Option<String> {
        let instance = find(&self.root, id)?;
        let mut group = x_core::detach_instance(&self.root, instance, vars)?;
        let old = group.id.clone();
        x_core::remap_node_ids(&mut group, |node_id| {
            if node_id == old {
                id.to_owned()
            } else {
                x_core::fresh_id("node")
            }
        });
        let new_id = group.id.clone();
        if self.replace_node(id, group) {
            Some(new_id)
        } else {
            None
        }
    }

    pub fn insert_node(&mut self, parent_id: &str, node: Node) -> bool {
        self.insert_nodes(parent_id, vec![node])
    }

    pub fn insert_nodes(&mut self, parent_id: &str, nodes: Vec<Node>) -> bool {
        let Some(parent) = find(&self.root, parent_id) else {
            return false;
        };
        if nodes.is_empty() {
            return false;
        }
        let base = parent.children.len();
        let mut taken = std::collections::HashSet::new();
        collect_ids(&self.root, &mut taken);
        let mut todo: Vec<_> = nodes.iter().collect();
        while let Some(n) = todo.pop() {
            if n.id.is_empty() || !taken.insert(n.id.clone()) {
                return false;
            }
            todo.extend(&n.children);
        }
        self.push(
            nodes
                .into_iter()
                .enumerate()
                .map(|(i, node)| Command::Insert {
                    parent_id: parent_id.into(),
                    index: base + i,
                    node,
                })
                .collect(),
        );
        true
    }

    /// P12 drag-reorder: move node `id` (currently at `from_index` in
    /// `from_parent`) so it lands at logical slot `index` in `to_parent`'s
    /// children — the slot expressed in the list where the node STILL
    /// exists (e.g. "before sibling T" = T's index, "after T" = T's
    /// index + 1). The same-parent removal shift is applied here, and the
    /// index is clamped at apply. One undo step. `false` when invalid
    /// (unknown ids, the root, a cycle) or a no-op (same slot).
    pub fn reorder_node(
        &mut self,
        id: &str,
        from_parent: &str,
        from_index: usize,
        to_parent: &str,
        index: usize,
    ) -> bool {
        if id == to_parent || id == self.root.id {
            return false;
        }
        let Some(node) = find(&self.root, id) else {
            return false;
        };
        if find(node, to_parent).is_some() {
            return false; // to_parent lives inside the moving subtree
        }
        let Some(fp) = find(&self.root, from_parent) else {
            return false;
        };
        if fp.children.get(from_index).map(|c| c.id.as_str()) != Some(id) {
            return false;
        }
        // Splice semantics: removing the node above the slot shifts the
        // insertion point down by one (same parent only).
        let slot = if from_parent == to_parent && from_index < index {
            index.saturating_sub(1)
        } else {
            index
        };
        if from_parent == to_parent && slot == from_index {
            return false; // same slot
        }
        let cmd = Command::ReorderNode {
            id: id.into(),
            from_parent: from_parent.into(),
            from_index,
            to_parent: to_parent.into(),
            index: slot,
        };
        if apply(&mut self.root, &cmd) {
            self.edit_serial = self.edit_serial.wrapping_add(1);
            self.undo_stack.push(vec![cmd]);
            self.clear_redo_history();
            true
        } else {
            false
        }
    }

    /// Phase 5.2: turn the current selection into a Component definition.
    /// The selected nodes become children of a hidden master (placed at the
    /// document root), and the selection is replaced in-place by an Instance
    /// of it — same flow as Figma's "create component". One undo step
    /// (snapshot-based, like group).
    pub fn make_component(&mut self, name: &str) -> bool {
        if self.selection.is_empty() {
            return false;
        }
        let snapshot = self.root.clone();
        let first = self.selection[0].clone();
        let Some(parent_id) = find_parent_mut(&mut self.root, &first).map(|p| p.id.clone()) else {
            return false;
        };
        // all selected must be siblings under the same parent
        let indices: Vec<usize> = {
            let Some(p) = find(&self.root, &parent_id) else {
                return false;
            };
            self.selection
                .iter()
                .filter_map(|id| p.children.iter().position(|c| &c.id == id))
                .collect()
        };
        if indices.len() != self.selection.len() {
            return false;
        }

        let Some(p) = find_mut(&mut self.root, &parent_id) else {
            return false;
        };
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        let mut members: Vec<Node> = vec![];
        for &i in sorted.iter().rev() {
            members.insert(0, p.children.remove(i));
        }
        // collective bounds -> master size; members re-based to (0,0)
        let x0 = members
            .iter()
            .map(|n| n.transform.x)
            .fold(f64::INFINITY, f64::min);
        let y0 = members
            .iter()
            .map(|n| n.transform.y)
            .fold(f64::INFINITY, f64::min);
        let x1 = members
            .iter()
            .map(|n| n.transform.x + n.w)
            .fold(f64::NEG_INFINITY, f64::max);
        let y1 = members
            .iter()
            .map(|n| n.transform.y + n.h)
            .fold(f64::NEG_INFINITY, f64::max);
        let (w, h) = (x1 - x0, y1 - y0);
        let mut master = Node::component(&format!("comp-{name}"), name, w, h);
        for mut m in members {
            m.transform.x -= x0;
            m.transform.y -= y0;
            master.children.push(m);
        }
        master.visible = false; // masters live hidden at the root
        let instance_id = format!("{name}-1");
        let instance = Node::instance(&instance_id, name, x0, y0, w, h);
        // instance replaces the members at their original spot
        let Some(p) = find_mut(&mut self.root, &parent_id) else {
            return false; // stale parent: drop the op instead of panicking
        };
        p.children.insert(sorted[0], instance);
        self.root.children.push(master);

        self.snapshots.push((self.undo_stack.len(), snapshot));
        self.edit_serial = self.edit_serial.wrapping_add(1);
        self.undo_stack.push(vec![Command::Group {
            parent_id,
            indices: sorted,
            group_id: instance_id.clone(),
        }]); // snapshot-undo reuses Group's path
        self.clear_redo_history();
        self.selection = vec![instance_id];
        true
    }

    /// Phase 5.2: stamp a new Instance of `component` at (x, y). Undoable.
    /// Returns the new instance id.
    /// Phase 5.2 variant: stamp an Instance into a SPECIFIC parent.
    /// Guards against instance cycles first (review A6: `would_cycle` was
    /// never consulted before placement): a master may not be placed
    /// inside itself — directly (a Component node with the same name) or
    /// through an Instance of the same component — because rendering then
    /// recurses forever. Instances at the page root can never cycle, so
    /// [`Self::place_instance`] is simply the root-parent case.
    pub fn place_instance_in(
        &mut self,
        component: &str,
        parent: &str,
        x: f64,
        y: f64,
    ) -> Option<String> {
        // cycle check: walk parent -> root; reject when any ancestor is a
        // Component with this name or an Instance OF this component
        fn is_componentish(n: &Node, component: &str) -> bool {
            match &n.kind {
                NodeKind::Component { name } => name == component,
                NodeKind::Instance { component: c } => c == component,
                _ => false,
            }
        }
        // UP: the parent chain must not contain the component (directly or
        // as an instance of it)
        let mut cur = parent.to_string();
        loop {
            let n = find(&self.root, &cur)?;
            if is_componentish(n, component) {
                return None;
            }
            match parent_id(&self.root, &cur) {
                Some(p) => cur = p,
                // reached the root: no cycle on this branch
                None => break,
            }
        }
        // NOTE: only the ANCESTOR chain matters. A sibling instance of the
        // same component (the usual master-at-root / instances-at-root
        // layout) is the normal legal pattern — the master's OWN subtree is
        // what would recurse, and placement does not add the parent's other
        // children to it.
        // stamp: master's size, unique id, inserted under `parent`
        fn find_master<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
            if let NodeKind::Component { name: c } = &n.kind {
                if c == name {
                    return Some(n);
                }
            }
            n.children.iter().find_map(|c| find_master(c, name))
        }
        let (w, h) = {
            let m = find_master(&self.root, component)?;
            (m.w, m.h)
        };
        let mut i = 1usize;
        let id = loop {
            let cand = format!("{component}-{i}");
            if find(&self.root, &cand).is_none() {
                break cand;
            }
            i += 1;
        };
        let node = Node::instance(&id, component, x, y, w, h);
        if self.insert_node(parent, node) {
            Some(id)
        } else {
            None
        }
    }

    pub fn place_instance(&mut self, component: &str, x: f64, y: f64) -> Option<String> {
        // find the master to copy its size
        fn find_master<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
            if let NodeKind::Component { name: c } = &n.kind {
                if c == name {
                    return Some(n);
                }
            }
            n.children.iter().find_map(|c| find_master(c, name))
        }
        let (w, h) = {
            let m = find_master(&self.root, component)?;
            (m.w, m.h)
        };
        // unique id
        let mut i = 1usize;
        let id = loop {
            let cand = format!("{component}-{i}");
            if find(&self.root, &cand).is_none() {
                break cand;
            }
            i += 1;
        };
        let node = Node::instance(&id, component, x, y, w, h);
        let root_id = self.root.id.clone();
        if self.insert_node(&root_id, node) {
            Some(id)
        } else {
            None
        }
    }

    /// Detach an instance into a plain group (undoable, Figma Ctrl+Alt+B).
    pub fn detach_selected_instance(&mut self, vars: &Variables) -> bool {
        let Some(id) = self.selection.first().cloned() else {
            return false;
        };
        if let Some(id) = self.detach(&id, vars) {
            self.selection = vec![id];
            true
        } else {
            false
        }
    }

    /// Swap the selected instance's component / switch variant (undoable).
    pub fn swap_instance(&mut self, id: &str, to_component: &str) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Instance { .. }) {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        if let NodeKind::Instance { component } = &mut after.kind {
            *component = to_component.to_string();
        }
        self.push_cmds(vec![Command::ReplaceNode {
            id: id.into(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Names of all Component masters in the document.
    pub fn component_names(&self) -> Vec<String> {
        fn walk(n: &Node, out: &mut Vec<String>) {
            if let NodeKind::Component { name } = &n.kind {
                out.push(name.clone());
            }
            for c in &n.children {
                walk(c, out);
            }
        }
        let mut v = vec![];
        walk(&self.root, &mut v);
        v
    }

    /// Rename a component master (Figma rename). Updates the master's
    /// `Component { name }` AND its node id (`comp-{name}`), then rewrites
    /// every instance that references the old name, including `swap:`
    /// instance-swap overrides. Undoable. Refuses empty / unchanged / colliding
    /// names.
    /// Replace a node's full interaction list (undoable). The rich list
    /// supersedes the legacy `prototype` link, which is cleared so the two
    /// representations never disagree.
    pub fn set_node_interactions(&mut self, id: &str, list: Vec<x_core::Interaction>) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.interactions = list;
        after.prototype = None;
        self.push_cmds(vec![Command::ReplaceNode {
            id: id.to_string(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Toggle a node's "start flow here" marker (undoable).
    pub fn set_node_starting_point(&mut self, id: &str, on: bool) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if n.is_starting_point == on {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.is_starting_point = on;
        self.push_cmds(vec![Command::ReplaceNode {
            id: id.to_string(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Re-point an instance at a sibling variant of its component set
    /// (undoable; property overrides ride along unchanged).
    pub fn set_instance_component(&mut self, id: &str, component: &str) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let NodeKind::Instance { component: cur } = &n.kind else {
            return false;
        };
        if cur == component {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.kind = NodeKind::Instance {
            component: component.to_string(),
        };
        self.push_cmds(vec![Command::ReplaceNode {
            id: id.to_string(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Variant names of a "Set/Variant"-grouped component set (sorted),
    /// empty if the component is not part of a set.
    pub fn variant_siblings(&self, component: &str) -> Vec<String> {
        let Some((set, _)) = component.split_once('/') else {
            return vec![];
        };
        let prefix = format!("{set}/");
        let mut out: Vec<String> = vec![];
        fn walk(n: &Node, prefix: &str, out: &mut Vec<String>) {
            if let NodeKind::Component { name } = &n.kind {
                if let Some(v) = name.strip_prefix(prefix) {
                    if !out.iter().any(|x| x == v) {
                        out.push(v.to_string());
                    }
                }
            }
            for c in &n.children {
                walk(c, prefix, out);
            }
        }
        walk(&self.root, &prefix, &mut out);
        out.sort();
        out
    }

    pub fn rename_component(&mut self, old: &str, new: &str) -> bool {
        let new = new.trim();
        if new.is_empty() || old == new {
            return false;
        }
        if self.component_names().iter().any(|c| c == new) {
            return false;
        }
        let Some(master) = find_master(&self.root, old) else {
            return false;
        };
        let old_id = master.id.clone();
        let new_id = format!("comp-{new}");
        if find(&self.root, &new_id).is_some() {
            return false;
        }
        let before = Box::new(self.root.clone());
        let mut after = self.root.clone();
        if let Some(m) = find_mut(&mut after, &old_id) {
            if let NodeKind::Component { name } = &mut m.kind {
                *name = new.to_string();
            }
            m.id = new_id.clone();
            m.name = new_id.clone(); // master display name follows its id
        }
        fn rewrite(n: &mut Node, old: &str, new: &str) {
            if let NodeKind::Instance { component } = &mut n.kind {
                if component == old {
                    *component = new.to_string();
                }
            }
            for v in n.overrides.values_mut() {
                if let Some(OverrideValue::Swap(c)) = OverrideValue::decode(v) {
                    if c == old {
                        *v = OverrideValue::Swap(new.to_string()).encode();
                    }
                }
            }
            for c in &mut n.children {
                rewrite(c, old, new);
            }
        }
        rewrite(&mut after, old, new);
        let root_id = self.root.id.clone();
        self.push_replace(&root_id, before, after);
        true
    }

    /// Combine the selected components into one variant set: each selected
    /// instance/master's component is renamed to `{set}/{variant}` (the variant
    /// name keeps the component's original name, or its existing variant part
    /// when already a variant). Returns how many components were renamed.
    pub fn combine_as_variants(&mut self, set_name: &str) -> usize {
        let mut names: Vec<String> = vec![];
        for id in &self.selection {
            if let Some(n) = find(&self.root, id) {
                let c = match &n.kind {
                    NodeKind::Instance { component } => Some(component.clone()),
                    NodeKind::Component { name } => Some(name.clone()),
                    _ => None,
                };
                if let Some(c) = c {
                    if !names.contains(&c) {
                        names.push(c);
                    }
                }
            }
        }
        if names.len() < 2 {
            return 0;
        }
        let mut done = 0;
        for c in names {
            let variant = c
                .split_once('/')
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| c.clone());
            let new = format!("{set_name}/{variant}");
            if self.rename_component(&c, &new) {
                done += 1;
            }
        }
        done
    }

    /// Component properties defined on a component master (Figma component
    /// properties). Empty for non-component names.
    pub fn component_props(&self, component_name: &str) -> Vec<ComponentProp> {
        fn find_master<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
            if let NodeKind::Component { name: c } = &n.kind {
                if c == name {
                    return Some(n);
                }
            }
            n.children.iter().find_map(|c| find_master(c, name))
        }
        find_master(&self.root, component_name)
            .map(|m| m.props.clone())
            .unwrap_or_default()
    }

    /// Add (or replace, same name) a component property on a master (undoable).
    pub fn add_component_prop(&mut self, component_name: &str, prop: ComponentProp) -> bool {
        fn find_master<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
            if let NodeKind::Component { name: c } = &n.kind {
                if c == name {
                    return Some(n);
                }
            }
            n.children.iter().find_map(|c| find_master(c, name))
        }
        let Some(master) = find_master(&self.root, component_name) else {
            return false;
        };
        let before = Box::new(master.clone());
        let mut after = master.clone();
        match after.props.iter_mut().find(|p| p.name() == prop.name()) {
            Some(existing) => *existing = prop,
            None => after.props.push(prop),
        }
        self.push_cmds(vec![Command::ReplaceNode {
            id: master.id.clone(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Remove a component property by name from a master (undoable).
    pub fn remove_component_prop(&mut self, component_name: &str, prop_name: &str) -> bool {
        fn find_master<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
            if let NodeKind::Component { name: c } = &n.kind {
                if c == name {
                    return Some(n);
                }
            }
            n.children.iter().find_map(|c| find_master(c, name))
        }
        let Some(master) = find_master(&self.root, component_name) else {
            return false;
        };
        if !master.props.iter().any(|p| p.name() == prop_name) {
            return false;
        }
        let before = Box::new(master.clone());
        let mut after = master.clone();
        after.props.retain(|p| p.name() != prop_name);
        self.push_cmds(vec![Command::ReplaceNode {
            id: master.id.clone(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Set a component property value on an instance (undoable). Resolves the
    /// property binding from the master and applies it as a typed override.
    pub fn set_prop_value(&mut self, instance_id: &str, prop_name: &str, value: &str) -> bool {
        let Some(inst) = find(&self.root, instance_id) else {
            return false;
        };
        let NodeKind::Instance { component } = &inst.kind else {
            return false;
        };
        let component = component.clone();
        let Some(prop) = self
            .component_props(&component)
            .into_iter()
            .find(|p| p.name() == prop_name)
        else {
            return false;
        };
        let before = Box::new(inst.clone());
        let mut after = inst.clone();
        let applied = match &prop {
            ComponentProp::Text { target, .. } => {
                set_override(&mut after, target, OverrideValue::Text(value.into()));
                true
            }
            ComponentProp::Bool { target, .. } => {
                if let Ok(b) = value.parse::<bool>() {
                    set_override(&mut after, target, OverrideValue::Visible(b));
                    true
                } else {
                    false
                }
            }
            ComponentProp::Swap { target, .. } => {
                set_override(&mut after, target, OverrideValue::Swap(value.into()));
                true
            }
            ComponentProp::Number {
                target,
                target_property,
                ..
            } => {
                if let Ok(n) = value.parse::<f64>() {
                    // Apply to the specified target_property (width, height, opacity, etc.)
                    match target_property.as_str() {
                        "width" | "height" | "radius" => {
                            set_override(&mut after, target, OverrideValue::Number(n));
                        }
                        "opacity" => {
                            set_override(&mut after, target, OverrideValue::Opacity(n as f32));
                        }
                        _ => {
                            // Default to Number for backward compatibility
                            set_override(&mut after, target, OverrideValue::Number(n));
                        }
                    }
                    true
                } else {
                    false
                }
            }
            // `target_property` ("fill" or "stroke") picks the typed
            // override: a border colour must not repaint the interior.
            ComponentProp::Color {
                target,
                target_property,
                ..
            } => {
                // Parse hex color and apply it to the bound node
                if let Some(color) = parse_hex_color(value) {
                    set_override(&mut after, target, color_override(target_property, color));
                    true
                } else {
                    false
                }
            }
            // slots carry subtrees, not string values — set_slot_content
            ComponentProp::Slot { .. } => false,
        };
        if !applied {
            return false;
        }
        self.push_cmds(vec![Command::ReplaceNode {
            id: instance_id.into(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Set a component property's DEFAULT on a master (undoable). This is the
    /// variant-grid edit path: it mutates the variant's definition, not an
    /// instance override. Type-aware: Text/Swap take the raw string, Bool
    /// parses a bool, Number parses an f64.
    pub fn set_prop_default(&mut self, component_name: &str, prop_name: &str, value: &str) -> bool {
        let Some(master) = find_master(&self.root, component_name) else {
            return false;
        };
        let Some(idx) = master.props.iter().position(|p| p.name() == prop_name) else {
            return false;
        };
        let before = Box::new(master.clone());
        let mut after = master.clone();
        let ok = match &mut after.props[idx] {
            ComponentProp::Text { default, .. } => {
                *default = value.to_string();
                true
            }
            ComponentProp::Bool { default, .. } => {
                if let Ok(b) = value.parse::<bool>() {
                    *default = b;
                    true
                } else {
                    false
                }
            }
            ComponentProp::Swap { default, .. } => {
                *default = value.to_string();
                true
            }
            ComponentProp::Number { default, .. } => {
                if let Ok(n) = value.parse::<f64>() {
                    *default = n;
                    true
                } else {
                    false
                }
            }
            ComponentProp::Color { default, .. } => {
                // Parse hex color and set as default
                if let Some(color) = parse_hex_color(value) {
                    *default = color;
                    true
                } else {
                    false
                }
            }
            // slot defaults are component names, edited via the master's
            // prop panel; a plain string default edit is a no-op here
            ComponentProp::Slot { .. } => false,
        };
        if !ok {
            return false;
        }
        self.push_cmds(vec![Command::ReplaceNode {
            id: master.id.clone(),
            before,
            after: Box::new(after),
        }]);
        true
    }

    /// Add (or replace) a property on EVERY variant in a set, so all variants
    /// share the same property columns. Returns how many masters were touched.
    pub fn add_component_prop_to_set(&mut self, set: &str, prop: ComponentProp) -> usize {
        let names: Vec<String> = variants_of(&self.root, set)
            .iter()
            .map(|s| s.to_string())
            .collect();
        names
            .iter()
            .filter(|n| self.add_component_prop(n, prop.clone()))
            .count()
    }

    /// Remove a property from every variant in a set. Returns how many masters
    /// were touched.
    pub fn remove_component_prop_from_set(&mut self, set: &str, prop_name: &str) -> usize {
        let names: Vec<String> = variants_of(&self.root, set)
            .iter()
            .map(|s| s.to_string())
            .collect();
        names
            .iter()
            .filter(|n| self.remove_component_prop(n, prop_name))
            .count()
    }
    // -- Phase 2.7: copy / paste / duplicate --------------------------------
    /// Cut = copy + delete (undoable via delete_selection's command).
    pub fn cut(&mut self) {
        self.copy();
        self.delete_selection();
    }

    /// How many nodes the internal clipboard holds (UI enablement).
    pub fn clipboard_len(&self) -> usize {
        self.clipboard.len()
    }

    /// World (x, y) of the first clipboard root — used to compute the
    /// "paste over selection" offset so the copy lands exactly on the
    /// selected object's position (Figma).
    pub fn clipboard_origin(&self) -> Option<(f64, f64)> {
        self.clipboard
            .first()
            .map(|n| (n.transform.x, n.transform.y))
    }

    /// Copy the current selection into the editor clipboard.
    pub fn copy(&mut self) {
        self.clipboard = self
            .selected_roots()
            .iter()
            .filter_map(|id| find(&self.root, id).cloned())
            .collect();
    }
    /// Transferable object clipboard for the application session. Returns owned
    /// data so switching pages/documents never borrows a source editor.
    pub fn clipboard_nodes(&self) -> &[Node] {
        &self.clipboard
    }

    pub fn set_clipboard_nodes(&mut self, nodes: Vec<Node>) {
        self.clipboard = nodes;
    }

    /// Paste clipboard contents into `parent_id` (undoable). Every pasted
    /// subtree gets fresh ids ("<old>-copy", "<old>-copy-2", ...) so ids stay
    /// unique — instance overrides keyed by INTERNAL component ids still
    /// work because those live inside component definitions, not the copy.
    pub fn paste(&mut self, parent_id: &str, offset: (f64, f64)) -> Vec<String> {
        self.paste_into_each(&[(parent_id.to_string(), offset)])
    }

    /// Multi-replace (Sketch 2026.2 "Paste and Replace" across a multi
    /// selection): delete the current selection, then paste one clipboard
    /// copy into each captured `(parent, offset)` slot — a single undo
    /// step, so one ⌘Z restores every replaced layer at once.
    pub fn paste_over_each(&mut self, slots: &[(String, (f64, f64))]) -> Vec<String> {
        if self.clipboard.is_empty() || slots.is_empty() {
            return vec![];
        }
        // delete commands for the selection, back-to-front (index-safe)
        let mut del_cmds = vec![];
        let mut deleted_per_parent: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for id in self.selection.clone() {
            if let Some(p) = find_parent_mut(&mut self.root, &id) {
                if let Some(i) = p.children.iter().position(|c| c.id == id) {
                    *deleted_per_parent.entry(p.id.clone()).or_insert(0) += 1;
                    del_cmds.push(Command::Delete {
                        parent_id: p.id.clone(),
                        index: i,
                        node: p.children[i].clone(),
                    });
                }
            }
        }
        del_cmds.sort_by(|a, b| match (a, b) {
            (Command::Delete { index: ia, .. }, Command::Delete { index: ib, .. }) => ib.cmp(ia),
            _ => std::cmp::Ordering::Equal,
        });

        let mut taken = std::collections::HashSet::new();
        collect_ids(&self.root, &mut taken);

        let mut new_root_ids = vec![];
        let mut ins_cmds = vec![];
        for (parent_id, offset) in slots {
            for node in self.clipboard.clone() {
                let mut copy = node;
                let mut roots = vec![];
                remap_ids(
                    &mut copy,
                    &mut |old| next_copy_id(&mut taken, old),
                    &mut roots,
                );
                if let Some(rid) = roots.first() {
                    new_root_ids.push(rid.clone());
                }
                copy.transform.x += offset.0;
                copy.transform.y += offset.1;
                // insert indexes are applied AFTER the deletes above, so
                // subtract this parent's deletions from its pre-count
                let pre = find(&self.root, parent_id)
                    .map(|p| p.children.len())
                    .unwrap_or(0);
                let dels = deleted_per_parent.get(parent_id).copied().unwrap_or(0);
                ins_cmds.push(Command::Insert {
                    parent_id: parent_id.clone(),
                    index: pre.saturating_sub(dels),
                    node: copy,
                });
            }
        }
        del_cmds.extend(ins_cmds);
        self.push(del_cmds);
        self.selection.clear();
        new_root_ids
    }

    /// Multi-paste (Sketch 2026.2): paste the clipboard into EVERY target
    /// in one undoable step. Each target is `(parent id, offset)`; every
    /// copy gets fresh ids exactly like [`Editor::paste`].
    pub fn paste_into_each(&mut self, targets: &[(String, (f64, f64))]) -> Vec<String> {
        if self.clipboard.is_empty() || targets.is_empty() {
            return vec![];
        }
        // Collect every id already in the document once, then allocate
        // unique "-copy" ids against that set (no repeated tree scans).
        let mut taken = std::collections::HashSet::new();
        collect_ids(&self.root, &mut taken);

        let mut new_root_ids = vec![];
        let mut cmds = vec![];
        for (parent_id, offset) in targets {
            for node in self.clipboard.clone() {
                let mut copy = node;
                let mut roots = vec![];
                remap_ids(
                    &mut copy,
                    &mut |old| next_copy_id(&mut taken, old),
                    &mut roots,
                );
                if let Some(rid) = roots.first() {
                    new_root_ids.push(rid.clone());
                }
                copy.transform.x += offset.0;
                copy.transform.y += offset.1;
                let index = find(&self.root, parent_id)
                    .map(|p| p.children.len())
                    .unwrap_or(0);
                cmds.push(Command::Insert {
                    parent_id: parent_id.clone(),
                    index,
                    node: copy,
                });
            }
        }
        self.push(cmds);
        new_root_ids
    }
    /// Duplicate = copy + paste-in-place with a small offset, one call.
    pub fn duplicate_selection(&mut self, offset: (f64, f64)) -> Vec<String> {
        self.copy();
        let parent = self
            .selection
            .first()
            .and_then(|id| find_parent_mut(&mut self.root, id).map(|p| p.id.clone()))
            .unwrap_or_else(|| self.root.id.clone());
        let ids = self.paste(&parent, offset);
        self.selection = ids.clone();
        ids
    }

    // -- Phase P0: Paste variants -------------------------------------------
    /// Paste at exact same world coordinates (paste in place)
    pub fn paste_in_place(&mut self, parent_id: &str) -> Vec<String> {
        self.paste_into_each(&[(parent_id.to_string(), (0.0, 0.0))])
    }

    /// Paste over current selection, replacing it
    pub fn paste_over_selection(&mut self, parent_id: &str) -> Vec<String> {
        self.delete_selection();
        self.paste_in_place(parent_id)
    }
    // -- Phase P0: Text editing ---------------------------------------------
    /// Start editing text node at given id
    pub fn start_text_edit(&mut self, node_id: &str) -> bool {
        if let Some(node) = find(&self.root, node_id) {
            if matches!(node.kind, NodeKind::Text { .. }) {
                self.text_edit_mode = Some(TextEditState {
                    node_id: node_id.to_string(),
                    selection_start: 0,
                    selection_end: 0,
                    cursor_visible: true,
                });
                return true;
            }
        }
        false
    }

    /// Update text selection range
    pub fn update_text_selection(&mut self, start: usize, end: usize) {
        if let Some(state) = &mut self.text_edit_mode {
            state.selection_start = start;
            state.selection_end = end;
        }
    }

    /// Insert text at current cursor position
    pub fn insert_text(&mut self, text: &str) {
        if let Some(state) = &self.text_edit_mode {
            let node_id = state.node_id.clone();
            let start = state.selection_start;
            let end = state.selection_end;
            if let Some(node) = find_mut(&mut self.root, &node_id) {
                if let NodeKind::Text { text: current } = &mut node.kind {
                    current.replace_range(start..end, text);
                    // editing text invalidates rich-run char ranges
                    node.text_runs.clear();
                    // Update selection to end of inserted text
                    if let Some(state) = &mut self.text_edit_mode {
                        state.selection_start = start + text.len();
                        state.selection_end = state.selection_start;
                    }
                }
            }
        }
    }

    /// Exit text edit mode
    pub fn exit_text_edit(&mut self) {
        self.text_edit_mode = None;
    }

    // -- Phase P0: Corner radius handles ------------------------------------
    /// Start dragging a corner handle to adjust radius
    pub fn start_corner_drag(&mut self, node_id: &str, corner: Corner) -> bool {
        if let Some(node) = find(&self.root, node_id) {
            if let NodeKind::Rect { radius } = node.kind {
                self.corner_drag_state = Some(CornerDragState {
                    node_id: node_id.to_string(),
                    corner,
                    initial_radius: radius,
                    initial_mouse_pos: (0.0, 0.0), // Will be set by caller
                });
                return true;
            }
        }
        false
    }

    /// Update corner drag with mouse delta
    pub fn update_corner_drag(&mut self, mouse_delta_x: f64) {
        if let Some(state) = &mut self.corner_drag_state {
            if let Some(node) = find_mut(&mut self.root, &state.node_id) {
                if let NodeKind::Rect { radius } = &mut node.kind {
                    let delta =
                        if state.corner == Corner::TopLeft || state.corner == Corner::BottomLeft {
                            mouse_delta_x
                        } else {
                            -mouse_delta_x
                        };
                    let max_radius = (node.w.min(node.h) / 2.0).max(0.0);
                    *radius = (state.initial_radius + delta).max(0.0).min(max_radius);
                }
            }
        }
    }

    /// End corner drag
    pub fn end_corner_drag(&mut self) {
        self.corner_drag_state = None;
    }

    // -- Phase 10.2: checkpoints -------------------------------------------
    pub fn checkpoint(&mut self, name: &str) {
        self.checkpoints.push((name.into(), self.root.clone()));
    }
    pub fn restore_checkpoint(&mut self, name: &str) -> bool {
        if let Some((_, snap)) = self.checkpoints.iter().find(|(n, _)| n == name) {
            self.root = snap.clone();
            self.undo_stack.clear();
            self.clear_redo_history();
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Vector edit mode (Figma: Enter / double-click a vector layer to edit points)
//
// The mode is three fields on `Editor` — `vector_edit_active`,
// `vector_edit_node`, `vector_edit_selected_points`. Everything that CHANGES a
// path lives in `vector_edit`, where it goes through the command log, so this
// block only holds the mode's state transitions plus the id/selection shaped
// wrappers the app dispatches. Nothing here mutates the tree behind the undo
// stack's back: an operation either pushes exactly one undo entry or pushes
// nothing at all.
// ---------------------------------------------------------------------------

impl Editor {
    /// Enter vector edit mode on a vector node. Refuses anything that is not a
    /// `Vector` node — a frame or a rect has no anchors to edit — and always
    /// starts with no anchors selected, matching Figma (entering node edit mode
    /// selects nothing until you click or marquee).
    pub fn enter_vector_edit_mode(&mut self, node_id: &str) -> bool {
        let Some(node) = find(&self.root, node_id) else {
            return false;
        };
        if !matches!(node.kind, NodeKind::Vector { .. }) {
            return false;
        }
        self.vector_edit_active = true;
        self.vector_edit_node = Some(node_id.to_string());
        self.vector_edit_selected_points.clear();
        self.tool_state.vector_edit_active = true;
        true
    }

    /// Leave vector edit mode, dropping the anchor selection. The path itself is
    /// already committed — every edit pushed its own undo entry as it happened,
    /// so exiting never discards or commits work.
    pub fn exit_vector_edit_mode(&mut self) {
        self.vector_edit_active = false;
        self.vector_edit_node = None;
        self.vector_edit_selected_points.clear();
        self.tool_state.vector_edit_active = false;
    }

    /// Select an anchor by index (`additive` = Shift-click: add to the selection
    /// instead of replacing it). Out-of-range indices are refused — a stale index
    /// from a previous edit must never select a different point — and
    /// re-selecting an already-selected point does not duplicate it.
    pub fn select_vector_point(&mut self, point_idx: usize, additive: bool) -> bool {
        let Some(node_id) = self.vector_edit_node.clone() else {
            return false;
        };
        let Some(node) = find(&self.root, &node_id) else {
            return false;
        };
        let NodeKind::Vector { path } = &node.kind else {
            return false;
        };
        if point_idx >= crate::vector_edit::anchors(path).len() {
            return false;
        }
        if !additive {
            self.vector_edit_selected_points.clear();
        }
        if !self.vector_edit_selected_points.contains(&point_idx) {
            self.vector_edit_selected_points.push(point_idx);
            // keep the selection ordered by anchor index: every batch path
            // operation walks it, and a stable order keeps undo deterministic
            self.vector_edit_selected_points.sort_unstable();
        }
        true
    }

    /// Deselect every anchor (Figma: click empty canvas inside node edit mode).
    pub fn deselect_vector_points(&mut self) {
        self.vector_edit_selected_points.clear();
    }

    /// The node whose anchors are being edited, if any. Callers that need the
    /// anchors themselves go through `vector_handles::anchors_world_of`, which
    /// maps them into the world space the canvas draws in.
    pub fn vector_edit_target(&self) -> Option<&str> {
        if self.vector_edit_active {
            self.vector_edit_node.as_deref()
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Stroke caps (Figma: the two cap dropdowns in the Stroke panel)
// ---------------------------------------------------------------------------

impl Editor {
    /// Set the cap on the START of a path (Figma's per-end cap dropdowns: an
    /// arrow at one end and nothing at the other is the common case).
    ///
    /// A node with no stroke layers yet gets one seeded from its simple `stroke`,
    /// which is how the rest of the engine reads per-end options. Undoable, and a
    /// no-op (already that cap) pushes nothing.
    pub fn set_stroke_cap_start(&mut self, node_id: &str, cap: StrokeCap) -> bool {
        self.set_stroke_cap(node_id, true, cap)
    }

    /// Set the cap on the END of a path. Same contract as
    /// [`Editor::set_stroke_cap_start`].
    pub fn set_stroke_cap_end(&mut self, node_id: &str, cap: StrokeCap) -> bool {
        self.set_stroke_cap(node_id, false, cap)
    }

    /// Shared body of the two cap setters: `start` picks which end.
    fn set_stroke_cap(&mut self, node_id: &str, start: bool, cap: StrokeCap) -> bool {
        let Some(node) = find(&self.root, node_id) else {
            return false;
        };
        // refuse the no-op BEFORE cloning, so it never reaches the undo stack
        if node.stroke_layers.first().map(|l| {
            if start {
                l.options.cap_start
            } else {
                l.options.cap_end
            }
        }) == Some(cap)
        {
            return false;
        }
        let before = Box::new(node.clone());
        let mut after = node.clone();
        if after.stroke_layers.is_empty() {
            let seed = after.stroke.clone();
            after.stroke_layers.push(StrokeLayer::new(seed));
        }
        let Some(layer) = after.stroke_layers.first_mut() else {
            return false;
        };
        if start {
            layer.options.cap_start = cap;
        } else {
            layer.options.cap_end = cap;
        }
        self.push_replace(node_id, before, after);
        true
    }
}

// ---------------------------------------------------------------------------
// Node-level vector operations the app dispatches (Figma: Object / Edit object)
//
// Thin, honest wrappers. The geometry lives in `vector_edit` (path rewrites) and
// `booleans` (outline stroke, flatten), both of which go through the command log;
// what these add is the app-facing shape — an id or the current selection in, a
// bool or an `Option<String>` out — and a refusal that never touches undo.
// ---------------------------------------------------------------------------

impl Editor {
    /// Outline Stroke (Figma: ⌥⌘O on a stroked shape): replace the node with its
    /// stroke's outline as a filled vector path. Delegates to
    /// [`Editor::outline_stroke_node`], the id-addressable entry point that the
    /// canvas menu and vector edit mode share.
    pub fn outline_stroke(&mut self, node_id: &str) -> bool {
        self.outline_stroke_node(node_id).is_some()
    }

    /// Apply `f` to a snapshot of the whole tree and commit it as ONE undo step
    /// — the batch counterpart of [`Editor::mutate_visual_stack`], for the
    /// gestures that touch several nodes at once (bulk rename, paste properties,
    /// apply-to-all).
    ///
    /// `f` walks the mutable copy with `find_mut` and returns how many nodes it
    /// changed; ZERO pushes nothing, so a batch that matched nothing never adds
    /// an Undo entry. Reach for this instead of looping `get_node_mut`, which
    /// writes behind the command log's back and leaves the gesture un-undoable.
    pub fn edit_batch(&mut self, f: impl FnOnce(&mut Node) -> usize) -> bool {
        let before = Box::new(self.root.clone());
        let mut after = self.root.clone();
        let changed = f(&mut after);
        if changed == 0 {
            return false;
        }
        let root_id = self.root.id.clone();
        self.push_replace(&root_id, before, after);
        true
    }
}

/// Shape signature for Select Similar: node kind + fill + stroke.
type Sig = (std::mem::Discriminant<NodeKind>, String, String, f64);

fn shape_signature(n: &Node) -> Sig {
    (
        std::mem::discriminant(&n.kind),
        format!("{:?}", n.fill),
        format!("{:?}", n.stroke.paint),
        n.stroke.width,
    )
}

// Layer management methods (Figma parity)

impl Editor {
    /// Get all selectable node IDs in the document
    pub fn get_all_selectable_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        fn collect_ids(node: &Node, ids: &mut Vec<String>) {
            ids.push(node.id.clone());
            for child in &node.children {
                collect_ids(child, ids);
            }
        }
        collect_ids(&self.root, &mut ids);
        ids
    }

    /// Figma's "matching objects": the SAME layer — by name and by its place in
    /// the structure — as it exists in the other frames and groups of the same
    /// scope. "Matching objects are identical layers that exist across more than
    /// one frame or group", and identity is a name, not a size: a search bar that
    /// was resized in one frame still matches. (This used to compare kind, child
    /// count and dimensions, which matched any two same-sized frames and missed
    /// the matching layer in a frame that had been resized.)
    ///
    /// Scope follows Figma as well: a layer inside a **Section** only matches
    /// layers in that section ("Objects with sections can only match with other
    /// objects in that section"), otherwise it matches across the page's
    /// top-level frames and groups. The template itself is included, so the
    /// selection is never empty for a layer that has a container to match in; a
    /// top-level layer (nothing to match within) returns itself alone.
    ///
    /// Names are the identity, so the first name+kind match at each step of the
    /// path wins when one container holds two layers with the same name.
    pub fn find_matching_nodes<'a>(&'a self, template: &'a Node) -> Vec<&'a Node> {
        /// The chain of nodes from the root down to `id`, inclusive.
        fn chain_to<'a>(node: &'a Node, id: &str, out: &mut Vec<&'a Node>) -> bool {
            if node.id == id {
                out.push(node);
                return true;
            }
            for child in &node.children {
                if chain_to(child, id, out) {
                    out.push(node);
                    return true;
                }
            }
            false
        }
        /// The first child matching each `(name, kind)` step, then one level down.
        fn resolve<'a>(
            container: &'a Node,
            path: &[(&str, std::mem::Discriminant<NodeKind>)],
        ) -> Option<&'a Node> {
            let mut cursor = container;
            for (name, kind) in path {
                cursor = cursor
                    .children
                    .iter()
                    .find(|c| c.name == *name && std::mem::discriminant(&c.kind) == *kind)?;
            }
            Some(cursor)
        }

        let mut chain = Vec::new();
        if !chain_to(&self.root, &template.id, &mut chain) {
            return Vec::new();
        }
        chain.reverse(); // root .. template
        if chain.len() < 3 {
            // a top-level layer: Figma asks for "an object inside a frame or
            // group", and a page's own objects have nothing to match across
            return vec![template];
        }
        // The template's container, and the section that scopes the match: each
        // Section on the chain moves the container one level down, to the
        // section's own child that holds the template.
        let mut own_from = 1;
        let mut section: Option<&Node> = None;
        for (i, node) in chain.iter().take(chain.len() - 1).enumerate() {
            if matches!(node.kind, NodeKind::Section) {
                own_from = i + 1;
                section = Some(*node);
            }
        }
        // Figma's precondition, verbatim: "Select an object inside a frame or
        // group." A page's top-level layer, or a frame sitting directly in a
        // Section, has no container to be matched across, and an empty relative
        // path would otherwise make every container a "match".
        let parent = chain[chain.len() - 2];
        if !matches!(parent.kind, NodeKind::Frame { .. } | NodeKind::Group) {
            return vec![template];
        }
        let own_container = chain[own_from];
        let path: Vec<(&str, std::mem::Discriminant<NodeKind>)> = chain[own_from + 1..]
            .iter()
            .map(|n| (n.name.as_str(), std::mem::discriminant(&n.kind)))
            .collect();
        let containers: &[Node] = match section {
            Some(s) => &s.children,
            None => &self.root.children,
        };
        let mut matches = vec![template];
        for container in containers {
            if container.id == own_container.id {
                continue;
            }
            if !matches!(container.kind, NodeKind::Frame { .. } | NodeKind::Group) {
                continue;
            }
            if let Some(found) = resolve(container, &path) {
                matches.push(found);
            }
        }
        matches
    }

    /// Get a shared reference to a node by ID
    pub fn get_node(&self, id: &str) -> Option<&Node> {
        fn find_node<'n>(node: &'n Node, id: &str) -> Option<&'n Node> {
            if node.id == id {
                return Some(node);
            }
            for child in &node.children {
                if let Some(found) = find_node(child, id) {
                    return Some(found);
                }
            }
            None
        }
        find_node(&self.root, id)
    }

    /// Get a mutable reference to a node by ID
    pub fn get_node_mut(&mut self, id: &str) -> Option<&mut Node> {
        fn find_node_mut<'a>(node: &'a mut Node, id: &str) -> Option<&'a mut Node> {
            if node.id == id {
                return Some(node);
            }
            for child in &mut node.children {
                if let Some(found) = find_node_mut(child, id) {
                    return Some(found);
                }
            }
            None
        }
        find_node_mut(&mut self.root, id)
    }

    /// Get the parent ID of a node
    pub fn get_parent_id(&self, id: &str) -> Option<String> {
        fn find_parent(node: &Node, id: &str) -> Option<String> {
            for child in &node.children {
                if child.id == id {
                    return Some(node.id.clone());
                }
                if let Some(parent_id) = find_parent(child, id) {
                    return Some(parent_id);
                }
            }
            None
        }
        find_parent(&self.root, id)
    }

    /// Get the next sibling ID of a node
    pub fn get_next_sibling_id(&self, id: &str) -> Option<String> {
        fn find_next_sibling(node: &Node, id: &str) -> Option<String> {
            for (i, child) in node.children.iter().enumerate() {
                if child.id == id && i + 1 < node.children.len() {
                    return Some(node.children[i + 1].id.clone());
                }
                if let Some(next_id) = find_next_sibling(child, id) {
                    return Some(next_id);
                }
            }
            None
        }
        find_next_sibling(&self.root, id)
    }

    /// Get the previous sibling ID of a node
    pub fn get_prev_sibling_id(&self, id: &str) -> Option<String> {
        fn find_prev_sibling(node: &Node, id: &str) -> Option<String> {
            for (i, child) in node.children.iter().enumerate() {
                if child.id == id && i > 0 {
                    return Some(node.children[i - 1].id.clone());
                }
                if let Some(prev_id) = find_prev_sibling(child, id) {
                    return Some(prev_id);
                }
            }
            None
        }
        find_prev_sibling(&self.root, id)
    }
}

#[cfg(test)]
mod reliability_history_tests {
    use super::*;
    #[test]
    fn a_new_edit_releases_abandoned_structural_redo_snapshots() {
        let mut editor = Editor::new(
            Node::frame("p", 100.0, 100.0)
                .child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::WHITE))
                .child(Node::rect("b", 20.0, 0.0, 10.0, 10.0, Color::WHITE)),
        );
        editor.selection = vec!["a".into(), "b".into()];
        editor.group_selection("g");
        assert!(editor.undo());
        assert!(editor.snapshots.iter().any(|(d, _)| *d == usize::MAX));
        editor.move_node("a", 1.0, 0.0);
        assert!(editor.snapshots.iter().all(|(d, _)| *d != usize::MAX));
        assert!(!editor.redo());
    }

    fn ids_of(node: &Node) -> Vec<&str> {
        node.children.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn reorder_node_moves_within_a_parent_with_undo_redo() {
        let mut ed = Editor::new(Node::frame("p", 100.0, 100.0));
        let root_id = ed.root.id.clone();
        ed.insert_node(
            &root_id,
            Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::WHITE),
        );
        ed.insert_node(
            &root_id,
            Node::rect("b", 20.0, 0.0, 10.0, 10.0, Color::WHITE),
        );
        ed.insert_node(
            &root_id,
            Node::rect("c", 30.0, 0.0, 10.0, 10.0, Color::WHITE),
        );
        // "after b" (b's slot + 1) -> [b, a, c]
        assert!(ed.reorder_node("a", &root_id, 0, &root_id, 2));
        assert_eq!(ids_of(&ed.root), vec!["b", "a", "c"]);
        assert!(ed.undo());
        assert_eq!(ids_of(&ed.root), vec!["a", "b", "c"]);
        assert!(ed.redo());
        assert_eq!(ids_of(&ed.root), vec!["b", "a", "c"]);
        // "to the front" -> [a, b, c]
        assert!(ed.reorder_node("a", &root_id, 1, &root_id, 0));
        assert_eq!(ids_of(&ed.root), vec!["a", "b", "c"]);
        // "before b" from the end -> [a, c, b]
        assert!(ed.reorder_node("c", &root_id, 2, &root_id, 1));
        assert_eq!(ids_of(&ed.root), vec!["a", "c", "b"]);
    }

    #[test]
    fn reorder_node_reparents_with_undo() {
        let mut ed = Editor::new(Node::frame("p", 100.0, 100.0));
        let root_id = ed.root.id.clone();
        ed.insert_node(&root_id, Node::frame("fr", 100.0, 100.0));
        ed.insert_node("fr", Node::rect("in", 0.0, 0.0, 10.0, 10.0, Color::WHITE));
        ed.insert_node(&root_id, Node::frame("fr2", 100.0, 100.0));
        // in (first child of fr) -> first child of fr2
        assert!(ed.reorder_node("in", "fr", 0, "fr2", 0));
        assert!(ed
            .get_node("fr2")
            .unwrap()
            .children
            .iter()
            .any(|c| c.id == "in"));
        assert!(ed.get_node("fr").unwrap().children.is_empty());
        assert!(ed.undo());
        assert!(ed
            .get_node("fr")
            .unwrap()
            .children
            .iter()
            .any(|c| c.id == "in"));
        assert!(ed.get_node("fr2").unwrap().children.is_empty());
    }

    #[test]
    fn reorder_node_rejects_invalid_and_noops() {
        let mut ed = Editor::new(Node::frame("p", 100.0, 100.0));
        let root_id = ed.root.id.clone();
        ed.insert_node(&root_id, Node::frame("fr", 100.0, 100.0));
        ed.insert_node("fr", Node::rect("in", 0.0, 0.0, 10.0, 10.0, Color::WHITE));
        ed.insert_node(&root_id, Node::frame("fr2", 100.0, 100.0));
        // cycle: fr into its own descendant
        assert!(!ed.reorder_node("fr", &root_id, 0, "in", 0));
        // self as target
        assert!(!ed.reorder_node("fr", &root_id, 0, "fr", 0));
        // the root cannot move
        assert!(!ed.reorder_node(&root_id, "fr", 0, "fr2", 0));
        // no-op: same slot
        assert!(!ed.reorder_node("fr2", &root_id, 1, &root_id, 1));
        // same slot via adjacent insert (slot 0 -> slot 1 == same place)
        assert!(!ed.reorder_node("fr", &root_id, 0, &root_id, 1));
        // unknown ids
        assert!(!ed.reorder_node("nope", &root_id, 0, &root_id, 0));
        assert!(!ed.reorder_node("fr2", &root_id, 1, "ghost", 0));
        // no reorder was recorded: undo pops the last setup INSERT,
        // not a reorder
        assert!(ed.undo());
        assert!(ed.get_node("fr2").is_none());
        assert!(ed.get_node("fr").is_some());
        assert_eq!(ids_of(&ed.root), vec!["fr"]);
    }
}
