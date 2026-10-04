/**
 * F2 parity pin (BEHAVIOR_OUTPUT_PARITY_AUDIT_2026-10-04.md): the exported
 * area must expand to contain effect bleed. Figma enlarges the export canvas
 * so a drop shadow / layer blur / outside stroke past the layer box survives
 * in the file; this app's own Rust renderer already inflates by 1.5 * blur
 * (crates/x-render/src/ir.rs:730, 762, 1667) - the web tiers must mirror the
 * same convention so both agree.
 *
 * FAILING BY DESIGN until the fix lands: apps/web/src/ui/exportModel.ts must
 * export `exportBleed(node) -> {l,t,r,b}` (per side = max over visible
 * effects of `1.5 * blur + max(0, offset)`; outside strokes add their width;
 * inner shadows and background blur bleed nothing) and fold it into
 * `exportSize` (before scale multiplication, on all formats including the
 * 1x-pinned SVG/PDF), which svgExport's viewBox and the inspector raster
 * canvas then consume. When the fix lands, append to the `npm test` chain:
 *   && vite-node src/ui/__tests__/exportBleedParity.test.mjs
 *
 * Sabotage ledger (each entry must catch at least one assertion):
 *   bleed dropped again (margin 0)              -> per-side size pins
 *   inner shadow made to bleed                  -> "inner shadow is contained"
 *   background blur made to bleed               -> "background blur bleeds nothing"
 *   hidden effects counted                      -> "invisible effects ignored"
 *   two shadows summed instead of maxed         -> "max, not sum"
 *   outside stroke ignored                      -> "outside stroke pads all sides"
 *   bleed skipped on the 1x vector pin          -> "SVG ... expands too"
 *   chip/scale math applies bleed after 500w    -> "500w keeps the aspect"
 */
import { exportSize } from "../exportModel.ts";

let pass = 0;
let fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

// `exportBleed` is the new half of the fix. Stub it as throwing until it
// exists so every assertion fails with a reason instead of the file dying
// on import.
const model = await import("../exportModel.ts");
const bleed = typeof model.exportBleed === "function"
  ? model.exportBleed
  : () => { throw new Error("exportBleed() not exported yet (F2 fix pending)"); };

const fx = (over = {}) => ({ effects: [over] });
const shadow = { kind: "drop-shadow", x: 0, y: 4, blur: 10, spread: 0, color: "#00000040", visible: true };

console.log("F2 export bleed (per side = 1.5 * blur + offset, outside stroke width):");
try {
  let b = bleed({ w: 100, h: 100, effects: [] });
  t("bare layer bleeds nothing", b.l === 0 && b.t === 0 && b.r === 0 && b.b === 0);

  b = bleed(fx({ ...shadow, kind: "inner-shadow" }));
  t("inner shadow is contained by the layer", b.l === 0 && b.t === 0 && b.r === 0 && b.b === 0);

  b = bleed(fx({ kind: "background-blur", x: 0, y: 0, blur: 24, color: "#000", visible: true }));
  t("background blur bleeds nothing", b.l === 0 && b.t === 0 && b.r === 0 && b.b === 0);

  b = bleed(fx({ ...shadow, visible: false }));
  t("invisible effects are ignored", b.b === 0);

  b = bleed(fx({ ...shadow, kind: "layer-blur", x: 0, y: 0 }));
  t("layer blur 10 pads all sides by 1.5 * 10 = 15", b.l === 15 && b.t === 15 && b.r === 15 && b.b === 15);

  b = bleed(fx(shadow));
  t("drop shadow dy 4 blur 10 pads asymmetrically", b.t === 11 && b.b === 19 && b.l === 15 && b.r === 15);

  b = bleed({ effects: [{ ...shadow, y: 4 }, { ...shadow, y: -7, blur: 4 }] });
  t("two shadows: per side takes the max, not the sum", b.b === 19 && b.t === 13 && b.l === 15 && b.r === 15);

  // Real node shape: the base stroke lives in the scalar strokeWidth /
  // strokeAlign fields; `strokes` layers paint on top of it.
  b = bleed({ w: 100, h: 100, effects: [], strokeWidth: 6, strokeAlign: "outside" });
  t("outside stroke of 6 pads all sides", b.l === 6 && b.t === 6 && b.r === 6 && b.b === 6);

  b = bleed({ w: 100, h: 100, effects: [], strokeWidth: 6, strokeAlign: "inside" });
  t("inside stroke pads nothing", b.l === 0 && b.r === 0);

  b = bleed({ w: 100, h: 100, effects: [], strokeWidth: 6, strokeAlign: "outside",
    strokes: [{ color: "#000", opacity: 1, visible: true, width: 10, align: "outside" }] });
  t("the widest extra outside stroke wins", b.l === 10 && b.b === 10);

  const spread = bleed({ w: 100, h: 100, effects: [shadow],
    strokeWidth: 6, strokeAlign: "outside" });
  t("shadow and outside stroke stack", spread.b === 19 + 6 && spread.t === 11 + 6 && spread.l === 15 + 6);
} catch (e) {
  fail++;
  console.log("  FAIL exportBleed: " + e.message);
}

console.log("F2 exportSize folds the bleed in before scale:");
let s = exportSize({ w: 100, h: 100, effects: [] }, { format: "PNG", scale: 2 });
t("plain layer at 2x stays 2x the box", s.width === 200 && s.height === 200);
// Non-square on purpose: a 130x130 box would make the 500w aspect pin
// pass by coincidence even with bleed dropped on one axis.
const shadowed = { w: 120, h: 100, effects: [shadow] }; // bleed l/r 15+15, t/b 11+19
s = exportSize(shadowed, { format: "PNG", scale: 1 });
t("shadowed 120x100 exports 150x130", s.width === 150 && s.height === 130);
s = exportSize(shadowed, { format: "PNG", scale: "500w" });
t("500w keeps the bleed-inclusive aspect", s.width === 500 && s.height === Math.round((130 * 500) / 150));
s = exportSize(shadowed, { format: "SVG", scale: 2 });
t("SVG stays pinned at 1x but still expands for bleed", s.width === 150 && s.height === 130 && s.scale === 1);

console.log(`\nexportBleedParity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
