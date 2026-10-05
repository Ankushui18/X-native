/**
 * Exact vector geometry: Boolean, Offset and Outline Stroke on real polygons.
 *
 * Why this file exists. The earlier implementations were approximations:
 *  - Boolean traced a 160-cell raster, so a union of two 100x100 squares came
 *    out as 149.19 wide with ragged points instead of exactly 150;
 *  - Offset moved points along averaged normals, which shrinks a rectangle on a
 *    positive distance and cannot handle holes or self-overlap;
 *  - Outline Stroke ignored stroke alignment.
 *
 * Everything here works on integer-scaled polygons through Clipper (Vatti
 * clipping + offsetting), the same class of algorithm Figma, Illustrator and
 * Inkscape use. Curves are flattened to a fixed 0.05px tolerance first. The
 * results are exact polygons with proper outer/hole winding.
 *
 * Coordinates in and out are plain numbers in the caller's own space.
 */
import ClipperLib from "clipper-lib";
import type { BooleanOp, PathPoint, StrokeCap, StrokeJoin, VectorNetwork, VectorVertex, VectorSegment } from "./types";

export interface Pt {
  x: number;
  y: number;
}
export type Ring = Pt[];

/** 1/1000 px grid. Clipper is integer-only; this keeps 0.001px precision. */
const SCALE = 1000;
/** Curve flattening tolerance, in px. */
const FLATNESS = 0.05;
/** Round joins/caps: max deviation of the arc from the true circle, in px. */
const ARC_TOLERANCE = 0.02;
/** Same miter limit the native offset used (4x, then bevel). */
const MITER_LIMIT = 4;

const CL: any = ClipperLib;

/* ------------------------------------------------------------------------- *
 * Flattening
 * ------------------------------------------------------------------------- */

function flattenCubic(
  out: Pt[],
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  depth = 0,
) {
  // Flat enough when both control points sit within tolerance of the chord.
  const dx = x3 - x0;
  const dy = y3 - y0;
  const len = Math.hypot(dx, dy);
  let d1: number;
  let d2: number;
  if (len < 1e-9) {
    d1 = Math.hypot(x1 - x0, y1 - y0);
    d2 = Math.hypot(x2 - x0, y2 - y0);
  } else {
    d1 = Math.abs((x1 - x0) * dy - (y1 - y0) * dx) / len;
    d2 = Math.abs((x2 - x0) * dy - (y2 - y0) * dx) / len;
  }
  if (depth >= 12 || Math.max(d1, d2) <= FLATNESS) {
    out.push({ x: x3, y: y3 });
    return;
  }
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  flattenCubic(out, x0, y0, x01, y01, xa, ya, xm, ym, depth + 1);
  flattenCubic(out, xm, ym, xb, yb, x23, y23, x3, y3, depth + 1);
}

/** Flatten a handle-based path (handles relative to their anchor) to a polyline. */
export function flattenPath(path: PathPoint[], closed: boolean): Ring {
  const n = path.length;
  if (n === 0) return [];
  const out: Pt[] = [{ x: path[0].x, y: path[0].y }];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    const curved = a.ox || a.oy || b.ix || b.iy;
    if (curved) {
      flattenCubic(
        out,
        a.x, a.y,
        a.x + (a.ox ?? 0), a.y + (a.oy ?? 0),
        b.x + (b.ix ?? 0), b.y + (b.iy ?? 0),
        b.x, b.y,
      );
    } else {
      out.push({ x: b.x, y: b.y });
    }
  }
  // A closed walk returns to its first point; drop the duplicate.
  if (closed && out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) out.pop();
  }
  return out;
}

