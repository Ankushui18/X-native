//! The screen contract (Refinement v1, P0-1).
//!
//! X-Native has three screens (dashboard, editor, board) and a fixed set of
//! surfaces inside them — docks, panels, canvases, toolbars, menus, modals and
//! overlays. This module is the list, kept in the component layer so a screen
//! that drifts from it can be caught by a test instead of by an audit:
//!
//! - every screen the app can show has a spec ([`SCREENS`]);
//! - every surface has a spec ([`SURFACES`]) with the name it shows, whether it
//!   owns property rows, and what it says when it is empty;
//! - the ledgers ([`OFF_STANDARD_SURFACES`], [`SILENT_EMPTY_STATES`]) count the
//!   surfaces the cross-screen pass (P0-5) still has to bring over, and fail
//!   when the registry and the count disagree.
//!
//! The rules these fields *mean* — what a property row owes the standard, what
//! an empty state owes the user, why a surface may not invent a name — are in
//! `docs/SCREEN_CONTRACT.md`.

use crate::metrics::ControlHeight;

/// The three screens the app can show. Mirrors the designer's `Screen` enum; a
/// test on the app side asserts the two stay in step.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScreenId {
    Dashboard,
    Editor,
    Board,
}

impl ScreenId {
    pub const ALL: [Self; 3] = [Self::Dashboard, Self::Editor, Self::Board];

    /// The name the app gives the screen.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Dashboard => "Dashboard",
            Self::Editor => "Editor",
            Self::Board => "Board",
        }
    }
}

/// What a screen is for, and where it sits in the Compose → Flow → Ship loop.
#[derive(Clone, Copy, Debug)]
pub struct ScreenSpec {
    pub id: ScreenId,
    pub name: &'static str,
    pub purpose: &'static str,
    pub workflow: &'static str,
}

pub static SCREENS: &[ScreenSpec] = &[
    ScreenSpec {
        id: ScreenId::Dashboard,
        name: "Dashboard",
        purpose: "Find, open and start a file.",
        workflow: concat!(
            "Entry point. Names the loop once (sidebar, primary card) and teaches ",
            "it on the first run; it does not host the loop itself."
        ),
    },
    ScreenSpec {
        id: ScreenId::Editor,
        name: "Editor",
        purpose: "Compose, flow, ship and analyze one file.",
        workflow: concat!(
            "The loop. COMPOSE is the default right-dock tab; FLOW, SHIP and UX ",
            "ANALYSIS follow it in that order."
        ),
    },
    ScreenSpec {
        id: ScreenId::Board,
        name: "Board",
        purpose: "Map screens and flows on an infinite canvas.",
        workflow: concat!(
            "Before the loop: a place to lay out what will later be composed and ",
            "connected in FLOW."
        ),
    },
];

/// What a surface is, which decides what it owes the standard: a panel that
/// owns property rows snaps to the control-height scale, a toolbar does not.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SurfaceKind {
    /// A bar of actions (title bar, editor toolbar, board tool rail).
    Toolbar,
    /// The narrow icon rail down the editor's left edge.
    Rail,
    /// A container that hosts tabs (the left and right docks).
    Dock,
    /// A scrolling panel of content or properties.
    Panel,
    /// User content: the editor page, the board canvas.
    Canvas,
    /// A one-off informational card (first-run onboarding).
    Card,
    /// A blocking surface with a scrim (template picker, command palette).
    Modal,
    /// A floating menu (app menu, context menu, sort menu).
    Menu,
    /// Non-blocking floating chrome (notifications, tooltips).
    Overlay,
}

/// How a surface moves its content.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScrollRule {
    /// It never scrolls: the chrome is sized to its content.
    Fixed,
    /// Its content scrolls.
    Content,
    /// Its content scrolls *under* pinned chrome — a clipped region with the
    /// header on top (the right dock's tab strip).
    Pinned,
}

/// What the surface shows when it has nothing to show.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EmptyState {
    /// It always has something: a toolbar, a menu, a rail.
    Never,
    /// It says this, and the copy offers the next step rather than only
    /// describing the emptiness (P0-10).
    Copy(&'static str),
    /// It can be empty and says nothing — a gap the cross-screen pass (P0-5)
    /// closes.
    Silent,
}

