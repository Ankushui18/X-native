# WASM bridges — implementation and verification

Date: 2026-09-27. Priority: complete the existing bridges before further Figma-parity work.

## 1. Status and authority

**Both bridges compile, package and execute in CI. Native geometry promotion has
FAILED the differential check; the TS guards remain enabled.** The sandbox itself
still has no cargo/rustc, and artifact/log CDN downloads remain inaccessible.
After user authorization, the current work was committed and pushed only to
`arena/01a0e1ff-x-native`. No generated binaries are checked in; the local preview
still uses the TypeScript fallback.

Latest verified code/CI checkpoint: `7532f05`, [CI run 36314867997](https://github.com/Ankushui18/X-native/actions/runs/36314867997).
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
| Full `npm test` | **2,906 passed, 0 failed**, 45 suites |
| Existing geometry bridge suite | **92 passed, 0 failed** (includes synthetic wasm, NOT native Rust geometry) |
| New import bridge suite | **34 passed, 0 failed** (injected bindgen interface + real TS importers) |
| New geometry safety suite | **37 passed, 0 failed** |
| `npx tsc -b` | **PASS**, no diagnostics |
| `npm run build` | **PASS**; existing >500 kB chunk warning remains |
| `bench:wasm --replay --repeat 1` | **30/30 equivalent**, replay/harness evidence only, NOT Rust performance |
| `node e2e/wasm-fallback.mjs` | **PASS**: real dashboard SVG upload, editor layer persistence and reload with assets deliberately 404; zero uncaught browser errors |
| Shell syntax, manifest/lockfile declaration consistency, `git diff --check` | **PASS** (not a substitute for Cargo resolution) |
| `build:wasm` local preflight | **BLOCKED**: reports missing Rust toolchain, exit 1 |
| Host Rust tests/clippy and pinned `cargo fmt` gate | **PASS in CI**, `scripts/check.sh` at `7532f05`; unavailable locally |
| WASM release build and matched bindgen packaging | **PASS in CI**, both crates; browser-ready `x-wasm` artifact uploaded |
| Real generated bindgen/native x-geo smoke | **PASS in CI**, real exports and production wrappers, not mock/replay |
| Real 30-case differential/performance | **1/30 equivalent, 29 failures** in CI; bounds, area, topology and emptiness mismatches; native promotion NOT approved |
| Full application E2E | **NOT RERUN**; prior failures remain recorded in parity reports |

Local logs: `/home/user/wasm-{unit,tsc,build,replay,browser}.log`.
CI evidence: `/home/user/wasm-ci-5-annotations.json` (complete 30-case summary) and the linked run/artifacts.

### Native results that were actually exercised

- Generated bindgen initialization, ABI/build identifier, SVG string interchange,
  malformed FIG/Sketch envelopes, and native-node document schema.
- **Simple SVG uses the actual Rust result** (`importBackend === "wasm"`), checked
  against the TS import contract. Text safely retains the TS result.
- Real `sample.fig` and `sample.sketch` production wrappers invoke the native
  functions and retain complete TS results. Native FIG declines this fixture with
  `figma file contains no canvases`; Sketch conversion declines unmapped native
  properties. This is verified fallback, NOT successful native FIG/Sketch parity.
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
2. Improve FIG fixture handling and extend the native schema mapping for Sketch,
   typography, resources and layered paints, with real fixture equivalence gates.
3. Measure broader native timing and browser main-thread cost separately from the
   TS oracle. Successful ABI smoke is not a production performance signoff.
4. Native-asset browser E2E and broad import fidelity remain unverified; current
   browser smoke covers the actual UI with native assets deliberately unavailable.
