import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  __enableBridgeAuditForTests, auditRustCall, bridgeAuditSnapshot, installBrowserBridgeAudit,
  inspectBridgeAssets, resetBridgeAudit,
} from "../bridgeRuntimeAudit.ts";
import { __resetWasmForTests, importSvg, initWasmBridge } from "../wasmBridge.ts";
import { __resetGeoForTests, __setGeoModuleForTests, wrapGeoExports } from "../geoBridge.ts";
import { booleanPath, booleanPathTs } from "../geometry.ts";
import { RustSessionClient } from "../rustSession.ts";

const dom = new JSDOM("<!doctype html>");
globalThis.DOMParser = dom.window.DOMParser;
__enableBridgeAuditForTests(true);
globalThis.window = { location: { search: "?bridgeAudit=1" } };
installBrowserBridgeAudit();
const command = window.__xWasmAudit;
assert.ok(command, "opt-in browser command installed");
assert.equal(command.snapshot().modules.geometry.instantiated, false);
assert.equal(command.snapshot().modules.imports.instantiated, false);

const svg = '<svg width="200" height="120"><rect id="box" x="10" y="10" width="80" height="50" fill="#ff0000"/></svg>';
const shape = { id: "box", kind: { t: "rect", radius: 0 }, x: 10, y: 10, w: 80, h: 50,
  rotation: 0, opacity: 1, visible: true, locked: false, fill: { t: "solid", c: "#ff0000" } };
