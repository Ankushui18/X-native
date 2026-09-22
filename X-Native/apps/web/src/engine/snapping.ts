/**
 * Snapping + smart alignment guides — the interaction that defines how Figma
 * *feels* when you move something.
 *
 * Ported in spirit from `crates/x-editor/src/snapping.rs` (`alignment_guides`,
 * `snap_delta`), extended with Figma behaviours the Rust side does not model:
 * equal-spacing distribution guides and gap measurements.
 *
 * Everything works in **page/world coordinates**. The caller converts the
 * screen tolerance into world units (`tol = px / zoom`) so snapping has a
 * constant feel at every zoom level.
 */

import type { XNode } from "./types";

export interface SnapTarget {
  /** Position on the axis, in world coordinates. */
  at: number;
  /** Extent of the contributing node along the *other* axis, for drawing. */
  from: number;
  to: number;
}

/** A guide line to draw on the canvas overlay. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  /** Center-alignment guides render dashed in Figma. */
  center?: boolean;
}

/** A measured equal-gap run, drawn as the red distance pills. */
export interface GapBadge {
  axis: "x" | "y";
  /** Midpoint of the gap, for label placement. */
  at: number;
  cross: number;
  size: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
  gaps: GapBadge[];
}

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const EMPTY: SnapResult = { dx: 0, dy: 0, guides: [], gaps: [] };

/**
 * Collect world-space boxes of every snappable node, skipping the nodes being
 * dragged (and their descendants) plus anything hidden or locked.
 */
export function snapCandidates(root: XNode, skip: Set<string>): Box[] {
  const out: Box[] = [];
  const visit = (n: XNode, px: number, py: number, skipped: boolean) => {
    const x = px + n.x;
    const y = py + n.y;
    const drop = skipped || skip.has(n.id);
    if (!drop && n !== root && n.visible) out.push({ id: n.id, x, y, w: n.w, h: n.h });
    // Rotated nodes snap on their axis-aligned bounds, which is what Figma does.
    for (const c of n.children) visit(c, x, y, drop);
  };
  visit(root, 0, 0, false);
  return out;
}

/** Edge + center positions a box contributes on one axis. */
function edges(b: Box, axis: "x" | "y"): { at: number; center: boolean }[] {
  const lo = axis === "x" ? b.x : b.y;
  const size = axis === "x" ? b.w : b.h;
  return [
    { at: lo, center: false },
    { at: lo + size / 2, center: true },
    { at: lo + size, center: false },
  ];
}

function span(b: Box, axis: "x" | "y"): [number, number] {
  return axis === "x" ? [b.y, b.y + b.h] : [b.x, b.x + b.w];
}

/**
 * Snap a moving bounding box against static candidates.
 *
 * Returns the delta to apply *on top of* the raw drag delta, plus the guides
 * and gap badges to render. Edge-to-edge alignment wins over center alignment
 * at equal distance, matching Figma.
 */
export function snapMove(moving: Box, others: Box[], tol: number): SnapResult {
  if (!others.length || tol <= 0) return EMPTY;
  const guides: Guide[] = [];
  let dx = 0;
  let dy = 0;

  for (const axis of ["x", "y"] as const) {
    const mine = edges(moving, axis);
    let best: { delta: number; at: number; center: boolean; other: Box } | null = null;
    for (const o of others) {
      for (const theirs of edges(o, axis)) {
        for (const m of mine) {
          const delta = theirs.at - m.at;
          if (Math.abs(delta) > tol) continue;
          const better =
            !best ||
            Math.abs(delta) < Math.abs(best.delta) - 1e-6 ||
            // tie-break: prefer edge alignment over center alignment
            (Math.abs(Math.abs(delta) - Math.abs(best.delta)) < 1e-6 && best.center && !theirs.center);
          if (better) best = { delta, at: theirs.at, center: theirs.center && m.center, other: o };
        }
      }
    }
    if (!best) continue;
    if (axis === "x") dx = best.delta;
    else dy = best.delta;

    // Draw the guide across the union of both boxes on the opposite axis.
    const [ma, mb] = span(moving, axis);
    const [oa, ob] = span(best.other, axis);
    guides.push({
      axis,
      at: best.at,
      from: Math.min(ma, oa),
      to: Math.max(mb, ob),
      center: best.center,
    });
  }

  const gaps = equalGaps({ ...moving, x: moving.x + dx, y: moving.y + dy }, others, tol);
  return { dx, dy, guides, gaps };
}

