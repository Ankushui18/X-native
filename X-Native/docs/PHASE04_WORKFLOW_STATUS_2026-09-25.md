# Phase 4 — Professional Workflow (TS track): status @ 2026-09-25

Roadmap: Phase 4 (P0.8, P1.12–P1.15). All work on the TS track; the
corresponding roadmap checkboxes are marked.

## Shipped

**P4-A · Command unification (P0.8)**
- Audit result: the command system was already unified — all 133 `Command`
  members route through `dispatch`/`apply` (only `begin`/`end` bypass
  `apply`, by design), and no UI code mutates engine state or snapshots
  in place.
- Locked in with undo/redo regression tests: variable/collection/mode
  commands, bind/unbind, `setInteractions`, `swapInstance`, plus proof
  that view commands (select, zoom) stay out of history.

**P4-B · Design linting (P1.14)**
- New `engine/lint.ts`: 10 rules over a snapshot — broken aliases,
  unused variables/styles/components, non-token colors/spacing/radii,
  text contrast (WCAG ratio), overridden instances, auto layer names.
- Health score (100 − 10/error − 3/warning, info is scoreless).
- `DesignHealth` panel in the empty Design tab: live score, click-to-show
  issues, one-click fixes (delete unused, reset overrides, make-token-and-bind).
- The engine is pure over `Snapshot` with headless tests, so CI can run
  the same rules the editor shows.

**P4-C · Unified search (P1.13)**
- The ⌘K Actions menu is now the Quick Open: commands, layers (with
  breadcrumbs), pages, components, variables (resolved values), and
  prototype flows in one fuzzy-ranked list.
- Type filter chips, arrow-key navigation, recents (persisted, stale-safe),
  and per-kind actions (select+zoom, place component, jump to tab, present).
- Accessible: dialog/listbox/option semantics, `aria-activedescendant`,
  focus restoration.

**P4-D · Prototype system (P1.12)**
- Multiple actions per trigger: `triggerInteractions()` (new
  `engine/protoEval.ts`, tested) bubbles to the innermost match and runs
  *all* of its actions; canvas clicks, overlay clicks, and after-delay
  all use it.
- Newly wired triggers: mouse enter/leave (edge-detected), key press
  (per-key capture in the panel), drag (press-drag past threshold).
- Conditions: per-interaction variable comparison (`Interaction.condition`,
  8 ops), evaluated mode-aware; the panel edits variable/op/value.
- `setVariable` reads the resolved value under the active mode (was raw
  slot, which broke on aliases); toggle/increment/decrement type-guarded.
- Interactive components: new `setVariant` action swaps the interaction's
  own instance; panel offers it with the master's variant list.
- Panel also gains key capture for keyPress and the missing "Set value"
  op with a typed value field.

**P4-E · Asset management**
- Assets pane gains an Images section: distinct-image inventory with
  thumbnails, usage counts, approximate sizes, search filtering, and
  click-to-show-first-use.

**P4-F · Accessibility (P1.15)**
- Reduced motion: `prefersReducedMotion()` gates prototype transitions
  (→ instant), player ripples/pulses, plus a global CSS kill-switch.
- Focus restoration for Quick Open, FillPicker, and Find/Replace.
- Icon-button audit: exactly one unlabeled instance in the UI (dashboard
  help), now labeled. WCAG contrast and layer-name checks ship as lint rules.

## Verification
- `tsc --noEmit` clean, `vite build` clean, dev server HMR clean.
- `npm test`: **890 + 64 + 46 = 1000 passed, 0 failed** (`workflow.test.mjs`
  covers undo round-trips, all lint rules + score, fuzzy ranking, recents,
  conditions incl. modes, and trigger bubbling).

## Behaviour notes
- Animated multi-actions overlap (each runs its own transition); the last
  committed navigation wins. Instant actions (set variable, URL) run first
  in author order only if authored first — order is author order throughout.
- `onHover` ("while hovering") still fires once on entry; `mouseEnter`
  fires alongside it on the same edge.
- `setVariant` targets the interaction's own node: put the interaction on
  the instance itself, not on a child inside it.
- Variable Quick Open entries reveal the Tokens tab rather than guessing
  a binding.
- Lint `info` issues never move the score.

## Follow-ups (not started)
1. Quick Open result thumbnails (type icons + breadcrumbs ship instead).
2. Keyboard-only canvas navigation and UI scaling (P1.15 remnants).
3. Inspector keyboard-editing pass (inputs are native; no formal audit).
4. Cross-file variable libraries (from Phase 3 follow-ups).
5. Per-mode value grid in the variables panel (from Phase 3 follow-ups).
