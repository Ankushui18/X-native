# X-Native → Figma Design: Behavioral & Output Parity Audit

**Date:** 2026-10-04
**Auditor role:** Product Engineer / QA Auditor (functional parity with Figma Design)
**Repository:** `/home/user/X-native` @ `9baf0cd` (branch `arena/01a106ee-x-native`)
**Reference authority:** Figma Help Center — Figma Design (`https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design`)

---

## 0. What this audit is, and what it deliberately is not

**In scope (behavior + output only):**

1. Vector & path editing — adding points, Bézier handle mirroring / ⌥ break, double-click entry, path splitting.
2. Frame & selection — marquee semantics (⇧ union vs. replace), rotation interaction, midpoint vs. corner handle behavior.
3. Auto layout — gap redistribution by dragging, hug vs. fill, ignore-auto-layout (absolute positioning).
4. Text & typography — line-height metrics, baseline alignment, text resizing (auto width vs. fixed).
5. Components & variables — instance overrides, mode switching, binding/unbinding.
6. Export & output — PNG/JPG/PDF rasterization, SVG structure, clipping/masking.

**Explicitly out of scope — ignored by design:**

- Colours, spacing, icons, panel layout, typography and any other styling of X-Native's *own* chrome. The audit never treats "our button looks different" as a finding; §5 (Category D) lists every place where X-Native's chrome differs from Figma's **and is correct**.
- AI, MCP, Video, Motion. No new features are proposed; every fix below makes an **existing** control or gesture produce Figma's behavior or output.

**Method.** Every finding below was produced by (a) reading the current implementation, then (b) cross-referencing the specific Figma Learn article for that behavior. Line numbers are from commit `9baf0cd` and were re-verified after the last prior batch of edits landed. Where the Figma documentation is ambiguous (noted inline), the finding is marked with a confidence level instead of being asserted.

Files read for this audit (all under `X-Native/apps/web/src` unless noted): `ui/Canvas.tsx` (11,434 lines), `ui/canvasSelection.ts`, `ui/pointBox.ts`, `ui/vectorEdit.ts`, `ui/textLayout.ts`, `ui/inspector.tsx` (10,566), `ui/chrome.tsx`, `ui/exportModel.ts`, `engine/svgExport.ts`, `engine/pdf.ts`, `engine/wasmExport.ts`, `engine/wasmBridge.ts`, `engine/rasterMetadata.ts`, `engine/memory.ts`, `engine/layout.ts`, `engine/geometry.ts`, `engine/variables.ts`, `engine/textVector.ts`, `engine/types.ts`, plus `crates/x-wasm/src/session.rs`, `crates/x-render/src/{sinks.rs,lib.rs}`, `crates/x-text/src/shaping.rs`, `crates/x-core/src/{node.rs,styles.rs}`.

---

## 1. Executive summary

| # | Finding | Area | Category | Severity |
|---|---|---|---|---|
| F1 | The Rust/WASM export path renders **a flat colour block** for PNG/JPG/PDF, and it *wins over* the correct SVG→canvas path whenever it "succeeds" | Export | B + C | Critical (latent) |
| F2 | Browser PDF export is a raster image, not vector paths/glyphs (the real vector writer exists in `x-render`) | Export | B + C | High |
| F3 | Auto line height is hard-coded to **1.2em** instead of the font's intrinsic line height | Text | B + C | High |
| F4 | Canvas gap drag is a **no-op** on auto-spacing ("Between/Around/Evenly") frames, and the handle only exists between the *first two* children | Auto layout | A | High |
| F5 | Bézier handles of **unselected** anchors are invisible but still grabbable (7px) | Vector | A | High |
| F6 | Rotation is reachable only from the **top-right** corner (shapes) or a detached spot 20px above it (frames); Figma rotates from just outside any corner | Frame & selection | A | High |
| F7 | Bend tool / ⌘-click on an **anchor** moves the point instead of adding mirrored handles | Vector | A | Medium-High |
| F8 | "Include bounding box (text layers only)" is exposed, stored — and read by **no** exporter (detailed with C2 in §4) | Export | C | Medium-High |
| F9 | "Ignore overlapping layers" changes nothing for non-slice layers/groups | Export | B + C | Medium |
| F10 | PNG/JPG of text rasterizes an SVG `<text>` with **no embedded font**; self-hosted fonts silently fall back | Export | B | Medium |
| F11 | A **plain** marquee never descends into a section, so its frames are unreachable without ⌘ | Frame & selection | A | Medium |
| F12 | Windows has **no** drop-as-ignore-auto-layout modifier (Figma: `S`) | Auto layout | A | Low |
| F13 | No layer/frame-level variable **mode override** (document-scope modes only; C5 in §4) | Variables | C | Medium (scope gap) |
| D1–D7 | Seven deliberate chrome differences verified as behaviorally correct | — | D | No action |

Sabotage-verified tests that currently **lock in** non-Figma behavior were found in `ui/__tests__/canvasSelection.test.mjs:74` and `:76` (F6) and are called out explicitly, because a fix must invert them.

---

## 2. Category A — Behavioral mismatches

### F5 · Unselected Bézier handles are painted nowhere but grabbed at 7px
**Category A** · `ui/Canvas.tsx`

**Figma.** Handles are editable only for the points you have selected: the point-editing surface shows handles on the selected vertices, and the Mirroring control (`No mirroring` / `Mirror angle` / `Mirror angle and length`) governs "a set of bézier handles" of *those* points. An unselected vertex's tangent is not a canvas target — the press belongs to the anchor, the segment, or the marquee. ([Edit vector layers](https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers))

**X-Native.** Two different predicates own the same 7px neighbourhood:

- **Paint** is correctly gated: handles are drawn only for selected vertices —
  `ui/Canvas.tsx:4338-4339`
  ```ts
  // Bézier tangent handles: only show for selected vertices (or when dragging) to keep canvas clean
  if (isSelected) { … }
  ```
- **Press** ignores selection entirely — for every point in the path it tests the in-handle, then the out-handle, then the anchor:
  `ui/Canvas.tsx:5815-5828`
  ```ts
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    …
    if ((p.ix || p.iy) && Math.hypot(px - (vx + (p.ix||0)*z), py - (vy + (p.iy||0)*z)) < 7) { …handle "in"… }
    if ((p.ox || p.oy) && Math.hypot(px - (vx + (p.ox||0)*z), py - (vy + (p.oy||0)*z)) < 7) { …handle "out"… }
  ```

**Why it differs.** The paint loop reads `selNow` (`Canvas.tsx:4300-4304`), the hit loop reads nothing. Two independent definitions of "editable handle" drifted apart: a fix to the visual noise (only paint selected handles) never propagated to the interaction test.

