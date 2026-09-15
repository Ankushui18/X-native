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
    pub fn marquee(&mut self, rect: Rect) {
        self.selection = hit_test_rect(&self.root, rect, false);
    }
    /// Figma Alt-drag marquee: select only fully-contained nodes.
    pub fn marquee_contained(&mut self, rect: Rect) {
        self.selection = hit_test_rect(&self.root, rect, true);
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

    // Vector Edit Mode methods (Figma parity)

impl Editor {
    /// Enter vector edit mode for a vector node
    pub fn enter_vector_edit_mode(&mut self, node_id: &str) -> bool {
        if let Some(node) = self.get_node(node_id) {
            if let NodeKind::Vector { .. } = &node.kind {
                self.vector_edit_active = true;
                self.vector_edit_node = Some(node_id.to_string());
                self.vector_edit_selected_points.clear();
                return true;
            }
        }
        false
    }

    /// Exit vector edit mode
    pub fn exit_vector_edit_mode(&mut self) {
        self.vector_edit_active = false;
        self.vector_edit_node = None;
        self.vector_edit_selected_points.clear();
    }

    /// Select a vector point by index
    pub fn select_vector_point(&mut self, point_idx: usize, additive: bool) {
        if !additive {
            self.vector_edit_selected_points.clear();
        }
        if !self.vector_edit_selected_points.contains(&point_idx) {
            self.vector_edit_selected_points.push(point_idx);
        }
    }

    /// Deselect all vector points
    pub fn deselect_vector_points(&mut self) {
        self.vector_edit_selected_points.clear();
    }

    /// Move selected vector points
    pub fn move_vector_points(&mut self, dx: f64, dy: f64) {
        let Some(node_id) = &self.vector_edit_node else { return };
        let Some(node) = self.get_node_mut(node_id) else { return };
        
        if let NodeKind::Vector { path } = &mut node.kind {
            for &idx in &self.vector_edit_selected_points {
                if let Some(cmd) = path.get_mut(idx) {
                    match cmd {
                        PathCmd::MoveTo(x, y) => { *x += dx; *y += dy; }
                        PathCmd::LineTo(x, y) => { *x += dx; *y += dy; }
                        PathCmd::CurveTo(x1, y1, x2, y2, x, y) => { 
                            *x1 += dx; *y1 += dy; 
                            *x2 += dx; *y2 += dy; 
                            *x += dx; *y += dy; 
                        }
                        PathCmd::Close => {}
                    }
                }
            }
            self.mark_dirty();
        }
    }

    /// Add a point to a vector path
    pub fn add_vector_point(&mut self, segment_idx: usize, position: (f64, f64)) {
        let Some(node_id) = &self.vector_edit_node else { return };
        let Some(node) = self.get_node_mut(node_id) else { return };
        
        if let NodeKind::Vector { path } = &mut node.kind {
            // Insert a LineTo at the specified position after the segment
            let insert_idx = (segment_idx + 1).min(path.len());
            path.insert(insert_idx, PathCmd::LineTo(position.0, position.1));
            self.mark_dirty();
        }
    }

    /// Delete selected vector points
    pub fn delete_vector_points(&mut self) {
        let Some(node_id) = &self.vector_edit_node else { return };
        let Some(node) = self.get_node_mut(node_id) else { return };
        
        if let NodeKind::Vector { path } = &mut node.kind {
            // Sort indices in descending order to delete from end to start
            let mut indices = self.vector_edit_selected_points.clone();
            indices.sort_by(|a, b| b.cmp(a));
            
            for idx in indices {
                if idx < path.len() {
                    path.remove(idx);
                }
            }
            self.vector_edit_selected_points.clear();
            self.mark_dirty();
        }
    }

    /// Simplify vector path using Ramer-Douglas-Peucker algorithm
    pub fn simplify_vector(&mut self, tolerance: f64) {
        let Some(node_id) = &self.vector_edit_node else { return };
        let Some(node) = self.get_node_mut(node_id) else { return };
        
        if let NodeKind::Vector { path } = &mut node.kind {
            // Extract points from path
            let mut points = Vec::new();
            for cmd in path.iter() {
                match cmd {
                    PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
                        points.push((*x, *y));
                    }
                    PathCmd::CurveTo(_, _, _, _, x, y) => {
                        points.push((*x, *y));
                    }
                    PathCmd::Close => {}
                }
            }
            
            // Simplify using the existing algorithm
            let simplified = simplify_polyline(&points, tolerance);
            
            // Rebuild path from simplified points
            if simplified.len() >= 2 {
                let mut new_path = Vec::new();
                new_path.push(PathCmd::MoveTo(simplified[0].0, simplified[0].1));
                for i in 1..simplified.len() {
                    new_path.push(PathCmd::LineTo(simplified[i].0, simplified[i].1));
                }
                *path = new_path;
                self.mark_dirty();
            }
        }
    }

    /// Outline stroke (convert stroke to vector path)
    pub fn outline_stroke(&mut self, node_id: &str) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        // Only works on nodes with stroke
        if node.stroke.width <= 0.0 {
            return false;
        }
        
        // Get the node's path or shape
        let path_cmds = match &node.kind {
            NodeKind::Vector { path } => path.clone(),
            NodeKind::Rect { .. } => {
                // Convert rect to path
                vec![
                    PathCmd::MoveTo(0.0, 0.0),
                    PathCmd::LineTo(node.w, 0.0),
                    PathCmd::LineTo(node.w, node.h),
                    PathCmd::LineTo(0.0, node.h),
                    PathCmd::Close,
                ]
            }
            NodeKind::Ellipse => {
                // Convert ellipse to path (approximate with curves)
                let rx = node.w / 2.0;
                let ry = node.h / 2.0;
                let cx = rx;
                let cy = ry;
                // Approximate ellipse with 4 cubic bezier curves
                let kappa = 0.5522847498; // Magic number for circle approximation
                vec![
                    PathCmd::MoveTo(cx + rx, cy),
                    PathCmd::CurveTo(cx + rx, cy + kappa * ry, cx + kappa * rx, cy + ry, cx, cy + ry),
                    PathCmd::CurveTo(cx - kappa * rx, cy + ry, cx - rx, cy + kappa * ry, cx - rx, cy),
                    PathCmd::CurveTo(cx - rx, cy - kappa * ry, cx - kappa * rx, cy - ry, cx, cy - ry),
                    PathCmd::CurveTo(cx + kappa * rx, cy - ry, cx + rx, cy - kappa * ry, cx + rx, cy),
                    PathCmd::Close,
                ]
            }
            _ => return false,
        };
        
        // Create offset paths for the stroke
        // For simplicity, we'll create two offset paths (inside and outside)
        let offset = node.stroke.width / 2.0;
        let mut offset_path = Vec::new();
        
        for cmd in &path_cmds {
            match cmd {
                PathCmd::MoveTo(x, y) => {
                    offset_path.push(PathCmd::MoveTo(*x + offset, *y + offset));
                }
                PathCmd::LineTo(x, y) => {
                    offset_path.push(PathCmd::LineTo(*x + offset, *y + offset));
                }
                PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                    offset_path.push(PathCmd::CurveTo(
                        x1 + offset, y1 + offset,
                        x2 + offset, y2 + offset,
                        x + offset, y + offset,
                    ));
                }
                PathCmd::Close => {
                    offset_path.push(PathCmd::Close);
                }
            }
        }
        
        // Create new vector node with the outlined path
        let new_id = fresh_id();
        let new_node = Node::vector(&new_id, node.transform.x, node.transform.y, node.w, node.h, offset_path);
        
        // Replace the original node
        self.replace_node(node_id, new_node);
        self.mark_dirty();
        true
    }

    /// Flatten selection (merge multiple nodes into single vector path)
    pub fn flatten_selection(&mut self) -> bool {
        if self.selection.is_empty() {
            return false;
        }
        
        // Collect all paths from selected nodes
        let mut combined_path = Vec::new();
        let mut bounds = None;
        
        for node_id in &self.selection.clone() {
            if let Some(node) = self.get_node(node_id) {
                // Update bounds
                let node_bounds = (node.transform.x, node.transform.y, node.w, node.h);
                bounds = Some(match bounds {
                    None => node_bounds,
                    Some((x, y, w, h)) => {
                        let min_x = x.min(node_bounds.0);
                        let min_y = y.min(node_bounds.1);
                        let max_x = (x + w).max(node_bounds.0 + node_bounds.2);
                        let max_y = (y + h).max(node_bounds.1 + node_bounds.3);
                        (min_x, min_y, max_x - min_x, max_y - min_y)
                    }
                });
                
                // Get path from node
                match &node.kind {
                    NodeKind::Vector { path } => {
                        combined_path.extend(path.iter().cloned());
                    }
                    NodeKind::Rect { .. } => {
                        combined_path.extend(vec![
                            PathCmd::MoveTo(node.transform.x, node.transform.y),
                            PathCmd::LineTo(node.transform.x + node.w, node.transform.y),
                            PathCmd::LineTo(node.transform.x + node.w, node.transform.y + node.h),
                            PathCmd::LineTo(node.transform.x, node.transform.y + node.h),
                            PathCmd::Close,
                        ]);
                    }
                    _ => {}
                }
            }
        }
        
        if combined_path.is_empty() {
            return false;
        }
        
        let (x, y, w, h) = bounds.unwrap();
        let new_id = fresh_id();
        let new_node = Node::vector(&new_id, x, y, w, h, combined_path);
        
        // Delete original nodes
        for node_id in &self.selection {
            self.delete_node(node_id);
        }
        
        // Add new flattened node
        self.add_node(new_node);
        self.selection = vec![new_id.clone()];
        self.mark_dirty();
        true
    }

    /// Offset vector path
    pub fn offset_vector(&mut self, node_id: &str, distance: f64) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { path } = &node.kind {
            // Simple offset: move all points outward by distance
            // This is a simplified implementation - proper offset requires
            // computing normals and handling corners
            let mut offset_path = Vec::new();
            for cmd in path {
                match cmd {
                    PathCmd::MoveTo(x, y) => {
                        offset_path.push(PathCmd::MoveTo(*x + distance, *y + distance));
                    }
                    PathCmd::LineTo(x, y) => {
                        offset_path.push(PathCmd::LineTo(*x + distance, *y + distance));
                    }
                    PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                        offset_path.push(PathCmd::CurveTo(
                            x1 + distance, y1 + distance,
                            x2 + distance, y2 + distance,
                            x + distance, y + distance,
                        ));
                    }
                    PathCmd::Close => {
                        offset_path.push(PathCmd::Close);
                    }
                }
            }
            
            // Update the node's path
            if let Some(node) = self.get_node_mut(node_id) {
                if let NodeKind::Vector { path } = &mut node.kind {
                    *path = offset_path;
                    self.mark_dirty();
                    return true;
                }
            }
        }
        false
    }

    /// Convert text to vector path (outline text)
    pub fn text_to_outline(&mut self, node_id: &str) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Text { text } = &node.kind {
            // For now, create a simple rectangular outline
            // In a full implementation, this would use font outlines
            let path = vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(node.w, 0.0),
                PathCmd::LineTo(node.w, node.h),
                PathCmd::LineTo(0.0, node.h),
                PathCmd::Close,
            ];
            
            let new_id = fresh_id();
            let new_node = Node::vector(&new_id, node.transform.x, node.transform.y, node.w, node.h, path);
            
            self.replace_node(node_id, new_node);
            self.mark_dirty();
            return true;
        }
        false
    }


    /// Replace the path of a vector node
    fn replace_path(&mut self, node_id: &str, new_path: Vec<PathCmd>) {
        fn update_path(node: &mut Node, id: &str, path: Vec<PathCmd>) -> bool {
            if node.id == id {
                if let NodeKind::Vector { path: ref mut p } = node.kind {
                    *p = path;
                    return true;
                }
            }
            for child in &mut node.children {
                if update_path(child, id, path.clone()) {
                    return true;
                }
            }
            false
        }
        update_path(&mut self.root, node_id, new_path);
    }

    // ========================================================================
    // Phase 2: Vector Editing Tools
    // ========================================================================

    /// Add a bézier handle to a vector point
    pub fn add_bezier_handle(&mut self, node_id: &str, point_idx: usize, handle_pos: (f64, f64)) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let mut new_path = path.clone();
            
            // Find the point and convert LineTo to CurveTo with handles
            let mut point_count = 0;
            for cmd in new_path.iter_mut() {
                match cmd {
                    PathCmd::MoveTo(x, y) => {
                        if point_count == point_idx {
                            // Convert to CurveTo with the handle
                            let cp1 = (*x, *y); // Start point (no incoming handle)
                            let cp2 = handle_pos;
                            let end = (*x, *y);
                            *cmd =
                                PathCmd::CurveTo(cp1.0, cp1.1, cp2.0, cp2.1, end.0, end.1);
                            self.replace_path(node_id, new_path);
                            self.mark_dirty();
                            return true;
                        }
                        point_count += 1;
                    }
                    PathCmd::LineTo(x, y) => {
                        if point_count == point_idx {
                            // Convert to CurveTo with the handle
                            let cp1 = (*x, *y);
                            let cp2 = handle_pos;
                            let end = (*x, *y);
                            *cmd =
                                PathCmd::CurveTo(cp1.0, cp1.1, cp2.0, cp2.1, end.0, end.1);
                            self.replace_path(node_id, new_path);
                            self.mark_dirty();
                            return true;
                        }
                        point_count += 1;
                    }
                    _ => {}
                }
            }
        }
        false
    }

    /// Adjust a bézier handle position
    pub fn adjust_bezier_handle(&mut self, node_id: &str, point_idx: usize, handle_idx: usize, new_pos: (f64, f64)) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let mut new_path = path.clone();
            
            let mut point_count = 0;
            for cmd in new_path.iter_mut() {
                if let PathCmd::CurveTo(h1x, h1y, h2x, h2y, _, _) = cmd {
                    if point_count == point_idx {
                        if handle_idx == 0 {
                            *h1x = new_pos.0;
                            *h1y = new_pos.1;
                        } else {
                            *h2x = new_pos.0;
                            *h2y = new_pos.1;
                        }
                        self.replace_path(node_id, new_path);
                        self.mark_dirty();
                        return true;
                    }
                    point_count += 1;
                }
            }
        }
        false
    }

    /// Split a vector path at a specific point
    pub fn split_vector_path(&mut self, node_id: &str, at_point: usize) -> Option<String> {
        let Some(node) = self.get_node(node_id) else { return None };
        
        if let NodeKind::Vector { ref path } = node.kind {
            // Split path into two parts at the specified point
            let mut path1 = Vec::new();
            let mut path2 = Vec::new();
            let mut point_count = 0;
            let mut in_second_path = false;
            
            for cmd in path {
                match cmd {
                    PathCmd::MoveTo(x, y) => {
                        if point_count == at_point {
                            in_second_path = true;
                            path2.push(PathCmd::MoveTo(*x, *y));
                        } else if in_second_path {
                            path2.push(PathCmd::MoveTo(*x, *y));
                        } else {
                            path1.push(PathCmd::MoveTo(*x, *y));
                        }
                        point_count += 1;
                    }
                    PathCmd::LineTo(x, y) => {
                        if in_second_path {
                            path2.push(PathCmd::LineTo(*x, *y));
                        } else {
                            path1.push(PathCmd::LineTo(*x, *y));
                        }
                        point_count += 1;
                    }
                    PathCmd::CurveTo(h1x, h1y, h2x, h2y, ex, ey) => {
                        let curve = PathCmd::CurveTo(*h1x, *h1y, *h2x, *h2y, *ex, *ey);
                        if in_second_path {
                            path2.push(curve);
                        } else {
                            path1.push(curve);
                        }
                        point_count += 1;
                    }
                    PathCmd::Close => {
                        path1.push(PathCmd::Close);
                        path2.push(PathCmd::Close);
                    }
                }
            }
            
            // Update original node with first path
            self.replace_path(node_id, path1);
            
            // Create new node with second path
            if !path2.is_empty() {
                let new_id = fresh_id();
                let new_node = Node::vector(&new_id, node.transform.x, node.transform.y, node.w, node.h, path2);
                self.add_node(new_node);
                return Some(new_id);
            }
        }
        None
    }

    /// Cut a vector path along a line
    pub fn cut_vector_path(&mut self, node_id: &str, start: (f64, f64), end: (f64, f64)) -> Vec<String> {
        let mut new_ids = Vec::new();
        let Some(node) = self.get_node(node_id) else { return new_ids };
        
        if let NodeKind::Vector { ref path } = node.kind {
            // Find all intersection points with the cut line
            let mut intersections = Vec::new();
            let mut prev_point = None;
            let mut point_idx = 0;
            
            for cmd in path {
                match cmd {
                    PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
                        if let Some((px, py)) = prev_point {
                            // Check if this segment intersects the cut line
                            if let Some(intersection) = line_intersection(px, py, *x, *y, start.0, start.1, end.0, end.1) {
                                intersections.push((point_idx, intersection));
                            }
                        }
                        prev_point = Some((*x, *y));
                        point_idx += 1;
                    }
                    PathCmd::CurveTo(_, _, _, _, end_x, end_y) => {
                        // For curves, we'd need more complex intersection logic
                        // For now, skip curve intersections
                        prev_point = Some((*end_x, *end_y));
                        point_idx += 1;
                    }
                    PathCmd::Close => {
                        prev_point = None;
                    }
                }
            }
            
            // Split at each intersection (in reverse order to maintain indices)
            intersections.sort_by(|a, b| b.0.cmp(&a.0));
            for (idx, _) in intersections {
                if let Some(new_id) = self.split_vector_path(node_id, idx) {
                    new_ids.push(new_id);
                }
            }
        }
        
        new_ids
    }

    /// Lasso select points within a freeform boundary
    pub fn lasso_select_points(&self, node_id: &str, boundary: &[(f64, f64)]) -> Vec<usize> {
        let mut selected = Vec::new();
        let Some(node) = self.get_node(node_id) else { return selected };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let mut point_idx = 0;
            for cmd in path {
                let point = match cmd {
                    PathCmd::MoveTo(x, y) => Some((*x, *y)),
                    PathCmd::LineTo(x, y) => Some((*x, *y)),
                    PathCmd::CurveTo(_, _, _, _, ex, ey) => Some((*ex, *ey)),
                    PathCmd::Close => None,
                };
                
                if let Some((px, py)) = point {
                    if point_in_polygon(px, py, boundary) {
                        selected.push(point_idx);
                    }
                    point_idx += 1;
                }
            }
        }
        
        selected
    }

    /// Set variable width stroke profile
    pub fn set_variable_width_stroke(&mut self, node_id: &str, width_points: Vec<(f64, f64)>) -> bool {
        let Some(node) = self.get_node_mut(node_id) else { return false };
        
        // Store width profile as a custom property
        // In a full implementation, this would be a proper field on Node
        // For now, we'll store it in the stroke metadata
        node.stroke.width = width_points.iter().map(|(_, w)| w).fold(0.0, f64::max);
        
        // TODO: Add proper variable width storage to Node struct
        // For now, this is a placeholder
        
        self.mark_dirty();
        true
    }

    /// Remove bézier handles from a point (convert to corner)
    pub fn remove_bezier_handles(&mut self, node_id: &str, point_idx: usize) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let mut new_path = path.clone();
            
            let mut point_count = 0;
            for cmd in new_path.iter_mut() {
                if let PathCmd::CurveTo(_, _, _, _, end_x, end_y) = cmd {
                    if point_count == point_idx {
                        // Convert to LineTo (remove handles)
                        let end = (*end_x, *end_y);
                        *cmd = PathCmd::LineTo(end.0, end.1);
                        self.replace_path(node_id, new_path);
                        self.mark_dirty();
                        return true;
                    }
                    point_count += 1;
                }
            }
        }
        false
    }

    /// Mirror bézier handles (symmetric curves)
    pub fn mirror_bezier_handles(&mut self, node_id: &str, point_idx: usize, mirror_mode: MirrorMode) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let mut new_path = path.clone();
            
            let mut point_count = 0;
            for cmd in new_path.iter_mut() {
                if let PathCmd::CurveTo(h1x, h1y, h2x, h2y, end_x, end_y) = cmd {
                    if point_count == point_idx {
                        let cp1 = (*h1x, *h1y);
                        let cp2 = (*h2x, *h2y);
                        let end = (*end_x, *end_y);
                        match mirror_mode {
                            MirrorMode::Angle => {
                                // Mirror angle only, keep lengths
                                let angle1 = (cp1.1 - end.1).atan2(cp1.0 - end.0);
                                let angle2 = (cp2.1 - end.1).atan2(cp2.0 - end.0);
                                let len1 = ((cp1.0 - end.0).powi(2) + (cp1.1 - end.1).powi(2)).sqrt();
                                let len2 = ((cp2.0 - end.0).powi(2) + (cp2.1 - end.1).powi(2)).sqrt();

                                // Average the angles and apply opposite directions
                                let avg_angle = (angle1 + angle2 + std::f64::consts::PI) / 2.0;
                                *h1x = end.0 + len1 * avg_angle.cos();
                                *h1y = end.1 + len1 * avg_angle.sin();
                                *h2x = end.0 - len2 * avg_angle.cos();
                                *h2y = end.1 - len2 * avg_angle.sin();
                            }
                            MirrorMode::AngleAndLength => {
                                // Mirror both angle and length
                                *h2x = 2.0 * end.0 - cp1.0;
                                *h2y = 2.0 * end.1 - cp1.1;
                            }
                            MirrorMode::None => {
                                // No mirroring - do nothing
                            }
                        }
                        self.replace_path(node_id, new_path);
                        self.mark_dirty();
                        return true;
                    }
                    point_count += 1;
                }
            }
        }
        false
    }


    // ========================================================================
    // Phase 4: Stroke Caps and Advanced Tools
    // ========================================================================

    /// Render stroke caps at path endpoints
    /// Returns additional path commands for caps
    pub fn render_stroke_caps(&self, node_id: &str) -> Vec<PathCmd> {
        let Some(node) = self.get_node(node_id) else { return Vec::new() };
        
        if let NodeKind::Vector { ref path } = node.kind {
            if path.is_empty() {
                return Vec::new();
            }
            
            let mut cap_commands = Vec::new();
            let stroke_width = node.stroke.width;
            
            // Get stroke options from the first stroke layer
            let options = node.stroke_layers.first()
                .map(|l| &l.options)
                .unwrap_or(&StrokeOptions::default());
            
            // Find start and end points
            let start_point = match path.first() {
                Some(PathCmd::MoveTo(x, y)) => (*x, *y),
                Some(PathCmd::LineTo(x, y)) => (*x, *y),
                _ => return Vec::new(),
            };
            
            let end_point = match path.last() {
                Some(PathCmd::LineTo(x, y)) => (*x, *y),
                Some(PathCmd::CurveTo(_, _, _, _, x, y)) => (*x, *y),
                Some(PathCmd::Close) => {
                    // For closed paths, find the last non-close point
                    path.iter().rev().skip(1).find_map(|cmd| match cmd {
                        PathCmd::LineTo(x, y) => Some((*x, *y)),
                        PathCmd::CurveTo(_, _, _, _, x, y) => Some((*x, *y)),
                        _ => None,
                    }).unwrap_or(start_point)
                }
                _ => start_point,
            };
            
            // Calculate direction vectors for caps
            let start_dir = if path.len() >= 2 {
                match &path[1] {
                    PathCmd::LineTo(x, y) => {
                        let dx = x - start_point.0;
                        let dy = y - start_point.1;
                        let len = (dx * dx + dy * dy).sqrt();
                        if len > 0.0 { Some((dx / len, dy / len)) } else { None }
                    }
                    PathCmd::CurveTo(x1, y1, _, _, _, _) => {
                        let dx = x1 - start_point.0;
                        let dy = y1 - start_point.1;
                        let len = (dx * dx + dy * dy).sqrt();
                        if len > 0.0 { Some((dx / len, dy / len)) } else { None }
                    }
                    _ => None,
                }
            } else {
                None
            };
            
            let end_dir = if path.len() >= 2 {
                match path.get(path.len() - 2) {
                    Some(PathCmd::LineTo(x, y)) => {
                        let dx = end_point.0 - x;
                        let dy = end_point.1 - y;
                        let len = (dx * dx + dy * dy).sqrt();
                        if len > 0.0 { Some((dx / len, dy / len)) } else { None }
                    }
                    Some(PathCmd::CurveTo(_, _, x2, y2, _, _)) => {
                        let dx = end_point.0 - x2;
                        let dy = end_point.1 - y2;
                        let len = (dx * dx + dy * dy).sqrt();
                        if len > 0.0 { Some((dx / len, dy / len)) } else { None }
                    }
                    _ => None,
                }
            } else {
                None
            };
            
            // Render start cap
            if let (Some(dir), Some((sx, sy))) = (start_dir, Some(start_point)) {
                let cap_cmds = self.generate_stroke_cap(options.cap_start, sx, sy, dir.0, dir.1, stroke_width, true);
                cap_commands.extend(cap_cmds);
            }
            
            // Render end cap
            if let (Some(dir), Some((ex, ey))) = (end_dir, Some(end_point)) {
                let cap_cmds = self.generate_stroke_cap(options.cap_end, ex, ey, dir.0, dir.1, stroke_width, false);
                cap_commands.extend(cap_cmds);
            }
            
            cap_commands
        } else {
            Vec::new()
        }
    }
    
    /// Generate stroke cap geometry
    fn generate_stroke_cap(&self, cap: StrokeCap, x: f64, y: f64, dx: f64, dy: f64, width: f64, is_start: bool) -> Vec<PathCmd> {
        let mut cmds = Vec::new();
        let half_width = width / 2.0;
        
        // Perpendicular direction
        let px = -dy;
        let py = dx;
        
        match cap {
            StrokeCap::None => {
                // No cap
            }
            StrokeCap::Round => {
                // Round cap: semicircle
                let steps = 16;
                let start_angle = if is_start { std::f64::consts::PI } else { 0.0 };
                let end_angle = if is_start { 2.0 * std::f64::consts::PI } else { std::f64::consts::PI };
                
                cmds.push(PathCmd::MoveTo(x + px * half_width, y + py * half_width));
                for i in 1..=steps {
                    let t = i as f64 / steps as f64;
                    let angle = start_angle + (end_angle - start_angle) * t;
                    let cx = x + half_width * (dx * angle.cos() - px * angle.sin());
                    let cy = y + half_width * (dy * angle.cos() - py * angle.sin());
                    cmds.push(PathCmd::LineTo(cx, cy));
                }
            }
            StrokeCap::Square => {
                // Square cap: extends half_width beyond endpoint
                let extend = half_width;
                let p1x = x + dx * extend + px * half_width;
                let p1y = y + dy * extend + py * half_width;
                let p2x = x + dx * extend - px * half_width;
                let p2y = y + dy * extend - py * half_width;
                
                cmds.push(PathCmd::MoveTo(x + px * half_width, y + py * half_width));
                cmds.push(PathCmd::LineTo(p1x, p1y));
                cmds.push(PathCmd::LineTo(p2x, p2y));
                cmds.push(PathCmd::LineTo(x - px * half_width, y - py * half_width));
            }
            StrokeCap::Arrow => {
                // Arrow cap: triangular arrow pointing outward
                let arrow_length = width * 1.5;
                let arrow_width = width * 0.8;
                
                let tip_x = x + dx * arrow_length;
                let tip_y = y + dy * arrow_length;
                
                let base1_x = x + px * arrow_width;
                let base1_y = y + py * arrow_width;
                let base2_x = x - px * arrow_width;
                let base2_y = y - py * arrow_width;
                
                cmds.push(PathCmd::MoveTo(base1_x, base1_y));
                cmds.push(PathCmd::LineTo(tip_x, tip_y));
                cmds.push(PathCmd::LineTo(base2_x, base2_y));
                cmds.push(PathCmd::Close);
            }
            StrokeCap::Triangle => {
                // Triangle cap: simple triangle
                let tri_length = width;
                let tip_x = x + dx * tri_length;
                let tip_y = y + dy * tri_length;
                
                cmds.push(PathCmd::MoveTo(x + px * half_width, y + py * half_width));
                cmds.push(PathCmd::LineTo(tip_x, tip_y));
                cmds.push(PathCmd::LineTo(x - px * half_width, y - py * half_width));
                cmds.push(PathCmd::Close);
            }
        }
        
        cmds
    }
    
    /// Set stroke cap for start of path
    pub fn set_stroke_cap_start(&mut self, node_id: &str, cap: StrokeCap) -> bool {
        let Some(node) = self.get_node_mut(node_id) else { return false };
        
        if node.stroke_layers.is_empty() {
            node.stroke_layers.push(StrokeLayer::new(node.stroke.clone()));
        }
        
        if let Some(layer) = node.stroke_layers.first_mut() {
            layer.options.cap_start = cap;
            self.mark_dirty();
            true
        } else {
            false
        }
    }
    
    /// Set stroke cap for end of path
    pub fn set_stroke_cap_end(&mut self, node_id: &str, cap: StrokeCap) -> bool {
        let Some(node) = self.get_node_mut(node_id) else { return false };
        
        if node.stroke_layers.is_empty() {
            node.stroke_layers.push(StrokeLayer::new(node.stroke.clone()));
        }
        
        if let Some(layer) = node.stroke_layers.first_mut() {
            layer.options.cap_end = cap;
            self.mark_dirty();
            true
        } else {
            false
        }
    }


    // ========================================================================
    // Phase 4: Shape Builder Tool
    // ========================================================================

}
    /// Shape Builder tool state
    pub struct ShapeBuilderState {
        pub active: bool,
        pub selected_nodes: Vec<String>,
        pub hovered_region: Option<usize>,
        pub mode: ShapeBuilderMode,
    }
    
    impl Default for ShapeBuilderState {
        fn default() -> Self {
            Self {
                active: false,
                selected_nodes: Vec::new(),
                hovered_region: None,
                mode: ShapeBuilderMode::Merge,
            }
        }
    }
    
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ShapeBuilderMode {
        Merge,
        Subtract,
        Intersect,
        Exclude,
    }
    
