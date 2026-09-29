/** Text interaction regression: the edit overlay must not inset glyphs, and
 * inspector font patches must reach a real bundled Canvas2D face. The software
 * canvas records drawing requests rather than rasterizing glyph outlines.
 * Run: vite-node src/ui/__tests__/textInteraction.test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { node, find } from "../../engine/memory.ts";
import { mountCanvas } from "./softCanvas2d.mjs";
import { hugSize } from "../textLayout.ts";

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
const editCss = /\.text-edit\s*\{([^}]+)\}/.exec(style)?.[1] ?? "";
const cssNode = document.createElement("style");
cssNode.textContent = `.text-edit {${editCss}}`;
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
const ui = await mountCanvas([n]);
const live = () => find(ui.engine.snapshot().pages[ui.engine.snapshot().page].root, n.id);
const box = () => [live().x, live().y, live().w, live().h];
const lastPaint = () => ui.ctx.texts.filter((c) => c.inDoc && c.text === n.text).at(-1);
console.log("T-1 entering Auto-width text edit:");
const initial = box();
t("point text is Auto width and starts drawn by Canvas", live().sizingW === "hug" && !!lastPaint());
await ui.dispatch({ type: "select", ids: [n.id] });
await ui.act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
let overlay = ui.host.querySelector(".text-edit");
t("Enter mounts the real editor", !!overlay);
t("x/y/w/h are byte-identical on entry (0px coordinate jump)", JSON.stringify(box()) === JSON.stringify(initial), `${initial} -> ${box()}`);
t("editor stays on the layer's world origin", overlay.style.left === `${initial[0]}px` && overlay.style.top === `${initial[1]}px`);
t("editor box remains the fitted Auto-width box", overlay.style.width === `${initial[2]}px` && overlay.style.height === `${initial[3]}px`);
t("editor's border does not inset glyphs (pre-fix: 1.5px)", /border:\s*0;/.test(editCss) && parseFloat(getComputedStyle(overlay).borderLeftWidth) === 0 && parseFloat(getComputedStyle(overlay).borderTopWidth) === 0);
t("focus ring is external to the text box", /outline:\s*1\.5px solid var\(--blue\)/.test(editCss));

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
const select = async (label, value) => {
  const input = host.querySelector(`select[aria-label="${label}"]`);
  t(`${label} is available`, !!input);
  await React.act(async () => { input.value = value; input.dispatchEvent(new window.Event("change", { bubbles: true })); });
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
const fixed = node("text", "Fixed", 230, 190, 160, 50, { text: "Fixed size", sizingW: "fixed", sizingH: "fixed" });
const fixedUi = await mountCanvas([fixed]);
await fixedUi.dispatch({ type: "select", ids: [fixed.id] });
await fixedUi.act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
const fixedLive = find(fixedUi.engine.snapshot().pages[0].root, fixed.id);
t("Fixed-size edit preserves x/y/w/h", [fixedLive.x, fixedLive.y, fixedLive.w, fixedLive.h].join() === "230,190,160,50");
t("Fixed-size overlay does not grow or shift", fixedUi.host.querySelector(".text-edit")?.style.width === "160px" && fixedUi.host.querySelector(".text-edit")?.style.left === "230px");
await fixedUi.close();
cssNode.remove();
if (priorFonts) Object.defineProperty(document, "fonts", priorFonts);
else delete document.fonts;
