/**
 * TypeScript side of the TS↔Rust geometry bridge (docs/GEO_BRIDGE_DESIGN_2026-09-25.md).
 *
 * The Rust module (`x_geo.wasm`, built from `crates/x-geo` in a Rust-capable
 * environment) is a candidate accelerator for `booleanPath`. Auto mode checks
 * its result against TS; unavailable/invalid/unequal results degrade to the
 * pure-TS implementation. Nothing here may ever throw past the choke point in
 * `geometry.ts`: the bridge is an accelerator, not a dependency.
 *
 * Lives apart from `wasmBridge.ts` deliberately: that module imports the file
 * importers (which import `geometry.ts`), so geometry calling into it would be
 * an import cycle. This module does not import document logic.
 */

import type { BooleanOp, PathPoint } from "./types";
import { wasmAssetUrl } from "./wasmAssets";

/* -------------------------------------------------------------------------- */
/* §5 wire format v1                                                           */
/* -------------------------------------------------------------------------- */

export const GEO_WASM_URL = wasmAssetUrl("x_geo.wasm");
export const GEO_VERSION = 1;
const REQ_MAGIC = 0x58474f31; // "XGO1"
const RESP_MAGIC = 0x58475231; // "XGR1"
const MAX_OPERANDS = 16;
const MAX_POINTS = 100_000;
const MAX_RESPONSE = 16 * 1024 * 1024;

const OP_CODE: Record<BooleanOp, number> = { union: 0, subtract: 1, intersect: 2, exclude: 3 };

export interface GeoShape {
  poly: PathPoint[];
  ox: number;
  oy: number;
}

export interface GeoContours {
  status: 0;
  x: number;
  y: number;
  w: number;
  h: number;
  contours: { x: number; y: number }[][];
}

/** Encode §5.1. Throws (caller falls back to TS) on limit breach. */
export function encodeGeoRequest(op: BooleanOp, shapes: GeoShape[]): Uint8Array {
  const code = OP_CODE[op];
  if (code === undefined) throw new Error(`geo: unknown op ${op}`);
  if (shapes.length > MAX_OPERANDS) throw new Error(`geo: ${shapes.length} operands exceeds ${MAX_OPERANDS}`);
  let total = 16;
  for (const s of shapes) {
    if (![s.ox, s.oy].every(Number.isFinite) || s.poly.some((p) =>
      ![p.x, p.y, p.ix ?? 0, p.iy ?? 0, p.ox ?? 0, p.oy ?? 0].every(Number.isFinite))) {
      throw new Error("geo: non-finite input");
    }
    if (s.poly.length > MAX_POINTS) throw new Error(`geo: operand exceeds ${MAX_POINTS} points`);
    total += 24 + s.poly.length * 56;
  }
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, REQ_MAGIC, true);
  dv.setUint32(4, total, true);
  dv.setUint16(8, GEO_VERSION, true);
  dv.setUint8(10, code);
  dv.setUint8(11, 0);
  dv.setUint32(12, shapes.length, true);
  let o = 16;
  for (const s of shapes) {
    dv.setFloat64(o, s.ox, true);
    dv.setFloat64(o + 8, s.oy, true);
    dv.setUint32(o + 16, s.poly.length, true);
    dv.setUint32(o + 20, 0, true);
    o += 24;
    for (const p of s.poly) {
      dv.setFloat64(o, p.x, true);
      dv.setFloat64(o + 8, p.y, true);
      dv.setFloat64(o + 16, p.ix ?? 0, true);
      dv.setFloat64(o + 24, p.iy ?? 0, true);
      dv.setFloat64(o + 32, p.ox ?? 0, true);
      dv.setFloat64(o + 40, p.oy ?? 0, true);
      const hasIn = (p.ix !== undefined && p.ix !== 0) || (p.iy !== undefined && p.iy !== 0);
      const hasOut = (p.ox !== undefined && p.ox !== 0) || (p.oy !== undefined && p.oy !== 0);
      dv.setUint32(o + 48, (hasIn ? 1 : 0) | (hasOut ? 2 : 0), true);
      dv.setUint32(o + 52, 0, true);
      o += 56;
    }
  }
  return buf;
}

