# Micro-Behavioral Parity Audit: X-Native vs Figma

**Date:** 2026-09-25 · **Branch:** `arena/01a0d904-x-native` @ `3364bec` · **Track:** TypeScript (`apps/web`)
**Scope (only):** ① vector-edit tools & modifiers · ② booleans (creation, inheritance, shortcuts, ungroup) ·
③ stroke model (align/caps/dash/joins/arrows/miter/individual) · ④ auto-layout hug/fill/fixed + constraints ·
⑤ keyboard shortcuts + a11y basics.

**Method:** code-first (every claim traced to `apps/web/src`), then checked against 9 official Figma Design
help articles (Edit vector layers 360039957634, Boolean operations 360039957534, Stroke properties 360049283914,
Auto layout 360040451373, Constraints 360039957734, Keyboard shortcuts 360040328653, Vector networks 360040450213,
Nudge 4404575206295, Select layers 360040449873). Only gaps that are (a) specific documented Figma behavior done
differently, (b) fixable in <50 lines, (c) visual or muscle-memory impact are listed as fixes (10).

**Environment caveat:** no browser/Chromium is installable in this sandbox (only npm registry + github.com
reachable; Chrome download hosts reset), so Gap 2 could not be screenshot-verified. It is traced end-to-end in
code + canvas spec; a 30-second check (draw a line with the Line tool) will confirm it.

**Implementation status (2026-09-25): all 10 gaps implemented** on this branch; `tsc -b` clean, full suite
1212 passed / 0 failed (8 new regression asserts in `parity.test.mjs`; 1 pre-existing assert updated to the
Figma rule, see Gap 4 note). Implementation deltas vs the audit: Gap 1 — legacy ⌘⌥U/S/I chords were found during
implementation (the audit missed them) and kept as aliases; Gap 2 — the render guard also covers extra-stroke
rows (`paintExtraStrokes`) and old docs with stored `inside` lines, which now centre unconditionally.

---

## Gap 1 — Boolean shortcuts ⌥⇧U / ⌥⇧S / ⌥⇧I / ⌥⇧E are advertised but dead

**Figma (Boolean operations):** the article gives Option+Shift+U (Union), Option+Shift+S (Subtract),
Option+Shift+I (Intersect), Option+Shift+E (Exclude) as the creation shortcuts.

**X-Native now:** the Arrange menu advertises exactly these chords (`ui/chrome.tsx:1182-1185`,
`sc: "⌥⇧U"` etc.) but the window keydown handler binds **none of the advertised ⌥⇧ (no-⌘) chords** — only
legacy `⌘⌥U/S/I` + `⌘⌥X`/`⌘⌥E` variants exist (`:1828-1842`). Pressing ⌥⇧U/S/I/E does nothing. No conflicts:
no existing `alt+shift+letter` binding without ⌘/Ctrl (verified `:1470-1626`).

**Fix (~10 lines, `ui/chrome.tsx` keydown, next to the `:1828` boolean branch):**
```ts
if (e.altKey && !meta && !e.ctrlKey && e.shiftKey) {
  const k = e.key.toLowerCase();
  const op = k === "u" ? "union" : k === "s" ? "subtract" : k === "i" ? "intersect" : k === "e" ? "exclude" : null;
  if (op) { e.preventDefault(); engine.dispatch({ type: "boolean", op }); return; }
}
```
Keep the `⌘⌥E`/`⌘⌥X` aliases to avoid breaking existing users.

---

## Gap 2 — Line/Arrow default `strokeAlign: "inside"` renders shafts invisible (critical)

**Figma (Stroke properties):** position defaults to inside "except for lines, which always have the stroke
applied to the center", and "Lines don't have position or join properties" (no such controls for lines).

**X-Native now:** `node()` defaults **every** kind to `strokeAlign: "inside"` (`engine/memory.ts:128`); the
Line/Arrow drag commit passes only `{ rotation }` (`ui/Canvas.tsx:4570-4571`), so lines keep `inside`. The stroke
pass then runs `traceShape()` (open 2-point path, `beginPath`+`moveTo`+`lineTo`, `:1030-1033`) followed by
`ctx.save(); ctx.clip(); ctx.lineWidth = w*2; ctx.stroke()` (`:1219-1224`). Clipping to an implicitly-closed
degenerate path yields an **empty clip region** (canvas spec: clip intersects with the path's fill region, which
has zero area) → `stroke()` paints zero pixels. SVG export mirrors it (`engine/svgExport.ts:265-269`, degenerate
`<clipPath>`) — canvas and export agree with each other, both wrong. Arrowheads still draw (independent code),
so arrows show a floating head with no shaft. (Same fate for any open pen path the user adds a stroke to, since
vectors also default to `inside`.)

