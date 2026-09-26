# TS↔Rust geometry bridge — design 2026-09-25 (perf track Task 2, reframed)

**Status: TS side implemented 2026-09-25; Rust side specified, awaiting a
Rust-capable environment.** There is no Rust toolchain in this sandbox (and
none installable), so the `x-geo` crate itself is still §6 prose — adding
unverified Rust would break `scripts/check.sh` for everyone else. The full
TypeScript surface (§5 codec, §7 loader/choke/fallback/`?geo=` flag) is
implemented and verified with mock + hand-assembled real wasm modules (see
"Implementation status" at the end). Task 2 was reframed from "profile the
bridge" to this design because no geometry bridge exists to profile (see §1).

## 1. What actually exists (corrections to the brief's premises)

- `apps/web/src/engine/wasmBridge.ts` exists but is **inert four ways**:
  (1) `initWasmBridge()` is never called, (2) no build step emits the
  `/x_wasm.wasm` it fetches, (3) it uses raw `WebAssembly.instantiate`
  while `x-wasm` is a wasm-bindgen module (ABI-incompatible: raw
  instantiation cannot pass `Uint8Array`/`String` or satisfy bindgen
  imports), (4) its only consumer is the `Engine:` label in chrome.tsx —
  the `importFig/importSketch/importSvg` wrappers are dead code.
- The Rust geometry engine already exists: `crates/x-core/src/booleans.rs`
  (~1.6k lines) with a tiered facade — `Backend::RasterGuided` (coverage
  grid + marching squares, the default), `Backend::Exact`
  (Greiner–Hormann), `Backend::BezierExact` (curve-preserving clipper).
  This task is therefore **exposure, not a port**: no new algorithm may
  be written (the boundary rule below forbids second implementations).
- `docs/ARCHITECTURE_BOUNDARY.md` governs: one authoritative production
  implementation per capability; TypeScript is authoritative today; Rust
  stays provisional until it is built, connected, and equivalence-tested.
  This design keeps TS authoritative with the wasm path as a proven
  accelerator behind a fallback — full cutover is explicitly out of scope.

## 2. Goal and non-goals

Goal: run `booleanPath` (the suite-C hotspot, 3.674ms/op) in the existing
Rust backend through a versioned binary bridge, with TS fallback, at
parity within geometric epsilon.

Non-goals: render-path changes (live booleans already paint via
offscreen compositing, never calling `booleanPath`); fixing the import
bridge (§1 lists its defects for a separate task); threads/workers;
`Exact`/`BezierExact` backends (behavior changes, need their own
equivalence tasks); removing the TS implementation.

## 3. Why `booleanPath` is the seam

Call sites (`apps/web/src/engine/`): `memory.ts` boolean-bake (creation),
shape-builder merge/subtract, export vectorization ×2, preview helper;
`geometry.ts` `defaultGeometryBoolean` (union/subtract/intersect/exclude);
`modifierStack.ts` `evaluateModifierStack`. All are synchronous,
edit/export-time bakes of 2+ operand paths — never per-frame. Input sizes
are small (2–8 operands, ≤ low-thousands of points); outputs are contour
rings. A synchronous FFI needs no signature changes anywhere.

## 4. Decisions (ADRs, condensed)

- **ADR-1 — new `crates/x-geo`, not an `x-wasm` extension.** A thin wrapper
  over `x-core::booleans` with zero new dependencies and no bindgen keeps
  the import story untouched, versions independently, and stays small.
- **ADR-2 — raw linear-memory protocol, no bindgen/serde/JSON.** A 1k-point
  operand round-trips in ~10µs binary vs ~0.5ms JSON stringify+parse —
  JSON would eat the speedup it exists to buy. Plain
  `cargo build --target wasm32-unknown-unknown`, no wasm-pack, no JS glue.
- **ADR-3 — expose `RasterGuided` only (v1).** It matches the TS approach
  (coverage grid); the exact backends change output geometry and need
  separate equivalence tasks.
- **ADR-4 — raw contours cross the boundary; shaping stays in TS.**
  `simplify`/`smoothPath`/network assembly (all O(output points), µs)
  keep running unchanged in `geometry.ts` on wasm-returned rings. The
  Rust surface is pure `boolean_paths` exposure.
- **ADR-5 — synchronous calls, no worker.** Ops are ms-scale; revisit if
  real inputs exceed ~8ms.
- **ADR-6 — TS authoritative, wasm opt-out-able.** `auto` (default) uses
  wasm when present and version-matched, else TS; `?geo=ts|wasm` plus a
  localStorage override for debugging. Any wasm failure degrades to TS
  with a `console.warn`, never a throw.