**Consequences (all observable):**

- A press that visually lands on the **path** or on empty canvas 7px from an invisible handle starts a handle drag; the hit loop runs *before* the segment insert (`Canvas.tsx:5886`) and before the anchor grab for the same point (`:5827`), so the user's point insert or point move is silently swallowed.
- Because the handles are not painted, the user gets no feedback that the layer is being reshaped — the classic "the tool did something I didn't ask for" report.
- At high zoom the ghost handle is 7 screen px wide, which is *larger* than the 3.5px painted handle it belongs to.

**Fix.** Capture `const editable = selNow.has(i) || (drag.current?.mode === "vec" && drag.current.point === i)` in the press loop and skip both handle branches when it is false. That is a TS-only change; the engine already accepts whatever the UI hands it.

---

### F4 · Gap dragging is inert on auto-spacing frames, and the handle exists only once per frame
**Category A** · `ui/Canvas.tsx`, `engine/layout.ts`

**Figma.** The gap between *any* pair of items in a linear auto-layout flow is a draggable on-canvas target: "Use these keyboard shortcuts while dragging on-canvas handles to: Set padding **or spacing** with big nudge — ⇧ Shift"; when the gap is *Auto*, dragging it produces a concrete value and the objects follow the pointer. ([Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma), *Keyboard shortcut guide → From the canvas*)

**X-Native — two defects in the same gesture:**

1. **Inert drag on Auto spacing.** The press writes a number into `layout.gap` without clearing `gapMode`:
   `ui/Canvas.tsx:7169-7181`
   ```ts
   } else if (d.mode === "autoGap" && d.id && d.origGap != null) {
     …
     engine.dispatch({ type: "autoLayout", id: d.id, layout: { ...wp.node.layout, gap: nextGap } });
   }
   ```
   The layout engine ignores `gap` while `gapMode === "auto"` — `engine/layout.ts:767-770` (`isAutoGap`) and `engine/memory.ts:951`:
   ```ts
   const pack = auto ? autoSpacing(slack, flow.length, spacing) : { lead: 0, gap: packedGap };
   ```
   `gapMode` is cleared in exactly two places — the alignment-box `X` shortcut (`engine/layout.ts:904`) and the inspector toggle (`ui/inspector.tsx:5727`) — never by the canvas gesture. So on a frame set to **Between / Around / Evenly**, dragging the pink gap band moves nothing and the band does not follow the cursor: the drag looks broken.
2. **One handle per frame.** The hit target is derived from the *first two* flow children only:
   `ui/Canvas.tsx:6058-6067`
   ```ts
   const flowKids = wp.node.children.filter((c) => c.visible && !c.absolutePosition);
   if (flowKids.length >= 2) {
     const c0 = flowKids[0];
     const gx = horiz ? sx + (c0.x + c0.w + l.gap / 2) * z : sx + sw / 2;
     …
     drag.current = { mode: "autoGap", … origGap: l.gap };
   ```
   The painter, by contrast, bands *every* gap and every wrap gap (`ui/Canvas.tsx:3903-3941`), so the chrome advertises drag targets the press refuses — the third, fourth and nth gap have no hit area at all.

**Why it differs.** (1) The gesture writes a *stored field* instead of the *effective* gap, so it never converts Auto → Fixed the way Figma does. (2) The handle position was copied from the padding handles' "one representative position" pattern, which is valid for four padded edges but wrong for N−1 gaps.

