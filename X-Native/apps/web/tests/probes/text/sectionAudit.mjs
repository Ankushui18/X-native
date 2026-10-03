/**
 * Text-and-typography section audit (pipeline run 14 pre-fix probe).
 * Source: https://help.figma.com/hc/en-us/sections/360006606853-Text-and-typography
 *   - Guide to text in Figma Design (360039956434)
 *   - Explore text properties (360039956634)
 *   - Adjust text dimensions and resizing (27378154668951)
 *   - Create bulleted and numbered lists (360040449773)
 *   - Add links to text (360045942953)
 *   - Create and apply text styles (360039957034)
 *
 * Measures the engine/paint behaviour with real numbers. Feature-presence
 * facts (absent model fields / chords) are reported as `source` rows.
 */
import { MemoryEngine, find, node } from "../../../src/engine/memory.ts";
import { mountRealCanvas } from "../../../src/ui/__tests__/realCanvas2d.mjs";
import { listMarker, indentOf, valignApplies, hugSize, fitLineCount } from "../../../src/ui/textLayout.ts";
import { balanceLines } from "../../../src/engine/geometry.ts";

let pass = 0, fail = 0;
const out = [];
const m = (name, measured, expected) => {
  const ok = String(measured) === String(expected);
  out.push(`${ok ? "ok  " : "DIFF"} ${name}\n      measured: ${measured}\n      figma:    ${expected}`);
  if (ok) pass++; else fail++;
};
const near = (a, b, e = 0.6) => Math.abs(a - b) <= e;

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const N = (e, id) => find(rootOf(e), id);
const engine = () => new MemoryEngine(false);
const addText = (e, x, y, w, h, patch = {}) => {
  e.dispatch({ type: "add", kind: "text", x, y, w, h, text: "T", parent: rootOf(e).id });
  const id = rootOf(e).children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};

console.log("== A · Text dimensions & resizing (27378154668951) ==\n");

{
  // "When you manually change a layer's dimensions in the canvas, Figma will
  // also update the resizing property to Fixed size."
  const e = engine();
  const id = addText(e, 0, 0, 120, 40, { sizingW: "hug", sizingH: "hug" });
  e.dispatch({ type: "resize", id, x: 0, y: 0, w: 300, h: 40 });
  m("A1 manual width change flips sizingW to fixed", N(e, id).sizingW, "fixed");
  m("A2 a hug axis that was not touched stays hug", N(e, id).sizingH, "hug");
}

{
  // "It's only possible to vertically align text in text layers with a Fixed
  // Size. Layers with resizing set to Auto Width or Auto Height will ignore
  // alignment." — measured as ink centroid on real pixels.
  const mk = (sizing, valign) => ({
    text: "Hamburge", fontFamily: "Inter", fontSize: 40, fontWeight: 400,
    lineHeight: 48, textAlign: "left", textAlignVertical: valign,
    sizingW: "fixed", sizingH: sizing, fill: "#ff0000", fillVisible: true,
    strokeVisible: false, strokePaint: "#00000000",
  });
  const cases = [["fixed", "top"], ["fixed", "middle"], ["hug", "middle"]];
  const centroids = [];
  for (const [sizing, valign] of cases) {
    const t = node("text", "T", 100, 100, 300, 200, mk(sizing, valign));
    const ui = await mountRealCanvas([t]);
    const P = ui.grab();
    let sum = 0, n = 0;
    for (let y = 90; y < 310; y++) for (let x = 90; x < 410; x++) {
      const p = P(x, y);
      if (p.r > 180 && p.g < 90 && p.b < 90) { sum += y; n++; }
    }
    await ui.close();
    centroids.push(n ? sum / n : -1);
  }
  const dMid = centroids[1] - centroids[0];
  m("A3 vertical-middle lifts ink by (box−block)/2 = 76px in a Fixed box",
    `top ${centroids[0].toFixed(1)} → middle ${centroids[1].toFixed(1)} (Δ ${dMid.toFixed(1)})`, "Δ≈76");
  m("A4 the same setting on Auto-height is IGNORED (ink stays at the hug top)",
    centroids[2] < centroids[0] + 20 ? "top-anchored (Δ<20 from fixed-top)" : `moved ${centroids[2].toFixed(1)}`, "top-anchored");
}

{
  // Scale tool scales the font with the box (dimensions article §Scale).
  const e = engine();
  const id = addText(e, 0, 0, 100, 40, { text: "Hello", fontSize: 20, sizingW: "fixed", sizingH: "fixed" });
  e.dispatch({ type: "resize", id, x: 0, y: 0, w: 150, h: 60, scaleProps: true });
  m("A5 Scale tool scales fontSize with the bounds", `${N(e, id).fontSize} ${N(e, id).w}x${N(e, id).h}`, "30 150x60");
}

console.log("\n== B · Wrap style / truncate / indent (360039956634) ==\n");

{
  // Balance: "distributes text as evenly as possible across every line".
  // 8 words that auto-wrap leaves 5/1/2-ish uneven; balance must even them.
  const words = ["aaaa", "bbb", "c", "dddd", "e", "ffff"];
  const line = (ws) => ws.join(" ");
  const widthOf = (s) => s.length * 5;
  const maxW = 10 * 5; // 10 chars
  // greedy wrap -> ["aaaa bbb c"(10), "dddd e"(6), "ffff"(4)] uneven
  const auto = [];
  {
    let cur = [];
    for (const w of words) {
      if (cur.length && widthOf(line([...cur, w])) > maxW) { auto.push(line(cur)); cur = [w]; }
      else cur.push(w);
    }
    if (cur.length) auto.push(line(cur));
  }
  const bal = balanceLines(auto, maxW, widthOf, "balance");
  const spread = (ls) => Math.max(...ls.map(widthOf)) - Math.min(...ls.map(widthOf));
  m("B1 Balance evens the line widths (max−min chars)", `${auto.map((l) => l.length).join("/")} → ${bal.map((l) => l.length).join("/")}`, "10/6/4 → even (≤8/6/6)");
}

