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

// 2. Old documents: an open path stored with the pre-P0-3 default keeps
//    painting. The paint guard (`paintedStrokeAlign`) overrides the stored
//    flag, so the inside pick below is not honoured on an open path — which is
//    the ratified decision, and the reason the width above is a real
//    discriminator rather than a coin.
{
  const id = snap().selection[0];
  const mark = ui.ctx.strokes.length;
  await ui.dispatch({ type: "patch", id, patch: { strokeAlign: "inside" } });
  const ink = inkSince(mark);
  t("an open path stored inside still paints one band", ink.length === 1, widths(ink));
  t("...at its own weight, not the doubled clip band", ink[0]?.width === 2, widths(ink));
}

// 3. An individual ("extra") stroke on the same open path is centre-stroked
//    too: the pass that paints extras reaches the same conclusion, so an
//    inside extra cannot quietly disappear behind the same zero-area clip.
{
  const id = snap().selection[0];
  const mark = ui.ctx.strokes.length;
  await ui.dispatch({
    type: "patch",
    id,
    patch: { strokes: [{ color: "#ff0000", opacity: 1, visible: true, width: 6, align: "inside" }] },
  });
  const extra = since(mark).filter((s) => s.inDoc && s.color === "rgba(255,0,0,1)");
  t("an inside extra stroke on an open path paints", extra.length > 0, widths(extra));
  t("...at its own weight, not the doubled clip band", extra.some((s) => s.width === 6), widths(extra));
  t("...and never at the doubled width", extra.every((s) => s.width !== 12), widths(extra));
  await ui.dispatch({ type: "patch", id, patch: { strokes: [] } });
}

// 4. The control on a shape where "inside" means something: a closed rectangle
//    keeps the doubled, clipped band. If this ever went to 2, the guard would
//    have spread past open paths and broken inside strokes for real shapes.
{
  const mark = ui.ctx.strokes.length;
  await ui.dispatch({ type: "add", kind: "rect", x: 600, y: 200, w: 120, h: 80 });
  const id = snap().selection[0];
  await ui.dispatch({
    type: "patch",
    id,
    patch: { strokeVisible: true, strokePaint: "#1e1e1e", strokeWidth: 2, strokeAlign: "inside" },
  });
  const ink = inkSince(mark);
  t("a closed shape's inside stroke is still the doubled band", ink.some((s) => s.width === 4), widths(ink));
}

// 5. The brush, which the renderer has always forced to centre, keeps painting
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
