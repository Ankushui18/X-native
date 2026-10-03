//! The component contract (Refinement v1, P0-2).
//!
//! Every piece of X-Native chrome is one of the components below. This module
//! is the inventory — what exists, how tall it is, which states it paints, and
//! whether it registers a hit region — rather than the widgets themselves: the
//! painters still live in the designer, and move here as the surfaces that use
//! them are reworked (the board and FLOW / SHIP / UX ANALYSIS in P0-5).
//!
//! What the fields *mean*, and the rules a new component has to satisfy before
//! it is added here, are in `docs/COMPONENT_CONTRACT.md`. The two rules that
//! are enforced by the tests below rather than by a reviewer:
//!
//! - **No phantom controls.** A component that responds to the pointer
//!   ([`ComponentKind::Interactive`]) registers a hit region; a component that
//!   cannot be clicked ([`ComponentKind::Decorative`]) must not paint a hover
//!   state that says otherwise. P0-4 removed three icons on the dashboard for
//!   exactly this.
//! - **One scale.** A component with a [`ControlHeight`] target that is marked
//!   on-standard is exactly that step tall. The two that are not — the 22px
//!   tree row and the 32px dropdown row — are counted by
//!   [`OFF_STANDARD_COMPONENTS`].

use crate::metrics::ControlHeight;
use crate::state::WidgetState;

/// What a component is for, which decides what it may paint.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ComponentKind {
    /// It responds to the pointer: it has a hit region, and it paints hover.
    Interactive,
    /// It is painted only — a label, a divider, a tooltip. It never hovers,
    /// because it never acts.
    Decorative,
    /// It hosts other components (a card, a menu) and has no height of its
    /// own.
    Container,
}

/// Where the component's painter lives today.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Owner {
    /// Painted by the designer's chrome (`editor_ui`, `dashboard`, `board_ui`).
    App,
    /// Painted from `x-ui` itself.
    XUi,
}

/// One row of the contract.
#[derive(Clone, Copy, Debug)]
pub struct ComponentSpec {
    pub id: ComponentId,
    /// The name used in reviews and in the docs — not a label shown in the UI.
    pub name: &'static str,
    pub kind: ComponentKind,
    /// Its height, or `None` when it has none of its own: a container sizes to
    /// its content and a decoration is a line or a run of text.
    pub height: Option<f64>,
    /// The step of the control-height scale it must snap to, or `None` when the
    /// scale deliberately does not apply — a toolbar button or a dashboard list
    /// row is its own idiom, not a property row.
    pub target: Option<ControlHeight>,
    /// It sits on its step today. `false` is a debt, counted by
    /// [`OFF_STANDARD_COMPONENTS`].
    pub on_standard: bool,
    /// It registers a hit region, so clicking it does what it looks like.
    pub hit: bool,
    /// It draws a focus ring when it holds keyboard focus.
    pub focus_ring: bool,
    /// The states it paints. Every interactive component paints at least rest,
    /// hover and disabled.
    pub states: &'static [WidgetState],
    pub owner: Owner,
}

/// The components X-Native chrome is built from.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum ComponentId {
    // — property rows (the control-height scale) —
    Field,
    NumberField,
    Select,
    SquareButton,
    SmallIconButton,
    Checkbox,
    Switch,
    SegmentedChip,
    DisclosureRow,
    SectionHeader,
    TreeRow,
    MenuRow,
    DropdownRow,
    // — idioms the scale deliberately does not cover —
    ToolbarButton,
    ToolbarPill,
    SearchField,
    DraftRow,
    // — containers and painted-only chrome —
    Card,
    Menu,
    Tooltip,
    Hline,
    CapsLabel,
}

