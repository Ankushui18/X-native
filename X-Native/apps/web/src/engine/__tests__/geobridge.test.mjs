/**
 * Headless checks for the TS side of the geo bridge (docs/GEO_BRIDGE_DESIGN_2026-09-25.md).
 *
 * Run with:  npx vite-node src/engine/__tests__/geobridge.test.mjs
 *
 * The real Rust module cannot be built in this sandbox, so the wasm side is
 * verified two ways: JS mocks implementing the GeoModule interface (protocol
 * errors, fallback), and hand-assembled real WebAssembly modules (loader,
 * version handshake, and a full §5 round trip through a real linear memory —
 * only the boolean math itself is stubbed).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { booleanPath, booleanPathTs, shapeBooleanResult } from "../geometry.ts";
import { CORPUS } from "./geobridgeCorpus.ts";
import {
  GEO_VERSION,
  compareBooleanResults,
  __resetGeoForTests,
  __setGeoModuleForTests,
  decodeGeoResponse,
  encodeGeoRequest,
  ensureGeo,
  getGeoMode,
  tryGeoBoolean,
} from "../geoBridge.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const shapes2 = () => [
  { poly: rect(0, 0, 10, 10), ox: 0, oy: 0 },
  { poly: rect(5, 5, 10, 10), ox: 0, oy: 0 },
];

/* -------------------------------------------------------------------------- */
/* §5.1 request encoding (exact bytes — the future Rust side reads these)      */
/* -------------------------------------------------------------------------- */
{
  const req = encodeGeoRequest("subtract", shapes2());
  const dv = new DataView(req.buffer);
  t("request magic XGO1", dv.getUint32(0, true) === 0x58474f31);
  t("request total_len matches", dv.getUint32(4, true) === req.length);
  t("request version 1", dv.getUint16(8, true) === 1);
  t("request op subtract=1", dv.getUint8(10) === 1);
  t("request 2 operands", dv.getUint32(12, true) === 2);
  t("request size 16+2*(24+4*56)", req.length === 16 + 2 * (24 + 4 * 56));
  t("operand 0 ox/oy", dv.getFloat64(16, true) === 0 && dv.getFloat64(24, true) === 0);
  t("operand 0 has 4 points", dv.getUint32(32, true) === 4);
  t("point 2 is (10,10)", dv.getFloat64(40 + 2 * 56, true) === 10 && dv.getFloat64(48 + 2 * 56, true) === 10);
  t("plain points carry no handle flags", dv.getUint32(40 + 48, true) === 0);
  t("union=0", new DataView(encodeGeoRequest("union", shapes2()).buffer).getUint8(10) === 0);
  t("intersect=2", new DataView(encodeGeoRequest("intersect", shapes2()).buffer).getUint8(10) === 2);
  t("exclude=3", new DataView(encodeGeoRequest("exclude", shapes2()).buffer).getUint8(10) === 3);
}
{
  const s = [{ poly: [{ x: 1, y: 2, ix: 3, iy: 0 }, { x: 4, y: 5, ox: 0, oy: -2 }], ox: 0, oy: 0 },
             { poly: [{ x: 0, y: 0 }], ox: 0, oy: 0 }];
  const dv = new DataView(encodeGeoRequest("union", s).buffer);
  t("in-handle flag bit0", dv.getUint32(40 + 48, true) === 1);
  t("out-handle flag bit1", dv.getUint32(40 + 56 + 48, true) === 2);
  t("handle values carried", dv.getFloat64(40 + 16, true) === 3 && dv.getFloat64(40 + 56 + 40, true) === -2);
}
{
  let threw = "";
  try { encodeGeoRequest("union", new Array(17).fill({ poly: [], ox: 0, oy: 0 })); } catch (e) { threw = e.message; }
  t("17 operands rejected", /exceeds 16/.test(threw));
  threw = "";
  try { encodeGeoRequest("union", [{ poly: new Array(100001).fill({ x: 0, y: 0 }), ox: 0, oy: 0 }, { poly: [], ox: 0, oy: 0 }]); } catch (e) { threw = e.message; }
  t("100001 points rejected", /exceeds 100000/.test(threw));
}

