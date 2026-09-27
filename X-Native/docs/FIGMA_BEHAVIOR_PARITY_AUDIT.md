# X-Native — Figma behavior parity re-audit

**2026-09-27 · branch `arena/01a0e1ff-x-native` · base `c3afa0dfcde95e29e8067c349b021cd0f583ce6e`**

## Executive summary — IN PROGRESS, not exhaustive parity

This is the current evidence ledger. It supersedes the historical counts/claims archived below.
Five narrowly scoped production defects were reproduced and fixed. **2,737 assertions across 42 unit/DOM suites pass; TypeScript and production build pass.** A new Chromium harness passes **12 targeted assertions**. Its optional diagnostics separately reproduce **two OPEN defects**, including branched-vector geometry loss. Those diagnostic reproductions are NOT counted as passing parity checks.

**Do not release or cite this as “100% parity.”** The full behavior runner, complete popup/subcontrol interaction matrix, and native verification are not all green. A complete all-combinations audit has not been achieved. Existing visual identity, semantic colors, architecture, and prior batches are preserved.

| Counting scope | P0 found / fixed | P1 found / fixed | P2 found / fixed |
|---|---:|---:|---:|
| Newly reproduced production defects R01–R07 | 1 / 0 | 6 / 5 | 0 / 0 |
| Carry-forward source/documentation gaps R08–R10 | 0 / 0 | 3 / 0 | 0 / 0 |
| Build/performance warning R11 | 0 / 0 | 0 / 0 | 1 / 0 |
| **Current ledger total (not historical totals)** | **1 / 0** | **9 / 5** | **1 / 0** |

- Feature families inventoried/source-indexed: **48/48 in this working catalogue**. This is not a proven exhaustive count of every subcontrol or popup instance.
- Families with complete behavior/UI/interaction/all-edge-case signoff: **0/48**. Partial tests are recorded, not promoted to full matches.
- Current fixes: **5 findings**, touching movement, rotation, resize hit zones, text measurement, and ancestor/descendant target normalization; some belong to the same broad transform family.
- Recorded out-of-scope capability groups: **8**, listed below. Missing new features were not implemented.
- Remaining confirmed newly reproduced defects: **2**; carry-forward gaps: **3**; bundle warning: **1**. Untriaged browser assertions are not automatically additional production bugs.

## Methodology and architecture

1. Inspected the actual checkout, public command/model contracts, UI handlers, geometry, layout, painter/export, persistence, regression suites, and Rust entry points. `App.tsx` instantiates `MemoryEngine`; Canvas/inspector dispatch commands, the engine lays out/publishes snapshots, Canvas paints, and files persist the document. Optional WASM geometry/text bridges exist: the older “no Rust connection” claim is not reliable.
2. Inventoried 48 feature families and all **145 distinct public Command discriminants**; appendix gives exact model lines. A command's existence does not prove it is surfaced, correctly rendered, persisted, undoable, or Figma-equivalent.
3. Read the current Figma Design category hierarchy (all four chunks), then the official articles in the reference manifest. Not all linked articles or every subordinate page have been read. No live Figma client comparison was available.
4. Added mounted-Canvas regression tests, red→green evidence, and actual Chromium mouse/keyboard/font checks. The browser harness mounts the real Canvas + MemoryEngine in a controlled viewport; it is not full shell/native validation.
5. Ran unit/DOM, TypeScript, production build, full browser runner, and an explicit Rust command. Each result below is kept separate.

Web source: `apps/web/src/{engine,ui}`; native sources: `crates/x-core`, `x-render`, `x-ui`, `x-designer` and other workspace members. The repository's HTML entry point mounts the current React application; no HTML prototype was used as the design source of truth. Historical docs/prototype references were not deleted on speculation. No engine or Auto Layout rewrite, theme redesign, or replacement UI was performed.

**Severity:** P0 = destructive/data loss; P1 = significant interaction/model/render mismatch; P2 = lower-risk polish/performance concern. A suspected source path is marked a candidate rather than counted as a reproduced defect.

**Evidence terminology:** “Partial” is not “Match.” Everywhere not individually demonstrated below is **NOT VERIFIED — requires runtime/manual verification.** This includes combinations of lock/visibility, nesting, rotation/flips, mixed selection, platform chords, reload, and undo/redo. Unit coverage alone does not satisfy browser behavior parity.

## Figma reference scope

Entry hierarchy: <https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design>.
Sections considered: interface/file utilities; create/edit/work with layers; vectors/Draw; text; paints/images/properties; Auto Layout; styles/components/variables/libraries; prototypes; import/export; applicable comments. The following articles were read in full, including their returned tail chunks. The manifest is bounded, not every link in the hierarchy.

- **D01 — Frames:** <https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design>
- **D02 — Selection:** <https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects>
- **D03 — Transforms:** <https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions>
- **D04 — Zoom:** <https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options>
- **D05 — Guides:** <https://help.figma.com/hc/en-us/articles/360040449713-Add-guides-to-the-canvas-or-frames>
- **D06 — Fill picker:** <https://help.figma.com/hc/en-us/articles/360041003774-Update-fills-using-the-color-picker>
- **D07 — Strokes:** <https://help.figma.com/hc/en-us/articles/360049283914-Apply-and-adjust-stroke-properties>
- **D08 — Effects:** <https://help.figma.com/hc/en-us/articles/360041488473-Apply-effects-to-layers>
- **D09 — Crop:** <https://help.figma.com/hc/en-us/articles/360040675194-Crop-an-image>
- **D10 — Vector editing:** <https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers>
- **D11 — Auto Layout:** <https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout>
- **D12 — Styles:** <https://help.figma.com/hc/en-us/articles/360039238753-Styles-in-Figma-Design>
- **D13 — Main components:** <https://help.figma.com/hc/en-us/articles/360038665934-Edit-main-components>
- **D14 — Library updates:** <https://help.figma.com/hc/en-us/articles/360039234193-Review-and-accept-library-updates>
- **D15 — Variables:** <https://help.figma.com/hc/en-us/articles/15343107263511-Apply-variables-to-designs>
- **D16 — Text resizing:** <https://help.figma.com/hc/en-us/articles/27378154668951-Adjust-text-dimensions-and-resizing>
- **D17 — Toolbar:** <https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar>
- **D18 — Import:** <https://help.figma.com/hc/en-us/articles/360040027794-Guide-to-imports-in-Figma-Design>
- **D19 — Text outlines:** <https://help.figma.com/hc/en-us/articles/360047239073-Convert-text-to-vector-paths>
- **D20 — Prototype actions:** <https://help.figma.com/hc/en-us/articles/360040035874-Prototype-actions>
- **D21 — Comments:** <https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments>
- **D22 — Export:** <https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings-for-static-designs>
- **D23 — Text properties:** <https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties>
- **D24 — Text styles:** <https://help.figma.com/hc/en-us/articles/360039957034-Create-and-apply-text-styles>
- **D25 — Create components:** <https://help.figma.com/hc/en-us/articles/360038663154-Create-components-to-reuse-in-designs>
- **D26 — Arc handles:** <https://help.figma.com/hc/en-us/articles/360040450173-Arc-tool-create-arcs-semi-circles-and-rings>
- **D27 — Constraints:** <https://help.figma.com/hc/en-us/articles/360039957734-Apply-constraints-to-define-how-layers-resize>
- **D28 — Layout guides:** <https://help.figma.com/hc/en-us/articles/360040450513-Create-layout-guides>
- **D29 — Networks:** <https://help.figma.com/hc/en-us/articles/360040450213-Vector-networks>
- **D30 — Actions:** <https://help.figma.com/hc/en-us/articles/23570416033943-Use-the-actions-menu-in-Figma-Design>
- **D31 — Organization fonts (scope only):** <https://help.figma.com/hc/en-us/articles/360039956774-Upload-custom-fonts-to-an-organization>

Reference cautions: Figma now calls layout grids **layout guides**, distinct from Auto Layout grid. Current Auto Layout docs include vertical wrap. Small caps is a distinct font treatment, not ordinary uppercase. A fetched page with an incorrect guessed slug was recorded by its canonical returned title, not its guessed title; the 404 for article 360040449193 is not evidence. Organization font administration was read only to define scope.

## Feature-by-feature inventory and matrix

“UI match” means contextual availability/feedback, **not** copying Figma's appearance. References resolve to the manifest above. All rows have partial or unverified signoff; none asserts exhaustive parity.

| Feature | X-Native Exists | Figma Reference | Behavior Match | UI Match | Interaction Match | Issues | Severity | Status |
|---|---|---|---|---|---|---|---|---|
| F01 Frames / presets | Yes, scope below | D01 | Partial / unverified | Partial / unverified | Partial / unverified | R07: rotated fit fails; ordinary frame tests are not rotated-fit proof. | P1 | Open audit |
| F02 Sections / slices | Yes, scope below | D01 | Partial / unverified | Partial / unverified | Partial / unverified | Section uses ordinary frame representation; semantic comparison remains open. | Unclassified | Open audit |
| F03 Shape tools | Yes, scope below | D26 | Partial / unverified | Partial / unverified | Partial / unverified | Tool availability is not a complete parametric-handle audit. | Unclassified | Open audit |
| F04 Type-aware selection | Yes, scope below | D02 | Partial / unverified | Partial / unverified | Partial / unverified | Prior Batch 1 plus current real Canvas tests; combinations partial. | Unclassified | Open audit |
| F05 Multi-selection / move | Yes, scope below | D02 | Partial / unverified | Partial / unverified | Partial / unverified | R01 fixed; R06 ancestor+child double-move/nudge is also fixed. | P1 | Open audit |
| F06 Resize / Scale | Yes, scope below | D03 | Partial / unverified | Partial / unverified | Partial / unverified | R03 fixed; prior Batch 3 tests. Deep ancestry still requires browser proof. | P1 | Open audit |
| F07 Rotation / origin | Yes, scope below | D03 | Partial / unverified | Partial / unverified | Partial / unverified | R02 fixed; numeric sign convention R08 remains. | P1 | Open audit |
| F08 Align / distribute / tidy | Yes, scope below | D03 | Partial / unverified | Partial / unverified | Partial / unverified | Existing tests do not prove every mixed/rotated hierarchy combination. | Unclassified | Open audit |
| F09 Constraints | Yes, scope below | D27 | Partial / unverified | Partial / unverified | Partial / unverified | Dedicated tests; translated worldPos consumers require further review. | Unclassified | Open audit |
| F10 Zoom / pan / hand / minimap | Yes, scope below | D04 | Partial / unverified | Partial / unverified | Partial / unverified | Current targeted tests exercise offset view and zoom; inertia/manual feel unverified. | Unclassified | Open audit |
| F11 Rulers / manual guides | Yes, scope below | D05 | Partial / unverified | Partial / unverified | Partial / unverified | Guides suite; every zoom/nested/rotated combination unverified. | Unclassified | Open audit |
| F12 Layout guides / pixel snapping | Yes, scope below | D28 | Partial / unverified | Partial / unverified | Partial / unverified | Layout guides are distinct from Auto Layout grid; source + existing tests only for many combinations. | Unclassified | Open audit |
| F13 Solid / stacked fills | Yes, scope below | D06 | Partial / unverified | Partial / unverified | Partial / unverified | Existing render/DOM tests; every nested picker lifecycle unverified. | Unclassified | Open audit |
| F14 Gradients | Yes, scope below | D06 | Partial / unverified | Partial / unverified | Partial / unverified | Interpolation/export/rotated nested equivalence not exhaustively verified. | Unclassified | Open audit |
| F15 Images / crop | Yes, scope below | D09 | Partial / unverified | Partial / unverified | Partial / unverified | Non-destructive model and crop helper tests; manual/aspect combinations partial. | Unclassified | Open audit |
| F16 Strokes | Yes, scope below | D07 | Partial / unverified | Partial / unverified | Partial / unverified | Batch 3 restrictions tested. Native alignment R09 is not cleared by web tests. | P1 | Open audit |
| F17 Shadows / blur / effects | Yes, scope below | D08 | Partial / unverified | Partial / unverified | Partial / unverified | Painter already counter-rotates ordinary/masked drop-shadow offsets; no blanket missing-shadow claim. | Unclassified | Open audit |
| F18 Noise / glass / texture | Yes, scope below | D08 | Partial / unverified | Partial / unverified | Partial / unverified | These already exist; NOT classified as missing new features. Full optical fidelity unverified. | Unclassified | Open audit |
| F19 Text entry / font controls | Yes, scope below | D23 | Partial / unverified | Partial / unverified | Partial / unverified | R04 measurement fix; glyph shaping and browser font fallback are not fully verified. | P1 | Open audit |
| F20 Text sizing / paragraph layout | Yes, scope below | D16 | Partial / unverified | Partial / unverified | Partial / unverified | R04 fixed font/case/list measurements; SVG divergence R10 remains. | P1 | Open audit |
| F21 Type settings / overflow | Yes, scope below | D23 | Partial / unverified | Partial / unverified | Partial / unverified | Batch 2/3 tests; rich ranges/model fields alone do not prove editing support. | Unclassified | Open audit |
| F22 Text to vectors | Yes, scope below | D19 | Partial / unverified | Partial / unverified | Partial / unverified | Prior glyphOutline tests; no general complex-script shaping certification. | Unclassified | Open audit |
| F23 Pen / pencil / brush / eraser | Yes, scope below | D10 | Partial / unverified | Partial / unverified | Partial / unverified | Tool modes exist; detailed manual gesture review still required. | Unclassified | Open audit |
| F24 Vector points / networks | Yes, scope below | D29 | Partial / unverified | Partial / unverified | Partial / unverified | R05 reproduced branch loss through legacy patchPath. Batch 3 box resize preservation does not fix ordinary edits. | P0 | Open audit |
| F25 Booleans / flatten / outline stroke | Yes, scope below | D10 | Partial / unverified | Partial / unverified | Partial / unverified | Engine coverage exists; all masks/regions/curves and native fallbacks unverified. | Unclassified | Open audit |
| F26 Vector offset / simplify / cleanup | Yes, scope below | D10 | Partial / unverified | Partial / unverified | Partial / unverified | Legacy path-to-network rewrites require branch-safety audit; do not infer from ordinary-path tests. | Unclassified | Open audit |
| F27 Layers / hierarchy | Yes, scope below | D02 | Partial / unverified | Partial / unverified | Partial / unverified | Browser suite plus isolated rename 33/0; mixed ancestor transforms remain open. | Unclassified | Open audit |
| F28 Group / frame / masks | Yes, scope below | D01 | Partial / unverified | Partial / unverified | Partial / unverified | Grouping/masking tests; general nested transform correctness not signed off. | Unclassified | Open audit |
| F29 Pages / local documents | Yes, scope below | D18 | Partial / unverified | Partial / unverified | Partial / unverified | Local persistence; cloud version history not inferred. | Unclassified | Open audit |
| F30 Components / instances | Yes, scope below | D13 | Partial / unverified | Partial / unverified | Partial / unverified | Local components supported; cross-file review/publish is OUT OF SCOPE. | Unclassified | Open audit |
| F31 Variants / component properties | Yes, scope below | D25 | Partial / unverified | Partial / unverified | Partial / unverified | Existing component tests; exhaustive nested override conflicts unverified. | Unclassified | Open audit |
| F32 Shared local styles / assets | Yes, scope below | D12 | Partial / unverified | Partial / unverified | Partial / unverified | Browser checks cover paint style propagation/reload; all style category combinations unverified. | Unclassified | Open audit |
| F33 Variables / collections / modes | Yes, scope below | D15 | Partial / unverified | Partial / unverified | Partial / unverified | Existing variables and DOM tests; every property lifecycle not signed off. | Unclassified | Open audit |
| F34 Auto Layout / sizing | Yes, scope below | D11 | Partial / unverified | Partial / unverified | Partial / unverified | Dedicated layout tests; present docs include vertical wrap, not obsolete horizontal-only assumptions. | Unclassified | Open audit |
| F35 Auto Layout wrap / grid / absolute | Yes, scope below | D11 | Partial / unverified | Partial / unverified | Partial / unverified | Batch 3 and layout tests; all deep combinations still require runtime/manual verification. | Unclassified | Open audit |
| F36 Contextual inspector / mixed fields | Yes, scope below | D03 | Partial / unverified | Partial / unverified | Partial / unverified | No universal no-phantom-control signoff; accepted values must be traced to render/export individually. | Unclassified | Open audit |
| F37 Toolbar / context menu / Actions | Yes, scope below | D30 | Partial / unverified | Partial / unverified | Partial / unverified | Actions intentionally caps unfiltered commands at 20; old E2E searches for absent off-list commands. | Unclassified | Open audit |
| F38 Dialogs / popovers / focus | Yes, scope below | D17 | Partial / unverified | Partial / unverified | Partial / unverified | See popup inventory and browser failures. Unit passes do not certify modal integration. | Unclassified | Open audit |
| F39 Prototyping / interactions | Yes, scope below | D20 | Partial / unverified | Partial / unverified | Partial / unverified | Existing action model; exact history/cancellation behavior across combinations partial. | Unclassified | Open audit |
| F40 Prototype player | Yes, scope below | D20 | Partial / unverified | Partial / unverified | Partial / unverified | Full E2E exercises ordinary player controls; all trigger/device matrices unverified. | Unclassified | Open audit |
| F41 Imports / clipboard | Yes, scope below | D18 | Partial / unverified | Partial / unverified | Partial / unverified | Supported subset only; Sketch/media breadth not implied by import menu. | Unclassified | Open audit |
| F42 Exports / presets / bulk sheet | Yes, scope below | D22 | Partial / unverified | Partial / unverified | Partial / unverified | R10 text export mismatch; browser PDF writer is raster-backed, not native vector writer. | P1 | Open audit |
| F43 Undo / redo / transactions | Yes, scope below | D03 | Partial / unverified | Partial / unverified | Partial / unverified | Current tests prove move/rotation undo/redo; no claim of every major category × every edge case. | Unclassified | Open audit |
| F44 Keyboard / find / preferences | Yes, scope below | D30 | Partial / unverified | Partial / unverified | Partial / unverified | E2E modal/keyboard failures must be triaged; platform-specific chords only partially covered. | Unclassified | Open audit |
| F45 Cursors / labels / overlays | Yes, scope below | D01 | Partial / unverified | Partial / unverified | Partial / unverified | Batch 1 labels + R03; viewport-change-during-drag manual cases unverified. | P1 | Open audit |
| F46 Comments / annotations | Yes, scope below | D21 | Partial / unverified | Partial / unverified | Partial / unverified | Local comments exist. Multiplayer permissions/notifications/undo semantics not fully verified. | Unclassified | Open audit |
| F47 Dev inspection / code / Agent | Yes, scope below | D17 | Partial / unverified | Partial / unverified | Partial / unverified | X-Native-specific behavior; no claim of Figma Agent/Dev Mode product equivalence. | Unclassified | Open audit |
| F48 Performance / native / WASM | Yes, scope below | D04 | Partial / unverified | Partial / unverified | Partial / unverified | R11 bundle warning; native runtime NOT VERIFIED; benchmark results below. | Unclassified | Open audit |

