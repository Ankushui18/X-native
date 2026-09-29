/**
 * Auto-layout edge cases (pipeline run 11, extended by run 12): what a Fill
 * child does when its own min/max clamps its share, and what an "Ignore auto
 * layout" (absolute position) child does to the flow around it.
 *
 * The evidence for the expected numbers:
 *
 *   - Figma, Guide to auto layout: "Layers set to Fill container stretches to
 *     occupy all available space in their parent frame, while respecting any
 *     spacing values", and min/max is "an additional setting that can be used
 *     at the same time as other resizing properties" - so the clamp outranks
 *     the fill, and the fill outranks the frame.
 *   - Figma, Use auto layout with CSS Flexbox in mind (help 42031586813719):
 *     the same model as CSS flexbox, with the *content* (border) box as the
 *     unit that is distributed.
 *   - Figma forum 57215 (Aug-Sep 2026), where the pre-fix engine "fails to
 *     distribute remaining space" and left a sibling 140px short; Figma's reply
 *     calls it "a real layout engine bug ... already been fixed on our end
 *     ... shipped to production". The fix is the freeze/redistribute loop the
 *     engine runs now: a clamped child is frozen at its limit and the space it
 *     could not take is offered again to the fill children that are still free.
 *   - Figma, Guide to auto layout, on ignore-auto-layout: such an object is
 *     "excluded from an auto layout flow while keeping it in the auto layout
 *     frame. The object and its surrounding siblings ignore each other", and
 *     is "treated as an object in a regular frame ... you can apply
 *     constraints to determine how they respond when its parent auto layout
 *     frame resizes."
 *
 * Test A is the redistribution case; Test B is the absolute-position case. Both
 * are written to fail against the pre-fix engine (see the sabotage notes in
 * AUTOLAYOUT_EDGE_CASES_AUDIT_2026-09-29.md). Section C is the run-12 re-audit
 * (AUTOLAYOUT_EDGE_CASES_REAUDIT_2026-09-29.md): an independent second witness
 * for the brief's two cases, plus the corners no probe measured before -
 * auto-gap around/evenly residuals, grid-cell and aspect-locked fill clamps,
 * scale pins, wrap + fill clamps, fill + baseline, nested clamp cascades, and
 * the inspector-driven patch paths. All C numbers were measured on this base
 * before being encoded, and each section is sabotage-verified: break the
 * redistribute loop, re-suppress the auto-gap residual, or let absolute
 * children back into the flow and these fail.
 *
 * Run with:  npx vite-node src/engine/__tests__/autoLayoutEdgeCases.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const layout = (over = {}) => ({
  direction: "horizontal", gap: 0, padding: [0, 0, 0, 0],
  sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min", ...over,
});
const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const byId = (e, id) => find(rootOf(e), id);
const addFrame = (e, w, h, l) => {
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w, h, parent: rootOf(e).id });
  const id = rootOf(e).children.at(-1).id;
  if (l) e.dispatch({ type: "autoLayout", id, layout: l });
  return id;
};
const addKid = (e, parent, w, h, patch) => {
  // A grid add lands in the cell under the cursor, so the new child is found by
  // diffing the ids rather than by taking the last one.
  const before = new Set(byId(e, parent).children.map((c) => c.id));
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent });
  const id = byId(e, parent).children.find((c) => !before.has(c.id)).id;
  if (patch && Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const g = (e, id, prop) => byId(e, id)[prop];
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

/* =================================================================== *
 * A · Fill children with min/max: clamp, then redistribute
 * =================================================================== */
console.log("A · Fill min/max redistribution:");

{
  // The break-glass case. Before the fix this was 100 + 200 of 300: Child 2
  // kept its equal 150 share, the 50px Child 1 could not use was dropped, and
  // the row ended 50px short of its own content box.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 100, layout({}));
  const a = addKid(e, F, 100, 100);
  e.dispatch({ type: "patch", id: a, patch: { sizingW: "fill", maxW: 100 } });
  const b = addKid(e, F, 100, 100, { sizingW: "fill" });
  t("A1 the capped child clamps at its maxW", near(g(e, a, "w"), 100));
  t("A2 the sibling grows to the content box (not 150 + 50 dead)", near(g(e, b, "w"), 200));
  t("A3 the two fill children add up to the frame", near(g(e, a, "w") + g(e, b, "w"), 300));
  t("A4 the sibling starts where the capped child ends", near(g(e, b, "x"), 100));
}

