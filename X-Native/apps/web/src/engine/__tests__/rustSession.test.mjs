import assert from "node:assert/strict";
import { __resetWasmForTests, getEngineInfo, initWasmBridge } from "../wasmBridge.ts";
import { openRustSession } from "../rustSession.ts";

let passed = 0, failed = 0;
async function test(name, fn) {
  __resetWasmForTests();
  try { await fn(); passed++; console.log(`  ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}`, e); }
}
const patch = { revision: 1, node: { id: "box", name: "Card", x: 13, y: 16 }, canUndo: true, canRedo: false };
const moduleWith = (session) => ({
  default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm 0.34.0 (rust)",
  importFigToX: () => "", importSketchToX: () => "", importSvgToX: () => "",
  sessionBridgeVersion: () => 1, RustDocumentSession: session,
});

await test("optional older bindgen artifacts keep imports without advertising a command session", async () => {
  assert.equal(await initWasmBridge(async () => moduleWith(undefined)), true);
  assert.equal(await openRustSession("native .x"), null);
  assert.equal(getEngineInfo().hasWasm, true);
});
await test("wrong independent session ABI declines without breaking import status", async () => {
  assert.equal(await initWasmBridge(async () => ({ ...moduleWith(class {}), sessionBridgeVersion: () => 2 })), true);
  assert.equal(await openRustSession("native .x"), null);
  assert.equal(getEngineInfo().importStatus, "ready");
});
await test("commands are forwarded to one Rust-owned instance, never a JS document mirror", async () => {
  const calls = [];
  class FakeSession {
    constructor(x) { calls.push(["open", x]); }
    state() { return JSON.stringify({ ...patch, revision: 0, node: null, canUndo: false }); }
    getNode(id) { calls.push(["getNode", id]); return JSON.stringify(patch.node); }
    renameNode(id, name) { calls.push(["rename", id, name]); return JSON.stringify(patch); }
    moveNode(id, dx, dy) { calls.push(["move", id, dx, dy]); return JSON.stringify(patch); }
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
  assert.deepEqual(session.undo(), patch);
  assert.deepEqual(session.redo(), patch);
  assert.equal(session.exportX(), '{"format":"x-native"}');
  session.close(); session.close();
  assert.deepEqual(calls, [
    ["open", "native .x"], ["getNode", "box"], ["rename", "box", "Card"],
    ["move", "box", 3, -4], ["undo"], ["redo"], ["exportX"], ["free"],
  ]);
  assert.throws(() => session.undo(), /closed/);
});
await test("malformed or whole-document command responses are rejected, not silently cast", async () => {
  class BadSession {
    renameNode() { return JSON.stringify({ ...patch, pages: [] }); }
    free() {}
  }
  await initWasmBridge(async () => moduleWith(BadSession));
  const session = await openRustSession("native .x");
  assert.ok(session);
  assert.throws(() => session.renameNode("box", "Card"), /session delta fields/);
  session.close();
});
await test("missing wasm has no JS document/undo replacement", async () => {
  assert.equal(await initWasmBridge(async () => { throw Error("404"); }), false);
  assert.equal(await openRustSession("native .x"), null);
});

console.log(`Rust session adapter: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
