# Batch 45 — Canvas / vector-editing parity audit (2026-10-04)

Scope: the seven canvas and vector-editing interactions called out as Figma
mismatches. Audited against `e33b95e` (the line numbers below are the pre-fix
positions), then fixed and covered with sabotage-verified tests.

Files read: `apps/web/src/ui/Canvas.tsx` (11 250 lines),
`apps/web/src/ui/canvasSelection.ts`, `apps/web/src/ui/canvasChrome.ts`,
`apps/web/src/ui/vectorEdit.ts`, `apps/web/src/ui/pointBox.ts`,
`apps/web/src/engine/geometry.ts`, `apps/web/src/engine/snapping.ts`,
`apps/web/src/engine/memory.ts`, `apps/web/src/engine/paint.ts`.

No architectural change: `MemoryEngine` still owns every one of these states and
every fix is a `dispatch` the engine already understands. No new WASM call was
added — see "WASM" at the bottom for why none was warranted.

---

## Summary table

| # | Target | Verdict before this batch | After |
|---|---|---|---|
| 1 | Pixel grid layering | **MISMATCH** — painted under the whole document | FIXED |
| 2 | Frame rotation handle | Position **MATCH** (already corrected by the 09-29 audit); *visual behaviour* **MISMATCH** — no hover state | FIXED, then superseded the same day — see **Follow-up** below |
| 3 | Path skeleton / centre line | **MISMATCH** — no path outline painted at all in point edit | FIXED |
| 4 | Double-click into an existing path | **PARTIAL** — entered `vecEdit`, never selected the anchor you clicked | FIXED |
| 5 | Adding a point to an existing path | **PARTIAL** — insert worked, the `+` preview could never appear | FIXED |
| 6 | Double-click / pointer-event wiring | **PARTIAL** — hit loop reimplemented the entry test; enter path selected nothing | FIXED |
| 7 | Vector editing consistency | **MISMATCH** — mirrored handles did not mirror by default; the ⌥ break did not persist | FIXED |

---

## 1 · Pixel grid / grid layering — MISMATCH

**Figma.** `View → Pixel grid` is a *view overlay*: at ≥ 400% the 1-document-pixel
hairlines draw over the artwork, which is the entire point — you are checking a
layer's edge for a half-pixel offset, and a grid hidden behind that edge answers
nothing. Selection chrome (names, ring, handles) stays on top of it.
[Zoom/view options](https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options)
confirms it is a view setting with a visibility floor, not a layer.

**X-Native before.** `Canvas.tsx:1837-1853` painted the grid immediately after the
canvas + page background, i.e. **before** the layer tree (`Canvas.tsx:2937`
`for (const ch of sectionsFirst(root.children)) paint(ch, 0, 0)`). Any layer with
a fill covered it: on a page of cards the grid was invisible exactly where it was
wanted. It also ran *before* the `pixelPreview` re-raster
(`Canvas.tsx:2946-2986`), which resamples the finished canvas per frame — so a
frame in pixel-preview mode could swallow grid lines into its own raster.

**Layout grids were audited at the same time and are correct**: `Canvas.tsx:2587-2660`
paints a frame's `layoutGrids` inside `paint()` after that frame's background and
before its children, which is Figma's ordering for a grid that belongs to a frame
rather than to the viewport. Left alone.

**Fix.** The grid became `paintPixelGrid()` at its old site and is now called
`Canvas.tsx:3066` — after the layer tree and after `pixelPreview`, before
`labelNames` and every selection ring. Same trigger (`pixelGrid && zoom >= 4`),
same colour role (`page.pixelGridColor || chrome.grid`).

## 2 · Frame rotation handle — position already right, hover state missing