{
  // A min is a floor, not a cap: the child that hits it is frozen first, and
  // the sibling is sized from what is left - so the row is 300, not 310.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 100, layout({}));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", minW: 80 });
  const b = addKid(e, F, 100, 100, { sizingW: "fill", minW: 160 });
  t("A5 the min-clamped child holds its floor", near(g(e, b, "w"), 160));
  t("A6 the sibling shrinks by exactly that much", near(g(e, a, "w"), 140));
  t("A7 the row does not overflow the frame", near(g(e, a, "w") + g(e, b, "w"), 300));
}

{
  // Three fillers, one capped: only the capped child freezes, and the other two
  // split the 380 that is left evenly (flex-grow semantics), not 160/220.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({}));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", maxW: 120 });
  const b = addKid(e, F, 100, 100, { sizingW: "fill" });
  const c = addKid(e, F, 100, 100, { sizingW: "fill" });
  t("A8 a lone clamp leaves the other two an even 190 each",
    near(g(e, a, "w"), 120) && near(g(e, b, "w"), 190) && near(g(e, c, "w"), 190));
  t("A8b all three add up to the frame",
    near(g(e, a, "w") + g(e, b, "w") + g(e, c, "w"), 500));
}

{
  // The content-area model still holds: a padded capped child stops at 150 of
  // *box*, and the sibling is measured against the box it has to share.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({}));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", maxW: 150, padding: [0, 8, 0, 8] });
  const b = addKid(e, F, 100, 100, { sizingW: "fill" });
  t("A9 the padded child clamps by its box width", near(g(e, a, "w"), 150));
  t("A10 the sibling takes the remaining 350", near(g(e, b, "w"), 350));
}

{
  // A lone capped filler is still capped, and the frame around it is untouched:
  // this is the brief's own example (parent 200 -> 300, child minW 150/maxW 180).
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({}));
  const k = addKid(e, F, 200, 200, { sizingW: "fill" });
  e.dispatch({ type: "patch", id: k, patch: { minW: 150, maxW: 180 } });
  t("A11 a single capped filler does not stretch to 300", near(g(e, k, "w"), 180));
  t("A12 the frame keeps its own size", near(g(e, F, "w"), 200));
  const k2 = addKid(e, F, 200, 200, { sizingW: "fill", minW: 150, maxW: 180 });
  t("A13 two floors the 200px frame cannot honour both win (150 + 150)",
    near(g(e, k, "w"), 150) && near(g(e, k2, "w"), 150));
  e.dispatch({ type: "resize", id: F, w: 400, h: 200 });
  t("A13b on expansion both rise to the shared 180 cap",
    near(g(e, k, "w"), 180) && near(g(e, k2, "w"), 180));
  t("A13c with every filler capped the rest is free space again",
    near(g(e, F, "w"), 400) && near(g(e, k, "w") + g(e, k2, "w"), 360));
}

{
  // Vertical flows redistribute on the main axis the same way (heights), so the
  // loop is axis-agnostic and not just a width rule.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 100, 400, layout({ direction: "vertical" }));
  const a = addKid(e, F, 100, 100, { sizingH: "fill", maxH: 120 });
  const b = addKid(e, F, 100, 100, { sizingH: "fill" });
  t("A14 a vertical flow redistributes on the main axis",
    near(g(e, a, "h"), 120) && near(g(e, b, "h"), 280));
}

{
  // The auto gap is the residual's other home: with nothing left to absorb the
  // capped space, "Between" puts it between the objects rather than leaving the
  // frame half empty (before the fix: the fixed child sat at x=120).
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({ gapMode: "auto", spacing: "between" }));
  const a = addKid(e, F, 60, 60, { sizingW: "fill", maxW: 120 });
  const b = addKid(e, F, 60, 60);
  t("A15 a capped filler still clamps", near(g(e, a, "w"), 120));
  t("A16 the released space becomes the auto gap", near(g(e, b, "x"), 440));
}

