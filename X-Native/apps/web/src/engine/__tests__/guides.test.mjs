/**
 * Headless checks for §9 (rulers, guides, grids): frame-level guides, guide
 * selection, guide undo coalescing, and snapping to guides.
 *
 * Run with:  npx vite-node src/engine/__tests__/guides.test.mjs
 */
import { MemoryEngine } from "../memory.ts";
import { snapMove, snapResize } from "../snapping.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

const snapOf = (e) => e.snapshot();
const guidesOf = (e) => snapOf(e).pages[snapOf(e).page].guides;
const guideIds = (e) => guidesOf(e).map((g) => g.id);

console.log("G-A guide creation and levels:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "addGuide", axis: "x", at: 100 });
  const gs = guidesOf(e);
  t("addGuide creates a canvas-level guide", gs.length === 1 && !gs[0].frameId);
  t("guide id is unique and stable", typeof gs[0].id === "string" && gs[0].id.length > 0);

  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 400, h: 300 });
  const root = snapOf(e).pages[snapOf(e).page].root;
  const frame = root.children[root.children.length - 1];
  e.dispatch({ type: "addGuide", axis: "y", at: 40, frameId: frame.id });
  const g2 = guidesOf(e).find((g) => g.frameId === frame.id);
  t("addGuide accepts a frame home", !!g2 && g2.at === 40);

  const g1 = guidesOf(e).find((g) => !g.frameId);
  e.dispatch({ type: "setGuideFrame", id: g1.id, frameId: frame.id });
  t("setGuideFrame re-homes an existing guide", guidesOf(e).find((g) => g.id === g1.id).frameId === frame.id);
  e.dispatch({ type: "setGuideFrame", id: g1.id, frameId: null });
  t("setGuideFrame back to canvas", !guidesOf(e).find((g) => g.id === g1.id).frameId);
}

console.log("G-B guide undo coalescing:");
{
  const e = new MemoryEngine(false);
  const undo = () => e.dispatch({ type: "undo" });

  // Creation (add + positioning moves + re-home) is one undo step.
  e.dispatch({ type: "addGuide", axis: "x", at: 10 });
  const id = guideIds(e)[0];
  e.dispatch({ type: "moveGuide", id, at: 20 });
  e.dispatch({ type: "moveGuide", id, at: 30 });
  e.dispatch({ type: "setGuideFrame", id, frameId: null });
  t("creation drag positions the guide", guidesOf(e)[0].at === 30);
  undo();
  t("creation undoes in one step", guideIds(e).length === 0);

  // A later reposition drag is its own single step. The coalescing window
  // is time-based, so this needs a real pause past it.
  e.dispatch({ type: "addGuide", axis: "y", at: 5 });
  await new Promise((r) => setTimeout(r, 650));
  const id2 = guideIds(e)[0];
  e.dispatch({ type: "moveGuide", id: id2, at: 6 });
  e.dispatch({ type: "moveGuide", id: id2, at: 7 });
  undo();
  const g = guidesOf(e)[0];
  t("reposition drag undoes in one step", guideIds(e).length === 1 && g.at === 5);
  undo();
  t("guide creation itself undoes", guideIds(e).length === 0);

  e.dispatch({ type: "addGuide", axis: "x", at: 1 });
  e.dispatch({ type: "selectGuide", id: guideIds(e)[0] });
  undo();
  t("selectGuide is not an undo step", guideIds(e).length === 0);
}

console.log("G-C guide selection:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "addGuide", axis: "x", at: 10 });
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50 });
  const id = guideIds(e)[0];

  e.dispatch({ type: "selectGuide", id });
  t("selectGuide selects", snapOf(e).selectedGuide === id);
  e.dispatch({ type: "select", ids: ["whatever"] });
  t("layer select clears the guide", snapOf(e).selectedGuide === null);
  e.dispatch({ type: "selectGuide", id: null });
  t("selectGuide null deselects", snapOf(e).selectedGuide === null);

  e.dispatch({ type: "selectGuide", id });
  e.dispatch({ type: "removeGuide", id });
  t("removing the selected guide clears selection", snapOf(e).selectedGuide === null);
}

console.log("G-D frame deletion cleans up its guides:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 400, h: 300 });
  const root = snapOf(e).pages[snapOf(e).page].root;
  const frame = root.children[root.children.length - 1];
  e.dispatch({ type: "addGuide", axis: "x", at: 10 });
  e.dispatch({ type: "addGuide", axis: "y", at: 10, frameId: frame.id });
  t("two guides before delete", guideIds(e).length === 2);
  e.dispatch({ type: "select", ids: [frame.id] });
  e.dispatch({ type: "delete" });
  const left = guidesOf(e);
  t("frame guide deleted with its frame", left.length === 1 && !left[0].frameId);
}

console.log("G-E snapping to guides:");
{
  // A guide exactly tied with a layer edge wins the tie.
  const box = { id: "m", x: 98, y: 0, w: 50, h: 50 };
  const layers = [{ id: "o", x: 200, y: 0, w: 50, h: 50 }];
  const r = snapMove(box, layers, 8, [{ axis: "x", at: 100 }]);
  t("move snaps an edge to a guide", r.dx === 2);

  // Corner 3 drags the right edge only. The layer edge and the guide sit
  // on the same x, so the winner shows in the redline span: a guide win
  // spans the box alone (0..40), a layer win would reach the layer (0..150).
  const tied = snapResize({ id: "m", x: 0, y: 0, w: 98, h: 40 }, 3, [{ id: "o", x: 100, y: 100, w: 50, h: 50 }], 8, [
    { axis: "x", at: 100 },
  ]);
  t("resize snaps to a guide", tied.dx === 2);
  t("guide wins the tie over a layer edge", tied.guides.length === 1 && tied.guides[0].from === 0 && tied.guides[0].to === 40);
}
