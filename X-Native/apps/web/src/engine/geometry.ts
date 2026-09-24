import type { BooleanOp, PathPoint, VectorNetwork, VectorSegment, VectorVertex, XNode } from "./types";

/** Sample a node's outline in local coordinates (for booleans / vector edit). */
export function shapePoly(n: XNode, steps = 48): PathPoint[] {
  if ((n.kind === "vector" || n.kind === "boolean") && n.path.length) return n.path.map((p) => ({ ...p }));
  const w = Math.max(1, n.w);
  const h = Math.max(1, n.h);
  if (n.kind === "ellipse") {
    const pts: PathPoint[] = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      pts.push({ x: w / 2 + Math.cos(a) * (w / 2), y: h / 2 + Math.sin(a) * (h / 2) });
    }
    return pts;
  }
  if (n.kind === "star") {
    const pts: PathPoint[] = [];
    const count = Math.max(3, Math.min(60, Math.round(n.count || 5)));
    const inner = n.starRatio || 0.4;
    const rx = w / 2;
    const ry = h / 2;
    for (let i = 0; i < count * 2; i++) {
      const a = (i * Math.PI) / count - Math.PI / 2;
      const k = i % 2 === 0 ? 1 : inner;
      pts.push({ x: w / 2 + Math.cos(a) * rx * k, y: h / 2 + Math.sin(a) * ry * k });
    }
    return pts;
  }
  if (n.kind === "poly") {
    const pts: PathPoint[] = [];
    const count = Math.max(3, Math.min(60, Math.round(n.count || 3)));
    const rx = w / 2;
    const ry = h / 2;
    for (let i = 0; i < count; i++) {
      const a = (i * 2 * Math.PI) / count - Math.PI / 2;
      pts.push({ x: w / 2 + Math.cos(a) * rx, y: h / 2 + Math.sin(a) * ry });
    }
    return pts;
  }
  if (n.kind === "line" || n.kind === "arrow") {
    return [
      { x: 0, y: h / 2 },
      { x: w, y: h / 2 },
    ];
  }
  const raw = n.cornerIndependent ? n.cornerRadii : [n.cornerRadii[0], n.cornerRadii[0], n.cornerRadii[0], n.cornerRadii[0]];
  const tl = Math.min(Math.max(0, raw[0] || 0), w / 2, h / 2);
  const tr = Math.min(Math.max(0, raw[1] || 0), w / 2, h / 2);
  const bl = Math.min(Math.max(0, raw[2] || 0), w / 2, h / 2);
  const br = Math.min(Math.max(0, raw[3] || 0), w / 2, h / 2);
  if (!(tl || tr || bl || br)) return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const k = 0.5522847498;
  return [
    { x: tl, y: 0, ix: -tl * k, iy: 0, ox: tl * k, oy: 0 },
    { x: w - tr, y: 0, ix: -tr * k, iy: 0, ox: tr * k, oy: 0 },
    { x: w, y: tr, ix: 0, iy: -tr * k, ox: 0, oy: tr * k },
    { x: w, y: h - br, ix: 0, iy: -br * k, ox: 0, oy: br * k },
    { x: w - br, y: h, ix: br * k, iy: 0, ox: -br * k, oy: 0 },
    { x: bl, y: h, ix: bl * k, iy: 0, ox: -bl * k, oy: 0 },
    { x: 0, y: h - bl, ix: 0, iy: bl * k, ox: 0, oy: -bl * k },
    { x: 0, y: tl, ix: 0, iy: tl * k, ox: 0, oy: -tl * k },
  ];
}

/** Return an outline in the node's parent coordinate system, including its local transform. */
export function transformedPoly(n: XNode): PathPoint[] {
  const points = shapePoly(n);
  const cx = n.w / 2;
  const cy = n.h / 2;
  const a = (n.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return points.map((p) => {
    const sx = n.flipH ? cx - (p.x - cx) : p.x;
    const sy = n.flipV ? cy - (p.y - cy) : p.y;
    const dx = sx - cx;
    const dy = sy - cy;
    return {
      ...p,
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
    };
  });
}

function inside(poly: PathPoint[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y + 1e-9) + a.x) hit = !hit;
  }
  return hit;
}

