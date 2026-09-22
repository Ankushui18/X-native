# UI Design Critique — a designer's read on the X-Native interface

**Date:** 2026-09-22 · **Tree:** `arena/01a0c8fe-x-native`
**Method:** rendered the running app in headless Chromium at 2× DPR and *looked* at it —
default state, selection, gradient picker, command palette, and all four themes. Findings
below are from screenshots and measured DOM geometry, not from reading CSS.

---

## The one-line answer

**It is a good Figma clone and a mediocre product.** The visual craft is genuinely high —
if you showed someone a screenshot they would believe it was Figma. What is missing is
not polish, it is *confidence*: the UI copies Figma's surface faithfully but has no
opinion of its own, and it goes quiet exactly where Figma reassures you.

**Verdict: close to Figma visually (~85%), behind Figma experientially (~55%), and
better than Figma in two narrow places.**

---

## 1. What is genuinely good

**The visual system is disciplined.** One 32px control height everywhere, a consistent
6px radius, 8/12px padding rhythm, Inter at 11px for chrome. Nothing is accidentally
14px. That consistency is the hardest thing to get right and it is right here.

**Colour restraint is correct.** The chrome is greyscale, colour is reserved for meaning
(`#0d99ff` selection, `#7b61ff` components, red snap guides). This is exactly Figma's
discipline and most clones fail it by decorating the panels.

**Four complete themes**, all contrast-audited. Graphite and Daylight come from a real
audited palette in `x-ui`. Figma ships two. This is a genuine win.

**The command palette is the best screen in the product** — clean rows, right-aligned
shortcut hints, instant filter.

**The bottom tool dock** is Figma UI3's layout, executed well: dark pill, clear active
state, flyout carets on grouped tools.

**Two places this is actually better than Figma:**
1. **OKLab gradient interpolation** — ramps don't go muddy through the midpoint the way
   Figma's sRGB blending does. A real, if subtle, quality edge.
2. **Theme range** — four audited palettes vs Figma's two.

---

## 2. Defects I found by looking — and fixed in this pass

These were all invisible in code review and obvious in a screenshot.

| Defect | What it looked like | Cause | Fix |
|---|---|---|---|
| **"Edit vector" / "Flatten" clipped** | Two buttons overlapping into unreadable mush in the Layout section | `.seg button` hard-coded `width: 32px` for icon segments; these two hold *text*. Measured: 43px and 45px of text in 32px boxes. | `min-width` + `flex` + padding; added `.seg.icons` for the 8 genuinely icon-only rows so they keep their square rhythm |
| **"Aut15.6" in Typography** | Line-height label bleeding into its own value | `.field label { width: 10px }` — correct for X/Y/W/H, wrong for the word "Auto" | `min-width: 10px` + `white-space: nowrap` |
| **White block in dark mode** | A bright rectangle beside "Pages" in every dark theme | The `.twist` reset was scoped `.row .twist`; the copy inside `.section-label` kept the UA default grey button background, rendering white-on-white | Unscoped the reset to `.twist` |
| **Gradient stop row unusable** | Hex field crushed to ~4 characters, buttons jammed edge-to-edge | My own multi-stop editor put 7 controls on one 240px row | Split into a values row + right-aligned actions row |

Verified after fixing: a sweep across all four themes for clipped text and low-contrast
controls now reports **zero** in both categories.

---

## 3. Where it still falls short of Figma

### 3.1 The interface never talks to you
This is the biggest experiential gap and it is not cosmetic.

- **No empty states.** Deselect everything and the right panel shows "Background / Pixel
  grid / Export" — no hint of what to do. Figma uses that exact space to teach.
- **No tooltips with shortcuts.** Buttons have `title` attributes, so you get the OS
  tooltip after ~1.5s with no keyboard hint. Figma's dark tooltips appear in ~300ms and
  always show the shortcut. The app *knows* every shortcut — they're in the palette — but
  never surfaces them at the point of use.
- **Destructive actions are silent.** Delete a page: gone, no confirmation, no undo toast.
- **Only one toast exists** ("Link copied"). Nothing else ever confirms anything.

