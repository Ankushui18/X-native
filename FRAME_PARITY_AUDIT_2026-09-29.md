# Frames parity — measured deviations (audit, awaiting fix approval)

**Run**: 2026-09-29 · **Scope**: Frame container logic — resize vs scale, clip
content under rotation, resize to fit. Files read: `apps/web/src/engine/layout.ts`,
`apps/web/src/engine/memory.ts` (`resize` / `resizeToFit` / `scaleProps` /
`applyConstraints`), `apps/web/src/ui/Canvas.tsx` (handle-drag dispatch,
rotation transform, clip, PR #43 composite-tile path).
**Status**: **measured — 2 real deviations (D1, D2), 3 of the brief's 3 probe
areas partially deviating.** No engine code changed. Awaiting approval for the
fix. Suite untouched: 69 files · 3,671 assertions · 0 failing.

Instrument: `apps/web/tests/probes/frames/edgeCases.mjs`
(`npx vite-node tests/probes/frames/edgeCases.mjs`, from `apps/web`) — 15
measurements, engine + real Skia pixels (`@napi-rs/canvas` via
`src/ui/__tests__/realCanvas2d.mjs`), the app's own paint path under test.

---

## 1 · Figma documentation (step 1)

From *Frames in Figma Design* ([360041539473](https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design)):

| Behaviour | Quote |
| --- | --- |
| **Resize ≠ scale** | *"Drag to resize a frame manually … Click the handle in one of the corners and drag to resize. Or, click one of the edges and drag."* … *"**Tip!** To ignore any constraints on child objects, hold down the modifier key"* … and for presets/fields: *"If you have applied constraints to any child objects, Figma will resize them to match the new frame preset. **Otherwise, objects inside the frame will stay at the original dimensions and position.**"* — handle-dragging runs the **constraints** solver; children are never scaled. Scaling children is the separate Scale tool (`K`) behaviour. |
| **Clip Content** | *"**Clip Content**: Hide any objects within the frame that extend beyond **the frame's bounds**."* The bounds are the frame's own box in its **local coordinate system**: the frame is one rotated object, so the mask turns with it — an axis-aligned mask would clip in a "different style" than the frame itself. |
| **Resize to fit** | *"You can resize a frame so that it shrinks or grows to fit its child objects. This will **redraw the frame around the outermost bounds of the objects within it**."* — the objects' outermost bounds (a stroke is part of an object's bounds: outside strokes spill fully, centre strokes by half), not their geometry boxes. |

## 2–3 · Audit & measurements (exact pixels)

### A · Resize vs Scaling — **MATCH (0 px deviation)**

The brief's exact case, dispatched with the payload `ui/Canvas.tsx` sends on a
plain handle drag (`{ type: "resize", scaleProps: tool === "scale" }`):

| # | Scenario | Measured | Figma expects | Verdict |
| --- | --- | --- | --- | --- |
| A1 | 200×200 frame, 50×50 child pinned top-left, right edge dragged to 300 | child **(10, 10) 50×50** | 50×50 at (10,10) — Resize, not Group (75×50) | **MATCH** |
| A2 | `max` / `stretch` children, same drag | max **(110, 10) 50×50**; stretch **(100,100) 150×50** | constraints resolve exactly | **MATCH** |
| A3 | Scale tool (`scaleProps`) control | child **(15, 10) 75×50** | only the Scale tool scales children | **MATCH** |
| A4 | ⌘/Ctrl-drag (`ignoreConstraints`) | child untouched **(10,10) 50×50** | "To ignore any constraints … hold down the modifier key" | **MATCH** |
| A5 | nested frame child | stays **60×60** | constraints, not group scale | **MATCH** |

