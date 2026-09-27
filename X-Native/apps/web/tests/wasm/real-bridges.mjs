/** REAL artifact gate: missing binaries and failed handshakes are failures.
 * Separate from npm test, which also has to pass in TS-only checkouts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import { importSvg as svgTs } from "../../src/engine/svgImport.ts";
import { importFig as figTs } from "../../src/engine/figImport.ts";
import { importSketch as sketchTs } from "../../src/engine/sketchImport.ts";
import { initWasmBridge, getEngineInfo, importSvg, importFig, importSketch, importsEquivalent, __resetWasmForTests } from "../../src/engine/wasmBridge.ts";
import { decodeRustImport } from "../../src/engine/wasmImportAdapter.ts";
import { ensureGeo, encodeGeoRequest, decodeGeoResponse, compareBooleanResults } from "../../src/engine/geoBridge.ts";
import { booleanPath, booleanPathTs } from "../../src/engine/geometry.ts";

const gluePath = path.resolve("public/wasm/x_wasm.js");
const importBytes = fs.readFileSync("public/wasm/x_wasm_bg.wasm");
const geoBytes = fs.readFileSync("public/x_geo.wasm");
// Use the runner-supported dynamic import. A Function("return import(...)")
// bypasses vite-node's transform and has no VM dynamic-import callback.
const glue = await import(/* @vite-ignore */ pathToFileURL(gluePath).href);
__resetWasmForTests();
const calls = { svg: 0, fig: 0, sketch: 0 };
assert.equal(await initWasmBridge(async () => ({ ...glue,
  importSvgToX: (text) => { calls.svg++; return glue.importSvgToX(text); },
  importFigToX: (bytes) => { calls.fig++; return glue.importFigToX(bytes); },
  importSketchToX: (bytes) => { calls.sketch++; return glue.importSketchToX(bytes); },
  default: () => glue.default({ module_or_path: importBytes }),
})), true, "generated glue must initialize the actual Rust artifact");
assert.equal(getEngineInfo().hasWasm, true);
assert.equal(glue.bridgeVersion(), 1);
assert.match(glue.engineVersion(), /^x-wasm /);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect id="λ-box" x="10" y="10" width="80" height="50" fill="#ff0000"/></svg>';
const imported = decodeRustImport(glue.importSvgToX(svg));
assert.ok(imported.nodes.length > 0, "native pages are direct nodes, not Page.root");
const rotated = decodeRustImport(glue.importSvgToX('<svg width="200" height="120"><rect id="box" x="0" y="0" width="80" height="50" transform="rotate(90)" fill="#ff0000"/></svg>'));
assert.ok(Math.abs(rotated.nodes[0].rotation - 90) < 1e-9, "native radians must become web degrees");
assert.equal(JSON.parse(glue.importFigToX(new Uint8Array([1, 2, 3]))).ok, false);
assert.equal(JSON.parse(glue.importSketchToX(new Uint8Array([1, 2, 3]))).ok, false);
console.log("PASS real wasm-bindgen: version, UTF-8 SVG/schema, binary error envelopes");

// Bounded diagnostics only. This does not participate in the production guard
// and never patches a native candidate with values from the TS oracle.
function differencePaths(a, b, path = "", out = []) {
  if (out.length >= 12 || Object.is(a, b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      // Match only the existing comparator's documented node defaults.
      const node = typeof a.kind === "string" && typeof b.kind === "string";
      const fallback = node && key === "children" ? [] : node && ["hidden", "locked"].includes(key) ? false : undefined;
      differencePaths(a[key] ?? fallback, b[key] ?? fallback, path ? `${path}.${key}` : key, out);
      if (out.length >= 12) break;
    }
  } else out.push(path);
  return out;
}