function combine(op: BooleanOp, a: boolean, b: boolean): boolean {
  if (op === "union") return a || b;
  if (op === "subtract") return a && !b;
  if (op === "intersect") return a && b;
  return a !== b;
}

/** Raster-guided boolean → polyline contours (same approach as x-core). */
export function booleanPath(
  op: BooleanOp,
  shapes: { poly: PathPoint[]; ox: number; oy: number }[],
): { path: PathPoint[]; x: number; y: number; w: number; h: number } | null {
  if (shapes.length < 2) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const world = shapes.map((s) => {
    const pts = s.poly.map((p) => ({ x: p.x + s.ox, y: p.y + s.oy }));
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return pts;
  });
  if (!isFinite(minX)) return null;
  const pad = 2;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const bw = Math.max(2, maxX - minX);
  const bh = Math.max(2, maxY - minY);
  const res = 160;
  const gw = res;
  const gh = Math.max(8, Math.round((bh / bw) * res));
  const sx = bw / gw;
  const sy = bh / gh;
  const cov: boolean[][] = [];
  for (let y = 0; y < gh; y++) {
    const row: boolean[] = [];
    const py = minY + (y + 0.5) * sy;
    for (let x = 0; x < gw; x++) {
      const px = minX + (x + 0.5) * sx;
      let v = inside(world[0], px, py);
      for (let i = 1; i < world.length; i++) v = combine(op, v, inside(world[i], px, py));
      row.push(v);
    }
    cov.push(row);
  }
  const path: PathPoint[] = [];
  const seen = new Set<string>();
  const at = (x: number, y: number) => y >= 0 && x >= 0 && y < gh && x < gw && cov[y][x];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!cov[y][x]) continue;
      if (at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)) continue;
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      let cx = x;
      let cy = y;
      const ring: PathPoint[] = [];
      for (let n = 0; n < gw * gh; n++) {
        const k = `${cx},${cy}`;
        if (seen.has(k)) break;
        seen.add(k);
        ring.push({ x: minX + (cx + 0.5) * sx, y: minY + (cy + 0.5) * sy });
        const nbs: [number, number][] = [
          [cx + 1, cy],
          [cx, cy + 1],
          [cx - 1, cy],
          [cx, cy - 1],
          [cx + 1, cy + 1],
          [cx - 1, cy + 1],
          [cx + 1, cy - 1],
          [cx - 1, cy - 1],
        ];
        const next = nbs.find(([nx, ny]) => at(nx, ny) && !seen.has(`${nx},${ny}`) && edge(at, nx, ny));
        if (!next) break;
        cx = next[0];
        cy = next[1];
      }
      if (ring.length >= 3) {
        const simp = simplify(ring, Math.max(sx, sy) * 0.85);
        const curved = shapes.some((s) => s.poly.some((p) => (p.ox && p.ox !== 0) || (p.oy && p.oy !== 0)));
        path.push(...(curved && simp.length >= 4 ? smoothPath(simp, true, 0.35) : simp));
      }
    }
  }
  if (path.length < 3) return null;
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return {
    path: path.map((p) => ({ x: p.x - x0, y: p.y - y0 })),
    x: x0,
    y: y0,
    w: Math.max(1, Math.max(...xs) - x0),
    h: Math.max(1, Math.max(...ys) - y0),
  };
}

function edge(at: (x: number, y: number) => boolean, x: number, y: number) {
  return !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1);
}

function simplify(pts: PathPoint[], eps: number): PathPoint[] {
  if (pts.length <= 2) return pts;
  const [x0, y0] = [pts[0].x, pts[0].y];
  const last = pts[pts.length - 1];
  const dx = last.x - x0;
  const dy = last.y - y0;
  const len = Math.hypot(dx, dy) || 1;
  let max = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * (pts[i].x - x0) - dx * (pts[i].y - y0)) / len;
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max > eps) {
    const left = simplify(pts.slice(0, idx + 1), eps);
    const right = simplify(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], last];
}

export function outlineStroke(path: PathPoint[], width: number, closed: boolean): PathPoint[] {
  if (path.length < 2 || width <= 0) return path;
  const hw = width / 2;
  const left: PathPoint[] = [];
  const right: PathPoint[] = [];
  for (let i = 0; i < path.length; i++) {
    const prev = path[i === 0 ? (closed ? path.length - 1 : 0) : i - 1];
    const next = path[i === path.length - 1 ? (closed ? 0 : i) : i + 1];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * hw;
    const ny = (dx / len) * hw;
    left.push({ x: path[i].x + nx, y: path[i].y + ny });
    right.push({ x: path[i].x - nx, y: path[i].y - ny });
  }
  return [...left, ...right.reverse()];
}