**Fix (~10 lines):**
1. `engine/memory.ts` `node()`: `strokeAlign: kind === "line" || kind === "arrow" ? "center" : "inside"`.
2. `ui/inspector.tsx` stroke section: hide the position seg (`:5328`, `inside/center/outside`) and the join
   control for `line`/`arrow` kinds (Figma shows neither).
3. Verify: draw one line; confirm shaft visible + inspector shows no position/join.

---

## Gap 3 — Default end caps are butt; Figma default is round

**Figma (Stroke properties):** "Round is the default." Round/Square each extend the path by half the stroke
weight per end; None (butt) adds no length.

**X-Native now:** `node()` sets `strokeCap: "none"`, `strokeCapStart/End: "none"` (`engine/memory.ts:131-133`;
only `arrow` kind differs), rendering `lineCap: "butt"` (`ui/Canvas.tsx:1197`, `engine/paint.ts:557`). Every new
line/arrow — and every open path given a stroke — renders butt ends, shorter and squarer than Figma.

**Fix (~3 lines, `engine/memory.ts` `node()`):**
```ts
strokeCap: kind === "arrow" ? "arrow" : kind === "line" ? "round" : "none",
strokeCapStart: kind === "line" || kind === "arrow" ? "round" : "none",
strokeCapEnd: kind === "arrow" ? "arrow" : kind === "line" ? "round" : "none",
```
(Consider `vector` too — Figma's default is round generally — but lines/arrows are the visible-today case since
pen vectors default to stroke-off.)

---

## Gap 4 — Manually resizing a Fill child snaps back instead of becoming Fixed

**Figma (Auto layout):** "Any manual adjustments you make will set the layer to Fixed on the relevant axis"
(X-Native's own `resize` comment at `engine/memory.ts:1706` cites this rule).

**X-Native now:** the `resize` case sets `sizing→fixed` only for `text` (`:1703-1704`) and for frames carrying
their own `layout` (`:1714-1728`). A plain rect/frame child of an auto-layout parent keeps `sizing: "fill"`, and
`applyLayout` — which runs after **every** dispatch (`:1361-1366`) — immediately overwrites fill-child dims
(`:326-336` grid, `:360-390` H/V flow). Dragging the edge of a Fill child, or typing a width in the inspector
(same `resize` path), visibly snaps back. Figma keeps the dragged/typed size and flips the axis to Fixed.

**Fix (~6 lines, `engine/memory.ts` `resize` case, after the layout-frame block):**
```ts
const par = findParent(this.root(), n.id);
if (par?.layout && !cmd.scaleProps) {
  if (askedW !== oldW) n.sizingW = "fixed";
  if (askedH !== oldH) n.sizingH = "fixed";
}
```
(Scale tool stays exempt, matching the existing exemption.)

---

## Gap 5 — ⇧E / ⇧B hijacked globally; vector-edit Eraser/Paint keys missing

**Figma (Edit vector layers):** inside vector-edit mode, Shift+E is the Eraser and Shift+B is the Paint bucket.

**X-Native now:** both chords are bound globally to other actions — ⇧E toggles Design/Prototype tabs
(`ui/chrome.tsx:1548-1552`), ⇧B toggles stroke (`:1642-1646`) — with no vec-edit exception. The eraser itself
exists as a main tool (`Tool` union `engine/types.ts:479`, canvas handling `ui/Canvas.tsx:2743/2961`) but has no
keyboard path; Paint exists as `vecSubTool` (`:277`, button `:5613`, `fillNetworkRegionAtPoint` at `:3440-3448`)
but is toolbar-click-only.

**Fix (~15 lines):** at the top of the chrome keydown handler, before the global ⇧E/⇧B branches:
```ts
if (engine.snapshot().vecEdit && !meta && !e.altKey && e.shiftKey) {
  if (e.key.toLowerCase() === "e") { e.preventDefault(); engine.dispatch({ type: "setTool", tool: "eraser" }); return; }
  if (e.key.toLowerCase() === "b") { e.preventDefault(); window.dispatchEvent(new CustomEvent("x-native-vec-subtool", { detail: "paint" })); return; }
}
```
plus a ~6-line listener in `Canvas.tsx` mapping the event to `setVecSubTool` (the subtool state is Canvas-local;
`eraseAt` is vecEdit-independent so the eraser works in context). Outside vec-edit mode, current ⇧E/⇧B behavior
is unchanged. (Q/Lasso and X/Cut are documented too but Lasso is a type stub and Cut is unimplemented — both
over budget, see Notes.)

---

## Gap 6 — ⌘/Ctrl-resize does not ignore constraints

**Figma (Constraints):** holding Command (Mac) / Control (Windows) while resizing ignores the children's
constraints for that gesture.

**X-Native now:** neither resize dispatch site reads a modifier (`ui/Canvas.tsx:3915` multi, `:4022` single) and
the `resize` command has no bypass flag (`engine/types.ts:908`); `applyConstraints` always runs (`engine/memory.ts:1735`).

**Fix (~8 lines):**
1. `engine/types.ts`: add `ignoreConstraints?: boolean` to the `resize` command.
2. `ui/Canvas.tsx` both dispatch sites: `ignoreConstraints: e.metaKey || e.ctrlKey`.
3. `engine/memory.ts` resize case: `} else if (!cmd.ignoreConstraints) { applyConstraints(...); }`.

---

## Gap 7 — maxHeight clears maxLines, but maxLines does not clear maxHeight

**Figma (Auto layout, text):** "Setting a maximum height clears maximum lines, and vice versa" — the two are
mutually exclusive.

**X-Native now:** setting max height zeroes lines (`ui/inspector.tsx:3923`, `patch({ maxH, maxLines: 0 })`) but
setting max lines leaves `maxH` intact (`:3424`, `patchType({ maxLines: v })`), so both limits can be armed and
the tighter one wins silently.

**Fix (1 line, `ui/inspector.tsx:3424`):** `patchType({ maxLines: v, maxH: undefined })`.

---

## Gap 8 — Double-click does not drill into frames/groups

**Figma (Select layers):** click selects the parent; double-click (like Enter) drills one level into it.

**X-Native now:** `onDbl` handles edges (hug/fill, `:4714`), frame rename, text edit, vec-point corner toggle,
and vec-edit entry — but a double-clicked frame/group/boolean falls through to plain re-select (`ui/Canvas.tsx:4834-4836`).
Enter-drill exists (`:615-623`); double-click has no equivalent.

**Fix (~12 lines, `ui/Canvas.tsx` `onDbl`, before the final `else if (hit)`):** if `hit` is a frame/group (or
boolean with children), select the deepest visible unlocked child containing the click point (reuse the
`worldPos` walk; fall back to first visible child like the Enter path), and `return`. Single-click stays
parent-first (already correct — `deep: e.metaKey || e.ctrlKey`, `:3615`).

---

## Gap 9 — Boolean members' fill/stroke/effects/opacity stay editable (but render nothing)

**Figma (Boolean operations):** the individual layers' fill, stroke, effects, and opacity are locked — only the
boolean group's own properties apply (it renders the baked path with the group's paint, `paintBoolean`,
`ui/Canvas.tsx:6461`).

