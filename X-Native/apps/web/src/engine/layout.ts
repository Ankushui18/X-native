/**
 * Auto layout, as Figma's "Guide to auto layout" describes it.
 *
 * The engine positions children with these rules and the right sidebar labels
 * them with the same ones, so what the panel says and where the pixels land
 * cannot drift apart. Everything here is pure: no React, no canvas, no engine.
 */
import type { AutoLayout, GridTrack, LayoutAlign, LayoutDirection, LayoutJustify, Sizing, TrackMode, XNode } from "./types";

/* ── The grid flow ──────────────────────────────────────────────────────────
 *
 * Figma's third flow, from "Use the grid in auto layout flow": cells arranged
 * into columns and rows (tracks), where an object can span several of each.
 * The geometry is worked out here and applied by the engine, so the panel, the
 * tests and the canvas all read the same numbers.
 */

/**
 * Which axis a frame's main resizing belongs to.
 *
 * A horizontal flow and a grid both measure width first, so `sizing` is the
 * width for both and `cross` the height; a vertical flow's main axis is its
 * height. Everything that asks about "the main axis" asks this, so a grid can
 * never end up with its width and height rules swapped.
 */
export function widthIsMain(layout: { direction: LayoutDirection }): boolean {
  return layout.direction !== "vertical";
}

/** A brand new grid frame's shape: two columns, rows that follow the objects. */
export function defaultGrid(over: Partial<AutoLayout> = {}): AutoLayout {
  return {
    ...defaultLayout(),
    direction: "grid",
    columns: 2,
    rows: "auto",
    gapRows: 8,
    gapCols: 8,
    colTracks: [],
    rowTracks: [],
    autoPosition: true,
    ...over,
  };
}

