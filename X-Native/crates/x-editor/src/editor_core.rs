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

/// True when a transform only says WHERE a node sits: translation without
/// rotation, scale or skew. The Section rules below deal in translations, so
/// anything else is refused rather than guessed.
fn plain_translation(t: &Transform) -> bool {
    t.rotation == 0.0 && t.scale_x == 1.0 && t.scale_y == 1.0 && t.skew_x == 0.0 && t.skew_y == 0.0
}

/// The PAGE position of a node's origin: its own translation plus every
/// ancestor's. `None` when an ancestor is not a plain translation — its
/// children's page position is a matrix, not a point.
fn page_pos(n: &Node, id: &str) -> Option<(f64, f64)> {
    for c in &n.children {
        if c.id == id {
            return Some((c.transform.x, c.transform.y));
        }
        if let Some((x, y)) = page_pos(c, id) {
            if !plain_translation(&c.transform) {
                return None;
            }
            return Some((c.transform.x + x, c.transform.y + y));
        }
    }
    None
}

/// The id of a node's direct parent, if it has one.
fn parent_of(n: &Node, id: &str) -> Option<String> {
    for c in &n.children {
        if c.id == id {
            return Some(n.id.clone());
        }
        if let Some(p) = parent_of(c, id) {
            return Some(p);
        }
    }
    None
}

