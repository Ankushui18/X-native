/**
 * Phase 10: WASM-backed drawing tool operations.
 *
 * Routes pen path commit, pencil stroke smoothing, and eraser geometry
 * splitting through the Rust session bridge (x-wasm). Each operation
 * creates or mutates a vector node as a SINGLE atomic undo step in Rust,
 * preventing the per-point undo spam bug described in the audit.
 *
 * When the WASM bridge is unavailable (dev mode without wasm-pack build),
 * all functions return null so the caller can fall back to the existing
 * TypeScript path in MemoryEngine.
 */
import { initWasmBridge, rustSessionConstructor } from "./wasmBridge";
import { auditRustCall } from "./bridgeRuntimeAudit";

export interface WasmDrawResult {
  /** Whether the WASM path succeeded. */
  success: boolean;
  /** The new revision number from the Rust session. */
  revision: number;
  /** The serialized .x document after the operation (for syncing back to MemoryEngine). */
  newX?: string;
}

function serializeNodeToX(raw: unknown, isRoot: boolean): Record<string, unknown> {
  const n = (raw ?? {}) as Record<string, unknown>;
  const id = typeof n.id === "string" && n.id ? n.id : isRoot ? "root" : "node";
  const name = typeof n.name === "string" && n.name ? n.name : id;
  const x = typeof n.x === "number" && Number.isFinite(n.x) ? n.x : 0;
  const y = typeof n.y === "number" && Number.isFinite(n.y) ? n.y : 0;
  const w = typeof n.w === "number" && Number.isFinite(n.w) && n.w > 0 ? n.w : 100;
  const h = typeof n.h === "number" && Number.isFinite(n.h) && n.h > 0 ? n.h : 100;
  const rawChildren = Array.isArray(n.children) ? n.children : [];

  let kind: Record<string, unknown> = isRoot ? { t: "frame" } : { t: "rect", radius: 0 };
  if (!isRoot) {
    if (n.kind === "ellipse") {
      kind = { t: "ellipse" };
    } else if (n.kind === "vector" && Array.isArray(n.path) && n.path.length >= 2) {
      const pts = n.path as Array<{ x: number; y: number }>;
      const cmds: Array<[string, ...number[]]> = [
        ["M", pts[0].x || 0, pts[0].y || 0],
        ...pts.slice(1).map((p): [string, ...number[]] => ["L", p.x || 0, p.y || 0]),
      ];
      if (n.closed) cmds.push(["Z"]);
      kind = { t: "vector", path: cmds };
    }
  }

  return {
    id,
    name,
    x,
    y,
    w,
    h,
    rotation: 0,
    opacity: 1,
    visible: n.visible !== false,
    locked: n.locked === true,
    show_name: false,
    ...(isRoot ? { blend: "pass-through" } : {}),
    fill: { t: "solid", c: "#000000" },
    kind,
    ...(isRoot && rawChildren.length > 0
      ? { children: rawChildren.map((c) => serializeNodeToX(c, false)) }
      : {}),
  };
}

/**
 * Serialize a minimal .x document from the current page root for a one-shot
 * WASM operation. Returns null if serialization fails.
 */
function serializeToX(root: unknown): string | null {
  try {
    return JSON.stringify({
      format: "x-native",
      version: 1,
      pages: [serializeNodeToX(root, true)],
    });
  } catch {
    return null;
  }
}

/**
 * Phase 10: Commit a pen-drawn path via Rust.
 *
 * Takes the collected click points from the TS pen tool and sends them
 * to `RustDocumentSession.commitPenPath` in a single call. Rust converts
 * the points to cubic bezier curves and inserts the vector node as ONE
 * undo step.
 *
 * @param pageRoot - Current page root node (for document context)
 * @param parentId - ID of the parent frame/page to insert into
 * @param points - Array of {x, y} points collected during the pen interaction
 */