### Implementation and subcontrol trace index

Each entry names the current entry point and the exposed feature surface. Cross-cutting model, painter, persistence and test dependencies must still be checked for every individual control; this index does not assert that all such traces are complete.

- **F01 Frames / presets:** `apps/web/src/ui/Canvas.tsx:296` — Create, presets, clip, frame selection, resize-to-fit. R07: rotated fit fails; ordinary frame tests are not rotated-fit proof.
- **F02 Sections / slices:** `apps/web/src/engine/memory.ts:2952` — Section wrapping, slice crop/export. Section uses ordinary frame representation; semantic comparison remains open.
- **F03 Shape tools:** `apps/web/src/ui/chrome.tsx:1052` — Rectangle, ellipse/arc, line/arrow, polygon/star, corner radii/smoothing. Tool availability is not a complete parametric-handle audit.
- **F04 Type-aware selection:** `apps/web/src/ui/canvasSelection.ts:6` — Parent-first, drill/deep select, locks, instances. Prior Batch 1 plus current real Canvas tests; combinations partial.
- **F05 Multi-selection / move:** `apps/web/src/ui/Canvas.tsx:4589` — Shift, marquee, ordinary selected-member drag, nudge. R01 fixed; R06 ancestor+child double-move/nudge is also fixed.
- **F06 Resize / Scale:** `apps/web/src/ui/Canvas.tsx:4474` — Single/multiple, K vs V, Shift, Alt, constraints. R03 fixed; prior Batch 3 tests. Deep ancestry still requires browser proof.
- **F07 Rotation / origin:** `apps/web/src/ui/canvasSelection.ts:44` — Outside corners, frame affordance, origin, Shift snap. R02 fixed; numeric sign convention R08 remains.
- **F08 Align / distribute / tidy:** `apps/web/src/engine/memory.ts:4359` — Edge/center alignment, distribution, tidy spacing. Existing tests do not prove every mixed/rotated hierarchy combination.
- **F09 Constraints:** `apps/web/src/engine/memory.ts:5084` — Pin, center, scale, ignore modifier. Dedicated tests; translated worldPos consumers require further review.
- **F10 Zoom / pan / hand / minimap:** `apps/web/src/ui/Canvas.tsx:296` — Wheel, Space, fit/selection, zoom tool, minimap. Current targeted tests exercise offset view and zoom; inertia/manual feel unverified.
- **F11 Rulers / manual guides:** `apps/web/src/ui/Guides.tsx:25` — Create, drag, frame-bound, duplicate, delete. Guides suite; every zoom/nested/rotated combination unverified.
- **F12 Layout guides / pixel snapping:** `apps/web/src/ui/inspector.tsx:7348` — Grid/rows/columns, counts, margins, offsets, visibility, snap. Layout guides are distinct from Auto Layout grid; source + existing tests only for many combinations.
- **F13 Solid / stacked fills:** `apps/web/src/ui/FillPicker.tsx:73` — Color models, alpha, reorder, mixed state, export visibility. Existing render/DOM tests; every nested picker lifecycle unverified.
- **F14 Gradients:** `apps/web/src/ui/FillPicker.tsx:779` — Linear/radial/angular/diamond, stops and on-canvas handles. Interpolation/export/rotated nested equivalence not exhaustively verified.
- **F15 Images / crop:** `apps/web/src/ui/cropModel.ts:62` — Fit/fill/tile/crop, exposure, rotation, adjustments. Non-destructive model and crop helper tests; manual/aspect combinations partial.
- **F16 Strokes:** `apps/web/src/engine/strokeModel.ts:9` — Stack, width/align, individual sides, join/cap, dashes, profiles. Batch 3 restrictions tested. Native alignment R09 is not cleared by web tests.
- **F17 Shadows / blur / effects:** `apps/web/src/ui/inspector.tsx:6795` — Stack/reorder, visibility, blend, limits, shadows, layer/background blur. Painter already counter-rotates ordinary/masked drop-shadow offsets; no blanket missing-shadow claim.
- **F18 Noise / glass / texture:** `apps/web/src/ui/inspector.tsx:6629` — Type-specific controls and previews. These already exist; NOT classified as missing new features. Full optical fidelity unverified.
- **F19 Text entry / font controls:** `apps/web/src/ui/inspector.tsx:3074` — Font family/weight/style/size, editing, local font permission. R04 measurement fix; glyph shaping and browser font fallback are not fully verified.
- **F20 Text sizing / paragraph layout:** `apps/web/src/ui/textLayout.ts:108` — Hug/fixed, wrap, line/paragraph spacing, indent, list, case. R04 fixed font/case/list measurements; SVG divergence R10 remains.
- **F21 Type settings / overflow:** `apps/web/src/ui/textLayout.ts:103` — Truncation, Max Lines, vertical/horizontal alignment, decoration. Batch 2/3 tests; rich ranges/model fields alone do not prove editing support.
- **F22 Text to vectors:** `apps/web/src/engine/textVector.ts:4` — Flatten / outline geometry, mixed glyphs, failure behavior. Prior glyphOutline tests; no general complex-script shaping certification.
- **F23 Pen / pencil / brush / eraser:** `apps/web/src/ui/Canvas.tsx:296` — Path creation, freehand, point entry, segment interactions. Tool modes exist; detailed manual gesture review still required.
- **F24 Vector points / networks:** `apps/web/src/ui/pointBox.ts:22` — Selected-point box, tangent/mirror, branches, regions, delete/heal. R05 reproduced branch loss through legacy patchPath. Batch 3 box resize preservation does not fix ordinary edits.
- **F25 Booleans / flatten / outline stroke:** `apps/web/src/engine/geometry.ts:35` — Union/subtract/intersect/exclude, flatten, outline, winding. Engine coverage exists; all masks/regions/curves and native fallbacks unverified.
- **F26 Vector offset / simplify / cleanup:** `apps/web/src/engine/memory.ts:3867` — Offset, simplify, align points, shape builder, cleanup. Legacy path-to-network rewrites require branch-safety audit; do not infer from ordinary-path tests.
- **F27 Layers / hierarchy:** `apps/web/src/ui/chrome.tsx:334` — Rename, visibility/lock, tree selection, drag/reparent/reorder, search. Browser suite plus isolated rename 33/0; mixed ancestor transforms remain open.
- **F28 Group / frame / masks:** `apps/web/src/engine/memory.ts:2961` — Wrap, ungroup, clipping and masks. Grouping/masking tests; general nested transform correctness not signed off.
- **F29 Pages / local documents:** `apps/web/src/engine/files.ts:18` — Add/rename/delete/duplicate/reorder pages, local save/reload. Local persistence; cloud version history not inferred.
- **F30 Components / instances:** `apps/web/src/engine/memory.ts:3274` — Create/place, overrides, detach/reset/swap, propagation. Local components supported; cross-file review/publish is OUT OF SCOPE.
- **F31 Variants / component properties:** `apps/web/src/engine/memory.ts:3946` — Variants, text/boolean/swap properties, instance controls. Existing component tests; exhaustive nested override conflicts unverified.
- **F32 Shared local styles / assets:** `apps/web/src/ui/chrome.tsx:2921` — Paint/text/effect/layout styles, apply/edit/detach, asset search. Browser checks cover paint style propagation/reload; all style category combinations unverified.
- **F33 Variables / collections / modes:** `apps/web/src/ui/chrome.tsx:3295` — Color/number/string/boolean, aliases, bind/unbind, modes, mixed. Existing variables and DOM tests; every property lifecycle not signed off.
- **F34 Auto Layout / sizing:** `apps/web/src/engine/layout.ts:26` — Horizontal/vertical, gap/padding/alignment, Fixed/Hug/Fill, min/max. Dedicated layout tests; present docs include vertical wrap, not obsolete horizontal-only assumptions.
- **F35 Auto Layout wrap / grid / absolute:** `apps/web/src/ui/inspector.tsx:7348` — Wrap gaps, grid tracks/spans, absolute children, reorder. Batch 3 and layout tests; all deep combinations still require runtime/manual verification.
- **F36 Contextual inspector / mixed fields:** `apps/web/src/ui/inspector.tsx:153` — Visibility/disabled/mixed state, expression entry, keyboard/scrub. No universal no-phantom-control signoff; accepted values must be traced to render/export individually.
- **F37 Toolbar / context menu / Actions:** `apps/web/src/ui/chrome.tsx:1423` — Context tools, command search, recents, menu keys. Actions intentionally caps unfiltered commands at 20; old E2E searches for absent off-list commands.
- **F38 Dialogs / popovers / focus:** `apps/web/src/ui/escape.ts:266` — Open/close, outside click, Escape cascade, focus restore/trap. See popup inventory and browser failures. Unit passes do not certify modal integration.
- **F39 Prototyping / interactions:** `apps/web/src/ui/inspector.tsx:771` — Triggers, destinations, variables/modes, conditions, links, overlays. Existing action model; exact history/cancellation behavior across combinations partial.
- **F40 Prototype player:** `apps/web/src/ui/PresentationPlayer.tsx:61` — Navigation, back/restart, device/orientation/scale, hotspots, live input. Full E2E exercises ordinary player controls; all trigger/device matrices unverified.
- **F41 Imports / clipboard:** `apps/web/src/engine/figImport.ts:59` — Supported .fig/SVG/image/JSON and clipboard paths, diagnostics. Supported subset only; Sketch/media breadth not implied by import menu.
- **F42 Exports / presets / bulk sheet:** `apps/web/src/ui/inspector.tsx:261` — PNG/JPG/SVG/PDF, scale/w/h/suffix, format settings, preview. R10 text export mismatch; browser PDF writer is raster-backed, not native vector writer.
- **F43 Undo / redo / transactions:** `apps/web/src/engine/memory.ts:2671` — Gesture grouping, property edits, structural edits, redo invalidation. Current tests prove move/rotation undo/redo; no claim of every major category × every edge case.
- **F44 Keyboard / find / preferences:** `apps/web/src/ui/chrome.tsx:1808` — Focus guards, shortcuts, find/replace, nudge, help, menus. E2E modal/keyboard failures must be triaged; platform-specific chords only partially covered.
- **F45 Cursors / labels / overlays:** `apps/web/src/ui/canvasSelection.ts:6` — Handle/cursor agreement, selected/hover labels, distances, pixel preview. Batch 1 labels + R03; viewport-change-during-drag manual cases unverified.
- **F46 Comments / annotations:** `apps/web/src/ui/Comments.tsx:25` — Pins, drag, reply/resolve/delete, editor annotations. Local comments exist. Multiplayer permissions/notifications/undo semantics not fully verified.
- **F47 Dev inspection / code / Agent:** `apps/web/src/ui/inspector.tsx:1852` — Code targets/tokens, mappings/annotations, local Agent commands. X-Native-specific behavior; no claim of Figma Agent/Dev Mode product equivalence.
- **F48 Performance / native / WASM:** `apps/web/src/engine/geoBridge.ts:21` — Load fixtures, bridge fallbacks, Rust scene/UI components. R11 bundle warning; native runtime NOT VERIFIED; benchmark results below.

