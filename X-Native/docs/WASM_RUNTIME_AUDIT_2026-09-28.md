# Web WASM runtime audit — 2026-09-28

## Executive answer

**The normal web editor is still TypeScript + browser Canvas2D.** Rust `x-core` is the desired shared engine, not the default browser document/paint engine today. There are **two independent, optional WASM modules**:

| Boundary | Browser entry / asset(s) | What it actually does | Admission / authority |
| --- | --- | --- | --- |
| Import + command module `x-wasm` | `wasm/x_wasm.js` **and matching** `wasm/x_wasm_bg.wasm` | Native candidate for FIG, Sketch and SVG *file imports*; optional Rust-owned `.x` rectangle command session | Import result is used only if the **whole converted import** matches the TS importer. The session is used only on the explicit `#/file/<id>?engine=rust` route after schema, ABI and whole-document round-trip checks. It is not the normal editor. |
| Geometry module `x-geo` | `x_geo.wasm` (separate raw ABI) | Candidate **union / subtract / intersect / exclude** in `booleanPath` | In default `auto`, the TS oracle also runs for each candidate. A mismatch in emptiness, contour count, relative bounding box (1e-6) or area (0.5%) returns **TS**, even when the Rust export ran. `?geo=wasm` bypasses this guard *for diagnosis*, not parity. |

`App.tsx` starts the import loader on the dashboard and schedules geometry preload in the editor (idle callback or ~2 s timeout). `__xWasmAudit.load()` can ask both loaders to finish now; `?imports=ts` / `?geo=ts` disable the respective boundary. An import candidate does **not** make vector editing, paint, effects or text processing Rust-owned. `getEngineInfo().hasWasm` describes the **import** module only; `importBackend` is **the last import**, not an editor-wide mode. A Boolean group may bake through `booleanPath`, but its *live composited paint* in `Canvas.tsx` is browser Canvas2D, not x-geo.

**Evidence levels, not interchangeable:** `scripts/build-wasm.sh` packages the optional outputs under `apps/web/public`; Vite copies them to a built site's root when they exist. CI [36345585798](https://github.com/Ankushui18/X-native/actions/runs/36345585798) generated matched binaries, ran real generated-module smoke in a Node/jsdom host, built web assets and uploaded `x-wasm`. CI **does not deploy them to your site or execute a real end-user browser**. This local checkout/preview has *no* generated binaries. Requests for `/wasm/x_wasm.js`, `/wasm/x_wasm_bg.wasm` and `/x_geo.wasm` each returned **HTTP 200 `text/html`, beginning `<!doctype html>`**: Vite's SPA fallback, **not a served WASM asset**. Thus *this preview* cannot execute those Rust modules; another deployment remains **unverified** until checked on its actual origin. No production deployment URL or browser instrumentation output was supplied.

### 30 editor-feature runtime matrix

`G` means only the four x-geo Boolean operations **may** run, when the actual command calls `booleanPath`, the module is loaded and the shape has at least two operands. `—` means **no browser-callable Rust export for that editor operation**, even if a Rust counterpart exists in the repository. **⚠️** is conditional/guarded, **❌** is not bridged for this editor operation; it does not mean the feature is missing from the web UI. Every row describes *editing/rendering after a file has been opened*, not a FIG/Sketch/SVG import. The default and guard decisions are per call, not global claims that every example on every deployment was exercised.

