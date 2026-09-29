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
  listCounters,
  listLayout,
  textMetrics,
  valignApplies,
} from "../../ui/textLayout.ts";
import { balanceLines } from "../geometry.ts";
import { svgNode } from "../svgExport.ts";
import { MemoryEngine, find } from "../memory.ts";
import { styleTextRange } from "../../ui/textSpans.ts";

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
  // Hanging lists (360040449773: "move bullet points or numbers of each list
  // item outside of the bounding box. This aligns text content with the
  // bounding box") - the marker hangs outside, so the box hugs the text alone.
  t("list rows hug the text with the marker hanging outside", m8.maxW === 20);
  const m8b = textMetrics(mctx(), node({ listStyle: "bulleted", hangingLists: false }), "ab");
  t("hangingLists:false clears the marker gutter instead", m8b.maxW === 40);
  const m9 = textMetrics(mctx(), node({ truncate: true, maxLines: 1 }), "a\nb");
  t("auto-width truncation budgets the ellipsis", m9.maxW === 20 && m9.lines === 1);
}

console.log("X-A2 list counters:");
{
  const lv = (lvls, plist) => {
    const n = node({ listStyle: "numbered", listLevels: lvls, ...(plist ? { paraList: plist } : {}) });
    const cs = listCounters(n, lvls.length);
    return lvls.map((_, i) => listLayout(n, i, cs[i], (s) => s.length * 10).marker);
  };
  // Counter rotation (360040449773): numbered → lettered → roman as the
  // nesting deepens, resetting at every third level.
  t("level 0 counts numbers", JSON.stringify(lv([0, 0, 0])) === JSON.stringify(["1.", "2.", "3."]));
  t("level 1 rotates to letters", JSON.stringify(lv([1, 1, 1])) === JSON.stringify(["a.", "b.", "c."]));
  t("level 2 rotates to roman", JSON.stringify(lv([2, 2, 2])) === JSON.stringify(["i.", "ii.", "iii."]));
  t("level 3 wraps back to numbers", JSON.stringify(lv([3, 3])) === JSON.stringify(["1.", "2."]));
  // Backspace at the item start deletes the counter without changing the
  // indent - the item stays levelled but is not counted.
  t("a deleted counter skips the number", JSON.stringify(lv([0, 0, 0], [0, null, 0])) === JSON.stringify(["1.", "", "2."]));
}

console.log("X-A3 pretty tail:");
{
  const widthOf = (s) => s.length;
  // Pretty (360039956634): "adjusts the last four lines of a paragraph" -
  // the head keeps its natural wrap; only the last ≤4 lines are re-flowed,
  // and a single-word last line is never left stranded.
  const natural = ["one two three four five", "six seven", "eight nine", "ten", "tiny"];
  const pretty = balanceLines(natural, 23, widthOf, "pretty");
  t("pretty keeps the natural head", pretty[0] === "one two three four five");
  t("pretty rescues a stranded last word", pretty[pretty.length - 1].split(" ").length >= 2);
  t("pretty keeps every word", pretty.join(" ").split(/\s+/).length === natural.join(" ").split(/\s+/).length);
  t("pretty never overflows", pretty.every((l) => widthOf(l) <= 23));
  // The window is the last FOUR lines: lines beyond it never move.
  const long = ["keep me", "a b c", "d e f", "g h i", "j k l", "tail word"];
  const pretty2 = balanceLines(long, 10, widthOf, "pretty");
  t("pretty leaves lines outside the window alone", pretty2[0] === "keep me" && pretty2[1] === "a b c");
  t("pretty still rescues inside the window", pretty2[pretty2.length - 1].split(" ").length >= 2);
  t("pretty keeps every word of a long paragraph", pretty2.join(" ").split(/\s+/).length === long.join(" ").split(/\s+/).length);
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

console.log("X-E text styles (360039957034):");
{
  const e = new MemoryEngine(false);
  const at = (id) => find(e.snapshot().pages[e.snapshot().page].root, id);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 200, h: 40 });
  const id = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id, patch: { text: "Hello world", fontSize: 16, fontWeight: 400, lineHeight: 20 } });
  const n0 = at(id);
  e.dispatch({ type: "createStyle", kind: "text", name: "Body" });
  const st = e.snapshot().styles.find((s) => s.name === "Body");
  t("createStyle makes a text style with captured properties", !!st && st.kind === "text" &&
    st.text?.fontSize === 16 && st.text?.fontFamily === n0.fontFamily && st.text?.lineHeight === 20);
  t("createStyle binds the layer", at(id).textStyle === st.id);
  t("a text style carries no colour", st.color === undefined);

  // Whole-layer application copies the properties and binds layer + runs.
  e.dispatch({ type: "add", kind: "text", x: 0, y: 100, w: 200, h: 40 });
  const id2 = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: id2, patch: { text: "Second layer", fontSize: 8, textRuns: [{ start: 0, end: 6, fontSize: 8 }, { start: 6, end: 12 }] } });
  e.dispatch({ type: "applyStyle", kind: "text", styleId: st.id });
  const n2 = at(id2);
  t("applyStyle re-types the layer", n2.textStyle === st.id && n2.fontSize === 16);
  t("applyStyle re-types every run", n2.textRuns.every((r) => r.textStyle === st.id && r.fontSize === 16));

  // Range application: the caller merges the style into the range's runs.
  e.dispatch({ type: "add", kind: "text", x: 0, y: 200, w: 200, h: 40 });
  const id3 = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: id3, patch: { text: "Hello world", fontSize: 8 } });
  const runs = styleTextRange(at(id3), 0, 6, { fontSize: 8, textStyle: st.id });
  e.dispatch({ type: "applyStyle", kind: "text", styleId: st.id, runs });
  const n3 = at(id3);
  t("range application binds only the range's runs",
    n3.textRuns.length === 2 && n3.textRuns[0].textStyle === st.id && n3.textRuns[1].textStyle === undefined);
  t("range application leaves the layer unbound", n3.textStyle === undefined);

  // Edit propagation reaches whole layers and range-bound runs alike.
  e.dispatch({ type: "editStyle", id: st.id, text: { fontSize: 22 } });
  const n4 = at(id), n5 = at(id3);
  t("edit propagation re-types bound layers", n4.fontSize === 22);
  t("edit propagation re-types range-bound runs", n5.textRuns[0].fontSize === 22 && n5.textRuns[0].textStyle === st.id);
  t("edit propagation leaves unbound runs alone", n5.textRuns[1].fontSize === 8);

  // Detach keeps the type properties; only the link goes away.
  e.dispatch({ type: "select", ids: [id] });
  e.dispatch({ type: "detachStyle", kind: "text" });
  const n6 = at(id);
  t("detachStyle keeps the type properties", n6.fontSize === 22);
  t("detachStyle drops the binding", n6.textStyle === undefined);
}