## Interaction discrepancies / dedicated priority investigations

| Interaction | Expected Behavior | X-Native Behavior | Difference | Severity |
|---|---|---|---|---|
| Press an already-selected object, drag | Preserve set; move all eligible members | Previously replaced selection; now preserves it | R01 FIXED; Shift removal/unselected replacement retained | P1 |
| Begin multi-rotation on offset canvas | No angle jump; local pointer and center use same space | Previously mixed client/local coordinates | R02 FIXED at gesture start | P1 |
| Corner cursor and press | Resize cursor starts resize; outside ring rotates | Rotation overlapped resize's inner 8px zone | R03 FIXED for single and multi selection | P1 |
| Text hug/wrap/list metrics | Measure transformed case and actual font | Measurement omitted italic/small caps/case | R04 FIXED using painter's font shorthand | P1 |
| Move a point on a branched graph | Retain other vertices/segments/regions | Legacy patchPath replaces network with path projection: 4→3 vertices, 3→2 edges | R05 OPEN, reproduced through browser engine command | P0 |
| Nudge selected ancestor and descendant | Descendant travels once in world space | Previously +10 moved child +20; now +10 | R06 FIXED, shared target normalization for move/nudge | P1 |
| Resize frame to fit a 90° child | Fit transformed child bounds | 100×20 instead of 20×100 | R07 OPEN, reproduced | P1 |
| Numeric rotation convention | Documented Figma counterclockwise-positive convention | Existing X canvas convention differs | R08 OPEN; old deviation, no migration attempted | P1 |
| Native inside/outside stroke | Honor chosen alignment | Native scene stroke call needs alignment-specific geometry/clip review | R09 source carry-forward; runtime NOT VERIFIED | P1 |
| Export wrapped/structured text | Preserve rendered layout | SVG export does not share full canvas shaping/layout; web PDF raster-backed | R10 OPEN; full export comparison NOT VERIFIED | P1 |
| Heavy-document responsiveness | Interactive work within an agreed budget | Build warns about large JS chunk; headless timings below | R11 warning, not proof of a rendering regression | P2 |

### Frame handles: event path and bounds of proof

Selection resolves through `canvasSelection.ts` → Canvas selection chrome/handles → hover cursor/hit test → mouse-down gesture → engine resize/patch → repaint/history. Existing frame-specific detached rotation affordance is intentional X-Native chrome, **not** an unexplained resize handle at the center. Figma documents outside-corner rotation; this visual/interaction difference must not be called identical. Batch 1 tests document the existing affordance.

This pass fixes the client/local multi-rotation mismatch and disjoint corner hit zones. Tests cover zoom 0.5/1/2, offset canvas, pan, stationary rotation, Shift 15°, mouse drag, transaction undo/redo, and cursor/command agreement. Deeply nested rotated frames, viewport changes mid-gesture, and every Auto Layout/locked/instance combination are **NOT VERIFIED — requires runtime/manual verification**. In particular, translation-only `worldPos` consumers must not be assumed equivalent to `worldMatrix`/`worldToLocal`/`localToWorld`.

### Nested labels

Batch 1 introduced contextual frame-label rules; ordinary nested layer names are not supposed to be painted indiscriminately. Existing tests remain in the suite. This pass does not certify every selected/hovered ancestor/descendant combination, overlap at low zoom, or label movement during viewport changes. No additional label production change was made.

### Phantom controls

No blanket “all inspector controls are wired” claim is made. Existing Batch 2/3 controls and restrictions remain. Example: branching/dashed variable-width profiles have visible disabled explanations, not silently active controls. For a newly discovered unsupported property, the acceptance rule remains **model + command + painter + persistence + undo/redo**, otherwise hide/disable with an explanation. Model-only `textRuns` does not prove rich-text UI support; a dropdown option does not prove accurate rendering/export. Effects including glass/noise/texture are already implemented and must be audited, not incorrectly classified as missing features.

### Popup catalogue (family-level, not complete instance signoff)

For every row the acceptance checklist is: contextual opening, preview vs commit, anchor after pan/zoom/resize, keyboard navigation, Escape closes only the top layer, outside click, focus trap where modal, restore focus, mixed/disabled state, persistence, and undo/redo where mutating. **No row has universal signoff.** Native select/datalist/file pickers need separate browser/platform checks.

| Popup family / controls | Implementation | Evidence and remaining work |
|---|---|---|
| File/Edit/View/Arrange/context menus, layer target submenu | `ui/ContextMenu.tsx`, `ui/chrome.tsx` | Existing menu tests; full runner has unresolved nested Escape assertions |
| Tool and boolean flyouts | `Toolbar`, `ui/chrome.tsx:1052` | Keyboard hooks exist; current legacy selectors need review |
| Actions / quick open / recents / filters | `ui/chrome.tsx:1423` | Default command cap 20 at :1660; tests must search before clicking a nonvisible result |
| Help and keyboard-shortcuts sheet | `HelpBtn`, `Shortcuts.tsx` | Layered Escape/focus tested but full runner failures not dismissed |
| Nudge preferences | `NudgeDialog`, `XDialog` | Shared trap; failed palette launch can invalidate downstream assertions |
| Rename, confirm/delete, create-style, dialogs queue | `DialogHost.tsx`, `dialogs.ts`, `XDialog` | Isolated rename section 33/0; validation/cancel behavior retained |
| Fill/color picker; color model; blend; opacity | `FillPicker.tsx:73`, `ColorPicker.tsx` | Actual paints and mixed state need individual control traces |
| Gradient-stop editor and paint type menu | `FillPicker.tsx:779` | Hover/drag/keyboard/undo matrix incomplete |
| Image placement, adjustment and crop chrome | `Canvas.tsx`, `cropModel.ts` | Model tests; nested image/viewport combinations incomplete |
| Font family/weight/datalist/local-font permission | `inspector.tsx:3558` | Browser-dependent availability/fallback not certified |
| Type settings, truncation, Max Lines, lists | `Design`, `inspector.tsx:3074` | Prior batches tested; all popup focus chains incomplete |
| Advanced strokes / cap / join / dash / width profile | `inspector.tsx:7644` and stroke rows | Prior restrictions tested; nested popover dismissal not universally verified |
| Effects type / blend / parameters | `Effects`, `EffectPopover`, :6629/:6795 | XPopover handles dismissal; source alone is not integration proof |
| Layout guide and Auto Layout grid settings | `GridPanel`, :7348 | Track/constraint state combinations incomplete |
| Property variable binding picker | `VariablePickerPopover`, :8861 | Type filtering/mixed binding source; all keyboard paths incomplete |
| Variables collections/modes/aliases and local styles | `VarsPane`, `VarRow`, `dialogs` | Unit and browser subset; cross-file publishing absent |
| Component/variant/property/swap menus | `Design`, `AssetsPane` | Nested override/mixed behavior incomplete |
| Vector context/actions/simplify/offset forms | `Canvas`, `inspector` | R05 graph preservation is a blocker |
| Prototype interaction popover/connection chip | `Prototype`, `Canvas` | Reopen/cancel/condition and history combinations incomplete |
| Device/orientation/scale/player menus | `PresentationPlayer.tsx` | Main player browser checks; all device matrices incomplete |
| Export presets / format settings / scale | `ExportBlock`, `ExportSettings`, :8351/:8224 | Format capabilities tested; all nested focus paths incomplete |
| Bulk export modal | `ExportAssetsDialog`, :261 | Real export checks exist; palette integration assertions need triage |
| Dev code-language/scope, mapping editor, annotations | `DevLangMenu`, `CodeMappingEditor`, :2240/:3025 | Product-specific surfaces; accessibility lifecycle incomplete |
| Comments draft/thread | `Comments.tsx` | Browser pin/reply/drag/reload subset; permissions/undo semantics incomplete |
| File import/inspect and new-file native pickers | `App.tsx`, `FigInspectorModal.tsx` | Supported input paths only; OS picker/failure combinations incomplete |

Shared primitives: `x-ui.tsx:425` XPopover, `:569` XDialog; `escape.ts:104` registration, `:125` top-close, `:217` hook, `:266` focus trap. Presence of reusable primitives is not proof that every caller registers and dismisses correctly.

## Findings, root causes, fixes, files and tests

### R01 — Selected-member click collapsed multi-selection (P1, FIXED)

Canvas ordinary-click selection branch recreated a single-id array. Preserve the current set when the hit is already selected; retain Shift toggle and unselected replacement.

**Source:** `apps/web/src/ui/Canvas.tsx:4589`. **Tests:** `src/ui/__tests__/parityReaudit.dom.test.mjs` (76/0 collectively), `e2e/parity-audit.mjs` (12/0 collectively).

### R02 — Multi-rotation initial angle used mismatched spaces (P1, FIXED)

The start pointer was client-space while the selection center was canvas-local. Subtract the canvas rect before atan2; later moves already use the local frame.

**Source:** `apps/web/src/ui/Canvas.tsx:4063`. **Tests:** `src/ui/__tests__/parityReaudit.dom.test.mjs` (76/0 collectively), `e2e/parity-audit.mjs` (12/0 collectively).

### R03 — Resize and rotation zones overlapped (P1, FIXED)

Both could accept the same corner press although the cursor promised resize. Exclude the inner radius <8px from rotation in single and multi hit paths.

**Source:** `apps/web/src/ui/canvasSelection.ts:44`. **Tests:** `src/ui/__tests__/parityReaudit.dom.test.mjs` (76/0 collectively), `e2e/parity-audit.mjs` (12/0 collectively).

### R04 — Text measurement and painter disagreed (P1, FIXED)

Share canvasTextFont across painter, text metrics and list gutter; apply text case before measuring/wrapping. This does not add shaping or export-layout support.

**Source:** `apps/web/src/ui/textLayout.ts:52`. **Tests:** `src/ui/__tests__/parityReaudit.dom.test.mjs` (76/0 collectively), `e2e/parity-audit.mjs` (12/0 collectively).

### R05 — Legacy point-edit path loses branches (P0, OPEN)

Canvas ordinary point drag dispatches patchPath; engine rebuilds vectorNetwork from a single walk. Diagnostic confirms unrelated geometry loss. Safe repair must preserve graph identity/edges/regions and handle delete/heal/mirror/bend/cleanup callers, not replace the whole graph with a path again. No speculative graph rewrite in this batch.

**Source:** `apps/web/src/engine/memory.ts:3497`. **Verification:** Browser engine diagnostic reproduced; not a passing regression and not fixed.

### R06 — Ancestor and selected descendant double-move/nudge (P1, FIXED)

The engine looped every selected id, changing each local position. A child already carried by its selected ancestor received another delta. `transformRoots` now retains only top-level selected targets, deduplicates IDs, and preserves input order. Both move and nudge use it; existing effective-lock/instance guards remain in the handlers. This does not claim to fix arbitrary screen/local transform conversion or all layout reorder semantics.

**Source:** `apps/web/src/engine/memory.ts:2219,2233,5253–5262`. **Tests:** `parityReaudit.dom.test.mjs:134–169`: nested targets in both selection orders; move/nudge; unrelated peers; size/selection retention; undo/redo; lock guard; duplicate IDs; Auto Layout ancestor carries child without reordering. Red **63/9**, then green **72/0**, then **76/0** with four Auto Layout assertions. Browser targeted harness now **12/0**, including real ancestor/child drag, undo and engine nudge.

### R07 — Resize-to-fit uses unrotated child rectangles (P1, OPEN)

x/y/w/h extents ignore child transforms. Repair must include transformed bounds and preserve children under parent rotation/flip/constraints, rather than patching only the 90° example.

**Source:** `apps/web/src/engine/memory.ts:2971`. **Verification:** Browser engine diagnostic reproduced; not a passing regression and not fixed.

### R08 — Rotation sign convention differs (P1, OPEN / carry-forward)

Historical convention mismatch remains. Changing persisted rotations or labels without conversion and import/export tests is unsafe.

**Source:** `apps/web/src/ui/Canvas.tsx:156`. **Verification:** Source/build evidence only; runtime/manual comparison remains open.

### R09 — Native stroke alignment (P1, OPEN / carry-forward)

Native scene path stroke passes width/style but needs inside/outside geometry/clip parity. Web tests do not validate Rust/Vello. Toolchain unavailable.

