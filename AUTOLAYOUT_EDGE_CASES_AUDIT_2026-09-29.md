# Auto-layout edge cases — measured deviations

**Run**: pipeline run 11, 2026-09-29 · **Scope**: `apps/web/src/engine/layout.ts`,
`apps/web/src/engine/memory.ts` — absolute positioning inside an auto-layout frame, and
min/max constraints on Fill children.
**Status**: **measured, not fixed.** The pipeline gate for this run is report-first;
nothing in `layout.ts` / `memory.ts` has been touched.
**Suite**: `npm test` green before and after writing the instrument — exit 0, **50 summary
files, 3,018 assertions, 0 failing** (`/tmp/prefix-suite.log`), `tsc -b` clean.

Instrument: `apps/web/tests/probes/autolayout/edgeCases.mjs`
(`npx vite-node tests/probes/autolayout/edgeCases.mjs`, run from `apps/web`) — **25
measurements, 4 deviation groups**, against the real `MemoryEngine`, printing every
intermediate number so each verdict can be read off directly. No canvas involved; these
are solver questions. Committed alongside this report as the run's audit record, before
any engine change.

---

## 0 · The headline: both behaviours the brief named are already correct

| Asked | Measured | Verdict |
| --- | --- | --- |
| Frame 200×200, child `Fill`, `minWidth 150`, `maxWidth 180`, parent → 300×300 | child **w = 180 → 180** | **MATCH** — it clamps at 180 and does not stretch to 300 |
| …same child with the parent shrunk to 100 | child **w = 150** | **MATCH** — the min wins |
| An "Absolute position" child, resize the parent | 11/11 cases: out of the flow, pinned by its constraints, siblings and hug size untouched | **MATCH** |

The deviations are in the **neighbouring** cases of the same two features: what happens to
the space a clamped Fill child gives back, and how a clamped child behaves in the presence
of *another* fill child. Four measured signatures, one root cause (§3).

---

## 1 · Figma documentation (step 1)