**The brief asked for "a distinct handle above top-centre". That is not Figma, and
the repo has already been through this correction once.** Figma has no persistent
detached handle at all: rotation is *hover near a corner until the rotate cursor
appears, then drag*, with the pivot target revealed by `⌥R` or by dwelling on that
corner. [Smart animate §Rotation](https://help.figma.com/hc/en-us/articles/360039818874-Smart-animate-layers-between-frames)
("Hover over the corner bounds of an object until the rotation cursor appears") and
multiple community answers agree. `FRAME_INTERACTION_AUDIT_2026-09-29.md:28` graded
the top-centre variant as the shipped behaviour and the tester then reported it as
wrong ("rotation icon is in top middle of frame and Figma has different style"), so
it was moved to the top-right corner with a stem. **The top-right placement is kept**
— moving back to top-centre would regress a documented fix and match nothing in
Figma. What was actually missing is the half of Figma's behaviour that the brief
also names: the *hover* state.

**X-Native before.** `canvasSelection.ts:41-49` (`{ x: x + w, y: y - 20 }`) and
`Canvas.tsx:3609-3643` painted a stem plus a 5px hollow dot; `canvasSelection.ts:50-58`
hit-tested `< 10` for frames and an 8-24px ring for other kinds, and the hover cursor
reused `rotationHandleHit` at `Canvas.tsx:6203`. Three defects:

1. No hover state at all — the target looked identical whether or not it had you,
   while Figma's affordance is *entirely* a hover state.
2. Paint radius (5px, `Canvas.tsx:3622`) and hit radius (10px) were independent
   literals in two files; nothing stopped them drifting.
3. The frame ring fallback used `< 10` for handles and `>= 8 && <= 24` for shapes,
   again as inline magic numbers.

**Fix †.** `canvasSelection.ts` now exports `ROTATION_HANDLE_STEM / _RADIUS / _HIT`
and `ROTATION_RING` as the single source for stem offset, painted radius, and hit
box (hit is `<=` inclusive so the edge of the target is grabbable, which the old
`< 10` made flaky at 25% zoom). The paint reads `ROTATION_HANDLE_RADIUS`, thickens
the stem to 1.5px, adds a `SEL_GLOW` halo and fills the dot with the accent (glyph
flipping to `INK`) whenever `rotHover` is set — and `rotHover` is set from the
*same* `rotationHandleHit` call that sets `ROT_CURSOR` in `onMove`
(`Canvas.tsx:6382`, committed at `:6469`), so the highlight, the cursor and the
press cannot disagree. The non-frame corner ring gets the same treatment (2px plus
the same glow).

† **Both of these are the state at commit `5314d38`.** They are kept as written
because the reasoning (and the measurement) still stands, but the follow-up at the
end of this file removes the painted handle this section added a hover state to.

---
## 3 · Path skeleton / centre line — MISMATCH

**Figma.** In path edit, the network draws as a wireframe over the shape: edges in
the selection hue, the edge(s) attached to your selection at full strength, the rest
as a dimmer thinner centre line, so you always know which segment a click would take.

**X-Native before.** `Canvas.tsx:4175-4300` — the point-edit overlay — set
`ctx.strokeStyle = SEL; ctx.lineWidth = 1` at `:4191-4192` and then never stroked a
path: it painted anchor dots, Bézier tangents for *selected* vertices only
(`:4200-4234`), branch-degree markers and the point-box. So an unedited segment had
no style at all — selected and unselected were indistinguishable because *neither*
was drawn. Figma's skeleton was simply absent, and a curved path's real outline was
never shown while editing it.

**Fix.** Per-segment stroke loop added ahead of the point loop in the same
transform (`Canvas.tsx:4344-4388`): both endpoints selected → `SEL` at 1.5px;
otherwise → `withAlpha(SEL, 0.45)` at 1px. Curved edges follow the cubic
(`bezierCurveTo` through the existing tangents) rather than their chord.
Colour note: the brief suggested `#0d99ff`. This app's selection ink is the
`--cv-sel` role — token at `canvasChrome.ts:36`, light fallback `#10b981` at `:89`
— and `#0d99ff` is already spoken for here: it is `--cv-target` (`:48` / `:95`),
the drop-target and crop colour, which the same overlay uses two nodes away.
`CONTRIBUTING.md:46` is blunt about the alternative ("Colors are roles, never
literals"), and for the 2D surfaces `canvasChrome.test.mjs` enforces that
`canvasChrome.ts` is the only door between `styles.css` and the canvas — a
hard-coded hex on an overlay is what that test exists to catch. So the skeleton
paints `withAlpha(SEL, 0.45)`, which on a sheet themed to Figma's blue *is*
`#0d99ff` at 45%, and stays right when the sheet changes.

## 4 · Editing an existing path (double-click) — PARTIAL

**Figma.** Double-click selects the layer; double-click again enters path edit, and
if the press was on an anchor, that anchor is selected on entry — the next press
drags it.

**X-Native before.** `onDbl` (`Canvas.tsx:7884`) reached the vector branch at
`:8118-8141` and called `setVecEdit(hit.id)` with no point argument, so
`snap.vecPoint/vecPoints` stayed empty: on entry nothing was selected, the handles
of the point you had just clicked were not shown, and a following drag started a
marquee instead of moving the anchor. Entering edit also silently skipped the
container-drill guard ordering (`:7965`) for booleans with children — correct, and
untouched.

**Fix.** `pathAnchorUnder(id)` resolves the node from the *live* tree (a childless
boolean has just been flattened into a new id), converts the press to node-local
space through the node's own rotation/flip, and asks `anchorIndexAt` (new,
`vectorEdit.ts`) with the same 8 screen-px
radius the point-edit press grabs an anchor at — one constant
(`VERTEX_PRIORITY_PX.edit`) for both. `setVecEdit(id, pt, pt != null ? [pt] : [])`.
The already-in-edit double-click branch (`:8081`, corner↔smooth conversion) reused
its own inline nearest-vertex loop *and* left the point unselected: it now calls
`anchorIndexAt` too and ends with the converted point selected.

## 5 · Adding points to an existing path — PARTIAL (the preview could never show)

**Figma.** Pen over a path: a `+` at the projected insert point and a `+` cursor;
click inserts the anchor at that parameter `t`. Same in point edit.

**X-Native before.** The *command* existed and worked — `insertPointOnPath`
(`geometry.ts:1455`) with dispatches at `Canvas.tsx:5008` (pen, in edit),
`:5045` (pen, selected layer) and `:5806` (point edit, plain press). Three
mismatches made it feel absent:

1. The only hover affordance, `Canvas.tsx:4269-4293`, was gated on `cursorPos`,
   and `cursorPos` is maintained solely for the eyedropper / eraser /
   place-image gestures (`Canvas.tsx:6081-6088`). While editing a path with the
   select tool it is always `null`, so **the insert hint never painted**.
2. No cursor change anywhere: `Canvas.tsx:8655-8673` hardcodes `crosshair` for
   the pen, and the hover-cursor pass is skipped entirely in point edit
   (`Canvas.tsx:6175` `if (r0 && snap.selection.length && !vecEdit)`).
3. The two pen branches each re-implemented the vertex veto with different numbers
   (`10 / zoom` at `:5003` and `:5040`) and the point-edit press used `12 / zoom`
   for its hint (`:4281`) — so "where the preview said +" and "where the click put
   the point" were four different rules, and only `vector|boolean` layers accepted a
   pen insert at `:5031` while a rect/ellipse/star could be inserted into once you
   were in edit mode.

**Fix.**
- `nearestSegmentForInsert()` (new export, `geometry.ts`) is now the single segment
  test; `insertPointOnPath` calls it, so its chord/cubic choice and its
  0.05-0.95 endpoint guard are shared with the hover. `segmentInsertLanding()`
  resolves *where* the anchor lands (the cubic for a Bézier edge within
  `1.5 ×` tolerance, the chord otherwise), the preview paints exactly that point,
  and `insertPointOnPath` splits at the *same* call — the `+` is the insert, not an
  approximation of it, and the rule cannot drift between the two again.
- `vectorAddPointTarget()` (`Canvas.tsx:181`) adds the policy on top: skip locked
  and effectively-locked layers, skip instance members (the engine refuses), skip a
  branched network (`topologyEditBlocked`) because the insert itself refuses — a
  `+` you cannot click is a lie — and yield to a vertex inside the press's own grab
  radius (`VERTEX_PRIORITY_PX.edit` 8px in point edit, `.pen` 10px for the pen).
- `onMove` computes it whenever the pen is armed with no draft or a path is in
  point edit with the Select sub-tool, and stores `addPt`. It drives (a) a `+`
  marker painted in the node's own rotated space, replacing the dead `cursorPos`
  block, and (b) `ADD_POINT_CURSOR`, which outranks the tool cursors in the
  `cursor` chain so it lands for both the select and pen tools.
- The two kind lists that used to be spread across the file — which kinds a
  double-click converts, and which kinds the pen may add a point to — are now
  `PATH_ENTRY_KINDS` / `PEN_POINT_KINDS` next to `vectorAddPointTarget`, the pen's
  deliberately one kind narrower (it refuses a raw `boolean`), so the preview can
  never offer a layer the click refuses to touch.
- The pen insert and the point-edit insert are now *one* branch
  (`Canvas.tsx:5200`, `if (!penBranch.current && !draft.length)` with
  `targetId = vecEdit ?? the single selected layer`), both calling
  `vectorAddPointTarget` at `ADD_POINT_TOL_PX` (10 screen px), both dispatching the
  same `insertPointOnPath`, both landing in `setVecEdit(targetId, insertedIndex)`.
  Two click paths that had drifted apart are one, and hovering and clicking are the
  same measurement in both tools for every editable layer.

## 6 · Double-click / path-edit pointer events — PARTIAL

**Figma.** Two presses on an already-selected path, no drag between them, and you
are editing points.

**X-Native before.** `onDoubleClick={onDbl}` is wired on the surface
(`Canvas.tsx:8823`) and the pointer chain is right in structure: `onDown` claims the
press for a `move` drag, `onUp` finishes it, `onDbl` then runs the entry — so entry
cannot be lost mid-drag. What did not hold up:

- `onDbl`'s order of checks puts gradient-stop insert (`:7906`), bounding-box edge
  sizing (`:7962`) and frame-label rename (`:7912`) ahead of path entry. All three
  are deliberate (the press handler gives them the same priority), but the
  `edgeHit` test measured the box edge with `Math.abs(px - x0) <= 8` on the
  *translation-only* `worldPos` box, while every other measurement in the file uses
  `nodeVisualBounds` (ancestor rotation/flip included). On a child of a rotated
  frame, a double-click meant for a path could be eaten as a hug/fill toggle.
- Path entry selected no point (see §4), so the gesture stopped half-way.
- The point-edit press loop (`:5721-5760`) hand-rolled three separate hit tests
  (`< 7` for each handle tip, `< 8` for the anchor) that no other consumer shared.

**Fix.** `edgeHit` now measures the box the chrome actually paints
(`nodeVisualBounds(worldPos(...))`, which follows a vector's *path* instead of its
stale frame) and brings the pointer into that box's axes with the same
`unrot`/flip correction the handle tests use, so the three pre-emptions agree with
each other and with the press. Path entry selects the anchor under the press (§4),
and the anchor's grab radius, the entry's select radius and the radius the `+`
preview bows out at are now the same `VERTEX_PRIORITY_PX.edit` read in three places
(`onDbl` entry, the `onDown` point loop, `addPointTargetAt`) instead of three
hand-rolled numbers — the press, the preview and the double-click ask one question
of one helper.

## 7 · Vector editing consistency — MISMATCH (handle symmetry)

**Figma.** Drag a smooth point's handle and its twin follows (opposite, equal
length). `⌥`-drag breaks the point: the twin stops following, and *stays broken* —
that is what "independent handles" means.