**Source:** `crates/x-render/src/scene.rs:311`. **Verification:** Source/build evidence only; runtime/manual comparison remains open.

### R10 — Typography differs across canvas and export (P1, OPEN / carry-forward)

Canvas layout, engine metrics, SVG text, glyph outlines and native text use different paths. Prior Max Lines fix is not a full text-layout/export equivalence fix. Web PDF intentionally embeds raster artwork.

**Source:** `apps/web/src/engine/pdf.ts:2`. **Verification:** Source/build evidence only; runtime/manual comparison remains open.

### R11 — Large production JavaScript chunk (P2, OPEN warning)

Vite reports 1,077.36 kB (325.90 kB gzip), over its 500 kB warning threshold. No agreed performance budget or Figma/client baseline; do not call this a proven FPS defect.

**Source:** `apps/web/package.json` / production build log. **Verification:** Source/build evidence only; runtime/manual comparison remains open.


Additional **unconfirmed** candidates, not included in found/fixed counts: consumers of translation-only worldPos under rotated ancestors; Section semantics versus ordinary transparent frames; full text shadow/effect orientation; rich text and native font shaping; all import/export property roundtrips. Ordinary and masked shape shadows already counter-rotate their offsets at `engine/paint.ts:691–695,756–760`; do not “fix” a claimed missing behavior without a narrower reproduction.

## Verification results and limitations

| Gate | Current evidence |
|---|---|
| Existing + added unit/DOM tests | **PASS: 2,737 / 0**, 42 suites; previous completed baseline 2,661 / 0 in 41 suites |
| Focused new mounted Canvas suite | **PASS: 76 / 0**; initial interaction 17/21 → 38/0; typography 41/9 → 50/0; hierarchy 63/9 → 72/0, then four Auto Layout checks |
| TypeScript `npx tsc -b` | **PASS**, exit 0, no errors |
| Production `npm run build` | **PASS**, exit 0; Vite chunk warning retained |
| Targeted Chromium `e2e/parity-audit.mjs` | **PASS: 12 / 0**; actual mouse/keyboard and browser font metrics; no page errors |
| Optional diagnostics in that harness | **2 OPEN defects reproduced**, not part of the 12 passing assertions |
| Isolated existing rename/dialog §31 | **PASS: 33 / 0**; does not clear other dialogs |
| First full behavior run | **FAILED/ABORTED** after 24 FAIL lines and missing-dialog null dereference; ran during source edits |
| Second full behavior attempt | **FAILED/ABORTED: 348 passed, 23 failed**, then unpaired Puppeteer mouseup in final radial section |
| Final full behavior run, corrected harness + final production | **FAILED: 363 passed / 16 failed, exit 1; no page errors**; completed all sections, see addendum |
| Rust `cargo check --workspace` | **UNAVAILABLE**, attempted, exit 127: cargo not found; rustc also absent |
| Native GUI/rendering | **NOT VERIFIED — requires runtime/manual verification** |

Logs: `/home/user/parity-{unit,tsc,build,rust}.log`; first browser `/home/user/parity-e2e.log`; second run `/home/user/parity-e2e-final.log`; final run `/home/user/parity-e2e-complete.log`; targeted `/home/user/parity-targeted.{log,json}`. Logs are workspace evidence, not large committed artifacts. Browser: provisioned Chromium `/tmp/chromium`, library path `/tmp/al2023/lib`, headless software-rendering launch flags. No live Figma app or native executable was exercised.

### Performance

The checked-in targeted browser harness supports `AUDIT_PERF=1` with 1/100/500 rectangles, depth-40 nesting, ten Auto Layout parents/100 children, 100 image fills, and 500 32-point vectors. It measures 60 pan samples per fixture, each dispatch followed by **two animation frames**. This is a dispatch-to-two-frame latency smoke test, **not FPS, GPU render duration, memory-leak analysis, or pointer-to-photon latency**. No threshold is invented. Results and environment caveats belong in the final addendum. Interactive drag/layout, large image decode, repeated mount/unmount memory growth, fonts and native workloads still require profiling.

## OUT OF SCOPE — NEW FEATURE

These eight absent capability groups were not implemented: (1) cloud cross-file library publishing/review/accept; (2) multiplayer presence/remote cursors/permission services; (3) third-party plugin/widget runtime; (4) video/audio/animated media editing; (5) cloud branching/version-history/review; (6) organization/team font administration; (7) a full variable-font axis editing surface; (8) Figma's remote AI agent and asset-search product. Local Agent, local assets/components/styles, comments, existing font controls, and all shipped effects remain **in scope**. Native existing features also remain in scope even though unavailable to run.

## Public command inventory (model, not behavior signoff)

All 145 current discriminants below were enumerated from `apps/web/src/engine/types.ts`; line numbers are exact for this working tree. Mapping each to UI → dispatch → render → persistence → undo/redo → browser evidence is **not yet complete**. This prevents silent omission from the next audit pass.

| Command | Model line | Behavioral signoff |
|---|---:|---|
| `select` | 940 | Partial / NOT VERIFIED |
| `setTool` | 941 | Partial / NOT VERIFIED |
| `setZoom` | 942 | Partial / NOT VERIFIED |
| `pan` | 943 | Partial / NOT VERIFIED |
| `setPan` | 944 | Partial / NOT VERIFIED |
| `setRightTab` | 945 | Partial / NOT VERIFIED |
| `toggleRulers` | 946 | Partial / NOT VERIFIED |
| `setPixelPreview` | 947 | Partial / NOT VERIFIED |
| `toggleLayoutGuides` | 948 | Partial / NOT VERIFIED |
| `togglePropertyLabels` | 949 | Partial / NOT VERIFIED |
| `toggleMinimap` | 950 | Partial / NOT VERIFIED |
| `toggleFlows` | 951 | Partial / NOT VERIFIED |
| `toggleComments` | 952 | Partial / NOT VERIFIED |
| `addComment` | 953 | Partial / NOT VERIFIED |
| `replyComment` | 954 | Partial / NOT VERIFIED |
| `resolveComment` | 955 | Partial / NOT VERIFIED |
| `deleteComment` | 956 | Partial / NOT VERIFIED |
| `moveComment` | 957 | Partial / NOT VERIFIED |
| `openComment` | 958 | Partial / NOT VERIFIED |
| `setPage` | 959 | Partial / NOT VERIFIED |
| `setFileName` | 960 | Partial / NOT VERIFIED |
| `addPage` | 961 | Partial / NOT VERIFIED |
| `add` | 963 | Partial / NOT VERIFIED |
| `move` | 972 | Partial / NOT VERIFIED |
| `resize` | 973 | Partial / NOT VERIFIED |
| `reparent` | 975 | Partial / NOT VERIFIED |
| `reorder` | 994 | Partial / NOT VERIFIED |
| `delete` | 995 | Partial / NOT VERIFIED |
| `duplicate` | 996 | Partial / NOT VERIFIED |
| `undo` | 997 | Partial / NOT VERIFIED |
| `redo` | 998 | Partial / NOT VERIFIED |
| `patch` | 999 | Partial / NOT VERIFIED |
| `autoLayout` | 1000 | Partial / NOT VERIFIED |
| `wrapAutoLayout` | 1005 | Partial / NOT VERIFIED |
| `removeAllLayout` | 1007 | Partial / NOT VERIFIED |
| `nudge` | 1008 | Partial / NOT VERIFIED |
| `begin` | 1009 | Partial / NOT VERIFIED |
| `end` | 1010 | Partial / NOT VERIFIED |
| `cut` | 1011 | Partial / NOT VERIFIED |
| `copy` | 1012 | Partial / NOT VERIFIED |
| `paste` | 1013 | Partial / NOT VERIFIED |
| `loadClip` | 1018 | Partial / NOT VERIFIED |
| `group` | 1019 | Partial / NOT VERIFIED |
| `ungroup` | 1020 | Partial / NOT VERIFIED |
| `frameSelection` | 1021 | Partial / NOT VERIFIED |
| `resizeToFit` | 1022 | Partial / NOT VERIFIED |
| `wrapSection` | 1023 | Partial / NOT VERIFIED |
| `arrange` | 1024 | Partial / NOT VERIFIED |
| `selectAll` | 1025 | Partial / NOT VERIFIED |
| `lockSel` | 1026 | Partial / NOT VERIFIED |
| `hideSel` | 1027 | Partial / NOT VERIFIED |
| `copyCode` | 1028 | Partial / NOT VERIFIED |
| `copyProperties` | 1029 | Partial / NOT VERIFIED |
| `pasteProperties` | 1030 | Partial / NOT VERIFIED |
| `deleteInteraction` | 1031 | Partial / NOT VERIFIED |
| `flip` | 1032 | Partial / NOT VERIFIED |
| `duplicatePage` | 1033 | Partial / NOT VERIFIED |
| `deletePage` | 1034 | Partial / NOT VERIFIED |
| `renamePage` | 1035 | Partial / NOT VERIFIED |
| `movePage` | 1036 | Partial / NOT VERIFIED |
| `patchPage` | 1037 | Partial / NOT VERIFIED |
| `distribute` | 1038 | Partial / NOT VERIFIED |
| `tidyUp` | 1039 | Partial / NOT VERIFIED |
| `swapFillStroke` | 1040 | Partial / NOT VERIFIED |
| `toggleStroke` | 1041 | Partial / NOT VERIFIED |
| `removeStroke` | 1043 | Partial / NOT VERIFIED |
| `removeFill` | 1044 | Partial / NOT VERIFIED |
| `toggleOutlines` | 1045 | Partial / NOT VERIFIED |
| `toggleMaskOutlines` | 1046 | Partial / NOT VERIFIED |
| `boolean` | 1047 | Partial / NOT VERIFIED |
| `setBooleanPreview` | 1049 | Partial / NOT VERIFIED |
| `createStyle` | 1052 | Partial / NOT VERIFIED |
| `applyStyle` | 1054 | Partial / NOT VERIFIED |
| `detachStyle` | 1056 | Partial / NOT VERIFIED |
| `editStyle` | 1058 | Partial / NOT VERIFIED |
| `deleteStyle` | 1059 | Partial / NOT VERIFIED |
| `addGuide` | 1060 | Partial / NOT VERIFIED |
| `moveGuide` | 1061 | Partial / NOT VERIFIED |
| `setGuideFrame` | 1062 | Partial / NOT VERIFIED |
| `selectGuide` | 1063 | Partial / NOT VERIFIED |
| `previewStroke` | 1064 | Partial / NOT VERIFIED |
| `previewEffect` | 1065 | Partial / NOT VERIFIED |
| `removeGuide` | 1066 | Partial / NOT VERIFIED |
| `makeComponent` | 1067 | Partial / NOT VERIFIED |
| `detachInstance` | 1068 | Partial / NOT VERIFIED |
| `placeComponent` | 1069 | Partial / NOT VERIFIED |
| `addPath` | 1070 | Partial / NOT VERIFIED |
| `patchPath` | 1071 | Partial / NOT VERIFIED |
| `patchVectorNetwork` | 1072 | Partial / NOT VERIFIED |
| `addVectorBranch` | 1073 | Partial / NOT VERIFIED |
| `bendSegment` | 1074 | Partial / NOT VERIFIED |
| `insertPointOnPath` | 1075 | Partial / NOT VERIFIED |
| `setPointMirror` | 1076 | Partial / NOT VERIFIED |
| `setPointCornerRadius` | 1077 | Partial / NOT VERIFIED |
| `flatten` | 1078 | Partial / NOT VERIFIED |
| `outlineStroke` | 1079 | Partial / NOT VERIFIED |
| `offsetPath` | 1080 | Partial / NOT VERIFIED |
| `simplifyPath` | 1081 | Partial / NOT VERIFIED |
| `vectorCleanup` | 1082 | Partial / NOT VERIFIED |
| `convertTextToVector` | 1083 | Partial / NOT VERIFIED |
| `shapeBuilder` | 1084 | Partial / NOT VERIFIED |
| `vectorAlign` | 1085 | Partial / NOT VERIFIED |
| `addVariant` | 1086 | Partial / NOT VERIFIED |
| `setVariant` | 1087 | Partial / NOT VERIFIED |
| `setVecEdit` | 1088 | Partial / NOT VERIFIED |
| `addComponentProperty` | 1089 | Partial / NOT VERIFIED |
| `deleteComponentProperty` | 1090 | Partial / NOT VERIFIED |
| `setCodeMapping` | 1091 | Partial / NOT VERIFIED |
| `deleteCodeMapping` | 1092 | Partial / NOT VERIFIED |
| `syncCodeMapping` | 1093 | Partial / NOT VERIFIED |
| `setComponentProperty` | 1094 | Partial / NOT VERIFIED |
| `resetOverrides` | 1095 | Partial / NOT VERIFIED |
| `setInteractions` | 1096 | Partial / NOT VERIFIED |
| `addVariable` | 1097 | Partial / NOT VERIFIED |
| `patchVariable` | 1098 | Partial / NOT VERIFIED |
| `deleteVariable` | 1099 | Partial / NOT VERIFIED |
| `addCollection` | 1100 | Partial / NOT VERIFIED |
| `renameCollection` | 1101 | Partial / NOT VERIFIED |
| `deleteCollection` | 1102 | Partial / NOT VERIFIED |
| `addMode` | 1103 | Partial / NOT VERIFIED |
| `renameMode` | 1104 | Partial / NOT VERIFIED |
| `deleteMode` | 1105 | Partial / NOT VERIFIED |
| `setActiveMode` | 1106 | Partial / NOT VERIFIED |
| `bindVariable` | 1107 | Partial / NOT VERIFIED |
| `unbindVariable` | 1108 | Partial / NOT VERIFIED |
| `swapInstance` | 1109 | Partial / NOT VERIFIED |
| `addAnnotation` | 1110 | Partial / NOT VERIFIED |
| `deleteAnnotation` | 1111 | Partial / NOT VERIFIED |
| `presentStart` | 1112 | Partial / NOT VERIFIED |
| `presentGo` | 1113 | Partial / NOT VERIFIED |
| `presentBack` | 1114 | Partial / NOT VERIFIED |
| `presentStop` | 1115 | Partial / NOT VERIFIED |
| `setPrototypeDevice` | 1116 | Partial / NOT VERIFIED |
| `setPrototypeOrientation` | 1117 | Partial / NOT VERIFIED |
| `commitTransaction` | 1118 | Partial / NOT VERIFIED |
| `applyModifier` | 1119 | Partial / NOT VERIFIED |
| `removeModifier` | 1120 | Partial / NOT VERIFIED |
| `setExpression` | 1121 | Partial / NOT VERIFIED |
| `removeExpression` | 1122 | Partial / NOT VERIFIED |
| `setPrototypeScale` | 1123 | Partial / NOT VERIFIED |
| `togglePrototypeHotspots` | 1124 | Partial / NOT VERIFIED |
| `togglePrototypeLiveInputs` | 1125 | Partial / NOT VERIFIED |
| `togglePrototypeSound` | 1126 | Partial / NOT VERIFIED |
| `openOverlay` | 1128 | Partial / NOT VERIFIED |
| `closeOverlay` | 1135 | Partial / NOT VERIFIED |