// Exercise the production choose/fallback boundary, not only direct exports.
const dom = new JSDOM("<!doctype html>");
globalThis.DOMParser = dom.window.DOMParser;
try {
  const plain = svg.replace("λ-box", "box");
  assert.ok(importsEquivalent(importSvg(plain), svgTs(plain)));
  assert.equal(getEngineInfo().importBackend, "wasm", getEngineInfo().lastImportFallback ?? "simple SVG must use native output");
  const text = '<svg width="200" height="120"><text x="10" y="30" font-size="20">Keep this text</text></svg>';
  assert.ok(importsEquivalent(importSvg(text), svgTs(text)));
  assert.equal(getEngineInfo().importBackend, "ts", "unmapped native typography must retain TS result");
  for (const [format, nativeImport, tsImport] of [["fig", importFig, figTs], ["sketch", importSketch, sketchTs]]) {
    const bytes = fs.readFileSync(`e2e/fixtures/sample.${format}`);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const raw = JSON.parse(format === "fig" ? glue.importFigToX(bytes) : glue.importSketchToX(bytes));
    assert.equal(raw.ok, true, `${format} native parser must import the real fixture: ${raw.error}`);
    const names = (n) => [n.name ?? n.id, ...(n.children ?? []).flatMap(names)];
    const nativeNames = raw.doc.pages.flatMap(names);
    for (const expectedName of format === "fig" ? ["Page 1", "Home", "FigCard", "FigDot", "FigLabel"] : ["Page 1", "Home", "Card", "Dot", "Label", "Grp", "Inner"]) {
      assert.ok(nativeNames.includes(expectedName), `${format} native import lost layer name ${expectedName}`);
    }
    const flatten = (n) => [n, ...(n.children ?? []).flatMap(flatten)];
    const rawTexts = raw.doc.pages.flatMap(flatten).filter((n) => n.kind.t === "text");
    assert.equal(rawTexts.length, 1);
    const rawText = rawTexts[0];
    const content = format === "fig" ? "Figma Hello" : "Sketch Hello";
    assert.equal(rawText.kind.text, content);
    assert.equal(raw.textMetrics.version, 1);
    assert.deepEqual(raw.textMetrics.nodes[rawText.id], { width: 200, height: 24, fontSize: 18 });
    assert.equal(rawText.h, 18, "native h remains font size, not source box height");
    // Decode the entire real document; don't carve out unsupported nodes to
    // manufacture a native success. Whole-result equivalence is checked below.
    const decoded = decodeRustImport(JSON.stringify(raw));
    const decodedText = decoded.nodes.flatMap(flatten).find((n) => n.kind === "text");
    assert.ok(decodedText, `${format} adapter must retain text`);
    assert.equal(decodedText.text, content);
    assert.equal(decodedText.w, 200); assert.equal(decodedText.h, 24); assert.equal(decodedText.fontSize, 18);
    for (const [key, value] of Object.entries(rawText.bindings ?? {})) {
      assert.ok(["font", "lh", "ls"].includes(key), `unknown fixture binding ${key}`);
      if (key === "font") assert.equal(decodedText.fontFamily, value);
      if (key === "lh") assert.equal(decodedText.lineHeight, Number(value) * 18);
      if (key === "ls") assert.equal(decodedText.letterSpacing, Number(value));
    }
    console.log(`PASS native ${format} text: content, source 200x24, font size 18, literal typography`);
    console.log(`PASS native ${format} parser: ${raw.doc.pages.length} page(s), source layer names retained`);
    const expected = await tsImport(data);
    console.log(`DIFF ${format} candidate paths (first 12): ${differencePaths(decoded, expected).join(", ") || "none"}`);
    const actual = await nativeImport(data);
    assert.ok(actual.nodes.length > 0, `${format} fixture must contain imported layers`);
    assert.ok(importsEquivalent(actual, expected), `${format} bridge must preserve the complete TS contract`);
    assert.equal(calls[format], 1, `${format} must invoke the real native export`);
    console.log(`PASS real ${format} wrapper: backend=${getEngineInfo().importBackend}; fallback=${getEngineInfo().lastImportFallback ?? "none"}`);
  }
  for (const [format, nativeImport, tsImport] of [["fig", importFig, figTs], ["sketch", importSketch, sketchTs]]) {
    const bytes = fs.readFileSync(`e2e/fixtures/state-text.${format}`);
    const raw = format === "fig" ? glue.importFigToX(bytes) : glue.importSketchToX(bytes);
    const decoded = decodeRustImport(raw);
    assert.equal(decoded.nodes.length, 4);
    for (const [i, align] of ["left", "center", "right", "justified"].entries()) {
      const n = decoded.nodes[i];
      assert.equal(n.textAlign, align); assert.equal(n.locked, i === 2);
      assert.equal(n.text, `State ${align.toUpperCase()}`);
      assert.equal(n.h, 24); assert.equal(n.fontSize, 18);
      if (format === "sketch") { assert.equal(n.lineHeight, 27); assert.equal(n.letterSpacing, 2.25); }
    }
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.ok(importsEquivalent(await nativeImport(data), await tsImport(data)), `${format} state fixture keeps the full TS contract`);
    assert.equal(calls[format], 2);
    console.log(`PASS native ${format} state: four alignments, locked/unlocked text${format === "sketch" ? ", Cocoa line-height/tracking" : ""}; wrapper=${getEngineInfo().importBackend}`);
  }
  const strokeBytes = fs.readFileSync("e2e/fixtures/stroke-options.fig");
  const strokeCandidate = decodeRustImport(glue.importFigToX(strokeBytes));
  assert.equal(strokeCandidate.nodes.length, 3);
  for (const [i, [align, cap, join, dash, gap]] of [
    ["inside", "round", "bevel", 8, 4], ["center", "square", "round", 6, 6], ["outside", "none", "miter", undefined, undefined],
  ].entries()) {
    const n = strokeCandidate.nodes[i];
    assert.equal(n.strokeAlign, align); assert.equal(n.strokeCap, cap); assert.equal(n.strokeJoin, join);
    assert.equal(n.strokeDash, dash); assert.equal(n.strokeGap, gap);
    assert.equal(n.strokeWidth, 2); assert.equal(n.strokePaint, "#000000");
  }
  const strokeData = strokeBytes.buffer.slice(strokeBytes.byteOffset, strokeBytes.byteOffset + strokeBytes.byteLength);
  assert.ok(importsEquivalent(await importFig(strokeData), await figTs(strokeData)));
  assert.equal(calls.fig, 3);
  console.log(`PASS native FIG stroke options: three alignments/caps/joins, solid/single/pair dashes; wrapper=${getEngineInfo().importBackend}`);
  const strokedSvg = decodeRustImport(glue.importSvgToX('<svg width="200" height="120"><rect width="80" height="50" fill="#ff0000" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="8 4"/></svg>'));
  assert.equal(strokedSvg.nodes[0].strokeCap, "round"); assert.equal(strokedSvg.nodes[0].strokeJoin, "bevel");
  assert.equal(strokedSvg.nodes[0].strokeDash, 8); assert.equal(strokedSvg.nodes[0].strokeGap, 4);
  console.log("PASS native SVG materialized solid stroke adapter");
  assert.equal(calls.svg, 2);
} finally { dom.window.close(); delete globalThis.DOMParser; }
console.log("PASS production import routing: native simple SVG, safe text fallback, real FIG/Sketch fixtures");