/** Where one object sits in the grid: its first cell and how far it reaches. */
export interface Cell {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

/**
 * Place the objects into cells.
 *
 * With automatic positioning on - Figma's default - objects fill the grid "in
 * succession from left to right, top to bottom", each one taking the first cell
 * its span fits in. When it is off, every object stays in the cell it already
 * has (`gridCol`/`gridRow`), which is what preserves empty cells.
 */
export function placeCells(flow: XNode[], cols: number, auto: boolean): Cell[] {
  const width = Math.max(1, Math.floor(cols));
  const taken = new Set<string>();
  const key = (c: number, r: number) => `${c}:${r}`;
  const out: Cell[] = [];
  const fits = (c: number, r: number, cs: number, rs: number) => {
    if (c + cs > width) return false;
    for (let i = c; i < c + cs; i++) for (let j = r; j < r + rs; j++) if (taken.has(key(i, j))) return false;
    return true;
  };
  for (let index = 0; index < flow.length; index++) {
    const n = flow[index];
    // A span wider than the grid is clamped: there is nothing to reach into.
    const cs = Math.max(1, Math.min(width, Math.floor(n.colSpan ?? 1) || 1));
    const rs = Math.max(1, Math.floor(n.rowSpan ?? 1) || 1);
    if (!auto) {
      // With automatic positioning off every object keeps its cell; an object
      // that has never been placed falls back to its place in the order, and
      // anything parked past the last column is pulled back into the grid.
      const c = Math.max(0, Math.min(width - cs, Math.floor(n.gridCol ?? 0)));
      const r0 = Math.max(0, Math.floor(n.gridRow ?? Math.floor(index / width)));
      out.push({ col: c, row: r0, colSpan: cs, rowSpan: rs });
      for (let i = c; i < c + cs; i++) for (let j = r0; j < r0 + rs; j++) taken.add(key(i, j));
      continue;
    }
    let placed: Cell | null = null;
    for (let r = 0; !placed; r++) {
      for (let c = 0; c + cs <= width; c++) {
        if (fits(c, r, cs, rs)) {
          placed = { col: c, row: r, colSpan: cs, rowSpan: rs };
          break;
        }
      }
      // A row that cannot hold a one-cell object is a bug guard, not a case.
      if (r > flow.length + 1) break;
    }
    const cell = placed ?? { col: 0, row: out.length, colSpan: cs, rowSpan: rs };
    out.push(cell);
    for (let i = cell.col; i < cell.col + cell.colSpan; i++)
      for (let j = cell.row; j < cell.row + cell.rowSpan; j++) taken.add(key(i, j));
  }
  return out;
}

/**
 * How many rows the grid needs.
 *
 * "By default, Number of rows is set to `auto`... the number of rows in the grid
 * will increase or decrease to accommodate the number of cells needed by cell
 * objects. For example, deleting all cell objects from a row will also remove
 * that row." A row count that was set by hand is a floor, because Figma will
 * "create new rows or columns to accommodate" objects that do not fit.
 */
export function gridRows(layout: AutoLayout, cells: Cell[]): number {
  const needed = cells.reduce((max, c) => Math.max(max, c.row + c.rowSpan), 0);
  const declared = typeof layout.rows === "number" ? Math.max(0, Math.floor(layout.rows)) : 0;
  return Math.max(needed, declared, 1);
}

/** The size of one track, resolved: a pixel size, plus how it was reached. */
export interface ResolvedTrack {
  size: number;
  mode: TrackMode;
}

/**
 * Resolve every track's size along one axis.
 *
 * `hug` tracks are as big as the objects inside them, `fixed` tracks keep the
 * size they were given, and `fill` tracks divide what is left between them by
 * fractional unit - the article's own formula. A frame that hugs its contents
 * has no leftover space to divide, so a fill track there falls back to hugging
 * its contents, which is what stops a hug from chasing its own tail.
 */
export function resolveTracks(
  count: number,
  tracks: GridTrack[] | undefined,
  needs: { start: number; span: number; size: number }[],
  gaps: number,
  available: number,
  canFill: boolean,
): ResolvedTrack[] {
  // A track that has not been given a mode is Figma's Auto: the free space is
  // shared out between the tracks that ask for it, in proportion to their
  // fractional units. (Figma's own help says "by default, the size is set to
  // auto, which means free space is divided evenly between all rows/columns".)
  const mode = (i: number): TrackMode => tracks?.[i]?.mode ?? "fill";
  const fr = (i: number) => Math.max(0.0001, tracks?.[i]?.fr ?? 1);
  // What each track would need to hug the objects in it. An object that spans
  // several tracks shares its size between them, once the gaps come out.
  const hug = new Array<number>(count).fill(0);
  for (const n of needs) {
    if (n.size <= 0) continue;
    const reach = Math.max(1, Math.min(n.span, count - n.start));
    const each = Math.max(0, (n.size - gaps * (reach - 1)) / reach);
    for (let i = n.start; i < n.start + reach && i < count; i++) hug[i] = Math.max(hug[i], each);
  }
  let totalFr = 0;
  let taken = 0;
  const sized = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    const m = mode(i);
    if (m === "fixed") sized[i] = tracks?.[i]?.size ?? hug[i];
    else if (m === "fill" && canFill) totalFr += fr(i);
    else sized[i] = hug[i];
    if (sized[i]) taken += sized[i];
  }
  const leftover = Math.max(0, available - taken - gaps * Math.max(0, count - 1));
  for (let i = 0; i < count; i++) {
    if (mode(i) === "fill" && canFill) sized[i] = totalFr > 0 ? (leftover * fr(i)) / totalFr : hug[i];
  }
  return sized.map((size, i) => ({ size, mode: mode(i) }));
}

/** The whole grid, resolved: where every track starts and how big it is. */
export interface GridPlan {
  cols: number;
  rows: number;
  cells: Cell[];
  colW: number[];
  rowH: number[];
  colX: number[];
  rowY: number[];
  totalW: number;
  totalH: number;
}

/**
 * The cell an object is sitting over.
 *
 * Automatic positioning off is the case where the object's own place on the
 * canvas is the truth: Figma says toggling it off "preserves empty cells", and
 * the way to move something into one of them is to drag it there. The track a
 * point falls in is read from the plan the objects' last arrangement produced,
 * so dragging across a track boundary lands in the next cell rather than being
 * snapped back to where the drag began.
 */