/* -------------------------------------------------------------------------- */
/* §5.2 response decoding                                                      */
/* -------------------------------------------------------------------------- */
function cannedResponse(status, msg = "") {
  const tri = [0, 0, 30, 0, 0, 40];
  const bodyLen = status === 2 ? 8 + msg.length : status === 1 ? 0 : 8 + tri.length * 8;
  const buf = new Uint8Array(52 + bodyLen);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x58475231, true);
  dv.setUint32(4, buf.length, true);
  dv.setUint16(8, 1, true);
  dv.setUint8(10, status);
  dv.setFloat64(12, 0, true); dv.setFloat64(20, 0, true);
  dv.setFloat64(28, 30, true); dv.setFloat64(36, 40, true);
  if (status === 2) {
    dv.setUint32(52, msg.length, true);
    buf.set(new TextEncoder().encode(msg), 60);
  } else {
    dv.setUint32(44, status === 0 ? 1 : 0, true);
    let o = 52 + 8;
    if (status === 0) {
      dv.setUint32(52, 3, true);
      for (const v of tri) { dv.setFloat64(o, v, true); o += 8; }
    }
  }
  return buf;
}
{
  const r = decodeGeoResponse(cannedResponse(0));
  t("status-0 bbox", r.x === 0 && r.y === 0 && r.w === 30 && r.h === 40);
  t("status-0 one triangle", r.contours.length === 1 && r.contours[0].length === 3 &&
    eq(r.contours[0][2], { x: 0, y: 40 }));
  const e = decodeGeoResponse(cannedResponse(1));
  t("status-1 empty, bbox kept", e.contours.length === 0 && e.w === 30);
  let threw = "";
  try { decodeGeoResponse(cannedResponse(2, "boom")); } catch (e2) { threw = e2.message; }
  t("status-2 throws message", threw === "geo: wasm error: boom");
  const bad = cannedResponse(0);
  new DataView(bad.buffer).setUint32(0, 0xdead, true);
  threw = "";
  try { decodeGeoResponse(bad); } catch (e2) { threw = e2.message; }
  t("bad magic rejected", /bad response magic/.test(threw));
  threw = "";
  try { decodeGeoResponse(cannedResponse(0).subarray(0, 40)); } catch (e2) { threw = e2.message; }
  t("truncation rejected", /truncated/.test(threw));
}

/* -------------------------------------------------------------------------- */
/* mode flag                                                                   */
/* -------------------------------------------------------------------------- */
{
  const rw = globalThis.window, rl = globalThis.localStorage;
  delete globalThis.window;
  try { delete globalThis.localStorage; } catch {}
  t("node default is auto", getGeoMode() === "auto");
  globalThis.window = { location: { search: "?geo=ts" } };
  t("?geo=ts", getGeoMode() === "ts");
  globalThis.window = { location: { search: "?geo=bogus" } };
  t("?geo=bogus falls to auto", getGeoMode() === "auto");
  globalThis.window = { location: { search: "?geo=audit" } };
  t("?geo=audit enables diagnostic oracle", getGeoMode() === "audit");
  globalThis.window = { location: { search: "" } };
  globalThis.localStorage = { getItem: () => "wasm" };
  t("stored override", getGeoMode() === "wasm");
  globalThis.window = { location: { search: "?geo=ts" } };
  t("query beats stored", getGeoMode() === "ts");
  if (rw === undefined) delete globalThis.window; else globalThis.window = rw;
  if (rl === undefined) { try { delete globalThis.localStorage; } catch {} } else globalThis.localStorage = rl;
}

/* -------------------------------------------------------------------------- */
/* loader against REAL hand-assembled wasm                                     */
/* -------------------------------------------------------------------------- */
const lebU = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
// i32.const immediates are *signed* LEB128: bare 0x6c would decode as -20, not 108.
const lebS = (n) => { const b = []; let more = true; while (more) { let x = n & 0x7f; n >>= 7; const s = x & 0x40; if ((n === 0 && !s) || (n === -1 && s)) more = false; else x |= 0x80; b.push(x); } return b; };
const sec = (id, c) => [id, ...lebU(c.length), ...c];
const str = (s) => [...lebU(s.length), ...[...s].map((c) => c.charCodeAt(0))];

/** Minimal x-geo ABI: version const + bump allocator + boolean stub serving a
 *  canned §5.2 response from a data segment. Hand-encoded wasm MVP, no imports. */
