/** Pattern stroke integration: pixel raster of rectangular stroke bands, SVG,
 * and the existing stroke FillPicker. Run with vite-node.
 * Baseline sabotage from the pre-fix audit: a green `strokePaint` with pattern
 * metadata requested solid green; a literal `strokePaint: "pattern"` requested
 * black and exported an invalid #attern. The regression assertions below
 * require actual red tiles, transparent gaps and no fallback colour.
 */
import { node } from "../../engine/memory.ts";
import { svgNode } from "../../engine/svgExport.ts";
import { mountCanvas } from "./softCanvas2d.mjs";

let pass = 0, fail = 0;
function t(label, condition, detail = "") {
  if (condition) pass++;
  else fail++;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${!condition ? ` ${detail}` : ""}`);
}
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});
const src = node("rect", "Red tile", 1500, 1500, 10, 10, { fill: "#ff0000", cornerRadii: [0, 0, 0, 0] });
const spec = (scale = 1) => ({ source: "deleted", snapshot: { ...src, x: 0, y: 0 }, scale, spacingX: 2, spacingY: 2, align: "start" });
const rect = (extra = {}) => node("rect", "Border", 100, 100, 200, 100, {
  fillVisible: false, fill: "#00000000", strokeVisible: true, strokeWidth: 10,
  strokeAlign: "center", strokePaint: "#00ff00", cornerRadii: [0, 0, 0, 0], ...extra,
});
const red = (p) => p.r > 220 && p.g < 50 && p.b < 50;
const white = (p) => p.r > 240 && p.g > 240 && p.b > 240;
const green = (p) => p.g > 220 && p.r < 50;
const row = (ui, y, x0, x1) => Array.from({ length: x1 - x0 }, (_, i) => red(ui.pixelAt(x0 + i, y)) ? "#" : ".").join("");

console.log("Baseline sabotage: pre-fix strokePaint accepted only a colour string:");
{
  const n = rect({ pattern: spec(), strokeType: "solid" });
  const ui = await mountCanvas([n]);
  t("pattern metadata on a solid stroke draws flat green, NOT tiles", green(ui.pixelAt(105, 100)) && green(ui.pixelAt(115, 100)));
  t("legacy solid exports without <pattern>", !svgNode(n, true).includes("<pattern"));
  await ui.close();
  const bad = rect({ strokePaint: "pattern", pattern: spec() });
  const b = await mountCanvas([bad]);
  t("pre-fix literal 'pattern' requests black", b.ctx.strokes.some((s) => s.inDoc && s.color === "rgba(0,0,0,1)"));
  t("pre-fix literal exports invalid #attern", svgNode(bad, true).includes('stroke="#attern"'));
  await b.close();
}

console.log("Patterned 10px band: both path directions and the miter corner:");
{
  const n = rect({ strokeType: "pattern", strokePattern: spec() });
  const ui = await mountCanvas([n]);
  const top = row(ui, 100, 100, 180);
  t("10px top edge repeats 10 red / 10 gap", top === "##########..........".repeat(4), top);
  t("right edge has tile and gap as y changes", red(ui.pixelAt(300, 105)) && white(ui.pixelAt(300, 115)));
  t("miter corner is covered", red(ui.pixelAt(304, 204)));
  t("inside of ring is unpainted", white(ui.pixelAt(105, 110)));
  t("outside the 10px center band is unpainted", white(ui.pixelAt(90, 100)));
  t("no flat fallback green", !green(ui.pixelAt(115, 100)) && !green(ui.pixelAt(115, 115)));
  t("Canvas uses a repeating CanvasPattern", ui.ctx.strokes.some((s) => s.inDoc && s.color?.tile));
  await ui.close();
  const svg = svgNode(n, true);
  t("SVG contains user-space <pattern> and source colour", /<pattern[^>]+patternUnits="userSpaceOnUse"/.test(svg) && svg.includes("#ff0000"));
  t("SVG stroke references its unique pattern", /stroke="url\(#paint_[^\"]+-stroke-pattern\)"/.test(svg));
  t("SVG retains 10px width and miter join", svg.includes('stroke-width="10"') && svg.includes('stroke-linejoin="miter"'));
  t("SVG never leaks the green fallback", !svg.includes("#00ff00"));
  const xml = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`, "image/svg+xml");
  const link = xml.querySelector('path[stroke^="url(#"]')?.getAttribute("stroke")?.slice(5, -1);
  t("SVG is parseable and its stroke pattern reference resolves", !xml.querySelector("parsererror") && !!link && xml.getElementById(link)?.tagName === "pattern");
  const bevel = await mountCanvas([rect({ strokeType: "pattern", strokePattern: spec(), strokeJoin: "bevel" })]);
  t("bevel join cuts off the patterned outer corner", white(bevel.pixelAt(304, 204)) && bevel.ctx.strokes.some((s) => s.inDoc && s.join === "bevel"));
  await bevel.close();
  const rounded = await mountCanvas([rect({ strokeType: "pattern", strokePattern: spec(), strokeJoin: "round" })]);
  t("round join curves the patterned corner", white(rounded.pixelAt(304, 204)) && red(rounded.pixelAt(303, 202)));
  await rounded.close();
}

