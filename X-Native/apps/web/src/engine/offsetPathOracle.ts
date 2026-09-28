/** Independent TypeScript *coverage reference* for the Rust filled-path offset.
 * This is NOT a second document engine or the old geometry.offsetPath helper:
 * that helper shifts averaged vertex normals, reverses the sign for clockwise
 * fills, and cannot represent holes/self-intersections. It is not a valid
 * filled-path oracle. This reference classifies sampled points under NONZERO
 * winding and signed Euclidean distance. Rect joins are checked analytically;
 * for other shapes, bevel/miter samples close to corners are inconclusive and
 * conservatively skipped. An unprovable/oversized case is BLOCKED, never
 * promoted based on a guess. `?offset=audit` remains available after parity.
 */
import { auditDecision } from "./bridgeRuntimeAudit";
import type { RustOffsetChange, RustPathCommand } from "./rustSession";

type Point = [number, number];
type Rings = Point[][];
type Join = "miter" | "bevel" | "round";
export class OffsetGuardRejected extends Error {
  readonly unchanged = true;
}

export function offsetRings(path: RustPathCommand[]): [number, number][][] | null {
  const rings: Rings = [];
  let ring: Point[] = [];
  for (const item of path) {
    if (item[0] === "C") return null; // the Web preview cannot checkpoint curves losslessly yet
    if (item[0] === "Z") { rings.push(ring); ring = []; }
    else ring.push([item[1], item[2]]);
  }
  return rings;
}
function inputRings(shape: RustOffsetChange): Rings | null {
  const { w, h } = shape;
  if (shape.kind === "vector") return offsetRings(shape.path);
  if (shape.kind === "rect") {
    if (shape.radius !== 0) return null;
    return [[[0, 0], [w, 0], [w, h], [0, h]]];
  }
  const count = shape.kind === "ellipse" ? 192 : shape.kind === "star" ? shape.count * 2 : shape.count;
  const vertices: Point[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - (shape.kind === "ellipse" ? -Math.PI / 2 : Math.PI / 2);
    const radius = shape.kind === "star" && i % 2 === 1 ? shape.ratio : 1;
    vertices.push([w / 2 + w / 2 * radius * Math.cos(angle), h / 2 + h / 2 * radius * Math.sin(angle)]);
  }
  return [vertices];
}

function insideAndDistance(rings: Rings, x: number, y: number): { inside: boolean; distance: number; vertex: number } {
  let winding = 0, distance = Infinity, vertex = Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dy = by - ay;
    vertex = Math.min(vertex, Math.hypot(x - ax, y - ay));
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    distance = Math.min(distance, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    if (ay <= y && by > y && dx * (y - ay) - dy * (x - ax) > 0) winding++;
    else if (ay > y && by <= y && dx * (y - ay) - dy * (x - ax) < 0) winding--;
  }
  return { inside: winding !== 0, distance, vertex };
}

function rectangleReference(x: number, y: number, w: number, h: number, d: number, join: Join):
    { inside: boolean; boundary: number } {
  if (d < 0) {
    const t = -d;
    const margin = Math.min(x - t, w - t - x, y - t, h - t - y);
    return { inside: 2 * t < Math.min(w, h) && margin > 0, boundary: Math.abs(margin) };
  }
  const vx = Math.max(-x, 0, x - w), vy = Math.max(-y, 0, y - h);
  const within = x >= -d && x <= w + d && y >= -d && y <= h + d;
  const diagonal = vx + vy;
  const inside = join === "miter" ? within : join === "bevel" ? within && diagonal <= d :
    (x >= 0 && x <= w && y >= 0 && y <= h) || Math.hypot(vx, vy) <= d;
  const boundary = Math.min(
    Math.abs(x + d), Math.abs(w + d - x), Math.abs(y + d), Math.abs(h + d - y),
    Math.abs(diagonal - d), Math.abs(Math.hypot(vx, vy) - d),
  );
  return { inside, boundary };
}

/** No canvas rasterization, native output or TS offset implementation is used
 * to produce the expected membership. Capped work happens once per proposed
 * edit (never in the paint loop). At least 96 decisive points must agree. */