/** The closed loops of every region of a vector network, curves flattened. */
export function networkToRings(vn: VectorNetwork): Ring[] {
  const rings: Ring[] = [];
  for (const region of vn.regions ?? []) {
    for (const loop of region.loops) {
      if (loop.length < 3) continue;
      const pts: PathPoint[] = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const va = vn.vertices[a];
        const vb = vn.vertices[b];
        if (!va || !vb) continue;
        const fwd = vn.segments.find((s) => s.start === a && s.end === b);
        const rev = fwd ? undefined : vn.segments.find((s) => s.start === b && s.end === a);
        const p: PathPoint = { x: va.x, y: va.y };
        if (fwd) {
          if (fwd.tangentStart) { p.ox = fwd.tangentStart.x; p.oy = fwd.tangentStart.y; }
        } else if (rev) {
          // Walking the segment backwards: its end tangent becomes our out handle.
          if (rev.tangentEnd) { p.ox = rev.tangentEnd.x; p.oy = rev.tangentEnd.y; }
        }
        // The incoming handle of `a` belongs to the previous edge.
        const prev = loop[(i - 1 + loop.length) % loop.length];
        const pf = vn.segments.find((s) => s.start === prev && s.end === a);
        const pr = pf ? undefined : vn.segments.find((s) => s.start === a && s.end === prev);
        if (pf?.tangentEnd) { p.ix = pf.tangentEnd.x; p.iy = pf.tangentEnd.y; }
        else if (pr?.tangentStart) { p.ix = pr.tangentStart.x; p.iy = pr.tangentStart.y; }
        pts.push(p);
      }
      const ring = flattenPath(pts, true);
      if (ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}

/* ------------------------------------------------------------------------- *
 * Clipper plumbing
 * ------------------------------------------------------------------------- */

const toClip = (rings: Ring[]): any[] =>
  rings
    .map((r) => r.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })))
    .filter((r) => r.length >= 3);

const fromClip = (paths: any[]): Ring[] =>
  paths.map((p: any[]) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }))).filter((r) => r.length >= 3);

/** Normalize an arbitrary (self-crossing, overlapping) fill to proper outer/hole rings. */
function normalize(paths: any[]): any[] {
  if (!paths.length) return [];
  const out = CL.Clipper.SimplifyPolygons(paths, CL.PolyFillType.pftNonZero);
  return CL.Clipper.CleanPolygons(out, 1.5);
}

function clip(type: number, subject: any[], clipPaths: any[]): any[] {
  const c = new CL.Clipper();
  c.AddPaths(subject, CL.PolyType.ptSubject, true);
  c.AddPaths(clipPaths, CL.PolyType.ptClip, true);
  const sol = new CL.Paths();
  c.Execute(type, sol, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
  return CL.Clipper.CleanPolygons(sol, 1.5);
}

/* ------------------------------------------------------------------------- *
 * Boolean
 * ------------------------------------------------------------------------- */

const CLIP_TYPE: Record<BooleanOp, number> = {
  union: CL.ClipType.ctUnion,
  subtract: CL.ClipType.ctDifference,
  intersect: CL.ClipType.ctIntersection,
  exclude: CL.ClipType.ctXor,
};

/**
 * Fold the operands left to right: `a op b op c`. Subtract removes every later
 * operand from the first; exclude is a chain of XORs. Each operand is a set of
 * rings (a shape with holes is several rings).
 */
export function booleanRings(op: BooleanOp, operands: Ring[][]): Ring[] {
  if (operands.length < 2) return operands[0] ?? [];
  let acc = normalize(toClip(operands[0]));
  for (let i = 1; i < operands.length; i++) {
    const next = normalize(toClip(operands[i]));
    acc = clip(CLIP_TYPE[op], acc, next);
  }
  return fromClip(acc);
}

/* ------------------------------------------------------------------------- *
 * Offset
 * ------------------------------------------------------------------------- */

const joinType = (j: StrokeJoin | undefined) =>
  j === "round" ? CL.JoinType.jtRound : j === "bevel" ? CL.JoinType.jtSquare : CL.JoinType.jtMiter;

function offsetClip(paths: any[], delta: number, jt: number, et: number): any[] {
  if (!paths.length) return [];
  const co = new CL.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE * SCALE);
  co.AddPaths(paths, jt, et);
  const sol = new CL.Paths();
  co.Execute(sol, delta * SCALE);
  return sol;
}