`memory.ts::case "resize"` routes `scaleProps` → `scaleProps()` (uniform child
scale) and otherwise → `applyConstraints()`; the canvas handle-drag only sets
`scaleProps` when the Scale tool is active. The reported "group behaviour" is
**not** present in the frame path. (Note: `multiResize` — a multi-selection
drag — intentionally scales each member's box like a group selection; that is
Figma's multi-select behaviour and is out of scope here.)

### B · Rotation & clipping — **DEVIATION D1 (the "different style")**

Scene: 200×200 frame at (100,100), **Clip content ON**, red child spanning
local x 150→250 (50px past the right edge), rotated 45° about (200,200). The
rotated right edge passes world **(270.71, 270.71)** (t=100 on the outward
diagonal); the child's ink would run to (306, 306) unclipped.

| # | Path | Measured | Expected | Verdict |
| --- | --- | --- | --- | --- |
| B1 | direct paint, unrotated | ink in at (275,200); clean at (325,200) | red / white | **MATCH** |
| B2 | direct paint, 45° | P_in(264,264) **red**; P_out(278,278) **white**; ink ends **t=99** | cut at the rotated edge (t≈100) | **MATCH** |
| B3 | **effects tile** (any drop shadow / layer blur / noise / texture), 45° | P_out(278,278) **RED**; ink runs to **t=140** (world (299,299)) | white past t≈100 | **DIFF** |
| B4 | 90° bar test (80×20 child must stand vertical) — frame & group, direct vs tile | direct: vert 1600 / horiz 500 ✓; **tile: horiz 1600 / vert 500 ✗** | one 90° turn | **DIFF** (tile) |

**D1 — root cause (characterised):** the PR #43 composite-tile path
**double-applies the container's rotation to its whole subtree**.
`effectsTile()` bakes `ctx.getTransform()` into the tile *after* `paint()` has
already applied `ctx.rotate(n.rotation)`; the re-entrant
`paint({ ...n, effects: plain }, …)` then applies the rotation **again**. Net
effect at 45°: content lands at 90°, and the twice-rotated clip square of a
square frame maps back onto its own axis-aligned box — so clipped children
**leak past the frame** and nothing visibly rotates the way the frame does.
Measured signatures: ink edge t=140 vs the correct t=100 (P_out (278,278)
(255,0,0) instead of white); the 90° bar renders at 180° (1600 horiz px where
the correct render has 1600 vert px). **Blast radius: every effected container
with children** — frames (clipped) and groups (unclipped) alike; any visible
drop-shadow / layer-blur / noise / texture row routes through the tile. The
direct path (no effects) is correct, which is why non-effected frames looked
fine.

### C · Resize to fit — **DEVIATION D2 (stroke spill dropped)**

Scene: 400×400 frame with three children — A (50,50) 40×40 **outside stroke 10**
(spill 10), B (200,100) 60×60 **centre stroke 20** (spill 10), C (30,250) 50×50
**rotated 45°** (bbox 70.71). Figma: *"redraw the frame around the outermost
bounds of the objects within it."*

| # | Scenario | Measured | Figma expects | Verdict |
| --- | --- | --- | --- | --- |
| C1 | frame after `resizeToFit` | **(19.64, 50) 240.36×260.36** | **(19.64, 40) 250.36×270.36** | **DIFF** |
| C2 | children through the refit | world (50,50)/(200,100)/(30,250) preserved | preserved | **MATCH** |
| C3 | hidden child off to the side | fit **(100,100) 50×50** | hidden objects ignored | **MATCH** |
| C4 | child outside a tiny frame | fit **(40, 0) 60×30** | redraw around the objects (old box not a union member) | **MATCH** |

**D2 — root cause:** `memory.ts::resizeToFit` builds each child's corners from
`[0,0]..[c.w,c.h]` through `nodeMatrix(c)` — the **geometry box**. The children's
stroke spill is never added (the engine's own `strokeSpill()` helper in
`strokeModel.ts` — outside strokes by full weight, centre by half — is used for
hit-testing but not here). Measured: frame **w −10.00, h −10.00** vs the
outermost bounds (A's top spill and B's right spill dropped), origin y **50
instead of 40**. Rotation of children is handled correctly (C's rotated bbox
counts).

## 4 · Missing behaviour — exact statement

1. **D1**: *"An effected frame/group (drop shadow, layer blur, noise, texture)
   renders its children at **twice** its own rotation, and a Clip-content
   frame's mask under rotation degenerates (45° → content at 90°, ink leaking
   past the rotated edge — measured edge at t=140 vs 100, P_out (278,278) red
   instead of white)."* The clip-content mask does not follow the frame's
   bounds through the composite-tile path — the brief's "rotation is a
   different style" symptom.
