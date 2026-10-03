/**
 * Nudge (arrow keys) and Duplicate (⌘D): arrow-key nudge dispatches
 * {type:"nudge", dx, dy} which moves free layers by that delta and
 * reorders inside auto-layout; ⌘D duplicates selected layers in place
 * (or offset by the smart-duplicate cascade delta).
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // Arrow nudge: default small nudge = 1px; shift = 10px.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 100, 100, 50, 50);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "nudge", dx: 1, dy: 0 });
  const n1 = find(r, rect.id);
  t("→ nudges right 1px (small nudge)", n1.x === 101 && n1.y === 100);
  engine.dispatch({ type: "nudge", dx: 0, dy: 1 });
  const n2 = find(r, rect.id);
  t("↓ nudges down 1px", n2.y === 101);
  engine.dispatch({ type: "nudge", dx: -10, dy: 0 });
  const n3 = find(r, rect.id);
  t("⇧← big nudge moves 10px left", n3.x === 91);
}

{
  // ⌘D duplicates a selected layer.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 100, 100, 50, 50);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "duplicate" });
  t("⌘D creates an extra layer", r.children.length === 2);
  const newOne = r.children.find((c) => c.id !== rect.id);
  t("duplicate is placed in place (same x,y on first ⌘D)",
    newOne.x === 100 && newOne.y === 100);
  t("duplicate is a different id", newOne.id !== rect.id);
  t("duplicate has same dimensions", newOne.w === 50 && newOne.h === 50);
}

{
  // Smart duplicate with explicit dx/dy offset.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 100, 100, 50, 50);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "duplicate", dx: 60, dy: 0 });
  const newOne = r.children.find((c) => c.id !== rect.id);
  t("duplicate with dx=60 places copy to the right",
    newOne.x === 160 && newOne.y === 100);
}

{
  // Nudge inside an auto-layout frame reorders children (⌘/Ctrl deep
  // select + arrow keys).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const f = node("frame", "F", 0, 0, 300, 100, {
    layout: { direction: "horizontal", gap: 8, padding: [8,8,8,8], sizing: "hug", cross: "hug", wrap: false, align: "min", justify: "min" },
  });
  const a = node("rect", "a", 0, 0, 50, 50);
  const b = node("rect", "b", 0, 0, 50, 50);
  f.children.push(a, b);
  r.children.push(f);
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "nudge", dx: 1, dy: 0 });
  t("nudge → inside auto-layout reorders child to next slot",
    f.children[0].id === b.id && f.children[1].id === a.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