/**
 * Grow (positive) or shrink (negative) a filled shape by `distance` px on every
 * side. Holes move the opposite way, so a donut's hole shrinks when the donut
 * grows. Insets that consume a part of the shape remove that part.
 */
export function offsetRings(rings: Ring[], distance: number, join: StrokeJoin = "round"): Ring[] {
  const base = normalize(toClip(rings));
  if (!base.length || !isFinite(distance)) return fromClip(base);
  if (Math.abs(distance) * SCALE < 1) return fromClip(base);
  const out = offsetClip(base, distance, joinType(join), CL.EndType.etClosedPolygon);
  return fromClip(CL.Clipper.CleanPolygons(out, 1.5));
}

/* ------------------------------------------------------------------------- *
 * Outline Stroke
 * ------------------------------------------------------------------------- */

export type StrokeAlign = "inside" | "center" | "outside";

/**
 * The stroke of a closed shape as filled geometry. Inside keeps the stroke in
 * the shape, outside puts it fully outside, center straddles the edge.
 */
export function outlineClosedRings(
  rings: Ring[],
  width: number,
  align: StrokeAlign = "center",
  join: StrokeJoin = "miter",
): Ring[] {
  if (!(width > 0)) return [];
  const base = normalize(toClip(rings));
  if (!base.length) return [];
  const grow = align === "inside" ? 0 : align === "outside" ? width : width / 2;
  const shrink = align === "inside" ? width : align === "outside" ? 0 : width / 2;
  const jt = joinType(join);
  const outer = grow > 0 ? offsetClip(base, grow, jt, CL.EndType.etClosedPolygon) : base;
  const inner = shrink > 0 ? offsetClip(base, -shrink, jt, CL.EndType.etClosedPolygon) : base;
  const band = inner.length ? clip(CL.ClipType.ctDifference, normalize(outer), normalize(inner)) : normalize(outer);
  return fromClip(band);
}

/** The stroke of an open polyline, with the requested end caps. */
export function outlineOpenPolyline(
  line: Ring,
  width: number,
  cap: StrokeCap | string = "none",
  join: StrokeJoin = "miter",
): Ring[] {
  if (!(width > 0) || line.length < 2) return [];
  const et = cap === "round" ? CL.EndType.etOpenRound : cap === "square" ? CL.EndType.etOpenSquare : CL.EndType.etOpenButt;
  // toClip drops rings under 3 points (right for polygons, wrong for a 2-point line).
  const open = [line.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))];
  const out = offsetClip(open, width / 2, joinType(join), et);
  return fromClip(normalize(out));
}

/* ------------------------------------------------------------------------- *
 * Assembly
 * ------------------------------------------------------------------------- */

export interface ExactResult {
  /** All rings concatenated (the legacy single `path` walk). */
  path: PathPoint[];
  /** Frame of the result in the caller's space. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rings relative to (x, y), with hole winding opposite to its outer ring. */
  network: VectorNetwork;
}

/**
 * Rings → path + network in the SAME coordinate space as the rings (no
 * re-origin). Used when a node keeps its frame and `normalizeVectorNode`
 * re-fits it afterwards, so rotation/flip compensation stays in one place.
 */
export function ringsToNetwork(rings: Ring[]): { path: PathPoint[]; network: VectorNetwork } | null {
  const live = rings.filter((r) => r.length >= 3);
  if (!live.length) return null;
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];
  const loops: number[][] = [];
  const path: PathPoint[] = [];
  for (const r of live) {
    const base = vertices.length;
    const loop: number[] = [];
    for (let i = 0; i < r.length; i++) {
      vertices.push({ x: r[i].x, y: r[i].y });
      path.push({ x: r[i].x, y: r[i].y });
      loop.push(base + i);
      segments.push({ start: base + i, end: base + ((i + 1) % r.length) });
    }
    loops.push(loop);
  }
  return { path, network: { vertices, segments, regions: [{ windingRule: "NONZERO", loops }] } };
}