**Fix (TS only, two edits).**
- In the `autoGap` move handler, dispatch `{ ...layout, gap: nextGap, gapMode: "fixed" }` (and, on the press side, treat an auto-gap frame's stored `gap` as the measured current spacing so the delta starts from what is on screen).
- In the press loop, walk every adjacent flow pair and use the gap under the pointer rather than the first pair.

**Verification hook.** `engine/__tests__/autoLayoutEdgeCases.test.mjs` and `autolayout.test.mjs` already build auto-spacing frames, so the regression test belongs with them (§7, T3c).

---

### F6 · Rotation exists at the top-right corner only (containers: a detached point above it)
**Category A** · `ui/canvasSelection.ts`, `ui/Canvas.tsx`

**Figma.** Rotation is a **cursor affordance around any corner**: "Hover just outside a layer's corner on the canvas and the cursor switches to the curved rotation arrow"; "Hover on the outside of a corner until the rotate cursor appears. Then click and drag." Nothing is painted to advertise it. ([How to rotate in Figma](https://wpdean.com/how-to-rotate-in-figma/) — corroborated by Figma's own forum threads where users describe hovering "outside the layer's corner"; the shape-tool article uses the same phrasing.)

**X-Native.** `ui/canvasSelection.ts:56-73`:
```ts
// "Figma places the rotation target above the top-right corner, with a
//  ~20px gap between the corner and the handle centre."   ← the mistaken premise
return kind === "frame" || kind === "component" || kind === "instance"
  ? { x: x + w, y: y - ROTATION_HANDLE_STEM }             // 20px above the corner
  : null;
…
export function rotationHandleHit(kind, px, py, x, y, w, h) {
  const handle = frameRotationHandle(kind, x, y, w, h);
  if (handle) return Math.hypot(px - handle.x, py - handle.y) <= ROTATION_HANDLE_HIT;   // 10px disc
  const tr = { x: x + w, y: y };                           // top-right corner only
  const d = Math.hypot(px - tr.x, py - tr.y);
  return d >= ROTATION_RING.min && d <= ROTATION_RING.max; // 8..24px
}
```
The inline comment is itself the root cause, recorded as a claim: Figma has **no** detached rotation dot above the top-right corner — the affordance is the cursor changing just *outside* any corner. On top of that:
- **Frames / components / instances:** rotation is a 10px disc centred **20px above** the top-right corner — a spot where Figma shows neither a rotate cursor nor a resize handle (dragging there in Figma is a canvas-level/other-layer interaction). The four corner bands that Figma *does* use are dead.
- **Everything else (rect, ellipse, vector, text, group…):** rotation works from the top-right corner only; the top-left, bottom-left and bottom-right outside bands do nothing.
- **Internal inconsistency proving the outlier:** a **multi-selection** rotates from *every* corner ring (`ui/Canvas.tsx:5373-5380`, `for (i = 0; i < hs.length; i += 2)` with an `8..22px` band), so the same gesture works on a group of two rects and fails on one rect.

**Why it differs.** `ROTATION_RING`/`frameRotationHandle` model a *detached painted handle* that no longer exists — the paint code deliberately removed the stem+dot (`ui/Canvas.tsx:3690-3694`: "No painted rotation handle, on purpose. Figma's rotate affordance is the *cursor*"). The decision to stop painting was right; the hit geometry that belonged to the removed handle was left behind, still keyed to one corner.

**Tests currently encode the divergence** (a fix must invert these, not merely add to them) — `ui/__tests__/canvasSelection.test.mjs`:
- `:74` `t(\`${kind} corners no longer rotate at zoom ${zoom}\`, …)` — asserts all four corners are dead for frames/components/instances.
- `:76` `t("ordinary shapes do NOT rotate from top-left corner", !rotationHandleHit("rect", 90, 90, …))`.
- `:70-73` assert the detached spot is hittable.

**Fix (TS only).** Make the rotation target corner-symmetric: a ring of 8–24px around each of the four corners for every layer kind, with the corner handles winning inside 8px (the press order at `ui/Canvas.tsx:5962` already gives a resize handle priority). Delete `frameRotationHandle` or reduce it to "the same ring, for every kind". Keep the cursor-only affordance — that part is Category D (D1).

---

### F7 · Bend / ⌘ / ⌥ on an anchor moves the point instead of adding handles
**Category A** · `ui/Canvas.tsx:5827-5886`

**Figma.** The Bend tool "allows you to add bézier handles to create a curve in a path… **Click on a point or path** where you want to add a curve"; ⌘/⌃ is the temporary Bend modifier ("press Command (Mac) or Ctrl (Windows) and click the point … to display handles and create a mirrored curve"). ([Edit vector layers](https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers); [vector edit lesson](https://uxcel.com/lessons/modifying-objects-in-figma-562))

**X-Native.** Bent-ness is keyed on **segments only**, and only their interior:
```ts
// ui/Canvas.tsx:5868-5886
const meta = e.metaKey || e.ctrlKey || e.altKey || vecSubTool === "bend";
if (meta) {
  for (let si = 0; si < count; si++) {
    const pr = projectPointOnSegment(local.x, local.y, p1.x, p1.y, p2.x, p2.y);
    if (pr.dist < 14 / snap.zoom && pr.t > 0.05 && pr.t < 0.95) { …bend segment… }
  }
}
```
A press on an **anchor** never reaches that code: the anchor grab at `ui/Canvas.tsx:5827-5851` runs first and unconditionally, so with the Bend tool active (or with ⌘/⌥ held) a press on a corner point *moves* it. The `t ∈ (0.05, 0.95)` guard also excludes the ~14px nearest each endpoint, so "click on a point to bend it" has no working path at all. `bendSegment` itself (`engine/geometry.ts:1874-1904`) only understands a segment index and overwrites *both* endpoints' tangents — it has no "give this anchor mirrored handles" form.

**Secondary issue in the same line:** ⌥ is folded into the bend modifier set even though ⌥ already means "break the mirror" two hundred lines below (`ui/Canvas.tsx:6951`, `:6970`) and "pull handles out of an anchor" (`:6987`). One modifier, three meanings in one mode.

**Fix (TS + one engine entry point).** With `vecSubTool === "bend"` (or ⌘/⌃ held) and the press within the anchor radius, convert the pressed anchor to a smooth point with mirrored handles placed along the dominant adjacent-segment direction (a new `convertAnchorToSmooth` dispatch, or reuse `smoothHandlesForPoint`, which already exists and is used by the double-click path at `ui/Canvas.tsx:8267`). Drop `e.altKey` from the bend modifier set.

---

### F11 · A plain marquee never descends into a section
**Category A** · `ui/Canvas.tsx:7948-7958` (confidence: medium-high)

**Figma.** A frame inside a **section** is a top-level layer for selection purposes — the help article's own locator is "The frame or group should sit at the top-level on the canvas **or inside a section**" — and a plain marquee selects top-level layers "across any objects you'd like to select"; nested layers need the ⌘/Ctrl modifier. ([Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects))

**X-Native.**
```ts
// ui/Canvas.tsx:7949-7958
const visit = (n, px, py, top, lockedAbove = false) => {
  …
  if (hit && (deep || top)) ids.push(n.id);
  const nest = deep || n === snap.pages[snap.page].root;   // ← sections are not traversed
  if (nest) for (const c of n.children) visit(c, x, y, n === root, effLocked);
};
```
`top` is granted by identity with the visited node's own parent check (`n === snap.pages[snap.page].root`), and recursion is gated on "is the page root" or ⌘. A section is a *child of the root*, so its frame children are one level further down: with a plain marquee they are never visited at all (the section itself is selected because the band touches it), and only the ⌘/Ctrl marquee reaches them. Figma's plain marquee would return the frames.

**Why it differs.** The nesting policy models "page root → top-level" as a fixed two-level ladder, treating `section` like `frame`/`group`. Figma treats a section as a *scope*, not a level.

**Fix (TS only).** Treat `kind === "section"` as a transparent level: give its children `top = true` when not deep (sections cannot nest inside frames — see `sectionStaysTopLevel`, `engine/memory.ts:111`, and its use at `:2585`), and recurse into sections unconditionally.

---

### F12 · Windows cannot drop a layer with "Ignore auto layout"
**Category A** · `ui/Canvas.tsx:7586-7589`

**Figma.** "Drag an object into an auto layout frame while pressing: **Mac:** ⌃ Control, **Windows:** `S`." ([Guide to auto layout → Ignore auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma))

**X-Native.**
```ts
// ui/Canvas.tsx:7586-7589
const isMac = /mac/i.test(navigator.platform ?? "");
const absolute = e.ctrlKey && isMac;
const bypass   = e.metaKey || (e.ctrlKey && !isMac);
```
On Windows, Ctrl is consumed by `bypass` (size-gate bypass, which matches the *other* Figma row) and `S` is not tested anywhere, so the only route to absolute positioning is the inspector toggle. Low severity (the documented panel route exists), but it is a documented modifier that is simply absent.

**Fix (TS only).** Add `e.key`/`sKey` tracking to the drag state (the canvas already tracks `space.current` for the Space bypass at `:7584`) and include `!isMac && sDown` in `absolute`.

---

## 3. Category B — Output mismatches

### F1 · The Rust/WASM export path emits a flat colour block — and takes priority over the correct renderer
**Category B (+ C: correct engine exists)** · `crates/x-wasm/src/session.rs`, `apps/web/src/engine/wasmExport.ts`, `apps/web/src/ui/inspector.tsx`

**Figma.** PNG/JPG rasterize the artwork; PDF is a vector document with paths, text/glyphs and images. A frame of three coloured rectangles exports as those three rectangles at any scale.

**X-Native.** The wasm `export_node` entry point does not render anything:

```rust
// crates/x-wasm/src/session.rs:662-671
fn node_rgba(node: &x_core::Node) -> [u8; 4] {
    match &node.fill {
        x_core::Paint::Solid(c) => { let rgba = c.to_rgba8(); let a = (f32::from(rgba.a) * node.opacity).round() as u8; [rgba.r, rgba.g, rgba.b, a] }
        _ => [0, 0, 0, 255],
    }
}
// :692-699 — one row, repeated for every scanline
let pw = ((w * scale).round() as u32).clamp(1, 4096);
let rgba = node_rgba(node);
let mut row = Vec::with_capacity(1 + (pw as usize) * 4);
row.push(0);                                   // PNG filter byte
row.extend(rgba.repeat(pw as usize));
let raw = row.repeat(ph as usize);
// :750-773 — PDF: a single rectangle fill of that same colour
let stream = format!("{rgb} rg 0 0 {w:.2} {h:.2} re f\n");
```

So `encode_node_png`, `encode_node_jpg` and `encode_node_pdf` all ignore geometry, children, strokes, gradients, text and effects. The **real** pipeline is present and unused: `crates/x-render/src/sinks.rs:60` `export_pdf_full` (paths, gradient shadings, image XObjects, per-glyph outlines via `text_geometry::outline_text`), `crates/x-render/src/raster.rs` (tiny-skia rasterizer), re-exported at `crates/x-render/src/lib.rs:34` — nothing in `x-wasm` calls any of them.

**Why this is worse than "a fallback that fails":** the call order makes the stub *authoritative*. `ui/inspector.tsx:9309-9311`:
```ts
void tryWasmExport(n, p, scope, name, width, height, box).then((handled) => {
  if (!handled) canvasExportPath(n, p, svg, width, height, name, colorProfile, settings, box);
});
```
and `tryWasmExport` returns `true` after downloading whatever came back (`ui/inspector.tsx:9316-9341`). The gate that decides whether wasm is attempted at all is `xnodeToX`, which **rejects the whole subtree** only when it finds text, an image, a non-solid fill, a gradient stop, an effect or a mask (`engine/wasmExport.ts:55-64`); everything else converts — including full vector paths with handles, rect corner radii, polygons and stars (`:66-124`, note `id: n.id` at `:124`), which is the giveaway that the TS side was written expecting a real renderer — and returns `null` for any child it cannot convert (`:146-152`). Net effect:

| Document being exported | Path taken | Output |
|---|---|---|
| Frame of plain solid rects, no text/effects | **WASM** | **A single flat slab** (the frame's own fill, transparent if the frame has none) |
| Anything containing text, images, gradients, effects, masks | SVG → canvas raster | Correct |

Because a *simple* document is exactly the case a user would trust, this is a silent, content-dependent corruption of PNG, JPG and PDF, and it also makes F2 look "already fixed by Phase 9" when it is not.

**Test blind spot (root cause of why this shipped).** The only assertions on this path are magic-byte checks on the Rust side — `crates/x-wasm/src/session.rs:1104-1140` (`assert_eq!(&bytes[1..4], b"PNG")`, JPEG SOI, `%PDF`). No TS suite imports `engine/wasmExport.ts` at all (`grep -rln "wasmExport\|exportNode" engine/__tests__ ui/__tests__` returns nothing), so nothing compares exported pixels to the document.

**Fix.** Two options, in order of leverage:
1. **Rust wiring (preferred):** have `session.rs::export_node` build the same `RenderTree` + `Assets` + `FontManager` the live canvas uses, call `x-render`'s `raster`/`export_pdf_full` sinks, and return those bytes. This is what `x-render` already provides; `export_node` currently constructs none of it.
2. **Interim (TS, one line):** until (1) lands, make `xnodeToX` refuse (return `null`) so `tryWasmExport` returns `false` and the SVG raster path — which is correct — is used; or delete the wasm branch for `pdf` and PNG/JPG until the sink is wired. Shipping a known flat-colour image is strictly worse than the older path.

**Note on reproducibility:** no `.wasm` artifact is checked in (`crates/x-wasm` has only `src/`, `apps/web/public` has no `wasm/`), so the sandbox/dev build falls back to canvas today. The moment `scripts/build-wasm.sh` runs and the artifact is deployed, every simple export silently changes. That is why this is ranked #1: it is a one-build-command-away regression of the primary output surface.

---

### F2 · PDF is a raster image, not a vector document
**Category B (+ C)** · `apps/web/src/engine/pdf.ts`, `ui/inspector.tsx:9390-9435`

**Figma.** PDF exports "text written as glyphs (uneditable)", i.e. a real vector document with paths, glyphs and embedded images, produced at 1x. ([Export formats and settings](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings))

**X-Native.** `engine/pdf.ts:1-15` documents its own design: "a single page holding the rendered artwork as a JPEG-compressed image, with a lossless soft mask… It is raster-backed rather than vector, so export at 2x/3x for print. A vector writer… is the natural next step and is what `crates/x-render`'s `export_pdf` already does natively." The UI path is `inspector.tsx:9390-9435`: rasterize the SVG into a canvas, JPEG-encode RGB, then hand the bytes plus alpha to `buildPdf`. Text is not selectable/searchable, curves are resampled, and file size scales with pixel count instead of geometry.

**Root cause.** The vector writer was implemented in Rust (`crates/x-render/src/sinks.rs:60`, with glyph outlining and image XObjects) and never wired to a UI entry point (see F1: the wasm export entry point is a stub). The TS writer was authored as the browser fallback and became the shipped behavior.

**Fix.** Same wiring as F1: route PDF through the Rust sink; keep `engine/pdf.ts` only as the no-wasm fallback. (Prior audit `FIGMA_HELP_AUDIT_2026-10-01_07_EXPORT_FORMATS.md` §5 recorded this as a known limitation; it is still open and is now provably fixable by wiring, not by new code.)

---

### F3 · Auto line height is 1.2em, not the font's intrinsic line height
**Category B (+ C)** · `ui/textLayout.ts`

**Figma.** "By default, line height is set to **Auto**. This is calculated using the font's default line height, **which varies between typefaces**." ([Explore text properties](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties))

**X-Native.**
```ts
// ui/textLayout.ts:82-88
export function effectiveLineHeight(n: XNode, fontSize?: number): number {
  const fs = Math.max(1, fontSize ?? n.fontSize);
  const unit = n.lineHeightUnit ?? (n.lineHeight > 0 ? "px" : "auto");
  if (unit === "percent" && n.lineHeight > 0) return Math.max(1, (n.lineHeight / 100) * fs);
  if (unit === "px" && n.lineHeight > 0) return Math.max(1, n.lineHeight);
  return Math.max(1, fs * 1.2);          // ← "Auto"
}
```
That single constant is the source of truth for **every** vertical text metric in the app:

| Consumer | Line |
|---|---|
| Live text editor box (`editBox`) | `ui/Canvas.tsx:8870`, `:8878` |
| Text measurement / fixed-box line count | `ui/Canvas.tsx:10663`, `:10667`, `:10963`, `:11013` |
| Layout metrics source (`textMetrics`) | `ui/textLayout.ts:486` |
| SVG `<tspan dy>` rhythm | `engine/svgExport.ts:443` |
| Glyph outlining / Outline-text | `engine/memory.ts:1955`, `engine/textVector.ts:667` |
| Inspector line-height stepper | `ui/inspector.tsx:3812`, `:4046`, `ui/chrome.tsx:2873` |

**Why it differs (and why it is fixable without new capability).** The engine already holds the correct quantity in three places and none of them reaches the auto branch:
- Rust computes the real line box: `let natural = (f0.ascent - f0.descent + f0.line_gap) * (max_size / f0.units_per_em);` — `crates/x-text/src/shaping.rs:908`; its explicit-px/percent branch does proper CSS half-leading (`:912-918`), while `lh_mode == 0` ("legacy AUTO", `:914`) uses `ascent × clamp(1.0, 1.2)` — the same approximation, which is why TS↔Rust parity tests cannot catch this.
- TS has per-family metrics: `engine/layout.ts:606-614` (`FONT_METRIC_RATIOS`, Inter/Roboto/Helvetica/Arial), used for *baselines* only (`childBaseline`, `:693-706`).
- TS can measure the real thing in the DOM: `fontMetricRatios` (`ui/textLayout.ts:200-232`) probes `fontBoundingBoxAscent/Descent` at 1000px — but it is only used to align the editor overlay, never to resolve Auto.

**Measurable divergence.** Under `hhea`-style metrics the intrinsic line height is roughly 1.15em for Helvetica/Arial, ~1.17 for Roboto and ~1.21 for Inter — a spread of ~5% across the fonts X-Native actually bundles (`apps/web/public/fonts` ships Roboto and Inter, so both sides of the constant are reachable in one document). X-Native's documents default to Inter (`engine/textInput.ts:94` falls back to `"Inter"`), so the app's own default is ~1% too short while any Roboto layer is ~2.5% too tall and any Arial/Helvetica layer ~4% too tall. That error multiplies through wrapped paragraphs, `hugHeight`, auto-layout row heights and baseline rows, and it is written into every SVG/PDF export.

**Fix (§7, T2).** Give the auto branch a real source: extend `FONT_METRIC_RATIOS` with `lineGap`, prefer the DOM probe when a canvas is available, and have `effectiveLineHeight` return `(ascent − descent + lineGap) × fontSize`. Mirror it in `x-text/src/shaping.rs:914` so parity tests compare two correct implementations.

---

### F9 · "Ignore overlapping layers" is honoured only for slices
**Category B (+ C)** · `engine/svgExport.ts:766`, `ui/inspector.tsx`

**Figma.** For any layer or group export: "When enabled, Figma only includes the selected layers… When disabled, Figma includes any layers that intersect with the selected layer or group." The slice paragraph is a *special case* of the rule, not the whole rule. ([Export formats and settings](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings))

**X-Native.** The flag is read in exactly one branch of `exportSvg`, the slice branch:
```ts
// engine/svgExport.ts:764-779
if (n.isSlice === true && scope?.root) {
  const whole = p.ignoreOverlap === false;
  const container = whole ? scope.root : (findLocalParent(scope.root, n.id) ?? scope.root);
  …
}
// :781 — every non-slice layer:
const size = svgSize(n, p);
return `${open(…)}${svgNode(n, true, opts)}</svg>`;    // subtree only; flag never read
```
`ui/exportModel.ts:198-199` exposes and stores the setting for PNG/JPG/SVG, and `ui/inspector.tsx:2696` calls `runExport(a, p)` with **no scope** for the per-layer download button, so the flag has no effect there (and the raster PNG/JPG path inherits the same SVG, `ui/inspector.tsx:9428`).

**Fix (TS only).** Generalize the slice branch: when `ignoreOverlap === false` and a `scope.root` is available, render the parent container (or the whole page) clipped to the target's box, for any layer kind, not just slices. The renderer already supports "container + crop" for slices, so this is a predicate change plus passing the scope from `inspector.tsx:2696`.

---

### F10 · PNG/JPG of text rasterizes an SVG `<text>` with no font embedded
**Category B** · `engine/svgExport.ts:750`, `ui/inspector.tsx:9428`

**Figma.** Raster export is produced by Figma's own document renderer with the document's font; the exported PNG matches the canvas even on a machine that lacks the font.

**X-Native.** For non-SVG formats the exporter leaves text as markup:
```ts
// engine/svgExport.ts:750
outlineText: p.outlineText ?? p.format === "SVG",     // ⇒ false for PNG/JPG/PDF
// :617 — the element:
<text … font-family="Inter, …" font-size="…" …><tspan x="…" dy="…">…</tspan></text>
```
The raster path then loads that SVG through an `Image` and draws it (`ui/inspector.tsx:9428`):
```ts
image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
```
An SVG loaded via `<img>` is a separate document: it cannot see the page's `@font-face` rules (`apps/web/src/styles.css:1-70`, self-hosted Inter/Geist/Outfit/Plus Jakarta/Fira Code/JetBrains Mono in `apps/web/public/fonts`). So a design set in Geist, Outfit or Plus Jakarta Mono/`small-caps` rasterizes to a **fallback font** in PNG/JPG while looking correct on canvas, and the exported SVG states only a family name (no `@font-face`, no outline) unless the user has "Outline text" ticked — which the UI only offers for SVG (`ui/exportModel.ts:44,54`).

**Fix (TS only, one of).** (a) Force `outlineText` for raster/PDF formats as well (the tracer already exists and is what Figma's default does for SVG); or (b) embed the used fonts as base64 `@font-face` inside the raster-source SVG. Option (a) also removes any dependency on the rasterizer's font stack.

---

### F8 · "Include bounding box (text layers only)" changes nothing
**Category C** · `ui/exportModel.ts`, `ui/inspector.tsx` *(detail row: §4 C2)*

**Figma.** For PNG/JPG (and the SVG equivalents) the setting "Include bounding box (text layers only)" makes the export keep the text layer's full box, "empty space and all". ([Export formats and settings](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings))

**X-Native.** The flag is modelled, defaulted per format, validated against `FORMAT_CAPS`, rendered as a checkbox only when the selection is a text layer, and carried in presets:
- field and defaults: `engine/types.ts:446`, `ui/exportModel.ts:19,42,52,62,199`;
- UI: `ui/inspector.tsx:8984-8986` ("Text layers only: keep the layer's bounding box, empty space and all"), preset copy at `:9204`;
- capability assertions: `engine/__tests__/parity.test.mjs:2407-2448`.

**Root cause.** No exporter reads it. It never reaches `exportSvg`'s options (`engine/svgExport.ts` has no `boundingBox` reference), so the SVG is always sized by `svgSize(n, p)` — i.e. the current node box or the crop box — and the raster/PDF paths inherit that SVG unchanged (`ui/inspector.tsx:9428`).

**Fix (TS only).** Read `p.boundingBox` in `svgSize`/`exportSvg` for text nodes and use the layout box (advance width and full line-box height from `engine/layout.ts`/`ui/textLayout.ts`) instead of the tight node box; add a test that a single-word text layer exports wider than its tight ink box.

### (Also Category B, already recorded) · "Simplify stroke" / "Outline text" defaults are not selection-aware
Carried forward from `FIGMA_HELP_AUDIT_2026-10-01_07_EXPORT_FORMATS.md` §6 and re-verified here: `engine/svgExport.ts:750-752` resolves both settings **on for every SVG preset** (`p.outlineText ?? p.format === "SVG"`), whereas Figma defaults them per selection (Outline text on when at least one text layer is in the selection; Simplify stroke on for vector networks with inside/outside strokes). Because the flags are memoized per preset (`ui/exportModel.ts:203`), a stored preset can also freeze a default. Lower severity than F1–F10; listed for completeness since it changes generated markup.

---

## 4. Category C — Unwired capability (engine right, UI/model not exposing it)

| ID | Capability that exists | Where it exists | Where it is not wired | Effect |
|---|---|---|---|---|
| C1 | Vector + text PDF writer, image XObjects, gradient shadings, glyph outlining | `crates/x-render/src/sinks.rs:41-60`, `crates/x-render/src/raster.rs`, `crates/x-text/src/text_geometry.rs` | `crates/x-wasm/src/session.rs:341-378` (`export_node` → `encode_node_*` flat-colour stubs) | F1, F2 |
| C2 | "Include bounding box (text layers only)": modelled, validated, stored, shown only for text selections | `ui/exportModel.ts:19,42-62,199`, `ui/inspector.tsx:8984-8986` | No reader: a repo-wide grep for `boundingBox` finds only the field (`engine/types.ts:446`), the settings model (`ui/exportModel.ts:185,199,224`), the checkbox (`ui/inspector.tsx:8984-8986`), a preset-copy merge (`ui/inspector.tsx:9204`) and the capability assertions in `engine/__tests__/parity.test.mjs:2407-2448` — **no exporter consults it** | The checkbox changes nothing in any format; Figma draws the text layer's box into the export |
| C3 | Font metrics for line height | `engine/layout.ts:606-614` (`FONT_METRIC_RATIOS`), `engine/layout.ts:641-676` (`resolveFontMetrics`), `ui/textLayout.ts:200-232` (`fontMetricRatios` DOM probe), `crates/x-text/src/shaping.rs:908` (`natural` line box) | `ui/textLayout.ts:87` (auto branch) | F3 |
| C4 | Container/root-crop SVG rendering | `engine/svgExport.ts:764-779` (slice branch) | Plain-layer branch `:781`; `runExport` never passes a scope for per-layer downloads (`ui/inspector.tsx:2696`) | F9 |
| C5 | Interaction/`setActiveMode` variable mode switching | `engine/memory.ts:4970-4979`, `ui/chrome.tsx:3764-3766`, prototype action at `ui/Canvas.tsx:1125` | No **layer/frame-scope** mode override: the model stores only `activeModes[collectionId]` (`engine/types.ts:1133`), so a subtree cannot run a different mode the way Figma's "apply a mode to a frame/layer" does | Medium: design-system parity gap (flagged as a capability gap, not a wrong behavior) |
| C6 | Text baseline machinery | `engine/layout.ts:688-717` (`childBaseline`, `baselineRow`), `engine/layout.ts:726-731` (`effectiveCrossAlign` — documented as a deliberate rule: a vertical flow has no baseline line, so a stale `baseline` falls back to the start edge, which is what the alignment box offers) | The *auto* **line box** used to place baselines resolves through the 1.2em constant (`ui/textLayout.ts:87` → `:486`), so baseline rows are measured correctly against the wrong line height | Compounding of F3; the `effectiveCrossAlign` rule itself is intentional (not a finding) |

---

## 5. Category D — Intentional custom design (verified correct, **no action**)

Each item below was inspected specifically to make sure it is *not* being mistaken for a bug. In every case the behavior matches Figma and only the chrome differs.

| ID | X-Native choice | Why it is correct |
|---|---|---|
| D1 | Rotation paints **no** handle; only the cursor changes (`ui/Canvas.tsx:3690-3694`, `ROT_CURSOR` at `:10203`) | This is Figma's model ("hover just outside a corner … the cursor switches to the curved rotation arrow"). The removal of the stem+dot was correct; only the *hit geometry* is wrong (F6). |
| D2 | Auto-layout padding/gap regions painted as translucent pink bands (`ui/Canvas.tsx:3903-3941`) rather than Figma's exact tint | Chrome colour/opacity only; the drag behavior (padding: ⌥ opposite, ⌥⇧ all sides — `:6040-6058`; big-nudge ⇧ — `:7177`) matches the documented shortcut table. |
| D3 | Point-box handles use a 6px painted square with a 10px padding and 7px hit radius (`ui/pointBox.ts:44-50`, painted at `ui/Canvas.tsx:4419`) vs. Figma's dot styling | Geometry/behaviour parity verified: ⇧ = proportional resize, ⌥ = from centre, ⇧ on a corner = 15° rotate, Space = reposition — exactly Figma's *Edit multiple points using bounding boxes* table; the sizes are our own chrome. |
| D4 | Move tool in point edit also inserts a point on the path (the `+` preview, `ui/Canvas.tsx:6223-6245`, insert at `:5886-5890`) | Figma's own lesson "FD4B: Use vector edit mode to modify shapes" describes hovering the path and clicking the previewed point without switching tools; the Pen route (`P`) also works here. Equivalent behaviour, not a mismatch. |
| D5 | Vector sub-tool toolbar placement/labels (`ui/Canvas.tsx:9756-9840`), Zen HUD, radial menu, dock | Position, iconography, copy — explicitly out of scope. |
| D6 | `W × H` / rotation-angle badge, guides, ruler, minimap chrome (`ui/Canvas.tsx:3699-3720`) | Our chrome; the *values* shown match the model. |
| D7 | Sections keep their own title-inside placement and rename affordance (`ui/Canvas.tsx:8190-8235`) | Behavior (double-click label → inline rename, top-level constraint `engine/memory.ts:111`) matches Figma; only the label geometry differs. |

---

## 6. Step 3 — Prioritized action plan (top 5 highest-leverage fixes)

**P1 — Make the WASM export path render, or take it out of the serving path.**
*Type:* **Rust wiring**, plus a TS guard and tests.
`crates/x-wasm/src/session.rs:341-378` must build a `RenderTree` + `Assets` + `FontManager` and call `x-render`'s raster/`export_pdf_full` sinks; until then, `engine/wasmExport.ts:55-64` should refuse every node (return `null`) so `ui/inspector.tsx:9309-9311` uses the SVG→canvas path, and `tryWasmExport` must not return `true` for a result whose pixel content was never verified. **Highest leverage in the report:** it converts a silent, content-dependent corruption of the primary output surface into either correct output or a non-event, and it unblocks P2.

**P2 — Wire the vector PDF writer to the UI.**
*Type:* **Rust wiring** + **test addition**.
Once P1's plumbing exists (`RenderTree`/`FontManager` available inside `x-wasm`), PDF should be produced by `crates/x-render/src/sinks.rs:60 export_pdf_full` (paths, glyph outlines, image XObjects, gradient shadings) and `apps/web/src/engine/pdf.ts` should be demoted to the no-wasm fallback. Test: golden-file structural assertions on the PDF (path operators present, `/Font` or glyph-outline streams present, images as XObjects) rather than magic bytes.

**P3 — Resolve line height from font metrics for the Auto case.**
*Type:* **TS tweak** (with a matching **Rust** constant change and a **test addition**).
`ui/textLayout.ts:87` → `(ascent − descent + lineGap) × fontSize`, sourcing `lineGap` from an extended `FONT_METRIC_RATIOS` (`engine/layout.ts:606-614`) with a DOM/textMetrics preference where available; mirror in `crates/x-text/src/shaping.rs:914` so parity tests are not comparing two copies of the same approximation. This is the single change that moves every text layer, every hugged text frame, every baseline row and every exported SVG closer to Figma at once.

**P4 — Fix the auto-layout gap gesture (effective value + all gaps).**
*Type:* **TS tweak** + **test addition**.
(a) The `autoGap` handler (`ui/Canvas.tsx:7169-7181`) must write `gapMode: "fixed"` alongside the numeric gap (and start the delta from the *effective* spacing so an Auto frame does not jump), otherwise F4's inert drag persists; (b) the press loop (`ui/Canvas.tsx:6058-6067`) must offer the handle at every adjacent pair instead of only pair 0–1, matching what the painter already bands (`:3923-3941`).

**P5 — Make point-editing hit test respect what is painted, then fix the two vector gestures that fail because of it.**
*Type:* **TS tweak** + **test addition**.
(a) Gate the handle branches in the press loop on `selNow`/the dragged point (`ui/Canvas.tsx:5815-5827`) — this alone stops silent geometry corruption (F5); (b) rotate from all four corner rings (`ui/canvasSelection.ts:56-73`) and invert the two tests that assert the current behaviour (`ui/__tests__/canvasSelection.test.mjs:74,76`); (c) add the anchor-entry path to Bend/⌘ (`ui/Canvas.tsx:5827-5886`) so "click a point to curve it" exists (F7).

*Runners-up, deliberately outside the top five (higher effort / narrower blast radius):* F8 (`Include bounding box` no-op), F9 (`ignoreOverlap` for non-slices), F10 (raster text fonts), F11 (marquee into sections), F12 (Windows `S`), F2 (already covered by P2), C5 (layer-scope variable modes).

---

## 7. Step 4 — Sabotage-verified testing strategy (top 3)

Each test below is written so that a **specific, plausible sabotage of the fix** flips it red. Test files follow the repository's existing harnesses: engine tests use the `t(name, ok)` pattern under `apps/web/src/engine/__tests__/`, DOM tests mount `Canvas` with `installDom()` and real mouse events as in `ui/__tests__/frameInteraction.dom.test.mjs`.

### T1 · Export pixels are real pixels (for P1/P2)
**File:** `apps/web/src/engine/__tests__/wasmExportContent.test.mjs` *(new)* and `crates/x-wasm/src/session.rs` *(extend the existing `#[cfg(test)] mod tests`)*

**Fixture:** a 200×100 page frame (fill `#ffffff`) containing a red rect `#ff0000` at x 0–100 and a blue rect `#0000ff` at x 100–200.

**Assertions (must be content-sensitive, not magic-byte):**
1. Decode the PNG (`x_format::base64` plus a ~20-line IDAT reader — the workspace already links `miniz_oxide`, see `crates/x-format/src/figbinary.rs:48`, and `crates/x-format/src/png_import.rs` shows the header parsing) and assert `pixel(10, 50)` is red-ish and `pixel(190, 50)` is blue-ish, i.e. two sampled pixels **differ** and each matches its source layer.
2. Same document, `format = "pdf"`: assert the content stream contains **more than one** painting operator (`> 1` of `re`/`f`/`m`/`l` groups) and, for a text-bearing fixture, that a glyph-outline stream (or `/Font`) is present; assert the page is not a single full-bleed fill.
3. TS side: assert `tryWasmExport` returns `false` (or that `runExport` chooses `canvasExportPath`) for the fixture *until* the Rust sink is wired, so the guard cannot silently regress.

**Sabotage that must fail it:** revert `encode_node_png` to the one-row repeat (or make `node_rgba` the only colour source) → assertion 1 fails because both sampled pixels become the frame's white/aligned fill; revert `encode_node_pdf` to the single `re f` stream → assertion 2 fails. Sabotage check #2: delete the guard in `engine/wasmExport.ts:55-64` and assert the TS test (3) still fails-safe.

### T2 · Auto line height follows the font, not a constant (for P3)
**File:** `apps/web/src/engine/__tests__/typography.test.mjs` *(extend)* + `apps/web/src/ui/__tests__/textLineHeight.dom.test.mjs` *(new, for the DOM probe path)*

**Assertions:**
1. With the canvas probe stubbed (the existing DOM harness already replaces `getContext("2d")`), return `fontBoundingBoxAscent = 0.905 × size`, `descent = 0.212 × size`, `lineGap = 0.033 × size` for a probe font, and assert `effectiveLineHeight(node, 100)` is **111.7**, not `120`.
2. For a 3-line paragraph inside a hug-height text layer, assert `hugHeight(...)` equals 3 × the font-derived line height (and therefore differs from the old constant by more than 0.5px).
3. Assert the same value reaches the SVG: `exportSvg(textNode, {format:"SVG", …})` contains `<tspan … dy="111.7">` for the second line.
4. Cross-check the Rust side: a unit test in `crates/x-text/src/shaping.rs` asserting the first-line baseline uses the natural box (`(ascent − descent + line_gap) × size/upem`) for `lh_mode == 0`.

**Sabotage that must fail it:** restore `return Math.max(1, fs * 1.2);` at `ui/textLayout.ts:87` → (1) and (3) go red for a font whose default ≠ 1.2; sabotage the SVG path specifically by hard-coding `n.fontSize * 1.2` at `engine/svgExport.ts:443` → (3) alone goes red, proving the export is covered independently of the canvas.

### T3 · The point-edit press matches the paint (for P5a/P5b)
**File:** `apps/web/src/ui/__tests__/vectorHandleHit.dom.test.mjs` *(new)* — mount `Canvas` exactly as `vectorEditTools.dom.test.mjs` does (real `mousedown`/`mousemove` on the wrap element, engine snapshot inspected afterwards).

**T3a — unselected handle is not a target.**
Fixture: a vector whose point `#1` has `out = (30, 0)` but is **not** in `vecPoints`; point `#0` is selected; a point-edit session is open.
- Assert `selNow`-invisible handle: dispatch `mousedown` 7px from `#1`'s out-handle position, then `mousemove` 20px, then `mouseup`.
- **Expected (fixed):** no `patchPath` is dispatched with `path[1].ox` changed; the gesture is either an anchor drag of `#1` or an `insertPointOnPath` on the segment.
- **Sabotage:** remove the new `if (!editable) continue;` guard → a `patchPath` that moves `path[1].ox/oy` appears and the assertion fails.
- **Companion paint assertion** (keeps the two in lockstep): with the recording `getContext` proxy, assert no handle-drawing call happens for `#1` while it is unselected — the same test then fails if someone "fixes" the grab by painting all handles instead.

**T3b — rotation is corner-symmetric; the old assertions are inverted.**
**File:** `apps/web/src/ui/__tests__/canvasSelection.test.mjs` *(edit)*
- Replace `:74` with: for each of the four corners and each kind ∈ {frame, component, instance, rect, group}, `rotationHandleHit(kind, cx + 16, cy − 16, …)` **is** true (and for the top-left corner too, inverting `:76`), while `rotationHandleHit(kind, cx + 4, cy − 4, …)` (inside the 8px corner-handle radius) is **false**, so corner resize still wins.
- **Sabotage:** restore `frameRotationHandle`'s single top-right point and the top-right-only ring → the top-left/bottom-left/bottom-right assertions go red, while the "corner resize wins" assertion stays green (proving the test discriminates rather than just asserting true).

**T3c — auto-gap drag is no longer inert (pairs with P4).**
**File:** `apps/web/src/engine/__tests__/autoLayoutEdgeCases.test.mjs` *(extend)*
- Build a horizontal auto-layout frame with `gapMode: "auto"`, `spacing: "between"`, three children; dispatch the exact command the canvas drag produces (`{type:"autoLayout", layout:{…, gap: 24}}`) and assert the **rendered** boxes: child 2's x minus child 1's right edge equals 24 (today it equals the auto spacing, so the assertion fails before the fix — sabotage: drop `gapMode: "fixed"` from the handler and it fails again).
- Add the "any pair" assertion: with three children, simulate a press in the middle gap and assert an `autoGap` drag starts (today the press loop only offers pair 0–1).

---

## 8. Confirmation of scope discipline

1. **No visual UI change is requested anywhere in this report.** Every finding names a *gesture*, a *modifier*, a *hit test*, a *geometry computation* or *exported bytes*. Items whose only difference is chrome are listed in §5 (Category D) with "no action".
2. **No new feature is proposed.** P1–P5 wire or correct code paths that already exist in this repository: `x-render`'s export sinks, `FONT_METRIC_RATIOS`/`fontMetricRatios`, the existing `gapMode`/`autoLayout` command, the existing corner-ring hit test, and the existing handle/mirror engine dispatches.
3. **Behavior and output only.** Each Category A finding documents the input → reaction difference; each Category B finding documents the produced bytes/structure; each Category C finding documents logic that exists but is not reachable.
4. **Evidence discipline.** Every claim carries a `file:line` reference verified at `9baf0cd`, and every Figma claim carries the article it came from. Where the documentation is ambiguous (`F11`), the finding is marked with a confidence level rather than asserted as certain.

---

## 9. Appendix — documents consulted (Figma Learn, fetched 2026-10-04)

| Article | Used for |
|---|---|
| [Edit vector layers](https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers) | Point editing, add points, Bend tool, Mirroring options, Cut tool, lasso, point bounding box (⇧ / ⌥ / ⇧-corner / Space) |
| [Vector networks](https://help.figma.com/hc/en-us/articles/360040450213-Vector-networks) | Pen workflow, caps |
| [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | Marquee semantics, ⌘/Ctrl for nested layers, "top-level … or inside a section" |
| [Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma) | Hug/Fill/Fixed, min/max, Ignore auto layout (⌃ Control / `S`), canvas shortcut table (⌥ / ⌥⇧ padding, ⇧ big nudge, double-click edge = hug, ⌥ double-click = fill), components-vs-instance table |
| [Explore text properties](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties) | Auto line height = font's intrinsic line height; line-height shortcut |
| [Adjust text dimensions and resizing](https://help.figma.com/hc/en-us/articles/27378154668951-Adjust-text-dimensions-and-resizing) | Single-click = auto width, drag = Fixed size; manual canvas resize ⇒ Fixed |
| [Export formats and settings](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings) | Per-format settings matrix, Ignore overlapping layers rules (incl. the slice special case), SVG/PDF at 1x, Outline text default, PDF/strokes notes |
| [Shape tools](https://help.figma.com/hc/en-us/articles/360040450133-Shape-tools) | Double-click to enter object editing on shapes |
| Related community/forum sources (linked inline) | Rotation affordance phrasing; Bend-tool modifier behavior |

**Prior in-repo audits reconciled with this one:** `FIGMA_HELP_AUDIT_2026-10-04_45_CANVAS_VECTOR_PARITY.md` (rotation *paint* removal — respected here as correct; §D1), `FIGMA_HELP_AUDIT_2026-10-01_07_EXPORT_FORMATS.md` (PDF raster + bounding-box + SVG defaults — re-verified and carried forward as F2/F8/F9 and the note in §3), `AUTOLAYOUT_EDGE_CASES_*` and `TEXT_TYPOGRAPHY_*` (used as the regression suites the new tests extend).