{
  // ...and with a filler that genuinely consumes the row, the auto gap stays
  // zero: releasing the residual must not disturb the normal case.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({ gapMode: "auto", spacing: "between" }));
  const a = addKid(e, F, 60, 60, { sizingW: "fill" });
  const b = addKid(e, F, 60, 60);
  t("A17 an uncapped filler still swallows the auto gap",
    near(g(e, a, "w"), 440) && near(g(e, b, "x"), 440));
}

{
  // No filler, no change: the auto gap still works on its own.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({ gapMode: "auto", spacing: "between" }));
  const a = addKid(e, F, 60, 60);
  const b = addKid(e, F, 60, 60);
  t("A18 auto gap between two fixed children is untouched",
    near(g(e, a, "x"), 0) && near(g(e, b, "x"), 440));
}

{
  // A min the frame cannot honour still overflows - Figma clamps the child, it
  // does not shrink it below the floor (probe 1e keeps this shape).
  const e = new MemoryEngine(false);
  const F = addFrame(e, 100, 100, layout({ padding: [0, 20, 0, 0] }));
  const k = addKid(e, F, 10, 50, { sizingW: "fill", minW: 200 });
  t("A19 a min larger than the frame overflows it", near(g(e, k, "w"), 200));
}

/* =================================================================== *
 * B · Ignore auto layout: out of the flow, pinned by constraints
 * =================================================================== */
console.log("B · Ignore auto layout (absolute position):");

{
  // The absolute child must not take a slot, must not move a sibling, and must
  // not close the gap the flow computed.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 100, layout({ gap: 10 }));
  const a = addKid(e, F, 60, 60);
  const b = addKid(e, F, 60, 60);
  const before = [g(e, a, "x"), g(e, b, "x")];
  const abs = addKid(e, F, 200, 80, { absolutePosition: true, x: 40, y: 10, w: 200, h: 80 });
  t("B1 the siblings keep their flow positions",
    near(g(e, a, "x"), before[0]) && near(g(e, b, "x"), before[1]));
  t("B2 the added child consumes no flow slot", byId(e, F).children.length === 3);
  t("B3 it sits where it was placed", near(g(e, abs, "x"), 40) && near(g(e, abs, "y"), 10));
}

{
  // Pinned to the bottom-right by its constraints: on a 200 -> 300 resize it
  // follows the corner (insets stay 10/10) while the flow child does not move.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({}));
  const flow = addKid(e, F, 60, 60);
  const abs = addKid(e, F, 40, 40, {
    x: 150, y: 150, absolutePosition: true, constraintH: "max", constraintV: "max",
  });
  const flowBefore = [g(e, flow, "x"), g(e, flow, "y")];
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  t("B4 the pinned child follows the bottom-right corner",
    near(g(e, abs, "x"), 250) && near(g(e, abs, "y"), 250));
  t("B5 its insets are the ones it was pinned with", near(300 - (g(e, abs, "x") + g(e, abs, "w")), 10));
  t("B6 the flow child never moved",
    near(g(e, flow, "x"), flowBefore[0]) && near(g(e, flow, "y"), flowBefore[1]));
}

{
  // Default left/top pin: a resize leaves it exactly where it was.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({}));
  const abs = addKid(e, F, 40, 40, { x: 30, y: 30, absolutePosition: true });
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  t("B7 a top-left pin holds through a resize",
    near(g(e, abs, "x"), 30) && near(g(e, abs, "y"), 30));
}

{
  // Stretch with a max: the child grows with the frame up to its own limit and
  // stops there (constraints first, min/max on top of them).
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({}));
  const abs = addKid(e, F, 40, 40, {
    x: 10, y: 10, absolutePosition: true,
    constraintH: "stretch", constraintV: "stretch", minW: 60, maxW: 150,
  });
  e.dispatch({ type: "resize", id: F, w: 400, h: 400 });
  t("B8 a stretching absolute child stops at its max",
    near(g(e, abs, "w"), 150) && near(g(e, abs, "h"), 240));
}

