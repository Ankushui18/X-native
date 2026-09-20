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

**Scoreboard (branch, verified):** 339 rows — **261 MATCH / 47 PARTIAL /
12 MISSING / 16 EXTRA / 3 OUT**. Guard: 10 checks, 69 pinned, 0 open, 0 failed.

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

2. **Wave 2 remainder** (items 16–19): right dock at 240 (needs the inspector
   reflow), radii (18.6), Inter at 11px (18.5), tool cursors (18.11), motion
   (18.12), remaining icon vocabulary (18.10), Design-tab row order, rotation
   sign (6.1).

3. **Wave 3** (item 20), only after 1 and 2.

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
