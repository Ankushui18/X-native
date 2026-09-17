//! The control-height and rhythm standard — one scale for every surface that
//! owns property rows.
//!
//! This is the P0-9 standard from the Refinement v1 milestone, declared in the
//! component layer instead of in the designer's `theme.rs`: a screen that owns
//! property rows imports [`CONTROL_H`] and the gaps beside it rather than
//! restating a number, so the scale has one definition the whole app can be
//! measured against.
//!
//! What each step is *for* is written up in `docs/COMPONENT_CONTRACT.md`; the
//! heights this scale replaced (19px sizing chip, 20px eye button, 22px style
//! buttons, 32px gap/padding rows) are itemised in
//! `docs/REFINEMENT_V1_PLAN.md` under P0-9.
//!
//! The gaps sit on the shared [`SpacingScale`] on purpose: the rhythm between
//! rows is spacing, and the spacing scale already owns spacing.

use crate::design_system::SpacingScale;

/// Every property row — inputs, dropdowns, action buttons — is this tall.
pub const CONTROL_H: f64 = 28.0;

/// Disclosure and summary rows: "Advanced", clip content, Fixed|Fill. One step
/// below a property row, because a summary row is not an editable value.
pub const DENSE_H: f64 = 24.0;

/// Checkboxes, switches and inline chips (Hug/Fixed, the padding glyph).
pub const CHIP_H: f64 = 16.0;

/// Square icon buttons. Not a fourth step: it is [`CONTROL_H`], named from the
/// button's point of view so a row of controls reads as one line of code.
pub const SQUARE_H: f64 = CONTROL_H;

/// row→row, row→label, row→disclosure.
pub const ROW_GAP: f64 = SpacingScale::SPACE_3;

/// label→control.
pub const LABEL_GAP: f64 = SpacingScale::SPACE_2;

/// content→hline, hline→next section.
pub const SECTION_GAP: f64 = SpacingScale::SPACE_4;

/// The three heights a property-row control may have.
pub const CONTROL_HEIGHTS: [f64; 3] = [CONTROL_H, DENSE_H, CHIP_H];

/// Which step of the scale a control belongs to.
///
/// Call sites name the step (`ControlHeight::Dense`) rather than the number, so
/// a review can see *why* a row is 24 and not 28.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ControlHeight {
    /// A property row: inputs, dropdowns, action buttons, square icon buttons.
    Control,
    /// A disclosure or summary row.
    Dense,
    /// A checkbox, switch or inline chip.
    Chip,
}

impl ControlHeight {
    /// The step's height in pixels.
    pub const fn px(self) -> f64 {
        match self {
            Self::Control => CONTROL_H,
            Self::Dense => DENSE_H,
            Self::Chip => CHIP_H,
        }
    }

    /// Every step, tallest first — the order a review reads a panel in.
    pub const ALL: [Self; 3] = [Self::Control, Self::Dense, Self::Chip];
}

/// True when `h` is one of the three steps — the test a row height has to pass
/// before its surface can be called on-standard.
pub const fn is_control_height(h: f64) -> bool {
    h == CONTROL_H || h == DENSE_H || h == CHIP_H
}

/// The step an off-scale height should snap to.
///
/// The thresholds are the midpoints between the steps (26 = halfway between 24
/// and 28, 20 = halfway between 16 and 24), written as comparisons so this
/// stays a `const fn` with no float arithmetic in it. A height exactly on a
/// midpoint rounds up.
pub const fn nearest_control_height(h: f64) -> ControlHeight {
    if h >= 26.0 {
        ControlHeight::Control
    } else if h >= 20.0 {
        ControlHeight::Dense
    } else {
        ControlHeight::Chip
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scale_is_three_steps_and_nothing_else() {
        assert_eq!(CONTROL_HEIGHTS, [28.0, 24.0, 16.0]);
        assert_eq!(SQUARE_H, CONTROL_H, "a square button is a row height");
        for step in ControlHeight::ALL {
            assert!(
                is_control_height(step.px()),
                "every step names a height on the scale"
            );
        }
    }

    #[test]
    fn the_rhythm_sits_on_the_shared_spacing_scale() {
        assert_eq!(ROW_GAP, SpacingScale::SPACE_3);
        assert_eq!(LABEL_GAP, SpacingScale::SPACE_2);
        assert_eq!(SECTION_GAP, SpacingScale::SPACE_4);
    }

    /// The four heights P0-9 removed from the inspector. They are the reason
    /// this function exists: each of them was a row height no scale contained.
    #[test]
    fn the_heights_p0_9_removed_are_off_the_scale() {
        for h in [19.0, 20.0, 22.0, 32.0] {
            assert!(!is_control_height(h), "{h} must not be a step");
        }
    }

    #[test]
    fn off_scale_heights_snap_to_the_step_they_were_reaching_for() {
        // 22px tree rows and 32px gap rows are dense rows wearing a control
        // row's clothes; the 19px chip was a chip that grew 3px.
        assert_eq!(nearest_control_height(32.0), ControlHeight::Control);
        assert_eq!(nearest_control_height(22.0), ControlHeight::Dense);
        assert_eq!(nearest_control_height(19.0), ControlHeight::Chip);
    }

    #[test]
    fn steps_round_trip_through_the_nearest_lookup() {
        for step in ControlHeight::ALL {
            assert_eq!(nearest_control_height(step.px()), step);
        }
    }
}
