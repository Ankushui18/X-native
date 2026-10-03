# Comprehensive Micro-Parity Audit — Batch 3

Date: 2026-09-27. Branch: `arena/01a0e1ff-x-native`.
Scope: the four authorized Batch 3 items only. Batch 1 and Batch 2 changes remain intact. Unassigned issue #6 (multi-selection movement/constraints) remains outside this batch.

Paths are relative to `X-Native/`; `src/...` abbreviates `apps/web/src/...`.
Before references identify the code inspected at the end of Batch 2; current references identify the finished working tree.

## Findings → changes → regression evidence

| Item | Exact pre-Batch-3 evidence | Fix and current source references | Verification |
| --- | --- | --- | --- |
| **Variable-width restrictions** | `src/ui/inspector.tsx:6309-6312` hid the editor for branching networks, rather than showing disabled controls. `src/engine/strokeModel.ts:209-215` rejected branching networks but not dashes. | Shared explanation/restriction in `src/engine/strokeModel.ts:208-221`. Visible editor at `src/ui/inspector.tsx:6314-6316`; disabled fieldset, explanatory text, disabled Reset and explicit SVG event guards at `:7644-7787`. Greyed presentation at `src/styles.css:5337-5339`. Stored profiles are retained and become usable again when the restriction is removed. | `src/ui/__tests__/batch3.dom.test.mjs:83-104`: branching Y network, legacy dash, nonempty pattern (including zero-valued pattern), guarded pointer/Reset, and re-enabling. Chromium clicked both branching and dashed controls and confirmed unchanged profiles, visible explanations and computed opacity **0.4**. |
| **Scale K versus Move V bounding-box resize** | Both resize dispatches already used `scaleProps: snap.tool === "scale"` at `src/ui/Canvas.tsx:4907` and `:5046`. However, combined-selection handle hit testing at `:4010` accepted only Move. | Combined-selection handles now accept Scale at `src/ui/Canvas.tsx:4041`; Scale maintains proportional dimensions at `:4929`. Existing single/multiple dispatch flags remain at `:4945` and `:5084`. Instance-member restrictions are retained. | `src/ui/__tests__/batch3.dom.test.mjs:130-149`: actual single/multiple Canvas drags, multiple pointer moves, dimensions, non-compounding stroke scaling, dispatch flags and one-step undo. Chromium used physical **K/V** keys: a **100×100, stroke 10** rectangle became **200×200, stroke 20** under K and **200×200, stroke 10** under V. |
| **Exclusive Max Lines / Max Height, including clearing** | Inspector Max Lines at `src/ui/inspector.tsx:3834-3842` forced at least one line; Max H at `:4381-4383` already cleared lines. `src/engine/layout.ts:1028-1033` explicitly allowed both positive limits and cleared height to numeric zero, which `src/engine/memory.ts:542` could clamp as a real zero-height limit. | `src/engine/layout.ts:1028-1035` normalizes finite positive limits, detects explicit clearing, and resolves simultaneous positive limits in favor of height. `src/engine/memory.ts:2510` applies it before patch filtering/override recording, including conversion to text. Inspector accepts zero and invalid-input clearing at `src/ui/inspector.tsx:3833-3844`, `:4382-4387`, `:8030-8039`; full reciprocal patch reaches hug measurement at `:3498`. Cleared lines mean unlimited rather than implicitly one in `src/ui/textLayout.ts:112`, `src/ui/Canvas.tsx:7607-7612`, and `src/engine/svgExport.ts:426-427`. | `src/ui/__tests__/batch3.dom.test.mjs:105-129`: mounted reciprocal controls; zero, negative, empty, malformed and nonfinite inputs; direct API patches; simultaneous positive limits; unrelated patches; unlimited cleared-line measurement. Chromium typed into the actual controls and verified both directions, invalid Max Lines and zero Max Height. |
| **Multi-point bounding-box resize** | `src/ui/Canvas.tsx:3161-3287` drew anchors/tangents without a selected-point resize box; `:4326-4398` hit-tested anchors/tangents; `:5070-5157` only moved points. `src/engine/geometry.ts:768-794` normalized through the legacy path, potentially discarding branches. | New `src/ui/pointBox.ts:8-73` maps path selection indices to graph vertices, computes padded page-axis handles, and transforms selected vertices/tangents from the immutable drag-start network. Canvas draws the box at `src/ui/Canvas.tsx:3285-3301`, starts its separate gesture at `:4028-4039`, updates at `:5113-5118`, and ends the transaction at `:5525`. Ordinary anchor movement remains separate; absent tangents no longer steal anchor presses at `:4367-4375`. `src/engine/types.ts:1072` and `src/engine/memory.ts:3510-3525` preserve the edit frame while dragging. `src/engine/geometry.ts:768-802` normalizes the complete graph on edit exit, retaining branches/regions and compensating rotation/flip centers. | `src/ui/__tests__/batch3.dom.test.mjs:150-225`: actual four-point gestures; Shift, Alt, both, and Command-not-Option; repeated pointer moves; reordered graph indices; unselected vertex/tangent/branch/region retention; undo/redo; exit normalization; all eight handles; immutable source; transformed ancestors; degenerate bounds; ordinary Shift point movement; mounted rotated/flipped drags at zoom 0.5/2; lock guard. Chromium entered vector editing, Shift-clicked four anchors and dragged the visible box with Shift, Alt and both. |