/// One row of the contract.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SurfaceSpec {
    pub id: SurfaceId,
    pub screen: ScreenId,
    pub kind: SurfaceKind,
    /// The name it shows, or `""` when it shows none. X-Native naming only —
    /// the test rejects the pre-rename vocabulary.
    pub label: &'static str,
    /// It owns property rows, so those rows snap to the control-height scale.
    pub property_rows: bool,
    /// Its rows are on the standard today.
    pub on_standard: bool,
    pub empty_state: EmptyState,
    pub scroll: ScrollRule,
}

/// The surfaces inside the three screens.
///
/// `Silent` empty states and off-standard property rows are counted by
/// [`SILENT_EMPTY_STATES`] and [`OFF_STANDARD_SURFACES`]; lowering a count
/// means the surface really changed, not that this file was edited.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum SurfaceId {
    // — dashboard —
    DashTopBar,
    DashSidebar,
    DashMain,
    DashRecents,
    DashTrash,
    DashDrafts,
    DashOnboarding,
    DashTemplatePicker,
    DashSortMenu,
    DashBulkBar,
    // — editor —
    EdTitleBar,
    EdNavRail,
    EdLeftDock,
    EdStructure,
    EdLibrary,
    EdTokens,
    EdCanvas,
    EdRightDock,
    EdCompose,
    EdFlow,
    EdShip,
    EdUx,
    EdToolbar,
    EdAppMenu,
    EdContextMenu,
    EdCommandPalette,
    EdFindReplace,
    EdNotifications,
    // — board —
    BoardHeader,
    BoardCanvas,
    BoardToolbar,
}