pub static COMPONENTS: &[ComponentSpec] = &[
    // ——————————————————————————————————————— property rows (28 / 24 / 16)
    ComponentSpec {
        id: ComponentId::Field,
        name: "field",
        kind: ComponentKind::Interactive,
        height: Some(28.0),
        target: Some(ControlHeight::Control),
        on_standard: true,
        hit: true,
        focus_ring: true,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::NumberField,
        name: "number field",
        kind: ComponentKind::Interactive,
        height: Some(28.0),
        target: Some(ControlHeight::Control),
        on_standard: true,
        hit: true,
        // a measurement is right-aligned in the mono face, so a column of them
        // shares an edge and can be compared without reading each value
        focus_ring: true,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::Select,
        name: "select",
        kind: ComponentKind::Interactive,
        height: Some(28.0),
        target: Some(ControlHeight::Control),
        on_standard: true,
        hit: true,
        focus_ring: true,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Active],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::SquareButton,
        name: "square icon button",
        kind: ComponentKind::Interactive,
        height: Some(28.0),
        target: Some(ControlHeight::Control),
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[
            WidgetState::Rest,
            WidgetState::Hover,
            WidgetState::Selected,
            WidgetState::Disabled,
        ],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::SmallIconButton,
        name: "small icon button",
        kind: ComponentKind::Interactive,
        height: Some(24.0),
        target: Some(ControlHeight::Dense),
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::Checkbox,
        name: "checkbox",
        kind: ComponentKind::Interactive,
        height: Some(16.0),
        target: Some(ControlHeight::Chip),
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Selected],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::Switch,
        name: "switch",
        kind: ComponentKind::Interactive,
        height: Some(16.0),
        target: Some(ControlHeight::Chip),
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Selected],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::SegmentedChip,
        name: "segmented chip",
        kind: ComponentKind::Interactive,
        height: Some(16.0),
        target: Some(ControlHeight::Chip),
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Selected],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::DisclosureRow,
        name: "disclosure row",
        kind: ComponentKind::Interactive,
        height: Some(24.0),
        target: Some(ControlHeight::Dense),
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::SectionHeader,
        name: "section header",
        kind: ComponentKind::Interactive,
        height: Some(24.0),
        target: Some(ControlHeight::Dense),
        on_standard: true,
        // the header itself is inert; the `plus` at its right edge is the
        // control, and that is the rect that carries the hit region
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::TreeRow,
        name: "tree row",
        kind: ComponentKind::Interactive,
        height: Some(22.0),
        target: Some(ControlHeight::Dense),
        // 22px predates the scale; a tree is dense on purpose, but the step it
        // should be is 24. P0-5 snaps it.
        on_standard: false,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Selected],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::MenuRow,
        name: "menu row",
        kind: ComponentKind::Interactive,
        height: Some(28.0),
        target: Some(ControlHeight::Control),
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::DropdownRow,
        name: "dropdown row",
        kind: ComponentKind::Interactive,
        height: Some(32.0),
        target: Some(ControlHeight::Control),
        // 32px: the frame / line-height / text-style pickers. A dropdown row is
        // a property row with a taller line box; P0-5 puts it on 28.
        on_standard: false,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Selected],
        owner: Owner::App,
    },
    // ——————————————————————————————————————————————————————————— idioms
    ComponentSpec {
        id: ComponentId::ToolbarButton,
        name: "toolbar button",
        kind: ComponentKind::Interactive,
        height: Some(32.0),
        // A tool is not a property row: it is an icon in a 40px bar, and the
        // hit target matters more than the row grid.
        target: None,
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Selected],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::ToolbarPill,
        name: "toolbar pill",
        kind: ComponentKind::Interactive,
        height: Some(30.0),
        target: None,
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover, WidgetState::Selected],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::SearchField,
        name: "search field",
        kind: ComponentKind::Interactive,
        height: Some(32.0),
        target: None,
        on_standard: true,
        hit: true,
        focus_ring: true,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::DraftRow,
        name: "draft row",
        kind: ComponentKind::Interactive,
        height: Some(48.0),
        // A file row: a name, a timestamp and a hover wash. It is a list
        // idiom, not a property row.
        target: None,
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    // ——————————————————————————————————————————— containers & decoration
    ComponentSpec {
        id: ComponentId::Card,
        name: "card",
        kind: ComponentKind::Container,
        height: None,
        target: None,
        on_standard: true,
        hit: true,
        focus_ring: false,
        states: &[WidgetState::Rest, WidgetState::Hover],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::Menu,
        name: "menu",
        kind: ComponentKind::Container,
        height: None,
        target: None,
        on_standard: true,
        // the rows inside it carry the hit regions, not the menu box
        hit: false,
        focus_ring: false,
        states: &[WidgetState::Rest],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::Tooltip,
        name: "tooltip",
        kind: ComponentKind::Decorative,
        height: None,
        target: None,
        on_standard: true,
        hit: false,
        focus_ring: false,
        states: &[WidgetState::Rest],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::Hline,
        name: "divider",
        kind: ComponentKind::Decorative,
        height: None,
        target: None,
        on_standard: true,
        hit: false,
        focus_ring: false,
        states: &[WidgetState::Rest],
        owner: Owner::App,
    },
    ComponentSpec {
        id: ComponentId::CapsLabel,
        name: "caps label",
        kind: ComponentKind::Decorative,
        height: None,
        target: None,
        on_standard: true,
        hit: false,
        focus_ring: false,
        states: &[WidgetState::Rest],
        owner: Owner::App,
    },
];

/// Every [`ComponentId`], so a test can assert the registry covers the enum.
pub const COMPONENT_VARIANTS: &[ComponentId] = &[
    ComponentId::Field,
    ComponentId::NumberField,
    ComponentId::Select,
    ComponentId::SquareButton,
    ComponentId::SmallIconButton,
    ComponentId::Checkbox,
    ComponentId::Switch,
    ComponentId::SegmentedChip,
    ComponentId::DisclosureRow,
    ComponentId::SectionHeader,
    ComponentId::TreeRow,
    ComponentId::MenuRow,
    ComponentId::DropdownRow,
    ComponentId::ToolbarButton,
    ComponentId::ToolbarPill,
    ComponentId::SearchField,
    ComponentId::DraftRow,
    ComponentId::Card,
    ComponentId::Menu,
    ComponentId::Tooltip,
    ComponentId::Hline,
    ComponentId::CapsLabel,
];

