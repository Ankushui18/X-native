import assert from "node:assert/strict";
import { decodeRustImport } from "../wasmImportAdapter.ts";
import { initWasmBridge, __resetWasmForTests, importSvg, getEngineInfo, importsEquivalent } from "../wasmBridge.ts";
import { importSvg as svgTs } from "../svgImport.ts";
import { JSDOM } from "jsdom";
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}`, e); }
}
const layer = (extra = {}) => ({ id: "text-1", name: "Label", kind: { t: "text", text: "Hello λ 👋\nSecond line" }, x: 10, y: 20, w: 200, h: 18, rotation: 0, opacity: 1, visible: true, locked: false, fill: { t: "solid", c: "#000000" }, ...extra });
const metrics = (extra = {}) => ({ width: 200, height: 60, fontSize: 18, ...extra });
function payload(node = layer(), meta = metrics()) {
  return { ok: true, doc: { format: "x-native", version: 1, pages: [layer({ id: "page", name: "Page 1", kind: { t: "frame" }, w: 800, h: 600, children: [node] })] }, textMetrics: { version: 1, nodes: { [node.id]: meta } } };
}
const decode = (p) => decodeRustImport(JSON.stringify(p));
await test("text content, source bounds and font size stay independent", () => {
  const n = decode(payload()).nodes[0];
  assert.equal(n.kind, "text"); assert.equal(n.text, "Hello λ 👋\nSecond line");
  assert.equal(n.w, 200); assert.equal(n.h, 60); assert.equal(n.fontSize, 18);
  assert.equal(n.fontWeight, 400); assert.equal(n.textAlign, "left");
});
await test("known typography bindings map with correct line-height units", () => {
  const n = decode(payload(layer({ bindings: { font: "Inter", lh: "1.25", ls: "-0.5" }, text_align: "center" }))).nodes[0];
  assert.equal(n.fontFamily, "Inter"); assert.equal(n.lineHeight, 22.5); assert.equal(n.letterSpacing, -0.5); assert.equal(n.textAlign, "center");
});
await test("all native horizontal alignments and lock state survive", () => {
  for (const text_align of ["left", "center", "right", "justified"]) {
    for (const locked of [false, true]) {
      const n = decode(payload(layer({ text_align, locked }))).nodes[0];
      assert.equal(n.textAlign, text_align); assert.equal(n.locked, locked);
    }
  }
});
await test("explicit zero tracking survives", () => assert.equal(decode(payload(layer({ bindings: { ls: "0" } }))).nodes[0].letterSpacing, 0));
await test("same names do not collide: metadata is keyed by native ID", () => {
  const p = payload(); p.doc.pages[0].children.push(layer({ id: "text-2", h: 24 }));
  p.textMetrics.nodes["text-2"] = metrics({ height: 120, fontSize: 24 });
  assert.deepEqual(decode(p).nodes.map((n) => [n.h, n.fontSize]), [[60, 18], [120, 24]]);
});
await test("metadata supports Unicode IDs without prototype lookup", () => {
  for (const id of ["λ", "constructor", "__proto__"]) assert.equal(decode(payload(layer({ id }))).nodes[0].fontSize, 18);
});
for (const [label, mutate] of [
  ["legacy text without source metrics", (p) => { delete p.textMetrics; }],
  ["unknown metadata version", (p) => { p.textMetrics.version = 2; }],
  ["missing text ID", (p) => { p.textMetrics.nodes = {}; }],
  ["unknown explicit font size", (p) => { p.textMetrics.nodes["text-1"].fontSize = null; }],
  ["negative font size", (p) => { p.textMetrics.nodes["text-1"].fontSize = -1; }],
  ["font size inconsistent with native lowering", (p) => { p.textMetrics.nodes["text-1"].fontSize = 24; }],
  ["non-numeric source height", (p) => { p.textMetrics.nodes["text-1"].height = "60"; }],
  ["negative source height", (p) => { p.textMetrics.nodes["text-1"].height = -1; }],
  ["unknown metric field", (p) => { p.textMetrics.nodes["text-1"].mystery = 9; }],
  ["unused text metrics", (p) => { p.textMetrics.nodes.ghost = metrics(); }],
  ["variable binding", (p) => { p.doc.pages[0].children[0].bindings = { fill: "color-primary" }; }],
  ["rich text runs", (p) => { p.doc.pages[0].children[0].textRuns = [{ start: 0, len: 2, size: 30 }]; }],
  ["unmapped justify alignment", (p) => { p.doc.pages[0].children[0].text_align = "justify"; }],
  ["null font binding", (p) => { p.doc.pages[0].children[0].bindings = { font: null }; }],
  ["unknown text alignment", (p) => { p.doc.pages[0].children[0].text_align = "diagonal"; }],
]) await test(`decline ${label} rather than invent or discard typography`, () => { const p = payload(); mutate(p); assert.throws(() => decode(p)); });
for (const value of ["", " ", "NaN", "Infinity", "0x10", "18px", "1e999"]) {
  await test(`reject malformed numeric binding ${JSON.stringify(value)}`, () => assert.throws(() => decode(payload(layer({ bindings: { lh: value } })))));
}
await test("non-positive line-height ratio declines", () => {
  for (const lh of ["0", "-1"]) assert.throws(() => decode(payload(layer({ bindings: { lh } }))));
});
await test("line-height multiplication overflow declines", () => assert.throws(() => decode(payload(layer({ bindings: { lh: "1e308" } })))));
await test("bindings on non-text nodes do not become typography", () => assert.throws(() => decode(payload(layer({ kind: { t: "rect" }, bindings: { font: "Inter" } })))));
await test("empty native variable tables are allowed; actual variables are not dropped", () => {
  const p = payload(); p.doc.variables = { colors: {}, numbers: {}, strings: {}, bools: {}, collections: {}, modes: {}, num_modes: {}, str_modes: {}, bool_modes: {} };
  assert.equal(decode(p).nodes[0].fontSize, 18);
  p.doc.variables.colors.primary = "#ff0000"; assert.throws(() => decode(p), /variables/);
});
await test("unknown variable schema declines", () => {
  const p = payload(); p.doc.variables = { future: {} }; assert.throws(() => decode(p));
});
await test("orphan metadata cannot be accepted for a shape-only document", () => {
  const p = payload(layer({ kind: { t: "rect" } })); assert.throws(() => decode(p));
});
await test("SVG text id/name parity selects native only for the complete result", async () => {
  const dom = new JSDOM("<!doctype html>"); globalThis.DOMParser = dom.window.DOMParser;
  const svg = '<svg width="200" height="120"><text id="label" x="10" y="30" font-size="20" text-anchor="middle">Keep this text</text></svg>';
  const n = layer({ id: "label", kind: { t: "text", text: "Keep this text" }, x: 10, y: 10, w: 168, h: 20, text_align: "center" });
  // Native .x omits names identical to ids; the adapter must recover "label" from id.
  delete n.name;
  const page = layer({ id: "svg-root", name: "svg-root", kind: { t: "frame" }, x: 0, y: 0, w: 200, h: 120, children: [n], fill: { t: "solid", c: "#00000000" } });
  const candidate = { ok: true, doc: { format: "x-native", version: 1, pages: [page] }, textMetrics: { version: 1, nodes: { label: metrics({ width: 168, height: 28, fontSize: 20 }) } } };
  __resetWasmForTests();
  try {
    const expected = svgTs(svg);
    const raw = decode(candidate);
    assert.equal(raw.nodes[0].name, "label");
    delete raw.pages; // choose() removes the single SVG interchange page, never a named design page
    assert.ok(importsEquivalent(raw, expected), "candidate, not a TS-patched result, must match the whole SVG import");
    await initWasmBridge(async () => ({ default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm test (rust)",
      importFigToX: () => "", importSketchToX: () => "", importSvgToX: () => JSON.stringify(candidate) }));
    assert.ok(importsEquivalent(importSvg(svg), expected));
    assert.equal(getEngineInfo().importBackend, "wasm");
    n.name = "Keep this text"; // the last Rust importer revision used content instead of the explicit id
    assert.deepEqual(importSvg(svg), expected);
    assert.equal(getEngineInfo().importBackend, "ts");
    assert.match(getEngineInfo().lastImportFallback, /differs/);
  } finally { __resetWasmForTests(); delete globalThis.DOMParser; dom.window.close(); }
});
await test("text candidates still require the unchanged whole-result oracle", async () => {
  const dom = new JSDOM("<!doctype html>"); globalThis.DOMParser = dom.window.DOMParser;
  __resetWasmForTests();
  try {
    await initWasmBridge(async () => ({ default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm test (rust)", importFigToX: () => "", importSketchToX: () => "", importSvgToX: () => JSON.stringify(payload()) }));
    const svg = '<svg width="200" height="100"><text font-size="20" y="30">Different text</text></svg>';
    assert.deepEqual(importSvg(svg), svgTs(svg)); assert.equal(getEngineInfo().importBackend, "ts");
    assert.match(getEngineInfo().lastImportFallback, /differs/);
  } finally { __resetWasmForTests(); delete globalThis.DOMParser; dom.window.close(); }
});
console.log(`wasmText: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
