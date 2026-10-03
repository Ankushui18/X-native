/**
 * Run 9 - Figma parity, fills: the Pattern fill type.
 *
 * Source of truth: Figma's *Create a strawberry illustration using pattern
 * fills, vector networks, and effects* (help.figma.com/hc/en-us/articles/33025308147223):
 *  - "click the plus to add another fill and choose Pattern as the fill type.
 *    Click Select source, then select the Seed layer. Use the settings to
 *    configure the pattern: Tile type: Hexagonal, Direction: Horizontal,
 *    Scale: 100%, X spacing: 370%, Y spacing: 100%, Alignment: Center"
 *  - "Pattern fills persist even if the source layer is deleted"
 *  - "Pattern fills are dynamic. If you update the pattern's source, the
 *    pattern will automatically update on each layer where its used."
 *
 * Measured before the fix (probe, deleted): FILL_TYPES had no Pattern entry; a
 * base fill of type "pattern" painted flat base colour (r=255 g=0 b=0 at
 * (50,50), byte-identical to a solid control), a stacked one painted flat
 * green, no node field could name a source layer, and svgNode emitted
 * fill="#ff0000" with no <pattern>.
 *
 * Pixels come from the software Canvas2D in ./softCanvas2d.mjs.
 *
 * Run: vite-node src/ui/__tests__/patternFill.test.mjs
 */
import { node } from "../../engine/memory.ts";
import { FILL_TYPES } from "../color.ts";
import { patternCells, patternPeriod, patternSettings } from "../../engine/pattern.ts";
import { svgNode } from "../../engine/svgExport.ts";
import { mountCanvas } from "./softCanvas2d.mjs";

