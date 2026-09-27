/** Batch 2: mounted inspector/layer panel and real global keydown dispatch. */
import { installDom, mountPanel, mountSurface } from "./domEnv.mjs";
import { MemoryEngine, node, find, hitTest } from "../../engine/memory.ts";
import { strokeSpill } from "../../engine/strokeModel.ts";
import { svgShape } from "../../engine/svgExport.ts";

const window = installDom();
// No raster backend in jsdom: exercise the documented geometric fallback here.
window.HTMLCanvasElement.prototype.getContext = () => null;
const { act } = await import("react");
const { bindHotkeys } = await import("../chrome.tsx");
const { runMenu } = await import("../ContextMenu.tsx");
const { clearEscapes, pushEscape } = await import("../escape.ts");
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const clear = (e) => {
  e.dispatch({ type: "select", ids: rootOf(e).children.map((n) => n.id) });
  e.dispatch({ type: "delete" });
};
const rectLayer = (e) => {
  clear(e);
  e.dispatch({ type: "add", kind: "rect", x: 40, y: 40, w: 100, h: 100, extra: { strokeWidth: 10, strokeVisible: true, strokePaint: "#000000" } });
  return e.snapshot().selection[0];
};
const change = async (select, value) => {
  if (!select) throw new Error("Missing select");
  await act(async () => { select.value = value; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
};
{
  const ui = await mountPanel({ layer: rectLayer });
  const dropdown = () => ui.one('select[aria-label="Stroke alignment"]');
  t("alignment uses the shared accessible dropdown", dropdown()?.classList.contains("x-select"));
  t("dropdown offers Inside / Center / Outside", Array.from(dropdown()?.options ?? []).map((o) => o.textContent).join() === "Inside,Center,Outside");
  t("rectangle defaults to Inside", dropdown()?.value === "inside" && ui.node().strokeAlign === "inside");
  await change(dropdown(), "outside");
  t("Outside patches the selected rectangle", ui.node().strokeAlign === "outside");
  t("alignment leaves geometric dimensions and stroke weight unchanged", ui.node().w === 100 && ui.node().h === 100 && ui.node().strokeWidth === 10);
  t("Outside expands visual stroke spill by its full weight", strokeSpill(ui.node()) === 10);
  t("Outside stroke's expanded area is selectable", hitTest(rootOf(ui.engine), 35, 90, { deep: true })?.id === ui.id);
  const svg = svgShape(ui.node(), "#ffffff", "#000000", "", { simplifyStrokes: false });
  t("web SVG renderer uses an outside mask rather than a centered stroke", svg.includes("<mask") && svg.includes('stroke-width="20"'));
  await ui.dispatch({ type: "undo" });
  t("alignment selection is undoable", dropdown()?.value === "inside" && ui.node().strokeAlign === "inside");
  await change(dropdown(), "center");
  t("Center spills half the weight", ui.node().strokeAlign === "center" && strokeSpill(ui.node()) === 5);
  await change(dropdown(), "inside");
  t("Inside has no outside spill", strokeSpill(ui.node()) === 0);
  await ui.unmount();
}
{
  const ui = await mountPanel({ layer(e) {
    const a = rectLayer(e);
    e.dispatch({ type: "add", kind: "rect", x: 200, y: 40, w: 100, h: 100, extra: { strokeWidth: 10, strokeVisible: true, strokePaint: "#000000", strokeAlign: "center" } });
    const b = e.snapshot().selection[0];
    e.dispatch({ type: "select", ids: [a, b] });
    return a;
  } });
  const ids = ui.snap().selection;
  t("mixed alignment is represented instead of silently choosing one value", ui.one('select[aria-label="Stroke alignment"]')?.value === "mixed");
  await change(ui.one('select[aria-label="Stroke alignment"]'), "outside");
  t("dropdown applies alignment across the selection", ids.every((id) => ui.node(id).strokeAlign === "outside"));
  await ui.dispatch({ type: "undo" });
  t("multi-alignment is a single undo step", ui.node(ids[0]).strokeAlign === "inside" && ui.node(ids[1]).strokeAlign === "center");
  await ui.unmount();
}
for (const kind of ["line", "arrow"]) {
  const ui = await mountPanel({ layer(e) {
    clear(e);
    e.dispatch({ type: "add", kind, x: 40, y: 40, w: 100, h: 1 });
    return e.snapshot().selection[0];
  } });
  t(`${kind} retains Center and does not offer unsupported alignment`, ui.node().strokeAlign === "center" && !ui.one('select[aria-label="Stroke alignment"]'));
  await ui.unmount();
}
{
  const ui = await mountSurface("left", { layer(e) {
    clear(e);
    e.dispatch({ type: "add", kind: "text", x: 40, y: 60, w: 100, h: 40, extra: { text: "Hi" } });
    return e.snapshot().selection[0];
  } });
  await act(async () => runMenu(ui.engine, "outlineStroke"));
  const glyphs = ui.snap().selection.map((id) => ui.node(id));
  t("Outline stroke menu action reaches per-glyph conversion", glyphs.length === 2 && glyphs.every((g) => g.kind === "vector"));
  t("Layers panel displays both glyph names", glyphs.every((g) => ui.container.textContent.includes(g.name)));
  t("Layers panel no longer contains original text node", !ui.node(ui.id));
  await ui.unmount();
}

const setupKeys = () => {
  const a = node("rect", "A", 0, 0, 100, 100), b = node("rect", "B", 50, 0, 100, 100);
  const e = new MemoryEngine(false, { pages: [{ id: "keys", name: "Page", root: node("frame", "Root", 0, 0, 1000, 1000, { children: [a, b] }), guides: [], comments: [] }], page: 0 });
  e.dispatch({ type: "select", ids: [a.id, b.id] });
  const commands = [];
  const dispatch = e.dispatch.bind(e);
  e.dispatch = (cmd) => { commands.push(cmd); dispatch(cmd); };
  const unbind = bindHotkeys(e, { onActions() {}, onHide() {}, onMinimize() {}, onPresentExit() {} });
  return { e, a, b, commands, unbind };
};
const press = (key, code = "", options = {}, target = document.body) => {
  const event = new window.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, altKey: true, shiftKey: true, ...options });
  target.dispatchEvent(event);
  return event;
};
for (const [letter, macChar, op] of [["U", "¨", "union"], ["S", "Í", "subtract"], ["I", "ˆ", "intersect"], ["E", "´", "exclude"]]) {
  for (const [name, key, code, ctrlKey] of [["physical", letter, `Key${letter}`, false], ["mac Option", macChar, `Key${letter}`, false], ["no-code fallback", letter, "", false], ["Windows Ctrl variant", letter, `Key${letter}`, true]]) {
    const { e, a, b, commands, unbind } = setupKeys();
    const event = press(key, code, { ctrlKey });
    const result = find(rootOf(e), e.snapshot().selection[0]);
    t(`${name} Alt+Shift+${letter} creates ${op}`, result?.kind === "boolean" && result.booleanOp === op && result.children.length === 2);
    t(`${name} ${op} dispatches once and prevents browser default`, commands.filter((c) => c.type === "boolean").length === 1 && event.defaultPrevented);
    e.dispatch({ type: "undo" });
    t(`${name} ${op} is one undo step`, rootOf(e).children.map((n) => n.id).join() === [a.id, b.id].join());
    unbind();
  }
}
for (const tag of ["input", "textarea", "select"]) {
  const { e, commands, unbind } = setupKeys();
  const field = document.createElement(tag); document.body.appendChild(field);
  press("U", "KeyU", {}, field);
  t(`${tag} typing guard prevents accidental boolean operations`, !commands.some((c) => c.type === "boolean") && rootOf(e).children.length === 2);
  field.remove(); unbind();
}
{
  clearEscapes();
  const { e, commands, unbind } = setupKeys();
  const release = pushEscape("batch2-test", () => {}, null, true);
  press("U", "KeyU");
  t("modal guard prevents boolean shortcuts behind a dialog", !commands.some((c) => c.type === "boolean") && rootOf(e).children.length === 2);
  release(); unbind(); clearEscapes();
}
{
  const { commands, unbind } = setupKeys();
  press("U", "KeyU", { altKey: false });
  press("U", "KeyU", { shiftKey: false });
  t("boolean chord requires both Alt and Shift", !commands.some((c) => c.type === "boolean"));
  unbind();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
