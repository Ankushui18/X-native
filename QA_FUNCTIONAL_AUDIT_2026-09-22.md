# Functional QA Audit — testing every control like a product tester

**Date:** 2026-09-22 · **Branch:** `arena/01a0c8fe-x-native`
**Method:** drove the running app in headless Chromium. Clicked every inspector button
with a *fresh page per button* (so no prior toggle contaminates the next test), drew with
every tool, exercised every popup, and measured real DOM geometry against the panel box.
Findings are from execution, not from reading source.

---

## Verdict up front

The functionality is **mostly there and mostly correct** — undo/redo, duplicate,
copy/paste, group, delete, all nine drawing tools, all five nav panes and both colour
popovers work. What was broken was not *missing features* but **controls the user could
not reach or that silently did nothing**. Those are worse than missing features, because
the user concludes the product is flaky rather than incomplete.

Four real defects found and fixed. Three "defects" turned out to be bugs in my own test
harness, and I've labelled them as such rather than claiming credit.

---

## 1. Real defects found and fixed

### 1.1 Align buttons silently did nothing on auto-layout children — **the worst bug**

Selecting `Chip` (inside the auto-layout `Card`) and clicking any of the six align
buttons produced **zero change**. X/Y stayed at `16,90`. No error, no feedback.

Root cause: children of an auto-layout frame are positioned by the layout pass, so the
`move` command the align helper dispatched was recomputed away on the next tick. The
button was wired, the dispatch fired, and the result was discarded.

This is exactly the "why would anyone choose us" problem — in Figma, align buttons on an
auto-layout child **retarget the parent's alignment** (main axis = `justify`, cross axis
= `align`). That is the only thing that can actually move the child. Implemented that
mapping, correctly accounting for horizontal vs vertical stacks:

```ts
const key = isX === horizontal ? "justify" : "align";
```

Verified by canvas pixel diff on four different nodes — all now move. Multi-select align
(a separate code path) re-tested and still correct.

### 1.2 The entire Stroke section overflowed the panel — controls unreachable

With a stroke added, measured geometry showed the section hanging **up to 75px past the
right edge of the 240px panel**. The dash toggle and part of the join segment were
physically outside the panel and unclickable.

Three compounding causes, all fixed:
- Grid/flex children default to `min-width: auto` and refuse to shrink → added
  `min-width: 0` to the grid/flex children in the inspector.
- Cap (4) + join (3) + dash (1) = 8 controls × 32px = 256px, more than the 216px of
  usable width → they now wrap to a second line via `.stroke-ends`.
- The stroke width row used `.grid3`, which reserves a trailing 32px column it does not
  use, squeezing the 96px align segment into 84px and clipping "outside" → gave it its
  own `.stroke-width` flex rule.

An honest note on process: my first attempt "fixed" the overflow with
`overflow-x: auto`, and my own follow-up check caught that this had merely *hidden*
"Cap arrow" and "Join round" behind a scroll edge. Making an unreachable control
differently unreachable is not a fix. Replaced with wrapping.

### 1.3 Context menu hung off the bottom of the screen

Right-clicking a low object put the menu 2px past the viewport. The clamp used an
*estimated* height (`28px × items + 7px × separators`) which drifts from reality. Now
measures the rendered node in `useLayoutEffect` and re-derives the position from the true
height. Re-tested: sits exactly 8px inside the edge.

### 1.4 Verification sweep

A 12-scenario sweep across node types × added sections checks for panel overflow, clipped
text, and buttons hidden inside their segment:

```
pass Chip · Title · Card · iPhone 14 · Success · Label
pass Chip+Add stroke · Chip+Add stroke+Dash · Chip+Add export
pass Chip+Add auto layout · Title+Add stroke · Card+Add stroke+Dash
```

All 12 pass. Before the fixes, 4 failed.

---

## 2. What I tested that was already correct

Worth recording so it isn't re-litigated:

| Area | Result |
|---|---|
| Undo / redo / duplicate / copy+paste / group / delete | all correct, layer counts exact |
| Drawing tools: rect, ellipse, line, text, frame, brush, slice, comment | all create nodes |
| Pen tool | correct — builds from discrete clicks, commits on Enter |
| Fill popover + Stroke popover | both open, 240×385, not clipped |
| Gradient ramp: add stop by mid-click | works, 2 → 3 stops |
| Nav rail: File / Agent / Assets / Tools / Vars | all five render content |
| Context menu | 17 items, opens correctly |
| Effects menu | opens, all 4 effect types add |
| Console / page errors across every test | **zero** |

---

## 3. Three findings that were my harness, not the product

Reporting these as bugs would have been wrong:

1. **"Fill and stroke popovers never open."** My selector was `.pop`; the real class is
   `.fill-pop`. Both always worked.
2. **"Pen tool creates nothing."** I drag-tested it. The pen is click-to-place-anchors,
   commit on Enter — which is Figma's behaviour and is correct.
3. **"Flip H/V do nothing."** They don't change X/Y (correct — flipping is in place); they
   mutate `flipH`/`flipV`, corner radii and child positions. My X/Y-only detector
   couldn't see it.

A fourth: an early run reported everything after "Dev Mode" as disabled, because that
click switched panels and every later query ran against the wrong view. Fixed by using a
fresh page per button.

---

## 4. Still missing vs Figma (not fixed — needs real work)

Honest list, since the goal is Figma's level:

- **Effects are inline, not a popover.** Figma opens a proper effect editor; here shadow
  controls stack directly in the panel. Functional, less refined.
- **Single fill / single stroke per node.** No `fills[]`/`strokes[]` arrays, so no
  stacked fills — a genuine model-level gap, not cosmetic.
- **No shared styles**, no rulers/guides, no minimap, no zoom dropdown.
- **No tooltips with shortcut hints**, no empty states, no confirm/undo toasts.
- **No motion anywhere**, no contextual cursors.
- Comment tool draws a blue ellipse rather than a real comment thread.

---

## 5. On "free isn't a reason to choose us"

Agreed, and the align bug was the clearest example of why. A user evaluating this would
select a button inside a card, click align-right, see nothing happen, and stop
evaluating. Not because a feature was missing — it was *there and wired* — but because it
didn't do the thing Figma does in that exact situation.

The pattern across all four defects is the same: **the feature existed, but the last mile
to Figma-equivalent behaviour was missing.** Stroke controls existed but sat outside the
panel. Align existed but not for auto-layout children. The context menu existed but fell
off the screen. That last mile is the entire difference between "a Figma clone" and
"something you'd actually switch to."

**Next highest-value work, in order:** contextual cursors and hover/press motion (the two
things that make an editor feel alive), tooltips with shortcuts, then `fills[]`/`strokes[]`
and shared styles for real model parity.

---

## Verification

`tsc -b --force` clean · `npm test` 11/11 · `npm run build` clean
(341.26 kB JS / 104.69 kB gzip) · 12/12 layout sweep · zero console/page errors
across every scenario exercised.