| # | Area / operation | UI trigger (after opening a file) | Browser WASM call? | Runtime/result in ordinary editor; TS guard | Gap |
| ---: | --- | --- | --- | --- | :---: |
| 1 | Vector: Pen path creation | Choose Pen (P), click canvas points; finish path. | — | `Canvas.tsx` draft → `memory.ts` add/patch path; TS point geometry. No WASM guard. | ❌ |
| 2 | Vector: Pencil / brush / eraser strokes | Use Pencil (⇧P) or Brush (B), draw; select Eraser and erase. | — | Canvas gestures, TS simplification/path commands and Canvas2D. No WASM guard. | ❌ |
| 3 | Vector: move/bend/add/mirror Bézier points | Edit a vector: select a point, drag/bend or use point handles. | — | `memory.ts` vector-network/point commands and `geometry.ts`; TS. No WASM guard. | ❌ |
| 4 | Boolean **union** | Select two overlapping shapes → toolbar Boolean groups → Union. | G: `xgeo_boolean` | Group/preview/bake calls `booleanPath("union", …)`; `auto` compares Rust candidate to TS; mismatch or unavailable returns TS. Live group paint remains Canvas2D. | ⚠️ |
| 5 | Boolean **subtract** | Select two overlapping shapes → Boolean groups → Subtract. | G | Same comparator; `auto` retains TS on mismatch. | ⚠️ |
| 6 | Boolean **intersect** | Select two overlapping shapes → Boolean groups → Intersect. | G | Same comparator; emptiness itself is checked. | ⚠️ |
| 7 | Boolean **exclude** | Select two overlapping shapes → Boolean groups → Exclude. | G | Same comparator; contour/topology differences have been observed in real-WASM CI. | ⚠️ |
| 8 | Shape Builder merge/subtract | Select two shapes → vector Shape Builder → drag merge or subtract. | G **conditionally** | `memory.ts` `shapeBuilder` **does call** `booleanPath` with union/subtract for two selected nodes; TS dispatch/edits; same geometry guard. | ⚠️ |
| 9 | Flatten selection | Select shapes/Boolean group → Boolean groups → Flatten selection. | G **only for Boolean children** | TS composition of text/vector/group; baking a Boolean child calls `booleanPath`. Ordinary flatten does not call Rust. | ⚠️ |
| 10 | Outline stroke | Select a stroked shape → Outline stroke (menu / ⇧⌘O). | — | `memory.ts` → TS `outlineStrokeNetwork` / `outlineVariableStroke`; text uses TS text outlining. No guard. | ❌ |
| 11 | Offset / simplify / vector cleanup | Select vector → right inspector Offset or Simplify / vector Cleanup. | — | TS `offsetPath`, `simplifyPath`, `vectorCleanup` in `memory.ts`/`geometry.ts`; no WASM guard. | ❌ |
| 12 | Stroke color / weight / opacity / visibility | Select shape → right inspector Stroke: color, width, visibility. | — | TS layer patch + `strokeModel.ts` / Canvas2D paint; no runtime Rust stroke command. | ❌ |
| 13 | Stroke inside/center/outside / per-side | Select shape → Stroke alignment or individual sides in inspector. | — | TS stroke model and Canvas2D clipping; no runtime Rust stroke command. | ❌ |
| 14 | Stroke caps / joins / miter | Select stroked line → Stroke cap / join / miter in inspector. | — | TS stroke model and Canvas2D; no runtime Rust stroke command. | ❌ |
| 15 | Stroke dashes / variable width | Select vector → Stroke dashes or variable width in inspector. | — | TS dash/profile sampling, outline and Canvas2D; no runtime Rust stroke command. | ❌ |
| 16 | Solid fill / opacity | Select shape → right inspector Fill: choose Solid / opacity. | — | TS patch + Canvas2D `paint.ts`; no runtime Rust fill command. | ❌ |
| 17 | Linear-gradient fill | Select shape → Fill picker → Linear with two color stops. | — | TS stops/interpolation + Canvas2D gradient; no runtime Rust fill command. | ❌ |
| 18 | Radial-gradient fill | Select shape → Fill picker → Radial. | — | TS + Canvas2D gradient; no runtime Rust fill command. | ❌ |
| 19 | Angular/conic-gradient fill | Select shape → Fill picker → Angular. | — | TS + Canvas2D conic gradient (browser-dependent); no runtime Rust fill command. | ❌ |
| 20 | Diamond-gradient fill | Select shape → Fill picker → Diamond. | — | TS + Canvas2D approximation; no runtime Rust fill command. | ❌ |
| 21 | Image fill / tile / fit | Select image/shape → Fill picker → Image / fit / tile. | — | TS image handling + Canvas2D; no runtime Rust image-paint command. | ❌ |
| 22 | Drop shadow | Select shape → Effects → add Drop shadow. | — | `paint.ts` / Canvas2D masks, filter and shadows; no runtime Rust effect command. | ❌ |
| 23 | Inner shadow | Select shape → Effects → add Inner shadow. | — | `paint.ts` / Canvas2D compositing; no runtime Rust effect command. | ❌ |
| 24 | Layer blur | Select shape → Effects → add Layer blur. | — | TS effect model + Canvas2D filter; no runtime Rust effect command. | ❌ |
| 25 | Background blur | Select shape → Effects → add Background blur. | — | TS effect model + Canvas2D background sampling/filter; no runtime Rust effect command. | ❌ |
| 26 | Text editing / typography / layout | Choose Text (T), type; change font, weight or spacing in inspector. | — | TS editor state/commands and browser font metrics; no runtime Rust text-edit/layout command. | ❌ |
| 27 | Live text paint / decorations | Select text, edit contents / decoration, observe canvas redraw. | — | `Canvas.tsx` Canvas2D `fillText`/`strokeText` and TS text layout; no runtime Rust renderer. | ❌ |
| 28 | Convert/outline text to vectors (also SVG export) | Select text → context menu Convert text to vector paths. | — | `textVector.ts` uses browser Canvas2D glyph pixels + TS contour tracing or JS fallback; `svgExport.ts` outlines in TS. No runtime Rust text conversion. | ❌ |
| 29 | Primitive shapes / corners / smoothing | Choose Rectangle (R) / Ellipse (O); adjust corners/smoothing. | — | TS `shapePoly`/corner/squircle math and Canvas2D tracing; no runtime Rust geometry export. | ❌ |
| 30 | General resize / transforms / hit test / layout | Drag selection resize handles, scale/move, test layout / hit selection. | — | Standard editor `memory.ts`/`geometry.ts`/Canvas; TS document commands, TS auto layout and undo. **Different limited exception:** explicit Rust rectangle-view resize below. | ❌ |

