/**
 * Figma parity — text baseline alignment in auto layout.
 *
 * Source of truth: Figma's help article *Use the horizontal and vertical flows
 * in auto layout* (help.figma.com 31289464393751), section "Text baseline
 * alignment":
 *
 *   "A baseline is the invisible line in which text or a layer sits. In
 *    typography, descenders will extend beneath this line."
 *   "In some cases, aligning the baselines of layers can create more balance —
 *    such as when aligning baselines of text layers with varying font sizes, or
 *    when aligning an icon with a text layer."
 *   … "the bottoms of the icon and the word home are aligned on the red line."
 *
 * and *Use auto layout with CSS Flexbox in mind* (42031586813719), which states
 * auto layout mirrors how the web renders layouts. That fixes the three rules
 * this file pins, all of them flexbox's:
 *
 *   1. an item with a baseline (text) is offset so its baseline lands on the
 *      row's shared line;
 *   2. an item without one (an icon, a shape) synthesises its baseline from its
 *      **bottom** edge — Figma's own icon example;
 *   3. a baseline row's cross size is `max baseline-above + max descent-below`,
 *      so a hug reserves the descenders instead of clipping the line.
 *
 * The engine has no font tables, so a text layer's first-line baseline is
 * modelled as `fontSize * TEXT_BASELINE_RATIO` from its box top — the same top
 * the canvas painter draws its first line from. These tests therefore compute
 * their expectations from that documented ratio rather than from a running
 * Figma: they pin our rule, not font metrics.
 */
import { MemoryEngine, find } from "../memory.ts";
import { TEXT_BASELINE_RATIO, childBaseline, baselineRow, effectiveCrossAlign } from "../layout.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const layout = (over = {}) => ({
  direction: "horizontal", gap: 10, padding: [0, 0, 0, 0],
  sizing: "hug", cross: "hug", wrap: false, align: "baseline", justify: "min", ...over,
});
const rootOf = (e) => { const s = e.snapshot(); return s.pages[s.page].root; };
const byId = (e, id) => find(rootOf(e), id);
const addFrame = (e, w, h, l) => {
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w, h, parent: rootOf(e).id });
  const id = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "autoLayout", id, layout: l });
  return id;
};
/** Adds an icon-shaped rect or a text layer and puts it in the frame, in order. */
const addIcon = (e, parent, w, h, index) => {
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent: rootOf(e).id });
  const id = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "reorder", ids: [id], parent, index });
  return id;
};
const addText = (e, parent, text, fontSize, w, index) => {
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w, h: fontSize, extra: { text, fontSize }, parent: rootOf(e).id });
  const id = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "reorder", ids: [id], parent, index });
  return id;
};

console.log("Figma's icon-on-the-baseline example (help.figma.com 31289464393751):");
{
  const e = new MemoryEngine(false);
  const row = addFrame(e, 400, 200, layout());
  const icon = addIcon(e, row, 48, 48, 0);
  const label = addText(e, row, "Home", 14, 60, 1);
  const n = byId(e, row);
  const iconNode = byId(e, icon);
  const labelNode = byId(e, label);
  const labelBaseline = labelNode.y + childBaseline(labelNode);
  t("the icon sits on the top edge of the content box", near(iconNode.y, 0));
  t("the icon's bottom and the text's baseline are the same line",
    near(iconNode.y + iconNode.h, labelBaseline));
  t("the text is pushed down to meet the icon's baseline",
    near(labelNode.y, 48 - 14 * TEXT_BASELINE_RATIO));
  // The row hugs `max baseline-above + max descent-below`: the icon's 48px
  // baseline plus the text's 8.8px descender box, so the descender is not
  // clipped by the frame's own bottom edge.
  t("a hug reserves the descender below the shared baseline",
    near(n.h, 48 + (labelNode.h - 14 * TEXT_BASELINE_RATIO)));
  t("and the text box ends exactly on the frame's bottom edge",
    near(labelNode.y + labelNode.h, n.h));
}

console.log("mixing icon and two text sizes keeps one baseline, and the hug follows it:");
{
  const e = new MemoryEngine(false);
  const row = addFrame(e, 400, 200, layout({ gap: 8 }));
  const small = addText(e, row, "Small", 12, 50, 0);
  const icon = addIcon(e, row, 32, 32, 1);
  const big = addText(e, row, "Big", 40, 90, 2);
  const n = byId(e, row);
  const nodes = [small, icon, big].map((id) => byId(e, id));
  const baselines = nodes.map((c) => c.y + childBaseline(c));
  t("all three baselines are the same line", baselines.every((b) => near(b, baselines[0])));
  t("the deepest baseline belongs to the icon's bottom edge", near(baselines[0], 32));
  t("the hug is baseline-above plus the deepest descent",
    near(n.h, 32 + Math.max(...nodes.map((c) => c.h - childBaseline(c)))));
  t("letter order is untouched by the alignment", nodes[0].x < nodes[1].x && nodes[1].x < nodes[2].x);
}