### 3.2 Density is Figma's, hierarchy isn't
Section headers (`Position`, `Layout`, `Fill`) are 11px/500 in near-full-strength text —
nearly the same weight as the values beneath them. Figma's headers recede so your eye
lands on values. Here everything competes, so the panel reads as one long undifferentiated
list. **This is the single highest-leverage visual fix available** and it is a one-line
change to the header colour.

### 3.3 No motion whatsoever
Zero transitions in the entire chrome. Panels appear, menus snap, hovers jump. Figma is
restrained but not static — 80–120ms on hovers and menu fades. The absence reads as
"unfinished prototype" more than "fast".

### 3.4 Interaction affordances
- **No cursor feedback.** Resize handles don't produce directional cursors; the eraser
  and pen show a default arrow. Figma's cursors are a core part of the feel.
- **The rotate handle is invisible** — a 4px dot 20px above the selection with no hover
  target growth. Figma uses generous invisible hit zones just outside each corner.
- **Focus states are inconsistent** — fields get a blue border, icon buttons get nothing.
  Keyboard-only navigation is effectively impossible.

### 3.5 Honest gaps
No rulers or guides. No minimap. No zoom dropdown (keyboard only). No comments UI
(the tool draws a blue ellipse). No multiplayer or version-history surface. Panels are
fixed-px, so below ~1100px the canvas is crushed; there is no responsive behaviour.

---

## 4. Is it a Figma clone?

Yes, and more literally than the codebase admits. `styles.css` opens with the comment
*"Figma UI3 light — panels white, canvas #e5e5e5, selection #0d99ff"*, and those are
Figma's exact values. Layout grammar, icon metaphors, panel order and tool grouping are
all Figma's.

That is a reasonable strategic choice — zero-friction switching for Figma users — but it
has a cost worth naming: **the product has no visual identity of its own.** The only
original elements are the logo and the Agent rail item. If X-Native is ever meant to be
its own product rather than a compatible alternative, this is the thing to revisit. Right
now a screenshot is indistinguishable from Figma, which is impressive as craft and risky
as strategy.

---

## 5. Scorecard

| Dimension | Score | Note |
|---|---|---|
| Visual consistency | 9/10 | genuinely disciplined |
| Colour & theming | 9/10 | 4 audited themes, better than Figma |
| Typography (chrome) | 7/10 | correct scale, weak hierarchy |
| Layout & density | 8/10 | Figma-accurate |
| Iconography | 8/10 | hand-drawn, consistent, on-metaphor |
| Information hierarchy | 5/10 | headers compete with values |
| Feedback & guidance | 3/10 | no empty states, tooltips, confirmations |
| Motion | 1/10 | none |
| Cursor & affordance | 4/10 | no contextual cursors |
| Accessibility | 3/10 | focus gaps, canvas not keyboard-navigable |
| Responsive | 2/10 | fixed-px desktop only |
| Originality | 3/10 | near-exact Figma replica |
| **Looks like Figma** | **8.5/10** | |
| **Feels like Figma** | **5.5/10** | |

---

## 6. What I'd do next, in order

Ranked by payoff per unit of effort:

1. ~~**Recede the section headers**~~ — **done in this pass.** `.h-row h3` and
   `.section-label` now use `--muted`. Contrast re-checked: light 4.6:1, dark 5.3:1,
   graphite 10.0:1, daylight 5.4:1 — all pass WCAG AA.
2. **Custom tooltips with shortcut hints** (~300ms, dark pill). The data already exists.
3. **Motion pass** — 80–120ms on hover/menu/panel. Half a day, changes the whole feel.
4. **Contextual cursors** — directional resize, crosshair for draw tools, eraser circle.
5. **Empty states** in the right panel and Assets/Variables panes.
6. **Confirm + undo toasts** for destructive actions.
7. **Focus-visible rings** on every interactive element.
8. Then the structural items from the parity audit (rulers/guides, `fills[]`, styles).

Items 1–7 are all small, all cosmetic-layer, and together would move "feels like Figma"
from ~5.5 to ~8 without touching the engine.