/** Decode §5.2. Status 1 (empty) yields no contours; status 2 throws Error(message). */
export function decodeGeoResponse(buf: Uint8Array): GeoContours {
  const need = (n: number) => {
    if (buf.length < n) throw new Error(`geo: truncated response (${buf.length} < ${n})`);
  };
  need(52);
  if (buf.length > MAX_RESPONSE) throw new Error("geo: response too large");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== RESP_MAGIC) throw new Error("geo: bad response magic");
  if (dv.getUint16(8, true) !== GEO_VERSION) throw new Error("geo: response version mismatch");
  if (dv.getUint32(4, true) !== buf.length) throw new Error("geo: response length mismatch");
  if (dv.getUint8(11) !== 0 || dv.getUint32(48, true) !== 0) throw new Error("geo: nonzero reserved field");
  const status = dv.getUint8(10);
  if (status === 2) {
    need(60);
    const mlen = dv.getUint32(52, true);
    if (60 + mlen !== buf.length || dv.getUint32(56, true) !== 0) throw new Error("geo: invalid error length");
    need(60 + mlen);
    const msg = new TextDecoder().decode(buf.subarray(60, 60 + mlen));
    throw new Error(`geo: wasm error: ${msg}`);
  }
  if (status !== 0 && status !== 1) throw new Error(`geo: unknown status ${status}`);
  const out: GeoContours = {
    status: 0,
    x: dv.getFloat64(12, true),
    y: dv.getFloat64(20, true),
    w: dv.getFloat64(28, true),
    h: dv.getFloat64(36, true),
    contours: [],
  };
  if (![out.x, out.y, out.w, out.h].every(Number.isFinite) || out.w < 0 || out.h < 0) throw new Error("geo: invalid bounds");
  if (status === 1) {
    if (buf.length !== 52 || dv.getUint32(44, true) !== 0) throw new Error("geo: invalid empty response");
    return out;
  }
  const n = dv.getUint32(44, true);
  let o = 52;
  for (let c = 0; c < n; c++) {
    need(o + 8);
    const np = dv.getUint32(o, true);
    if (dv.getUint32(o + 4, true) !== 0) throw new Error("geo: invalid contour header");
    o += 8;
    need(o + np * 16);
    const ring: { x: number; y: number }[] = [];
    for (let i = 0; i < np; i++, o += 16) {
      const x = dv.getFloat64(o, true), y = dv.getFloat64(o + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("geo: non-finite point");
      ring.push({ x, y });
    }
    out.contours.push(ring);
  }
  if (o !== buf.length || n === 0) throw new Error("geo: trailing bytes or missing contours");
  return out;
}

/* -------------------------------------------------------------------------- */
/* mode + loader                                                               */
/* -------------------------------------------------------------------------- */

export type GeoMode = "auto" | "ts" | "wasm";

/** `?geo=` beats the stored override beats the default. Node-safe (no window). */
export function getGeoMode(): GeoMode {
  try {
    const loc =
      typeof window !== "undefined" ? window.location : typeof location !== "undefined" ? location : null;
    const q = loc?.search ? new URLSearchParams(loc.search).get("geo") : null;
    if (q === "ts" || q === "wasm" || q === "auto") return q;
    const stored =
      typeof localStorage !== "undefined" ? localStorage.getItem("x-native-geo") : null;
    if (stored === "ts" || stored === "wasm" || stored === "auto") return stored;
  } catch {
    /* storage/URL accessors can throw in locked-down contexts; default out */
  }
  return "auto";
}

export interface GeoModule {
  readonly version: number;
  /** Synchronous §5 round trip. Throws on any anomaly (caller falls back). */
  call(req: Uint8Array): Uint8Array;
}

interface GeoWasmExports {
  memory: WebAssembly.Memory;
  xgeo_version: () => number;
  xgeo_alloc: (len: number) => number;
  xgeo_free: (ptr: number, len: number) => void;
  xgeo_boolean: (req: number, reqLen: number, outPtr: number, outLen: number) => number;
}