/**
 * Figma's equal-spacing detection: when the gap to a neighbour on one side
 * matches the gap on the other side (within tolerance), show both distances.
 * Only considers boxes that actually overlap on the cross axis.
 */
function equalGaps(moving: Box, others: Box[], tol: number): GapBadge[] {
  const out: GapBadge[] = [];
  for (const axis of ["x", "y"] as const) {
    const lo = axis === "x" ? moving.x : moving.y;
    const size = axis === "x" ? moving.w : moving.h;
    const hi = lo + size;
    const [ca, cb] = span(moving, axis);

    const overlapping = others.filter((o) => {
      const [oa, ob] = span(o, axis);
      return Math.min(cb, ob) - Math.max(ca, oa) > 0;
    });

    let before: { gap: number; box: Box } | null = null;
    let after: { gap: number; box: Box } | null = null;
    for (const o of overlapping) {
      const olo = axis === "x" ? o.x : o.y;
      const ohi = olo + (axis === "x" ? o.w : o.h);
      if (ohi <= lo) {
        const gap = lo - ohi;
        if (!before || gap < before.gap) before = { gap, box: o };
      } else if (olo >= hi) {
        const gap = olo - hi;
        if (!after || gap < after.gap) after = { gap, box: o };
      }
    }
    if (!before || !after) continue;
    if (Math.abs(before.gap - after.gap) > tol) continue;
    if (before.gap < 0.5 || after.gap < 0.5) continue;

    const cross = (Math.max(ca, span(before.box, axis)[0]) + Math.min(cb, span(before.box, axis)[1])) / 2;
    out.push({ axis, at: lo - before.gap / 2, cross, size: before.gap });
    out.push({ axis, at: hi + after.gap / 2, cross, size: after.gap });
  }
  return out;
}

/**
 * Snap a single dragged resize handle. `corner` follows the same 0..7 ordering
 * the canvas uses (TL, T, TR, R, BR, B, BL, L), so we only snap the edges that
 * the handle actually moves.
 */
export function snapResize(
  box: Box,
  corner: number,
  others: Box[],
  tol: number,
): { dx: number; dy: number; guides: Guide[] } {
  if (!others.length || tol <= 0) return { dx: 0, dy: 0, guides: [] };
  const movesLeft = corner === 0 || corner === 6 || corner === 7;
  const movesRight = corner === 2 || corner === 3 || corner === 4;
  const movesTop = corner === 0 || corner === 1 || corner === 2;
  const movesBottom = corner === 4 || corner === 5 || corner === 6;
  const guides: Guide[] = [];
  let dx = 0;
  let dy = 0;

  for (const axis of ["x", "y"] as const) {
    const lowEdge = axis === "x" ? movesLeft : movesTop;
    const highEdge = axis === "x" ? movesRight : movesBottom;
    if (!lowEdge && !highEdge) continue;
    const lo = axis === "x" ? box.x : box.y;
    const hi = lo + (axis === "x" ? box.w : box.h);
    const active = lowEdge ? lo : hi;

    let best: { delta: number; at: number; other: Box } | null = null;
    for (const o of others) {
      for (const theirs of edges(o, axis)) {
        const delta = theirs.at - active;
        if (Math.abs(delta) > tol) continue;
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, at: theirs.at, other: o };
        }
      }
    }
    if (!best) continue;
    if (axis === "x") dx = best.delta;
    else dy = best.delta;
    const [ma, mb] = span(box, axis);
    const [oa, ob] = span(best.other, axis);
    guides.push({ axis, at: best.at, from: Math.min(ma, oa), to: Math.max(mb, ob) });
  }
  return { dx, dy, guides };
}