export function cellAt(plan: GridPlan, layout: AutoLayout, child: XNode): Cell {
  const [pl, , pt] = Array.isArray(layout.padding) ? layout.padding : [0, 0, 0, 0];
  const gapCols = layout.gapCols ?? layout.gap ?? 0;
  const gapRows = layout.gapRows ?? layout.gap ?? 0;
  const colSpan = Math.max(1, Math.min(plan.cols, Math.floor(child.colSpan ?? 1) || 1));
  const rowSpan = Math.max(1, Math.floor(child.rowSpan ?? 1) || 1);
  // The last track that starts at or before the object's centre: for an object
  // dragged out past the end that is the nearest track, which is where Figma
  // parks it too rather than letting it float off the grid.
  const track = (offsets: number[], gap: number, at: number) => {
    let found = 0;
    // A track owns its own box plus half of each gap beside it, so the
    // boundary between neighbours is the middle of the gap between them.
    for (let i = 0; i < offsets.length; i++) if (at >= offsets[i] - gap / 2) found = i;
    return found;
  };
  const cx = child.x - pl + child.w / 2;
  const cy = child.y - pt + child.h / 2;
  const col = Math.max(0, Math.min(plan.cols - colSpan, track(plan.colX, gapCols, cx)));
  const row = Math.max(0, track(plan.rowY, gapRows, cy));
  return { col, row, colSpan, rowSpan };
}

/**
 * Lay a grid frame out. Everything is measured from the frame's own padding, so
 * `colX`/`rowY` are offsets inside the content box.
 */
export function planGrid(
  node: Pick<XNode, "w" | "h">,
  flow: XNode[],
  layout: AutoLayout,
  hugsWidth: boolean,
  hugsHeight: boolean,
  /** Cells worked out by the caller. Automatic positioning off asks the
   *  objects where they are instead of asking the flow, and that answer
   *  depends on the tracks - which is this function's job - so it is passed in
   *  from a first pass. */
  placed?: Cell[],
): GridPlan {
  const [pl, pr, pt, pb] = Array.isArray(layout.padding) ? layout.padding : [0, 0, 0, 0];
  const cols = Math.max(1, Math.floor(layout.columns ?? 2));
  const gapCols = layout.gapCols ?? layout.gap ?? 0;
  const gapRows = layout.gapRows ?? layout.gap ?? 0;
  const auto = layout.autoPosition !== false;
  const cells = placed ?? placeCells(flow, cols, auto);
  const rows = gridRows(layout, cells);
  // An object that fills its cell asks for no size of its own: the track is
  // what gives it one, and asking would make a fill track chase itself.
  const needs = (axis: "x" | "y") =>
    cells.map((c, i) => ({
      start: axis === "x" ? c.col : c.row,
      span: axis === "x" ? c.colSpan : c.rowSpan,
      size: axis === "x" ? (flow[i].sizingW === "fill" ? 0 : flow[i].w) : flow[i].sizingH === "fill" ? 0 : flow[i].h,
    }));
  const colW = resolveTracks(
    cols,
    layout.colTracks,
    needs("x"),
    gapCols,
    node.w - pl - pr,
    !hugsWidth,
  ).map((t) => t.size);
  const rowH = resolveTracks(
    rows,
    layout.rowTracks,
    needs("y"),
    gapRows,
    node.h - pt - pb,
    !hugsHeight,
  ).map((t) => t.size);
  const colX: number[] = [];
  const rowY: number[] = [];
  let x = 0;
  for (let i = 0; i < cols; i++) {
    colX.push(x);
    x += colW[i] + gapCols;
  }
  let y = 0;
  for (let i = 0; i < rows; i++) {
    rowY.push(y);
    y += rowH[i] + gapRows;
  }
  return {
    cols,
    rows,
    cells,
    colW,
    rowH,
    colX,
    rowY,
    totalW: colW.reduce((s2, w) => s2 + w, 0) + gapCols * Math.max(0, cols - 1),
    totalH: rowH.reduce((s2, h) => s2 + h, 0) + gapRows * Math.max(0, rows - 1),
  };
}

