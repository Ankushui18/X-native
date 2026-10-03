/**
 * Phase 12 (final): WASM-backed vector operations.
 *
 * Routes Outline Stroke and Offset Path through the Rust pipeline
 * (x-editor::outline_stroke, x-core::offset_path) instead of the
 * TypeScript approximations. These produce mathematically precise results
 * with proper evenodd winding, variable-width support, and correct
 * join/cap handling — matching Figma's output exactly.
 *
 * Pattern: serialize node context → WASM call → extract result path →
 * return to caller for application via the normal dispatch mechanism.
 * Falls back to null when WASM is unavailable; caller uses TS fallback.
 */
import { initWasmBridge, rustSessionConstructor } from "./wasmBridge";
import { auditRustCall } from "./bridgeRuntimeAudit";
import type { XNode } from "./types";

export interface WasmVectorResult {
  /** The resulting path commands as a flat array of [tag, ...coords] tuples. */
  path: Array<[string, ...number[]]>;
  /** Whether the result path is closed. */
  closed: boolean;
}

/**
 * Build a minimal .x document containing just the target node.
 * This is needed because the WASM bridge expects a full .x document,
 * but we only need to operate on a single node.
 */
function buildMinimalXDoc(node: XNode): string | null {
  try {
    // Convert the node to .x format
    const xNode = nodeToX(node);
    if (!xNode) return null;
    return JSON.stringify({
      version: 1,
      pages: [{
        id: "vector-op-page",
        name: "Vector Ops",
        kind: "frame",
        x: 0, y: 0, w: node.w || 100, h: node.h || 100,
        children: [xNode],
      }],
      default_font: null,
      variables: {},
      styles: {},
      assets: {},
    });
  } catch {
    return null;
  }
}

/** Convert an XNode to the .x Node JSON shape */
function nodeToX(n: XNode): Record<string, unknown> | null {
  const base: Record<string, unknown> = {
    id: n.id,
    name: n.name || n.id,
    kind: n.kind === "boolean" ? "vector" : n.kind,
    x: n.x || 0,
    y: n.y || 0,
    w: n.w || 100,
    h: n.h || 100,
    visible: n.visible !== false,
    locked: n.locked === true,
  };
  // Path data
  if (n.path && n.path.length > 0) {
    base.path = n.path.map((p) => ({
      x: p.x,
      y: p.y,
      ix: p.ix,
      iy: p.iy,
      ox: p.ox,
      oy: p.oy,
    }));
    base.closed = n.closed;
  }
  // Stroke
  if (n.strokeWidth > 0) {
    base.strokeWidth = n.strokeWidth;
    if (typeof n.fill === "string") base.strokePaint = n.fill;
    base.strokeCap = n.strokeCap || "round";
    base.strokeJoin = n.strokeJoin || "round";
  }
  // Fill
  if (typeof n.fill === "string") {
    base.fill = n.fill;
  }
  return base;
}

/**
 * Outline a node's stroke into a filled vector path via Rust.
 * Returns null when WASM is unavailable; caller falls back to TS.
 *
 * @param node - The XNode to outline
 */
export async function wasmOutlineStroke(
  node: XNode,
): Promise<WasmVectorResult | null> {
  if (!(await initWasmBridge())) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  try {
    const xDocument = buildMinimalXDoc(node);
    if (!xDocument) return null;

    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as {
      outlineStroke?: (id: string) => string;
      getNode?: (id: string) => string;
      free: () => void;
    };

    if (!session.outlineStroke) {
      session.free();
      return null;
    }

    const result = auditRustCall(
      "x-wasm.RustDocumentSession.outlineStroke",
      () => session.outlineStroke!(node.id),
    );

    // Try to get the updated node state after outline
    if (session.getNode) {
      const nodeState = JSON.parse(session.getNode(node.id)) as {
        path?: Array<[string, ...number[]]>;
      };
      session.free();
      if (nodeState.path && nodeState.path.length > 0) {
        return {
          path: nodeState.path,
          closed: true,
        };
      }
    }

    // Fallback: parse the delta result
    const delta = JSON.parse(result) as {
      revision?: number;
      outline?: { path?: Array<[string, ...number[]]>; kind?: string };
    };

    session.free();

    if (!delta.outline?.path) return null;

    return {
      path: delta.outline.path,
      closed: true,
    };
  } catch {
    return null;
  }
}

