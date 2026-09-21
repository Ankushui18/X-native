import type { BooleanOp, PathPoint, XNode } from "./types";

/** Sample a node's outline in local coordinates (for booleans / vector edit). */
export function shapePoly(n: XNode, steps = 48): PathPoint[] {
  if (n.kind === "vector" && n.path.length) return n.path.map((p) => ({ ...p }));
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
    const count = Math.max(3, n.count || 5);
    const inner = n.starRatio || 0.4;
    const r = Math.min(w, h) / 2;
    for (let i = 0; i < count * 2; i++) {
      const a = (i * Math.PI) / count - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * inner;
      pts.push({ x: w / 2 + Math.cos(a) * rad, y: h / 2 + Math.sin(a) * rad });
    }
    return pts;
  }
  if (n.kind === "poly") {
    const pts: PathPoint[] = [];
    const count = Math.max(3, n.count || 3);
    const r = Math.min(w, h) / 2;
    for (let i = 0; i < count; i++) {
      const a = (i * 2 * Math.PI) / count - Math.PI / 2;
      pts.push({ x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r });
    }
    return pts;
  }
  if (n.kind === "line" || n.kind === "arrow") {
    return [
      { x: 0, y: h / 2 },
      { x: w, y: h / 2 },
    ];
  }
  const r = Math.min(n.cornerRadii[0] || 0, w / 2, h / 2);
  if (r <= 0) return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const k = 0.5522847498 * r;
  return [
    { x: r, y: 0, ix: -k, iy: 0, ox: k, oy: 0 },
    { x: w - r, y: 0, ix: -k, iy: 0, ox: k, oy: 0 },
    { x: w, y: r, ix: 0, iy: -k, ox: 0, oy: k },
    { x: w, y: h - r, ix: 0, iy: -k, ox: 0, oy: k },
    { x: w - r, y: h, ix: k, iy: 0, ox: -k, oy: 0 },
    { x: r, y: h, ix: k, iy: 0, ox: -k, oy: 0 },
    { x: 0, y: h - r, ix: 0, iy: k, ox: 0, oy: -k },
    { x: 0, y: r, ix: 0, iy: k, ox: 0, oy: -k },
  ];
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
  const res = 96;
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
      if (ring.length >= 3) path.push(...simplify(ring, Math.max(sx, sy) * 0.85));
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