## 5. Wire format v1 (normative)

Little-endian (wasm is LE-only). All f64 fields 8-aligned; readers use
explicit offsets, never packed-struct casts. Limits: ≤16 operands,
≤100k points per operand, response ≤16MB; beyond that the TS side uses
the TS implementation without calling wasm.

### 5.1 Request (TS → wasm, caller-allocated, caller-freed)

```
offset  type   field
0       u32    magic 0x58474F31 ("XGO1")
4       u32    total_len (bytes, including this header)
8       u16    version (=1)
10      u8     op: 0=union 1=subtract 2=intersect 3=exclude
11      u8     reserved (0)
12      u32    n_operands
16      ...    operands, back to back
```

Each operand:

```
0       f64    ox
8       f64    oy
16      u32    n_points
20      u32    reserved (0)
24      ...    points, 56 bytes each: f64 x, f64 y, f64 ix, f64 iy,
               f64 ox, f64 oy, u32 flags, u32 pad.
               flags bit0 = has incoming handle, bit1 = has outgoing.
               Missing handles are 0.0 AND flag-clear (v1 ignores
               handles exactly like TS does today; flags exist so a
               curve-aware backend needs no format change).
```

### 5.2 Response (wasm-allocated, TS copies out, TS frees via `xgeo_free`)

```
0       u32    magic 0x58475231 ("XGR1")
4       u32    total_len
8       u16    version (=1)
10      u8     status: 0=ok 1=empty (degenerate, no contours) 2=error
11      u8     reserved
12      f64    bbox x, 20: y, 28: w, 36: h (meaningful iff status=0;
               TS-equivalent box: min/max over returned points)
44      u32    n_contours (iff status=0)
48      u32    reserved
52      ...    per contour: u32 n_points, u32 reserved, then n_points
               × (f64 x, f64 y) polyline vertices, world coords
```

On status=2 the contour section is replaced by: u32 msg_len,
u32 reserved, msg_len UTF-8 bytes (no NUL). Status=1 carries bbox only.

### 5.3 Module ABI (raw `extern "C"`, `#[no_mangle]`)

```rust
xgeo_version() -> u32;                          // 1
xgeo_alloc(len: u32) -> *mut u8;                // bump/growable; zeroed?
xgeo_free(ptr: *mut u8, len: u32);
xgeo_boolean(req: *const u8, req_len: u32,
             out_ptr: *mut u32, out_len: *mut u32) -> u32; // status
```

`xgeo_boolean` validates magic/version/lengths before touching anything
and returns 2 (with an error response) rather than trapping on malformed
input. TS re-acquires all `DataView`s after every call (`memory.grow`
invalidates views; v1 copies buffers out, so views are short-lived).

## 6. Rust sketch (`crates/x-geo`, ~150 lines + tests)

```rust
// lib.rs: parse §5.1, fold operands pairwise left-to-right through
// x_core::booleans::boolean_with(Backend::RasterGuided, …),
// serialize §5.2. No geometry here — that rule is the whole point.
```

Fold-order note (normative): TS combines coverage left-to-right
(`((a op b) op c)`), which matters for subtract/exclude. The wrapper
must fold pairwise in operand order, not balance the tree.

Grid note: TS uses a fixed 160-wide grid + edge-chaining; Rust uses
`MAX_CELLS=360`, ≥0.75px cells + marching squares. These must NOT be
"unified" in v1 — changing either grid alters shipped output. The
epsilon in §8 absorbs the difference; converging grids is a P4+ task.

## 7. TypeScript sketch (`wasmBridge.ts` + `geometry.ts`)

- `ensureGeo(): Promise<boolean>` — fetch `/x_geo.wasm`, instantiate,
  check `xgeo_version() === 1`; memoized; preload on app idle.
- `booleanPathsWasm(op, shapes)` — same signature/shape as `booleanPath`
  (including the `{path, x, y, w, h, network?} | null` return, with
  shaping from §4/ADR-4 applied after the call). Throws on any anomaly;
  callers never let it propagate.
- `geometry.ts booleanPath` becomes the choke point: try wasm when
  `geoMode !== "ts"` and ready, `catch → TS`. All §3 call sites inherit
  the accelerator with no edits.
- `getEngineInfo()` gains `geoBackend: "wasm" | "ts"` (display-only;
  the `Engine:` label already exists).

## 8. Equivalence (the boundary rule, made testable)

Vertex-level parity is **impossible by construction** (§6 grid note):
two grid resolutions + two contour extractors cannot agree vertex for
vertex. Equivalence is geometric, per case:

