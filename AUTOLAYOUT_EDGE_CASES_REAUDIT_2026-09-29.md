# Auto-layout edge cases — re-audit against the brief (run 12 record)

**Run**: pipeline run 12 re-audit, 2026-09-29 · **Scope**: the brief's two cases —
absolute positioning within auto-layout frames, and min/max constraints on Fill
children — measured fresh against `apps/web/src/engine/layout.ts` +
`apps/web/src/engine/memory.ts` at `3553bbe` (branch `arena/01a0ebfa-x-native`).
**Status**: **measured — both cases already MATCH at HEAD (0 px deviation).** No
engine code was changed. Awaiting sign-off before any further work.

---

## 0 · Provenance: the fix for this brief already merged — inside PR #43

The brief treats these two edge cases as an open parity gap. It is not open at
HEAD. `gh pr view 43 --json files` shows PR #43 ("Effects Engine & Real Skia
Testing") carried **both** pipelines' work in one 13-file merge, including:

* `AUTOLAYOUT_EDGE_CASES_AUDIT_2026-09-29.md` (run 11's measurement record)
* `X-Native/apps/web/src/engine/memory.ts` — the engine fix (freeze/redistribute
  loop, auto-gap residual, `absolutePosition` flow filtering)
* `X-Native/apps/web/src/engine/__tests__/autoLayoutEdgeCases.test.mjs` — 43
  assertions, wired into `npm test`
* `X-Native/apps/web/tests/probes/autolayout/edgeCases.mjs` — run 11's probe
* `FIGMA_CREATE_DESIGNS_COMPARISON.md` — living record rows, checklist **MATCH**

This run did not inherit that verdict: it re-measured from scratch (§2) with a
newly written instrument (§1) and checked the suite green end-to-end (§4).

## 1 · Instrument

`apps/web/tests/probes/autolayout/briefEdgeCases.mjs` — written from scratch for
this run against the raw `MemoryEngine` dispatch API, following the brief's
scenario wording literally. **20 measurements**, expectations derived
independently from Figma's documented model (§2). Run with
`npx vite-node tests/probes/autolayout/briefEdgeCases.mjs` from `apps/web`.

## 2 · Figma documentation (step 1)

| Behaviour | Figma says | Source |
| --- | --- | --- |
| **Ignore auto layout** (formerly *Absolute position*) | *"excluded from an auto layout flow while keeping it in the auto layout frame. The object and its surrounding siblings ignore each other, even as they resize and move."* … *"treated as objects in a regular frame … you can apply **constraints** to determine how they respond when its parent auto layout frame resizes."* | [Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout) |
| **Fill container** | *"stretches to occupy all available space in their parent frame, while respecting any spacing values."* | same |
| **Min / max** | *"an additional setting that can be used at the same time as other resizing properties"* — *"Minimum width / height: Object size is equal to or greater than the minimum"*, *"Maximum … equal to or lesser than the maximum"* | same |
| **Distribution model** | auto layout *"mirrors how the web renders layouts"*; space is distributed as CSS `flex-grow` with `min-width`/`max-width` | [Use auto layout with CSS Flexbox in mind](https://help.figma.com/hc/en-us/articles/42031586813719) |
| **A clamp's released space** | a clamped fill child's share is redistributed to the fill children still open (*"Child B → 160px, Child A → remaining 140px … matches CSS Flexbox behavior"*); Figma confirmed the no-redistribution behaviour as *"a real layout engine bug … fixed … shipped to production"* | Figma forum [57215](https://forum.figma.com/report-a-problem-6/bug-report-auto-layout-fill-min-width-fails-to-distribute-remaining-space-57215) |

## 3 · Measurements (step 3) — exact pixels at HEAD

### A · Fill child, `minW 150` / `maxW 180`, parent 200 → 300 (the brief's case)

| # | Scenario | Measured | Figma expects | Verdict |
| --- | --- | --- | --- | --- |
| A1 | parent 200×200 | child **w = 180** | 180 (fill share 200, max clamps) | **MATCH** |
| A2 | parent 300×300 | child **w = 180** | 180 — **not** 300 | **MATCH** |
| A3 | parent 100 wide | child **w = 150** | 150 (min outranks the fill) | **MATCH** |

### B · "Absolute position" child pinned bottom-right (the brief's case)

| # | Scenario | Measured | Figma expects | Verdict |
| --- | --- | --- | --- | --- |
| B1 | 40×40 child, insets 10/10, frame 200 | **(150, 150) 40×40** | pinned 10/10 from the bottom-right | **MATCH** |
| B2 | frame 200 → 300 | **(250, 250) 40×40**, insets right=10, bottom=10 | +100/+100, insets preserved | **MATCH** |
| B3 | flow siblings, gap 10 | A **(0,0) 60×60 → (0,0) 60×60**; B **(70,0) 60×60 → (70,0) 60×60** | absolute child out of the flow: no slot, no gap entry, no push | **MATCH** |
| B4 | hug frame + 300×300 absolute child | frame hugs its flow child **60×40** | the hug ignores absolute children | **MATCH** |

### C · the redistribution neighbours (run 11's pre-fix deviation signature)

| # | Scenario | Measured | Verdict |
| --- | --- | --- | --- |
| C1 | frame 500, two fills, A `maxW 120` | A **120** @x=0 + B **380** @x=120 = **500 of 500** | **MATCH** (pre-fix signature was 120 + 250 = 370, 130 px dropped) |
| C2 | auto gap (`gapMode:"auto"`, between), A capped 120, B 60 | B @**x=440**, right edge **500 of 500** | **MATCH** (pre-fix B sat at x=120) |
| C3 | frame 300, fills `minW 80` / `minW 160` | A **140** + B **160** = **300 of 300** | **MATCH** (pre-fix row overflowed to 310) |

### D · adversarial neighbours (no prior probe measured these)

| # | Scenario | Measured | Verdict |
| --- | --- | --- | --- |
| D1a | auto gap **around**, A capped 120 | lead 80 / gap 160 / trail 80 (A@80, B@360) | **MATCH** |
| D1b | auto gap **evenly**, A capped 120 | lead = gap = trail = 106.67 (A@106.67, B@333.33) | **MATCH** |
| D2 | grid cell fill + `maxW/maxH 150` in a 200×200 cell | **150×150** | **MATCH** |
| D3 | aspect-locked fill + `maxW 180` (ratio 0.5) | **180×90** — the clamp keeps the ratio | **MATCH** |
| D4 | absolute child, `scale` constraints, frame ×1.5 | **(45, 45) 60×60** | **MATCH** |

**Measured deviation for the brief's two cases: 0 px.** No missing behaviour to
fix (step 4): the solver already filters `absolutePosition` children out of the
flow (`memory.ts::computeAutoLayout`, `layout.ts::flowGapLine`/`flowInsertIndex`),
pins them via `applyConstraints` against the frame bounds, clamps Fill shares
with a freeze/redistribute loop (`MAX_REDISTRIBUTION_ITERATIONS`, `mainLimit`/
`mainFloor`) and hands a capped filler's residual to the auto gap — exactly the
fix shape the brief's step 5 prescribes.

### Note on one transient DIFF

The first pass of the C2 probe (fixed `gap` 0, `justify:"min"`, `spacing:"between"`
without `gapMode:"auto"`) measured B at x=120 and read as a deviation. It is
not: `spacing` only applies when `gapMode:"auto"` (`layout.ts::isAutoGap`), and
with a fixed gap packed left, Figma also leaves the residual empty at the
trailing edge (content 180 of 500). Corrected probe confirms B @x=440 under a
true auto gap. Engine correct in both modes.

## 4 · Suite baseline (step 7 constraint: do not break the 3,500+ tests)

* Clean `npm test`: **69 files · 3,642 assertions · 0 failed · exit 0**
  (`autoLayoutEdgeCases.test.mjs` contributes its 43).
* `npx tsc -b` clean.
* One earlier run showed `parity.test.mjs` "200 auto-layout children … under
  100ms" failing — a **wall-clock flake** under parallel probe load; it passes
  alone (935/935) and in the clean full run. Not a solver deviation.

## 5 · Consolidation & hardening (approved follow-up — completed)

The sign-off consolidated the re-audit into the permanent suite (test/doc-only;
`layout.ts` and `memory.ts` were **not** modified — final `memory.ts` md5
identical to its pre-sabotage backup):

1. **Expanded suite** — `autoLayoutEdgeCases.test.mjs` grew 43 → **72 passed,
   0 failed**: a new section C folds the 20 fresh measurements in as an
   independent second witness (brief A: 180/180/150; brief B: (250,250) with
   insets 10/10 and siblings frozen; the redistribution neighbours; auto-gap
   around 80/160/80 and evenly 320/3; grid-cell clamp 150×150; aspect-lock
   180×90; scale pins (45,45) 60×60) and adds the corners no probe measured:
   wrap + fill clamps (the min-forced wrap and cross-hug 200×80, the wrapped
   row's 40/80/160 redistribution), fill + baseline (clamp holds; synthesised
   bottom baseline at 60), nested clamp cascades (250/100 under grow, 40/40
   under shrink past the caps), scaleProps limit scaling (minW 150 / maxW
   240), and the inspector `patch` min/max paths on both axes (150 → 320;
   160 → 320 vertical).
2. **Sabotage verification on this base** — each breakage run against the
   expanded file, then restored:
   * pre-fix equal share (no freeze/redistribute) → **11 failures**
     (A2, A3, A6, A7, A8, A8b, A10, A14 + C7, C9, C17);
   * auto-gap residual suppressed whenever a filler exists → **4 failures**
     (A16 + C8, C10, C11);
   * absolute children let back into the flow → **11 failures**
     (B3, B4, B5, B7, B9, B15, B19, B19b + C4, C5, C14).
   Restored: **72 passed, 0 failed** after every round; `memory.ts` md5
   `3d2cfba2…` matches its backup byte for byte.
3. **Living record** — a Pipeline run 12 block added to
   `FIGMA_CREATE_DESIGNS_COMPARISON.md`, and the §7 checklist rows for
   *Min/max on a Fill child* and *Ignore auto layout (absolute position)* kept
   at **MATCH** with the run-12 backing recorded explicitly.
4. **Suite baseline** — clean `npm test`: 69 files, **3,671 assertions,
   0 failed, exit 0** (the 3,642 baseline plus this file's net +29); `tsc -b`
   clean.
