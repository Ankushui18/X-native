/**
 * Auto-layout edge-case probe (pipeline steps 3–4): absolute positioning
 * inside an auto-layout frame, and min/max constraints on Fill children.
 *
 * The two questions the audit asks, and the Figma sentences they answer to:
 *
 *   1. "Ignore auto layout" (formerly absolute position) — "excluded from an
 *      auto layout flow while keeping it in the auto layout frame. The object
 *      and its surrounding siblings ignore each other, even as they resize and
 *      move", and such objects "are treated as objects in a regular frame. This
 *      means you can apply constraints to determine how they respond when its
 *      parent auto layout frame resizes."
 *      Measure: does it keep its pinned offset when the frame resizes, and does
 *      it stay out of the flow (siblings' positions, gaps, wrap lines, hug size)?
 *   2. Min/max on a Fill child — "Layers set to Fill container stretches to
 *      occupy all available space in their parent frame, while respecting any
 *      spacing values"; min/max is "an additional setting that can be used at
 *      the same time as other resizing properties".
 *      Measure: with the parent going 200 → 300, does a Fill child with
 *      minWidth 150 / maxWidth 180 stop at 180? And when such a child is
 *      clamped, where does the space it gave back go — to the other children,
 *      to the auto gap, or nowhere? (Figma fixed exactly this redistribution
 *      bug in Sep 2026 — forum thread 57215 — so the expected answers below
 *      follow the shipped CSS-flexbox loop.)
 *
 * Runs the engine headless (MemoryEngine), the same surface
 * src/engine/__tests__/autolayout.test.mjs uses, and prints every intermediate
 * number so a deviation can be read off directly. No canvas involved: these are
 * solver questions.
 *
 * Run:  npx vite-node tests/probes/autolayout/edgeCases.mjs
 */
import { MemoryEngine, find } from "../../../src/engine/memory.ts";

const layout = (over = {}) => ({
  direction: "horizontal",
  gap: 0,
  padding: [0, 0, 0, 0],
  sizing: "fixed",
  cross: "fixed",
  wrap: false,
  align: "min",
  justify: "min",
  ...over,
});
const root = (e) => e.snapshot().pages[e.snapshot().page].root;
const byId = (e, id) => find(root(e), id);
const addFrame = (e, w, h, l) => {
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w, h, parent: root(e).id });
  const id = root(e).children.at(-1).id;
  if (l) e.dispatch({ type: "autoLayout", id, layout: l });
  return id;
};
const addKid = (e, parent, w, h, patch = {}) => {
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent });
  const id = byId(e, parent).children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const box = (n) => ({ x: +n.x.toFixed(2), y: +n.y.toFixed(2), w: +n.w.toFixed(2), h: +n.h.toFixed(2) });
const kidBoxes = (e, id) => byId(e, id).children.map((c) => `${c.name}@${JSON.stringify(box(c))}`).join("  ");
const frameBox = (e, id) => JSON.stringify(box(byId(e, id)));

let deviations = 0;
const out = (s = "") => console.log(s);
const check = (label, actual, expected, ok, detail = "") => {
  if (!ok) deviations++;
  out(
    `${ok ? " ok " : "DIFF"} ${label}\n       ours: ${actual}\n       figma: ${expected}${detail ? `\n       ${detail}` : ""}`,
  );
};

/* =================================================================== *
 * 1 · Fill children with min/max constraints
 * =================================================================== */
out("\n=== 1 · Fill + min/max on an auto-layout child ===");

/* 1a · the asked case: parent 200x200 → 300x300, child Fill with 150/180 */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ direction: "horizontal", sizing: "fixed", cross: "fixed" }));
  const c = addKid(e, F, 100, 100, { sizingW: "fill", minW: 150, maxW: 180 });
  const before = box(byId(e, c));
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  const after = box(byId(e, c));
  check(
    "1a · Fill child, minW 150 / maxW 180, parent 200 → 300",
    `child w ${before.w} → ${after.w} (parent ${frameBox(e, F)})`,
    "180 at parent 200 (the fill asks for 200, the max clamps to 180 — the min is " +
      "not a cap) and 180 at parent 300",
    after.w === 180 && before.w === 180,
  );
  e.dispatch({ type: "resize", id: F, w: 100, h: 200 });
  const shrunk = box(byId(e, c));
  check(
    "1a′ · same child, parent shrunk to 100",
    `child w ${shrunk.w}`,
    "150 — the min wins over the frame's inner width",
    shrunk.w === 150,
  );
}