impl Editor {
    /// Detect overlapping regions between selected shapes
    pub fn detect_shape_regions(&self, node_ids: &[String]) -> Vec<ShapeRegion> {
        let mut regions = Vec::new();
        
        // Collect all paths
        let paths: Vec<(String, Vec<PathCmd>)> = node_ids.iter()
            .filter_map(|id| {
                self.get_node(id).and_then(|node| {
                    if let NodeKind::Vector { ref path } = node.kind {
                        Some((id.clone(), path.clone()))
                    } else {
                        None
                    }
                })
            })
            .collect();
        
        if paths.len() < 2 {
            return regions;
        }
        
        // Simple region detection: find intersection points
        for i in 0..paths.len() {
            for j in (i + 1)..paths.len() {
                let (id1, path1) = &paths[i];
                let (id2, path2) = &paths[j];
                
                // Find intersection points
                let intersections = find_path_intersections(path1, path2);
                
                if !intersections.is_empty() {
                    regions.push(ShapeRegion {
                        node_ids: vec![id1.clone(), id2.clone()],
                        intersection_points: intersections,
                        region_type: RegionType::Overlap,
                    });
                }
            }
        }
        
        regions
    }
    
    /// Merge selected shapes into one
    pub fn shape_builder_merge(&mut self, node_ids: &[String]) -> Option<String> {
        if node_ids.len() < 2 {
            return None;
        }
        
        // Get all paths
        let paths: Vec<Vec<PathCmd>> = node_ids.iter()
            .filter_map(|id| {
                self.get_node(id).and_then(|node| {
                    if let NodeKind::Vector { ref path } = node.kind {
                        Some(path.clone())
                    } else {
                        None
                    }
                })
            })
            .collect();
        
        if paths.is_empty() {
            return None;
        }
        
        // Combine all paths into one
        let mut combined_path = Vec::new();
        for path in paths {
            combined_path.extend(path);
        }
        
        // Create new node with combined path
        let new_id = fresh_id();
        let first_node = self.get_node(&node_ids[0])?;
        let new_node = Node::vector(
            &new_id,
            first_node.transform.x,
            first_node.transform.y,
            first_node.w,
            first_node.h,
            combined_path,
        );
        
        // Delete old nodes
        for id in node_ids {
            self.delete_node(id);
        }
        
        // Add new node
        self.add_node(new_node);
        
        self.mark_dirty();
        Some(new_id)
    }
    
