/**
 * Phase 9: WASM-backed export pipeline.
 *
 * Replaces the lossy canvas.toDataURL path for PNG/JPG exports with the
 * Rust render pipeline (x-render/raster.rs: tiny-skia, deterministic, no GPU).
 * Falls back gracefully when the Rust bridge is unavailable.
 *
 * The export works by opening a short-lived RustDocumentSession with the
 * serialized document, exporting the target node, and closing the session.
 * This is stateless w.r.t. the editor — no mutation, no undo impact.
 */
import { initWasmBridge, rustSessionConstructor } from "./wasmBridge";
import { auditRustCall } from "./bridgeRuntimeAudit";

export interface WasmExportResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  format: "png" | "jpg" | "pdf";
}

/**
 * Attempt to export a node via the Rust render pipeline.
 * Returns null when the WASM bridge is not available or the export fails,
 * so the caller can fall back to the canvas-based path.
 *
 * @param xDocument - The serialized .x document string (from save_x/exportX)
 * @param nodeId - The ID of the node to export
 * @param format - "png", "jpg", or "pdf"
 * @param scale - Scale factor (1x, 2x, 3x, etc.)
 */
export async function wasmExportNode(
  xDocument: string,
  nodeId: string,
  format: "png" | "jpg" | "pdf",
  scale: number,
): Promise<WasmExportResult | null> {
  if (!(await initWasmBridge())) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  let session: ReturnType<typeof auditRustCall> | null = null;
  try {
    session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as InstanceType<NonNullable<ReturnType<typeof rustSessionConstructor>>>;

    const binding = session as unknown as {
      exportNode?: (id: string, format: string, scale: number) => string;
      free: () => void;
    };

    if (!binding.exportNode) {
      session.free();
      return null;
    }

    const raw = auditRustCall(
      "x-wasm.RustDocumentSession.exportNode",
      () => binding.exportNode!(nodeId, format, scale),
    );
    const result = JSON.parse(raw) as {
      ok: boolean;
      bytes?: string;
      width?: number;
      height?: number;
      format?: string;
      error?: string;
    };

    session.free();

    if (!result.ok || !result.bytes) return null;

    const binaryStr = atob(result.bytes);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    return {
      bytes,
      width: result.width ?? 0,
      height: result.height ?? 0,
      format: (result.format ?? format) as "png" | "jpg" | "pdf",
    };
  } catch {
    try {
      (session as { free?: () => void } | null)?.free?.();
    } catch { /* best-effort cleanup */ }
    return null;
  }
}
