/**
 * Exact geometry (Boolean / Offset / Outline Stroke) — Figma vector tools parity.
 * Expected numbers are what the operation means geometrically, not what an
 * earlier implementation happened to output.
 * Run: vite-node src/engine/__tests__/exactGeometry.test.mjs
 */
import {
  booleanRings, offsetRings, outlineClosedRings, outlineOpenPolyline, ringsToResult, flattenPath,
} from "../exactGeometry.ts";

let pass = 0, fail = 0;
const t = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${n}${!ok && extra ? " - " + extra : ""}`); };
process.on("exit", () => { console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`); if (fail) process.exitCode = 1; });

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const bb = (rings) => { const a = rings.flat(); return { minX: Math.min(...a.map(p => p.x)), minY: Math.min(...a.map(p => p.y)), maxX: Math.max(...a.map(p => p.x)), maxY: Math.max(...a.map(p => p.y)) }; };
const area = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a.x * b.y - b.x * a.y; } return s / 2; };
const net = (rings) => rings.reduce((s, r) => s + area(r), 0);   // signed: holes subtract
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const ellipse = (cx, cy, r, n = 128) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(i / n * 2 * Math.PI), y: cy + r * Math.sin(i / n * 2 * Math.PI) }));

console.log("Boolean");
{
  const u = booleanRings("union", [[rect(0, 0, 100, 100)], [rect(50, 50, 100, 100)]]);
  const b = bb(u);
  t("union of two overlapping squares is one contour", u.length === 1);
  t("union bbox is exactly 0,0..150,150", b.minX === 0 && b.minY === 0 && b.maxX === 150 && b.maxY === 150, JSON.stringify(b));
  t("union has the 8 corner vertices, no raster noise", u[0].length === 8, String(u[0].length));
  t("union area = 100*100*2 - 50*50", near(Math.abs(net(u)), 17500));
}
{
  const d = booleanRings("subtract", [[rect(0, 0, 200, 200)], [rect(50, 50, 100, 100)]]);
  const b = bb(d);
  t("subtract keeps outer bbox exactly 0..200", b.minX === 0 && b.maxX === 200 && b.maxY === 200);
  t("subtract makes outer + hole (2 contours)", d.length === 2);
  t("hole winds opposite to outer", area(d[0]) * area(d[1]) < 0);
  t("hole is exactly 50..150", (() => { const h = d.find(r => Math.abs(area(r)) < 20000); const hb = bb([h]); return hb.minX === 50 && hb.maxX === 150 && hb.minY === 50 && hb.maxY === 150; })());
  t("subtract area = 40000 - 10000", near(Math.abs(net(d)), 30000));
}
{
  const i = booleanRings("intersect", [[rect(0, 0, 100, 100)], [rect(50, 50, 100, 100)]]);
  t("intersect = the 50x50 overlap", i.length === 1 && near(Math.abs(area(i[0])), 2500));
  const x = booleanRings("exclude", [[rect(0, 0, 100, 100)], [rect(50, 50, 100, 100)]]);
  t("exclude area = union - 2*overlap", near(Math.abs(net(x)), 17500 - 2500));
  const none = booleanRings("intersect", [[rect(0, 0, 10, 10)], [rect(50, 50, 10, 10)]]);
  t("disjoint intersect is empty", none.length === 0);
}
{
  const s = booleanRings("subtract", [[rect(0, 0, 100, 100)], [rect(10, 10, 20, 20)], [rect(60, 60, 20, 20)]]);
  t("subtract folds across 3 operands", s.length === 3 && near(Math.abs(net(s)), 10000 - 400 - 400));
}

console.log("Offset");
for (const join of ["miter", "round", "bevel"]) {
  const o = offsetRings([rect(100, 100, 100, 100)], 10, join);
  const b = bb(o);
  t(`rect +10 ${join} grows to 90..210 (was shrinking)`, near(b.minX, 90) && near(b.maxX, 210) && near(b.minY, 90) && near(b.maxY, 210), JSON.stringify(b));
}
{
  const o = offsetRings([rect(100, 100, 100, 100)], 10, "miter");
  t("miter rect offset keeps 4 sharp corners", o[0].length === 4);
  const i = offsetRings([rect(100, 100, 100, 100)], -10, "miter");
  const b = bb(i);
  t("rect -10 shrinks to 110..190", near(b.minX, 110) && near(b.maxX, 190));
  const gone = offsetRings([rect(0, 0, 10, 10)], -10, "miter");
  t("inset larger than the shape removes it", gone.length === 0);
}
{
  const c = offsetRings([ellipse(50, 50, 50)], 10, "round");
  const b = bb(c);
  t("circle r50 +10 round reaches -10..110", near(b.minX, -10, 0.05) && near(b.maxX, 110, 0.05), JSON.stringify(b));
}
{
  const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 100 }, { x: 0, y: 100 }];
  t("L-shape (arms 20 wide) inset -15 collapses to nothing", offsetRings([L], -15, "miter").length === 0);
  const five = offsetRings([L], -5, "miter");
  t("L-shape inset -5 stays one contour inside the original", five.length === 1 && near(bb(five).minX, 5) && near(bb(five).maxX, 95));
}
{
  const donut = [rect(0, 0, 200, 200), rect(50, 50, 100, 100).reverse()];
  const grown = offsetRings(donut, 10, "miter");
  const holes = grown.filter(r => Math.abs(area(r)) < 20000);
  t("donut +10: outer grows, hole shrinks (2 contours)", grown.length === 2 && near(bb(grown).minX, -10));
  t("donut +10: hole becomes 60..140", holes.length === 1 && near(bb(holes).minX, 60) && near(bb(holes).maxX, 140));
  const shrunk = offsetRings(donut, -10, "miter");
  const outer = shrunk.find(r => Math.abs(area(r)) > 20000);
  t("donut -10: outer 10..190, hole grows to 40..160", near(bb([outer]).minX, 10) && near(bb(shrunk.filter(r => r !== outer)).minX, 40));
}