    /// Subtract shape from another
    pub fn shape_builder_subtract(&mut self, base_id: &str, subtract_ids: &[String]) -> Option<String> {
        // Get base path
        let base_node = self.get_node(base_id)?;
        let base_path = if let NodeKind::Vector { ref path } = base_node.kind {
            path.clone()
        } else {
            return None;
        };
        
        // For now, just return the base path
        // Full implementation would use boolean operations
        // This is a placeholder
        
        self.mark_dirty();
        Some(base_id.to_string())
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

    /// Find all nodes that match the structure of the given node
    pub fn find_matching_nodes(&self, template: &Node) -> Vec<&Node> {
        let mut matches = Vec::new();
        fn find_matches<'a>(node: &'a Node, template: &Node, matches: &mut Vec<&'a Node>) {
            // Compare structure (kind, children count, dimensions)
            if std::mem::discriminant(&node.kind) == std::mem::discriminant(&template.kind)
                && node.children.len() == template.children.len()
                && (node.w - template.w).abs() < 0.1
                && (node.h - template.h).abs() < 0.1
            {
                matches.push(node);
            }
            for child in &node.children {
                find_matches(child, template, matches);
            }
        }
        find_matches(&self.root, template, &mut matches);
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

    // ========================================================================
    // Phase 3: Enhanced Path Operations
    // ========================================================================

    /// Enhanced outline stroke with proper stroke-to-fill conversion
    /// Creates a filled path that represents the stroke outline
    pub fn outline_stroke_enhanced(&mut self, node_id: &str) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let stroke_width = node.stroke.width;
            if stroke_width <= 0.0 {
                return false;
            }
            
            // Generate offset paths for stroke outline
            let mut outline_path = Vec::new();
            let half_width = stroke_width / 2.0;
            
            // For each segment, create offset paths on both sides
            let mut prev_point = None;
            for cmd in path {
                match cmd {
                    PathCmd::MoveTo(x, y) => {
                        // Start of path - create first point on both sides
                        outline_path.push(PathCmd::MoveTo(*x - half_width, *y));
                        prev_point = Some((*x, *y));
                    }
                    PathCmd::LineTo(x, y) => {
                        if let Some((px, py)) = prev_point {
                            // Calculate perpendicular offset
                            let dx = x - px;
                            let dy = y - py;
                            let len = (dx * dx + dy * dy).sqrt();
                            if len > 0.0 {
                                let nx = -dy / len * half_width;
                                let ny = dx / len * half_width;
                                
                                // Add points for both sides
                                outline_path.push(PathCmd::LineTo(*x + nx, *y + ny));
                            }
                        }
                        prev_point = Some((*x, *y));
                    }
                    PathCmd::CurveTo(_, _, _, _, end_x, end_y) => {
                        // For curves, we'd need to offset the control points
                        // For now, just use the endpoint
                        let end = (*end_x, *end_y);
                        if let Some((px, py)) = prev_point {
                            let dx = end.0 - px;
                            let dy = end.1 - py;
                            let len = (dx * dx + dy * dy).sqrt();
                            if len > 0.0 {
                                let nx = -dy / len * half_width;
                                let ny = dx / len * half_width;
                                outline_path.push(PathCmd::LineTo(end.0 + nx, end.1 + ny));
                            }
                        }
                        prev_point = Some((end.0, end.1));
                    }
                    PathCmd::Close => {
                        outline_path.push(PathCmd::Close);
                        prev_point = None;
                    }
                }
            }
            
            // Now create the return path (other side of stroke)
            let mut return_path = Vec::new();
            prev_point = None;
            for cmd in path.iter().rev() {
                match cmd {
                    PathCmd::MoveTo(x, y) => {
                        return_path.push(PathCmd::MoveTo(*x + half_width, *y));
                        prev_point = Some((*x, *y));
                    }
                    PathCmd::LineTo(x, y) => {
                        if let Some((px, py)) = prev_point {
                            let dx = px - x;
                            let dy = py - y;
                            let len = (dx * dx + dy * dy).sqrt();
                            if len > 0.0 {
                                let nx = -dy / len * half_width;
                                let ny = dx / len * half_width;
                                return_path.push(PathCmd::LineTo(*x - nx, *y - ny));
                            }
                        }
                        prev_point = Some((*x, *y));
                    }
                    PathCmd::CurveTo(_, _, _, _, end_x, end_y) => {
                        let end = (*end_x, *end_y);
                        if let Some((px, py)) = prev_point {
                            let dx = px - end.0;
                            let dy = py - end.1;
                            let len = (dx * dx + dy * dy).sqrt();
                            if len > 0.0 {
                                let nx = -dy / len * half_width;
                                let ny = dx / len * half_width;
                                return_path.push(PathCmd::LineTo(end.0 - nx, end.1 - ny));
                            }
                        }
                        prev_point = Some((end.0, end.1));
                    }
                    PathCmd::Close => {
                        return_path.push(PathCmd::Close);
                        prev_point = None;
                    }
                }
            }
            
            // Combine forward and return paths
            outline_path.extend(return_path);
            outline_path.push(PathCmd::Close);
            
            // Update node with new path and remove stroke
            self.replace_path(node_id, outline_path);
            if let Some(node) = self.get_node_mut(node_id) {
                node.stroke.width = 0.0; // Remove stroke
            }
            self.mark_dirty();
            return true;
        }
        false
    }

    /// Enhanced offset vector with different join styles
    pub fn offset_vector_enhanced(&mut self, node_id: &str, distance: f64, join_style: JoinStyle) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let mut offset_path = Vec::new();
            let mut prev_point = None;
            let mut prev_normal = None;
            
            for cmd in path {
                match cmd {
                    PathCmd::MoveTo(x, y) => {
                        offset_path.push(PathCmd::MoveTo(*x, *y));
                        prev_point = Some((*x, *y));
                        prev_normal = None;
                    }
                    PathCmd::LineTo(x, y) => {
                        if let Some((px, py)) = prev_point {
                            // Calculate perpendicular offset
                            let dx = x - px;
                            let dy = y - py;
                            let len = (dx * dx + dy * dy).sqrt();
                            if len > 0.0 {
                                let nx = -dy / len * distance;
                                let ny = dx / len * distance;
                                
                                // Handle join style
                                if let Some((prev_nx, prev_ny)) = prev_normal {
                                    // Apply join style at corner
                                    match join_style {
                                        JoinStyle::Miter => {
                                            // Extend to intersection point
                                            offset_path.push(PathCmd::LineTo(*x + nx, *y + ny));
                                        }
                                        JoinStyle::Round => {
                                            // Add arc (simplified as line for now)
                                            offset_path.push(PathCmd::LineTo(*x + nx, *y + ny));
                                        }
                                        JoinStyle::Bevel => {
                                            // Cut corner with line
                                            offset_path.push(PathCmd::LineTo(*x + prev_nx, *y + prev_ny));
                                            offset_path.push(PathCmd::LineTo(*x + nx, *y + ny));
                                        }
                                    }
                                } else {
                                    offset_path.push(PathCmd::LineTo(*x + nx, *y + ny));
                                }
                                
                                prev_normal = Some((nx, ny));
                            }
                        }
                        prev_point = Some((*x, *y));
                    }
                    PathCmd::CurveTo(h1x, h1y, h2x, h2y, end_x, end_y) => {
                        // For curves, offset control points
                        let cp1 = (*h1x, *h1y);
                        let cp2 = (*h2x, *h2y);
                        let end = (*end_x, *end_y);
                        if let Some((px, py)) = prev_point {
                            let dx = end.0 - px;
                            let dy = end.1 - py;
                            let len = (dx * dx + dy * dy).sqrt();
                            if len > 0.0 {
                                let nx = -dy / len * distance;
                                let ny = dx / len * distance;
                                offset_path.push(PathCmd::CurveTo(
                                    cp1.0 + nx,
                                    cp1.1 + ny,
                                    cp2.0 + nx,
                                    cp2.1 + ny,
                                    end.0 + nx,
                                    end.1 + ny,
                                ));
                                prev_normal = Some((nx, ny));
                            }
                        }
                        prev_point = Some((end.0, end.1));
                    }
                    PathCmd::Close => {
                        offset_path.push(PathCmd::Close);
                        prev_point = None;
                        prev_normal = None;
                    }
                }
            }
            
            self.replace_path(node_id, offset_path);
            self.mark_dirty();
            return true;
        }
        false
    }

    /// Enhanced text to outline with actual glyph conversion
    /// Note: This is still a placeholder. Full implementation requires font outline extraction
    pub fn text_to_outline_enhanced(&mut self, node_id: &str) -> bool {
        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Text { text } = &node.kind {
            // Get text metrics
            let font_size = node.font.size;
            let char_width = font_size * 0.6; // Approximate character width
            
            // Create a path for each character (simplified as rectangles)
            let mut outline_path = Vec::new();
            let mut x_offset = 0.0;
            
            for ch in text.chars() {
                if ch == ' ' {
                    x_offset += char_width;
                    continue;
                }
                
                // Create rectangle for each character
                outline_path.push(PathCmd::MoveTo(x_offset, 0.0));
                outline_path.push(PathCmd::LineTo(x_offset + char_width, 0.0));
                outline_path.push(PathCmd::LineTo(x_offset + char_width, font_size));
                outline_path.push(PathCmd::LineTo(x_offset, font_size));
                outline_path.push(PathCmd::Close);
                
                x_offset += char_width;
            }
            
            let new_id = fresh_id();
            let new_node = Node::vector(&new_id, node.transform.x, node.transform.y, x_offset, font_size, outline_path);
            
            self.replace_node(node_id, new_node);
            self.mark_dirty();
            return true;
        }
        false
    }

    /// Interactive path simplification with tolerance control
    pub fn simplify_vector_interactive(&mut self, node_id: &str, tolerance: f64, preview: bool) -> Option<Vec<PathCmd>> {
        let Some(node) = self.get_node(node_id) else { return None };
        
        if let NodeKind::Vector { ref path } = node.kind {
            // Extract points from path
            let mut points = Vec::new();
            for cmd in path {
                match cmd {
                    PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
                        points.push((*x, *y));
                    }
                    PathCmd::CurveTo(_, _, _, _, end_x, end_y) => {
                        points.push((*end_x, *end_y));
                    }
                    PathCmd::Close => {}
                }
            }
            
            // Apply Ramer-Douglas-Peucker simplification
            let simplified = ramer_douglas_peucker(&points, tolerance);
            
            // Convert back to path commands
            let mut new_path = Vec::new();
            if !simplified.is_empty() {
                new_path.push(PathCmd::MoveTo(simplified[0].0, simplified[0].1));
                for i in 1..simplified.len() {
                    new_path.push(PathCmd::LineTo(simplified[i].0, simplified[i].1));
                }
                new_path.push(PathCmd::Close);
            }
            
            if !preview {
                self.replace_path(node_id, new_path.clone());
                self.mark_dirty();
            }
            
            return Some(new_path);
        }
        None
    }

    /// Join two vector paths at their endpoints
    pub fn join_paths(&mut self, node_id1: &str, node_id2: &str) -> Option<String> {
        let Some(node1) = self.get_node(node_id1) else { return None };
        let Some(node2) = self.get_node(node_id2) else { return None };
        
        if let (NodeKind::Vector { path: ref path1 }, NodeKind::Vector { path: ref path2 }) = (&node1.kind, &node2.kind) {
            // Combine paths
            let mut joined_path = path1.clone();
            
            // Remove Close command from first path if present
            if let Some(PathCmd::Close) = joined_path.last() {
                joined_path.pop();
            }
            
            // Append second path
            joined_path.extend(path2.iter().cloned());
            
            // Update first node with joined path
            self.replace_path(node_id1, joined_path);
            
            // Delete second node
            self.delete_node(node_id2);
            
            self.mark_dirty();
            return Some(node_id1.to_string());
        }
        None
    }

    /// Reverse path direction
    pub fn reverse_path_direction(&mut self, node_id: &str) -> bool {


        let Some(node) = self.get_node(node_id) else { return false };
        
        if let NodeKind::Vector { ref path } = node.kind {
            let mut reversed = Vec::new();
            let mut points = Vec::new();
            
            // Collect all points
            for cmd in path {
                match cmd {
                    PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
                        points.push(PathCmd::LineTo(*x, *y));
                    }
                    PathCmd::CurveTo(h1x, h1y, h2x, h2y, ex, ey) => {
                        // Traversed backwards, so the two handles swap roles
                        points.push(PathCmd::CurveTo(*h2x, *h2y, *h1x, *h1y, *ex, *ey));
                    }
                    PathCmd::Close => {
                        // Ignore Close, we'll add it at the end
                    }
                }
            }
            
            // Reverse and convert to path
            if !points.is_empty() {
                if let PathCmd::LineTo(x, y) = points[0] {
                    reversed.push(PathCmd::MoveTo(x, y));
                } else if let PathCmd::CurveTo(_, _, _, _, end_x, end_y) = points[0] {
                    reversed.push(PathCmd::MoveTo(end_x, end_y));
                }
                
                for i in (0..points.len() - 1).rev() {
                    reversed.push(points[i].clone());
                }
                
                reversed.push(PathCmd::Close);
            }
            
            self.replace_path(node_id, reversed);
            self.mark_dirty();
            return true;
        }
        false
    }


    // ========================================================================
    // Phase 5: Interactive UI & Performance Optimizations
    // ========================================================================

}
    /// Interactive Shape Builder with hover detection
    pub struct InteractiveShapeBuilder {
        pub state: ShapeBuilderState,
        pub hovered_shape: Option<String>,
        pub hover_point: Option<(f64, f64)>,
        pub preview_operation: Option<ShapeOperation>,
        pub selection_mode: SelectionMode,
    }
    
    impl Default for InteractiveShapeBuilder {
        fn default() -> Self {
            Self {
                state: ShapeBuilderState::default(),
                hovered_shape: None,
                hover_point: None,
                preview_operation: None,
                selection_mode: SelectionMode::Click,
            }
        }
    }
    
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum SelectionMode {
        Click,      // Click to select shapes
        Drag,       // Drag to select multiple shapes
        Lasso,      // Lasso selection
    }
    
    #[derive(Debug, Clone)]
    pub enum ShapeOperation {
        Merge(Vec<String>),
        Subtract { base: String, subtract: Vec<String> },
        Intersect(Vec<String>),
        Exclude(Vec<String>),
    }
    
