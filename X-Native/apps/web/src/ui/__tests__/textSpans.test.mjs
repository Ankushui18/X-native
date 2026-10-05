/** Range typography integration: real textarea -> Inspector -> engine -> Canvas2D.
 * Canvas recorder proves font, fill and measured positions, not glyph pixels.
 * Run: vite-node src/ui/__tests__/textSpans.test.mjs */
import { node, find } from "../../engine/memory.ts";
import { mountCanvas } from "./softCanvas2d.mjs";
import { resolvedTextSpans, styleTextRange, spansAfterTextEdit } from "../textSpans.ts";
import { canvasTextFont, hugSize, styledTextRows } from "../textLayout.ts";

let pass = 0, fail = 0;
const t = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` - ${detail}`}`);
  ok ? pass++ : fail++;
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});
const n = node("text", "Span fixture", 120, 150, 240, 26, {
  text: "Hello World", sizingW: "hug", sizingH: "hug", fontFamily: "Inter", fontWeight: 400, fontSize: 16,
});
const ui = await mountCanvas([n]);
const live = () => find(ui.engine.snapshot().pages[0].root, n.id);
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { RightPanel } = await import("../inspector.tsx");
const { ThemeProvider } = await import("../theme.tsx");
function Inspector() {
  const snap = React.useSyncExternalStore((cb) => ui.engine.subscribe(cb), () => ui.engine.snapshot());
  return React.createElement(ThemeProvider, null, React.createElement(RightPanel, { engine: ui.engine, snap }));
}
const host = document.createElement("div"); document.body.appendChild(host);
const root = createRoot(host);
await React.act(async () => root.render(React.createElement(Inspector)));
await ui.dispatch({ type: "select", ids: [n.id] });
await ui.act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
const textarea = ui.host.querySelector("textarea.text-edit");
t("real textarea is mounted", !!textarea);
await ui.act(() => {
  textarea.focus();
  textarea.setSelectionRange(6, 11);
  textarea.dispatchEvent(new window.Event("select", { bubbles: true }));
  textarea.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
});
t("DOM selection is World [6,11)", textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) === "World");
// Blur and collapse BEFORE the Inspector changes the family: this reproduces
// the focus transition that used to discard the range.
await ui.act(() => {
  textarea.blur();
  textarea.setSelectionRange(11, 11);
});
t("inspector focus has removed the textarea", !ui.host.querySelector("textarea.text-edit"));
// Font family/weight ride the FontPicker pops: open the trigger, pick the row.
async function choose(label, value) {
  const el = host.querySelector(`[aria-label="${label}"]`);
  t(`${label} control exists`, !!el);
  await React.act(async () => { el.click(); });
  const row = document.body.querySelector(`[data-value="${value}"]`);
  t(`${label} offers ${value}`, !!row);
  await React.act(async () => { row.click(); });
}
await choose("Font family", "Roboto");
await choose("Font weight", "700");
const model = structuredClone(live());
const runs = model.textRuns ?? [];
t("two stored contiguous, nonoverlapping runs", runs.length === 2 && runs[0].start === 0 && runs[0].end === 6 && runs[1].start === 6 && runs[1].end === 11, JSON.stringify(runs));
t("Hello retains Inter 400; World becomes Roboto 700", runs[0]?.fontFamily === "Inter" && runs[0]?.fontWeight === 400 && runs[1]?.fontFamily === "Roboto" && runs[1]?.fontWeight === 700, JSON.stringify(runs));
t("layer defaults were not overwritten", model.fontFamily === "Inter" && model.fontWeight === 400);
t("Inspector reflects selected run rather than layer defaults", host.querySelector('[aria-label="Font family"]')?.getAttribute("data-value") === "Roboto" && host.querySelector('[aria-label="Font weight"]')?.getAttribute("data-value") === "700");
const strokes = ui.ctx.texts.filter((c) => c.inDoc && c.text === "Hello " || c.inDoc && c.text === "World");
const pair = strokes.slice(-2);
const measureCtx = ui.ctx;
measureCtx.font = canvasTextFont(model, 16, resolvedTextSpans(model)[0]);
const expected = measureCtx.measureText("Hello ").width;
t("Canvas paints two separate segments in their own fonts", pair.length === 2 && pair[0].text === "Hello " && pair[1].text === "World" && /400 16px "Inter"/.test(pair[0].font) && /700 16px "Roboto"/.test(pair[1].font), JSON.stringify(pair));
t("World starts at measured end of Hello (not whole-string width)", pair.length === 2 && Math.abs(pair[0].x - 120) < 0.01 && Math.abs(pair[1].x - pair[0].x - expected) < 0.01, JSON.stringify(pair));
// The same Inspector controls also route size and the base Fill colour to
// the captured range, rather than patching the whole layer.
const setInput = async (el, value) => React.act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const sizeInput = host.querySelector('input[aria-label="S"]');
t("Inspector font size field exists", !!sizeInput);
await setInput(sizeInput, "28");
t("Inspector size updates only World", live().fontSize === 16 && live().textRuns[0].fontSize === 16 && live().textRuns[1].fontSize === 28, JSON.stringify(live().textRuns));
const fillInput = host.querySelector('input[aria-label="Fill colour hex"]');
t("Inspector Fill colour input exists", !!fillInput);
await setInput(fillInput, "ff0000");
t("Inspector Fill colour updates only World", live().fill !== "#ff0000" && live().textRuns[1].fill === "#ff0000" && live().textRuns[0].fill !== "#ff0000", JSON.stringify(live().textRuns));
t("Inspector displays the selected size and colour", host.querySelector('input[aria-label="S"]')?.value === "28" && host.querySelector('input[aria-label="Fill colour hex"]')?.value.toLowerCase() === "ff0000");
const serialized = JSON.parse(JSON.stringify(ui.engine.snapshot()));
t("document JSON retains both runs and their overrides", JSON.stringify(find(serialized.pages[0].root, n.id).textRuns) === JSON.stringify(live().textRuns));
const beforeHistory = JSON.stringify(live().textRuns);
await ui.dispatch({ type: "undo" });
t("undo restores the prior span styling", JSON.stringify(live().textRuns) !== beforeHistory);
await ui.dispatch({ type: "redo" });
t("redo restores the same spans", JSON.stringify(live().textRuns) === beforeHistory);


// Reapplying style inside and across boundaries splits/merges without gaps;
// size and colour are also per-run and fed to the same layout and renderer.
const changed = { ...model, textRuns: styleTextRange(model, 6, 11, { fontSize: 28, fill: "#ff0000" }) };
const sizeRuns = resolvedTextSpans(changed);
t("range size and colour leave base run unchanged", sizeRuns.length === 2 && sizeRuns[0].fontSize === 16 && sizeRuns[1].fontSize === 28 && sizeRuns[1].fill === "#ff0000");
await ui.dispatch({ type: "patch", id: n.id, patch: { textRuns: changed.textRuns } });
const sizePaint = ui.ctx.texts.filter((c) => c.inDoc && (c.text === "Hello " || c.text === "World")).slice(-2);
t("Canvas paints selected range in its own 28px font and red fill", /700 28px "Roboto"/.test(sizePaint[1]?.font ?? "") && /255,0,0/.test(sizePaint[1]?.fillStyle ?? "") && /400 16px "Inter"/.test(sizePaint[0]?.font ?? ""), JSON.stringify(sizePaint));
const sized = styledTextRows(ui.ctx, changed, changed.text, 1000)[0];
t("measured row width sums each font's segment width", sized.pieces.length === 2 && Math.abs(sized.width - sized.pieces.reduce((w, p) => w + p.width, 0)) < 0.01);
t("hug width follows styled row width", hugSize(changed, changed.text).w === Math.max(8, Math.ceil(sized.width + 4)));
const cross = { ...changed, textRuns: styleTextRange(changed, 4, 9, { fontFamily: "Fira Code" }) };
t("overlap splits at both boundaries without gaps", JSON.stringify(cross.textRuns.map((r) => [r.start, r.end])) === JSON.stringify([[0, 4], [4, 6], [6, 9], [9, 11]]));
const reverted = { ...model, textRuns: styleTextRange(model, 6, 11, { fontFamily: "Inter", fontWeight: 400 }) };
t("matching neighbours merge into a single run", reverted.textRuns.length === 1 && reverted.textRuns[0].start === 0 && reverted.textRuns[0].end === 11);
const fixed = { ...changed, sizingW: "fixed", w: 42 };
const wrapped = styledTextRows(ui.ctx, fixed, fixed.text, fixed.w);
t("mixed-font wrapping respects per-row bounds", wrapped.length > 1 && wrapped.every((r) => r.width + r.lead <= fixed.w + 0.001), JSON.stringify(wrapped.map((r) => r.width + r.lead)));
const inserted = spansAfterTextEdit(model, "Hello big World");
t("text edit shifts offsets while preserving the styled suffix", inserted.length === 2 && inserted[1].start === 10 && inserted[1].end === 15, JSON.stringify(inserted));
const uniform = { ...model, textRuns: styleTextRange(model, 0, 11, { fontFamily: "Roboto", fontWeight: 700 }) };
await ui.dispatch({ type: "patch", id: n.id, patch: { textRuns: uniform.textRuns } });
const whole = ui.ctx.texts.filter((c) => c.inDoc && c.text === "Hello World").at(-1);
t("a single covering run keeps the single fillText fast path", /700 16px "Roboto"/.test(whole?.font ?? ""));
const unicode = { ...model, text: "😀World", textRuns: [] };
const unicodeRuns = styleTextRange(unicode, 2, 7, { fontFamily: "Roboto" });
t("run offsets follow textarea UTF-16 positions", JSON.stringify(unicodeRuns.map((r) => [r.start, r.end])) === "[[0,2],[2,7]]");
await React.act(async () => root.unmount()); host.remove(); await ui.close();
