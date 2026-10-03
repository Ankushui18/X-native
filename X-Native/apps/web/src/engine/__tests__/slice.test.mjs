/**
 * Slice tool (Figma help 360040028394): slice layers are rect-kind frames
 * marked isSlice with a dashed stroke and no fill, and accept export
 * settings like any other layer.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const s = node("frame", "Slice", 0, 0, 200, 100, { isSlice: true, fillVisible: false, strokeDash: 4 });
  r.children.push(s);
  const n = find(r, s.id);
  t("slice layer created with isSlice flag", n.isSlice === true);
  t("slice has no visible fill", n.fillVisible === false);
  t("slice has a dashed outline", n.strokeDash === 4);
  engine.dispatch({ type: "patch", id: s.id, patch: { exportSettings: [{ format: "png", scale: 1, suffix: "" }] } });
  t("slice accepts export settings like any layer", find(r, s.id).exportSettings.length === 1);
}

{
  // The engine's setTool accepts "slice" (mapped from S key in chrome).
  const engine = new MemoryEngine(false);
  engine.dispatch({ type: "setTool", tool: "slice" });
  t("S-key slice tool activates in the engine", engine.snapshot().tool === "slice");
}

console.log(`\n${pass} passed, ${fail} failed`);