export async function wasmCommitPenPath(
  pageRoot: unknown,
  parentId: string,
  points: Array<{ x: number; y: number }>,
): Promise<WasmDrawResult | null> {
  if (!(await initWasmBridge())) return null;
  if (points.length < 2) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  const xDoc = serializeToX(pageRoot);
  if (!xDoc) return null;

  try {
    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDoc),
    ) as {
      commitPenPath?: (parentId: string, pointsJson: string) => string;
      exportX: () => string;
      free: () => void;
    };

    if (!session.commitPenPath) {
      session.free();
      return null;
    }

    const pointsJson = JSON.stringify(points.map((p) => [p.x, p.y]));
    const raw = auditRustCall(
      "x-wasm.RustDocumentSession.commitPenPath",
      () => session.commitPenPath!(parentId, pointsJson),
    );
    const delta = JSON.parse(raw) as { revision: number; canUndo: boolean };
    const newX = session.exportX();
    session.free();

    return {
      success: true,
      revision: delta.revision,
      newX,
    };
  } catch {
    return null;
  }
}

/**
 * Phase 10: Commit a pencil-drawn stroke via Rust.
 *
 * Sends raw pointer samples to `RustDocumentSession.smoothPencilPath`.
 * Rust applies RDP simplification + Catmull-Rom → cubic bezier fitting,
 * producing a smooth vector path as ONE atomic undo step.
 *
 * @param pageRoot - Current page root node
 * @param parentId - ID of the parent frame/page
 * @param rawPoints - Raw pointer positions from the drag
 * @param tolerance - RDP simplification tolerance in canvas units
 */
export async function wasmSmoothPencilPath(
  pageRoot: unknown,
  parentId: string,
  rawPoints: Array<{ x: number; y: number }>,
  tolerance: number,
): Promise<WasmDrawResult | null> {
  if (!(await initWasmBridge())) return null;
  if (rawPoints.length < 2) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  const xDoc = serializeToX(pageRoot);
  if (!xDoc) return null;

  try {
    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDoc),
    ) as {
      smoothPencilPath?: (parentId: string, pointsJson: string, tolerance: number) => string;
      exportX: () => string;
      free: () => void;
    };

    if (!session.smoothPencilPath) {
      session.free();
      return null;
    }

    const pointsJson = JSON.stringify(rawPoints.map((p) => [p.x, p.y]));
    const raw = auditRustCall(
      "x-wasm.RustDocumentSession.smoothPencilPath",
      () => session.smoothPencilPath!(parentId, pointsJson, tolerance),
    );
    const delta = JSON.parse(raw) as { revision: number; canUndo: boolean };
    const newX = session.exportX();
    session.free();

    return {
      success: true,
      revision: delta.revision,
      newX,
    };
  } catch {
    return null;
  }
}

/**
 * Phase 10: Erase geometry from a vector node via Rust.
 *
 * Sends the eraser stroke points to `RustDocumentSession.eraseGeometry`.
 * Rust splits segments within `radius` of the stroke path as ONE undo step.
 *
 * @param pageRoot - Current page root node
 * @param targetId - ID of the vector node to erase from
 * @param erasePoints - Points along the eraser stroke
 * @param radius - Eraser radius in canvas units
 */
export async function wasmEraseGeometry(
  pageRoot: unknown,
  targetId: string,
  erasePoints: Array<{ x: number; y: number }>,
  radius: number,
): Promise<WasmDrawResult | null> {
  if (!(await initWasmBridge())) return null;
  if (erasePoints.length === 0) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  const xDoc = serializeToX(pageRoot);
  if (!xDoc) return null;

  try {
    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDoc),
    ) as {
      eraseGeometry?: (targetId: string, pointsJson: string, radius: number) => string;
      exportX: () => string;
      free: () => void;
    };

    if (!session.eraseGeometry) {
      session.free();
      return null;
    }

    const pointsJson = JSON.stringify(erasePoints.map((p) => [p.x, p.y]));
    const raw = auditRustCall(
      "x-wasm.RustDocumentSession.eraseGeometry",
      () => session.eraseGeometry!(targetId, pointsJson, radius),
    );
    const delta = JSON.parse(raw) as { revision: number; canUndo: boolean };
    const newX = session.exportX();
    session.free();

    return {
      success: true,
      revision: delta.revision,
      newX,
    };
  } catch {
    return null;
  }
}