**Important import distinction:** the `x-wasm` FIG/Sketch/SVG importer can bring in *some* vectors, strokes, solids, text and effects at file-open time. This does **not** bridge those features' subsequent editor commands, paints, or live frames. `wasmImportAdapter.ts` admits supported structure and rejects unknown/unmappable fields (e.g. gradients, unsupported stroke stacks, rich native-only schema). Only a **complete TS-equivalent** import is selected; simple SVG and selected FIG/effects fixtures passed the real-module CI smoke, while other documents fall back. A ready import module does not imply a particular user's import was selected. Rich files need an observed per-import decision.

**Narrow ✅ bridged slice (not rows 1–30):** if both `x-wasm` assets actually load, `sessionBridgeVersion() === 2`, and an entire one-page document consisting of flat, opaque, solid rectangles round-trips losslessly, `#/file/<id>?engine=rust` mounts the separate `RustDocumentView`. The Rust `DocumentSession` owns rename, move, absolute resize and undo/redo; each command returns a single changed node + flags. Full `.x` transfer occurs on explicit open/save, **not per frame**. This does *not* activate Rust paint, effects, general geometry, auto layout, or the normal editor. Unsupported files refuse the opt-in view instead of silently switching ownership; the original file is never dual-written. The native desktop facade uses the same Rust session directly, not this browser WASM loader.

## Pasteable live-browser verification

Open the **real deployment** (or the local preview), use DevTools → Console, and paste this. It reloads only once, keeping the hash route; the diagnostic is intentionally **opt-in** and does not change engine modes. Check the **real URL search** `?bridgeAudit=1`, *before* `#/file/...`, not the hash query `?engine=rust`.

