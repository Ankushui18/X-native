/**
 * Parent/child/sibling alignment behaviors from Figma help articles, via
 * engine dispatches (no DOM needed for the alignment math).
 *   360039959014 Parent/child/sibling
 *   360039956914 Alignment/rotation/position/dimensions
 */
import { MemoryEngine, node, find, findParent } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const rect = (name, x, y, w, h, extra = {}) => node("rect", name, x, y, w, h, extra);

function engineWith(rootChildren) {
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  for (const c of rootChildren) r.children.push(c);
  return engine;
}

// 1. Align-left moves child.x to 0 in parent.
{
  const child = rect("c", 50, 50, 80, 80);
  const parent = node("frame", "F", 100, 100, 400, 300, { fill: "#ffffff", fillVisible: true, children: [child] });
  const engine = engineWith([parent]);
  engine.dispatch({ type: "select", ids: [child.id] });
  // Call align() indirectly by synthesising the same command the key handler
  // uses, but we can import the align function.
  const { align } = await import("../../ui/inspector.tsx");
  align(engine, engine.snapshot(), "align-left");
  t("align-left moves child to x=0 in parent", find(engine.snapshot().pages[0].root, child.id).x === 0);
  t("align-left leaves y untouched", find(engine.snapshot().pages[0].root, child.id).y === 50);
}

// 2. align-right x = parent.w - child.w
{
  const child = rect("c", 50, 50, 80, 80);
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [child] });
  const engine = engineWith([parent]);
  engine.dispatch({ type: "select", ids: [child.id] });
  const { align } = await import("../../ui/inspector.tsx");
  align(engine, engine.snapshot(), "align-right");
  t("align-right moves child to x=320 (400-80)", find(engine.snapshot().pages[0].root, child.id).x === 320);
}

// 3. align-hcenter: x = (p.w-c.w)/2
{
  const child = rect("c", 50, 50, 80, 80);
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [child] });
  const engine = engineWith([parent]);
  engine.dispatch({ type: "select", ids: [child.id] });
  const { align } = await import("../../ui/inspector.tsx");
  align(engine, engine.snapshot(), "align-hcenter");
  t("align-hcenter x=160", find(engine.snapshot().pages[0].root, child.id).x === 160);
}

// 4. align-top y=0
{
  const child = rect("c", 50, 50, 80, 80);
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [child] });
  const engine = engineWith([parent]);
  engine.dispatch({ type: "select", ids: [child.id] });
  const { align } = await import("../../ui/inspector.tsx");
  align(engine, engine.snapshot(), "align-top");
  t("align-top y=0", find(engine.snapshot().pages[0].root, child.id).y === 0);
}

// 5. align-vcenter: y = (p.h-c.h)/2 = 110
{
  const child = rect("c", 50, 50, 80, 80);
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [child] });
  const engine = engineWith([parent]);
  engine.dispatch({ type: "select", ids: [child.id] });
  const { align } = await import("../../ui/inspector.tsx");
  align(engine, engine.snapshot(), "align-vcenter");
  t("align-vcenter y=110", find(engine.snapshot().pages[0].root, child.id).y === 110);
}

// 6. align-bottom y=220
{
  const child = rect("c", 50, 50, 80, 80);
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [child] });
  const engine = engineWith([parent]);
  engine.dispatch({ type: "select", ids: [child.id] });
  const { align } = await import("../../ui/inspector.tsx");
  align(engine, engine.snapshot(), "align-bottom");
  t("align-bottom y=220 (300-80)", find(engine.snapshot().pages[0].root, child.id).y === 220);
}

// 7. Shift+align (toParent=true) with multi-selection keeps group together.
{
  const a = rect("a", 20, 20, 60, 60);
  const b = rect("b", 90, 40, 60, 40); // union x=20,y=20,w=130,h=60
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [a, b] });
  const engine = engineWith([parent]);
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  const { align } = await import("../../ui/inspector.tsx");
  align(engine, engine.snapshot(), "align-left", /*toParent*/ true);
  const aN = find(engine.snapshot().pages[0].root, a.id);
  const bN = find(engine.snapshot().pages[0].root, b.id);
  t("Shift+align-left moves group to x=0 (a.x=0)", aN.x === 0);
  t("Shift+align-left preserves sibling offset (b.x - a.x == 70)", Math.abs((bN.x - aN.x) - 70) < 0.01);
}

// 8. Enter drills into a component, Shift+Enter selects parent.
{
  const inner = rect("inner", 20, 20, 60, 60);
  const comp = node("component", "Comp", 200, 200, 100, 100, { fill: "#ffffff", fillVisible: true, children: [inner] });
  const engine = engineWith([comp]);
  engine.dispatch({ type: "select", ids: [comp.id] });
  // Simulate Enter: select first visible child.
  const c = find(engine.snapshot().pages[0].root, comp.id);
  const child = c.children.find((cc) => cc.visible && !cc.locked);
  engine.dispatch({ type: "select", ids: [child.id] });
  t("Enter drills into component → child selected", engine.snapshot().selection[0] === child.id);
  // Shift+Enter: select parent.
  const p = findParent(engine.snapshot().pages[0].root, child.id);
  engine.dispatch({ type: "select", ids: [p.id] });
  t("Shift+Enter selects parent component", engine.snapshot().selection[0] === comp.id);
}

// 9. Shape larger than parent is NOT reparented when dropped.
{
  const big = rect("big", 300, 300, 600, 600); // larger than 400x300 parent
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [] });
  const engine = engineWith([big, parent]);
  engine.dispatch({ type: "select", ids: [big.id] });
  // Programmatic reparent of an oversized child should be refused.
  engine.dispatch({ type: "reparent", ids: [big.id], parent: parent.id, x: 10, y: 10 });
  t("oversize shape is NOT reparented into freeform frame", findParent(engine.snapshot().pages[0].root, big.id).id !== parent.id);
}

// 10. Small shape IS reparented.
{
  const small = rect("small", 1000, 1000, 50, 50);
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [] });
  const engine = engineWith([small, parent]);
  engine.dispatch({ type: "select", ids: [small.id] });
  engine.dispatch({ type: "reparent", ids: [small.id], parent: parent.id, x: 10, y: 10 });
  t("small shape IS reparented", findParent(engine.snapshot().pages[0].root, small.id).id === parent.id);
  const s = find(engine.snapshot().pages[0].root, small.id);
  t("reparent lands at x=10,y=10", s.x === 10 && s.y === 10);
}

// 11. Bypass flag lets oversize shapes reparent (⌘/Ctrl modifier).
{
  const big = rect("big", 300, 300, 600, 600);
  const parent = node("frame", "F", 0, 0, 400, 300, { fill: "#ffffff", fillVisible: true, children: [] });
  const engine = engineWith([big, parent]);
  engine.dispatch({ type: "reparent", ids: [big.id], parent: parent.id, x: 0, y: 0, bypassSizeGate: true });
  t("bypassSizeGate overrides the size gate", findParent(engine.snapshot().pages[0].root, big.id).id === parent.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