{
  // The absolute child is not part of the frame's hug either, even when it is
  // bigger than everything in the flow.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 60, 40, layout({ sizing: "hug", cross: "hug" }));
  const flow = addKid(e, F, 60, 40);
  const abs = addKid(e, F, 300, 300, { absolutePosition: true, x: 0, y: 0 });
  t("B9 the hug ignores an oversized absolute child",
    near(g(e, F, "w"), 60) && near(g(e, F, "h"), 40));
  t("B10 the absolute child keeps its own size", near(g(e, abs, "w"), 300));
  t("B11 the flow child is the one the hug measured", near(g(e, flow, "w"), 60));
}

{
  // Toggling a flow child to absolute leaves it where the flow had put it, and
  // the siblings do not jump.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 100, layout({ gap: 10 }));
  const a = addKid(e, F, 50, 50);
  const b = addKid(e, F, 50, 50);
  e.dispatch({ type: "patch", id: b, patch: { absolutePosition: true } });
  t("B12 a toggled child stays where the flow put it",
    near(g(e, b, "x"), 60) && near(g(e, b, "y"), 0));
  t("B13 the sibling that stayed in the flow does not move", near(g(e, a, "x"), 0));
}

{
  // In a grid, switching a child to absolute must not disturb the cells: the
  // others keep their cell and their position.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 220, 220, layout({ direction: "grid", columns: 2, gap: 20 }));
  const a = addKid(e, F, 100, 100);
  const b = addKid(e, F, 100, 100);
  // Aimed past the last cell, so the cursor rule appends rather than replacing.
  const third = addKid(e, F, 100, 100, { x: 210, y: 210 });
  const others = () =>
    byId(e, F).children
      .filter((c) => c.id !== third)
      .map((c) => `${c.name}:${c.gridCol},${c.gridRow}@${c.x},${c.y}`)
      .join(" ");
  const before = others();
  e.dispatch({ type: "patch", id: third, patch: { x: 10, y: 10, absolutePosition: true } });
  const after = others();
  t("B14 the grid cells are untouched by the toggle", after === before);
  t("B15 the absolute child keeps its own position",
    near(g(e, third, "x"), 10) && near(g(e, third, "y"), 10));
  const cellsOf = (name) => {
    const n = byId(e, F).children.find((c) => c.name === name);
    return `${n.gridCol},${n.gridRow}@${n.x},${n.y}`;
  };
  t("B16 the two flow children keep the cells the plan gave them",
    /^[01],[01]@/.test(cellsOf("Rectangle 1")) && /^[01],[01]@/.test(cellsOf("Rectangle 2")));
}

{
  // One frame, both features: a capped fill child, a fixed sibling, and a
  // pinned absolute child - the flow adds up to the content box and the pinned
  // child is on the corner the whole time.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 200, layout({ gap: 10, padding: [10, 10, 10, 10] }));
  const a = addKid(e, F, 100, 40, { sizingW: "fill", maxW: 180 });
  const b = addKid(e, F, 40, 40);
  const abs = addKid(e, F, 40, 40, {
    x: 350, y: 150, absolutePosition: true, constraintH: "max", constraintV: "max",
  });
  t("B17 the capped filler stops at 180", near(g(e, a, "w"), 180));
  t("B18 the flow sibling follows it at x=200", near(g(e, b, "x"), 200));
  t("B19 the pinned child sits in the padded corner",
    near(g(e, abs, "x"), 350) && near(g(e, abs, "y"), 150));
  e.dispatch({ type: "resize", id: F, w: 500, h: 300 });
  t("B19b the pinned child follows the larger frame (+100 on both axes)",
    near(g(e, abs, "x"), 450) && near(g(e, abs, "y"), 250));
  t("B19c the flow is unchanged by the resize",
    near(g(e, a, "w"), 180) && near(g(e, b, "x"), 200));
}

/* =================================================================== *
 * C · Run 12 re-audit: independent second witness + unmeasured corners
 * =================================================================== */
console.log("C · Run 12 re-audit (20+ adversarial measurements):");

