/**
 * Export settings (Figma Design): exportSettings property supports
 * PNG/JPG/SVG/PDF with scale multipliers; multiple entries can be stacked.
 * Existing export24/pdfExport/exportBulk/exportPathway/exportSettings.dom
 * suites cover the actual export pipeline; this test locks in the
 * engine's ability to store stacked export settings on a node.
 */
import { MemoryEngine, node } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 100, 100);
  r.children.push(a);
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "patch", id: a.id, patch: { exportSettings: [{ format: "png", scale: 2, suffix: "@2x" }] } });
  const n = engine.snapshot().pages[0].root.children[0];
  t("node holds a PNG @2x export setting",
    n.exportSettings && n.exportSettings.length === 1 &&
    n.exportSettings[0].format === "png" && n.exportSettings[0].scale === 2);
  engine.dispatch({ type: "patch", id: a.id, patch: { exportSettings: [
    { format: "png", scale: 1, suffix: "" },
    { format: "svg", scale: 1, suffix: "" },
    { format: "pdf", scale: 1, suffix: "" },
  ] } });
  const n2 = engine.snapshot().pages[0].root.children[0];
  t("multiple formats can be stacked (PNG + SVG + PDF)", n2.exportSettings.length === 3);
  t("scale 0.5x is allowed", (() => {
    engine.dispatch({ type: "patch", id: a.id, patch: { exportSettings: [{ format: "jpg", scale: 0.5, suffix: "" }] } });
    const n3 = engine.snapshot().pages[0].root.children[0];
    return n3.exportSettings[0].scale === 0.5;
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
