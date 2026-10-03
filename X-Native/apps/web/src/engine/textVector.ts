import type { PathPoint, VectorNetwork, VectorSegment, VectorVertex } from "./types";
import { simplifyLineMetric } from "./geometry";

export interface TextVectorResult {
  path: PathPoint[];
  network: VectorNetwork;
  w: number;
  h: number;
  /** Bearing retained when raster contours are normalized to a local origin. */
  offsetX?: number;
  offsetY?: number;
}

/**
 * Standard geometric fallback glyphs for ASCII characters when running outside
 * browser DOM (e.g. headless unit tests or SSR). Coordinates normalized to 100x100.
 */
const FALLBACK_GLYPHS: Record<string, { loops: { x: number; y: number }[][]; advance: number }> = {
  " ": { loops: [], advance: 30 },
  "A": {
    loops: [
      [{ x: 0, y: 100 }, { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 100, y: 100 }, { x: 78, y: 100 }, { x: 64, y: 65 }, { x: 36, y: 65 }, { x: 22, y: 100 }],
      [{ x: 42, y: 48 }, { x: 50, y: 22 }, { x: 58, y: 48 }]
    ],
    advance: 80,
  },
  "B": {
    loops: [
      [{ x: 10, y: 0 }, { x: 65, y: 0 }, { x: 80, y: 15 }, { x: 80, y: 38 }, { x: 68, y: 48 }, { x: 82, y: 58 }, { x: 82, y: 85 }, { x: 68, y: 100 }, { x: 10, y: 100 }],
      [{ x: 28, y: 18 }, { x: 60, y: 18 }, { x: 64, y: 24 }, { x: 64, y: 34 }, { x: 60, y: 40 }, { x: 28, y: 40 }],
      [{ x: 28, y: 58 }, { x: 62, y: 58 }, { x: 66, y: 64 }, { x: 66, y: 76 }, { x: 62, y: 82 }, { x: 28, y: 82 }],
    ],
    advance: 80,
  },
  "C": {
    loops: [
      [{ x: 80, y: 20 }, { x: 65, y: 0 }, { x: 25, y: 0 }, { x: 5, y: 20 }, { x: 5, y: 80 }, { x: 25, y: 100 }, { x: 65, y: 100 }, { x: 80, y: 80 }, { x: 65, y: 80 }, { x: 55, y: 85 }, { x: 30, y: 85 }, { x: 20, y: 75 }, { x: 20, y: 25 }, { x: 30, y: 15 }, { x: 55, y: 15 }, { x: 65, y: 20 }]
    ],
    advance: 75,
  },
  "D": {
    loops: [
      [{ x: 10, y: 0 }, { x: 55, y: 0 }, { x: 85, y: 30 }, { x: 85, y: 70 }, { x: 55, y: 100 }, { x: 10, y: 100 }],
      [{ x: 28, y: 18 }, { x: 50, y: 18 }, { x: 68, y: 35 }, { x: 68, y: 65 }, { x: 50, y: 82 }, { x: 28, y: 82 }]
    ],
    advance: 80,
  },
  "E": {
    loops: [
      [{ x: 12, y: 0 }, { x: 75, y: 0 }, { x: 75, y: 18 }, { x: 32, y: 18 }, { x: 32, y: 40 }, { x: 70, y: 40 }, { x: 70, y: 58 }, { x: 32, y: 58 }, { x: 32, y: 82 }, { x: 78, y: 82 }, { x: 78, y: 100 }, { x: 12, y: 100 }]
    ],
    advance: 72,
  },
  "F": {
    loops: [
      [{ x: 12, y: 0 }, { x: 75, y: 0 }, { x: 75, y: 18 }, { x: 32, y: 18 }, { x: 32, y: 40 }, { x: 68, y: 40 }, { x: 68, y: 58 }, { x: 32, y: 58 }, { x: 32, y: 100 }, { x: 12, y: 100 }]
    ],
    advance: 70,
  },
  "G": {
    loops: [
      [{ x: 80, y: 20 }, { x: 65, y: 0 }, { x: 25, y: 0 }, { x: 5, y: 20 }, { x: 5, y: 80 }, { x: 25, y: 100 }, { x: 75, y: 100 }, { x: 75, y: 50 }, { x: 45, y: 50 }, { x: 45, y: 68 }, { x: 60, y: 68 }, { x: 60, y: 84 }, { x: 30, y: 84 }, { x: 20, y: 74 }, { x: 20, y: 26 }, { x: 30, y: 16 }, { x: 60, y: 16 }, { x: 68, y: 20 }]
    ],
    advance: 80,
  },
  "H": {
    loops: [
      [{ x: 12, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 40 }, { x: 68, y: 40 }, { x: 68, y: 0 }, { x: 88, y: 0 }, { x: 88, y: 100 }, { x: 68, y: 100 }, { x: 68, y: 60 }, { x: 32, y: 60 }, { x: 32, y: 100 }, { x: 12, y: 100 }]
    ],
    advance: 82,
  },
  "I": {
    loops: [
      [{ x: 10, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 100 }, { x: 10, y: 100 }]
    ],
    advance: 40,
  },
  "L": {
    loops: [
      [{ x: 12, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 82 }, { x: 75, y: 82 }, { x: 75, y: 100 }, { x: 12, y: 100 }]
    ],
    advance: 70,
  },
  "M": {
    loops: [
      [{ x: 10, y: 100 }, { x: 10, y: 0 }, { x: 30, y: 0 }, { x: 50, y: 55 }, { x: 70, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 100 }, { x: 72, y: 100 }, { x: 72, y: 35 }, { x: 56, y: 75 }, { x: 44, y: 75 }, { x: 28, y: 35 }, { x: 28, y: 100 }]
    ],
    advance: 95,
  },
  "N": {
    loops: [
      [{ x: 12, y: 100 }, { x: 12, y: 0 }, { x: 32, y: 0 }, { x: 68, y: 60 }, { x: 68, y: 0 }, { x: 88, y: 0 }, { x: 88, y: 100 }, { x: 68, y: 100 }, { x: 32, y: 40 }, { x: 32, y: 100 }]
    ],
    advance: 85,
  },
  "O": {
    loops: [
      [{ x: 20, y: 0 }, { x: 70, y: 0 }, { x: 90, y: 20 }, { x: 90, y: 80 }, { x: 70, y: 100 }, { x: 20, y: 100 }, { x: 0, y: 80 }, { x: 0, y: 20 }],
      [{ x: 24, y: 20 }, { x: 66, y: 20 }, { x: 72, y: 26 }, { x: 72, y: 74 }, { x: 66, y: 80 }, { x: 24, y: 80 }, { x: 18, y: 74 }, { x: 18, y: 26 }]
    ],
    advance: 85,
  },
  "P": {
    loops: [
      [{ x: 12, y: 0 }, { x: 62, y: 0 }, { x: 80, y: 18 }, { x: 80, y: 42 }, { x: 62, y: 60 }, { x: 32, y: 60 }, { x: 32, y: 100 }, { x: 12, y: 100 }],
      [{ x: 32, y: 18 }, { x: 58, y: 18 }, { x: 64, y: 24 }, { x: 64, y: 36 }, { x: 58, y: 42 }, { x: 32, y: 42 }]
    ],
    advance: 76,
  },
  "R": {
    loops: [
      [{ x: 12, y: 0 }, { x: 62, y: 0 }, { x: 80, y: 18 }, { x: 80, y: 42 }, { x: 62, y: 58 }, { x: 82, y: 100 }, { x: 62, y: 100 }, { x: 45, y: 60 }, { x: 32, y: 60 }, { x: 32, y: 100 }, { x: 12, y: 100 }],
      [{ x: 32, y: 18 }, { x: 58, y: 18 }, { x: 64, y: 24 }, { x: 64, y: 36 }, { x: 58, y: 42 }, { x: 32, y: 42 }]
    ],
    advance: 78,
  },
  "S": {
    loops: [
      [{ x: 75, y: 20 }, { x: 60, y: 0 }, { x: 25, y: 0 }, { x: 8, y: 18 }, { x: 8, y: 40 }, { x: 60, y: 55 }, { x: 75, y: 65 }, { x: 75, y: 82 }, { x: 55, y: 100 }, { x: 20, y: 100 }, { x: 5, y: 80 }, { x: 20, y: 80 }, { x: 30, y: 86 }, { x: 55, y: 86 }, { x: 62, y: 78 }, { x: 62, y: 65 }, { x: 20, y: 50 }, { x: 8, y: 38 }, { x: 8, y: 20 }, { x: 30, y: 14 }, { x: 55, y: 14 }, { x: 65, y: 20 }]
    ],
    advance: 75,
  },
  "T": {
    loops: [
      [{ x: 5, y: 0 }, { x: 85, y: 0 }, { x: 85, y: 18 }, { x: 55, y: 18 }, { x: 55, y: 100 }, { x: 35, y: 100 }, { x: 35, y: 18 }, { x: 5, y: 18 }]
    ],
    advance: 78,
  },
  "U": {
    loops: [
      [{ x: 10, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 70 }, { x: 40, y: 84 }, { x: 60, y: 84 }, { x: 70, y: 70 }, { x: 70, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 75 }, { x: 70, y: 100 }, { x: 30, y: 100 }, { x: 10, y: 75 }]
    ],
    advance: 85,
  },
  "V": {
    loops: [
      [{ x: 5, y: 0 }, { x: 28, y: 0 }, { x: 50, y: 75 }, { x: 72, y: 0 }, { x: 95, y: 0 }, { x: 60, y: 100 }, { x: 40, y: 100 }]
    ],
    advance: 85,
  },
  "X": {
    loops: [
      [{ x: 5, y: 0 }, { x: 30, y: 0 }, { x: 50, y: 35 }, { x: 70, y: 0 }, { x: 95, y: 0 }, { x: 65, y: 50 }, { x: 95, y: 100 }, { x: 70, y: 100 }, { x: 50, y: 65 }, { x: 30, y: 100 }, { x: 5, y: 100 }, { x: 35, y: 50 }]
    ],
    advance: 85,
  },
  "Y": {
    loops: [
      [{ x: 5, y: 0 }, { x: 28, y: 0 }, { x: 50, y: 45 }, { x: 72, y: 0 }, { x: 95, y: 0 }, { x: 60, y: 60 }, { x: 60, y: 100 }, { x: 40, y: 100 }, { x: 40, y: 60 }]
    ],
    advance: 85,
  },
  "!": {
    loops: [
      [{ x: 8, y: 0 }, { x: 22, y: 0 }, { x: 18, y: 65 }, { x: 12, y: 65 }],
      [{ x: 10, y: 80 }, { x: 20, y: 80 }, { x: 20, y: 100 }, { x: 10, y: 100 }]
    ],
    advance: 30,
  },
  "a": {
    loops: [
      [{ x: 10, y: 50 }, { x: 30, y: 35 }, { x: 60, y: 35 }, { x: 65, y: 50 }, { x: 65, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 88 }, { x: 35, y: 100 }, { x: 15, y: 100 }, { x: 5, y: 85 }, { x: 5, y: 65 }, { x: 25, y: 55 }, { x: 50, y: 55 }, { x: 50, y: 50 }, { x: 25, y: 50 }],
      [{ x: 20, y: 72 }, { x: 20, y: 85 }, { x: 35, y: 85 }, { x: 48, y: 75 }, { x: 48, y: 68 }, { x: 30, y: 68 }]
    ],
    advance: 65,
  },
  "e": {
    loops: [
      [{ x: 10, y: 65 }, { x: 60, y: 65 }, { x: 60, y: 55 }, { x: 50, y: 35 }, { x: 25, y: 35 }, { x: 5, y: 55 }, { x: 5, y: 80 }, { x: 25, y: 100 }, { x: 60, y: 100 }, { x: 60, y: 85 }, { x: 30, y: 85 }, { x: 20, y: 78 }],
      [{ x: 20, y: 52 }, { x: 48, y: 52 }, { x: 44, y: 44 }, { x: 30, y: 44 }]
    ],
    advance: 65,
  },
  "i": {
    loops: [
      [{ x: 8, y: 35 }, { x: 22, y: 35 }, { x: 22, y: 100 }, { x: 8, y: 100 }],
      [{ x: 8, y: 8 }, { x: 22, y: 8 }, { x: 22, y: 23 }, { x: 8, y: 23 }],
    ],
    advance: 30,
  },
  "l": {
    loops: [
      [{ x: 8, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 100 }, { x: 8, y: 100 }]
    ],
    advance: 30,
  },
  "m": {
    loops: [
      [
        { x: 8, y: 100 }, { x: 8, y: 35 }, { x: 22, y: 35 }, { x: 22, y: 48 },
        { x: 38, y: 35 }, { x: 50, y: 45 }, { x: 68, y: 35 }, { x: 84, y: 45 },
        { x: 84, y: 100 }, { x: 70, y: 100 }, { x: 70, y: 55 }, { x: 58, y: 55 },
        { x: 58, y: 100 }, { x: 44, y: 100 }, { x: 44, y: 55 }, { x: 34, y: 55 },
        { x: 34, y: 100 }, { x: 22, y: 100 }
      ]
    ],
    advance: 92,
  },
  "f": {
    loops: [
      [
        { x: 14, y: 100 }, { x: 14, y: 50 }, { x: 4, y: 50 }, { x: 4, y: 36 },
        { x: 14, y: 36 }, { x: 14, y: 20 }, { x: 22, y: 0 }, { x: 44, y: 0 },
        { x: 44, y: 15 }, { x: 30, y: 15 }, { x: 28, y: 24 }, { x: 28, y: 36 },
        { x: 42, y: 36 }, { x: 42, y: 50 }, { x: 28, y: 50 }, { x: 28, y: 100 }
      ]
    ],
    advance: 48,
  },
  "g": {
    loops: [
      [
        { x: 20, y: 35 }, { x: 50, y: 35 }, { x: 62, y: 30 }, { x: 65, y: 35 },
        { x: 65, y: 65 }, { x: 58, y: 70 }, { x: 62, y: 78 }, { x: 62, y: 92 },
        { x: 45, y: 100 }, { x: 15, y: 100 }, { x: 5, y: 90 }, { x: 15, y: 82 },
        { x: 40, y: 85 }, { x: 48, y: 80 }, { x: 42, y: 72 }, { x: 20, y: 72 },
        { x: 5, y: 55 }
      ],
      [
        { x: 22, y: 52 }, { x: 48, y: 52 }, { x: 48, y: 60 }, { x: 22, y: 60 }
      ],
      [
        { x: 20, y: 90 }, { x: 45, y: 90 }, { x: 45, y: 96 }, { x: 20, y: 96 }
      ]
    ],
    advance: 68,
  },
  "p": {
    loops: [
      [
        { x: 10, y: 100 }, { x: 10, y: 35 }, { x: 24, y: 35 }, { x: 24, y: 42 },
        { x: 45, y: 35 }, { x: 66, y: 48 }, { x: 66, y: 72 }, { x: 45, y: 85 },
        { x: 24, y: 85 }, { x: 24, y: 100 }
      ],
      [
        { x: 24, y: 52 }, { x: 48, y: 52 }, { x: 52, y: 60 }, { x: 52, y: 68 },
        { x: 48, y: 72 }, { x: 24, y: 72 }
      ]
    ],
    advance: 72,
  },
  "q": {
    loops: [
      [
        { x: 50, y: 100 }, { x: 50, y: 85 }, { x: 30, y: 85 }, { x: 8, y: 72 },
        { x: 8, y: 48 }, { x: 30, y: 35 }, { x: 64, y: 35 }, { x: 64, y: 100 }
      ],
      [
        { x: 24, y: 52 }, { x: 50, y: 52 }, { x: 50, y: 72 }, { x: 24, y: 72 },
        { x: 20, y: 68 }, { x: 20, y: 60 }
      ]
    ],
    advance: 72,
  },
  "b": {
    loops: [
      [
        { x: 10, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 42 }, { x: 45, y: 35 },
        { x: 66, y: 48 }, { x: 66, y: 85 }, { x: 45, y: 100 }, { x: 10, y: 100 }
      ],
      [
        { x: 24, y: 52 }, { x: 48, y: 52 }, { x: 52, y: 65 }, { x: 52, y: 78 },
        { x: 48, y: 85 }, { x: 24, y: 85 }
      ]
    ],
    advance: 72,
  },
  "d": {
    loops: [
      [
        { x: 50, y: 0 }, { x: 64, y: 0 }, { x: 64, y: 100 }, { x: 45, y: 100 },
        { x: 8, y: 85 }, { x: 8, y: 48 }, { x: 30, y: 35 }, { x: 50, y: 42 }
      ],
      [
        { x: 24, y: 52 }, { x: 50, y: 52 }, { x: 50, y: 85 }, { x: 24, y: 85 },
        { x: 20, y: 78 }, { x: 20, y: 65 }
      ]
    ],
    advance: 72,
  },
  "o": {
    loops: [
      [{ x: 20, y: 35 }, { x: 50, y: 35 }, { x: 65, y: 52 }, { x: 65, y: 82 }, { x: 50, y: 100 }, { x: 20, y: 100 }, { x: 5, y: 82 }, { x: 5, y: 52 }],
      [{ x: 22, y: 52 }, { x: 48, y: 52 }, { x: 52, y: 62 }, { x: 52, y: 75 }, { x: 48, y: 84 }, { x: 22, y: 84 }, { x: 18, y: 75 }, { x: 18, y: 62 }]
    ],
    advance: 68,
  },
};