/// Does a subtree carry a Section anywhere? Figma's rule is about the
/// container itself: "Sections ... cannot be contained within frames or
/// groups", and a frame cannot be given one through the back door either.
fn has_section(n: &Node) -> bool {
    matches!(n.kind, NodeKind::Section) || n.children.iter().any(has_section)
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
    /// Figma: a layer *inside* an instance is selectable, and editing one of
    /// its properties stores an override on the instance instead of touching
    /// the master. `(instance id, layer id inside it)`; `None` = not inside.
    pub instance_scope: Option<(String, String)>,
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
            instance_scope: None,
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

    // -- inside an instance -------------------------------------------------
    /// Figma's *select inside*: double-clicking inside an instance selects the
    /// layer under the cursor **inside it**, and every property change from
    /// then on is stored as the instance's override (help 360039150733: *"you
    /// can change the properties of any layer within an instance"*). The
    /// selected id is the **master's** layer id, because that is what an
    /// override targets — an instance carries no children of its own to select.
    pub fn enter_instance(&mut self, p: Point, vars: &x_core::Variables) -> Option<String> {
        let hit = hit_test(&self.root, p)?;
        let instance_id = instance_ancestor(&self.root, &hit)?;
        let layer = self.layer_inside(&instance_id, p, vars)?;
        self.instance_scope = Some((instance_id, layer.clone()));
        self.selection = vec![layer.clone()];
        Some(layer)
    }

    /// Leave the instance: Figma's Esc selects the instance itself again.
    /// Returns true when there was a scope to leave.
    pub fn exit_instance(&mut self) -> bool {
        match self.instance_scope.take() {
            Some((instance_id, _)) => {
                self.selection = vec![instance_id];
                true
            }
            None => false,
        }
    }

    /// The scoped layer as the canvas resolves it — master value with the
    /// instance's override applied. This is what the panels must show while a
    /// layer inside an instance is selected.
    pub fn scoped_layer(&self, vars: &x_core::Variables) -> Option<Node> {
        let (instance_id, layer) = self.instance_scope.clone()?;
        let inst = find(&self.root, &instance_id)?;
        let resolved = x_core::detach_instance(&self.root, inst, vars)?;
        fn take(node: Node, id: &str) -> Option<Node> {
            if node.id == id {
                return Some(node);
            }
            for c in node.children {
                if let Some(found) = take(c, id) {
                    return Some(found);
                }
            }
            None
        }
        take(resolved, &layer)
    }

    /// The deepest master layer under `p` inside `instance_id`: the instance is
    /// swapped for its resolved subtree and the point is asked again, so the
    /// answer comes from the same tree the renderer paints.
    fn layer_inside(
        &self,
        instance_id: &str,
        p: Point,
        vars: &x_core::Variables,
    ) -> Option<String> {
        let inst = find(&self.root, instance_id)?;
        let sentinel = format!("{instance_id}#inside");
        let mut resolved = x_core::detach_instance(&self.root, inst, vars)?;
        resolved.id = sentinel.clone();
        let mut tree = self.root.clone();
        if !replace_in_tree(&mut tree, instance_id, resolved) {
            return None;
        }
        let inside = hit_test(&tree, p)?;
        let group = find(&tree, &sentinel)?;
        if group.id == inside {
            return None;
        }
        find(group, &inside).map(|n| n.id.clone())
    }

    /// Is `id` inside the instance the editor is scoped into? The ids an
    /// override targets are the master's, so the master's tree is the one to
    /// ask.
    fn scope_owns(&self, id: &str) -> bool {
        let Some((instance_id, layer)) = self.instance_scope.as_ref() else {
            return false;
        };
        let Some(inst) = find(&self.root, instance_id) else {
            return false;
        };
        let NodeKind::Instance { component } = &inst.kind else {
            return false;
        };
        let Some(master) = x_core::find_master(&self.root, component) else {
            return false;
        };
        let Some(scope) = find(master, layer) else {
            return false;
        };
        scope.id == id || find(scope, id).is_some()
    }

    /// A write aimed at a layer inside an instance never edits the master
    /// (Figma keeps the master and every other instance untouched). Returns
    /// true when the caller must stop: either the write became an override, or
    /// `v` is `None` — meaning that property is one Figma does not let an
    /// instance override, so the write is refused rather than misdirected.
    fn scope_gate(&mut self, id: &str, v: Option<x_core::OverrideValue>) -> bool {
        if !self.scope_owns(id) {
            return false;
        }
        let Some(v) = v else {
            return true;
        };
        let Some((instance_id, _)) = self.instance_scope.clone() else {
            return true;
        };
        let Some(inst) = find(&self.root, &instance_id).cloned() else {
            return true;
        };
        let mut after = inst;
        x_core::set_exclusive_override(&mut after, id, v);
        self.replace_node(&instance_id, after);
        true
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
        // Figma's list of what an instance does NOT let you override starts
        // with position: a layer inside an instance does not move.
        if self.scope_gate(id, None) {
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
        if self.scope_gate(id, Some(x_core::OverrideValue::Visible(v))) {
            return;
        }
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

    /// Figma's *Use as mask* (`⌘⌥M`; help 360040450253): the bottom-most
    /// selected layer becomes the mask for the layers above it. With several
    /// layers selected Figma wraps them in the mask object it creates — a
    /// group carrying the mask — and that group becomes the selection; a
    /// single layer just flips its own flag. Asking again on a selection that
    /// is all masks clears them, so one gesture is the toggle.
    ///
    /// `Some(true)` means a mask was applied, `Some(false)` that one was
    /// removed, `None` that the selection could not take a mask at all.
    pub fn use_as_mask(&mut self, group_id: &str) -> Option<bool> {
        if self.selection.is_empty() {
            return None;
        }
        let targets: Vec<String> = self
            .selection
            .clone()
            .iter()
            .filter_map(|id| self.mask_section_target(id))
            .collect();
        if targets.len() == self.selection.len() {
            let mut cleared = false;
            for id in targets {
                cleared |= self.set_mask(&id, false);
            }
            return cleared.then_some(false);
        }
        if self.selection.len() == 1 {
            let id = self.selection[0].clone();
            return self.set_mask(&id, true).then_some(true);
        }
        // The mask object's stack is the selection's z-order: park the
        // bottom layer first, where `group_selection` puts the first entry
        // and where the clip rule looks for the mask.
        if let Some(parent) = find_parent_mut(&mut self.root, &self.selection[0]) {
            let mut ordered: Vec<(usize, String)> = self
                .selection
                .iter()
                .filter_map(|id| {
                    parent
                        .children
                        .iter()
                        .position(|c| &c.id == id)
                        .map(|i| (i, id.clone()))
                })
                .collect();
            if ordered.len() == self.selection.len() {
                ordered.sort_by_key(|(i, _)| *i);
                self.selection = ordered.into_iter().map(|(_, id)| id).collect();
            }
        }
        self.group_selection(group_id);
        let bottom = find(&self.root, group_id)
            .and_then(|g| g.children.first())
            .map(|c| c.id.clone());
        let bottom = bottom?;
        let masked = self.set_mask(&bottom, true);
        if masked {
            // one gesture, one undo entry: the mask object and its mask
            self.merge_last(2);
        }
        masked.then_some(true)
    }

    /// Set or clear one layer's mask flag. One `ReplaceNode`, so one undo
    /// entry — the parity sheet's mask rows lean on that.
    pub fn set_mask(&mut self, id: &str, v: bool) -> bool {
        if let Some(n) = find(&self.root, id).filter(|n| n.is_mask != v) {
            let mut after = n.clone();
            after.is_mask = v;
            return self.replace_node(id, after);
        }
        false
    }

    /// The layer the Mask section speaks for: a selected mask, or the mask at
    /// the bottom of a selected mask object — Figma selects the object it just
    /// created, and its Mask section still drives that mask's type.
    pub fn mask_section_target(&self, id: &str) -> Option<String> {
        let n = find(&self.root, id)?;
        if n.is_mask {
            return Some(id.to_string());
        }
        n.children
            .first()
            .filter(|c| c.is_mask)
            .map(|c| c.id.clone())
    }

    /// Figma's **Mask** section (help 360040450253): the type the mask is
    /// applied by. The section speaks for the whole selection, so every
    /// selected mask takes the choice.
    pub fn set_mask_type(&mut self, kind: MaskType) -> bool {
        let ids: Vec<String> = self
            .selection
            .clone()
            .iter()
            .filter_map(|id| self.mask_section_target(id))
            .collect();
        let mut done = false;
        for id in ids {
            if let Some(n) = find(&self.root, &id).filter(|n| n.is_mask && n.mask_type != kind) {
                let mut after = n.clone();
                after.mask_type = kind;
                done |= self.replace_node(&id, after);
            }
        }
        done
    }

    /// Figma's **List style** (help 360040449773): the selected text layers
    /// take the style — the shaper then reserves a marker column and draws
    /// the bullet or the counter in it. Layers that are not text are left
    /// alone, and a write that changes nothing is not an entry.
    pub fn set_list_style(&mut self, style: ListStyle) -> bool {
        let ids: Vec<String> = self
            .selection
            .clone()
            .into_iter()
            .filter(|id| {
                find(&self.root, id).is_some_and(|n| matches!(n.kind, NodeKind::Text { .. }))
            })
            .collect();
        let mut done = false;
        for id in ids {
            if let Some(n) = find(&self.root, &id).filter(|n| n.list_style != style) {
                let mut after = n.clone();
                after.list_style = style;
                done |= self.replace_node(&id, after);
            }
        }
        done
    }

    /// The list style the type-details block shows: the primary selection's,
    /// when that layer is text at all.
    pub fn list_style_of_selection(&self) -> Option<ListStyle> {
        self.selection
            .last()
            .and_then(|id| find(&self.root, id))
            .filter(|n| matches!(n.kind, NodeKind::Text { .. }))
            .map(|n| n.list_style)
    }

    /// The type the Mask section's dropdown shows: the primary selection's,
    /// when it is a mask at all.
    pub fn mask_type_of_selection(&self) -> Option<MaskType> {
        self.selection
            .last()
            .and_then(|id| self.mask_section_target(id))
            .and_then(|id| find(&self.root, &id))
            .map(|n| n.mask_type)
    }

    pub fn move_selection(&mut self, dx: f64, dy: f64) {
        let ids: Vec<String> = self
            .selection
            .iter()
            .filter(|id| !self.scope_owns(id))
            .cloned()
            .collect();
        let cmds = ids
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
        // …and `constraints` and `text bounds` are on the same list: size
        // comes from the master.
        if self.scope_gate(id, None) {
            return;
        }
        if let Some(n) = find(&self.root, id) {
            let cmd = Command::Resize {
                id: id.into(),
                from: (n.w, n.h),
                to: (w, h),
            };
            self.push(vec![cmd]);
        }
    }

    /// Resize a node the way the canvas does (Figma's Constraints): the node
    /// takes the new size and the layers inside it answer their pins — in the
    /// SAME undo entry, so one Ctrl+Z puts the whole picture back.
    pub fn resize_with_constraints(&mut self, id: &str, w: f64, h: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let (ow, oh) = (n.w, n.h);
        let kids = if constrains_children(n) {
            n.children.clone()
        } else {
            Vec::new()
        };
        let mut cmds = vec![Command::Resize {
            id: id.into(),
            from: (ow, oh),
            to: (w, h),
        }];
        pin_commands(&kids, w, h, ow, oh, &mut cmds);
        self.push_cmds(cmds);
        true
    }
    /// Figma's rotation field (`360039956914`): the angle applies to *every*
    /// selected layer, and what is stored follows the panel's convention —
    /// `(-180, 180]`, counting back down past 180 in the direction you came
    /// from. One undo entry for the whole selection.
    pub fn set_selection_rotation(&mut self, deg: f64) -> bool {
        let ids: Vec<String> = self
            .selection
            .iter()
            .filter(|id| !self.scope_owns(id))
            .cloned()
            .collect();
        let to = normalize_degrees(deg).to_radians();
        let cmds: Vec<Command> = ids
            .iter()
            .filter_map(|id| {
                let n = find(&self.root, id)?;
                Some(Command::Rotate {
                    id: id.clone(),
                    from: n.transform.rotation,
                    to,
                })
            })
            .collect();
        if cmds.is_empty() {
            return false;
        }
        self.push(cmds);
        true
    }

    /// Figma's canvas rotate: every selected layer turns about `pivot` by
    /// `delta` radians. `base` is the selection as it stood when the gesture
    /// began (`id → x, y, rotation`), so a live drag can ask for the *total*
    /// delta on every move — the last move wins instead of compounding, and the
    /// app merges the gesture into one undo entry on release.
    ///
    /// The pivot is `(x + origin_x·w, y + origin_y·h)` for a layer whose own
    /// origin the user moved, and the selection's centre otherwise — which is
    /// Figma's rule: *"Figma uses the horizontal and vertical center of the
    /// current selection as the point of rotation by default. You can change an
    /// object's rotation origin so that it will rotate around a different
    /// point."*
    pub fn rotate_selection_from(
        &mut self,
        base: &[(String, f64, f64, f64)],
        pivot: (f64, f64),
        delta: f64,
    ) -> bool {
        let mut cmds: Vec<Command> = Vec::new();
        for (id, bx, by, brot) in base {
            if self.scope_owns(id) {
                continue;
            }
            let Some(n) = find(&self.root, id) else {
                continue;
            };
            let (w, h) = (n.w, n.h);
            let mut t = n.transform;
            t.x = *bx;
            t.y = *by;
            t.rotation = *brot;
            t.rotate_about(w, h, pivot, delta);
            cmds.push(Command::Rotate {
                id: id.clone(),
                from: n.transform.rotation,
                to: normalize_degrees(t.rotation.to_degrees()).to_radians(),
            });
            cmds.push(Command::Move {
                id: id.clone(),
                dx: t.x - n.transform.x,
                dy: t.y - n.transform.y,
            });
        }
        if cmds.is_empty() {
            return false;
        }
        self.push(cmds);
        true
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
    /// Set a node's corner radius: uniform `radius` + optional per-corner
    /// overrides (None = uniform mode). Figma's radius applies to rectangles
    /// AND frames (help 360050986854); a frame has no uniform field of its own,
    /// so the command resolves its uniform value into four equal corners.
    /// Undoable.
    pub fn set_corners(&mut self, id: &str, radius: f64, corners: Option<[f64; 4]>) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let from = match &n.kind {
            NodeKind::Rect { radius } => (*radius, n.corner_radii),
            NodeKind::Frame { .. } => (0.0, n.corner_radii),
            _ => return false,
        };
        // A frame has no radius field of its own, so a uniform radius has to
        // LAND as four equal corners; a caller that passes an array (or the
        // reverse entry of an undo) is already explicit.
        let to = match &n.kind {
            NodeKind::Frame { .. } => corners.or(Some([radius.max(0.0); 4])),
            _ => corners,
        };
        self.push(vec![Command::SetCorners {
            id: id.into(),
            from,
            to: (radius, to),
        }]);
        true
    }

    /// The uniform corner radius on whatever carries one — a rect's own field,
    /// or a frame's four equal corners.
    pub fn set_uniform_radius(&mut self, id: &str, r: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        match n.kind {
            NodeKind::Rect { .. } => self.set_corners(id, r, None),
            NodeKind::Frame { .. } => self.set_corners(id, r, Some([r.max(0.0); 4])),
            _ => false,
        }
    }

    /// ONE corner's radius — Figma's **Independent corners**. The uniform value
    /// a rect keeps in its kind is left alone, so putting the corners back to
    /// uniform returns the radius the layer had before.
    pub fn set_corner_radius(&mut self, id: &str, corner: usize, r: f64) -> bool {
        if corner >= 4 {
            return false;
        }
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let base = match &n.kind {
            NodeKind::Rect { radius } => *radius,
            NodeKind::Frame { .. } => 0.0,
            _ => return false,
        };
        let mut radii = n.corner_radii.unwrap_or([base; 4]);
        radii[corner] = r.max(0.0);
        self.set_corners(id, base, Some(radii))
    }

    /// Corner smoothing — Figma's *Corner smoothing* slider, 0–1 here and 0–100%
    /// on screen. Only the whole shape carries it, so one write is one entry.
    pub fn set_corner_smoothing(&mut self, id: &str, v: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, NodeKind::Rect { .. } | NodeKind::Frame { .. }) {
            return false;
        }
        // the slider re-reads its value on every move: a write that changes
        // nothing is not an entry
        let v = v.clamp(0.0, 1.0);
        if (n.corner_smoothing - v).abs() < 1e-9 {
            return false;
        }
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.corner_smoothing = v;
        after.dirty = true;
        self.push_replace(id, before, after);
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
        // Inside an instance a solid fill is an override; a gradient or an
        // image is a paint the override model has no shape for, so it is
        // refused rather than written into the master.
        let solid = match &paint {
            Paint::Solid(c) => Some(x_core::OverrideValue::Fill(*c)),
            _ => None,
        };
        if self.scope_gate(id, solid) {
            return;
        }
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

    /// Replace the picture of an image layer. Figma's *Place image* with an
    /// image layer selected swaps the file rather than painting a fill over
    /// it, and the crop and fit mode stay: they describe how the layer shows
    /// a picture, not which one (help 360040675194).
    pub fn set_image_asset(&mut self, id: &str, asset: &str) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let mut after = n.clone();
        if let NodeKind::Image { asset: current, .. } = &mut after.kind {
            if current == asset {
                return false;
            }
            *current = asset.to_string();
        } else {
            return false;
        }
        self.replace_node(id, after)
    }

    /// Set an image layer's fill mode (Figma's Fill mode menu). One entry.
    pub fn set_image_fit(&mut self, id: &str, fit: ImageFit) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let mut after = n.clone();
        match &mut after.kind {
            NodeKind::Image { fit: current, .. } => {
                if *current == fit {
                    return false;
                }
                *current = fit;
            }
            _ => return false,
        }
        self.replace_node(id, after)
    }

    /// Set an image layer's crop — focal point, zoom and flips (help
    /// 360040675194). The crop gesture's one writer; a crop session folds its
    /// entries into one when it is applied. One entry.
    pub fn set_image_placement(&mut self, id: &str, placement: ImagePlacement) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let mut after = n.clone();
        match &mut after.kind {
            NodeKind::Image {
                placement: current, ..
            } => {
                if *current == placement {
                    return false;
                }
                *current = placement;
            }
            _ => return false,
        }
        self.replace_node(id, after)
    }

    /// Figma's **Resize to fit** (help 360040675194): the layer becomes the
    /// size of the whole picture, uncropped. Box, focal point and zoom in ONE
    /// entry, because they only mean anything together.
    pub fn fit_image_to_picture(&mut self, id: &str, iw: f64, ih: f64) -> bool {
        let (iw, ih) = (iw.max(1.0), ih.max(1.0));
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let mut after = n.clone();
        if !matches!(after.kind, NodeKind::Image { .. }) {
            return false;
        }
        let clean = match &after.kind {
            NodeKind::Image { fit, placement, .. } => {
                *fit == ImageFit::Crop && *placement == ImagePlacement::default()
            }
            _ => false,
        };
        if clean && (after.w - iw).abs() < 1e-6 && (after.h - ih).abs() < 1e-6 {
            // already the picture's size with a clean crop: nothing to write
            return false;
        }
        after.w = iw;
        after.h = ih;
        if let NodeKind::Image { fit, placement, .. } = &mut after.kind {
            *fit = ImageFit::Crop;
            *placement = ImagePlacement::default();
        }
        after.dirty = true;
        self.replace_node(id, after)
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
        sync_legacy_effects(&mut after);
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
        if effect_at(&self.root, id, index).is_none() {
            return false;
        }
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
        if effect_at(&self.root, id, from).is_none() || effect_at(&self.root, id, to).is_none() {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if from < n.effect_layers.len() && to < n.effect_layers.len() {
                let v = n.effect_layers.remove(from);
                n.effect_layers.insert(to, v);
            }
        })
    }
    /// Toggle one effect off/on (Figma's per-effect eye). The effect keeps its
    /// settings; it just stops painting — which is Figma's own reason for the
    /// control: *"you can toggle the visibility of individual effects"*.
    pub fn set_effect_layer_visible(&mut self, id: &str, index: usize, visible: bool) -> bool {
        if effect_at(&self.root, id, index).is_none() {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if let Some(l) = n.effect_layers.get_mut(index) {
                l.visible = visible;
            }
        })
    }

    /// Switch an effect to another type (Figma's per-row dropdown). The new
    /// effect starts from that type's own defaults; the layer keeps its
    /// visibility and blend, which belong to the row rather than the effect.
    pub fn set_effect_kind(&mut self, id: &str, index: usize, kind: EffectKind) -> bool {
        if effect_at(&self.root, id, index).is_none() {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if let Some(l) = n.effect_layers.get_mut(index) {
                l.effect = Effect::default_of(kind);
            }
        })
    }

    /// Write one numeric setting of one effect (X / Y / Blur / Radius /
    /// Density — see [`Effect::fields`]).
    pub fn set_effect_field(&mut self, id: &str, index: usize, field: EffectField, v: f64) -> bool {
        if effect_at(&self.root, id, index).is_none() {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if let Some(l) = n.effect_layers.get_mut(index) {
                l.effect.set_field(field, v);
            }
        })
    }

    /// A shadow's **Fill** (its colour). Only the shadow kinds carry one, so
    /// the write is refused for the others rather than silently dropped.
    pub fn set_effect_color(&mut self, id: &str, index: usize, color: Color) -> bool {
        if !effect_at(&self.root, id, index).is_some_and(|e| e.color().is_some()) {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if let Some(l) = n.effect_layers.get_mut(index) {
                l.effect.set_color(color);
            }
        })
    }

    /// One effect's blend mode (Figma: *"Apply a blend mode to an effect"* for
    /// inner shadow, drop shadow and noise). `Pass through` is refused here —
    /// it cannot be applied to an effect.
    pub fn set_effect_layer_blend(&mut self, id: &str, index: usize, blend: BlendKind) -> bool {
        if blend == BlendKind::PassThrough || effect_at(&self.root, id, index).is_none() {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if let Some(l) = n.effect_layers.get_mut(index) {
                l.blend = blend;
            }
        })
    }

    /// Duplicate an effect in place (`⌘D` on a selected effect copies its
    /// settings — Figma's *"duplicate the effect"*).
    pub fn duplicate_effect_layer(&mut self, id: &str, index: usize) -> bool {
        if effect_at(&self.root, id, index).is_none() {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if let Some(l) = n.effect_layers.get(index).cloned() {
                n.effect_layers.insert(index + 1, l);
            }
        })
    }

    /// The whole layer's blend mode: Figma's **Apply blend mode** in the
    /// Appearance section, where `Pass through` IS allowed (it is the default
    /// for layers).
    pub fn set_layer_blend(&mut self, id: &str, blend: BlendKind) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let mut after = n.clone();
        after.blend = blend;
        after.dirty = true;
        self.push_replace(id, Box::new(n.clone()), after);
        true
    }

    /// One fill's or stroke's blend mode (Figma: *"Open the color picker in
    /// the Fill or Stroke sections … then click Apply blend mode"*). `Pass
    /// through` is refused: it cannot be applied to a paint.
    pub fn set_paint_layer_blend(
        &mut self,
        id: &str,
        is_fill: bool,
        index: usize,
        blend: BlendKind,
    ) -> bool {
        if blend == BlendKind::PassThrough {
            return false;
        }
        // A node whose paints still live in the flat `fill` / `stroke` fields
        // has an empty `fill_layers`, so the question "does that paint exist?"
        // has to be asked of the *materialized* stack: materializing is what
        // turns the flat fill into layer 0. (Without this, a blend picked on a
        // layer nobody had touched yet wrote nothing at all.)
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let mut probe = n.clone();
        probe.materialize_visual_stacks();
        // `PaintLayer` and `StrokeLayer` are different types, but their lengths
        // are both `usize`, so the two branches can share this binding.
        let present = if is_fill {
            index < probe.fill_layers.len()
        } else {
            index < probe.stroke_layers.len()
        };
        if !present {
            return false;
        }
        self.mutate_visual_stack(id, move |n| {
            if is_fill {
                if let Some(l) = n.fill_layers.get_mut(index) {
                    l.blend = blend;
                }
            } else if let Some(l) = n.stroke_layers.get_mut(index) {
                l.blend = blend;
            }
        })
    }

    pub fn set_text(&mut self, id: &str, text: &str) {
        let overridable = matches!(
            find(&self.root, id).map(|n| &n.kind),
            Some(NodeKind::Text { .. })
        );
        if self.scope_gate(
            id,
            overridable.then(|| x_core::OverrideValue::Text(text.into())),
        ) {
            return;
        }
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
    /// uniformly — sizes, child offsets, strokes, corner radii, text, effects
    /// and auto layout. One undoable ReplaceNode. The anchor is the node's own
    /// origin, so a node scales IN PLACE (Figma's numeric scale).
    pub fn scale_node(&mut self, id: &str, factor: f64) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let (ax, ay) = (n.transform.x, n.transform.y);
        self.scale_nodes_about(&[(id.to_string(), ax, ay)], factor)
    }

    /// Figma's Scale tool (K): scale every listed node — and its subtree — by
    /// `factor` about `(ax, ay)`, a point of that node's PARENT space (the
    /// space `transform.x/y` live in). The anchor is the fixed point of the
    /// mapping, which is what pins the corner you are not dragging: grab the
    /// bottom-right handle and the top-left corner stays exactly where it was.
    ///
    /// A listed node whose ANCESTOR is also listed is skipped — its scale is
    /// already part of that subtree's, and applying both would scale it twice.
    /// Every `ReplaceNode` goes into ONE undo step, so scaling a ten-layer
    /// selection is a single Ctrl+Z.
    ///
    /// What travels with the size is Figma's list, not just w/h: child
    /// offsets, stroke weight, dashes, corner radius, text size and leading,
    /// the distances inside effects, and auto-layout padding/gap.
    pub fn scale_nodes_about(&mut self, parts: &[(String, f64, f64)], factor: f64) -> bool {
        if parts.is_empty() || !factor.is_finite() || factor <= 0.0 {
            return false;
        }
        if factor == 1.0 {
            return true;
        }
        // Shadows and blurs are distances, so they scale with the box. A
        // noise AMOUNT is a ratio — 0.4 grain is 0.4 grain at any size.
        fn scale_effect(e: &mut Effect, f: f64) {
            match e {
                Effect::DropShadow { dx, dy, blur, .. }
                | Effect::InnerShadow { dx, dy, blur, .. } => {
                    *dx *= f;
                    *dy *= f;
                    *blur *= f;
                }
                Effect::LayerBlur { radius } | Effect::BackgroundBlur { radius } => *radius *= f,
                Effect::Noise { .. } => {}
            }
        }
        fn scale_subtree(n: &mut Node, f: f64, scale_own_pos: bool) {
            if scale_own_pos {
                n.transform.x *= f;
                n.transform.y *= f;
            }
            n.w *= f;
            n.h *= f;
            n.stroke.width *= f;
            // Text metrics are px values in the BINDINGS — `fs` point size,
            // `ls` tracking, `ps`/`pi` paragraph distance, `lhpx` an absolute
            // line height — so the Scale tool takes them with the box. That is
            // the whole difference from the Move tool's handles, which leave
            // font size alone. The other line-height modes are relative and
            // follow by construction: a percentage rides the size up on its
            // own and a multiple never was px.
            for key in ["fs", "ls", "ps", "pi", "lhpx"] {
                if let Some(px) = n.bindings.get(key).and_then(|v| v.parse::<f64>().ok()) {
                    n.bindings.insert(key.into(), (px * f).to_string());
                }
            }
            n.paragraph_spacing *= f;
            n.paragraph_indent *= f;
            for run in &mut n.text_runs {
                if let Some(size) = &mut run.size {
                    *size *= f;
                }
                if let Some(ls) = &mut run.ls {
                    *ls *= f;
                }
            }
            // stroke stacks: weight and the dash/gap pattern are distances
            for layer in &mut n.stroke_layers {
                layer.stroke.width *= f;
                for d in layer.options.dash.iter_mut() {
                    *d *= f;
                }
                layer.options.dash_offset *= f;
            }
            scale_effect_both(&mut n.effects, &mut n.effect_layers, f, scale_effect);
            // auto layout: padding and gap travel with the frame
            if let NodeKind::Frame {
                layout: Some(layout),
            } = &mut n.kind
            {
                layout.gap *= f;
                for side in layout.padding.iter_mut() {
                    *side *= f;
                }
            }
            for grid in &mut n.layout_grids {
                grid.gutter *= f;
                grid.margin *= f;
                grid.cell *= f;
            }
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
                        PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
                            *x *= f;
                            *y *= f;
                        }
                        PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                            *x1 *= f;
                            *y1 *= f;
                            *x2 *= f;
                            *y2 *= f;
                            *x *= f;
                            *y *= f;
                        }
                        PathCmd::Close => {}
                    }
                }
            }
            for c in &mut n.children {
                scale_subtree(c, f, true);
            }
        }
        // The legacy `effects` list and the ordered `effect_layers` stack are
        // two encodings of the same idea; a node may carry either or both,
        // and each entry scales exactly once.
        fn scale_effect_both(
            legacy: &mut [Effect],
            layers: &mut [EffectLayer],
            f: f64,
            one: fn(&mut Effect, f64),
        ) {
            for e in legacy.iter_mut() {
                one(e, f);
            }
            for layer in layers.iter_mut() {
                one(&mut layer.effect, f);
            }
        }
        // Is `id` inside a subtree that the same gesture already scales?
        fn nested_in_listed(n: &Node, id: &str, listed: &[&str], ancestor_listed: bool) -> bool {
            if n.id == id {
                return ancestor_listed;
            }
            let now = ancestor_listed || listed.contains(&n.id.as_str());
            n.children
                .iter()
                .any(|c| nested_in_listed(c, id, listed, now))
        }

        let listed: Vec<&str> = parts.iter().map(|(id, _, _)| id.as_str()).collect();
        let mut cmds = Vec::new();
        for (id, ax, ay) in parts {
            if nested_in_listed(&self.root, id, &listed, false) {
                continue;
            }
            let Some(n) = find(&self.root, id) else {
                continue;
            };
            // Figma: "You can scale any object, with the exception of locked
            // layers and layers nested inside a component instance." A locked
            // layer refuses every gesture, so it is skipped here too.
            if n.locked {
                continue;
            }
            let before = Box::new(n.clone());
            let mut after = n.clone();
            // the anchor is the fixed point: x' = ax + (x - ax) * f
            after.transform.x = ax + (n.transform.x - ax) * factor;
            after.transform.y = ay + (n.transform.y - ay) * factor;
            scale_subtree(&mut after, factor, false);
            cmds.push(Command::ReplaceNode {
                id: id.clone(),
                before,
                after: Box::new(after),
            });
        }
        if cmds.is_empty() {
            return false;
        }
        self.push(cmds);
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

    /// Figma's per-frame **Show name** switch: whether the canvas paints this
    /// frame's name label. Undoable, like every other layer property.
    pub fn set_show_name(&mut self, id: &str, show: bool) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        after.show_name = show;
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }

    /// Set one layer's **scroll position** inside its scrolling frame —
    /// Figma's Prototype-tab "Scroll behavior → Position" (Scroll with parent
    /// / Fixed / Sticky). One undoable ReplaceNode, like every other layer
    /// property; the flags it writes are the ones the renderer already honours.
    pub fn set_scroll_position(&mut self, id: &str, pos: x_core::ScrollPosition) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        let before = Box::new(n.clone());
        let mut after = n.clone();
        pos.apply(&mut after.constraints);
        after.dirty = true;
        self.push_replace(id, before, after);
        true
    }

    /// The preview's own scroll offset for a frame. This is **view state, not a
    /// document edit**: the flow player writes it in place (no command, no undo
    /// entry) and clears it when the preview opens and closes, the way the
    /// preview owns its copy of the variables. Authoring scroll uses
    /// [`Editor::set_scroll`], which is undoable.
    pub fn set_scroll_preview(&mut self, id: &str, x: f64, y: f64) -> bool {
        match find_mut(&mut self.root, id) {
            Some(n) => {
                n.scroll = (x, y);
                true
            }
            None => false,
        }
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
        if self.scope_gate(id, Some(x_core::OverrideValue::Opacity(v))) {
            return;
        }
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

    /// Wrap the current selection in a labelled Section container.
    ///
    /// Figma's own rule stands behind the two paths here: "Sections in Figma
    /// Design are a top-level element on the canvas by default. Sections can
    /// contain all layer types, including other sections, but cannot be
    /// contained within frames or groups." A selection that already lives on
    /// the canvas — or inside another section — is wrapped in place; one that
    /// lives inside a frame or a group is LIFTED to the canvas first, keeping
    /// its place, so the section lands around it rather than inside a frame.
    pub fn section_selection(&mut self, section_id: &str) {
        if section_id.is_empty() || find(&self.root, section_id).is_some() {
            return;
        }
        if self.selection.is_empty() {
            return;
        }
        let first = self.selection[0].clone();
        let parent_id = match find_parent_mut(&mut self.root, &first) {
            Some(p) => p.id.clone(),
            None => return,
        };
        let allowed = match find(&self.root, &parent_id) {
            Some(p) => matches!(p.kind, NodeKind::Section),
            None => return,
        };
        if !allowed && parent_id != self.root.id {
            self.lift_into_section(section_id);
            return;
        }
        let snapshot = self.root.clone();
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

    /// Wrap a selection that sits inside a frame or a group in a Section that
    /// lands on the canvas. The members keep their place on the page — their
    /// page positions are computed first, the section is drawn around them,
    /// and each member is moved into it by the difference. A rotated or
    /// scaled ancestor stops the lift and nothing changes: the page position
    /// of that subtree is a matrix, and a wrong lift would be worse than none.
    fn lift_into_section(&mut self, section_id: &str) -> bool {
        /// One member of the lift: where it is now and where it sits on the
        /// page. `from_index` is resolved by id at apply, so it cannot drift.
        struct Placed {
            id: String,
            from_parent: String,
            from_index: usize,
            px: f64,
            py: f64,
            lx: f64,
            ly: f64,
            w: f64,
            h: f64,
        }
        let members = self.selected_roots();
        if members.is_empty() {
            return false;
        }
        let mut placed: Vec<Placed> = vec![];
        for id in &members {
            let Some((px, py)) = page_pos(&self.root, id) else {
                return false;
            };
            let Some(n) = find(&self.root, id) else {
                return false;
            };
            let Some(from_parent) = parent_of(&self.root, id) else {
                return false;
            };
            let Some(from_index) = find(&self.root, &from_parent)
                .and_then(|p| p.children.iter().position(|c| c.id == *id))
            else {
                return false;
            };
            placed.push(Placed {
                id: id.clone(),
                from_parent,
                from_index,
                px,
                py,
                lx: n.transform.x,
                ly: n.transform.y,
                w: n.w,
                h: n.h,
            });
        }
        let x0 = placed.iter().map(|p| p.px).fold(f64::INFINITY, f64::min);
        let y0 = placed.iter().map(|p| p.py).fold(f64::INFINITY, f64::min);
        let x1 = placed
            .iter()
            .map(|p| p.px + p.w)
            .fold(f64::NEG_INFINITY, f64::max);
        let y1 = placed
            .iter()
            .map(|p| p.py + p.h)
            .fold(f64::NEG_INFINITY, f64::max);
        let mut sec = Node::section(section_id, x1 - x0, y1 - y0);
        sec.transform.x = x0;
        sec.transform.y = y0;
        let mut cmds = vec![Command::Insert {
            parent_id: self.root.id.clone(),
            index: self.root.children.len(),
            node: sec,
        }];
        for (k, p) in placed.iter().enumerate() {
            cmds.push(Command::ReorderNode {
                id: p.id.clone(),
                from_parent: p.from_parent.clone(),
                from_index: p.from_index,
                to_parent: section_id.into(),
                index: k,
            });
            // the reorder keeps the member's local transform: this moves it
            // from where it was inside its frame to where it was on the page
            cmds.push(Command::Move {
                id: p.id.clone(),
                dx: p.px - x0 - p.lx,
                dy: p.py - y0 - p.ly,
            });
        }
        self.push(cmds);
        self.selection = vec![section_id.to_string()];
        true
    }

    /// Figma's "Add objects to a section": "You can also click and drag a
    /// section over the objects you want to add to it." Every SIBLING layer
    /// the section completely covers — section, frame, shape or text — joins
    /// it, keeping its place on the canvas. This is the one rule behind both
    /// the drag that creates a section over a design and the drag that moves
    /// one onto it. Returns how many layers moved; 0 is the common answer.
    pub fn section_absorb(&mut self, section_id: &str) -> usize {
        let Some(sec) = find(&self.root, section_id) else {
            return 0;
        };
        if !matches!(sec.kind, NodeKind::Section) || !plain_translation(&sec.transform) {
            return 0;
        }
        let (sx, sy, sw, sh) = (sec.transform.x, sec.transform.y, sec.w, sec.h);
        let Some(parent_id) = parent_of(&self.root, section_id) else {
            return 0;
        };
        let mut taken: Vec<String> = vec![];
        {
            let Some(parent) = find(&self.root, &parent_id) else {
                return 0;
            };
            for c in &parent.children {
                // a locked layer stays where it is, and a rotated one cannot
                // be placed inside the section's own frame of reference
                if c.id == section_id || c.locked || !plain_translation(&c.transform) {
                    continue;
                }
                let inside = c.transform.x >= sx - 0.5
                    && c.transform.y >= sy - 0.5
                    && c.transform.x + c.w <= sx + sw + 0.5
                    && c.transform.y + c.h <= sy + sh + 0.5;
                if inside {
                    taken.push(c.id.clone());
                }
            }
        }
        if taken.is_empty() {
            return 0;
        }
        let mut cmds: Vec<Command> = vec![];
        for (k, id) in taken.iter().enumerate() {
            cmds.push(Command::ReorderNode {
                id: id.clone(),
                from_parent: parent_id.clone(),
                from_index: k, // resolved by id at apply
                to_parent: section_id.to_string(),
                index: k,
            });
            // a sibling of the section is a page-level node, so its position
            // on the page IS its local one: joining the section is a shift by
            // the section's own origin, and its place on the page is kept
            cmds.push(Command::Move {
                id: id.clone(),
                dx: -sx,
                dy: -sy,
            });
        }
        let n = taken.len();
        self.push(cmds);
        n
    }

    /// Figma's second delete — "To delete a section without deleting its
    /// contents", Command+Delete on a Mac and Control+Backspace on Windows:
    /// the container goes, its children stay, promoted to the container's
    /// parent with their place on the canvas kept. Plain layers, containers
    /// with nothing to keep, and rotated containers (whose children's page
    /// positions are a matrix) delete the ordinary way. Returns how many
    /// layers were promoted.
    pub fn delete_keeping_contents(&mut self) -> usize {
        let mut cmds: Vec<Command> = vec![];
        let mut promoted = 0usize;
        for id in self.selected_roots() {
            let Some(node) = find(&self.root, &id).cloned() else {
                continue;
            };
            let container = matches!(
                node.kind,
                NodeKind::Group | NodeKind::Section | NodeKind::Frame { .. }
            );
            let ordinary =
                !container || node.children.is_empty() || !plain_translation(&node.transform);
            if ordinary {
                if let Some(p) = find_parent_mut(&mut self.root, &id) {
                    if let Some(i) = p.children.iter().position(|c| c.id == id) {
                        cmds.push(Command::Delete {
                            parent_id: p.id.clone(),
                            index: i,
                            node: p.children[i].clone(),
                        });
                    }
                }
                continue;
            }
            let Some(parent_id) = parent_of(&self.root, &id) else {
                continue;
            };
            let Some(index) = find(&self.root, &parent_id)
                .and_then(|p| p.children.iter().position(|c| c.id == id))
            else {
                continue;
            };
            let (ox, oy) = (node.transform.x, node.transform.y);
            cmds.push(Command::Delete {
                parent_id: parent_id.clone(),
                index,
                node: node.clone(),
            });
            for (k, child) in node.children.iter().enumerate() {
                cmds.push(Command::Insert {
                    parent_id: parent_id.clone(),
                    index: index + k,
                    node: child.clone(),
                });
                if ox != 0.0 || oy != 0.0 {
                    cmds.push(Command::Move {
                        id: child.id.clone(),
                        dx: ox,
                        dy: oy,
                    });
                }
            }
            promoted += node.children.len();
        }
        if !cmds.is_empty() {
            self.push(cmds);
        }
        self.selection.clear();
        promoted
    }

    /// Figma "Frame selection" (⌥⌘G): wrap the current selection in a new
    /// Frame sized to the members' collective AABB. Works with a single node
    /// (unlike group, which needs 2+). Snapshot-undo, like group.
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

    /// The instance's change list — Figma's More-actions menu *"only lists
    /// properties that have changes applied"* (help 360039150733).
    pub fn instance_changes(&self, id: &str) -> Vec<x_core::InstanceChange> {
        match find(&self.root, id) {
            Some(n) if matches!(n.kind, x_core::NodeKind::Instance { .. }) => {
                x_core::instance_changes(n)
            }
            _ => Vec::new(),
        }
    }

    /// Reset ONE change on an instance: Figma's *"Reset > Reset [property]"*.
    /// Undoable; false when that layer had no override to reset.
    pub fn reset_one_override(&mut self, id: &str, target: &str) -> bool {
        let Some(n) = find(&self.root, id) else {
            return false;
        };
        if !matches!(n.kind, x_core::NodeKind::Instance { .. }) {
            return false;
        }
        let mut after = n.clone();
        if !x_core::reset_override(&mut after, target) {
            return false;
        }
        self.replace_node(id, after)
    }

    /// Reset the changes on ONE LAYER of an instance: Figma's *"select a
    /// specific layer to view changes for that layer only"* then *"Reset all
    /// changes"*. Returns how many overrides went; undoable when any did.
    pub fn reset_layer_overrides(&mut self, id: &str, layer: &str) -> usize {
        let Some(n) = find(&self.root, id) else {
            return 0;
        };
        if !matches!(n.kind, x_core::NodeKind::Instance { .. }) {
            return 0;
        }
        let mut after = n.clone();
        let changed = x_core::reset_layer_overrides(&mut after, layer);
        if changed > 0 {
            self.replace_node(id, after);
        }
        changed
    }

    /// Figma's **push changes to main component** (help 360039150733): the
    /// instance's overrides are written into its master, so the change lands
    /// on every other instance of that component. Undoable; returns how many
    /// master layers changed, 0 when the master is not in this document.
    pub fn push_overrides_to_main(&mut self, id: &str) -> usize {
        let Some(n) = find(&self.root, id) else {
            return 0;
        };
        if !matches!(n.kind, x_core::NodeKind::Instance { .. }) {
            return 0;
        }
        let mut after = self.root.clone();
        let changed = x_core::push_overrides_to_master(&mut after, id);
        if changed > 0 {
            let root_id = self.root.id.clone();
            self.replace_node(&root_id, after);
        }
        changed
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
        // Figma's rule, enforced where the tree is written rather than in each
        // caller: a section is a top-level element and "cannot be contained
        // within frames or groups". The page is a frame in this model, so the
        // canvas itself is exempt BY IDENTITY, not by kind.
        if parent_id != self.root.id
            && matches!(parent.kind, NodeKind::Frame { .. } | NodeKind::Group)
            && nodes.iter().any(has_section)
        {
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
        let before = Box::new(self.root.clone());
        let mut after = self.root.clone();
        if !rename_master_in(&mut after, old, new) {
            return false;
        }
        let root_id = self.root.id.clone();
        self.push_replace(&root_id, before, after);
        true
    }

    /// Combine the selected components into one variant set. The set is a
    /// **frame holding the masters** — which is what makes Figma's rule "a set
    /// can contain only components" true by construction. A frame that already
    /// holds nothing but the selection becomes the set; otherwise a new frame
    /// is built around them. Each master is renamed to `{set}/{variant}` (the
    /// variant part keeps its own name) and every instance follows the rename.
    /// One undo entry for the whole combine. Returns how many masters the set
    /// holds.
    pub fn combine_as_variants(&mut self, set_name: &str) -> usize {
        let set_name = set_name.trim();
        if set_name.is_empty() {
            return 0;
        }
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
        let mut ids: Vec<String> = vec![];
        for n in &names {
            if let Some(m) = find_master(&self.root, n) {
                if !ids.contains(&m.id) {
                    ids.push(m.id.clone());
                }
            }
        }
        if ids.len() < 2 {
            return 0;
        }

        let before = Box::new(self.root.clone());
        let mut after = self.root.clone();

        // --- the container: an existing frame, or a new one around them
        // A container that already holds nothing but the selection becomes the
        // set. The page itself is not a container in that sense — Figma never
        // turns the canvas into a set — so loose masters get a frame of their
        // own even when the page holds nothing else.
        let page_id = self.root.id.clone();
        let holds_only_the_selection = common_parent_id(&after, &ids)
            .filter(|pid| *pid != page_id)
            .and_then(|pid| find(&after, &pid).map(|p| (pid, p)))
            .filter(|(_, p)| {
                matches!(p.kind, NodeKind::Frame { .. } | NodeKind::Section)
                    && p.children.len() == ids.len()
                    && p.children.iter().all(|c| ids.contains(&c.id))
            })
            .map(|(pid, _)| pid);
        if let Some(pid) = holds_only_the_selection {
            if let Some(p) = find_mut(&mut after, &pid) {
                p.name = set_name.to_string();
            }
        } else {
            let mut bounds: Option<(f64, f64, f64, f64)> = None;
            for id in &ids {
                if let Some(m) = find(&after, id) {
                    let (x, y) = (m.transform.x, m.transform.y);
                    bounds = Some(match bounds {
                        None => (x, y, x + m.w, y + m.h),
                        Some((x0, y0, x1, y1)) => {
                            (x0.min(x), y0.min(y), x1.max(x + m.w), y1.max(y + m.h))
                        }
                    });
                }
            }
            let (bx, by, bw, bh) = bounds.unwrap_or((0.0, 0.0, 0.0, 0.0));
            // the first master's slot: the set takes its place in the tree
            let home = ids.first().and_then(|id| {
                find_parent_mut(&mut after, id).map(|p| {
                    (
                        p.id.clone(),
                        p.children.iter().position(|c| c.id == *id).unwrap_or(0),
                    )
                })
            });
            let mut set = Node::frame(&format!("set-{set_name}"), bw, bh);
            set.name = set_name.to_string();
            set.transform.x = bx;
            set.transform.y = by;
            for id in &ids {
                if let Some(mut m) = take_node(&mut after, id) {
                    m.transform.x -= bx;
                    m.transform.y -= by;
                    set.children.push(m);
                }
            }
            match home.and_then(|(pid, idx)| find_mut(&mut after, &pid).map(|p| (p, idx))) {
                Some((p, idx)) => p.children.insert(idx.min(p.children.len()), set),
                None => after.children.push(set),
            }
        }

        // --- the variant names
        let mut done = 0;
        for c in &names {
            let variant = c
                .split_once('/')
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| c.clone());
            if rename_master_in(&mut after, c, &format!("{set_name}/{variant}")) {
                done += 1;
            }
        }
        if done == 0 {
            return 0;
        }
        let root_id = self.root.id.clone();
        self.push_replace(&root_id, before, after);
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
                set_exclusive_override(&mut after, target, OverrideValue::Text(value.into()));
                true
            }
            ComponentProp::Bool { target, .. } => {
                if let Ok(b) = value.parse::<bool>() {
                    set_exclusive_override(&mut after, target, OverrideValue::Visible(b));
                    true
                } else {
                    false
                }
            }
            ComponentProp::Swap { target, .. } => {
                set_exclusive_override(&mut after, target, OverrideValue::Swap(value.into()));
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
                            set_exclusive_override(&mut after, target, OverrideValue::Number(n));
                        }
                        "opacity" => {
                            set_exclusive_override(&mut after, target, OverrideValue::Opacity(n as f32));
                        }
                        _ => {
                            // Default to Number for backward compatibility
                            set_exclusive_override(&mut after, target, OverrideValue::Number(n));
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
                    set_exclusive_override(&mut after, target, color_override(target_property, color));
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

/// The effect at `index` as the node carries it: the ordered stack once the
/// node is materialized, the flat legacy list otherwise. `None` when the index
/// is out of range — which is how every effect setter refuses *before* it
/// pushes an undo entry, so a click on a stale row changes nothing at all.
fn effect_at<'a>(root: &'a Node, id: &str, index: usize) -> Option<&'a Effect> {
    let n = find(root, id)?;
    if n.visual_stacks_materialized {
        n.effect_layers.get(index).map(|l| &l.effect)
    } else {
        n.effects.get(index)
    }
}

/// The ordered `effect_layers` stack is the truth once a node has been
/// materialized; `effects` is the flat list the `.x` format and the direct
/// (non-IR) sink read. Every write through [`Editor::mutate_visual_stack`]
/// leaves the two saying the same thing, so an effect added, retyped, hidden
/// or reordered in the panel paints exactly that way on every path.
fn sync_legacy_effects(n: &mut Node) {
    if n.visual_stacks_materialized {
        n.effects = n.effect_layers.iter().map(|l| l.effect.clone()).collect();
    }
}

/// Rename every reference to a component — `Instance { component }` and the
/// `Swap` overrides — from `old` to `new`. The other half of
/// [`Editor::rename_component`], shared with [`Editor::combine_as_variants`] so
/// combining can never leave an instance pointing at a name that is gone.
fn rename_component_refs(n: &mut Node, old: &str, new: &str) {
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
        rename_component_refs(c, old, new);
    }
}

