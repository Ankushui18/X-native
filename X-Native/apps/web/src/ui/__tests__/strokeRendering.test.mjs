/** Regression for acute joins, inverse-clipped outside strokes and repaint colour.
 * The software canvas rasterizes rectangular bands; vector joins are recorded
 * as Canvas2D state plus the exact 10° miter geometry, NOT browser glyph pixels.
 * Run: vite-node src/ui/__tests__/strokeRendering.test.mjs */
import { node, find } from "../../engine/memory.ts";
import { mountCanvas } from "./softCanvas2d.mjs";
import { strokeCanvasMiterLimit } from "../../engine/paint.ts";

let pass = 0, fail = 0;
const t = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` - ${detail}`}`);
  ok ? pass++ : fail++;
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});
const theta = 10 * Math.PI / 180;
const angle = node("vector", "Acute 10°", 300, 250, 120, 120, {
  path: [
    { x: 60, y: 0 },
    { x: 60 - 100 * Math.sin(theta / 2), y: 100 * Math.cos(theta / 2) },
    { x: 60 + 100 * Math.sin(theta / 2), y: 100 * Math.cos(theta / 2) },
  ],
  closed: true, fillVisible: false, fill: "#00000000", strokeVisible: true,
  strokePaint: "#000000", strokeWidth: 20, strokeAlign: "center", strokeJoin: "miter",
});
const sharp = await mountCanvas([angle]);
const sharpStroke = () => sharp.ctx.strokes.filter((s) => s.inDoc && s.width === 20 && s.join === "miter").at(-1);
const requiredRatio = 1 / Math.sin(theta / 2);
t("10° corner requires miter ratio 11.47 to draw a 114.74px spike", Math.abs(requiredRatio - 11.473713245669856) < 1e-8 && Math.abs(10 * requiredRatio - 114.73713245669856) < 1e-8);
t("default 20px acute join records Canvas miter limit 4 (bevel, no >4× half-width spike)", sharpStroke()?.miterLimit === 4 && requiredRatio > sharpStroke().miterLimit, JSON.stringify(sharpStroke()));
await sharp.dispatch({ type: "patch", id: angle.id, patch: { strokeMiterAngle: 30 } });
t("explicit 30° bevel threshold remains configurable", Math.abs(sharpStroke()?.miterLimit - 1 / Math.sin(Math.PI / 12)) < 1e-9, JSON.stringify(sharpStroke()));
await sharp.dispatch({ type: "patch", id: angle.id, patch: { strokeMiterAngle: 0 } });
t("explicit zero uses safe default, not an unbounded miter", sharpStroke()?.miterLimit === 4);
t("missing angle uses safe default", strokeCanvasMiterLimit(undefined) === 4);
await sharp.close();

const shape = node("rect", "Transparent border", 100, 100, 200, 100, {
  cornerRadii: [0,0,0,0], fillVisible: false, fill: "#00000000",
  strokeVisible: true, strokeWidth: 20, strokePaint: "#000000", strokeAlign: "outside",
});
const ui = await mountCanvas([shape]);
const box = () => { const n = find(ui.engine.snapshot().pages[0].root, shape.id); return [n.x, n.y, n.w, n.h]; };
const initialBox = box();
const rgb = (x, y = 150) => { const { r, g, b } = ui.pixelAt(x, y); return [r, g, b]; };
const black = (x) => rgb(x).every((v) => v < 20);
const white = (x) => rgb(x).every((v) => v > 240);
const red = (x) => { const [r,g,b] = rgb(x); return r > 240 && g < 20 && b < 20; };
t("Outside 20px fills x=80–99 only, not x=79 or any x=100–119 inside", [80,89,99].every(black) && [79,100,109,119,120].every(white), JSON.stringify([79,80,99,100,109,119,120].map((x) => [x,rgb(x)])));
t("Outside does not expand stored x/y/w/h", JSON.stringify(box()) === JSON.stringify([100,100,200,100]));
await ui.dispatch({ type: "patch", id: shape.id, patch: { strokeAlign: "inside" } });
t("Inside is strictly inside the same stable box", [100,109,119].every(black) && [99,120].every(white) && JSON.stringify(box()) === JSON.stringify(initialBox));
await ui.dispatch({ type: "patch", id: shape.id, patch: { strokeAlign: "center" } });
t("Center spans ten pixels either side", [90,99,100,109].every(black) && [89,110].every(white));
await ui.dispatch({ type: "patch", id: shape.id, patch: { strokeAlign: "outside" } });

// The real Inspector dispatches both alignment and color; verify painting
// after React's controlled controls update the engine, not just raw patches.
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { RightPanel } = await import("../inspector.tsx");
const { ThemeProvider } = await import("../theme.tsx");
await ui.dispatch({ type: "select", ids: [shape.id] });
function Panel() {
  const snap = React.useSyncExternalStore((cb) => ui.engine.subscribe(cb), () => ui.engine.snapshot());
  return React.createElement(ThemeProvider, null, React.createElement(RightPanel, { engine: ui.engine, snap }));
}
const host = document.createElement("div"); document.body.appendChild(host);
const root = createRoot(host);
await React.act(async () => root.render(React.createElement(Panel)));
const align = host.querySelector('select[aria-label="Stroke alignment"]');
t("Inspector offers Outside for this rectangle", align?.value === "outside");
await React.act(async () => { align.value = "inside"; align.dispatchEvent(new window.Event("change", { bubbles: true })); });
t("Inspector alignment patches paint and keeps the box stable", find(ui.engine.snapshot().pages[0].root, shape.id).strokeAlign === "inside" && white(99) && black(110) && JSON.stringify(box()) === JSON.stringify(initialBox));
const hex = host.querySelector('input[aria-label="Stroke colour hex"]');
t("Inspector has the stroke colour input", !!hex);
await React.act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(hex, "FF0000");
  hex.dispatchEvent(new window.Event("input", { bubbles: true }));
  hex.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const live = find(ui.engine.snapshot().pages[0].root, shape.id);
const latest = ui.ctx.strokes.filter((s) => s.inDoc && s.width === 40).at(-1);
t("Inspector stores red; painter sets exact rgba(255,0,0,1)", live.strokePaint === "#FF0000" && latest?.color === "rgba(255,0,0,1)", JSON.stringify(latest));
t("previous black band does not ghost after red repaint", [109,115,119].every(red) && JSON.stringify(box()) === JSON.stringify(initialBox), JSON.stringify([99,100,103,109,115,119].map((x) => [x,rgb(x)])));
await React.act(async () => root.unmount()); host.remove(); await ui.close();

const extra = node("rect", "Extra outside stroke", 100,100,200,100, {
  fillVisible: false, fill: "#00000000", strokeVisible: false, strokeWidth: 0,
  cornerRadii: [0,0,0,0], strokes: [{ color: "#00ff00", visible: true, opacity: 1, width: 20, align: "outside", join: "miter" }],
});
const extraUi = await mountCanvas([extra]);
const ePixel = (x) => extraUi.pixelAt(x, 150);
t("stacked Outside stroke also excludes the shape interior", ePixel(90).g > 240 && ePixel(110).r > 240 && ePixel(110).g > 240 && extraUi.ctx.strokes.some((s) => s.inDoc && s.miterLimit === 4));
await extraUi.close();