/* 1b · horizontal vs vertical: does the height axis clamp too? */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ direction: "vertical" }));
  const c = addKid(e, F, 100, 100, { sizingH: "fill", minH: 120, maxH: 160 });
  const before = box(byId(e, c));
  e.dispatch({ type: "resize", id: F, w: 200, h: 400 });
  const after = box(byId(e, c));
  check(
    "1b · vertical flow, Fill height with minH 120 / maxH 160, parent h 200 → 400",
    `child h ${before.h} → ${after.h}`,
    "160 — the max clamps the fill on the main axis",
    after.h === 160,
  );
}

/* 1c · cross-axis fill (a vertical child filling its width) */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ direction: "vertical" }));
  const c = addKid(e, F, 100, 40, { sizingW: "fill", minW: 140, maxW: 190 });
  const before = box(byId(e, c));
  e.dispatch({ type: "resize", id: F, w: 400, h: 200 });
  const after = box(byId(e, c));
  check(
    "1c · vertical flow, Fill width (cross axis) minW 140 / maxW 190, parent w 200 → 400",
    `child w ${before.w} → ${after.w}`,
    "190 — the max clamps the cross-axis fill",
    after.w === 190,
  );
}

/* 1d · two fill children: does a clamped one hand its space to its sibling?
 * Figma forum 57215 (Aug 2026): the reporter's expected result for a max-width
 * clamp is "Child B → 480, Child A → remaining 240 … This matches CSS Flexbox
 * behavior with flex-grow + min-width", and Figma's support confirmed the
 * no-redistribution behaviour was "a real layout engine bug … already been
 * fixed on our end". */

{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 100, layout({ direction: "horizontal", gap: 0 }));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", maxW: 120 });
  const b = addKid(e, F, 100, 100, { sizingW: "fill" });
  e.dispatch({ type: "resize", id: F, w: 500, h: 100 });
  const A = box(byId(e, a)), B = box(byId(e, b));
  check(
    "1d · two Fill children, A.maxW 120, parent 400 → 500",
    `A ${JSON.stringify(A)} x=${A.x}; B ${JSON.stringify(B)} x=${B.x}; ` +
      `A+B = ${(A.w + B.w).toFixed(0)} of 500`,
    "A stops at 120 and B absorbs the rest (x=120, w=380) — CSS flexbox and the " +
      "documented Figma fix both redistribute a clamped item's share",
    A.w === 120 && B.w === 380 && B.x === 120,
    `a ragged right edge (A 120 + B ${B.w} = ${(A.w + B.w).toFixed(0)} in a 500 ` +
      `frame) means the clamped share was simply dropped`,
  );
}

/* 1e · a min constraint that exceeds the frame's inner size */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 100, 100, layout({ direction: "horizontal", padding: [0, 20, 0, 0] }));
  const c = addKid(e, F, 100, 50, { sizingW: "fill", minW: 200 });
  const C = box(byId(e, c));
  check(
    "1e · Fill child, minW 200, inside a 100-wide frame (20 right padding)",
    `child ${JSON.stringify(C)}`,
    "200 — min/max are the child's own limits and outrank the fill (the child " +
      "overflows the 80px content box)",
    C.w === 200,
  );
}

/* 1g · the forum thread's exact min-width case (57215): parent 300, two Fill
 * children, A.minW 80, B.minW 160 — Figma's shipped fix gives B 160, A 140. */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 100, layout({ direction: "horizontal", gap: 0 }));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", minW: 80 });
  const b = addKid(e, F, 100, 100, { sizingW: "fill", minW: 160 });
  const A = box(byId(e, a)), B = box(byId(e, b));
  check(
    "1g · two Fill children, minW 80 and minW 160, in a 300-wide frame",
    `A ${JSON.stringify(A)}; B ${JSON.stringify(B)}; total ${(A.w + B.w).toFixed(0)} of 300`,
    "B is pushed to its 160 min, A gives up the difference: A = 140, total 300",
    A.w === 140 && B.w === 160,
    "if the equal share is handed out and the min only applied on top, the row " +
      "overflows its own frame instead",
  );
}

