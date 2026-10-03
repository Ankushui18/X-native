/**
 * Opacity & blend modes (Figma Design):
 *  - Layer opacity 0..1 defaults to 1.
 *  - Default blend mode is "normal" for leaf layers and "pass-through" for
 *    groups/frames (so their children blend with outside content).
 *  - 16 blend modes are supported via the node.blendMode field.
 *  - Fill opacity exists separately from layer opacity.
 *  - ⇧1..⇧9 / ⇧0 numeric opacity shortcuts (numeric keypad not bound here).
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // Defaults.
  const rect = node("rect", "R", 0, 0, 100, 100);
  t("default layer opacity is 1", rect.opacity === 1);
  t("default leaf blendMode is normal", rect.blendMode === "normal");
}

{
  // Groups/frames default to pass-through so children blend through.
  const g = node("group", "G", 0, 0, 100, 100);
  const f = node("frame", "F", 0, 0, 100, 100);
  t("group default blendMode is pass-through", g.blendMode === "pass-through");
  t("frame default blendMode is pass-through", f.blendMode === "pass-through");
}

{
  // Opacity can be changed on a selected layer via patch.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 100, 100);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "patch", id: rect.id, patch: { opacity: 0.5 } });
  t("layer opacity can be set to 50%", Math.abs(find(r, rect.id).opacity - 0.5) < 0.001);
}

{
  // Blend modes: multiply, screen, overlay, darken, lighten, color-dodge,
  // color-burn, hard-light, soft-light, difference, exclusion, hue,
  // saturation, color, luminosity plus normal/pass-through.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 100, 100);
  r.children.push(rect);
  engine.dispatch({ type: "patch", id: rect.id, patch: { blendMode: "multiply" } });
  t("multiply blend mode stores on node", find(r, rect.id).blendMode === "multiply");
  engine.dispatch({ type: "patch", id: rect.id, patch: { blendMode: "overlay" } });
  t("overlay blend mode stores on node", find(r, rect.id).blendMode === "overlay");
}

{
  // Fill opacity (alpha inside 8-hex fill color) exists separately from layer opacity.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 100, 100, { fill: "#ff000080" });
  r.children.push(rect);
  t("fill can carry 8-hex alpha (#rrggbbaa)", find(r, rect.id).fill === "#ff000080");
  t("fill opacity does not change layer opacity", find(r, rect.id).opacity === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
