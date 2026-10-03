/**
 * Phase 10: WASM-backed drawing tool finalization.
 *
 * Routes pen commit, pencil smoothing, and eraser geometry splitting through
 * the Rust pipeline. Points are collected in TS during the drag (60fps), then
 * a single WASM call on pointer-up creates the final geometry atomically.
 *
 * Falls back to the existing TS path when the WASM bridge is unavailable.
 */
import { initWasmBridge, rustSessionConstructor } from "./wasmBridge";
import { auditRustCall } from "./bridgeRuntimeAudit";

/**
 * Serialize a root XNode to a minimal .x JSON document. Used by the drawing
 * tool finalization to hand the current document state to the Rust pipeline.
 * Returns null when serialization is not possible.
 */
export function serializeToX(root: {
  id: string;
  name?: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  children?: Array<unknown>;
}): string | null {
  try {
    return JSON.stringify({
      version: 1,
      pages: [root],
      default_font: null,
      variables: {},
      styles: {},
      assets: {},
    });
  } catch {
    return null;
  }
}

/**
 * Commit a pen-drawn path through the Rust pipeline. Takes raw click points,
 * creates a vector node with smooth bezier curves as ONE atomic undo step.
 * Returns null when the WASM bridge is unavailable (caller should fall back).
 */
export async function wasmCommitPenPath(
  xDocument: string,
  parentId: string,
  points: [number, number][],
): Promise<{ success: boolean; newX?: string } | null> {
  if (points.length < 2) return null;
  if (!(await initWasmBridge())) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  try {
    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as {
      commitPenPath?: (parentId: string, pointsJson: string) => string;
      exportX: () => string;
      free: () => void;
    };

    if (!session.commitPenPath) {
      session.free();
      return null;
    }

    const json = JSON.stringify(points);
    const result = auditRustCall(
      "x-wasm.RustDocumentSession.commitPenPath",
      () => session.commitPenPath!(parentId, json),
    );
    const parsed = JSON.parse(result) as { revision?: number };
    const success = typeof parsed.revision === "number" && parsed.revision > 0;
    const newX = success ? session.exportX() : undefined;
    session.free();
    return { success, newX };
  } catch {
    return null;
  }
}

/**
 * Commit a pencil-drawn stroke through the Rust pipeline. Applies RDP
 * simplification and Catmull-Rom bezier fitting for a smooth path.
 * Returns null when the WASM bridge is unavailable.
 */
export async function wasmSmoothPencilPath(
  xDocument: string,
  parentId: string,
  points: [number, number][],
  tolerance: number,
): Promise<{ success: boolean; newX?: string } | null> {
  if (points.length < 2) return null;
  if (!(await initWasmBridge())) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  try {
    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as {
      smoothPencilPath?: (parentId: string, pointsJson: string, tolerance: number) => string;
      exportX: () => string;
      free: () => void;
    };

    if (!session.smoothPencilPath) {
      session.free();
      return null;
    }

    const json = JSON.stringify(points);
    const result = auditRustCall(
      "x-wasm.RustDocumentSession.smoothPencilPath",
      () => session.smoothPencilPath!(parentId, json, tolerance),
    );
    const parsed = JSON.parse(result) as { revision?: number };
    const success = typeof parsed.revision === "number" && parsed.revision > 0;
    const newX = success ? session.exportX() : undefined;
    session.free();
    return { success, newX };
  } catch {
    return null;
  }
}

/**
 * Erase geometry from a vector node along a stroke path through the Rust
 * pipeline. Segments within radius of the erase path are removed, splitting
 * the vector. Returns null when the WASM bridge is unavailable.
 */
export async function wasmEraseGeometry(
  xDocument: string,
  targetId: string,
  erasePoints: [number, number][],
  radius: number,
): Promise<{ success: boolean; newX?: string } | null> {
  if (erasePoints.length === 0 || radius <= 0) return null;
  if (!(await initWasmBridge())) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  try {
    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as {
      eraseGeometry?: (targetId: string, erasePointsJson: string, radius: number) => string;
      exportX: () => string;
      free: () => void;
    };

    if (!session.eraseGeometry) {
      session.free();
      return null;
    }

    const json = JSON.stringify(erasePoints);
    const result = auditRustCall(
      "x-wasm.RustDocumentSession.eraseGeometry",
      () => session.eraseGeometry!(targetId, json, radius),
    );
    const parsed = JSON.parse(result) as { revision?: number };
    const success = typeof parsed.revision === "number" && parsed.revision > 0;
    const newX = success ? session.exportX() : undefined;
    session.free();
    return { success, newX };
  } catch {
    return null;
  }
}