/* 1h · a clamped Fill child that also carries padding (content-area model) */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 400, 100, layout({ direction: "horizontal", gap: 0 }));
  const a = addKid(e, F, 100, 60, { sizingW: "fill", maxW: 150, padding: [8, 8, 8, 8] });
  const b = addKid(e, F, 100, 60, { sizingW: "fill" });
  e.dispatch({ type: "resize", id: F, w: 500, h: 100 });
  const A = box(byId(e, a)), B = box(byId(e, b));
  check(
    "1h · Fill child with 8px padding and maxW 150, sibling Fill, frame 500",
    `A ${JSON.stringify(A)} (content ${(A.w - 16).toFixed(0)}); B ${JSON.stringify(B)}; ` +
      `total ${(A.w + B.w).toFixed(0)} of 500`,
    "A clamps to 150 and B takes the remaining 350 (x = 150)",
    A.w === 150 && B.x === 150 && B.w === 350,
  );
}

/* 1i · auto gap: where does a clamped filler's surplus go? */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({ direction: "horizontal", gapMode: "auto", spacing: "between", gap: 0 }));
  const a = addKid(e, F, 60, 60, { sizingW: "fill", maxW: 120 });
  const b = addKid(e, F, 60, 60);
  const A = box(byId(e, a)), B = box(byId(e, b));
  const slack = B.x - (A.x + A.w);
  check(
    "1i · auto gap (Between) with a Fill child capped at maxW 120, frame 500",
    `A ${JSON.stringify(A)}; B ${JSON.stringify(B)}; gap between them ${slack.toFixed(0)}; ` +
      `right edge ${(B.x + B.w).toFixed(0)} of 500`,
    "the capped 380px of fill space shows up as the auto gap: A stays 120 wide, " +
      "B is pushed to the right edge (x = 440)",
    B.x + B.w === 500 && slack > 300,
  );
}

/* 1l · three fillers, one min-clamped and one max-clamped */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 600, 100, layout({ direction: "horizontal", gap: 0 }));
  const a = addKid(e, F, 100, 100, { sizingW: "fill", minW: 300 });
  const b = addKid(e, F, 100, 100, { sizingW: "fill", maxW: 100 });
  const c = addKid(e, F, 100, 100, { sizingW: "fill" });
  const A = box(byId(e, a)), B = box(byId(e, b)), C = box(byId(e, c));
  check(
    "1l · three Fill children: minW 300, maxW 100, uncapped, frame 600",
    `A ${A.w} · B ${B.w} · C ${C.w} · total ${(A.w + B.w + C.w).toFixed(0)} of 600`,
    "A 300 (min), B 100 (max), C 200 (the rest) — total 600",
    A.w === 300 && B.w === 100 && C.w === 200,
  );
}

/* 1m · the same clamp under justify center: does the residual space get honoured? */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 500, 100, layout({ direction: "horizontal", justify: "center" }));
  const a = addKid(e, F, 60, 60, { sizingW: "fill", maxW: 120 });
  const b = addKid(e, F, 60, 60);
  const A = box(byId(e, a)), B = box(byId(e, b));
  check(
    "1m · Fill child capped at maxW 120 with justify center, frame 500",
    `A ${JSON.stringify(A)}; B ${JSON.stringify(B)}; content span ${A.x}…${(B.x + B.w).toFixed(0)}`,
    "A is capped at 120 and nothing else can absorb the 380px, so it is free " +
      "space: centered content (500 − 180) / 2 = 160, so A at x=160 and B at 280",
    A.x === 160 && B.x === 280 && A.w === 120,
  );
}

/* 1j · a max-clamped frame that is itself a Fill child of a bigger frame */
{
  const e = new MemoryEngine(false);
  const outer = addFrame(e, 600, 100, layout({ direction: "horizontal" }));
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 100, h: 100, parent: outer });
  const inner = byId(e, outer).children[0].id;
  e.dispatch({ type: "autoLayout", id: inner, layout: layout({ direction: "vertical" }) });
  e.dispatch({ type: "patch", id: inner, patch: { sizingW: "fill", maxW: 250 } });
  const I = box(byId(e, inner));
  check(
    "1j · nested auto-layout frame, Fill width with maxW 250, inside a 600-wide frame",
    `inner ${JSON.stringify(I)}; outer content 600`,
    "250 — the frame's own max clamps its fill (Figma: min/max apply to any " +
      "auto layout frame and its children)",
    I.w === 250,
  );
}

