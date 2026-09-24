/**
 * Auto layout, as Figma's "Guide to auto layout" describes it.
 *
 * The engine positions children with these rules and the right sidebar labels
 * them with the same ones, so what the panel says and where the pixels land
 * cannot drift apart. Everything here is pure: no React, no canvas, no engine.
 */
import type { AutoLayout, LayoutAlign, Sizing, XNode } from "./types";

/**
 * A brand new auto layout frame, as Figma adds one: a horizontal flow hugging
 * its contents with an 8px gap and 8px of padding all round.
 *
 * It lives here rather than in the engine because the panel, the canvas and the
 * suggester below all have to agree on it, and `memory.ts` re-exports it so the
 * older `from "../engine/memory"` imports keep working.
 */
export function defaultLayout(): AutoLayout {
  return {
    direction: "horizontal",
    gap: 8,
    padding: [8, 8, 8, 8],
    sizing: "hug",
    cross: "hug",
    wrap: false,
    align: "min",
    justify: "min",
  };
}

/** Figma's three flows. Grid is its own article and is not this module. */
export const LAYOUT_FLOWS: { id: "vertical" | "horizontal"; label: string }[] = [
  { id: "vertical", label: "Vertical" },
  { id: "horizontal", label: "Horizontal" },
];

/** Figma's Auto gap, and its three packing rules. */
export type Spacing = "between" | "around" | "evenly";

export const SPACING_MODES: { id: Spacing; label: string; hint: string }[] = [
  {
    id: "between",
    label: "Between",
    hint: "Equal space between each object, with none added at the edges",
  },
  { id: "around", label: "Around", hint: "Each object gets half a gap on either side" },
  { id: "evenly", label: "Evenly", hint: "The same space everywhere, edges included" },
];

/**
 * Where the space goes when the gap is set to Auto.
 *
 * `free` is what is left over once the objects and the padding have taken their
 * share, so a frame that hugs its contents has no slack and every mode comes
 * out as zero. The three answers are CSS's space-between / space-around /
 * space-evenly, which is what Figma's Auto gap is:
 *
 *   Between  |□ □ □|        the objects are pushed to the padding
 *   Around   | □ □ □ |      each object carries half a gap on each side
 *   Evenly   | □ □ □ |      the same space before, between and after
 *
 * `lead` is the space before the first object; the same space follows the last
 * one, which is what makes "around" and "evenly" visibly different at a glance.
 */
export function autoSpacing(
  free: number,
  count: number,
  mode: Spacing,
): { lead: number; gap: number } {
  const slack = Math.max(0, free);
  if (count <= 0) return { lead: 0, gap: 0 };
  if (mode === "around") {
    const each = slack / count;
    return { lead: each / 2, gap: each };
  }
  if (mode === "evenly") {
    const each = slack / (count + 1);
    return { lead: each, gap: each };
  }
  return { lead: 0, gap: count > 1 ? slack / (count - 1) : 0 };
}

/** True when the gap is Figma's Auto rather than a number. */
export function isAutoGap(layout: AutoLayout | undefined): boolean {
  if (!layout) return false;
  return layout.gapMode === "auto";
}

/**
 * Does any object in the flow fill along this axis?
 *
 * Figma: "If any child objects within an auto layout frame are set to Fill
 * container, the parent frame will no longer hug contents and become Fixed for
 * the axis." The children that fill need a size to fill *into*, so there is
 * nothing for the frame to hug down to - which is why the article pairs the two
 * rules.
 */
export function hasFillChild(flow: XNode[], axis: "main" | "cross", horizontal: boolean): boolean {
  const alongX = axis === "main" ? horizontal : !horizontal;
  return flow.some((c) => (alongX ? c.sizingW : c.sizingH) === "fill");
}

/**
 * The auto layout values Figma's own "Suggest auto layout" would have picked.
 *
 * The article keeps this behind ⌃⇧A: rather than adding an auto layout frame
 * with the defaults, Figma looks at how the objects are already arranged and
 * fills in the direction, gap, padding and alignment that describe it. There is
 * no model here - just the arrangement itself, read off the geometry:
 *
 *   - a flow is horizontal when the objects sit side by side (their horizontal
 *     bands overlap and they march across the frame) and vertical when they
 *     stack. The axis whose gaps are the more even of the two wins, with a
 *     side-by-side overlap as the tie-breaker.
 *   - the gap is the median space between neighbours along that axis, so one
 *     stray object does not drag the value off.
 *   - the padding is the frame's own inset, measured from the objects' bounding
 *     box; a frame that is exactly its contents plus that inset is set to hug.
 *   - the cross-axis alignment is where the objects actually sit: all at the
 *     start, all centred, or all at the end.
 *
 * Returns `defaultLayout()` when there is nothing to read - fewer than two
 * objects in the flow - which is what the panel's own button would have used.
 */
