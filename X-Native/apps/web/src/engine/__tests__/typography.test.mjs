/**
 * Headless checks for §14 (typography): the shared text-measure rules (wrap,
 * gaps, truncation, indent gating), the hug-height formula, the case/indent/
 * valign/fit-lines helpers, and the SVG export text branch.
 *
 * Run with:  npx vite-node src/engine/__tests__/typography.test.mjs
 *
 * Measuring runs against a stub context (10 units a character), so what is
 * asserted is the layout arithmetic, not font rasterisation. `hugSize`
 * itself needs a DOM canvas and stays trace-verified; its formula is the
 * pure `hugHeight` covered below.
 */
import {
  applyTextCase,
  fitLineCount,
  hugHeight,
  indentOf,
  textMetrics,
  valignApplies,
} from "../../ui/textLayout.ts";
import { svgNode } from "../svgExport.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

/** 10 units a character, whatever the string. */
const mctx = () => {
  let font = "";
  return {
    set font(v) { font = v; },
    get font() { return font; },
    measureText: (s) => ({ width: String(s).length * 10 }),
  };
};

/** Minimal node; textMetrics only reads the type family plus w. */
const node = (over = {}) => ({
  w: 100,
  fontWeight: 400,
  fontSize: 16,
  fontFamily: "Inter",
  sizingW: "hug",
  sizingH: "hug",
  letterSpacing: 0,
  paragraphSpacing: 0,
  paragraphIndent: 0,
  textAlign: "left",
  textAlignVertical: "top",
  textWrap: "auto",
  listStyle: "none",
  truncate: false,
  maxLines: 1,
  ...over,
});

console.log("X-A textMetrics:");
{
  const m1 = textMetrics(mctx(), node(), "ab\ncde");
  t("auto width breaks only on Return", m1.lines === 2);
  t("maxW is the widest line", m1.maxW === 30);
  t("paragraph breaks are counted", m1.gaps === 1);
  const m2 = textMetrics(mctx(), node({ sizingW: "fixed", w: 100 }), "aa bb cc dd ee");
  t("fixed width wraps", m2.lines === 2);
  t("wrapped maxW is the longest row", m2.maxW === 80);
  const m3 = textMetrics(mctx(), node(), "a\nb\nc");
  t("three paragraphs leave two gaps", m3.lines === 3 && m3.gaps === 2);
  const m4 = textMetrics(mctx(), node({ truncate: true, maxLines: 2 }), "a\nb\nc");
  t("truncate caps the rows", m4.lines === 2);
  t("truncate keeps only surviving gaps", m4.gaps === 1);
  const m5 = textMetrics(mctx(), node({ sizingW: "fixed", w: 100, truncate: true, maxLines: 1 }), "aa bb cc dd ee");
  t("a cut mid-paragraph leaves no gap", m5.lines === 1 && m5.gaps === 0);
  const m6 = textMetrics(mctx(), node({ paragraphIndent: 15 }), "ab");
  t("left-aligned text budgets the indent", m6.maxW === 35);
  const m7 = textMetrics(mctx(), node({ paragraphIndent: 15, textAlign: "center" }), "ab");
  t("centred text ignores the indent", m7.maxW === 20);
  const m8 = textMetrics(mctx(), node({ listStyle: "bulleted" }), "ab");
  t("list rows clear the gutter", m8.maxW === 40);
  const m9 = textMetrics(mctx(), node({ truncate: true, maxLines: 1 }), "a\nb");
  t("auto-width truncation budgets the ellipsis", m9.maxW === 20 && m9.lines === 1);
}

console.log("X-B hugHeight:");
{
  t("one row is one leading", hugHeight(1, 0, 20, 0) === 20);
  t("rows stack", hugHeight(3, 2, 20, 0) === 60);
  t("paragraph gaps add on", hugHeight(3, 2, 20, 8) === 76);
  t("never shorter than one leading", hugHeight(0, 0, 20, 8) === 20);
  t("negative gaps cannot shrink the box", hugHeight(2, -5, 20, 8) === 40);
}

console.log("X-C type helpers:");
{
  t("fixed size takes vertical alignment", valignApplies(node({ sizingW: "fixed", sizingH: "fixed" })));
  t("auto width ignores it", !valignApplies(node({ sizingW: "hug", sizingH: "fixed" })));
  t("auto height ignores it", !valignApplies(node({ sizingW: "fixed", sizingH: "hug" })));
  t("fill counts as fixed", valignApplies(node({ sizingW: "fill", sizingH: "fill" })));
  t("indent takes on the left", indentOf(node({ paragraphIndent: 12 })) === 12);
  t("indent ignored when centred", indentOf(node({ paragraphIndent: 12, textAlign: "center" })) === 0);
  t("indent ignored when justified", indentOf(node({ paragraphIndent: 12, textAlign: "justified" })) === 0);
  t("upper uppercases", applyTextCase("Abc Def", "upper") === "ABC DEF");
  t("lower lowercases", applyTextCase("Abc Def", "lower") === "abc def");
  t("title capitalises words", applyTextCase("hello world", "title") === "Hello World");
  t("small caps lowers for the variant", applyTextCase("AbC", "small-caps") === "abc");
  t("none passes through", applyTextCase("AbC", "none") === "AbC");
  t("fit count divides the box", fitLineCount(100, 20, 0) === 5);
  t("fit count honours paragraph gaps", fitLineCount(100, 20, 5) === 4);
  t("fit count floors at one", fitLineCount(100, 0, 0) === 1 && fitLineCount(0, 20, 0) === 1);
}

console.log("X-D svg export text:");
{
  const snode = (over = {}) => ({
    id: "t1", visible: true, x: 0, y: 0, w: 200, h: 100, rotation: 0, opacity: 1,
    fill: "#111111", fillVisible: true, fillType: "solid", fillOpacity: 1,
    strokeVisible: false, strokeWidth: 0, strokePaint: "", strokeOpacity: 1,
    kind: "text", text: "Abc", fontFamily: "Inter", fontSize: 16, fontWeight: 400,
    lineHeight: 20, letterSpacing: 0, textAlign: "left", textAlignVertical: "top",
    textDecoration: "none", textCase: "none", truncate: false, maxLines: 1,
    sizingW: "fixed", sizingH: "fixed",
    cornerRadii: [0, 0, 0, 0], overflow: "visible",
    children: [], path: [], closed: false, effects: [], ...over,
  });
  const sc = svgNode(snode({ textCase: "small-caps", text: "AbC" }));
  t("small caps exports the variant, not capitals", sc.includes('font-variant="small-caps"') && sc.includes(">abc<"));
  t("upper still uppercases", svgNode(snode({ textCase: "upper", text: "Abc" })).includes(">ABC<"));
  const hugMid = svgNode(snode({ sizingW: "hug", sizingH: "hug", textAlignVertical: "middle" }));
  t("hug layers ignore vertical alignment", hugMid.includes('dy="16"'));
  const fixMid = svgNode(snode({ textAlignVertical: "middle" }));
  t("fixed layers centre", fixMid.includes('dy="56"'));
  t("decoration passes through", svgNode(snode({ textDecoration: "underline" })).includes('text-decoration="underline"'));
  const trunc = svgNode(snode({ text: "a\nb\nc", truncate: true, maxLines: 2 }));
  t("truncate keeps max lines with an ellipsis", (trunc.match(/<tspan/g) || []).length === 2 && trunc.includes("…"));
}