/** The box one object's cell (or span) takes up inside the content area. */
export function cellBox(plan: GridPlan, cell: Cell): { x: number; y: number; w: number; h: number } {
  const startX = plan.colX[cell.col] ?? 0;
  const endX = plan.colX[cell.col + cell.colSpan - 1] ?? startX;
  const startY = plan.rowY[cell.row] ?? 0;
  const endY = plan.rowY[cell.row + cell.rowSpan - 1] ?? startY;
  return {
    x: startX,
    y: startY,
    w: endX + plan.colW[cell.col + cell.colSpan - 1] - startX,
    h: endY + plan.rowH[cell.row + cell.rowSpan - 1] - startY,
  };
}

/** How an object sits inside its cell: Figma's Position align buttons. */
export function cellAlign(n: XNode): { h: "min" | "center" | "max"; v: "min" | "center" | "max" } {
  const one = (c: string | undefined) => (c === "center" ? "center" : c === "max" ? "max" : "min");
  return { h: one(n.constraintH), v: one(n.constraintV) };
}

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

/** One cell of the alignment box: a main-axis packing and a cross-axis position. */
export interface AlignCell {
  j: LayoutJustify;
  a: LayoutAlign;
}

/** The nine cells, in reading order: top-left through bottom-right. */
const NINE_CELLS: AlignCell[] = [
  { j: "min", a: "min" },
  { j: "center", a: "min" },
  { j: "max", a: "min" },
  { j: "min", a: "center" },
  { j: "center", a: "center" },
  { j: "max", a: "center" },
  { j: "min", a: "max" },
  { j: "center", a: "max" },
  { j: "max", a: "max" },
];

/**
 * What the alignment box offers for this frame.
 *
 * The article: "If gap between items is set to a specific number, you have the
 * same nine options for each auto layout flow... If gap between items is set to
 * Auto, you have three options for each flow - vertical auto layout flow: Left,
 * Center, Right; horizontal auto layout flow: Top, Center, Bottom." Auto gap
 * owns the main axis - it is what decides how the objects are distributed along
 * it - so only the cross-axis position is left to choose, and the box drops from
 * nine cells to three.
 */
export function alignmentCells(layout: AutoLayout): AlignCell[] {
  if (!isAutoGap(layout)) return NINE_CELLS;
  const main = layout.justify === "between" ? "min" : layout.justify;
  return (["min", "center", "max"] as LayoutAlign[]).map((a) => ({ j: main, a }));
}

/** The three positions of one axis, in the order the alignment box lays them out. */
const POSITIONS = ["min", "center", "max"] as const;
type Position = (typeof POSITIONS)[number];

/**
 * The keys the alignment box answers to, from the article: "Select the box and
 * use arrow keys to switch between the different alignment settings. Select the
 * box and press W/A/S/D to set alignment to the edge of the frame." Plus `B` for
 * baseline and `X` to switch the gap between a number and Auto.
 */
export type AlignKey =
  | { kind: "arrow"; axis: "x" | "y"; dir: 1 | -1 }
  | { kind: "edge"; edge: "top" | "left" | "bottom" | "right" }
  | { kind: "baseline" }
  | { kind: "gap" };

/**
 * What one press of a key does to a frame's alignment, as a patch. Null means
 * "nothing this flow can do" - an arrow aimed at the main axis of an Auto-gap
 * stack, or `B` on a vertical flow, where text baselines do not apply.
 */
