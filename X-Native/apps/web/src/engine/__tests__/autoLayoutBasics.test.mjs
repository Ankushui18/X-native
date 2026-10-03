/**
 * Auto layout basics (Figma ⇧A shortcut): wrapping selection in an
 * auto-layout frame via wrapAutoLayout; applying autoLayout to a
 * single existing frame; stripping layout with {layout: null}.
 *
 * Existing autolayout (52) and autoLayoutEdgeCases (72) suites cover
 * detailed wrap/reflow/resize; this test locks in the basic wrap/remove
 * contracts exercised by ⇧A / ⌥⇧A.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // wrapAutoLayout wraps two selected layers in a single auto-layout frame.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 100, 40);
  const b = node("rect", "b", 110, 0, 100, 40);
  r.children.push(a, b);
  engine.dispatch({ type: "select", ids: [a.id, b.id] });
  engine.dispatch({
    type: "wrapAutoLayout",
    ids: [a.id, b.id],
    layout: { direction: "horizontal", gap: 8, padding: [8, 8, 8, 8], sizing: "hug", cross: "hug", wrap: false, align: "min", justify: "min" },
  });
  t("wrapAutoLayout replaces selection with one frame", r.children.length === 1);
  const wrapper = r.children[0];
  t("wrapper is a frame with horizontal autoLayout",
    wrapper.kind === "frame" && wrapper.layout && wrapper.layout.direction === "horizontal");
  t("wrapper has both children", wrapper.children.length === 2);
  t("children ids are the original two",
    wrapper.children.some(c => c.id === a.id) && wrapper.children.some(c => c.id === b.id));
  t("default gap is 8", wrapper.layout.gap === 8);
  t("default padding is 8 on all sides", JSON.stringify(wrapper.layout.padding) === "[8,8,8,8]");
}

{
  // Applying auto layout directly to a frame (single selection case).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const f = node("frame", "F", 0, 0, 200, 100);
  r.children.push(f);
  engine.dispatch({ type: "select", ids: [f.id] });
  engine.dispatch({
    type: "autoLayout",
    id: f.id,
    layout: { direction: "vertical", gap: 10, padding: [10, 10, 10, 10], sizing: "hug", cross: "hug", wrap: false, align: "min", justify: "min" },
  });
  const f2 = find(r, f.id);
  t("autoLayout applies to a single frame", f2.layout && f2.layout.direction === "vertical");
}

{
  // Removing auto layout with layout:null.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const f = node("frame", "F", 0, 0, 200, 100);
  r.children.push(f);
  const c = node("rect", "c", 0, 0, 100, 40);
  f.children.push(c);
  engine.dispatch({ type: "autoLayout", id: f.id, layout: {
    direction: "horizontal", gap: 8, padding: [8,8,8,8], sizing: "hug", cross: "hug", wrap: false, align: "min", justify: "min"
  } });
  engine.dispatch({ type: "select", ids: [f.id] });
  engine.dispatch({ type: "removeAllLayout", id: f.id });
  const f2 = find(r, f.id);
  t("removeAllLayout strips layout", !f2.layout);
  t("children remain after stripping layout", f2.children.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
