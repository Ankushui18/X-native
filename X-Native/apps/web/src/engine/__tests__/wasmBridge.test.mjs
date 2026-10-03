import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initWasmBridge, getEngineInfo, importSvg, importFig, importSketch, importsEquivalent, __resetWasmForTests } from "../wasmBridge.ts";
import { importSvg as svgTs } from "../svgImport.ts";
import { decodeRustImport } from "../wasmImportAdapter.ts";
import { wasmAssetUrl } from "../wasmAssets.ts";
import fs from "node:fs";

const dom = new JSDOM("<!doctype html>");
globalThis.DOMParser = dom.window.DOMParser;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}`, e); }
}
const rect = (extra = {}) => ({ id: "box", kind: { t: "rect", radius: 0 }, x: 10, y: 10, w: 80, h: 50, rotation: 0, opacity: 1, visible: true, locked: false, fill: { t: "solid", c: "#ff0000" }, ...extra });
const page = (children = [rect()], name = "Page 1") => rect({ id: name, name, kind: { t: "frame" }, x: 0, y: 0, w: 200, h: 120, children });
const envelope = (pages = [page()]) => JSON.stringify({ ok: true, doc: { format: "x-native", version: 1, pages } });
const svg = '<svg width="200" height="120"><rect id="box" x="10" y="10" width="80" height="50" fill="#ff0000"/></svg>';
const translatedGroupSvg = '<svg width="120" height="80"><g id="outer" transform="translate(10 20)" fill="#123456" opacity=".5"><g id="inner" transform="translate(-2 5)"><rect id="box" x="3" y="4" width="20" height="10"/></g><text id="label" x="10" y="30" font-size="10">Hi</text><rect id="after" x="0" y="1" width="4" height="4"/></g><rect id="outside" x="5" y="6" width="3" height="2" fill="red"/></svg>';
await test("TS SVG oracle flattens nested translations and retains siblings after text", () => {
  const { nodes, width, height, skipped } = svgTs(translatedGroupSvg);
  assert.deepEqual([width, height, skipped], [120, 80, 0]);
  assert.deepEqual(nodes.map(n => [n.name, n.x, n.y, n.opacity]), [
    ["box", 11, 29, 0.5], ["label", 20, 40, 0.5], ["after", 10, 21, 0.5], ["outside", 5, 6, 1],
  ]);
  assert.deepEqual([nodes[1].kind, nodes[1].text, nodes[1].w, nodes[1].h], ["text", "Hi", 12, 14]);
  assert.ok(nodes.slice(0, 3).every(n => n.fill === "#123456"));
});
let calls = 0;
const glue = (extra = {}) => ({ default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm 0.34.0 (rust)", importFigToX: () => envelope(), importSketchToX: () => envelope(), importSvgToX: () => { calls++; return envelope(); }, ...extra });
await test("direct native pages (not pages[0].root), dimensions and names", () => {
  const r = decodeRustImport(envelope()); assert.equal(r.nodes.length, 1); assert.equal(r.nodes[0].name, "box"); assert.equal(r.width, 200); assert.equal(r.height, 120);
});
await test("all pages and nested children retained", () => {
  const r = decodeRustImport(envelope([page([rect({ children: [rect()] })]), page([rect()], "Page 2")]));
  assert.equal(r.pages.length, 2); assert.equal(r.pages[1].name, "Page 2"); assert.equal(r.nodes[0].children.length, 1);
});
await test("visibility, locks, rotation, opacity and strokes map explicitly", () => {
  const n = decodeRustImport(envelope([page([rect({ visible: false, locked: true, rotation: Math.PI / 2, opacity: 0.4, stroke: { color: "#01020380", width: 2 } })])])).nodes[0];
  assert.equal(n.hidden, true); assert.equal(n.locked, true); assert.equal(n.rotation, 90); assert.equal(n.opacity, 0.4); assert.equal(n.strokePaint, "#01020380"); assert.equal(n.strokeWidth, 2);
});
await test("negative and half-turn radians map to web degrees", () => {
  for (const [rotation, expected] of [[-Math.PI / 2, -90], [Math.PI, 180]]) {
    assert.equal(decodeRustImport(envelope([page([rect({ rotation })])])).nodes[0].rotation, expected);
  }
});
await test("angle conversion overflow declines rather than producing Infinity", () => {
  assert.throws(() => decodeRustImport(envelope([page([rect({ rotation: 1e308 })])])), /Invalid Rust document number/);
});
await test("unsupported field diagnostics identify the unmapped schema keys", () => {
  assert.throws(() => decodeRustImport(envelope([page([rect({ bindings: { font: "Inter" } })])])), /properties: bindings/);
});
await test("native pivots rebase to the same web affine at all four corners", () => {
  for (const angle of [0, Math.PI / 2, -Math.PI / 2, Math.PI / 6]) {
    for (const origin of [[0, 0], [0.5, 0.5], [1, 1], [0.2, 0.8]]) {
      const raw = rect({ rotation: angle, origin });
      const n = decodeRustImport(envelope([page([raw])])).nodes[0];
      const place = (x, y, tx, ty, px, py, a) => [tx + px + (x - px) * Math.cos(a) - (y - py) * Math.sin(a), ty + py + (x - px) * Math.sin(a) + (y - py) * Math.cos(a)];
      for (const [x, y] of [[0, 0], [raw.w, 0], [raw.w, raw.h], [0, raw.h]]) {
        const expected = place(x, y, raw.x, raw.y, origin[0] * raw.w, origin[1] * raw.h, angle);
        const actual = place(x, y, n.x, n.y, n.w / 2, n.h / 2, n.rotation * Math.PI / 180);
        assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-9);
      }
    }
  }
});
await test("invalid pivots and pivot overflow decline safely", () => {
  for (const origin of [[0], [0, 0, 0], [null, 0], [1e308, 0]]) assert.throws(() => decodeRustImport(envelope([page([rect({ origin })])])));
});
await test("opaque black vs transparent black", () => {
  for (const [c, visible] of [["#000000", true], ["#00000000", false]]) assert.equal(decodeRustImport(envelope([page([rect({ fill: { t: "solid", c } })])])).nodes[0].fillVisible, visible);
});
await test("corner order is adapted to web tl,tr,bl,br", () => {
  assert.deepEqual(decodeRustImport(envelope([page([rect({ corners: [1, 2, 3, 4] })])])).nodes[0].cornerRadii, [1, 2, 4, 3]);
});
await test("disconnected vector contours and relative cubic handles retained", () => {
  const kind = { t: "vector", path: [["M", 0, 0], ["C", 2, 3, 8, 3, 10, 0], ["L", 5, 10], ["Z"], ["M", 20, 20], ["L", 30, 20], ["L", 30, 30], ["Z"]] };
  const n = decodeRustImport(envelope([page([rect({ kind })])])).nodes[0];
  assert.equal(n.vectorNetwork.regions[0].loops.length, 2); assert.equal(n.path.length, 3);
  assert.deepEqual(n.vectorNetwork.segments[0].tangentEnd, { x: -2, y: 3 }); assert.equal(n.path[0].ox, 2); assert.equal(n.path[1].ix, -2);
});
for (const [label, extra] of [
  ["text without lossless typography", { kind: { t: "text", text: "hello" } }],
  ["gradients", { fill: { t: "linear", stops: [] } }],
  ["unknown visual properties", { scale: [2, 1] }],
  ["native auto layout", { kind: { t: "frame", layout: { dir: "h" } } }],
  ["negative dimensions", { w: -1 }],
  ["invalid numeric data", { x: "4" }],
  ["unknown path verbs", { kind: { t: "vector", path: [["Q", 0, 1, 2, 3]] } }],
]) await test(`reject ${label} rather than partially import`, () => assert.throws(() => decodeRustImport(envelope([page([rect(extra)])]))));
for (const payload of ["bad", JSON.stringify({ ok: false, error: "nope" }), JSON.stringify({ ok: true, doc: { pages: [] } }), JSON.stringify({ ok: true, doc: { format: "x-native", version: 999, pages: [page()] } })]) {
  await test("malformed/error/version envelope rejected", () => assert.throws(() => decodeRustImport(payload)));
}
await test("asset-bearing document cannot silently lose assets", () => {
  const r = JSON.parse(envelope()); r.doc.assets = { image: "data:abc" }; assert.throws(() => decodeRustImport(JSON.stringify(r)));
});
await test("accept typed empty native document tables", () => {
  const r = JSON.parse(envelope());
  Object.assign(r.doc, { variables: { colors: {}, numbers: {}, strings: {}, bools: {}, collections: {}, modes: {}, num_modes: {}, str_modes: {}, bool_modes: {} },
    styles: {}, component_props: {}, comments: [], assets: [], libraries: [] });
  assert.equal(decodeRustImport(JSON.stringify(r)).nodes[0].name, "box");
});
await test("unknown envelope and document fields must decline rather than disappear", () => {
  for (const scope of ["envelope", "doc"]) {
    const r = JSON.parse(envelope());
    (scope === "doc" ? r.doc : r).futurePaints = ["lost"];
    assert.throws(() => decodeRustImport(JSON.stringify(r)), /properties: futurePaints/);
  }
});
for (const [field, value] of [
  ["default_font", "Other Face"], ["assets", "none"], ["styles", null],
  ["component_props", { Button: [] }], ["comments", [{ text: "keep me" }]],
  ["libraries", {}], ["variables", null],
]) await test(`decline unsupported/malformed document ${field}`, () => {
  const r = JSON.parse(envelope()); r.doc[field] = value;
  assert.throws(() => decodeRustImport(JSON.stringify(r)), /Unsupported Rust|Invalid Rust/);
});
await test("unsupported document fields fall back through the production SVG wrapper", async () => {
  const r = JSON.parse(envelope()); r.doc.comments = [{ text: "keep me" }];
  __resetWasmForTests();
  try {
    await initWasmBridge(async () => glue({ importSvgToX: () => JSON.stringify(r) }));
    assert.deepEqual(importSvg(svg), svgTs(svg));
    assert.equal(getEngineInfo().importBackend, "ts");
    assert.match(getEngineInfo().lastImportFallback, /comments/);
  } finally { __resetWasmForTests(); }
});
await test("single-page shape equivalence expands absent defaults", () => assert.equal(importsEquivalent(svgTs(svg), { ...decodeRustImport(envelope()), pages: undefined }), true));
await test("equivalence includes optional paints and additional pages", () => {
  const a = svgTs(svg), b = structuredClone(a); b.nodes[0].imageSrc = "data:x"; assert.equal(importsEquivalent(a, b), false);
  b.nodes = a.nodes; b.pages = [{ name: "one", nodes: a.nodes }, { name: "two", nodes: [] }]; assert.equal(importsEquivalent(a, b), false);
});
await test("named single-page imports cannot silently rename pages", () => {
  const a = decodeRustImport(envelope()), b = structuredClone(a); b.pages[0].name = "Renamed";
  assert.equal(importsEquivalent(a, b), false);
});
await test("concurrent loader calls share a pending promise and initialize once", async () => {
  __resetWasmForTests(); let release; let count = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const first = initWasmBridge(async () => { count++; await wait; return glue(); });
  const second = initWasmBridge(async () => { throw Error("must not start twice"); });
  assert.equal(first, second); assert.equal(getEngineInfo().importStatus, "loading"); release();
  assert.equal(await first, true); assert.equal(await second, true); assert.equal(count, 1);
});
await test("sync SVG uses registered bindgen functions, not raw wasm exports", () => {
  calls = 0; const r = importSvg(svg); assert.equal(calls, 1); assert.equal(r.nodes.length, 1); assert.equal(getEngineInfo().importBackend, "wasm");
});
await test("partial native conversion falls back to complete TS import", async () => {
  __resetWasmForTests(); await initWasmBridge(async () => glue({ importSvgToX: () => envelope([page([])]) }));
  assert.deepEqual(importSvg(svg), svgTs(svg)); assert.equal(getEngineInfo().importBackend, "ts"); assert.match(getEngineInfo().lastImportFallback, /differs/);
});
await test("native trap falls back without losing SVG", async () => {
  __resetWasmForTests(); await initWasmBridge(async () => glue({ importSvgToX: () => { throw Error("trap"); } }));
  assert.deepEqual(importSvg(svg), svgTs(svg)); assert.equal(getEngineInfo().lastImportFallback, "trap");
});
await test("missing artifact does not break TS import; failure is memoized", async () => {
  __resetWasmForTests(); let count = 0;
  assert.equal(await initWasmBridge(async () => { count++; throw Error("404"); }), false);
  assert.equal(await initWasmBridge(async () => { count++; return glue(); }), false); assert.equal(count, 1);
  assert.deepEqual(importSvg(svg), svgTs(svg)); assert.equal(getEngineInfo().hasWasm, false);
});
for (const mod of [glue({ bridgeVersion: () => 99 }), glue({ importFigToX: null }), glue({ default: async () => { throw Error("bad wasm"); } })]) {
  await test("bad ABI, missing export or failed initialization declines", async () => { __resetWasmForTests(); assert.equal(await initWasmBridge(async () => mod), false); });
}
await test("invalid FIG/Sketch still reports TS parser failure", async () => {
  __resetWasmForTests(); await initWasmBridge(async () => glue());
  await assert.rejects(importFig(new ArrayBuffer(3))); await assert.rejects(importSketch(new ArrayBuffer(3)));
});
await test("pending optional wasm never blocks FIG or Sketch fallback", async () => {
  __resetWasmForTests(); let release;
  const pending = initWasmBridge(async () => { await new Promise((r) => { release = r; }); return glue(); });
  let timer;
  try {
    await Promise.race([
      Promise.all([assert.rejects(importFig(new ArrayBuffer(3))), assert.rejects(importSketch(new ArrayBuffer(3)))]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("optional load blocked fallback")), 1000); }),
    ]);
  } finally { clearTimeout(timer); release(); await pending; }
});
await test("explicit TS mode skips load and can later be lifted", async () => {
  __resetWasmForTests(); globalThis.location = { search: "?imports=ts" };
  assert.equal(await initWasmBridge(async () => { throw Error("must not load"); }), false); assert.deepEqual(importSvg(svg), svgTs(svg));
  delete globalThis.location; assert.equal(await initWasmBridge(async () => glue()), true);
});
await test("all actual UI import entry points route through the bridge", () => {
  for (const name of ["Dashboard", "Canvas", "FigInspectorModal"]) {
    const s = fs.readFileSync(new URL(`../../ui/${name}.tsx`, import.meta.url), "utf8");
    assert.match(s, /from "\.\.\/engine\/wasmBridge"/);
    assert.doesNotMatch(s, /import \{[^}]*\bimport(?:Svg|Fig|Sketch)\b[^}]*\} from "\.\.\/engine\/(?:svgImport|figImport|sketchImport)"/);
  }
});
await test("assets resolve at root, subpath and CDN deployment bases", () => {
  assert.equal(wasmAssetUrl("x_geo.wasm", "/"), "/x_geo.wasm");
  assert.equal(wasmAssetUrl("wasm/x_wasm.js", "/design/"), "/design/wasm/x_wasm.js");
  assert.equal(wasmAssetUrl("/x_geo.wasm", "https://cdn.example/design"), "https://cdn.example/design/x_geo.wasm");
});
__resetWasmForTests(); dom.window.close(); delete globalThis.DOMParser;
console.log(`wasmBridge: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