export function layoutKeyPatch(layout: AutoLayout, key: AlignKey): Partial<AutoLayout> | null {
  const horizontal = layout.direction === "horizontal";
  const auto = isAutoGap(layout);
  // "main" packs the objects along the flow, "cross" places them across it. The
  // keys are spatial, so which one they land on depends on the flow's direction:
  // x is the main axis of a horizontal flow and the cross axis of a vertical one.
  const axisOf = (axis: "x" | "y"): "main" | "cross" =>
    (axis === "x") === horizontal ? "main" : "cross";
  const propOf = (axis: "main" | "cross"): "justify" | "align" =>
    axis === "main" ? "justify" : "align";
  /* Auto gap owns the main axis, which is the whole reason the box loses six of
     its nine cells - so a key aimed at the main axis has nothing to change. */
  const target = (axis: "main" | "cross") => {
    if (axis === "main" && auto) return null;
    return propOf(axis);
  };
  if (key.kind === "gap") return { gapMode: auto ? "fixed" : "auto" };
  if (key.kind === "baseline") {
    if (!horizontal) return null;
    return { align: layout.align === "baseline" ? "min" : "baseline" };
  }
  const axis = axisOf(key.kind === "arrow" ? key.axis : key.edge === "left" || key.edge === "right" ? "x" : "y");
  const prop = target(axis);
  if (!prop) return null;
  const current = prop === "justify" ? layout.justify : layout.align;
  if (key.kind === "arrow") {
    // "Use arrow keys to switch between the different alignment settings": each
    // press steps one position along that axis and wraps round, rather than
    // jumping to an edge the way W/A/S/D do.
    if (prop === "align" && current === "baseline") return { align: key.dir > 0 ? "center" : "max" };
    const at = (POSITIONS as readonly string[]).indexOf(current === "between" ? "min" : current);
    const next = POSITIONS[(at + key.dir + POSITIONS.length) % POSITIONS.length];
    return prop === "justify" ? { justify: next } : { align: next };
  }
  const want: Position = key.edge === "left" || key.edge === "top" ? "min" : "max";
  return prop === "justify" ? { justify: want } : { align: want };
}

/**
 * Which alignment key a keystroke is, if any. Kept apart from the DOM so the
 * mapping is the same wherever it is read - and so the box's keys can be
 * asserted without a browser. Modifier chords are left alone: ⌘A, ⌘S and the
 * rest still belong to the app.
 */
export function alignKey(ch: string): AlignKey | null {
  switch (ch.toLowerCase()) {
    case "arrowleft":
      return { kind: "arrow", axis: "x", dir: -1 };
    case "arrowright":
      return { kind: "arrow", axis: "x", dir: 1 };
    case "arrowup":
      return { kind: "arrow", axis: "y", dir: -1 };
    case "arrowdown":
      return { kind: "arrow", axis: "y", dir: 1 };
    case "w":
      return { kind: "edge", edge: "top" };
    case "a":
      return { kind: "edge", edge: "left" };
    case "s":
      return { kind: "edge", edge: "bottom" };
    case "d":
      return { kind: "edge", edge: "right" };
    case "b":
      return { kind: "baseline" };
    case "x":
      return { kind: "gap" };
    default:
      return null;
  }
}

/**
 * The padding field's shorthand, as CSS writes it: `1` is all four sides, `1,2`
 * is top/bottom then left/right, `1,2,3` adds the top, `1,2,3,4` is top, right,
 * bottom, left. The article names all four forms and calls it CSS shorthand, so
 * this follows CSS rather than inventing an order. Returns null for anything
 * that is not a list of numbers, so a bad entry changes nothing.
 */
export function parsePaddingShorthand(raw: string): [number, number, number, number] | null {
  const parts = String(raw ?? "")
    .trim()
    .split(/[,\s]+/)
    .filter((t) => t.length > 0)
    .map((t) => Number(t));
  if (!parts.length || parts.length > 4) return null;
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const clamp = (n: number) => Math.max(0, n);
  if (parts.length === 1) {
    const v = clamp(parts[0]);
    return [v, v, v, v];
  }
  if (parts.length === 2) {
    const [tb, lr] = parts.map(clamp);
    return [lr, lr, tb, tb];
  }
  if (parts.length === 3) {
    const [t, lr, b] = parts.map(clamp);
    return [lr, lr, t, b];
  }
  const [t, r, b, l] = parts.map(clamp);
  return [l, r, t, b];
}

/**
 * A frame cannot be smaller than its own padding. The article: "If a frame is
 * set to hug contents or a fixed size smaller than its padding, the frame will
 * size up to fit the padding." Strokes are not part of this - only inside
 * strokes count towards layout sizes, and this app does not size them yet.
 */
export function clampToPadding(n: XNode): void {
  const l = n.layout;
  if (!l || !Array.isArray(l.padding)) return;
  const [pl, pr, pt, pb] = l.padding;
  if (n.w < pl + pr) n.w = pl + pr;
  if (n.h < pt + pb) n.h = pt + pb;
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
  const horizontal = widthIsMain(layout);
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
