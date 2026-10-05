/** Text interaction regression: the edit overlay must not inset glyphs, must
 * hang its first row on the row the painter draws, and inspector font patches
 * must reach a real bundled Canvas2D face. The software canvas records drawing
 * requests rather than rasterizing glyph outlines.
 * Run: vite-node src/ui/__tests__/textInteraction.test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { node, find } from "../../engine/memory.ts";
import { mountCanvas } from "./softCanvas2d.mjs";
import { cssFirstBaseline, effectiveLineHeight, hugSize } from "../textLayout.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});
const style = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const frameCss = /\.text-edit-frame\s*\{([^}]+)\}/.exec(style)?.[1] ?? "";
const editCss = /\.text-edit\s*\{([^}]+)\}/.exec(style)?.[1] ?? "";
const cssNode = document.createElement("style");
cssNode.textContent = `.text-edit-frame {${frameCss}}\n.text-edit {${editCss}}`;
document.head.appendChild(cssNode);
const n = node("text", "Text", 120, 150, 24, 24, { text: "Jump test", sizingW: "hug", sizingH: "hug", fontFamily: "Inter", fontWeight: 400 });
Object.assign(n, hugSize(n, n.text));
// A controllable FontFaceSet proves that an asynchronously resolved face
// triggers another Canvas pass even though no document patch follows it.
const priorFonts = Object.getOwnPropertyDescriptor(document, "fonts");
let resolveRoboto;
Object.defineProperty(document, "fonts", { configurable: true, value: {
  load(css) { return css.includes("Roboto") ? new Promise((resolve) => { resolveRoboto = resolve; }) : Promise.resolve([]); },
} });
// Blink's metrics for the bundled Inter face, as ratios of the em: the hhea
// ascent/descent a CSS line box leads around, and the normalised sTypo ascent
// the canvas "top" baseline anchors at (see textLayout.fontMetricRatios).
// The software canvas has no font metrics, so the harness lends it these -
// without them the editor keeps its unadjusted placement.
const INTER = { ascent: 0.96875, descent: 0.2412, top: 0.80078 };
function installInterMetrics(u) {
  const stubMeasure = u.ctx.measureText.bind(u.ctx);
  u.ctx.measureText = (s) => {
    const base = stubMeasure(s);
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(String(u.ctx.font))?.[1] ?? "16");
    const asc = INTER.ascent * size, desc = INTER.descent * size, top = INTER.top * size;
    const onTop = u.ctx.textBaseline === "top";
    return { ...base, fontBoundingBoxAscent: onTop ? asc - top : asc, fontBoundingBoxDescent: onTop ? desc + top : desc };
  };
}
const ui = await mountCanvas([n]);
installInterMetrics(ui);
const live = () => find(ui.engine.snapshot().pages[ui.engine.snapshot().page].root, n.id);
const box = () => [live().x, live().y, live().w, live().h];
const lastPaint = () => ui.ctx.texts.filter((c) => c.inDoc && c.text === n.text).at(-1);
const frameOf = (u, id) => u.host.querySelector(".text-edit-frame");
console.log("T-1 entering Auto-width text edit:");
const initial = box();
const paintedRow = lastPaint()?.y ?? NaN;
t("point text is Auto width and starts drawn by Canvas", live().sizingW === "hug" && !!lastPaint());
await ui.dispatch({ type: "select", ids: [n.id] });
await ui.act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
let frame = frameOf(ui);
let overlay = ui.host.querySelector(".text-edit");
t("Enter mounts the real editor", !!overlay && !!frame);
t("x/y/w/h are byte-identical on entry (0px coordinate jump)", JSON.stringify(box()) === JSON.stringify(initial), `${initial} -> ${box()}`);
t("editor frame stays on the layer's world origin", frame?.style.left === `${initial[0]}px` && frame?.style.top === `${initial[1]}px`);
t("editor frame remains the fitted Auto-width box", frame?.style.width === `${initial[2]}px` && frame?.style.height === `${initial[3]}px`);
t("editor's border does not inset glyphs (pre-fix: 1.5px)", /border:\s*0;/.test(editCss) && parseFloat(getComputedStyle(overlay).borderLeftWidth) === 0 && parseFloat(getComputedStyle(overlay).borderTopWidth) === 0);
t("focus ring is external to the text box", /outline:\s*1\.5px solid var\(--blue\)/.test(frameCss) && /pointer-events:\s*none;/.test(frameCss));
// Figma's text editing box is a plain rectangle, so the ring that stands in
// for it must be too. `outline` follows `border-radius`, so a radius on either
// half of the pair would be visible in the ring the user sees.
t("text box is square-cornered: no radius on the frame or the textarea",
  /border-radius:\s*0;/.test(frameCss) && /border-radius:\s*0;/.test(editCss) &&
  parseFloat(getComputedStyle(frame).borderTopLeftRadius) === 0 &&
  parseFloat(getComputedStyle(overlay).borderTopLeftRadius) === 0,
  `frame ${getComputedStyle(frame).borderTopLeftRadius} / textarea ${getComputedStyle(overlay).borderTopLeftRadius}`);
// The jump: a textarea hangs its first row off the CSS line box, the painter
// hangs it off the canvas "top" baseline. The overlay must carry the difference
// (zoom is 1 in this harness, so screen px == world px). `paintedRow` is the y
// the painter actually handed to fillText before edit started.
const fs = live().fontSize, lh = effectiveLineHeight(live()) * 1;
const A = INTER.ascent * fs, D = INTER.descent * fs, Tn = INTER.top * fs;
const rowShift = Tn - cssFirstBaseline(A, D, lh);
t("editor text is not left on the unadjusted line box (pre-fix: 0px offset)",
  Math.abs(parseFloat(overlay.style.top) - rowShift) < 1e-6, `${overlay.style.top} vs ${rowShift}`);
const domBaseline = parseFloat(frame.style.top) + parseFloat(overlay.style.top || "0") + cssFirstBaseline(A, D, lh);
t("DOM first baseline == the baseline the painter drew the row at",
  Math.abs(domBaseline - (paintedRow + Tn)) < 1e-6, `${domBaseline} vs ${paintedRow + Tn}`);
t("corrected text box still covers the layer's box (no clipped rows)",
  Math.abs(parseFloat(overlay.style.height) - (initial[3] + Math.abs(rowShift))) < 1e-6 &&
  overlay.style.left === "0px" && overlay.style.right === "0px" && overlay.style.width === "");

console.log("T-2 inspector font changes through the engine to the canvas:");
await ui.act(() => overlay.blur());
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { RightPanel } = await import("../inspector.tsx");
const { ThemeProvider } = await import("../theme.tsx");
function Host() {
  const snap = React.useSyncExternalStore((cb) => ui.engine.subscribe(cb), () => ui.engine.snapshot());
  return React.createElement(ThemeProvider, null, React.createElement(RightPanel, { engine: ui.engine, snap }));
}
const host = document.createElement("div"); document.body.appendChild(host);
const root = createRoot(host);
await React.act(async () => root.render(React.createElement(Host)));
// The font family/weight controls are button-triggered pops now (FontPicker):
// open the trigger, click the row that carries the value.
const select = async (label, value) => {
  const btn = host.querySelector(`[aria-label="${label}"]`);
  t(`${label} is available`, !!btn);
  await React.act(async () => { btn.click(); });
  const row = document.body.querySelector(`[data-value="${value}"]`);
  t(`${label} offers ${value}`, !!row);
  await React.act(async () => { row.click(); });
};
await select("Font family", "Roboto");
t("Inspector patches the selected text layer's family", live().fontFamily === "Roboto");
t("Canvas fillText requests the new family", /\bRoboto\b/.test(lastPaint()?.font || ""), lastPaint()?.font);
t("Roboto has a bundled variable face (not an Inter-only fallback)", existsSync(new URL("../../../public/fonts/roboto-latin-wght-normal.woff2", import.meta.url)) && /font-family:\s*"Roboto";[\s\S]*?font-weight:\s*100 900;[\s\S]*?roboto-latin-wght-normal\.woff2/.test(style));
const otherFaces = ["geist", "space-grotesk", "plus-jakarta-sans", "outfit", "fira-code", "jetbrains-mono"];
t("other advertised web families have local faces", otherFaces.every((f) =>
  existsSync(new URL(`../../../public/fonts/${f}-latin-wght-normal.woff2`, import.meta.url)) && style.includes(`/fonts/${f}-latin-wght-normal.woff2`)));
t("Poppins exposes the listed weights locally", [100, 200, 300, 400, 500, 600, 700, 800, 900].every((w) =>
  existsSync(new URL(`../../../public/fonts/poppins-latin-${w}-normal.woff2`, import.meta.url)) && style.includes(`/fonts/poppins-latin-${w}-normal.woff2`)));
const strokesBeforeFontLoad = ui.ctx.texts.filter((c) => c.inDoc && c.text === n.text).length;
t("selected web font is requested", typeof resolveRoboto === "function");
await React.act(async () => { resolveRoboto([{ family: "Roboto" }]); await Promise.resolve(); });
t("font resolution repaints without another model edit", ui.ctx.texts.filter((c) => c.inDoc && c.text === n.text).length > strokesBeforeFontLoad);
await select("Font weight", "700");
t("Inspector patches weight", live().fontWeight === 700);
t("Canvas fillText requests the new weight and family", /700 16px "Roboto"/.test(lastPaint()?.font || ""), lastPaint()?.font);
t("font edits preserve the text origin", live().x === initial[0] && live().y === initial[1]);
await React.act(async () => root.unmount());
host.remove();
await ui.close();
console.log("T-3 fixed-size text also keeps its box on entry:");
// Middle-aligned: the painter centres the block in the box, so the live row
// hangs that much lower - and a textarea left on its own line box would ignore
// the alignment entirely and jump up by the whole inset.
const fixed = node("text", "Fixed", 230, 190, 160, 50, { text: "Fixed size", sizingW: "fixed", sizingH: "fixed", textAlignVertical: "middle" });
const fixedUi = await mountCanvas([fixed]);
installInterMetrics(fixedUi);
const fPaintedRow = fixedUi.ctx.texts.filter((c) => c.inDoc && c.text === "Fixed size").at(-1)?.y ?? NaN;
await fixedUi.dispatch({ type: "select", ids: [fixed.id] });
await fixedUi.act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
const fixedLive = find(fixedUi.engine.snapshot().pages[0].root, fixed.id);
const fFrame = fixedUi.host.querySelector(".text-edit-frame");
const fText = fixedUi.host.querySelector(".text-edit");
t("Fixed-size edit preserves x/y/w/h", [fixedLive.x, fixedLive.y, fixedLive.w, fixedLive.h].join() === "230,190,160,50");
t("Fixed-size frame keeps the layer's box", fFrame?.style.width === "160px" && fFrame?.style.left === "230px");
const fLh = effectiveLineHeight(fixed) * 1;
const fA = INTER.ascent * fixed.fontSize, fD = INTER.descent * fixed.fontSize, fTn = INTER.top * fixed.fontSize;
const fDomBaseline = parseFloat(fFrame.style.top) + parseFloat(fText.style.top || "0") + parseFloat(fText.style.paddingTop || "0") + cssFirstBaseline(fA, fD, fLh);
t("middle-aligned box: DOM baseline == the painted row's baseline, not the box top",
  Math.abs(fDomBaseline - (fPaintedRow + fTn)) < 1e-6 && fPaintedRow > parseFloat(fFrame.style.top), `${fDomBaseline} vs ${fPaintedRow + fTn}`);
const fRowOffset = parseFloat(fText.style.top || "0") + parseFloat(fText.style.paddingTop || "0");
t("aligned row still fits the text box", Math.abs(parseFloat(fText.style.height) - (50 + Math.abs(fRowOffset))) < 1e-6, `${fText.style.height}`);
await fixedUi.close();
console.log("T-4 vertical trim reaches the live row too:");
const trimmed = node("text", "Trim", 300, 80, 160, 40, { text: "Trim", sizingW: "fixed", sizingH: "fixed", verticalTrim: true });
const trimUi = await mountCanvas([trimmed]);
installInterMetrics(trimUi);
const tPaintedRow = trimUi.ctx.texts.filter((c) => c.inDoc && c.text === "Trim").at(-1)?.y ?? NaN;
await trimUi.dispatch({ type: "select", ids: [trimmed.id] });
await trimUi.act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
const tFrame = trimUi.host.querySelector(".text-edit-frame");
const tText = trimUi.host.querySelector(".text-edit");
const tLh = effectiveLineHeight(trimmed) * 1;
const tA = INTER.ascent * trimmed.fontSize, tD = INTER.descent * trimmed.fontSize, tTn = INTER.top * trimmed.fontSize;
const tDomBaseline = parseFloat(tFrame.style.top) + parseFloat(tText.style.top || "0") + parseFloat(tText.style.paddingTop || "0") + cssFirstBaseline(tA, tD, tLh);
t("trimmed row: DOM baseline == the painted row's baseline",
  Math.abs(tDomBaseline - (tPaintedRow + tTn)) < 1e-6, `${tDomBaseline} vs ${tPaintedRow + tTn}`);
await trimUi.close();
cssNode.remove();
if (priorFonts) Object.defineProperty(document, "fonts", priorFonts);
else delete document.fonts;