/* 1f · does a clamped Fill child still count as a filler for the hug / auto gap? */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 100, layout({ direction: "horizontal", sizing: "hug" }));
  const c = addKid(e, F, 100, 50, { sizingW: "fill", maxW: 80 });
  const C = box(byId(e, c));
  check(
    "1f · hug frame with one Fill child capped at maxW 80",
    `frame ${frameBox(e, F)}; child ${JSON.stringify(C)}`,
    "the frame does not hug down around a capped filler — Figma keeps a fill " +
      "frame fixed, and the child takes its 80px (or the frame's content box)",
    !(C.w === 80 && box(byId(e, F)).w === 80),
    "a hug that collapsed to the capped child would be a second bug (the frame's " +
      "own sizing said fixed)",
  );
}

/* =================================================================== *
 * 2 · Absolute positioning inside an auto-layout frame
 * =================================================================== */
out("\n=== 2 · Absolute position inside an auto-layout frame ===");

/* 2a · out of the flow: siblings and gaps must not move */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 200, layout({ direction: "horizontal", gap: 10 }));
  const a = addKid(e, F, 60, 60);
  const b = addKid(e, F, 60, 60);
  const flowed = kidBoxes(e, F);
  const abs = addKid(e, F, 40, 40, { x: 100, y: 150, absolutePosition: true });
  const withAbs = kidBoxes(e, F).split("  ").slice(0, 2).join("  ");
  check(
    "2a · adding an absolute child leaves the flow untouched",
    `before [${flowed}]\n             after  [${withAbs}]`,
    "A and B keep their exact positions (0,0) and (70,0); the absolute child " +
      "sits where it was placed",
    flowed === withAbs && box(byId(e, abs)).x === 100,
    `the frame is fixed 300 wide, so if the absolute child entered the flow it ` +
      `would take a 60-wide slot and push/space its siblings`,
  );
  void a; void b;
}

/* 2b · pinned bottom-right across a resize */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ direction: "vertical", gap: 10 }));
  const c = addKid(e, F, 40, 40, {
    x: 150, y: 150, absolutePosition: true,
    constraintH: "max", constraintV: "max",
  });
  const before = box(byId(e, c));
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  const after = box(byId(e, c));
  const gapRight = box(byId(e, F)).w - (after.x + after.w);
  const gapBottom = box(byId(e, F)).h - (after.y + after.h);
  check(
    "2b · absolute child pinned bottom-right (right/bottom constraints), frame 200 → 300",
    `child ${JSON.stringify(before)} → ${JSON.stringify(after)}; ` +
      `inset right ${gapRight}, bottom ${gapBottom}`,
    "the child follows the corner: +100 on both axes, insets unchanged " +
      "(10,10 → 10,10)",
    after.x === before.x + 100 && after.y === before.y + 100 && gapRight === 10 && gapBottom === 10,
  );
}