console.log("Outline stroke");
{
  const R = [rect(0, 0, 100, 100)];
  const inside = bb(outlineClosedRings(R, 10, "inside", "miter"));
  const center = bb(outlineClosedRings(R, 10, "center", "miter"));
  const outside = bb(outlineClosedRings(R, 10, "outside", "miter"));
  t("inside stroke stays within 0..100", inside.minX === 0 && inside.maxX === 100);
  t("center stroke spans -5..105", center.minX === -5 && center.maxX === 105);
  t("outside stroke spans -10..110", outside.minX === -10 && outside.maxX === 110);
  const ring = outlineClosedRings(R, 10, "center", "miter");
  t("closed stroke is a ring: outer + hole", ring.length === 2);
  t("center stroke area = 110^2 - 90^2", near(Math.abs(net(ring)), 12100 - 8100));
  t("inside stroke area = 100^2 - 80^2", near(Math.abs(net(outlineClosedRings(R, 10, "inside", "miter"))), 3600));
}
{
  const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const butt = bb(outlineOpenPolyline(line, 10, "none"));
  const sq = bb(outlineOpenPolyline(line, 10, "square"));
  const rd = bb(outlineOpenPolyline(line, 10, "round"));
  t("open stroke width 10 -> y -5..5", butt.minY === -5 && butt.maxY === 5);
  t("butt caps add no length", butt.minX === 0 && butt.maxX === 100);
  t("square caps add half the width", sq.minX === -5 && sq.maxX === 105);
  t("round caps add half the width", near(rd.minX, -5, 0.05) && near(rd.maxX, 105, 0.05));
}

console.log("Flattening and assembly");
{
  const circle = flattenPath([
    { x: 50, y: 0, ix: -27.614, iy: 0, ox: 27.614, oy: 0 },
    { x: 100, y: 50, ix: 0, iy: -27.614, ox: 0, oy: 27.614 },
    { x: 50, y: 100, ix: 27.614, iy: 0, ox: -27.614, oy: 0 },
    { x: 0, y: 50, ix: 0, iy: 27.614, ox: 0, oy: -27.614 },
  ], true);
  t("4-point bezier circle flattens within tolerance of area pi*r^2", Math.abs(Math.abs(area(circle)) - Math.PI * 2500) < 12, String(Math.abs(area(circle))));
  const res = ringsToResult(booleanRings("subtract", [[rect(0, 0, 200, 200)], [rect(50, 50, 100, 100)]]));
  t("result frame is the bbox, rings are frame-relative", res.x === 0 && res.w === 200 && res.network.regions[0].loops.length === 2);
  t("result network vertices start at 0,0", Math.min(...res.network.vertices.map(v => v.x)) === 0);
}

console.log("Branched networks");
{
  const { outlineNetworkRings, networkTrails } = await import("../exactGeometry.ts");
  // Y shape: stem + two arms meeting at (50,50)
  const vn = { vertices: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }, { x: 50, y: 100 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 1, end: 3 }] };
  const trails = networkTrails(vn);
  t("Y network splits into 3 trails from the junction", trails.length === 3 && trails.every(x => x.startJunction || x.endJunction));
  const rings = outlineNetworkRings(vn, 10, "none", "miter");
  const b = bb(rings);
  t("stroke covers every branch incl. the one off the path walk (reaches y=100)", b.maxY >= 100 - 1e-6, JSON.stringify(b));
  t("branches fuse into one shape", rings.length === 1, String(rings.length));
  const tri = { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }] };
  t("a closed cycle with no junction is one trail flagged closed", networkTrails(tri).length === 1 && networkTrails(tri)[0].closed);
  t("cycle stroke is a ring (outer + hole)", outlineNetworkRings(tri, 6, "none", "miter").length === 2);
}
