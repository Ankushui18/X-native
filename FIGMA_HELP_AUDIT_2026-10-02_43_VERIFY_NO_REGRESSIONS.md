# Figma Help Audit — Batch 43 (2026-10-02) — Verification + regressions check

## What was done this batch

Reinstalled `node_modules` (cleared between turns) and restarted the dev
server after the batch-42 click-no-stamp fix. Then re-verified the fix
did not break Pen / Pencil / Brush / Eyedropper bindings or the ⇧I Place
image shortcut.

### Findings on hot-key ordering (not a bug)

- Bare **I** fires `armGlobalEyedrop()` at line 2384 with an early return,
  so it never reaches the tool-map at line 3150. Eyedropper is bound
  correctly per Figma's I shortcut.
- **⇧I** does not match `isEyedrop` (which requires `!e.shiftKey`), falls
  through past the block that ends at line 3149, and then the tool-map
  `i: "image"` fires Place Image — matching Figma's ⇧I Place image.
- **Pen** tool has its own `if (snap.tool === "pen")` branch at line 4798
  that runs BEFORE `drag.current = {mode:"create"}` is ever set (line
  5020), so my click-fix's `if (clicked)` branch inside `d.mode ===
  "create"` is never reached for Pen — it handles clicks via its own
  vertex-branch / add-point logic before create-drag starts. Pencil and
  Brush similarly have their own early handlers (lines 4901, 6100
  pencil.current accumulator).
- **Zoom** tool click/drag is handled by `if (d.zoom)` earlier in the
  create branch and returns before the clicked-rect fallback.

So the batch-42 fix correctly applies to shape/frame/line/arrow/slice/
section tools only, and does not regress Pen/Pencil/Brush/Eyedropper/
Zoom/Text.

## Verification

- Full repo test battery re-run after re-installing dependencies:
  **4671 passed, 0 failed** (identical to batch-42 baseline; no
  regressions from the click fix).
- `tsc -b --noEmit` clean.
- `npm run build` 5.37 s.
- Dev server live at http://localhost:5173 (HTTP 200).

## Cumulative product bugs fixed across the QA session: 17