/**
 * Computes the signed area of a 2D closed polygon using the Shoelace formula.
 * Screen coordinates (X right, Y down):
 * - Positive area (> 0) = Counter-Clockwise (CCW)
 * - Negative area (< 0) = Clockwise (CW)
 */
export function signedArea(poly: { x: number; y: number }[]): number {
  const n = poly.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % n];
    sum += p2.x * p1.y - p1.x * p2.y;
  }
  return sum / 2;
}

/**
 * Standard ray-casting point-in-polygon containment test.
 */
export function pointInPolygon(pt: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y))
        && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Computes the winding number of a point with respect to a polygon.
 * Screen coordinates (X right, Y down).
 */
export function polygonWindingNumber(pt: { x: number; y: number }, poly: { x: number; y: number }[]): number {
  let wn = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    if (p1.y <= pt.y) {
      if (p2.y > pt.y) {
        const cross = (p2.x - p1.x) * (pt.y - p1.y) - (pt.x - p1.x) * (p2.y - p1.y);
        if (cross > 0) wn++;
      }
    } else {
      if (p2.y <= pt.y) {
        const cross = (p2.x - p1.x) * (pt.y - p1.y) - (pt.x - p1.x) * (p2.y - p1.y);
        if (cross < 0) wn--;
      }
    }
  }
  return wn;
}