{
  // The brief's own case A, measured from scratch: a Fill child with
  // minW 150 / maxW 180 under a parent that goes 200 -> 300 -> 100. The max
  // clamps the growth (180, NOT 300), and the min outranks the fill on the
  // way down.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({}));
  const k = addKid(e, F, 100, 100, { sizingW: "fill", minW: 150, maxW: 180 });
  t("C1 brief A: w=180 at parent 200 (the fill's 200 share clamps to maxW)", near(g(e, k, "w"), 180));
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  t("C2 brief A: w=180 at parent 300 - it clamps, it does not stretch to 300", near(g(e, k, "w"), 180));
  e.dispatch({ type: "resize", id: F, w: 100, h: 300 });
  t("C3 brief A: w=150 at parent 100 - the min outranks the fill", near(g(e, k, "w"), 150));
}

{
  // The brief's own case B: an absolute child pinned bottom-right keeps its
  // insets through the resize and never enters the flow (sibling slots and the
  // 10px gap stay exactly as computed without it).
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ gap: 10 }));
  const a = addKid(e, F, 60, 60);
  const b = addKid(e, F, 60, 60);
  const abs = addKid(e, F, 40, 40, {
    x: 150, y: 150, absolutePosition: true, constraintH: "max", constraintV: "max",
  });
  t("C4 brief B: pinned child starts 10/10 inside the bottom-right corner",
    near(g(e, abs, "x"), 150) && near(g(e, abs, "y"), 150));
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  t("C5 brief B: after 200 -> 300 it sits at (250, 250), insets still 10/10",
    near(g(e, abs, "x"), 250) && near(g(e, abs, "y"), 250) &&
    near(300 - (g(e, abs, "x") + g(e, abs, "w")), 10) && near(300 - (g(e, abs, "y") + g(e, abs, "h")), 10));
  t("C6 brief B: the flow siblings keep (0,0) and (70,0) - no slot, no push",
    near(g(e, a, "x"), 0) && near(g(e, a, "y"), 0) && near(g(e, b, "x"), 70) && near(g(e, b, "y"), 0));
}

{
  // Run 11's pre-fix deviation signatures, re-measured: 120 + 380 of 500 (the
  // released 260 goes to the open filler), the auto-gap residual, and the
  // min-squeeze that keeps the row at 300 of 300.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({}));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", maxW: 120 });
  const b = addKid(e, F, 100, 100, { sizingW: "fill" });
  t("C7 a capped filler hands its released share to the open filler",
    near(g(e, a, "w"), 120) && near(g(e, b, "w"), 380) && near(g(e, b, "x"), 120));
  const e2 = new MemoryEngine(false);
  const F2 = addFrame(e2, 500, 100, layout({ gapMode: "auto", spacing: "between" }));
  const a2 = addKid(e2, F2, 60, 60, { sizingW: "fill", maxW: 120 });
  const b2 = addKid(e2, F2, 60, 60);
  t("C8 with nothing open to absorb it, the auto gap takes the residual",
    near(g(e2, a2, "w"), 120) && near(g(e2, b2, "x"), 440) && near(g(e2, b2, "x") + g(e2, b2, "w"), 500));
  const e3 = new MemoryEngine(false);
  const F3 = addFrame(e3, 300, 100, layout({}));
  const a3 = addKid(e3, F3, 100, 100, { sizingW: "fill", minW: 80 });
  const b3 = addKid(e3, F3, 100, 100, { sizingW: "fill", minW: 160 });
  t("C9 a min above the equal share squeezes the sibling, not the frame",
    near(g(e3, a3, "w"), 140) && near(g(e3, b3, "w"), 160));
}

{
  // Auto gap "around" and "evenly" split a capped filler's residual
  // symmetrically: 320 of slack -> lead 80 / gap 160 / trail 80, and
  // lead = gap = trail = 320/3. (A fixed gap packed left instead leaves the
  // residual at the trailing edge - also correct, and not what these assert.)
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 60, layout({ gapMode: "auto", spacing: "around" }));
  const a = addKid(e, F, 60, 60, { sizingW: "fill", maxW: 120 });
  const b = addKid(e, F, 60, 60);
  t("C10 auto gap around: the capped residual splits 80 / 160 / 80",
    near(g(e, a, "x"), 80) && near(g(e, b, "x"), 360) && near(500 - (g(e, b, "x") + g(e, b, "w")), 80));
  const e2 = new MemoryEngine(false);
  const F2 = addFrame(e2, 500, 60, layout({ gapMode: "auto", spacing: "evenly" }));
  const a2 = addKid(e2, F2, 60, 60, { sizingW: "fill", maxW: 120 });
  const b2 = addKid(e2, F2, 60, 60);
  t("C11 auto gap evenly: lead = gap = trail = 320/3",
    near(g(e2, a2, "x"), 320 / 3, 0.02) && near(g(e2, b2, "x"), 1000 / 3, 0.02) &&
    near(500 - (g(e2, b2, "x") + g(e2, b2, "w")), 320 / 3, 0.02));
}

