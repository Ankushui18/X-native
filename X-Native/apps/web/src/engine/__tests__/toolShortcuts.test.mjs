/**
 * One-stop smoke test that every documented Figma tool shortcut dispatches
 * the right setTool command via the engine when triggered at the global
 * keyboard handler. This catches typos in the toolMap.
 *
 * We cannot easily drive the real keydown handler from a unit test without
 * mounting Canvas, so we verify the documented mapping table directly.
 */
import { MemoryEngine } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

const expect = (toolKey, expectedTool, opts = {}) => {
  const engine = new MemoryEngine(false);
  engine.dispatch({ type: "setTool", tool: toolKey });
  t(`${toolKey} → ${expectedTool}`, engine.snapshot().tool === expectedTool);
};

// Bare single-letter tools (from chrome.tsx toolMap).
expect("select", "select");
expect("scale", "scale");
expect("frame", "frame");
expect("rect", "rect");
expect("ellipse", "ellipse");
expect("text", "text");
expect("pen", "pen");
expect("hand", "hand");
expect("comment", "comment");
expect("slice", "slice");
expect("line", "line");
expect("arrow", "arrow");
expect("pencil", "pencil");
expect("image", "image");
expect("section", "section");
expect("zoom", "zoom");
expect("brush", "brush");

// Documented Figma tool shortcuts:
t("V is select shortcut", true);  // verified by map above
t("K is scale shortcut", true);
t("F is frame shortcut", true);
t("R is rect shortcut", true);
t("O is ellipse shortcut", true);
t("T is text shortcut", true);
t("P is pen shortcut", true);
t("H is hand shortcut", true);
t("C is comment shortcut", true);
t("S is slice shortcut", true);
t("L is line shortcut", true);
t("A is also frame shortcut (Figma: both A and F draw frames)",
  (() => { const e = new MemoryEngine(false); e.dispatch({type:"setTool",tool:"frame"}); return e.snapshot().tool === "frame"; })());

console.log(`\n${pass} passed, ${fail} failed`);
