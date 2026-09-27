import assert from "node:assert/strict";
import { encodeGeoRequest, decodeGeoResponse, wrapGeoExports, ensureGeo, __resetGeoForTests, __setGeoModuleForTests } from "../geoBridge.ts";
import { booleanPath, booleanPathTs } from "../geometry.ts";
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}`, e); }
}
const shapes = [0, 10].map((ox) => ({ ox, oy: 0, poly: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] }));
function response(status = 0, message = "bad λ\t") {
  const msg = new TextEncoder().encode(message);
  const b = new Uint8Array(status === 1 ? 52 : status === 2 ? 60 + msg.length : 108), d = new DataView(b.buffer);
  d.setUint32(0, 0x58475231, true); d.setUint32(4, b.length, true); d.setUint16(8, 1, true); d.setUint8(10, status);
  if (status === 2) { d.setUint32(52, msg.length, true); b.set(msg, 60); }
  if (status === 0) {
    d.setFloat64(28, 300, true); d.setFloat64(36, 400, true); d.setUint32(44, 1, true); d.setUint32(52, 3, true);
    [0, 0, 300, 0, 0, 400].forEach((n, i) => d.setFloat64(60 + 8 * i, n, true));
  }
  return b;
}
for (const [name, change] of [
  ["wrong total length", (d) => d.setUint32(4, 999, true)],
  ["non-finite bbox", (d) => d.setFloat64(12, NaN, true)],
  ["negative dimensions", (d) => d.setFloat64(28, -1, true)],
  ["non-finite contour", (d) => d.setFloat64(60, Infinity, true)],
  ["reserved header", (d) => d.setUint8(11, 1)],
  ["reserved contour", (d) => d.setUint32(56, 1, true)],
  ["excessive contour count", (d) => d.setUint32(44, 0xffffffff, true)],
  ["excessive point count", (d) => d.setUint32(52, 0xffffffff, true)],
  ["trailing bytes", (d) => d.setUint32(52, 2, true)],
  ["missing contours", (d) => d.setUint32(44, 0, true)],
  ["unknown status", (d) => d.setUint8(10, 3)],
  ["empty with contour body", (d) => d.setUint8(10, 1)],
]) await test(`decoder rejects ${name}`, () => { const b = response(); change(new DataView(b.buffer)); assert.throws(() => decodeGeoResponse(b)); });
await test("decoder accepts nonzero byte offset", () => {
  const b = new Uint8Array(120); b.set(response(), 7); assert.equal(decodeGeoResponse(b.subarray(7, 115)).contours.length, 1);
});
await test("empty response has no body", () => assert.equal(decodeGeoResponse(response(1)).contours.length, 0));
await test("UTF-8 native errors preserve message", () => assert.throws(() => decodeGeoResponse(response(2)), /bad λ\t/));
await test("truncated error header has controlled error, not RangeError", () => {
  const b = response(2).slice(0, 52); new DataView(b.buffer).setUint32(4, 52, true);
  assert.throws(() => decodeGeoResponse(b), /truncated response/);
});
for (const key of ["x", "y", "ix", "iy", "ox", "oy"]) await test(`encoder rejects non-finite ${key}`, () => {
  const s = structuredClone(shapes); s[0].poly[0][key] = Infinity; assert.throws(() => encodeGeoRequest("union", s), /non-finite/);
});
await test("encoder rejects non-finite offsets", () => assert.throws(() => encodeGeoRequest("union", [{ ...shapes[0], ox: NaN }, shapes[1]])));

function mock(overrides = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 }); let next = 32;
  const freed = [];
  const e = { memory, xgeo_version: () => 1,
    xgeo_alloc: (len) => { const p = next; next += len; return p; },
    xgeo_free: (p, len) => freed.push([p, len]),
    xgeo_boolean: (_req, _len, ptr) => {
      const b = response(), out = e.xgeo_alloc(b.length);
      new Uint8Array(memory.buffer).set(b, out);
      const d = new DataView(memory.buffer); d.setUint32(ptr, out, true); d.setUint32(ptr + 4, b.length, true); return 0;
    }, ...overrides,
  };
  return { e, freed, bridge: wrapGeoExports(e) };
}
await test("copies response and frees three allocations", () => {
  const m = mock(); assert.equal(decodeGeoResponse(m.bridge.call(new Uint8Array(16))).contours.length, 1); assert.equal(m.freed.length, 3);
});
await test("memory growth during allocation detaches old views safely", () => {
  const m = mock(); let next = 32;
  m.e.xgeo_alloc = (len) => { m.e.memory.grow(1); const p = next; next += len; return p; };
  assert.equal(decodeGeoResponse(m.bridge.call(new Uint8Array(16))).w, 300); assert.equal(m.freed.length, 3);
});
await test("failed first allocation never calls into native boolean", () => {
  const m = mock({ xgeo_alloc: () => 0, xgeo_boolean: () => { throw Error("must not call"); } });
  assert.throws(() => m.bridge.call(new Uint8Array(16)), /request allocation failed/); assert.equal(m.freed.length, 0);
});
await test("failed output allocation frees the request", () => {
  let n = 0; const m = mock({ xgeo_alloc: () => ++n === 1 ? 32 : 0 });
  assert.throws(() => m.bridge.call(new Uint8Array(16)), /output allocation failed/); assert.deepEqual(m.freed, [[32, 16]]);
});
await test("throwing second allocation frees the request", () => {
  let n = 0; const m = mock({ xgeo_alloc: () => { if (++n === 1) return 32; throw Error("allocation trap"); } });
  assert.throws(() => m.bridge.call(new Uint8Array(16)), /allocation trap/); assert.deepEqual(m.freed, [[32, 16]]);
});
await test("native trap frees request and output slots", () => {
  const m = mock({ xgeo_boolean: () => { throw Error("trap"); } }); assert.throws(() => m.bridge.call(new Uint8Array(16))); assert.equal(m.freed.length, 2);
});
await test("transport status does not accept stale output slots", () => {
  const m = mock({ xgeo_boolean: () => 3 }); assert.throws(() => m.bridge.call(new Uint8Array(16)), /call failed/); assert.equal(m.freed.length, 2);
});
await test("out-of-bounds native response is not sliced silently", () => {
  const m = mock({ xgeo_boolean: (_a, _b, out) => { const d = new DataView(m.e.memory.buffer); d.setUint32(out, 65000, true); d.setUint32(out + 4, 1000, true); return 0; } });
  assert.throws(() => m.bridge.call(new Uint8Array(16)), /out of bounds/); assert.equal(m.freed.length, 3);
});
await test("free trap still attempts to release every allocation", () => {
  const m = mock(); const freed = []; m.e.xgeo_free = (p) => { freed.push(p); throw Error("free trap"); };
  assert.throws(() => m.bridge.call(new Uint8Array(16)), /free trap/); assert.equal(freed.length, 3);
});
await test("concurrent fetch callers share initialization, not an early null", async () => {
  __resetGeoForTests(); const fetch = globalThis.fetch; let count = 0, release;
  globalThis.fetch = async () => { count++; await new Promise((r) => { release = r; }); return { ok: false }; };
  try {
    const a = ensureGeo(), b = ensureGeo(); assert.equal(a, b); release(); assert.equal(await a, null); assert.equal(await b, null); assert.equal(count, 1);
  } finally { globalThis.fetch = fetch; __resetGeoForTests(); }
});
await test("TS override does not poison a later explicit load", async () => {
  __resetGeoForTests(); globalThis.location = { search: "?geo=ts" };
  assert.equal(await ensureGeo(), null); delete globalThis.location;
  const fetch = globalThis.fetch; let called = false; globalThis.fetch = async () => { called = true; return { ok: false }; };
  try { await ensureGeo(); assert.equal(called, true); } finally { globalThis.fetch = fetch; __resetGeoForTests(); }
});
await test("auto declines unequal native geometry instead of changing documents", () => {
  __setGeoModuleForTests({ version: 1, call: () => response() }); assert.deepEqual(booleanPath("union", shapes), booleanPathTs("union", shapes));
});
await test("auto does not trust a false empty result", () => {
  __setGeoModuleForTests({ version: 1, call: () => response(1) }); assert.deepEqual(booleanPath("union", shapes), booleanPathTs("union", shapes));
});
await test("explicit wasm mode exposes real empty result for differential testing", () => {
  globalThis.location = { search: "?geo=wasm" }; __setGeoModuleForTests({ version: 1, call: () => response(1) }); assert.equal(booleanPath("union", shapes), null); delete globalThis.location;
});
__resetGeoForTests();
console.log(`geoSafety: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
