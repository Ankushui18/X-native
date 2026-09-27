/** wasm-bindgen import boundary. The web engine remains TypeScript; this
 * module loads GENERATED JS glue, never casts raw wasm exports to JS functions.
 * Until native import equivalence is proven broadly, TS is the per-file oracle:
 * a converted native result is used only if it matches the TS result. */
import { importFig as importFigTs } from "./figImport";
import { importSketch as importSketchTs } from "./sketchImport";
import { importSvg as importSvgTs, type ImportResult, type ImportedNode } from "./svgImport";
import { wasmAssetUrl } from "./wasmAssets";
import { decodeRustImport } from "./wasmImportAdapter";
import { auditDecision, auditRustAsyncCall, auditRustCall, registerAuditProbe } from "./bridgeRuntimeAudit";

export const IMPORT_BRIDGE_VERSION = 1;
// V3 adds an atomic Boolean command and bounded structural layer deltas.
// Older bindgen classes cannot acknowledge a vector result or its undo safely.
export const SESSION_BRIDGE_VERSION = 3;
export const IMPORT_GLUE_URL = wasmAssetUrl("wasm/x_wasm.js");
/** wasm-bindgen owns this stateful instance; JS never mirrors its document or
 * undo stack. The only large payload is an explicit open/export of native .x. */
export interface WasmDocumentSession {
  state: () => string;
  getNode: (id: string) => string;
  renameNode: (id: string, name: string) => string;
  moveNode: (id: string, dx: number, dy: number) => string;
  resizeNode: (id: string, w: number, h: number) => string;
  booleanNode: (first: string, second: string, op: string) => string;
  undo: () => string;
  redo: () => string;
  exportX: () => string;
  free: () => void;
}
export interface WasmImportModule {
  default: () => Promise<unknown>;
  bridgeVersion: () => number;
  engineVersion: () => string;
  importFigToX: (bytes: Uint8Array) => string;
  importSketchToX: (bytes: Uint8Array) => string;
  importSvgToX: (text: string) => string;
  /** Optional independently versioned command/session slice. Older import
   * artifacts still work; they simply cannot open a Rust command session. */
  sessionBridgeVersion?: () => number;
  RustDocumentSession?: new (x: string) => WasmDocumentSession;
}
export interface EngineInfo {
  name: string;
  version: string;
  hasWasm: boolean;
  importBackend: "ts" | "wasm";
  importStatus: "idle" | "loading" | "ready" | "unavailable";
  lastImportFallback: string | null;
}
let loaded: WasmImportModule | null = null;
let loading: Promise<boolean> | null = null;
let status: EngineInfo["importStatus"] = "idle";
let backend: EngineInfo["importBackend"] = "ts";
let version = "0.1.0-ts";
let fallback: string | null = null;

registerAuditProbe("imports", {
  snapshot: () => ({
    assets: { glue: IMPORT_GLUE_URL, wasm: wasmAssetUrl("wasm/x_wasm_bg.wasm") },
    status: disabled() ? "disabled by imports=ts" : status,
    instantiated: !!loaded,
    version: loaded ? version : null,
    // Bindgen's JS exports are the callable interface. The raw .wasm is not a
    // separate editor engine; a loaded import module does NOT imply x-geo loaded.
    availableFunctions: loaded ? Object.keys(loaded).filter(k => typeof loaded![k as keyof WasmImportModule] === "function") : [],
    sessionExportPresent: !!loaded?.RustDocumentSession && typeof loaded?.sessionBridgeVersion === "function",
    // Presence alone is not admission; open also checks V2 ABI and whole-file parity.
    lastImportResult: backend, // last import, NOT the active editor owner
    lastFailureClass: status === "unavailable" ? "asset, initialization or ABI failure" :
      fallback ? /differs/.test(fallback) ? "equivalence mismatch" : "native import/decode declined" : null,
  }),
  load: () => initWasmBridge(),
});

function disabled(): boolean {
  try { return typeof location !== "undefined" && new URLSearchParams(location.search).get("imports") === "ts"; }
  catch { return false; }
}
async function loadGenerated(): Promise<WasmImportModule> {
  // Vite must leave this optional deployed asset outside its static module graph.
  const url = IMPORT_GLUE_URL;
  return import(/* @vite-ignore */ url);
}
export function initWasmBridge(load = loadGenerated): Promise<boolean> {
  if (disabled() || typeof WebAssembly === "undefined") return Promise.resolve(false);
  if (loading) return loading;
  status = "loading";
  loading = (async () => {
    try {
      const glue = await load();
      for (const key of ["default", "bridgeVersion", "engineVersion", "importFigToX", "importSketchToX", "importSvgToX"] as const) {
        if (typeof glue[key] !== "function") throw new Error(`Missing wasm-bindgen export: ${key}`);
      }
      await auditRustAsyncCall("x-wasm.init", () => glue.default());
      if (auditRustCall("x-wasm.bridgeVersion", () => glue.bridgeVersion()) !== IMPORT_BRIDGE_VERSION) throw new Error("Import bridge ABI version mismatch");
      const build = auditRustCall("x-wasm.engineVersion", () => glue.engineVersion());
      if (typeof build !== "string" || !build.startsWith("x-wasm ")) throw new Error("Invalid Rust build identifier");
      loaded = glue; version = build; status = "ready"; fallback = null;
      return true;
    } catch (e) {
      loaded = null; status = "unavailable";
      fallback = e instanceof Error ? e.message : String(e);
      return false;
    }
  })();
  return loading;
}