## Important implementation choices

- **Option is `altKey`, not `metaKey`.** Command alone does not center-scale points. Shift holds proportions; Alt uses the selection center; both combine.
- **The model requires numeric `maxLines`.** Clearing stores `maxLines: 0` and `maxH: undefined`. Explicit positive height wins a patch containing both positive limits. Non-text min/max behavior is unchanged.
- **No duplicate scale handler was added.** Single-layer scaling already dispatched the correct flag. Multi-selection Scale could not reach its existing handler; that gate was fixed and both routes were tested. Plain K/V drags dispatch `ignoreConstraints: false`; the existing Cmd/Ctrl constraint-override modifier on layer resize was not removed.
- **Point-box handles sit 10 screen pixels outside the selected anchors.** This leaves anchor movement accessible; only pointer deltas, not the padding, enter the resize math. The box is page-axis aligned. Zero-size axes remain finite; crossing a pivot clamps rather than introduces reflection.
- **Graph preservation required more than `patchPath`.** The legacy editable path can represent only one walk through a branching graph. The new gesture retains the original graph, updates selected mapped vertices and attached tangents, and keeps the rotation/flip frame stable until normalization. Normalization now considers all graph edges and isolated vertices instead of rebuilding the network from one path.
- Existing legacy assertions that required simultaneous positive text limits or `maxH: 0` conflicted with the requested rule. They were updated, not removed, at `src/engine/__tests__/parity.test.mjs:2870-2876` and `:3054-3061`. Test count did not decrease.

## Verification results

| Gate | Result |
| --- | --- |
| `npx tsc -b` | **PASS**, no diagnostics |
| `npm run test` | **2,661 passed, 0 failed** across 41 suites |
| Previous completed baseline | **2,530**; retained, plus **131** new Batch 3 checks |
| Focused mounted/geometry suite | `npx vite-node src/ui/__tests__/batch3.dom.test.mjs`: **131 passed, 0 failed** |
| Targeted Chromium QA | **8 workflow checks passed; no page errors** |
| `git diff --check` | **PASS** |

The new suite is registered in `apps/web/package.json:11`.
Execution logs: `/home/user/batch3-tests.log`, `/home/user/batch3-tsc.log`, `/home/user/batch3-focused.log`, `/home/user/batch3-browser.log`.
Chromium exercised the real Vite module graph, mounted Canvas/Inspector, physical keyboard/mouse events and computed browser styles on deterministic documents. This is targeted automated browser QA, not human visual approval or the full existing E2E suite. The existing geobridge suite emits its invalid-WASM fallback diagnostic while its checks pass.

## Batch 3 files changed

- `apps/web/src/engine/{geometry,layout,memory,strokeModel,svgExport,types}.ts`
- `apps/web/src/ui/{Canvas,inspector}.tsx`
- `apps/web/src/ui/textLayout.ts`
- `apps/web/src/ui/pointBox.ts` — new
- `apps/web/src/styles.css`
- `apps/web/src/engine/__tests__/parity.test.mjs` — conflicting text-limit expectations updated
- `apps/web/src/ui/__tests__/batch3.dom.test.mjs` — new
- `apps/web/package.json` — test registration
- This audit report

Other uncommitted files belong to the earlier completed batches; they were preserved.

## Verification boundaries

This completes the **four authorized Batch 3 items**, not absolute whole-product Figma parity. The earlier native Vello stroke-alignment gap and typography/shaping limitations remain. Native rendering, a comprehensive import/export typography comparison, and unassigned multi-selection movement/constraint issue #6 were not verified or fixed in this batch. The web SVG change only removes the incorrect implicit one-line limit when Max Lines is cleared; it is not a full SVG text-layout rewrite.