/* 2c · pinned top-left is the default: the offset must NOT move */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ direction: "vertical" }));
  const c = addKid(e, F, 40, 40, { x: 30, y: 30, absolutePosition: true });
  const before = box(byId(e, c));
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  const after = box(byId(e, c));
  check(
    "2c · absolute child, default left/top, frame 200 → 300",
    `child ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    "offset from the top-left is preserved exactly (30,30 → 30,30)",
    after.x === 30 && after.y === 30,
  );
}

/* 2d · do constraints with min/max clamp an absolutely positioned child? */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ direction: "vertical" }));
  const c = addKid(e, F, 40, 40, {
    x: 10, y: 10, absolutePosition: true,
    constraintH: "stretch", maxW: 150, minW: 100,
    constraintV: "stretch", maxH: 150, minH: 100,
  });
  e.dispatch({ type: "resize", id: F, w: 400, h: 400 });
  const C = box(byId(e, c));
  check(
    "2d · absolute child, stretch constraints, minW 100 / maxW 150, frame 200 → 400",
    `child ${JSON.stringify(C)}`,
    "the stretch stops at the clamp: w = 150, h = 150 (left at x=10, so 10+150 " +
      "= 160 ≤ 390 of content)",
    C.w === 150 && C.h === 150,
  );
}

/* 2e · absolute inside a clipped frame — is it masked by the resize? */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 200, layout({ direction: "vertical" }));
  F && addKid(e, F, 40, 40, { x: 150, y: 150, absolutePosition: true, constraintH: "max", constraintV: "max" });
  e.dispatch({ type: "resize", id: F, w: 100, h: 100 });
  const kid = byId(e, F).children[0];
  check(
    "2e · pinned child survives a shrink to 100x100 (no clamp to the frame)",
    `child ${JSON.stringify(box(kid))}; frame ${frameBox(e, F)}`,
    "Figma keeps the layer's size (40x40) and its pinned inset, even when the " +
      "frame shrinks past it",
    kid.w === 40 && kid.h === 40,
  );
}

/* 2f · two absolute children: neither is in the flow, both keep their offsets */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 200, layout({ direction: "horizontal", gap: 5, padding: [10, 10, 10, 10] }));
  addKid(e, F, 60, 60);
  addKid(e, F, 60, 60, { x: 0, y: 0, absolutePosition: true, constraintH: "min", constraintV: "min" });
  addKid(e, F, 60, 60, { x: 200, y: 100, absolutePosition: true, constraintH: "max", constraintV: "max" });
  const flowed = JSON.stringify(box(byId(e, F).children[0]));
  e.dispatch({ type: "resize", id: F, w: 400, h: 300 });
  const a2 = box(byId(e, F).children[1]);
  const b2 = box(byId(e, F).children[2]);
  check(
    "2f · one flow child + two absolute children, frame 300x200 → 400x300",
    `flow child ${flowed} → ${JSON.stringify(box(byId(e, F).children[0]))}; ` +
      `abs-min ${JSON.stringify(a2)}; abs-max ${JSON.stringify(b2)}`,
    "the flow child keeps (10,10); the min-pinned absolute stays at (0,0); the " +
      "max-pinned one moves +100/+100 to (300,200)",
    a2.x === 0 && a2.y === 0 && b2.x === 300 && b2.y === 200,
  );
}

/* 2g · toggling "Ignore auto layout" on a flow child keeps it where it is */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 100, layout({ direction: "horizontal", gap: 10 }));
  addKid(e, F, 50, 50);
  const b = addKid(e, F, 50, 50);
  const asFlow = box(byId(e, b));
  e.dispatch({ type: "patch", id: b, patch: { absolutePosition: true } });
  const asAbs = box(byId(e, b));
  const first = box(byId(e, F).children[0]);
  check(
    "2g · toggling absolute position on a flow child",
    `child B ${JSON.stringify(asFlow)} → ${JSON.stringify(asAbs)}; sibling A ${JSON.stringify(first)}`,
    "B stays exactly where the flow had put it (60,0) and A stays at (0,0) — the " +
      "gaps close up only when the flow is asked to re-pack",
    asAbs.x === asFlow.x && asAbs.y === asFlow.y && first.x === 0,
  );
}

/* 2h · an absolute child must not consume a wrap line's width */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 100, layout({ direction: "horizontal", gap: 0, wrap: true }));
  addKid(e, F, 120, 40);
  addKid(e, F, 120, 40);
  const wrapped = byId(e, F).children.map((c) => `${c.x},${c.y}`).join(" ");
  const abs = addKid(e, F, 140, 40, { x: 20, y: 60, absolutePosition: true });
  const after = byId(e, F).children.slice(0, 2).map((c) => `${c.x},${c.y}`).join(" ");
  check(
    "2h · a 140-wide absolute child inside a 200-wide wrapping flow",
    `before [${wrapped}]  after [${after}]  abs ${JSON.stringify(box(byId(e, abs)))}`,
    "the two 120-wide children keep breaking to their own lines (0,0 and 0,40); " +
      "the absolute child adds no line and keeps (20,60)",
    wrapped === after && box(byId(e, abs)).x === 20,
  );
}

/* 2i · an absolute child in a grid frame takes no cell */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 220, 220, layout({ direction: "grid", columns: 2, gap: 20, padding: [0, 0, 0, 0] }));
  addKid(e, F, 100, 100);
  addKid(e, F, 100, 100);
  const cells = byId(e, F).children.map((c) => `${c.gridCol},${c.gridRow}`).join(" ");
  // The add is aimed past the last cell so the cursor rule appends it.
  const abs = addKid(e, F, 100, 100, { x: 210, y: 210 });
  const others = () =>
    byId(e, F).children
      .filter((c) => c.id !== abs)
      .map((c) => `${c.name}:${c.gridCol},${c.gridRow}@${+c.x},${+c.y}`)
      .join(" ");
  const placed = others();
  e.dispatch({ type: "patch", id: abs, patch: { x: 10, y: 10, absolutePosition: true } });
  const after = others();
  const A = byId(e, abs);
  check(
    "2i · grid frame (2 cols): a child switched to ignore auto layout",
    `before [${placed}]\n             after  [${after}]  (absolute at ${JSON.stringify(box(A))})`,
    "switching the child to absolute leaves every other child's cell and position " +
      "exactly as they were, and the child keeps its own (10,10)",
    after === placed && box(A).x === 10 && box(A).y === 10 && A.absolutePosition === true,
    `the two flow children started at cells [${cells}]`,
  );
}

/* 2j · absolute children never size a hug frame */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 100, 100, layout({ direction: "horizontal", sizing: "hug", cross: "hug" }));
  addKid(e, F, 60, 40);
  const hug = frameBox(e, F);
  addKid(e, F, 300, 300, { x: 0, y: 0, absolutePosition: true });
  const hug2 = frameBox(e, F);
  check(
    "2j · hug frame with a 300x300 absolute child added",
    `frame ${hug} → ${hug2}`,
    "the frame keeps hugging its flow child (60x40); the oversized absolute child " +
      "does not stretch it",
    hug === hug2 && box(byId(e, F)).w === 60,
  );
}

/* 2k · an absolute child does not pin the frame's padding floor */
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 300, 300, layout({ direction: "horizontal", padding: [10, 10, 10, 10] }));
  const c = addKid(e, F, 40, 40, { x: 200, y: 200, absolutePosition: true, constraintH: "max", constraintV: "max" });
  e.dispatch({ type: "resize", id: F, w: 60, h: 60 });
  const F2 = box(byId(e, F));
  const C = box(byId(e, c));
  check(
    "2k · pinned absolute child when the frame shrinks to 60x60 (10px padding)",
    `frame ${JSON.stringify(F2)}; child ${JSON.stringify(C)}`,
    "the child's right/bottom inset was 60 (300 − 240), so a 60-wide frame puts " +
      "its top-left at −40: the inset is honoured and the child overflows",
    F2.w === 60 && F2.h === 60 && C.x === -40 && C.y === -40,
  );
}

/* =================================================================== *
 * 3 · The two together: a pinned child must not affect the flow that the
 *     fill child's constraints are resolved against
 * =================================================================== */
out("\n=== 3 · combined ===");
{
  const e = new MemoryEngine(false);
  const F = addFrame(e, 200, 100, layout({ direction: "horizontal", gap: 10, padding: [10, 10, 10, 10] }));
  const a = addKid(e, F, 100, 40, { sizingW: "fill", maxW: 180 });
  addKid(e, F, 40, 40);
  addKid(e, F, 40, 40, { x: 150, y: 50, absolutePosition: true, constraintH: "max", constraintV: "max" });
  e.dispatch({ type: "resize", id: F, w: 400, h: 200 });
  const A = box(byId(e, a));
  const B = box(byId(e, F).children[1]);
  const C = box(byId(e, F).children[2]);
  check(
    "3a · [Fill(maxW 180), fixed 40, absolute pinned] in a 400x200 frame, pad 10/gap 10",
    `A ${JSON.stringify(A)}; B ${JSON.stringify(B)}; C ${JSON.stringify(C)}`,
    "A takes 180 (clamped), B sits at x=200, C stays pinned in the corner " +
    "(inset 10,10 → x=350, y=150)",
    A.w === 180 && B.x === 200 && C.x === 350 && C.y === 150,
    "content box is 380; A clamps to 180, B is 40 at x=200; if A's share were " +
      "dropped instead of clamped, B would sit at 170",
  );
}

out(`\n${deviations} deviation group(s) measured`);