/**
 * Ramer–Douglas–Peucker simplification over anchor positions.
 *
 * Mirrors `x-editor::vector_edit::simplify_path`. The freehand tools capture a
 * raw mouse sample every pointermove, which yields hundreds of near-duplicate
 * anchors; without this a single pencil stroke is both visually jagged and
 * expensive to hit-test.
 */
export function simplifyPath(pts: PathPoint[], tolerance: number): PathPoint[] {
  if (pts.length < 3 || tolerance <= 0) return pts;
  return simplify(pts, tolerance);
}

/**
 * Fit smooth bezier handles through a polyline (Catmull–Rom → cubic).
 *
 * `tension` 0 gives a polyline, 1 is very loose; Figma's pencil sits near 0.5.
 * Handles are stored relative to their anchor, matching `PathPoint`.
 */
export function smoothPath(pts: PathPoint[], closed: boolean, tension = 0.5): PathPoint[] {
  if (pts.length < 3) return pts;
  const n = pts.length;
  const k = tension / 3;
  return pts.map((p, i) => {
    const prev = pts[i === 0 ? (closed ? n - 1 : 0) : i - 1];
    const next = pts[i === n - 1 ? (closed ? 0 : n - 1) : i + 1];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    return { x: p.x, y: p.y, ix: -dx * k, iy: -dy * k, ox: dx * k, oy: dy * k };
  });
}

/**
 * Erase the part of an open polyline that falls inside a circular brush.
 *
 * Returns one entry per surviving run, so erasing through the middle of a
 * stroke splits it into two paths — which is what Figma's eraser does to
 * vector geometry, rather than deleting the whole layer.
 */
