/**
 * Scale-tool geometry (pipeline Run 15): K scales *all* of the layer.
 *
 * Figma, Scale layers while maintaining proportions (360040451453): "Use the
 * scale tool to proportionally resize layers and objects. This tool preserves
 * aspect ratios and ignores constraints of any nested layers in order to
 * scale them proportionally. Any blurs or strokes will scale as well."
 * Locked layers and instance members are excluded; the panel carries a
 * multiplier, W/H fields that update each other, and the 9-anchor box.
 *
 * Figma, Stroke properties (360049283914) draws the resize half of the line:
 * "Resize the object if you want to retain a stroke's weight, while adjusting
 * the object's dimensions." A vector's dimensions ARE its artwork box, so a
 * plain resize remaps vector geometry with the stroke fixed, while K remaps
 * geometry AND stroke.
 *
 * What this pins (measured pre-fix by tests/probes/scale/vectorGeometry.mjs,
 * 14 DIFFs, 0 after):
 *
 *   A. Pen vector (path + live branched network + handles) K 2x about center:
 *      box, path points/handles, network vertices/tangents/point-radii and
 *      stroke all double; regions (index topology) are untouched.
 *   B. Boolean group (baked network) K 0.5x: network + path halve.
 *   C. Type-length sweep K 2x: listSpacing, underline offset/thickness, and
 *      per-range fontSize/underline double; every effect row scales (control).
 *   D. Immunity: locked layers and *nested* instance members are byte-identical;
 *      the instance root itself still scales (the article's exclusion is
 *      nested-only).
 *   E. Nested Scale-constraint child lands at its % box under K.
 *   F. Plain resize remaps vector geometry (uniform + stretched), stroke fixed.
 *   G. Panel math: anchor hold-points, W/H ratio, member map, multiplier.
 *
 * Sabotage (each restored byte-exact, md5-compared): remove the network
 * mapping -> A fails; restore the pre-fix scaleProps -> C fails (lengths);
 * lift the locked/instance gate -> D fails.
 *
 * Run with:  npx vite-node src/engine/__tests__/scaleGeometry.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import {
  anchorOf, scaleBoxAround, sizeKeepingRatio, scaleMembers, factorBetween,
} from "../../ui/scaleModel.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const near = (a, b, eps = 0.001) => Math.abs(a - b) <= eps;

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const N = (e, id) => find(rootOf(e), id);
const add = (e, kind, x, y, w, h, parent, patch = {}) => {
  e.dispatch({ type: "add", kind, x, y, w, h, parent: parent ?? rootOf(e).id });
  const id = N(e, parent ?? rootOf(e).id).children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const kscale = (e, id, f, ax = 0.5, ay = 0.5) => {
  const n = N(e, id);
  const box = scaleBoxAround({ x: n.x, y: n.y, w: n.w, h: n.h }, f, ax, ay);
  e.dispatch({ type: "resize", id, x: box.x, y: box.y, w: box.w, h: box.h, scaleProps: true });
};

const BRANCH = () => ({
  vertices: [
    { x: 10, y: 50, cornerRadius: 4 },
    { x: 50, y: 50 },
    { x: 90, y: 50 },
    { x: 50, y: 10 },
  ],
  segments: [
    { start: 0, end: 1, tangentStart: { x: 8, y: 0 }, tangentEnd: { x: -8, y: 0 } },
    { start: 1, end: 2 },
    { start: 1, end: 3, tangentStart: { x: 0, y: -6 }, tangentEnd: { x: 0, y: 6 } },
  ],
  regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }],
});
const PATH = () => [
  { x: 10, y: 50, ix: -8, iy: 0, ox: 8, oy: 0, cornerRadius: 3 },
  { x: 50, y: 50 },
  { x: 90, y: 50 },
];

// ── A · Pen vector K 2x about center ────────────────────────────────
{
  const e = new MemoryEngine(false);
  const id = add(e, "vector", 0, 0, 100, 100, undefined, {
    path: PATH(), vectorNetwork: BRANCH(), closed: false, strokeWidth: 4,
  });
  kscale(e, id, 2);
  const n = N(e, id);
  const v = n.vectorNetwork.vertices, sg = n.vectorNetwork.segments;
  t("A1 box doubles", near(n.w, 200) && near(n.h, 200));
  t("A2 path points double", near(n.path[0].x, 20) && near(n.path[2].x, 180));
  t("A3 path handles double", near(n.path[0].ox, 16) && near(n.path[0].ix, -16));
  t("A4 path point-radius doubles", near(n.path[0].cornerRadius, 6));
  t("A5 network vertices double", near(v[2].x, 180) && near(v[3].y, 20) && near(v[0].x, 20) && near(v[0].y, 100));
  t("A6 network tangents double", near(sg[0].tangentStart.x, 16) && near(sg[0].tangentEnd.x, -16) &&
    near(sg[2].tangentStart.y, -12) && near(sg[2].tangentEnd.y, 12));
  t("A7 vertex cornerRadius doubles", near(v[0].cornerRadius, 8));
  t("A8 regions untouched (topology)", JSON.stringify(n.vectorNetwork.regions) === JSON.stringify(BRANCH().regions));
  t("A9 strokeWidth doubles", near(n.strokeWidth, 8));
  t("A10 segment topology untouched", sg.length === 3 && sg[0].start === 0 && sg[0].end === 1 && sg[2].start === 1 && sg[2].end === 3);
}

// ── B · Boolean group K 0.5x ───────────────────────────────────────
{
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 100, 100);
  const b = add(e, "rect", 50, 50, 100, 100);
  e.dispatch({ type: "select", ids: [a, b] });
  e.dispatch({ type: "boolean", op: "union" });
  const g = e.snapshot().selection[0];
  const before = N(e, g).vectorNetwork.vertices.map((p) => [p.x, p.y]);
  const beforePath = N(e, g).path.map((p) => [p.x, p.y]);
  kscale(e, g, 0.5);
  const n = N(e, g);
  const after = n.vectorNetwork.vertices.map((p) => [p.x, p.y]);
  t("B1 every network vertex halves",
    after.length === before.length &&
    after.every(([x, y], i) => near(x, before[i][0] * 0.5, 0.02) && near(y, before[i][1] * 0.5, 0.02)));
  t("B2 baked path halves",
    n.path.length === beforePath.length &&
    n.path.every((p, i) => near(p.x, beforePath[i][0] * 0.5, 0.02) && near(p.y, beforePath[i][1] * 0.5, 0.02)));
  t("B3 group box halves", near(n.w, 75) && near(n.h, 75));
}

// ── C · Type/effect length sweep K 2x ──────────────────────────────
{
  const e = new MemoryEngine(false);
  const fx = (kind, x, y, blur, spread) => ({ kind, color: "#00000080", x, y, blur, spread, visible: true });
  const id = add(e, "text", 0, 0, 200, 60, undefined, {
    text: "Hello", fontSize: 16, listSpacing: 8, underlineOffset: 2, underlineThickness: 1,
    textRuns: [{ start: 0, end: 5, fontSize: 20, underlineOffset: 3, underlineThickness: 2 }],
    effects: [fx("drop-shadow", 4, 6, 8, 2), fx("noise", 1, 2, 3, 0), fx("texture", 2, 2, 4, 1), fx("glass", 0, 0, 12, 0)],
  });
  kscale(e, id, 2);
  const n = N(e, id);
  t("C1 fontSize doubles", near(n.fontSize, 32));
  t("C2 listSpacing doubles", near(n.listSpacing, 16));
  t("C3 underlineOffset doubles", near(n.underlineOffset, 4));
  t("C4 underlineThickness doubles", near(n.underlineThickness, 2));
  t("C5 run fontSize doubles", near(n.textRuns[0].fontSize, 40));
  t("C6 run underlineOffset doubles", near(n.textRuns[0].underlineOffset, 6));
  t("C7 run underlineThickness doubles", near(n.textRuns[0].underlineThickness, 4));
  t("C8 run text range untouched", n.textRuns[0].start === 0 && n.textRuns[0].end === 5);
  const [ds, nz, tx, gl] = n.effects;
  t("C9 drop-shadow row doubles", near(ds.x, 8) && near(ds.y, 12) && near(ds.blur, 16) && near(ds.spread, 4));
  t("C10 noise row doubles", near(nz.x, 2) && near(nz.y, 4) && near(nz.blur, 6));
  t("C11 texture row doubles", near(tx.x, 4) && near(tx.y, 4) && near(tx.blur, 8) && near(tx.spread, 2));
  t("C12 glass blur doubles", near(gl.blur, 24));
}

// ── D · Immunity ───────────────────────────────────────────────────
{
  const e = new MemoryEngine(false);
  const locked = add(e, "rect", 10, 10, 50, 40, undefined, { locked: true, strokeWidth: 4 });
  const beforeLocked = JSON.stringify(N(e, locked));
  kscale(e, locked, 2);
  t("D1 locked layer byte-identical", JSON.stringify(N(e, locked)) === beforeLocked);
  const f = add(e, "frame", 300, 0, 200, 200);
  add(e, "rect", 10, 10, 40, 40, f);
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "makeComponent" });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "duplicate" });
  const inst = e.snapshot().selection[0];
  const member = N(e, inst).children[0].id;
  const beforeMember = JSON.stringify(N(e, member));
  e.dispatch({ type: "resize", id: member, x: 10, y: 10, w: 80, h: 80, scaleProps: true });
  t("D2 instance member byte-identical", JSON.stringify(N(e, member)) === beforeMember);
  // The article excludes only layers *nested inside* an instance: the root
  // itself scales like any other frame.
  e.dispatch({ type: "resize", id: inst, x: 300, y: 0, w: 400, h: 400, scaleProps: true });
  t("D3 instance root still scales", near(N(e, inst).w, 400) && near(N(e, inst).h, 400));
}

// ── E · Nested Scale constraints under K ───────────────────────────
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 0, 0, 200, 200);
  const c = add(e, "rect", 20, 30, 70, 40, f, { constraintH: "scale", constraintV: "scale" });
  kscale(e, f, 2);
  const n = N(e, c);
  t("E1 scale-pinned child lands at % box",
    near(n.x, 40) && near(n.y, 60) && near(n.w, 140) && near(n.h, 80));
}

// ── F · Plain resize remaps vector geometry, stroke fixed ──────────
{
  const e = new MemoryEngine(false);
  const id = add(e, "vector", 0, 0, 100, 100, undefined, {
    path: PATH(), vectorNetwork: BRANCH(), closed: false, strokeWidth: 4,
  });
  e.dispatch({ type: "resize", id, x: 0, y: 0, w: 200, h: 200 });
  const n = N(e, id);
  t("F1 path follows the box", near(n.path[0].x, 20) && near(n.path[0].ox, 16));
  t("F2 network follows the box", near(n.vectorNetwork.vertices[2].x, 180) &&
    near(n.vectorNetwork.segments[2].tangentEnd.y, 12));
  t("F3 stroke stays fixed", near(n.strokeWidth, 4));
  t("F4 regions still untouched", JSON.stringify(n.vectorNetwork.regions) === JSON.stringify(BRANCH().regions));
  // Non-uniform stretch: x doubles, y holds, scalar radii take the average.
  const e2 = new MemoryEngine(false);
  const id2 = add(e2, "vector", 0, 0, 100, 100, undefined, {
    path: PATH(), vectorNetwork: BRANCH(), closed: false, strokeWidth: 4,
  });
  e2.dispatch({ type: "resize", id: id2, x: 0, y: 0, w: 200, h: 100 });
  const m = N(e2, id2);
  t("F5 stretched x doubles, y holds", near(m.path[2].x, 180) && near(m.path[2].y, 50) &&
    near(m.vectorNetwork.vertices[3].y, 10));
  t("F6 point-radii take the averaged factor", near(m.path[0].cornerRadius, 4.5) &&
    near(m.vectorNetwork.vertices[0].cornerRadius, 6));
}

// ── G · Panel math ─────────────────────────────────────────────────
{
  const b = scaleBoxAround({ x: 10, y: 20, w: 100, h: 50 }, 2, 0.5, 0.5);
  t("G1 anchor mc holds the center", near(b.x, -40) && near(b.y, -5) && near(b.w, 200) && near(b.h, 100));
  const tl = scaleBoxAround({ x: 10, y: 20, w: 100, h: 50 }, 2, 0, 0);
  t("G2 anchor tl holds top-left", near(tl.x, 10) && near(tl.y, 20));
  const wh = sizeKeepingRatio({ x: 0, y: 0, w: 100, h: 50 }, { w: 300 });
  t("G3 W field updates H", near(wh.w, 300) && near(wh.h, 150));
  const wh2 = sizeKeepingRatio({ x: 0, y: 0, w: 100, h: 50 }, { h: 25 });
  t("G4 H field updates W", near(wh2.w, 50) && near(wh2.h, 25));
  const mm = scaleMembers({ x: 0, y: 0, w: 200, h: 100 },
    [{ x: 0, y: 0, w: 50, h: 50 }, { x: 150, y: 50, w: 50, h: 50 }], 2, "mc");
  t("G5 members map as one", near(mm[0].x, -100) && near(mm[1].x, 200) && near(mm[0].w, 100));
  t("G6 factorBetween", near(factorBetween(100, 250), 2.5));
  t("G7 anchorOf", JSON.stringify(anchorOf("tl")) === JSON.stringify({ ax: 0, ay: 0 }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
