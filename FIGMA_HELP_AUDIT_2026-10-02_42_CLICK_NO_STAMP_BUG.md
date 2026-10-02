# Figma Help Audit — Batch 42 (2026-10-02) — Real canvas bug: click stamped 100×100 shapes

## Bug found & fixed (#17)

**Any bare click (no drag) with a shape/frame/line/arrow/slice/section tool
active stamped a default 100×100 shape onto the canvas.** This was a real
usability bug — in Figma, shape tools require you to **drag** to create; a
click either selects the topmost layer under the cursor or deselects, and
the tool reverts to Move (V). The only exception is the Text tool, where
a click enters edit mode at that point (which X-Native already handled
correctly).

Root cause: in `src/ui/Canvas.tsx` onUp handler for the "create" drag, a
click (drag distance < 4px) fell into the `if (clicked)` branch that
hardcoded `w = 100; h = 100;` for rect/ellipse/frame/section/pen/polygon/
star and `w = 100; h = 1` for line/arrow, then dispatched `{type:"add"…}`,
dropping a shape on the canvas every time. The Text tool already had its
own separate path that stayed correct.

### Fix applied

`src/ui/Canvas.tsx` onUp create branch:

- For any non-text shape tool, a bare click now does NOT call add().
  Instead it:
  1. Clears `drag.current` (abandons the in-progress create gesture).
  2. Switches to the `select` tool (matches Figma returning to Move after
     a click).
  3. Performs a hit-test at the click point; with Shift it toggles the
     hit layer into/out of the current selection, without Shift it
     replaces selection with the hit layer or deselects if nothing is
     under the cursor.
  4. Clears the selection marquee band.
- The Text tool path is untouched (click still creates a hug/hug text
  layer and opens the editor).
- The zoom tool path is untouched (d.zoom early-return above already
  handles click-to-zoom-in and ⌥-click-to-zoom-out).

Files touched:
- `apps/web/src/ui/Canvas.tsx`: replaced the `w=100;h=100` click branch
  with select-on-click + tool-revert logic.

### Test added

- `apps/web/src/engine/__tests__/clickNoStamp.test.mjs` (4 assertions):
  no new node is created by a shape-tool-click-then-select sequence;
  drag-create still adds a rect when w/h are explicit; text click still
  creates a text layer with kind `text`.

## Verification

- Full repo test battery: **4671 passed, 0 failed** (+4 from
  clickNoStamp, +4 from guideSelectionMutex, +6 from zoomShortcuts,
  +4 from selectAllSiblings over the previous batches — all new tests
  green, no regressions).
- `tsc -b --noEmit` clean.
- `npm run build` 5.82 s.
- Dev server live at http://localhost:5173 (200).

## Cumulative product bugs fixed across the QA session: 17
- #15 (batch 40): non-Figma ⌘0/1/2/3 zoom aliases removed.
- #16 (batch 41): guide/layer selection ⌫ mutex fixed.
- #17 (batch 42): shape-tool clicks no longer stamp 100×100 shapes —
  select-on-click matches Figma.
