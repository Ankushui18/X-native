/** Semantic eyedropper actions and canvas interaction regression tests.
 * Run: npx vite-node src/ui/__tests__/eyedropper.test.mjs
 */
import { installDom, mountSurface } from "./domEnv.mjs";
import { mountCanvas } from "./softCanvas2d.mjs";
import { MemoryEngine, node } from "../../engine/memory.ts";
import { nextEyedropModel, armEyedrop, eyedropArmed, takeEyedrop } from "../color.ts";
import {
  applyEyedropSource,
  createEyedropStyle,
  createEyedropVariable,
  eyedropClipboardText,
  eyedropSourceForNode,
} from "../eyedropper.ts";

let pass = 0;
let fail = 0;
const t = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

{
  const sequence = ["hex", "rgb", "hsl", "hsb", "hex"];
  const actual = [sequence[0]];
  for (let i = 0; i < 4; i++) actual.push(nextEyedropModel(actual.at(-1)));
  t("Tab cycles the eyedropper's documented Hex/RGB/HSL/HSB models", JSON.stringify(actual) === JSON.stringify(sequence), JSON.stringify(actual));
  t("Tab from the fill picker's CSS mode enters the supported eyedropper cycle", nextEyedropModel("css") === "hex");
}

const engine = new MemoryEngine(false);
engine.dispatch({ type: "add", kind: "rect", x: 100, y: 100, w: 80, h: 80, extra: { fill: "#123456", fillVisible: true } });
const targetId = engine.snapshot().selection[0];
const variable = { id: "eyedrop-var", name: "brand/ink", type: "color", value: "#123456", collection: "Brand" };
engine.dispatch({ type: "addVariable", variable });
const sourceNode = node("rect", "Token source", 10, 10, 40, 40, {
  fill: "#123456", fillVisible: true, variableBindings: { fill: variable.id },
});
const source = eyedropSourceForNode(sourceNode, engine.snapshot(), "#123456");
t("sampling a variable-backed pixel retains its color-variable identity", source?.kind === "variable" && source.id === variable.id && source.name === variable.name);

engine.dispatch({ type: "createStyle", kind: "fill", name: "Surface/blue" });
const styleSnap = engine.snapshot();
const generatedStyle = styleSnap.styles.at(-1);
const styledSource = node("rect", "Style source", 10, 10, 40, 40, {
  fill: "#123456", fillVisible: true, fillStyle: generatedStyle.id,
});
const styledBinding = eyedropSourceForNode(styledSource, styleSnap, "#123456");
t("sampling a style-backed pixel retains its shared-style identity", styledBinding?.kind === "style" && styledBinding.id === generatedStyle.id && styledBinding.name === "Surface/blue");

engine.dispatch({ type: "select", ids: [targetId] });
t("Shift-sampling applies the source variable binding to the active fill", applyEyedropSource(engine, [targetId], "fill", source) && engine.snapshot().pages[0].root.children.find((n) => n.id === targetId).variableBindings.fill === variable.id);
const styleSource = { kind: "style", id: generatedStyle.id, name: generatedStyle.name, value: generatedStyle.color, prop: "fill" };
t("Shift-sampling applies a shared style to the selection", applyEyedropSource(engine, [targetId], "fill", styleSource) && engine.snapshot().pages[0].root.children.find((n) => n.id === targetId).fillStyle === generatedStyle.id);

t("creating a sampled color variable binds and paints the selection", createEyedropVariable(engine, [targetId], "fill", "#ab12cd", "brand/accent") &&
  engine.snapshot().variables.some((v) => v.name === "brand/accent" && v.value === "#ab12cd") &&
  engine.snapshot().pages[0].root.children.find((n) => n.id === targetId).fill === "#ab12cd");
t("creating a sampled color style binds the selected fill", createEyedropStyle(engine, [targetId], "fill", "#fedcba", "Sampled cream") &&
  engine.snapshot().styles.some((s) => s.name === "Sampled cream" && s.color === "#fedcba") &&
  engine.snapshot().pages[0].root.children.find((n) => n.id === targetId).fill === "#fedcba");