```js
(async () => {
  const url = new URL(location.href);
  if (url.searchParams.get("bridgeAudit") !== "1") {
    url.searchParams.set("bridgeAudit", "1");
    location.assign(url.href); // Reload once; then paste this again.
    return;
  }
  const audit = window.__xWasmAudit;
  if (!audit) throw new Error("Audit command absent: deploy this version of the web app");
  audit.trace(true); // Live [WASM audit] call AND guard/owner decisions.
  console.table(await audit.assets()); // Body/MIME checks: HTTP 200 HTML is NOT WASM.
  await audit.load(); // Wait for BOTH independent modules/handshakes.
  audit.report(); // Module/engine state, exported functions, zero + nonzero counters, guard decisions.
  console.log("Now trigger a UI operation; run __xWasmAudit.report() afterward.");
})();
```

Additional console commands (after installation):

```js
__xWasmAudit.snapshot().modules          // imports vs geometry vs session owner
__xWasmAudit.snapshot().functions        // per-export invocation counts and boundary timings
__xWasmAudit.snapshot().decisions        // per-import, per-Boolean and session admission outcomes
__xWasmAudit.snapshot().recent           // last 80 bounded, data-free call/decision events
__xWasmAudit.reset()                     // isolate the NEXT UI interaction (not a loader reset)
__xWasmAudit.trace(false)                // stop live logs
```

The command is installed only on `?bridgeAudit=1`; no continuous UI panel or per-frame document serialization is introduced. `modules.imports.instantiated` means generated bindgen JS initialized and its **import ABI handshake** succeeded; `modules.geometry.instantiated` means a binary was instantiated and its **geo ABI handshake** succeeded. The module's `availableFunctions` lists callable exports; `functions["x-geo.xgeo_boolean"].calls` counts actual **application wrapper invocations of the raw WebAssembly export**, while `x-wasm.importSvgToX` counts calls into generated bindgen glue (the glue calls Rust on success). `x-wasm.init` is the JS/WASM initializer, **not** a design operation. A failed bindgen wrapper can fail before completing a native call. **Only `decisions[...].last.result === "rust"` means that candidate was selected**, and `guard === "bypassed"` is explicitly diagnostic. Zero calls can mean an untriggered operation; absence of a module, disabled flags and guard reasons have separate fields. The `recent` buffer is bounded; the totals continue until `reset()` or reload. Audit call timings cover a boundary, **not** whole UI operation time, the TS oracle, rendering or FPS.

`assets()` distinguishes a real `x-wasm` JS MIME/body and binaries beginning `00 61 73 6d 01 00 00 00` from a 200 HTML SPA response. A plausible file alone is not proof of compilation/call: confirm the *module handshake* and counters too. `modules.geometry.source === "public URL"` in a browser confirms the production fetch path; `"test-injected"` and `"override"` in tests do not establish a deployment. `trace(true)` logs function names, coarse failure classes and guard check names only (not file contents or node IDs). Existing *non-audit* geometry warnings can print numerical comparator metrics. Use a real matched binary; a synthetic/mock test cannot prove Rust provenance.

### UI trigger and expected observation