1. bbox equal within 1e-6 relative (both derive from input bounds);
2. symmetric area difference < 0.5% of union area;
3. same contour count (holes included);
4. no degenerate output (status=1) where TS returns ≥3 points, and vice
   versa — emptiness must agree exactly (this is the user-visible line:
   a shape must not vanish/appear between backends).

Corpus (new in P1, committed as fixtures): hand-picked regressors
(rect pairs at all 4 ops, star/ellipse/path operands, touching edges,
contained shapes, sub-pixel slivers, 3+ operand folds per op) plus a
seeded fuzzer (10k random pairs) run in CI. No boolean-output oracle
exists today (parity tests pin preview state, not geometry) — recording
TS outputs as fixtures is step one, before wasm exists.

FP note: both sides are IEEE-754 f64, but `hypot`/transcendentals may
differ in the last ulp across engines; grid-edge comparisons can flip on
a ulp. The area epsilon absorbs this; anything that fails by more is a
real divergence. NaN inputs are rejected at the TS choke point (never
sent) per the repo's NaN-ordering invariant.

## 9. Build, ship, gates

- Build: `cargo build -p x-geo --target wasm32-unknown-unknown --release`,
  copy to `apps/web/public/x_geo.wasm` (served by dev, preview, and
  production builds). Script: `scripts/build-geo.sh`, invoked by
  `npm run build:wasm` and CI. Optional `wasm-opt -Oz` size pass in CI
  only (binaryen is not vendored).
- Size budget: ≤300KB uncompressed, enforced in CI. Risk: `x-core`'s
  dependency graph may bloat the module; mitigation ladder is
  `crate-type` pruning → feature-gating `x-core` → (last resort) moving
  the boolean backend into `x-geo`. Do not "fix" bloat by hand-rolling
  geometry in `x-geo`.
- `scripts/check.sh` covers the new crate automatically (workspace fmt,
  clippy with zero live warnings, dead-code ceiling, NaN scan,
  `cargo test --workspace --locked`). New code must add no clippy
  warnings and no dead-code entries.
- CI addition (sketch): install `wasm32-unknown-unknown` target →
  build geo → run `cargo test -p x-geo` → boot `vite preview`, run the
  node differential suite against the built `.wasm` → assert §8 + §10.

## 10. Performance targets

Baseline (suite C, Node/V8): 3.674ms/op on the 1k-boolean corpus.
Target: **≤1.2ms/op (≥3×) on the same corpus** in-Chromium, measured by
a `bench:wasm` differential runner (both backends, same inputs, JSON
report beside the FPS results). Secondary: p95 frame time of b-live
must not regress (booleans bake on edit; a slower bake would show
there). If wasm ever loses on small inputs (FFI overhead vs 8-point
operands), add a size floor that routes tiny ops to TS — measure first.

## 11. Risks

| risk | likelihood | mitigation |
|------|------------|------------|
| x-core dep bloats module past budget | medium | §9 ladder; budget enforced, not wished |
| Grid/ulp divergence fails §8 on fuzz | medium | epsilon tuned on corpus; exact-empty rule is non-negotiable |
| `memory.grow` races / leaks | low | copy-out + explicit free; balance test in Rust + soak in CI |
| Version skew (stale cached .wasm) | low | handshake + fallback; content-hash the filename if caching bites |
| Safari / old Chromium wasm gaps | low | wasm MVP only, no SIMD/threads/atomics (assert in CI via `wasm-objdump` feature scan) |
| Import-bridge confusion (two modules) | low | this doc names it; unifying module strategy is a separate task |

## 12. Work plan (needs a Rust-capable env; nothing below runs here)

- **P0 scaffold** — `x-geo` crate + `xgeo_version`/alloc/free round-trip
  + TS loader + `?geo=` flag. Accept: check.sh green, version handshake
  true, engine label shows backend.
- **P1 corpus** — TS fixtures recorded + epsilon comparator + (Rust-side)
  wrapper with fold semantics. Accept: fixtures pass on TS backend;
  comparator tested with known-divergent pairs.
- **P2 integration** — choke point in `geometry.ts`, fallback paths,
  balance/soak tests. Accept: 1112 unit tests green in both `ts` and
  `wasm` modes; e2e unchanged.
- **P3 measurement** — `bench:wasm` runner, size budget in CI, wasm-opt
  evaluation. Accept: §10 primary target met or size-floor rule added
  with data.
- **P4 fuzz + ship** — 10k seeded pairs in CI, `auto` default on.
  Accept: zero §8 violations; FPS b-live unregressed; boundary doc
  updated to name wasm the boolean accelerator (TS still authoritative).