export function erasePath(
  pts: PathPoint[],
  cx: number,
  cy: number,
  radius: number,
): PathPoint[][] {
  if (!pts.length) return [];
  const runs: PathPoint[][] = [];
  let run: PathPoint[] = [];
  for (const p of pts) {
    if (Math.hypot(p.x - cx, p.y - cy) <= radius) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * Converts a sequence of `PathPoint`s to Figma's `VectorNetwork` graph representation.
 */
export function pathToVectorNetwork(path: PathPoint[], closed: boolean): VectorNetwork {
  if (!path.length) return { vertices: [], segments: [] };
  const vertices: VectorVertex[] = path.map((p) => ({
    x: p.x,
    y: p.y,
    ...(p.cornerRadius != null ? { cornerRadius: p.cornerRadius } : {}),
  }));
  const segments: VectorSegment[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const cur = path[i];
    const nxt = path[i + 1];
    segments.push({
      start: i,
      end: i + 1,
      tangentStart: cur.ox != null || cur.oy != null ? { x: cur.ox ?? 0, y: cur.oy ?? 0 } : undefined,
      tangentEnd: nxt.ix != null || nxt.iy != null ? { x: nxt.ix ?? 0, y: nxt.iy ?? 0 } : undefined,
    });
  }

  if (closed && path.length > 2) {
    const last = path[path.length - 1];
    const first = path[0];
    segments.push({
      start: path.length - 1,
      end: 0,
      tangentStart: last.ox != null || last.oy != null ? { x: last.ox ?? 0, y: last.oy ?? 0 } : undefined,
      tangentEnd: first.ix != null || first.iy != null ? { x: first.ix ?? 0, y: first.iy ?? 0 } : undefined,
    });
  }

  const regions = closed && path.length > 2
    ? [{ windingRule: "NONZERO" as const, loops: [Array.from({ length: path.length }, (_, i) => i)] }]
    : undefined;

  return { vertices, segments, regions };
}

/**
 * Calculate the degree (connected segment count) for a vertex in a VectorNetwork.
 * A degree >= 3 indicates a branching point (Figma Vector Network characteristic).
 */
export function vertexDegree(vn: VectorNetwork, vertexIndex: number): number {
  let count = 0;
  for (const s of vn.segments) {
    if (s.start === vertexIndex) count++;
    if (s.end === vertexIndex) count++;
  }
  return count;
}

/**
 * Returns segment indices connected to the given vertex.
 */
export function connectedSegments(vn: VectorNetwork, vertexIndex: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < vn.segments.length; i++) {
    const s = vn.segments[i];
    if (s.start === vertexIndex || s.end === vertexIndex) result.push(i);
  }
  return result;
}

/**
 * Adds a new branch connecting an existing vertex to a new or existing vertex.
 * If target exists or is newly created, connects a segment with optional tangent handles.
 */
export function addVectorBranch(
  vn: VectorNetwork,
  fromVertexIndex: number,
  to: VectorVertex,
  tangentStart?: { x: number; y: number },
  tangentEnd?: { x: number; y: number },
): VectorNetwork {
  const vertices = [...vn.vertices];
  let targetIndex = -1;

  // Check if target matches an existing vertex within 1px
  for (let i = 0; i < vertices.length; i++) {
    if (Math.hypot(vertices[i].x - to.x, vertices[i].y - to.y) < 1) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    targetIndex = vertices.length;
    vertices.push({ x: to.x, y: to.y, strokeCap: to.strokeCap, strokeJoin: to.strokeJoin });
  }

  // Avoid duplicate identical segment
  const exists = vn.segments.some(
    (s) =>
      (s.start === fromVertexIndex && s.end === targetIndex) ||
      (s.start === targetIndex && s.end === fromVertexIndex),
  );

  const segments = [...vn.segments];
  if (!exists && fromVertexIndex !== targetIndex) {
    segments.push({
      start: fromVertexIndex,
      end: targetIndex,
      tangentStart,
      tangentEnd,
    });
  }

  return {
    vertices,
    segments,
    regions: vn.regions,
  };
}

/**
 * Converts a `VectorNetwork` into a standard SVG path definition string (`d="..."`).
 */
export function vectorNetworkToSvgPath(vn: VectorNetwork): string {
  if (!vn.vertices.length || !vn.segments.length) return "";
  const parts: string[] = [];

  for (const s of vn.segments) {
    const v0 = vn.vertices[s.start];
    const v1 = vn.vertices[s.end];
    if (!v0 || !v1) continue;

    parts.push(`M ${v0.x.toFixed(2)} ${v0.y.toFixed(2)}`);
    if (s.tangentStart || s.tangentEnd) {
      const c1x = (v0.x + (s.tangentStart?.x ?? 0)).toFixed(2);
      const c1y = (v0.y + (s.tangentStart?.y ?? 0)).toFixed(2);
      const c2x = (v1.x + (s.tangentEnd?.x ?? 0)).toFixed(2);
      const c2y = (v1.y + (s.tangentEnd?.y ?? 0)).toFixed(2);
      parts.push(`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${v1.x.toFixed(2)} ${v1.y.toFixed(2)}`);
    } else {
      parts.push(`L ${v1.x.toFixed(2)} ${v1.y.toFixed(2)}`);
    }
  }

  return parts.join(" ");
}

/**
 * Converts a simple (degree <= 2) VectorNetwork back to a `PathPoint[]` array.
 */
export function vectorNetworkToPath(vn: VectorNetwork): { path: PathPoint[]; closed: boolean } {
  if (!vn.vertices.length) return { path: [], closed: false };
  if (!vn.segments.length) {
    return { path: vn.vertices.map((v) => ({ x: v.x, y: v.y })), closed: false };
  }

  // Follow segments
  const path: PathPoint[] = [];
  const visited = new Set<number>();
  let cur = vn.segments[0].start;
  let closed = false;

  path.push({ x: vn.vertices[cur].x, y: vn.vertices[cur].y });
  visited.add(cur);

  let advanced = true;
  while (advanced) {
    advanced = false;
    const seg = vn.segments.find((s) => s.start === cur && !visited.has(s.end));
    if (seg) {
      const lastPoint = path[path.length - 1];
      if (seg.tangentStart) {
        lastPoint.ox = seg.tangentStart.x;
        lastPoint.oy = seg.tangentStart.y;
      }
      const nextV = vn.vertices[seg.end];
      path.push({
        x: nextV.x,
        y: nextV.y,
        ix: seg.tangentEnd?.x,
        iy: seg.tangentEnd?.y,
      });
      visited.add(seg.end);
      cur = seg.end;
      advanced = true;
    }
  }

  // Check if closed
  if (vn.segments.some((s) => s.start === cur && s.end === vn.segments[0].start)) {
    closed = true;
  }

  return { path, closed };
}

/**
 * Projects a point onto a line segment and calculates orthogonal distance.
 */
export function projectPointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number; dist: number; t: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { x: x1, y: y1, dist: Math.hypot(px - x1, py - y1), t: 0 };
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return { x: projX, y: projY, dist: Math.hypot(px - projX, py - projY), t };
}