1. **Start with a clean scope.** Load the file in a real browser with `?bridgeAudit=1` in the URL before the `#`; run the pasteable snippet; inspect `await __xWasmAudit.assets()` and `await __xWasmAudit.load()`. On this checkout, three assets are HTML, so expect unavailable modules and TS fallback; do **not** infer a Rust execution from the 200. On a configured site both instantiation flags should become `true` unless one bridge was explicitly disabled.
2. **Imports:** On the dashboard, use **Import** to select a small solid-rectangle SVG, then a representative FIG/Sketch file. Observe `x-wasm.importSvgToX` / `importFigToX` / `importSketchToX` increasing and `decisions["imports.Svg"]` etc. `last.guard: "passed"` / `last.result: "rust"` means the *whole imported result* was selected. `"blocked"` with a native call means Rust executed but TS was retained; `"not-run"` means missing/disabled/not ready. Reload between formats if a last-import indicator is ambiguous. **Do not upload private files to a diagnostic server.**
3. **Boolean paths:** In a normal file create **two overlapping rectangles** (R), select both, open toolbar **Boolean groups → Union**, then test **Subtract / Intersect / Exclude** similarly on a fresh pair. Inspect `functions["x-geo.xgeo_boolean"].calls` and `decisions["geometry.union"]`, etc. The group may be Canvas-painted without further x-geo calls; preview/baking can add extra calls. In `auto`, a `blocked` decision and TS result after a native call is expected for current real geometry. Also try vector **Shape Builder** (two selected shapes; merge/subtract) and flatten a Boolean child: they reach this same chokepoint. Flattening two ordinary vectors need not call WASM.
4. **TS-only operations:** Select Pen/Pencil, edit a path vertex; change stroke dash/cap, gradient or blur in the right inspector; edit and outline text; draw or resize a normal shape. The UI should work but the relevant Rust-export counters should **not rise because of those operations**. This absence alone does not prove which TS function executed: the table is grounded in the traced call graph. Some other side effect (e.g. modifying a Boolean child) may legitimately cause x-geo calls—reset and isolate each action.
5. **Rust-owned rectangle slice:** Make a saved *one-page blank file with direct solid opaque rectangles* and open its `#/file/<id>?engine=rust` route (put `?bridgeAudit=1` **before** `#`). If admitted, the UI explicitly says **Rust document preview**. Move right, Wider 10, Undo/Redo; see `modules.session.activeRustSessions > 0`, `decisions["session.open"].last.result === "rust"`, and `x-wasm.RustDocumentSession.{moveNode,resizeNode,undo,redo}` counts. `free` rises on leaving. If refused, inspect the classed `session.open` reason; the ordinary editor does not silently acquire a Rust owner. Saving a copy runs one explicit `exportX`, not repeated exports while dragging.
6. **Compare modes safely:** Use `?geo=ts&bridgeAudit=1` (real URL query) to see no native Boolean candidate; use default `auto` for shipped behavior. `?geo=wasm` makes native outputs visible **despite known mismatches**: use only on disposable diagnostic files; revert to `auto`/remove the override afterward. `?imports=ts` separately disables candidate imports. The localStorage key `x-native-geo` can override `auto`; query params take precedence. Do not call raw exports from the console to pretend a UI operation was bridged.

## Why guards block, what performance is known

