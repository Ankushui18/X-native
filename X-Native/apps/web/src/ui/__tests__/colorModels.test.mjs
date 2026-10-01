/** Color-model picker parity tests; run with vite-node. */
import { parseCssColor } from "../color.ts";
import { installDom, mountSurface } from "./domEnv.mjs";

let pass = 0;
let fail = 0;
const t = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};
const close = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

{
  const srgb = parseCssColor("color(srgb 1 0 0 / 50%)");
  t("CSS sRGB space notation parses channels and percentage alpha", !!srgb && srgb.r === 255 && srgb.g === 0 && srgb.b === 0 && srgb.a === 0.5, JSON.stringify(srgb));

  const p3Gray = parseCssColor("color(display-p3 0.5 0.5 0.5 / 0.25)");
  t("Display P3 converts to the equivalent clipped sRGB value", !!p3Gray && close(p3Gray.r, 128) && close(p3Gray.g, 128) && close(p3Gray.b, 128) && p3Gray.a === 0.25, JSON.stringify(p3Gray));

  const labRed = parseCssColor("oklab(0.627955 0.224863 0.125846 / 0.5)");
  t("OKLAB converts to sRGB while preserving alpha", !!labRed && labRed.r >= 254 && labRed.g <= 1 && labRed.b <= 1 && labRed.a === 0.5, JSON.stringify(labRed));

  const lchRed = parseCssColor("oklch(0.627955 0.257683 29.2339deg)");
  t("OKLCH angle notation converts to the same sRGB red", !!lchRed && lchRed.r >= 254 && lchRed.g <= 1 && lchRed.b <= 1 && lchRed.a === 1, JSON.stringify(lchRed));

  t("unsupported or malformed CSS color notation remains rejected", parseCssColor("color(nope 1 0 0)") === null);
}

installDom();
{
  const React = await import("react");
  const ui = await mountSurface("inspector", { layer: "rect" });
  await ui.click(ui.one(".color-row .swatch"));
  const picker = () => ui.document.body.querySelector('.fill-pop[aria-label="Fill"]');
  const model = picker()?.querySelector('select[aria-label="Color model"]');
  t("color picker exposes all five models in a direct selector", !!model &&
    [...model.options].map((option) => option.value).join(",") === "hex,rgb,css,hsl,hsb", model?.innerHTML);

  const before = ui.node().fill;
  await React.act(async () => {
    model.value = "hsl";
    model.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  });
  t("selecting a model updates notation without changing the paint", model.value === "hsl" && ui.node().fill === before);

  await React.act(async () => {
    model.value = "css";
    model.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  });
  t("CSS selection opens the editable CSS notation field", model.value === "css" && !!picker()?.querySelector(".css-field"));
  const cssField = picker()?.querySelector(".css-field");
  await ui.type(cssField, "color(srgb 1 0 0 / 0.5)");
  t("modern CSS notation updates the paint color and separate opacity", ui.node().fill === "#ff0000" && Math.abs((ui.node().fillOpacity ?? 1) - 0.5) < 0.01, JSON.stringify({ fill: ui.node().fill, opacity: ui.node().fillOpacity }));
  await ui.unmount();
}

console.log(`color models: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
