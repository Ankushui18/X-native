/**
 * Lock/unlock & hide/show layers parity.
 * Figma help 360041596573 (lock): ⌘⇧L toggles lock on selection.
 * Figma help toggle visibility: ⌘⇧H toggles visibility on selection.
 * Locked layer cannot be moved or edited on canvas (isEffectivelyLocked check).
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

function make() {
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 50, 50);
  const b = node("rect", "b", 60, 0, 50, 50);
  r.children.push(a, b);
  return { engine, a, b };
}

// 1. lockSel toggles locked.
{
  const { engine, a, b } = make();
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "lockSel" });
  t("lockSel locks the layer", find(engine.snapshot().pages[0].root, a.id).locked === true);
  engine.dispatch({ type: "lockSel" });
  t("lockSel toggles off", find(engine.snapshot().pages[0].root, a.id).locked === false);
}

// 2. hideSel toggles visibility.
{
  const { engine, a } = make();
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "hideSel" });
  t("hideSel hides the layer", find(engine.snapshot().pages[0].root, a.id).visible === false);
  engine.dispatch({ type: "hideSel" });
  t("hideSel toggles back on", find(engine.snapshot().pages[0].root, a.id).visible !== false);
}

// 3. Locked layer refuses moves via engine dispatch.
{
  const { engine, a } = make();
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "lockSel" });
  const snap = engine.snapshot();
  t("a is locked", find(snap.pages[0].root, a.id).locked);
  // A locked layer should be filtered out of move dispatches.
  engine.dispatch({ type: "move", ids: [a.id], dx: 100, dy: 0 });
  const n = find(engine.snapshot().pages[0].root, a.id);
  t("locked layer did not move", n.x === 0);
}

// 4. Multi-select lock applies to all.
{
  const { engine, a, b } = make();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "lockSel" });
  t("multi-select: a locked", find(engine.snapshot().pages[0].root, a.id).locked);
  t("multi-select: b locked", find(engine.snapshot().pages[0].root, b.id).locked);
}

console.log(`\n${pass} passed, ${fail} failed`);
