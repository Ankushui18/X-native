/**
 * Independent audit probe — Auto Layout Edge Cases (this pipeline run).
 *
 * Written from scratch against the raw MemoryEngine dispatch API, following the
 * brief's two scenarios literally, so the numbers below are measured and not
 * inherited from any earlier run's instrument:
 *
 *   A. Auto-layout frame 200x200, one child "Fill" with minW 150 / maxW 180.
 *      Expand the parent to 300x300. Does the child clamp at 180, or does it
 *      incorrectly stretch to 300?  Shrink the parent to 100 next: the min
 *      must win (150).
 *   B. Add an "Absolute position" child (pinned bottom-right, insets 10/10)
 *      to the frame. Resize the parent. It must keep its pinned offset
 *      relative to the frame's bounds and leave the flow of the sibling
 *      children untouched (positions, gap, hug size).
 *
 * Plus the two neighbouring redistribution cases (the deviations the previous
 * run measured pre-fix) so this run can state whether they reproduce.
 *
 * Run:  npx vite-node tests/probes/autolayout/briefEdgeCases.mjs
 */
import { MemoryEngine, find } from "../../../src/engine/memory.ts";

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const node = (e, id) => find(rootOf(e), id);
const r2 = (n) => Math.round(n * 100) / 100;
const box = (n) => `(${r2(n.x)}, ${r2(n.y)}) ${r2(n.w)}x${r2(n.h)}`;

let fails = 0;
const say = (s = "") => console.log(s);
const expect = (label, actual, want, ok) => {
  if (!ok) fails++;
  say(`${ok ? "  ok " : " DIFF"} ${label}\n         measured: ${actual}\n         expected: ${want}`);
};

