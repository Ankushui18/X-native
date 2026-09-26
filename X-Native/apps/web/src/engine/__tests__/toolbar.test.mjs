/**
 * Headless checks for §21: the context toolbar against the Figma toolbar and
 * boolean-operations evidence — default/switching tools, the engine side of
 * single-use vs sticky creation, and the boolean menu's guards (two supported
 * layers, frames refused, top/bottom paint inheritance).
 *
 * The dock chrome itself (group memory, flyouts, floating toolbar gating,
 * Done chords) is React-side and verified by code tracing; see the §21 ledger.
 *
 * Run with:  npx vite-node src/engine/__tests__/toolbar.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const rootOf = (e) => snapOf(e).pages[snapOf(e).page].root;
const N = (e, id) => find(rootOf(e), id);
const lastId = (e) => rootOf(e).children[rootOf(e).children.length - 1].id;
const add = (e, kind, x, y, w, h, extra = {}) => {
  e.dispatch({ type: "add", kind, x, y, w, h, extra });
  return lastId(e);
};
const booleans = (e) => {
  const out = [];
  const walk = (n) => { if (n.kind === "boolean") out.push(n); for (const c of n.children) walk(c); };
  walk(rootOf(e));
  return out;
};

console.log("TB tool lifecycle (default, switching, creation reset):");
{
  const e = new MemoryEngine(false);
  t("Move is the default tool", snapOf(e).tool === "select");
  e.dispatch({ type: "setTool", tool: "rect" });
  t("setTool arms the picked tool", snapOf(e).tool === "rect");
}
{
  // Text commits back to Move engine-side; shapes revert canvas-side after
  // the drag commits, so the engine keeps the armed tool here.
  const e = new MemoryEngine(false);
  e.dispatch({ type: "setTool", tool: "text" });
  add(e, "text", 0, 0, 100, 20);
  t("text creation returns to Move", snapOf(e).tool === "select");
  e.dispatch({ type: "setTool", tool: "rect" });
  add(e, "rect", 0, 0, 40, 40);
  t("shape creation keeps the armed tool engine-side", snapOf(e).tool === "rect");
}
{
  // Pen-family paths stay on the tool for the next path.
  const e = new MemoryEngine(false);
  e.dispatch({ type: "setTool", tool: "pen" });
  e.dispatch({ type: "addPath", points: [{ x: 0, y: 0 }, { x: 50, y: 50 }], closed: false });
  t("pen path keeps the pen armed", snapOf(e).tool === "pen");
}

console.log("TB boolean menu guards (two supported layers, frames refused):");
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 0, 0, 40, 40);
  e.dispatch({ type: "select", ids: [r] });
  e.dispatch({ type: "boolean", op: "union" });
  t("single layer refuses the boolean", booleans(e).length === 0 && N(e, r).kind === "rect");
}
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 200, 0, 100, 100);
  const r1 = add(e, "rect", 0, 0, 40, 40);
  const r2 = add(e, "rect", 30, 0, 40, 40);
  e.dispatch({ type: "select", ids: [f, r1, r2] });
  e.dispatch({ type: "boolean", op: "union" });
  const g = booleans(e)[0];
  t("frames sit out of the boolean", booleans(e).length === 1 && g.children.length === 2);
  t("sat-out frame stays top-level", rootOf(e).children.some((c) => c.id === f));
}
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 200, 0, 100, 100);
  const r = add(e, "rect", 0, 0, 40, 40);
  e.dispatch({ type: "select", ids: [f, r] });
  e.dispatch({ type: "boolean", op: "union" });
  t("frame plus one layer is too few", booleans(e).length === 0 && N(e, r).kind === "rect");
}

console.log("TB boolean paint inheritance (top wins, subtract takes bottom):");
{
  const e = new MemoryEngine(false);
  const bottom = add(e, "rect", 0, 0, 40, 40, { fill: "#ff0000" });
  const top = add(e, "rect", 30, 0, 40, 40, { fill: "#0000ff" });
  e.dispatch({ type: "select", ids: [bottom, top] });
  e.dispatch({ type: "boolean", op: "union" });
  t("union takes the top fill", booleans(e)[0].fill === "#0000ff");
}
{
  const e = new MemoryEngine(false);
  const bottom = add(e, "rect", 0, 0, 40, 40, { fill: "#ff0000" });
  const top = add(e, "rect", 30, 0, 40, 40, { fill: "#0000ff" });
  e.dispatch({ type: "select", ids: [bottom, top] });
  e.dispatch({ type: "boolean", op: "subtract" });
  t("subtract takes the bottom fill", booleans(e)[0].fill === "#ff0000");
}

console.log("TB group wraps a single layer (always-on Group button):");
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 0, 0, 40, 40);
  e.dispatch({ type: "select", ids: [r] });
  e.dispatch({ type: "group" });
  const g = N(e, snapOf(e).selection[0]);
  t("single layer groups", g.kind === "group" && g.children.length === 1 && g.children[0].id === r);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