**X-Native before.** `Canvas.tsx:6822-6848` (the `vec` drag, `handle: "in"|"out"`)
mirrored only when `p.mirrorMode === "angleAndLength"` and `!e.altKey`, i.e.:

1. `mirrorMode` is only written by `setPointMirror` (`memory.ts:4368`) and
   `convertAnchor` (`memory.ts:4356`). A point made by dragging out a pen handle, or
   by `smoothHandlesForPoint` (`geometry.ts`) on a path typed into `patchPath`, has
   perfectly mirrored handles and **no mode**, so `undefined` matched neither branch:
   the first nudge of one handle broke the tangency that the pen had just built. In
   practice the most common point on the canvas was the one that did not behave.
2. The `⌥` break was transient. Nothing wrote `mirrorMode`, so releasing `⌥` and
   dragging again re-mirrored and silently overwrote the handle you had just set
   free — the break did not survive the gesture.
3. `⌥`-drag out of a corner (`:6851-6862`) checked the same authored-only mode, so a
   smooth point without a mode on record pulled out one handle instead of a pair.

**Fix.** `effectiveMirrorMode(p)` (new, `vectorEdit.ts`) is the rule: an authored
mode always wins, otherwise the handles declare the mode — opposite and equal is
`angleAndLength`, collinear-but-unequal is `angle`, anything else `none`. The drag
uses it for both directions, and an `⌥`-modified handle move writes
`BREAK_MIRROR_MODE` (`"none"`) onto the point, through the same `patchPath` the drag
already dispatches, so the break is persisted inside the same undo step rather than
as a second history entry. The corner pull-out uses the derived mode too, so a
smooth point yields a mirrored pair.