console.log("Scale, weight, alignment and source-missing fallbacks:");
{
  const ui = await mountCanvas([rect({ strokeType: "pattern", strokePattern: spec(2) })]);
  const r = row(ui, 101, 100, 180);
  t("200% scale produces 20px tile / 20px gap", r === "#".repeat(20) + ".".repeat(20) + "#".repeat(20) + ".".repeat(20), r);
  await ui.close();
  const inside = await mountCanvas([rect({ strokeType: "pattern", strokePattern: spec(), strokeAlign: "inside" })]);
  t("inside: pattern does not spill beyond path", white(inside.pixelAt(99, 102)) && red(inside.pixelAt(100, 102)));
  await inside.close();
  const outside = await mountCanvas([rect({ strokeType: "pattern", strokePattern: spec(), strokeAlign: "outside" })]);
  t("outside: width expands out of path", red(outside.pixelAt(304, 102)));
  await outside.close();
  const thick = await mountCanvas([rect({ strokeType: "pattern", strokePattern: { ...spec(), spacingY: 1 }, strokeWidth: 20 })]);
  t("20px weight widens the band but keeps tile pitch", red(thick.pixelAt(106, 91)) && white(thick.pixelAt(116, 91)));
  await thick.close();
  const clearSwatch = rect({ strokeType: "pattern", strokePaint: "#00000000", strokePattern: spec() });
  const clearUi = await mountCanvas([clearSwatch]);
  t("pattern works with a transparent legacy swatch", red(clearUi.pixelAt(105, 100)) &&
    /stroke-opacity="1"/.test(svgNode(clearSwatch, true)));
  await clearUi.close();
  const n = rect({ strokeType: "pattern", strokePattern: {} });
  const missing = await mountCanvas([n]);
  t("unset source never falls back to solid paint", white(missing.pixelAt(105, 100)));
  t("unset source exports stroke none", !svgNode(n, true).includes("<pattern") && !svgNode(n, true).includes("#00ff00"));
  await missing.close();
  const insideSvg = svgNode(rect({ strokeType: "pattern", strokePattern: spec(), strokeAlign: "inside" }), true);
  t("SVG inside keeps the stroke band clip", insideSvg.includes("<clipPath") && insideSvg.includes('stroke-width="20"'));
  const outsideSvg = svgNode(rect({ strokeType: "pattern", strokePattern: spec(), strokeAlign: "outside" }), true);
  t("SVG outside keeps the stroke band mask", outsideSvg.includes("<mask") && outsideSvg.includes('stroke-width="20"'));
}

console.log("Stroke picker reuses the fill pattern controls:");
{
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FillPicker } = await import("../FillPicker.tsx");
  let value = { type: "solid", color: "#00ff00", opacity: 100, second: "#ffffff", blend: "normal" };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = () => root.render(React.createElement(FillPicker, {
    title: "Stroke", stroke: true, value, patternSources: [{ id: src.id, name: src.name, node: src }],
    anchor: { left: 300, top: 100, right: 330, bottom: 120, width: 30, height: 20 }, recents: [],
    onChange(v) { value = v; render(); }, onClose() {},
  }));
  await React.act(async () => render());
  const pop = () => document.body.querySelector(".fill-pop");
  await React.act(async () => pop().querySelector(".type-btn").click());
  const options = [...pop().querySelectorAll(".type-menu button")].map((b) => b.textContent.trim());
  t("stroke offers Solid and Pattern, not unsupported paints", options.length === 2 && options.some((v) => v.includes("Pattern")));
  await React.act(async () => [...pop().querySelectorAll(".type-menu button")].find((b) => b.textContent.includes("Pattern")).click());
  t("stroke has existing source, scale, spacing and alignment controls", ["Pattern source", "Pattern Scale", "Pattern X spacing", "Pattern alignment"].every((s) => pop().querySelector(`[aria-label="${s}"]`)));
  const select = pop().querySelector('select[aria-label="Pattern source"]');
  await React.act(async () => { select.value = src.id; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
  t("picker keeps source snapshot", value.pattern?.snapshot?.fill === "#ff0000");
  await React.act(async () => root.unmount());
  host.remove();
}

console.log("Inspector persists a selected stroke pattern through the real engine:");
{
  const { mountSurface } = await import("./domEnv.mjs");
  const React = await import("react");
  let sourceId;
  const ui = await mountSurface("inspector", { layer(e) {
    e.dispatch({ type: "add", kind: "rect", x: 400, y: 400, w: 10, h: 10, extra: { fill: "#ff0000" } });
    sourceId = e.snapshot().selection[0];
    e.dispatch({ type: "add", kind: "rect", x: 100, y: 100, w: 200, h: 100,
      extra: { strokeWidth: 10, strokeVisible: true, strokePaint: "#00ff00" } });
    return e.snapshot().selection[0];
  } });
  const row = ui.one('input[aria-label="Stroke colour hex"]')?.closest(".color-row");
  t("Inspector renders the stroke swatch", !!row?.querySelector(".swatch"));
  await ui.click(row.querySelector(".swatch"));
  const pop = () => document.body.querySelector('.fill-pop[aria-label="Stroke"]');
  await ui.click(pop().querySelector(".type-btn"));
  await ui.click([...pop().querySelectorAll(".type-menu button")].find((b) => b.textContent.includes("Pattern")));
  const source = pop().querySelector('select[aria-label="Pattern source"]');
  await React.act(async () => { source.value = sourceId; source.dispatchEvent(new window.Event("change", { bubbles: true })); });
  t("stroke picker stores dedicated type, source and snapshot", ui.node().strokeType === "pattern" &&
    ui.node().strokePattern?.source === sourceId && ui.node().strokePattern?.snapshot?.fill === "#ff0000");
  t("Inspector displays Pattern as the stroke paint", ui.one('input[aria-label="Stroke colour hex"]')?.value === "Pattern");
  await ui.unmount();
}