const envelope = (children = [shape]) => JSON.stringify({ ok: true, doc: { format: "x-native", version: 1, pages: [
  { ...shape, id: "page", name: "Page", x: 0, y: 0, w: 200, h: 120, kind: { t: "frame" }, children },
] } });
let rustImports = 0;
const glue = {
  default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm audit-test (mock)",
  importSvgToX: () => { rustImports++; return envelope(); },
  importFigToX: () => envelope(), importSketchToX: () => envelope(),
};
try {
  assert.equal(await initWasmBridge(async () => glue), true);
  assert.equal(importSvg(svg).nodes[0].name, "box");
  assert.equal(rustImports, 1, "counted a real invocation at the mock bindgen interface");
  let snap = command.snapshot();
  assert.equal(snap.functions["x-wasm.importSvgToX"].calls, 1);
  assert.equal(snap.decisions["imports.Svg"].attempts, 1);
  assert.equal(snap.decisions["imports.Svg"].rust, 1);
  assert.equal(snap.decisions["imports.Svg"].last.guard, "passed");
  assert.equal(snap.modules.imports.instantiated, true);

  // The same actual native call can occur while its result is rejected.
  __resetWasmForTests();
  await initWasmBridge(async () => ({ ...glue, importSvgToX: () => { rustImports++; return envelope([]); } }));
  importSvg(svg);
  snap = command.snapshot();
  assert.equal(snap.functions["x-wasm.importSvgToX"].calls, 2);
  assert.equal(snap.decisions["imports.Svg"].rust, 1);
  assert.equal(snap.decisions["imports.Svg"].ts, 1);
  assert.equal(snap.decisions["imports.Svg"].blocked, 1);

  // Exercise the raw export wrappers, not a fake counter increment. The module
  // is intentionally labeled test-injected; this is NOT evidence of Rust math.
  let next = 1024;
  const memory = new WebAssembly.Memory({ initial: 1 });
  const e = {
    memory,
    xgeo_version: () => 1,
    xgeo_alloc: len => { const p = next; next += len + 16; return p; },
    xgeo_free: () => {},
    xgeo_boolean: (_req, _len, out) => {
      const response = new Uint8Array(52); // valid empty response
      const dv = new DataView(response.buffer);
      dv.setUint32(0, 0x58475231, true); dv.setUint32(4, 52, true); dv.setUint16(8, 1, true); dv.setUint8(10, 1);
      const ptr = next; next += 100;
      new Uint8Array(memory.buffer).set(response, ptr);
      const view = new DataView(memory.buffer);
      view.setUint32(out, ptr, true); view.setUint32(out + 4, 52, true);
      return 0;
    },
  };
  __setGeoModuleForTests(wrapGeoExports(e));
  const rect = (x, y) => ({ poly: [
    { x, y }, { x: x + 10, y }, { x: x + 10, y: y + 10 }, { x, y: y + 10 },
  ], ox: 0, oy: 0 });
  const shapes = [rect(0, 0), rect(5, 5)];
  assert.equal(booleanPath("union", shapes), null, "promoted auto selects native empty without the oracle");
  snap = command.snapshot();
  assert.equal(snap.functions["x-geo.xgeo_boolean"].calls, 1);
  assert.equal(snap.functions["x-geo.xgeo_alloc"].calls, 2);
  assert.equal(snap.functions["x-geo.xgeo_free"].calls, 3);
  assert.equal(snap.decisions["geometry.union"].rust, 1);
  assert.equal(snap.decisions["geometry.union"].last.guard, "not-run");
  assert.equal(snap.modules.geometry.source, "test-injected");

  window.location.search = "?bridgeAudit=1&geo=audit";
  const prevWarn = console.warn;
  console.warn = () => {};
  try { assert.deepEqual(booleanPath("union", shapes), booleanPathTs("union", shapes)); }
  finally { console.warn = prevWarn; }
  snap = command.snapshot();
  assert.equal(snap.functions["x-geo.xgeo_boolean"].calls, 2);
  assert.equal(snap.decisions["geometry.union"].ts, 1);
  assert.equal(snap.decisions["geometry.union"].blocked, 1);
  assert.match(snap.decisions["geometry.union"].last.reason, /emptiness/);

  // When the mode is explicitly TS, no native call and no guard comparison.
  window.location.search = "?bridgeAudit=1&geo=ts&imports=ts";
  globalThis.location = window.location;
  booleanPath("intersect", shapes);
  importSvg(svg);
  snap = command.snapshot();
  assert.equal(snap.decisions["geometry.intersect"].last.guard, "not-run");
  assert.equal(snap.functions["x-geo.xgeo_boolean"].calls, 2);
  assert.equal(snap.functions["x-wasm.importSvgToX"].calls, 2);
  window.location.search = "?bridgeAudit=1";
  delete globalThis.location;

  const state = JSON.stringify({ revision: 1, node: null, canUndo: true, canRedo: false });
  let freed = 0;
  const binding = { state: () => state, getNode: () => "null", renameNode: () => state,
    moveNode: () => state, resizeNode: () => state, undo: () => state, redo: () => state,
    exportX: () => "{}", free: () => { freed++; } };
  window.location.hash = "#/file/private-id?engine=rust";
  assert.equal(command.snapshot().modules.session.rustRouteRequested, true);
  assert.match(command.snapshot().modules.session.activeDocumentOwner, /no TS shadow/);
  const client = new RustSessionClient(binding);
  assert.match(command.snapshot().modules.session.activeDocumentOwner, /Rust command session/);
  client.renameNode("private-id", "private-name");
  client.resizeNode("private-id", 20, 30);
  client.close();
  assert.equal(freed, 1);
  assert.equal(command.snapshot().modules.session.activeRustSessions, 0);
  assert.equal(command.snapshot().functions["x-wasm.RustDocumentSession.resizeNode"].calls, 1);
  assert.ok(!JSON.stringify(command.snapshot()).includes("private-"), "no document data in audit snapshot");

  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><html>fallback</html>",
    { status: 200, headers: { "content-type": "text/html" } });
  try {
    const assets = await inspectBridgeAssets();
    assert.equal(assets["x-wasm glue"].plausibleAsset, false);
    assert.equal(assets["x-geo binary"].wasmMagic, false);
    assert.equal(assets["x-wasm binary"].status, 200);
  } finally { globalThis.fetch = fetchBefore; }
  globalThis.fetch = async url => new Response(
    String(url).endsWith(".js") ? "export default function init() {}" : new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    { status: 200, headers: { "content-type": String(url).endsWith(".js") ? "text/javascript" : "application/wasm" } },
  );
  try {
    const assets = await command.assets();
    assert.equal(assets["x-wasm glue"].plausibleAsset, true);
    assert.equal(assets["x-wasm binary"].plausibleAsset, true);
    assert.equal(assets["x-geo binary"].plausibleAsset, true);
  } finally { globalThis.fetch = fetchBefore; }

  resetBridgeAudit();
  assert.equal(command.snapshot().functions["x-wasm.importSvgToX"].calls, 0);
  assert.deepEqual(command.snapshot().decisions, {});
  __enableBridgeAuditForTests(false);
  delete globalThis.window;
  auditRustCall("x-geo.xgeo_boolean", () => 5);
  assert.equal(bridgeAuditSnapshot().functions["x-geo.xgeo_boolean"]?.calls ?? 0, 0, "opt-out has no call-count overhead");
  console.log("bridge runtime audit: call sites, guards, session, bytes and opt-out passed");
} finally {
  __resetWasmForTests();
  __resetGeoForTests();
  __enableBridgeAuditForTests(false);
  delete globalThis.location;
  delete globalThis.window;
  dom.window.close();
}
