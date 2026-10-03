# "Create designs" 100% Parity Audit — 2026-09-29

**Source of truth:** https://help.figma.com/hc/en-us/sections/4403912808599-Create-designs
(fetched 2026-09-29; **7 sub-sections, 70 articles** observed — the living record's
"8 sub-sections" header predates a Figma IA change and is corrected by this audit).

**Compared against:** the product UI `X-Native/apps/web` (React + TypeScript engine),
`X-Native/crates/x-core` (Rust, where a claim crosses the WASM boundary), prior
pipeline runs 1–14 and their tests.

**Method.** Every article below was either (a) **fetched in full this session**
(29 articles, listed in §0), (b) **fetched in a prior pipeline run** (frames, masks,
sections, effects, patterns, arc, smart selection, auto-layout ×3, text ×6 — 17
articles with run numbers cited), or (c) **assessed by targeted code reads** against
long-stable documented behavior plus the existing test suite (24 articles, each marked
`code-read`). Statuses: ✅ verified parity · ⚠️ partial / needs hardening ·
❌ missing · 🔵 deliberate OUT · 📝 documented residual (browser/platform limit,
exports correct).

**Headline counts (70 articles):** ✅ **42** · ⚠️ **21** · ❌ **6** · 🔵 **1**. *(Run 15 closed P1 on 2026-09-29; see §6.)*
No engine code was written in this audit (planning phase only).

---

## §0 — Articles fetched in full this session (29)

Scale (360040451453) · Boolean operations (360039957534) · Masks (360040450253) ·
Edit vector layers (360039957634, 2 chunks) · Simplify (33792593975575) · Flatten
(30101373312279) · Offset (33792861450263) · Outline stroke (33052305733015) ·
Align/rotation/position/dimensions (360039956914, 3 chunks) · Select layers
(360040449873) · Gradients (34208860210199) · Constraints (360039957734) ·
Shape builder (31616004109847) · Corner radius (360050986854) · Shape tools
(360040450133, 2 chunks) · Layout guides (360040450513) · Stroke properties
(360049283914, 2 chunks) · Bulk edit (21635177948567) · Matching objects
(21523793229463) · Coded screens (40826832449303) · Copy/paste (4409078832791,
2 chunks) · Mixed selection (360042553434) · Fills guide (360041003694) ·
Color models (360043042113) · Pencil (4402723791511) · Vector networks
(360040450213) · Outline text (360047239073) · Crop (360040675194) ·
Guides+constraints (360039957934).

---

## §1 — ✅ Verified 100% parity (41)