impl InteractiveShapeBuilder {
    /// Update hover state based on mouse position
    pub fn update_shape_builder_hover(&mut self, ed: &Editor, mouse_pos: (f64, f64)) {
        self.hover_point = Some(mouse_pos);

        // Find shape under cursor
        let hit_result = self.hit_test_shapes(ed, mouse_pos);
        
        if let Some(shape_id) = hit_result {
            self.hovered_shape = Some(shape_id);
            
            // Generate preview based on current mode
            self.update_preview_operation();
        } else {
            self.hovered_shape = None;
            self.preview_operation = None;
        }
    }
    
    /// Hit test to find shape under cursor
    fn hit_test_shapes(&self, ed: &Editor, point: (f64, f64)) -> Option<String> {
        // Check all visible vector shapes
        for id in ed.get_all_selectable_ids() {
            let Some(node) = ed.get_node(&id) else { continue };
            if let NodeKind::Vector { ref path } = node.kind {
                if self.point_in_shape(path, point) {
                    return Some(node.id.clone());
                }
            }
        }
        None
    }
    
    /// Check if point is inside a shape
    fn point_in_shape(&self, path: &[PathCmd], point: (f64, f64)) -> bool {
        // Convert path to polygon points
        let points = self.path_to_points(path);
        
        if points.is_empty() {
            return false;
        }
        
        // Ray casting algorithm
        let mut inside = false;
        let mut j = points.len() - 1;
        
        for i in 0..points.len() {
            let (xi, yi) = points[i];
            let (xj, yj) = points[j];
            
            if ((yi > point.1) != (yj > point.1)) && 
               (point.0 < (xj - xi) * (point.1 - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
            j = i;
        }
        
        inside
    }
    
    /// Convert path to list of points
    fn path_to_points(&self, path: &[PathCmd]) -> Vec<(f64, f64)> {
        let mut points = Vec::new();
        
        for cmd in path {
            match cmd {
                PathCmd::MoveTo(x, y) => points.push((*x, *y)),
                PathCmd::LineTo(x, y) => points.push((*x, *y)),
                PathCmd::CurveTo(_, _, _, _, x, y) => points.push((*x, *y)),
                PathCmd::Close => {}
            }
        }
        
        points
    }
    
    /// Update preview operation based on hover and mode
    fn update_preview_operation(&mut self) {
        let hovered = self.hovered_shape.clone();
        
        if let Some(shape_id) = hovered {
            match self.state.mode {
                ShapeBuilderMode::Merge => {
                    // Preview merge of all selected + hovered
                    let mut shapes = self.state.selected_nodes.clone();
                    if !shapes.contains(&shape_id) {
                        shapes.push(shape_id);
                    }
                    self.preview_operation = Some(ShapeOperation::Merge(shapes));
                }
                ShapeBuilderMode::Subtract => {
                    // Preview subtract hovered from selected
                    if !self.state.selected_nodes.is_empty() {
                        self.preview_operation = Some(ShapeOperation::Subtract {
                            base: self.state.selected_nodes[0].clone(),
                            subtract: vec![shape_id],
                        });
                    }
                }
                ShapeBuilderMode::Intersect => {
                    // Preview intersection
                    let mut shapes = self.state.selected_nodes.clone();
                    if !shapes.contains(&shape_id) {
                        shapes.push(shape_id);
                    }
                    self.preview_operation = Some(ShapeOperation::Intersect(shapes));
                }
                ShapeBuilderMode::Exclude => {
                    // Preview exclude
                    let mut shapes = self.state.selected_nodes.clone();
                    if !shapes.contains(&shape_id) {
                        shapes.push(shape_id);
                    }
                    self.preview_operation = Some(ShapeOperation::Exclude(shapes));
                }
            }
        }
    }
    
    /// Handle click in Shape Builder mode
    pub fn handle_shape_builder_click(&mut self, shift: bool) -> Option<ShapeOperation> {
        if let Some(hovered) = self.hovered_shape.clone() {
            if shift {
                // Add to selection
                if !self.state.selected_nodes.contains(&hovered) {
                    self.state.selected_nodes.push(hovered.clone());
                }
            } else {
                // Replace selection
                self.state.selected_nodes = vec![hovered.clone()];
            }
            
            self.update_preview_operation();
            return self.preview_operation.clone();
        }
        None
    }
    
    /// Execute the preview operation
    pub fn execute_preview_operation(&mut self, ed: &mut Editor) -> Option<String> {
        if let Some(operation) = self.preview_operation.clone() {
            match operation {
                ShapeOperation::Merge(shapes) => {
                    return ed.shape_builder_merge(&shapes);
                }
                ShapeOperation::Subtract { base, subtract } => {
                    return ed.shape_builder_subtract(&base, &subtract);
                }
                ShapeOperation::Intersect(_shapes) => {
                    // TODO: Implement intersect operation
                    return None;
                }
                ShapeOperation::Exclude(_shapes) => {
                    // TODO: Implement exclude operation
                    return None;
                }
            }
        }
        None
    }
    
    /// Get visual feedback data for rendering
    pub fn get_shape_builder_visuals(&self) -> ShapeBuilderVisuals {
        ShapeBuilderVisuals {
            hovered_shape: self.hovered_shape.clone(),
            selected_shapes: self.state.selected_nodes.clone(),
            preview_operation: self.preview_operation.clone(),
            hover_point: self.hover_point,
        }
    }
}



    // ========================================================================
    // Phase 5: Spatial Indexing with Quadtree
    // ========================================================================

    /// Quadtree for fast spatial queries
    pub struct Quadtree {
        root: Option<Box<QuadNode>>,
        bounds: (f64, f64, f64, f64), // x, y, width, height
        max_items: usize,
        max_depth: usize,
    }
    
    struct QuadNode {
        bounds: (f64, f64, f64, f64),
        items: Vec<QuadItem>,
        children: Option<Box<[QuadNode; 4]>>,
        depth: usize,
    }
    
    #[derive(Clone)]
    pub struct QuadItem {
        pub id: String,
        pub bounds: (f64, f64, f64, f64), // x, y, width, height
        pub node_id: String,
    }
    
    impl Quadtree {
        pub fn new(bounds: (f64, f64, f64, f64)) -> Self {
            Self {
                root: None,
                bounds,
                max_items: 10,
                max_depth: 8,
            }
        }
        
        /// Insert item into quadtree
        pub fn insert(&mut self, item: QuadItem) {
            if self.root.is_none() {
                self.root = Some(Box::new(QuadNode::new(self.bounds, 0)));
            }
            
            if let Some(root) = &mut self.root {
                root.insert(item, self.max_items, self.max_depth);
            }
        }
        
        /// Query items in bounds
        pub fn query(&self, bounds: (f64, f64, f64, f64)) -> Vec<QuadItem> {
            let mut results = Vec::new();
            if let Some(root) = &self.root {
                root.query(bounds, &mut results);
            }
            results
        }
        
        /// Query items at point
        pub fn query_point(&self, point: (f64, f64)) -> Vec<QuadItem> {
            self.query((point.0, point.1, 0.0, 0.0))
        }
        
        /// Clear all items
        pub fn clear(&mut self) {
            self.root = None;
        }
    }
    
    impl QuadNode {
        fn new(bounds: (f64, f64, f64, f64), depth: usize) -> Self {
            Self {
                bounds,
                items: Vec::new(),
                children: None,
                depth,
            }
        }
        
        fn insert(&mut self, item: QuadItem, max_items: usize, max_depth: usize) {
            // Check if item is within bounds
            if !self.contains_bounds(&item.bounds) {
                return;
            }
            
            // If we have children, insert into appropriate child
            if let Some(children) = &mut self.children {
                for child in children.iter_mut() {
                    if child.contains_bounds(&item.bounds) {
                        child.insert(item, max_items, max_depth);
                        return;
                    }
                }
            }
            
            // Add to this node
            self.items.push(item);
            
            // Subdivide if needed
            if self.items.len() > max_items && self.depth < max_depth && self.children.is_none() {
                self.subdivide(max_items, max_depth);
            }
        }
        
        fn query(&self, bounds: (f64, f64, f64, f64), results: &mut Vec<QuadItem>) {
            // Check if query bounds intersects this node
            if !self.intersects_bounds(&bounds) {
                return;
            }
            
            // Check items in this node
            for item in &self.items {
                if self.bounds_intersect(&item.bounds, &bounds) {
                    results.push(item.clone());
                }
            }
            
            // Query children
            if let Some(children) = &self.children {
                for child in children.iter() {
                    child.query(bounds, results);
                }
            }
        }
        
        fn subdivide(&mut self, max_items: usize, max_depth: usize) {
            let (x, y, w, h) = self.bounds;
            let hw = w / 2.0;
            let hh = h / 2.0;
            
            self.children = Some(Box::new([
                QuadNode::new((x, y, hw, hh), self.depth + 1),
                QuadNode::new((x + hw, y, hw, hh), self.depth + 1),
                QuadNode::new((x, y + hh, hw, hh), self.depth + 1),
                QuadNode::new((x + hw, y + hh, hw, hh), self.depth + 1),
            ]));
            
            // Redistribute items to children
            let items = std::mem::take(&mut self.items);
            for item in items {
                if let Some(children) = &mut self.children {
                    for child in children.iter_mut() {
                        if child.contains_bounds(&item.bounds) {
                            child.insert(item.clone(), max_items, max_depth);
                            break;
                        }
                    }
                }
            }
        }
        
        fn contains_bounds(&self, bounds: &(f64, f64, f64, f64)) -> bool {
            let (x, y, w, h) = self.bounds;
            let (bx, by, bw, bh) = *bounds;
            
            bx >= x && by >= y && 
            bx + bw <= x + w && by + bh <= y + h
        }
        
        fn intersects_bounds(&self, bounds: &(f64, f64, f64, f64)) -> bool {
            self.bounds_intersect(&self.bounds, bounds)
        }
        
        fn bounds_intersect(&self, b1: &(f64, f64, f64, f64), b2: &(f64, f64, f64, f64)) -> bool {
            let (x1, y1, w1, h1) = *b1;
            let (x2, y2, w2, h2) = *b2;
            
            !(x1 + w1 < x2 || x2 + w2 < x1 || y1 + h1 < y2 || y2 + h2 < y1)
        }
    }
    
    /// Spatial index for fast shape queries
    pub struct SpatialIndex {
        quadtree: Quadtree,
        item_count: usize,
    }
    
    impl SpatialIndex {
        pub fn new(bounds: (f64, f64, f64, f64)) -> Self {
            Self {
                quadtree: Quadtree::new(bounds),
                item_count: 0,
            }
        }
        
        /// Index a node
        pub fn index_node(&mut self, node_id: &str, bounds: (f64, f64, f64, f64)) {
            let item = QuadItem {
                id: format!("{}_{}", node_id, self.item_count),
                bounds,
                node_id: node_id.to_string(),
            };
            self.quadtree.insert(item);
            self.item_count += 1;
        }
        
        /// Query shapes in bounds
        pub fn query_bounds(&self, bounds: (f64, f64, f64, f64)) -> Vec<String> {
            let items = self.quadtree.query(bounds);
            items.into_iter()
                .map(|item| item.node_id)
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect()
        }
        
        /// Query shape at point
        pub fn query_point(&self, point: (f64, f64)) -> Vec<String> {
            let items = self.quadtree.query_point(point);
            items.into_iter()
                .map(|item| item.node_id)
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect()
        }
        
        /// Clear index
        pub fn clear(&mut self) {
            self.quadtree.clear();
            self.item_count = 0;
        }
    }


    // ========================================================================
    // Phase 5: Visual Feedback Structures
    // ========================================================================

    /// Visual feedback data for Shape Builder rendering
    #[derive(Debug, Clone)]
    pub struct ShapeBuilderVisuals {
        pub hovered_shape: Option<String>,
        pub selected_shapes: Vec<String>,
        pub preview_operation: Option<ShapeOperation>,
        pub hover_point: Option<(f64, f64)>,
    }
    
impl Editor {
    /// Render visual feedback for Shape Builder
    pub fn render_shape_builder_feedback(&self, visuals: &ShapeBuilderVisuals) -> Vec<VisualFeedback> {
        let mut feedback = Vec::new();
        
        // Highlight selected shapes
        for shape_id in &visuals.selected_shapes {
            if let Some(node) = self.get_node(shape_id) {
                if let NodeKind::Vector { ref path } = node.kind {
                    feedback.push(VisualFeedback {
                        shape_id: shape_id.clone(),
                        path: path.clone(),
                        style: FeedbackStyle::Selected,
                        opacity: 0.5,
                    });
                }
            }
        }
        
        // Highlight hovered shape
        if let Some(hovered_id) = &visuals.hovered_shape {
            if let Some(node) = self.get_node(hovered_id) {
                if let NodeKind::Vector { ref path } = node.kind {
                    feedback.push(VisualFeedback {
                        shape_id: hovered_id.clone(),
                        path: path.clone(),
                        style: FeedbackStyle::Hovered,
                        opacity: 0.7,
                    });
                }
            }
        }
        
        // Show preview operation
        if let Some(operation) = &visuals.preview_operation {
            match operation {
                ShapeOperation::Merge(shapes) => {
                    // Show merge preview (combined outline)
                    feedback.push(VisualFeedback {
                        shape_id: "preview".to_string(),
                        path: self.generate_merge_preview(shapes),
                        style: FeedbackStyle::Preview,
                        opacity: 0.3,
                    });
                }
                ShapeOperation::Subtract { base, subtract } => {
                    // Show subtract preview
                    feedback.push(VisualFeedback {
                        shape_id: "preview".to_string(),
                        path: self.generate_subtract_preview(base, subtract),
                        style: FeedbackStyle::Preview,
                        opacity: 0.3,
                    });
                }
                _ => {}
            }
        }
        
        feedback
    }
    
}
    /// Visual feedback item for rendering
    #[derive(Debug, Clone)]
    pub struct VisualFeedback {
        pub shape_id: String,
        pub path: Vec<PathCmd>,
        pub style: FeedbackStyle,
        pub opacity: f32,
    }
    
    /// Style of visual feedback
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum FeedbackStyle {
        Selected,   // Blue outline
        Hovered,    // Yellow outline
        Preview,    // Green outline with fill
    }
    
impl Editor {
    /// Generate merge preview path
    fn generate_merge_preview(&self, shapes: &[String]) -> Vec<PathCmd> {
        // Combine all paths
        let mut combined = Vec::new();
        for shape_id in shapes {
            if let Some(node) = self.get_node(shape_id) {
                if let NodeKind::Vector { ref path } = node.kind {
                    combined.extend(path.iter().cloned());
                }
            }
        }
        combined
    }
    
    /// Generate subtract preview path
    fn generate_subtract_preview(&self, base: &str, subtract: &[String]) -> Vec<PathCmd> {
        // For now, just return base path
        // Full implementation would use boolean operations
        if let Some(node) = self.get_node(base) {
            if let NodeKind::Vector { ref path } = node.kind {
                return path.clone();
            }
        }
        Vec::new()
    }


    // ========================================================================
    // Phase 5: Advanced Stroke Cap Features
    // ========================================================================

}
    /// Extended stroke cap types
    #[derive(Debug, Clone, PartialEq)]
    pub enum AdvancedStrokeCap {
        None,
        Round,
        Square,
        Arrow(ArrowStyle),
        Triangle,
        Diamond,
        Circle,
        Bar,
        Custom(Vec<PathCmd>),
    }
    
    /// Arrow style configuration
    #[derive(Debug, Clone, PartialEq)]
    pub struct ArrowStyle {
        pub length_factor: f64,      // Length multiplier (default 1.5)
        pub width_factor: f64,       // Width multiplier (default 0.8)
        pub filled: bool,            // Filled or outline
        pub reversed: bool,          // Point inward
    }
    
    impl Default for ArrowStyle {
        fn default() -> Self {
            Self {
                length_factor: 1.5,
                width_factor: 0.8,
                filled: true,
                reversed: false,
            }
        }
    }
    
    /// Dash pattern configuration
    #[derive(Debug, Clone, PartialEq)]
    pub struct DashPattern {
        pub dashes: Vec<f64>,        // Dash and gap lengths
        pub offset: f64,             // Starting offset
        pub line_cap: LineCap,       // Cap style for dash ends
        pub line_join: LineJoin,     // Join style at corners
    }
    
    impl Default for DashPattern {
        fn default() -> Self {
            Self {
                dashes: vec![10.0, 5.0],  // 10px dash, 5px gap
                offset: 0.0,
                line_cap: LineCap::Butt,
                line_join: LineJoin::Miter,
            }
        }
    }
    
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum LineCap {
        Butt,
        Round,
        Square,
    }
    
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum LineJoin {
        Miter,
        Round,
        Bevel,
    }
    
impl Editor {
    /// Generate advanced stroke cap
    pub fn generate_advanced_cap(&self, cap: &AdvancedStrokeCap, x: f64, y: f64, 
                                  dx: f64, dy: f64, width: f64, is_start: bool) -> Vec<PathCmd> {
        let mut cmds = Vec::new();
        let half_width = width / 2.0;
        
        // Perpendicular direction
        let px = -dy;
        let py = dx;
        
        match cap {
            AdvancedStrokeCap::None => {}
            
            AdvancedStrokeCap::Round => {
                // Round cap: semicircle
                let steps = 16;
                let start_angle = if is_start { std::f64::consts::PI } else { 0.0 };
                let end_angle = if is_start { 2.0 * std::f64::consts::PI } else { std::f64::consts::PI };
                
                cmds.push(PathCmd::MoveTo(x + px * half_width, y + py * half_width));
                for i in 1..=steps {
                    let t = i as f64 / steps as f64;
                    let angle = start_angle + (end_angle - start_angle) * t;
                    let cx = x + half_width * (dx * angle.cos() - px * angle.sin());
                    let cy = y + half_width * (dy * angle.cos() - py * angle.sin());
                    cmds.push(PathCmd::LineTo(cx, cy));
                }
            }
            
            AdvancedStrokeCap::Square => {
                // Square cap: extends half_width beyond endpoint
                let extend = half_width;
                let p1x = x + dx * extend + px * half_width;
                let p1y = y + dy * extend + py * half_width;
                let p2x = x + dx * extend - px * half_width;
                let p2y = y + dy * extend - py * half_width;
                
                cmds.push(PathCmd::MoveTo(x + px * half_width, y + py * half_width));
                cmds.push(PathCmd::LineTo(p1x, p1y));
                cmds.push(PathCmd::LineTo(p2x, p2y));
                cmds.push(PathCmd::LineTo(x - px * half_width, y - py * half_width));
            }
            
            AdvancedStrokeCap::Arrow(style) => {
                // Arrow cap with customizable style
                let length = width * style.length_factor;
                let arrow_width = width * style.width_factor;
                
                let direction = if style.reversed { -1.0 } else { 1.0 };
                
                let tip_x = x + dx * length * direction;
                let tip_y = y + dy * length * direction;
                
                let base1_x = x + px * arrow_width;
                let base1_y = y + py * arrow_width;
                let base2_x = x - px * arrow_width;
                let base2_y = y - py * arrow_width;
                
                if style.filled {
                    cmds.push(PathCmd::MoveTo(base1_x, base1_y));
                    cmds.push(PathCmd::LineTo(tip_x, tip_y));
                    cmds.push(PathCmd::LineTo(base2_x, base2_y));
                    cmds.push(PathCmd::Close);
                } else {
                    cmds.push(PathCmd::MoveTo(base1_x, base1_y));
                    cmds.push(PathCmd::LineTo(tip_x, tip_y));
                    cmds.push(PathCmd::LineTo(base2_x, base2_y));
                }
            }
            
            AdvancedStrokeCap::Triangle => {
                // Triangle cap
                let tri_length = width;
                let tip_x = x + dx * tri_length;
                let tip_y = y + dy * tri_length;
                
                cmds.push(PathCmd::MoveTo(x + px * half_width, y + py * half_width));
                cmds.push(PathCmd::LineTo(tip_x, tip_y));
                cmds.push(PathCmd::LineTo(x - px * half_width, y - py * half_width));
                cmds.push(PathCmd::Close);
            }
            
            AdvancedStrokeCap::Diamond => {
                // Diamond cap
                let size = width;
                let tip_x = x + dx * size;
                let tip_y = y + dy * size;
                let back_x = x - dx * size * 0.5;
                let back_y = y - dy * size * 0.5;
                
                cmds.push(PathCmd::MoveTo(x + px * half_width, y + py * half_width));
                cmds.push(PathCmd::LineTo(tip_x, tip_y));
                cmds.push(PathCmd::LineTo(x - px * half_width, y - py * half_width));
                cmds.push(PathCmd::LineTo(back_x, back_y));
                cmds.push(PathCmd::Close);
            }
            
            AdvancedStrokeCap::Circle => {
                // Circle cap
                let steps = 24;
                let radius = half_width;
                
                for i in 0..=steps {
                    let angle = (i as f64 / steps as f64) * 2.0 * std::f64::consts::PI;
                    let cx = x + radius * angle.cos();
                    let cy = y + radius * angle.sin();
                    
                    if i == 0 {
                        cmds.push(PathCmd::MoveTo(cx, cy));
                    } else {
                        cmds.push(PathCmd::LineTo(cx, cy));
                    }
                }
                cmds.push(PathCmd::Close);
            }
            
            AdvancedStrokeCap::Bar => {
                // Bar cap (perpendicular line)
                let bar_length = width * 1.5;
                
                cmds.push(PathCmd::MoveTo(
                    x + px * bar_length,
                    y + py * bar_length
                ));
                cmds.push(PathCmd::LineTo(
                    x - px * bar_length,
                    y - py * bar_length
                ));
            }
            
            AdvancedStrokeCap::Custom(custom_path) => {
                // Custom path-based cap
                cmds.extend(custom_path.iter().cloned());
            }
        }
        
        cmds
    }
    
    /// Apply dash pattern to path
    pub fn apply_dash_pattern(&self, path: &[PathCmd], pattern: &DashPattern) -> Vec<Vec<PathCmd>> {
        let mut dashed_paths = Vec::new();
        let mut current_path = Vec::new();
        let mut dash_index = 0;
        let mut distance_in_dash = pattern.offset;
        
        // Convert path to segments
        let segments = self.path_to_segments(path);
        
        for segment in segments {
            let (start, end) = segment;
            let segment_length = ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt();
            let mut remaining = segment_length;
            let mut current_pos = start;
            
            while remaining > 0.0 {
                let dash_length = pattern.dashes[dash_index % pattern.dashes.len()];
                let available = dash_length - distance_in_dash;
                let draw_length = remaining.min(available);
                
                // Calculate direction
                let dx = (end.0 - start.0) / segment_length;
                let dy = (end.1 - start.1) / segment_length;
                
                // Calculate next position
                let next_pos = (
                    current_pos.0 + dx * draw_length,
                    current_pos.1 + dy * draw_length
                );
                
                // If this is a dash (even index), add to path
                if dash_index % 2 == 0 {
                    if current_path.is_empty() {
                        current_path.push(PathCmd::MoveTo(current_pos.0, current_pos.1));
                    }
                    current_path.push(PathCmd::LineTo(next_pos.0, next_pos.1));
                } else {
                    // End of dash, start new path
                    if !current_path.is_empty() {
                        dashed_paths.push(current_path);
                        current_path = Vec::new();
                    }
                }
                
                // Update state
                distance_in_dash += draw_length;
                remaining -= draw_length;
                current_pos = next_pos;
                
                // Move to next dash if needed
                if distance_in_dash >= dash_length {
                    distance_in_dash = 0.0;
                    dash_index += 1;
                }
            }
        }
        
        // Add final path if not empty
        if !current_path.is_empty() {
            dashed_paths.push(current_path);
        }
        
        dashed_paths
    }
}

/// Join style for offset paths
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinStyle {
    /// Sharp corner (extended to intersection)
    Miter,
    /// Rounded corner
    Round,
    /// Flat corner (cut with line)
    Bevel,
}

impl Default for JoinStyle {
    fn default() -> Self {
        JoinStyle::Miter
    }
}

/// Ramer-Douglas-Peucker algorithm for path simplification
/// Reduces number of points while maintaining shape within tolerance
fn ramer_douglas_peucker(points: &[(f64, f64)], tolerance: f64) -> Vec<(f64, f64)> {
    if points.len() < 3 {
        return points.to_vec();
    }
    
    // Find the point with maximum distance from line between first and last
    let mut max_distance = 0.0;
    let mut max_index = 0;
    
    let first = points[0];
    let last = points[points.len() - 1];
    
    for i in 1..points.len() - 1 {
        let distance = perpendicular_distance(points[i], first, last);
        if distance > max_distance {
            max_distance = distance;
            max_index = i;
        }
    }
    
    // If max distance is greater than tolerance, recursively simplify
    if max_distance > tolerance {
        // Recursive call for first part
        let mut result = ramer_douglas_peucker(&points[0..=max_index], tolerance);
        
        // Recursive call for second part (excluding the point at max_index to avoid duplication)
        let second_part = ramer_douglas_peucker(&points[max_index..], tolerance);
        
        // Combine results (excluding first point of second part to avoid duplication)
        result.extend(second_part.into_iter().skip(1));
        
        result
    } else {
        // All points are within tolerance, just return first and last
        vec![first, last]
    }
}

/// Calculate perpendicular distance from point to line
fn perpendicular_distance(point: (f64, f64), line_start: (f64, f64), line_end: (f64, f64)) -> f64 {
    let dx = line_end.0 - line_start.0;
    let dy = line_end.1 - line_start.1;
    
    // If line is actually a point, return distance to that point
    if dx == 0.0 && dy == 0.0 {
        let pdx = point.0 - line_start.0;
        let pdy = point.1 - line_start.1;
        return (pdx * pdx + pdy * pdy).sqrt();
    }
    
    // Calculate perpendicular distance using cross product
    let numerator = ((dy * point.0) - (dx * point.1) + (line_end.0 * line_start.1) - (line_end.1 * line_start.0)).abs();
    let denominator = (dx * dx + dy * dy).sqrt();
    
    numerator / denominator
}

/// Smooth corners with rounded joins
fn smooth_corner(points: &[(f64, f64)], radius: f64) -> Vec<(f64, f64)> {
    if points.len() < 3 {
        return points.to_vec();
    }
    
    let mut result = Vec::new();
    result.push(points[0]);
    
    for i in 1..points.len() - 1 {
        let prev = points[i - 1];
        let curr = points[i];
        let next = points[i + 1];
        
        // Calculate vectors
        let v1 = (curr.0 - prev.0, curr.1 - prev.1);
        let v2 = (next.0 - curr.0, next.1 - curr.1);
        
        // Normalize vectors
        let len1 = (v1.0 * v1.0 + v1.1 * v1.1).sqrt();
        let len2 = (v2.0 * v2.0 + v2.1 * v2.1).sqrt();
        
        if len1 > 0.0 && len2 > 0.0 {
            let n1 = (v1.0 / len1, v1.1 / len1);
            let n2 = (v2.0 / len2, v2.1 / len2);
            
            // Calculate arc points
            let arc_start = (curr.0 - n1.0 * radius, curr.1 - n1.1 * radius);
            let arc_end = (curr.0 + n2.0 * radius, curr.1 + n2.1 * radius);
            
            // Add arc points (simplified - just add start and end)
            result.push(arc_start);
            result.push(arc_end);
        } else {
            result.push(curr);
        }
    }
    
    result.push(points[points.len() - 1]);
    result
}


#[derive(Debug, Clone)]
pub struct ShapeRegion {
    pub node_ids: Vec<String>,
    pub intersection_points: Vec<(f64, f64)>,
    pub region_type: RegionType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionType {
    Overlap,
    Exclusive,
    Hole,
}

/// Find intersection points between two paths
fn find_path_intersections(path1: &[PathCmd], path2: &[PathCmd]) -> Vec<(f64, f64)> {
    let mut intersections = Vec::new();
    
    // Convert paths to line segments for simplicity
    let segments1 = path_to_segments(path1);
    let segments2 = path_to_segments(path2);
    
    // Check each pair of segments
    for seg1 in &segments1 {
        for seg2 in &segments2 {
            if let Some(point) = line_segment_intersection(*seg1, *seg2) {
                intersections.push(point);
            }
        }
    }
    
    intersections
}

/// Convert path to line segments
fn path_to_segments(path: &[PathCmd]) -> Vec<((f64, f64), (f64, f64))> {
    let mut segments = Vec::new();
    let mut current_point = None;
    
    for cmd in path {
        match cmd {
            PathCmd::MoveTo(x, y) => {
                current_point = Some((*x, *y));
            }
            PathCmd::LineTo(x, y) => {
                if let Some(prev) = current_point {
                    segments.push((prev, (*x, *y)));
                    current_point = Some((*x, *y));
                }
            }
            PathCmd::CurveTo(_, _, _, _, x, y) => {
                if let Some(prev) = current_point {
                    // Approximate curve as line for intersection detection
                    segments.push((prev, (*x, *y)));
                    current_point = Some((*x, *y));
                }
            }
            PathCmd::Close => {
                current_point = None;
            }
        }
    }
    
    segments
}

/// Find intersection point of two line segments
fn line_segment_intersection(
    seg1: ((f64, f64), (f64, f64)),
    seg2: ((f64, f64), (f64, f64)),
) -> Option<(f64, f64)> {
    let ((x1, y1), (x2, y2)) = seg1;
    let ((x3, y3), (x4, y4)) = seg2;
    
    let denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if denom.abs() < 1e-10 {
        return None; // Parallel lines
    }
    
    let t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    let u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    
    if t >= 0.0 && t <= 1.0 && u >= 0.0 && u <= 1.0 {
        let x = x1 + t * (x2 - x1);
        let y = y1 + t * (y2 - y1);
        Some((x, y))
    } else {
        None
    }
}

/// Mirror mode for bézier handles (Figma parity)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorMode {
    /// No mirroring - handles are independent
    None,
    /// Mirror angle only - handles maintain their lengths
    Angle,
    /// Mirror both angle and length - perfectly symmetric
    AngleAndLength,
}

/// Find intersection point of two line segments
fn line_intersection(
    x1: f64, y1: f64, x2: f64, y2: f64,  // Line 1
    x3: f64, y3: f64, x4: f64, y4: f64,  // Line 2
) -> Option<(f64, f64)> {
    let denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if denom.abs() < 1e-10 {
        return None; // Parallel lines
    }
    
    let t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    let u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    
    if t >= 0.0 && t <= 1.0 && u >= 0.0 && u <= 1.0 {
        let x = x1 + t * (x2 - x1);
        let y = y1 + t * (y2 - y1);
        Some((x, y))
    } else {
        None // Lines don't intersect within segments
    }
}

/// Check if a point is inside a polygon using ray casting algorithm
fn point_in_polygon(x: f64, y: f64, polygon: &[(f64, f64)]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    
    let mut inside = false;
    let mut j = polygon.len() - 1;
    
    for i in 0..polygon.len() {
        let (xi, yi) = polygon[i];
        let (xj, yj) = polygon[j];
        
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    
    inside
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
}