function assembleGeoModule({ versionConst = 1, response }) {
  const dataOff = 1024;
  const types = [0x04,
    0x60, 0x00, 0x01, 0x7f,
    0x60, 0x01, 0x7f, 0x01, 0x7f,
    0x60, 0x02, 0x7f, 0x7f, 0x00,
    0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f];
  const body = (b) => [...lebU(b.length), ...b];
  const codes = [0x04,
    ...body([0x00, 0x41, ...lebS(versionConst), 0x0b]),
    ...body([0x00, 0x23, 0x00, 0x23, 0x00, 0x20, 0x00, 0x6a, 0x24, 0x00, 0x0b]),
    ...body([0x00, 0x0b]),
    ...body([0x00, 0x20, 0x02, 0x41, ...lebS(dataOff), 0x36, 0x02, 0x00,
             0x20, 0x03, 0x41, ...lebS(response.length), 0x36, 0x02, 0x00, 0x41, 0x00, 0x0b])];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sec(0x01, types),
    ...sec(0x03, [0x04, 0x00, 0x01, 0x02, 0x03]),
    ...sec(0x05, [0x01, 0x00, 0x01]),
    ...sec(0x06, [0x01, 0x7f, 0x01, 0x41, ...lebS(2048), 0x0b]),
    ...sec(0x07, [0x05,
      ...str("memory"), 0x02, 0x00,
      ...str("xgeo_version"), 0x00, 0x00,
      ...str("xgeo_alloc"), 0x00, 0x01,
      ...str("xgeo_free"), 0x00, 0x02,
      ...str("xgeo_boolean"), 0x00, 0x03]),
    ...sec(0x0a, codes),
    ...sec(0x0b, [0x01, 0x00, 0x41, ...lebS(dataOff), 0x0b, ...lebU(response.length), ...response]),
  ];
  return new Uint8Array(bytes);
}

const stubResp = cannedResponse(0);
const stubMod = assembleGeoModule({ response: stubResp });
t("stub module validates", WebAssembly.validate(stubMod));
__resetGeoForTests();
t("real wasm loads, version 1", (await ensureGeo(stubMod))?.version === 1);
{
  const raw = tryGeoBoolean("union", shapes2());
  t("§5 round trip through real linear memory",
    !!raw && raw.status === 0 && raw.contours.length === 1 && eq(raw.contours[0][1], { x: 30, y: 0 }));
}
{
  // Boolean no longer routes through the native raster module in any mode.
  const priorLocation = globalThis.location;
  globalThis.location = { search: "?geo=wasm" };
  let called = false;
  __setGeoModuleForTests({ version: 1, call: () => { called = true; return stubResp; } });
  const via = booleanPath("union", shapes2());
  t("?geo=wasm no longer consults the native raster module", !called);
  t("boolean result is the exact union (no raster noise)", !!via && via.w === 15 && via.h === 15 && via.path.length === 8);
  if (priorLocation === undefined) delete globalThis.location; else globalThis.location = priorLocation;
  __resetGeoForTests();
}
__resetGeoForTests();
t("version-0 module rejected", (await ensureGeo(assembleGeoModule({ versionConst: 0, response: stubResp }))) === null);
__resetGeoForTests();
t("garbage bytes rejected", (await ensureGeo(new Uint8Array([0, 1, 2, 3]))) === null);
__resetGeoForTests();
t("relative fetch in node degrades to null", (await ensureGeo()) === null);

/* -------------------------------------------------------------------------- */
/* JS-mock protocol errors + choke fallback                                    */
/* -------------------------------------------------------------------------- */
{
  let seen = null;
  __setGeoModuleForTests({ version: 1, call: (req) => { seen = req; return stubResp; } });
  tryGeoBoolean("exclude", shapes2());
  const dv = new DataView(seen.buffer);
  t("mock saw op exclude=3", dv.getUint8(10) === 3);
  t("mock saw 2 operands", dv.getUint32(12, true) === 2);
  __resetGeoForTests();
}
{
  // The exact engine is the contract: a loaded module — agreeing, disagreeing,
  // trapping, or reporting an error — cannot change the result.
  const exact = booleanPath("union", shapes2());
  const exactSub = booleanPath("subtract", shapes2());
  for (const [label, mod] of [
    ["disagreeing module", { version: 1, call: () => stubResp }],
    ["trapping module", { version: 1, call: () => { throw new Error("trap"); } }],
    ["false-empty module", { version: 1, call: () => cannedResponse(1) }],
    ["wasm-error module", { version: 1, call: () => cannedResponse(2, "nope") }],
  ]) {
    let called = false;
    __setGeoModuleForTests({ version: 1, call: (r) => { called = true; return mod.call(r); } });
    t(`${label}: never called, result unchanged`,
      !called && eq(booleanPath("union", shapes2()), exact) && eq(booleanPath("subtract", shapes2()), exactSub));
    __resetGeoForTests();
  }
  const priorLocation = globalThis.location;
  for (const mode of ["?geo=audit", "?geo=ts", "?geo=wasm"]) {
    globalThis.location = { search: mode };
    t(`${mode}: same exact result`, eq(booleanPath("union", shapes2()), exact));
  }
  if (priorLocation === undefined) delete globalThis.location; else globalThis.location = priorLocation;
}
{
  t("union of two 10x10 squares offset by 5 is exactly 15x15", (() => { const r = booleanPath("union", shapes2()); return r.x === 0 && r.y === 0 && r.w === 15 && r.h === 15; })());
  t("subtract keeps outer frame and adds a hole", (() => { const r = booleanPath("subtract", [{ poly: rect(0, 0, 100, 100), ox: 0, oy: 0 }, { poly: rect(25, 25, 50, 50), ox: 0, oy: 0 }]); return r.w === 100 && r.network.regions[0].loops.length === 2; })());
  t("fewer than 2 shapes -> null", booleanPath("union", shapes2().slice(0, 1)) === null);
  t("disjoint intersect -> null", booleanPath("intersect", [{ poly: rect(0, 0, 10, 10), ox: 0, oy: 0 }, { poly: rect(50, 50, 10, 10), ox: 0, oy: 0 }]) === null);
}