/// Rename a master inside `root`: its component name, its id, its display name
/// and every reference to it. `false` when the master is missing or the name is
/// already taken. One undo entry is the caller's business — this works on a
/// tree so a whole combine can be a single replace.
fn rename_master_in(root: &mut Node, old: &str, new: &str) -> bool {
    if old == new || find_master(root, new).is_some() {
        return false;
    }
    let Some(master) = find_master(root, old) else {
        return false;
    };
    let old_id = master.id.clone();
    let new_id = format!("comp-{new}");
    if find(root, &new_id).is_some() {
        return false;
    }
    if let Some(m) = find_mut(root, &old_id) {
        if let NodeKind::Component { name } = &mut m.kind {
            *name = new.to_string();
        }
        m.id = new_id.clone();
        m.name = new_id.clone(); // master display name follows its id
    }
    rename_component_refs(root, old, new);
    true
}

/// The id of the node that is the parent of EVERY id — `None` when they do not
/// share one. Combining uses it to decide whether an existing frame can become
/// the set or a new one has to be built.
fn common_parent_id(root: &Node, ids: &[String]) -> Option<String> {
    fn parent_of<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
        if n.children.iter().any(|c| c.id == id) {
            return Some(n);
        }
        n.children.iter().find_map(|c| parent_of(c, id))
    }
    let first = ids.first()?;
    let p = parent_of(root, first)?;
    if ids
        .iter()
        .skip(1)
        .all(|id| parent_of(root, id).is_some_and(|q| q.id == p.id))
    {
        Some(p.id.clone())
    } else {
        None
    }
}

/// Detach a node from the tree, children intact.
fn take_node(root: &mut Node, id: &str) -> Option<Node> {
    fn walk(n: &mut Node, id: &str) -> Option<Node> {
        if let Some(i) = n.children.iter().position(|c| c.id == id) {
            return Some(n.children.remove(i));
        }
        for c in &mut n.children {
            if let Some(found) = walk(c, id) {
                return Some(found);
            }
        }
        None
    }
    walk(root, id)
}

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
