//! Canvas context menu — the single source of truth for what the
//! right-click menu shows (viewport audit P4: before this there were
//! THREE parallel systems — this item model, a paint-command IR nobody
//! rendered, and a hardcoded item list in the painter; the painter now
//! renders `items`, and this file owns what they are).

use crate::state::{Action, CtxCmd};

// ═══════════════════════════════════════════════════════════
// Menu target
// ═══════════════════════════════════════════════════════════

/// What was right-clicked. Drives which items `build_menu_items` shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextTarget {
    /// Right-click on empty canvas (nothing selected).
    CanvasEmpty,
    /// Right-click with one or more nodes selected.
    CanvasSelection {
        selected_count: usize,
        /// Any selected node is a group (enables Ungroup).
        contains_group: bool,
    },
}

// ═══════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════

/// A menu action. Each maps 1:1 to an `Action` through `action_for` —
/// the only click path for menu rows.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ContextAction {
    // Edit
    Cut,
    Copy,
    Paste,
    Duplicate,
    Delete,
    /// B13: serialize the selection to JSX (system clipboard + status).
    CopyAsCode,
    // Object
    Group,
    Ungroup,
    MakeComponent,
    BringToFront,
    BringForward,
    SendBackward,
    SendToBack,
    Lock,
    Hide,
    // Boolean / vector
    BooleanUnion,
    BooleanSubtract,
    BooleanIntersect,
    BooleanExclude,
    Flatten,
    OutlineStroke,
    OutlineText,
    // View
    SelectAll,
    ToggleGrid,
}

impl ContextAction {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Cut => "Cut",
            Self::Copy => "Copy",
            Self::Paste => "Paste",
            Self::Duplicate => "Duplicate",
            Self::Delete => "Delete",
            Self::CopyAsCode => "Copy as code",
            Self::Group => "Group selection",
            Self::Ungroup => "Ungroup",
            Self::MakeComponent => "Make component",
            Self::BringToFront => "Bring to front",
            Self::BringForward => "Bring forward",
            Self::SendBackward => "Send backward",
            Self::SendToBack => "Send to back",
            Self::Lock => "Lock",
            Self::Hide => "Hide",
            Self::BooleanUnion => "Union selection",
            Self::BooleanSubtract => "Subtract",
            Self::BooleanIntersect => "Intersect",
            Self::BooleanExclude => "Exclude",
            Self::Flatten => "Flatten",
            Self::OutlineStroke => "Outline stroke",
            Self::OutlineText => "Outline text",
            Self::SelectAll => "Select all",
            Self::ToggleGrid => "Toggle grid",
        }
    }

    /// Icon name from `icons.rs` (only names that exist in the set).
    pub fn icon(&self) -> &'static str {
        match self {
            Self::Cut => "scissors",
            Self::Copy => "copy",
            Self::Paste => "clipboard",
            Self::Duplicate => "copy-plus",
            Self::Delete => "trash-2",
            Self::CopyAsCode => "code",
            Self::Group => "group",
            Self::Ungroup => "ungroup",
            Self::MakeComponent => "component",
            Self::BringToFront => "chevrons-up",
            Self::BringForward => "chevron-up",
            Self::SendBackward => "chevron-down",
            Self::SendToBack => "chevrons-down",
            Self::Lock => "lock",
            Self::Hide => "eye-off",
            Self::BooleanUnion => "box",
            Self::BooleanSubtract => "minus",
            Self::BooleanIntersect => "circle",
            Self::BooleanExclude => "square",
            Self::Flatten => "box",
            Self::OutlineStroke => "pen-tool",
            Self::OutlineText => "type",
            Self::SelectAll => "box-select",
            Self::ToggleGrid => "grid-2x2",
        }
    }

    /// Shortcut hint shown at the right of the row (only shortcuts that
    /// actually exist in the key handler).
    pub fn shortcut(&self) -> Option<&'static str> {
        match self {
            Self::Cut => Some("⌘X"),
            Self::Copy => Some("⌘C"),
            Self::Paste => Some("⌘V"),
            Self::Duplicate => Some("⌘D"),
            Self::Delete => Some("⌫"),
            Self::Group => Some("⌘G"),
            Self::Ungroup => Some("⇧⌘G"),
            Self::MakeComponent => Some("⌘⌥K"),
            Self::BringToFront => Some("⇧⌘]"),
            Self::BringForward => Some("⌘]"),
            Self::SendBackward => Some("⌘["),
            Self::SendToBack => Some("⇧⌘["),
            Self::BooleanUnion => Some("⌘⌥U"),
            Self::BooleanSubtract => Some("⌘S"),
            Self::BooleanIntersect => Some("⌘⌥I"),
            Self::BooleanExclude => Some("⌘⌥X"),
            Self::OutlineStroke => Some("⇧⌘O"),
            Self::OutlineText => Some("⇧⌥⌘O"),
            Self::Flatten => Some("⌘E"),
            Self::Lock => Some("⇧⌘L"),
            Self::Hide => Some("⇧⌘H"),
            Self::SelectAll => Some("⌘A"),
            _ => None,
        }
    }
}