/**
 * Inserts a new point onto an existing vector path by splitting the nearest segment.
 */
export function insertPointOnPath(
  pts: PathPoint[],
  px: number,
  py: number,
  closed: boolean,
  maxDist = 12,
): { newPath: PathPoint[]; insertedIndex: number } | null {
  if (pts.length < 2) return null;
  const n = pts.length;
  const count = closed ? n : n - 1;
  let bestDist = maxDist;
  let bestIdx = -1;
  let bestProj = { x: px, y: py };

  for (let i = 0; i < count; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const res = projectPointOnSegment(px, py, p1.x, p1.y, p2.x, p2.y);
    if (res.dist < bestDist && res.t > 0.05 && res.t < 0.95) {
      bestDist = res.dist;
      bestIdx = i;
      bestProj = { x: res.x, y: res.y };
    }
  }

  if (bestIdx === -1) return null;

  const newPt: PathPoint = { x: bestProj.x, y: bestProj.y };
  const newPath = [...pts];
  newPath.splice(bestIdx + 1, 0, newPt);
  return { newPath, insertedIndex: bestIdx + 1 };
}

/**
 * Bends a path segment towards a mouse drag point (Bend Tool / Curvature Tool).
 * Calculates exact cubic Bézier handles on the segment endpoints so the curve passes through (dragX, dragY).
 */
export function bendSegment(
  pts: PathPoint[],
  segIndex: number,
  closed: boolean,
  dragX: number,
  dragY: number,
): PathPoint[] {
  const n = pts.length;
  if (segIndex < 0 || (closed ? segIndex >= n : segIndex >= n - 1)) return pts;

  const p0 = pts[segIndex];
  const p1 = pts[(segIndex + 1) % n];

  // Pass through mouse point at t=0.5
  const cx = 2 * dragX - 0.5 * (p0.x + p1.x);
  const cy = 2 * dragY - 0.5 * (p0.y + p1.y);

  // Convert quadratic control point to cubic bezier handles
  const cp1x = p0.x + (2 / 3) * (cx - p0.x);
  const cp1y = p0.y + (2 / 3) * (cy - p0.y);
  const cp2x = p1.x + (2 / 3) * (cx - p1.x);
  const cp2y = p1.y + (2 / 3) * (cy - p1.y);

  const newPts = pts.map((p) => ({ ...p }));
  newPts[segIndex].ox = cp1x - p0.x;
  newPts[segIndex].oy = cp1y - p0.y;
  newPts[(segIndex + 1) % n].ix = cp2x - p1.x;
  newPts[(segIndex + 1) % n].iy = cp2y - p1.y;

  return newPts;
}

/**
 * Finds all fundamental closed loops/faces in a VectorNetwork graph
 * to automatically form filled planar regions.
 */
export function findNetworkLoops(vn: VectorNetwork): number[][] {
  if (vn.vertices.length < 3 || vn.segments.length < 3) return [];
  const adj = new Map<number, number[]>();
  for (let i = 0; i < vn.vertices.length; i++) adj.set(i, []);
  for (const s of vn.segments) {
    adj.get(s.start)?.push(s.end);
    adj.get(s.end)?.push(s.start);
  }

  const loops: number[][] = [];
  const visited = new Set<string>();

  const findCyclesFrom = (start: number, cur: number, path: number[]) => {
    if (path.length > 16) return;
    const neighbors = adj.get(cur) || [];
    for (const next of neighbors) {
      if (next === start && path.length >= 3) {
        const sorted = [...path].sort((a, b) => a - b).join(",");
        if (!visited.has(sorted)) {
          visited.add(sorted);
          loops.push([...path]);
        }
        continue;
      }
      if (!path.includes(next)) {
        findCyclesFrom(start, next, [...path, next]);
      }
    }
  };

  for (let i = 0; i < vn.vertices.length; i++) {
    findCyclesFrom(i, i, [i]);
  }

  return loops;
}

