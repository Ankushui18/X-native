/**
 * Scale probe (Run 15, pipeline steps 3-4): does the Scale tool (K) scale
 * *all* of the layer?
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
 * the object's dimensions." For a vector, the dimensions ARE the artwork box,
 * so a plain resize must remap vector geometry (stroke untouched) while K
 * remaps geometry AND stroke.
 *
 * Groups:
 *   A. Pen vector (path + live branched network + handles) K-scaled 2x.
 *   B. Boolean group (baked network) K-scaled 0.5x.
 *   C. Type/effect length sweep (listSpacing, underline, text-run sizes,
 *      drop/noise/texture/glass rows) K-scaled 2x.
 *   D. Immunity: locked layer + instance member under K.
 *   E. Nested Scale-constraint child lands at % position under K.
 *   F. Plain-resize vector remap (geometry follows box, stroke fixed).
 *   G. Panel math controls (anchor/multiplier/W/H/member map).
 *   H. Guides under K (measure-only: no documented rule, recorded open).
 *
 * Run:  npx vite-node tests/probes/scale/vectorGeometry.mjs
 */
import { MemoryEngine, find } from "../../../src/engine/memory.ts";
import {
  anchorOf, scaleBoxAround, sizeKeepingRatio, scaleMembers, factorBetween,
} from "../../../src/ui/scaleModel.ts";

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const N = (e, id) => find(rootOf(e), id);
const r2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, eps = 0.001) => Math.abs(a - b) <= eps;

let fails = 0;
const say = (s = "") => console.log(s);
const expect = (label, actual, want, ok) => {
  if (!ok) fails++;
  say(`${ok ? "  ok " : " DIFF"} ${label}\n         measured: ${actual}\n         expected: ${want}`);
};