const engine = () => new MemoryEngine(false);
const addFrame = (e, w, h, layout) => {
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w, h, parent: rootOf(e).id });
  const id = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "autoLayout", id, layout });
  return id;
};
const addRect = (e, parent, w, h, patch = {}) => {
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent });
  const id = node(e, parent).children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const flow = (over = {}) => ({
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

say("=== A · Fill child with minW 150 / maxW 180 under a 200 -> 300 parent ===");
{
  const e = engine();
  const F = addFrame(e, 200, 200, flow());
  const C = addRect(e, F, 100, 100, { sizingW: "fill", minW: 150, maxW: 180 });
  const at200 = node(e, C).w;
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  const at300 = node(e, C).w;
  e.dispatch({ type: "resize", id: F, w: 100, h: 300 });
  const at100 = node(e, C).w;
  expect(
    "A1 · child width at parent 200 (fill share 200, clamped to max 180)",
    `w = ${r2(at200)}`,
    "w = 180",
    at200 === 180,
  );
  expect(
    "A2 · child width at parent 300 (fill share 300 -> maxWidth 180)",
    `w = ${r2(at300)}`,
    "w = 180  (a w = 300 here means the fill ignores maxWidth)",
    at300 === 180,
  );
  expect(
    "A3 · child width at parent 100 (fill share 100 -> minWidth 150)",
    `w = ${r2(at100)}`,
    "w = 150  (the min outranks the fill)",
    at100 === 150,
  );
}

say("\n=== B · 'Absolute position' child pinned bottom-right, parent 200 -> 300 ===");
{
  const e = engine();
  const F = addFrame(e, 200, 200, flow({ gap: 10 }));
  const A = addRect(e, F, 60, 60);
  const B = addRect(e, F, 60, 60);
  // The flow packs A at (0,0) and B at (70,0) — 60 + gap 10.
  const abs = addRect(e, F, 40, 40, {
    absolutePosition: true,
    constraintH: "max",
    constraintV: "max",
    x: 150,
    y: 150, // 10px inset from the bottom-right of the 200x200 frame
  });
  // Toggling/patching may re-flow: read the settled boxes first.
  const a0 = box(node(e, A));
  const b0 = box(node(e, B));
  const abs0 = box(node(e, abs));
  e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
  const a1 = box(node(e, A));
  const b1 = box(node(e, B));
  const abs1 = box(node(e, abs));
  const nAbs = node(e, abs);
  const insetR = r2(300 - nAbs.x - nAbs.w);
  const insetB = r2(300 - nAbs.y - nAbs.h);
  expect(
    "B1 · absolute child before resize (10,10 inset from bottom-right)",
    abs0,
    "(150, 150) 40x40",
    abs0 === "(150, 150) 40x40",
  );
  expect(
    "B2 · absolute child after 200 -> 300 follows the pinned corner",
    `${abs1}  insets right=${insetR} bottom=${insetB}`,
    "(250, 250) 40x40  insets right=10 bottom=10",
    abs1 === "(250, 250) 40x40" && insetR === 10 && insetB === 10,
  );
  expect(
    "B3 · flow siblings untouched by the absolute child and the resize",
    `A ${a0} -> ${a1};  B ${b0} -> ${b1}`,
    "A (0, 0) 60x60 -> (0, 0) 60x60;  B (70, 0) 60x60 -> (70, 0) 60x60",
    a0 === "(0, 0) 60x60" && a1 === "(0, 0) 60x60" && b0 === "(70, 0) 60x60" && b1 === "(70, 0) 60x60",
  );
  // And the flow must not reserve space for the absolute child in a hug.
  const e2 = engine();
  const Fh = addFrame(e2, 100, 100, flow({ sizing: "hug", cross: "hug" }));
  addRect(e2, Fh, 60, 40);
  addRect(e2, Fh, 300, 300, { absolutePosition: true, x: 0, y: 0 });
  const hug = node(e2, Fh);
  expect(
    "B4 · hug frame ignores the absolute child (300x300) in its size",
    box(hug),
    "(0, 0) 60x40",
    hug.w === 60 && hug.h === 40,
  );
}

say("\n=== C · redistribution neighbours (run 11's pre-fix deviation signature) ===");
{
  // C1: two fill children, A capped at maxW 120, frame 500 — A's released
  // share must go to B (CSS flex-grow + max-width; Figma forum 57215).
  const e = engine();
  const F = addFrame(e, 500, 100, flow());
  const A = addRect(e, F, 100, 100, { sizingW: "fill", maxW: 120 });
  const B = addRect(e, F, 100, 100, { sizingW: "fill" });
  const a = node(e, A);
  const b = node(e, B);
  expect(
    "C1 · capped filler hands its space to the open filler",
    `A w=${r2(a.w)} @x=${r2(a.x)};  B w=${r2(b.w)} @x=${r2(b.x)};  total ${r2(a.w + b.w)} of 500`,
    "A w=120 @x=0;  B w=380 @x=120;  total 500 of 500",
    a.w === 120 && b.w === 380 && b.x === 120,
  );
  // C2: every filler capped — the residual is free space, and with an auto gap
  // (gapMode "auto", spacing "between") the gap takes it: the fixed child rides
  // the right edge. (A *fixed* gap with packed-left alignment instead leaves
  // the residual at the right edge — B at x=120 — which is Figma-correct and
  // not a deviation.)
  const e2 = engine();
  const F2 = addFrame(e2, 500, 60, flow({ gapMode: "auto", spacing: "between" }));
  const A2 = addRect(e2, F2, 100, 60, { sizingW: "fill", maxW: 120 });
  const B2 = addRect(e2, F2, 60, 60);
  const a2 = node(e2, A2);
  const b2 = node(e2, B2);
  expect(
    "C2 · auto gap absorbs the space a capped filler could not take",
    `A w=${r2(a2.w)} @x=${r2(a2.x)};  B @x=${r2(b2.x)} (right edge ${r2(b2.x + b2.w)} of 500)`,
    "A w=120 @x=0;  B @x=440 (right edge 500 of 500)",
    a2.w === 120 && b2.x === 440,
  );
  // C3: a min that exceeds the equal share must shrink the sibling, not
  // overflow the row (the other pre-fix signature).
  const e3 = engine();
  const F3 = addFrame(e3, 300, 100, flow());
  const A3 = addRect(e3, F3, 100, 100, { sizingW: "fill", minW: 80 });
  const B3 = addRect(e3, F3, 100, 100, { sizingW: "fill", minW: 160 });
  const a3 = node(e3, A3);
  const b3 = node(e3, B3);
  expect(
    "C3 · a min above the equal share squeezes the sibling, not the frame",
    `A w=${r2(a3.w)};  B w=${r2(b3.w)};  total ${r2(a3.w + b3.w)} of 300`,
    "A w=140;  B w=160;  total 300 of 300",
    a3.w === 140 && b3.w === 160,
  );
}

say("\n=== D · adversarial neighbours (cases no prior probe measured) ===");
{
  // D1 · auto gap "evenly"/"around": a capped filler's residual must split
  // symmetrically (lead = half of "around", third of "evenly").
  for (const spacing of ["around", "evenly"]) {
    const e = engine();
    const F = addFrame(e, 500, 60, flow({ gapMode: "auto", spacing }));
    const A = addRect(e, F, 100, 60, { sizingW: "fill", maxW: 120 });
    const B = addRect(e, F, 60, 60);
    const a = node(e, A);
    const b = node(e, B);
    const lead = a.x;
    const trail = r2(500 - (b.x + b.w));
    const gap = r2(b.x - (a.x + a.w));
    expect(
      `D1 · auto gap "${spacing}" splits a capped filler's residual symmetrically`,
      `A w=${r2(a.w)} @x=${r2(a.x)};  B @x=${r2(b.x)};  lead=${r2(lead)} gap=${gap} trail=${trail}`,
      spacing === "around"
        ? "A w=120 @x=80;  B @x=360;  lead=80 gap=160 trail=80"
        : "A w=120 @x=106.67;  B @x=333.33;  lead=106.67 gap=106.67 trail=106.67",
      spacing === "around"
        ? a.w === 120 && a.x === 80 && b.x === 360 && lead === trail
        : a.w === 120 && Math.abs(a.x - 320 / 3) < 0.01 && Math.abs(b.x - 1000 / 3) < 0.01 && Math.abs(lead - trail) < 0.01,
    );
  }
  // D2 · grid cell fill + maxW clamp.
  {
    const e = engine();
    const F = addFrame(e, 400, 400, {
      direction: "grid",
      gap: 0,
      gapCols: 0,
      gapRows: 0,
      padding: [0, 0, 0, 0],
      sizing: "fixed",
      cross: "fixed",
      wrap: false,
      align: "min",
      justify: "min",
      columns: 2,
    });
    const A = addRect(e, F, 50, 50, { sizingW: "fill", sizingH: "fill", maxW: 150, maxH: 150 });
    const a = node(e, A);
    expect(
      "D2 · grid cell fill clamps to maxW/maxH",
      box(a),
      "(0, 0) 150x150",
      a.w === 150 && a.h === 150,
    );
  }
  // D3 · aspect-locked fill + maxW: the clamp must keep the ratio.
  {
    const e = engine();
    const F = addFrame(e, 400, 200, flow());
    const A = addRect(e, F, 100, 50, { sizingW: "fill", maxW: 180, aspectLocked: true, aspectRatio: 0.5 });
    const a = node(e, A);
    expect(
      "D3 · aspect-locked fill stops at maxW and keeps its ratio",
      box(a),
      "(0, 0) 180x90",
      a.w === 180 && a.h === 90,
    );
  }
  // D4 · absolute child with scale constraints under a 1.5x resize.
  {
    const e = engine();
    const F = addFrame(e, 200, 200, flow());
    const A = addRect(e, F, 40, 40, {
      absolutePosition: true,
      constraintH: "scale",
      constraintV: "scale",
      x: 30,
      y: 30,
    });
    e.dispatch({ type: "resize", id: F, w: 300, h: 300 });
    const a = node(e, A);
    expect(
      "D4 · scale-pinned absolute child scales position and size (x1.5)",
      box(a),
      "(45, 45) 60x60",
      a.x === 45 && a.y === 45 && a.w === 60 && a.h === 60,
    );
  }
}

say(fails === 0 ? "\n0 deviation(s) measured" : `\n${fails} deviation(s) measured`);
process.exit(fails === 0 ? 0 : 1);
