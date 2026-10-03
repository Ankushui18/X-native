/** Geometry and selection rules for the vector-edit freeform Lasso tool. */
import type { PathPoint } from "../engine/types";

export interface LassoPoint { x: number; y: number }
export type LassoOperation = "replace" | "add" | "subtract";

/** Boundary points count as inside so a lasso dragged exactly through an
 * anchor doesn't produce a surprising miss. */
export function pointInLasso(point: LassoPoint, polygon: LassoPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const cross = (point.x - a.x) * dy - (point.y - a.y) * dx;
    const dot = (point.x - a.x) * dx + (point.y - a.y) * dy;
    if (Math.abs(cross) <= 1e-7 && dot >= -1e-7 && dot <= dx * dx + dy * dy + 1e-7) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (dx * (point.y - a.y)) / (dy || 1e-9) + a.x)
      inside = !inside;
  }
  return inside;
}

function polygonArea(polygon: LassoPoint[]): number {
  if (polygon.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

function cubicPoint(a: PathPoint, b: PathPoint, t: number): LassoPoint {
  const c1x = a.x + (a.ox ?? 0), c1y = a.y + (a.oy ?? 0);
  const c2x = b.x + (b.ix ?? 0), c2y = b.y + (b.iy ?? 0);
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt ** 2 * t * c1x + 3 * mt * t ** 2 * c2x + t ** 3 * b.x,
    y: mt ** 3 * a.y + 3 * mt ** 2 * t * c1y + 3 * mt * t ** 2 * c2y + t ** 3 * b.y,
  };
}

/**
 * Return the path-point selection produced by a freehand lasso.
 *
 * Anchors inside the polygon are selected directly. A path segment is also
 * included when most of its visible line/cubic lies inside the lasso; because
 * the editor's selection model stores anchor indices, selecting that segment
 * selects its two end anchors. Coordinates are mapped through the complete
 * layer/ancestor transform before testing.
 */
export function lassoSelectPathPoints(
  path: PathPoint[],
  closed: boolean,
  boundary: LassoPoint[],
  toWorld: (x: number, y: number) => LassoPoint,
  previous: number[] = [],
  operation: LassoOperation = "replace",
): number[] {
  if (path.length < 1 || boundary.length < 3 || polygonArea(boundary) < 0.5) return [...previous];
  const hits = new Set<number>();
  path.forEach((p, i) => {
    if (pointInLasso(toWorld(p.x, p.y), boundary)) hits.add(i);
  });

  const segmentCount = closed && path.length > 2 ? path.length : path.length - 1;
  const subdivisions = 20;
  for (let i = 0; i < segmentCount; i++) {
    const start = path[i], end = path[(i + 1) % path.length];
    let inside = 0;
    for (let sample = 1; sample < subdivisions; sample++) {
      const local = cubicPoint(start, end, sample / subdivisions);
      if (pointInLasso(toWorld(local.x, local.y), boundary)) inside++;
    }
    // Avoid selecting a long segment just because the lasso grazed one end;
    // a majority-inside rule represents the Figma notion of lassoing a path.
    if (inside >= Math.ceil((subdivisions - 1) / 2)) {
      hits.add(i);
      hits.add((i + 1) % path.length);
    }
  }

  const previousSet = new Set(previous);
  if (operation === "replace") return [...hits].sort((a, b) => a - b);
  if (operation === "add") {
    for (const index of hits) previousSet.add(index);
    return [...previousSet].sort((a, b) => a - b);
  }
  return [...previousSet].filter((index) => !hits.has(index)).sort((a, b) => a - b);
}