// ═══════════════════════════════════════════════════════════
// Menu items
// ═══════════════════════════════════════════════════════════

/// One row of the menu. `Submenu` rows open a flyout on hover; the
/// painter owns the flyout geometry.
#[derive(Debug, Clone, PartialEq)]
pub enum ContextMenuItem {
    Action {
        action: ContextAction,
        enabled: bool,
    },
    Separator,
    Submenu {
        label: &'static str,
        icon: &'static str,
        enabled: bool,
        items: Vec<ContextMenuItem>,
    },
}

impl ContextMenuItem {
    pub fn height(&self) -> f64 {
        match self {
            Self::Separator => SEPARATOR_HEIGHT,
            _ => ROW_HEIGHT,
        }
    }
}

/// Menu geometry, shared with the painter (single source).
pub const MENU_WIDTH: f64 = 208.0;
pub const ROW_HEIGHT: f64 = 28.0;
pub const SEPARATOR_HEIGHT: f64 = 7.0;

// ═══════════════════════════════════════════════════════════
// Menu state
// ═══════════════════════════════════════════════════════════

/// The currently open menu (position anchored at the cursor, clamped to
/// the canvas by `open_for_target`). Geometry, hover and hit-testing
/// live in the painter; this struct is data only.
#[derive(Debug, Clone)]
pub struct ContextMenu {
    pub open: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub items: Vec<ContextMenuItem>,
}

impl ContextMenu {
    pub fn new() -> Self {
        ContextMenu {
            open: false,
            x: 0.0,
            y: 0.0,
            width: MENU_WIDTH,
            items: Vec::new(),
        }
    }

    /// Open the menu for `target` at screen position `(x, y)`, clamped
    /// to the window.
    pub fn open_for_target(
        &mut self,
        target: ContextTarget,
        x: f64,
        y: f64,
        screen_w: f64,
        screen_h: f64,
    ) {
        let items = build_menu_items(&target);
        let h = menu_height(&items);
        self.open = true;
        self.x = clamp_menu_x(x, self.width, screen_w);
        self.y = clamp_menu_y(y, h, screen_h);
        self.items = items;
    }

    pub fn close(&mut self) {
        self.open = false;
        self.items.clear();
    }
}

/// The one click a menu row performs. `None` means the action cannot be
/// expressed as an `Action` (the painter then doesn't hit-test the row).
pub fn action_for(action: &ContextAction) -> Option<Action> {
    use ContextAction::*;
    Some(match action {
        Cut => Action::Ctx(CtxCmd::Cut),
        Copy => Action::Ctx(CtxCmd::Copy),
        CopyAsCode => Action::Ctx(CtxCmd::CopyAsCode),
        Paste => Action::Ctx(CtxCmd::Paste),
        Duplicate => Action::Ctx(CtxCmd::Duplicate),
        Delete => Action::Ctx(CtxCmd::Delete),
        Group => Action::Ctx(CtxCmd::Group),
        Ungroup => Action::Ctx(CtxCmd::Ungroup),
        MakeComponent => Action::Ctx(CtxCmd::MakeComponent),
        BringToFront => Action::Ctx(CtxCmd::ToFront),
        BringForward => Action::Ctx(CtxCmd::BringFwd),
        SendBackward => Action::Ctx(CtxCmd::SendBack),
        SendToBack => Action::Ctx(CtxCmd::ToBack),
        BooleanUnion => Action::Ctx(CtxCmd::Union),
        BooleanSubtract => Action::Ctx(CtxCmd::Subtract),
        BooleanIntersect => Action::Ctx(CtxCmd::Intersect),
        BooleanExclude => Action::Ctx(CtxCmd::Exclude),
        OutlineStroke => Action::Ctx(CtxCmd::OutlineStroke),
        OutlineText => Action::Ctx(CtxCmd::OutlineText),
        Flatten => Action::Ctx(CtxCmd::Flatten),
        Lock => Action::Ctx(CtxCmd::LockSel),
        Hide => Action::Ctx(CtxCmd::HideSel),
        SelectAll => Action::Ctx(CtxCmd::SelectAll),
        ToggleGrid => Action::ToggleGuideVisibility,
    })
}

// ═══════════════════════════════════════════════════════════
// Menu building
// ═══════════════════════════════════════════════════════════

/// Build the items for a target — the single place that decides what
/// the right-click menu offers.
/// One enabled menu row for a given action.
fn ai(a: ContextAction, enabled: bool) -> ContextMenuItem {
    ContextMenuItem::Action { action: a, enabled }
}