/**
 * Normalizes contour winding for NONZERO winding rule.
 * Outer contours wind CCW (positive signed area).
 * Interior counter loops (holes) wind CW (negative signed area).
 */
export function normalizeGlyphContours<T extends { x: number; y: number }>(loops: T[][]): T[][] {
  if (loops.length <= 1) {
    if (loops.length === 1) {
      const area = signedArea(loops[0]);
      return [area < 0 ? [...loops[0]].reverse() : [...loops[0]]];
    }
    return loops;
  }

  const loopData = loops.map((loop, idx) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let cx = 0, cy = 0;
    for (const p of loop) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      cx += p.x;
      cy += p.y;
    }
    const len = loop.length || 1;
    return {
      loop,
      idx,
      area: signedArea(loop),
      absArea: Math.abs(signedArea(loop)),
      minX, minY, maxX, maxY,
      centroid: { x: cx / len, y: cy / len },
    };
  });

  return loopData.map((d, i) => {
    let depth = 0;
    for (let j = 0; j < loopData.length; j++) {
      if (i === j) continue;
      const other = loopData[j];
      if (
        other.minX <= d.minX &&
        other.maxX >= d.maxX &&
        other.minY <= d.minY &&
        other.maxY >= d.maxY &&
        other.absArea > d.absArea
      ) {
        if (pointInPolygon(d.centroid, other.loop) || pointInPolygon(d.loop[0], other.loop)) {
          depth++;
        }
      }
    }

    const isHole = (depth % 2) === 1;
    const currentArea = signedArea(d.loop);

    if (!isHole) {
      // Outer contour: must wind CCW (positive area)
      return currentArea < 0 ? [...d.loop].reverse() : [...d.loop];
    } else {
      // Counter loop (hole): must wind CW (negative area)
      return currentArea > 0 ? [...d.loop].reverse() : [...d.loop];
    }
  });
}