t("no-selection copy produces an uppercase raw value", eyedropClipboardText("#12abef") === "#12ABEF");
t("Shift-copy preserves the semantic name with its sampled value", eyedropClipboardText("#12abef", source, true) === "brand/ink #12ABEF");

installDom();
let seen = null;
armEyedrop((hex, context) => { seen = { hex, context }; }, "rgb");
t("arming the tool exposes its active state and selected readout model", eyedropArmed());
const callback = takeEyedrop();
callback?.("#123456", { shiftKey: true, create: true, source });
t("sample modifiers and semantic source pass through the eyedropper callback", seen?.hex === "#123456" && seen.context.shiftKey && seen.context.create && seen.context.source.id === variable.id);
t("taking a sample disarms the tool", !eyedropArmed());

{
  const painted = node("rect", "Sample source", 100, 100, 100, 100, { fill: "#123456", fillVisible: true });
  const ui = await mountCanvas([painted], { selection: [painted.id] });
  const wrap = ui.host.querySelector(".canvas-wrap");
  let picked = null;
  await ui.act(() => armEyedrop((hex, context) => { picked = { hex, context }; }));
  await ui.act(() => wrap.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 180 })));
  await ui.act(() => wrap.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 200, clientY: 180, shiftKey: true })));
  t("canvas click samples the rendered pixel and carries Shift for semantic apply", picked?.hex === "#123456" && picked.context.shiftKey, JSON.stringify(picked));
  let createdByClick = false;
  await ui.act(() => armEyedrop((_hex, context) => { createdByClick = !!context?.create; }));
  await ui.act(() => wrap.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 180 })));
  await ui.act(() => wrap.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 200, clientY: 180, ctrlKey: true, shiftKey: true })));
  t("Ctrl/Shift-click requests creation from the sampled color", createdByClick);
  let createdByEnter = false;
  await ui.act(() => armEyedrop((_hex, context) => { createdByEnter = !!context?.create; }));
  await ui.act(() => wrap.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 180 })));
  await ui.act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true, bubbles: true })));
  t("Ctrl/Shift+Enter creates from the current eyedropper sample", createdByEnter);
  await ui.close();
}

async function pickerShortcut(platform, modifiers) {
  const ui = await mountSurface("inspector", { layer: "rect" });
  await ui.click(ui.one(".color-row .swatch"));
  await ui.settle();
  Object.defineProperty(ui.window.navigator, "platform", { configurable: true, value: platform });
  const event = new ui.window.KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true, ...modifiers });
  await ui.window.dispatchEvent(event);
  const armed = eyedropArmed();
  if (armed) takeEyedrop();
  await ui.unmount();
  return armed;
}
t("macOS Control+C opens the picker eyedropper", await pickerShortcut("MacIntel", { ctrlKey: true }));
t("Cmd+C remains ordinary copy while the picker is open", !(await pickerShortcut("MacIntel", { metaKey: true })));
t("Windows Control+C remains ordinary copy; I is the eyedropper shortcut there", !(await pickerShortcut("Win32", { ctrlKey: true })));

{
  const { bindHotkeys } = await import("../chrome.tsx");
  const ui = await mountSurface("inspector", { layer: "rect" });
  Object.defineProperty(ui.window.navigator, "platform", { configurable: true, value: "MacIntel" });
  const unbind = bindHotkeys(ui.engine, { onActions() {}, onHide() {}, onMinimize() {} });
  const event = new ui.window.KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
  ui.window.dispatchEvent(event);
  t("macOS Control+C activates the global eyedropper for a selected layer", eyedropArmed() && event.defaultPrevented);
  if (eyedropArmed()) takeEyedrop();
  unbind();
  await ui.unmount();
}

console.log(`eyedropper: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
