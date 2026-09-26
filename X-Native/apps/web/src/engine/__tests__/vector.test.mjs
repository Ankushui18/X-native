/**
 * Headless checks for §15 (vectors / pen): in-place shape edit seeding,
 * curve-preserving point insertion, auto smooth handles, and point shifting.
 *
 * Run with:  npx vite-node src/engine/__tests__/vector.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import {
  insertPointOnPath,
  normalizeVectorNode,
  shapePoly,
  shiftPoints,
  smoothHandlesForPoint,
} from "../geometry.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

console.log("V-A curve-aware insertion:");
{
  // Straight segment: unchanged legacy behavior.
  const r = insertPointOnPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], 5, 1, false);
  t("straight insert index", r !== null && r.insertedIndex === 1);
  t("straight insert lands on chord", r !== null && near(r.newPath[1].x, 5) && near(r.newPath[1].y, 0));
  t("straight insert adds a bare corner", r !== null && r.newPath[1].ox === undefined);

  // Curved segment: cubic P0(0,0) C1(0,10) C2(10,10) P1(10,0), apex (5,7.5).
  const curve = [
    { x: 0, y: 0, ox: 0, oy: 10 },
    { x: 10, y: 0, ix: 0, iy: 10 },
  ];
  const c = insertPointOnPath(curve, 5, 7.5, false);
  t("curved insert found", c !== null);
  t("curved insert lands on the curve", c !== null && near(c.newPath[1].x, 5, 0.01) && near(c.newPath[1].y, 7.5, 0.01));
  t("curved insert carries handles", c !== null && (c.newPath[1].ox || 0) !== 0);
  // De Casteljau split preserves shape exactly: midpoint of the left half of
  // the new curve equals the original curve at t=0.25 (= (1.5625, 5.625)).
  if (c) {
    const q0 = c.newPath[0], m = c.newPath[1];
    const c1 = { x: q0.x + (q0.ox || 0), y: q0.y + (q0.oy || 0) };
    const c2 = { x: m.x + (m.ix || 0), y: m.y + (m.iy || 0) };
    const tt = 0.5, mt = 0.5;
    const x = mt ** 3 * q0.x + 3 * mt * mt * tt * c1.x + 3 * mt * tt * tt * c2.x + tt ** 3 * m.x;
    const y = mt ** 3 * q0.y + 3 * mt * mt * tt * c1.y + 3 * mt * tt * tt * c2.y + tt ** 3 * m.y;
    t("split preserves the arc (left half midpoint)", near(x, 1.5625, 1e-6) && near(y, 5.625, 1e-6));
  }
  t("far click inserts nothing", insertPointOnPath(curve, 5, 40, false) === null);
  // Closed wrap: insert on the closing edge appends at the end.
  const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }];
  const w = insertPointOnPath(tri, 2.4, 4.1, true);
  t("closing-edge insert appends", w !== null && w.newPath.length === 4 && w.insertedIndex === 3);
}

console.log("V-B smooth handles follow the path:");
{
  const h = smoothHandlesForPoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], 1, false);
  t("horizontal neighbours give horizontal handles", near(h.oy, 0) && h.ox > 0);
  t("length is a third of the shorter edge", near(h.ox, 10 / 3));
  t("handles are symmetric", near(h.ix, -h.ox) && near(h.iy, -h.oy));
  const v = smoothHandlesForPoint([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }], 1, false);
  t("vertical path gives vertical handles (not fixed +X)", near(v.ox, 0, 1e-9) && v.oy > 0);
  const end = smoothHandlesForPoint([{ x: 0, y: 0 }, { x: 9, y: 0 }], 0, false);
  t("open endpoint uses its single neighbour", near(end.ox, 3) && near(end.oy, 0));
}

console.log("V-C shiftPoints:");
{
  const out = shiftPoints([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 1 }], [0, 2], 2, -1);
  t("selected move", out[0].x === 2 && out[0].y === -1 && out[2].x === 11 && out[2].y === 0);
  t("unselected stay", out[1].x === 5 && out[1].y === 5);
}

console.log("V-D in-place shape edit (engine seeding):");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 60 });
  const root = e.snapshot().pages[e.snapshot().page].root;
  const id = root.children[root.children.length - 1].id;
  const before = find(e.snapshot().pages[e.snapshot().page].root, id);
  t("fresh rect carries no path", before !== null && before.path.length === 0);
  // Insert on the top edge midpoint seeds from the outline and converts.
  e.dispatch({ type: "insertPointOnPath", id, x: 50, y: 0 });
  const after = find(e.snapshot().pages[e.snapshot().page].root, id);
  t("insert seeds the outline", after !== null && after.path.length === 5);
  t("first edit converts kind", after !== null && after.kind === "vector");
  t("rect converts closed", after !== null && after.closed === true);
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 60 });
  const root = e.snapshot().pages[e.snapshot().page].root;
  const id = root.children[root.children.length - 1].id;
  e.dispatch({ type: "bendSegment", id, segIndex: 0, dragX: 50, dragY: -20 });
  const n = find(e.snapshot().pages[e.snapshot().page].root, id);
  t("bend seeds the outline", n !== null && n.path.length === 4);
  t("bend writes handles", n !== null && (n.path[0].ox || 0) !== 0);
  t("bend converts kind", n !== null && n.kind === "vector");
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "line", x: 0, y: 0, w: 100, h: 0 });
  const root = e.snapshot().pages[e.snapshot().page].root;
  const id = root.children[root.children.length - 1].id;
  e.dispatch({ type: "insertPointOnPath", id, x: 50, y: 0 });
  const n = find(e.snapshot().pages[e.snapshot().page].root, id);
  t("line converts open", n !== null && n.kind === "vector" && n.closed === false);
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 60 });
  const root = e.snapshot().pages[e.snapshot().page].root;
  const id = root.children[root.children.length - 1].id;
  e.dispatch({ type: "addVectorBranch", id, fromVertexIndex: 0, to: { x: 150, y: 30 } });
  const n = find(e.snapshot().pages[e.snapshot().page].root, id);
  t("branch seeds from the outline", n !== null && !!n.vectorNetwork && n.vectorNetwork.vertices.length >= 5);
  t("branch converts kind", n !== null && n.kind === "vector");
}
{
  // Entering and leaving vector edit without touching a point must not move
  // the node: normalize-on-exit is a no-op on a pathless shape.
  const n = { x: 0, y: 0, w: 100, h: 60, kind: "rect", closed: false, path: [] };
  normalizeVectorNode(n);
  t("exit is clean on untouched shapes", n.x === 0 && n.y === 0 && n.w === 100 && n.h === 60 && n.kind === "rect");
  const e2 = new MemoryEngine(false);
  e2.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 60 });
  const r2 = e2.snapshot().pages[e2.snapshot().page].root;
  const real = r2.children[r2.children.length - 1];
  t("shapePoly gives rect four corners", shapePoly(real).length === 4);
}
