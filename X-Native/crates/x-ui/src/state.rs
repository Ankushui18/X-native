//! One state language for every component (Refinement v1, P0-7).
//!
//! Canvas *selection*, keyboard *focus* and pointer *hover* are three
//! questions with three different answers, and before P0-7 two of them shared
//! one colour — a hovered row and a focused row were the same violet. This
//! module is the answer in data: a component asks [`resolve`] what to paint and
//! receives a base fill plus an optional ring.
//!
//! The ring is *additive*: focus does not replace selection, it is drawn on top
//! of it. A selected row that also has keyboard focus reads as both, which is
//! what a user hitting Tab through a list of selected layers expects.
//!
//! Every role named here is looked up in [`COLOR_ROLES`] by a test, so this
//! module cannot invent a colour the palette does not have.

/// The base state of a component — the fill and outline it paints before any
/// ring is drawn on top.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum WidgetState {
    /// Nothing has happened to it. A field's resting fill.
    #[default]
    Rest,
    /// The pointer is over it.
    Hover,
    /// The pointer is down on it.
    Active,
    /// It is the current selection (a layer row, an active tool, a tab).
    Selected,
    /// It cannot be acted on. Disabling wins over every other input.
    Disabled,
}

impl WidgetState {
    /// The palette role that fills the component in this state.
    pub const fn fill_role(self) -> &'static str {
        match self {
            Self::Rest => "surface_elevated",
            Self::Hover => "surface_hover",
            Self::Active => "surface_active",
            Self::Selected => "surface_active",
            // A disabled control sinks into the panel: it is chrome that is
            // not offering anything.
            Self::Disabled => "surface",
        }
    }

    /// The palette role that outlines it — `None` at rest, because the outline
    /// is the affordance and a resting field has nothing to say.
    pub const fn line_role(self) -> Option<&'static str> {
        match self {
            Self::Rest | Self::Disabled => None,
            Self::Hover | Self::Active => Some("border_strong"),
            Self::Selected => Some("selection"),
        }
    }

    /// The palette role for its label and icon ink.
    pub const fn ink_role(self) -> &'static str {
        match self {
            Self::Disabled => "text_placeholder",
            _ => "text_primary",
        }
    }

    /// Whether it still responds to input.
    pub const fn is_interactive(self) -> bool {
        !matches!(self, Self::Disabled)
    }
}

/// A ring drawn on top of the base state — never instead of it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ring {
    /// Keyboard focus: the lighter `focus_ring` role, so it cannot be confused
    /// with the `selection` role a selected row already carries.
    Focus,
    /// The in-place text editor's border. Editing *is* focus — the caret is
    /// where the keyboard attention is — so it takes the same role.
    Edit,
}

impl Ring {
    pub const fn role(self) -> &'static str {
        "focus_ring"
    }
}

/// What one component paints for one combination of inputs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StatePaint {
    pub base: WidgetState,
    pub ring: Option<Ring>,
}

/// Resolve the raw flags a paint pass has into the one state to paint.
///
/// Precedence: disabled beats everything; selection outranks hover (a selected
/// row stays selected while the pointer crosses it); focus is a ring on top of
/// whatever the base turned out to be.
pub fn resolve(hover: bool, selected: bool, focused: bool, disabled: bool) -> StatePaint {
    if disabled {
        return StatePaint {
            base: WidgetState::Disabled,
            ring: None,
        };
    }
    let base = if selected {
        WidgetState::Selected
    } else if hover {
        WidgetState::Hover
    } else {
        WidgetState::Rest
    };
    StatePaint {
        base,
        ring: if focused { Some(Ring::Focus) } else { None },
    }
}

/// Every role this module can name. The test below checks them all against the
/// palette, which is what keeps the state language and the palette in step.
pub const STATE_ROLES: &[&str] = &[
    "surface_elevated",
    "surface_hover",
    "surface_active",
    "surface",
    "border_strong",
    "selection",
    "text_primary",
    "text_placeholder",
    "focus_ring",
];

#[cfg(test)]
mod tests {
    use super::*;
    // Imported here, not at the top of the module: the palette is what the
    // test checks the state language against, and an import only the test
    // reads would be unused — and therefore warned about — in the lib build.
    use crate::design_system::COLOR_ROLES;

    /// The whole point of P0-7: the three states must be three *different*
    /// roles, or one of them is impersonating another.
    #[test]
    fn hover_selection_and_focus_are_three_different_roles() {
        let hover = resolve(true, false, false, false);
        let selected = resolve(false, true, false, false);
        let focused = resolve(false, false, true, false);

        // the fill of a hovered control, the outline of a selected one and the
        // ring of a focused one: three different answers to three questions
        let roles = [
            hover.base.fill_role(),
            selected.base.line_role().unwrap(),
            focused.ring.unwrap().role(),
        ];
        assert_eq!(roles, ["surface_hover", "selection", "focus_ring"]);
        assert_eq!(
            roles.iter().collect::<std::collections::HashSet<_>>().len(),
            3,
            "the three states must not share a role"
        );
    }

    #[test]
    fn focus_is_a_ring_on_top_of_the_base_state_not_instead_of_it() {
        let both = resolve(false, true, true, false);
        assert_eq!(both.base, WidgetState::Selected);
        assert_eq!(both.ring, Some(Ring::Focus));
        // and the ring is the same role whichever meaning asked for it
        assert_eq!(Ring::Focus.role(), Ring::Edit.role());
    }

    #[test]
    fn disabled_wins_and_drops_the_ring() {
        let disabled = resolve(true, true, true, true);
        assert_eq!(disabled.base, WidgetState::Disabled);
        assert_eq!(disabled.ring, None, "a disabled control draws no ring");
        assert!(!disabled.base.is_interactive());
    }

    #[test]
    fn selection_outranks_hover_and_rest_is_the_default() {
        assert_eq!(
            resolve(true, true, false, false).base,
            WidgetState::Selected
        );
        assert_eq!(resolve(true, false, false, false).base, WidgetState::Hover);
        assert_eq!(resolve(false, false, false, false).base, WidgetState::Rest);
        // only the states that say something carry an outline
        assert_eq!(WidgetState::Rest.line_role(), None);
        assert_eq!(WidgetState::Hover.line_role(), Some("border_strong"));
    }

    /// A role this module names but the palette does not define would be a
    /// colour no theme can remap — the bug P0-7 was fixing in the first place.
    #[test]
    fn every_role_named_here_is_a_role_the_palette_defines() {
        for role in STATE_ROLES {
            assert!(
                COLOR_ROLES.contains(role),
                "{role} is not a palette role — add it to ColorTokens"
            );
        }
        for state in [
            WidgetState::Rest,
            WidgetState::Hover,
            WidgetState::Active,
            WidgetState::Selected,
            WidgetState::Disabled,
        ] {
            assert!(STATE_ROLES.contains(&state.fill_role()));
            assert!(STATE_ROLES.contains(&state.ink_role()));
            if let Some(line) = state.line_role() {
                assert!(STATE_ROLES.contains(&line));
            }
        }
        assert!(STATE_ROLES.contains(&Ring::Focus.role()));
    }
}