export function wrapGeoExports(e: GeoWasmExports): GeoModule {
  // Views are re-acquired around every call: allocator growth detaches them.
  const view8 = () => new Uint8Array(e.memory.buffer);
  const viewDV = () => new DataView(e.memory.buffer);
  return {
    version: e.xgeo_version(),
    call(req: Uint8Array): Uint8Array {
      let reqPtr = 0, outPtr = 0, rPtr = 0, rLen = 0;
      const valid = (ptr: number, len: number) => Number.isInteger(ptr) && ptr > 0 &&
        Number.isInteger(len) && len > 0 && ptr + len <= e.memory.buffer.byteLength;
      try {
        reqPtr = e.xgeo_alloc(req.length) >>> 0;
        if (!valid(reqPtr, req.length)) throw new Error("geo: request allocation failed");
        view8().set(req, reqPtr);
        outPtr = e.xgeo_alloc(8) >>> 0;
        if (!valid(outPtr, 8)) throw new Error("geo: output allocation failed");
        view8().fill(0, outPtr, outPtr + 8);
        const rc = e.xgeo_boolean(reqPtr, req.length, outPtr, outPtr + 4);
        const dv = viewDV();
        rPtr = dv.getUint32(outPtr, true);
        rLen = dv.getUint32(outPtr + 4, true);
        if (![0, 1, 2].includes(rc)) throw new Error(`geo: call failed (${rc})`);
        if (rLen > MAX_RESPONSE || !valid(rPtr, rLen)) {
          throw new Error(`geo: response out of bounds (ptr=${rPtr} len=${rLen})`);
        }
        return view8().slice(rPtr, rPtr + rLen);
      } finally {
        // Try every free even when a faulty module traps during cleanup.
        try { if (rPtr && rPtr !== reqPtr && rPtr !== outPtr) e.xgeo_free(rPtr, rLen); }
        finally {
          try { if (reqPtr) e.xgeo_free(reqPtr, req.length); }
          finally { if (outPtr && outPtr !== reqPtr) e.xgeo_free(outPtr, 8); }
        }
      }
    },
  };
}

let cached: GeoModule | null = null;
let pending: Promise<GeoModule | null> | null = null;
let warned = false;

/** Loud in `wasm` mode (a debugging flag), once-per-session otherwise. */
function geoWarn(e: unknown): void {
  if (getGeoMode() === "wasm") {
    console.warn("geo bridge fallback to TS:", e);
    return;
  }
  if (!warned) {
    warned = true;
    console.warn("geo bridge unavailable, using TS booleans:", e);
  }
}

/**
 * Load and handshake the module (memoized). `source` overrides the fetch, so
 * tests can pass bytes; `null` result means "use TS" and is never an error.
 */
export function ensureGeo(source?: string | ArrayBuffer | Uint8Array): Promise<GeoModule | null> {
  if (getGeoMode() === "ts" || typeof WebAssembly === "undefined") return Promise.resolve(null);
  if (pending) return pending;
  pending = (async () => {
  try {
    let bytes: ArrayBuffer;
    if (typeof source === "string" || source === undefined) {
      const resp = await fetch(source ?? GEO_WASM_URL).catch(() => null);
      if (!resp || !resp.ok) return null;
      bytes = await resp.arrayBuffer();
    } else if (source instanceof Uint8Array) {
      bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    } else {
      bytes = source;
    }
    const mod = await WebAssembly.instantiate(bytes, {});
    const exp = mod.instance.exports as Partial<GeoWasmExports>;
    if (
      !(exp.memory instanceof WebAssembly.Memory) ||
      typeof exp.xgeo_version !== "function" ||
      typeof exp.xgeo_alloc !== "function" ||
      typeof exp.xgeo_free !== "function" ||
      typeof exp.xgeo_boolean !== "function"
    ) {
      return null;
    }
    const wrapped = wrapGeoExports(exp as GeoWasmExports);
    if (wrapped.version !== GEO_VERSION) {
      geoWarn(`version mismatch (wasm=${wrapped.version} ts=${GEO_VERSION})`);
      return null;
    }
    cached = wrapped;
    return cached;
  } catch (e) {
    geoWarn(e);
    cached = null;
    return null;
  }
  })();
  return pending;
}

