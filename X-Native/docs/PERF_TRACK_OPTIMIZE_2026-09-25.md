# Perf track optimization — 2026-09-25 (`track=ts`, layers-panel memo)

Pan over a 10k-layer file went from ~1fps to ~45fps with a 51-line,
UI-neutral change. The layers panel already had a memo guard against
exactly this; it was dead for two compounding reasons, and reviving it
needed a new engine revision counter because tree edits mutate in place.

## Root cause

`LeftPanel` (`chrome.tsx`) is wrapped in `memo` with a comparator that
skips re-render when pages/page/selection/fileName are unchanged — the
pan/zoom case. It never hit, because `App.tsx` passed two inline arrow
closures (`onMinimize`, `onActions`) whose identities change on every
`Editor` render. So each pan re-rendered all 10k `LayerRow`s (~224ms),
re-serialized the document on settle, and GC-stormed on the churn
(~430ms) — the ~1s frames in the baseline profile.

Stabilizing the callbacks alone would have been wrong: tree edits
(`move`, `patch`, …) mutate nodes in place, so `pages` identity never
changes and the panel would have gone stale on rename/add/delete. The
memo-as-designed could never have worked; it needed an edit signal.

## Fix (4 files, +51/−18)

- `engine/types.ts`, `engine/memory.ts` — new `Snapshot.treeRev`,
  bumped in `dispatch()` on every command except provably viewport-only
  (`pan`/`setPan`/`setZoom`), plus unconditionally in
  `dispatchTransaction()`. Conservative by design: anything not
  viewport-only bumps. Session-only, never persisted; undo restores it
  with the rest of state (any value change still re-renders).
- `ui/chrome.tsx` — comparator also requires `treeRev` equality, with
  a comment explaining the in-place trap; `LayerRow`'s masked-child
  check went from a per-row `findIndex` scan (O(n²) per panel render
  on wide trees) to a `withMaskedAbove` single pass with identical
  semantics (verified: same display order, same "any row above masked"
  rule; `siblings` prop kept for Shift-extend selection).
- `App.tsx` — the two panel callbacks are `useCallback`-stable
  (same closures, stable identity; zero behavioral difference).

## Before / after (prod build, headless Chromium, 8s runs)

| scenario | before | after |
|----------|--------|-------|
| a-pan 10k pan @zoom1 | 0.8fps, p95 4500ms | 44.8fps, p95 33ms |
| a-full 10k pan, all visible | 1.2fps, p95 4333ms | 47.0fps, p95 67ms |
| b-pan 1k booleans pan | 19.5fps, p95 217ms | 39.8fps, p95 100ms |
| b-full 1k booleans pan, all visible | 21.3fps, p95 183ms | 42.7fps, p95 83ms |
| b-live nudge one operand ×24 | 25.1fps, p95 183ms | 25.7fps, p95 167ms |
| d-pan 500 blurs pan | 0.6fps, p95 8116ms | 0.7fps, p95 7366ms |

Raw JSON: `apps/web/tests/benchmarks/results/fps-after-layeropt-2026-09-25.json`
(baseline: `fps-baseline-2026-09-25.json` in the same directory).

Reading: pan paths are fixed (update-pipeline cost removed; what remains
is Canvas render + paint, ~25–45ms p95 — diminishing returns, stopping
here). b-live is unchanged, which is the correctness signal in numbers:
real edits bump `treeRev`, the panel re-renders, cost is by design.
d-pan is unchanged because it is SwiftShader-raster-bound (500 CPU blurs),
not JS-bound — needs a real GPU to re-verify, no code conclusion to draw.

## Deliberately not changed

- Autosave (`App.tsx` effect + `persist.ts saveDoc`): already
  trailing-debounced at 600ms; post-fix runs show 0–2 writes per 8s pan
  and saveDoc is off the frame path. The localStorage+IDB double write
  stays: the IDB copy is the durability backstop, not worth the risk.
- Undo snapshots (`clone(state)` per history entry): the likely source
  of the 954MB rest heap at 10k nodes, but changing undo semantics is
  out of scope for a UI-locked perf pass. Noted for the owner.
- Layers virtualization, scratch-canvas booleans, passive wheel
  listener: still deferred from the baseline report — none is on the
  hot path anymore.

## Verification

- `npm test` — 1112 passed, 0 failed; `tsc -b` clean.
- `e2e/behaviour.mjs` sections 1–9 with the fix: 28 ok, including the
  rename-commit tests (in-place `patch` → row updates, the exact case
  the naive fix would have broken). Also verified against unmodified
  baseline via worktree: identical results — the 2 FAILs (`corrupt save
  warns the user`, `New file resets…`) and the section-10 crash
  (missing Vars "Copy" button) reproduce byte-for-byte without this
  change. Pre-existing e2e rot, filed here for the record, not
  introduced here.
