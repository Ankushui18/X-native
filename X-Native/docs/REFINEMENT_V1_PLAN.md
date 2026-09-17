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

### P0-8 · Progressive disclosure — DONE (this branch)

Nothing was removed; the secondary properties moved behind a disclosure.

- **Typography inspector.** Primary (always visible): Font family, Weight,
  Size, Line height, Alignment (L/C/R buttons), Vertical alignment,
  Decoration, Wrap style, Max lines, Paragraph indent. Advanced (behind
  "Advanced ▸", off by default): Letter/Word spacing, Paragraph spacing /
  Baseline shift, Text case (small caps rides it), Optical size / Width
  (variable axes). The section's end — and the fill/stroke/effects tail
  below it — follow the disclosure state; the scroll clamp covers the
  worst case.
- **Auto Layout section.** Flow / Resizing (Hug-Fixed) / Alignment grid /
  Gap / Padding stay primary. Wrap (layout frames) and Fixed|Fill +
  Absolute (layout children) are the section's advanced rows: their band
  now shows an "Advanced" toggle, and the chevron at the band's right
  edge collapses it. Non-layout selections show no toggle (no phantom
  affordance).

### P0-9 · Control heights / spacing / typography standard — DONE (this branch)

One scale, declared in `theme.rs` and applied to the COMPOSE inspector:

- **Heights.** `INPUT_H` 28 = every property row (inputs, dropdowns,
  action buttons); `SQ_BTN` 28 = square icon buttons; `DENSE_H` 24 =
  disclosure / summary rows ("Advanced" rows, clip content, Fixed|Fill);
  `CHIP_H` 16 = checkboxes, switches, inline chips. The outliers are
  gone: 19px sizing chip, 20px eye button, 22px style buttons, 32px
  gap / padding rows — all now on the scale.
- **Rhythm.** `ROW_GAP` 8 (row→row, row→label, row→disclosure),
  `LABEL_GAP` 6 (label→control), `SECTION_GAP` 12 (content→hline,
  hline→section). The inspector previously mixed three dialects
  (header 8 / auto-layout 16+11 / typography 8+5.5 with drift); it is
  now one grid, and the same constants normalize the fill/stroke/effects
  tail's cursor math (16px row gaps, 24px section gaps → 8/12).
- **Side fix.** The alignment card no longer overlaps the advanced
  band (card 334–418, band 426–450) — a measured-reference leftover.
- **Typography usage** already sits on the T10–T20 aliases; this pass
  kept section headers on caps_label and every value on T10/T11.
- The design sheet's COMPOSE mirror (`screens.js composePanel`) was
  re-synced to the same geometry. The line-height row (grid 756/774–802)
  sits at the scroll fold (content N ≤ 775 is visible at scroll 0), so the
  sheet's scroll-0 mock ends at weight/size — the row is scroll content.

Scope note: dashboard / board / tool-dock control heights are their own
idioms (card grids, 22px tree rows, 40px toolbar) and belong to the
P0-4/P0-5 visual-language pass; the standard above is what any of those
should snap to when they touch property rows.

### P0-4 · Dashboard visually X-Native — DONE (this branch)

The dashboard already spoke the theme's roles and type ladder; the gap was
phantom affordances, an un-branded lower sidebar, and one off-idiom list:

- **Phantom controls gone.** Three `more-horizontal` icons (recents grid
  card, list row, drafts row) were painted with no hit region and no menu
  behind them — removed. The "Personal" sidebar row had a hover fill and a
  hover chevron but no hit region — demoted to the plain scope label it is.
  The recents view chip drew a `chevron-down` although clicking it CYCLES
  the view (no dropdown) — now `rotate-cw`, which is what it does.
- **THE WORKFLOW in the sidebar.** The sidebar's empty lower half now paints
  the primary loop — 1 Compose / 2 Flow / 3 Ship, each with a one-line sub —
  in both the local-first and demo variants. Informational only (no hit
  region, no hover, no affordance), so it cannot be a phantom; it is where a
  returning user (onboarding marker already set) sees the loop again.
- **Primary card names the loop.** The quick-action "New design file" card's
  sub is now "Compose, flow, ship — from one file" — the entry point says
  what the file is for.
- **One list idiom.** The non-demo "Open in this session" panel was bare
  floating rows (its own species); it now uses the same container as the
  Drafts panel — rounded card, hline-separated rows, hover wash, file icon,
  right-aligned count.
- **Design sheet re-synced** to the non-demo reality both mocks had drifted
  from: the sheet-only "All changes saved" chip, the demo-only TEAMS list,
  the "Recently viewed" heading (the app says "Recents" + a view chip), the
  demo-only search placeholder, and the bulk bar's old Move/Star/Trash
  buttons (the app has Star / Unstar / Open / Remove from recents) are all
  corrected; the new workflow rows are drawn in both mocks.

Scope note: the board and the editor's FLOW/SHIP/UX tabs are P0-5's
cross-screen pass; dashboard control *heights* (32px chips vs the 28px
inspector rows) are a different idiom (toolbar pills) and are left as is —
they were never property rows.

### P0-10 · First-time workflow — DONE (this branch)

The first run must teach the primary loop in the product's own naming and
leave the supporting surfaces findable — without inventing destinations
that don't exist:

- **Onboarding card** (first launch, dashboard) now names the steps
  **Compose / Flow / Ship** (previously "Design / Prototype / Ship" —
  off-naming), adds the loop line ("The loop: Compose, then Flow, then
  Ship") and names the supporting surfaces once: "Structure, Library,
  Tokens, Variables, Agents and UX analysis live in the editor docks."
  Buttons and the once-only marker are unchanged.
- **Empty-canvas first-run hint** (editor). A blank file previously opened
  to a bare canvas with zero affordance. Now, while the current page has
  no frames, the canvas centre says "Add your first frame — pick the frame
  tool in the dock below, then drag on the canvas. Then connect screens in
  FLOW, and export from SHIP." It is pure paint keyed on `root.children`
  being empty: it leaves the moment the first frame lands — no flag, no
  dismiss button, nothing to get stale. Boards are excluded.
- **Not changed on purpose.** The right dock already reads COMPOSE
  (default) / FLOW / SHIP / UX ANALYSIS and the left dock STRUCTURE /
  LIBRARY / TOKENS — the primary/supporting order is already right, so
  P0-10 fixes the *narrative* around those surfaces, not the surfaces.
  Dashboard quick-action cards and the board's empty state are file/board
  idioms and belong to the P0-4/P0-5 visual-language pass.

### Not yet done (queued)
- **P0-1/2 · Screen & component contract; x-ui as the component layer.**
  x-ui is currently a token repo the app does not import for widgets;
  Button/Input/Select/Section/LayerRow/etc. land there incrementally.
- **P0-5 · Cross-screen visual language pass** — board + the editor's
  FLOW / SHIP / UX tabs brought onto the editor + dashboard language
  (property-row surfaces snap to the P0-9 standard).
- **P1 · Professional editor interaction** (deep select, select-under-cursor,
  smart selection, …).
- **P2 · Polish/motion.**

## Verification

No local toolchain exists in the development sandbox — the gate is CI
(`scripts/check.sh`): workspace `cargo test`, clippy and fmt. The engine
slice is test-covered (x-text alignment/cap/indent/decoration + cache-key
tests; app-level regression tests for the theme role mapping).