**X-Native now:** no lock exists — the inspector shows fully editable fill/stroke/effects/opacity for a member of
a boolean group, and edits silently change values nothing renders. (`inspector.tsx` has zero boolean-parent
checks; `const parent = findParent(...)` already exists at `:3171`.)

**Fix (~12 lines, `ui/inspector.tsx`):** `const boolChild = parent?.kind === "boolean";` and pass
`disabled={boolChild}` (with `title="Controlled by the boolean group"`) to the fill section, stroke section,
effects rows, and opacity field — Figma's exact four.

---

## Gap 10 — Circle arrowhead missing

**Figma (Stroke properties / Vector networks):** the endpoint menu lists None, Round, Square, Line arrow, Circle,
Triangle, Reverse triangle, Diamond.

**X-Native now:** `StrokeCap` + UI offer `none/round/square/arrow/triangle/reverse-triangle/diamond`
(`engine/types.ts:61-64`, `ui/inspector.tsx:5389`) — no Circle. Render lives in one canvas branch
(`ui/Canvas.tsx:1282-1370`) and one export branch (`engine/svgExport.ts:285-310`); icons `cap-*` in
`ui/icons.tsx:78-82` lack `cap-circle`.

**Fix (~20 lines):** add `"circle"` to `StrokeCap`; extend `isTip` (`Canvas.tsx:1282`); add a fill-`arc()` branch
(radius `eah*0.55` at the endpoint, honoring `tipScale`) next to the `:1347` diamond branch; add `"circle"` to the
inspector array + a `cap-circle` icon (`icons.tsx`); extend `tipCap` + a `<circle>` element in `svgExport.ts`.

---

## ✅ Parity confirmed (spot-check; code-traced, not assumed)

- **Boolean inheritance:** `subtract ? children[0] : children[last]` (`memory.ts:2280`) over paint-order children
  (`wrapSel` preserves order, `:3411`) = Figma's top-layer rule for union/intersect/exclude, bottom-layer for
  subtract — incl. stroke + effects copy (`:2281-2290`).