{
  // Pretty: "adjusts the last four lines to avoid an orphan — a single word
  // stranded alone on the last line".
  const widthOf = (s) => s.length * 5;
  const maxW = 25 * 5;
  const auto = ["aaaa bbbb cccc dddd", "eeee ffff gggg hhhh", "iiii jjjj kkkk llll", "word"];
  const pretty = balanceLines(auto, maxW, widthOf, "pretty");
  m("B2 Pretty kills the single-word last line (last-line word count)", String(pretty[pretty.length - 1].split(" ").length >= 2), "true");
}

{
  // "Wrap style … has no effect on … layers with text resizing set to Auto
  // width, where Figma only creates a new line when you press Enter."
  const t1 = node("text", "T", 0, 0, 10, 10, { text: "one two three four", sizingW: "hug", textWrap: "auto" });
  const t2 = { ...t1, textWrap: "balance" };
  const h1 = hugSize(t1, t1.text), h2 = hugSize(t2, t2.text);
  m("B3 wrap style is inert on Auto width (same hug width)", String(h1.w === h2.w && h1.h === h2.h), "true");
}

{
  // Truncate: ellipsis; Max lines only on auto width/height.
  const e = engine();
  const id = addText(e, 0, 0, 300, 30, {
    text: "alpha beta gamma\ndelta epsilon", sizingW: "fixed", sizingH: "hug",
    truncate: true, maxLines: 1, lineHeight: 30, fontSize: 20,
  });
  // engine-side state is enough here; the painter truncates rows to maxLines
  // and appends "…" (Canvas.tsx paintText). Verify the model accepts and the
  // row limiter does what the UI promises.
  const lim = fitLineCount(999, 30, 0);
  m("B4 max-lines truncation path present (model carries truncate+maxLines)",
    `${N(e, id).truncate}/${N(e, id).maxLines}`, "true/1");
  m("B4b fitLineCount for a tall box is unbounded", lim >= 20 ? "∞-ish" : lim, "∞-ish");
}

{
  // Paragraph indent: "You can only apply paragraph indentation to text that
  // uses the horizontal alignment setting Text-align left."
  const left = indentOf({ textAlign: "left", paragraphIndent: 24 });
  const cent = indentOf({ textAlign: "center", paragraphIndent: 24 });
  const rite = indentOf({ textAlign: "right", paragraphIndent: 24 });
  m("B5 paragraph indent applies only to left-aligned text", `${left}/${cent}/${rite}`, "24/0/0");
}

console.log("\n== C · Lists (360040449773) ==\n");

{
  // "Figma currently supports up to five levels of indentation" and
  // "numbered list counters rotate between numbers, alphabetical characters,
  // and roman numerals with each indentation."
  const seq = [0, 1, 2, 3, 4].map((i) => listMarker("numbered", i));
  m("C1 numbered markers per item (ours: paragraph index only)", seq.join(" "), "1. 2. 3. 4. 5.");
  const levelProbe = listMarker.toString().includes("level");
  m("C2 listMarker has an indentation-level parameter", levelProbe ? "yes" : "no", "yes (5 levels)");
  const rot = seq.some((s) => /^[a-i]\.$|^[ivx]+\.$/.test(s));
  m("C3 counters rotate number → alpha → roman with indent", rot ? "rotates" : "never rotates", "rotates");
}

{
  // Hanging lists: "Toggle hanging lists to move bullet points or numbers of
  // each list item outside of the bounding box" — a toggle (on/off).
  const t = node("text", "T", 0, 0, 10, 10, { listStyle: "bulleted", hangingLists: undefined });
  m("C4 hanging-lists toggle exists in the model", "hangingLists" in t ? String(t.hangingLists) : "no field", "boolean field");
  // List spacing: "By default, list spacing is set to 0 … represents list
  // spacing in pixels (px)."
  m("C5 list-spacing field exists (px, default 0)", "listSpacing" in t ? String(t.listSpacing) : "no field", "number field");
}

console.log("\n== D · Links / multi-edit / text on a path / text styles ==\n");

{
  const t = node("text", "T", 0, 0, 10, 10, {});
  m("D1 hyperlink field exists on text (links article)", "link" in t || "hyperlink" in t ? "yes" : "no field", "yes");
  m("D2 vertical-trim field exists (360039956634 §Vertical trim)", "verticalTrim" in t ? String(t.verticalTrim) : "no field", "boolean field");
  m("D3 underline details fields (style/thickness/offset/skipInk/color)",
    ["underlineStyle", "underlineColor", "underlineThickness", "underlineOffset", "skipInk"].every((k) => k in t) ? "all" : "none", "all");
  m("D4 numbers fields (fractions/super-sub/slashed-zero/figure style)",
    ["baselineShift", "fractions", "slashedZero", "figureStyle"].some((k) => k in t) ? "some" : "none", "some");
  m("D5 line-height can be expressed as % of font size", "lineHeightUnit" in t || "lineHeightPercent" in t ? "yes" : "px only", "% + px + auto");
}

for (const line of out) console.log(line);
console.log(`\n${pass} matched, ${fail} deviation groups measured`);
process.exit(0);
