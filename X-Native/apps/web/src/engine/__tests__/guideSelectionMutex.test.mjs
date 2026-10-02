/**
 * Ruler guide ↔ layer selection mutual exclusion (bug #16): selecting a
 * ruler guide must clear the layer selection so ⌫ deletes the guide, not
 * the layer. Previously selectGuide left s.selection intact, causing ⌫
 * to delete the still-selected layer instead of the guide the user
 * clicked.
 */
import { MemoryEngine, node } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 100, 100);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  t("layer is selected", engine.snapshot().selection.length === 1);

  // Select a guide (simulates clicking a ruler on the canvas).
  engine.dispatch({ type: "addGuide", axis: "v", at: 200 });
  const gid = engine.snapshot().pages[0].guides[0].id;
  engine.dispatch({ type: "selectGuide", id: gid });
  t("guide is selected", engine.snapshot().selectedGuide === gid);
  t("layer selection is cleared when a guide is selected",
    engine.snapshot().selection.length === 0);
}

{
  // Selecting a layer in turn clears the selected guide.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  engine.dispatch({ type: "addGuide", axis: "h", at: 100 });
  const gid = engine.snapshot().pages[0].guides[0].id;
  engine.dispatch({ type: "selectGuide", id: gid });
  const rect = node("rect", "R", 0, 0, 100, 100);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  t("selecting a layer clears selectedGuide", engine.snapshot().selectedGuide === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
