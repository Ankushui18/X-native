/**
 * Headless checks for §16 (layers / structure): lock inheritance, ungroup
 * breadth + rotation, cross-parent grouping, and page moves.
 *
 * Run with:  npx vite-node src/engine/__tests__/layers.test.mjs
 */
import { MemoryEngine, find, hitTest, isEffectivelyLocked } from "../memory.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const lastId = (e) => { const r = rootOf(e); return r.children[r.children.length - 1].id; };

console.log("L-A lock inheritance:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 100, h: 100 });
  const f = lastId(e);
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 20, h: 20, parent: f });
  const r = rootOf(e);
  const kid = find(r, f).children[0].id;
  t("unlocked by default", !isEffectivelyLocked(rootOf(e), kid));
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "lockSel" });
  t("parent lock covers the child", isEffectivelyLocked(rootOf(e), kid));
  t("canvas skips the inherited-locked child", hitTest(rootOf(e), 20, 20) === null);
  t("includeLocked still reaches it", hitTest(rootOf(e), 20, 20, { includeLocked: true })?.id === kid);
  e.dispatch({ type: "select", ids: [kid] });
  e.dispatch({ type: "delete" });
  t("delete refuses inherited-locked", !!find(rootOf(e), kid));
  const before = rootOf(e).children.length;
  e.dispatch({ type: "duplicate" });
  t("duplicate refuses inherited-locked", rootOf(e).children.length === before);
  const kx = find(rootOf(e), kid).x;
  e.dispatch({ type: "nudge", dx: 5, dy: 0 });
  t("nudge refuses inherited-locked", find(rootOf(e), kid).x === kx);
  e.dispatch({ type: "add", kind: "rect", x: 200, y: 200, w: 10, h: 10 });
  const outsider = lastId(e);
  const kidsBefore = find(rootOf(e), f).children.length;
  e.dispatch({ type: "reorder", ids: [outsider], parent: f, index: 99 });
  t("locked container takes no new children", find(rootOf(e), f).children.length === kidsBefore);
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "lockSel" });
  t("unlocking the parent frees the child", !isEffectivelyLocked(rootOf(e), kid));
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const a = lastId(e);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const b = lastId(e);
  e.dispatch({ type: "select", ids: [a] });
  e.dispatch({ type: "lockSel" });
  e.dispatch({ type: "select", ids: [a] });
  e.dispatch({ type: "arrange", dir: "front" });
  const order = rootOf(e).children.map((c) => c.id);
  t("arrange skips locked layers", order[order.length - 1] === b);
}

console.log("L-B ungroup breadth + rotation:");
{
  const e = new MemoryEngine(false);
  const seedN = rootOf(e).children.length;
  const mine = [];
  for (let i = 0; i < 4; i++) {
    e.dispatch({ type: "add", kind: "rect", x: i * 20, y: 0, w: 10, h: 10 });
    mine.push(lastId(e));
  }
  const all = mine;
  e.dispatch({ type: "select", ids: [all[0], all[1]] });
  e.dispatch({ type: "group" });
  const g1 = e.snapshot().selection[0];
  e.dispatch({ type: "select", ids: [all[2], all[3]] });
  e.dispatch({ type: "group" });
  const g2 = e.snapshot().selection[0];
  e.dispatch({ type: "select", ids: [g1, g2] });
  e.dispatch({ type: "ungroup" });
  t("multi-ungroup unwraps every group", rootOf(e).children.length === seedN + 4);
  t("multi-ungroup selects all kids", e.snapshot().selection.length === 4);
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const q0 = lastId(e);
  e.dispatch({ type: "add", kind: "rect", x: 20, y: 0, w: 10, h: 10 });
  const q1 = lastId(e);
  const all = [q0, q1];
  e.dispatch({ type: "select", ids: [q0, q1] });
  e.dispatch({ type: "group" });
  const g = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: g, patch: { locked: true } });
  e.dispatch({ type: "select", ids: [g] });
  e.dispatch({ type: "ungroup" });
  t("locked group refuses ungroup", !!find(rootOf(e), g) && find(rootOf(e), g).children.length === 2);
}
{
  // 100x100 group rotated 90° about its center; kid center (5,5) lands on (95,5).
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const kid = lastId(e);
  e.dispatch({ type: "select", ids: [kid] });
  e.dispatch({ type: "group" });
  const g = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: g, patch: { x: 0, y: 0, w: 100, h: 100, rotation: 90 } });
  e.dispatch({ type: "select", ids: [g] });
  e.dispatch({ type: "ungroup" });
  const k = find(rootOf(e), e.snapshot().selection[0]);
  t("rotated ungroup keeps the world center", k !== null && near(k.x + k.w / 2, 95, 1e-4) && near(k.y + k.h / 2, 5, 1e-4));
  t("rotated ungroup inherits rotation", k !== null && near(k.rotation ?? 0, 90));
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 7, y: 3, w: 10, h: 10 });
  const k = lastId(e);
  e.dispatch({ type: "select", ids: [k] });
  e.dispatch({ type: "group" });
  const g = e.snapshot().selection[0];
  e.dispatch({ type: "select", ids: [g] });
  e.dispatch({ type: "ungroup" });
  const back = find(rootOf(e), e.snapshot().selection[0]);
  t("plain ungroup keeps positions", back !== null && back.x === 7 && back.y === 3);
}

console.log("L-C cross-parent grouping:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 50, y: 50, w: 200, h: 200 });
  const f = lastId(e);
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 20, h: 20, parent: f });
  const inner = find(rootOf(e), f).children[0].id;
  e.dispatch({ type: "add", kind: "rect", x: 300, y: 300, w: 20, h: 20 });
  const outer = lastId(e);
  e.dispatch({ type: "select", ids: [inner, outer] });
  e.dispatch({ type: "group" });
  const g = e.snapshot().selection[0];
  const gn = find(rootOf(e), g);
  t("cross-parent group forms", gn !== null && gn.children.length === 2);
  // Group lands in the first selection's parent (the frame at 50,50), so its
  // local origin is 10 and the kids sit at local 0 and 240: worlds 60/300.
  const kids = [...gn.children].sort((a, b) => a.x - b.x);
  t("group preserves world geometry", gn !== null && gn.x === 10 && gn.y === 10 && kids[0].x === 0 && kids[1].x === 240);
  const fc = find(rootOf(e), f).children;
  t("frame keeps no orphans", fc.length === 1 && fc[0].id === g);
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 100, h: 100 });
  const f = lastId(e);
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 20, h: 20, parent: f });
  const kid = find(rootOf(e), f).children[0].id;
  const before = rootOf(e).children.length;
  e.dispatch({ type: "select", ids: [f, kid] });
  e.dispatch({ type: "group" });
  t("ancestor pair stays a no-op", rootOf(e).children.length === before);
}

console.log("L-D page moves:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "addPage" });
  e.dispatch({ type: "addPage" });
  const names = () => e.snapshot().pages.map((p) => p.name);
  const start = names();
  t("three pages", start.length === 3);
  e.dispatch({ type: "setPage", index: 0 });
  e.dispatch({ type: "movePage", from: 0, to: 2 });
  const after = names();
  t("page moves", after[2] === start[0]);
  t("current page follows", e.snapshot().page === 2);
  e.dispatch({ type: "movePage", from: 9, to: 0 });
  t("bad indices no-op", names().join("|") === after.join("|"));
}
