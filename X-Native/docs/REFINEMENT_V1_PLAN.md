# X-Native — UI/UX Refinement v1

**Goal (from the 2026-09-18 audit):** feature breadth is sufficient; the gap is
consistent polish toward a first-class design tool. One design system, one
interaction language, every screen consistent, **no phantom controls**, a
stronger first-time workflow, and a visibly more polished
inspector/canvas/dashboard. This is refinement of the existing design — not a
restart, and not a copy of any other product's UI.

Standing rules for this milestone:

1. **No phantom controls.** A property shown in the inspector must change what
   renders — UI → engine → renderer, verified end to end — or it is hidden.
2. **No feature removal.** Complexity is hidden behind progressive disclosure
   ("Advanced"), never deleted.
3. **One state language.** Canvas *selection*, keyboard *focus*, and *hover*
   are three visually distinguishable states.
4. **Naming stays X-Native:** COMPOSE / FLOW / SHIP / UX ANALYSIS.
5. **Priority:** hierarchy > consistency > interaction > performance > effects.
   No glassmorphism/kinetic-scroll pass in this milestone.

## Status

### P0-6 · Phantom inspector controls — DONE (this branch)

The typography inspector was audited control-by-control against the engine:

| Control | Before | Now |
|---|---|---|
| Horizontal alignment | decorative 6-icon row (no action); a cycle dropdown that offered **Justified**, which the shaper does not stretch | **3 working L/C/R buttons**, active state mirrors what renders (Justified degrades to Left, so it is not offered) |
| Vertical alignment | wired but the engine ignored it | **wired end to end** — every sink places the block Top/Middle/Bottom in the node box |
| Decoration (underline/strike) | wired but the engine ignored it | **wired end to end** — one rect per line at CSS-like offsets |
| Max lines | wired but the engine ignored it | **wired end to end** — lines beyond the cap are dropped; block height covers what is emitted |
| Paragraph indent | wired but the engine ignored it | **wired end to end** — first line of each paragraph shifts |
| Word spacing | read by the IR path but **dropped by the canvas scene path** | canvas scene path now reads the `ws` binding, matching every sink |
| Wrap style | toggled `node.wrap_style` (Normal/BreakWord) — a **serialization-only field the engine never reads** | re-wired to the engine's real paragraph wrap strategy (the `tw` binding): Auto → Balance → Pretty |
| Truncation | editable, engine does not render it | **removed from the inspector** (model field kept for the format) |
| List style | editable, engine does not render it | **removed from the inspector** (model field kept for the format) |
| Font family/weight, size, line height (3 modes), letter spacing, word spacing, para spacing, baseline shift, case, small caps, optical size, width axis | already wired and rendered | unchanged |

Also fixed in the same section: the fill/stroke/effects tail started at
`y0+1041.5` — *above* the typography rows it was supposed to follow — and
painted over them; the section now ends at 1178, the divider at 1190.5, and
the tail at 1202.5 (scroll clamp updated to match).

Engine changes (all sinks agree: canvas GPU, PDF, PNG/JPG, SVG outline):

- `x-text`: `TextBlockStyle` gains `max_lines` / `paragraph_indent` /
  `decoration`; the outline functions take `align` + those three;
  `glyph_outlines` implements the cap, the per-paragraph first-line indent
  (CSS `text-indent` semantics), and per-line decoration rects. The shaped
  cache key includes all four, so a style change can never serve stale
  geometry. New tests cover alignment offsets, the line cap's height, the
  indent pattern, and decoration rects.
- `x-render`: `RenderCommand::Glyphs` carries the four values; the vello,
  raster, PDF and outline sinks apply vertical placement (`dy` from the
  shaped height vs the node box).
- `x-native::outline_text_node` (SVG/outline export) places the block the same
  way the canvas does.

### P0-7 · Selection / hover / focus as three states — DONE (this branch)

- `C_SEL` / `C_SEL_SOFT` / `C_SEL_WASH` / `C_SEL_HANDLE` now derive from the
  `selection` role (`#7C5CFC` in Graphite & Signal) instead of `focus_ring`.
- New `C_FOCUS` derives from `focus_ring` (`#A996FF`) for real input focus.
- `C_EDIT_BORDER` (in-place text editor) stays on `focus_ring` — editing is
  the focus state.
- Dashboard: the keyboard focus ring and the open-dropdown border use
  `C_FOCUS`; the template-card hover ring uses the quiet `C_LINE_2`
  (hover no longer impersonates selection).
- Regression test asserts the role mapping (`C_SEL = selection`,
  `C_FOCUS = focus_ring`).

### P0-3 · Drop the copy-the-reference framing — wording DONE

Code comments that described the UI as a "pixel clone" of a measured HTML
reference (dashboard header, theme notes, inspector geometry notes, tab-width
notes) now describe what they are: hand-tuned constants for a 1440px
composition. The constants themselves stay — they are data, and the audit
explicitly does not ask to re-platform the layout.

### Not yet done (queued)

- **P0-8 · Progressive disclosure.** Typography inspector: primary =
  Font / Weight / Size / Line height / Alignment (+ Vertical, Decoration,
  Wrap, Max lines, Paragraph indent); advanced = letter/word/para spacing,
  baseline shift, case, variable axes behind an "Advanced ▸" section.
  Auto Layout section: Direction / Sizing / Alignment / Gap / Padding
  primary; Wrap/Grow/Shrink/Min-Max/Absolute advanced.
- **P0-1/2 · Screen & component contract; x-ui as the component layer.**
  x-ui is currently a token repo the app does not import for widgets;
  Button/Input/Select/Section/LayerRow/etc. land there incrementally.
- **P0-4/5 · Dashboard + cross-screen visual language pass.**
- **P0-9 · Control height/spacing/typography audit** (one row height, one
  label style, one field style per screen).
- **P0-10 · First-time workflow** (Primary: Compose / Flow / Ship;
  Supporting: Structure / Library / Tokens / Variables / Agents / UX).
- **P1 · Professional editor interaction** (deep select, select-under-cursor,
  smart selection, …).
- **P2 · Polish/motion.**

## Verification

No local toolchain exists in the development sandbox — the gate is CI
(`scripts/check.sh`): workspace `cargo test`, clippy and fmt. The engine
slice is test-covered (x-text alignment/cap/indent/decoration + cache-key
tests; app-level regression tests for the theme role mapping).
