//! Canvas context menu — the single source of truth for what the
//! right-click menu shows (viewport audit P4: before this there were
//! THREE parallel systems — this item model, a paint-command IR nobody
//! rendered, and a hardcoded item list in the painter; the painter now
//! renders `items`, and this file owns what they are).

use crate::state::{Action, CtxCmd};
use crate::theme::{MENU_ROW_H, MENU_WIDTH};

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
        /// The instance the selection is, when it is one: the master name,
        /// whether that master lives in this file, and the layers carrying an
        /// override (Figma's More-actions menu, help 360039150733).
        instance: Option<InstanceMenu>,
        /// Any selected layer is an image. Figma's **Flip horizontal /
        /// vertical** rows (help 360039956914) are shown for one, because the
        /// flip the engine carries lives on the image placement.
        has_image: bool,
    },
}

/// What the instance section of the selection menu needs. Built by the app
/// from the engine, so the menu itself stays data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceMenu {
    /// The instance node's id.
    pub id: String,
    /// The component it follows — Figma's *"hover over the name … to see Go
    /// to main component in library"*.
    pub component: String,
    /// The master is in this document, so *Go to main component* and *Push
    /// changes to main component* are both available.
    pub in_file: bool,
    /// One override per entry: (target layer id, the property's own word).
    pub changes: Vec<(String, String)>,
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
    /// Figma's "Wrap in new section" — the selection goes into a labelled
    /// Section on the canvas. Sections cannot live inside frames or groups
    /// (help 9771500257687), so a selection drawn in one is lifted first.
    WrapInSection,
    MakeComponent,
    /// Figma's *Use as mask* (help 360040450253): the bottom-most selected
    /// layer masks the layers above it. The row is the one gesture — the
    /// engine's `use_as_mask` clears the flag when the selection already is
    /// a mask object.
    UseAsMask,
    /// Figma's **Flip horizontal** (⇧H) — *"Use the right-click menu to apply
    /// a flip transformation, or the keyboard shortcuts"* (help 360039956914).
    FlipHorizontal,
    /// Figma's **Flip vertical** (⇧V).
    FlipVertical,
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
    /// Canvas minimap (⇧M) — the navigation aid for a page larger than the
    /// viewport.
    ToggleMinimap,
    // Instance (Figma's More-actions menu)
    /// *"Go to main component"* — select the master (help 360038665934).
    GoToMainComponent,
    /// *"Push changes to main component"* (help 360039150733).
    PushChangesToMain,
    /// A row of the Reset flyout: *"Reset > Reset [property]"* — the label
    /// names the layer and the property it carries, so it is data, not a
    /// static string.
    ResetChange {
        target: String,
        label: String,
    },
    /// *"Reset > Reset all changes"*.
    ResetAllChanges,
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
            Self::WrapInSection => "Wrap in new section",
            Self::MakeComponent => "Make component",
            Self::UseAsMask => "Use as mask",
            Self::FlipHorizontal => "Flip horizontal",
            Self::FlipVertical => "Flip vertical",
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
            Self::ToggleMinimap => "Toggle minimap",
            Self::GoToMainComponent => "Go to main component",
            Self::PushChangesToMain => "Push changes to main component",
            Self::ResetAllChanges => "Reset all changes",
            // the one action whose label is data; `dynamic_label` serves it
            Self::ResetChange { .. } => "Reset change",
        }
    }

    /// The label when it is not static (the Reset rows, which name the layer
    /// and the property they clear).
    pub fn dynamic_label(&self) -> Option<&str> {
        match self {
            Self::ResetChange { label, .. } => Some(label.as_str()),
            _ => None,
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
            Self::WrapInSection => "section",
            Self::MakeComponent => "component",
            Self::UseAsMask => "square",
            Self::FlipHorizontal => "flip-horizontal",
            Self::FlipVertical => "flip-vertical",
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
            Self::ToggleMinimap => "layout-dashboard",
            Self::GoToMainComponent => "component",
            Self::PushChangesToMain => "arrow-up-right",
            Self::ResetChange { .. } | Self::ResetAllChanges => "rotate-ccw",
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
            Self::UseAsMask => Some("⌘⌥M"),
            Self::FlipHorizontal => Some("⇧H"),
            Self::FlipVertical => Some("⇧V"),
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
            Self::ToggleMinimap => Some("⇧M"),
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
            _ => MENU_ROW_H,
        }
    }
}

