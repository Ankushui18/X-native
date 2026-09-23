/**
 * WebAssembly bridge interface connecting the Rust engine (crates/x-wasm)
 * with the TypeScript web product.
 *
 * Implements the architecture boundary described in docs/ARCHITECTURE_BOUNDARY.md:
 * when the WASM binary is present and loaded, format imports are processed
 * by the native Rust parsers; otherwise, it gracefully falls back to the
 * built-in pure TypeScript implementations.
 */

import { importFig as importFigTs } from "./figImport";
import { importSketch as importSketchTs } from "./sketchImport";
import { importSvg as importSvgTs, type ImportResult } from "./svgImport";

export interface EngineInfo {
  name: string;
  version: string;
  hasWasm: boolean;
}

interface WasmExports {
  importFigToX?: (bytes: Uint8Array) => string;
  importSketchToX?: (bytes: Uint8Array) => string;
  importSvgToX?: (text: string) => string;
  engineVersion?: () => string;
}

let wasmInstance: WasmExports | null = null;
let wasmAttempted = false;

export async function initWasmBridge(): Promise<boolean> {
  if (wasmAttempted) return wasmInstance !== null;
  wasmAttempted = true;
  try {
    if (typeof WebAssembly === "undefined") return false;
    // Attempt to fetch and compile x_wasm.wasm if exposed by the dev server or assets
    const resp = await fetch("/x_wasm.wasm").catch(() => null);
    if (!resp || !resp.ok) return false;
    const bytes = await resp.arrayBuffer();
    const module = await WebAssembly.instantiate(bytes, {});
    wasmInstance = module.instance.exports as WasmExports;
    return true;
  } catch {
    wasmInstance = null;
    return false;
  }
}

export function getEngineInfo(): EngineInfo {
  if (wasmInstance && wasmInstance.engineVersion) {
    try {
      return {
        name: "X-Native Engine (Rust WASM)",
        version: wasmInstance.engineVersion(),
        hasWasm: true,
      };
    } catch {
      // Fall through to TS
    }
  }
  return {
    name: "X-Native Engine (TypeScript)",
    version: "0.1.0-ts",
    hasWasm: false,
  };
}

export async function importFig(buf: ArrayBuffer): Promise<ImportResult> {
  if (wasmInstance?.importFigToX) {
    try {
      const bytes = new Uint8Array(buf);
      const res = JSON.parse(wasmInstance.importFigToX(bytes));
      if (res.ok && res.doc) {
        const page = res.doc.pages?.[0]?.root;
        return {
          nodes: page?.children ?? [],
          width: page?.w ?? 800,
          height: page?.h ?? 600,
          skipped: 0,
        };
      }
    } catch (e) {
      console.warn("WASM importFig failed, falling back to TS:", e);
    }
  }
  return importFigTs(buf);
}

export async function importSketch(buf: ArrayBuffer): Promise<ImportResult> {
  if (wasmInstance?.importSketchToX) {
    try {
      const bytes = new Uint8Array(buf);
      const res = JSON.parse(wasmInstance.importSketchToX(bytes));
      if (res.ok && res.doc) {
        const page = res.doc.pages?.[0]?.root;
        return {
          nodes: page?.children ?? [],
          width: page?.w ?? 800,
          height: page?.h ?? 600,
          skipped: 0,
        };
      }
    } catch (e) {
      console.warn("WASM importSketch failed, falling back to TS:", e);
    }
  }
  return importSketchTs(buf);
}

export function importSvg(text: string): ImportResult {
  if (wasmInstance?.importSvgToX) {
    try {
      const res = JSON.parse(wasmInstance.importSvgToX(text));
      if (res.ok && res.doc) {
        const page = res.doc.pages?.[0]?.root;
        return {
          nodes: page?.children ?? [],
          width: page?.w ?? 800,
          height: page?.h ?? 600,
          skipped: 0,
        };
      }
    } catch (e) {
      console.warn("WASM importSvg failed, falling back to TS:", e);
    }
  }
  return importSvgTs(text);
}