- **Selection keys:** Tab/Shift+Tab siblings (`Canvas.tsx:580-594`), Shift+Enter→parent (`:603-608` — even Figma's
  unusual chord), Enter→first-child (`:615-623`), Enter/Esc vec-edit toggle (`:638-650`), ⌘/Ctrl-click deep select
  (`:3615`), ⌘-drag nested marquee + top-level-only default (`:4630-4642`), Shift+click toggles off (`:3619-3621`),
  ⌘A all / ⌥⌘A matching (`chrome.tsx:1702-1711`), nudge 1/10 with prefs (`nudgePrefs.ts:18`, `chrome.tsx:2053-2060`).
- **Auto-layout canvas gestures:** double-click edge → Hug, ⌥+double-click → Fill with AL-parent guard
  (`Canvas.tsx:4685-4728`); typed/dragged text + frame sizes → Fixed (`memory.ts:1703-1728`, `inspector.tsx:3108`);
  any-Fill-child ⇒ parent effectively Fixed (`layout.ts:840-841`, `memory.ts:391-394`, panel reads the same).
- **Pen:** click-near-start closes (`Canvas.tsx:3026-3034`), Esc/Enter commits open (`:531-534`), Shift constrains
  to 45° (`:3020-3024`); vec-edit marquee selects points, Shift adds (`:4603-4625`); mirror modes none/angle/
  angleAndLength with Alt-disconnect (`:699-722`, `:4050-4058`); per-end caps UI for open paths (`inspector.tsx:5435`).
- **Strokes:** individual strokes on exactly rect/frame/component/instance (`strokeModel.ts:66-68`) with Custom
  4-field incl. 0-removes; miter-angle→limit rule (`:109-114`); custom `dash,gap,…` + per-dash caps incl. the
  1px-dash+round dotted technique (`Canvas.tsx:1200-1204`); weight stored separately from dims (never in `w/h`).
- **Constraints:** per-axis min/center/max/stretch/scale (`types.ts:88`), Top+Left defaults (`memory.ts:149-150`),
  Scale as true % (`:3842-3851`), cascade to subtrees (`:3855`), absolute-position children skipped by flow but
  still constraint-driven on parent resize (resize path `:1735` runs over all children).
- **Misc bindings:** ⌘E Flatten, ⇧⌘O Outline stroke, ⇧⌘E Export, ⌘⌥M mask — all bound as advertised (`chrome.tsx`
  `:1833/:1838/:2001/:1841`); Shift+X swap fill/stroke (`:1636`); visible `:focus-visible` + labeled controls
  baseline (`styles.css:167`, `aria-label`s throughout); text-click hug / text-drag fixed+H (`Canvas.tsx:4568-4569`).

## Noted but out of scope/budget (no fix proposed)

- **Cut tool (X), Lasso (Q), multi-point bbox transform** (Shift-proportional / Alt-center / 15° / Space-move),
  **eraser no-split semantics** (Figma: "doesn't split layers apart"; X-Native `erasePath` splits runs into new
  layers, `geometry.ts:910-929` + `Canvas.tsx:2866-2871`), **paint hover preview** (diagonal stripes, blue/red
  droplet states, drag-across-multi) — each a real documented gap, each >50 lines or needing new interaction
  state. (Vec-edit Shift multi-select of *handles* to drag both together is unimplemented; borderline ~40 lines.)
- **Dashed half-dash rule** ("starts and ends with half of a dash"): not exactly reproducible with native
  `lineDash` (offset fixes the start only); exact both-ends layout needs path-length-aware dashing.
- **Min/max dimensions UI:** model (`minW/maxW`, `clampDims`) exists but the inspector has no Minimum/Maximum
  fields, boundary-line icons, or hover preview — over budget as a whole.
- **Line-arrow fixed length** ("same length regardless of stroke weight") and **width-profile suppresses
  arrowheads** — X-Native scales tips (`Canvas.tsx:1290-1294`); narrow, low-impact; trivial (~3 lines) if wanted.
- **Constraints/sizing visibility:** the Constraints toggle shows even for top-level layers and AL-flow children
  (Figma hides both), and the sizing cycler stays live on absolute-positioned children — ~10 lines combined, minor.
- **Arrows pan with nothing selected** (Figma) vs always-nudge (`chrome.tsx:2055-2061`): documented behavior, but
  the article gives no pan amounts — quoteless sizing, so not proposed.
- **A11y:** no `aria-live` selection announcements, no F6 region cycling, no Ctrl+Shift+? shortcuts panel — the
  articles describe these only as settings/panels (no specific testable micro-behavior in the fetched text), and
  the panel is over budget regardless. Focus-visible styling + labeled canvas/controls already exist.
