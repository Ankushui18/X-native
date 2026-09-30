/**
 * P0-3: an open path paints. The pen's straight segment is the case that used
 * to vanish — an "inside" stroke is drawn as a doubled band clipped to the
 * region the path encloses, and a straight segment encloses nothing, so the
 * clip threw the whole stroke away. The engine now creates open paths
 * centre-stroked (memory.ts addPath), which is the branch with no clip at all.
 *
 * This suite asserts on the *paint*, not the stored flag: the recording 2D
 * context reports the line width each stroke() was asked for, and the inside
 * branch is the one that doubles it (Canvas.tsx:2192).
 *
 * Run with:  npx vite-node src/ui/__tests__/openPathStroke.dom.test.mjs
 */
import { mountCanvas } from "./softCanvas2d.mjs";

let pass = 0;
let fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra === "" ? "" : ` — ${extra}`}`);
  }
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\nopen-path stroke: ${pass} passed, 0 failed`);
});

// The harness mounts at zoom 1, so a stored width is the device width.
const ui = await mountCanvas([]);
const since = (mark) => ui.ctx.strokes.slice(mark);
const snap = () => ui.engine.snapshot();
const nodeOf = (id) => {
  const walk = (n) => (n.id === id ? n : n.children.map(walk).find(Boolean) ?? null);
  return walk(snap().pages[snap().page].root);
};
// The node's own ink is #1e1e1e; a repaint also strokes the selection's
// accent outline, so the paint has to be picked out by colour.
const INK = "rgba(30,30,30,1)";
const inkSince = (mark) => since(mark).filter((s) => s.inDoc && s.color === INK);
const widths = (list) => list.map((s) => s.width).join(",");

const straightSegment = async () => {
  const mark = ui.ctx.strokes.length;
  await ui.dispatch({ type: "setTool", tool: "pen" });
  await ui.dispatch({ type: "addPath", points: [{ x: 200, y: 200 }, { x: 400, y: 200 }], closed: false });
  return { id: snap().selection[0], ink: inkSince(mark) };
};

// 1. The straight segment, as the pen leaves it.
{
  const { id, ink } = await straightSegment();
  t("the pen's segment is stored centre-aligned", nodeOf(id).strokeAlign === "center", nodeOf(id).strokeAlign);
  t("it paints one band of ink", ink.length === 1, widths(ink));
  t("...at its own weight — not the doubled inside band", ink[0]?.width === 2, widths(ink));
  t("...with round caps", nodeOf(id).strokeCap === "round", nodeOf(id).strokeCap);
}

// 2. The control: the same geometry forced back to "inside" (the old default,
//    still reachable from the inspector) is the doubled band — which is what
//    makes the width above a real discriminator rather than a coin.
{
  const id = snap().selection[0];
  const mark = ui.ctx.strokes.length;
  await ui.dispatch({ type: "patch", id, patch: { strokeAlign: "inside" } });
  const ink = inkSince(mark);
  t("an inside stroke is still drawn as the doubled band", ink.length === 1 && ink[0].width === 4, widths(ink));
}

// 3. The brush, which the renderer has always forced to centre, keeps painting
//    at its own weight.
{
  const mark = ui.ctx.strokes.length;
  await ui.dispatch({ type: "setTool", tool: "brush" });
  await ui.dispatch({ type: "addPath", points: [{ x: 200, y: 300 }, { x: 400, y: 300 }], closed: false });
  const id = snap().selection[0];
  const ink = inkSince(mark);
  t("the brush stroke is stored centre-aligned", nodeOf(id).strokeAlign === "center", nodeOf(id).strokeAlign);
  t("...and paints at its brush weight", ink.some((s) => s.width === 8), widths(ink));
}

await ui.close();