## Next required work / completion blockers

1. Repair R05 without dropping network geometry; add branch/disconnected/region/undo/reload tests for every legacy path-edit caller.
2. Repair rotated fit (R07) using transformed bounds with rotated/flipped-parent preservation tests. R06 now has shared-engine target normalization and regression coverage; arbitrary nested screen/local transform conversion remains a separate candidate.
3. Triage full browser failures individually: distinguish capped palette/changed selector assumptions from actual Escape/focus, disabled-action and narrow-viewport failures. No blanket HMR excuse.
4. Finish current-documentation subhierarchy review, exact subcontrol/popup inventory, and all-category undo/persistence matrix. Repeat browser profiling without concurrent suites and on representative hardware.
5. Run Rust/native gates when toolchain/runtime is available; resolve carry-forward native/text/export gaps. Preserve the existing design system.

## Measured performance addendum — final production, 2026-09-27

Executed after unit/build gates and before launching the final full E2E run; no concurrent full suite. Headless Chromium, software rendering, 1400×950 viewport, DPR 1. Each fixture uses 60 dispatch→two-animation-frame samples, warmed by mounting/two frames first. Images are repeated small SVG data URLs (100 image **layers**, not a high-resolution decode stress test). Deep fixture is 40 nested frames; layout fixture is ten parents/100 children; vectors are 500 paths × 32 points. These results are dominated by the two-frame sampling cadence; **they do not demonstrate 60 FPS or complete performance parity**.

| Fixture | Samples | Median ms | P95 ms | Max ms |
|---|---:|---:|---:|---:|
| 1 | 60 | 33.3 | 33.5 | 33.7 |
| 100 | 60 | 33.3 | 33.6 | 34 |
| 500 | 60 | 33.3 | 33.5 | 33.6 |
| deep | 60 | 33.3 | 33.5 | 33.6 |
| layout | 60 | 33.3 | 33.5 | 34 |
| images | 60 | 33.3 | 33.6 | 33.7 |
| vectors | 60 | 33.3 | 33.6 | 33.8 |

An earlier vector run measured P95 49.5 ms; the final run measured 33.6 ms. This variability and the small sample size preclude a regression or smoothness guarantee. High-resolution images, sustained editing, memory use/leaks and native GPU behavior remain NOT VERIFIED — requires runtime/manual verification.

## Final full-browser result and failure triage

Final production was frozen after all 2,737 unit/DOM assertions, TypeScript and build passed. The corrected harness completed **all 51 sections: 363 assertions passed, 16 failed, exit 1, no browser page errors**. Evidence: `/home/user/parity-e2e-complete.log`. This is a failed gate, not a pass with caveats.

Earlier run 1 aborted after 24 printed failures; run 2 recorded 348/23 before a Puppeteer unpaired-mouseup exception. Current harness corrects the Agent's obsolete hardcoded frame name, null-safe missing-dialog traversal, searching Actions' capped command list, and paired radial mouse buttons. Assertions were not deleted or changed to unconditional success. These are test setup corrections, not new production fixes.

| Failure group | Failed assertions | Current triage / next action |
|---|---:|---|
| Vector Done theme token | 1 | Immediate theme mutation/style read may interact with transitions; NOT independently reproduced as a product defect. Do not redesign semantic colors to satisfy a timing assertion. |
| Boolean menu styling/separator | 2 | Harness queries a boolean flyout after point-edit/select-all without establishing that it is open. Verify context and open the menu explicitly before comparing geometry. |
| Tools pane colors/reasons/disabled action | 3 | Current test compares disabled labels case-sensitively to explanatory prose; switches to File before querying a Tools-only button; counts tree rows while the tree is absent. Setup/expectation defects must be corrected before claiming command failures. Enabled color expectation still needs design-token review. |
| Agent “changes nothing” | 1 | Counts tree rows while Agent pane is active, then after returning to File (0→23). Compare model state or the same mounted pane, not different DOM surfaces. |
| Dock at 700/430px and flyout bounds | 3 | Responsive geometry checks fail. NOT VERIFIED as intentional layout versus genuine clipping/hit-access problem; requires independent narrow-viewport interaction reproduction. |
| Nested menu second Escape | 1 | Still open after expected second Escape. Remains an integration candidate; isolate stack/focus registration before changing shared dismissal. |
| Delete after modal close | 1 | Modal guards and dismissal now pass, but follow-up layer selection/deletion assertion fails. Test sends a synthetic click to a row; verify actual pointer selection/model and focus before attributing to the modal guard. |
| Radial Bend | 4 | Confirmed harness assumptions are wrong: source slice 0 is top and Bend index 4 is **bottom**, but test moves left. Its active readout selects the first text (“Select”), not center hub. Correct coordinates/readout, then exercise the real action; production Bend behavior is not cleared by this run. |
| **Total** | **16** | No blanket attribution to HMR; no claim of all browser tests passing. |

The corrected export/nudge command launches, export focus trap, 24-Tab containment, Shift+Tab wrap, nudge focus/Tab, and modal keyboard suppression passed in this final run. They do not clear the separate second-Escape/post-modal-selection assertions or every popup combination. Further harness work should retain meaningful checks and be followed by another complete run.

## Historical archive — NOT current verification

The following earlier report is preserved for traceability. Its branch, line numbers, 225/224 counts, “22/22,” browser unavailability, and test totals are historical and **must not** be treated as current signoff. The authoritative results are above and the completed Micro Parity Batch 1–3 records.

<details><summary>Archived 2026-09-26 report</summary>

# Figma Behavior Parity Audit — X-Native (TS)

- Date: 2026-09-26. Branch: `arena/01a0d904-x-native`, HEAD `6e0e90d` (base `c7c6d34`).
- Working ledger (per-section evidence, code refs, Deferred lists): `X-Native/docs/BEHAVIOR_AUDIT_2026-09-26.md` (§§5–26).
- This document is the §44.5 deliverable: what was audited, what Figma does, what X did, and what was found.
- Companion: `FIGMA_BEHAVIOR_PARITY_FIXES.md` (every fix, files, tests, verification).
- Path note: the repo has no repo-root `docs/`; both deliverables live in `X-Native/docs/` alongside the ledger.

## 1. Scope

Only features X-Native already has, benchmarked against documented Figma behavior. No new Figma-only
capabilities were added (pattern/video fills, branching, multiplayer, version history, FigJam/AI tools, etc.).
Graphite & Signal visual identity and the existing engine architecture were preserved; fixes went to the
smallest correct layer (engine model → canvas interaction → inspector/chrome surface).

## 2. Method and method limits (read before citing this audit)

- Source of Figma truth: official Figma help-center articles per area (named in each § below) plus the
  Figma keyboard-shortcut article for chords. No Figma client was available in this sandbox; "Figma behavior"
  = behavior as documented in those articles.
- Every X behavior was inspected in source (`X-Native/apps/web/src`), exercised through headless
  unit/component tests, and cross-checked against the cited article.
- Sandbox limits, stated plainly:
  - **No browser.** The E2E runner (`e2e/behaviour.mjs`) requires Chromium; provisioning failed
    (no cargo, puppeteer CLI unusable, direct Chrome-for-Testing download blocked, zero GUI libs).
    **E2E is NOT VERIFIED**, not claimed.
  - **No Rust toolchain.** The product track is TypeScript (`track=ts`); Rust results are N/A, not claimed.
  - Pointer/keyboard interactions were **code-traced and headless-tested, not physically clicked.**
    Anything requiring a live pointer (drag feel, hover paint timing) is marked as such in §8.

## 3. Severity rubric

- **P0** — feature unusable, data corruption, or destructive-on-common-path. Fix immediately.
- **P1** — significant behavior mismatch a user hits in normal flows, or accepted-but-unrenderable values.
- **P2** — polish/minor: labels, tooltips, micro-feedback, edge cases, dead code.

## 4. Executive counts (§44.6–44.7)

| Measure | Count |
|---|---|
| Audit areas (prompt §§5–26 + transverse §§27–30) | 22/22 areas audited |
| Findings with fix IDs | **225** (P0 9, P1 123, P2 93) |
| Fixed on this branch | **224** (P0 9/9, P1 122/123, P2 93/93) |
| Open (known, recorded §8) | 1 × P1: rotation-sign convention (§7 deviation) |
| Deferred holes recorded (no fix ID) | locked-layer patch whitelist (P1), tidy readout w/o surface (P2) |
| Verified-parity confirmations (no fix needed) | 40+ (listed per §) |
| Out-of-scope capabilities recorded (not attempted) | ≈60 (condensed §9; 2 later superseded: tidy-up §20, italic §26) |
| Suite | 1216 → **1776 passed / 0 failed** (22 files; § trackers record ~610 added checks, net +560 after consolidation) |
| TS build / `tsc -b` | ✓ 0 errors; `npm run build` ✓ 4.31s |
| E2E / Rust | NOT VERIFIED (no browser) / N/A (no toolchain; TS track) |

## 5. Figma references used (official help articles, by area)

Frames; Select layers and objects; Adjust alignment, rotation, and position; Navigate the canvas;
Create and manage guides (+ grids article); Apply fills; Apply strokes; Apply effects; Crop images +
mask/place-image articles; Format text; Vector networks + Pen tool; Layers panel; Components;
Variables; Auto layout; Inspector/fields per-prop docs; Toolbar; Menus; Prototype triggers/actions;
Export; Version history/undo; Keyboard shortcuts. Full per-section citation lines live in the ledger.

## 6. Findings by area — Figma behavior vs X behavior

Disposition: **FIXED** (shipped + tested), **OPEN** (recorded, not fixed), **PARITY** (verified, no action).

### §5 Frames (F-001–F-009 + macOS chord cleanup) — 5 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| F-001 | Frame tool = F **or A** | Only F bound | P2 | FIXED |
| F-002 | ⌥⌘G wraps selection in a frame | Help text advertised it; nothing bound, menu display-only | P1 | FIXED |
| F-003 | ⌘⌫ inside a frame ungroups one level (keeps children) | Deleted the whole selection | P1 | FIXED |
| F-004 | Click-placed top-level frames reuse last top-level size | Nested frames inherited parent size | P2 | FIXED |
| F-005 | ⌥⌘E resizes frame to fit content | Chord + function missing | P1 | FIXED |
| F-006 | Device presets land left of current frame at same Y; repeats swap device | Cascaded diagonally | P2 | FIXED |
| F-007 | Esc climbs one level (child→frame→top→page) | Esc cleared selection at frame level | P1 | FIXED |
| F-008 | Frame hover shows quick-add badges | No badges (only duplicate existed) | P2 | FIXED |
| F-009 | W/H fields scrub | No scrub on dimension fields | P2 | FIXED |
| — | Boolean chords work on macOS | `e.code`-only branch dead on macOS dead-keys; duplicate branch | P1 | FIXED |
| — | Type-aware chrome: 6–22px corner rotate zone, handles, top-level-only labels | Confirmed in source (Canvas.tsx rotate zone ≤22/≥6 verified this session) | — | PARITY |

### §6 Selection (S-001–S-005) — 3 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| S-001 | Click on an already-selected group drills into it | Click did nothing (group stayed selected) | P1 | FIXED |
| S-002 | ⇧-range selects siblings (same parent) only | Ranged across parents | P1 | FIXED |
| S-003 | Layers-panel hover highlights canvas object | No hover highlight | P2 | FIXED |
| S-004 | ⇧-marquee replaces the marquee set (anchor kept) | ⇧-marquee unioned onto selection | P1 | FIXED |
| S-005 | Select-same covers Instance | Instance missing from select-same | P2 | FIXED |

### §7 Transform (T-001–T-005 + rotation-sign deviation) — P1 2 fixed + 1 open, P2 3 fixed

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| T-001 | Align/distribute/rotation-origin chords work on macOS | `e.key` chords dead on macOS (dead-keys) | P1 | FIXED |
| T-002 | Aspect lock respects min/max constraints | Lock ignored min/max | P2 | FIXED |
| T-003 | Equations accept tokens like `w/2`, `h-8` | Token parse rejected valid tokens | P2 | FIXED |
| T-004 | ⌥-scrub works from numeric inputs | No ⌥-scrub from inputs | P2 | FIXED |
| T-005 | Shadow offsets rotate with the layer | Shadows stayed axis-aligned on rotate | P1 | FIXED |
| T-DEV | Rotation sign convention matches Figma | Sign convention unverified vs Figma | P1 | **OPEN** |

### §8 Navigation (N-001–N-002) — 1 × P1, 1 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| N-001 | Zoom labels read "Zoom in / Zoom out" | Labels swapped | P2 | FIXED |
| N-002 | Pixel snap applies to all move paths | Gaps: some move paths skipped snapping | P1 | FIXED |

### §9 Guides & grids (G-000–G-007) — 1 × P0, 5 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| G-000 | Rulers/guides visible and grabbable | Guides invisible AND ungrabbable (CSS classes missing) | P0 | FIXED |
| G-001 | Repeated nudges coalesce to one undo step | One undo entry per nudge | P2 | FIXED |
| G-002 | Guides selectable (Delete/Esc/menu act on them) | No guide selection at all | P1 | FIXED |
| G-003 | Frames have frame-level guides | Only canvas guides existed | P1 | FIXED |
| G-004 | Resize snaps to guides | Resize ignored guides | P1 | FIXED |
| G-005 | Canvas margin 10% | 8% margin | P2 | FIXED |
| G-006 | Fixed grids render columns/rows/gutter/margins | Settings stored but renderer ignored them | P1 | FIXED |
| G-007 | Layout-grid fields (count, gutter, margins) in inspector | Fields missing | P1 | FIXED |

