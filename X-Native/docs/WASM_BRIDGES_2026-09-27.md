# WASM bridges — implementation and verification

Date: 2026-09-27. Priority: complete the existing bridges before further Figma-parity work.

## 1. Status and authority

**Both bridges compile, package and execute in CI. Native geometry promotion has
FAILED the differential check; the TS guards remain enabled.** The sandbox itself
still has no cargo/rustc, and artifact/log CDN downloads remain inaccessible.
The earlier work was committed on `arena/01a0e1ff-x-native`; this import-only
continuation is on `arena/01a0e36f-x-native`. No generated binaries are checked
in; the local preview still uses the TypeScript fallback.

Latest verified code/CI checkpoint: `acb24b3`, [CI run 36336138062](https://github.com/Ankushui18/X-native/actions/runs/36336138062).
The basic FIG and both effects fixtures pass complete-result gates with `backend=wasm`;
plain/numeric-weight SVG text, SVG viewport defaults, and standalone group
translations now do too (see §§13–19).
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
  mapping (text runs, gradients, resources, components, layout, layered paints) is
  not promoted; those files retain their existing TS result. No new product feature.
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

## 8. Source text metrics and guarded typography (2026-09-27)

Import-only continuation; geometry kernels, comparators and promotion policy are
unchanged. This supersedes §7's text/bindings limitation only for the subset below,
not its historical results or remaining whole-file fidelity limitations.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W05 — FIG root-level characters lost | Native `text_json` accepts root `characters` when nested `textData.characters` is absent; nested content still wins; root typography is processed in either case | Committed FIG fixture plus nested/partial text-data Rust regressions |
| W06 — source text height lost during native lowering | `ImportReport.text_metrics` captures source width/height and explicit font size before native `Node.h` becomes font size; final deduplicated IDs key entries. FIG/Sketch WASM envelopes add independent `textMetrics.version=1` metadata | Collision/unknown-size Rust regression; both file fixtures assert source 200×24 versus native h=18; WASM envelope regression |
| W07 — all native typography bindings rejected | Adapter accepts text only with valid matching metadata; preserves Unicode content, source box, explicit size, literal font family, line-height ratio→pixels, tracking and left/center/right alignment | New `wasmText.test.mjs`: positive mappings plus legacy/malformed metadata, rich runs, non-text bindings, unsupported alignment, numeric overflow and full-contract fallback |
| W08 — native variable tables ignored | Accept only known empty variable tables; decline nonempty resources or unknown variable schemas rather than silently losing them | Empty/nonempty/unknown-variable regressions |

Persisted `.x` and ABI version 1 are unchanged. Legacy glue remains safe: text
without source metrics declines. SVG still does not supply explicit font-size
metadata and remains on TS for text. Font weight is the native unstyled default
400, not inferred from PostScript font names; missing source styles still require
the unchanged complete-contract TS equivalence check. Rich runs, variable-backed
styles and unmapped properties are not promoted. Metadata does not establish
complete FIG/Sketch typography or rendering fidelity.

### Verification

- Initial new regression suite: **24 passed / 8 failed**, establishing the missing
  text mapping and metadata checks. Final expanded suite: **34/0**.
- Local full suite: **2,945 passed / 0 failed**, 46 suite summaries; existing bridge
  suite remains **39/0**. `tsc -b` clean and production build passes (existing
  chunk-size warning). An intermediate TS check rejected `justify` because the
  web `TextAlign` contract lacks it; adapter now declines it explicitly, tested.
- Local cargo/rustc are unavailable; native verification ran in **CI
  [36316826914](https://github.com/Ankushui18/X-native/actions/runs/36316826914)**
  at runtime commit `ed200ae3da50ce9922f208bc647c70f0a2c45f4b`: **SUCCESS**.
  Rust workspace gate, regenerated WASM packages, real-artifact smoke and web
  checks passed. Rust job: `108612990861`.
- Actual WASM output for both committed file fixtures retains the expected text
  content, source **200×24** box and **18px** font size. Each complete native
  document now passes the adapter, including its literal typography bindings.
  Both production wrappers still use TS: **“Native import differs from
  TypeScript; kept the complete TypeScript result.”** The former unsupported
  `text`/`bindings` rejection is resolved, not whole-document fidelity.
- Browser fallback smoke rerun: actual dashboard SVG upload, persisted editable
  rectangle and reload pass, with zero uncaught errors and native assets absent.
- Unchanged geometry diagnostic: **1/30 equivalent, 29 failures**, repeat 2;
  summed means TS 72.00ms / native 6.56ms. Non-blocking geometry failure remains
  visible in CI annotations; green CI is not geometry promotion or speedup proof.
- Native browser E2E and broad rich-import fidelity remain **NOT VERIFIED**.
  The screenshot job again uploaded no screenshots, so is not visual signoff.

Local evidence: `/home/user/wasm-text-{red,focused,unit,tsc,build,browser,ci}.log`;
native evidence: `/home/user/wasm-text-annotations.json`.

## 9. Layer locks, alignment and Sketch Cocoa attributes (2026-09-27)

Import-only continuation. No geometry, placement normalization, hierarchy,
production comparator, or TS importer behavior changes. The complete-result
comparison still decides promotion, not successful field conversion.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W09 — source layer locks dropped before adapter | FIG binary shim and REST reader preserve `locked`; Sketch reader preserves `isLocked`; shared IR lowers per-layer flags to native `Node.locked` | Separate four-text FIG/Sketch fixtures include locked and unlocked layers; Rust import + `.x` save/load regression; parent/child IR regression does not bake inherited locks into children |
| W10 — source horizontal alignment discarded | FIG shim carries `textAlignHorizontal`; REST and Sketch map explicit alignment into the existing native enum; adapter accepts the valid `justified` spelling | Fixtures cover left/center/right/justified; web regression first failed, now all four alignments × both lock values pass. Invalid `justify` and unknown spellings still decline |
| W11 — Sketch Cocoa typography keys ignored | Read `NSKern` and `NSParagraphStyle`, retaining legacy `kerning` / `paragraphStyle` aliases. Positive minimum line height retains precedence; positive maximum is a fallback, converted to native ratio | Fixtures use 27px line height / 18px font size and 2.25px tracking; Rust regression pins alias precedence and explicit zero tracking |

The previous batch correctly rejected the invalid spelling `justify`, but missed
that both native and web enums support **`justified`**. This batch maps that exact
value rather than changing either model or weakening validation.

Reproducible synthetic binary fixtures: `e2e/fixtures/state-text.fig` and
`state-text.sketch`, generated by the adjacent Python scripts. Existing sample
fixtures remain unchanged. These are authored regression archives, not evidence
of broad third-party file compatibility.

The existing native-artifact smoke now logs the first 12 candidate/TS differing
paths per sample. This is bounded test-only diagnostics, not a relaxed comparator
or copying TS values into the native result.

### Verification

- Local full suite: **2,946 passed / 0 failed**, 46 suite summaries; text suite
  **35/0**, bridge suite **39/0**. `tsc -b` and production build pass (existing
  chunk-size warning).
- Initial text regression: **34/1**, rejecting valid `justified`; now green.
- Both new archives also parse through the real TS readers locally. FIG preserves
  all four alignments and the lock; Sketch preserves the lock and Cocoa spacing,
  but its existing reader maps justified to left. That discrepancy is retained
  by the strict fallback policy, not silently resolved in this WASM-only batch.
- **CI [36318122770](https://github.com/Ankushui18/X-native/actions/runs/36318122770)
  SUCCESS**, runtime `7fb7476dc4d0a1ec5910b043a2b34f396661241d`.
  Rust workspace gate, both WASM packages, expanded actual-artifact smoke and web
  checks pass. Rust job: `108616600519`. Local cargo/rustc remain unavailable.
- Actual WASM imports of both new archives retain all four alignments and the
  locked/unlocked flags; Sketch additionally retains 27px line height and 2.25px
  tracking. Original text/source-bounds regressions still pass. All four fixture
  wrappers use TS after whole-result differences; native simple SVG still passes
  equivalence and uses WASM.
- Remaining sample FIG differences include x/y, blend mode, effects, fill type,
  stroke alignment and cap fields. Sample Sketch differences include root kind,
  x/y/rotation, child hierarchy, fill type and top-level node count. These are
  observed differing paths, not a claim that each mismatch has the same cause;
  none were normalized away to force promotion.
- Dashboard SVG upload → editable persisted rectangle → reload passes again
  with native assets deliberately missing; zero uncaught browser errors.
- Geometry is unchanged: **1/30 equivalent, 29 failures**, repeat 2; summed means
  TS 59.29ms / native 6.42ms. Non-blocking diagnostic failure is not promotion or
  speedup approval.
- Native browser E2E and broad rich-import fidelity remain **NOT VERIFIED**.
  The screenshot job produced no screenshot artifacts; not visual signoff.

Evidence: `/home/user/wasm-state-{red,unit,tsc,build,reference,browser,ci}.log`;
actual-artifact messages: `/home/user/wasm-state-annotations.json`.

## 10. Stroke options and materialized-stack safety (2026-09-27)

Import-only continuation. The TypeScript whole-result comparator and geometry
kernels/guards are unchanged. No flattening, coordinate shifting or default-field
normalization was added to force native promotion.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W12 — FIG stroke geometry dropped before WASM | Binary shim retains stroke alignment, cap, join and dash array; REST parser fills the existing shared `StrokeOptions`. Additional native strokes inherit the same node-level options | New `stroke-options.fig` synthetic archive covers three alignments/caps/joins and solid/single/pair dashes; Rust fixture checks import and `.x` save/load |
| W13 — materializing strokes hid imported effects | Shared lowering now assigns imported effects before materializing visual stacks, so the active effect stack is initialized with them | Rust regression covers materialization by multiple strokes, with/without explicit options, active effect visibility and `.x` persistence |
| W14 — all materialized solid strokes rejected by web adapter | Strict identity mapping accepts one visible, opacity-1, normal-blend solid fill and at most one matching solid stroke; maps basic symmetric caps, joins, alignment and positive one/two-element dashes | New `wasmStroke.test.mjs`: positive matrix plus 26 rejection cases and unchanged whole-contract comparison; actual-artifact smoke extended for FIG and stroked SVG |

This is **not** general paint-stack support. Empty/mismatched stacks cannot silently
reuse stale legacy paints. Multiple fills/strokes, gradients, effects, hidden or
translucent entries, blend overrides, asymmetric/arrow caps, custom miters, dash
phase and complex/zero-length dash patterns still decline. Effects are preserved
in native lowering, not newly converted to the web schema in this batch.

The new fixture is generated by `e2e/fixtures/make-fig-fixture.py --strokes`;
existing fixture binaries are unchanged. Synthetic coverage is not broad
third-party file or visual-rendering signoff.

### Verification

- Initial adapter regression: **26 passed / 5 failed**; final stroke suite **31/0**.
- Local full suite: **2,977 passed / 0 failed**, 47 suite summaries; text **35/0**,
  existing bridge **39/0**. `tsc -b` and production build pass, with the existing
  chunk-size warning.
- **CI [36319037573](https://github.com/Ankushui18/X-native/actions/runs/36319037573)
  SUCCESS**, runtime `43a5ed55188f1f68d06038208d5988834bf52d92`.
  Rust workspace gate, both WASM packages, expanded real-artifact smoke and web
  checks pass. Rust job: `108619168025`. Local cargo/rustc remain unavailable.
- Actual WASM decodes the complete FIG stroke fixture with all expected options;
  raw native SVG also passes materialized solid-stroke conversion. Original
  content/metrics, state/typography, error-envelope and native simple-SVG routing
  tests still pass. The FIG fixture wrapper retains TS because other whole-result
  differences remain. Stroked SVG conversion is not browser-native visual proof.
- Sample FIG's first-12 differing-path diagnostic no longer lists stroke alignment
  or cap; placement, blend/effects/fill-type metadata and corner independence
  remain visible. Sketch's structural differences remain. No guard was relaxed.
- Browser fallback smoke: actual dashboard SVG upload, editable persisted rectangle
  and reload pass with native assets absent; zero uncaught browser errors.
- Unchanged geometry diagnostic: **1/30 equivalent, 29 failures**, repeat 2;
  summed means TS 59.19ms / native 6.48ms. Non-blocking failure is still explicit;
  green CI is not geometry promotion or speedup approval.
- Native browser E2E, broad rich-import fidelity and performance promotion remain
  **NOT VERIFIED**. No screenshot artifacts were produced by the screenshot job.

Evidence: `/home/user/wasm-stroke-{red,unit,tsc,build,browser,ci}.log`;
native messages: `/home/user/wasm-stroke-annotations.json`.

## 11. Explicit layer blends and guarded basic effects (2026-09-27)

Import-only continuation. No changes to TypeScript importers, whole-result
comparison, coordinate/hierarchy handling, or boolean kernels/guards.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W15 — FIG layer blend modes discarded | Binary shim carries `blendMode`; REST parser maps the 19 existing native modes through shared IR into `Node.blend`; adapter translates explicit serialized mode names to existing web labels | Native enum-name regression; adapter label table test; binary fixture imports and persists Multiply, Soft Light and Pass Through |
| W16 — literal `LAYER_BLUR` dropped by FIG shim | Accept both `LAYER_BLUR` and the existing `FOREGROUND_BLUR` spelling as native layer blur | Binary fixture contains both aliases; native persistence regression |
| W17 — all basic native effects rejected by adapter | Map ordered drop/inner shadows and layer/background blurs; accept materialized effect lists only when they exactly match the legacy effects, with visible/opacity-1/normal-blend layers | New `wasmEffects.test.mjs` covers legacy/materialized mappings, colors/offsets/radii, list order, malformed data, unknown modes/types, overriding stacks and complete-contract fallback |

This maps the **native effect model**, not every source effect property. Native
legacy effects do not preserve source shadow spread, hidden effects, effect blend
modes or show-behind options. Those source-only differences must still fail the
unchanged complete-result oracle. Tests explicitly verify that changing these
properties makes results unequal. Noise, unknown effect fields, invalid radii,
non-identity effect stacks and unknown blend modes decline rather than being
silently discarded. Absent blend fields remain absent; no default-field
normalization was added to force promotion.

The synthetic `e2e/fixtures/effects-blend.fig` is generated with
`make-fig-fixture.py --effects`. It exercises four ordered effects together with
a stroke-materialized stack, a legacy blur list, both blur spellings and three
layer blend modes. Existing binary fixtures remain unchanged.

### Verification

- Initial adapter regression: **20 passed / 6 failed**; final effect suite **26/0**.
- Local full suite: **3,003 passed / 0 failed**, 48 suite summaries; existing stroke
  **31/0**, text **35/0**, bridge **39/0**. `tsc -b` and production build pass
  (existing chunk-size warning).
- **CI [36319870093](https://github.com/Ankushui18/X-native/actions/runs/36319870093)
  SUCCESS**, runtime `a63c981c5e8d2e936509f717d211588f190f08fe`.
  Rust workspace gate, both WASM packages, expanded real-artifact smoke and web
  checks pass. Rust job: `108621515526`. Local cargo/rustc remain unavailable.
- Actual WASM imports the complete effects fixture, retaining the four effects
  in order, their colors/offsets/radii, matching materialized and legacy lists,
  both blur spellings and the explicit layer modes. Its production wrapper still
  uses TS because whole-document differences remain. Previous fixture checks and
  native simple-SVG routing continue to pass.
- Original sample FIG still differs in placement, absent/default blend/effect/
  fill-type metadata and corner independence; Sketch still differs in root
  kind, transforms and hierarchy. Mapping explicit properties does not eliminate
  those separate mismatches, and no normalization was added to conceal them.
- Browser fallback smoke: dashboard SVG import, editable persisted rectangle and
  reload pass with native assets absent; zero uncaught browser errors.
- Geometry remains guarded: **1/30 equivalent, 29 failures**, repeat 2; summed
  means TS 63.03ms / native 6.91ms. This non-blocking diagnostic failure is not
  promotion or speedup approval.
- Native-browser visual fidelity, broad rich-import parity and performance
  promotion remain **NOT VERIFIED**. The screenshot job produced no artifacts.

Evidence: `/home/user/wasm-effects-{red,focused,unit,tsc,build,browser,ci}.log`;
actual-artifact messages: `/home/user/wasm-effects-annotations.json`.

## 12. Source FIG coordinates and content extents (2026-09-27)

Import-only continuation. The native editor still normalizes page content near
(40,40); persisted `.x`, boolean kernels and the production comparison guard are
unchanged. The adapter now has explicit source data instead of guessing an offset.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W18 — native page normalization displaced web imports | Capture exact top-level translations before normalization; shared report keys them by final deduplicated IDs. FIG WASM envelopes add `figmaCoordinates.version=1`; adapter requires complete, unique top-level coverage and restores positions before pivot rebasing | Rust collision/precision regression, binary multi-page fixture and envelope regression; web tests cover negative/tiny coordinates, unchanged nested local positions, pivot ordering and malformed/incomplete metadata |
| W19 — native page envelope used as web file bounds | When FIG coordinate metadata is present, measure source-space content extents across all pages/descendants and select the first nonempty page's nodes while retaining every page | Empty first page + negative/positive pages + overflowing child fixture; expected 470×340 bounds, matching the existing TS reader |

Only FIG envelopes carry this metadata. Legacy glue and SVG/Sketch decoding keep
their previous behavior; no coordinates are inferred from the native page box.
Exact source values are saved rather than reversing a floating-point offset.
Nested local coordinates are not shifted or flattened. Unknown metadata versions,
missing/duplicate/unused positions, unexpected page transforms, nonfinite values
and bounds overflow all decline. This fixes placement and page selection, not
unrelated paint/default-field/hierarchy differences; the entire candidate still
must equal the TypeScript result.

The new `e2e/fixtures/coordinates.fig` synthetic archive is generated by
`make-fig-fixture.py --coordinates`. It has an ordered empty page, a negative-space
frame with an overflowing child, and a positive-space rectangle on another page.
Existing fixtures are unchanged. Native positions remain (40,40) in Rust tests;
source positions are (-120,-80) and (300,200), with child-local (10,20).

### Verification

- Initial coordinate regression: **1 passed / 20 failed**; final suite **21/0**.
- Serial local full suite: **3,024 passed / 0 failed**, 49 suite summaries.
  `tsc -b` and production build pass (existing chunk-size warning).
- The first full run, concurrent with the build, stopped at the existing
  **200-child auto-layout under-100ms** timing check: 934/1 in the first suite.
  No layout code or threshold changed; a subsequent full serial run passed.
- The new binary fixture also parses through the real TS reader locally, with
  preserved page order, negative positions, local child coordinates and 470×340
  content bounds. This is not native execution evidence by itself.
- **CI [36320770727](https://github.com/Ankushui18/X-native/actions/runs/36320770727)
  SUCCESS**, runtime `f7de25533a0c41dd9326d13a57dbc1aba04bbe34`.
  Rust workspace gate, both WASM packages, expanded real-artifact smoke and web
  checks pass. Rust job: `108624032736`. Local cargo/rustc remain unavailable.
- Actual WASM verifies unchanged native (40,40) placement alongside restored
  negative/positive source positions, unchanged nested local coordinates, empty
  first-page selection and **470×340** content bounds matching TS. The original
  sample FIG also restores Home to (100,50), Card x=120 and **320×240** bounds.
- Sample FIG's first-12 differing paths now start with blend/effects/fill-type
  metadata and corner independence, then text fill/visibility—not x/y. The
  production wrappers still retain complete TS results for remaining differences;
  this is not whole-file native promotion. Sketch behavior is unchanged.
- Browser fallback smoke: dashboard SVG import, editable persisted rectangle and
  reload pass with native assets absent; zero uncaught browser errors.
- Geometry remains guarded: **1/30 equivalent, 29 failures**, repeat 2; summed
  means TS 46.84ms / native 5.31ms. Non-blocking diagnostic failure is not native
  promotion or speedup proof.
- Native-browser visual fidelity, broad rich-import parity and performance
  promotion remain **NOT VERIFIED**. The screenshot job produced no artifacts.

Evidence: `/home/user/wasm-coordinates-{red,focused,unit,unit-serial,tsc,build,reference,browser,ci}.log`;
actual-artifact messages: `/home/user/wasm-coordinates-annotations.json`.

## 13. Source appearance facts and basic FIG promotion gate (2026-09-27)

Import-only continuation. The production comparator and TS importers are unchanged;
no native candidate is patched with values obtained from the TS oracle. Geometry
kernels/guards and persisted `.x` rendering defaults are also unchanged.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W20 — native fallback paints mistaken for source fills | Capture per-layer FIG appearance facts keyed by final IDs. Distinguish absent fill, one opaque visible unblended solid fill, and unsupported paint data. Adapter restores absent source fills instead of exposing native black-text/white-frame fallback paint | Native original fixture checks text remains black in `.x` while source fact says no fill; web test restores transparent source text without losing text or dimensions |
| W21 — explicit FIG contract defaults missing from adapter | Versioned `figmaAppearance` metadata permits source-backed fill type, absent-vs-explicit layer blend, empty effect list, uniform/linked rectangle corners and zero imported-image count | New appearance suite validates defaults, explicit NORMAL, complete metadata coverage, contradictions, unsupported paints/resources and unchanged full-result comparison |
| W22 — dropped paints could appear falsely absent | Binary shim retains an unsupported-paint marker and source paint blend presence through the REST shim; native paint conversion still declines unsupported types | Rust regression proves an unrepresentable VIDEO paint is marked unsupported, not an empty fill list |
| W23 — shared lowering overflows the normal stack after IR metadata grows | Separate single-node construction from recursive traversal, releasing the large constructor frame before descending; retain preorder IDs and all import semantics | Existing 64-level SVG test unchanged; new explicit 2 MiB-stack, 65-node metadata regression checks final IDs, source maps, text metrics and native fill defaults |

The supported subset is deliberately narrow: single opaque visible normal-composited
solid fills or no fill. Multiple/hidden/translucent/blended/unsupported paints decline.
Unknown versions, missing/unused facts, native/source blend or effect-count
contradictions, invalid corner metadata and images decline. Per-corner and richer
effect differences remain subject to full-contract fallback; metadata is not a
claim of broad native import fidelity. Legacy envelopes acquire none of these
defaults. Source appearance is carried only in FIG envelopes, not SVG/Sketch.

The real-artifact smoke now **requires** the existing `sample.fig` candidate to
match the complete TS result and select `backend=wasm`. This is an explicit
promotion gate for that fixture, not a relaxed comparison or broad promotion.

### Verification

- Initial appearance regression: **3 passed / 22 failed**; final suite **25/0**.
- Serial local full suite: **3,049 passed / 0 failed**, 50 suite summaries.
  `tsc -b` and production build pass (existing chunk-size warning).
- Initial native gate failed in CI `36321987492`, then reproduced in
  `36322180613` and `36322340267`. Improved API-readable crash annotations
  identified `svg_import::tests::svg_import_accepts_reasonable_nesting`:
  **stack overflow / SIGABRT**, not an appearance assertion failure. Build and
  clippy passed; packaging and actual WASM smoke did not run in those attempts.
  W23 addresses the shared lowering frame; no test/depth/stack limits were relaxed.
- **CI [36322532944](https://github.com/Ankushui18/X-native/actions/runs/36322532944)
  SUCCESS** at `9677ddf59c92777e00931e8a4650c174144e162f`. Rust workspace
  formatting/clippy/tests, both WASM packages, actual-module smoke and web gates
  pass. Rust job: `108629004183`. Local cargo/rustc remain unavailable.
- Original basic FIG: **candidate differences: none; backend=wasm; fallback=none**.
  The smoke asserts full candidate equivalence, not merely selected fields or a
  TS-patched return value. FIG state, stroke-options and coordinate fixtures also
  select WASM. Sketch fixtures and the richer FIG effects fixture still select TS;
  these are verified safe fallbacks, not full native-format parity.
- Both the existing 64-level SVG nesting regression and new explicit 2 MiB-stack
  metadata lowering regression pass through the workspace gate. Construction is
  separated from recursion; ordering, final IDs, metadata and native defaults are
  retained. No enlarged stack environment, skipped test or reduced depth limit.
- After the stack fix, serial local full npm suite again **3,049/0**, 50 summaries;
  `tsc -b` and production build pass. Missing-WASM browser fallback smoke also
  passed in this batch (dashboard SVG → editable rectangle → persistence/reload,
  no uncaught errors).
- Geometry remains guarded: **1/30 equivalent, 29 failures**, repeat 2; summed
  means TS 57.85ms / native 6.40ms. This is not promotion or speedup proof.
- CI published `x-wasm` and `wasm-verification` artifacts. Screenshot job produced
  no screenshots. Native-browser visual fidelity, broad rich-import parity and
  performance promotion remain **NOT VERIFIED**.

Evidence: `/home/user/wasm-appearance-{red,focused,unit,tsc,build,browser,ci,ci-2,ci-3,ci-4}.log`,
`/home/user/wasm-appearance-stack-{unit,tsc,build}.log`,
`/home/user/wasm-appearance-ci-red-3.json` (named stack abort),
`/home/user/wasm-appearance-annotations.json` (genuine artifact results).

## 14. Source-backed FIG effect fidelity (2026-09-27)

Import-only continuation. The complete-result comparator, geometry kernels/guard,
and native `.x` rendering/persistence remain unchanged. Unlike §13, this batch
also fixes a demonstrated omission in the existing TS FIG importer: the binary
`FOREGROUND_BLUR` alias must not silently disappear while `LAYER_BLUR` survives.
The native binary shim already treats both as layer blur. No oracle relaxation.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W24 — web FIG importer drops binary foreground blur | Recognize both existing blur spellings as the existing layer-blur effect | Binary tests exercise both aliases, including a hidden alias; the original effects fixture is unchanged |
| W25 — source effect fields lost at native boundary | Capture complete ordered source facts, including hidden entries, spread, blend, show-behind and source color; emit FIG-only `figmaEffects.version1` keyed by final IDs | New native shim/IR/fixture/envelope tests; source-effects fixture carries materialized shadows, negative spread, explicit/absent blends, hidden entries and source blur color |
| W26 — restoring source fields could hide inconsistent native effects | Validate the entire visible native projection and active materialized stack before applying metadata; require exact node coverage, version, field types, effect count and known kinds/blends | 32-test source-effects suite covers native contradictions, unsupported data, malformed metadata, missing/unused records, limits, legacy behavior and unchanged complete comparison |

The source facts are not values borrowed from the TS result. Native visible
shadow offsets/colors/radii and blur radii must agree, in order, with the facts;
hidden entries must have no corresponding native effect. Source-only fields are
then restored. Native rendering still excludes hidden effects and retains its
existing reduced effect model, including after `.x` persistence. Old envelopes
without the sidecar keep their previous adapter semantics, not guessed defaults.
Unknown source effect kinds survive the binary shim as unsupported markers and
force fallback rather than becoming a false empty list.

The new deterministic `effect-source.fig` fixture (797 bytes) is generated with
`e2e/fixtures/make-fig-fixture.py --effect-source`. Existing fixture binaries are
unchanged. Real-artifact smoke now requires complete candidate equivalence AND
`backend=wasm` for both the original effects fixture and the new source-effects
fixture. Synthetic fixture coverage is not general real-world or visual signoff.

### Verification

- Regression first: **25 passed / 7 failed**; implemented source-effects suite **32/0**.
- Serial full npm suite: **3,081/0**, 51 summaries. `tsc -b` and production build
  pass (existing chunk-size warning). Missing-WASM browser fallback smoke passes:
  dashboard SVG upload → editable rectangle → persistence/reload, no uncaught errors.
- **CI [36323243749](https://github.com/Ankushui18/X-native/actions/runs/36323243749)
  SUCCESS**, commit `ddf4472f306d61c9d2b6db5b29faa125d35660b0`; Rust job
  `108631010562`. Rust workspace, WASM packaging, genuine-module smoke and web
  gates all pass. Published `x-wasm` and `wasm-verification` artifacts.
- Both the original `effects-blend.fig` and new `effect-source.fig` have no
  complete-result candidate differences and select `backend=wasm`. This verifies
  the tested subset (including source-only fields); it does not establish broad
  third-party file or visual fidelity. Real Sketch fixtures and rich unsupported
  cases continue to fall back safely.
- Geometry remains guarded: **1/30 equivalent, 29 failures**, repeat 2; latest
  summed means TS 64.43ms / native 6.73ms. Not promotion or speedup proof.
- Screenshot job reported no screenshot files. Broad rich-import parity,
  native-browser visual fidelity and performance remain **NOT VERIFIED**.

Evidence: `/home/user/wasm-source-effects-{red,focused,unit,tsc,build,browser,ci}.log`,
`/home/user/wasm-source-effects-annotations.json`.

## 15. Neutral SVG group flattening (2026-09-27)

Import-only continuation. The strict import oracle, native geometry and persisted
`.x` model are unchanged. Web SVG import walks through `<g>` wrappers and returns
its drawable children directly; native import previously returned explicit Group
nodes even when there was no transform. This structural mismatch blocked native
selection for otherwise basic SVGs.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W27 — transform-free SVG groups differ structurally across importers | Flatten untransformed groups into their parent on close, including nested/empty wrappers. Child style computation still inherits fill/stroke/opacity. Keep groups with a transform structural so current unsupported affine/group composition safely falls back | Native tests cover nested groups, empty group, inherited fill+opacity, and transformed group retention; actual-module smoke requires full equivalence and `backend=wasm` for neutral groups, and confirms transformed groups stay on TS |

Group IDs are not emitted as drawable nodes, matching existing web behavior.
Transformed groups are not flattened or patched with the TS result; they remain
subject to the unchanged full-contract guard. This only aligns neutral wrappers,
not broad SVG parity.

### Verification

- **CI [36327446710](https://github.com/Ankushui18/X-native/actions/runs/36327446710)
  SUCCESS**, code `9704d64e65f441db36756e9a8a7a7c1d5337d610`; Rust job
  `108642820454`. Rust workspace, both WASM packages, actual-module smoke, web
  tests/build and screenshot test job pass. `test:wasm` reports `Diff grouped SVG:
  none`; the grouped fixture selects `backend=wasm`, `fallback=none`. A transformed
  group selects TS with the expected full-result mismatch fallback.
- Serial local web suite: **3,081/0**, 51 summaries; `tsc -b` and production build
  pass. Local headless Chromium smoke could not run because `/tmp/chromium` is not
  present. The screenshot job produced no image artifacts.
- Neutral wrappers with inherited fill/opacity are verified; transformed groups
  and broad third-party SVG/import parity remain guarded or **NOT VERIFIED**.
  Native-browser visual fidelity remains **NOT VERIFIED**.

Evidence: `/home/user/wasm-svg-groups-{unit,tsc,build,browser,ci-final2}.log`;
actual-module messages: `/home/user/wasm-svg-groups-ci-annotations.json`.

## 16. Basic SVG text metrics and anchors (2026-09-27)

Import-only continuation. The existing browser SVG importer already handles
plain literal text, but the Rust candidate used synthetic widths/baselines and the
WASM SVG envelope omitted text-metric metadata; therefore even basic text always
fell back. The shared full-result oracle remains unchanged.

### Fixes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W28 — basic SVG text could never satisfy the web contract | Emit shared versioned text metrics for SVG imports; capture text content/name, UTF-16-compatible width estimate, source-box height, baseline top position, font size and `text-anchor` alignment | New Rust importer and wasm-envelope regression for “Keep this text” (200×120 SVG, 20px, middle anchor); real-module smoke requires the decoded candidate and wrapper to match the complete TS result |
| W29 — rich SVG weight could be silently implied if routed natively | No weight inference added: the native adapter still reports only its existing 400 default, so non-400 text must fail the strict comparator and keep the TS result | Real-module smoke asserts weight 700 stays on the TS fallback |
| W30 — initial real-module smoke rejected SVG text with an explicit `id` | Preserve the source id as the native display name; use a content preview only without an id. Native `.x` omits `name` when it equals `id`, so the adapter uses the serialized id as the effective name. Neither path borrows values from the TS result | Rust importer/envelope tests, TS whole-result guard regression (including omitted `name`), real-module named/unnamed text and bold fallback smoke |

Only plain text representable by the current native typography contract is
promoted. Complex SVG text/tspan/font styling remains guarded. Metrics describe
the existing web importer’s approximate text-box convention, not measured font
rendering or visual equivalence.

### Verification

- The first SVG-text runs, including the merge commit, **failed** real-WASM smoke
  because native named `<text>` used its content rather than its SVG id; the
  initial follow-up also expected `.x` to serialize a redundant name. Both
  issues were corrected without changing the TS comparator or persisted schema.
- **CI [36329391845](https://github.com/Ankushui18/X-native/actions/runs/36329391845) SUCCESS**
  on `9b2f31c`: Rust workspace fmt/clippy/tests, matched WASM packaging, genuine
  generated-module smoke and web tests/build all pass. The native candidate and
  production wrapper select `backend=wasm` for named and unnamed basic SVG text;
  weight 700 safely falls back to TS. `x-wasm` and verification artifacts uploaded.
- Local `npm test` and production `npm run build` pass. Local Cargo/rustc and
  Chromium remain unavailable, so no local real-WASM or browser-visual claim.
- Native geometry promotion remains **NOT APPROVED** (1/30 equivalent, 29 failed
  in that CI run); `auto` keeps its TS comparator. Native-browser visual fidelity
  and complex SVG text remain **NOT VERIFIED**.

Evidence: CI run above and its `wasm-verification` artifact/annotations. The local
preview does not contain the CI-built WASM assets and uses the TS fallback.

## 17. Fail-closed document envelopes and SVG viewport sizing (2026-09-27)

Import-only continuation. TypeScript remains the whole-result oracle; no WASM
editor replacement, persisted `.x` schema change or geometry promotion.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W31 — unknown document-level fields and malformed empty resources could disappear silently | The web adapter now admits only known success-envelope and `.x` v1 document fields. It validates empty styles, component props, comments, assets and libraries with their native container types; present default fonts, nonempty resources, unexpected fields and null variable tables decline to the complete TS import. Missing optional fields still work with old envelopes | Red-first web regressions for unknown fields, wrong types, nonempty resources, complete-wrapper fallback, and typed empty native tables; real-module smoke mutates a valid envelope to check rejection |
| W32 — native SVG root defaulted to 800×600 even when web import used a `viewBox` or 100×100 | Read a finite four-number `viewBox` for missing/zero width or height; explicit nonzero dimensions win. Without either, use the web importer's 100×100 defaults. Malformed/unsupported geometry remains subject to the unchanged complete-result comparator | Rust importer/envelope tests; actual-module smoke compares three entire SVG results (viewBox-only, explicit width + viewBox height, and no dimensions) and requires `backend=wasm` for each |

These checks protect the conversion boundary, not native rendering or support
for nonempty component/resource tables. No TypeScript oracle fields are copied
into the native candidate; resources without a lossless mapping still fall back.

### Verification

- Local `npm test`, `npm run build` and `git diff --check` pass. This sandbox
  still cannot build Rust or run native-browser visual checks.
- **CI [36330628149](https://github.com/Ankushui18/X-native/actions/runs/36330628149) SUCCESS**
  on `1e89edf`: Rust formatting/clippy/workspace tests, matching WASM packaging,
  real generated-module smoke, and web tests/build. The actual candidate logs
  `Diff SVG viewBox dimensions: none`, `Diff SVG explicit width over viewBox:
  none`, and `Diff SVG default dimensions: none`; each production wrapper
  selects WASM after complete equivalence.
- The documentation/smoke follow-up **CI [36330943567](https://github.com/Ankushui18/X-native/actions/runs/36330943567) SUCCESS**
  on `ad16bf0` additionally exercised an actual generated-module envelope
  mutated with unsupported document metadata; the adapter declined it. The
  three whole-result viewport matches were still verified.
- Geometry stays guarded: **1/30 equivalent, 29 differential failures** in this
  run; the `auto` mode TS check is unchanged. Broader SVG fidelity, browser
  visual parity, and native speedup remain **NOT VERIFIED**.

## 18. Guarded numeric SVG text weight (2026-09-27)

Import-only continuation. This narrows §16's *historical* weight-700 fallback:
explicit numeric element `font-weight` values can now enter the candidate through
native source facts; no TS-oracle value is copied into the candidate.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W33 — numeric SVG text weight always fell back even when the rest of the native text result agreed | The SVG parser records only complete decimal element attributes in the positive 1–1000 CSS numeric range. Shared lowering keys this import-only fact by the final deduplicated text ID. The SVG envelope uses `textMetrics.version=2` with `fontWeight` set to a number or `null` (no supported numeric attribute); FIG/Sketch remain on version 1. The web adapter accepts both versions, requires the v2 field, rejects malformed/out-of-range values, and uses the unstyled 400 default only when no supported weight was reported | Red-first `wasmText` regressions for valid/invalid versions, range and keyed IDs; Rust SVG/import-IR/envelope regressions; real generated-module smoke checks weight 700, the unchanged persisted `.x`, whole-result equivalence, wrapper backend, malformed-metadata rejection and partial-numeric fallback |

The `.x` document schema, WASM function ABI, import comparator and native text
rendering model are unchanged. No PostScript-name inference, rich text, inherited
CSS styling, or broad SVG text support is claimed. E.g. `700bold` is not emitted
as a numeric source fact; the current TS importer parses it as 700, so the
complete-result check retains TS rather than dropping its value.

### Verification

- Local red-first `wasmText` run failed on v2 metadata as expected; the focused
  suite then passed **45/0**. The full local `npm test`, `npx tsc -b`,
  `npm run build`, and `git diff --check` pass (pre-existing large-chunk warning).
- The initial push's Rust gate caught a test-assertion formatting error; after
  that was corrected, the real-module smoke caught its stale SVG call-count
  assertion (9 instead of 10 with the new fallback case). No comparator or
  format/schema guard was relaxed. The smoke now emits a bounded error annotation
  if a future assertion fails where runner logs are inaccessible.
- **CI [36334336133](https://github.com/Ankushui18/X-native/actions/runs/36334336133) SUCCESS**
  on `dbacb2c`: Rust formatting, clippy/workspace tests, both WASM builds,
  real generated-module smoke, web tests/build and screenshot jobs passed.
  Annotations confirm `Diff SVG numeric weight: none` and
  `PASS actual-module SVG numeric weight selects guarded WASM result`. The
  production wrapper selects WASM for the complete weight-700 candidate;
  `700bold` retains TS, and malformed source metadata is rejected.
- Local Cargo/rustc and a generated WASM module are unavailable. The native
  geometry promotion diagnostic is still **NOT APPROVED: 1/30 equivalent**;
  `auto` keeps the TS comparator. Wider SVG and browser-visual parity and
  native import speedup are **NOT VERIFIED**.

## 19. Standalone SVG group translations and text siblings (2026-09-27)

Import-only continuation. The Rust importer now matches the existing web
importer's flat layer contract for a bounded group-transform subset. This
supersedes §15's transform-free-only boundary **only** for single translations.
TypeScript remains the complete-result oracle; this does not promote general
SVG transforms.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| W34 — native `<g transform="translate(...)">` kept an extra group layer, while the web importer applied its offset to each child | Flatten only a **single complete `translate()`** with one or two finite numeric arguments. Apply its offset to child positions, or precompose it before an existing child affine; nested offsets retain source order. Do not flatten ambiguous/compound/rotated groups; they remain structural candidates behind the TS guard | Rust regressions for nested offsets, inherited style and child matrix composition, plus real generated-WASM whole-result checks with `Diff translated SVG group with text and siblings: none` and `Diff translated SVG group with child matrix: none`. Both production wrappers select WASM; rotated and compound groups remain on TS |
| W35 — `</text>` popped the current `<g>` or root frame and could discard subsequent siblings | Close only the group/root frames actually pushed by the importer. Clear pending empty text on `</text>`; nonempty text is already appended when read. An empty or unsupported child is not an excuse to close its parent early | Web-oracle regression pins the four sibling names/positions; Rust importer and WASM envelope tests pin following shapes; the real module matches the entire text-plus-shapes import |

The earlier generic native test expected a `grp` wrapper for a pure translation;
that expectation was replaced with the web-compatible absence of the wrapper.
Dedicated importer tests now assert its children's actual coordinates. The `.x`
schema, WASM ABI, TypeScript parser, whole-result comparator, and geometry kernels
are unchanged. General group matrices/rotation/scale/skew, rich text and
resource imports are not declared equivalent by this slice.

### Verification

- Local TS oracle/focused bridge test: **50/0**; full `npm test`, `npm run build`,
  `node --check` of real-module smoke and `git diff --check` pass. Local Cargo
  and generated WASM assets remain unavailable.
- CI first caught the outdated legacy-group expectation, then Rust-formatting
  differences in that updated assertion. The expected group contract was
  corrected; the assertion was kept in the dedicated offset regression. No
  comparator was loosened and no unsupported group transform was promoted.
- **CI [36336138062](https://github.com/Ankushui18/X-native/actions/runs/36336138062) SUCCESS**
  on `acb24b3`: Rust fmt/clippy/workspace tests, both WASM packages, genuine
  module smoke, web tests/build and screenshot job passed. Annotations show
  both translated-group diffs as `none`, production WASM selection, and TS
  fallback for rotation/compound transforms.
- Native geometry promotion remains **NOT APPROVED (1/30 equivalent, 29 failed)**.
  `auto` retains the TS comparator. Browser-visual parity, broad SVG coverage
  and import speedup are **NOT VERIFIED**.

## 20. Opt-in Rust document command/state session (2026-09-27)

The requested **destination** is one Rust document/command/undo/layout engine
shared by web (WASM) and native (direct Rust), with TypeScript limited to UI and
application concerns. This is the first **command-boundary** slice, not a claim
that the production web editor has already reached that destination.

`x-editor::DocumentSession` owns one `x-core::Document` page and delegates edits
and undo/redo to the existing Rust `Editor`; the remaining native document
metadata stays in Rust. `x-native::editor` re-exports the exact same Rust API
for a future native UI. `x-wasm` exports an independently versioned
`RustDocumentSession` wasm-bindgen class over native `.x` JSON. Web's
`rustSession.ts` calls that class; it has **no JS node tree, layout or history**.

| Operation | Transport | Owner / boundary |
| --- | --- | --- |
| Open | Native `.x` once; refuses malformed/zero/multiple pages or duplicate IDs | `x-format::load_x` → `x-editor::DocumentSession` |
| `getNode(id)`, `state()` | One node's id/name/x/y or revision + history flags | Explicit read, no document snapshot |
| `renameNode`, `moveNode`, `undo`, `redo` | One affected node's id/name/x/y, monotonic revision, canUndo/canRedo | `x-editor` command log and inverse, **not** TS undo |
| `exportX()` | Complete native `.x` only at explicit save/checkpoint | `x-format::save_x`; never called for paint or command acknowledgement |
| Close | wasm-bindgen `free()` | No global mutable session shared across files |

This slice supports only **one page** and two layer mutations (rename and
relative move). It rejects a page-root target and invalid/nonfinite moves;
no-op commands do not add history or erase redo. Name history now copies only
the edited subtree rather than an entire page. There is no hand-written
parallel undo implementation in JavaScript or extra document model in Rust.
An absent/older optional WASM module leaves the existing import bridge intact.

**Not migrated:** the current web editor uses `MemoryEngine` with a different
persisted document shape (`Page.root`) and TS Auto Layout, undo, hit testing and
rendering. The new session is deliberately **not routed into** `App.tsx` or
`MemoryEngine` while the web/native document contract is not lossless; doing so
would create two sources of truth and could drop unsupported styling/resources.
Native desktop currently has no GUI; the direct Rust-host test demonstrates the
shared API, not a shipped desktop application. Geometry `auto` keeps its
unchanged TS equivalence guard, and the SVG/FIG/Sketch import comparator is
unchanged. Next gates: lossless document conversion and round-trip, command and
layout/undo parity, persisted-format safety, then a single UI-owner swap per
proven slice, followed by removal of the TS duplicate.

### Verification

- Local `npm test`, `npm run build`, `node --check tests/wasm/real-bridges.mjs`
  and `git diff --check` pass; local Cargo/wasm-bindgen are unavailable.
- Rust session and native-host tests cover status, no-op/invalid commands,
  rename/move/undo/redo, metadata preservation, explicit `.x` round-trip,
  one-page/unique-ID limits and per-node rather than whole-page rename history.
- **CI [36338707226](https://github.com/Ankushui18/X-native/actions/runs/36338707226) SUCCESS**
  on `3db4253`: Rust formatting, clippy/workspace tests (including the direct
  native-host regression), matched WASM packages, real-module smoke, web
  tests/build and the screenshot job passed. The smoke opens a genuine native
  `.x` result from SVG, calls the generated wasm-bindgen class and TS transport
  wrapper, and logs `PASS real Rust command session: open, per-node deltas,
  move/rename, Rust undo/redo, explicit .x export, isolation and refusals`.
  The initial CI run caught the architecture-test allowlist for the new
  `x-wasm → x-editor` leaf edge; it was updated without introducing a cycle.
  Rustfmt-only test fixture differences were corrected before this green run.
- The unchanged geometry diagnostic remains **NOT APPROVED (1/30 equivalent)**.
  A passed command ABI does not promote geometry, the full web editor, native
  desktop UI or per-frame rendering parity.

## 21. Gated web-document V1 admission (opt-in; not a live editor switch)

`apps/web/src/engine/webDocumentSession.ts` translates **only** a one-page
`DocSeed`/`PersistedDoc` with its transparent `Page.root` and up to 2048 direct
solid, opaque rectangle children to native `.x` at open. Required web node keys
are frozen to V1; every other node value must match the explicitly reviewed
factory defaults. File/page metadata must have the supported shape; unsupported
pages, styles, components, variables, annotations, guides, interactions,
strokes, gradients, effects, text, layout, nested layers and unknown keys cause
the **whole file** to decline (`null`), with the existing `MemoryEngine` left
as its owner. The bridge requires the existing session ABI, and its own dialect
constant is `WEB_DOCUMENT_SESSION_VERSION = 1`.

On admission, the generated WASM class loads native `.x`, immediately exports
one checkpoint, and the adapter compares the **entire** reconstructed web file
with the input. Mismatched native defaults/precision/metadata close that Rust
session rather than losing data. The retained JavaScript shell has only
file/page/viewport metadata and a root ID — not the original node tree or a
parallel undo stack. Commands call the one Rust-owned session and return
single-node deltas; a full JSON document is read **only** at admission and an
explicit `exportDocument()` checkpoint. Export validates every native field
and refuses native features or metadata the dialect cannot represent. The FIG,
Sketch and SVG import adapters and geometry equivalence guards are unchanged.

Local `npm test` (including negative document/node/native-field cases),
`npm run build`, and `node --check tests/wasm/real-bridges.mjs` passed. The
real-generated-WASM smoke now also exercises actual web-document admission,
Rust rename/move/undo/redo, full metadata round trips and strict fallback.
**CI [36340690212](https://github.com/Ankushui18/X-native/actions/runs/36340690212)
SUCCESS** on `8252cf7`: the workspace gate, web tests/build, generated-WASM
smoke and screenshot job all passed. Native geometry remains independently
**NOT APPROVED** by the unchanged nonblocking diagnostic. Local Cargo/WASM
builds are unavailable. This **does not** migrate production rendering, layout, file store,
undo or `App.tsx` to Rust. Wider schemas and a single production document owner
remain prerequisites before retiring the TS engine.

## 22. Explicit Rust-owned web rectangle preview (not the default editor)

For a stored, V1-admissible file, open `#/file/<id>?engine=rust`. `App.tsx`
mounts `ui/RustDocumentView.tsx` **instead of**, never inside, the standard
`MemoryEngine` editor. The view opens through the existing admission/checkpoint
gate, queries Rust's node IDs and current node values once, then paints only
rectangle presentation. Rename, move and undo/redo send individual commands to
one Rust session. Each response has one optional changed node and small status
fields; no document JSON is exchanged per command/frame. There is no shadow TS
edit engine, document history, layout calculation, or Rust/TS dual-write.

The V1 **format restriction** from §21 is unchanged. The view is a deliberately
narrow interface, not a claim of canvas renderer/viewport parity: it displays
flat solid rectangles with native-returned positions/names and seed paint/size;
there are no text, groups, effects, layout, variable edits or other standard
editor tools. Nonadmitted files, WASM load failure or a mismatched Rust open
show a refusal and an explicit standard-editor link; they never switch engines
after an edit. A malformed command delta pauses editing but keeps the session
available for strict recovery export. The explicit "Prepare download" control
runs `exportDocument()` once, verifies its native→web checkpoint, and offers a
**copy** of the `.x` web document. It never writes the original browser file
store. Renaming/moving followed by "Standard editor" therefore does **not**
import those changes; the user must knowingly leave and discard them or first
download the copy. File/route changes with edits require confirmation, as does
browser unload. A same-file Rust query change does not reopen stale stored data.

Router and lifecycle safeguards: `ui/fileRoute.ts` requires the literal
`engine=rust` query; the ordinary `#/file/<id>` route is unchanged. A route
owner change synchronously closes Rust before React mounts the next editor;
opening is abortable across a pending optional-WASM load. When leaving the
standard editor, its pending autosave flushes before the Rust route reads a
fresh, mode-matched seed. No edit or history is copied between engines. Strict
Mode remounts and cross-file route changes dispose sessions and blob URLs.
The existing FIG/Sketch/SVG import equivalence gates and geometry guard are
unchanged; native geometry is still **NOT APPROVED (1/30 equivalent)**.

Verification layers: jsdom view interaction tests mount the real React view
over a fake session, assert one owner, small node deltas, Rust-owned history,
strict explicit export, disabled unsafe states and cleanup; adapter tests cover
cancellation during WASM initialization. `npm test`, TypeScript and the web
build run without generated binaries. `npm run test:wasm` now also mounts the
React view against the **real generated** `x-wasm` class in jsdom, checks a
move/undo round trip and release; it requires CI-built artifacts and is not a
browser paint test. Browser rendering parity, native desktop integration,
advanced document schemas, durable Rust-owned persistence and default-route
promotion are still **unverified** and outside this slice.

**Verification (2026-09-28):**
[CI 36342756975](https://github.com/Ankushui18/X-native/actions/runs/36342756975)
passed on `06e6a81`: Rust workspace gate, generated WASM packaging and real
bridge/React preview smoke, full web test/build and the screenshot job. The
native geometry diagnostic is nonblocking and does not change its NOT APPROVED
status. This proves the bounded generated-WASM host path, not a production
editor swap or visual browser parity.
