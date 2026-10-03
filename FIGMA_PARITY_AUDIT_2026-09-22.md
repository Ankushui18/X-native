# X-Native vs Figma — Full Product Audit (2026-09-22)

**Tree:** `arena/01a0c8fe-x-native` @ `de232fe`
**Method:** full read of `apps/web/src` (9,996 LOC TS/TSX, the shipped product UI),
capability grep across all 9 Rust crates (~85k LOC), `tsc -b` clean, dev server run.

---

## 0. Headline: the product is two disconnected codebases

This is the single most important finding, and it reframes every other item below.

| | Rust engine (`crates/*`, `apps/x-designer`) | Web UI (`apps/web`) |
|---|---|---|
| Size | ~85,000 LOC, 9 crates | 9,996 LOC |
| Role | document model, booleans, vector edit, layout, text shaping, render, IO | **the only product UI** (per `apps/web/README.md`) |
| Link between them | **none** | **none** |

`grep -rn "wasm" apps/web/src crates/ --include=*.toml --include=*.rs` returns **zero
hits**. There is no `wasm-bindgen`, no `wasm-pack`, no generated bindings, no build step
that produces a `.wasm` artifact. `apps/web/src/engine/types.ts` says it out loud:

> *"WASM `x-editor` can implement the same command API later."*

`MemoryEngine` (`apps/web/src/engine/memory.ts`, 1,536 LOC) is a **complete, independent
TypeScript reimplementation** of the document model. It shares no code, no types and no
algorithms with the Rust engine.

**Therefore "functionality that exists in the code but is not exposed in the UI" is not a
list of a few stranded features — it is essentially the entire Rust engine.** Concretely,
these are implemented, tested Rust capabilities with *no* path to the user today:

| Capability | Rust location | State in web UI |
|---|---|---|
| Exact bezier boolean ops | `x-core/bezier_clip.rs` (`clip_bezier`, 584 LOC) | reimplemented as a **96×N raster grid approximation** (`geometry.ts:booleanPath`) — lossy, no curves |
| Vector editing (40+ ops: simplify, offset, reverse, split, join, lasso, bend, convert-anchor) | `x-editor/vector_edit.rs` (1,468 LOC) | ~4 ops (move point, move handle, delete point, add path) |
| Snapping + alignment guides | `x-editor/snapping.rs` (`alignment_guides`, `snap_delta`) | **absent entirely** |
| Eraser with pressure/radius | `x-editor/eraser.rs` | deletes whole layers on click |
| Component overrides / slots / typed props | `x-core/components.rs` (30 fns) | variant = a single `string` field |
| Variables, collections, modes, aliases | `x-core/variables.rs` (18 fns) | a flat list of hex swatches |
| Text shaping, font families, subsetting | `x-text/*` (5,556 LOC) | `ctx.measureText` + 5 hardcoded font names |
| Stroke outline, variable-width stroke, offset path | `x-core/booleans.rs` | naive normal-offset polyline |
| PNG / JPG / PDF export, image optimizer | `x-render/raster.rs`, `sinks.rs` | SVG string-building + `canvas.toDataURL` |
| Constraints solver, parametric resize, spatial index | `x-editor/*` | simple per-child arithmetic |
| `.fig` / Sketch / SVG import | `x-format/*` (17,906 LOC) | none |

Note also: **`cargo` is not installed in this sandbox**, so no Rust code in this repo can
currently be compiled, tested, or bridged to WASM here. Any work that depends on the Rust
engine is not verifiable in this environment.

---

## 1. Canvas & rendering

Renderer: single `<canvas>` 2D context, full repaint inside a `useEffect` on every
snapshot change (`Canvas.tsx:200–1640`).

