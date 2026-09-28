import assert from "node:assert/strict";
import { __resetWasmForTests, getEngineInfo, initWasmBridge } from "../wasmBridge.ts";
import { openRustSession } from "../rustSession.ts";

let passed = 0, failed = 0;
async function test(name, fn) {
  __resetWasmForTests();
  try { await fn(); passed++; console.log(`  ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}`, e); }
}
const patch = { revision: 1, node: { id: "box", name: "Card", x: 13, y: 16, w: 80, h: 24.5 }, canUndo: true, canRedo: false };
const moduleWith = (session) => ({
  default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm 0.34.0 (rust)",
  importFigToX: () => "", importSketchToX: () => "", importSvgToX: () => "",
  sessionBridgeVersion: () => 5, RustDocumentSession: session,
});

await test("optional older bindgen artifacts keep imports without advertising a command session", async () => {
  assert.equal(await initWasmBridge(async () => moduleWith(undefined)), true);
  assert.equal(await openRustSession("native .x"), null);
  assert.equal(getEngineInfo().hasWasm, true);
});
await test("old/future session ABIs decline without breaking import status", async () => {
  for (const version of [1, 2, 3, 4, 6]) {
    __resetWasmForTests();
    assert.equal(await initWasmBridge(async () => ({ ...moduleWith(class {}), sessionBridgeVersion: () => version })), true);
    assert.equal(await openRustSession("native .x"), null);
    assert.equal(getEngineInfo().importStatus, "ready");
  }
});
await test("commands are forwarded to one Rust-owned instance, never a JS document mirror", async () => {
  const calls = [];
  class FakeSession {
    constructor(x) { calls.push(["open", x]); }
    state() { return JSON.stringify({ ...patch, revision: 0, node: null, canUndo: false }); }
    getNode(id) { calls.push(["getNode", id]); return JSON.stringify(patch.node); }
    getShape(id) { calls.push(["getShape", id]); return JSON.stringify({ ...patch.node, kind: "rect", radius: 0 }); }
    previewOffset(id, distance, join) {
      calls.push(["previewOffset", id, distance, join]);
      return JSON.stringify({ ...patch.node, kind: "vector", path: [
        ["M", 0, 0], ["L", 80, 0], ["L", 80, 24.5], ["L", 0, 24.5], ["Z"]] });
    }
    offsetNode(id, distance, join) {
      calls.push(["offsetNode", id, distance, join]);
      return JSON.stringify({ ...patch, node: null, offset: { ...patch.node, kind: "vector", path: [
        ["M", 0, 0], ["L", 80, 0], ["L", 80, 24.5], ["L", 0, 24.5], ["Z"]] } });
    }
    renameNode(id, name) { calls.push(["rename", id, name]); return JSON.stringify(patch); }
    moveNode(id, dx, dy) { calls.push(["move", id, dx, dy]); return JSON.stringify(patch); }
    resizeNode(id, w, h) { calls.push(["resize", id, w, h]); return JSON.stringify(patch); }
    booleanNode(first, second, op) { calls.push(["boolean", first, second, op]); return JSON.stringify(patch); }
    strokeNode(id, width, color, align, join) {
      calls.push(["stroke", id, width, color, align, join]); return JSON.stringify(patch);
    }
    undo() { calls.push(["undo"]); return JSON.stringify(patch); }
    redo() { calls.push(["redo"]); return JSON.stringify(patch); }
    exportX() { calls.push(["exportX"]); return '{"format":"x-native"}'; }
    free() { calls.push(["free"]); }
  }
  await initWasmBridge(async () => moduleWith(FakeSession));
  const session = await openRustSession("native .x");
  assert.ok(session);
  assert.equal(session.state().revision, 0);
  assert.deepEqual(session.getNode("box"), patch.node);
  assert.deepEqual(session.renameNode("box", "Card"), patch);
  assert.deepEqual(session.moveNode("box", 3, -4), patch);
  assert.deepEqual(session.resizeNode("box", 80, 24.5), patch);
  assert.deepEqual(session.booleanNode("box", "b", "exclude"), patch);
  assert.deepEqual(session.strokeNode("box", 3, "#123456", "outside", "bevel"), patch);
  assert.equal(session.getShape("box").kind, "rect");
  assert.equal(session.previewOffset("box", 4, "round").path.length, 5);
  assert.equal(session.offsetNode("box", 4, "round").offset.kind, "vector");
  assert.deepEqual(session.undo(), patch);
  assert.deepEqual(session.redo(), patch);
  assert.equal(session.exportX(), '{"format":"x-native"}');
  session.close(); session.close();
  assert.deepEqual(calls, [
    ["open", "native .x"], ["getNode", "box"], ["rename", "box", "Card"],
    ["move", "box", 3, -4], ["resize", "box", 80, 24.5],
    ["boolean", "box", "b", "exclude"], ["stroke", "box", 3, "#123456", "outside", "bevel"],
    ["getShape", "box"], ["previewOffset", "box", 4, "round"], ["offsetNode", "box", 4, "round"],
    ["undo"], ["redo"], ["exportX"], ["free"],
  ]);
  assert.throws(() => session.undo(), /closed/);
});
await test("malformed or whole-document command responses are rejected, not silently cast", async () => {
  class BadSession {
    state() { return JSON.stringify(patch); }
    getNode() { return JSON.stringify(patch.node); }
    getShape() { return "{}"; }
    previewOffset() { return "{}"; }
    offsetNode() { return "{}"; }
    renameNode() { return JSON.stringify({ ...patch, pages: [] }); }
    moveNode() { return JSON.stringify(patch); }
    resizeNode() { return JSON.stringify({ ...patch, node: { ...patch.node, w: "wide" } }); }
    booleanNode() { return JSON.stringify({ ...patch, boolean: { pages: [] } }); }
    strokeNode() { return JSON.stringify({ ...patch, stroke: { pages: [] } }); }
    undo() { return JSON.stringify(patch); }
    redo() { return JSON.stringify(patch); }
    exportX() { return "{}"; }
    free() {}
  }
  await initWasmBridge(async () => moduleWith(BadSession));
  const session = await openRustSession("native .x");
  assert.ok(session);
  assert.throws(() => session.renameNode("box", "Card"), /session delta fields/);
  assert.throws(() => session.resizeNode("box", 90, 20), /Invalid Rust node delta/);
  assert.throws(() => session.booleanNode("box", "b", "union"), /Invalid Rust session delta/);
  assert.throws(() => session.strokeNode("box", 4, "#000000", "center", "miter"), /stroke delta/);
  session.close();
});
await test("bounded Boolean patches are parsed strictly, without a full document", async () => {
  const layer = { ...patch.node, id: "result", index: 0, kind: "vector", fill: "#123456",
    visible: true, locked: false, rings: [[[0, 0], [10, 0], [10, 10]]] };
  const changed = { revision: 1, node: null, canUndo: true, canRedo: false,
    boolean: { removed: ["a", "b"], upsert: [layer] } };
  let result = changed;
  class Session {
    state() { return JSON.stringify({ ...patch, revision: 0, node: null }); }
    getNode() { return "null"; }
    getShape() { return "{}"; }
    previewOffset() { return "{}"; }
    offsetNode() { return "{}"; }
    renameNode() { return JSON.stringify(patch); }
    moveNode() { return JSON.stringify(patch); }
    resizeNode() { return JSON.stringify(patch); }
    booleanNode() { return JSON.stringify(result); }
    strokeNode() { return JSON.stringify(result); }
    undo() { return JSON.stringify({ revision: 2, node: null, canUndo: false, canRedo: true,
      boolean: { removed: ["result"], upsert: [
        { ...layer, id: "a", kind: "rect", index: 0, rings: undefined },
        { ...layer, id: "b", kind: "rect", index: 2, rings: undefined },
      ].map(({ rings, ...r }) => r) } }); }
    redo() { return this.booleanNode(); }
    exportX() { return "{}"; }
    free() {}
  }
  await initWasmBridge(async () => moduleWith(Session));
  const session = await openRustSession("native .x");
  assert.deepEqual(session.booleanNode("a", "b", "union").boolean, changed.boolean);
  assert.deepEqual(session.undo().boolean.removed, ["result"]);
  result = { ...changed, boolean: { ...changed.boolean, upsert: [
    { ...layer, rings: [[[0, Infinity], [1, 0], [1, 1]]] },
  ] } };
  assert.throws(() => session.booleanNode("a", "b", "union"), /contour point/);
  result = { ...changed, pages: [] };
  assert.throws(() => session.booleanNode("a", "b", "union"), /session delta fields/);
  session.close();
});
await test("bounded stroke deltas reject unexpected fields, nonfinite geometry and invalid option names", async () => {
  const good = { revision: 1, node: null, canUndo: true, canRedo: false,
    stroke: { id: "box", width: 8, color: "#236b9e", align: "outside", join: "bevel",
      outer: [[-8, 0], [0, -8], [40, -8], [48, 0], [48, 30], [40, 38], [0, 38], [-8, 30]],
      inner: [[0, 0], [40, 0], [40, 30], [0, 30]] } };
  let response = good;
  class Styled {
    state() { return JSON.stringify({ ...patch, revision: 0, node: null }); }
    getNode() { return JSON.stringify(patch.node); }
    getShape() { return "{}"; }
    previewOffset() { return "{}"; }
    offsetNode() { return "{}"; }
    renameNode() { return JSON.stringify(patch); }
    moveNode() { return JSON.stringify(patch); }
    resizeNode() { return JSON.stringify(patch); }
    booleanNode() { return JSON.stringify(patch); }
    strokeNode() { return JSON.stringify(response); }
    undo() { return JSON.stringify(response); }
    redo() { return JSON.stringify(response); }
    exportX() { return "{}"; }
    free() {}
  }
  await initWasmBridge(async () => moduleWith(Styled));
  const session = await openRustSession("native .x");
  assert.deepEqual(session.strokeNode("box", 8, "#236b9e", "outside", "bevel").stroke, good.stroke);
  for (const value of [
    { ...good, stroke: { ...good.stroke, outer: [[Infinity, 0], ...good.stroke.outer.slice(1)] } },
    { ...good, stroke: { ...good.stroke, color: "#ff0" } },
    { ...good, stroke: { ...good.stroke, join: "round" } },
    { ...good, stroke: { ...good.stroke, extra: "discarded" } },
    { ...good, stroke: { ...good.stroke, outer: Array(5000).fill([0, 0]) } },
    { ...good, boolean: { upsert: [], removed: [] } },
    { ...good, pages: [] },
  ]) {
    response = value;
    assert.throws(() => session.strokeNode("box", 8, "#236b9e", "outside", "bevel"), /Invalid|Unexpected/);
  }
  response = { ...good, revision: 2, stroke: { id: "box", width: 0, color: "#000000",
    align: "center", join: "miter", outer: [], inner: [] } };
  assert.equal(session.undo().stroke.width, 0);
  session.close();
});
await test("offset paths are bounded, closed, typed and never whole-page deltas", async () => {
  const shape = { id: "box", name: "Card", x: -4, y: 8, w: 20, h: 12, kind: "vector",
    path: [["M", 0, 0], ["L", 20, 0], ["L", 20, 12], ["L", 0, 12], ["Z"]] };
  const good = { revision: 1, node: null, canUndo: true, canRedo: false, offset: shape };
  let response = good;
  class OffsetSession {
    state() { return JSON.stringify({ revision: 0, node: null, canUndo: false, canRedo: false }); }
    getNode() { return JSON.stringify(patch.node); }
    getShape() { return JSON.stringify({ ...patch.node, kind: "rect", radius: 0 }); }
    previewOffset() { return JSON.stringify(shape); }
    offsetNode() { return JSON.stringify(response); }
    renameNode() { return JSON.stringify(patch); }
    moveNode() { return JSON.stringify(patch); }
    resizeNode() { return JSON.stringify(patch); }
    booleanNode() { return JSON.stringify(patch); }
    strokeNode() { return JSON.stringify(patch); }
    undo() { return JSON.stringify(response); }
    redo() { return JSON.stringify(response); }
    exportX() { return "{}"; }
    free() {}
  }
  await initWasmBridge(async () => moduleWith(OffsetSession));
  const session = await openRustSession("native .x");
  assert.deepEqual(session.offsetNode("box", 5, "round").offset, shape);
  assert.deepEqual(session.previewOffset("box", 5, "round"), shape);
  for (const invalid of [
    { ...good, offset: { ...shape, path: [["M", 0, 0], ["L", 5, 0]] } },
    { ...good, offset: { ...shape, path: [["M", 0, 0], ["C", 0, 1, 1, 1, 2, 2], ["Z"]] } },
    { ...good, offset: { ...shape, path: [["M", Infinity, 0], ["L", 5, 0], ["L", 5, 5], ["Z"]] } },
    { ...good, offset: { ...shape, pages: [] } },
    { ...good, node: patch.node },
    { ...good, boolean: { removed: [], upsert: [] } },
    { ...good, stroke: {} },
  ]) {
    response = invalid;
    assert.throws(() => session.offsetNode("box", 5, "round"), /Invalid|Unexpected|Unclosed/);
  }
  session.close();
});
await test("incomplete v5 binding frees itself before exposing a Rust owner", async () => {
  let freed = 0;
  class IncompleteSession {
    state() { return "{}"; }
    free() { freed++; }
  }
  await initWasmBridge(async () => moduleWith(IncompleteSession));
  await assert.rejects(() => openRustSession("native .x"), /Incomplete Rust command-session ABI/);
  assert.equal(freed, 1);
  assert.equal(getEngineInfo().importStatus, "ready");
});
await test("missing wasm has no JS document/undo replacement", async () => {
  assert.equal(await initWasmBridge(async () => { throw Error("404"); }), false);
  assert.equal(await openRustSession("native .x"), null);
});

console.log(`Rust session adapter: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
