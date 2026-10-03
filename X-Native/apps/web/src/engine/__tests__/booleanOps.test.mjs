/**
 * Boolean operations (Figma help 360039957534):
 *   Union, Subtract, Intersect, Exclude via ⌥⇧U/S/I/E and the Arrange menu.
 *   Result is a boolean group named for the op; Enter drills into it;
 *   children are still editable.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

function setup() {
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 100, 100, { fill: "#f00" });
  const b = node("rect", "b", 50, 50, 100, 100, { fill: "#0f0" });
  r.children.push(a, b);
  return { engine, a, b };
}

// 1. Union wraps both rects in a boolean group.
{
  const { engine, a, b } = setup();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "boolean", op: "union" });
  const r = engine.snapshot().pages[0].root;
  const g = r.children.find((n) => n.name === "Union");
  t("union creates a 'Union' boolean group", !!g && g.booleanOp === "union");
  t("union contains both children", g && g.children.length === 2);
}

// 2. Subtract.
{
  const { engine, a, b } = setup();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "boolean", op: "subtract" });
  const r = engine.snapshot().pages[0].root;
  const g = r.children.find((n) => n.name === "Subtract");
  t("subtract creates a 'Subtract' boolean group", !!g && g.booleanOp === "subtract");
}

// 3. Intersect.
{
  const { engine, a, b } = setup();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "boolean", op: "intersect" });
  const r = engine.snapshot().pages[0].root;
  const g = r.children.find((n) => n.name === "Intersect");
  t("intersect creates an 'Intersect' boolean group", !!g && g.booleanOp === "intersect");
}

// 4. Exclude (⌥⇧E per article).
{
  const { engine, a, b } = setup();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "boolean", op: "exclude" });
  const r = engine.snapshot().pages[0].root;
  const g = r.children.find((n) => n.name === "Exclude");
  t("exclude creates an 'Exclude' boolean group", !!g && g.booleanOp === "exclude");
}

// 5. Single-layer selection does not create a boolean group.
{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 100, 100);
  r.children.push(a);
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "boolean", op: "union" });
  t("single selection stays a rect (no boolean wrap)", r.children.length === 1 && r.children[0].kind === "rect");
}

// 6. Enter drills into a boolean group (child visibility).
{
  const { engine, a, b } = setup();
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({ type: "boolean", op: "union" });
  const r = engine.snapshot().pages[0].root;
  const g = r.children.find((n) => n.booleanOp === "union");
  t("boolean group children are visible/editable",
    !!g && g.children.every((c) => c.visible !== false && !c.locked));
}

console.log(`\n${pass} passed, ${fail} failed`);