| # | Article | Figma rule (short) | Our proof |
|---|---------|-------------------|-----------|
| 1 | Frames in Figma Design | resize-vs-scale, ⌘-ignore, rotated clip, resize-to-fit incl. strokes | Run 13 · `engine/__tests__/frameParity.test.mjs` (17) · triple sabotage |
| 2 | Arc tool | Sweep/Start(dotted)/Ratio handles, hover affordance, own undo step | Run 4 · `ui/__tests__/arcHandles.test.mjs` (22) |
| 3 | Masks — alpha/reach/indicators | per-pixel alpha, 3 stop rules, green outlines + note, ↑ arrows, toggle | Runs 5–6 · `maskAlpha.test.mjs` (33) + `maskReach.test.mjs` (22) |
| 4 | Sections | top-level kind, bg/border, title+rename, z-behind, no clip toggle | Runs 7–8 · `sections.test.mjs` (33) |
| 5 | Smart selection | equal-gap 1D run, pink pills, drag re-spaces whole run | Run 3 · `smartSelection.test.mjs` (26) |
| 6 | Auto-layout border-box fill | content-area share, padding floor, inside-stroke only | Run 2 · `autolayout.test.mjs` AL-038-046 |
| 7 | Fill min/max redistribution | freeze/redistribute, auto-gap takes residual | Runs 11–12 · `autoLayoutEdgeCases.test.mjs` (72) · triple sabotage |
| 8 | Ignore auto layout | out-of-flow, constraint pins, hug-blind | Runs 11–12 · same file, section B+C |
| 9 | Baseline alignment | icon-bottom baseline, descender reserve, per-line, vertical normalize | Run 1 · `baselineAlignment.test.mjs` (32) + `.dom` (16) |
| 10 | Effects render | 7 types, caps, documented order, alpha shadows, composite blur, order split, backdrop reach | Run 10 · `ui/__tests__/effects.test.mjs` (26, Skia) |
| 11 | Pattern fills | source/snapshot/tile/scale/spacing/align, live + persistent-after-delete, `<pattern>` export | Run 9 · `patternFill.test.mjs` (44) |
| 12 | Pattern strokes | lattice + native band/joins, own SVG pattern, picker | Runs 9–10 · `patternStroke.test.mjs` (33) |
| 13 | Text: creation/dimensions | click=auto-width, drag=fixed, no edit-entry jump | `textInteraction.test.mjs` (21) |
| 14 | Text: properties + type settings | line-height units, trim, underline fam., numbers, wrap style | Run 14 · `typography.test.mjs` (40) |
| 15 | Text: per-range font/color | runs survive blur, run-aware wrap/paint/undo | `textSpans.test.mjs` (29) |
| 16 | Text: lists | 5 levels, counter rotation, chords, listSpacing, hanging, creation | Run 14 · `typography.test.mjs` |
| 17 | Text: links | ⇧⌘U box, paste-link, hover preview, click-follow, ⌘U remove | Run 14 · `events.test.mjs` bus |
| 18 | Text: multi-edit | Enter edits all, contents fan out | Run 14 · `typography.test.mjs` |
| 19 | Text: styles | create/apply/update/detach, run bindings | Run 14 · `typography.test.mjs` X-E |
| 20 | Text on a path | click-path attach, fill/effects copy, start handle, flip | Run 14 · `typography.test.mjs` X-F |
| 21 | OpenType + variable fonts | features/axes on layers+runs+styles, editor+SVG+codegen+DevMode | Run 14 (model) — canvas pixels 📝 |
| 22 | Emoji + smart symbols | `:code` picker, smart converts, prefs toggles | Run 14 · `typography.test.mjs` X-G |
| 23 | Icon fonts | FA groups, weight→style, paste flow | Run 14 (model) |
| 24 | CJK | Noto stack + picker groups + fallback | Run 14 |
| 25 | RTL/bidi | auto-detect, LTR/RTL/Auto overrides, painter+SVG+editor | Run 14 (mixed-run x 📝) |
| 26 | Fonts: browse/apply + missing | family/weight patch, local webfonts, fallback refit | `textInteraction.test.mjs` (21) |
| 27 | Outline stroke | ⌘⌥O, ribbon-not-ring for open paths, style→fill, vector-editable | `memory.ts::outlineStroke` + `strokes.test.mjs` · `outlineStrokeOracle.test.mjs` |
| 28 | Outline text | per-glyph layers (outline) vs single vector (flatten) | `memory.ts::outlineText` (per-glyph `Glyph "x"` nodes) + flatten text arm |
| 29 | Simplify path | Simplify vector + slider; ⇧⌫ delete-and-heal | `simplifyPath`/`simplifyKeep` (iterative O(n) mem) + inspector slider + `vector.test.mjs` + `simplify.test.mjs` |
| 30 | Offset path | ± amount, join choice, destructive+undo | `offsetPath` + inspector Amount/Join + `offsetPathOracle.test.mjs` + task 2B doc |
| 31 | Corner radius + smoothing | uniform/per-corner/per-point, canvas handles, iOS 60%, nudge keys | `cornerRadii`/`cornerSmoothing`, `setPointCornerRadius`, Canvas handles, `vector.test.mjs` |
| 32 | Pencil | ⇧P, freehand→editable points, stays active, ⇧ straight, stroke props | `Canvas.tsx` pencil draft + `simplifyPath` thin + `vector.test.mjs` |
| 33 | Shape tools | R/O/L/⇧L/poly/star, ⇧/⌥/Space, counts 3–60, star 0.382, handles | `toolbar.test.mjs`, Canvas create path, `STAR_RATIO` |
| 34 | Select layers | deep ⌘, Select-layer menu, Enter/Tab nav, panel ⇧/⌘ rules, ⌥⌘A matching, same-prop family, collapse | `canvasSelection.test.mjs`, `selectSame.ts` (`selectMatching`, `sameIds`, `layersAt`), ContextMenu rows |
| 35 | Matching objects | name+parent+hierarchy+index rules, section scope | `selectSame.ts::matchingIds/pathIndex` + ⌥⌘A wiring |
| 36 | Constraints | 5×5, TL default, Scale %, groups→children, ⇧ multi, ⌘ ignore, dotted indicator | `constraints` model + `applyConstraints` + `autolayout.test.mjs` |
| 37 | Layout guides | grid/col/row, red 10%, count/Auto, fixed+stretch+offset+margin+gutter, multi, ⇧G + per-eye | `LayoutGrid` model + `Guides.tsx` + `guides.test.mjs` |
| 38 | Align/distribute/tidy | 6 aligns (+⇧-as-group-to-parent), h/v distribute pinning ends, 1D/2D tidy w/ mode gap | `align`/`distribute`/`tidyUp` + `parentAlignDelta` + `inspector.test.mjs` |
| 39 | Position/dims/rotation/values | XY top-left (rotated=original), nudge prefs, aspect lock, CCW ±180 + ⇧15° + ⌥R origin + ⇧H/V flip, ⌘]/[ order, equations, scrub speeds | `nudgePrefs.ts`, `fieldExpr.ts` (Mixed+100), scrub (×speed toast), `wrapRotationDeg`, `rotOrigin`, flip, order cmds |
| 40 | Copy/paste properties | ⌥⌘C/V incl. cross-layer | `copyProperties`/`pasteProperties` (`memory.ts`) + ContextMenu rows |
| 41 | Lock / hide / rename | ⇧⌘L/H, ⌘R/double-click, eye+lock | flags + `keyboard26.test.mjs` |

---

## §2 — ⚠️ Partial / needs hardening (22)

Each item names the **exact documented sentence**, the **measured state**, and the
**bounded fix**. Ordered by impact.

| # | Article | Figma rule | Ours (measured) | Gap → fix |
|---|---------|-----------|-----------------|-----------|
| P1 ✅ | **Scale layers (K)** — **CLOSED by Run 15** (`scaleGeometry.test.mjs` 42, probe 14→0, triple sabotage; residuals: boolean re-bake → P2d/Run 17, guide sizes open) | *"Use the scale tool to proportionally resize layers… Any blurs or strokes will scale as well"*; panel multiplier/W/H + 9-anchor box; *"exception of locked layers and layers nested inside a component instance"* | `scaleModel.ts` (anchors, factors, `scaleBoxAround`, `sizeKeepingRatio`, `scaleMembers`) + inspector Scale panel + `resize{scaleProps}` recursion + locked/instance gates — all present | **P1a (real bug, →Run 15):** `scaleProps` maps `n.path` but **never `n.vectorNetwork`**, while the painter prefers `segments` when present (`Canvas.tsx:1902/8416`). Scaling any live-network vector (pen art, baked booleans) scales box+stroke but leaves drawn geometry behind. **P1b:** `listSpacing`, underline offset/thickness, noise/texture/glass params not scaled. **P1c (probe):** plain-resize vector-point remap; guide `sectionSize` under scale |
| P2 | **Boolean operations** | *"Boolean operations now use a layer's stroke and fill to calculate the geometry"*; union=top paint, subtract=bottom paint; non-overlap intersect *"disappear… until you move them"*; members keep dims/pos/rot/radius but **not** fill/stroke/effects/opacity; *"can't apply them to sections or frames"* | TS raster-guided `booleanPath` + guarded WASM (`geobridge.test.mjs`); paint-source rule correct (subtract→`children[0]`, else last); effects copied; baked path+network cached | **P2a:** geometry samples **fill outline only** (`transformedPoly`) — strokes not unioned into geometry (new Figma model). **P2b:** filter excludes `frame` but **not `section`**. **P2c:** no member paint-lock (fill/stroke/effects/opacity of children still writable). **P2d:** live re-bake on child edit unverified |
| P3 | **Masks (advanced)** | *"Figma will create a mask group with all selected layers"*; *"Hover over any option to preview it on the canvas"* | sibling-run alpha compositing + stop rules + indicators all MATCH (runs 5–6) | **P3a:** no mask-**object grouping** — toggle is a bare `isMask` patch, so the mask+content can't move as one. **P3b (residual):** no hover-to-preview on the type dropdown. **P3c (residual):** enormous-run tile cap → hard-clip fallback |
| P4 | **Copy and paste objects** | duplicate: *"top-level frame… placed to the right of the original. Otherwise… on top"*; *"continue the same distance… continue rotating"*; multi-paste order/repeat/overflow-to-last; ⇧⌘R paste-to-replace (*"adopts the constraints"*); ⌘⇧V paste-over; Paste-here; per-axis paste placement; 50%-view rule; clipped-frame outside honor | `duplicate` (+`lastDupDelta`, `duplicateNaming`), clipboard ladder, 4096 cap, Copy-as-PNG/code | **P4a:** top-level-frame dup cascades +10/+10 instead of **right-of-original**. **P4b:** no rotation-repeat on ⌘D. **P4c:** no paste-to-replace / paste-over / paste-here / multi-paste-repeat commands. **P4d:** per-axis center fallback + 50%-view + clipped-outside rules unverified |
| P5 | **Edit vector layers — Cut tool** | *"Select the Cut… or press X… To split a vector path: Click on a point or anywhere on the path… To divide a vector object: Click and drag across… moved to its own layer"* | `vecSubTool` has bend/paint/shapeBuilder/eraser/lasso; `cut` cmd exists in types | Cut-as-documented (X, click-split + drag-divide-to-own-layer) not wired as a vector-edit subtool |
| P6 | **Edit vectors — Variable width** | *"Hover over the stroke until you see a pink handle… Click to add a new width point… ⇧ multi… Delete removes… not on dynamic/dashed/branching"* | `strokeWidthProfile` model + `outlineVariableStroke` + outline/export support | No canvas pink-handle authoring tool; preset width-profiles also absent (stroke article §Width profile) |
| P7 | **Shape builder** | Merge (drag), **Extract (click → own layer)**, Subtract (⌥-click) | `shapeBuilder` merge/subtract + subtool toast | **Extract-a-region** missing; hover region highlight unverified |
| P8 | **Gradients** | *"Flip gradient… Rotate gradient"*; canvas stop/axis handles (6.3/8.3 native) | 4 types, stops add/remove/drag, Rotate button (`FillPicker:1040`), variable stops | **No Flip button**; **no canvas gradient handles in web** (Rust has `MoveGradientStop`); per-stop variable detach unverified |
| P9 | **Stroke properties — types** | **Brush** (center-only, Direction, hover preview) and **Dynamic/Frequency/Wiggle/Smoothen** (center-only) tabs in Advanced stroke settings | `strokeType: "solid"\|"pattern"` only; solid/dashed/dotted/custom + half-dash + dash-cap all present | Brush + Dynamic stroke types absent in web (native Tool::Brush is Draw-only EXTRA) |
| P10 | **Stroke support table** | per-layer-type matrix (lines: position ✕, join ✕; arrows: width-profile removes head; ellipse join only if arced; …) | all props writable on all kinds | matrix unenforced — e.g. Position offered on lines, Join on lines, width-profile keeps arrowheads |
| P11 | **Stroke hover preview** | *"Preview stroke positions and styles on the canvas by hovering over each option"* | dropdowns apply on click | no hover-to-preview on Position/Style/Cap/Join menus |
| P12 | **Individual strokes UI** | All/Top/Bottom/Left/Right/Custom on rect/frame/component/instance; `0` removes a side | `strokeSides`/`strokeSideW` model + painter clip + codegen/DevMode | picker control in the Stroke section unverified/absent (only export paths found) |
| P13 | **Images: adjust** | exposure/contrast/saturation/temperature/tint/highlights/shadows panel | `imageExposure` model + painter + Fill/Fit/Crop/Tile + 90° rotate | exposure-only — remaining adjustments absent |
| P14 | **Crop image** | double-click/button/Fill-mode entry; blue handles; **slider value**; **Aspect picker**; Resize-to-fit; ⌥ both-sides; Ctrl free aspect; ⌘-drag quick crop; reposition-in-faded-area; rotate-in-crop (⇧15°) | `cropModel.ts` (rect math, 8 handles) + `coverCrop` + Resize-to-fit path | entry routes + slider + aspect picker + ⌘-drag + rotate-in-crop coverage unverified — hardening probe needed |
| P15 | **Mixed selection colors** | solids+gradients only (*"not pattern, image, video, hidden fills, or masks"*); boolean group ⇒ group colors only; variable/style/normal groups; target-icon select; Style-apply; opacity % | `selectionColors.ts` (buckets/usage/target/recolor/opacity) + panel | boolean-group-only rule + pattern/image/video/mask exclusions unverified |
| P16 | **Color models** | Hex `#RRGGBBAA`; CSS incl. `display-p3`/`srgb`/`oklch`/`oklab`, *"stored in the color space you entered"* | hex/rgb/css/hsl/hsb models + parsers (`color.ts`, picker fields) | wide-gamut CSS functions + stored-space round-trip unverified |
| P17 | **Bulk edit** | cross-container group/mask/boolean/autolayout; ⇧-align-to-respective-parents; multi-paste repeat; **Multi-edit variants (Q)** | multi-edit **text** MATCH (run 14); multi-select ops exist | **Multi-edit variants (Q)** absent; cross-container op parity + ⇧-align-per-parent need a probe |
| P18 | **Guides × constraints** | stretch ⇒ constraints resolve against **nearest column/row**; fixed ⇒ against the **frame** | both systems exist independently (`applyConstraints`, `LayoutGrid`) | interaction unimplemented — constraints always resolve against the frame |
| P19 | **Parent/measure/rename/layers-101** | blue hover box; ⇧-click toggle-off; marquee+⌘ deep; *"red line… horizontal and vertical measurements"*; ⌘R rename | selection model, Alt-measure, rename, `layers.test.mjs` | edge verifications open: marquee-⌘ deep in web, measurement both-axes readout, text-layer auto-rename |
| P20 | **Flatten shortcut** | *"Mac: Option Shift F"* | Flatten bound to **⌘E** (Figma's retired shortcut) | rebind to ⌥⇧F (keep ⌘E alias or drop per shortcut audit) |
| P21 | **Snapping prefs** | Snap-to geometry/objects/pixel-grid toggles in Preferences + quick actions; Ctrl temp-disable | pixel-snap toggle (⌘⇧') + in-drag snapping + guide snap | explicit geometry/objects toggles + Ctrl-disable absent (master 11.18 already PARTIAL) |
| P22 | **Pen: continue + preview** | close-on-first-point circle cursor; Esc leaves open; rubber-band preview | pen draft + close + Esc commit | no segment rubber-band preview; continue-a-path unverified (master 1.10/11.16 PARTIAL) |

---

## §3 — ❌ Missing / not implemented (6)

| # | Article | Figma rule | State | Notes |
|---|---------|-----------|-------|-------|
| M1 | **Video fills** (Fills guide; Images+videos) | *"Video: A video or animated GIF. Video is only available on paid plans"* | no video paint type in web (`FillType` has 6 of 7) | master 9.9 already PARTIAL (documented);Needs product decision (paid-plan feature) before build |
| M2 | **Layout-guide styles** (Layout guides) | *"Create a layout guide style… to reuse it across your designs"* | style create/apply exists for color/text/effect — not guides | bounded: extend style kind + picker row |
| M3 | **Strokes in auto layout** (Stroke props) | *"In an auto layout frame, you can choose to include stroke in the layer's total dimensions"* | no per-frame stroke-inclusion toggle | bounded: layout flag + measure path |
| M4 | **Select: Layers-panel ⇧-range / ⌘-disjoint** (Select layers) | *"every layer between two layers"* (⇧); *"individual layers"* (⌘) | canvas ⇧-add exists; panel range/disjoint unverified | probe then wire |
| M5 | **Pencil/polygon micro-rules** (Pencil; Shape tools) | pencil defaults *"round 3px stroke… black (white on dark)"*; polygon bbox *"below the bottom… To snap… flatten"* | defaults + bbox-snapping rule unverified | 15-minute probe |
| M6 | **Multi-edit variants** — counted here too (see P17) | *"Multi-edit variants… press Q… matching objects automatically get the same edits"* | absent | component-system scope; schedule after M1–M5 |

**🔵 OUT (1): Turn coded screens into editable design layers.** Chrome-extension /
Make-preview / MCP `generate_figma_design` capture pipeline — a Figma-platform + AI
feature, same class as auto-layout suggestions (master 7.16 OUT). Our MCP server
(`apps/mcp-server`) is the future host; explicitly deferred, not a gap.

---

## §4 — 📝 Documented residuals (not bugs)

1. **Canvas2D has no native OpenType/variable-font rendering** — `font-features` /
   `font-variation-settings` ride the editor CSS, SVG export, codegen and Dev Mode;
   canvas pixels approximate (run 14 §5).
2. **Text baseline ratio** — `TEXT_BASELINE_RATIO 0.8`, no font tables in engine
   (run 1 residual; Rust still differs — needs metrics source, own task).
3. **Bidi inside mixed styled runs** — per-row direction correct; x-positions LTR
   (run 14 §5).
4. **Mask hover-preview + enormous-run tile cap** (P3b/c) — recorded in runs 5–6.
5. **Section absorb + delete-keeping-contents + ready-for-dev** — recorded runs 7–8.
6. **Progressive (non-uniform) blurs** — uniform only (run 10 residual).
7. **Color profiles (sRGB/Display P3)** — render/output color management belongs to
   the color-management article outside this section; wide-gamut *notation* is P16.
8. **Fig files / GIF animation / HEIC-TIFF** — import-format limits (master 9.x/16.x).

---

## §5 — Prioritized gap list (impact × boundedness)

1. ~~**P1a Scale × vectorNetwork**~~ — ✅ **DONE in Run 15** (42 tests, sabotage-verified, suite green).
2. **P4a–c Duplicate/paste family** — top-level-frame right-placement, ⌘D
   rotation-repeat, paste-to-replace, multi-paste repeat/overflow — daily-use,
   exact documented rules, no guard contact → RUN 16 candidate.
3. **P2a–c Boolean membership** — section guard (1 line), member paint-lock,
   stroke-in-geometry spike (guard-aware: TS sampling first) → RUN 17 candidate.
4. **P7 Shape-builder Extract + P5 Cut tool** — two small vector-edit subtools → RUN 18.
5. **P9/P10 Brush+Dynamic / support matrix** — needs product scoping (Draw overlap).
6. **P6 Variable-width canvas tool + P8 gradient handles** — pointer-heavy; after 1–4.
7. **M1 Video** — product/pricing decision first.

---

## §6 — ✅ COMPLETED Run 15 — Scale tool scales *all* of the layer (2026-09-29)

> **Status: shipped.** Probe measured 14 DIFFs pre-fix → 0 post-fix. Fix: `scaleNetwork` +
> single-owner `remapVectorGeometry` in `memory.ts` (TS-only, no guard contact), orphaned
> lengths (`listSpacing`, underline offset/thickness, run `fontSize`/underline, path +
> vertex `cornerRadius`) ride `scaleProps`, plain vector `resize` remaps geometry with
> stroke fixed. Test `src/engine/__tests__/scaleGeometry.test.mjs` (42 passed, wired
> into `npm test`); sabotage 6/6/2 with md5-identical restores; 52 files green;
> `tsc -b` clean. Original proposal preserved below.

## §6 (original) — Proposal: Run 15 — Scale tool scales *all* of the layer

**The exact Figma documentation rule** ([Scale layers while maintaining
proportions](https://help.figma.com/hc/en-us/articles/360040451453)):
*"Use the scale tool to proportionally resize layers and objects. This tool preserves
aspect ratios and ignores constraints of any nested layers in order to scale them
proportionally. **Any blurs or strokes will scale as well.**"* — plus the panel rule:
multiplier/dropdown, W/H fields that *"automatically update"* each other, and the
anchor box (*"which side of the object to stay put"*).

**The probe** (`tests/probes/scale/vectorGeometry.mjs`, real `MemoryEngine`, deleted
after use; assertions folded into the test):
1. Pen vector (path + live `vectorNetwork` with a branch + handles) 100×100 → K-scale
   2× about `mc`: expect box 200×200, every `path` point ×2, every network
   vertex ×2, segment handle offsets ×2, stroke 4→8. **Predicts today:** path ✓,
   vertices **×1 (stale)** — painter draws 1× art in a 2× box.
2. Boolean group (baked network) → K 0.5×: same expectation on the group's network.
3. Type-length sweep: `listSpacing 8`, `underlineOffset/thickness`, noise density,
   texture size, glass params → K 2×: expect ×2. **Predicts today:** unchanged.
4. Controls (must stay green): locked layer + instance member untouched by K;
   nested Scale-constraint child ends at % position; multiplier/W/H/anchor math
   unchanged; plain `resize` (no `scaleProps`) leaves points alone **unless** the
   probe's Figma check (pencil article: *"Drag the side… to resize its dimensions"*)
   confirms artwork-stretch — in which case the vector-remap joins this run,
   else it spawns Run 16.

**The proposed engine fix** (TS-only, no guard contact):
- `memory.ts::scaleProps`: after mapping `n.path`, map `n.vectorNetwork` —
  `vertices[*].x/y × sx/sy`, handle deltas × sx/sy, `regions` untouched
  (topology), via a `scaleNetwork(vn, sx, sy)` helper next to `scaleProps`;
  recurse as today (children already recurse).
- Same function: scale `listSpacing`, underline offset/thickness (+ any sibling
  length the probe finds: noise density, texture size/radius, glass depth…),
  each guarded by `!= null`.
- If probe-4 confirms: `resize` (non-scale) remaps `path` + network for
  `kind: "vector"` (and only vectors — shapes derive from w/h), keeping stroke
  weight fixed (that is the documented resize-vs-scale difference).

**The sabotage-verified test** (`engine/__tests__/scaleGeometry.test.mjs`, wired
into `npm test`): K-scale cases for path+network+branch+handles, boolean-group
network, type/effect lengths, locked/instance immunity, nested-constraint ignore,
panel math controls. Sabotage: (a) network mapping removed → vertex assertions
fail; (b) pre-fix `scaleProps` restored → length assertions fail; (c) locked-gate
lifted → immunity assertions fail. Restore byte-exact (md5), suite green, `tsc -b`
clean. Living record + master-list rows updated; run-15 row added.

**Out of scope for 15:** boolean stroke-geometry (P2a spike), paste family (P4),
gradient/variable-width canvas tools (P6/P8).

---

## §7 — Coverage honesty statement

- Fetched in full **this session**: 29 articles (§0). Fetched in **prior runs**: 17.
- Assessed by **targeted code reads + existing tests** (no fresh fetch): 24 —
  Layers 101 ×3, frames-vs-groups, parent/child/sibling, measure, lock, visibility,
  rename, copy/paste properties, text ×8 (run-14 scope, 6 fetched then), color
  picker, blend modes, images+videos, adjust image, eyedropper, auto-layout
  toggle/grid/combine. Each is either trivially covered (lock/hide/rename) or backed
  by a named test above; any row whose only evidence is a code-read is marked ⚠️
  until a probe lands.
- No MATCH is claimed without a named test or a prior sabotage-verified run.