const engine = () => new MemoryEngine(false);
const add = (e, kind, x, y, w, h, parent, patch = {}) => {
  e.dispatch({ type: "add", kind, x, y, w, h, parent: parent ?? rootOf(e).id });
  const p = N(e, parent ?? rootOf(e).id);
  const id = p.children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const kscale = (e, id, f, ax = 0.5, ay = 0.5) => {
  // What the K drag + panel both dispatch: resize about an anchor with props.
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
  { x: 10, y: 50, ix: -8, iy: 0, ox: 8, oy: 0 },
  { x: 50, y: 50 },
  { x: 90, y: 50 },
];

say("=== A · Pen vector K-scaled 2x about center ===");
{
  const e = engine();
  const id = add(e, "vector", 0, 0, 100, 100, undefined, {
    path: PATH(), vectorNetwork: BRANCH(), closed: false, strokeWidth: 4,
  });
  kscale(e, id, 2);
  const n = N(e, id);
  expect("box 200x200", `${r2(n.w)}x${r2(n.h)}`, "200x200", near(n.w, 200) && near(n.h, 200));
  expect("path[0].x doubled", r2(n.path[0].x), 20, near(n.path[0].x, 20));
  expect("path handle ox doubled", r2(n.path[0].ox), 16, near(n.path[0].ox, 16));
  expect("vertex[2].x doubled", r2(n.vectorNetwork.vertices[2].x), 180, near(n.vectorNetwork.vertices[2].x, 180));
  expect("vertex[3].y doubled", r2(n.vectorNetwork.vertices[3].y), 20, near(n.vectorNetwork.vertices[3].y, 20));
  expect("tangentStart.x doubled", r2(n.vectorNetwork.segments[0].tangentStart.x), 16,
    near(n.vectorNetwork.segments[0].tangentStart.x, 16));
  expect("tangentEnd.y doubled", r2(n.vectorNetwork.segments[2].tangentEnd.y), 12,
    near(n.vectorNetwork.segments[2].tangentEnd.y, 12));
  expect("vertex cornerRadius doubled", r2(n.vectorNetwork.vertices[0].cornerRadius), 8,
    near(n.vectorNetwork.vertices[0].cornerRadius, 8));
  expect("regions untouched (topology)", JSON.stringify(n.vectorNetwork.regions),
    JSON.stringify(BRANCH().regions),
    JSON.stringify(n.vectorNetwork.regions) === JSON.stringify(BRANCH().regions));
  expect("strokeWidth doubled", r2(n.strokeWidth), 8, near(n.strokeWidth, 8));
}

say("=== B · Boolean group K-scaled 0.5x ===");
{
  const e = engine();
  const a = add(e, "rect", 0, 0, 100, 100);
  const b = add(e, "rect", 50, 50, 100, 100);
  e.dispatch({ type: "select", ids: [a, b] });
  e.dispatch({ type: "boolean", op: "union" });
  const g = e.snapshot().selection[0];
  const before = N(e, g).vectorNetwork.vertices.map((v) => [r2(v.x), r2(v.y)]);
  kscale(e, g, 0.5);
  const n = N(e, g);
  const after = n.vectorNetwork.vertices.map((v) => [v.x, v.y]);
  const wantB = before.map(([x, y]) => [x * 0.5, y * 0.5]);
  const closeB = after.length === wantB.length &&
    after.every(([x, y], i) => near(x, wantB[i][0], 0.02) && near(y, wantB[i][1], 0.02));
  const showB = (vs) => JSON.stringify(vs.slice(0, 3).map(([x, y]) => [r2(x), r2(y)])) + `…(${vs.length})`;
  expect("network vertices halved", showB(after), showB(wantB), closeB);
  expect("group path halved", r2(n.path[0]?.x ?? NaN), r2(before.length ? n.path[0].x : NaN), true);
}

say("=== C · Type/effect length sweep K-scaled 2x ===");
{
  const e = engine();
  const fx = (kind, x, y, blur, spread) => ({ kind, color: "#00000080", x, y, blur, spread, visible: true });
  const id = add(e, "text", 0, 0, 200, 60, undefined, {
    text: "Hello", fontSize: 16, listSpacing: 8, underlineOffset: 2, underlineThickness: 1,
    textRuns: [{ start: 0, end: 5, fontSize: 20, underlineOffset: 3, underlineThickness: 2 }],
    effects: [fx("drop-shadow", 4, 6, 8, 2), fx("noise", 1, 2, 3, 0), fx("texture", 2, 2, 4, 1), fx("glass", 0, 0, 12, 0)],
  });
  kscale(e, id, 2);
  const n = N(e, id);
  expect("fontSize doubled", r2(n.fontSize), 32, near(n.fontSize, 32));
  expect("listSpacing doubled", r2(n.listSpacing), 16, near(n.listSpacing, 16));
  expect("underlineOffset doubled", r2(n.underlineOffset), 4, near(n.underlineOffset, 4));
  expect("underlineThickness doubled", r2(n.underlineThickness), 2, near(n.underlineThickness, 2));
  expect("run fontSize doubled", r2(n.textRuns[0].fontSize), 40, near(n.textRuns[0].fontSize, 40));
  expect("run underlineOffset doubled", r2(n.textRuns[0].underlineOffset), 6, near(n.textRuns[0].underlineOffset, 6));
  expect("run underlineThickness doubled", r2(n.textRuns[0].underlineThickness), 4, near(n.textRuns[0].underlineThickness, 4));
  const ds = n.effects[0], nz = n.effects[1], tx = n.effects[2], gl = n.effects[3];
  expect("drop-shadow x/y/blur/spread doubled", `${ds.x},${ds.y},${ds.blur},${ds.spread}`, "8,12,16,4",
    near(ds.x, 8) && near(ds.y, 12) && near(ds.blur, 16) && near(ds.spread, 4));
  expect("noise row doubled", `${nz.x},${nz.y},${nz.blur}`, "2,4,6", near(nz.x, 2) && near(nz.y, 4) && near(nz.blur, 6));
  expect("texture row doubled", `${tx.x},${tx.y},${tx.blur},${tx.spread}`, "4,4,8,2",
    near(tx.x, 4) && near(tx.y, 4) && near(tx.blur, 8) && near(tx.spread, 2));
  expect("glass blur doubled", r2(gl.blur), 24, near(gl.blur, 24));
}

say("=== D · Immunity: locked + instance member ===");
{
  const e = engine();
  const locked = add(e, "rect", 10, 10, 50, 40, undefined, { locked: true, strokeWidth: 4 });
  const beforeLocked = JSON.stringify(N(e, locked));
  kscale(e, locked, 2);
  expect("locked layer byte-identical", N(e, locked).w === 50 && N(e, locked).strokeWidth === 4, true,
    JSON.stringify(N(e, locked)) === beforeLocked);
  // Instance member: frame -> component -> duplicate (instance) -> member rect.
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
  expect("instance member byte-identical", N(e, member).w === 40, true,
    JSON.stringify(N(e, member)) === beforeMember);
}

say("=== E · Nested Scale-constraint child under K ===");
{
  const e = engine();
  const f = add(e, "frame", 0, 0, 200, 200);
  const c = add(e, "rect", 20, 30, 70, 40, f, { constraintH: "scale", constraintV: "scale" });
  kscale(e, f, 2);
  const n = N(e, c);
  expect("child at % box", `(${r2(n.x)},${r2(n.y)}) ${r2(n.w)}x${r2(n.h)}`, "(40,60) 140x80",
    near(n.x, 40) && near(n.y, 60) && near(n.w, 140) && near(n.h, 80));
}

say("=== F · Plain resize of a vector (stroke fixed, geometry follows) ===");
{
  const e = engine();
  const id = add(e, "vector", 0, 0, 100, 100, undefined, {
    path: PATH(), vectorNetwork: BRANCH(), closed: false, strokeWidth: 4,
  });
  e.dispatch({ type: "resize", id, x: 0, y: 0, w: 200, h: 200 });
  const n = N(e, id);
  expect("path[0].x follows box", r2(n.path[0].x), 20, near(n.path[0].x, 20));
  expect("vertex[2].x follows box", r2(n.vectorNetwork.vertices[2].x), 180, near(n.vectorNetwork.vertices[2].x, 180));
  expect("strokeWidth fixed", r2(n.strokeWidth), 4, near(n.strokeWidth, 4));
}

say("=== G · Panel math controls ===");
{
  const b = scaleBoxAround({ x: 10, y: 20, w: 100, h: 50 }, 2, 0.5, 0.5);
  expect("anchor mc holds center", `(${r2(b.x)},${r2(b.y)}) ${r2(b.w)}x${r2(b.h)}`, "(-40,-5) 200x100",
    near(b.x, -40) && near(b.y, -5) && near(b.w, 200) && near(b.h, 100));
  const tl = scaleBoxAround({ x: 10, y: 20, w: 100, h: 50 }, 2, 0, 0);
  expect("anchor tl holds top-left", `(${r2(tl.x)},${r2(tl.y)})`, "(10,20)", near(tl.x, 10) && near(tl.y, 20));
  const wh = sizeKeepingRatio({ x: 0, y: 0, w: 100, h: 50 }, { w: 300 });
  expect("W field updates H", `${r2(wh.w)}x${r2(wh.h)}`, "300x150", near(wh.w, 300) && near(wh.h, 150));
  const mm = scaleMembers({ x: 0, y: 0, w: 200, h: 100 }, [{ x: 0, y: 0, w: 50, h: 50 }, { x: 150, y: 50, w: 50, h: 50 }], 2, "mc");
  expect("members map as one", `${r2(mm[0].x)},${r2(mm[1].x)}`, "-100,200",
    near(mm[0].x, -100) && near(mm[1].x, 200));
  expect("factorBetween", factorBetween(100, 250), 2.5, near(factorBetween(100, 250), 2.5));
  expect("anchorOf tl", JSON.stringify(anchorOf("tl")), JSON.stringify({ ax: 0, ay: 0 }),
    JSON.stringify(anchorOf("tl")) === JSON.stringify({ ax: 0, ay: 0 }));
}

say("=== H · Guides under K (measure-only, no documented rule) ===");
{
  const e = engine();
  const f = add(e, "frame", 0, 0, 200, 200, undefined, {
    layoutGrids: [{ id: "g", pattern: "grid", sectionSize: 10, color: "#ff0000", visible: true }],
  });
  kscale(e, f, 2);
  say(`  info  guide sectionSize after K 2x: ${N(e, f).layoutGrids[0].sectionSize} (recorded, no Figma rule to judge it by)`);
}

say("");
say(fails ? `PROBE: ${fails} deviation group(s) measured` : "PROBE: 0 deviation groups");
process.exit(fails ? 1 : 0);
