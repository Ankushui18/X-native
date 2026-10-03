/**
 * This test doesn't exercise the Canvas drag-end code (that lives in React,
 * not the engine). It exists to document bug #17: in X-Native, a bare click
 * (no drag) with a shape tool active used to stamp a 100x100 shape onto the
 * canvas. In Figma shape tools require a drag; a click either selects the
 * layer under the cursor or deselects, and the tool reverts to Move.
 *
 * The engine contract this locks down: add() must be called explicitly by
 * the drag-end handler with the drag's x/y/w/h. A click with no drag must
 * NOT call add().
 */
import { MemoryEngine, node } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  const before = r.children.length;
  // Simulate a click (not a drag) by issuing select + setTool select, which
  // is what the fixed Canvas handler does on a shape-tool click.
  engine.dispatch({ type: "setTool", tool: "rect" });
  engine.dispatch({ type: "setTool", tool: "select" });
  engine.dispatch({ type: "select", ids: [] });
  t("no new node created when shape-tool click reverts to select",
    r.children.length === before);
}

{
  // Dragging (explicit add) still works.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  const before = r.children.length;
  engine.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  t("drag-create still adds one rect", r.children.length === before + 1);
}

{
  // Click with text tool still creates a text layer (Canvas sets w/h=24 on
  // click for text specifically).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  const before = r.children.length;
  engine.dispatch({ type: "add", kind: "text", x: 50, y: 50, w: 24, h: 24, extra: { text: "", sizingW: "hug", sizingH: "hug" } });
  t("text click still creates a text layer", r.children.length === before + 1);
  t("text layer is kind 'text'", r.children[r.children.length - 1].kind === "text");
}

console.log(`\n${pass} passed, ${fail} failed`);