/// Components with a scale target they do not sit on yet. P0-5 owns this
/// number: it is the 22px tree row and the 32px dropdown row.
pub const OFF_STANDARD_COMPONENTS: usize = 2;

/// Components whose painter has moved into `x-ui`. Zero today: this milestone
/// lands the contract first, and the painters move with the surfaces that use
/// them (P0-5 and after).
pub const MIGRATED_TO_X_UI: usize = 0;

/// Components that can be *unavailable* — that paint `WidgetState::Disabled`.
/// One today: the square icon button is the only control the chrome can dim
/// (`sq_btn`'s `dimmed` flag). Everything else is drawn as always-actionable,
/// which is a claim worth revisiting the moment a panel gains a control that
/// depends on the selection.
pub const DISABLEABLE_COMPONENTS: usize = 1;

pub fn component(id: ComponentId) -> Option<&'static ComponentSpec> {
    COMPONENTS.iter().find(|c| c.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_component_variant_has_a_spec_and_no_two_rows_share_one() {
        assert_eq!(COMPONENTS.len(), COMPONENT_VARIANTS.len());
        for id in COMPONENT_VARIANTS {
            let spec = component(*id).unwrap_or_else(|| panic!("no spec for {id:?}"));
            assert_eq!(spec.id, *id);
            assert!(!spec.name.is_empty());
        }
        let mut ids: Vec<ComponentId> = COMPONENTS.iter().map(|c| c.id).collect();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count, "a component id appears twice");
    }

    /// The no-phantom-controls rule, in the only form a test can check: a
    /// component that acts registers a hit region, and one that does not act
    /// never paints a hover that claims it does.
    #[test]
    fn interactive_components_register_a_hit_and_decorative_ones_never_hover() {
        for c in COMPONENTS {
            match c.kind {
                ComponentKind::Interactive => assert!(
                    c.hit,
                    "{} is interactive but registers no hit region",
                    c.name
                ),
                ComponentKind::Decorative => {
                    assert!(!c.hit, "{} is painted only but takes a hit", c.name);
                    assert!(
                        !c.states.contains(&WidgetState::Hover),
                        "{} cannot be clicked, so it must not paint hover",
                        c.name
                    );
                }
                // a container's rows carry the hits
                ComponentKind::Container => {}
            }
        }
    }

    #[test]
    fn every_interactive_component_paints_rest_and_hover() {
        for c in COMPONENTS
            .iter()
            .filter(|c| c.kind == ComponentKind::Interactive)
        {
            assert!(c.states.contains(&WidgetState::Rest), "{}", c.name);
            assert!(c.states.contains(&WidgetState::Hover), "{}", c.name);
        }
    }

    /// How much of the chrome can be unavailable: one component today. A panel
    /// that gains a conditional control raises this instead of quietly drawing
    /// a control that cannot be pressed as if it could.
    #[test]
    fn disableable_components_are_counted() {
        let disabled = COMPONENTS
            .iter()
            .filter(|c| c.states.contains(&WidgetState::Disabled))
            .count();
        assert_eq!(
            disabled, DISABLEABLE_COMPONENTS,
            "the disableable ledger and the registry disagree — update both"
        );
        assert!(
            COMPONENTS.iter().any(|c| {
                c.id == ComponentId::SquareButton && c.states.contains(&WidgetState::Disabled)
            }),
            "the square icon button is the control the chrome dims"
        );
    }

    #[test]
    fn on_standard_components_sit_exactly_on_their_step() {
        let off: Vec<ComponentId> = COMPONENTS
            .iter()
            .filter(|c| !c.on_standard)
            .map(|c| c.id)
            .collect();
        assert_eq!(
            off.len(),
            OFF_STANDARD_COMPONENTS,
            "the off-standard ledger and the registry disagree — update both"
        );
        assert_eq!(
            off,
            vec![ComponentId::TreeRow, ComponentId::DropdownRow],
            "the two rows that predate the scale"
        );
        for c in COMPONENTS {
            let Some(target) = c.target else {
                // no target: a deliberate idiom, so it is on-standard by
                // definition — there is no step it could be off
                assert!(c.on_standard, "{} has no step to miss", c.name);
                continue;
            };
            if c.on_standard {
                assert_eq!(
                    c.height,
                    Some(target.px()),
                    "{} is marked on-standard but is not {}px",
                    c.name,
                    target.px()
                );
            } else {
                assert_ne!(
                    c.height,
                    Some(target.px()),
                    "{} is marked off-standard but already sits on its step",
                    c.name
                );
            }
        }
    }

    /// The migration ledger: how much of the chrome `x-ui` paints. It only ever
    /// goes up, and the test is what stops this file from claiming it did.
    #[test]
    fn the_migration_ledger_matches_the_registry() {
        assert_eq!(
            COMPONENTS.iter().filter(|c| c.owner == Owner::XUi).count(),
            MIGRATED_TO_X_UI
        );
    }
}
