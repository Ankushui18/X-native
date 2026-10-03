import assert from "node:assert/strict";
import { decodeRustImport } from "../wasmImportAdapter.ts";
import { importsEquivalent } from "../wasmBridge.ts";
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}`, e); }
}
function payload() {
  const fill = { t: "solid", c: "#ff0000" };
  const node = { id: "box", name: "Box", kind: { t: "rect", radius: 0 }, x: 10, y: 20, w: 100, h: 50, rotation: 0, opacity: 1, visible: true, locked: false, fill,
    stroke: { color: "#000000", width: 2 },
    fill_layers: [{ paint: fill, opacity: 1, visible: true, blend: "normal" }],
    stroke_layers: [{ color: "#000000", width: 2, opacity: 1, visible: true, blend: "normal", align: "inside", cap_start: "round", cap_end: "round", join: "bevel", dash: [8, 4], dash_offset: 0, miter: 4 }],
    effect_layers: [],
  };
  return { ok: true, doc: { format: "x-native", version: 1, pages: [{ id: "page", kind: { t: "frame" }, x: 0, y: 0, w: 400, h: 300, rotation: 0, opacity: 1, fill, children: [node] }] } };
}
const child = (p) => p.doc.pages[0].children[0];
const decode = (p) => decodeRustImport(JSON.stringify(p));
test("simple materialized solid stroke preserves all mapped geometry", () => {
  const n = decode(payload()).nodes[0];
  assert.equal(n.strokePaint, "#000000"); assert.equal(n.strokeWidth, 2); assert.equal(n.strokeVisible, true);
  assert.equal(n.fill, "#ff0000"); assert.equal(n.fillVisible, true);
  assert.equal(n.strokeAlign, "inside"); assert.equal(n.strokeCap, "round"); assert.equal(n.strokeJoin, "bevel");
  assert.equal(n.strokeDash, 8); assert.equal(n.strokeGap, 4);
});
test("all basic caps, joins and alignments map without guessing", () => {
  for (const align of ["inside", "center", "outside"]) for (const cap of ["none", "round", "square"]) for (const join of ["miter", "bevel", "round"]) {
    const p = payload(); Object.assign(child(p).stroke_layers[0], { align, cap_start: cap, cap_end: cap, join });
    const n = decode(p).nodes[0]; assert.equal(n.strokeAlign, align); assert.equal(n.strokeCap, cap); assert.equal(n.strokeJoin, join);
  }
});
test("single dash repeats; solid stroke emits no dash pair", () => {
  for (const dash of [[], [6]]) {
    const p = payload(); child(p).stroke_layers[0].dash = dash;
    const n = decode(p).nodes[0]; assert.equal(n.strokeDash, dash[0]); assert.equal(n.strokeGap, dash[0]);
  }
});
test("materialized fill-only identity is accepted without invented strokes", () => {
  const p = payload(); delete child(p).stroke; child(p).stroke_layers = [];
  const n = decode(p).nodes[0]; assert.equal(n.strokeVisible, false); assert.equal(n.strokeAlign, undefined);
});
for (const [name, mutate] of [
  ["multiple fills", (n) => n.fill_layers.push(n.fill_layers[0])],
  ["multiple strokes", (n) => n.stroke_layers.push(n.stroke_layers[0])],
  ["nonempty effects", (n) => n.effect_layers.push({})],
  ["partial stack envelope", (n) => delete n.effect_layers],
  ["empty fill stack overrides legacy", (n) => n.fill_layers = []],
  ["empty stroke stack overrides legacy", (n) => n.stroke_layers = []],
  ["stack fill differs from legacy", (n) => n.fill_layers[0].paint = { t: "solid", c: "#00ff00" }],
  ["stack stroke differs from legacy", (n) => n.stroke_layers[0].color = "#00ff00"],
  ["stack width differs from legacy", (n) => n.stroke_layers[0].width = 3],
  ["fill opacity", (n) => n.fill_layers[0].opacity = 0.5],
  ["hidden fill", (n) => n.fill_layers[0].visible = false],
  ["stroke opacity", (n) => n.stroke_layers[0].opacity = 0.5],
  ["hidden stroke", (n) => n.stroke_layers[0].visible = false],
  ["blend", (n) => n.stroke_layers[0].blend = "multiply"],
  ["asymmetric caps", (n) => n.stroke_layers[0].cap_end = "none"],
  ["arrow cap", (n) => n.stroke_layers[0].cap_start = n.stroke_layers[0].cap_end = "arrow"],
  ["dash phase", (n) => n.stroke_layers[0].dash_offset = 2],
  ["long dash pattern", (n) => n.stroke_layers[0].dash = [1, 2, 3, 4]],
  ["zero dash segment", (n) => n.stroke_layers[0].dash = [0, 4]],
  ["negative dash segment", (n) => n.stroke_layers[0].dash = [-1, 4]],
  ["nonnumeric dash segment", (n) => n.stroke_layers[0].dash = ["8", 4]],
  ["nonfinite dash segment", (n) => n.stroke_layers[0].dash = [Infinity, 4]],
  ["custom miter", (n) => n.stroke_layers[0].miter = 8],
  ["unknown alignment", (n) => n.stroke_layers[0].align = "mystery"],
  ["unknown join", (n) => n.stroke_layers[0].join = "mystery"],
  ["unknown stack data", (n) => n.stroke_layers[0].future = true],
]) test(`decline ${name} instead of silently dropping it`, () => { const p = payload(); mutate(child(p)); assert.throws(() => decode(p)); });
test("the complete-contract oracle still detects stroke differences", () => {
  const a = decode(payload()), b = structuredClone(a); b.nodes[0].strokeAlign = "outside";
  assert.equal(importsEquivalent(a, b), false);
});
console.log(`wasmStroke: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
