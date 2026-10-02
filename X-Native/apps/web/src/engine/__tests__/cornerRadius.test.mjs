/**
 * Corner radius & smoothing (Figma help 360050986854):
 *  - Default rect starts with cornerRadii [0,0,0,0] and cornerSmoothing 0.
 *  - Setting one radius applies to all four corners uniformly.
 *  - Independent corners supports distinct TL/TR/BL/BR values.
 *  - Corner smoothing ranges 0..1 (iOS preset = 0.6).
 *  - Flip H / Flip V mirrors the radii array so the rounded corners stay
 *    visually on the same physical corner after a flip.
 *  - Polygons/stars don't carry cornerRadii.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // Default rect.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 200, 100);
  r.children.push(rect);
  t("default rect cornerRadii are [0,0,0,0]",
    JSON.stringify(rect.cornerRadii) === "[0,0,0,0]");
  t("default corner smoothing is 0", rect.cornerSmoothing === 0);
}

{
  // Apply a uniform corner radius.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 200, 100);
  r.children.push(rect);
  engine.dispatch({ type: "patch", id: rect.id, patch: { cornerRadii: [8, 8, 8, 8] } });
  const n = find(r, rect.id);
  t("uniform corner radius applies to all four corners",
    JSON.stringify(n.cornerRadii) === "[8,8,8,8]");
}

{
  // Independent corners: only TL rounded (24,0,0,0 like Figma top-tabs).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 200, 100);
  r.children.push(rect);
  engine.dispatch({ type: "patch", id: rect.id, patch: { cornerRadii: [24, 24, 0, 0] } });
  const n = find(r, rect.id);
  t("independent corners supports distinct per-corner values",
    n.cornerRadii[0] === 24 && n.cornerRadii[1] === 24 &&
    n.cornerRadii[2] === 0 && n.cornerRadii[3] === 0);
}

{
  // Corner smoothing: iOS preset = 60% = 0.6.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 200, 100);
  r.children.push(rect);
  engine.dispatch({ type: "patch", id: rect.id, patch: { cornerSmoothing: 0.6, cornerRadii: [16,16,16,16] } });
  const n = find(r, rect.id);
  t("corner smoothing stores 0.6 (iOS-style squircle)", Math.abs(n.cornerSmoothing - 0.6) < 0.001);
}

{
  // Flip H mirrors corner radii left↔right (TL↔TR, BL↔BR).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 200, 100, { cornerRadii: [20, 0, 20, 0] });
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "flip", axis: "h" });
  const n = find(r, rect.id);
  t("flip H swaps TL↔TR and BL↔BR radii",
    JSON.stringify(n.cornerRadii) === "[0,20,0,20]");
}

{
  // Flip V mirrors corner radii top↔bottom (TL↔BL, TR↔BR).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 200, 100, { cornerRadii: [20, 20, 0, 0] });
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "flip", axis: "v" });
  const n = find(r, rect.id);
  t("flip V swaps TL↔BL and TR↔BR radii",
    JSON.stringify(n.cornerRadii) === "[0,0,20,20]");
}

{
  // Frames also support cornerRadii.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const f = node("frame", "F", 0, 0, 200, 200, { cornerRadii: [12,12,12,12] });
  r.children.push(f);
  t("frames carry cornerRadii like rectangles",
    JSON.stringify(find(r, f.id).cornerRadii) === "[12,12,12,12]");
}

console.log(`\n${pass} passed, ${fail} failed`);