/**
 * Traces 2D pixel contours from Canvas alpha data using boundary following.
 */
function traceAlphaContours(data: Uint8ClampedArray, w: number, h: number): PathPoint[][] {
  const visited = new Uint8Array(w * h);
  const contours: PathPoint[][] = [];
  const at = (x: number, y: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    return data[(y * w + x) * 4 + 3];
  };

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const val = at(x, y);
      if (val < 128 || visited[idx]) continue;

      // Check if this pixel is an edge pixel (adjacent to a transparent pixel)
      const isEdge =
        at(x - 1, y) < 128 ||
        at(x + 1, y) < 128 ||
        at(x, y - 1) < 128 ||
        at(x, y + 1) < 128;

      if (!isEdge) continue;

      // Follow contour
      const ring: PathPoint[] = [];
      let cx = x;
      let cy = y;
      let dir = 0; // 0=right, 1=down-right, 2=down, ...
      const startX = cx;
      const startY = cy;

      const dirs = [
        [1, 0], [1, 1], [0, 1], [-1, 1],
        [-1, 0], [-1, -1], [0, -1], [1, -1]
      ];

      for (let step = 0; step < 4000; step++) {
        visited[cy * w + cx] = 1;
        ring.push({ x: cx, y: cy });

        let foundNext = false;
        // Search around current pixel starting from previous direction
        for (let d = 0; d < 8; d++) {
          const nd = (dir + d + 6) % 8; // Turn back slightly and sweep clockwise
          const nx = cx + dirs[nd][0];
          const ny = cy + dirs[nd][1];
          if (at(nx, ny) >= 128) {
            cx = nx;
            cy = ny;
            dir = nd;
            foundNext = true;
            break;
          }
        }

        if (!foundNext || (cx === startX && cy === startY && ring.length >= 3)) {
          break;
        }
      }

      if (ring.length >= 6) {
        // Simplify contour to remove redundant collinear pixels
        const simplified = simplifyLineMetric(ring, 1.2);
        if (simplified.length >= 3) {
          contours.push(simplified);
        }
      }
    }
  }

  return contours;
}