Point selection (click / ⇧-toggle / lasso / point-box), movement (⇧ axis lock, ⌥
handle pull-out), segment bend, the Cut tool's click-split and drag-cut
(`:7242-7294`) and `⌫` delete were audited and already match Figma; they are re-pinned
by the new tests rather than changed.

---

## Tests

`apps/web/src/ui/__tests__/figmaCanvasVectorParity.dom.test.mjs` — 57 assertions
over a mounted `Canvas`, recording every 2D call *with the styles that were live
at that instant* (a recorder that only keeps colours at `stroke()` time cannot tell
a dim centre line from a selection ring, and cannot see a `fill()` whose
`fillStyle` was set after the `arc` that shaped it) — and
`apps/web/src/ui/__tests__/figmaGridLayering.dom.test.mjs` — 7 assertions on
composited pixels from the Skia backend, because "the grid is invisible behind the
shape I am checking" is a pixel claim, not a call-order claim. Both are appended to
the `npm test` chain (that script is an explicit `&&` list — a file that is not in
it never runs).

Sabotage run — each break was applied to the source, both files re-run through a
driver that restores the file afterwards, and the failing assertion ids below are
the actual output. One round of this mattered: the first version of A2 did *not*
notice "paint the grid last", because the earliest `SEL` stroke in a frame is some
unrelated chrome — so the comparison was rewritten against the selection handles,
which is what the claim was about anyway.

