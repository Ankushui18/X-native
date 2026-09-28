# Figma "Create designs" vs X-Native — living comparison

**Source of truth:** <https://help.figma.com/hc/en-us/sections/4403912808599-Create-designs>
(the *Create designs* section: 8 sub-sections, 70+ articles, retrieved 2026-09-28).
**Compared against:** the **product UI**, `X-Native/apps/web` (React + the TypeScript
document engine), plus the Rust crates where a claim is about them.

**Supersedes:** the previous revision of this file (2026-09-15), which compared the
*retired* native `apps/x-designer` chrome. That material is preserved in
`X-Native/docs/FIGMA_PARITY_MASTER_LIST.md` and the `AUDIT_2026-09-*` files.

### How to read a row — and how its status was obtained

| provenance | meaning |
| --- | --- |
| **measured** | in this session I opened the file, found the symbol named, and — where a test is named — found that test. The strongest claim this file makes. |
| **carried §N** | the status is taken from `X-Native/docs/FIGMA_PARITY_MASTER_LIST.md` §N (or the audit file named), which is the repository's own verified record. **It is a recon task, not a settled fact** — the same rule that file applies to its own *verify* rows. |

Statuses are `MATCH` · `PARTIAL` (divergence spelled out) · `MISSING` · `EXTRA` (ours,
beyond Figma) · `OUT`. `MATCH` is claimed only where a test exists.

---

## The pipeline — one feature at a time

Every feature audit runs these eight steps, in order, and leaves its evidence here:

1. **Figma documentation** — the article id and the sentence that defines the behavior.
2. **This file** — the row, updated as the living record.
3. **X-Native audit** — read the TS/Rust implementation and *measure* it (a probe or a
   test that prints the current numbers); a plausible-looking function is not evidence.
4. **Missing behavior** — the deviation as *Figma value vs ours*, with the measurement.
5. **WASM API / Editor command** — what the fix needs: a new command, a changed one, or
   nothing. **The Rust geometry guard stays intact for any operation without recorded
   30/30 generated-WASM parity**; such a fix lands on the TypeScript side only and says so.
6. **Inspector / Toolbar / Canvas** — the surface a person uses, and what changes there.
7. **Integration test** — new tests under `apps/web/src/{engine,ui}/__tests__`, wired into
   `npm test`, with the rest of the suite left green.
8. **Checklist** — the row here and the matching row of
   `X-Native/docs/FIGMA_PARITY_MASTER_LIST.md`.

### Pipeline run 1 — Auto layout · text baseline alignment ✅ (2026-09-28)

