# Phase 2 — Core Editor: status 2026-09-25 (TypeScript product track)

Companion to `docs/CANONICAL_ARCHITECTURE_2026.md`. Phase 2 covers: Pen tool,
Node editing, Shape Builder, Boolean UI + live preview, Stroke editing,
Variable-width manipulation, Selection, Snapping, Guides, Alignment.

## Audit result

Most of Phase 2 already existed in the production app (`apps/web`): pen /
pencil / node editing with bend + lasso + shape-builder subtools, boolean ops
+ flatten + outline-stroke in the inspector, the stroke panel, smart guides +
draggable ruler guides with snap-to-guide, and align/distribute. The two gaps
were **variable-width strokes** (a type in `modifierStack.ts` only — no node
field, rendering, or UI) and **boolean live preview** (ops committed
immediately). Both are implemented here, end to end.

## What shipped

### A. Variable-width strokes (`apps/web/src`)

- `engine/types.ts` — `VariableWidthPoint` (`position` 0..1 along the
  centerline's arc length, `widthMultiplier` relative to `strokeWidth`) and
  `VariableWidthProfile` moved here from `modifierStack.ts` (which
  re-exports them); new `XNode.strokeWidthProfile?: VariableWidthPoint[]`.
  Persists with the node automatically; old documents load without it.
- `engine/strokeModel.ts` — the single funnel every consumer uses:
  `normalizeWidthProfile` (sort + clamp 0..1 / 0..8), `sampleVariableWidth`
  (linear interpolation, accepts the bare array or the `{ points }`
  modifier-stack shape), `hasVariableWidth` (< 2 points or all-equal takes
  the uniform fast path), `maxWidthMultiplier`, `widthAt`,
  `usesVariableWidth` (vector/line/arrow + visible weight + varied profile).
- `engine/geometry.ts`
  - `outlineVariableStroke(path, width, profile, closed, cap, join,
    miterLimit)` — centerline → closed filled contour. Arc-length
    parameterization; **segments are split at each interior control
    position** so a straight 2-point line still honors mid-path points;
    miter/bevel/round joins with a ratio miter limit (round fans the outer
    side only); caps sized by endpoint widths (a taper to 0 needs no cap).
    Closed loops include the wrap segment in the total. A missing/uniform
    profile delegates to `outlineStroke`, so plain strokes render
    byte-identical to before.
  - `widthProfileStations` — node-local control-point stations for the
    canvas dots, resolved by the same arc-length walk the outline uses.
- `engine/memory.ts` — `outlineStroke` bakes through `outlineVariableStroke`
  when a profile is active and clears the profile afterwards (geometry is
  now literal fill); hit-test stroke tolerance scales with
  `maxWidthMultiplier` so fat strokes stay clickable.
- `engine/modifierStack.ts` — the `Stroke` modifier honors `variableWidth`
  through the same function, unifying the node stroke and the canonical
  modifier-stack path.
- `ui/Canvas.tsx` — profiled base strokes paint as filled outlines
  (center-aligned by construction); arrow/triangle/diamond tips scale with
  the width at their end and vanish where the stroke tapers to nothing;
  control-point dots overlay the selected profiled stroke (hidden under
  rotation, where the translation-only page offset would misplace them).
- `engine/svgExport.ts` — profiled strokes export as filled outline paths
  (SVG has no variable stroke); uniform strokes unchanged.
- `ui/inspector.tsx` — `WidthProfileEditor` in the Stroke section for
  vector/line/arrow with weight > 0: envelope strip, click to add at the
  sampled width, drag sideways/up-down to move/resize (pointer capture, so
  dragging above the strip grows past the display scale), double-click or
  Alt-click to delete, Reset to uniform. Every gesture is a `patch`, so a
  drag coalesces into one undo step. Dev Mode notes the limitation (CSS
  comment + "variable" inspect row).

Explicit semantics (also in the `XNode` field doc): profiles apply to the
base stroke of vector/line/arrow centerlines only; a profiled stroke paints
center-aligned and ignores dashes (canvas cannot dash a filled outline);
extra `strokes` rows stay uniform; vectors with no path centerline keep
uniform segment strokes.

### B. Boolean live preview

- `engine/types.ts` + `engine/memory.ts` — `Snapshot.booleanPreview:
  BooleanOp | null`: armed-op view state, never persisted, never in history.
  `setBooleanPreview` arms/clears; selection change, tool change, and
  boolean commit clear it. Moves/nudges/resizes do not — the overlay tracks
  them live.
- `previewBoolean(op, root, ids)` (exported, pure) — runs the same
  `booleanPath` over the same inputs (`transformedPoly` + node offsets, same
  operand order) the `boolean` command bakes, translated to page space.
  Returns null unless the selection is exactly what the command would act
  on (2+ same-parent, non-frame nodes), so the overlay is the result Apply
  would commit.
- `ui/Canvas.tsx` — dashed accent outline + translucent fill overlay,
  recomputed every frame; `Esc` discards, `Enter` applies (when no pen
  draft / text edit / vector edit is in flight).
- `ui/inspector.tsx` — multi-select Boolean section: op buttons apply
  immediately as before; the Preview toggle arms the overlay, the op buttons
  then switch the previewed op, and an Apply/Cancel row commits or discards.

### C. Fixed along the way

`outlineStroke` forced `isClosed = true` for open vectors, baking a
degenerate chord-loop (zero area for 2-point paths). It now respects the
vector's own `closed` flag when the node carries a real path; shape outlines
from `shapePoly` are still treated as closed loops. Open vectors now outline
to a proper ribbon (uniform and profiled alike). No existing test covered
open-vector outline (only lines, which are unaffected).

## Verification (this commit)

- `npx vite-node src/engine/__tests__/parity.test.mjs`: **890 passed,
  0 failed** (830 pre-existing + 60 new: profile math, outline expansion incl.
  taper/bulge/caps/closed/joins/delegates, engine patch/undo/redo/bake,
  preview helper + view-state transitions, SVG export, modifier-stack
  stroke, dot stations).
- `npx tsc --noEmit`: clean. `npm run build`: clean.
- Dev server serves (`vite --host 0.0.0.0 --port 5173`, HTTP 200).
- Browser-driven checks (preview overlay pixels, strip dragging) were not
  run here — no Chromium in this sandbox; the e2e suite needs a follow-up
  run wherever it executes.

## What is NOT done (follow-ups, in value order)

1. Canvas dragging of width dots (dots are display-only; editing is in the
   inspector strip).
2. Pressure-recorded width on pencil/brush input (`pressure_points` in the
   canonical model).
3. Inside/outside alignment and dashes for profiled strokes (documented as
   center-only / ignored for now).
4. Per-branch widths on branched vector networks (profile follows `path`).
5. e2e behaviour checks for the preview toggle and the strip, run with Chromium.
6. Rust canonical-track port (`x-editor` variable-width API, guides model,
   Transaction emission) — needs the CI push-and-check loop; no toolchain here.