2. **D2**: *"Resize to fit ignores children's stroke widths — measured
   240.36×260.36 where Figma's outermost bounds give 250.36×270.36 (−10 px on
   both axes)."*

## 5 · Proposed fixes (not yet applied)

1. **D1** (`ui/Canvas.tsx`): break the double transform at the tile recursion —
   the tile's CTM already carries the container's rotation/flip (captured from
   `ctx.getTransform()` after the rotate), so the re-entrant `paint()` must
   **skip its own rotation/flip block** (a `tilePass` flag, same shape as
   `maskTile`), keeping fills/clip/children identical to the direct path. The
   clip `roundRect` then lands on the rotated bounds and children paint once.
   Alternative: create the tile before the rotation block and let the recursion
   rotate; the flag is more local and reuses the path proven by the direct
   render.
2. **D2** (`memory.ts::resizeToFit`): pad each child's corner set by its
   `strokeSpill(c)` (already imported in `memory.ts`) before `nodeMatrix(c)` —
   symmetric local padding maps correctly under the child's own rotation.
3. Neither fix touches `layout.ts`, the commands, or the Rust/WASM boundary.

## 6–8 · Tests & checklist (on approval)

- `apps/web/src/engine/__tests__/frameParity.test.mjs` (new, wired into
  `npm test`): A1–A5 resize-vs-scale, B1–B4 rotated clipping incl. the 90°
  bar discriminator on both paint paths and both container kinds, C1–C4 resize
  to fit incl. stroke spill. Sabotage: route the plain handle drag through
  `scaleProps` → A1 fails; re-introduce the double rotation → B2/B3/B4 fail;
  drop the spill pad → C1 fails.
- Living record: *Create and edit layers → Frames in Figma Design* row +
  checklist **MATCH** after the fix; run-13 block in
  `FIGMA_CREATE_DESIGNS_COMPARISON.md`.
- Baseline to preserve: **69 files · 3,671 assertions · 0 failing**.

---

## Outcome (run 13, after approval)

Both deviations fixed and the whole article surface re-audited:

- **D1** — `ui/Canvas.tsx::paint()` gained `tilePass`; the composite-tile recursion no longer re-applies the container's rotation (it lives in the tile CTM exactly once). Probe: tile-path 45° ink ends at **t=100** (was 140), P_out(278,278) **white** (was red); the 90° bar turns vertical exactly once, frames and groups. Direct path unchanged (already matched).
- **D2** — `memory.ts::resizeToFit` pads each child's corners by `strokeSpill(c)` before `nodeMatrix(c)`. Probe: **(19.64, 40) 250.36×270.36** = Figma's outermost bounds.
- Article surface (F/A tool keys, ⌥⌘G frame selection, ⇧⌘G/⌘⌫ ungroup, ⌥⇧⌘R resize to fit, Enter/Tab/⇧Enter navigation, presets, first-frame 100×100 / last-top-level-size, W/H field math): all present; no other deviation found.

`src/engine/__tests__/frameParity.test.mjs` (17 checks) pins all three behaviours and is sabotage-verified (resize-through-scaleProps → A fails; rotation re-applied in the tile pass → B fails; strokeSpill pad zeroed → C1 fails; each restored byte-exact). Suite: **70 files · 3,688 assertions · 0 failed · exit 0**; `npx tsc -b` clean. Living record: `FIGMA_CREATE_DESIGNS_COMPARISON.md` run 13 + the §1 **Frames in Figma Design** row (MATCH).