pub static SURFACES: &[SurfaceSpec] = &[
    // ——————————————————————————————————————————————————————— dashboard
    SurfaceSpec {
        id: SurfaceId::DashTopBar,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Toolbar,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::DashSidebar,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Dock,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::DashMain,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Panel,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::DashRecents,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Panel,
        label: "RECENTS",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Copy(
            "Create a new file, or use Ctrl/Cmd+O to open an existing project.",
        ),
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::DashTrash,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Panel,
        label: "TRASH",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Copy("Trash is empty"),
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::DashDrafts,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Panel,
        label: "DRAFTS",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Silent,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::DashOnboarding,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Card,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::DashTemplatePicker,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Modal,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::DashSortMenu,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Menu,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::DashBulkBar,
        screen: ScreenId::Dashboard,
        kind: SurfaceKind::Toolbar,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    // ————————————————————————————————————————————————————————— editor
    SurfaceSpec {
        id: SurfaceId::EdTitleBar,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Toolbar,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::EdNavRail,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Rail,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::EdLeftDock,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Dock,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::EdStructure,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Panel,
        label: "STRUCTURE",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Silent,
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::EdLibrary,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Panel,
        label: "LIBRARY",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Copy("No colour variables in this file"),
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::EdTokens,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Panel,
        label: "TOKENS",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Silent,
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::EdCanvas,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Canvas,
        label: "",
        property_rows: false,
        on_standard: true,
        // P0-10: a blank page says what to do first, and the hint leaves as
        // soon as a frame lands.
        empty_state: EmptyState::Copy(concat!(
            "Add your first frame — pick the frame tool in the dock below, then ",
            "drag on the canvas. Then connect screens in FLOW, and export from SHIP."
        )),
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::EdRightDock,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Dock,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Pinned,
    },
    SurfaceSpec {
        id: SurfaceId::EdCompose,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Panel,
        label: "COMPOSE",
        property_rows: true,
        // P0-9 put every row here on the control-height scale.
        on_standard: true,
        // With nothing selected it shows the page/canvas properties, not a
        // message — so it is never an empty panel.
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Pinned,
    },
    SurfaceSpec {
        id: SurfaceId::EdFlow,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Panel,
        label: "FLOW",
        property_rows: true,
        on_standard: false,
        empty_state: EmptyState::Copy("No painted content to analyze yet"),
        scroll: ScrollRule::Pinned,
    },
    SurfaceSpec {
        id: SurfaceId::EdShip,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Panel,
        label: "SHIP",
        property_rows: true,
        on_standard: false,
        // The code panel simply draws no lines when there is nothing selected.
        empty_state: EmptyState::Silent,
        scroll: ScrollRule::Pinned,
    },
    SurfaceSpec {
        id: SurfaceId::EdUx,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Panel,
        label: "UX ANALYSIS",
        property_rows: true,
        on_standard: false,
        empty_state: EmptyState::Copy("Select an element to analyze"),
        scroll: ScrollRule::Pinned,
    },
    SurfaceSpec {
        id: SurfaceId::EdToolbar,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Toolbar,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::EdAppMenu,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Menu,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::EdContextMenu,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Menu,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::EdCommandPalette,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Modal,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Content,
    },
    SurfaceSpec {
        id: SurfaceId::EdFindReplace,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Modal,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::EdNotifications,
        screen: ScreenId::Editor,
        kind: SurfaceKind::Overlay,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Silent,
        scroll: ScrollRule::Fixed,
    },
    // ——————————————————————————————————————————————————————————— board
    SurfaceSpec {
        id: SurfaceId::BoardHeader,
        screen: ScreenId::Board,
        kind: SurfaceKind::Toolbar,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::BoardCanvas,
        screen: ScreenId::Board,
        kind: SurfaceKind::Canvas,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Silent,
        scroll: ScrollRule::Fixed,
    },
    SurfaceSpec {
        id: SurfaceId::BoardToolbar,
        screen: ScreenId::Board,
        kind: SurfaceKind::Toolbar,
        label: "",
        property_rows: false,
        on_standard: true,
        empty_state: EmptyState::Never,
        scroll: ScrollRule::Fixed,
    },
];

/// Every [`SurfaceId`], so a test can assert the registry covers the enum.
pub const SURFACE_VARIANTS: &[SurfaceId] = &[
    SurfaceId::DashTopBar,
    SurfaceId::DashSidebar,
    SurfaceId::DashMain,
    SurfaceId::DashRecents,
    SurfaceId::DashTrash,
    SurfaceId::DashDrafts,
    SurfaceId::DashOnboarding,
    SurfaceId::DashTemplatePicker,
    SurfaceId::DashSortMenu,
    SurfaceId::DashBulkBar,
    SurfaceId::EdTitleBar,
    SurfaceId::EdNavRail,
    SurfaceId::EdLeftDock,
    SurfaceId::EdStructure,
    SurfaceId::EdLibrary,
    SurfaceId::EdTokens,
    SurfaceId::EdCanvas,
    SurfaceId::EdRightDock,
    SurfaceId::EdCompose,
    SurfaceId::EdFlow,
    SurfaceId::EdShip,
    SurfaceId::EdUx,
    SurfaceId::EdToolbar,
    SurfaceId::EdAppMenu,
    SurfaceId::EdContextMenu,
    SurfaceId::EdCommandPalette,
    SurfaceId::EdFindReplace,
    SurfaceId::EdNotifications,
    SurfaceId::BoardHeader,
    SurfaceId::BoardCanvas,
    SurfaceId::BoardToolbar,
];

/// Surfaces that own property rows and are not on the control-height scale yet.
///
/// P0-5 owns this number: it is the cross-screen pass over FLOW, SHIP and UX
/// ANALYSIS. Lower it when a surface's rows actually move onto the scale.
pub const OFF_STANDARD_SURFACES: usize = 3;

/// Surfaces that can be empty and say nothing. P0-5 gives each of them copy
/// that offers the next step, and lowers this to zero.
pub const SILENT_EMPTY_STATES: usize = 6;

/// Labels a surface must never show: the internal vocabulary (enum variant
/// names, mostly) that the UI used to leak before the X-Native rename.
pub const BANNED_LABELS: &[&str] = &["design", "prototype", "inspect", "layers", "assets"];

pub fn screen(id: ScreenId) -> Option<&'static ScreenSpec> {
    SCREENS.iter().find(|s| s.id == id)
}

pub fn surface(id: SurfaceId) -> Option<&'static SurfaceSpec> {
    SURFACES.iter().find(|s| s.id == id)
}

/// The surfaces of one screen, in contract order.
pub fn surfaces_of(id: ScreenId) -> impl Iterator<Item = &'static SurfaceSpec> {
    SURFACES.iter().filter(move |s| s.screen == id)
}

