# Frame interaction QA — measured deviations and fixes (2026-09-29)

**Scope**: the "frame selected → handles / rotation / move / nested / rotated /
Auto Layout / constraints" tree from the 2026-09-29 audit, treated as
*interaction* QA rather than a feature checklist: does a press do what the
hover cursor promised, does the selection chrome sit where the layer is
painted, does a drag on a child of a rotated or offset frame follow the
pointer. Verified first, fixed second.

**Instrument**: `apps/web/tests/probes/frames/interaction.mjs` — the mounted
`Canvas` (jsdom + recorded 2D-context calls, the same harness as
`canvasSelection.test.mjs`), real `mousedown/mousemove/mouseup` sequences,
geometry read back from the `MemoryEngine`. Interaction wiring and geometry,
not browser pixels.

**Regression suite**: `apps/web/src/ui/__tests__/frameInteraction.dom.test.mjs`
— **47 assertions**, wired into `npm test`. Sabotage-verified: with the fixed
engine but the pre-fix `Canvas.tsx`, **15 fail** (listed in §4); with the
fixes, 0. Whole suite green, `tsc -b` clean.

---

## 1 · What the audit claimed vs what was measured

| Audit item | Claim | Measured |
| --- | --- | --- |
| no unwanted centre handle | — | **MATCH** — 8 handles, none at the centre (frame and shape) |
| rotation affordance in the correct place | — | **MATCH** — frames: detached curved arrow 20 px above top-centre; corners resize-only. Shapes: 8–22 px ring outside each corner |
| resize handles don't compete with rotation | "matched" | **DEVIATION D3** — on any *non-frame* layer with a side ≤ 44 px the edge-midpoint handle lies inside the corner rotation ring and the press tested rotation first: the hover cursor said `ew-resize`, the press rotated |
| selection outline follows rotation | "matched" | **DEVIATION D1** — a layer's own rotation, yes; an *ancestor's* rotation or flip, no. `worldPos` accumulated translation only, so a child of a 90° frame painted at world (290–330, 70–150) drew its selection box at the unrotated (120,120) and hit-tested its handles there |
| dragging a frame doesn't resize it | — | **MATCH** for top-level layers |
| nested layer names don't clutter | — | **MATCH** — idle canvas labels only top-level frames; a nested frame's name appears only when it is selected; a selected ancestor suppresses unselected descendants' names |
| children don't get selected when manipulating the parent | — | **MATCH** — press on a selected container never drills; double-click does |
| Auto Layout frames don't expose controls that don't apply | — | **MATCH (as Figma)** — a hug frame still shows 8 handles; dragging one switches that axis to fixed |
| constraints on frame resize | — | **MATCH** (`constraintH`/`constraintV` = min/max/center/stretch/scale, ⌘ ignores) — already covered by `frameParity.test.mjs` |
| multi-selection resize / move / rotate (3 objects) | "fresh regression needed" | **MATCH** — bounding-box scale of members (Figma's multi-select behaviour), collective move, collective rotate about the box centre |
| **not in the audit list** | — | **DEVIATION D2 (P0)** — resizing a child of *any* offset frame was broken: the drag was measured against the page origin instead of the parent, so +50 px on a child at parent offset (200,100) produced **w 350 instead of 150**, and a top-left corner drag collapsed the box to **h = 1** |

## 2 · Root causes

**D1 — placement ignored ancestors.** `memory.ts::worldPos` summed `n.x`/`n.y`
up the tree and returned the real node; every canvas consumer (selection
chrome, handle hit-test, hover cursor, drag start) then applied only
`node.rotation`/`flipH`/`flipV` about that box. The painter and `hitTest` use
the full `worldMatrix`, so what you saw and what you could grab disagreed the
moment a parent was rotated or flipped. The `move` command then added the
page-axis delta straight to parent-local `x`/`y` — inside a 90° frame a drag to
the right moved the child *along the parent's y*.

**D2 — resize mixed coordinate spaces.** The resize drag converted the pointer
to page space (`toWorld`) but measured it against `d.orig`, the layer's box in
*parent-local* space, then wrote the result back with `resize`. Correct only
when parent-local == page, i.e. for top-level layers. Pre-existing on `main`
(shallow history, so not dated).

**D3 — hit order.** The single-selection press tested `rotationHandleHit`
before the resize-handle loop; the hover-cursor code tests them the other way
round, so the two disagreed exactly where the areas overlap (shapes with a
side under ~44 px).

## 3 · Fixes (TypeScript only — no Rust file, no WASM boundary touched)

`apps/web/src/engine/memory.ts`
- **`worldPlacement(root, id)`** (new, exported) — the layer's on-page placement
  including every ancestor's rotation/flip. All transforms in the tree are rigid,
  so the composite is exactly "an unrotated `w`×`h` box at some page position,
  turned by a total angle about its centre" — the shape every consumer already
  assumed of `{x, y, node.rotation}`. When the ancestry is a plain translation
  it returns `worldPos` verbatim (real node, same numbers → zero change for the
  common case); otherwise `node` is a shallow copy carrying the total
  rotation/flip. `worldPos` itself is unchanged: the engine's reparenting paths
  use it as a parent offset, not a placement.
- **`parentWorldMatrix`, `worldDeltaToParent`, `worldPointToParent`,
  `parentHandedness`** (new, exported) — the three conversions the canvas
  needs (delta, point, and the sign a screen-clockwise turn has under a mirrored
  ancestry).
- **`move { world?: true }`** (`types.ts`) — a pointer drag's delta is on the
  page; with the flag the engine converts it into each root's parent axes. The
  plain command keeps its parent-local meaning (nudge, align, tests untouched).

`apps/web/src/ui/Canvas.tsx`
- Imports `worldPlacement as worldPos`, so all 88 canvas placement reads
  (selection box, handles, badge, hover cursor, drag starts) move at once.
  Documented at the import.
- **Resize drag**: pointer → `worldPointToParent` → the existing own-rotation
  unrotate against `d.orig`. Page-axis edge snapping is skipped while the
  parent's axes are not the page's (a snap there would shear the box).
- **Rotate**: press records the layer's *own* rotation (`find`), not the total;
  the drag multiplies the swept angle by `parentHandedness` and converts the
  rotation-origin slide with `worldDeltaToParent`. The live `°` badge shows the
  layer's own angle (what the inspector shows).
- **Move drag** dispatches `move{world: true}`.
- **Hit order**: a resize handle (< 8 px) now outranks the rotation ring in the
  press path, matching the cursor. Frames are unaffected (their corners never
  rotated).

## 4 · Sabotage evidence (fixed engine, pre-fix `Canvas.tsx`)

```
FAIL nested child resize measures the drag in its parent's space (+50 → w 150, not 350) — {"x":50,"y":50,"w":350,"h":80}
FAIL nested child corner resize keeps the opposite corner pinned — {"x":270,"y":129,"w":130,"h":1}
FAIL nested child body drag moves without resizing
FAIL selection box is drawn about the painted centre (310,110) — [120.5,120.5,80,40]
FAIL no stale outline at the unrotated spot (120,120)
FAIL dragging the painted child +30 screen-x moves it -30 along its local y — {"x":50,"y":20}
FAIL the drag stayed a move (no resize/patch)
FAIL hover over the painted right-edge handle shows a screen-axis resize cursor — default
FAIL press on that handle resizes (does not rotate) — ["select","begin","move","move","end"]
FAIL dragging the painted right edge +20 along local x grows w 80→100 with x,y fixed
FAIL rotating on screen adds the swept angle (126°) to the layer's own rotation
FAIL rotation about the centre leaves the box in place
FAIL selection box is drawn at the mirrored position (world x 300) — [120.5,120.5,80,40]
FAIL dragging right on screen moves the child left in its mirrored parent
FAIL small shape: the press honours that promise (resize, not rotate)
frameInteraction: 32 passed, 15 failed
```

## 5 · Still open after this pass (recorded, not hidden)

1. **Vector / arc / gradient / radius / padding handle drags inside a rotated
   ancestry** go through `nodeLocalPoint(wpt, wp.x, wp.y, wp.node)` with a
   page-space `wpt`; the *placement* they read is now right (so the handles are
   drawn and hit correctly) but the drag maths still assumes the parent's axes
   are the page's. Same shape of fix as the resize drag (one
   `worldPointToParent` before `nodeLocalPoint`); not done here to keep the
   change reviewable.
2. **Frame name labels** (`labelNames`) walk the tree with translation only, so
   a *selected* nested frame inside a rotated frame draws its name at the
   unrotated corner. Unselected nested names are suppressed, so the idle canvas
   is unaffected.
3. **Corner-radius pins vs corner resize handle** overlap in a ~2 px sliver on
   the diagonal (pin ≥ 12.7 px from the corner, radius 7; resize radius 8). Pins
   are tested first. Figma insets its pins similarly; left as is.
4. **Hover cursor under a rotated ancestry** is derived from the total angle
   (`resizeCursor(i, box.rot)`) — correct on screen — but a mirrored ancestry
   still picks the cursor for the un-mirrored handle index.
5. The comparison's Gradients row says "no web canvas handles"; `Canvas.tsx`
   has a `grad` drag mode with `g`/`h` handles behind `gradTarget`. Worth a
   re-measure before treating that row as current.