/** Fire-and-forget preload for app idle. Never throws, never blocks. */
export function preloadGeo(): void {
  try {
    const idle =
      typeof requestIdleCallback !== "undefined"
        ? requestIdleCallback
        : (fn: () => void) => setTimeout(fn, 2000);
    idle(() => {
      void ensureGeo();
    });
  } catch {
    /* scheduler itself failed; the choke still falls back per call */
  }
}

/**
 * Synchronous attempt used by the `booleanPath` choke: null when the module
 * is absent (not yet loaded, disabled, or failed) so the caller falls back.
 * Throws only for malformed traffic (bad encode/decode), which also falls back.
 */
export function tryGeoBoolean(op: BooleanOp, shapes: GeoShape[]): GeoContours | null {
  if (getGeoMode() === "ts" || !cached) return null;
  const raw = cached.call(encodeGeoRequest(op, shapes));
  return decodeGeoResponse(raw);
}

/* Test seams (nothing outside __tests__ touches these). */
export function __setGeoModuleForTests(mod: GeoModule | null): void {
  cached = mod;
  pending = Promise.resolve(mod);
}
export function __resetGeoForTests(): void {
  cached = null;
  pending = null;
  warned = false;
}
export function notifyGeoFallback(e: unknown): void {
  geoWarn(e);
}

/* -------------------------------------------------------------------------- */
/* §8 equivalence comparator (differential oracle)                             */
/* -------------------------------------------------------------------------- */

/** Structural view of a `booleanPath` result; both backends shape through
 *  `shapeBooleanResult`, so this is what either side yields. */
export interface BooleanShapeResult {
  path: { x: number; y: number }[];
  x: number;
  y: number;
  w: number;
  h: number;
  network?: {
    vertices: { x: number; y: number }[];
    regions?: { loops: number[][] }[];
  };
}

export interface EquivalenceReport {
  ok: boolean;
  reasons: string[];
}

const BBOX_EPS = 1e-6;
const AREA_FRAC = 0.005;

function ringArea(pts: { x: number; y: number }[]): number {
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    acc += p.x * q.y - q.x * p.y;
  }
  return Math.abs(acc) / 2;
}

/** Sum of absolute loop areas. Holes count positive: both backends emit the
 *  same loop structure through the shared shaper, so this is a comparator
 *  metric, not a rendering rule. */
function totalArea(r: BooleanShapeResult): number {
  const net = r.network;
  const loops = net?.regions?.[0]?.loops;
  if (net && loops?.length) {
    return loops.reduce((acc, loop) => {
      const pts = loop.map((i) => net.vertices[i]).filter((p) => !!p);
      return acc + (pts.length >= 3 ? ringArea(pts) : 0);
    }, 0);
  }
  return ringArea(r.path);
}

function contourCount(r: BooleanShapeResult): number {
  const loops = r.network?.regions?.[0]?.loops;
  return loops?.length ?? (r.path.length ? 1 : 0);
}

/**
 * Geometric equivalence per design §8: exact emptiness agreement, equal
 * contour counts, bbox within 1e-6 relative, symmetric area difference under
 * 0.5% of the larger area (a stricter proxy for union area — §8 note).
 * Collects every violation instead of short-circuiting, for diagnostics.
 */
export function compareBooleanResults(
  a: BooleanShapeResult | null,
  b: BooleanShapeResult | null,
): EquivalenceReport {
  const reasons: string[] = [];
  if (a === null || b === null) {
    if ((a === null) !== (b === null)) reasons.push("emptiness: one side is null");
    return { ok: reasons.length === 0, reasons };
  }
  const ca = contourCount(a);
  const cb = contourCount(b);
  if (ca !== cb) reasons.push(`contours: ${ca} vs ${cb}`);
  for (const k of ["x", "y", "w", "h"] as const) {
    const av = a[k];
    const bv = b[k];
    const tol = BBOX_EPS * Math.max(1, Math.abs(av), Math.abs(bv));
    if (!(Math.abs(av - bv) <= tol)) reasons.push(`bbox.${k}: ${av} vs ${bv}`);
  }
  const A = totalArea(a);
  const B = totalArea(b);
  const denom = Math.max(A, B);
  if (denom >= 1e-9 && Math.abs(A - B) / denom > AREA_FRAC) {
    reasons.push(`area: ${A} vs ${B}`);
  }
  return { ok: reasons.length === 0, reasons };
}
