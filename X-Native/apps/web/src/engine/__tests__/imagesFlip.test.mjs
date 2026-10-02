/**
 * Image placement: ⇧⌘K dispatches place-image custom event (chrome.tsx:2345),
 * and images have imageSrc set so the renderer knows what to draw.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const img = node("rect", "img", 0, 0, 200, 150, { imageSrc: "data:example" });
  r.children.push(img);
  t("imageSrc can be set on a rect (treated as image layer)", find(r, img.id).imageSrc === "data:example");
  t("image layer is still kind rect", find(r, img.id).kind === "rect");
}

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 0, 0, 100, 100);
  r.children.push(a);
  engine.dispatch({ type: "select", ids: [a.id] });
  engine.dispatch({ type: "flip", axis: "h" });
  t("flip h toggles horizontal flip", find(r, a.id).flipH === true);
  engine.dispatch({ type: "flip", axis: "h" });
  t("flip h twice returns to normal", find(r, a.id).flipH !== true);
  engine.dispatch({ type: "flip", axis: "v" });
  t("flip v toggles vertical flip", find(r, a.id).flipV === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