export interface NoodleCurve {
  ax: number;
  ay: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  bx: number;
  by: number;
  angle: number;
  sourceSide: "right" | "bottom" | "left" | "top";
  destSide: "right" | "bottom" | "left" | "top";
}

/**
 * Calculates a smooth, organic Figma-grade S-curve connection noodle between
 * source node and destination frame (or mouse cursor). Dynamically selects the
 * best perimeter edges (right/left/top/bottom) and computes tangential cubic
 * Bézier control handles and rotating arrowhead orientation.
 */
export function computeFigmaNoodle(
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  destX: number,
  destY: number,
  destW: number = 0,
  destH: number = 0,
  forcedSourceSide?: "right" | "bottom" | "left" | "top",
): NoodleCurve {
  const scx = srcX + srcW / 2;
  const scy = srcY + srcH / 2;
  const dcx = destW > 0 ? destX + destW / 2 : destX;
  const dcy = destH > 0 ? destY + destH / 2 : destY;

  const dx = dcx - scx;
  const dy = dcy - scy;

  let sourceSide: "right" | "bottom" | "left" | "top" = forcedSourceSide || "right";
  let destSide: "right" | "bottom" | "left" | "top" = "left";

  if (!forcedSourceSide) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      sourceSide = dx >= 0 ? "right" : "left";
      destSide = dx >= 0 ? "left" : "right";
    } else {
      sourceSide = dy >= 0 ? "bottom" : "top";
      destSide = dy >= 0 ? "top" : "bottom";
    }
  } else {
    if (sourceSide === "right") destSide = "left";
    else if (sourceSide === "left") destSide = "right";
    else if (sourceSide === "bottom") destSide = "top";
    else if (sourceSide === "top") destSide = "bottom";
  }

  let ax = srcX + srcW;
  let ay = scy;
  let normAx = 1;
  let normAy = 0;

  if (sourceSide === "right") {
    ax = srcX + srcW;
    ay = scy;
    normAx = 1;
    normAy = 0;
  } else if (sourceSide === "left") {
    ax = srcX;
    ay = scy;
    normAx = -1;
    normAy = 0;
  } else if (sourceSide === "bottom") {
    ax = scx;
    ay = srcY + srcH;
    normAx = 0;
    normAy = 1;
  } else if (sourceSide === "top") {
    ax = scx;
    ay = srcY;
    normAx = 0;
    normAy = -1;
  }

  let bx = destX;
  let by = destH > 0 ? dcy : destY;
  let normBx = -1;
  let normBy = 0;

  if (destW > 0 || destH > 0) {
    if (destSide === "left") {
      bx = destX;
      by = dcy;
      normBx = -1;
      normBy = 0;
    } else if (destSide === "right") {
      bx = destX + destW;
      by = dcy;
      normBx = 1;
      normBy = 0;
    } else if (destSide === "top") {
      bx = dcx;
      by = destY;
      normBx = 0;
      normBy = -1;
    } else if (destSide === "bottom") {
      bx = dcx;
      by = destY + destH;
      normBx = 0;
      normBy = 1;
    }
  } else {
    bx = destX;
    by = destY;
    const dragDx = bx - ax;
    const dragDy = by - ay;
    const dragDist = Math.hypot(dragDx, dragDy) || 1;
    normBx = -dragDx / dragDist;
    normBy = -dragDy / dragDist;
  }

  const dist = Math.hypot(bx - ax, by - ay);
  const curvature = Math.max(32, Math.min(220, dist * 0.42));

  const cp1x = ax + normAx * curvature;
  const cp1y = ay + normAy * curvature;
  const cp2x = bx + normBx * curvature;
  const cp2y = by + normBy * curvature;

  const angle = Math.atan2(by - cp2y, bx - cp2x);

  return { ax, ay, cp1x, cp1y, cp2x, cp2y, bx, by, angle, sourceSide, destSide };
}

