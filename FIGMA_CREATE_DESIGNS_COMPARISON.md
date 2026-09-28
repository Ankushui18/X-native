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
| Arc tool | arcs, semi-circles and rings made by dragging an ellipse's arc handles | `ArcData` (`startingAngle`, `endingAngle`, `innerRadius`) on `types.ts:785`, painted and hit-tested in `Canvas.tsx:1398`, edited from the inspector (**Sweep / Start / Inner radius**, `inspector.tsx:6449`) | PARTIAL | measured — the values are editable, but Figma's canvas arc handles are not built |
| Masks | `⌘⌥M`; alpha / vector / luminance; any layer can mask | `maskType: "alpha" \| "vector" \| "luminance"` (`types.ts:779`) + mask flag; `layers.test.mjs` | PARTIAL | carried §11.13 — per-pixel alpha (a gradient or blurred mask clips hard), mask-outline view and the layers-panel mask glyph are not built |
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
| Smart selection | drag the spacing handles *between* two objects to even the gaps | equal-gap detection while dragging: `snapping.ts::equalGaps` + `GapBadge` | PARTIAL | measured — the badges exist; dragging them to redistribute spacing is not verified here |
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