{
  // A fill inside a grid cell clamps to its own limits: the track offers 200,
  // the max stops it at 150 on both axes.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 400, layout({ direction: "grid", columns: 2 }));
  const a = addKid(e, F, 50, 50, { sizingW: "fill", sizingH: "fill", maxW: 150, maxH: 150 });
  t("C12 a grid-cell fill stops at its own maxW/maxH",
    near(g(e, a, "w"), 150) && near(g(e, a, "h"), 150));
}

{
  // An aspect-locked fill stops at its maxW and takes its height with it from
  // the ratio it was locked at (180 x 90, not a square).
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 200, layout({}));
  const a = addKid(e, F, 100, 50, { sizingW: "fill", maxW: 180, aspectLocked: true, aspectRatio: 0.5 });
  t("C13 an aspect-locked fill clamp keeps the locked ratio",
    near(g(e, a, "w"), 180) && near(g(e, a, "h"), 90));
}

{
  // A scale-pinned absolute child scales its position AND its size with the
  // frame: 200 -> 300 is x1.5 on both axes.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({}));
  const abs = addKid(e, F, 40, 40, {
    x: 30, y: 30, absolutePosition: true, constraintH: "scale", constraintV: "scale",
  });
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  t("C14 a scale-pinned absolute child scales to (45, 45) 60x60",
    near(g(e, abs, "x"), 45) && near(g(e, abs, "y"), 45) && near(g(e, abs, "w"), 60) && near(g(e, abs, "h"), 60));
}

{
  // Wrap + fill clamp: a fill child pushed to its minW 150 makes the row
  // 250 wide inside a 200 frame, so its sibling wraps - and the cross-hug
  // frame grows to the two lines (200x80) rather than staying 200x200.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ wrap: true, cross: "hug" }));
  const a = addKid(e, F, 100, 40, { sizingW: "fill", minW: 150 });
  const b = addKid(e, F, 100, 40);
  t("C15 a fill min-clamp that overflows the line forces the wrap",
    near(g(e, a, "w"), 150) && near(g(e, a, "x"), 0) && near(g(e, a, "y"), 0) &&
    near(g(e, b, "x"), 0) && near(g(e, b, "y"), 40));
  t("C16 the cross hug measures the wrapped lines (200x80)",
    near(g(e, F, "w"), 200) && near(g(e, F, "h"), 80));
}

{
  // Wrap + two fills where one caps: the freeze/redistribute loop runs before
  // the line break, so the 40 the capped child refused lands on its sibling
  // (80) and the three still fit one 300 line - 40 + 80 + 160 + two 10 gaps.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 200, layout({ wrap: true, gap: 10 }));
  const a = addKid(e, F, 100, 40, { sizingW: "fill", maxW: 40 });
  const b = addKid(e, F, 100, 40, { sizingW: "fill" });
  const c = addKid(e, F, 160, 40);
  t("C17 a capped filler in a wrapped row still redistributes to its sibling",
    near(g(e, a, "w"), 40) && near(g(e, b, "w"), 80) && near(g(e, c, "w"), 160) &&
    near(g(e, b, "x"), 50) && near(g(e, c, "x"), 140));
}