/* -------------------------------------------------------------------------- */
/* TS authority sanity (extracted shaper must preserve behavior)               */
/* -------------------------------------------------------------------------- */
{
  const u = booleanPathTs("union", shapes2());
  t("TS union non-null with network", !!u && !!u.network && u.network.vertices.length > 0);
  t("TS union bbox sane", !!u && u.w > 14 && u.w < 16 && u.h > 14 && u.h < 16 &&
    Math.abs(u.x) < 0.5 && Math.abs(u.y) < 0.5);
  const s = booleanPathTs("subtract", shapes2());
  t("TS subtract non-null", !!s && s.w >= 1 && s.h >= 1);
  t("TS short input null", booleanPathTs("union", shapes2().slice(0, 1)) === null);
}

/* -------------------------------------------------------------------------- */
/* §8 comparator units                                                             */
/* -------------------------------------------------------------------------- */
{
  const u = booleanPathTs("union", shapes2());
  const r = compareBooleanResults(u, JSON.parse(JSON.stringify(u)));
  t("identical results equivalent", r.ok && r.reasons.length === 0);
  const nudge = { ...u, w: u.w * (1 + 1e-9) };
  t("1e-9 bbox nudge passes", compareBooleanResults(u, nudge).ok);
  const off = { ...u, w: u.w * 1.001 };
  const offR = compareBooleanResults(u, off);
  t("1e-3 bbox shift fails with reason", !offR.ok && offR.reasons.some((x) => x.startsWith("bbox.w")));
  const diamond = { path: [{ x: 0, y: 5 }, { x: 5, y: 10 }, { x: 10, y: 5 }, { x: 5, y: 0 }], x: 0, y: 0, w: 10, h: 10 };
  const square = { path: rect(0, 0, 10, 10), x: 0, y: 0, w: 10, h: 10 };
  const areaR = compareBooleanResults(square, diamond);
  t("same bbox, half area fails on area", !areaR.ok && areaR.reasons.some((x) => x.startsWith("area")));
  const empty = { path: [], x: 0, y: 0, w: 1, h: 1 };
  t("degenerate zero-area pair passes", compareBooleanResults(empty, { ...empty }).ok);
  t("empty vs non-empty fails", !compareBooleanResults(null, u).ok);
  t("null vs null passes", compareBooleanResults(null, null).ok);
}

/* -------------------------------------------------------------------------- */
/* fixtures: recorded oracle reproduces exactly                                */
/* -------------------------------------------------------------------------- */
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, "geobridge.fixtures.json"), "utf8"));
  t("fixtures version 1", fx.version === 1);
  t("fixture count matches corpus", fx.count === CORPUS.length && fx.cases.length === CORPUS.length);
  t("fixture names match corpus", eq(fx.cases.map((c) => c.name), CORPUS.map((c) => c.name)));
  const byName = Object.fromEntries(fx.cases.map((c) => [c.name, c]));
  for (const c of CORPUS) {
    const live = booleanPathTs(c.op, c.shapes);
    const rep = compareBooleanResults(live, byName[c.name].result);
    t(`fixture ${c.name} reproduces`, rep.ok);
    if (!rep.ok) console.log(`    reasons: ${rep.reasons.join("; ")}`);
  }
  const disjoint = byName["disjoint-union"].result;
  const oneLoop = { ...disjoint, network: { vertices: disjoint.network.vertices, regions: [{ loops: [disjoint.network.regions[0].loops[0]] }] } };
  const countR = compareBooleanResults(disjoint, oneLoop);
  t("loop-count mismatch fails", !countR.ok && countR.reasons.some((x) => x.startsWith("contours")));
}

console.log(`\ngeobridge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
