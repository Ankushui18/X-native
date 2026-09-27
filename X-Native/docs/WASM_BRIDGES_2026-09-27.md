# WASM bridges — implementation and verification

Date: 2026-09-27. Priority: complete the existing bridges before further Figma-parity work.

## 1. Status and authority

**Integration, build wiring and fallback tests are implemented. Native execution and
promotion are NOT VERIFIED.** This sandbox has no cargo/rustc; official toolchain,
mirror and GitHub artifact/release downloads failed. Previous successful CI runs
prove only the baseline, not the Rust/CI changes in this patch. No binaries are
checked in, and the local preview is running the TypeScript fallback.

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
These CI changes have not run for this uncommitted patch.

## 5. Verified checks and limitations

| Check | Result in this sandbox |
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
| Host Rust tests/clippy and pinned `cargo fmt` gate | **NOT RUN**; source formatted/parsed with WASM rustfmt, not compiled |
| Real generated bindgen/native x-geo smoke | **NOT RUN**; requires built assets |
| Real 30-case differential/performance | **NOT RUN**; no native equivalence/speedup claim |
| Full application E2E | **NOT RERUN**; prior failures remain recorded in parity reports |

Logs: `/home/user/wasm-{unit,tsc,build,replay,browser}.log`.

## 6. Remaining before native promotion

1. Run the changed Rust workspace gate and real-artifact CI smoke on this patch.
   Fix any compile, lint, schema or actual ABI failures; mocks do not waive this.
2. Run the real-module differential corpus. Keep failures visible and leave the
   automatic TS guard enabled; do not relax tolerances to manufacture a pass.
3. Expand native import equivalence coverage with real FIG/Sketch/SVG fixtures,
   especially typography, embedded images, resources and multi-page documents.
4. Measure native timing separately from the TS oracle and browser main-thread
   cost. Remove a per-call oracle only after promotion is backed by evidence.
