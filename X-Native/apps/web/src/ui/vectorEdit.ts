/**
 * Vector sub-tool rules (PM-U10).
 *
 * `vecSubTool` is the mode inside the vector-edit toolbar — Select, Bend, Paint,
 * Shape Builder — and the toolbar is on screen when one of three things is true:
 * a vector is in point edit (`vecEdit`), the pen tool is active, or a pen path is
 * in progress (`draft`). That is the guard the toolbar itself renders under, so
 * it is also the honest answer to "can this sub-tool be used at all right now".
 *
 * It lives here rather than inline because three callers need the same answer and
 * the same sentence: the toolbar's own buttons, the pen, and the radial menu's
 * Bend slice — which until now dispatched a window event nothing listened for, so
 * choosing it reset the user's tool and did nothing else.
 */

import type { PathPoint } from "../engine/types";
import { nearestSegmentForInsert, segmentInsertLanding } from "../engine/geometry";

export interface VectorContext {
  /** The id of the vector in point edit, or null. */
  vecEdit: string | null;
  /** The active tool id (`"select"`, `"pen"`, …). */
  tool: string;
  /** Is a pen path in progress? */
  drafting: boolean;
}

/** Is the vector-edit toolbar up, i.e. does a sub-tool mean anything? */
export function vectorToolbarOpen(c: VectorContext): boolean {
  return !!c.vecEdit || c.tool === "pen" || c.drafting;
}

/** What the Bend request can do, and what to say when it cannot. `need` is the
 *  sentence the toast shows — written once so the radial and the toolbar cannot
 *  tell the user two different things. */
export function bendReadiness(c: VectorContext): { ok: true; say: string } | { ok: false; need: string } {
  if (vectorToolbarOpen(c)) {
    return { ok: true, say: "Bend tool active (drag segment to curve)" };
  }
  return {
    ok: false,
    need: "Select a vector, press Enter to edit its points, then Bend — or start a pen path",
  };
}

/* ------------------------------------------------------------------------- *
 * Bézier handle symmetry (Figma's point styles).
 * ------------------------------------------------------------------------- */

export type PointMirrorMode = "none" | "angle" | "angleAndLength";

/** The minimum a path point has to say about its handles. */
export interface MirrorablePoint {
  x: number;
  y: number;
  ix?: number;
  iy?: number;
  ox?: number;
  oy?: number;
  mirrorMode?: PointMirrorMode;
}

/**
 * Which symmetry a point's handles obey while one of them is dragged.
 *
 * `mirrorMode` is only written when a tool or the user states it, so a point
 * pulled out with the pen, or converted by `convertAnchor` on another path, can
 * carry mirrored handles with no mode on record. Figma mirrors those: drag
 * either side and the twin stays opposite and equal. Reading the mode as
 * `undefined → none` (the pre-fix behaviour) meant a freshly drawn curve
 * quietly broke its own tangency the first time a handle was nudged.
 *
 * So: an authored mode always wins; without one, the handles themselves declare
 * it — opposite and equal is `angleAndLength`, collinear-but-unequal is
 * `angle`, anything else is independent.
 */
export function effectiveMirrorMode(p: MirrorablePoint): PointMirrorMode {
  if (p.mirrorMode) return p.mirrorMode;
  const inX = p.ix ?? 0;
  const inY = p.iy ?? 0;
  const outX = p.ox ?? 0;
  const outY = p.oy ?? 0;
  const inLen = Math.hypot(inX, inY);
  const outLen = Math.hypot(outX, outY);
  if (inLen < 1e-6 || outLen < 1e-6) return "none";
  // Opposite *direction*, which the sum of the two vectors cannot tell you once
  // the lengths differ (that is the whole `angle` case): collinear means the sin
  // of the angle between them is nil, pointing the other way means a negative dot.
  // The tolerance is a sine, so ~0.006 degrees — enough to survive the float noise
  // a node rotation or non-uniform scale leaves on the tangents, tight enough that
  // a deliberately kinked handle pair still reads as independent.
  const collinear = Math.abs(inX * outY - inY * outX) / (inLen * outLen) <= 1e-4;
  if (!collinear || inX * outX + inY * outY >= 0) return "none";
  const scale = Math.max(inLen, outLen, 1);
  return Math.abs(inLen - outLen) <= 1e-6 * scale ? "angleAndLength" : "angle";
}

/**
 * The result of an Option-drag on a handle.
 *
 * Figma does not give the mirror back when the modifier comes off: Option
 * *breaks* the point, and its two handles stay independent from then on. The
 * drag writes this onto the point (through `patchPath`, so it lands inside the
 * same undo step as the handle move itself).
 */
export const BREAK_MIRROR_MODE: PointMirrorMode = "none";

/* ------------------------------------------------------------------------- *
 * Anchor / segment hit rules shared by hover and press.
 * ------------------------------------------------------------------------- */

/** The vertex under a point, or null. Both the double-click that opens a path
 *  and the pen's join test need the same answer: nearest vertex inside the
 *  tolerance. `maxDist` is in the same space as the coordinates (world px, i.e.
 *  a screen tolerance divided by zoom). */
export function anchorIndexAt(
  pts: { x: number; y: number }[],
  x: number,
  y: number,
  maxDist: number,
): number | null {
  let best = -1;
  let bestDist = maxDist;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(x - pts[i].x, y - pts[i].y);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best >= 0 ? best : null;
}

/* ------------------------------------------------------------------------- *
 * Adding a point to an existing path (Figma's "+" pen state).
 * ------------------------------------------------------------------------- */

/** Screen-pixel tolerances, divided by zoom by the caller so they read the same
 *  at 25% as at 800%. An insert only happens comfortably inside a segment —
 *  never on an endpoint. */
export const ADD_POINT_TOL_PX = 10;
/** How close a press takes the *anchor* instead of inserting, per gesture: 8 px
 *  inside a point edit (the anchor grab in `onDown`) and 10 px for the pen (its
 *  join/branch test). The preview has to bow out at exactly the radius the press
 *  grabs at, or it advertises an insert that never happens. */
export const VERTEX_PRIORITY_PX = { edit: 8, pen: 10 };

/** Where the next click lands an anchor.
 *
 *  Figma's Pen shows a "+" on the path you are about to add a point to, and in
 *  point edit the same rule applies to the selected segment. The preview and the
 *  click have to agree exactly, so they share this one measurement: the pointer
 *  is either on a vertex (which *moves* a point, so there is no insert to
 *  advertise) or within `ADD_POINT_TOL_PX` of a segment away from its ends, in
 *  which case the returned point is where the insert will go — on the curve for a
 *  Bézier segment, not on its chord.
 */
export function addPointTargetAt(
  pts: PathPoint[],
  local: { x: number; y: number },
  closed: boolean,
  zoom: number,
  vertexPx: number = VERTEX_PRIORITY_PX.edit,
): { x: number; y: number; segIndex: number } | null {
  if (anchorIndexAt(pts, local.x, local.y, vertexPx / zoom) !== null) return null;
  const hit = nearestSegmentForInsert(pts, local.x, local.y, closed, ADD_POINT_TOL_PX / zoom);
  if (!hit) return null;
  // `segmentInsertLanding` is the same choice `insertPointOnPath` makes, so the
  // preview cannot promise a point the click will not put there.
  const at = segmentInsertLanding(hit, ADD_POINT_TOL_PX / zoom);
  return { x: at.x, y: at.y, segIndex: hit.segIndex };
}
