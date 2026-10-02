/**
 * Group layers and arrange z-order:
 *   ⌘G group, ⇧⌘G ungroup
 *   ⌘] bring forward, ⌘[ send backward
 *   ⌘⌥] bring to front, ⌘⌥[ send to back
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

function threeRects() {
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 50, 50);
  const b = node("rect", "b", 60, 0, 50, 50);
  const c = node("rect", "c", 120, 0, 50, 50);
  r.children.push(a, b, c);
  return { engine, a, b, c };
}

// 1. ⌘G groups selection.
{
  const { engine, a, b } = threeRects();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "group" });
  const r = engine.snapshot().pages[0].root;
  t("group creates a group parent", r.children.length === 2 && r.children.some(n => n.kind === "group" && n.children.length === 2));
}

// 2. ⇧⌘G ungroups.
{
  const { engine, a, b } = threeRects();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "group" });
  const g = engine.snapshot().pages[0].root.children.find(n => n.kind === "group");
  engine.dispatch({ type: "select", ids: [g.id] });
  engine.dispatch({ type: "ungroup" });
  const r = engine.snapshot().pages[0].root;
  t("ungroup flattens back", r.children.length === 3 && r.children.every(n => n.kind === "rect"));
}

// 3. Bring forward moves one step forward.
{
  const { engine, a, b, c } = threeRects();
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "arrange", dir: "forward" });
  const r = engine.snapshot().pages[0].root;
  t("bring forward: a moves between b and c", r.children.map(n=>n.id).join(",") === [b.id,a.id,c.id].join(","));
}

// 4. Send backward moves one step back.
{
  const { engine, a, b, c } = threeRects();
  engine.dispatch({ type: "select", ids: [c.id] });
  engine.dispatch({ type: "arrange", dir: "backward" });
  const r = engine.snapshot().pages[0].root;
  t("send backward: c moves between a and b", r.children.map(n=>n.id).join(",") === [a.id,c.id,b.id].join(","));
}

// 5. Bring to front.
{
  const { engine, a, b, c } = threeRects();
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "arrange", dir: "front" });
  const r = engine.snapshot().pages[0].root;
  t("bring to front: a goes to end", r.children[r.children.length-1].id === a.id);
}

// 6. Send to back.
{
  const { engine, a, b, c } = threeRects();
  engine.dispatch({ type: "select", ids: [c.id] });
  engine.dispatch({ type: "arrange", dir: "back" });
  const r = engine.snapshot().pages[0].root;
  t("send to back: c goes to start", r.children[0].id === c.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
