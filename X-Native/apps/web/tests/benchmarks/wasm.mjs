// bench:wasm — differential + timing runner for the geo bridge (design §8/P3).
//
//   vite-node tests/benchmarks/wasm.mjs [--replay] [--module x_geo.wasm]
//                                         [--repeat 5] [--out report.json]
//
// --replay (default): replays the recorded fixtures through the full stack
//   (choke -> §5 encode -> module -> §5 decode -> shape -> §8 compare) with a
//   mock module serving the recorded contours. This validates the harness,
//   codec, comparator, and timing at scale; the "module" timing here is pure
//   harness overhead, NOT Rust speed.
// --module <path>: true differential — the TS authority vs a real x_geo.wasm
//   on all fixtures, plus the timing behind the §10 target (<=1.2ms/op).
//   Any wasm decline/fallback in this mode is a failure, not a fallback:
//   silent TS substitution would mask the breakage being hunted.
//
// Exit status is non-zero on any equivalence failure (CI-ready).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { booleanPath, booleanPathTs, hasCurveHandles, shapeBooleanResult } from "../../src/engine/geometry.ts";
import {
  __resetGeoForTests,
  __setGeoModuleForTests,
  compareBooleanResults,
  decodeGeoResponse,
  encodeGeoRequest,
  ensureGeo,
  tryGeoBoolean,
} from "../../src/engine/geoBridge.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : def;
};
const MODULE_PATH = flag("module", "");
const REPLAY = !MODULE_PATH || args.includes("--replay");
const FIXTURES = flag("fixtures", path.join(HERE, "../../src/engine/__tests__/geobridge.fixtures.json"));
const REPEAT = Math.max(1, Number(flag("repeat", "5")) || 5);
const OUT = flag("out", "");

const fx = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));

/** §5.2 bytes for a recorded result (replay mock + honesty check on decode). */
function encodeCannedResponse(result) {
  if (result === null) {
    const buf = new Uint8Array(52);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x58475231, true);
    dv.setUint32(4, 52, true);
    dv.setUint16(8, 1, true);
    dv.setUint8(10, 1);
    return buf;
  }
  const net = result.network;
  const loops = net?.regions?.[0]?.loops ?? [];
  const verts = net?.vertices ?? [];
  const contours = loops.length
    ? loops.map((l) => l.map((i) => ({ x: verts[i].x + result.x, y: verts[i].y + result.y })))
    : [result.path.map((p) => ({ x: p.x + result.x, y: p.y + result.y }))];
  let len = 52;
  for (const c of contours) len += 8 + c.length * 16;
  const buf = new Uint8Array(len);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x58475231, true);
  dv.setUint32(4, len, true);
  dv.setUint16(8, 1, true);
  dv.setUint8(10, 0);
  dv.setFloat64(12, result.x, true);
  dv.setFloat64(20, result.y, true);
  dv.setFloat64(28, result.w, true);
  dv.setFloat64(36, result.h, true);
  dv.setUint32(44, contours.length, true);
  let o = 52;
  for (const c of contours) {
    dv.setUint32(o, c.length, true);
    o += 8;
    for (const p of c) { dv.setFloat64(o, p.x, true); dv.setFloat64(o + 8, p.y, true); o += 16; }
  }
  return buf;
}

const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Self-check: the replay encoder must survive the real decoder.
for (const c of fx.cases) {
  const back = decodeGeoResponse(encodeCannedResponse(c.result));
  const wantContours = c.result === null ? 0 : (c.result.network?.regions?.[0]?.loops?.length ?? 1);
  if (back.contours.length !== wantContours) {
    console.error(`harness self-check failed on ${c.name}`);
    process.exit(2);
  }
}

let mod = null;
if (!REPLAY) {
  if (!fs.existsSync(MODULE_PATH)) { console.error(`no such module: ${MODULE_PATH}`); process.exit(2); }
  mod = await ensureGeo(fs.readFileSync(MODULE_PATH));
  if (!mod) { console.error("module failed to load/handshake (see warning above)"); process.exit(2); }
  console.log(`module: ${MODULE_PATH} (version ${mod.version})`);
} else {
  console.log("mode: replay (mock module serving recorded contours)");
}