/**
 * Boolean over node polygons (the shape `booleanPath` has always taken):
 * each operand is a closed polygon offset by (ox, oy). Returns null when the
 * result is empty, like the raster tracer did.
 */
export function exactBooleanPath(
  op: BooleanOp,
  shapes: { poly: PathPoint[]; ox: number; oy: number }[],
): ExactResult | null {
  if (shapes.length < 2) return null;
  const operands = shapes.map((s) => [
    flattenPath(s.poly.map((p) => ({ ...p, x: p.x + s.ox, y: p.y + s.oy })), true),
  ]);
  return ringsToResult(booleanRings(op, operands));
}

/** Rings → vector node geometry, positioned at the rings' own bounding box. */
export function ringsToResult(rings: Ring[]): ExactResult | null {
  const live = rings.filter((r) => r.length >= 3);
  if (!live.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of live) {
    for (const p of r) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];
  const loops: number[][] = [];
  const path: PathPoint[] = [];
  for (const r of live) {
    const base = vertices.length;
    const loop: number[] = [];
    for (let i = 0; i < r.length; i++) {
      const x = r[i].x - minX;
      const y = r[i].y - minY;
      vertices.push({ x, y });
      path.push({ x, y });
      loop.push(base + i);
      segments.push({ start: base + i, end: base + ((i + 1) % r.length) });
    }
    loops.push(loop);
  }
  return {
    path,
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    network: { vertices, segments, regions: [{ windingRule: "NONZERO", loops }] },
  };
}

/* ------------------------------------------------------------------------- *
 * Node-level entry points (what the editor commands call)
 * ------------------------------------------------------------------------- */

interface GeomNode {
  path: PathPoint[];
  closed?: boolean;
  vectorNetwork?: VectorNetwork;
}

/**
 * The closed rings of a node's shape, in node-local space. A node with network
 * regions (a donut, a flattened boolean) contributes every loop, so holes are
 * kept. Otherwise the single path is flattened. `null` for open geometry.
 */
export function closedRingsOf(n: GeomNode, fallback: PathPoint[], closed: boolean): Ring[] | null {
  const vn = n.vectorNetwork;
  if (vn?.regions?.length) {
    const rings = networkToRings(vn);
    if (rings.length) return rings;
  }
  if (!closed) return null;
  const ring = flattenPath(n.path.length ? n.path : fallback, true);
  return ring.length >= 3 ? [ring] : null;
}

/**
 * Split an open vector network into trails: maximal walks through vertices of
 * degree 2. Ends sit on a free end (degree 1) or a junction (degree 3+).
 * Closed cycles with no junction come back flagged `closed`. Handles are
 * oriented along the walk, so a reversed segment swaps its tangents.
 */
export function networkTrails(vn: VectorNetwork): { pts: PathPoint[]; closed: boolean; startJunction: boolean; endJunction: boolean }[] {
  const segs = vn.segments.filter((sg) => vn.vertices[sg.start] && vn.vertices[sg.end] && sg.start !== sg.end);
  const adj = new Map<number, number[]>();
  segs.forEach((sg, i) => {
    for (const v of [sg.start, sg.end]) {
      if (!adj.has(v)) adj.set(v, []);
      adj.get(v)!.push(i);
    }
  });
  const deg = (v: number) => adj.get(v)?.length ?? 0;
  const used = new Array(segs.length).fill(false);
  const out: { pts: PathPoint[]; closed: boolean; startJunction: boolean; endJunction: boolean }[] = [];

  const walk = (startV: number, firstSeg: number) => {
    const pts: PathPoint[] = [];
    let v = startV;
    let si = firstSeg;
    const base = (idx: number): PathPoint => ({ x: vn.vertices[idx].x, y: vn.vertices[idx].y });
    pts.push(base(v));
    let closed = false;
    for (;;) {
      used[si] = true;
      const sg = segs[si];
      const fwd = sg.start === v;
      const next = fwd ? sg.end : sg.start;
      const outT = fwd ? sg.tangentStart : sg.tangentEnd;
      const inT = fwd ? sg.tangentEnd : sg.tangentStart;
      const last = pts[pts.length - 1];
      if (outT) { last.ox = outT.x; last.oy = outT.y; }
      const np = base(next);
      if (inT) { np.ix = inT.x; np.iy = inT.y; }
      pts.push(np);
      v = next;
      if (v === startV && pts.length > 2) { closed = true; break; }
      if (deg(v) !== 2) break;
      const cand = adj.get(v)!.find((k) => !used[k]);
      if (cand === undefined) break;
      si = cand;
    }
    if (closed) {
      // The walk returned to its start: fold the duplicate end into point 0.
      const endP = pts.pop()!;
      if (endP.ix !== undefined) { pts[0].ix = endP.ix; pts[0].iy = endP.iy; }
    }
    out.push({ pts, closed, startJunction: deg(startV) > 2, endJunction: !closed && deg(v) > 2 });
  };

  for (const v of adj.keys()) {
    if (deg(v) === 2) continue;
    for (const k of adj.get(v)!) if (!used[k]) walk(v, k);
  }
  segs.forEach((sg, i) => { if (!used[i]) walk(sg.start, i); }); // pure cycles
  return out;
}

