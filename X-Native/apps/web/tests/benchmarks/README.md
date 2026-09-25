# FPS benchmarks (headless Chromium)

Measures true rAF frame times, long tasks, and heap on heavy documents by
driving the running app in headless Chromium. This complements the
engine-throughput suite (`npm run bench`, Node/V8 only), which cannot see
paint, canvas compositing, or React costs.

```sh
# from apps/web, with `npm run dev` running:
node tests/benchmarks/fps.mjs [--scenario a|b|blive|d|all] [--seconds 8]
                              [--url http://localhost:5173] [--out out.json]
```

## Chromium setup

Discovery mirrors `e2e/behaviour.mjs`: `CHROMIUM_PATH` / `CHROMIUM_LIBS`
(default `/tmp/shot/bin/chromium` and `/tmp/shot/ext/lib`). One way to get a
binary without system packages is the Lambda Chromium build:

```sh
mkdir -p /tmp/shot && cd /tmp/shot && npm init -y >/dev/null
npm i @sparticuz/chromium@133.0.0
node -e "
const z=require('zlib'),fs=require('fs');
const bin='/tmp/shot/node_modules/@sparticuz/chromium/bin';
const out=(f)=>'/tmp/shot/'+f;
for (const f of ['chromium','al2023.tar','swiftshader.tar']) {
  fs.writeFileSync(out(f), z.brotliDecompressSync(fs.readFileSync(bin+'/'+f+'.br')));
}"
mkdir -p bin ext && mv /tmp/shot/chromium bin/ && chmod +x bin/chromium
tar -xf /tmp/shot/al2023.tar -C ext && tar -xf /tmp/shot/swiftshader.tar -C ext
cp ext/*.so bin/   # libEGL/libGLESv2 sit next to the binary
export CHROMIUM_PATH=/tmp/shot/bin/chromium CHROMIUM_LIBS=/tmp/shot/ext/lib
```

## One-shot profiler (`bench:profile`)

`node tests/benchmarks/profile.mjs [--blurs 500] [--plain] [--wheels 5]
[--live] [--keys 10] [--url http://localhost:4173] [--out prof.json]` loads
a heavy doc, captures a CDP CPU profile across N wheel-pans (or arrow-key
nudges with `--live`, the b-live path), and reports top functions by self
time plus per-op wall latency. `--plain` strips the blur effects (pan mode)
or swaps the boolean doc for plain rects (live mode) for the counterfactual
run. This convicted native `ctx.filter` rasterization for d-pan (99.7%
`(program)` vs 18ms total with `--plain`), then paintBoolean churn and
LeftPanel re-renders for b-live. The live prelude verifies engagement (an
arrow must change pixels) and fails loudly otherwise, as does fps.mjs.

## Differential runner (`bench:wasm`)

`vite-node tests/benchmarks/wasm.mjs [--replay] [--module x_geo.wasm]
[--repeat 5] [--out report.json] [--fixtures path]` replays the 30 recorded
geo fixtures through the TS authority and the module path, comparing both
with the §8 oracle and timing each side. Exit status is non-zero on any
divergence (CI-ready).

- `--replay` (default without `--module`) serves the recorded contours from
  a mock, which also asserts the choke's request bytes equal the §5.1
  encoding — drift between choke and codec fails loudly. Module-path timing
  here is harness overhead, not Rust speed.
- `--module` loads real bytes and treats any wasm decline as the finding:
  the choke would silently fall back to TS, so the runner calls the module
  directly per case and fails when it declines.
- Replay compares against the recorded contours *re-shaped once*, not the
  fixture itself: shaping is not idempotent for degenerate 2-point rings,
  so the fixture is the wrong yardstick for already-shaped inputs. (Module
  mode compares against the fixture: real wasm returns raw contours.)

## Scenarios

| key    | document | drive | measures |
|--------|----------|-------|----------|
| a-pan  | 10k rects | wheel-pan @zoom 1 | pan FPS through the culling path |
| a-full | 10k rects | wheel-pan @zoom 0.25 | pan FPS with (nearly) all nodes visible |
| b-pan  | 1k live booleans | wheel-pan @zoom 1 | pan FPS over baked boolean paths |
| b-full | 1k live booleans | wheel-pan @zoom 0.25 | pan FPS with all booleans visible |
| b-live | 1k live booleans | keyboard nudge of one operand | live-edit FPS via Ctrl+A, Tab, Enter, arrows |
| d-pan  | 500 layer-blurs | wheel-pan @zoom 1 | pan FPS under canvas filter cost |

Documents are injected through the app's own `x-native-doc:<id>`
localStorage slot as sparse seeds (backfilled by `reviveNode`), so no test
hooks were added to the app. One field is mandatory even on leaves:
`children` — asset hydration walks the tree before revive runs, and an
absent `children` array hangs the file-open screen.

## Reading the numbers

- **Software raster.** Headless Chromium here uses SwiftShader (CPU). Raster
  cost is overstated vs real GPUs; engine/React-side costs (frame p95,
  long tasks) transfer.
- **b-live proof.** Every nudge is a real move command + repaint + autosave.
  The harness counts autosave writes during the run; if it reports 0, the
  edit path did not engage and the row must be treated as idle, not
  live-edit. (The harness exits 0 either way and says so loudly.)
- **Booleans bake on edit.** The app repaints live booleans via offscreen
  compositing each frame; `booleanPath` runs at edit/export time, so b-live
  measures move + repaint + autosave, not boolean re-evaluation. Boolean
  geometry throughput is covered by suite B/C of `npm run bench`.
- Screenshots land in `.shots/` (git-ignored) as render proof.
