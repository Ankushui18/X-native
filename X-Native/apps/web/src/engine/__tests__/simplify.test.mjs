/**
 * Sprint 3 phase 1 — Simplify: iterative, segment-distance Ramer–Douglas–Peucker.
 *
 * Measured before the fix (probe, deleted): the recursive `simplify` threw
 * "Maximum call stack size exceeded" on an 8,000-point zig-zag, took 223 ms on
 * 5,000 (every split copied both halves), and at tolerance 1.5 left input
 * points 2.04 from the output because it measured against the infinite line.
 *
 * Also pinned: the *legacy* line-metric simplifier behind booleans, offsets
 * and glyph outlines keeps exactly the points the recursive version kept, so
 * the geometry equivalence guard against Rust's `simplify_web_ring` is intact.
 *
 * Run: vite-node src/engine/__tests__/simplify.test.mjs
 */
import { simplifyKeep, simplifyLineMetric, simplifyPath } from "../geometry.ts";

let pass = 0,
  fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? ` - ${extra}` : ""}`);
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});

const segDist = (p, a, b) => {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    L = dx * dx + dy * dy;
  if (!L) return Math.hypot(p.x - a.x, p.y - a.y);
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
};
/** Largest distance from any input point to the output segment replacing it. */
const maxDev = (pts, keep) => {
  let worst = 0,
    prev = 0;
  for (let i = 1; i < pts.length; i++) {
    if (!keep[i]) continue;
    for (let j = prev; j <= i; j++) worst = Math.max(worst, segDist(pts[j], pts[prev], pts[i]));
    prev = i;
  }
  return worst;
};
const count = (keep) => keep.reduce((s, k) => s + k, 0);
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const hand = (n) => Array.from({ length: n }, (_, i) => ({ x: (i / (n - 1)) * 800, y: 100 * Math.sin((i / (n - 1)) * 12) + (rnd() - 0.5) * 3 }));
const zigzag = (n) => Array.from({ length: n }, (_, i) => ({ x: i, y: (i % 2) * 3 }));
const spiral = (n) => Array.from({ length: n }, (_, i) => ({ x: (10 + i * 0.5) * Math.cos(i * 0.05), y: (10 + i * 0.5) * Math.sin(i * 0.05) }));
const time = (f) => {
  const s = performance.now();
  const r = f();
  return [r, performance.now() - s];
};

console.log("S-1 no stack overflow, tolerance guaranteed, bounded time:");
for (const n of [1000, 8000, 20000, 100000]) {
  const pts = hand(n);
  let keep, ms, threw = null;
  try {
    [keep, ms] = time(() => simplifyKeep(pts, 1.5));
  } catch (e) {
    threw = e.message;
  }
  t(`hand ${n}: no throw`, !threw, threw);
  if (threw) continue;
  const dev = maxDev(pts, keep);
  t(`hand ${n}: max deviation ${dev.toFixed(3)} ≤ 1.5`, dev <= 1.5 + 1e-9);
  t(`hand ${n}: reduces (${count(keep)} kept)`, count(keep) < n / 4);
  t(`hand ${n}: ${ms.toFixed(1)} ms < 250`, ms < 250);
}
for (const n of [8000, 20000, 100000]) {
  const pts = zigzag(n);
  let keep, ms, threw = null;
  try {
    [keep, ms] = time(() => simplifyKeep(pts, 1));
  } catch (e) {
    threw = e.message;
  }
  t(`zigzag ${n}: no throw (was a stack overflow from 8,000)`, !threw, threw);
  if (threw) continue;
  t(`zigzag ${n}: every tooth kept`, count(keep) === n);
  t(`zigzag ${n}: ${ms.toFixed(1)} ms < 250 (worst case of the old code)`, ms < 250);
}
{
  const pts = spiral(20000);
  const [keep, ms] = time(() => simplifyKeep(pts, 0.01));
  t(`spiral 20000 (adversarial, every point kept): ${ms.toFixed(0)} ms < 2000, O(n) memory`, count(keep) === 20000 && ms < 2000);
}

console.log("S-2 segment distance, not the infinite line:");
{
  // (14, 0.5) is 0.5 from the line y=0 but 4.03 from segment (0,0)–(10,0).
  const pts = [{ x: 0, y: 0 }, { x: 14, y: 0.5 }, { x: 10, y: 0 }];
  t("a point past the chord end survives", simplifyPath(pts, 1).length === 3);
  t("the legacy line metric still drops it (booleans unchanged)", simplifyLineMetric(pts, 1).length === 2);
  const old = hand(1000);
  t("hand 1000 at 1.5: deviation bound holds where the old metric reached 1.66", maxDev(old, simplifyKeep(old, 1.5)) <= 1.5 + 1e-9);
}

console.log("S-3 behaviour kept:");
{
  const line = [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1 }, { x: 4, y: 2 }];
  t("collinear collapses to its ends", simplifyPath(line, 0.1).length === 2);
  const spike = [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }];
  t("a spike survives", simplifyPath(spike, 0.1).length === 3);
  t("tolerance 0 returns the input", simplifyPath(hand(50), 0).length === 50);
  t("negative / NaN tolerance returns the input", simplifyPath(hand(50), -1).length === 50 && simplifyPath(hand(50), NaN).length === 50);
  t("2 points pass through", simplifyPath(line.slice(0, 2), 5).length === 2);
  const ring = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }];
  t("coincident ends use point distance", simplifyPath(ring, 1).length === 4);
  const src = { x: 3, y: 4, ix: 1, iy: 1, ox: -1, oy: -1 };
  const out = simplifyPath([{ x: 0, y: 0 }, src, { x: 10, y: 0 }], 0.5);
  t("survivors are the original objects (handles kept)", out[1] === src);
}

console.log("S-4 legacy line metric = the recursive reference (equivalence guard):");
{
  function ref(pts, eps) {
    if (pts.length <= 2) return pts;
    const [x0, y0] = [pts[0].x, pts[0].y];
    const last = pts[pts.length - 1];
    const dx = last.x - x0, dy = last.y - y0, len = Math.hypot(dx, dy) || 1;
    let max = 0, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs(dy * (pts[i].x - x0) - dx * (pts[i].y - y0)) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > eps) return ref(pts.slice(0, idx + 1), eps).slice(0, -1).concat(ref(pts.slice(idx), eps));
    return [pts[0], last];
  }
  let same = 0;
  const cases = 200;
  for (let c = 0; c < cases; c++) {
    const n = 3 + Math.floor(rnd() * 600);
    const pts = Array.from({ length: n }, () => ({ x: Math.round(rnd() * 400), y: Math.round(rnd() * 400) }));
    const eps = [0.4, 1.2, 1.5, 3][c % 4];
    const a = simplifyLineMetric(pts, eps), b = ref(pts, eps);
    if (a.length === b.length && a.every((p, i) => p === b[i])) same++;
  }
  t(`${same}/${cases} random rings keep identical points`, same === cases);
  const big = zigzag(50000);
  let threw = null;
  try {
    simplifyLineMetric(big, 1);
  } catch (e) {
    threw = e.message;
  }
  t("legacy metric no longer overflows at 50,000 points", !threw, threw);
}
