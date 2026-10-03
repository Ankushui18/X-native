//! The greys the engine paints when there is nothing better to paint.
//!
//! Two decisions used to live at several sites each — the missing-asset box at
//! three (`Node::image`'s default fill, the Vello scene sink, the tiny-skia
//! raster sink, whose comment promised it "matches the Vello sink") and the
//! pattern fallback at two (`Variables::flat_color`, the renderer's brush
//! resolution) — which is a promise and a coincidence, not a design system.
//! `tools/design-sheet/guard.mjs` fails if either value is written out a second
//! time, so this file stays the only owner.

use crate::Color;

/// The grey a *missing asset* paints: the default fill of `Node::image`, the
/// scene sink's placeholder and the raster sink's box are the same decision —
/// "there is no bitmap here".
pub fn missing_asset_grey() -> Color {
    Color::from_rgb8(0xdd, 0xdd, 0xdd)
}

/// The neutral grey a *pattern* paint falls back to where a flat colour is
/// required (strokes, text fills, lines — a pattern cannot clip those).
pub fn pattern_fallback_grey() -> Color {
    Color::from_rgb8(0x99, 0x99, 0x99)
}