export function offsetCoverageEquivalent(before: RustOffsetChange, after: RustOffsetChange,
    distance: number, join: Join): boolean {
  if (before.id !== after.id || before.name !== after.name || after.kind !== "vector" ||
      !Number.isFinite(distance) || Math.abs(distance) > 2048 || distance === 0) return false;
  const source = inputRings(before), output = offsetRings(after.path);
  if (!source || !output || !source.length || source.reduce((n, r) => n + r.length, 0) > 512 ||
      output.reduce((n, r) => n + r.length, 0) > 4096) return false;
  const xs = [...source.flat().map(p => p[0] + before.x), ...output.flat().map(p => p[0] + after.x)];
  const ys = [...source.flat().map(p => p[1] + before.y), ...output.flat().map(p => p[1] + after.y)];
  const margin = Math.min(4, Math.abs(distance) + 1);
  const x0 = Math.min(...xs) - margin, x1 = Math.max(...xs) + margin;
  const y0 = Math.min(...ys) - margin, y1 = Math.max(...ys) + margin;
  if (![x0, x1, y0, y1].every(Number.isFinite) || x1 - x0 > 1024 || y1 - y0 > 1024) return false;
  // Check the reported box too. If the contour is empty Rust keeps a stable
  // 1x1 layer solely for undo; non-empty bounds must describe every anchor.
  if (output.length) {
    const outX = output.flat().map(p => p[0]), outY = output.flat().map(p => p[1]);
    if (Math.abs(Math.min(...outX)) > 1e-7 || Math.abs(Math.min(...outY)) > 1e-7 ||
        Math.abs(Math.max(1, ...outX) - after.w) > 1e-7 ||
        Math.abs(Math.max(1, ...outY) - after.h) > 1e-7) return false;
  }
  const width = x1 - x0, height = y1 - y0, step = Math.max(width, height) / 40;
  const epsilon = Math.max(0.04, step * 0.35, Math.abs(distance) * 0.01);
  let compared = 0, expectedInk = 0, observedInk = 0;
  for (let iy = 0; iy < 41; iy++) for (let ix = 0; ix < 41; ix++) {
    const x = x0 + (ix + 0.5) * width / 41, y = y0 + (iy + 0.5) * height / 41;
    const start = insideAndDistance(source, x - before.x, y - before.y);
    let expected: boolean, boundary: number;
    if (before.kind === "rect" && before.radius === 0) {
      const ref = rectangleReference(x - before.x, y - before.y, before.w, before.h, distance, join);
      expected = ref.inside; boundary = ref.boundary;
    } else {
      const signed = start.inside ? -start.distance : start.distance;
      expected = signed < distance;
      boundary = Math.abs(signed - distance);
      // Signed Euclidean distance models ROUND corners exactly. For the
      // other joins, a point within the affected vertex wedge cannot prove
      // equivalence; compare only straight edge interiors and gross topology.
      if (before.kind !== "ellipse" && join !== "round" &&
          start.vertex <= Math.abs(distance) + epsilon) continue;
    }
    const end = insideAndDistance(output, x - after.x, y - after.y);
    if (boundary <= epsilon || end.distance <= epsilon) continue;
    compared++; expectedInk += Number(expected); observedInk += Number(end.inside);
    if (expected !== end.inside) return false;
  }
  // A coarse grid can miss the small triangular differences between miter,
  // bevel and round joins. Interior corner probes enforce the actual join,
  // not just the expanded bounding box.
  if (before.kind === "rect" && before.radius === 0 && distance > 0) {
    for (const [x, y] of [[-0.8, -0.8], [-0.6, -0.6], [before.w / distance + 0.8, -0.8],
      [before.w / distance + 0.6, -0.6], [-0.8, before.h / distance + 0.8],
      [before.w / distance + 0.8, before.h / distance + 0.8]]) {
      const px = x * distance, py = y * distance;
      const expected = rectangleReference(px, py, before.w, before.h, distance, join).inside;
      const actual = insideAndDistance(output, before.x + px - after.x, before.y + py - after.y).inside;
      if (expected !== actual) return false;
    }
  }
  return compared >= 96 && (expectedInk > 0 || !output.length) &&
    (observedInk > 0 || !output.length);
}

/** A failed preview never enters Rust history. The regular editor remains
 * TypeScript-owned; the opt-in Rust owner cannot spawn a shadow TS editor. */
export function guardOffsetPreview(before: RustOffsetChange, after: RustOffsetChange,
    distance: number, join: Join): RustOffsetChange {
  const passes = offsetCoverageEquivalent(before, after, distance, join);
  auditDecision({ bridge: "session", operation: "offset", result: passes ? "rust" : "none",
    guard: passes ? "passed" : "blocked", candidate: true,
    reason: passes ? "bounded Rust preview agrees with independent TS winding/offset coverage" :
      "native offset coverage unproven; Rust edit not applied" });
  if (!passes) throw new OffsetGuardRejected("Offset did not pass the geometry guard; no change was made. Use the standard editor for this shape.");
  return after;
}