// One untimed pass to warm JIT on both paths.
for (const c of fx.cases.slice(0, 3)) {
  booleanPathTs(c.op, c.shapes);
  __setGeoModuleForTests({ version: 1, call: () => encodeCannedResponse(c.result) });
  booleanPath(c.op, c.shapes);
}
__resetGeoForTests();
if (mod) __setGeoModuleForTests(mod);

const rows = [];
let fails = 0;
for (const c of fx.cases) {
  // Authority (live) vs fixture: guards against TS drift since recording.
  const live = booleanPathTs(c.op, c.shapes);
  const sanity = compareBooleanResults(live, c.result);
  // Module path, driven through the real choke.
  let expectedReq = null;
  if (REPLAY) {
    const canned = encodeCannedResponse(c.result);
    expectedReq = encodeGeoRequest(c.op, c.shapes);
    __setGeoModuleForTests({ version: 1, call: (req) => {
      if (!eqBytes(req, expectedReq)) throw new Error("choke request drifted from §5.1 encoding");
      return canned;
    } });
  }
  let via = null;
  let declined = "";
  try {
    via = booleanPath(c.op, c.shapes);
    if (!REPLAY) {
      // In module mode a decline is the finding, not a fallback.
      const direct = tryGeoBoolean(c.op, c.shapes);
      if (!direct || direct.status !== 0) declined = "wasm declined (status!=0), choke fell back to TS";
    }
  } catch (e) {
    declined = `threw: ${e.message}`;
  }
  // Replay expectation: the recorded (already shaped) contours through the
  // shaper once — shaping is not idempotent for degenerate 2-point rings, so
  // the fixture itself is the wrong yardstick here. (Module mode compares
  // against the fixture: real wasm returns raw contours, shaped once per side.)
  let expected = c.result;
  if (REPLAY && c.result) {
    const net = c.result.network;
    const loops = net?.regions?.[0]?.loops ?? [];
    const rings = loops.length
      ? loops.map((l) => l.map((i) => ({ x: net.vertices[i].x + c.result.x, y: net.vertices[i].y + c.result.y })))
      : [c.result.path.map((q) => ({ x: q.x + c.result.x, y: q.y + c.result.y }))];
    expected = shapeBooleanResult(c.op, rings, (Math.max(c.result.w, c.result.h) / 160) * 0.85,
      hasCurveHandles(c.shapes));
  }
  const diff = declined ? { ok: false, reasons: [declined] } : compareBooleanResults(via, expected);
  // Timing (means over repeats; equivalence already decided above).
  let tsMs = 0, modMs = 0;
  for (let i = 0; i < REPEAT; i++) {
    let t0 = performance.now();
    booleanPathTs(c.op, c.shapes);
    tsMs += performance.now() - t0;
    t0 = performance.now();
    booleanPath(c.op, c.shapes);
    modMs += performance.now() - t0;
  }
  const ok = sanity.ok && diff.ok;
  if (!ok) fails++;
  rows.push({ name: c.name, op: c.op, tsMs: tsMs / REPEAT, modMs: modMs / REPEAT,
              sanityOk: sanity.ok, diffOk: diff.ok,
              reasons: [...sanity.reasons, ...diff.reasons] });
  if (!ok) console.log(`FAIL ${c.name}: ${[...sanity.reasons, ...diff.reasons].join("; ")}`);
}

const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
console.log(`\n${REPLAY ? "replay" : "module"}: ${rows.length - fails}/${rows.length} equivalent ` +
  `(TS total ${sum("tsMs").toFixed(1)}ms, module-path total ${sum("modMs").toFixed(1)}ms, ` +
  `mean TS ${(sum("tsMs") / rows.length).toFixed(2)}ms/op)`);
if (REPLAY) console.log("note: replay module-path timing is harness overhead, not Rust speed.");
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ mode: REPLAY ? "replay" : "module", module: MODULE_PATH || null,
    repeat: REPEAT, fails, rows }, null, 1));
  console.log(`wrote ${OUT}`);
}
process.exit(fails ? 1 : 0);