- **Geometry:** Real generated-WASM 30-case differential at CI [36345585798](https://github.com/Ankushui18/X-native/actions/runs/36345585798) found **1/30 equivalent, 29 failed**. The one passing case is identical-subtract-empty. The failures include bbox/area, contour count and one emptiness disagreement. This is *not* a missing-export failure: the Rust Boolean function executed. The current `auto` comparator rightly keeps the TS authority. Forced `?geo=wasm` can display differing output and is not an activation strategy.
- **Import:** A successful parse/export is insufficient. `decodeRustImport` refuses unsupported/missing native fields or loss of typography/stacks, and `choose` checks the **entire** normalized TS import. TS itself must parse the file; only a complete matching Rust result is selected. Simple supported imports can pass; complex ones can fail per-file. This gate does not inspect live paint or post-import editing.
- **Document preview:** `sessionBridgeVersion` must equal **2**, the V1 web document must be losslessly representable (one page, flat opaque solid rectangles and supported metadata), and opening/exporting native `.x` must reproduce **the whole web document**. This is deliberate single-owner admission, not a TypeScript shadow-document fallback inside the Rust view.
- **Performance:** The audit CI diagnostic reports sums of per-case mean timings over 30 operations (repeat 2): **TS 50.05 ms vs native-module path 5.01 ms** on that CI runner. **29 results differ**, so these numbers are **not** a valid speedup comparison, and the shipped `auto` path also executes the TS oracle. They are neither browser wall-clock/FPS data nor production workload measurements. The console's `totalMs` is boundary time only. **A safe Rust-versus-TS user-visible performance difference is not established.** First match results in a representative real-module corpus, then benchmark equivalent results on the same deployed browser and include load/serialization/comparator/render costs (e.g. `npm run bench:wasm -- --module public/x_geo.wasm --repeat 2 --out /tmp/geo-native.json` for non-browser diagnostics). Do not use `--replay` as Rust performance evidence.

## Activation / remaining gaps

1. **Make deployment real:** with the repository's pinned Rust toolchain, `wasm32-unknown-unknown` and matching `wasm-bindgen-cli 0.2.127`, run `cd X-Native/apps/web && npm run build:wasm && npm run test:wasm && npm run build`; deploy the built app **together with** `dist/wasm/x_wasm.js`, `dist/wasm/x_wasm_bg.wasm` and `dist/x_geo.wasm` at the correct Vite base/CDN paths. Preserve JS/binary build pairing, MIME/CORS/CSP, caching and route rewrites; the optional Vite public copy is not a deployment policy. Validate on the deployed origin with the console probe, not just CI/package success.
2. **Promote geometry only after parity:** fix native/TS algorithm differences, run the strict full differential on real generated artifacts and browser UI/regression tests, then measure equivalent output and remove the TS oracle *only after* a reviewed promotion. Avoid lowering tolerances to manufacture pass status. Direct `?geo=wasm` is diagnostic only.
3. **Extend document authority incrementally:** add narrowly reviewed Rust command/state slices for the actual web schema—vectors/strokes/fills/effects/text/layout/undo—plus lossless admission and parity. Drive the normal editor through small commands + changed-state deltas from a **single Rust-owned document**, not duplicate TS history/auto-layout or whole-document JSON every frame. Expand visual/persistence/native-host E2E before changing the default route. Today the opt-in rectangle preview demonstrates the boundary but **does not complete** this migration.
4. **Make gaps observable:** retain this opt-in audit on deployed builds while broadening genuine browser integration tests. Instrument new exported call sites and document their guards; absence of a counter today is not evidence that an uninstrumented future export is impossible.

**Verification of this audit change:** local `npm test` (including `bridgeRuntimeAudit.test.mjs`: mocked bindgen/geo calls, successful/blocked guards, session counters, HTML-200 asset trap and opt-out), `npm run build`, `npx tsc -b`, `node --check tests/wasm/real-bridges.mjs` and `git diff --check` passed. **No generated WASM assets or browser executable were found in this sandbox**, so local tests do not establish browser execution here. CI [36345585798](https://github.com/Ankushui18/X-native/actions/runs/36345585798) **passed** the Rust gate, full web tests/build, generated matched WASM package, *real-artifact smoke including the new audit-counter assertions*, and screenshots. The nonblocking geometry differential still reports **NOT APPROVED (1/30)**. This establishes real-module calls from the app bridge in the CI host, **not** a shipped browser deployment or visual browser parity. The interactive local Vite preview is a TS-fallback reproduction, not a production deployment.

**Source landmarks:** `apps/web/src/engine/{geoBridge,geometry,wasmBridge,wasmImportAdapter,webDocumentSession,rustSession,bridgeRuntimeAudit,wasmAssets,memory,paint,strokeModel,textVector,modifierStack}.ts`, `apps/web/src/ui/{Canvas,RustDocumentView,chrome,inspector}.tsx`, `apps/web/src/App.tsx`, `apps/web/tests/{wasm/real-bridges.mjs,benchmarks/wasm.mjs}`, `scripts/build-wasm.sh`, `apps/web/vite.config.ts`, `.github/workflows/ci.yml` and [WASM_BRIDGES_2026-09-27.md](WASM_BRIDGES_2026-09-27.md).
