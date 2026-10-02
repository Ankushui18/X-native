/**
 * Figma ⌘A select-all: with a child selected, ⌘A selects all SIBLINGS
 * within that container (not the whole page). With nothing selected, ⌘A
 * selects all top-level layers on the current page. This locks in the
 * expected semantics — a regression here would make ⌘A always grab the
 * whole page even when the user is inside a group.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // Nothing selected: ⌘A selects all visible top-level layers on page.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  r.children.push(node("rect", "a", 0, 0, 50, 50));
  r.children.push(node("rect", "b", 60, 0, 50, 50));
  r.children.push(node("rect", "c", 120, 0, 50, 50));
  engine.dispatch({ type: "selectAll" });
  t("⌘A with no selection selects all top-level layers",
    engine.snapshot().selection.length === 3);
}

{
  // Child selected inside a group: ⌘A selects siblings, not whole page.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const g = node("group", "G", 0, 0, 200, 50);
  const a = node("rect", "a", 0, 0, 50, 50);
  const b = node("rect", "b", 60, 0, 50, 50);
  g.children.push(a, b);
  r.children.push(g);
  r.children.push(node("rect", "outside", 0, 100, 50, 50));
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "selectAll" });
  const sel = engine.snapshot().selection;
  t("⌘A with child selected selects siblings inside parent",
    sel.length === 2 && sel.includes(a.id) && sel.includes(b.id));
  t("outside layer not selected when ⌘A scoped to group",
    !sel.includes(r.children[1].id));
}

{
  // Locked/hidden siblings are excluded (per Figma).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 50, 50);
  const b = node("rect", "b", 60, 0, 50,50, { visible: false });
  const c = node("rect", "c", 120, 0, 50,50, { locked: true });
  r.children.push(a, b, c);
  engine.dispatch({ type: "selectAll" });
  t("⌘A excludes hidden and locked siblings",
    engine.snapshot().selection.length === 1 &&
    engine.snapshot().selection[0] === a.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