| Sabotage | Caught by |
|---|---|
| `paintPixelGrid()` moved back above the layer-tree loop | A1 (op order) + H1, H5, H6 (pixels) |
| `paintPixelGrid()` moved below the selection chrome | A2 (op order) + H3 (the top ring row is wiped to 0/300 accent pixels) |
| skeleton loop's `skelCount` → 0 | C1, C3, C4, C5 |
| hot edge styled like the skeleton (no emphasis) | C4 |
| `pathAnchorUnder` returns `null` (the pre-fix entry) | D1, D2 |
| `ADD_POINT_TOL_PX` → 0 (no preview, no insert) | E1–E6, E8, E9 |
| drop the vertex veto in `addPointTargetAt` | E4d |
| `rHov` hardcoded `false` (no hover state) | B3, B4, B5 † |
| `effectiveMirrorMode` → always `"none"` | F1, F2, F6, F7, F9 |
| drag reads only the authored `p.mirrorMode` | F6, F7, F9 |
| `⌥` branch stops writing `BREAK_MIRROR_MODE` | F8 |

One claim is order-only and has no one-token sabotage: C7, "the skeleton survives
the shape's own fill", holds because the loop lives in the point-edit overlay —
after `paint()` — so breaking it means moving code between passes, not flipping a
number. It is still worth pinning, because the pre-fix overlay painted no path at
all and so had no answer for that question either way. C8/C9 pin the styling that
made `selNow` and the anchor dots one definition of "selected", and D5 pins the
transform maths in the new entry: aimed at a rotated path's second anchor, it must
select index 1 (the pre-fix hand-rolled loop measured the un-rotated `hit.path`
and would not have).

D1 failing under the `pathAnchorUnder` break is the instructive one: with the
anchor test gone, the double-click on the triangle's first vertex stops reading as
a path click at all and gets eaten by the selection box's edge sizing — the exact
fight §6 had to settle, now pinned by a test.

## Where each fix lives now

Post-fix line numbers, so each change can be read without a diff viewer.

| Fix | Now at |
|---|---|
| 1 · grid layering | `Canvas.tsx:1910-1927` (`paintPixelGrid`), called at `:3066` — after the layer tree and `pixelPreview`, before labels and every ring |
| 2 · rotation hover | `canvasSelection.ts:46-53` (`ROTATION_HANDLE_STEM / _RADIUS / _HIT`, `ROTATION_RING`), hit test at `:64`; paint `Canvas.tsx:3689-3756`; `rotHover` measured at `:6382` and committed at `:6469` |
| 3 · path skeleton | `Canvas.tsx:4344-4388`, inside the node's rotation/flip transform; `selNow` is the one definition of "selected" the anchor dots share |
| 4 · double-click selects | `pathAnchorUnder` at `Canvas.tsx:8164`, used by the entry at `:8366`; `anchorIndexAt` in `vectorEdit.ts:116` at `VERTEX_PRIORITY_PX.edit` |
| 5 · add-point hover | `vectorAddPointTarget` `Canvas.tsx:181` over `addPointTargetAt` (`vectorEdit.ts:158`); the two kind lists at `:160` / `:168`; arming in `onMove` `:6280`; marker paint `:4291`; cursor `:8901` + `ADD_POINT_CURSOR` `:10268`; the single pen/insert click branch `:5200` |
| 6 · pointer-event agreement | `edgeHit` on `nodeVisualBounds` with the `unrot`/flip correction at `Canvas.tsx:8182-8214`, anchor pre-emption at its top; press-loop radius `:5884` |
| 7 · handle symmetry | `effectiveMirrorMode` `vectorEdit.ts:77`, `BREAK_MIRROR_MODE` `:106`; drag `Canvas.tsx:7008-7044` with the ⌥ write at `:7016` and `:7032`, corner pull-out at `:7048` |

Engine-side, the shared segment rule is `nearestSegmentForInsert`
(`engine/geometry.ts:1477`) plus `segmentInsertLanding` (`:1549`), which
`insertPointOnPath` (`:1563`) now splits at — hover, click and split are three
readers of one measurement.

## WASM