const geo = await ensureGeo(geoBytes);
assert.ok(geo, "native geometry module must load, not silently fall back");
const rect = (ox, oy) => ({ ox, oy, poly: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }] });
const shapes = [rect(-20, -10), rect(0, -10)];
for (const op of ["union", "subtract", "intersect", "exclude"]) {
  const out = decodeGeoResponse(geo.call(encodeGeoRequest(op, shapes)));
  assert.ok(out.contours.length > 0, `${op} must produce real native contours`);
  assert.ok(out.w > 0 && out.h > 0 && out.x < 10 && out.y < 0);
  // Auto's oracle must protect the shipped result even if native raster differs.
  assert.ok(compareBooleanResults(booleanPath(op, shapes), booleanPathTs(op, shapes)).ok);
}
assert.equal(decodeGeoResponse(geo.call(encodeGeoRequest("intersect", [rect(0, 0), rect(500, 0)]))).contours.length, 0);
const req = encodeGeoRequest("union", shapes);
const invalid = req.slice(); invalid[0] ^= 255;
assert.throws(() => decodeGeoResponse(geo.call(invalid)), /wasm error/);
for (const n of [0, 1, 15, 16, req.length - 1]) {
  // Zero-length allocations intentionally fail before entering the module.
  assert.throws(() => decodeGeoResponse(geo.call(req.slice(0, n))));
}
for (let i = 0; i < 50; i++) assert.ok(decodeGeoResponse(geo.call(req)).contours.length);
const { instance } = await WebAssembly.instantiate(geoBytes, {});
const e = instance.exports;
assert.ok(e.xgeo_boolean(0, 0, 0, 4) >= 3, "unowned pointers rejected without dereference");
e.xgeo_free(0, 100); e.xgeo_free(1234, 100);
const p = e.xgeo_alloc(8); assert.ok(p);
e.xgeo_free(p, 8); e.xgeo_free(p, 8); // double free is harmless
console.log("PASS real x-geo: four operations, empty, invalid input/pointers, repeated ownership cycles");
console.log("NOTE: smoke is NOT corpus equivalence or a performance/promotion signoff; run bench:wasm --module public/x_geo.wasm separately.");
