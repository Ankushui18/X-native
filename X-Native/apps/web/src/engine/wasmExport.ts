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
import type { XNode } from "./types";

export interface WasmExportResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  format: "png" | "jpg" | "pdf";
}

/** Build a minimal .x JSON document containing the target node. The .x
 *  schema is defined by x-format; this produces the minimum valid document
 *  the Rust session can open and export from. */
export function buildExportXDoc(n: XNode, box: { w: number; h: number } | null): string | null {
  const w = Math.max(1, box?.w ?? n.w);
  const h = Math.max(1, box?.h ?? n.h);
  const xNode = xnodeToX(n);
  if (!xNode) return null;
  return JSON.stringify({
    format: "x-native",
    version: 1,
    pages: [
      {
        id: "export-page",
        name: "Export",
        x: 0,
        y: 0,
        w,
        h,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        show_name: false,
        blend: "pass-through",
        fill: { t: "solid", c: "#00000000" },
        kind: { t: "frame" },
        children: [xNode],
      },
    ],
  });
}

function xnodeToX(n: XNode): Record<string, unknown> | null {
  if (
    n.imageSrc ||
    n.fillType !== "solid" ||
    (n.gradientStops && n.gradientStops.length > 0) ||
    (n.effects && n.effects.length > 0) ||
    n.isMask ||
    n.kind === "text"
  ) {
    return null;
  }

  let kind: Record<string, unknown>;
  if (n.kind === "frame" || n.kind === "component" || n.kind === "instance") {
    kind = { t: "frame" };
  } else if (n.kind === "group") {
    kind = { t: "group" };
  } else if (n.kind === "section") {
    kind = { t: "section" };
  } else if (n.kind === "rect") {
    kind = { t: "rect", radius: n.cornerRadii?.[0] ?? 0 };
  } else if (n.kind === "ellipse") {
    kind = { t: "ellipse" };
  } else if (n.kind === "poly") {
    kind = { t: "poly", sides: n.count ?? 5 };
  } else if (n.kind === "star") {
    kind = { t: "star", points: n.count ?? 5, ratio: n.starRatio ?? 0.4 };
  } else if (n.kind === "line") {
    kind = { t: "line" };
  } else if ((n.kind === "vector" || n.kind === "boolean") && n.path?.length) {
    const cmds: Array<[string, ...number[]]> = [];
    for (let i = 0; i < n.path.length; i++) {
      const pt = n.path[i];
      if (i === 0) {
        cmds.push(["M", pt.x, pt.y]);
      } else {
        const prev = n.path[i - 1];
        const hasOut = (prev.ox ?? 0) !== 0 || (prev.oy ?? 0) !== 0;
        const hasIn = (pt.ix ?? 0) !== 0 || (pt.iy ?? 0) !== 0;
        if (hasOut || hasIn) {
          cmds.push([
            "C",
            prev.x + (prev.ox ?? 0),
            prev.y + (prev.oy ?? 0),
            pt.x + (pt.ix ?? 0),
            pt.y + (pt.iy ?? 0),
            pt.x,
            pt.y,
          ]);
        } else {
          cmds.push(["L", pt.x, pt.y]);
        }
      }
    }
    if (n.closed !== false) {
      cmds.push(["Z"]);
    }
    kind = { t: "vector", path: cmds };
  } else {
    return null;
  }

  const fillHex =
    n.fillVisible !== false && typeof n.fill === "string" && n.fill.startsWith("#")
      ? n.fill
      : "#00000000";

  const base: Record<string, unknown> = {
    id: n.id,
    name: n.name || n.id,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    rotation: n.rotation || 0,
    opacity: typeof n.opacity === "number" ? n.opacity : 1,
    visible: n.visible !== false,
    locked: n.locked === true,
    show_name: false,
    fill: { t: "solid", c: fillHex },
    kind,
  };
  if (n.cornerRadii && n.cornerRadii.some((r) => r !== (n.cornerRadii?.[0] ?? 0))) {
    base.corners = n.cornerRadii;
  }
  if (n.strokeVisible !== false && n.strokeWidth > 0 && typeof n.strokePaint === "string" && n.strokePaint.startsWith("#")) {
    base.stroke = { color: n.strokePaint, width: n.strokeWidth };
  }
  if (n.children?.length) {
    const childXNodes: Record<string, unknown>[] = [];
    for (const child of n.children) {
      const converted = xnodeToX(child);
      if (!converted) return null;
      childXNodes.push(converted);
    }
    base.children = childXNodes;
  }
  return base;
}

/** Settings the Rust pipeline honors per Figma's format table
 * (13402894554519): Image quality for JPG, as 0..100; and the export-area
 * bleed per side, so the wasm canvas and `exportSize` frame the same box. */
export interface WasmExportOptions {
  quality?: number;
  bleed?: { l: number; t: number; r: number; b: number };
}

/** The file-type signatures a correct answer must start with; JPEG also has
 *  to END at its EOI marker. A bridge that cannot satisfy this is answered by
 *  the canvas fallback, never downloaded. */
const FILE_MAGIC: Record<"png" | "jpg" | "pdf", number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  pdf: [0x25, 0x50, 0x44, 0x46],
};

function validateExportBytes(bytes: Uint8Array, format: "png" | "jpg" | "pdf"): boolean {
  const magic = FILE_MAGIC[format];
  if (bytes.length < magic.length + 8) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  if (format === "jpg" && !(bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)) return false;
  return true; // validated
}

/**
 * Attempt to export a node via the Rust render pipeline.
 * Returns null when the WASM bridge is not available, the node is refused,
 * or the bytes fail validation - so the caller falls back to the canvas path.
 *
 * @param xDocument - The serialized .x document string (from save_x/exportX)
 * @param nodeId - The ID of the node to export
 * @param format - "png", "jpg", or "pdf"
 * @param scale - Scale factor (1x, 2x, 3x, etc.)
 * @param options - Per-format quality and the export-area bleed
 */
export async function wasmExportNode(
  xDocument: string,
  nodeId: string,
  format: "png" | "jpg" | "pdf",
  scale: number,
  options: WasmExportOptions = {},
): Promise<WasmExportResult | null> {
  if (!(await initWasmBridge())) return null;
  const Session = rustSessionConstructor();
  if (!Session) return null;

  let session: {
    exportNode?: (id: string, format: string, scale: number, options: string) => string;
    free: () => void;
  } | null = null;
  try {
    session = auditRustCall(
      "x-wasm.RustDocumentSession.new",
      () => new Session(xDocument),
    ) as unknown as {
      exportNode?: (id: string, format: string, scale: number, options: string) => string;
      free: () => void;
    };

    const binding = session;

    if (!binding.exportNode) {
      session.free();
      return null;
    }

    const raw = auditRustCall(
      "x-wasm.RustDocumentSession.exportNode",
      () => binding.exportNode!(nodeId, format, scale, JSON.stringify(options)),
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
    // Never trust the bridge's ok flag alone: decode first, then validate the
    // magic bytes, so a stub or truncated answer degrades to the canvas path.
    if (!validateExportBytes(bytes, format)) return null;

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
