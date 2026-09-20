# Session brief — X-native (forward direction)

> Reconciled **2026-09-20** on branch `arena/01a0bd31-x-native` @ `86510ec`.
> The pasted handoff was written from `main @ 97df7ce`; this branch is two commits
> ahead of it, so a few numbers below are corrected to what is actually on the
> branch. Nothing here is folklore — the scoreboard and ceilings are what
> `tools/design-sheet/guard.mjs` reports right now.

## We are at

`main` is green after PR #18 (Outlines mode, ⌘Y — master row 17.7). On top of it
this branch ships **Wave 2, part one** (`c2be496`, `86510ec`): Figma's palette
(`#1E1E1E` canvas / `#2C2C2C` panels / `#383838` dividers / `#0D99FF` selection),
the 24px layer row, the 240px left dock, and four redrawn tool glyphs. The two
values Figma ships sub-AA (accent fill, dim grey) are pinned as deliberate
deviations by `graphite_carries_figmas_chrome_values`.

**Scoreboard (branch, verified):** 339 rows — **264 MATCH / 46 PARTIAL /
10 MISSING / 16 EXTRA / 3 OUT**. Guard: 10 checks, 74 pinned, 0 open, 0 failed.

The single source of truth for what's next remains
`docs/FIGMA_PARITY_MASTER_LIST.md`.

## Where we're heading — in this order

1. ~~**Item 15 — Clean up layers (row 5.9)**~~ — **delivered** on this branch,
   scoped with the owner to the chapter-4 framing: `Editor::clean_up_layers`
   flattens redundant single-child, visually-inert group nests in one undo entry
   (rename stays manual; Figma's is an AI agent). Right-click + palette both
   route through `CtxCmd::CleanupLayers`. Pinned by
   `clean_up_layers_flattens_redundant_nests_in_one_undo`. Row 5.9 → PARTIAL.
   *Remainder:* FD4B's chapter-16 smart-selection tidy-up + `distribute_vertical`
   (help 30979556779159, 360040450233) — a separate, later row.

2. ~~**Rotation sign (row 6.1)**~~ — **delivered**: `state::rotation_display`
   (negate + re-range to (−180,180]) applied at the single `Sel.rot` readout
   source, `rotation_from_display` on write; stored y-down sign untouched.
   Pinned by `the_rotation_field_shows_figmas_counter_clockwise_sign`.
   Row 6.1 → MATCH.

3. ~~**Radii (row 18.6)**~~ — **delivered**: `R_ROW`/`R_CARD`=8, `R_INPUT`=6,
   `R_PILL`=4 on the shared `RadiusScale`, pinned by
   `radii_follow_figmas_measured_chrome`. Row 18.6 → MATCH.

4. ~~**Header (row 18.7 header)**~~ — **delivered**: `ED_TITLE_H` 36→40 (Figma's
   top bar); panels hang off the constant, sheet is title-relative, so
   `check_screens.mjs` stays 20/0. Pinned by
   `the_editor_header_is_figmas_forty_pixels`.

5. ~~**UI type (row 18.5)**~~ — **delivered**: the chrome's body step is now
   `theme::T_UI` = 11 px (Figma's base) across all 250 editor call sites plus the
   tracked section headings; `T10` stays only on the dashboard's metadata rows,
   the board and the status band. The four bundled Inter weights are verified
   from each file's own `name` table via `LoadedFont::family_name`. Pinned by
   `the_chrome_type_is_figmas_inter_at_eleven_pixels`. Row 18.5 → MATCH.

6. ~~**Icon vocabulary (row 18.10), part**~~ — `star` redrawn at Figma's 0.382
   default ratio, `arrow-up-right` redrawn as shaft+V head, Frame glyph keyed
   `frame-hash` so the sheet can draw it, Slice layers wear the Slice glyph, and
   the icon census now reads the `fn icon()`/`kind_icon` tables so "unused" is
   real. Pinned by `the_star_and_arrow_glyphs_are_figmas_metaphors`. Row 18.10
   stays PARTIAL — hand, pen nib and comment bubble still read Lucide.

7. **Wave 2 remainder** (items 16–19): right dock at 240 — needs the inspector
   reflow (`paint_design` offsets are absolute for ~340px; a CI-compiled
   refactor, deliberately not half-done here) — plus tool cursors (18.11),
   motion (18.12) and the remaining icon forms (18.10). (The Design tab's
   row order already matches Figma's: Position → Layout → Appearance → Fill →
   Stroke → Effects → Export.)

8. **Wave 3** (item 20), only after 1–7.

## How we reach it — per-behaviour recipe

One behaviour per PR, in wave order. Every delivery carries: a **regression
test**, a `FIGMA_PARITY.md` §2 row naming it, a **CHANGELOG** entry, the
master-list row flipped + scoreboard re-derived, and the design sheet
regenerated **last** with the conformance guard holding its ceilings.

Gate before merge: `scripts/check.sh` (fmt, clippy inside the dead-code budget,
full test suite, docs refs, design-sheet byte-diff, guard, jsdom, CLI smoke) +
the Screenshots job. Toolchain pinned 1.98.1. *Note: in this sandbox `cargo` and
`crates.io` are unreachable, so the Rust half of the gate runs in CI, not here —
the Node gates (`guard.mjs`, `check.mjs`, `check_screens.mjs`) are the local
check.*

## Layout

- Editor: `X-Native/apps/x-designer/src/bin/x_native_app/` — `state.rs`,
  `run.rs`, `editor_ui.rs`, `regression_tests.rs`.
- Engine: `X-Native/crates/` — `x-core`, `x-render`, `x-editor`, `x-native`.
- Queue/scoreboard: `X-Native/docs/FIGMA_PARITY_MASTER_LIST.md`.

## Hard-won gotchas

- rustfmt 1.98.1 is unforgiving: 60-char budget for call/macro args, **one**
  separator char per comma, single-expression closure bodies collapse to
  expression form when they fit, match arms >100 chars split their pattern
  vertically. The gate's own diff is the idempotent fixed point — adopt its `+`
  lines verbatim when in doubt. The gate caps fmt output (~20 lines), so audit
  *every* added line, not just the first hunk.
- Never issue parallel `edit_file` calls on one file — the second write silently
  clobbers the first.
- Undo pattern in `x-editor`: snapshot `self.root`, mutate, `snapshots.push`,
  bump `edit_serial`, push a `Command`, `clear_redo_history()`, set `selection`
  (see `Editor::ungroup`).

**First commit of the new session:** item 15, Clean up layers (row 5.9) — once
its scope is confirmed.