### §10 Fills (P-001–P-010) — 6 × P1, 4 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| P-001 | Angular gradient mirrors correctly | Mirrored output | P1 | FIXED |
| P-002 | Conic sweep starts at Figma origin | Sweep origin 90° off | P1 | FIXED |
| P-003 | Radial gradients can be elliptical | Forced circular | P1 | FIXED |
| P-004 | Gradient handles target visible stops | Handles targeted hidden/removed stops | P1 | FIXED |
| P-005 | Rotate/blend apply to extra fills | Dead on extras (first fill only) | P1 | FIXED |
| P-006 | − removes the fill | Only hid it (ghost fill) | P2 | FIXED |
| P-007 | Delete removes selected stop | Delete ignored stop selection | P2 | FIXED |
| P-008 | Inserted stop takes neighbor color | Inserted wrong color | P2 | FIXED |
| P-009 | Same-color stops stay distinguishable/selected | Selection lost on same-color stops | P2 | FIXED |
| P-010 | Image fill type always resolvable | Dead-end choice when no image | P1 | FIXED |

### §11 Strokes (K-001–K-009) — 3 × P1, 6 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| K-001 | Dash phase/offset honored | Phase ignored | P2 | FIXED |
| K-002 | Dash cap style honored | Caps wrong on dashed strokes | P2 | FIXED |
| K-003 | Join style hover preview | No preview | P2 | FIXED |
| K-004 | Width profiles render on branching paths | Branching swallowed the stroke | P1 | FIXED |
| K-005 | Outside spill clickable/selectable | Spill region unclickable | P1 | FIXED |
| K-006 | Join control visible with arrowheads | Join hidden when arrows on | P2 | FIXED |
| K-007 | Only supported stroke fills offered | Phantom gradient/image/blend controls (edits silently dropped) | P1 | FIXED |
| K-008 | Circle line tip offered | Missing tip | P2 | FIXED |
| K-009 | "Align" label for stroke position | Label mismatch | P2 | FIXED |

### §12 Effects (L-001–L-010) — 8 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| L-001 | Noise/texture stack in Figma order | Wrong stack order | P1 | FIXED |
| L-002 | Multiple noise effects + correct labels | First-noise-only + mislabeled | P1 | FIXED |
| L-003 | Multiple shadows on text/booleans | First-shadow-only on text/bool | P1 | FIXED |
| L-004 | Show-behind honored | Ignored | P1 | FIXED |
| L-005 | Spread gated to supporting types | Spread applied where invalid | P1 | FIXED |
| L-006 | Effect hover preview | No preview | P2 | FIXED |
| L-007 | ⌘D in effects popover duplicates the effect | Duplicated the whole layer | P1 | FIXED |
| L-008 | Background blur on invalid target warns | Silent no-op | P2 | FIXED |
| L-009 | Shadows render with extra-only fills | No shadow when only extra fills | P1 | FIXED |
| L-010 | Noise renders on line layers | Noise vanished on lines | P1 | FIXED |

### §13 Images & masks (M-001–M-010 + export peek + labels) — 1 × P0, 5 × P1, 4 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| M-001 | Masks clip text/alpha/blur correctly | Mask clip wrong for text, alpha, blurred content | P0 | FIXED |
| M-002 | Mask outlines viewable | No outlines view | P2 | FIXED |
| M-003 | Crop tool with handles | No crop interaction | P1 | FIXED |
| M-004 | Place-image flow | No place flow | P1 | FIXED |
| M-005 | Image cascade order | Wrong cascade | P2 | FIXED |
| M-006 | Tile mode + adjustments modeled | Model gaps (tile/adjust) | P1 | FIXED |
| M-007/008 | — | Verified parity, no action | — | PARITY |
| M-009 | Stacked image fills render | Only first image fill rendered | P1 | FIXED |
| M-010 | Fit readout label | Wrong label | P2 | FIXED |
| M-EX | Export peeks through masks correctly | Export peeked unmasked output | P1 | FIXED |
| M-LBL | Video labels correct | Wrong labels | P2 | FIXED |

### §14 Typography (Y-001–Y-015) — 12 × P1, 3 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| Y-001 | Dragging auto-width/height becomes fixed | Stayed auto after drag | P1 | FIXED |
| Y-002 | Vertical align gated to fixed-height | Applied on auto-height (no-op/confusing) | P1 | FIXED |
| Y-003 | Small caps render | Not rendered | P1 | FIXED |
| Y-004 | Leading floored per Figma | No floor (collapse) | P1 | FIXED |
| Y-005 | Indent gated to supporting align | Indent on wrong aligns | P2 | FIXED |
| Y-006 | Tracking honored on justified text | Tracking dropped on justify | P1 | FIXED |
| Y-007 | Strikethrough positioned per Figma | Wrong position | P2 | FIXED |
| Y-008 | Hug height measured correctly | Wrong hug height | P1 | FIXED |
| Y-009 | Truncate + max-lines honored | Ignored | P1 | FIXED |
| Y-010 | Click another text to edit it | Click didn't switch editing target | P1 | FIXED |
| Y-011 | Advertised chords bound; ⌥⌘L doesn't nuke layout | Chords unbound; ⌥⌘L removed auto-layout | P1 | FIXED |
| Y-012 | Metric chords bound + text rehugs | Chords missing; stale hug | P1 | FIXED |
| Y-013 | Style label correct | Mislabeled | P2 | FIXED |
| Y-014 | Dev-mode CSS emits valid lists | Invalid CSS lists emitted | P1 | FIXED |
| Y-015 | Clamp accepted values to renderer capability | Phantom values accepted, never rendered | P1 | FIXED |

### §15 Vectors (V-001–V-010) — 5 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| V-001 | Boolean members drillable, not pre-flattened | Flattened up front; dead drill | P1 | FIXED |
| V-002 | Backspace with no point selected does nothing | Ate an anchor (geometry loss) | P1 | FIXED |
| V-003 | Close-ring affordance scoped | Ring offered everywhere | P2 | FIXED |
| V-004 | Click inserts point on path; new draft is explicit | Second draft started instead of insert | P1 | FIXED |
| V-005 | Arrows move selected points in edit mode | Arrows moved the whole layer | P1 | FIXED |
| V-006 | ⇧ constrains point drag | No constrain | P2 | FIXED |
| V-007 | Inserting a point preserves curve shape | Insert split/deformed the arc | P1 | FIXED |
| V-008 | Tangents stay smooth on drag | Tangent kinked | P2 | FIXED |
| V-009 | ⌥-pull drags handle independently | No ⌥-pull | P2 | FIXED |
| V-010 | Zero-length segments cleaned | Zero-length segments kept (bad hit/export) | P2 | FIXED |

### §16 Layers (L-001–L-007) — 3 × P1, 4 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| L-001 | Lock inherits: locked subtree not editable | Locked children still editable | P1 | FIXED |
| L-002 | Ungroup single-child splices; rotation preserved | Wrong splice; rotation lost | P1 | FIXED |
| L-003 | Cross-parent move works | Cross-parent move no-op | P1 | FIXED |
| L-004 | ⌥-fold folds subtree | No ⌥-fold | P2 | FIXED |
| L-005 | Selecting canvas object reveals panel row | No reveal | P2 | FIXED |
| L-006 | Whitespace-only rename rejected | Accepted (blank names) | P2 | FIXED |
| L-007 | Inline rename + drag reorder | Prompt rename only; weak reorder | P2 | FIXED |