## Appendix A — call-site inventory (§3 detail)

`memory.ts`: `case "boolean"` bake (~2277), export vectorize (~2727,
~2816), shapeBuilder (~2950), preview helper (~3686). `geometry.ts`:
`defaultGeometryBoolean` union/subtract/intersect/exclude (~273–294).
`modifierStack.ts`: `evaluateModifierStack` re-export. All flow through
`booleanPath(op, {poly, ox, oy}[])` — the single choke point.

## Appendix B — rejected alternatives

- **Extend `x-wasm` with bindgen geometry calls**: couples geometry to
  the bindgen/pinning story and to a module whose TS side is already
  ABI-broken; rejected per ADR-1 (unifying later is allowed, not required).
- **JSON over the boundary (import-style envelope)**: ~50× the per-call
  overhead (§4/ADR-2); fine for file imports, fatal for a 3.6ms budget.
- **Port TS→Rust line by line**: forbidden by the boundary rule while
  `x-core::booleans` exists; the job is exposure + equivalence, not a
  third implementation.
- **Move simplify/smooth to Rust**: negligible cost, real risk (output
  shaping must stay in one language); revisit only with profiler data.

## Implementation status (2026-09-25, `track=ts`)

TS side landed; Rust side untouched (no toolchain here).

- `apps/web/src/engine/geoBridge.ts` (new) — §5.1/§5.2 codec, `GeoModule`
  interface, `ensureGeo` loader with version handshake, `tryGeoBoolean`,
  `getGeoMode` (`?geo=` > `x-native-geo` > `auto`), `preloadGeo`, and
  `__setGeoModuleForTests`/`__resetGeoForTests` seams. One deliberate
  deviation from §7: it lives in its own module rather than
  `wasmBridge.ts`, because that module imports the file importers (which
  import `geometry.ts`) — geometry calling into it would be an import
  cycle. Function names and semantics match the spec.
- `apps/web/src/engine/geometry.ts` — `booleanPath` is now the choke
  (wasm when ready, TS authority otherwise; only status-0 contour sets
  accepted, everything else defers); the former body is `booleanPathTs`
  (unchanged behavior, still exported); contour shaping extracted
  verbatim into exported `shapeBooleanResult`, shared by both backends.
  Zero call-site edits (all five `memory.ts`/`modifierStack.ts` sites
  inherit the choke).
- `apps/web/src/App.tsx` — `preloadGeo()` on editor mount (idle,
  silent when absent).
- P1 (TS side) landed with the implementation: `__tests__/geobridgeCorpus.ts`
  (30 differential cases: 4-op rect pairs, offsets, disjoint/contained/
  touching, star/ellipse/curved/sliver/L/tri operands, 3–4-operand folds,
  emptiness, far/negative/large coords), `recordGeobridgeFixtures.mjs`
  (`npm run record:geofixtures`) + committed `geobridge.fixtures.json`
  (full shapes + TS outputs, self-contained for the future Rust-side CI
  job), `compareBooleanResults` in `geoBridge.ts` (§8: exact emptiness,
  loop counts, 1e-6 bbox, 0.5% symmetric area), and 41 tests (comparator
  units incl. known-divergent pairs + per-fixture reproduction). Fuzzing
  stays Rust-gated: it needs the real module. `bench:wasm`
  (`tests/benchmarks/wasm.mjs`, P3-TS) landed with it: replays all 30
  fixtures through the live choke + mock module (request bytes asserted
  against §5.1 per case), compares with the §8 oracle, times both sides
  over `--repeat` runs, exits non-zero on divergence. `--module` runs the
  true differential against real bytes, treating any wasm decline as a
  failure. Replay expectation is re-shaped-once (shaping is not idempotent
  for degenerate 2-point rings); negative control verified (mutated
  fixtures fail with precise reasons, exit 1).
- `apps/web/src/engine/__tests__/geobridge.test.mjs` (new, in `npm
  test`) — 92 checks: exact §5.1 byte layout incl. all four op codes and
  handle flags, limit breaches, §5.2 decode incl. status-1/2 and
  truncation/magic/version errors, mode-flag precedence, loader against
  hand-assembled **real** WebAssembly (version handshake accept/reject,
  garbage rejection, and a full §5 round trip through a real linear
  memory via a bump-allocator + stub module), choke fallback on trap /
  wasm-empty / wasm-error, `?geo=ts` bypass with a loaded module, and TS
  authority sanity. Suite total: 1112 → 1204, all green.
