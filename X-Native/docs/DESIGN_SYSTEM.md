# The X-Native Design System (tokens, and how to use them)

**One rule.** If a colour, radius, icon size, type size, spacing step, wash
alpha, stroke width or duration is written as a literal inside a paint path,
that is the bug the next reviewer will find. Every one of them has a name in
`crate::theme`, and every name derives from `crates/x-ui/src/design_system.rs`
— the single source of truth, audited by tests.

```
crates/x-ui/src/design_system.rs          <- the scales (owner)      |
   ColorTokens::GRAPHITE/DAYLIGHT/HIGH_CONTRAST                          |
   TypographyScale · SpacingScale · IconScale · RadiusScale ·            |  tests pin every
   ShadowScale · AlphaScale · StrokeScale · MotionScale                  |  ladder + the AA audit
crates/x-ui/src/theme.rs                  <- the WCAG audit + remap     |
apps/x-designer/.../theme.rs              <- the app's names for them   v
   C_* (roles)  R_* (radius)  ICON_*  T*  SP_*  A_*  STROKE_*
   design_tokens_test.rs                  <- the ratchet that keeps call sites honest
```

## The vocabularies

| Needs | Use | Steps |
|---|---|---|
| Colour | `C_*` — a **role**, never a hex | `C_PANEL`, `C_TEXT`, `C_SEL`, `C_DANGER_FILL`, `C_SUCCESS_WASH`, `C_SELECTION_EDGE`… |
| Corner | `R_*` — 2/4/6/8/12 only | `R_XS R_SM R_MD R_LG R_XL` + intent aliases `R_INPUT R_ROW R_CARD R_SEARCH R_PILL R_TREE R_TOOL_ICON R_LOGO` |
| Glyph | `ICON_*` + `STROKE_ICON` | `ICON_XS 12 · ICON_SM 14 · ICON_MD 16 · ICON_LG 18 · ICON_XL 24` |
| Type | `T*` | `T10 T11 T12 T13 T14 T16 T20`, tracked via `micro_label` (0.12em) / `caps_label` (0.08em) |
| Space | `SP_*` | `SP_1 4 · SP_2 6 · SP_3 8 · SP_4 12 · SP_5 16 · SP_6 20 · SP_7 24 · SP_8 32 · SP_9 40 · SP_10 48` |
| Wash alpha | `A_*` | `A_WHISPER 8 · A_FAINT 20 · A_SOFT 51 · A_MEDIUM 66 · A_STRONG 128` (0–255) |
| Border | `STROKE_HAIRLINE 1.0 · STROKE_RING 1.5` | |
| Motion | `MotionScale` (u32 ms + easing) | `fast 120 · base 180 · slow 240`; honour `DesignSystem::reduced_motion` |

### Adding a colour
A missing colour is a missing **role**, not a new hex at the call site:

1. add the role to `ColorTokens` (a `[u8; 3]`) **and** to `COLOR_ROLES` **and**
   to `ColorTokens::role()`;
2. give it a value in all three palettes (Graphite/Daylight/HighContrast);
3. if text is drawn on it, add the pair to the audit in
   `crates/x-ui/src/theme.rs` (`TEXT_ROLES`, `ACCENT_FILLS` or `LABEL_FILLS`);
4. expose it in `apps/.../theme.rs` as `pub const C_… = rgb(role!(…))`.

`resolve()` remaps a Graphite-authored colour by *equality on the role table*,
so a hex that is not a role cannot follow a theme switch — step 1 is what makes
the colour themeable at all. That is why `danger_fill`/`on_danger` exist: the
chrome needed a saturated badge and was one role short, so it invented
`#FF3B30` and shipped a 3.55:1 label.

## The exceptions (and their reasons)

A literal is allowed when it describes **the user's content**, not the chrome.
These are enumerated in `design_tokens_test.rs::CANVAS_SPACE_RADII` and by
comment in `theme.rs`:

- vector anchors/handles (radius 1.0/1.5) and one canvas mock's 18px frame —
  drawn next to artwork, so they follow the artwork;
- `Color::from_*` inside document/board construction — the user's own pixels;
- the brand set: logo green, avatar/team hues, draft dot, star, markdown badge,
  grid/guide colours — they must **not** repaint with a UI theme;
- watermarks on a thumbnail (`C_BLACK_10` / `C_WHITE_10`).

Everything else is chrome and belongs to a token.

## The ratchet

`design_tokens_test.rs` scans the production paint code (everything before the
first `#[cfg(test)]`) and fails the build when:

- any `draw_icon` size is numeric — the ladder is the only knob;
- any `_rrect` radius is numeric **and off the documented canvas-space list**;
- a file's raw-colour count exceeds its ceiling (a ratchet: lower it when you
  fix one, never raise it);
- a `pub const C_*` in `theme.rs` is a literal with no comment saying why it is
  not a role.

Current ceilings (2026-09-17): dashboard 2, editor_ui 13, board_ui 3,
loading 1, command 0, paint 2, run 4, state 22, icons 0, theme 24.

## What is *not* tokenised, on purpose

- **Measured coordinates.** The dashboard is a pixel clone of an audited
  reference: `+17.4`, `y 147.5`, `366.7` are measurements, not spacing
  decisions. Naming them would hide that a number came from a browser rather
  than from the system.
- **Gaps/padding (`SP_*`) in the pixel-cloned screens**, for the same reason —
  `SP_*` is for new UI and for chrome that declares intent (e.g.
  `command.rs::PADDING`), not for retro-fitted measurements.
- **UI scale.** `DesignSystem::scale` exists and is honoured by `space()` /
  `font_size()` / `scaled()`, but the shipped window paints in logical
  coordinates and no call site reads it yet: an interface-size setting needs
  the hit regions and the paint calls to scale together, which is its own
  change (see the audit's roadmap).