/// The height a surface's property rows must have.
pub const fn row_height() -> f64 {
    ControlHeight::Control.px()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_screen_has_a_spec() {
        assert_eq!(SCREENS.len(), ScreenId::ALL.len());
        for id in ScreenId::ALL {
            let spec = screen(id).unwrap_or_else(|| panic!("no spec for {id:?}"));
            assert_eq!(spec.id, id);
            assert_eq!(spec.name, id.name());
            assert!(!spec.purpose.is_empty() && !spec.workflow.is_empty());
        }
    }

    #[test]
    fn every_surface_variant_has_a_spec_and_no_two_rows_share_one() {
        assert_eq!(SURFACES.len(), SURFACE_VARIANTS.len());
        for id in SURFACE_VARIANTS {
            let spec = surface(*id).unwrap_or_else(|| panic!("no spec for {id:?}"));
            assert_eq!(spec.id, *id);
        }
        let mut ids: Vec<SurfaceId> = SURFACES.iter().map(|s| s.id).collect();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count, "a surface id appears twice");
    }

    #[test]
    fn every_surface_belongs_to_a_screen() {
        for s in SURFACES {
            assert!(screen(s.screen).is_some(), "{:?} has no screen", s.id);
        }
        for id in ScreenId::ALL {
            assert!(
                surfaces_of(id).next().is_some(),
                "{} owns no surfaces",
                id.name()
            );
        }
    }

    /// The naming rule from P0-10: the workflow is COMPOSE / FLOW / SHIP / UX
    /// ANALYSIS, and the docks are STRUCTURE / LIBRARY / TOKENS. A surface
    /// showing "Design" or "Layers" is the old vocabulary leaking through.
    #[test]
    fn surface_labels_use_x_native_naming() {
        for s in SURFACES {
            let label = s.label.to_ascii_lowercase();
            for banned in BANNED_LABELS {
                assert!(
                    !label.contains(*banned),
                    "{:?} shows a banned label {:?}",
                    s.id,
                    s.label
                );
            }
        }
        // the four workflow tabs, in order, are what the right dock shows
        let tabs: Vec<&str> = [
            SurfaceId::EdCompose,
            SurfaceId::EdFlow,
            SurfaceId::EdShip,
            SurfaceId::EdUx,
        ]
        .iter()
        .map(|id| surface(*id).unwrap().label)
        .collect();
        assert_eq!(tabs, vec!["COMPOSE", "FLOW", "SHIP", "UX ANALYSIS"]);
    }

    #[test]
    fn empty_state_copy_is_never_blank_and_silent_surfaces_are_counted() {
        for s in SURFACES {
            if let EmptyState::Copy(copy) = s.empty_state {
                assert!(!copy.trim().is_empty(), "{:?} has blank copy", s.id);
            }
        }
        let silent = SURFACES
            .iter()
            .filter(|s| s.empty_state == EmptyState::Silent)
            .count();
        assert_eq!(
            silent, SILENT_EMPTY_STATES,
            "the silent-empty ledger and the registry disagree — update both"
        );
    }

    /// The P0-5 ledger: property rows not yet on the control-height scale.
    #[test]
    fn off_standard_property_rows_are_counted() {
        let off: Vec<SurfaceId> = SURFACES
            .iter()
            .filter(|s| s.property_rows && !s.on_standard)
            .map(|s| s.id)
            .collect();
        assert_eq!(
            off.len(),
            OFF_STANDARD_SURFACES,
            "the off-standard ledger and the registry disagree — update both"
        );
        assert_eq!(
            off,
            vec![SurfaceId::EdFlow, SurfaceId::EdShip, SurfaceId::EdUx],
            "the cross-screen pass is FLOW, SHIP and UX ANALYSIS"
        );
        // the rows a surface owes are the tallest step of the scale
        assert_eq!(row_height(), ControlHeight::Control.px());
        assert_eq!(row_height(), 28.0);
    }

    /// Content that scrolls under pinned chrome has to be clipped, or scrolled
    /// rows overdraw the header they are supposed to scroll under (P0-6).
    #[test]
    fn only_dock_panels_scroll_under_pinned_chrome() {
        for s in SURFACES.iter().filter(|s| s.scroll == ScrollRule::Pinned) {
            assert!(
                matches!(s.kind, SurfaceKind::Dock | SurfaceKind::Panel),
                "{:?} is pinned but is a {:?}",
                s.id,
                s.kind
            );
        }
    }
}