/**
 * Converts a text string into an outlined vector network and path contours.
 */
export function convertTextToVectorPaths(
  text: string,
  fontSize: number,
  fontFamily = "Inter",
  fontWeight = "400",
  targetW?: number,
  targetH?: number,
): TextVectorResult {
  const content = text || "Text";

  // Check if browser DOM is available with 2D Canvas context
  if (typeof document !== "undefined") {
    try {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        const scale = 2.0; // Render at 2x resolution for clean anchor curves
        const fontPx = Math.max(24, Math.min(256, fontSize * scale));
        ctx.font = `${fontWeight} ${fontPx}px "${fontFamily}", Inter, system-ui, sans-serif`;
        const metrics = ctx.measureText(content);
        const textW = Math.ceil(metrics.width);
        const textH = Math.ceil(fontPx * 1.3);
        const pad = Math.ceil(fontPx * 0.2);

        canvas.width = textW + pad * 2;
        canvas.height = textH + pad * 2;

        ctx.font = `${fontWeight} ${fontPx}px "${fontFamily}", Inter, system-ui, sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "alphabetic";
        const baseline = pad + Math.ceil(fontPx * 0.95);
        ctx.fillText(content, pad, baseline);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const rawContours = traceAlphaContours(imgData.data, canvas.width, canvas.height);

        if (rawContours.length > 0) {
          const normContours = normalizeGlyphContours(rawContours);
          // Normalize contours back to target size or font size
          const normFactor = (fontSize || 16) / fontPx;
          const allVertices: VectorVertex[] = [];
          const allSegments: VectorSegment[] = [];
          const loops: number[][] = [];
          const combinedPath: PathPoint[] = [];

          let globalVertIdx = 0;
          for (const contour of normContours) {
            const loopIndices: number[] = [];
            const n = contour.length;
            for (let i = 0; i < n; i++) {
              const pt = contour[i];
              const vx = (pt.x - pad) * normFactor;
              const vy = (pt.y - (baseline - fontPx * 0.8)) * normFactor;

              allVertices.push({ x: vx, y: vy });
              combinedPath.push({ x: vx, y: vy });
              loopIndices.push(globalVertIdx + i);

              const nextIdx = globalVertIdx + ((i + 1) % n);
              allSegments.push({
                start: globalVertIdx + i,
                end: nextIdx,
              });
            }
            loops.push(loopIndices);
            globalVertIdx += n;
          }

          // Measure bbox
          const xs = allVertices.map((v) => v.x);
          const ys = allVertices.map((v) => v.y);
          const minX = Math.min(...xs, 0);
          const minY = Math.min(...ys, 0);
          const maxX = Math.max(...xs, 1);
          const maxY = Math.max(...ys, 1);

          // Shift vertices to (0, 0) origin
          for (const v of allVertices) {
            v.x -= minX;
            v.y -= minY;
          }
          for (const p of combinedPath) {
            p.x -= minX;
            p.y -= minY;
          }

          const w = targetW ?? Math.max(1, maxX - minX);
          const h = targetH ?? Math.max(1, maxY - minY);

          const network: VectorNetwork = {
            vertices: allVertices,
            segments: allSegments,
            regions: [{ windingRule: "NONZERO", loops }],
          };

          return { path: combinedPath, network, w, h, offsetX: minX, offsetY: minY };
        }
      }
    } catch {
      // Fall through to geometric fallback
    }
  }

  // Geometric fallback when running outside browser or canvas fails
  const allVertices: VectorVertex[] = [];
  const allSegments: VectorSegment[] = [];
  const loops: number[][] = [];
  const combinedPath: PathPoint[] = [];

  let curX = 0;
  const scale = (fontSize || 16) / 100;
  let globalVertIdx = 0;

  for (const ch of content) {
    const glyph = FALLBACK_GLYPHS[ch] || FALLBACK_GLYPHS[ch.toUpperCase()] || {
      loops: [[{ x: 5, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 100 }, { x: 5, y: 100 }]],
      advance: 75,
    };

    const normLoops = normalizeGlyphContours(glyph.loops);
    for (const loop of normLoops) {
      const loopIndices: number[] = [];
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const pt = loop[i];
        const vx = curX + pt.x * scale;
        const vy = pt.y * scale;

        allVertices.push({ x: vx, y: vy });
        combinedPath.push({ x: vx, y: vy });
        loopIndices.push(globalVertIdx + i);

        const nextIdx = globalVertIdx + ((i + 1) % n);
        allSegments.push({
          start: globalVertIdx + i,
          end: nextIdx,
        });
      }
      loops.push(loopIndices);
      globalVertIdx += n;
    }

    curX += glyph.advance * scale;
  }

  const finalW = targetW ?? Math.max(1, curX);
  const finalH = targetH ?? Math.max(1, fontSize || 16);

  const network: VectorNetwork = {
    vertices: allVertices,
    segments: allSegments,
    regions: [{ windingRule: "NONZERO", loops }],
  };

  return { path: combinedPath, network, w: finalW, h: finalH };
}


export interface TextGlyphResult extends TextVectorResult {
  char: string;
  /** Placement relative to the original text layer; path/network stay local. */
  x: number;
  y: number;
}

/** Outline, unlike Flatten, keeps all contours of each glyph in its own layer.
 * A dot or counter is not another glyph. Whitespace advances the pen but does
 * not produce an empty vector. The merged API above remains used by Flatten. */
export function convertTextToGlyphPaths(
  text: string,
  fontSize: number,
  fontFamily = "Inter",
  fontWeight = "400",
  letterSpacing = 0,
  lineHeight = (fontSize || 16) * 1.2,
): TextGlyphResult[] {
  const size = fontSize || 16;
  let ctx: CanvasRenderingContext2D | null = null;
  if (typeof document !== "undefined") {
    try {
      ctx = document.createElement("canvas").getContext("2d");
      if (ctx) ctx.font = `${fontWeight} ${size}px "${fontFamily}", Inter, system-ui, sans-serif`;
    } catch { /* deterministic geometric advances outside the browser */ }
  }
  const chars = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment)
    : Array.from(text);
  const results: TextGlyphResult[] = [];
  let prefix = "", cursor = 0, y = 0, column = 0;
  for (const char of chars) {
    if (char === "\n" || char === "\r\n" || char === "\r") {
      prefix = "";
      cursor = column = 0;
      y += lineHeight;
      continue;
    }
    const glyph = FALLBACK_GLYPHS[char] || FALLBACK_GLYPHS[char.toUpperCase()];
    const nextPrefix = prefix + char;
    // Prefix measurement retains kerning advances, unlike summing ink bounds.
    const x = (ctx ? ctx.measureText(nextPrefix).width - ctx.measureText(char).width : cursor) + column * letterSpacing;
    cursor = ctx ? ctx.measureText(nextPrefix).width : cursor + (glyph?.advance ?? (/^\s+$/u.test(char) ? 30 : 75)) * size / 100;
    prefix = nextPrefix;
    column++;
    if (/^\s+$/u.test(char)) continue;
    const res = convertTextToVectorPaths(char, size, fontFamily, fontWeight);
    if (!res.network.vertices.length) continue;
    const xs = res.network.vertices.map((v) => v.x), ys = res.network.vertices.map((v) => v.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - minX), h = Math.max(1, Math.max(...ys) - minY);
    results.push({
      ...res, char, x: x + minX + (res.offsetX ?? 0), y: y + minY + (res.offsetY ?? 0), w, h,
      path: res.path.map((p) => ({ ...p, x: p.x - minX, y: p.y - minY })),
      network: { ...res.network, vertices: res.network.vertices.map((v) => ({ ...v, x: v.x - minX, y: v.y - minY })) },
    });
  }
  return results;
}
