/**
 * F5 parity pin (BEHAVIOR_OUTPUT_PARITY_AUDIT_2026-10-04.md): Auto line
 * height must follow *the font's* metrics, never a constant.
 * https://help.figma.com/hc/en-us/articles/360039956634 §Line height:
 *   "By default, line height is set to Auto. This is calculated using the
 *    font's default line height, which varies between typefaces."
 *
 * FAILING BY DESIGN until the fix lands: `effectiveLineHeight`
 * (apps/web/src/ui/textLayout.ts:82-88) must return
 * `fontBoundingBoxAscent + fontBoundingBoxDescent` from the per-node
 * `textMetrics` that memory.ts already stamps (:249-258, :3048-3057),
 * rescaled by `fontSize / textMetrics.fontSize` for larger spans, with the
 * current `1.2 * fontSize` kept ONLY as the no-metrics fallback. When the
 * fix lands, append to apps/web/package.json's `npm test` chain:
 *   && vite-node src/ui/__tests__/lineHeightMetrics.test.mjs
 *
 * Sabotage ledger (each entry must catch at least one assertion):
 *   auto branch reverted to the constant            -> "per-font box wins"
 *   ink box (actualBoundingBox*) used for the box   -> "font box, not ink box"
 *   span sizes not rescaled off the recorded em     -> "bigger span rescales"
 *   fallback deleted (jsdom/SSR return NaN/0)       -> "no metrics ... 1.2"
 *   metrics applied to explicit px/% paths too      -> "explicit px wins"
 *   a second 1.2 constant appears in a consumer     -> "no second constant"
 *   the SVG text block keeps its inline `n.lineHeight || fs * 1.2`
 *     (svgExport.ts:443 - also drops the unit, so percent leaks raw px
 *      into dy)                                        -> "percent line height"
 */
import { readFileSync } from "node:fs";
import { effectiveLineHeight } from "../textLayout.ts";
import { svgNode } from "../../engine/svgExport.ts";

let pass = 0;
let fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const base = { lineHeight: 0, lineHeightUnit: "auto" };
const box = { fontBoundingBoxAscent: 15.2, fontBoundingBoxDescent: 4.4, fontSize: 16 };

console.log("F5 auto line height = font default, per typeface (360039956634):");
t("no metrics: 1.2 * fontSize documented fallback", near(effectiveLineHeight({ ...base, fontSize: 16 }), 19.2));
t("per-font box wins over the constant (19.6, not 19.2)",
  near(effectiveLineHeight({ ...base, fontSize: 16, textMetrics: box }), 19.6));
t("font box, not ink box: actualBoundingBox* is ignored",
  near(effectiveLineHeight({ ...base, fontSize: 16, textMetrics: { ...box,
    actualBoundingBoxAscent: 11, actualBoundingBoxDescent: 3 } }), 19.6));
t("bigger span rescales recorded metrics (19.6 * 24/16 = 29.4)",
  near(effectiveLineHeight({ ...base, fontSize: 16, textMetrics: box }, 24), 29.4));
t("explicit px still wins",
  near(effectiveLineHeight({ ...base, fontSize: 16, lineHeight: 24, lineHeightUnit: "px", textMetrics: box }), 24));
t("explicit percent still resolves against the font size",
  near(effectiveLineHeight({ ...base, fontSize: 16, lineHeight: 150, lineHeightUnit: "percent", textMetrics: box }), 24));
t("a partial metric record never half-applies",
  near(effectiveLineHeight({ ...base, fontSize: 16, textMetrics: { fontBoundingBoxAscent: 15.2, fontSize: 16 } }), 19.2));
t("metrics recorded at another em rescale too (box at 8pt, drawn at 16)",
  near(effectiveLineHeight({ ...base, fontSize: 16,
    textMetrics: { fontBoundingBoxAscent: 7.6, fontBoundingBoxDescent: 2.2, fontSize: 8 } }), 19.6));

// Consistency guard: every consumer (paint rows, hug, SVG bake) must route
// through this one function - no second auto-height constant may appear in
// the export rasterizer.
const svg = readFileSync(new URL("../../engine/svgExport.ts", import.meta.url), "utf8");
t("no second 1.2 constant in the SVG exporter", !/(?:fontSize|fs)\s*\*\s*1\.2/.test(svg));

// F5b: the SVG text block reimplements line placement inline
// (svgExport.ts:443 `n.lineHeight || n.fontSize * 1.2`), which not only
// duplicates the auto constant but drops `lineHeightUnit` - so a 150%
// line height exports rows 150px apart. The fix must route svgTextLayout
// through `effectiveLineHeight`; these pins hold it to that.
console.log("F5b the SVG text block must share the same resolution:");
const snode = (over = {}) => ({
  id: "t1", visible: true, x: 0, y: 0, w: 200, h: 100, rotation: 0, opacity: 1,
  fill: "#111111", fillVisible: true, fillType: "solid", fillOpacity: 1,
  strokeVisible: false, strokeWidth: 0, strokePaint: "", strokeOpacity: 1,
  kind: "text", text: "a\nb", fontFamily: "Inter", fontSize: 16, fontWeight: 400,
  lineHeight: 0, letterSpacing: 0, textAlign: "left", textAlignVertical: "top",
  textDecoration: "none", textCase: "none", truncate: false, maxLines: 1,
  sizingW: "fixed", sizingH: "fixed",
  cornerRadii: [0, 0, 0, 0], overflow: "visible",
  children: [], path: [], closed: false, effects: [], ...over,
});
t("percent line height does not leak raw px into SVG dy",
  svgNode(snode({ lineHeight: 150, lineHeightUnit: "percent" })).includes('dy="24"'));
t("explicit px row advance is unchanged",
  svgNode(snode({ lineHeight: 24, lineHeightUnit: "px" })).includes('dy="24"'));

console.log(`\nlineHeightMetrics: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
