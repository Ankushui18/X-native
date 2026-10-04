/**
 * Editor commands on top of the exact geometry: Offset path, Outline stroke,
 * Boolean + Flatten. Numbers are what Figma's behavior means geometrically.
 * Run: vite-node src/engine/__tests__/exactCommands.test.mjs
 */
import { MemoryEngine, node } from "../memory.ts";

let pass = 0, fail = 0;
const t = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${n}${!ok && extra ? " - " + extra : ""}`); };
process.on("exit", () => { console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`); if (fail) process.exitCode = 1; });

const near = (a, b, e = 0.05) => Math.abs(a - b) <= e;
const setup = (...ns) => { const e = new MemoryEngine(false); const r = e.snapshot().pages[0].root; r.children = []; ns.forEach((n) => r.children.push(n)); return { e, r }; };
const frame = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h });

console.log("Offset path");
for (const join of ["miter", "round", "bevel"]) {
  const a = node("rect", "a", 100, 100, 100, 100, { fill: "#f00" });
  const { e, r } = setup(a);
  e.dispatch({ type: "select", ids: [a.id] });
  e.dispatch({ type: "offsetPath", distance: 10, join });
  const f = frame(r.children[0]);
  t(`rect +10 ${join}: frame grows to 90,90 120x120`, near(f.x, 90) && near(f.y, 90) && near(f.w, 120) && near(f.h, 120), JSON.stringify(f));
}
{
  const a = node("rect", "a", 100, 100, 100, 100, { fill: "#f00" });
  const { e, r } = setup(a);
  e.dispatch({ type: "select", ids: [a.id] });
  e.dispatch({ type: "offsetPath", distance: -10, join: "miter" });
  const f = frame(r.children[0]);
  t("rect -10: frame shrinks to 110,110 80x80", near(f.x, 110) && near(f.y, 110) && near(f.w, 80) && near(f.h, 80), JSON.stringify(f));
  e.dispatch({ type: "undo" });
  const back = e.snapshot().pages[0].root.children[0];   // undo swaps the state; re-read it
  t("undo restores the original rect", back.kind === "rect" && near(back.w, 100));
}
{
  const a = node("ellipse", "c", 0, 0, 100, 100, { fill: "#f00" });
  const { e, r } = setup(a);
  e.dispatch({ type: "select", ids: [a.id] });
  e.dispatch({ type: "offsetPath", distance: 10, join: "round" });
  const f = frame(r.children[0]);
  t("circle r50 +10: 120x120 at -10,-10", near(f.x, -10, 0.1) && near(f.w, 120, 0.1), JSON.stringify(f));
}
{
  const a = node("rect", "a", 0, 0, 200, 200, { fill: "#f00" });
  const b = node("rect", "b", 50, 50, 100, 100, { fill: "#0f0" });
  const { e, r } = setup(a, b);
  e.dispatch({ type: "select", ids: [a.id, b.id] });
  e.dispatch({ type: "boolean", op: "subtract" });
  e.dispatch({ type: "select", ids: [r.children[0].id] });
  e.dispatch({ type: "flatten" });
  const donut = r.children[0];
  t("flatten of subtract: exact 200x200 frame", donut.w === 200 && donut.h === 200, JSON.stringify(frame(donut)));
  t("flatten of subtract: 2 loops (outer + hole)", donut.vectorNetwork.regions[0].loops.length === 2);
  e.dispatch({ type: "select", ids: [donut.id] });
  e.dispatch({ type: "offsetPath", distance: 10, join: "miter" });
  const grown = r.children[0];
  t("donut +10: frame 220x220 (offset no longer a silent no-op)", near(grown.w, 220) && near(grown.h, 220), JSON.stringify(frame(grown)));
  t("donut +10: still a ring (hole kept)", grown.vectorNetwork.regions[0].loops.length === 2);
  const holeVerts = grown.vectorNetwork.regions[0].loops.map((l) => l.map((i) => grown.vectorNetwork.vertices[i]));
  const spans = holeVerts.map((vs) => Math.max(...vs.map((v) => v.x)) - Math.min(...vs.map((v) => v.x))).sort((p, q) => p - q);
  t("donut +10: hole shrinks 100 -> 80", near(spans[0], 80) && near(spans[1], 220), JSON.stringify(spans));
}
{
  const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 100 }, { x: 0, y: 100 }];
  const a = node("vector", "L", 0, 0, 100, 100, { fill: "#000" });
  a.path = L; a.closed = true;
  const { e, r } = setup(a);
  e.dispatch({ type: "select", ids: [a.id] });
  e.dispatch({ type: "offsetPath", distance: -15, join: "miter" });
  t("L-shape inset past its arm width leaves the layer unchanged, not inside-out", r.children[0].path.length === 6 && near(r.children[0].w, 100));
}