/**
 * Re-break an already wrapped paragraph for Figma's two wrap styles.
 *
 * `lines` is the greedy word wrap, one entry per line, and `widthOf` is the
 * same width model the wrapper used, so the two never disagree about what
 * fits. Greedy first-fit is already the fewest lines a paragraph can have, so
 * the count is fixed and the only freedom is *where* the breaks fall: this
 * picks the partition whose widest line is as narrow as possible, which is
 * what Figma means by distributing the lines evenly. Pretty takes the same
 * partition and then refuses a widow - a lone final word is joined to the
 * line above when it fits, otherwise it borrows a word from it.
 *
 * Space-delimited scripts only: CJK has no word boundaries to move and falls
 * back to the greedy break. Results are memoised because this runs inside the
 * canvas paint, and the search is skipped for very long paragraphs so a page of
 * text cannot turn a pan frame into a dynamic programme.
 */
const BALANCE_CACHE = new Map<string, string[]>();
const BALANCE_CACHE_MAX = 4000;
const BALANCE_MAX_WORDS = 220;

type WidthOf = (s: string) => number;

function evenPartition(lines: string[], maxW: number, widthOf: WidthOf): string[] {
  const words = lines.flatMap((l) => (l.trim() ? l.trim().split(/\s+/) : []));
  const n = words.length;
  const k = lines.filter((l) => l.trim()).length;
  if (n < 2 || k < 2 || n > BALANCE_MAX_WORDS) return lines;
  // For every start word, the words that still fit on one line and their width.
  const fits: { j: number; w: number }[][] = [];
  for (let i = 0; i < n; i++) {
    const row: { j: number; w: number }[] = [];
    let acc = "";
    for (let j = i; j < n; j++) {
      acc = j === i ? words[j] : `${acc} ${words[j]}`;
      const w = widthOf(acc);
      if (w > maxW) break;
      row.push({ j: j + 1, w });
    }
    if (!row.length) return lines; // a word alone does not fit: the wrapper is on its own
    fits.push(row);
  }
  // cost[i][left] = [widest line from i on, sum of squared widths] for `left` lines.
  const INF = Number.POSITIVE_INFINITY;
  const costM = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(INF));
  const costS = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(INF));
  const splitAt = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(-1));
  costM[n][0] = 0;
  costS[n][0] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let left = 1; left <= k; left++) {
      for (let f = fits[i].length - 1; f >= 0; f--) {
      const { j, w } = fits[i][f];
        const rest = costM[j][left - 1];
        if (rest === INF) continue;
        const m = Math.max(w, rest);
        const s = w * w + costS[j][left - 1];
        if (m < costM[i][left] - 0.01 || (Math.abs(m - costM[i][left]) <= 0.01 && s < costS[i][left] - 0.01)) {
          costM[i][left] = m;
          costS[i][left] = s;
          splitAt[i][left] = j;
        }
      }
    }
  }
  if (costM[0][k] === INF) return lines;
  const out: string[] = [];
  let at = 0;
  for (let left = k; left > 0; left--) {
    const j = splitAt[at][left];
    out.push(words.slice(at, j).join(" "));
    at = j;
  }
  return out;
}

export function balanceLines(
  lines: string[],
  maxW: number,
  widthOf: WidthOf,
  mode: "balance" | "pretty",
): string[] {
  if (lines.length < 2 || !(maxW > 0) || !Number.isFinite(maxW)) return lines;
  const key = `${mode}\u0000${Math.round(maxW)}\u0000${lines.join("\n")}`;
  const hit = BALANCE_CACHE.get(key);
  if (hit) return hit;
  let out = evenPartition(lines, maxW, widthOf);
  if (mode === "pretty" && out.length > 1) {
    const last = out[out.length - 1];
    if (last.trim().split(/\s+/).length === 1) {
      const prev = out[out.length - 2];
      const words = prev.trim().split(/\s+/);
      if (words.length > 1 && widthOf(`${last} ${words[words.length - 1]}`) <= maxW)
        out = [...out.slice(0, -2), words.slice(0, -1).join(" "), [...words.slice(-1), last].join(" ")];
      else if (widthOf(`${prev} ${last}`) <= maxW) out = [...out.slice(0, -2), `${prev} ${last}`];
    }
  }
  if (BALANCE_CACHE.size >= BALANCE_CACHE_MAX) BALANCE_CACHE.clear();
  BALANCE_CACHE.set(key, out);
  return out;
}