pub fn build_menu_items(target: &ContextTarget) -> Vec<ContextMenuItem> {
    use ContextAction::*;
    match target {
        ContextTarget::CanvasEmpty => vec![
            ai(Paste, true),
            ai(SelectAll, true),
            ContextMenuItem::Separator,
            ai(ToggleGrid, true),
        ],
        ContextTarget::CanvasSelection {
            selected_count,
            contains_group,
        } => {
            let mut items = vec![
                ai(Cut, true),
                ai(Copy, true),
                ai(Paste, true),
                ai(CopyAsCode, true),
                ai(Duplicate, true),
                ContextMenuItem::Separator,
            ];
            if *selected_count > 1 {
                items.push(ai(Group, true));
            }
            if *contains_group {
                items.push(ai(Ungroup, true));
            }
            items.push(ai(MakeComponent, true));
            items.push(ContextMenuItem::Separator);
            items.push(ContextMenuItem::Submenu {
                label: "Arrange",
                icon: "layout-template",
                enabled: true,
                items: vec![
                    ai(BringToFront, true),
                    ai(BringForward, true),
                    ai(SendBackward, true),
                    ai(SendToBack, true),
                ],
            });
            // Boolean combine works on the two top-level selections
            // (the engine combines exactly two), so it only appears
            // with a multi-selection.
            if *selected_count > 1 {
                items.push(ContextMenuItem::Submenu {
                    label: "Boolean",
                    icon: "box",
                    enabled: true,
                    items: vec![
                        ai(BooleanUnion, true),
                        ai(BooleanSubtract, true),
                        ai(BooleanIntersect, true),
                        ai(BooleanExclude, true),
                    ],
                });
            }
            items.push(ContextMenuItem::Separator);
            items.push(ai(OutlineStroke, true));
            items.push(ai(OutlineText, true));
            items.push(ai(Flatten, true));
            items.push(ContextMenuItem::Separator);
            items.push(ai(Lock, true));
            items.push(ai(Hide, true));
            items.push(ai(SelectAll, true));
            items.push(ai(Delete, true));
            items
        }
    }
}

fn menu_height(items: &[ContextMenuItem]) -> f64 {
    items.iter().map(ContextMenuItem::height).sum()
}

fn clamp_menu_x(x: f64, w: f64, screen_w: f64) -> f64 {
    x.min(screen_w - w - 4.0).max(4.0)
}

fn clamp_menu_y(y: f64, h: f64, screen_h: f64) -> f64 {
    y.min(screen_h - h - 4.0).max(4.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actions_of(items: &[ContextMenuItem]) -> Vec<&ContextAction> {
        items
            .iter()
            .filter_map(|it| match it {
                ContextMenuItem::Action { action, .. } => Some(action),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn canvas_empty_menu_offers_paste_select_all_and_grid() {
        let items = build_menu_items(&ContextTarget::CanvasEmpty);
        let actions = actions_of(&items);
        assert!(
            actions.contains(&&ContextAction::Paste),
            "empty canvas must offer paste"
        );
        assert!(
            actions.contains(&&ContextAction::SelectAll),
            "empty canvas must offer select-all"
        );
        assert!(
            actions.contains(&&ContextAction::ToggleGrid),
            "empty canvas must offer the grid toggle"
        );
    }

    #[test]
    fn multi_selection_menu_offers_group_and_boolean_submenu() {
        let items = build_menu_items(&ContextTarget::CanvasSelection {
            selected_count: 2,
            contains_group: false,
        });
        let actions = actions_of(&items);
        assert!(
            actions.contains(&&ContextAction::Group),
            "two selections must offer group"
        );
        assert!(
            !actions.contains(&&ContextAction::Ungroup),
            "a non-group selection must not offer ungroup"
        );
        let has_bool = items.iter().any(|it| {
            matches!(it, ContextMenuItem::Submenu { label, .. } if *label == "Boolean")
        });
        assert!(has_bool, "two selections must offer the boolean submenu");
    }

    #[test]
    fn single_group_selection_offers_ungroup_not_group() {
        let items = build_menu_items(&ContextTarget::CanvasSelection {
            selected_count: 1,
            contains_group: true,
        });
        let actions = actions_of(&items);
        assert!(
            actions.contains(&&ContextAction::Ungroup),
            "a group selection must offer ungroup"
        );
        assert!(
            !actions.contains(&&ContextAction::Group),
            "a single selection must not offer group"
        );
        let has_bool = items.iter().any(|it| {
            matches!(it, ContextMenuItem::Submenu { label, .. } if *label == "Boolean")
        });
        assert!(!has_bool, "booleans need two selections");
    }

    #[test]
    fn every_action_maps_to_a_runnable_action() {
        assert_eq!(
            action_for(&ContextAction::BringToFront),
            Some(Action::Ctx(CtxCmd::ToFront))
        );
        assert_eq!(
            action_for(&ContextAction::ToggleGrid),
            Some(Action::ToggleGuideVisibility)
        );
    }
}
