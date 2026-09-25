import type { PathPoint, VectorNetwork, VectorSegment, VectorVertex } from "./types";
import { simplifyPath } from "./geometry";

export interface TextVectorResult {
  path: PathPoint[];
  network: VectorNetwork;
  w: number;
  h: number;
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
  "l": {
    loops: [
      [{ x: 8, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 100 }, { x: 8, y: 100 }]
    ],
    advance: 30,
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
        const simplified = simplifyPath(ring, 1.2);
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
          // Normalize contours back to target size or font size
          const normFactor = 1 / scale;
          const allVertices: VectorVertex[] = [];
          const allSegments: VectorSegment[] = [];
          const loops: number[][] = [];
          const combinedPath: PathPoint[] = [];

          let globalVertIdx = 0;
          for (const contour of rawContours) {
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
            regions: [{ windingRule: "EVENODD", loops }],
          };

          return { path: combinedPath, network, w, h };
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

  for (let c = 0; c < content.length; c++) {
    const ch = content[c];
    const glyph = FALLBACK_GLYPHS[ch] || FALLBACK_GLYPHS[ch.toUpperCase()] || {
      loops: [[{ x: 5, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 100 }, { x: 5, y: 100 }]],
      advance: 75,
    };

    for (const loop of glyph.loops) {
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
    regions: [{ windingRule: "EVENODD", loops }],
  };

  return { path: combinedPath, network, w: finalW, h: finalH };
}
