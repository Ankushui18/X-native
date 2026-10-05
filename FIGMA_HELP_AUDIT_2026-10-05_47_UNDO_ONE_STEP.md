# Figma Help Audit — Batch 47 (2026-10-05) — Undo stopped stepping one action at a time

## The report

“Why is our undo not working like one step at a time?” — after a rotation (and a
few other handle drags), a single ⌘Z rolled back the drag **and** everything the
user did after it, as if those later edits had never been separate steps.

## Figma first (as asked)

- “Press undo, then an equal number of redos, and the file returns to exactly
  the state it held before” — Figma's own undo model (2019 engineering post,
  quoted by saasdesign.io/learn/figma-undo and wpdean.com).
- “Each press steps back one action” (saasdesign.io/learn/figma-undo); “Press it
  once and the last thing you touched snaps back. Press it again and Figma steps
  one action further into the past.” (wpdean.com).
- Ctrl+Z/Cmd+Z / Shift+Cmd+Z are the chords; history is a session-only chain,
  and there is no “Undo History” menu item (figmafy.com's “Undo History” claim
  is wrong — it is Version History, a different product surface).

So: **one user gesture = one step, and a later edit = a later step.** A single
undo that crosses two actions (a leaked group) is the parity bug.

## Root cause (found by reproducing, not by reading)

`Canvas.tsx` opens an undo group on pointer-down (`engine.dispatch({type:"begin"})`)
for every canvas gesture, and closes it on release. The release check listed the
drag modes by hand and omitted eight of them:

`rotate`, `bend`, `starRatio`, `starCount`, `starRadius`, `polyCount`,
`polyRadius`, `radius` (corner-radius pin).

Those drags opened a group and never closed it, so `groupStack` stayed non-empty
and `MemoryEngine` stayed in “grouping” mode: **every history command after the
drag merged into that one entry** (no new undo step was pushed), and one ⌘Z
popped the entry saved before the drag — rolling back the handle drag and all
the unrelated work after it.

Reproduced through the mounted canvas (jsdom, real `Canvas` + `MemoryEngine`):
a rect rotated by its ring handle, then a fill patch — one undo reverted both
(`rotation 24 → 0` **and** `fill #ff0000 → #d9d9d9`), two undos were needed for
two actions that should have been one each.

## Fix

- `apps/web/src/ui/Canvas.tsx`
  - The release list is now the one `GESTURE_MODES` set (28 modes) that the
    press sites feed; the release is `GESTURE_MODES.has(d.mode) || (marquee &&
    erase)`. A mode missing from the set is a shipped bug, so the set is the
    single place to look.
  - Two more single-action sequences made one step while there: a prototype
    connection (interaction + first-flow-start page patch) and the paint-bucket
    click (region patch + `fillVisible`) each wrapped in `begin`/`end`, because
    otherwise one click cost two ⌘Z presses.
- `apps/web/src/ui/__tests__/gestureUndoSteps.test.mjs` (**41 assertions**,
  wired into `npm test`): mounts the real canvas and drives every previously
  leaking handle — rotate, corner radius, star ratio/count/radius, poly
  count/radius, bend — asserting the drag changes the document, the follow-up
  edit lands, **one undo takes back only the follow-up**, and a second undo
  takes back the drag. Sabotage check: removing the eight modes from
  `GESTURE_MODES` fails 8 of the assertions (verified per mode; bend needs the
  `act()`-flushed vec-edit entry, which the test does).

## Verification

- `gestureUndoSteps.test.mjs` — 41 passed, 0 failed.
- Sabotage: pre-fix mode list → 8 failures, one per previously leaking mode;
  bend needed an `act()`-flushed vector-edit entry to be measured (an un-acted
  `setVecEdit` left the press on the box's own resize handle — itself a small
  lesson in how the mounted-canvas tests must be written). Restored → green.
- Full `npm test` chain (all batches through `gestureUndoSteps`) — exit 0, no
  failing suite; final suite `41 passed`.
- `tsc -b --noEmit` clean; `npm run build` 5.24 s (pre-existing >500 kB chunk
  advisory only).

## Cumulative product bugs fixed across the QA session: 18
