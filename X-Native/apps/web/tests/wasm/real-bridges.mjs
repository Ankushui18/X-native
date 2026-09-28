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
import { openRustSession } from "../../src/engine/rustSession.ts";
import { admitWebDocument, openWebDocumentSession } from "../../src/engine/webDocumentSession.ts";
import { rectangleStrokeOracle, strokeMatchesRectangle } from "../../src/engine/strokeBandOracle.ts";
import { docFromTemplate } from "../../src/engine/files.ts";
import { node } from "../../src/engine/memory.ts";
import { ensureGeo, encodeGeoRequest, decodeGeoResponse, compareBooleanResults } from "../../src/engine/geoBridge.ts";
import { booleanPath, booleanPathTs } from "../../src/engine/geometry.ts";
import { __enableBridgeAuditForTests, bridgeAuditSnapshot } from "../../src/engine/bridgeRuntimeAudit.ts";

// The audit's counters must observe the REAL generated modules in CI, not only
// the mock-based web unit suite. No console command is installed in this runner.
__enableBridgeAuditForTests(true);
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
  // Real stateful class, not a synthetic session/replayed patch. The Rust
  // document is opened once; each edit/undo returns one node, never .x JSON.
  assert.equal(glue.sessionBridgeVersion(), 4);
  const sessionX = JSON.stringify(JSON.parse(glue.importSvgToX(plain)).doc);
  const session = await openRustSession(sessionX);
  assert.ok(session, "generated bindgen must expose the shared Rust command session");
  assert.deepEqual(session.state(), { revision: 0, node: null, canUndo: false, canRedo: false });
  assert.deepEqual([session.getNode("box").x, session.getNode("box").y], [10, 10]);
  assert.equal(session.getNode("missing"), null);
  const renamed = session.renameNode("box", "Card");
  assert.deepEqual([renamed.revision, renamed.node.id, renamed.node.name], [1, "box", "Card"]);
  const moved = session.moveNode("box", 3, -4);
  assert.deepEqual([moved.revision, moved.node.x, moved.node.y], [2, 13, 6]);
  assert.equal(moved.canUndo, true);
  const resized = session.resizeNode("box", 95, 65);
  assert.deepEqual([resized.revision, resized.node.w, resized.node.h], [3, 95, 65]);
  assert.ok(JSON.stringify(resized).length < 256, "command delta must not contain the document");
  const undoneSize = session.undo();
  const undoneMove = session.undo();
  const undoneRename = session.undo();
  assert.deepEqual([undoneSize.node.w, undoneSize.node.h, undoneMove.node.x, undoneRename.node.name], [80, 50, 10, "box"]);
  const redoneRename = session.redo();
  const redoneMove = session.redo();
  const redoneSize = session.redo();
  assert.deepEqual([redoneRename.node.name, redoneMove.node.x, redoneSize.node.w], ["Card", 13, 95]);
  assert.equal(session.state().revision, 9);
  assert.throws(() => session.moveNode("box", Number.NaN, 1), "nonfinite move must be refused");
  assert.throws(() => session.resizeNode("box", 0, 65), "invalid dimensions must be refused");
  assert.equal(session.state().revision, 9);
  const savedSessionDoc = JSON.parse(session.exportX());
  assert.equal(savedSessionDoc.pages[0].children[0].name, "Card");
  assert.deepEqual([savedSessionDoc.pages[0].children[0].x, savedSessionDoc.pages[0].children[0].y,
    savedSessionDoc.pages[0].children[0].w, savedSessionDoc.pages[0].children[0].h], [13, 6, 95, 65]);
  const independentSession = await openRustSession(sessionX);
  assert.ok(independentSession);
  assert.equal(independentSession.getNode("box").name, "box", "sessions cannot share mutable state");
  independentSession.close();
  session.close();
  await assert.rejects(() => openRustSession("not a native document"));
  const multiPage = { ...savedSessionDoc, pages: [savedSessionDoc.pages[0], { ...savedSessionDoc.pages[0], id: "second" }] };
  await assert.rejects(() => openRustSession(JSON.stringify(multiPage)), "unsupported multi-page session must decline");
  console.log("PASS real Rust command session V3: move/rename/resize deltas, Rust undo/redo, explicit .x export, isolation and refusals");

  // The web-document gate is separate from import conversion. Check a real
  // persisted web shape through x-format -> x-editor -> x-format and back,
  // including the web-only file/page/viewport shell. Unsupported whole files
  // must stay on MemoryEngine without opening a second Rust history.
  const web = docFromTemplate("blank");
  web.fileName = 'Web ↔ Rust "working file"';
  web.pages[0].name = "Canvas label ≠ root label";
  web.pages[0].root.children.push(
    node("rect", "Card \"α\"", 10, 20, 30, 40, { fill: "#a1b2c3" }),
    node("rect", "Hidden", -25, 9, 80, 12, { fill: "#445566", visible: false, locked: true }),
  );
  web.showFlows = false; web.zoom = 1.25; web.panX = -80; web.panY = 53;
  assert.ok(admitWebDocument(web));
  const before = JSON.parse(JSON.stringify(web));
  const webSession = await openWebDocumentSession(web);
  assert.ok(webSession, "real Rust artifact must preserve the complete admitted web file");
  assert.deepEqual(webSession.exportDocument(), before, "full open -> Rust -> web checkpoint is lossless");
  const cardId = web.pages[0].root.children[0].id;
  assert.equal(webSession.getNode(cardId).name, 'Card "α"');
  const changeName = webSession.renameNode(cardId, "Renamed");
  assert.deepEqual([changeName.revision, changeName.node.name], [1, "Renamed"]);
  const changePosition = webSession.moveNode(cardId, -3, 4);
  assert.deepEqual([changePosition.revision, changePosition.node.x, changePosition.node.y], [2, 7, 24]);
  const changeSize = webSession.resizeNode(cardId, 41.25, 55.5);
  assert.deepEqual([changeSize.revision, changeSize.node.w, changeSize.node.h], [3, 41.25, 55.5]);
  assert.ok(JSON.stringify(changeSize).length < 256, "web command boundary must remain a small delta");
  assert.deepEqual([webSession.undo().node.w, webSession.undo().node.x, webSession.undo().node.name], [30, 10, 'Card "α"']);
  assert.deepEqual([webSession.redo().node.name, webSession.redo().node.x, webSession.redo().node.h], ["Renamed", 7, 55.5]);
  const expectedWeb = JSON.parse(JSON.stringify(before));
  expectedWeb.pages[0].root.children[0].name = "Renamed";
  expectedWeb.pages[0].root.children[0].x = 7;
  expectedWeb.pages[0].root.children[0].y = 24;
  expectedWeb.pages[0].root.children[0].w = 41.25;
  expectedWeb.pages[0].root.children[0].h = 55.5;
  assert.deepEqual(webSession.exportDocument(), expectedWeb, "Rust edits + history persist without web shadow edits");
  assert.deepEqual(web, before, "caller document was never mutated by Rust session");
  webSession.close();
  assert.equal(await openWebDocumentSession({ ...web, styles: [{ name: "unsupported" }] }), null);
  console.log("PASS real WASM web-document admission: lossless rectangle resize/history, metadata and strict fallback");

  // The command-session Boolean is NOT the imported x-geo function. This
  // exercises the generated bindgen class and Rust editor history with real
  // source rectangles, shaped path deltas and explicit native checkpoints.
  const booleanSeed = docFromTemplate("blank");
  booleanSeed.pages[0].root.children.push(
    node("rect", "A", 0, 0, 10, 10, { fill: "#123456" }),
    node("rect", "Untouched", 40, 40, 10, 10, { fill: "#abcdef" }),
    node("rect", "B", 5, 5, 10, 10, { fill: "#654321" }),
  );
  const [operandA, untouched, operandB] = booleanSeed.pages[0].root.children;
  const sourceShapes = [operandA, operandB].map(n => ({ ox: n.x, oy: n.y,
    poly: [{ x: 0, y: 0 }, { x: n.w, y: 0 }, { x: n.w, y: n.h }, { x: 0, y: n.h }] }));
  const originalBooleanDoc = JSON.parse(JSON.stringify(booleanSeed));
  for (const op of ["union", "subtract", "intersect", "exclude"]) {
    const owner = await openWebDocumentSession(booleanSeed);
    assert.ok(owner, `real WASM ${op} session must open`);
    assert.throws(() => owner.booleanNode(operandA.id, operandA.id, op), /distinct/);
    assert.equal(owner.state().revision, 0);
    const delta = owner.booleanNode(operandA.id, operandB.id, op);
    assert.equal(delta.revision, 1);
    assert.equal(delta.node, null);
    assert.deepEqual(delta.boolean.removed, [operandA.id, operandB.id]);
    assert.equal(delta.boolean.upsert.length, 1);
    const created = delta.boolean.upsert[0];
    assert.equal(created.kind, "vector");
    assert.equal(created.fill, "#123456");
    assert.equal(created.index, 0);
    assert.ok(JSON.stringify(delta).length < 2048, `${op} sent the whole document instead of a patch`);
    const firstSave = owner.exportDocument();
    assert.deepEqual(firstSave.pages[0].root.children.map(n => n.id), [created.id, untouched.id]);
    const vector = firstSave.pages[0].root.children[0];
    assert.equal(vector.kind, "vector");
    assert.equal(vector.fill, "#123456");
    const expected = booleanPathTs(op, sourceShapes);
    const actual = { x: vector.x, y: vector.y, w: vector.w, h: vector.h,
      path: vector.path, network: vector.vectorNetwork };
    const comparison = compareBooleanResults(actual, expected);
    assert.ok(comparison.ok, `${op} native session contours differ: ${comparison.reasons.join(", ")}`);
    assert.equal(vector.vectorNetwork.vertices.length, expected.network.vertices.length);
    for (const [i, p] of vector.vectorNetwork.vertices.entries()) {
      const q = expected.network.vertices[i];
      assert.ok(Math.abs(p.x - q.x) < 1e-8 && Math.abs(p.y - q.y) < 1e-8,
        `${op} native session contour anchor ${i} differs from oracle`);
    }
    const undo = owner.undo();
    assert.equal(undo.revision, 2);
    assert.deepEqual(undo.boolean.removed, [created.id]);
    assert.deepEqual(undo.boolean.upsert.map(n => n.index), [0, 2]);
    assert.deepEqual(owner.exportDocument(), originalBooleanDoc,
      `${op} undo must restore original sources, paint, flags and sibling order`);
    const redo = owner.redo();
    assert.equal(redo.revision, 3);
    assert.deepEqual(redo.boolean.removed, [operandA.id, operandB.id]);
    assert.deepEqual(owner.exportDocument(), firstSave, `${op} redo must restore exact vector`);
    assert.throws(() => owner.resizeNode(created.id, 20, 20), /vector/i);
    assert.equal(owner.state().revision, 3);
    owner.close();
  }
  const emptySeed = docFromTemplate("blank");
  emptySeed.pages[0].root.children.push(
    node("rect", "A", 0, 0, 10, 10), node("rect", "B", 500, 0, 10, 10));
  const emptyOwner = await openWebDocumentSession(emptySeed);
  assert.ok(emptyOwner);
  const emptyChange = emptyOwner.booleanNode(emptySeed.pages[0].root.children[0].id,
    emptySeed.pages[0].root.children[1].id, "intersect");
  assert.deepEqual(emptyChange.boolean.upsert[0].rings, []);
  assert.deepEqual(emptyOwner.exportDocument().pages[0].root.children[0].vectorNetwork.vertices, []);
  assert.equal(emptyOwner.undo().boolean.upsert.length, 2);
  emptyOwner.close();
  assert.deepEqual(booleanSeed, originalBooleanDoc, "Rust command must never mutate the web caller");
  console.log("PASS real WASM Rust Boolean V3: four shaped operations, TS anchor parity, atomic history, empty result, small deltas and explicit vector checkpoint");

  // The stroke corpus uses the ACTUAL bindgen class and the opt-in web owner,
  // not a mock/replay. Each result is checked against independently computed
  // rectangle edge offsets. Five distinct rectangles × 3 alignments × 2 joins
  // include fractional/negative origins, narrow holes and a thick collapse.
  const strokeRects = [
    { x: 10, y: 15, w: 100, h: 70, width: 8 },
    { x: -32.5, y: 4.75, w: 20.5, h: 12.75, width: 2.5 },
    { x: 100, y: 120, w: 6, h: 4, width: 5 },
    { x: 0, y: 0, w: 1, h: 1, width: 0.25 },
    { x: 145.25, y: -23.5, w: 300.25, h: 149.75, width: 27.5 },
  ];
  const strokeAuditsBefore = bridgeAuditSnapshot().decisions["session.stroke"]?.attempts ?? 0;
  let parity = 0;
  for (const r of strokeRects) for (const align of ["inside", "center", "outside"])
    for (const join of ["miter", "bevel"]) {
      const seed = docFromTemplate("blank");
      seed.pages[0].root.children.push(node("rect", "Border", r.x, r.y, r.w, r.h, { fill: "#b7a9c2" }));
      const id = seed.pages[0].root.children[0].id;
      const owner = await openWebDocumentSession(seed);
      assert.ok(owner, "native owner must admit an unstroked rectangle");
      assert.throws(() => owner.strokeNode(id, -1, "#236b9e", align, join), /width/);
      assert.throws(() => owner.strokeNode(id, r.width, "#236b9e", align, "round"), /join/);
      assert.equal(owner.state().revision, 0, "a rejected command cannot change native history");
      // The first real bindgen edit opts into the analytical audit; the other
      // 29 cases must use Rust without a default per-edit oracle comparison.
      const previousLocation = globalThis.location;
      let changed;
      try {
        if (parity === 0) globalThis.location = { search: "?stroke=audit" };
        changed = owner.strokeNode(id, r.width, "#236b9e", align, join);
      } finally {
        if (parity === 0) {
          if (previousLocation === undefined) delete globalThis.location;
          else globalThis.location = previousLocation;
        }
      }
      if (parity === 0) {
        assert.equal(bridgeAuditSnapshot().decisions["session.stroke"]?.last.guard, "passed",
          "opt-in stroke audit must compare the actual Rust contour");
      }
      assert.equal(changed.revision, 1);
      assert.equal(changed.node, null, "style change must not copy the bounding box");
      assert.equal(changed.boolean, undefined);
      assert.deepEqual(changed.stroke?.id, id);
      assert.deepEqual([changed.stroke.width, changed.stroke.color, changed.stroke.align, changed.stroke.join],
        [r.width, "#236b9e", align, join]);
      const expected = rectangleStrokeOracle(r.w, r.h, changed.stroke);
      assert.ok(strokeMatchesRectangle(r, changed.stroke), `${align}/${join}: Rust differs from rectangle edge oracle`);
      assert.deepEqual(changed.stroke.outer.length, expected.outer.length);
      assert.deepEqual(changed.stroke.inner.length, expected.inner.length);
      assert.ok(JSON.stringify(changed).length < 550, "stroke delta copied too much geometry");
      const saved = owner.exportDocument();
      const webStroke = saved.pages[0].root.children[0];
      assert.deepEqual([webStroke.strokeWidth, webStroke.strokePaint, webStroke.strokeAlign, webStroke.strokeJoin,
        webStroke.strokeVisible], [r.width, "#236b9e", align, join, true]);
      assert.equal(owner.strokeNode(id, r.width, "#236b9e", align, join).revision, 1,
        "no-op must not create a second history entry");
      const undo = owner.undo();
      assert.equal(undo.stroke?.width, 0);
      assert.deepEqual(undo.stroke?.outer, []);
      assert.deepEqual(owner.exportDocument(), seed, "undo restores the entire original document, not just the paint");
      const redo = owner.redo();
      assert.deepEqual(redo.stroke, changed.stroke, "redo restores exact Rust geometry/style");
      assert.deepEqual(owner.exportDocument(), saved);
      if (parity === 0) {
        const resized = owner.resizeNode(id, r.w + 10, r.h + 5);
        assert.deepEqual([resized.node.w, resized.node.h], [r.w + 10, r.h + 5]);
        assert.ok(strokeMatchesRectangle(resized.node, resized.stroke), "resize must reproject both stroke contours");
        const back = owner.undo();
        assert.ok(strokeMatchesRectangle(back.node, back.stroke), "undo resize must reproject the old band");
        assert.deepEqual(back.stroke, changed.stroke);
        assert.deepEqual(owner.redo().stroke, resized.stroke, "redo resize must reproject new band");
        assert.equal(owner.strokeNode(id, 0, "#236b9e", "center", "miter").stroke.width, 0);
      }
      owner.close();
      parity++;
    }
  assert.equal(parity, 30);
  assert.equal(bridgeAuditSnapshot().decisions["session.stroke"]?.attempts, strokeAuditsBefore + 1,
    "only the one opt-in edit may run the TS oracle; 29 default edits stay Rust-owned");
  console.log(`PASS real-WASM Rust stroke alignment: ${parity}/30 rectangle oracle parity, one opt-in audit, 29 default Rust edits, bound checks, history, resize reprojection and lossless checkpoints`);

  const extended = JSON.parse(glue.importSvgToX(plain));
  extended.doc.comments = [{ text: "do not discard me" }];
  assert.throws(() => decodeRustImport(JSON.stringify(extended)), /Unsupported Rust comments/);
  extended.doc.comments = [];
  extended.futureAppearance = { enabled: true };
  assert.throws(() => decodeRustImport(JSON.stringify(extended)), /properties: futureAppearance/);
  console.log("PASS actual-module envelope declines unsupported document metadata");
  const groupedSvg = '<svg width="120" height="80"><g id="outer" fill="#123456" opacity=".5"><g id="inner"><rect id="box" width="20" height="10"/></g></g><g id="empty"/></svg>';
  const groupedCandidate = decodeRustImport(glue.importSvgToX(groupedSvg));
  const groupedExpected = svgTs(groupedSvg);
  assert.equal(groupedCandidate.nodes.length, 1, "neutral group wrappers flatten like the TS importer");
  assert.equal(groupedCandidate.nodes[0].name, "box");
  assert.equal(groupedCandidate.nodes[0].fill, "#123456");
  assert.equal(groupedCandidate.nodes[0].opacity, 0.5);
  // Match choose()'s established SVG shape adaptation: a single native
  // interchange page is removed only because the web SVG result has no pages.
  assert.equal(groupedExpected.pages, undefined);
  assert.equal(groupedCandidate.pages.length, 1);
  delete groupedCandidate.pages;
  const groupedDiff = differencePaths(groupedCandidate, groupedExpected);
  console.log(`Diff grouped SVG: ${groupedDiff.join(", ") || "none"}`);
  assert.ok(importsEquivalent(groupedCandidate, groupedExpected), `group flattening contract differs: ${groupedDiff.join(", ") || "paths helper found none"}`);
  console.log("PASS direct neutral-group candidate contract");
  const groupedActual = importSvg(groupedSvg);
  console.log(`Grouped SVG wrapper: backend=${getEngineInfo().importBackend}; fallback=${getEngineInfo().lastImportFallback ?? "none"}; equivalent=${importsEquivalent(groupedActual, groupedExpected)}`);
  assert.ok(importsEquivalent(groupedActual, groupedExpected), "production group import must preserve the whole TS contract");
  assert.equal(getEngineInfo().importBackend, "wasm", getEngineInfo().lastImportFallback ?? "neutral groups should select native output");
  const translatedGroupSvg = '<svg width="120" height="80"><g id="outer" transform="translate(10 20)" fill="#123456" opacity=".5"><g id="inner" transform="translate(-2 5)"><rect id="box" x="3" y="4" width="20" height="10"/></g><text id="label" x="10" y="30" font-size="10">Hi</text><rect id="after" x="0" y="1" width="4" height="4"/></g><rect id="outside" x="5" y="6" width="3" height="2" fill="red"/></svg>';
  const translatedRaw = JSON.parse(glue.importSvgToX(translatedGroupSvg));
  const translatedCandidate = decodeRustImport(JSON.stringify(translatedRaw));
  assert.deepEqual(translatedCandidate.nodes.map(n => n.name), ["box", "label", "after", "outside"]);
  assert.deepEqual(translatedCandidate.nodes.map(n => [n.x, n.y]), [[11, 29], [20, 40], [10, 21], [5, 6]]);
  assert.equal(translatedRaw.textMetrics.nodes.label.height, 14, "text box remains import-only source metadata");
  delete translatedCandidate.pages;
  const translatedExpected = svgTs(translatedGroupSvg);
  const translatedDiff = differencePaths(translatedCandidate, translatedExpected);
  console.log(`Diff translated SVG group with text and siblings: ${translatedDiff.join(", ") || "none"}`);
  assert.ok(importsEquivalent(translatedCandidate, translatedExpected), `translated group candidate differs: ${translatedDiff.join(", ")}`);
  assert.ok(importsEquivalent(importSvg(translatedGroupSvg), translatedExpected));
  assert.equal(getEngineInfo().importBackend, "wasm", getEngineInfo().lastImportFallback ?? "single translations should select native");
  const matrixGroupSvg = '<svg width="120" height="80"><g transform="translate(7 -2)"><rect id="matrix" x="3" y="4" width="9" height="5" transform="matrix(1 0 0 1 2 3)" fill="red"/></g></svg>';
  const matrixCandidate = decodeRustImport(glue.importSvgToX(matrixGroupSvg));
  assert.deepEqual([matrixCandidate.nodes[0].x, matrixCandidate.nodes[0].y], [12, 5]);
  delete matrixCandidate.pages;
  const matrixExpected = svgTs(matrixGroupSvg);
  const matrixDiff = differencePaths(matrixCandidate, matrixExpected);
  console.log(`Diff translated SVG group with child matrix: ${matrixDiff.join(", ") || "none"}`);
  assert.ok(importsEquivalent(matrixCandidate, matrixExpected), `child matrix composition differs: ${matrixDiff.join(", ")}`);
  assert.ok(importsEquivalent(importSvg(matrixGroupSvg), matrixExpected));
  assert.equal(getEngineInfo().importBackend, "wasm", getEngineInfo().lastImportFallback ?? "translated child matrix should select native");
  const transformedGroupSvg = '<svg width="120" height="80"><g transform="rotate(15)"><rect width="20" height="10"/></g></svg>';
  const transformedExpected = svgTs(transformedGroupSvg), transformedActual = importSvg(transformedGroupSvg);
  console.log(`Transformed SVG wrapper: backend=${getEngineInfo().importBackend}; fallback=${getEngineInfo().lastImportFallback ?? "none"}; equivalent=${importsEquivalent(transformedActual, transformedExpected)}`);
  assert.ok(importsEquivalent(transformedActual, transformedExpected), "transformed group fallback must retain the complete TS result");
  assert.equal(getEngineInfo().importBackend, "ts", "transformed groups remain guarded until their flattening is equivalent");
  const compoundGroupSvg = '<svg width="120" height="80"><g id="compound" transform="translate(10 5) rotate(15)"><rect width="20" height="10" fill="red"/></g></svg>';
  assert.ok(importsEquivalent(importSvg(compoundGroupSvg), svgTs(compoundGroupSvg)));
  assert.equal(getEngineInfo().importBackend, "ts", "compound transforms remain guarded");
  const text = '<svg width="200" height="120"><text id="label" x="10" y="30" font-size="20" text-anchor="middle">Keep this text</text></svg>';
  const textRaw = JSON.parse(glue.importSvgToX(text));
  console.log(`Diff SVG text envelope: ${JSON.stringify({metrics: textRaw.textMetrics, node: textRaw.doc?.pages?.[0]?.children?.[0]})}`);
  assert.equal(textRaw.textMetrics.version, 2);
  assert.equal(textRaw.textMetrics.nodes.label.fontWeight, null, "unstyled SVG text reports no numeric source weight");
  let textCandidate;
  try { textCandidate = decodeRustImport(JSON.stringify(textRaw)); }
  catch (error) { console.log(`Diff SVG text decode error: ${String(error)}`); throw error; }
  const textExpected = svgTs(text);
  console.log(`Diff SVG text candidate: ${JSON.stringify(textCandidate.nodes[0])}; expected: ${JSON.stringify(textExpected.nodes[0])}`);
  const nativeText = textRaw.doc.pages[0].children[0];
  // .x omits the redundant name when it equals id. Never reconstruct it from TS.
  assert.equal(nativeText.name ?? nativeText.id, "label", "native SVG layer retains its source id as the name");
  assert.equal(textCandidate.nodes[0].name, "label", "the adapter must not borrow a name from TS");
  assert.equal(textCandidate.nodes[0].textAlign, "center");
  assert.deepEqual([textCandidate.nodes[0].x, textCandidate.nodes[0].y, textCandidate.nodes[0].w, textCandidate.nodes[0].h], [10, 10, 168, 28]);
  delete textCandidate.pages; // same single-interchange-page adaptation used by choose()
  const textDiff = differencePaths(textCandidate, textExpected);
  assert.ok(importsEquivalent(textCandidate, textExpected), `basic SVG text candidate differs: ${textDiff.join(", ")}`);
  assert.ok(importsEquivalent(importSvg(text), textExpected));
  assert.equal(getEngineInfo().importBackend, "wasm", "literal SVG text should use the complete native result");
  const unnamedText = '<svg width="200" height="120"><text x="10" y="30" font-size="20">Keep this text</text></svg>';
  const unnamedCandidate = decodeRustImport(glue.importSvgToX(unnamedText));
  assert.equal(unnamedCandidate.nodes[0].name, "Keep this text", "unnamed SVG text uses a content preview");
  delete unnamedCandidate.pages;
  assert.ok(importsEquivalent(unnamedCandidate, svgTs(unnamedText)), "unnamed SVG text candidate must match TS");
  assert.ok(importsEquivalent(importSvg(unnamedText), svgTs(unnamedText)));
  assert.equal(getEngineInfo().importBackend, "wasm", "unnamed SVG text should use native output");
  const boldText = '<svg width="200" height="120"><text x="10" y="30" font-size="20" font-weight="700">Keep this text</text></svg>';
  const boldRaw = JSON.parse(glue.importSvgToX(boldText));
  const boldNode = boldRaw.doc.pages[0].children[0];
  assert.equal(boldRaw.textMetrics.version, 2);
  assert.equal(boldRaw.textMetrics.nodes[boldNode.id].fontWeight, 700, "weight comes from the actual Rust SVG parser");
  assert.equal(boldNode.bindings, undefined, "source-only weight must not change persisted .x");
  const boldCandidate = decodeRustImport(JSON.stringify(boldRaw));
  delete boldCandidate.pages;
  const boldExpected = svgTs(boldText);
  const boldDiff = differencePaths(boldCandidate, boldExpected);
  console.log(`Diff SVG numeric weight: ${boldDiff.join(", ") || "none"}`);
  assert.ok(importsEquivalent(boldCandidate, boldExpected), `numeric SVG weight candidate differs: ${boldDiff.join(", ")}`);
  assert.ok(importsEquivalent(importSvg(boldText), boldExpected));
  assert.equal(getEngineInfo().importBackend, "wasm", "complete numeric SVG weight candidate should select native");
  console.log("PASS actual-module SVG numeric weight selects guarded WASM result");
  boldRaw.textMetrics.nodes[boldNode.id].fontWeight = "700";
  assert.throws(() => decodeRustImport(JSON.stringify(boldRaw)), /source font weight/);
  const partialWeight = boldText.replace('font-weight="700"', 'font-weight="700bold"');
  assert.ok(importsEquivalent(importSvg(partialWeight), svgTs(partialWeight)));
  assert.equal(getEngineInfo().importBackend, "ts", "partially numeric SVG weight stays guarded");
  for (const [label, source, w, h] of [
    ["viewBox dimensions", '<svg viewBox="0, 0, 96, 48"><rect id="box" x="10" y="12" width="20" height="15" fill="red"/></svg>', 96, 48],
    ["explicit width over viewBox", '<svg width="200" viewBox="0 0 96 48"><rect id="box" width="20" height="15" fill="red"/></svg>', 200, 48],
    ["default dimensions", '<svg><rect id="box" width="20" height="15" fill="red"/></svg>', 100, 100],
  ]) {
    const raw = JSON.parse(glue.importSvgToX(source));
    assert.equal(raw.ok, true, `${label}: native SVG import should succeed`);
    assert.deepEqual([raw.doc.pages[0].w, raw.doc.pages[0].h], [w, h], `${label}: native root size`);
    const expected = svgTs(source), candidate = decodeRustImport(JSON.stringify(raw));
    delete candidate.pages; // single SVG interchange root, as in choose()
    const diff = differencePaths(candidate, expected);
    console.log(`Diff SVG ${label}: ${diff.join(", ") || "none"}`);
    assert.ok(importsEquivalent(candidate, expected), `${label}: native import differs: ${diff.join(", ")}`);
    assert.ok(importsEquivalent(importSvg(source), expected), `${label}: complete wrapper result differs`);
    assert.equal(getEngineInfo().importBackend, "wasm", `${label}: ${getEngineInfo().lastImportFallback ?? "native output expected"}`);
  }
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
    if (format === "fig") {
      assert.equal(raw.figmaCoordinates.version, 1);
      assert.equal(decoded.nodes.find(n => n.name === "Home").x, 100);
      assert.equal(decoded.nodes.find(n => n.name === "Home").y, 50);
      assert.equal(decoded.nodes.find(n => n.name === "FigCard").x, 120);
      assert.equal(decoded.width, 320); assert.equal(decoded.height, 240);
    }
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
    if (format === "fig") {
      assert.equal(getEngineInfo().importBackend, "wasm", getEngineInfo().lastImportFallback ?? "basic FIG must pass the unchanged whole-result oracle");
      assert.ok(importsEquivalent(decoded, expected), "the entire FIG candidate—not a TS-patched result—must match");
    }
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
  const effectBytes = fs.readFileSync("e2e/fixtures/effects-blend.fig");
  const effectCandidate = decodeRustImport(glue.importFigToX(effectBytes));
  assert.equal(effectCandidate.nodes.length, 3);
  assert.deepEqual(effectCandidate.nodes.map(n => n.blendMode), ["Multiply", "Soft Light", "pass-through"]);
  assert.deepEqual(effectCandidate.nodes[0].effects, [
    { kind: "drop-shadow", color: "#ff000080", x: 5, y: -3, blur: 6, spread: 0, visible: true },
    { kind: "inner-shadow", color: "#0000ff", x: -2, y: 4, blur: 2, spread: 0, visible: true },
    { kind: "layer-blur", color: "#000000", x: 0, y: 0, blur: 8, spread: 0, visible: true },
    { kind: "background-blur", color: "#000000", x: 0, y: 0, blur: 4, spread: 0, visible: true },
  ].map(e => ({ ...e, blend: undefined, showBehind: false })));
  assert.equal(effectCandidate.nodes[1].effects[0].blur, 3);
  const effectData = effectBytes.buffer.slice(effectBytes.byteOffset, effectBytes.byteOffset + effectBytes.byteLength);
  const effectExpected = await figTs(effectData);
  console.log(`DIFF FIG effects: ${differencePaths(effectCandidate, effectExpected).join(", ") || "none"}`);
  assert.ok(importsEquivalent(effectCandidate, effectExpected), "complete source-backed effect candidate must match");
  assert.ok(importsEquivalent(await importFig(effectData), effectExpected));
  assert.equal(getEngineInfo().importBackend, "wasm");
  assert.equal(calls.fig, 4);
  console.log(`PASS native FIG effects/blends: four ordered effects, materialized+legacy lists, blur aliases, layer modes; wrapper=${getEngineInfo().importBackend}`);
  const coordinateBytes = fs.readFileSync("e2e/fixtures/coordinates.fig");
  const rawCoordinates = JSON.parse(glue.importFigToX(coordinateBytes));
  assert.equal(rawCoordinates.doc.pages[1].children[0].x, 40, "native placement remains normalized");
  const placed = decodeRustImport(JSON.stringify(rawCoordinates));
  assert.deepEqual(placed.pages.map(p => p.name), ["Empty", "Negative", "Positive"]);
  assert.equal(placed.pages[0].nodes.length, 0);
  assert.equal(placed.nodes[0].name, "Outer");
  assert.deepEqual([placed.nodes[0].x, placed.nodes[0].y], [-120, -80]);
  assert.deepEqual([placed.nodes[0].children[0].x, placed.nodes[0].children[0].y], [10, 20]);
  assert.deepEqual([placed.pages[2].nodes[0].x, placed.pages[2].nodes[0].y], [300, 200]);
  assert.deepEqual([placed.width, placed.height], [470, 340]);
  const coordinateData = coordinateBytes.buffer.slice(coordinateBytes.byteOffset, coordinateBytes.byteOffset + coordinateBytes.byteLength);
  const coordinateTs = await figTs(coordinateData);
  assert.deepEqual([placed.width, placed.height], [coordinateTs.width, coordinateTs.height]);
  assert.ok(importsEquivalent(await importFig(coordinateData), coordinateTs));
  assert.equal(calls.fig, 5);
  console.log(`PASS native FIG source placement: negative+positive pages, empty first page, nested local coordinates, content bounds; wrapper=${getEngineInfo().importBackend}`);
  const sourceBytes = fs.readFileSync("e2e/fixtures/effect-source.fig");
  const sourceData = sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
  const sourceRaw = JSON.parse(glue.importFigToX(sourceBytes));
  assert.equal(sourceRaw.figmaEffects.version, 1);
  const sourceCandidate = decodeRustImport(JSON.stringify(sourceRaw)), sourceExpected = await figTs(sourceData);
  console.log(`DIFF FIG source effects: ${differencePaths(sourceCandidate, sourceExpected).join(", ") || "none"}`);
  assert.ok(importsEquivalent(sourceCandidate, sourceExpected), "hidden effects, spread, blend, color and show-behind must match");
  assert.ok(importsEquivalent(await importFig(sourceData), sourceExpected));
  assert.equal(getEngineInfo().importBackend, "wasm");
  assert.equal(sourceCandidate.nodes[0].effects[0].spread, 7);
  assert.equal(sourceCandidate.nodes[0].effects[1].visible, false);
  assert.equal(sourceCandidate.nodes[1].effects[0].kind, "layer-blur");
  assert.equal(sourceCandidate.nodes[1].effects[0].visible, false);
  console.log("PASS native FIG source effects: hidden entries, spread, blend, show-behind; full candidate equivalent; wrapper=wasm");
  assert.equal(calls.fig, 6);
  assert.equal(calls.svg, 13); // translated/nested groups, child matrix, compound-group fallback
} catch (error) {
  // The raw job log is on an inaccessible CDN in some environments. Keep the
  // actionable assertion/stack API-readable as a single bounded annotation.
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.log(`::error::Real WASM import smoke failed: ${detail.slice(0, 3000).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
  throw error;
} finally { dom.window.close(); delete globalThis.DOMParser; }
console.log("PASS production import routing: native simple SVG, numeric text weight, real FIG/Sketch fixtures");


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

// Mount the actual opt-in React view over the generated WASM class. This is
// intentionally separate from the import oracle: Rust alone owns this editor.
// The mocked DOM checks wiring, not browser paint fidelity.
const uiDom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/", pretendToBeVisual: true,
});
const uiWindow = uiDom.window;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "DOMParser"]) {
  Object.defineProperty(globalThis, key, { value: key === "window" ? uiWindow : uiWindow[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
try {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RustDocumentView } = await import("../../src/ui/RustDocumentView.tsx");
  const uiDoc = docFromTemplate("blank");
  uiDoc.pages[0].root.children.push(node("rect", "Native card", 10, 20, 50, 30, { fill: "#a1b2c3" }));
  const host = uiWindow.document.createElement("div"); uiWindow.document.body.appendChild(host);
  const root = createRoot(host);
  const releases = [];
  await React.act(async () => root.render(React.createElement(RustDocumentView, {
    fileId: "real-wasm-preview", seed: uiDoc,
    onHome: () => {}, onStandard: () => {}, onRelease: fn => releases.push(fn),
  })));
  await React.act(async () => { await Promise.resolve(); });
  assert.ok(host.textContent.includes("Rust document preview"));
  assert.equal(host.querySelector(".rust-preview-rect")?.style.left, "10px");
  const action = label => [...host.querySelectorAll("button")].find(b => b.textContent.trim() === label);
  await React.act(async () => action("Move right 10").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(host.querySelector(".rust-preview-rect")?.style.left, "20px");
  assert.equal(host.querySelector(".rust-preview-toolbar span:not([role])")?.textContent, "Rust revision 1");
  await React.act(async () => action("Undo").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(host.querySelector(".rust-preview-rect")?.style.left, "10px");
  await React.act(async () => action("Wider 10").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(host.querySelector(".rust-preview-rect")?.style.width, "60px");
  await React.act(async () => action("Undo").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(host.querySelector(".rust-preview-rect")?.style.width, "50px");
  const alignControl = host.querySelector('select[aria-label="Stroke alignment"]');
  const joinControl = host.querySelector('select[aria-label="Stroke join"]');
  await React.act(async () => {
    alignControl.value = "outside";
    alignControl.dispatchEvent(new uiWindow.Event("change", { bubbles: true }));
    joinControl.value = "bevel";
    joinControl.dispatchEvent(new uiWindow.Event("change", { bubbles: true }));
  });
  await React.act(async () => host.querySelector(".rust-preview-stroke-form").dispatchEvent(new uiWindow.Event("submit", { bubbles: true, cancelable: true })));
  assert.match(host.querySelector(".rust-preview-stroke path")?.getAttribute("d") ?? "", /^M-8 0 L0 -8/);
  assert.equal(host.querySelector(".rust-preview-stroke path")?.getAttribute("fill"), "#202020");
  assert.equal(host.querySelector(".rust-preview-stroke")?.style.left, "-8px", "outside band cannot be clipped to the node's bounds");
  await React.act(async () => action("Undo").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(host.querySelector(".rust-preview-stroke"), null);
  await React.act(async () => action("Redo").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.ok(host.querySelector(".rust-preview-stroke path"));
  await React.act(async () => action("Remove stroke").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(host.querySelector(".rust-preview-stroke"), null);
  assert.ok(releases.some(owner => owner && typeof owner.close === "function" && owner.hasEdits()));
  await React.act(async () => root.unmount());
  host.remove();

  const uiBooleanDoc = docFromTemplate("blank");
  uiBooleanDoc.pages[0].root.children.push(
    node("rect", "First", 0, 0, 10, 10, { fill: "#123456" }),
    node("rect", "Second", 5, 5, 10, 10, { fill: "#654321" }));
  const booleanHost = uiWindow.document.createElement("div"); uiWindow.document.body.appendChild(booleanHost);
  const booleanRoot = createRoot(booleanHost);
  await React.act(async () => booleanRoot.render(React.createElement(RustDocumentView, {
    fileId: "real-wasm-boolean", seed: uiBooleanDoc,
    onHome: () => {}, onStandard: () => {}, onRelease: () => {},
  })));
  await React.act(async () => { await Promise.resolve(); });
  const booleanButton = label => [...booleanHost.querySelectorAll("button")].find(b => b.textContent.trim() === label);
  assert.equal(booleanButton("Union")?.disabled, true);
  const otherLayer = [...booleanHost.querySelectorAll(".rust-preview-layers button")]
    .find(b => b.textContent.includes("Second"));
  await React.act(async () => otherLayer.dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true, shiftKey: true })));
  assert.equal(booleanButton("Union")?.disabled, false);
  await React.act(async () => booleanButton("Union").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(booleanHost.querySelectorAll(".rust-preview-layers button").length, 1);
  assert.ok(booleanHost.querySelector(".rust-preview-rect svg path")?.getAttribute("d")?.startsWith("M"));
  assert.equal(booleanButton("Wider 10")?.disabled, true);
  await React.act(async () => booleanButton("Undo").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.equal(booleanHost.querySelectorAll(".rust-preview-layers button").length, 2);
  await React.act(async () => booleanButton("Redo").dispatchEvent(new uiWindow.MouseEvent("click", { bubbles: true })));
  assert.ok(booleanHost.querySelector(".rust-preview-rect svg path"));
  await React.act(async () => booleanRoot.unmount());
  booleanHost.remove();
  console.log("PASS real WASM opt-in React host V3: Rust move/resize, Boolean vector paint, atomic undo/redo and safe unmount");
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.log(`::error::Real WASM Rust UI failed: ${detail.slice(0, 3000).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
  throw error;
} finally {
  uiWindow.close();
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "DOMParser", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete globalThis[key];
  }
}

// These are wrapper-level counters. The tests above sourced both binaries from
// public/, initialized actual bindgen glue and instantiated actual x-geo WASM.
// This proves the diagnostic observed real calls in CI, not in a deployment.
const audit = bridgeAuditSnapshot();
assert.equal(audit.modules.imports.instantiated, true);
assert.equal(audit.modules.geometry.instantiated, true);
assert.equal(audit.modules.geometry.source, "override");
assert.ok(audit.functions["x-wasm.importSvgToX"]?.calls >= 1);
assert.ok(audit.functions["x-wasm.RustDocumentSession.resizeNode"]?.calls >= 2);
assert.ok(audit.functions["x-wasm.RustDocumentSession.booleanNode"]?.calls >= 6);
assert.ok(audit.functions["x-geo.xgeo_boolean"]?.calls >= 4);
assert.ok(audit.decisions["geometry.union"]?.attempts >= 1);
assert.ok(audit.decisions["session.open"]?.rust >= 1);
console.log("PASS real WASM audit: bindgen import, Rust resize/Boolean session, x-geo Boolean and guarded decisions observed at production call sites");
__enableBridgeAuditForTests(false);