No new bridge call. Every item here is a pointer-state or paint-order question —
grid ordering, a hover flag, a per-segment stroke style, which point a double-click
selects, one mirror test. The nearest computational candidate was
`nearestSegmentForInsert`'s 25-sample cubic search, which runs once per mousemove on
one segment and stays in TS because it returns a *decision*, not a batch.
`WasmEngine`'s existing vector methods (`wasmVectorOps.ts`) are untouched and still
back outline/boolean work.

## Verification

Run in `apps/web`, on the final tree (every fix + both new files):

- `npm test` → exit 0. 1 925 `ok` lines, 0 `FAIL` lines, including the two new
  files at the end of the chain: `figmaCanvasVectorParity: 57 passed, 0 failed`
  and `figmaGridLayering: 7 passed, 0 failed`. The suites that already pinned this
  territory stayed green without edits — `canvasSelection: 92` (the top-right
  rotation pins), `frameInteraction: 65`, `vectorCutTool: 39`,
  `vectorEditTools: 23`, `variableWidthVector: 41`, `strokeSidesBrush: 84`,
  `imageCropInteraction: 58`, `toolsagent`, `batch2`, `batch3`, `openPathStroke`,
  `events`, `drift`, `trap`, `escape`, `canvasChrome`.
- `npx tsc --noEmit -p tsconfig.json` → clean (strict, `noUnusedLocals`,
  `noUnusedParameters`).
- `npm run build` (`tsc -b && vite build`) → exit 0, `✓ built in 5.08s`.
- Pre-existing, not caused by this batch: the sandbox has no compiled `.wasm`, so
  the run logs `geo bridge unavailable, using TS booleans: [CompileError:
  WebAssembly.instantiate(): expected magic word …]` and `geobridge: 96 passed`
  against the TS fallback path. Nothing in this batch goes through the bridge, so
  the number is the same as the baseline run taken before any edit.

## Follow-up · the same day, against the tester's screenshots

The batch above shipped in `5314d38`. The tester then put five screenshots of Figma's
selection chrome next to a render of ours and asked which differences were real
("green is our blue is figma"). Six things were compared, row by row:

| What was compared | Verdict | What happened |
|---|---|---|
| Selection ink — ours emerald `--cv-sel`, Figma's blue | not a bug | `#0d99ff` is this sheet's `--cv-target` (drop outline), and the emerald is a deliberate `--cv-sel` role. The tester chose **"add a Figma-blue chrome theme"** over a global recolour → item 2 below. |
| Rotation affordance — ours a permanent stem + hollow dot + glyph at the top-right, Figma's *nothing* | **real diff** | Removed → item 1 below. |
| Frame label / size chip weight | half a diff | The chip was already `500 11px`; the frame *name* was `600` when selected. One weight now → item 3. |
| Label unboxed, boxed chip on hover | match | untouched |
| Eight hollow handles, white fill, 1px accent stroke | size diff | 7px → 8px boxes on containers → item 3 |
| Size chip centred below the bottom edge | match | untouched |

### 1 · Rotation is a cursor, and now paints nothing at all

Deleted from `Canvas.tsx`: the whole paint block that drew the stem, the haloed dot
and the double-arrow glyph (it sat at `:3689-3756` in `5314d38`), the `rotHover`
state and its setter in `onMove`, its entry in the paint effect's deps, and
`ROTATION_HANDLE_RADIUS` — the export existed only to be painted, so `noUnusedLocals`
takes it as well. `canvasSelection.ts` keeps `frameRotationHandle`,
`ROTATION_HANDLE_STEM` / `_HIT` and `ROTATION_RING` (`:49-77`), because they define
the *invisible* band that the hover measurement and the press both read: the grab
point is still exactly where the dot used to be, so the gesture anyone learned keeps
working, and one source still means the cursor cannot promise a target the press
misses. Feedback during the turn is unchanged — the `N°` readout next to the size
chip and the `⌥R` pivot.

This supersedes both the brief's "distinct handle above top-centre" and the
compromise this file argued for at §2 (keep a painted top-right dot, add hover
emphasis). The argument was that the painted dot was better than nothing; the
screenshots said Figma's nothing is the design, and the tester picked it with the
test churn understood.

### 2 · `View → Canvas chrome`: Editor / Figma blue

The whole mechanism is one attribute on `<html>`, because the door between the sheet
and the 2D surfaces already existed:

| Piece | Where | What it does |
|---|---|---|
| preference, options, normaliser | `themeModel.ts:60-97` | two ids, the first one default; a stored value nobody recognises becomes `editor` rather than an unstyled canvas |
| the writer | `themeModel.ts:99-115` | `applyCanvasChromePref` sets `data-canvas-chrome="figma"`, and *deletes* the attribute for the default — an absent attribute is the state the rest of the sheet assumes |
| boot + persistence | `theme.tsx:22,62,88-95` | its own `localStorage` key (the colour scheme and the canvas palette are independent switches), applied before first paint so a reload does not flash emerald at someone who chose blue |
| the colours | `styles.css:313-341` | `html[data-canvas-chrome="figma"]` restates the four emerald canvas roles as the sheet's own blue; a second, two-attribute block carries the dark column's grid alpha |
| the menu | `chrome.tsx:142-159` | one row under Theme in the rail menu, mapped from `CANVAS_CHROME_OPTIONS`, no `title=` (§2.3), so the drift table's only movement is `button` 71 → 72 |

`canvasChrome.ts` gained nothing. The canvas, the rulers and the minimap already
re-read the cascade per paint, so what had to change was only the *dependency*:
`theme, chromePref` in the paint effect's deps (`Canvas.tsx:1040`, `:4797`) and a
`chrome` prop on the two companion surfaces (`Rulers.tsx:33,150`,
`Minimap.tsx:75,151`). Without those, a switch persists, the sheet says blue, and
the pixels stay emerald until you pan — which is exactly the class of bug the
follow-up tests were written before the feature was considered done.

**Scope, stated rather than discovered later.** The theme moves `--cv-sel`,
`--cv-sel-wash`, `--cv-sel-glow` and `--grid`. It does **not** restate `--cv-target`,
which is already `#0d99ff` in both columns: under this theme the drop target and the
selection share one blue, and that is what Figma does when you drag a layer over a
frame. It also does **not** touch `--accent` / `--accent-wash`, and that has one
visible consequence — the minimap's viewport rectangle and the rulers' selection-range
wash keep the app accent in both canvas palettes, because those two roles read the
*panel* accent (the FR-U2 comment in the sheet explains why they were chosen over
selection ink). Folding them in is a three-line edit plus dropping two roles from the
token map, but it turns an approved green blue for people who never opted in, so it
stays a proposal. The dashboard's second Theme control (`Dashboard.tsx:356`) was left
alone too: the switch belongs where the canvas is on screen.

### 3 · Type and handle metrics

`Canvas.tsx:3108` — the frame name is `"500 11px Inter, system-ui"` whether or not it
is selected; `active` now picks the *colour* only (`SEL` against `canvasLabel`), which
is how Figma marks it. Section titles stay `600 12px` (`:3089`), and the size/angle
chip was already `500 11px` (`:3704`) — §2's "both labels are bold" was wrong in
detail, and this corrects it. `Canvas.tsx:3660` — `const s = isFrame ? 8 : 7`, painted
one inset as before, so the boxes are Figma's 8px on containers, 7px on plain shapes,
still centred on the same edge points (`frameInteraction`'s `x + 3.5` half-width
assumption holds, which M4/M7 now pin directly). The multi-selection box keeps its
smaller 5px boxes, and its comment no longer claims it matches the single-selection
size.

### 4 · And then the pixels were made to answer

Everything above is text: the sheet declares the block, the model writes the
attribute, the components list the dependency. What no source-text test can say is
that a value read out of the cascade *becomes the colour of a ring on the canvas* —
and that gap is where the last real bug sat.

`figmaChromeTheme.dom.test.mjs` (26) closes it. It reads `styles.css` itself —
top-level `:root` / `html[…]` blocks, in document order, last match wins — installs
that as jsdom's `getComputedStyle` for custom properties, mounts the real `Canvas`
on the real Skia backend next to the real `NavRail`, selects a frame, and samples
composited device pixels across the ring's top edge and the layer name. Then it
clicks the actual "Figma blue" row and samples again: emerald before, Figma blue
after, emerald again after "Editor", the choice in `localStorage` under its own key,
and the band above the top-right corner holding nothing in either palette. The
model reads the sheet rather than a constant, so retinting `--cv-sel` moves the
test with it; the price is that it does not re-derive specificity, which §5 of
`canvasChrome.test.mjs` pins for the sheet instead.

The bug it caught: `ThemeProvider` had been applying the preference from a
`useEffect`, and in the browser that write landed after the canvas's paint effect had
already re-read the cascade. The click persisted, the DOM got `data-canvas-chrome`,
and the ring stayed emerald until something else happened to repaint — while every
text assertion in the suite stayed green. `theme.tsx:93-107` now applies it in the
setter, before the state update. Note the limit, because it is the interesting part:
re-creating the effect shape as a sabotage **passes** the pixel file, because
jsdom's passive-effect order is not the browser's here — so the ordering is pinned
textually in `canvasChromePref.test.mjs:123-131` (the write precedes the state
update, and nothing applies it from an effect) and the pixel file asserts the
consequence that survives both harnesses: a flip repaints. A dependency list is not a
promise about pixels; that distinction has now earned two tests in this batch.