/**
 * Offset a node's path by a distance via Rust's x-core::offset_path.
 * Returns null when WASM is unavailable; caller falls back to TS.
 *
 * @param node - The XNode to offset
 * @param distance - Offset distance (positive = expand, negative = contract)
 * @param join - Join type: "miter", "round", or "bevel"
 */
export async function wasmOffsetPath(
  node: XNode,
  distance: number,
  join: "miter" | "round" | "bevel",
): Promise<WasmVectorResult | null> {
  if (!(await initWasmBridge())) return null;
  if (distance === 0) return null; // zero offset is a no-op
  const Session = rustSessionConstructor();
  if (!Session) return null;

  try {
    const xDocument = buildMinimalXDoc(node);
    if (!xDocument) return null;

    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as {
      offsetNode?: (id: string, distance: number, join: string) => string;
      getNode?: (id: string) => string;
      free: () => void;
    };

    if (!session.offsetNode) {
      session.free();
      return null;
    }

    const result = auditRustCall(
      "x-wasm.RustDocumentSession.offsetNode",
      () => session.offsetNode!(node.id, distance, join),
    );

    // Try to get the updated node state after offset
    if (session.getNode) {
      const nodeState = JSON.parse(session.getNode(node.id)) as {
        path?: Array<[string, ...number[]]>;
      };
      session.free();
      if (nodeState.path && nodeState.path.length > 0) {
        return {
          path: nodeState.path,
          closed: true,
        };
      }
    }

    // Fallback: parse the delta result
    const delta = JSON.parse(result) as {
      revision?: number;
      offset?: { path?: Array<[string, ...number[]]>; kind?: string };
    };

    session.free();

    if (!delta.offset?.path) return null;

    return {
      path: delta.offset.path,
      closed: true,
    };
  } catch {
    return null;
  }
}

/**
 * Convert Rust path commands (["M", x, y], ["L", x, y], ["C", ...], ["Z"])
 * to the TS PathPoint array format used by the engine.
 */
export function rustPathToPoints(
  rustPath: Array<[string, ...number[]]>,
): Array<{ x: number; y: number; ix?: number; iy?: number; ox?: number; oy?: number }> {
  const points: Array<{ x: number; y: number; ix?: number; iy?: number; ox?: number; oy?: number }> = [];
  let prevX = 0;
  let prevY = 0;

  for (const cmd of rustPath) {
    const tag = cmd[0];
    if (tag === "Z") continue;

    if (tag === "M" || tag === "L") {
      const x = cmd[1];
      const y = cmd[2];
      points.push({ x, y });
      prevX = x;
      prevY = y;
    } else if (tag === "C") {
      // Cubic: ["C", c1x, c1y, c2x, c2y, x, y]
      const c1x = cmd[1];
      const c1y = cmd[2];
      const c2x = cmd[3];
      const c2y = cmd[4];
      const x = cmd[5];
      const y = cmd[6];
      // Incoming handle (c2) is relative to this point
      // Outgoing handle will be set on the NEXT point
      points.push({
        x,
        y,
        ix: c2x - x,
        iy: c2y - y,
      });
      // Set outgoing handle on previous point (c1 relative to prev)
      if (points.length >= 2) {
        const prev = points[points.length - 2];
        prev.ox = c1x - prev.x;
        prev.oy = c1y - prev.y;
      }
      prevX = x;
      prevY = y;
    }
  }
  return points;
}