{
  // Fill + baseline: the clamp still holds, and boxes without text share a
  // baseline synthesised from their bottom edges - the 40-tall capped fill
  // drops 20 below the 60-tall sibling (both bottoms at 60).
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 100, layout({ align: "baseline", gap: 10 }));
  const a = addKid(e, F, 100, 40, { sizingW: "fill", maxW: 180 });
  const b = addKid(e, F, 60, 60);
  t("C18 a baseline row still clamps the fill (180) and keeps the gap",
    near(g(e, a, "w"), 180) && near(g(e, b, "x"), 190));
  t("C19 the shorter fill drops onto the shared baseline (bottoms at 60)",
    near(g(e, a, "y"), 20) && near(g(e, b, "y"), 0) &&
    near(g(e, a, "y") + g(e, a, "h"), 60) && near(g(e, b, "y") + g(e, b, "h"), 60));
  e.dispatch({ type: "resize", id: F, w: 500, h: 100 });
  t("C19b on resize the clamp and the baseline both hold",
    near(g(e, a, "w"), 180) && near(g(e, a, "y"), 20) && near(g(e, b, "x"), 190));
}

{
  // Nested clamp cascade: an inner fill frame capped at 250 inside an outer
  // fill row, with its own fill child capped at 100. Every level clamps
  // independently as the outer frame grows - and the inner one tracks the
  // outer when it shrinks below the caps.
  const e = new MemoryEngine(false);
  const outer = addFrame(e, 500, 200, layout({}));
  // Frames added to a parent directly (addFrame only targets the page root).
  const before = new Set(byId(e, outer).children.map((c) => c.id));
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 100, h: 100, parent: outer });
  const inner = byId(e, outer).children.find((c) => !before.has(c.id)).id;
  e.dispatch({ type: "autoLayout", id: inner, layout: layout({}) });
  e.dispatch({ type: "patch", id: inner, patch: { sizingW: "fill", maxW: 250 } });
  const a = addKid(e, inner, 50, 50, { sizingW: "fill", maxW: 100 });
  const sib = addKid(e, outer, 60, 60);
  t("C20 nested: the inner fill frame clamps at its own maxW (250)",
    near(g(e, inner, "w"), 250) && near(g(e, a, "w"), 100) && near(g(e, sib, "x"), 250));
  e.dispatch({ type: "resize", id: outer, w: 800, h: 200 });
  t("C21 nested: growth past the caps changes nothing (250 / 100 / x=250)",
    near(g(e, inner, "w"), 250) && near(g(e, a, "w"), 100) && near(g(e, sib, "x"), 250));
  e.dispatch({ type: "resize", id: outer, w: 100, h: 200 });
  t("C22 nested: shrink below the caps re-clamps down (40 / 40 / x=40)",
    near(g(e, inner, "w"), 40) && near(g(e, a, "w"), 40) && near(g(e, sib, "x"), 40));
}

{
  // Scale tools: a scaled resize takes the min/max limits with the box
  // (scaleProps), so the clamp cannot outlive the geometry it was drawn for.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 100, layout({}));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", minW: 200, maxW: 320 });
  t("C23 the fill starts at its maxW (320)", near(g(e, a, "w"), 320));
  e.dispatch({ type: "resize", id: F, w: 200, h: 100, scaleProps: true });
  const n = byId(e, a);
  t("C24 a scaled parent resize scales the limits (minW 150, maxW 240) and the clamp follows",
    near(n.minW, 150) && near(n.maxW, 240) && near(n.w, 200));
}

{
  // The inspector's numeric fields dispatch `patch` with the limits; a patch
  // must re-clamp the fill immediately on both axes.
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 100, layout({}));
  const a = addKid(e, F, 100, 100, { sizingW: "fill" });
  e.dispatch({ type: "patch", id: a, patch: { maxW: 150 } });
  t("C25 patching maxW re-clamps at once (w 400 -> 150)", near(g(e, a, "w"), 150));
  e.dispatch({ type: "patch", id: a, patch: { minW: 200, maxW: 320 } });
  t("C26 patching minW/maxW together settles at the frame's share capped to 320",
    near(g(e, a, "w"), 320));
  const e2 = new MemoryEngine(false);
  const F2 = addFrame(e2, 100, 400, layout({ direction: "vertical" }));
  const h = addKid(e2, F2, 100, 100, { sizingH: "fill" });
  e2.dispatch({ type: "patch", id: h, patch: { maxH: 160 } });
  t("C27 the height axis re-clamps the same way (h 400 -> 160)", near(g(e2, h, "h"), 160));
  e2.dispatch({ type: "patch", id: h, patch: { minH: 200, maxH: 320 } });
  t("C28 vertical min/max patch settles at 320", near(g(e2, h, "h"), 320));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
