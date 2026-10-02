/**
 * Copy/paste properties between layers (4412765442967):
 *   ⌥⌘C copies all supported properties, ⌥⌘V pastes them onto another layer.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

function mk() {
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  return engine;
}

// 1. Copy/paste fill color.
{
  const engine = mk();
  const r = engine.snapshot().pages[0].root;
  const src = node("rect", "src", 0, 0, 100, 100, { fill: "#ff0000" });
  const dst = node("rect", "dst", 200, 0, 100, 100, { fill: "#0000ff" });
  r.children.push(src, dst);
  engine.dispatch({ type: "select", ids: [src.id] });
  engine.dispatch({ type: "copyProperties" });
  engine.dispatch({ type: "select", ids: [dst.id] });
  engine.dispatch({ type: "pasteProperties" });
  t("pasteProperties copies fill color", find(r, dst.id).fill === "#ff0000");
}

// 2. Copy/paste stroke properties.
{
  const engine = mk();
  const r = engine.snapshot().pages[0].root;
  const src = node("rect", "src", 0, 0, 100, 100, { strokePaint: "#00ff00", strokeWidth: 4 });
  const dst = node("rect", "dst", 200, 0, 100, 100, { strokePaint: "#000000", strokeWidth: 1 });
  r.children.push(src, dst);
  engine.dispatch({ type: "select", ids: [src.id] });
  engine.dispatch({ type: "copyProperties" });
  engine.dispatch({ type: "select", ids: [dst.id] });
  engine.dispatch({ type: "pasteProperties" });
  t("pasteProperties copies stroke width", find(r, dst.id).strokeWidth === 4);
  t("pasteProperties copies stroke color", find(r, dst.id).strokePaint === "#00ff00");
}

// 3. Empty clipboard paste is a no-op.
{
  const engine = mk();
  const r = engine.snapshot().pages[0].root;
  const dst = node("rect", "dst", 200, 0, 100, 100, { fill: "#0000ff" });
  r.children.push(dst);
  engine.dispatch({ type: "select", ids: [dst.id] });
  engine.dispatch({ type: "pasteProperties" });
  t("pasteProperties with empty clipboard is no-op", find(r, dst.id).fill === "#0000ff");
}

// 4. Copy/paste opacity.
{
  const engine = mk();
  const r = engine.snapshot().pages[0].root;
  const src = node("rect", "src", 0, 0, 100, 100, { opacity: 0.5 });
  const dst = node("rect", "dst", 200, 0, 100, 100, { opacity: 1 });
  r.children.push(src, dst);
  engine.dispatch({ type: "select", ids: [src.id] });
  engine.dispatch({ type: "copyProperties" });
  engine.dispatch({ type: "select", ids: [dst.id] });
  engine.dispatch({ type: "pasteProperties" });
  t("pasteProperties copies opacity", Math.abs(find(r, dst.id).opacity - 0.5) < 0.001);
}

console.log(`\n${pass} passed, ${fail} failed`);