### §17 Components (C-001–C-013) — 5 × P0, 7 × P1, 1 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| C-001 | Instance member geometry doesn't leak to main | Leaked | P1 | FIXED |
| C-002 | Structural guards (can't ungroup/bool-op instances destructively) | Missing guards | P1 | FIXED |
| C-003 | Library ids unique per component | Two components shared one id (cross-talk) | P0 | FIXED |
| C-004 | Detaching master doesn't orphan instances | Orphaned instances | P1 | FIXED |
| C-005 | Instance child ids unique | Shared child ids (collision) | P0 | FIXED |
| C-006 | Reset restores the instance's own variant | Reset wrong variant | P1 | FIXED |
| C-007 | Overrides apply to own instance | Cross-wired overrides | P1 | FIXED |
| C-008 | Insert position correct | Wrong insert position | P2 | FIXED |
| C-009 | Variant edits publish to variant's own def | Silently overwrote another variant's def | P0 | FIXED |
| C-010 | Publish covers nested/override cases | Publish gaps | P1 | FIXED |
| C-011 | Overrides carry across variant switch | Overrides dropped | P1 | FIXED |
| C-012 | Sync never corrupts roots | Deep sync corruption (root mismatch) | P0 | FIXED |
| C-013 | Reset restores member state | Grafted master-root clone inside member | P0 | FIXED |

### §18 Variables (VR-001–VR-014) — 1 × P0, 10 × P1, 3 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| VR-001 | engine binds "variable" alias | Only "var" bound | P1 | FIXED |
| VR-002 | Variable picker on stroke/effects props | Picker missing there | P1 | FIXED |
| VR-003 | Tuple values guarded | Unguarded tuples crashed/coerced wrong | P1 | FIXED |
| VR-004 | Scale-factor applied | Ignored | P1 | FIXED |
| VR-005 | Arc radius accepts variables | Refused | P1 | FIXED |
| VR-006 | Number→string coercion on bind | Bind failed | P1 | FIXED |
| VR-007 | Variable ids unique | Dupe ids silently shadowed in resolution | P0 | FIXED |
| VR-008 | Cyclic aliases refused (no hang) | Cycle possible (infinite loop) | P1 | FIXED |
| VR-009 | String coercion on resolve | Wrong/missing coerce | P1 | FIXED |
| VR-010 | Unlink restores alias target value | Unlink dropped value | P1 | FIXED |
| VR-011 | Rename gestures | Missing | P2 | FIXED |
| VR-012 | Case-only rename allowed | Rejected | P2 | FIXED |
| VR-013 | Picker covers Figma-supported props | Coverage gaps | P2 | FIXED |
| VR-014 | Mode switch snapshots cleanly | Mode snapshot leaked across modes | P1 | FIXED |

### §19 Auto layout (AL-001–AL-014) — 11 × P1, 3 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| AL-001 | Arrow keys flip hug→fixed correctly | Wrong flip behavior | P1 | FIXED |
| AL-002 | Independent row/column gaps | Single gap only | P1 | FIXED |
| AL-003 | min/max honored with wrap | min/max ignored when wrapped | P1 | FIXED |
| AL-004 | Gap readout accurate | Wrong readout | P2 | FIXED |
| AL-005 | First/last margin honored | Ignored | P1 | FIXED |
| AL-006 | List reorder moves layout child | Reorder broke layout position | P1 | FIXED |
| AL-007 | Hidden children toggleable without layout loss | Silent no-op or layout loss | P1 | FIXED |
| AL-008 | Wrap drop index correct | Wrong index | P1 | FIXED |
| AL-009 | Baseline + stroke alignment | Wrong alignment | P1 | FIXED |
| AL-010 | Wrap badge shown | Missing badge | P1 | FIXED |
| AL-011 | Distribute via drag-and-drop | Missing | P1 | FIXED |
| AL-012 | Canvas drag-and-drop into layout | Gaps | P2 | FIXED |
| AL-013 | Align via drag-and-drop | Gaps | P2 | FIXED |
| AL-014 | Keyboard can leave layout context | Trapped | P1 | FIXED |

### §20 Inspector (IN-001–IN-009) — 4 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| IN-001 | Mixed-state shown for multi-select | First-value shown as if uniform | P1 | FIXED |
| IN-002 | Scale (K) vs resize distinguished | Conflated | P1 | FIXED |
| IN-003 | Tidy-up works | Missing/broken tidy-up | P1 | FIXED |
| IN-004 | Multi-select bulk actions | Missing actions | P1 | FIXED |
| IN-005 | Scrub hint on numeric fields | No hint | P2 | FIXED |
| IN-006 | ⌘⌥]/[ z-order alternates | Only ⇧ variants bound | P2 | FIXED |
| IN-007 | Distribute controls | Missing | P2 | FIXED |
| IN-008 | Help URL correct | Wrong URL | P2 | FIXED |
| IN-009 | Constraints editor | Missing editor | P2 | FIXED |

### §21 Toolbar (TB-001–TB-006) — 1 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| TB-001 | Tool state tooltip | Missing/wrong | P2 | FIXED |
| TB-002 | Advertised zoom chord wired | Advertised but unwired | P1 | FIXED |
| TB-003 | Zoom shortcuts complete | Gaps | P2 | FIXED |
| TB-004 | Add-frame affordance | Missing | P2 | FIXED |
| TB-005 | Zoom controls in menus | Missing | P2 | FIXED |
| TB-006 | — | Dead font-list code removed | P2 | FIXED |

### §22 Menus (MN-001–MN-008) — 1 × P1, 7 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| MN-001 | "Paste over selection" label | Wrong label | P2 | FIXED |
| MN-002 | Boolean menu labels | Wrong labels | P2 | FIXED |
| MN-003 | Flatten label | Wrong label | P2 | FIXED |
| MN-004 | Disabled items explain why | Silent no-ops w/ misleading toast | P1 | FIXED |
| MN-005 | Selection submenu complete | Gaps | P2 | FIXED |
| MN-006–008 | Paste/guide/vector labels per Figma | Mismatched labels | P2 | FIXED |

### §23 Prototype (PT-001–PT-019) — 12 × P1, 7 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| PT-001 | Present stays in flow | Dropped out of present | P1 | FIXED |
| PT-002 | Drag vs navigate disambiguated | Drag triggered nav | P1 | FIXED |
| PT-003 | Overlay close behavior | Wrong close | P1 | FIXED |
| PT-004 | All triggers fire | Dead triggers | P1 | FIXED |
| PT-005 | Delay authorable | Delay unauthorable | P1 | FIXED |
| PT-006 | Media triggers work | Broken | P1 | FIXED |
| PT-007 | None→dismiss transition | Missing | P1 | FIXED |
| PT-008 | Smart-animate order | Wrong order | P2 | FIXED |
| PT-009 | Scroll overflow honored | Ignored | P2 | FIXED |
| PT-010 | Reset scroll on entry | Missing | P2 | FIXED |
| PT-011 | Scroll-to gated correctly | Wrong gating | P1 | FIXED |
| PT-012 | Missing action type added (engine cmd existed) | No UI action | P1 | FIXED |
| PT-013 | — | Minor trigger label | P2 | FIXED |
| PT-014 | Overlay positioning | Wrong position | P1 | FIXED |
| PT-015 | — | Minor timing label | P2 | FIXED |
| PT-016 | — | Minor easing label | P2 | FIXED |
| PT-017 | Expression eval for numbers | Eval gap | P1 | FIXED |
| PT-018 | Variable-driven nav resolves | Silently dropped | P1 | FIXED |
| PT-019 | Variable connection lines drawn | Missing lines | P2 | FIXED |

### §24 Export (EX-001–EX-014) — 9 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| EX-001 | Batch export rows | UI rows missing (engine supported) | P2 | FIXED |
| EX-002 | Slice bounds correct | Wrong bounds | P1 | FIXED |
| EX-003 | Slice model exists | No slice model | P1 | FIXED |
| EX-004 | PDF page size correct | Wrong page size | P1 | FIXED |
| EX-005 | PNG/JPG scale options | Missing scales | P1 | FIXED |
| EX-006 | SVG export choice | Missing choice | P1 | FIXED |
| EX-007 | PDF renderer correct | Wrong renderer | P1 | FIXED |
| EX-008 | Export icon button | Missing | P2 | FIXED |
| EX-009 | Filename suffix default | Wrong default | P2 | FIXED |
| EX-010 | Copy-link works | Broken | P1 | FIXED |
| EX-011 | Lossless SVG emitter | Lossy emitter | P1 | FIXED |
| EX-012 | — | Minor format label | P2 | FIXED |
| EX-013 | Re-import round-trips | Dead-end re-import | P1 | FIXED |
| EX-014 | Scrolled-slice handling | Wrong | P2 | FIXED |

### §25 History (HI-001–HI-007) — 1 × P0, 4 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| HI-001 | Redo preserved across unrelated edits | Redo eaten | P1 | FIXED |
| HI-002 | First command undoes cleanly | First-cmd undo broken | P1 | FIXED |
| HI-003 | Burst edits coalesce to a real entry | Coalesced into thin air (unundoable + redo eaten) | P0 | FIXED |
| HI-004 | History guards never crash | Guard crash path | P2 | FIXED |
| HI-005 | New command resweeps correctly | Stale sweep | P2 | FIXED |
| HI-006 | Mid-sweep wheel handled | Wheel corrupted sweep | P1 | FIXED |
| HI-007 | First-entry redo works | Broken | P1 | FIXED |

### §26 Keyboard (KB-001–KB-018 + sheet) — 5 × P1, 14 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| KB-001 | Ctrl+Y redoes (Win/Linux) | Swallowed | P1 | FIXED |
| KB-002 | ⌘I toggles italic | Chord missing + no model | P1 | FIXED |
| KB-003 | Chords work on macOS dead-keys | Dead on Mac | P1 | FIXED |
| KB-004 | `/` removes stroke, `⌥/` removes fill | Actions missing | P1 | FIXED |
| KB-005–016 | Text-edit, type-tool guard, vector, layer, pixel-zoom, grid, align, distribute, show/hide UI, boolean, layer-list chords per official article | Gaps/mismatches | P2 | FIXED |
| KB-017 | Menu arrows navigate; Esc closes menu w/o losing selection | Arrows dead; Esc cleared selection | P1 | FIXED |
| KB-018 | Library/asset chords | Missing | P2 | FIXED |
| KB-S | Shortcut sheet matches bindings | Stale entries | P2 | FIXED |

## 7. Feature matrix (§37) — one row per audited feature

Status: ✅ fixed to parity · ⏺ verified parity (no fix) · ❌ open. Tests = regression file (counts §4).

| # | Feature | Figma | X now | St | Sev | Tests |
|---|---|---|---|---|---|---|
| 1 | Frame tool chords (F/A) | F or A | F + A | ✅ | P2 | parity |
| 2 | Wrap in frame ⌥⌘G | Wraps selection | Bound + menu wired | ✅ | P1 | parity |
| 3 | Ungroup ⌘⌫ | Ungroups one level | Splices children, keeps them | ✅ | P1 | parity |
| 4 | Click-place size reuse | Reuse last top-level size | Top-level-only reuse | ✅ | P2 | parity |
| 5 | Resize to fit ⌥⌘E | Fits frame to content | Chord + fn shipped | ✅ | P1 | parity |
| 6 | Device presets | Land left, same Y; swap on repeat | Matches | ✅ | P2 | parity |
| 7 | Esc level-up | Climbs to page | Climbs child→frame→page | ✅ | P1 | parity |
| 8 | Quick-add badges | On frame hover | Badges shipped | ✅ | P2 | parity |
| 9 | Dimension scrub | W/H scrub | Scrub on W/H | ✅ | P2 | parity |
| 10 | Boolean chords on macOS | Work | code+key fallback, deduped | ✅ | P1 | parity |
| 11 | Selection chrome/rotate zone/labels | 6–22px zone, top-level labels | Verified in source | ⏺ | — | — |
| 12 | Drill into selected group | Click drills in | Drills in | ✅ | P1 | parity |
| 13 | ⇧-range | Siblings only | Same-parent only | ✅ | P1 | parity |
| 14 | Panel hover highlight | Highlights canvas | Highlights | ✅ | P2 | parity |
| 15 | ⇧-marquee | Replaces marquee set | Replaces (anchor kept) | ✅ | P1 | parity |
| 16 | Select-same instance | Covers instances | Covers | ✅ | P2 | parity |
| 17 | macOS e.key chords (align/origin) | Work | code+key fallback | ✅ | P1 | parity |
| 18 | Aspect lock + min/max | Lock respects min/max | Respects | ✅ | P2 | parity |
| 19 | Equation tokens | w/2, h−8 accepted | Accepted | ✅ | P2 | parity |
| 20 | ⌥-scrub from inputs | Scrubs | Scrubs | ✅ | P2 | parity |
| 21 | Shadow rotation | Offsets rotate w/ layer | Rotate | ✅ | P1 | parity |
| 22 | Rotation sign convention | Figma sign | UNVERIFIED | ❌ | P1 | — |
| 23 | Zoom labels | "Zoom in/out" | Fixed | ✅ | P2 | parity |
| 24 | Pixel snap | All move paths | All paths | ✅ | P1 | parity |
| 25 | Guide visibility/grab | Visible + grabbable | CSS + hit shipped | ✅ | P0 | guides |
| 26 | Nudge coalescing | One undo step | Coalesced | ✅ | P2 | guides |
| 27 | Guide selection | Selectable | Select/Delete/Esc/menu | ✅ | P1 | guides |
| 28 | Frame guides | Per-frame guides | Shipped | ✅ | P1 | guides |
| 29 | Resize→guide snap | Snaps | Snaps | ✅ | P1 | guides |
| 30 | Canvas margin | 10% | 10% | ✅ | P2 | guides |
| 31 | Fixed grids render | col/row/gutter/margin | Rendered | ✅ | P1 | guides |
| 32 | Layout-grid fields | count/gutter/margins | Fields shipped | ✅ | P1 | guides |
| 33 | Angular gradient | Correct mirror | Correct | ✅ | P1 | fills |
| 34 | Conic sweep origin | Figma origin | Fixed | ✅ | P1 | fills |
| 35 | Elliptical radial | Elliptical | Elliptical | ✅ | P1 | fills |
| 36 | Gradient handle targeting | Visible stops | Retargeted | ✅ | P1 | fills |
| 37 | Rotate/blend on extras | Apply | Apply | ✅ | P1 | fills |
| 38 | Delete fill | Removes | Removes | ✅ | P2 | fills |
| 39 | Delete stop | Removes stop | Removes | ✅ | P2 | fills |
| 40 | Insert stop color | Neighbor color | Neighbor | ✅ | P2 | fills |
| 41 | Same-color stop select | Stable | Stable | ✅ | P2 | fills |
| 42 | Image fill type | Always resolvable | No dead-end | ✅ | P1 | fills |
| 43 | Dash phase | Honored | Honored | ✅ | P2 | strokes |
| 44 | Dash cap | Correct caps | Correct | ✅ | P2 | strokes |
| 45 | Join preview | Hover preview | Preview | ✅ | P2 | strokes |
| 46 | Width profile (branching) | Renders | Renders | ✅ | P1 | strokes |
| 47 | Outside spill hit | Clickable | Clickable | ✅ | P1 | strokes |
| 48 | Join + arrows | Join visible | Visible | ✅ | P2 | strokes |
| 49 | Stroke fills offered | Supported only | Phantoms removed | ✅ | P1 | strokes |
| 50 | Circle tip | Offered | Offered | ✅ | P2 | strokes |
| 51 | Stroke align label | "Align" | Fixed | ✅ | P2 | strokes |
| 52 | Noise stack order | Figma order | Fixed | ✅ | P1 | effects |
| 53 | Multi-noise + labels | Supported + labeled | Supported | ✅ | P1 | effects |
| 54 | Multi-shadow text/bool | Supported | Supported | ✅ | P1 | effects |
| 55 | Show-behind | Honored | Honored | ✅ | P1 | effects |
| 56 | Spread gating | Gated | Gated | ✅ | P1 | effects |
| 57 | Effect preview | Hover preview | Preview | ✅ | P2 | effects |
| 58 | ⌘D in fx popover | Dupes effect | Dupes effect | ✅ | P1 | effects |
| 59 | BG-blur invalid target | Warns | Warns | ✅ | P2 | effects |
| 60 | Shadow + extra-only fill | Renders | Renders | ✅ | P1 | effects |
| 61 | Noise on lines | Renders | Renders | ✅ | P1 | effects |
| 62 | Mask rendering | Clips text/alpha/blur | partitionMaskRuns | ✅ | P0 | images |
| 63 | Mask outlines view | Viewable | Shipped | ✅ | P2 | images |
| 64 | Crop | Handles + commit | Shipped | ✅ | P1 | images |
| 65 | Place image | Flow exists | Shipped | ✅ | P1 | images |
| 66 | Image cascade | Correct order | Fixed | ✅ | P2 | images |
| 67 | Tile/adjust model | Modeled | Modeled | ✅ | P1 | images |
| 68 | Stacked image fills | All render | Render | ✅ | P1 | images |
| 69 | Fit readout | Correct label | Fixed | ✅ | P2 | images |
| 70 | Export mask peek | Masked output | Masked | ✅ | P1 | images |
| 71 | Video labels | Correct | Fixed | ✅ | P2 | images |
| 72 | Auto→fixed on drag | Becomes fixed | Fixed | ✅ | P1 | typography |
| 73 | Vertical align gate | Fixed-height only | Gated | ✅ | P1 | typography |
| 74 | Small caps | Render | Render | ✅ | P1 | typography |
| 75 | Leading floor | Floored | Floored | ✅ | P1 | typography |
| 76 | Indent gate | Gated | Gated | ✅ | P2 | typography |
| 77 | Tracking on justify | Honored | Honored | ✅ | P1 | typography |
| 78 | Strikethrough | Positioned | Fixed | ✅ | P2 | typography |
| 79 | Hug height | Measured | Fixed | ✅ | P1 | typography |
| 80 | Truncate/max-lines | Honored | Honored | ✅ | P1 | typography |
| 81 | Click-to-edit switch | Switches target | Switches | ✅ | P1 | typography |
| 82 | Advertised type chords | Bound; ⌥⌘L safe | Bound + safe | ✅ | P1 | typography |
| 83 | Metric chords + rehug | Bound + rehug | Shipped | ✅ | P1 | typography |
| 84 | Style label | Correct | Fixed | ✅ | P2 | typography |
| 85 | Dev CSS lists | Valid | Valid | ✅ | P1 | typography |
| 86 | Value clamping | Renderer-honored | Clamped | ✅ | P1 | typography |
| 87 | Boolean drill | Drillable members | Drillable | ✅ | P1 | vector |
| 88 | Backspace (no point) | No-op | No-op | ✅ | P1 | vector |
| 89 | Close-ring scope | Scoped | Scoped | ✅ | P2 | vector |
| 90 | Insert vs draft | Insert on path | Inserts | ✅ | P1 | vector |
| 91 | Arrows in edit mode | Move points | Move points | ✅ | P1 | vector |
| 92 | ⇧-constrain points | Constrains | Constrains | ✅ | P2 | vector |
| 93 | Insert preserves curve | Preserves | Preserves | ✅ | P1 | vector |
| 94 | Tangent smoothness | Smooth | Smooth | ✅ | P2 | vector |
| 95 | ⌥-pull handles | Independent | Independent | ✅ | P2 | vector |
| 96 | Zero-length segments | Cleaned | Cleaned | ✅ | P2 | vector |
| 97 | Lock inheritance | Subtree locked | Enforced | ✅ | P1 | layers |
| 98 | Ungroup single/rotation | Splice + keep rot | Fixed | ✅ | P1 | layers |
| 99 | Cross-parent move | Works | Works | ✅ | P1 | layers |
| 100 | ⌥-fold | Folds subtree | Shipped | ✅ | P2 | layers |
| 101 | Reveal on select | Reveals row | Reveals | ✅ | P2 | layers |
| 102 | Whitespace rename | Rejected | Rejected | ✅ | P2 | layers |
| 103 | Inline rename + reorder | Both work | Both work | ✅ | P2 | layers |
| 104 | Member geometry privacy | No leak to main | No leak | ✅ | P1 | components |
| 105 | Structural guards | Guarded | Guarded | ✅ | P1 | components |
| 106 | Library id uniqueness | Unique | Unique | ✅ | P0 | components |
| 107 | Master detach | No orphans | No orphans | ✅ | P1 | components |
| 108 | Instance child ids | Unique | Unique | ✅ | P0 | components |
| 109 | Reset variant | Own variant | Own | ✅ | P1 | components |
| 110 | Override wiring | Own instance | Own | ✅ | P1 | components |
| 111 | Insert position | Correct | Correct | ✅ | P2 | components |
| 112 | Variant publish target | Own def | Own def | ✅ | P0 | components |
| 113 | Publish coverage | Nested/override | Covered | ✅ | P1 | components |
| 114 | Override carry | Carry on switch | Carry | ✅ | P1 | components |
| 115 | Root sync integrity | No corruption | findInstanceRoot | ✅ | P0 | components |
| 116 | Reset purity | No graft | No graft | ✅ | P0 | components |
| 117 | variable/var alias | Both bound | Both | ✅ | P1 | variables |
| 118 | Picker on stroke/fx | Present | Present | ✅ | P1 | variables |
| 119 | Tuple guard | Guarded | Guarded | ✅ | P1 | variables |
| 120 | Scale-factor | Applied | Applied | ✅ | P1 | variables |
| 121 | Arc radius vars | Accepted | Accepted | ✅ | P1 | variables |
| 122 | Number→string bind | Coerced | Coerced | ✅ | P1 | variables |
| 123 | Variable id uniqueness | Unique | Deduped | ✅ | P0 | variables |
| 124 | Cycle refusal | Refused | Refused | ✅ | P1 | variables |
| 125 | String coerce | Correct | Correct | ✅ | P1 | variables |
| 126 | Unlink alias | Restores value | Restores | ✅ | P1 | variables |
| 127 | Rename gestures | Work | Work | ✅ | P2 | variables |
| 128 | Case-only rename | Allowed | Allowed | ✅ | P2 | variables |
| 129 | Picker coverage | Full | Full | ✅ | P2 | variables |
| 130 | Mode snapshot | Clean | Clean | ✅ | P1 | variables |
| 131 | Hug→fixed arrows | Correct flip | Correct | ✅ | P1 | autolayout |
| 132 | Dual gaps | Row+col | Shipped | ✅ | P1 | autolayout |
| 133 | min/max + wrap | Honored | Honored | ✅ | P1 | autolayout |
| 134 | Gap readout | Accurate | Accurate | ✅ | P2 | autolayout |
| 135 | First/last margin | Honored | Honored | ✅ | P1 | autolayout |
| 136 | List reorder | Keeps layout pos | Keeps | ✅ | P1 | autolayout |
| 137 | Hidden toggle | No layout loss | No loss | ✅ | P1 | autolayout |
| 138 | Wrap drop index | Correct | Correct | ✅ | P1 | autolayout |
| 139 | Baseline + stroke | Aligned | Aligned | ✅ | P1 | autolayout |
| 140 | Wrap badge | Shown | Shown | ✅ | P1 | autolayout |
| 141 | Distribute DnD | Works | Works | ✅ | P1 | autolayout |
| 142 | Canvas DnD into layout | Works | Works | ✅ | P2 | autolayout |
| 143 | Align DnD | Works | Works | ✅ | P2 | autolayout |
| 144 | Keyboard leave layout | Leaves | Leaves | ✅ | P1 | autolayout |
| 145 | Mixed-state | Shown | Shown | ✅ | P1 | inspector |
| 146 | Scale vs resize | Distinguished | Distinguished | ✅ | P1 | inspector |
| 147 | Tidy-up | Works | Works | ✅ | P1 | inspector |
| 148 | Multi-select actions | Present | Present | ✅ | P1 | inspector |
| 149 | Scrub hint | Shown | Shown | ✅ | P2 | inspector |
| 150 | Z-order alternates | ⌘⌥]/[ bound | Bound | ✅ | P2 | inspector |
| 151 | Distribute controls | Present | Present | ✅ | P2 | inspector |
| 152 | Help URL | Correct | Correct | ✅ | P2 | inspector |
| 153 | Constraints editor | Present | Present | ✅ | P2 | inspector |
| 154 | Tool tooltip | Correct | Correct | ✅ | P2 | toolbar |
| 155 | Zoom chord | Wired | Wired | ✅ | P1 | toolbar |
| 156 | Zoom shortcuts | Complete | Complete | ✅ | P2 | toolbar |
| 157 | Add-frame | Present | Present | ✅ | P2 | toolbar |
| 158 | Zoom in menus | Present | Present | ✅ | P2 | toolbar |
| 159 | Paste-over label | Correct | Correct | ✅ | P2 | menu |
| 160 | Boolean labels | Correct | Correct | ✅ | P2 | menu |
| 161 | Flatten label | Correct | Correct | ✅ | P2 | menu |
| 162 | Disabled items | Explain why | Explain | ✅ | P1 | menu |
| 163 | Selection submenu | Complete | Complete | ✅ | P2 | menu |
| 164 | Paste/guide/vector labels | Per Figma | Fixed | ✅ | P2 | menu |
| 165 | Present flow | Stays in flow | Stays | ✅ | P1 | proto |
| 166 | Drag vs nav | Disambiguated | Disambiguated | ✅ | P1 | proto |
| 167 | Overlay close | Correct | Correct | ✅ | P1 | proto |
| 168 | Triggers | All fire | All fire | ✅ | P1 | proto |
| 169 | Delay authoring | Authorable | Authorable | ✅ | P1 | proto |
| 170 | Media triggers | Work | Work | ✅ | P1 | proto |
| 171 | None→dismiss | Supported | Supported | ✅ | P1 | proto |
| 172 | Smart-animate order | Correct | Correct | ✅ | P2 | proto/parity |
| 173 | Scroll overflow | Honored | Honored | ✅ | P2 | proto |
| 174 | Reset scroll | On entry | On entry | ✅ | P2 | proto |
| 175 | Scroll-to gating | Correct | Correct | ✅ | P1 | proto |
| 176 | Missing action type | In UI | Added | ✅ | P1 | proto |
| 177 | Overlay position | Correct | Correct | ✅ | P1 | proto |
| 178 | Expression numbers | Evaluated | Evaluated | ✅ | P1 | proto |
| 179 | Variable nav | Resolves | Resolves | ✅ | P1 | proto |
| 180 | Variable conn lines | Drawn | Drawn | ✅ | P2 | proto |
| 181 | Batch export rows | Present | Present | ✅ | P2 | export24 |
| 182 | Slice bounds | Correct | Correct | ✅ | P1 | export24 |
| 183 | Slice model | Exists | Exists | ✅ | P1 | export24 |
| 184 | PDF page size | Correct | Correct | ✅ | P1 | export24 |
| 185 | PNG/JPG scales | Offered | Offered | ✅ | P1 | export24 |
| 186 | SVG choice | Offered | Offered | ✅ | P1 | export24 |
| 187 | PDF renderer | Correct | Correct | ✅ | P1 | export24 |
| 188 | Export icon button | Present | Present | ✅ | P2 | export24 |
| 189 | Suffix default | Correct | Correct | ✅ | P2 | export24 |
| 190 | Copy-link | Works | Works | ✅ | P1 | export24 |
| 191 | SVG emitter | Lossless | Lossless | ✅ | P1 | export24/codegen |
| 192 | Re-import | Round-trips | Round-trips | ✅ | P1 | export24 |
| 193 | Scrolled slice | Correct | Correct | ✅ | P2 | export24 |
| 194 | Redo preservation | Preserved | Preserved | ✅ | P1 | history25 |
| 195 | First-cmd undo | Clean | Clean | ✅ | P1 | history25 |
| 196 | Burst coalescing | Real entry | Real entry | ✅ | P0 | history25 |
| 197 | History guards | No crash | No crash | ✅ | P2 | history25 |
| 198 | Resweep on new cmd | Correct | Correct | ✅ | P2 | history25 |
| 199 | Mid-sweep wheel | Handled | Handled | ✅ | P1 | history25 |
| 200 | First-entry redo | Works | Works | ✅ | P1 | history25 |
| 201 | Ctrl+Y redo | Redoes | Redoes | ✅ | P1 | keyboard26 |
| 202 | ⌘I italic | Toggles | Toggles (+model) | ✅ | P1 | keyboard26 |
| 203 | macOS dead-key chords | Work | Guarded | ✅ | P1 | keyboard26 |
| 204 | `/` + `⌥/` | Del stroke/fill | Shipped | ✅ | P1 | keyboard26 |
| 205 | Text-edit chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 206 | Type-tool guard | Guarded | Guarded | ✅ | P2 | keyboard26 |
| 207 | Vector chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 208 | Layer chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 209 | Pixel-zoom climb | Climbs | Climbs | ✅ | P2 | keyboard26 |
| 210 | Grid chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 211 | Align chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 212 | Distribute chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 213 | Show/hide UI | Per article | Fixed | ✅ | P2 | keyboard26 |
| 214 | Boolean chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 215 | Layer-list chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 216 | Menu arrows + Esc | Nav + safe Esc | Fixed | ✅ | P1 | keyboard26 |
| 217 | Library/asset chords | Bound | Bound | ✅ | P2 | keyboard26 |
| 218 | Shortcut sheet | Matches bindings | Audited | ✅ | P2 | keyboard26 |

## 8. Micro-interaction matrix (§38)

Audited = traced in source + headless-tested unless noted. "Live-pointer" rows could not be physically
exercised (no browser) — code path verified, feel NOT VERIFIED.

| # | Micro-interaction | Audited | Verdict |
|---|---|---|---|
| 1 | Hover prelight on canvas objects | Yes | ✅ matches (selection6/parity) |
| 2 | Selection ring color/weight by type | Yes | ✅ verified parity (§5) |
| 3 | Resize handle cursors (8-pt aware) | Yes (traced) | ✅ code-verified; feel NOT VERIFIED |
| 4 | Corner rotate zone (6–22px) | Yes | ✅ re-verified in source this session |
| 5 | Snap indicator lines while drag/resize | Yes | ✅ guides snap (G-004) |
| 6 | Arrow nudge / ⇧×10 | Yes | ✅ + coalesced undo (G-001) |
| 7 | Numeric scrub (fields + ⌥-scrub) | Yes | ✅ F-009, T-004, IN-005 |
| 8 | Equation entry in fields | Yes | ✅ T-003 |
| 9 | Frame quick-add badges | Yes | ✅ F-008 |
| 10 | Guide create/drag/delete/select | Yes | ✅ G-000, G-002 |
| 11 | Gradient stop drag/insert/delete | Yes | ✅ P-007, P-008 |
| 12 | Join/effect hover previews | Yes | ✅ K-003, L-006 |
| 13 | Mask outlines view | Yes | ✅ M-002 |
| 14 | Crop handle drag + commit | Yes (traced) | ✅ code-verified; feel NOT VERIFIED |
| 15 | Baseline trim indicators | Yes | ✅ textLayout verified |
| 16 | Vector hover/insert/bend/⌥-pull | Yes (traced) | ✅ code-verified; feel NOT VERIFIED |
| 17 | Layers-panel hover + reveal | Yes | ✅ S-003, L-005 |
| 18 | Lock grey-out + enforcement | Yes | ✅ L-001 |
| 19 | Menu checkmarks/disabled reasons | Yes | ✅ MN-004 |
| 20 | Toast feedback wording | Yes | ✅ MN-004, L-008 |
| 21 | Zoom % readout + climb | Yes | ✅ N-001, KB-009 |
| 22 | Present transitions/overlays | Yes (traced) | ✅ code-verified; motion NOT VERIFIED |
| 23 | Inline rename commit/cancel | Yes | ✅ L-006, L-007 |
| 24 | Fold chevrons + ⌥-fold | Yes | ✅ L-004 |
| 25 | Asset/search filter | Yes | ✅ search verified |
| 26 | Distribute/wrap badges | Yes | ✅ AL-010 |
| 27 | Mixed-state "Mixed" labels | Yes | ✅ IN-001 |
| 28 | Cursor per tool/mode | Yes (traced) | ✅ code-verified; pixels NOT VERIFIED |

## 9. Remaining known issues (not fixed)

1. **Rotation-sign convention (P1, §7 T-DEV).** Sign of canvas rotation vs Figma unverified; needs a
   Figma-side comparison. Recorded in ledger §7 Deferred.
2. **Locked-layer patch whitelist (P1, §20 deferred hole).** A generic patch path can still touch locked
   layers without going through the L-001 guard. Needs a whitelist at the patch entry point.
3. **Tidy-up gap readout (P2, §20).** No surface shows the tidy gap value; engine computes it.
4. **E2E NOT VERIFIED.** `e2e/behaviour.mjs` exists and is wired (`npm run test:e2e`) but cannot run here:
   no Chromium, provisioning blocked (see §2). Must run in CI/with a browser.
5. **Live-pointer feel NOT VERIFIED** for drag/cursor/motion rows (§8): code paths verified, physical feel
   needs a browser session.

## 10. Out-of-scope capabilities recorded (condensed; full lists in ledger Deferred)

Smart Selection; view-only chrome; minimap drag; multiplayer cursors; guide styles/presets; pattern/video
fills; brush/dynamic strokes; gradient/image/blend stroke fills; progressive blur; GIF animation; TIFF decode;
image strokes; text-on-path; multi-edit; rich runs; % leading; underline details; list spacing; OpenType;
vertical trim; hanging punctuation; font links; spellcheck; missing-font flow; multi-point bbox; lasso select;
vector cut; variable-width subtool; per-point caps; drag-across toggles; mixed lock semantics; batch rename;
push-to-main; per-layer modes; variable scopes/descriptions/groups/search/syntax/publish; duplicate
variable/collection/mode; nested bindings; tidy readout surface; annotation tools; Figma Draw; multi-flow
prototype; prototype cardinality/combos/direction/backdrop/background/collapse; video in prototype; export
overlap render; text trim in export; zip export; DPI settings; vector PDF; video export; 144dpi import; slice
icons; whole-file export; undo labels; version history; ⌘J join; paint bucket; AI bar; versions chord;
libraries chord; box-select tool. (≈60; tidy-up and italic were superseded — shipped in §20/§26.)

</details>