const discRing = (c: Pt, r: number, n = 48): Ring =>
  Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((i / n) * 2 * Math.PI), y: c.y + r * Math.sin((i / n) * 2 * Math.PI) }));

/** The stroke of a whole open network: every branch, joined at junctions. */
export function outlineNetworkRings(
  vn: VectorNetwork,
  width: number,
  cap: StrokeCap | string,
  join: StrokeJoin,
): Ring[] {
  const pieces: Ring[][] = [];
  for (const t of networkTrails(vn)) {
    const line = flattenPath(t.pts, t.closed);
    if (t.closed) {
      pieces.push(outlineClosedRings([line], width, "center", join));
      continue;
    }
    pieces.push(outlineOpenPolyline(line, width, cap, join));
    // A junction end is not a free end: no user cap there, a disc seals the joint.
    if (t.startJunction) pieces.push([discRing(line[0], width / 2)]);
    if (t.endJunction) pieces.push([discRing(line[line.length - 1], width / 2)]);
  }
  const all = pieces.flat();
  if (all.length <= 1) return all;
  // Union the pieces (each already carries its own winding).
  const c = new CL.Clipper();
  for (const piece of pieces) c.AddPaths(normalize(toClip(piece)), CL.PolyType.ptSubject, true);
  const sol = new CL.Paths();
  c.Execute(CL.ClipType.ctUnion, sol, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
  return fromClip(CL.Clipper.CleanPolygons(sol, 1.5));
}

/** Offset of a closed node (holes included). Empty array = the shape vanished. */
export function exactOffsetNode(
  n: GeomNode,
  fallback: PathPoint[],
  closed: boolean,
  distance: number,
  join: StrokeJoin,
): { path: PathPoint[]; network: VectorNetwork } | "open" | "empty" {
  const rings = closedRingsOf(n, fallback, closed);
  if (!rings) return "open";
  const out = ringsToNetwork(offsetRings(rings, distance, join));
  return out ?? "empty";
}

/**
 * Outline Stroke for a non-variable-width node: the stroke as filled geometry.
 * Closed shapes honour stroke alignment (inside / center / outside); open
 * paths are always centered with the requested caps.
 */
export function exactOutlineNode(
  n: GeomNode,
  fallback: PathPoint[],
  closed: boolean,
  width: number,
  align: StrokeAlign,
  cap: StrokeCap | string,
  join: StrokeJoin,
): { path: PathPoint[]; network: VectorNetwork } | null {
  const rings = closedRingsOf(n, fallback, closed);
  if (rings) return ringsToNetwork(outlineClosedRings(rings, width, align, join));
  const vn = n.vectorNetwork;
  if (vn && vn.segments.length > 0) return ringsToNetwork(outlineNetworkRings(vn, width, cap, join));
  const line = flattenPath(n.path.length ? n.path : fallback, false);
  return ringsToNetwork(outlineOpenPolyline(line, width, cap, join));
}