### Tests

`figmaCanvasVectorParity` — the B series was inverted from "paints a hollow dot, fills
it on hover, gains a halo" to *chrome absent, affordance present*: B1/B3/B6 (no arc
anywhere in the band, before, during and after the hover), B2 (no stem), B11 (the
non-frame ring is gone too), B4/B5 (the cursor is the whole story, and it leaves),
B7/B8/B12 (the band's half-width is the shared constant, and a press inside it
rotates), B9/B10 (the module exports no painted-handle radius, and `Canvas.tsx` does
not even import the handle position). A new M series pins the metrics: M1/M2/M5 the
label's one weight and its colour-only selection state, M3/M6 the handle sizes,
M4/M7 that growing them did not move them off the edge points.
`canvasSelection` and `frameInteraction` gained the same absence pins at the
interaction level, and `frameInteraction`'s "rotation affordance is detached above the
top-right region" — which demanded the dot — became the opposite claim plus a cursor
test. 66 / 93 / 66 pass.

A new file, `canvasChromePref.test.mjs` (41 assertions, wired into the `test` chain
next to `canvasChrome`), holds the preference: menu shape, twelve normaliser cases,
`applyCanvasChromePref` against a `{dataset:{}}` object — no DOM needed, because the
writer takes its root as an argument — and the wiring contracts (its own key, read
before first paint, memo dependency, all three paint dependencies, both call sites,
the menu row exists). `canvasChrome.test.mjs` gained §5, which is what makes the CSS
honest: every emerald canvas role must be restated, each one must equal the sheet's
own blue *thinned by the alpha the light column already used* (recomputed, not
matched against a retyped `rgba()`), no panel role may be touched, nothing outside the
family may appear in the block, the block must sit *after* both theme blocks or it
loses the cascade, and the dark override must change the grid alpha and nothing else.

Sabotages run for this follow-up, each one restored after its run:

| Break | Caught by |
|---|---|
| repaint a dot + halo at the band | B1, B3, B11; `canvasSelection` ×3; `frameInteraction` |
| bold the selected frame's label again | M1 |
| container handles back to 7px | M3, M6 |
| the choice is never persisted (wrong key) | `canvasChromePref` |
| `chromePref` dropped from the context memo's deps | `canvasChromePref` |
| `chrome` dropped from the rulers' deps | `canvasChromePref` |
| the figma block forgets `--cv-sel` | `canvasChrome` §5 ×2 |
| a wash re-thinned to 0.4 | `canvasChrome` §5 |
| the theme recolours `--accent` | `canvasChrome` §5 ×2 |
| the override moved above the dark block | `canvasChrome` §5 |
| `apply()` writes the wrong value | `canvasChromePref` ×2 |
| the menu row disappears | `canvasChromePref` |
| the hover promises a grab instead of a rotate | B4; `canvasSelection` ×4; `frameInteraction` |

Then, for the pixel file: `--cv-sel` dropped from the figma block (×6 here, ×2 in
`canvasChrome` §5); the attribute never written (×3, ×2); the flip dropped from the
paint deps (×2); the rotation dot repainted (×2, plus parity B1/B3); the label no
longer following the selection (×2). Nineteen breaks tried, eighteen caught; the
nineteenth — the apply moved back into a parent `useEffect` — is not catchable in
pixels in this harness, and the honest response was a text pin plus a sentence in
the test file rather than a claim that a test covers it.

`npm test` → exit 0, **2003 `ok`, 0 `FAIL`** (1925 at `5314d38`; the delta is the
B/M rewrite, `canvasChromePref`, `canvasChrome` §5 and `figmaChromeTheme`); `drift`
24/0 with `chrome.tsx`'s button row raised to 72 and the dated note beside it;
`npx tsc --noEmit` clean; `npm run build` → exit 0, `✓ built in 5.00s`.

Still not verified, and the wording matters: the cascade in
`figmaChromeTheme.dom.test.mjs` is **that file's reader of `styles.css`**, not
cssstyle's. It proves that the values the sheet declares, read in the order the
sheet declares them, drive the pixels — against the real component, the real backend
and the real menu row. It does not prove a browser parses those two blocks the same
way, and there is still no Chromium here for `npm run test:e2e` to say so. The
remaining human step is short: open the app on :5173, switch the row, watch the ring
turn blue without touching anything else.

The one paragraph this section used to end with — that no test could watch
`getComputedStyle` hand the canvas a blue `--cv-sel` — is now only half true, and the
half that remains is above.