| step | result |
| --- | --- |
| 1 · Figma docs | *Use the horizontal and vertical flows in auto layout* ([31289464393751](https://help.figma.com/hc/en-us/articles/31289464393751)) §"Text baseline alignment": *"A baseline is the invisible line in which text or a layer sits."* … *"such as when aligning baselines of text layers with varying font sizes, or when aligning an icon with a text layer."* … *"the bottoms of the icon and the word home are aligned on the red line."* Plus *Use auto layout with CSS Flexbox in mind* ([42031586813719](https://help.figma.com/hc/en-us/articles/42031586813719)): auto layout "mirrors how the web renders layouts" — i.e. `align-items: baseline` semantics. |
| 2 · Living record | §7.11 of the master list; the Auto layout rows below. |
| 3 · Audit (**measured**) | `apps/web/src/engine/memory.ts` gave a text a baseline of `fontSize × 0.8` and **every other layer** `h × 0.8`. Probe (48px icon + 14px text, `align: "baseline"`): icon `y = 0`, text `y = 27.2`, hug `h = 48` — so the shared line was the icon's 0.8-height, not its bottom. A wrapped baseline row top-aligned every line (no baseline at all). A frame switched to a vertical flow kept `align: "baseline"` in the model while the panel offered no such control. |
| 4 · Deviation | **D1** a layer without text must synthesise its baseline from its **bottom** edge (Figma's icon example; CSS flexbox), ours used `h × 0.8`. **D2** a baseline row's cross size must be `max baseline-above + max descent-below`, ours was `max(h)`, so a hug clipped the descenders (measured: 48 vs the correct 56.8). **D3** each wrapped line must align on its own baseline; ours were top-aligned. **D4** the stored layout could disagree with the alignment box. |
| 5 · Command / WASM | **None needed** — this is the TypeScript layout pass behind the existing `autoLayout` command. No geometry crosses the WASM boundary, so **no guard was touched** and no Rust file changed. |
| 6 · UI / Canvas | The inspector's alignment box already offered baseline for horizontal flows only (`B` toggles it, `Nine` in `ui/inspector.tsx`); the fix makes the engine agree (D4). The canvas needed no painter change: it draws the positions the layout produced. |
| 7 · Tests | `apps/web/src/engine/__tests__/baselineAlignment.test.mjs` — **32 passed**; `apps/web/src/ui/__tests__/baselineAlignment.dom.test.mjs` — **16 passed**; both wired into `npm test`, whole suite green (2790 `ok`, 0 failed suites). |
| 8 · Checklist | §7.11 of the master list updated with the rule, the single owner (`layout.ts::{childBaseline, baselineRow, effectiveCrossAlign}`, `memory.ts::normalLayout`) and the two tests. No scoreboard move: the row was already claimed `MATCH` and is now actually tested. |

**Residual, recorded rather than hidden:** the engine has no font tables, so a text
baseline stays the documented ratio `fontSize × TEXT_BASELINE_RATIO (0.8)` from the box
top, not the loaded font's true ascender. The shape rule now matches Figma/CSS; the text
rule is an approximation, and the Rust engine
(`crates/x-core/src/auto_layout.rs::child_baseline` — `h * 0.72 * 0.8` for text, `h` for a
shape) still differs from it for text. A font-metric-exact rule needs a metrics source in
the engine and is its own task.

### Pipeline run 6 — Create and edit layers · Masks: the reach stops at clip content ✅ (2026-09-28)

| step | result |
| --- | --- |
| 1 · Figma docs | *Masks* ([360040450253](https://help.figma.com/hc/en-us/articles/360040450253-Masks)), the third stopping rule: *"Masks are positioned below masked layers on the z-axis. The mask applies to all siblings above it until it reaches: Another mask or mask object / The mask's parent frame or group / **A frame or component with clip content on**."* Secondary sources agree on the consequence, and that the frame itself is outside the mask: *"A mask will clip every element that doesn't have \"Clip Contents\" turned on. Once it reaches one with it, it stops"*, and *"masking a frame directly gets blocked by its own setting … Turn off Clip content on that frame"*. |
| 2 · Living record | the **Masks** row below; master list **11.13** |
| 3 · Audit (**measured**) | Probe against `engine/paint.ts::partitionMaskRuns` and the mounted canvas (deleted after use). Every boundary kind was swallowed into the masked run: `[mask, Small, clipFrame, Above]` → one run `mask(Mask):[Small, Clipped frame, Above]` — the same for a frame with clip content **off**, a group, a component with clip on, an instance with clip on and a scroll frame, i.e. the rule was not implemented at all. In device pixels over the page's white fill (the frame's fill is `#1f2937` = r31, the layer's blue `#3b82f6` = r59): the clipped frame's own fill read **r=255 g=255 b=255** at (180,30) and the layer above it **r=255** at (130,20) — both punched out. The layers panel badged all three rows (`Above`, `Clipped frame`, `Small`). Already right: the mask still clipped what sat between it and the boundary ((20,70) in the mask's window r=59, (75,70) past its ink r=255), a mask inside a clipped frame still clipped its own siblings while its parent's sibling was untouched ((170,25) r=255 vs (210,15) r=59), and a frame with clip content off let the reach through (both r=255). |
| 4 · Deviation | **D1** `partitionMaskRuns` had no clip-content boundary: a mask's run continued through *any* sibling, so a frame that clips content — the article's hard stop — was itself masked and dragged everything above it under the mask. Measured vs Figma: `mask(Mask):[Small, Clipped frame, Above]` where Figma gives `mask(Mask):[Small] \| plain:[Clipped frame, Above]`. **D2** the pixels followed: the clipped frame's fill and the layer above it were both punched to transparent white at (180,30) and (130,20), where Figma paints them (r31 and r59). **D3** the layers panel put the masked-layer arrow on the boundary row and on every row above it. |
| 5 · Command / WASM | **No new command** — the painter's partitioning and the panel's walk. **TypeScript only: no Rust file changed, the WASM boundary and the geometry guard were not touched.** |
| 6 · UI / Canvas | `paint.ts::stopsMaskReach` is the single owner of the rule (a frame/component/instance whose `overflow` is not `visible`), and `partitionMaskRuns` closes the masked run at it: the boundary node and everything above it open a plain run, so `paintMaskedRun` is never entered for them and no `destination-in` composite, run clip or mask tile can reach them; an empty masked run is dropped, which also stops a reach-less mask from drawing a green outline around nothing. `chrome.tsx::withMaskedBelow` clears its `seenMask` at the same predicate, so the arrow stops on the same row the canvas does. |
| 7 · Tests | `apps/web/src/ui/__tests__/maskReach.test.mjs` — **22 passed**, wired into `npm test`. The software Canvas2D both mask tests share now lives in `apps/web/src/ui/__tests__/softCanvas2d.mjs` (extracted from run 5's file, whose 33 assertions still pass unchanged: same names, same order). The test covers the predicate (frames/components/instances that clip stop it; a frame with clip off, a group and a clipped rect do not), the run shapes (the boundary outside the mask, empty runs dropped, a boundary below the mask irrelevant, a boundary between two masks), the device pixels of the four cases above, and the panel arrows. Verified load-bearing: with the partition rule disarmed **9 assertions fail** (7 engine + 2 pixel), with the panel walk disarmed **2 fail**. Whole suite **2918 passed, 0 failed** (2,896 + the 22 here); `tsc -b` clean. |
| 8 · Checklist | the **Masks** row below keeps MATCH and now names `maskReach.test.mjs`; master list **11.13** carries the rule and both tests. No scoreboard move: the row was already MATCH — the residual was not a row-level gap. |

**Residual, recorded rather than hidden:** run 5's residual (2) is closed by this run and struck
from the list. Still open, unchanged: the enormous-run tile cap falls back to a hard geometric
clip, and the mask-type dropdown has no hover-to-preview. One boundary is worth naming: this
engine's frames default to `overflow: "clip"` (Figma now ships new frames with clip content
*unchecked*), so a default-clipping frame ends a mask's reach here where Figma's default would
let it continue. The rule implemented is Figma's; the default is this engine's, and changing it
would move every frame in every existing document.

### Pipeline run 5 — Create and edit layers · Masks: per-pixel alpha and the mask indicators ✅ (2026-09-28)

| step | result |
| --- | --- |
| 1 · Figma docs | *Masks* ([360040450253](https://help.figma.com/hc/en-us/articles/360040450253-Masks)). Alpha: *"When working with alpha masks, masks are applied based on the opacity of the mask. The higher the opacity, the more that is revealed. Zero percent opacity reveals nothing. This means we can utilize blurs and opacity in our masks: … Use layer blur effects to replicate feathering … Add fills, strokes, and gradients with varying opacity."* Vector: *"If a mask contains any area with an opacity of more than zero percent, then its outlines are used as the mask and the entire mask assumes 100% opacity."* Luminance: *"The brighter the area of a mask, the more that is revealed."* The panel: *"the mask icon identifies the mask, with an upward-facing arrow along the layers that are being masked."* The view setting: *"Once the setting on, masks in your file are outlined in green. Note: If all layers being masked are hidden or have zero percent opacity, then the object's mask outlines won't appear."* Removing one: *"To stop using an object as a mask … Right-click the mask and select Remove mask."* |
| 2 · Living record | the **Masks** row below; master list **11.13** |
| 3 · Audit (**measured**) | Probe against the mounted canvas (deleted after use): a 100px gradient mask (alpha 1 → 0 left to right) over an opaque 100px child. Already right: the mask paints into its own device-resolution tile and every masked child is punched with `destination-in` — the mask tile's fill was the 7-stop OKLab ladder `#ffffffff → #c8c8c8d5 → #949494aa → #63636380 → #36363655 → #0f0f0f2a → #00000000`, so per-pixel alpha was in place; alpha masks skip the `getImageData` reduction (0 calls, no binarising), a layer blur on the mask reaches the tile (`filter = blur(12px)`), luminance reduces once, and vector stays binary. Wrong, measured: **(a)** the revealed ramp was read **6 device px off** — coverage at x = 5 / 25 / 50 / 75 / 95 px was **0.000 / 0.806 / 0.556 / 0.306 / 0.102** where the mask's own alpha is 0.95 / 0.75 / 0.50 / 0.25 / 0.05, because the mask raster was composited with `drawImage(mc, 0, 0)` at natural size while the run box it covers starts at `(-6, -6)` (its padding); **(b)** with *View → Mask outlines* on, the green `#00c853` stroke was issued to the **mask tile** (1 stroke on a tile, **0 on the canvas**), so the setting had no visible effect at all *and* its alpha widened the mask by the stroke width; **(c)** that outline was painted even when every masked layer was hidden, and again when every one sat at 0% opacity; **(d)** the layers panel's arrow sat on the row *below* the mask — the Figma arrangement (mask below its content) showed **no arrow anywhere**, while a mask above its content (which masks nothing) badged the content row; **(e)** ⌃⌘M and the context row never toggled a mask off (`isMask` was still `true` after a second run) and the row read "Use as mask" while the layer *was* a mask; **(f)** `partitionMaskRuns([mask, clippedFrame, rect])` still applied the mask to a sibling frame with clip content and, through it, to the layer above it. |
| 4 · Deviation | **D1** the mask's alpha was sampled at the run box's padding offset, so a soft mask read the neighbouring pixel and the mask bled past its own box (Figma: masks are applied by the mask's own opacity, per pixel). **D2** *Mask outlines* was painted into the mask tile instead of the canvas, so the article's green outline never appeared and it perturbed the mask it marked. **D3** the article's note — no outline when all masked layers are hidden or at zero opacity — was not implemented. **D4** the masked-layer indicator was on the wrong rows and pointed down-right (`↳`) instead of up. **D5** `useAsMask` was one-way: no way to remove a mask from the shortcut or the row, and no "Remove mask" label. |
| 5 · Command / WASM | **No new command**: the toggle reuses the existing `patch` command (`{ isMask }`). **TypeScript only: no Rust file changed, the WASM boundary and the geometry guard were not touched** — the run is `ui/Canvas.tsx`, `ui/chrome.tsx` and `ui/ContextMenu.tsx`. |
| 6 · UI / Canvas | `Canvas.tsx::traceNodeShape` (the layer paint's tracer, extracted so the outline cannot drift from the shape a mask paints) now draws the outline **on the canvas** in `strokeMaskOutline`, gated by the article's note and by the mask-tile flag, so the mask's own alpha stays clean; the mask raster is composited with `drawImage(mc, ox, oy, ow, oh)` — the same rect the punched tile is blitted with, which is what makes the soft edge land where the mask is. `chrome.tsx::withMaskedBelow` marks the rows **above** a mask (the ones the canvas clips) with an upward arrow beside `Icon name="mask"`; `ContextMenu.tsx` reads `caps.mask` for the row's label and `runMenu(engine, "useAsMask")` toggles. |
| 7 · Tests | `apps/web/src/ui/__tests__/maskAlpha.test.mjs` — **33 passed**, wired into `npm test`. It runs against a small software Canvas2D inside the test file (rect paths, linear gradients, `globalAlpha`, `source-over` / `destination-in`, scaled tile blits, `getImageData` / `putImageData`), so the edge is measured in pixel alpha, not inferred from a call log: the gradient mask reveals a monotone ramp (a(5px) ≈ 0.95, a(95px) ≈ 0.05) with ≥ 40 pixels in the 0.05–0.95 band and a worst deviation of 0.06 from the mask's own opacity, the same gradient as a **vector** mask is binary, luminance follows brightness, a mask at 0% opacity reveals nothing, the blur reaches the mask tile, the three outline cases (on / all hidden / all at 0%), the panel arrows, and the ⌃⌘M toggle. Verified load-bearing: reverting the blit to `(0, 0)` fails 5 assertions, dropping the outline note fails 2, and the old panel walk fails the row-marking one. Whole suite **2896 passed, 0 failed** (2,863 + the 33 here); `tsc -b` clean. |
| 8 · Checklist | the **Masks** row below moved PARTIAL → MATCH; master list **11.13** moved PARTIAL → MATCH and names the web canvas owner and the test; the scoreboard moved with it (341 rows / **288 MATCH** / 33 PARTIAL). |

**Residual, recorded rather than hidden:** (1) the run box's tile cap (8192 px a side, 16.7M px) still falls back to `paintGeometricMask`, a geometric hard clip, so an enormous mask degrades to a binary edge (its outline is now drawn there too); (2) the article's third stopping rule — the mask's reach ends at *"a frame or component with clip content on"* — was closed in run 6 (see the run-6 section above); (3) the mask-type dropdown has no hover-to-preview (*"Hover over any option to preview it on the canvas"*); (4) the mask-icon half of the panel indicator was already right (`Icon name="mask"` on the mask row), and the arrow now matches the article's direction.

### Pipeline run 4 — Create and edit layers · Arc tool: canvas arc handles ✅ (2026-09-28)

| step | result |
| --- | --- |
| 1 · Figma docs | *Arc tool: create arcs, semi-circles, and rings* ([360040450173](https://help.figma.com/hc/en-us/articles/360040450173-Arc-tool-create-arcs-semi-circles-and-rings)): *"When you hover over the circle, a single handle will appear on the right-hand side. This point (0) determines where you can begin to create an arc."* … *"Click and drag the Arc handle up or down to change the sweep."* … *"Now there will be three handles shown: The **Sweep** … The **Start** handle (which has a dot inside it) indicates where the arc begins … you can drag this around the circle to change the position of the ring. The **Ratio** handle at the center of the circle allows you to change the circle to a ring."* The worked example: *"Drag the Sweep handle to make a pie. Drag the Ratio handle to the desired size for the ring. Drag the Sweep handle back to meet the start position, to close the ring."* |
| 2 · Living record | the **Arc tool** row below; master list **2.14** (Arc handles) |
| 3 · Audit (**measured**) | Probe against the mounted canvas (deleted after use), 100px circle at 0,0, zoom 1. Working already: a selected circle paints one Sweep dot at (100, 50) — the article's right-hand side — and dragging it to the bottom edge sets `endingAngle` 0 → 90°; an arc with `innerRadius` 0.5 paints a second dot at (75, 50) and dragging it out gives `innerRadius 0.74`. Missing, measured: an arc with `startingAngle 90°, endingAngle 360°, innerRadius 0.5` painted only `sweep@(100,50)` and `ratio@(75,50)` — **nothing at the start point (50, 100)** — and dragging that point left to (0, 50) left `startingAngle` at 90° while running the box's bottom-middle resize (**h 100 → 50**). A pie (start 0°, end 270°, ratio 0) painted one dot (`sweep@(50,0)`); pressing its **centre** and dragging moved the whole ellipse (**+25, 0**) with `innerRadius` still 0, so a ring could only be made from the inspector. Hovering an unselected circle painted nothing (`dots=[]`, cursor default). Undo: an arc drag then a move drag, **one undo reverted both** (`endingAngle 270°` gone and the position 30,30 → 0,0). |
| 4 · Deviation | **D1** no Start handle: Figma's third control ("which has a dot inside it") had neither a dot nor a hit-test, and its position was owned by a resize handle, so a user dragging it resized the ellipse. **D2** the Ratio handle existed only once `innerRadius > 0`, so the article's pie → ring gesture was unreachable on canvas. **D3** the hover affordance ("when you hover over the circle, a single handle will appear") did not exist: only a selected ellipse showed controls. **D4** the arc drag never dispatched `end` (it was missing from the on-up list), so its undo step leaked into the next gesture. |
| 5 · Command / WASM | **No new command** — the three drags patch `arcData` through the existing `patch` command (`engine/types.ts`). **TypeScript only: no Rust file changed, the WASM boundary and the geometry guard were not touched.** |
| 6 · UI / Canvas | `Canvas.tsx::arcHandlePoints` is now the one owner of the three controls (Sweep at the arc's end; Start at `startingAngle` once a gap exists; Ratio at `endingAngle × innerRadius`, which is the centre of a pie), used by both `paintArcHandles` and the pointer path, so the dot a user sees is the dot the pointer grabs. The set paints on **hover** for an unselected ellipse (with the node's rotation transform) and in the selection pass for a selected one; the Start dot draws the article's dot inside it. The press takes an arc dot ahead of the box's resize handles, selecting the layer first when it was only hovered; the move handler gained a `start` branch (same angle maths as the sweep, ⇧ snapping to 15°), and `arc` joined the on-up `end` list so the drag closes its own undo step. |
| 7 · Tests | `apps/web/src/ui/__tests__/arcHandles.test.mjs` — **22 passed**, wired into `npm test`: the painted sets (one dot for a circle, three for an arc, the dot-inside on Start, the Ratio dot at a pie's centre), the three drags (`endingAngle 90°`, `startingAngle 90° → 180°`, pie → `innerRadius 0.5`), Shift snapping, the hover handle making an arc on an unselected circle, the undo step (verified to fail without the on-up fix), and the two move regressions. Whole suite **2863 passed, 0 failed** (2,841 + the 22 here); `tsc -b` clean. |
| 8 · Checklist | the **Arc tool** row below moved PARTIAL → MATCH; master list **2.14** (already MATCH) now names the web canvas owner and the test. No scoreboard move: 341 rows / 287 MATCH as recorded in run 3. |

### Pipeline run 3 — Work with layers · Smart selection: equal-gap dragging ✅ (2026-09-28)

| step | result |
| --- | --- |
| 1 · Figma docs | *Arrange layers with Smart selection* ([360040450233](https://help.figma.com/hc/en-us/articles/360040450233-Arrange-layers-with-Smart-selection)): *"To make a Smart selection, all layers must be an equal distance apart and overlap on either the x or y axis (1D) […] When you hover over your Smart selection, additional pink handles will appear between each layer. These handles allow you to adjust the vertical or horizontal spacing between layers."* … *"Click and drag the handle to adjust the space between layers. A tooltip above your cursor shows the current space between layers, in pixels."* Right/down grows the space, left/up shrinks it; the article's own summary lists the point of the tool as *"uniformly adjust the vertical and horizontal spacing between layers"*. |
| 2 · Living record | the **Smart selection** row below; master list **5.15** (new row, scoped to the handle drag). |
| 3 · Audit (**measured**) | Probe against the mounted canvas (deleted after use). Three 100px squares at x = 0 / 120 / 240 (gaps 20/20), all three selected: `snapping.ts::equalGaps` already measured the run — but only **as feedback while a layer drags**, and `GapBadge` was paint-only: no pointer handler anywhere hit-tested a badge. A press on the badge point therefore fell through to the ordinary canvas press: measured, the press at (110, 50) **cleared the selection** (`[]`) and the drag left the layers at **0 / 120 / 240** — no gap change at all. A move drag of a selected square moved the selection (10 / 170 / 330), which is correct and unchanged. The engine's `distribute` re-splits a span evenly (baseline: 0 / 160 / 320) but pins both outer layers and cannot express "grow the gaps to this value". |
| 4 · Deviation | **D1** the run's badges were feedback-only — pressing one started a marquee, so equal-gap *dragging* did not exist, while Figma's sentence is "click and drag the handle to adjust the space between layers" with every gap in the run moving together. Nothing else moved: the 1D detection, the badge positions and the move-snapping pills already matched. |
| 5 · Command / WASM | one new TypeScript command, `distributeSpacing { ids, axis, gap }` (`engine/types.ts`, `engine/memory.ts`): it sorts the run on the axis, anchors it at its first layer and re-places each following layer at `size + gap`, so the space grows away from the handle in the direction dragged with order and sizes untouched, skipping locked layers and instance members exactly as `distribute` does. **No geometry crosses the WASM boundary — no Rust file changed and the geometry guard was not touched.** |
| 6 · UI / Canvas | `snapping.ts::smartSelectionGaps` (new, exported) is the one owner of "is this run a 1D smart selection": the boxes must share a cross-axis band and every gap must be equal (≥ 0.5; a drifting gap fails the run), and it returns one `GapBadge` per gap — the shape the move-snapping feedback already painted. `Canvas.tsx` keeps them in `smartGaps`, recomputed from the snapshot so a nudge that breaks the equality removes the handles, paints one pink pill per gap at rest (the article's pink handles) and hit-tests them in the multi-selection press path (10px, before the marquee fall-through). The press starts a `smartGap` drag whose move dispatches `distributeSpacing`; ⇧ steps by the Big nudge, the value clamps at 0, the pill shows the live value, and the drag closes with the same `end` as every other handle. |
| 7 · Tests | `apps/web/src/ui/__tests__/smartSelection.test.mjs` — **26 passed**, wired into `npm test`: the detector (equal row and column, unequal run, touching layers, missing cross overlap, a pair), the command (gap 60 → 0/160/320; a negative gap clamps to 0), and the mounted-canvas drags — a 40px drag of the middle handle turns gaps 20/20 into **60/60** and moves every layer in the run (0/160/320), a left drag clamps at **0/0**, ⇧ steps by the Big nudge (50/50), a column adjusts the vertical space, a run that drifts loses its handles, and a press on a layer itself still just moves the selection. Whole suite **2841 passed, 0 failed** (2,815 + the 26 here); `tsc -b` clean. |
| 8 · Checklist | master list **5.15** added (`MATCH`, test named) and the scoreboard moved with it (341 rows, 287 MATCH / 34 PARTIAL). The article's other half — the Tidy up tool that *creates* equal spacing from an unequal run, the per-object pink rings, the sidebar "space between" fields and the ⌘-swap reorder — stays recorded as the §5.9 remainder. |

### Pipeline run 2 — Auto layout · fill children use the border-box model ✅ (2026-09-28)

| step | result |
| --- | --- |
| 1 · Figma docs | *Use auto layout with CSS Flexbox in mind* ([42031586813719](https://help.figma.com/hc/en-us/articles/42031586813719)), section **"Children set to fill container now use the border-box model"**: *"Previously, children set to fill container would evenly occupy the available space—the length of space minus padding, gap, and strokes. … In the new version, Figma distributes space amongst fill container children by the children's content area instead of by their size, matching the CSS border-box model. A layer with a thicker stroke will take up slightly more of the available width or height, so that its inner content area matches its sibling's."* The same article carries the two neighbouring rules this run checked: padding always gets its room (*"that same frame can't be narrower than 60px"*), and only inside strokes count (outside and center strokes are CSS outlines and never do). |
| 2 · Living record | the **Flexbox parity rules** row below; master list **7.7** (Sizing per axis) |
| 3 · Audit (**measured**) | Probe against `layout.ts::fillPatch` + `memory.ts::computeAutoLayout` (deleted after use). 300px row, two fill children, the second with an 8px inside stroke → **150 / 150** (content **150 / 134**). Second child instead a frame padded 16 → **150 / 150** (content **150 / 118**). A lone filler with 30px frame padding → 240 ✓ (padding measured first). Cross fill → 100 / 100 ✓ (a stretch). Grid `fr` tracks → 150 / 150 ✓ (the article's own exact-split escape hatch). |
| 4 · Deviation | **D1** the fillers shared the *box*, so a child's own padding and inside stroke came out of its content area — the pre-CSS behaviour this Figma section replaces; the measured content areas differed by exactly the child's inset (16 and 32 above). Nothing else moved: the padding floor, a lone filler, cross stretch and grid `fr` splits already matched. |
| 5 · Command / WASM | **None needed** — `computeAutoLayout` is the TypeScript layout pass behind the existing `autoLayout` command; no geometry crosses the WASM boundary, so no guard was touched and **no Rust file changed in this run**. |
| 6 · UI / Canvas | **None** — the inspector's Fill dropdown and the canvas both read the sizes the layout produced. |
| 7 · Tests | `apps/web/src/engine/__tests__/autolayout.test.mjs`, block **AL-038-046** (10 assertions: the 142/158 and 134/166 splits, the equal content areas, the pair still filling the frame exactly, a lone filler with a center and then an inside stroke, cross stretch, grid `fr`). Whole suite **2815 passed, 0 failed**; `tsc -b` clean. |
| 8 · Checklist | master list **7.7** now names the rule, the single owner (`layout.ts::contentInset`) and the test block. No scoreboard move: the row was already `MATCH` and is now actually tested. |

**Residual, recorded rather than hidden:** the Rust pass adds only the child's *inside
stroke* back when it distributes grow children (`crates/x-core/src/auto_layout.rs:176`,
`:418` — `2.0 * inside_stroke_width()`), so a fill child that is itself a padded auto-layout
frame gets no padding term there, while the TypeScript pass now adds the child's padding
too (which is what the article's sentence says). Rust was left untouched for this run, per
the task's constraint and the geometry guard.

---

## Core features, section by section

### 1 · Create and edit layers

| Feature | Figma behavior | Ours | Status | Source |
| --- | --- | --- | --- | --- |
| Layers 101 | select, name, group, reorder, hide, lock | `engine/memory.ts` commands, `ui/LeftPanel.tsx`; `engine/__tests__/layers.test.mjs` | MATCH | measured |
| Frames | container with its own size, clip and backgrounds | `NodeKind` `"frame"` (`engine/types.ts`), `overflow`, frame tool in `Canvas.tsx`; `layers.test.mjs` | MATCH | measured |
| Frames vs groups | a group has no size of its own and never clips | `NodeKind` `"group"`; group bounds follow children; `layers.test.mjs` | MATCH | measured |
| Pencil | freehand sketch becomes editable points | `draft` state → `addPath` in `Canvas.tsx`; `vector.test.mjs` | MATCH | measured |
| Shape tools | rect, ellipse, line, arrow, polygon, star | `NodeKind`: frame, group, rect, ellipse, text, line, arrow, poly, star, vector, boolean, component, instance; `toolbar.test.mjs` | MATCH | measured |
| Arc tool | arcs, semi-circles and rings made by dragging an ellipse's arc handles | `ArcData` (`startingAngle`, `endingAngle`, `innerRadius`) on `types.ts:785`; `Canvas.tsx::arcHandlePoints` is the one owner of the three controls — **Sweep**, **Start** (with the article's dot inside) and **Ratio** — painted on hover and on selection and hit-tested ahead of the box's resize handles, the Start drag patching `startingAngle`; the inspector rows (**Sweep / Start / Inner radius**, `inspector.tsx:6451`) stay; pinned by `ui/__tests__/arcHandles.test.mjs` (22) | MATCH | measured — run 4 |
| Masks | `⌘⌥M`; alpha / vector / luminance; any layer can mask | mask flag + `maskType` (`types.ts:778-779`), `partitionMaskRuns` / `reduceMaskAlpha` (`engine/paint.ts`); **per-pixel alpha verified**: `Canvas.tsx::paintMaskedRun` paints the mask into a device-resolution tile and punches each masked child with `destination-in`, compositing the mask raster back through `drawImage(mc, ox, oy, ow, oh)` — the run box's own rect, where `(0, 0)` at natural size read the alpha 6 px off; *View → Mask outlines* strokes `#00c853` on the canvas via `traceNodeShape` only while a masked layer is visible and above 0% opacity; the reach stops where the article says it does — `paint.ts::stopsMaskReach` ends the run at *"a frame or component with clip content on"* (that frame is outside the mask, as is everything above it) and `chrome.tsx::withMaskedBelow` clears the arrow at the same predicate, so the canvas and the panel cannot drift; the layers panel puts an upward arrow on the rows **above** a mask beside `Icon name="mask"`; ⌃⌘M and the menu rows toggle ("Remove mask"); pinned by `ui/__tests__/maskAlpha.test.mjs` (33) and `ui/__tests__/maskReach.test.mjs` (22) | MATCH | measured — runs 5 and 6 |
| Sections | a section is a titled container that can hold frames | no section node type in `apps/web` (`grep section engine/types.ts` → none) | MISSING | measured |

### 2 · Work with layers

| Feature | Figma behavior | Ours | Status | Source |
| --- | --- | --- | --- | --- |
| Parent/child/sibling, reorder | drag in the layers panel, ↑↓ in the canvas | `reparent` / `reorder` in `memory.ts`; `layers.test.mjs` | MATCH | carried §5 |
| Select layers | click, ⇧-click, marquee, ⌘ deep-select | `Canvas.tsx` selection model; `ui/__tests__/canvasSelection.test.mjs` | MATCH | carried §2 |
| Alignment, position, rotation, dimensions | align row, W/H fields, rotate handle | inspector rows; `inspector.test.mjs` | MATCH | carried §6 |
| Copy and paste | `⌘C` / `⌘V` | `engine/clipboard.ts`; `keyboard26.test.mjs` | MATCH | carried §3 |
| Copy/paste properties | `⌥⌘C` / `⌥⌘V` | `copyProperties` / `pasteProperties` commands (`memory.ts:2921`, `:2964`) + `ContextMenu.tsx:261` rows with those shortcuts | MATCH | measured |
| Scale with proportions | `K`, ⇧ constrains | `tool === "scale"` handling in `Canvas.tsx:4045` and friends | MATCH | measured |
| Measure distances | hover with a selection to measure | "Live Alt/Option distance measurement state" in `Canvas.tsx:505` | MATCH | measured |
| Smart selection | drag the spacing handles *between* two objects to even the gaps | `snapping.ts::smartSelectionGaps` finds the 1D run and returns one `GapBadge` per gap; `Canvas.tsx` paints and hit-tests them at rest, and a drag dispatches the new `distributeSpacing` command so every gap in the run takes the dragged value (`ui/__tests__/smartSelection.test.mjs`, 26) | MATCH | measured — run 3 |
| Lock / hide / rename | `⇧⌘L`, `⇧⌘H`, `⌘R` | node flags + `rename`; `keyboard26.test.mjs` | MATCH | carried §3 |
| Constraints and layout guides | pin/scale per edge | `constraints` on nodes; `autolayout.test.mjs` | MATCH | carried §6 |

### 3 · Design with vector tools

| Feature | Figma behavior | Ours | Status | Source |
| --- | --- | --- | --- | --- |
| Vector networks | branching topology, T-junctions, interior faces | `VectorNetwork` + regions in `engine/geometry.ts`; `parity.test.mjs`, `vector.test.mjs` | MATCH | carried §11.17 |
| Edit vector layers | move/bend/add/remove points, mirror modes | point edit in `Canvas.tsx`; `insertPointOnPath` / `smoothHandlesForPoint` in `geometry.ts`; `setPointMirror` (1/2/3/4); `ui/__tests__/batch3.dom.test.mjs` | MATCH | measured |
| Shape builder | merge/subtract by dragging across shapes | Shape Builder → `booleanPath` | MATCH | carried §11 |
| Convert strokes to vector paths | outline a stroke | `outlineStrokeNetwork` / `outlineVariableStroke` (`geometry.ts`); `strokes.test.mjs` | MATCH | measured |
| Convert text to vector paths | outline text into editable contours | `engine/textVector.ts`; `glyphOutline.test.mjs` | MATCH | measured |
| Offset a vector path | signed offset of a filled path | `offsetPath` (`geometry.ts`); offset parity task 2B (`X-Native/docs/OFFSET_PATH_TASK2B.md`) | MATCH | measured |
| Simplify a vector path | fewer points, same shape | `simplifyPath` / `vectorCleanup` (`geometry.ts`); `vector.test.mjs` | MATCH | measured |
| Boolean operations | union / subtract / intersect / exclude, live and flattened | `booleanPath` (+ the WASM candidate under guard); `geobridge.test.mjs`, `ui/__tests__/parityReaudit.dom.test.mjs` | MATCH | carried §11.5 — the Rust candidate stays guarded |
| Flatten layers | bake the selection into one vector | `flatten`; `vector.test.mjs` | MATCH | carried §11.6 |

### 4 · Text and typography

| Feature | Figma behavior | Ours | Status | Source |
| --- | --- | --- | --- | --- |
| Create text | click for an auto-width box, drag for a fixed one | `add kind:"text"` with sizing; `typography.test.mjs` | MATCH | carried §10.1 |
| Text properties | family, weight, size, line height, letter spacing, paragraph spacing, indent | inspector typography rows; `typography.test.mjs` | MATCH | carried §10 |
| Text styles | create / apply / update / detach | style commands; `typography.test.mjs` | MATCH | carried §10.11 |
| Dimensions and resizing | hug / fixed; double-click a handle to fit | `textDimensionRule` (`layout.ts`), `ui/textLayout.ts`; `ui/__tests__/batch3.dom.test.mjs` | MATCH | carried §10.15 |
| Lists, case, decoration | bullets/numbers (`⌘⇧8`/`⌘⇧7`), upper/lower/title, underline/strike | `listStyle`, `textCase`, `textDecoration`; `typography.test.mjs` | MATCH | carried §10 |
| **Text baseline in a layout** | the first line's baseline is the font's ascent | `TEXT_BASELINE_RATIO = 0.8` in `layout.ts` | PARTIAL | measured — documented approximation; **pipeline run 1** |

### 5 · Color, gradients, images

| Feature | Figma behavior | Ours | Status | Source |
| --- | --- | --- | --- | --- |
| Fills and the colour picker | solids with opacity, mixed selections | `engine/paint.ts`, picker in `ui/FillPicker.tsx`; `fills.test.mjs` | MATCH | carried §8 |
| Gradients | linear/radial/angular/diamond as fill or stroke | gradient model + painter; `fills.test.mjs` | MATCH | carried §8 |
| Blend modes | per layer, fill and effect | `blendMode`; `effects.test.mjs` | MATCH | carried §8 |
| Images | place, adjust, crop | `engine/assets.ts` + image fills; `images.test.mjs` | MATCH | carried §9 |
| Eyedropper | sample a colour from the canvas | armed from the colour picker (`FillPicker.tsx:454`, tooltip "Eyedropper (I)") and bound to `I` in `ui/chrome.tsx:2107` | MATCH | measured |
| Patterns as a fill or stroke | Figma's repeating-pattern paint | no pattern paint type in `engine/types.ts` / `paint.ts` | MISSING | measured |

### 6 · Additional properties

| Feature | Figma behavior | Ours | Status | Source |
| --- | --- | --- | --- | --- |
| Strokes | inside/center/outside alignment, caps, joins, dashes, variable width | `engine/strokeModel.ts` + inspector stroke section; `strokes.test.mjs`, `strokeBandOracle.test.mjs` | MATCH | measured |
| Effects | drop/inner shadow, layer blur, background blur | `effects` + painter; `effects.test.mjs` | MATCH | carried §8 |
| Corner radius and smoothing | per-corner radius, iOS-style smoothing | `cornerRadii` + `cornerSmoothing`; `vector.test.mjs` | MATCH | carried §8 |

### 7 · Use auto layout

| Feature | Figma behavior | Ours | Status | Source |
| --- | --- | --- | --- | --- |
| Horizontal / vertical flows | direction, wrap, both gaps | `layout.ts` + `memory.ts::computeAutoLayout`; `autolayout.test.mjs` | MATCH | measured |
| Grid flow | columns/rows, span, `fr` tracks, automatic positioning | `planGrid` (`layout.ts`); `autolayout.test.mjs`, `parity.test.mjs` | MATCH | carried §7 |
| Resizing per axis | hug / fixed / fill, plus min/max | `hugsMain` / `hugsCross`, `fillPatch`; `autolayout.test.mjs` | MATCH | carried §7.7/7.9 |
| Alignment box | nine positions; three cross options when the gap is Auto; `B` toggles baseline | `alignmentCells` / `layoutKeyPatch` (`layout.ts`), `Nine` (`inspector.tsx`); `parity.test.mjs`, `baselineAlignment.dom.test.mjs` | MATCH | measured |
| **Text baseline alignment** | an icon's bottom sits on the text baseline; varying font sizes share one line; descenders are reserved | `layout.ts::{childBaseline, baselineRow, effectiveCrossAlign}`, `normalLayout` (`memory.ts`); `baselineAlignment.test.mjs` (32), `baselineAlignment.dom.test.mjs` (16) | MATCH | measured — **pipeline run 1** (see the residual above) |
| Padding and gap, incl. Auto spacing | between / evenly / around = CSS `space-between` / `space-evenly` / `space-around`; the gap never goes negative | `autoSpacing` + `Math.max(0, slack)` (`layout.ts`) | MATCH | measured |
| Flexbox parity rules | padding always gets its room first, only inside strokes count, fill children share space by *content area* (the CSS border-box model) | `contentInset` (`layout.ts`) is the one owner of a child's own inset; the fillers loop in `memory.ts::computeAutoLayout` shares the leftover content area and adds each child's inset back; `clampToPadding` keeps the padding floor | MATCH | measured — **pipeline run 2** (142/158 and 134/166 splits, test block AL-038-046); master list 7.7 |
| Canvas stacking | first/last on top, visual only | canvas stacking order in the painter; `autolayout.test.mjs` | MATCH | carried §7.10 |
| Auto layout suggestions | Figma proposes a layout from the arrangement | not built — deliberate non-goal (owner decision) | OUT | carried §7.16 |

---

## How to add a row

1. Pick **one** behavior a person can see, from an article in the section above.
2. Quote the sentence that defines it and put the article id in the row.
3. Measure the current implementation and write the numbers down.
4. State the deviation as *Figma value vs ours*, or say plainly that they agree.
5. Decide the command/API change. Behavior that crosses the WASM boundary may **not** be
   promoted without recorded 30/30 generated-WASM parity — fix the TypeScript side only,
   or leave the guard and say so.
6. Update the surface: inspector, toolbar, canvas interaction.
7. Add the test, wire it into `npm test`, keep the whole suite green.
8. Update the row here **and** in `X-Native/docs/FIGMA_PARITY_MASTER_LIST.md`, and add the
   run to the pipeline table at the top.