| Behaviour | Quote | Source |
| --- | --- | --- |
| **Ignore auto layout** (formerly *absolute position*) | *"An object with **Ignore auto layout** enabled is excluded from an auto layout flow while keeping it in the auto layout frame. The object and its surrounding siblings ignore each other, even as they resize and move."* … *"Much like absolute position in CSS, an object that ignores auto layout can be placed precisely where you want relative to its parent container."* … *"Objects with ignore auto layout enabled are treated as objects in a regular frame. This means you can apply **constraints** to determine how they respond when its parent auto layout frame resizes. Other auto layout settings, such as resizing and layout options, aren't available to these objects."* | [Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout) |
| **Fill container** | *"Layers set to **Fill container** stretches to occupy all available space in their parent frame, while respecting any spacing values."* | same |
| **Min / max** | *"**Minimum and maximum dimensions** is an additional setting that can be used at the same time as other resizing properties. Set minimum or maximum width and height to any auto layout frame and its children."* — *"Minimum width / height: Object size is equal to or greater than the minimum"*, *"Maximum width / height: Object size is equal to or lesser than the maximum"* | same |
| **Parent stops hugging** | *"If any child objects within an auto layout frame are set to **Fill container**, the parent frame will no longer hug contents and become **Fixed** for the axis."* | same |
| **CSS Flexbox model** | auto layout *"mirrors how the web renders layouts"*; the same article's fill rule is the CSS **border-box** model: *"Figma distributes space amongst fill container children by the children's content area instead of by their size"* | [Use auto layout with CSS Flexbox in mind](https://help.figma.com/hc/en-us/articles/42031586813719) |
| **What a clamp does to the released space** | A fill child whose `min-width` exceeds its equal share must hand the difference to the other fill child: *"**Expected**: Child B → 160px, Child A → remaining 140px … the layout engine should allocate the remaining space (parent width − Child B's min-width) to Child A, as long as that value is ≥ Child A's min-width. **This matches CSS Flexbox behavior with flex-grow + min-width.**"* — the same thread's max-width case: *"Child B → 480, Child A → remaining 240"*. Figma's support reply: *"This turned out to be a real layout engine bug, exactly as @tozaki diagnosed above, and it's already been fixed on our end. The fix was verified and shipped to production."* | Figma forum [57215](https://forum.figma.com/report-a-problem-6/bug-report-auto-layout-fill-min-width-fails-to-distribute-remaining-space-57215) (Aug–Sep 2026) |

The last row is the key one: the current Figma the engine must match **redistributes** a
clamped fill child's share, and calls the no-redistribution behaviour a bug it has fixed.

---

## 2 · Method

`edgeCases.mjs` drives the real engine and reads the solver's own numbers. Three families:

* **Fill + min/max** — 1a–1m: the main axis, the cross axis, both frame directions, one and
  several fillers, a padded filler, an auto gap, and justify.
* **Absolute position** — 2a–2k: out of the flow, the three constraint pins, stretch with
  min/max, shrink past the frame, two absolute children, a toggled child, wrap and grid
  parents, hug sizing, and the padding floor.
* **Combined** — 3a: a fill child, a fixed sibling and a pinned child in one frame.

---

## 3 · Deviations (steps 3–4)

### D1 · A clamped Fill child's released space is dropped, not redistributed

One root cause, four measured signatures. The solver hands every filler the same share
(`memory.ts:722`, `each = (leftover − insets) / fillers.length`), then clamps each child
individually (`memory.ts:723-728` → `clampDims`, `memory.ts:580`). Nothing re-runs the
distribution with the clamped sizes, so the space a cap releases is simply lost — and a
min that exceeds the share makes the row **overflow its own frame**.

| Probe | Scene | ours | expected (Figma / CSS flexbox) |
| --- | --- | --- | --- |
| **1d** | frame 500, two `Fill` children, A `maxW 120`, parent 400 → 500 | **A 120 + B 250 = 370 of 500 — 130 px unallocated**, B at x=120 | B absorbs the release: **A 120, B 380** |
| **1g** | frame 300, two `Fill` children, `minW 80` and `minW 160` | **A 150 + B 160 = 310 of 300 — the row overflows by 10 px**, B at x=150, right edge 310 | B 160, A gives up the difference: **A 140, total 300** (the forum thread's exact case) |
| **1h** | frame 500, A `Fill` with 8 px padding and `maxW 150`, B `Fill` | **A 150 + B 250 = 400 of 500 — 100 px unallocated** | A 150, **B 350**, x=150 |
| **1i** | frame 500, gap **Auto · Between**, A `Fill` with `maxW 120`, B fixed 60 | **A 120, B at x=120, right edge 180 of 500 — the freed 320 px becomes the gap nowhere** | the freed space is the gap: **B at x=440** |

Controls that isolate the cause:

* Without a clamp the model is right: two `Fill` children in a 500 frame take 250 + 250; a
  single uncapped filler with Auto · Between takes 440 and pushes the fixed child to x=440.
* With no fillers at all, Auto · Between works (60 + 60 → B at 440).
* `justify` already sees the released space: 1m (A `maxW 120` + a fixed 60, justify center)
  centres the pair correctly at x=160 — so only the *fill distribution* is unaware of it.
* Cases where the clamps cancel out pass by coincidence: 1l (three fillers, `minW 300`,
  `maxW 100`, uncapped, 600 frame) gives 300 + 100 + 200 = 600, which is also the
  redistributed answer.

### Verified correct — recorded so it is not re-litigated

Everything the brief asked about absolute positioning measures right. Notable ones, with
numbers, because they pin the constraint math:

| Probe | Scene | ours |
| --- | --- | --- |
| 2a | add an absolute child to a gap-10 flow | siblings stay at (0,0) and (70,0) |
| 2b | pinned bottom-right (`max`/`max`), frame 200 → 300 | (150,150) → (250,250); insets 10/10 unchanged |
| 2c | default left/top, frame 200 → 300 | (30,30) → (30,30) |
| 2d | `stretch` + `minW 100` / `maxW 150`, frame 200 → 400 | 150×150 — the stretch stops at the clamp |
| 2e | pinned child when the frame shrinks to 100×100 | child keeps 40×40 |
| 2f | one flow child + two absolute (min-pinned, max-pinned) | (10,10) / (0,0) / (300,200) |
| 2g | toggling `absolutePosition` on a flow child | stays at (60,0) |
| 2h | 140-wide absolute child in a 200-wide wrapping flow | no extra wrap line; keeps (20,60) |
| 2i | grid frame, child switched to ignore auto layout | every other cell/position unchanged |
| 2j | 300×300 absolute child added to a hug frame | frame still hugs at 60×40 |
| 2k | frame shrinks to 60×60 with a 60 px right/bottom inset | child lands at −40 (the inset is honoured and it overflows) |

One **separate** observation, out of scope for this run and not counted as a deviation: in a
**grid** frame the child list is re-sorted into cell reading order on every layout pass, so
the array order stops matching insertion order (`[R2, R1]` after two plain `add`s). The
cursor rule (`gridSpotForPoint`, `memory.ts:2339`) makes the *insert* behave, and the two
`gridSpotForPoint`-driven probes here pass; the re-sort is worth its own look when the grid
flow gets audited.

---

## 4 · Proposed engine fix (step 5 — proposed, not written)

**One change, in the fill distribution** (`memory.ts:705-730`): turn "share once, then
clamp" into the flexbox loop — distribute, clamp, freeze the clamped children, redistribute
what is left among the rest, repeat until nothing clamps.

```
active = fillers            // children still allowed to absorb space
frozen = {}                 // child -> clamped size
loop:
  leftover  = inner − Σ(frozen) − Σ(non-filler sizes) − gaps − Σ(insets of active)
  share     = leftover / active.length          // keep the content-area model (insets)
  for each active child: size = share + its inset
    if size < min  → freeze at min
    if size > max  → freeze at max
  if nothing froze this pass → assign the sizes and stop
  else → move every frozen child out of `active` and repeat
```

Properties this gives, matching the four measured rows:

* **1d / 1h** — the capped child's release flows to the remaining filler (130 → B 380,
  100 → B 350).
* **1g** — the min-clamped child is frozen first, then A is recomputed from the *remaining*
  space (140), so the row lands on the frame's content box instead of overflowing it.
* **1e** — a maxed-out set of clamps still overflows when the mins genuinely exceed the
  space (Figma does the same), which is why the loop must be bounded by "no child clamped
  in the last pass" rather than by "the total fits".
* **1i** — once no filler can absorb the residual, it must reach the packing stage: the
  auto-gap / justify maths already handles the residual correctly (`memory.ts:706`,
  `packedGap = auto && fillers.length ? 0 : gap` is what suppresses it today), so the
  `fillers.length` test needs to become "fillers that actually took space".

Everything else stays: `contentInset` keeps the border-box model, `clampDims` remains the
single clamp owner for non-filler paths, hug/fixed sizing is untouched (a fill child still
means the frame cannot hug), and the absolute-position paths are not touched at all.

---

## 5 · Test plan (step 6 — after approval)

New `apps/web/src/engine/__tests__/autoLayoutEdgeCases.test.mjs`, sabotage-verified, wired
into `npm test`:

* **A · Fill + max clamp** — 1d and 1h: the capped child stops at its max, the sibling
  filler absorbs the rest, and the two add up to the content box.
* **B · Fill + min clamp** — 1g: the min-clamped child freezes and the sibling shrinks;
  the row never exceeds the frame (this is the forum thread's exact 300/80/160 case).
* **C · auto gap** — 1i: the residual after a cap becomes the Auto · Between gap.
* **D · single child regressions** — 1a/1a′/1b/1c/1e/1f: the cases that already pass stay
  passing (including "a lone child still overflows when its min exceeds the frame").
* **E · absolute position** — 2a–2k as regression cover, so the constraint pins, the flow
  exclusion, wrap, grid and hug sizing are all pinned by numbers.
* **Sabotage** — (1) drop the clamp from the redistribution loop and prove A fails;
  (2) keep the naive equal share after freezing and prove B fails; (3) restore and prove the
  file green, then the whole suite.

Estimated footprint: ~10 lines changed in `memory.ts`, no `layout.ts` change, no command,
no model field, no Rust/WASM surface.

---

## Appendix · probe output (2026-09-29, before the fix)

```
1 · Fill + min/max on an auto-layout child
 ok  1a  Fill child, minW 150 / maxW 180, parent 200 → 300      child w 180 → 180 (frame 300)
 ok  1a′ same child, parent shrunk to 100                       child w 150
 ok  1b  vertical, Fill height minH 120 / maxH 160, h 200 → 400 child h 160
 ok  1c  vertical, Fill width minW 140 / maxW 190, w 200 → 400  child w 190
DIFF 1d  two Fill children, A.maxW 120, parent 400 → 500        A 120 + B 250 = 370 of 500
 ok  1e  Fill child minW 200 in a 100-wide frame                child w 200 (overflows, correct)
DIFF 1g  two Fill children, minW 80 / minW 160, frame 300       A 150 + B 160 = 310 of 300
DIFF 1h  Fill child, 8px padding, maxW 150, sibling Fill, 500   A 150 + B 250 = 400 of 500
DIFF 1i  auto gap Between with a Fill child capped at 120       B at x=120, right edge 180 of 500
 ok  1j  nested frame, Fill width maxW 250 in a 600 frame        inner w 250
 ok  1l  three Fill children: minW 300, maxW 100, uncapped      A 300 · B 100 · C 200 = 600
 ok  1m  capped Fill + justify center, frame 500                A at x=160, B at 280
 ok  1f  hug frame with a Fill child capped at 80               frame keeps 100
2 · Absolute position inside an auto-layout frame
 ok  2a…2k  (11 of 11)  flow exclusion · three pins · stretch+clamp · shrink past the
                        frame · two absolute children · toggle · wrap · grid · hug · floor
3 · combined
 ok  3a  [Fill(maxW 180), fixed 40, absolute pinned] in 400×200  A 180 · B x=200 · C (350,150)
4 deviation group(s) measured
```
