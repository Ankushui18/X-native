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

## The sheet

`X-Native/tools/design-sheet/` is a live page generated from these sources
(`node extract_icons.mjs && node build_tokens.mjs && node build_audit.mjs`,
then serve the folder — see its README): the three palettes side by side, every
ladder, the dashboard at 1440 / 980 / 1920, and the spacing + ratchet audit.
Because the generators read `design_system.rs`, `theme.rs`, `icons.rs` and
`design_tokens_test.rs`, the sheet cannot claim a value the code does not ship —
and `check.mjs` smoke-tests the rendered page in jsdom.

## Themes (light, dark, high contrast)

Three palettes, all shipped, all audited by the crate's own tests:

| id | label | for | notes |
|---|---|---|---|
| `Graphite` | dark | the default, and the palette every app constant is authored in | |
| `Daylight` | light | bright rooms, projectors, screen sharing | white surfaces, darker accent, hairlines carry the structure |
| `HighContrast` | high contrast | low vision / accessibility settings | yellow accent with **black** ink, 7:1+ pairs |

Switching is a first-class action, not a debug flag: `Action::SetTheme(id)`,
`Action::CycleTheme` (the toolbar button), the ⌘K verbs `Theme: Daylight
(light)` / `Theme: High Contrast`, and the choice is persisted to
`~/.config/x-native/theme` (`set_theme` / `load_persisted_theme`).

How it works, and what it means for new code:

- every constant in `theme.rs` is authored in Graphite and resolved through
  `role!()` → `ColorTokens`; at paint time `resolve()` maps a colour onto the
  active palette **by value** through the role table (`remap_color` keeps
  alpha, so washes and scrims stay washes and scrims);
- therefore a colour built from a role follows the theme automatically, and a
  colour built from a literal does not — that is the point of the ratchet's
  "say why in a comment" rule for literals;
- ink is a role in every palette (`C_ON_ACCENT`, `C_ON_DANGER`, `C_BLACK`,
  `C_ACCENT_INK`) precisely so no palette can produce black-on-black or
  white-on-yellow;
- the brand set (logo green, avatar and team hues, draft dot, markdown badge,
  canvas guides, watermarks) deliberately does **not** follow the theme: a
  theme must never repaint the user's artwork.

If you add a role, it exists in all three palettes or it does not compile a
lookup — `COLOR_ROLES`, `role()` and the DTCG export are cross-checked, and
`every_shipped_palette_is_aa_clean` re-runs the contrast audit for each.

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

### Keyboard and pointer (dashboard)

The dashboard is a file browser, so it behaves like one:

- **Tab / Shift+Tab** walk its controls in paint order (sidebar → top bar →
  quick actions → file grid → drafts); the ring is painted from the same hit
  list the mouse uses (`dashboard::focus_targets`), and Tab out of a focused
  search box moves the ring rather than inserting a tab;
- **Enter** fires the focused control through the same `dispatch` a click uses;
- **Escape** drops the ring; the next Tab starts from the top;
- a **click** puts the ring on whatever was clicked (focus follows the
  pointer), so the keyboard and the pointer never disagree;
- the pointer itself says what it will do: `Text` over the search field,
  `Pointer` over any control (it was a plain arrow everywhere before —
  `cursor_for` in `run.rs`).

Add a control to the dashboard and it is keyboard-reachable for free, because
focus is derived from the hit list rather than a second list of stops.

**Multi-select and sorting follow the same rule.** `dashboard::visible_files`
is the single list of "what is on screen, in what order" — the grid, the table,
"select all" and the bulk actions all read it, so they cannot disagree:

- the sort chip (grid) and the column headers (table) set `DashSort`
  (`Edited` / `Name` / `Starred first`); the sort key is parsed from the label
  the UI already shows (`edited_minutes`), so ordering and wording cannot
  drift, and an unknown label sorts last rather than first;
- Cmd/Ctrl-click or Shift-click toggles a file's membership, Cmd/Ctrl+A selects
  everything visible, Escape unwinds one step at a time (menu → selection →
  ring);