let pass = 0,
  fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? ` - ${extra}` : ""}`);
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});

/* Scene: a 10x10 red "Seed" far from the target, and a 200x100 target at
 * (100,100) whose fill repeats the seed. The page is white. */
const seed = (extra = {}) => node("rect", "Seed", 1500, 1500, 10, 10, { fill: "#ff0000", fillVisible: true, cornerRadii: [0, 0, 0, 0], ...extra });
const target = (spec, extra = {}) =>
  node("rect", "Target", 100, 100, 200, 100, {
    fill: "#00ff00",
    fillVisible: true,
    fillType: "pattern",
    pattern: spec,
    cornerRadii: [0, 0, 0, 0],
    ...extra,
  });
const isRed = (p) => p.r > 200 && p.g < 60 && p.b < 60;
const isBlue = (p) => p.b > 200 && p.r < 60 && p.g < 60;
const isWhite = (p) => p.r > 240 && p.g > 240 && p.b > 240;
/** Red/non-red string along a row, one char per px: "#" red, "." otherwise. */
const row = (ui, y, x0, x1) => {
  let s = "";
  for (let x = x0; x < x1; x++) s += isRed(ui.pixelAt(x, y)) ? "#" : ".";
  return s;
};

console.log("P-1 the fill-type menu offers Pattern:");
t("FILL_TYPES has a Pattern entry", FILL_TYPES.some((f) => f.id === "pattern" && f.label === "Pattern"));

console.log("P-2 grid tiling is periodic, not flat:");
{
  const s = seed();
  const ui = await mountCanvas([s, target({ source: s.id, spacingX: 2, spacingY: 2, align: "start" })]);
  const r = row(ui, 105, 100, 180);
  t("row y=105 alternates 10 red / 10 gap", r === "##########..........".repeat(4), r);
  t("the gap row y=115 has no tile", row(ui, 115, 100, 180) === ".".repeat(80));
  t("the base colour (green) is never painted flat", (({ r, g }) => !(g > 200 && r < 60))(ui.pixelAt(115, 115)));
  t("tiles clip to the layer box", isWhite(ui.pixelAt(305, 105)));
  await ui.close();
}

console.log("P-3 scale and spacing change the period:");
{
  const s = seed();
  const ui = await mountCanvas([s, target({ source: s.id, scale: 2, spacingX: 2, spacingY: 2, align: "start" })]);
  const r = row(ui, 105, 100, 180);
  t("scale 200% → 20px tiles every 40px", r === ("#".repeat(20) + ".".repeat(20)).repeat(2), r);
  await ui.close();
  const s2 = seed();
  const ui2 = await mountCanvas([s2, target({ source: s2.id, spacingX: 1.5, spacingY: 2, align: "start" })]);
  const r2 = row(ui2, 105, 100, 160);
  t("X spacing 150% → 10px tiles every 15px", r2 === ("#".repeat(10) + ".".repeat(5)).repeat(4), r2);
  await ui2.close();
}

console.log("P-4 hexagonal tiling offsets alternate rows / columns:");
{
  const s = seed();
  const ui = await mountCanvas([s, target({ source: s.id, tile: "hex", direction: "horizontal", spacingX: 2, spacingY: 1, align: "start" })]);
  const r0 = row(ui, 105, 100, 140);
  const r1 = row(ui, 115, 100, 140);
  t("row 0 starts on the edge", r0 === "##########..........##########..........", r0);
  t("row 1 is shifted by half a step (10px)", r1 === "..........##########..........##########", r1);
  await ui.close();
  const s2 = seed();
  const ui2 = await mountCanvas([s2, target({ source: s2.id, tile: "hex", direction: "vertical", spacingX: 1, spacingY: 2, align: "start" })]);
  t("vertical: column 0 tile at y=105", isRed(ui2.pixelAt(105, 105)));
  t("vertical: column 1 empty at y=105", !isRed(ui2.pixelAt(115, 105)));
  t("vertical: column 1 tile at y=115 (half-step down)", isRed(ui2.pixelAt(115, 115)));
  await ui2.close();
}

console.log("P-5 alignment anchors the lattice:");
{
  const p = patternSettings({ spacingX: 2, spacingY: 2, align: "center" });
  const per = patternPeriod(p, 10, 10, 200, 100);
  t("center puts a tile at the box centre", per.ox === 95 && per.oy === 45, JSON.stringify(per));
  const s = seed();
  const ui = await mountCanvas([s, target({ source: s.id, spacingX: 2, spacingY: 2, align: "center" })]);
  t("center: pixel at the box centre (200,150) is a tile", isRed(ui.pixelAt(200, 150)));
  t("center: (100,100) corner is a gap (lattice shifted)", !isRed(ui.pixelAt(100, 100)));
  await ui.close();
  const end = patternPeriod(patternSettings({ align: "end" }), 10, 10, 200, 100);
  t("end anchors the last tile flush right/bottom", end.ox === 190 && end.oy === 90);
  const cells = patternCells(per, 200, 100);
  t("lattice covers the box", cells.some((c) => c.x <= 0) && cells.some((c) => c.x + 10 >= 200));
}

console.log("P-6 dynamic: editing the source repaints the pattern:");
{
  const s = seed();
  const tg = target({ source: s.id, spacingX: 2, spacingY: 2, align: "start" });
  const ui = await mountCanvas([s, tg]);
  t("before: red tile", isRed(ui.pixelAt(105, 105)));
  await ui.dispatch({ type: "patch", id: s.id, patch: { fill: "#0000ff" } });
  t("after recolouring the source: blue tile", isBlue(ui.pixelAt(105, 105)), JSON.stringify(ui.pixelAt(105, 105)));
  await ui.close();
}

console.log("P-7 persists if the source is deleted (snapshot):");
{
  const s = seed();
  const snap = JSON.parse(JSON.stringify(s));
  const tg = target({ source: s.id, snapshot: snap, spacingX: 2, spacingY: 2, align: "start" });
  const ui = await mountCanvas([s, tg]);
  await ui.dispatch({ type: "select", ids: [s.id] });
  await ui.dispatch({ type: "delete" });
  const gone = !ui.engine.snapshot().pages[0].root.children.some((c) => c.id === s.id);
  t("source is gone from the document", gone);
  const r = row(ui, 105, 100, 140);
  t("pattern still tiles from the snapshot", r === "##########..........##########..........", r);
  await ui.close();
}

console.log("P-8 no source never pretends with a flat colour:");
{
  const ui = await mountCanvas([target({})]);
  t("unset source paints nothing (page white shows)", isWhite(ui.pixelAt(150, 150)), JSON.stringify(ui.pixelAt(150, 150)));
  await ui.close();
}

console.log("P-9 a stacked Pattern fill tiles too:");
{
  const s = seed();
  const tg = node("rect", "Stack", 100, 100, 200, 100, {
    fill: "#ffffff",
    fillVisible: true,
    cornerRadii: [0, 0, 0, 0],
    fills: [{ type: "pattern", color: "#00ff00", opacity: 1, visible: true, pattern: { source: s.id, spacingX: 2, spacingY: 2, align: "start" } }],
  });
  const ui = await mountCanvas([s, tg]);
  const r = row(ui, 105, 100, 140);
  t("stacked pattern alternates", r === "##########..........##########..........", r);
  t("stacked pattern never paints flat green", ui.pixelAt(115, 105).g > 240 && ui.pixelAt(115, 105).r > 240);
  await ui.close();
}

console.log("P-10 SVG export emits a real <pattern>:");
{
  const s = seed();
  const tg = target({ source: "missing", snapshot: JSON.parse(JSON.stringify(s)), tile: "hex", spacingX: 3.7, spacingY: 1 });
  const svg = svgNode(tg, true);
  t("has a <pattern> def", /<pattern id="[^"]+" patternUnits="userSpaceOnUse"/.test(svg), svg.slice(0, 200));
  t("shape paints url(#…-pattern)", /fill="url\(#[^"]+-pattern\)"/.test(svg));
  t("hex doubles the cell height (2 × Y step)", /height="20"/.test(svg));
  t("source colour is inside the pattern", /<pattern[^]*#ff0000[^]*<\/pattern>/i.test(svg));
  t("no flat base colour leaks", !svg.includes("#00ff00"));
  const none = svgNode(target({}), true);
  t("no source → fill none, no pattern", !none.includes("<pattern") && !none.includes("#00ff00"));
}

console.log("P-11 the picker offers Pattern and its settings:");
{
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = React;
  const { FillPicker } = await import("../FillPicker.tsx");
  const s = seed();
  let last = null;
  let value = { color: "#d9d9d9", opacity: 100, type: "solid", second: "#ffffff", blend: "normal" };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = () =>
    root.render(
      React.createElement(FillPicker, {
        title: "Fill",
        value,
        recents: [],
        anchor: { left: 400, top: 100, bottom: 120, right: 420, width: 20, height: 20 },
        patternSources: [{ id: s.id, name: "Seed", node: s }],
        onChange: (v) => {
          last = v;
          value = v;
          render();
        },
        onClose() {},
      }),
    );
  await act(async () => render());
  const pop = () => document.body.querySelector(".fill-pop");
  await act(async () => pop().querySelector(".type-btn").click());
  const items = [...pop().querySelectorAll(".type-menu button")].map((b) => b.textContent.replace("✓", "").trim());
  t("type menu lists Pattern", items.includes("Pattern"), items.join(","));
  await act(async () => [...pop().querySelectorAll(".type-menu button")].find((b) => b.textContent.includes("Pattern")).click());
  t("choosing it sets type pattern", last?.type === "pattern");
  const labels = [...pop().querySelectorAll('.pattern-fill [aria-label]')].map((e) => e.getAttribute("aria-label"));
  for (const l of ["Pattern source", "Pattern tile type", "Pattern direction", "Pattern Scale", "Pattern X spacing", "Pattern Y spacing", "Pattern alignment", "Pattern opacity"])
    t(`control: ${l}`, labels.includes(l), labels.join(","));
  const sel = pop().querySelector('select[aria-label="Pattern source"]');
  await act(async () => {
    sel.value = s.id;
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  t("selecting a source stores id + snapshot", last?.pattern?.source === s.id && last?.pattern?.snapshot?.fill === "#ff0000");
  await act(async () => [...pop().querySelectorAll('[aria-label="Pattern tile type"] button')].find((b) => b.textContent.trim() === "Hexagonal").click());
  t("tile type → hex", last?.pattern?.tile === "hex" && last.pattern.source === s.id);
  await act(async () => [...pop().querySelectorAll('[aria-label="Pattern direction"] button')].find((b) => b.textContent.trim() === "Vertical").click());
  t("direction → vertical", last?.pattern?.direction === "vertical");
  const noColour = !pop().querySelector(".sv") && !pop().querySelector(".swatch-grid");
  t("colour area hidden for a pattern", noColour);
  await act(async () => root.unmount());
  host.remove();
}