**Works:** rect/ellipse/line/arrow/poly/star/vector/boolean/text/frame painting, corner
radii (incl. independent), rotation + flip, opacity, blend modes, clip, alpha masks,
drop/inner shadow, layer blur, background blur, noise, glass, image fills with
exposure/contrast/saturation/temperature adjustments, 2-stop linear/radial/angular
gradients with OKLab interpolation (genuinely better than Figma's sRGB default),
prototype flow arrows, pixel grid.

**Gaps vs Figma:**

| # | Gap | Evidence |
|---|---|---|
| C1 | **No snapping, no smart/alignment guides, no distance badges.** The defining feel of moving objects in Figma is absent. | no `snap`/`guide` logic anywhere in `Canvas.tsx` |
| C2 | **No rulers, no user guides.** | — |
| C3 | **Multi-select cannot be transformed.** Resize/rotate handles are gated on `snap.selection.length === 1` (`Canvas.tsx:851`). Selecting 3 objects gives you no bounding box, no handles. | `Canvas.tsx:851` |
| C4 | Full-scene repaint every frame; no dirty-rect, no layer/tile cache, no culling of off-screen nodes. Will not hold 60fps on large documents. | `Canvas.tsx` `useEffect` deps `[snap, band, edit, …]` |
| C5 | Booleans are raster-approximated at `res = 96`, then Douglas–Peucker simplified → curved shapes become visibly faceted polygons and are destructive. | `geometry.ts:booleanPath` |
| C6 | Inside/outside stroke faked by `lineWidth * 2` + clip; outside stroke repaints the fill on top. Miter limit, dash offset/caps per-segment not supported. | `Canvas.tsx` stroke block |
| C7 | Text is `measureText` + manual wrap: no kerning, ligatures, bidi, script shaping, or real line-height metrics. `small-caps` is implemented as `toUpperCase()`. | `Canvas.tsx:1900` `paintText` |
| C8 | Background-blur reads back the canvas via `drawImage(c, …)` inside the paint loop — O(n) full-canvas reads, and silently no-ops on taint. | `Canvas.tsx` `bgBlur` |

## 2. Document model

`XNode` is a flat struct of ~90 scalar fields.

| # | Gap |
|---|---|
| M1 | **Single fill and single stroke per node.** Figma has `fills[]` / `strokes[]` arrays, each with own blend mode, opacity, visibility. Here: `fill` + `fillB` (a *second colour*, used only as a gradient endpoint). |
| M2 | **Gradients are hard-limited to 2 stops** — the UI literally labels them "Stop 2" (`FillPicker.tsx:486`). No stop add/remove/reposition, no midpoint. |
| M3 | No colour styles, text styles, effect styles, or grid styles — so no shared-library story at all. |
| M4 | No layout grids / columns on frames. |
| M5 | Vector model is a flat `PathPoint[]` with one in/out handle. Not a **vector network**: no multiple edges per vertex, no regions, no independent per-region fills. (Rust removed its `VectorNetwork` experiment too — `x-core/node.rs:412`.) |
| M6 | Auto Layout: no absolute-positioned children, no min/max width/height, no per-child `alignSelf`, no grid layout, no "strokes excluded from layout", no canvas stacking order control. |
| M7 | Components: `variant` is a free-text string. No component properties (boolean/text/instance-swap), no nested instance overrides, no interactive components. |
| M8 | Constraints exist but there is no "scale" behaviour on frame resize for grandchildren, and no constraint UI feedback on canvas. |

## 3. Tools

| Tool | State |
|---|---|
| Move / Scale | works; scale tool scales props. No multi-select transform (C3). |
| Frame / Section / Slice | Frame OK. **Section is just a frame with a different name**; Slice is a dashed rect that exports nothing. |
| Rect / Ellipse / Line / Arrow / Poly / Star | good; shift/alt modifiers correct. Ellipse has no arc/sweep handles. |
| Pen | decent: click, drag-for-handles, shift-constrain, close-on-first-point, Esc/Enter/Backspace. Missing: editing an existing path with the pen, adding mid-segment points, corner/smooth conversion on alt-click. |
| Pencil | captures raw points, **no smoothing/simplification** → very heavy, jagged paths. Rust has `simplify_path`. |
| Brush | aliased to pencil. No width, no pressure, no taper. |
| Eraser | **not an eraser** — hit-tests and deletes the entire layer (`Canvas.tsx` `tool === "eraser"`). Figma erases geometry; Rust `eraser.rs` does too. |
| Comment | **creates a blue ellipse shape on the canvas.** No comment thread, no pin, no text, not stored as a comment. |
| Hand / zoom | fine. |

## 4. UI / UX / chrome

**Good:** nav rail, layers tree with rename/lock/hide/context menu, pages, assets pane,
right panel with Design/Prototype/Inspect, ⌘K command palette (~50 commands), context
menus, 4 themes, resizable panels, hide/minimize UI, help sheet.

| # | Gap |
|---|---|
| U1 | **Layer tree has no drag-and-drop reordering or reparenting.** Only canvas-drag reparents. This is a core Figma interaction. |
| U2 | No multi-select in the layer tree (no shift-range, no ⌘-toggle) — `onClick` always sets `ids: [n.id]`. |
| U3 | Font family is a `<select>` of 5 hardcoded names (`inspector.tsx:1164`); no font browser, weights derived from a number field, no per-character/range styling. |
| U4 | The "Agent" pane is a regex stub (`/frame/i` → add a frame). |
| U5 | The Variables pane just lists colours found in the doc; the `+` button dispatches `copyCode`. |
| U6 | No zoom control/menu in the UI (zoom only via keys/wheel); no minimap; no page-level zoom-to-fit button. |
| U7 | No responsive/mobile handling; panels are fixed-position with px widths. |
| U8 | Accessibility: canvas is not keyboard-navigable, no ARIA on the layer tree, focus rings inconsistent. |
| U9 | No multiplayer, no version history UI, no comments UI, no dev-mode measurements/redlines. |

## 5. Keyboard shortcuts

Genuinely strong — the best-covered area. V/K/F/T/R/O/L/P/B/C/S/H/⇧S/⇧P/⇧L/⇧I, ⌘Z/⇧⌘Z,
⌘C/X/V/⇧V, ⌘D, ⌘G/⇧⌘G, ⌘]/[ +shift, ⇧⌘L/H, ⌘A, ⌘K, ⌘\\, ⇧⌘\\, ⇧D, ⇧E, ⌥1-3, ⌥A/D/W/S/H/V
align, boolean ⌥⇧U/S/I/E, ⌘E flatten, ⌘⌥M mask, ⇧A auto-layout, ⇧H/V flip, zoom set,
arrows/shift-arrows, Tab/⇧Tab sibling cycling, Enter/⇧Enter enter/exit group.

Missing: ⌘/ (resources), ⌘⇧K (place image), ⌘⌥C/V (copy/paste properties), ⌘R (rename),
⌘⇧O (outline stroke — the command exists but is unbound), `2`–`9` opacity, ⌥ hover
measurements, ⌘⇧E export dialog.

## 6. Dead / stranded code in the web app itself

- `outlineStroke` — implemented in `memory.ts` + `geometry.ts`, reachable from **no**
  menu, button, or shortcut.
- `wrapSection` — command implemented, no UI entry point.
- `maskType` (`alpha` | `vector` | `luminance`) — model + field exist; UI only ever sets
  alpha.
- `imageFit: "tile"` — in the type union, not offered in the picker.
- `ProtoTrigger` is 3 of Figma's ~10 triggers; `ProtoAction` is 3 of ~8.
- `Snapshot.leftTab` is dispatched but `LeftPanel` switches on `nav` instead — the
  `leftTab` state is effectively vestigial.

---

## 7. Scored summary

| Area | Parity | Note |
|---|---|---|
| Keyboard shortcuts | 80% | strongest area |
| Shapes | 75% | missing arc/sweep, smoothing |
| Frames | 65% | no grids, no sections |
| Layers | 55% | **no drag-reorder, no multi-select** |
| Selection & manipulation | 50% | **no multi-select transform, no snapping** |
| Stroke & fill | 45% | single paint, 2-stop gradients |
| Text & typography | 45% | no shaping, no font browser, no ranges |
| Auto Layout | 50% | no absolute, min/max, grid |
| Effects & shadows | 65% | good set, single-value UI |
| Booleans | 35% | raster approximation |
| Pen | 55% | no re-edit of existing paths |
| Pencil / brush | 30% | no smoothing, no width |
| Eraser | 10% | deletes layers |
| Vector networks | 20% | polyline model only |
| Components & variants | 30% | string variants, no properties |
| Prototyping | 35% | 3 triggers, 3 actions |
| Constraints | 55% | works, no UI feedback |
| Align / distribute | 70% | no tidy-up, no spacing edit |
| Zoom / pan | 70% | no rulers/guides/minimap |
| Context menus & toolbars | 70% | solid |
| Performance | 30% | full repaint, no culling |
| Responsive | 15% | desktop-fixed |
| **Overall (web UI)** | **~45%** | |

The Rust engine, scored on its own, would land far higher on booleans, vector, text and
IO — but none of it reaches a user.

---

## 8. Recommended order of work

**Tier 1 — the interactions that make it *feel* like Figma (all in `apps/web`, no Rust):**
1. ✅ **Done.** Snapping + smart alignment guides + distance badges (port `snapping.rs` logic).
2. ✅ **Done.** Multi-select bounding box: transform, resize, rotate.
3. ✅ **Done.** Layer tree drag-to-reorder/reparent + shift/⌘ multi-select.
4. ✅ **Done.** Real eraser; pencil smoothing (port `simplify_path`).
5. Rulers + draggable guides.

**Tier 2 — model depth:**
6. ⚠️ **Partly done.** Multi-stop gradient editor shipped (`gradientStops` + ramp UI);
   `fills[]` / `strokes[]` arrays still outstanding.
7. Colour/text/effect styles.
8. Component properties + real variant sets.
9. Auto Layout: absolute position, min/max, alignSelf.

**Tier 3 — correctness:**
10. Exact bezier booleans in TS (port `bezier_clip.rs`) — removes the biggest quality cliff.
11. Pen re-edit of existing paths; anchor convert/split/join.
12. Canvas performance: dirty rects, off-screen culling, cached layer bitmaps.

**Tier 4 — the strategic question:**
13. Either build the `wasm-bindgen` bridge so the 85k-LOC Rust engine actually ships, or
    formally retire it and commit to TypeScript. Maintaining two divergent document models
    is the root cause of most gaps above. *This cannot be started in this sandbox — cargo
    is not installed.*


---

## 9. Changes implemented in this pass

All in `apps/web`; `tsc -b` clean, production build clean, `npm test` 11/11 green.

| Change | Files |
|---|---|
| **Snapping engine** — edge + centre alignment, equal-spacing detection, resize-handle snapping, world-space candidate collection that skips the dragged subtree. ⌘/Ctrl bypasses snapping. | `src/engine/snapping.ts` (new, 230 LOC) |
| **Smart guides + distance badges** rendered on the canvas overlay; centre guides dashed, gap pills in Figma red. | `src/ui/Canvas.tsx` |
| **Multi-select transform** — combined bounding box with handles, rotate stem and size badge; group resize maps every member through one affine scale, group rotate orbits members about the shared centre. Individual members keep a thin outline. | `src/ui/Canvas.tsx` |
| **Real eraser** — removes anchors under a circular brush from vector paths and splits the remainder into separate strokes, instead of deleting the whole layer. Non-vectors still delete, as in Figma. | `src/ui/Canvas.tsx`, `src/engine/geometry.ts` |
| **Pencil smoothing** — RDP thinning (`simplifyPath`, mirroring `x-editor::simplify_path`) then Catmull-Rom → cubic handle fitting (`smoothPath`). | `src/engine/geometry.ts`, `src/ui/Canvas.tsx` |
| **Layer tree drag-and-drop** — before/after/inside drop zones with indicator styling, multi-layer drags, cycle-safe, preserves absolute position via a new `reorder` command. | `src/ui/chrome.tsx`, `src/engine/memory.ts`, `src/engine/types.ts`, `src/styles.css` |
| **Layer tree multi-select** — ⌘/Ctrl toggle, Shift range-extend. | `src/ui/chrome.tsx` |
| **Multi-stop gradients** — `GradientStop[]` model with legacy `fill`/`fillB` fallback, OKLab ramp rendering across N stops, conic mirroring to kill the sweep seam, and a draggable ramp editor (click to insert, double-click/Delete to remove, position field, reverse). | `src/engine/types.ts`, `src/engine/paint.ts`, `src/ui/FillPicker.tsx`, `src/ui/inspector.tsx`, `src/styles.css` |
| **Stranded commands connected** — `⇧⌘O` outline stroke now bound (the context menu already advertised it); `outlineStroke`, `wrapSection`, `useAsMask`, arrange-to-front/back and add-auto-layout added to the ⌘K palette. | `src/ui/chrome.tsx` |
| **Regression tests** — 11 headless assertions over snapping, candidate collection, RDP, smoothing and eraser splitting. `npm test`. | `src/engine/__tests__/parity.test.mjs` (new) |

### Revised scores for the areas touched

| Area | Before | After |
|---|---|---|
| Selection & manipulation | 50% | **75%** |
| Layers | 55% | **80%** |
| Eraser | 10% | **60%** |
| Pencil / brush | 30% | **60%** |
| Stroke & fill | 45% | **60%** |
| **Overall (web UI)** | **~45%** | **~55%** |

### Not addressed, and why

- **Rulers/guides, `fills[]` arrays, styles, component properties, exact bezier booleans,
  canvas performance work** — each is a substantial piece; they are sequenced in §8.
- **Anything requiring the Rust engine** (including the WASM bridge, the single highest-
  leverage item in this repo) — **cargo is not installed in this sandbox**, so none of it
  can be compiled or verified here.
