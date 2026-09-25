/**
 * Differential corpus for the geo bridge (design §8/P1). Pure data: each case
 * is an op over positioned polylines. The recorder snapshots `booleanPathTs`
 * outputs as fixtures; the future wasm backend must match within epsilon.
 *
 * Deliberately dependency-free (types only) so the recorder, the tests, and
 * any future runner can all import it without engine cycles.
 */
import type { BooleanOp, PathPoint } from "../types";

export interface CorpusShape {
  poly: PathPoint[];
  ox: number;
  oy: number;
}

export interface CorpusCase {
  name: string;
  op: BooleanOp;
  shapes: CorpusShape[];
}

const P = (x: number, y: number, h?: { ix?: number; iy?: number; ox?: number; oy?: number }): PathPoint => ({
  x,
  y,
  ...(h ?? {}),
});

export const rectPoly = (x: number, y: number, w: number, h: number): PathPoint[] => [
  P(x, y),
  P(x + w, y),
  P(x + w, y + h),
  P(x, y + h),
];

export const starPoly = (cx: number, cy: number, rO: number, rI: number, points = 5): PathPoint[] => {
  const out: PathPoint[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rO : rI;
    const a = (Math.PI * i) / points - Math.PI / 2;
    out.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return out;
};

export const ellipsePoly = (cx: number, cy: number, rx: number, ry: number, steps = 24): PathPoint[] => {
  const out: PathPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    out.push(P(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
  }
  return out;
};

const R = (x: number, y: number, w: number, h: number, ox = 0, oy = 0): CorpusShape => ({
  poly: rectPoly(x, y, w, h),
  ox,
  oy,
});

export const CORPUS: CorpusCase[] = [
  { name: "rect-overlap-union", op: "union", shapes: [R(0, 0, 10, 10), R(5, 5, 10, 10)] },
  { name: "rect-overlap-subtract", op: "subtract", shapes: [R(0, 0, 10, 10), R(5, 5, 10, 10)] },
  { name: "rect-overlap-intersect", op: "intersect", shapes: [R(0, 0, 10, 10), R(5, 5, 10, 10)] },
  { name: "rect-overlap-exclude", op: "exclude", shapes: [R(0, 0, 10, 10), R(5, 5, 10, 10)] },
  { name: "rect-offset-union", op: "union", shapes: [R(0, 0, 10, 10, 3, 4), R(0, 0, 10, 10, 8, 9)] },
  { name: "disjoint-union", op: "union", shapes: [R(0, 0, 10, 10), R(50, 50, 10, 10)] },
  { name: "contained-union", op: "union", shapes: [R(0, 0, 20, 20), R(5, 5, 5, 5)] },
  { name: "contained-subtract", op: "subtract", shapes: [R(0, 0, 20, 20), R(5, 5, 5, 5)] },
  { name: "contained-intersect", op: "intersect", shapes: [R(0, 0, 20, 20), R(5, 5, 5, 5)] },
  { name: "touching-edge-union", op: "union", shapes: [R(0, 0, 10, 10), R(10, 0, 10, 10)] },
  { name: "touching-corner-union", op: "union", shapes: [R(0, 0, 10, 10), R(10, 10, 10, 10)] },
  { name: "star-rect-union", op: "union", shapes: [{ poly: starPoly(10, 10, 12, 5), ox: 0, oy: 0 }, R(5, 5, 10, 10)] },
  {
    name: "star-rect-subtract",
    op: "subtract",
    shapes: [{ poly: starPoly(10, 10, 12, 5), ox: 0, oy: 0 }, R(5, 5, 10, 10)],
  },
  {
    name: "ellipse-ellipse-intersect",
    op: "intersect",
    shapes: [
      { poly: ellipsePoly(10, 10, 12, 8), ox: 0, oy: 0 },
      { poly: ellipsePoly(16, 12, 10, 9), ox: 0, oy: 0 },
    ],
  },
  {
    name: "curved-rect-union",
    op: "union",
    shapes: [
      { poly: [P(0, 0, { ox: 5, oy: 0 }), P(10, 0), P(10, 10, { ix: -5, iy: 0 }), P(0, 10)], ox: 0, oy: 0 },
      R(5, 5, 10, 10),
    ],
  },
  { name: "sliver-rect-union", op: "union", shapes: [R(0, 0, 0.3, 10), R(0, 5, 10, 10)] },
  { name: "sliver-sliver-intersect", op: "intersect", shapes: [R(0, 0, 0.3, 10), R(0, 4, 10, 0.3)] },
  {
    name: "l-rect-exclude",
    op: "exclude",
    shapes: [{ poly: [P(0, 0), P(10, 0), P(10, 4), P(4, 4), P(4, 10), P(0, 10)], ox: 0, oy: 0 }, R(2, 2, 8, 8)],
  },
  {
    name: "tri-tri-subtract",
    op: "subtract",
    shapes: [
      { poly: [P(0, 0), P(12, 0), P(0, 12)], ox: 0, oy: 0 },
      { poly: [P(4, 4), P(16, 4), P(4, 16)], ox: 0, oy: 0 },
    ],
  },
  { name: "fold3-union", op: "union", shapes: [R(0, 0, 10, 10), R(8, 0, 10, 10), R(16, 0, 10, 10)] },
  { name: "fold3-subtract", op: "subtract", shapes: [R(0, 0, 20, 10), R(4, 0, 4, 10), R(12, 0, 4, 10)] },
  { name: "fold3-intersect", op: "intersect", shapes: [R(0, 0, 20, 10), R(4, -5, 16, 20), R(8, 0, 20, 10)] },
  { name: "fold3-exclude", op: "exclude", shapes: [R(0, 0, 10, 10), R(8, 0, 10, 10), R(16, 0, 10, 10)] },
  {
    name: "fold4-union",
    op: "union",
    shapes: [R(0, 0, 10, 10), R(8, 2, 10, 10), R(16, 4, 10, 10), R(24, 6, 10, 10)],
  },
  { name: "identical-subtract-empty", op: "subtract", shapes: [R(0, 0, 10, 10), R(0, 0, 10, 10)] },
  { name: "identical-intersect", op: "intersect", shapes: [R(0, 0, 10, 10), R(0, 0, 10, 10)] },
  { name: "far-subtract", op: "subtract", shapes: [R(0, 0, 10, 10), R(500, 500, 10, 10)] },
  { name: "negative-coords-union", op: "union", shapes: [R(-15, -15, 10, 10), R(-10, -10, 10, 10)] },
  { name: "large-coords-union", op: "union", shapes: [R(10000, 10000, 50, 50), R(10020, 10020, 50, 50)] },
  {
    name: "ellipse-star-exclude",
    op: "exclude",
    shapes: [
      { poly: ellipsePoly(12, 12, 14, 10), ox: 0, oy: 0 },
      { poly: starPoly(12, 12, 11, 4.5, 6), ox: 0, oy: 0 },
    ],
  },
];
