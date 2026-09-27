# WASM bridges — implementation and verification

Date: 2026-09-27. Priority: complete the existing bridges before further Figma-parity work.

## 1. Status and authority

**Both bridges compile, package and execute in CI. Native geometry promotion has
FAILED the differential check; the TS guards remain enabled.** The sandbox itself
still has no cargo/rustc, and artifact/log CDN downloads remain inaccessible.
After user authorization, the current work was committed and pushed only to
`arena/01a0e1ff-x-native`. No generated binaries are checked in; the local preview
still uses the TypeScript fallback.

Latest verified code/CI checkpoint: `1d9fe9e`, [CI run 36315979388](https://github.com/Ankushui18/X-native/actions/runs/36315979388).
The user selected **keep geometry guarded for now**; subsequent work is import-only.
The Rust workspace gate, packaging, real-module smoke and web tests/build passed.
The geometry promotion diagnostic is explicitly non-blocking while auto retains
its oracle: **a green CI conclusion does not mean native geometry parity passed**.

TypeScript remains authoritative, as required by `ARCHITECTURE_BOUNDARY.md`:

- Imports run the TS parser and use a converted native result only when the full
  supported import contract agrees. A named page, optional paint, missing layer,
  resource or unsupported property cannot silently disappear. This is a guarded
  integration, **not yet an import acceleration or native-format parity claim**.
- Geometry `auto` compares the native candidate with TS using the existing §8
  comparator. Different native/web raster grids are NOT presumed equivalent.
  `?geo=wasm` deliberately bypasses that comparison for diagnostics; invalid
  traffic/traps still fall back. `?geo=ts` disables the geometry bridge.
- Neither core geometry algorithm was rewritten or replaced. Rich native import
  mapping (text, gradients, resources, components, layout, layered paints) is not
  promoted; those files retain their existing TS result. No new product feature.
- Prior parity changes are preserved. This work does not claim to close the
  previously reported full-browser failures or certify Figma parity.

## 2. Import bridge

Files: `apps/web/src/engine/{wasmBridge,wasmImportAdapter,wasmAssets}.ts`,
`apps/web/src/{App.tsx,ui/Dashboard.tsx,ui/Canvas.tsx,ui/FigInspectorModal.tsx}`,
`crates/x-wasm/{Cargo.toml,src/lib.rs}`.

- Replaced the ABI-incompatible raw instantiate/cast with optional generated
  `--target web` wasm-bindgen JS glue. Shared pending initialization, checked
  function exports, `bridgeVersion() == 1`, and Rust build identifier.
- Preload starts on the dashboard as well as the editor. SVG stays synchronous;
  FIG/Sketch remain asynchronous. **No import waits for an optional network load.**
  A first import can use TS while native initialization is still pending.
- UI file/drop/paste/inspector import functions now route through the boundary.
  FIG container inspection remains the existing format-specific inspection path.
- Explicit native `.x` v1 adapter: native pages are Node objects, not web
  `Page.root`. Retains multiple pages, tree hierarchy, visibility/lock state,
  transforms, solid paints, simple strokes, corner ordering and path networks.
  Unknown/unmapped visual properties decline the entire candidate.
- The SVG interchange root is not exposed as an invented named design page.
  Named pages from formats that actually supply them must compare equal.
- `getEngineInfo()` distinguishes loaded native capability from the TS runtime
  and records last selected import backend/fallback. `?imports=ts` skips native.
- Rust error envelopes now use JSON string escaping, including control characters,
  while preserving the existing envelope ordering. Added control-character test.
- Asset URLs follow Vite's base path, including subdirectory/CDN deployments.

## 3. Geometry bridge

Files: `crates/x-geo/{Cargo.toml,src/lib.rs}`,
`apps/web/src/engine/{geoBridge,geometry}.ts`.

- Added the missing leaf crate and workspace/lockfile/dependency-graph entries.
  It wraps `x_core::booleans::boolean_with(Backend::RasterGuided)` and folds
  operands left-to-right. Geometry remains in x-core; shaping remains in TS.
- Implemented the documented v1 LE request/response protocol: four operations,
  world-coordinate contours, empty and error responses, version/magic/length
  checks, operand/point/response limits, finite coordinates and reserved fields.
  V1 validates but ignores curve handles during rasterization, as specified.
- Additional native safety limit: coordinate/handle magnitude <= 1e9; out-of-range
  inputs decline to TS. Fewer than two operands/three anchors also decline.
- Owned, zero-filled allocation registry; checked pointers/sizes; checked output
  slots; bounded live allocations; idempotent free. No unsafe dereference/block.
  The wasm-only `unsafe_code` lint exception is for `no_mangle` export declarations.
- TS re-acquires memory views after growth, checks transport status and response
  range, and attempts every allocation cleanup even after traps. Decoder rejects
  malformed lengths, non-finite coordinates, reserved fields and trailing data.
- Concurrent loader calls now share the actual pending initialization. Disabling
  the bridge does not poison a later explicit load. Empty native results reach
  the diagnostic path without being disguised as TS fallback.
- The benchmark explicitly selects diagnostic wasm mode, so auto's TS guard
  cannot conceal a native corpus mismatch.

## 4. Build and distribution

From `X-Native/`, with the repository-pinned Rust toolchain available:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.127 --locked
cargo test --locked -p x-wasm -p x-geo
cargo test --locked -p x-native --test dependency_rules
cargo fmt --all -- --check
cd apps/web
npm ci
npm run build:wasm
npm run test:wasm
npm run bench:wasm -- --module public/x_geo.wasm --out /tmp/geo-native.json
npm test
npx tsc -b
npm run build
```

`build:wasm` builds both crates with `--locked`, rejects a mismatched bindgen CLI,
and packages `public/wasm/{x_wasm.js,x_wasm_bg.wasm}` plus `public/x_geo.wasm`.
Generated assets are ignored by Git; Vite includes them when present. Plain
`npm run build` remains usable in TS-only checkouts. Deploy **the JS glue and its
matching binary together**, not the old raw `x_wasm.wasm` artifact alone.

CI now packages both bridges, runs `test:wasm` against the real generated modules,
builds the web app with those assets, and uploads browser-ready files as `x-wasm`.
The smoke gate fails for missing artifacts: it does not substitute mocks/replay.
Full corpus equivalence is a separate promotion gate, not claimed by smoke tests.
The `wasm-verification` artifact contains smoke logs, the real differential log
and per-case JSON. CI emits API-readable annotations too, because the log/artifact
CDNs are inaccessible here. Promotion diagnostics are non-blocking, clearly marked
as NOT approved on mismatch; the strict benchmark command itself exits nonzero.

## 5. Verified checks and limitations

| Check | Verified result / environment |
| --- | --- |
| Full `npm test` | **2,911 passed, 0 failed**, 45 suites |
| Existing geometry bridge suite | **92 passed, 0 failed** (includes synthetic wasm, NOT native Rust geometry) |
| New import bridge suite | **39 passed, 0 failed** (injected bindgen interface + real TS importers) |
| New geometry safety suite | **37 passed, 0 failed** |
| `npx tsc -b` | **PASS**, no diagnostics |
| `npm run build` | **PASS**; existing >500 kB chunk warning remains |
| `bench:wasm --replay --repeat 1` | **30/30 equivalent**, replay/harness evidence only, NOT Rust performance |
| `node e2e/wasm-fallback.mjs` | **PASS**: real dashboard SVG upload, editor layer persistence and reload with assets deliberately 404; zero uncaught browser errors |
| Shell syntax, manifest/lockfile declaration consistency, `git diff --check` | **PASS** (not a substitute for Cargo resolution) |
| `build:wasm` local preflight | **BLOCKED**: reports missing Rust toolchain, exit 1 |
| Host Rust tests/clippy and pinned `cargo fmt` gate | **PASS in CI**, `scripts/check.sh` at `1d9fe9e`; unavailable locally |
| WASM release build and matched bindgen packaging | **PASS in CI**, both crates; browser-ready `x-wasm` artifact uploaded |
| Real generated bindgen/native x-geo smoke | **PASS in CI**, real exports and production wrappers, not mock/replay |
| Real 30-case differential/performance | **1/30 equivalent, 29 failures** in CI; bounds, area, topology and emptiness mismatches; native promotion NOT approved |
| Full application E2E | **NOT RERUN**; prior failures remain recorded in parity reports |

Local logs: `/home/user/wasm-{unit,tsc,build,replay,browser}.log`.
CI evidence: `/home/user/wasm-import-next-annotations.json` for the latest batch;
`/home/user/wasm-ci-5-annotations.json` retains the initial complete 30-case summary.

### Native results that were actually exercised

- Generated bindgen initialization, ABI/build identifier, SVG string interchange,
  malformed FIG/Sketch envelopes, and native-node document schema.
- **Simple SVG uses the actual Rust result** (`importBackend === "wasm"`), checked
  against the TS import contract. Text safely retains the TS result.
- Real `sample.fig` and `sample.sketch` production wrappers invoke the native
  functions and retain complete TS results. At the initial `7532f05` checkpoint,
  native FIG declined with `figma file contains no canvases`. The import-only
  batch below fixes that parser failure and preserves Sketch names. Both native
  parsers now succeed, but conversion still declines unmapped `text`/`bindings`.
  This is verified fallback, NOT full native FIG/Sketch rendering parity.
- Native union/subtract/intersect/exclude, disjoint empty intersection, malformed
  requests, bad pointers, double-free and 50 repeated allocation/free cycles pass.
- Real geometry differs from TS: e.g. overlapping rectangles yield native bbox
  x/y `0.25/0.25` vs TS `0.078125/0.078125`; native exclusion has one contour vs
  two in the TS fixture. Auto mode demonstrably returns the TS result for such
  differences. No tolerance was relaxed, and neither algorithm was rewritten.

### Complete native differential result

Run `36314867997` tested real `public/x_geo.wasm`, ABI v1, with two repeats:
**1 passed, 29 failed**. Only `identical-subtract-empty` matched. All other
fixtures—including the simple rectangle operations—failed at least one existing
comparator check. `sliver-sliver-intersect` disagreed on emptiness; several
exclusion/star/triangle cases disagreed on contour counts as well as geometry.

The benchmark reported sums of per-case mean timings: TS **60.48 ms**, native
module path **6.47 ms** across the 30 cases. These timings are diagnostic only:
29 results were not equivalent, and auto mode also runs the TS oracle. They do
NOT establish a safe replacement, a browser speedup or an acceleration signoff.
The detailed numerical reasons and per-case timings are in `wasm-verification`.

### CI failure fixed during verification

Runs `36313881976` and `36314083392` compiled/packaged successfully but the smoke
runner failed with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. `Function("return
import(...)")` bypassed vite-node's VM import transform. Commit `e1e5d5f` switched
to a supported dynamic import of the generated file URL. The native smoke then
passed in run `36314302359`; expanded real import fixtures passed at `7a05157`.
This was a real failing gate, not a mocked success or a waived smoke assertion.

## 6. Remaining before native promotion

1. Resolve measured native geometry differences before removing the TS oracle.
   Preserve existing web behavior and keep the strict comparator; do not loosen
   tolerances to manufacture a pass or describe diagnostic-mode output as parity.
2. Extend native schema mapping for typography, bindings, resources and layered
   paints, with real fixture equivalence gates. Parentless FIG handling and
   Sketch display-name preservation are fixed in the batch below.
3. Measure broader native timing and browser main-thread cost separately from the
   TS oracle. Successful ABI smoke is not a production performance signoff.
4. Native-asset browser E2E and broad import fidelity remain unverified; current
   browser smoke covers the actual UI with native assets deliberately unavailable.


## 7. Import-only follow-up (2026-09-27)

Scope decision: the user chose **keep geometry guarded for now**, rather than
introduce a web-compatible Rust kernel. No boolean algorithm, tolerance or
geometry promotion policy changed in this batch.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W01 — native radians treated as web degrees | `wasmImportAdapter.ts` converts radians to degrees, rejects conversion overflow | Existing angle test first failed (`1.570796…` instead of `90`); positive/negative/half-turn tests now pass |
| W02 — native SVG pivot was unsupported | Rebase native pivot translation to the web's center pivot while preserving the complete affine, not ignoring the origin | 16 angle/pivot combinations checked at all four corners; malformed/overflow pivots rejected; real native rotated SVG passes |
| W03 — parentless FIG records disappeared | `x-format/src/figbinary.rs` recovers orphan canvases/layers, retains ordered document children and prevents hidden-canvas children leaking onto visible pages | Native web fixture imports all four named layers; missing-parent/hidden-page and ordering/deduplication regressions pass |
| W04 — Sketch display names replaced with IDs | `x-format/src/sketch.rs` carries source page and nested layer names into the existing import IR; IDs unchanged | Native fixture retains Page 1, Home, Card, Dot, Label, Grp and Inner; stable `ab-1` ID asserted |

Unknown-property diagnostics now name the rejected keys, without discarding them.
This exposes remaining text/binding mapping work rather than silently dropping it.

### Verified gates

- Local full suite: **2,911 passed / 0 failed**, 45 suites; `tsc -b` clean; build
  passes with the pre-existing chunk-size warning. Bridge suite: **39/0**.
- Browser fallback smoke: dashboard import, editable persisted rectangle and
  reload pass; zero uncaught browser errors. Native browser E2E is still unverified.
- CI `36315979388` at `1d9fe9e`: Rust workspace gate, both wasm packages, real
  bindgen/geometry smoke, native FIG/Sketch parser assertions and web checks pass.
- The native FIG parser now returns a page and all expected names. The production
  FIG wrapper still uses TS because the native `text` kind payload is unmapped.
  Sketch similarly parses correctly and retains names, but `bindings` remain
  unmapped. Guards retain the complete TS results in both cases.
- The unchanged geometry diagnostic again reports **1/30 equivalent, 29 failures**.
  Its non-blocking CI status is not a promotion approval.

CI caught two issues during this batch: the first new FIG regression incorrectly
expected raw canvas x=120, whereas the existing native lowering normalizes the
page envelope to (40,40). The test now explicitly asserts native x=40/60 and
preserved relative spacing—production placement was not altered. The next real
WASM check exposed the unsupported SVG `origin`, addressed by W02. Neither smoke
assertion nor equivalence tolerance was waived.

Local logs: `/home/user/wasm-import-next-{red,focused,unit,tsc,build,browser}.log`;
CI annotations: `/home/user/wasm-import-next-annotations.json`.
