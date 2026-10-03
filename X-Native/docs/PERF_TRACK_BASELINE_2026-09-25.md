# Perf track baseline — 2026-09-25 (`track=ts`, FPS harness + attribution)

The TS-side performance baseline is now measured two ways: engine
throughput in Node (`npm run bench`, pre-existing) and true browser frame
times from a new headless-Chromium harness (`npm run bench:fps`). Headline:
small documents run at 60fps, but every pan/keystroke re-renders the full
layers list and re-saves the full document, so a 10k-layer file pans at
~1fps with a ~1GB heap. The cost is the update pipeline, not paint.

## How it was measured

- `X-Native/apps/web/tests/benchmarks/fps.mjs` (new, `bench:fps` script) —
  drives the app in headless Chromium (same `CHROMIUM_PATH`/`CHROMIUM_LIBS`
  convention as `e2e/behaviour.mjs`), injects sparse documents through the
  app's own `x-native-doc:<id>` slot, then pans with real wheel input or
  nudges with real arrow keys while sampling rAF deltas, long tasks, heap,
  and autosave writes. No test hooks in the app.
- Numbers below are the **production build** (`vite build` + `vite
  preview`), because dev-mode React distorted everything: a single pan over
  10k rects takes >180s in dev (CDP input timeout) but 0.9s in prod.
- Raster runs on SwiftShader (CPU): blur/paint cost is overstated vs real
  GPUs, but engine/React-side costs (frame p95, long tasks) transfer.
- Raw JSON (frame deltas included):
  `apps/web/tests/benchmarks/results/fps-baseline-2026-09-25.json`.
- Seeds must give every leaf `children: []` — asset hydration walks
  `children` before revive runs, and a missing array hangs file-open.
  (Pre-existing app behaviour; the harness documents it.)

## Engine throughput (Node/V8, `npm run bench` — unchanged suite)

| suite | result |
|-------|--------|
| A 10k rect create | 120.76ms (82.8k nodes/s), heap 23.90MB |
| B 10k Bézier bounds | 26.14ms (2.61µs/path) |
| C 1k booleans | 3673.69ms (3.674ms/op — the geometry hotspot) |
| D 500-blur bounds | 0.42ms (bounds math, not raster) |
| E 100k cull | 4.53ms |
| F 1k keystrokes | mean 0.445ms / p95 0.80ms / p99 1.28ms |

## Browser FPS (prod build, 8s runs, shared sandbox CPU)

| scenario | fps | p50 | p95 | max | longtasks | heap | writes |
|----------|-----|-----|-----|-----|-----------|------|--------|
| a-pan 10k rects, pan @zoom1 | 0.8 | 16.7 | 4500 | 4500 | 9 | 954MB | 3 |
| a-full 10k rects, pan, all visible | 1.2 | 16.7 | 4333 | 4333 | 10 | 954MB | 3 |
| b-pan 1k booleans, pan @zoom1 | 19.5 | 16.7 | 217 | 417 | 28 | 73MB | 0 |
| b-full 1k booleans, pan, all visible | 21.3 | 16.7 | 183 | 317 | 30 | 58MB | 0 |
| b-live nudge one boolean operand ×24 keys | 25.1 | 16.7 | 183 | 567 | 36 | 58MB | 1 |
| d-pan 500 layer-blurs, pan @zoom1 | 0.6 | 16.7 | 8116 | 8116 | 3 | 18MB | 1 |

Scale check (dev server, 3s): 100 rects = 59fps flat; 1k = 32fps, p95
133ms; 3k = 4fps, ~650ms per pan frame. Cost per pan frame grows
superlinearly; zoom level barely matters (a-pan ≈ a-full, b-pan ≈
b-full), so the bottleneck is per-dispatch JS, not raster or culling.

## Attribution (prod, CDP Profiler + source maps, one pan @10k)

- `LayerRow` (`chrome.tsx:187`) — the layers panel re-renders all 10k
  rows on every pan (~224ms self + React commit).
- `saveDoc`/`writeDoc` (`persist.ts:215`, `files.ts:126`) — autosave
  serializes the full document per pan (~80ms + IDB continuation).
- Garbage collector — ~430ms per pan from the churn of the two above
  (10k React elements + full-doc stringify per tick).
- `Icon` (`icons.tsx:218`) — per-row icons ride along with the list.
- Heap is stable during pan (Δ≈0, no leak) but huge at rest: 954MB for
  10k rects (~95KB/node: engine tree + 10k DOM rows + fibers), vs
  ~20KB/node at 3k.

## What this means for the track

1. The app's steady-state boolean rendering already avoids `booleanPath`
   (bake-on-edit + offscreen compositing per frame); b-live measures
   move + repaint + autosave, and boolean geometry throughput stays
   covered by bench suites B/C. A Rust geometry port would move suite C
   (3.674ms/op), not FPS.
2. Ranked TS fixes (no UI/UX change, suite must stay 1112 green):
   a. layers list skips re-render on pan/zoom-only snapshots
      (`LayerRow` memo + selective subscribe) — expected −90% of
      update cost;
   b. autosave throttles viewport-only updates (trailing edge) and
      stops double-writing localStorage + IDB on every save;
   c. layers list virtualization for the 954MB DOM/fiber weight
      (careful: e2e asserts on DOM rows);
   d. non-passive wheel listener (today every wheel logs
      `Unable to preventDefault…` — harmless but noisy);
   e. `booleanCanvases` 64-entry thrash → single reused scratch
      canvas (deferred: boolean paint is not the bottleneck).
3. Rust toolchain remains uninstallable in this sandbox (blocked
   network) and `x-wasm` is import-only, so the bridge stays a design
   doc (next in this track) and the Rust port stays deferred.

## Verification

- `npm test` — 890 + 64 + 46 + 63 + 49 = 1112 passed, 0 failed.
- `npm run build` (`tsc -b` + vite) clean; harness scenarios all
  complete on the prod build; b-live's autosave-write counter is > 0,
  proving the edit path engaged.
