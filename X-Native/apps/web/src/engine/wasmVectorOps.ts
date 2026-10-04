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
import type { PathPoint, VectorNetwork, VectorSegment, VectorVertex, XNode } from "./types";

export interface WasmVectorResult {
  /** The resulting path commands as a flat array of [tag, ...coords] tuples. */
  path: Array<[string, ...number[]]>;
  /** Whether the result path is closed. */
  closed: boolean;
  /** Updated node bounds and local geometry when returned by Rust. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  localPath?: PathPoint[];
  vectorNetwork?: VectorNetwork;
}

function normalizeOpaqueHex(color: unknown, fallback: string | null = "#000000"): string | null {
  if (typeof color !== "string") return fallback;
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed) && trimmed.slice(7).toLowerCase() === "ff") {
    return trimmed.slice(0, 7).toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function nodeKindToX(
  n: XNode,
  requireClosedVector: boolean,
): { kind: Record<string, unknown>; isClosed: boolean } | null {
  if (n.kind === "rect") {
    const radii = n.cornerRadii ?? [0, 0, 0, 0];
    if (radii.some((r) => r !== 0)) return null;
    return { kind: { t: "rect", radius: 0 }, isClosed: true };
  }
  if (n.kind === "ellipse") {
    if (n.arcData) return null;
    return { kind: { t: "ellipse" }, isClosed: true };
  }
  if (n.kind === "star") {
    return {
      kind: {
        t: "star",
        points: n.count ?? 5,
        ratio: n.starRatio ?? 0.4,
      },
      isClosed: true,
    };
  }
  if (n.kind === "poly") {
    return {
      kind: {
        t: "poly",
        sides: n.count ?? 5,
      },
      isClosed: true,
    };
  }
  if (n.kind === "line" && !requireClosedVector && (!n.path || n.path.length === 0)) {
    return {
      kind: { t: "line" },
      isClosed: false,
    };
  }
  if (n.kind === "vector" || n.kind === "boolean" || n.kind === "line") {
    if (!n.path || n.path.length < 2) return null;
    const isClosed = !!n.closed;
    if (requireClosedVector && (!isClosed || n.path.length < 3)) return null;
    for (const p of n.path) {
      if (
        (p.ix !== undefined && p.ix !== 0) ||
        (p.iy !== undefined && p.iy !== 0) ||
        (p.ox !== undefined && p.ox !== 0) ||
        (p.oy !== undefined && p.oy !== 0)
      ) {
        return null;
      }
    }
    const cmds: Array<[string, ...number[]]> = [
      ["M", n.path[0].x, n.path[0].y],
      ...n.path.slice(1).map((p): [string, ...number[]] => ["L", p.x, p.y]),
    ];
    if (isClosed) cmds.push(["Z"]);
    return { kind: { t: "vector", path: cmds }, isClosed };
  }
  return null;
}

/**
 * Build a minimal .x document containing just the target node.
 * This is needed because the WASM bridge expects a full .x document,
 * but we only need to operate on a single node.
 */
function buildMinimalXDoc(node: XNode, mode: "outline" | "offset"): string | null {
  try {
    const xNode = nodeToX(node, mode);
    if (!xNode) return null;
    return JSON.stringify({
      format: "x-native",
      version: 1,
      pages: [
        {
          id: "vector-op-page",
          name: "Vector Ops",
          x: 0,
          y: 0,
          w: Math.max(1000, (node.x || 0) + (node.w || 100) + 100),
          h: Math.max(1000, (node.y || 0) + (node.h || 100) + 100),
          rotation: 0,
          opacity: 1,
          visible: true,
          locked: false,
          show_name: false,
          blend: "pass-through",
          fill: { t: "solid", c: "#ffffff" },
          kind: { t: "frame" },
          children: [xNode],
        },
      ],
    });
  } catch {
    return null;
  }
}

/** Convert an XNode to the .x Node JSON shape expected by RustDocumentSession */
function nodeToX(n: XNode, mode: "outline" | "offset"): Record<string, unknown> | null {
  if (
    (n.rotation ?? 0) !== 0 ||
    n.flipH ||
    n.flipV ||
    (n.opacity ?? 1) !== 1 ||
    n.visible === false ||
    n.locked === true ||
    (n.effects && n.effects.length > 0)
  ) {
    return null;
  }
  const shapeInfo = nodeKindToX(n, mode === "offset");
  if (!shapeInfo) return null;
  const { kind, isClosed } = shapeInfo;

  if (mode === "outline") {
    const strokeWidth = n.strokeWidth ?? 0;
    if (!(strokeWidth > 0) || n.strokeVisible === false) return null;
    if ((n.strokeDash ?? 0) > 0 || (n.strokeDashPattern && n.strokeDashPattern.length > 0)) return null;
    if (n.strokeWidthProfile && n.strokeWidthProfile.length > 0) return null;

    const strokeHex = normalizeOpaqueHex(n.strokePaint, "#000000");
    if (!strokeHex) return null;

    const hasFill =
      n.fillVisible !== false &&
      typeof n.fill === "string" &&
      n.fill !== "transparent" &&
      n.fill !== "none" &&
      !n.fill.toLowerCase().endsWith("00");
    const fillHex = hasFill ? normalizeOpaqueHex(n.fill, null) : null;
    if (hasFill && !fillHex) return null;

    const align =
      n.strokeAlign === "inside" || n.strokeAlign === "outside"
        ? (isClosed ? n.strokeAlign : "center")
        : "center";
    const cap =
      !isClosed && (n.strokeCap === "round" || n.strokeCap === "square")
        ? n.strokeCap
        : "none";
    const join =
      n.strokeJoin === "round" || n.strokeJoin === "bevel" ? n.strokeJoin : "miter";

    return {
      id: n.id,
      name: n.name || n.id,
      x: n.x || 0,
      y: n.y || 0,
      w: Math.max(1, n.w || 100),
      h: Math.max(1, n.h || 100),
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      show_name: false,
      fill: { t: "solid", c: fillHex ?? "#00000000" },
      stroke: { color: strokeHex, width: strokeWidth },
      fill_layers: fillHex
        ? [
            {
              paint: { t: "solid", c: fillHex },
              opacity: 1,
              visible: true,
              blend: "normal",
            },
          ]
        : [],
      stroke_layers: [
        {
          color: strokeHex,
          width: strokeWidth,
          opacity: 1,
          visible: true,
          blend: "normal",
          align,
          cap_start: cap,
          cap_end: cap,
          join,
          dash: [],
          dash_offset: 0,
          miter: 4,
        },
      ],
      effect_layers: [],
      kind,
    };
  }

  // mode === "offset"
  const fillHex = normalizeOpaqueHex(typeof n.fill === "string" ? n.fill : "#000000", "#000000");
  if (!fillHex) return null;
  return {
    id: n.id,
    name: n.name || n.id,
    x: n.x || 0,
    y: n.y || 0,
    w: Math.max(1, n.w || 100),
    h: Math.max(1, n.h || 100),
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    show_name: false,
    fill: { t: "solid", c: fillHex },
    stroke: { color: "#00000000", width: 0 },
    fill_layers: [],
    stroke_layers: [],
    effect_layers: [],
    kind,
  };
}

function buildLocalGeometryFromRustDelta(
  sourceNode: XNode,
  deltaNode: { x: number; y: number; w: number; h: number; path: Array<[string, ...number[]]> },
): { localPath: PathPoint[]; vectorNetwork: VectorNetwork } {
  const offsetX = deltaNode.x - (sourceNode.x || 0);
  const offsetY = deltaNode.y - (sourceNode.y || 0);
  const localPath = rustPathToPoints(deltaNode.path, offsetX, offsetY);
  const vectorNetwork = rustPathToVectorNetwork(deltaNode.path, offsetX, offsetY);
  return { localPath, vectorNetwork };
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
    const xDocument = buildMinimalXDoc(node, "outline");
    if (!xDocument) return null;

    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as {
      outlineStroke?: (id: string) => string;
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

    const delta = JSON.parse(result) as {
      revision?: number;
      outline?: {
        x: number;
        y: number;
        w: number;
        h: number;
        path?: Array<[string, ...number[]]>;
        kind?: string;
      };
    };

    session.free();

    if (!delta.outline?.path || delta.outline.path.length === 0) return null;

    const { localPath, vectorNetwork } = buildLocalGeometryFromRustDelta(node, {
      x: delta.outline.x,
      y: delta.outline.y,
      w: delta.outline.w,
      h: delta.outline.h,
      path: delta.outline.path,
    });

    return {
      path: delta.outline.path,
      closed: true,
      x: delta.outline.x,
      y: delta.outline.y,
      w: delta.outline.w,
      h: delta.outline.h,
      localPath,
      vectorNetwork,
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
    const xDocument = buildMinimalXDoc(node, "offset");
    if (!xDocument) return null;

    const session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as {
      offsetNode?: (id: string, distance: number, join: string) => string;
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

    const delta = JSON.parse(result) as {
      revision?: number;
      offset?: {
        x: number;
        y: number;
        w: number;
        h: number;
        path?: Array<[string, ...number[]]>;
        kind?: string;
      };
    };

    session.free();

    if (!delta.offset?.path || delta.offset.path.length === 0) return null;

    const { localPath, vectorNetwork } = buildLocalGeometryFromRustDelta(node, {
      x: delta.offset.x,
      y: delta.offset.y,
      w: delta.offset.w,
      h: delta.offset.h,
      path: delta.offset.path,
    });

    return {
      path: delta.offset.path,
      closed: true,
      x: delta.offset.x,
      y: delta.offset.y,
      w: delta.offset.w,
      h: delta.offset.h,
      localPath,
      vectorNetwork,
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
  offsetX = 0,
  offsetY = 0,
): Array<{ x: number; y: number; ix?: number; iy?: number; ox?: number; oy?: number }> {
  const points: Array<{ x: number; y: number; ix?: number; iy?: number; ox?: number; oy?: number }> = [];

  for (const cmd of rustPath) {
    const tag = cmd[0];
    if (tag === "Z") continue;

    if (tag === "M" || tag === "L") {
      const x = cmd[1] + offsetX;
      const y = cmd[2] + offsetY;
      points.push({ x, y });
    } else if (tag === "C") {
      // Cubic: ["C", c1x, c1y, c2x, c2y, x, y]
      const c1x = cmd[1] + offsetX;
      const c1y = cmd[2] + offsetY;
      const c2x = cmd[3] + offsetX;
      const c2y = cmd[4] + offsetY;
      const x = cmd[5] + offsetX;
      const y = cmd[6] + offsetY;
      points.push({
        x,
        y,
        ix: c2x - x,
        iy: c2y - y,
      });
      if (points.length >= 2) {
        const prev = points[points.length - 2];
        prev.ox = c1x - prev.x;
        prev.oy = c1y - prev.y;
      }
    }
  }

  return points;
}

/**
 * Convert multi-contour Rust path commands into a VectorNetwork with EVENODD
 * winding so interior cutout rings (such as outlined closed strokes) are preserved.
 */
export function rustPathToVectorNetwork(
  rustPath: Array<[string, ...number[]]>,
  offsetX = 0,
  offsetY = 0,
): VectorNetwork {
  const vertices: VectorVertex[] = [];
  const segments: VectorSegment[] = [];
  const loops: number[][] = [];
  let ringStart = -1;
  let ringSegments: number[] = [];

  const flushRing = () => {
    if (ringStart >= 0 && vertices.length - ringStart >= 3 && ringSegments.length >= 2) {
      const closeIdx = segments.length;
      segments.push({ start: vertices.length - 1, end: ringStart });
      ringSegments.push(closeIdx);
      loops.push(ringSegments);
    }
    ringStart = -1;
    ringSegments = [];
  };

  for (const cmd of rustPath) {
    const tag = cmd[0];
    if (tag === "M") {
      flushRing();
      ringStart = vertices.length;
      vertices.push({ x: cmd[1] + offsetX, y: cmd[2] + offsetY });
    } else if (tag === "L" && ringStart >= 0) {
      const prev = vertices.length - 1;
      const next = vertices.length;
      vertices.push({ x: cmd[1] + offsetX, y: cmd[2] + offsetY });
      ringSegments.push(segments.length);
      segments.push({ start: prev, end: next });
    } else if (tag === "C" && ringStart >= 0) {
      const prev = vertices.length - 1;
      const next = vertices.length;
      const c1x = cmd[1] + offsetX;
      const c1y = cmd[2] + offsetY;
      const c2x = cmd[3] + offsetX;
      const c2y = cmd[4] + offsetY;
      const x = cmd[5] + offsetX;
      const y = cmd[6] + offsetY;
      const prevV = vertices[prev];
      vertices.push({ x, y });
      ringSegments.push(segments.length);
      segments.push({
        start: prev,
        end: next,
        tangentStart: { x: c1x - prevV.x, y: c1y - prevV.y },
        tangentEnd: { x: c2x - x, y: c2y - y },
      });
    } else if (tag === "Z") {
      flushRing();
    }
  }
  flushRing();

  return {
    vertices,
    segments,
    regions: loops.length ? [{ windingRule: "EVENODD", loops }] : [],
  };
}