export function suggestLayout(node: Pick<XNode, "children" | "w" | "h">): AutoLayout {
  const flow = (node.children ?? []).filter(
    (c) => c.visible !== false && !c.absolutePosition,
  );
  const base = defaultLayout();
  if (flow.length < 2) return base;
  const spanX = (axis: "h" | "v") => {
    // The gaps between neighbours, once the objects are sorted along the axis.
    const sorted = [...flow].sort((a, b) => (axis === "h" ? a.x - b.x : a.y - b.y));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      gaps.push(axis === "h" ? cur.x - (prev.x + prev.w) : cur.y - (prev.y + prev.h));
    }
    // The cross axis overlap: in a row every object shares a horizontal band,
    // in a column every object shares a vertical one.
    const overlaps = sorted.every((c, i) => {
      if (!i) return true;
      const prev = sorted[i - 1];
      return axis === "h"
        ? Math.min(prev.y + prev.h, c.y + c.h) - Math.max(prev.y, c.y) > 0
        : Math.min(prev.x + prev.w, c.x + c.w) - Math.max(prev.x, c.x) > 0;
    });
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const drift =
      Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length) /
      (Math.abs(mean) || 1);
    return { gaps, overlaps, drift };
  };
  const across = spanX("h");
  const down = spanX("v");
  const horizontal =
    across.overlaps !== down.overlaps ? across.overlaps : across.drift <= down.drift;
  const chosen = horizontal ? across : down;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const gap = Math.max(0, Math.round(median(chosen.gaps)));
  const minX = Math.min(...flow.map((c) => c.x));
  const minY = Math.min(...flow.map((c) => c.y));
  const maxX = Math.max(...flow.map((c) => c.x + c.w));
  const maxY = Math.max(...flow.map((c) => c.y + c.h));
  // The frame's inset, from the objects' own bounding box. A frame can only
  // honour the smaller of its two insets on an axis - anything beyond that is
  // slack - so the padding is symmetric per axis, and a frame that is bigger
  // than its contents plus that padding is Fixed rather than a hug.
  const insets = [
    Math.max(0, minX),
    Math.max(0, node.w - maxX),
    Math.max(0, minY),
    Math.max(0, node.h - maxY),
  ];
  const padX = Math.round(Math.min(insets[0], insets[1]));
  const padY = Math.round(Math.min(insets[2], insets[3]));
  const padding: [number, number, number, number] = [padX, padX, padY, padY];
  const contentMain =
    flow.reduce((s, c) => s + (horizontal ? c.w : c.h), 0) + gap * (flow.length - 1);
  const contentCross = Math.max(...flow.map((c) => (horizontal ? c.h : c.w)));
  const mainSize = horizontal ? node.w : node.h;
  const crossSize = horizontal ? node.h : node.w;
  const mainPad = horizontal ? padX : padY;
  const crossPad = horizontal ? padY : padX;
  const hugMain = Math.abs(mainSize - (contentMain + mainPad * 2)) < 1.5;
  const hugCross = Math.abs(crossSize - (contentCross + crossPad * 2)) < 1.5;
  // Where the objects sit across the flow decides the cross alignment; a hug
  // leaves no room to sit anywhere but the start, which is Figma's default.
  const crossStart = Math.min(...flow.map((c) => (horizontal ? c.y : c.x)));
  const crossEnd = Math.max(...flow.map((c) => (horizontal ? c.y + c.h : c.x + c.w)));
  const lead = crossStart - crossPad;
  const trail = crossSize - crossPad * 2 - (crossEnd - crossPad);
  const align: LayoutAlign = Math.abs(lead - trail) < 1.5 ? "min" : lead < trail ? "min" : "max";
  return {
    ...base,
    direction: horizontal ? "horizontal" : "vertical",
    gap,
    padding,
    sizing: hugMain ? "hug" : "fixed",
    cross: hugCross ? "hug" : "fixed",
    align,
  };
}

/**
 * What a frame's resizing actually does, which is not always what its `sizing`
 * fields say: a hug that has a filling child is a Fixed frame. The panel reads
 * this too, so a frame that behaves fixed is *shown* as fixed rather than as a
 * hug that never hugs.
 */
export function effectiveSizing(
  layout: AutoLayout,
  node: Pick<XNode, "sizingW" | "sizingH">,
  flow: XNode[],
): { main: Sizing; cross: Sizing } {
  const horizontal = layout.direction === "horizontal";
  // Two places can ask for a hug and either one is enough: the layout's own
  // `sizing` pair, and the layer's width/height resizing menu. They are kept in
  // step by the panel, but a document written by an older build may only have
  // one of them set, so both are read.
  const wantsMain =
    layout.sizing === "hug" || (horizontal ? node.sizingW : node.sizingH) === "hug";
  const wantsCross =
    layout.cross === "hug" || (horizontal ? node.sizingH : node.sizingW) === "hug";
  const main: Sizing = wantsMain && !hasFillChild(flow, "main", horizontal) ? "hug" : "fixed";
  const cross: Sizing = wantsCross && !hasFillChild(flow, "cross", horizontal) ? "hug" : "fixed";
  return { main, cross };
}

/** The frame hugs along an axis only when nothing in the flow fills it. */
export function hugsMain(layout: AutoLayout, node: XNode, flow: XNode[]): boolean {
  return effectiveSizing(layout, node, flow).main === "hug";
}

export function hugsCross(layout: AutoLayout, node: XNode, flow: XNode[]): boolean {
  return effectiveSizing(layout, node, flow).cross === "hug";
}

/**
 * Figma: "Wrap becomes available" once the flow is horizontal, and the article
 * offers it nowhere else. A vertical flow with wrap set is not a state Figma
 * has, so it does not wrap here either - the flag is kept on the document (a
 * file that had it keeps its data) but it stops bending the layout.
 */
export function wraps(layout: AutoLayout | undefined): boolean {
  return !!layout && layout.wrap === true && layout.direction === "horizontal";
}

/**
 * Figma's text rule from the same guide: "Text layers cannot have both a max
 * height and a set number of max lines. Adding a max height will set max lines
 * to Auto. Setting max lines to a number will remove the layer's max height."
 *
 * Returned as a patch rather than applied in place so the engine can fold it
 * into the same dispatch, and so the rule is testable on its own.
 */
export function textDimensionRule(patch: Partial<XNode>): Partial<XNode> {
  const out: Partial<XNode> = { ...patch };
  if (patch.maxH != null && patch.maxLines == null) out.maxLines = 0;
  if (patch.maxLines != null && patch.maxLines > 0 && patch.maxH == null) out.maxH = 0;
  return out;
}