export function rustSessionConstructor(): WasmImportModule["RustDocumentSession"] {
  if (!loaded || typeof loaded.sessionBridgeVersion !== "function" || typeof loaded.RustDocumentSession !== "function") return undefined;
  try {
    return auditRustCall("x-wasm.sessionBridgeVersion", () => loaded!.sessionBridgeVersion!()) === SESSION_BRIDGE_VERSION
      ? loaded.RustDocumentSession : undefined;
  } catch {
    // A broken optional session export must not disable the import-only bridge.
    return undefined;
  }
}

export function getEngineInfo(): EngineInfo {
  return {
    name: loaded ? "X-Native Engine (TypeScript; Rust import bridge ready)" : "X-Native Engine (TypeScript)",
    version, hasWasm: !!loaded, importBackend: backend, importStatus: status, lastImportFallback: fallback,
  };
}

/** Compare the render/import contract, including every optional property in
 * either result. Defaults are expanded, not arbitrary properties discarded. */
export function importsEquivalent(a: ImportResult, b: ImportResult): boolean {
  const normalizeNode = (n: ImportedNode): unknown => canonical({
    hidden: false, locked: false, ...n,
    children: (n.children ?? []).map(normalizeNode),
  });
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v)
      .filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  }
  const norm = (r: ImportResult) => canonical({
    ...r, nodes: r.nodes.map(normalizeNode),
    pages: r.pages?.map((p) => ({ name: p.name, nodes: p.nodes.map(normalizeNode) })),
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
function choose(ts: ImportResult, native: () => string, format: "Fig" | "Sketch" | "Svg"): ImportResult {
  backend = "ts";
  if (!loaded || disabled()) {
    auditDecision({ bridge: "imports", operation: format, result: "ts", guard: "not-run",
      candidate: false, reason: disabled() ? "imports=ts" : "import module unavailable/not loaded" });
    return ts;
  }
  try {
    const candidate = decodeRustImport(auditRustCall(`x-wasm.import${format}ToX`, native));
    // SVG has an interchange root, not a named design page. Preserve the
    // existing importer's absence of page metadata; never discard extra pages.
    if (!ts.pages && candidate.pages?.length === 1) delete candidate.pages;
    if (!importsEquivalent(ts, candidate)) throw new Error("Native import differs from TypeScript; kept the complete TypeScript result");
    backend = "wasm"; fallback = null;
    auditDecision({ bridge: "imports", operation: format, result: "rust", guard: "passed",
      candidate: true, reason: "complete TS import equivalence passed" });
    return candidate;
  } catch (e) {
    fallback = e instanceof Error ? e.message : String(e);
    auditDecision({ bridge: "imports", operation: format, result: "ts", guard: "blocked", candidate: true,
      reason: /differs/.test(fallback) ? "complete TS import differs" :
        /Unsupported|Invalid|Missing|Unexpected/.test(fallback) ? "native schema/adapter cannot project losslessly" :
        "native import failed" });
    return ts;
  }
}
export async function importFig(buf: ArrayBuffer): Promise<ImportResult> {
  void initWasmBridge();
  return choose(await importFigTs(buf), () => loaded!.importFigToX(new Uint8Array(buf)), "Fig");
}
export async function importSketch(buf: ArrayBuffer): Promise<ImportResult> {
  void initWasmBridge();
  return choose(await importSketchTs(buf), () => loaded!.importSketchToX(new Uint8Array(buf)), "Sketch");
}
/** Existing canvas/clipboard callers are synchronous. Startup preload makes
 * wasm available when ready; the first early SVG import still works via TS. */
export function importSvg(text: string): ImportResult {
  void initWasmBridge();
  return choose(importSvgTs(text), () => loaded!.importSvgToX(text), "Svg");
}
export function __resetWasmForTests(): void {
  loaded = null; loading = null; status = "idle"; backend = "ts"; version = "0.1.0-ts"; fallback = null;
}