/// Separator row height inside a menu. The menu width / row-height tokens
/// live in `theme.rs` (one geometry for the whole chrome).
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
        WrapInSection => Action::Ctx(CtxCmd::SectionSelection),
        MakeComponent => Action::Ctx(CtxCmd::MakeComponent),
        UseAsMask => Action::UseAsMask,
        FlipHorizontal => Action::FlipImage { horizontal: true },
        FlipVertical => Action::FlipImage { horizontal: false },
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
        ToggleMinimap => Action::ToggleMinimap,
        GoToMainComponent => Action::GoToMainComponent,
        PushChangesToMain => Action::PushChangesToMain,
        ResetChange { target, .. } => Action::ResetInstanceChange(target.clone()),
        ResetAllChanges => Action::ResetInstanceProps,
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
            ai(ToggleMinimap, true),
        ],
        ContextTarget::CanvasSelection {
            selected_count,
            contains_group,
            instance,
            has_image,
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
            items.push(ai(WrapInSection, true));
            items.push(ai(MakeComponent, true));
            items.push(ai(UseAsMask, true));
            // Figma's transform rows, for a selection that carries an image
            // (help 360039956914) — no dead row for the rest.
            if *has_image {
                items.push(ai(FlipHorizontal, true));
                items.push(ai(FlipVertical, true));
            }
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
            // Figma's instance More-actions menu (help 360039150733). The two
            // master rows need the master to be in this file; the Reset flyout
            // *"only lists properties that have changes applied"* and ends with
            // *"Reset all changes"*.
            if let Some(inst) = instance {
                let pushable = inst.in_file && !inst.changes.is_empty();
                items.push(ContextMenuItem::Separator);
                items.push(ai(GoToMainComponent, inst.in_file));
                items.push(ai(PushChangesToMain, pushable));
                if !inst.changes.is_empty() {
                    let mut rows: Vec<ContextMenuItem> = inst
                        .changes
                        .iter()
                        .map(|(target, property)| ContextMenuItem::Action {
                            action: ResetChange {
                                target: target.clone(),
                                label: property.clone(),
                            },
                            enabled: true,
                        })
                        .collect();
                    rows.push(ai(ResetAllChanges, true));
                    items.push(ContextMenuItem::Submenu {
                        label: "Reset",
                        icon: "history",
                        enabled: true,
                        items: rows,
                    });
                }
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
        assert!(
            actions.contains(&&ContextAction::ToggleMinimap),
            "empty canvas must offer the minimap toggle"
        );
    }

    #[test]
    fn multi_selection_menu_offers_group_and_boolean_submenu() {
        let items = build_menu_items(&ContextTarget::CanvasSelection {
            selected_count: 2,
            contains_group: false,
            has_image: false,
            instance: None,
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
        let has_bool = items
            .iter()
            .any(|it| matches!(it, ContextMenuItem::Submenu { label, .. } if *label == "Boolean"));
        assert!(has_bool, "two selections must offer the boolean submenu");
    }

    #[test]
    fn the_selection_menu_offers_use_as_mask() {
        let items = build_menu_items(&ContextTarget::CanvasSelection {
            selected_count: 1,
            contains_group: false,
            has_image: false,
            instance: None,
        });
        let actions = actions_of(&items);
        assert!(
            actions.contains(&&ContextAction::UseAsMask),
            "Figma's Use as mask row, help 360040450253"
        );
        assert_eq!(ContextAction::UseAsMask.shortcut(), Some("⌘⌥M"));
    }

    #[test]
    fn the_selection_menu_offers_flip_rows_for_an_image() {
        let items = build_menu_items(&ContextTarget::CanvasSelection {
            selected_count: 1,
            contains_group: false,
            has_image: true,
            instance: None,
        });
        let actions = actions_of(&items);
        assert!(
            actions.contains(&&ContextAction::FlipHorizontal),
            "Figma's flip rows, help 360039956914"
        );
        assert!(actions.contains(&&ContextAction::FlipVertical));
        assert_eq!(ContextAction::FlipHorizontal.shortcut(), Some("⇧H"));
        assert_eq!(ContextAction::FlipVertical.shortcut(), Some("⇧V"));

        // a selection with no image has nothing to flip, so it gets no row
        let plain = actions_of(&build_menu_items(&ContextTarget::CanvasSelection {
            selected_count: 1,
            contains_group: false,
            has_image: false,
            instance: None,
        }));
        assert!(!plain.contains(&&ContextAction::FlipHorizontal));
    }

    #[test]
    fn single_group_selection_offers_ungroup_not_group() {
        let items = build_menu_items(&ContextTarget::CanvasSelection {
            selected_count: 1,
            contains_group: true,
            has_image: false,
            instance: None,
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
        let has_bool = items
            .iter()
            .any(|it| matches!(it, ContextMenuItem::Submenu { label, .. } if *label == "Boolean"));
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
        assert_eq!(
            action_for(&ContextAction::ToggleMinimap),
            Some(Action::ToggleMinimap)
        );
    }
}