console.log("Outline stroke");
for (const [align, lo, size] of [["inside", 0, 100], ["center", -5, 110], ["outside", -10, 120]]) {
  const a = node("rect", "r", 0, 0, 100, 100, { fill: "#f00" });
  a.strokeWidth = 10; a.strokePaint = "#00f"; a.strokeVisible = true; a.strokeAlign = align; a.strokeJoin = "miter";
  const { e, r } = setup(a);
  e.dispatch({ type: "select", ids: [a.id] });
  e.dispatch({ type: "outlineStroke" });
  const o = r.children[0], f = frame(o);
  t(`rect stroke 10 ${align}: frame ${lo},${lo} ${size}x${size}`, near(f.x, lo) && near(f.y, lo) && near(f.w, size) && near(f.h, size), JSON.stringify(f));
  t(`  ${align}: is a ring with the stroke colour as fill`, o.kind === "vector" && o.fill === "#00f" && o.vectorNetwork.regions[0].loops.length === 2 && o.strokeWidth === 0);
}
{
  const a = node("line", "ln", 0, 0, 100, 0, {});
  a.strokeWidth = 10; a.strokePaint = "#00f"; a.strokeVisible = true;
  for (const [cap, lo, w] of [["none", 0, 100], ["square", -5, 110], ["round", -5, 110]]) {
    const b = JSON.parse(JSON.stringify(a)); b.strokeCap = cap;
    const { e, r } = setup(b);
    e.dispatch({ type: "select", ids: [b.id] });
    e.dispatch({ type: "outlineStroke" });
    const f = frame(r.children[0]);
    t(`open line stroke 10, ${cap} caps: x ${lo}, width ${w}, height 10`, near(f.x, lo, 0.1) && near(f.w, w, 0.1) && near(f.h, 10, 0.1), JSON.stringify(f));
  }
}
{
  const a = node("vector", "Y", 0, 0, 100, 100, { fill: "none" });
  a.vectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }, { x: 50, y: 100 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 1, end: 3 }], regions: [] };
  a.path = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }]; a.closed = false;
  a.strokeWidth = 4; a.strokePaint = "#000"; a.strokeVisible = true; a.strokeCap = "none";
  const { e, r } = setup(a);
  e.dispatch({ type: "select", ids: [a.id] });
  e.dispatch({ type: "outlineStroke" });
  t("branched network: outline reaches the branch off the path walk (height >= 100)", r.children[0].h >= 100, JSON.stringify(frame(r.children[0])));
}
{
  const a = node("rect", "r", 100, 100, 100, 100, { fill: "#f00" });
  a.strokeWidth = 10; a.strokePaint = "#00f"; a.strokeVisible = true; a.strokeAlign = "outside"; a.rotation = 45;
  const { e, r } = setup(a);
  e.dispatch({ type: "select", ids: [a.id] });
  const c0 = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  e.dispatch({ type: "outlineStroke" });
  const o = r.children[0];
  t("rotated node: outlined frame keeps the same centre (no drift)", near(o.x + o.w / 2, c0.x, 0.3) && near(o.y + o.h / 2, c0.y, 0.3), `${o.x + o.w / 2},${o.y + o.h / 2} vs ${c0.x},${c0.y}`);
}

console.log("Boolean + Flatten");
{
  const a = node("rect", "a", 0, 0, 100, 100, { fill: "#f00" });
  const b = node("rect", "b", 50, 50, 100, 100, { fill: "#0f0" });
  const { e, r } = setup(a, b);
  e.dispatch({ type: "select", ids: [a.id, b.id] });
  e.dispatch({ type: "boolean", op: "union" });
  e.dispatch({ type: "select", ids: [r.children[0].id] });
  e.dispatch({ type: "flatten" });
  const f = r.children[0];
  t("union flatten: exact 150x150 with 8 corners", f.w === 150 && f.h === 150 && f.vectorNetwork.vertices.length === 8, JSON.stringify(frame(f)));
}