- the bulk bar only exists while something is selected, swallows presses on its
  own background, and offers only actions that really do something —
  `Remove from recents` says what it is, because the files on disk stay put.

### Ink
Text and glyphs never take a *fill* role. On a saturated fill:
`C_ON_ACCENT` (white in the dark and light palettes, black on high contrast),
`C_ON_DANGER` for the unread badge, `C_BLACK` on a brand/team hue. In the
accent's own colour: `C_ACCENT_INK` (`accent_ink` — the accent itself measures
3.13:1 on the panel and 2.80:1 on a raised surface, so it is a fill, not a
label). The ratchet enforces both: a bare `Color::WHITE` used as ink and an
accent token in the colour slot of `fonts.text` / `text_center` / `draw_icon`
both fail the build.

**Text roles are audited, including placeholders.** `TEXT_ROLES` in
`crates/x-ui/src/theme.rs` is the list of roles checked at 4.5:1 against all
six surfaces — `text_placeholder` used to be exempt as "faint by intent",
which shipped `#6B6E7A` (2.56:1 on a hover fill). It is now `#939AA6`
(Graphite, 4.59:1 worst), `#5B6274` (Daylight, 4.93:1) and `#B8B8B8` (high
contrast, 7.24:1), each still dimmer than its `text_dim` so the hierarchy
holds. The only remaining exemption is the hairline border pair, which carries
no meaning on its own.

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
- a file's bare `Color::WHITE` / `Color::BLACK` count exceeds its ink ceiling;
- type or a glyph is painted in an accent token instead of `C_ACCENT_INK`;
- a file's raw-colour count exceeds its ceiling (a ratchet: lower it when you
  fix one, never raise it);
- a `pub const C_*` in `theme.rs` is a literal with no comment saying why it is
  not a role.

Current ceilings (2026-09-17) — colours: dashboard 2, editor_ui 13, board_ui 3,
loading 1, command 0, paint 2, run 4, state 22, icons 0, theme 24; ink:
editor_ui 3, state 3, everything else 0 (a document default is content, so
those whites stay and say so).

## Spacing, padding and resize

Measured from the paint code (`node build_audit.mjs` prints this): 616 literal
offsets, **46% on the ladder** (4/6/8/12/16/20/24/32/40/48). The rest are
deliberately not gaps — they are optical nudges like centring a 14px glyph in a
32px chip `(32−14)/2 = 9`, which are arithmetic about a box, not spacing about a
layout. The rule for new chrome:

- container padding comes from `SP_*` (8 for palette rows, 12 for panel
  interiors, 16–24 for page/card padding);
- centring inside a known box may stay arithmetic — write it as arithmetic
  when the box is a token, and it will follow a UI-scale change;
- the pixel-cloned dashboard keeps its measured interiors (a comment says so
  per site) — those numbers came from a browser, and naming one `SP_5` would
  hide that.

**Resize.** The window opens at 1440×900 and has a 980×680 minimum. Everything
that divides a column is fluid, never fixed: the quick-action row is
`(mx1 − MX − 3·gap)/4` — **274px at 1440, 159px at 980** — and the 3-up grid is
`(… − 2·gap)/3`, 366.7 → 213.3. Two consequences are enforced:

- **text is measured against its container.** Any string that sits in a fluid
  box goes through `fonts.truncate(…)`; at the reference width nothing
  truncates, and a narrow window ellipsises instead of painting over the
  neighbouring card (quick cards, recent-file meta, gallery rows, draft rows);
- **the docks yield to the canvas.** The nav rail plus the two panels may not
  take the canvas below `ED_CANVAS_MIN` (280px): `editor_regions()` derives the
  regions from the window and the panel widths, the resizer stops at the floor,
  and `docks_never_eat_the_canvas` pins 6 window widths × 9 dock pairs. Before
  this, dragging both panels wide at the minimum window produced a canvas of
  −68px (an inverted rect handed to paint and hit-testing).

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