console.log("a text-only row keeps Figma's varying-font-size result (no regression):");
{
  const e = new MemoryEngine(false);
  const row = addFrame(e, 400, 200, layout());
  const big = addText(e, row, "Big", 40, 100, 0);
  const small = addText(e, row, "Small", 20, 80, 1);
  const b = byId(e, big), s = byId(e, small);
  t("the larger text sits on the top edge", near(b.y, 0));
  t("the smaller text is offset by the difference of their baselines", near(s.y, 40 * TEXT_BASELINE_RATIO - 20 * TEXT_BASELINE_RATIO));
  t("their baselines coincide", near(b.y + 40 * TEXT_BASELINE_RATIO, s.y + 20 * TEXT_BASELINE_RATIO));
}

console.log("cross-axis alignment without baseline is unchanged:");
{
  for (const [align, expected] of [["min", 0], ["center", (200 - 48) / 2], ["max", 200 - 48]]) {
    const e = new MemoryEngine(false);
    const row = addFrame(e, 400, 200, layout({ align, cross: "fixed", sizing: "fixed" }));
    const icon = addIcon(e, row, 48, 48, 0);
    t(`${align} places a 48px box at ${expected}`, near(byId(e, icon).y, expected));
  }
  const e = new MemoryEngine(false);
  const col = addFrame(e, 200, 300, layout({ direction: "vertical", align: "baseline", cross: "fixed", sizing: "fixed" }));
  const icon = addIcon(e, col, 48, 48, 0);
  t("a vertical flow has no baseline: the stale value falls to the start edge", near(byId(e, icon).x, 0));
}

console.log("wrapped rows each align on their own baseline:");
{
  const lineCross = 48 + (14 - 14 * TEXT_BASELINE_RATIO); // icon bottom + text descent
  const wrapped = (cross) => {
    const e = new MemoryEngine(false);
    // 110px wide, fixed: icon(48) + text(30 wide) fit a line; the next pair wraps.
    const row = addFrame(e, 110, 200, layout({ wrap: true, gap: 10, gapCross: 20, cross, sizing: "fixed" }));
    const icon1 = addIcon(e, row, 48, 48, 0);
    const text1 = addText(e, row, "One", 14, 30, 1);
    const icon2 = addIcon(e, row, 48, 48, 2);
    const text2 = addText(e, row, "Two", 14, 30, 3);
    return { n: byId(e, row), i1: byId(e, icon1), t1: byId(e, text1), i2: byId(e, icon2), t2: byId(e, text2) };
  };
  const { n, i1, t1, i2, t2 } = wrapped("fixed");
  t("the pairs wrapped into two lines", i1.y === t1.y - (48 - 14 * TEXT_BASELINE_RATIO) && i1.y < i2.y && i2.y === t2.y - (48 - 14 * TEXT_BASELINE_RATIO));
  t("both members of a line share its run", t1.x > i1.x && t2.x > i2.x && near(t1.x, i1.w + 10));
  t("line 1 shares its baseline", near(i1.y + i1.h, t1.y + childBaseline(t1)));
  t("line 2 shares its own baseline, not line 1's", near(i2.y + i2.h, t2.y + childBaseline(t2)));
  t("the second line starts one baseline group plus gapCross below the first",
    near(i2.y - i1.y, lineCross + 20));
  t("a fixed cross axis still holds its size", n.h === 200);
  const hugged = wrapped("hug");
  t("a hugging wrap reserves both lines and the gap between them",
    near(hugged.n.h, lineCross * 2 + 20));
}

console.log("the stored layout and the alignment box agree:");
{
  const e = new MemoryEngine(false);
  const frame = addFrame(e, 300, 120, layout({ sizing: "fixed", cross: "fixed" }));
  t("baseline is stored while the flow is horizontal", byId(e, frame).layout.align === "baseline");
  e.dispatch({ type: "autoLayout", id: frame, layout: { ...byId(e, frame).layout, direction: "vertical" } });
  const vertical = byId(e, frame);
  t("switching the flow to vertical normalizes the stale baseline to the start edge",
    vertical.layout.direction === "vertical" && vertical.layout.align === "min");
  t("switching back does not resurrect it", effectiveCrossAlign(vertical.layout) === "min");
  const icon = addIcon(e, frame, 20, 20, 0);
  e.dispatch({ type: "autoLayout", id: frame, layout: { ...byId(e, frame).layout, align: "baseline", direction: "horizontal" } });
  t("a horizontal flow accepts baseline again", byId(e, frame).layout.align === "baseline" && byId(e, icon).y >= 0);
}

console.log("the shared baseline model itself:");
{
  const row = [{ kind: "text", fontSize: 20, h: 24 }, { kind: "rect", h: 40 }];
  const group = baselineRow(row);
  t("a rect's baseline is its bottom edge", childBaseline(row[1]) === 40);
  t("a text's baseline is the documented ratio of its size", childBaseline(row[0]) === 20 * TEXT_BASELINE_RATIO);
  t("the row offsets the shorter baseline down to the tallest", group.offsets[0] === 40 - 20 * TEXT_BASELINE_RATIO && group.offsets[1] === 0);
  t("the row's cross size is baseline-above plus the deepest descent", group.cross === 40 + (24 - 20 * TEXT_BASELINE_RATIO));
  t("an empty row has no baseline to give", baselineRow([]).cross === 0 && baselineRow([]).offsets.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
