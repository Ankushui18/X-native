/** UI-facing adapter for a Rust-owned .x document session. It is NOT an
 * alternate TypeScript document engine: there is no JS node tree or history
 * here. Open/export are explicit checkpoints; each command returns at most one
 * changed node and small history flags. The existing web MemoryEngine cannot
 * consume native .x yet and must not run in parallel with this session. */
import { initWasmBridge, rustSessionConstructor, type WasmDocumentSession } from "./wasmBridge";
import { auditRustCall, registerAuditProbe } from "./bridgeRuntimeAudit";
import type { BooleanOp } from "./types";

// Session status is an independent owner decision; the import loader being ready
// alone says nothing about this schema/route's admission or command dispatch.
let openSessions = 0;
registerAuditProbe("session", { snapshot: () => {
  // Hash query != real URL query; never log the document ID or contents.
  const hash = typeof window !== "undefined" ? window.location.hash ?? "" : "";
  const fileRoute = /^#\/file\/[^/?#]+(?:\?[^#]*)?$/.test(hash);
  const rustRequested = fileRoute && new URLSearchParams(hash.split("?")[1] ?? "").get("engine") === "rust";
  return {
    activeRustSessions: openSessions,
    activeDocumentOwner: openSessions > 0 ? "Rust command session (opt-in view)" :
      rustRequested ? "none: Rust view loading/refused; no TS shadow editor" :
      fileRoute ? "TypeScript MemoryEngine (or still loading)" : "dashboard: no document owner",
    rustRouteRequested: rustRequested,
    mode: "only an explicitly admitted #/file/<id>?engine=rust route; ordinary editor is TS",
  };
} });

export interface RustNodeChange {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface RustGeometryChange extends RustNodeChange {
  index: number;
  kind: "rect" | "vector";
  fill: string;
  visible: boolean;
  locked: boolean;
  /** Present only on vector results; node-local contour anchors. */
  rings?: [number, number][][];
}
export interface RustBooleanChange {
  upsert: RustGeometryChange[];
  removed: string[];
}
/** Native PathCmds preserve even cubic controls on undo. Result offsets are
 * straight, closed contours; neither direction transfers a page or paint. */
export type RustPathCommand = ["M" | "L", number, number] |
  ["C", number, number, number, number, number, number] | ["Z"];
export type RustOffsetChange = RustNodeChange & (
  { kind: "rect"; radius: number } | { kind: "ellipse" } |
  { kind: "poly"; count: number } | { kind: "star"; count: number; ratio: number } |
  { kind: "vector"; path: RustPathCommand[] }
);
/** The one persisted live-stroke style that Outline Stroke can restore on
 * undo. It is deliberately richer than the older rectangle-only stroke band:
 * dashes, asymmetric caps, round joins and variable-width stations stay Rust
 * data rather than being guessed from a filled result. */
export interface RustOutlineStrokeStyle {
  width: number;
  color: string;
  align: "inside" | "center" | "outside";
  capStart: "none" | "round" | "square" | "arrow" | "triangle";
  capEnd: "none" | "round" | "square" | "arrow" | "triangle";
  join: "miter" | "bevel" | "round";
  dash: number[];
  dashOffset: number;
  miterLimit: number;
  widthProfile: { position: number; widthMultiplier: number }[];
}
/** Apply/undo/redo projection for one outline rewrite. The result is normally
 * a vector with `stroke: null`; undo supplies the original primitive/vector
 * and its full sole-stroke style. */
export type RustOutlineChange = RustNodeChange & (
  { kind: "rect"; radius: number } | { kind: "ellipse" } | { kind: "line" } |
  { kind: "arc"; start: number; end: number; ratio: number } |
  { kind: "poly"; count: number } | { kind: "star"; count: number; ratio: number } |
  { kind: "vector"; path: RustPathCommand[] }
) & {
  fill: string | null;
  stroke: RustOutlineStrokeStyle | null;
};
// User-authored document ink, not chrome/theme color.
export const DEFAULT_RECT_STROKE_COLOR = "#202020";
export interface RustStrokeChange {
  id: string;
  width: number;
  color: string;
  align: "inside" | "center" | "outside";
  join: "miter" | "bevel";
  /** Two node-local contours; the second is an EVENODD hole if present. */
  outer: [number, number][];
  inner: [number, number][];
}
export interface RustStateChange {
  revision: number;
  node: RustNodeChange | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Only structural Boolean apply/undo/redo returns this bounded patch. */
  boolean?: RustBooleanChange;
  /** Only a style edit or a stroke-geometry resize emits this bounded patch. */
  stroke?: RustStrokeChange;
  /** Only an offset edit/undo/redo emits this bounded affected-layer patch. */
  offset?: RustOffsetChange;
  /** Only Outline Stroke apply/undo/redo emits this reversible layer patch. */
  outline?: RustOutlineChange;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Rust ${label}`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) {
    throw new Error(`Unexpected Rust ${label} fields`);
  }
}
function nodeValue(value: unknown): RustNodeChange | null {
  if (value === null) return null;
  const obj = record(value, "node delta");
  keys(obj, ["id", "name", "x", "y", "w", "h"], "node delta");
  if (typeof obj.id !== "string" || !obj.id || typeof obj.name !== "string" ||
      typeof obj.x !== "number" || !Number.isFinite(obj.x) ||
      typeof obj.y !== "number" || !Number.isFinite(obj.y) ||
      typeof obj.w !== "number" || !Number.isFinite(obj.w) ||
      typeof obj.h !== "number" || !Number.isFinite(obj.h)) throw new Error("Invalid Rust node delta");
  return { id: obj.id, name: obj.name, x: obj.x, y: obj.y, w: obj.w, h: obj.h };
}
function geometryValue(value: unknown): RustGeometryChange {
  const obj = record(value, "Boolean layer delta");
  const vector = obj.kind === "vector";
  keys(obj, ["id", "name", "x", "y", "w", "h", "index", "kind", "fill", "visible", "locked",
    ...(vector ? ["rings"] : [])], "Boolean layer delta");
  const node = nodeValue({ id: obj.id, name: obj.name, x: obj.x, y: obj.y, w: obj.w, h: obj.h });
  if (!node || !node.id || node.id.length > 256 || node.name.length > 1024 ||
      (obj.kind !== "rect" && !vector) ||
      !Number.isSafeInteger(obj.index) || (obj.index as number) < 0 || (obj.index as number) > 2048 ||
      !(node.w > 0 && node.h > 0) || typeof obj.fill !== "string" || !/^#[0-9a-f]{6}$/.test(obj.fill) ||
      typeof obj.visible !== "boolean" || typeof obj.locked !== "boolean") throw new Error("Invalid Rust Boolean layer");
  let rings: [number, number][][] | undefined;
  if (vector) {
    if (!Array.isArray(obj.rings) || obj.rings.length > 512) throw new Error("Invalid Rust Boolean contours");
    let count = 0;
    rings = obj.rings.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 3 || (count += ring.length) > 4096) {
        throw new Error("Invalid Rust Boolean contour size");
      }
      return ring.map((p): [number, number] => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
          throw new Error("Invalid Rust Boolean contour point");
        }
        return [p[0], p[1]];
      });
    });
  }
  return { ...node, index: obj.index as number, kind: vector ? "vector" : "rect", fill: obj.fill,
    visible: obj.visible, locked: obj.locked, ...(vector ? { rings } : {}) };
}
function booleanValue(value: unknown): RustBooleanChange {
  const obj = record(value, "Boolean delta");
  keys(obj, ["upsert", "removed"], "Boolean delta");
  if (!Array.isArray(obj.upsert) || !Array.isArray(obj.removed) ||
      ![1, 2].includes(obj.upsert.length) || obj.upsert.length + obj.removed.length !== 3 ||
      obj.removed.some(id => typeof id !== "string" || !id)) throw new Error("Invalid Rust Boolean delta");
  const upsert = obj.upsert.map(geometryValue);
  const removed = obj.removed as string[];
  const ids = [...upsert.map(n => n.id), ...removed];
  if (new Set(ids).size !== 3) throw new Error("Duplicate Rust Boolean identities");
  return { upsert, removed };
}
function strokeValue(value: unknown): RustStrokeChange {
  const s = record(value, "stroke delta");
  keys(s, ["id", "width", "color", "align", "join", "outer", "inner"], "stroke delta");
  if (typeof s.id !== "string" || !s.id || s.id.length > 256 ||
      typeof s.width !== "number" || !Number.isFinite(s.width) || s.width < 0 || s.width > 2048 ||
      typeof s.color !== "string" || !/^#[0-9a-f]{6}$/.test(s.color) ||
      !["inside", "center", "outside"].includes(s.align as string) ||
      !["miter", "bevel"].includes(s.join as string)) throw new Error("Invalid Rust stroke style");
  const contour = (ring: unknown, outer: boolean): [number, number][] => {
    if (!Array.isArray(ring) || ![outer ? 4 : 0, outer ? 8 : 4].includes(ring.length)) {
      throw new Error("Invalid Rust stroke contour size");
    }
    return ring.map(point => {
      if (!Array.isArray(point) || point.length !== 2 ||
          point.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9 + 2048)) {
        throw new Error("Invalid Rust stroke contour point");
      }
      return [point[0], point[1]] as [number, number];
    });
  };
  if (s.width === 0 && (s.align !== "center" || s.join !== "miter" || s.color !== "#000000" ||
      !Array.isArray(s.outer) || s.outer.length || !Array.isArray(s.inner) || s.inner.length)) {
    throw new Error("Removed Rust stroke must have empty contours");
  }
  const outer = s.width === 0 ? [] as [number, number][] : contour(s.outer, true);
  const inner = s.width === 0 ? [] as [number, number][] : contour(s.inner, false);
  return { id: s.id, width: s.width, color: s.color, align: s.align as RustStrokeChange["align"],
    join: s.join as RustStrokeChange["join"], outer, inner };
}
function offsetValue(value: unknown): RustOffsetChange {
  const obj = record(value, "offset layer delta");
  const kind = obj.kind;
  const extra = kind === "rect" ? ["radius"] : kind === "poly" ? ["count"] :
    kind === "star" ? ["count", "ratio"] : kind === "vector" ? ["path"] : [];
  keys(obj, ["id", "name", "x", "y", "w", "h", "kind", ...extra], "offset layer delta");
  const node = nodeValue({ id: obj.id, name: obj.name, x: obj.x, y: obj.y, w: obj.w, h: obj.h });
  if (!node || node.id.length > 256 || node.name.length > 1024 || node.w <= 0 || node.h <= 0 ||
      Math.abs(node.x) > 1e9 + 2048 || Math.abs(node.y) > 1e9 + 2048) {
    throw new Error("Invalid Rust offset layer");
  }
  if (kind === "rect") {
    if (typeof obj.radius !== "number" || !Number.isFinite(obj.radius) ||
        obj.radius < 0 || obj.radius > Math.min(node.w, node.h) / 2) throw new Error("Invalid Rust offset radius");
    return { ...node, kind, radius: obj.radius };
  }
  if (kind === "ellipse") return { ...node, kind };
  if (kind === "poly" || kind === "star") {
    if (!Number.isSafeInteger(obj.count) || (obj.count as number) < 3 || (obj.count as number) > 256 ||
        (kind === "star" && (typeof obj.ratio !== "number" || !Number.isFinite(obj.ratio) ||
          obj.ratio <= 0 || obj.ratio >= 1))) throw new Error("Invalid Rust offset polygon");
    return kind === "poly" ? { ...node, kind, count: obj.count as number } :
      { ...node, kind, count: obj.count as number, ratio: obj.ratio as number };
  }
  if (kind !== "vector" || !Array.isArray(obj.path) || obj.path.length > 4224) {
    throw new Error("Invalid Rust offset path");
  }
  let opened = false, contourSize = 0, count = 0, contours = 0;
  const path: RustPathCommand[] = obj.path.map((item): RustPathCommand => {
    if (!Array.isArray(item) || !["M", "L", "C", "Z"].includes(item[0])) {
      throw new Error("Invalid Rust offset path command");
    }
    const tag = item[0];
    if (tag === "Z") {
      if (item.length !== 1 || !opened || contourSize < 3) throw new Error("Unclosed Rust offset contour");
      opened = false; contourSize = 0; contours++;
      return ["Z"];
    }
    if ((tag === "C" ? item.length !== 7 : item.length !== 3) ||
        item.slice(1).some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e7) ||
        (tag === "M") === opened || ++count > 4096) throw new Error("Invalid Rust offset anchor");
    opened = true; contourSize++;
    return item as RustPathCommand;
  });
  if (opened || contours > 128 || (path.length > 0 && !contours)) throw new Error("Unclosed Rust offset path");
  return { ...node, kind, path };
}
const OUTLINE_COORD_LIMIT = 1_100_000_000;
const OUTLINE_MAX_ANCHORS = 8192;
const OUTLINE_MAX_PATH_COMMANDS = OUTLINE_MAX_ANCHORS + Math.ceil(OUTLINE_MAX_ANCHORS / 3);

function outlinePathValue(value: unknown): RustPathCommand[] {
  if (!Array.isArray(value) || value.length > OUTLINE_MAX_PATH_COMMANDS) {
    throw new Error("Invalid Rust outline path");
  }
  let opened = false, contourSize = 0, anchors = 0, closedContours = 0;
  const finishOpen = () => {
    if (opened && contourSize < 2) throw new Error("Degenerate Rust outline subpath");
  };
  const path = value.map((item): RustPathCommand => {
    if (!Array.isArray(item) || !["M", "L", "C", "Z"].includes(item[0])) {
      throw new Error("Invalid Rust outline path command");
    }
    const tag = item[0];
    if (tag === "Z") {
      if (item.length !== 1 || !opened || contourSize < 3) throw new Error("Invalid Rust outline contour");
      opened = false; contourSize = 0; closedContours++;
      if (closedContours > Math.ceil(OUTLINE_MAX_ANCHORS / 3)) throw new Error("Too many Rust outline contours");
      return ["Z"];
    }
    if ((tag === "C" ? item.length !== 7 : item.length !== 3) ||
        item.slice(1).some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > OUTLINE_COORD_LIMIT)) {
      throw new Error("Invalid Rust outline anchor");
    }
    if (tag === "M") {
      finishOpen();
      opened = true; contourSize = 1;
    } else {
      if (!opened) throw new Error("Rust outline segment has no move");
      contourSize++;
    }
    if (++anchors > OUTLINE_MAX_ANCHORS) throw new Error("Rust outline exceeds the anchor budget");
    return item as RustPathCommand;
  });
  finishOpen();
  return path;
}

function outlineStrokeValue(value: unknown): RustOutlineStrokeStyle {
  const obj = record(value, "outline stroke");
  keys(obj, ["width", "color", "align", "capStart", "capEnd", "join", "dash", "dashOffset", "miterLimit", "widthProfile"], "outline stroke");
  if (typeof obj.width !== "number" || !Number.isFinite(obj.width) || obj.width <= 0 || obj.width > 1_000_000 ||
      typeof obj.color !== "string" || !/^#[0-9a-f]{6}$/.test(obj.color) ||
      !["inside", "center", "outside"].includes(obj.align as string) ||
      !["none", "round", "square", "arrow", "triangle"].includes(obj.capStart as string) ||
      !["none", "round", "square", "arrow", "triangle"].includes(obj.capEnd as string) ||
      !["miter", "bevel", "round"].includes(obj.join as string) ||
      !Array.isArray(obj.dash) || obj.dash.length > 128 ||
      obj.dash.some(v => typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1e9) ||
      typeof obj.dashOffset !== "number" || !Number.isFinite(obj.dashOffset) || Math.abs(obj.dashOffset) > 1e9 ||
      typeof obj.miterLimit !== "number" || !Number.isFinite(obj.miterLimit) || obj.miterLimit < 1 || obj.miterLimit > 64 ||
      !Array.isArray(obj.widthProfile) || obj.widthProfile.length > 64) {
    throw new Error("Invalid Rust outline stroke style");
  }
  let previous = -1;
  const widthProfile = obj.widthProfile.map((station): { position: number; widthMultiplier: number } => {
    const point = record(station, "outline width station");
    keys(point, ["position", "widthMultiplier"], "outline width station");
    if (typeof point.position !== "number" || !Number.isFinite(point.position) || point.position < 0 || point.position > 1 ||
        point.position < previous || typeof point.widthMultiplier !== "number" || !Number.isFinite(point.widthMultiplier) ||
        point.widthMultiplier < 0 || point.widthMultiplier > 8) {
      throw new Error("Invalid Rust outline width profile");
    }
    previous = point.position;
    return { position: point.position, widthMultiplier: point.widthMultiplier };
  });
  return {
    width: obj.width, color: obj.color, align: obj.align as RustOutlineStrokeStyle["align"],
    capStart: obj.capStart as RustOutlineStrokeStyle["capStart"], capEnd: obj.capEnd as RustOutlineStrokeStyle["capEnd"],
    join: obj.join as RustOutlineStrokeStyle["join"], dash: obj.dash as number[], dashOffset: obj.dashOffset,
    miterLimit: obj.miterLimit, widthProfile,
  };
}

function outlineValue(value: unknown): RustOutlineChange {
  const obj = record(value, "outline layer delta");
  const kind = obj.kind;
  const extra = kind === "rect" ? ["radius"] : kind === "arc" ? ["start", "end", "ratio"] :
    kind === "poly" ? ["count"] : kind === "star" ? ["count", "ratio"] : kind === "vector" ? ["path"] : [];
  keys(obj, ["id", "name", "x", "y", "w", "h", "kind", ...extra, "fill", "stroke"], "outline layer delta");
  const node = nodeValue({ id: obj.id, name: obj.name, x: obj.x, y: obj.y, w: obj.w, h: obj.h });
  // `line` keeps an endpoint delta in w/h, so a horizontal or vertical
  // source legitimately has one zero (or a negative direction) component.
  // The outlined vector returned on apply still has a positive bounding box.
  const invalidDimensions = kind === "line"
    ? node === null || (node.w === 0 && node.h === 0)
    : node === null || node.w <= 0 || node.h <= 0;
  if (!node || node.id.length > 256 || node.name.length > 1024 || invalidDimensions ||
      [node.x, node.y, node.w, node.h].some(n => Math.abs(n) > OUTLINE_COORD_LIMIT) ||
      !(obj.fill === null || typeof obj.fill === "string" && /^#[0-9a-f]{6}$/.test(obj.fill))) {
    throw new Error("Invalid Rust outline layer");
  }
  const stroke = obj.stroke === null ? null : outlineStrokeValue(obj.stroke);
  if (kind === "rect") {
    if (typeof obj.radius !== "number" || !Number.isFinite(obj.radius) || obj.radius < 0 ||
        obj.radius > Math.min(node.w, node.h) / 2) throw new Error("Invalid Rust outline radius");
    return { ...node, kind, radius: obj.radius, fill: obj.fill, stroke };
  }
  if (kind === "ellipse" || kind === "line") return { ...node, kind, fill: obj.fill, stroke };
  if (kind === "arc") {
    if (![obj.start, obj.end, obj.ratio].every(v => typeof v === "number" && Number.isFinite(v)) ||
        (obj.ratio as number) < 0 || (obj.ratio as number) > 1) throw new Error("Invalid Rust outline arc");
    return { ...node, kind, start: obj.start as number, end: obj.end as number, ratio: obj.ratio as number, fill: obj.fill, stroke };
  }
  if (kind === "poly" || kind === "star") {
    if (!Number.isSafeInteger(obj.count) || (obj.count as number) < 3 || (obj.count as number) > 256 ||
        (kind === "star" && (typeof obj.ratio !== "number" || !Number.isFinite(obj.ratio) ||
          (obj.ratio as number) < 0.05 || (obj.ratio as number) > 0.95))) throw new Error("Invalid Rust outline polygon");
    return kind === "poly" ? { ...node, kind, count: obj.count as number, fill: obj.fill, stroke } :
      { ...node, kind, count: obj.count as number, ratio: obj.ratio as number, fill: obj.fill, stroke };
  }
  if (kind !== "vector") throw new Error("Invalid Rust outline kind");
  return { ...node, kind, path: outlinePathValue(obj.path), fill: obj.fill, stroke };
}

function stateValue(json: string): RustStateChange {
  const obj = record(JSON.parse(json) as unknown, "session delta");
  keys(obj, ["revision", "node", "canUndo", "canRedo", ...(obj.boolean === undefined ? [] : ["boolean"]),
    ...(obj.stroke === undefined ? [] : ["stroke"]), ...(obj.offset === undefined ? [] : ["offset"]),
    ...(obj.outline === undefined ? [] : ["outline"])], "session delta");
  if (typeof obj.revision !== "number" || !Number.isSafeInteger(obj.revision) || obj.revision < 0 ||
      typeof obj.canUndo !== "boolean" || typeof obj.canRedo !== "boolean" ||
      (obj.boolean !== undefined && (obj.node !== null || obj.stroke !== undefined || obj.offset !== undefined || obj.outline !== undefined)) ||
      (obj.offset !== undefined && (obj.node !== null || obj.stroke !== undefined || obj.outline !== undefined)) ||
      (obj.outline !== undefined && (obj.node !== null || obj.stroke !== undefined || obj.offset !== undefined))) {
    throw new Error("Invalid Rust session delta");
  }
  return {
    revision: obj.revision,
    node: nodeValue(obj.node),
    canUndo: obj.canUndo,
    canRedo: obj.canRedo,
    ...(obj.boolean === undefined ? {} : { boolean: booleanValue(obj.boolean) }),
    ...(obj.stroke === undefined ? {} : { stroke: strokeValue(obj.stroke) }),
    ...(obj.offset === undefined ? {} : { offset: offsetValue(obj.offset) }),
    ...(obj.outline === undefined ? {} : { outline: outlineValue(obj.outline) }),
  };
}

export class RustSessionClient {
  private binding: WasmDocumentSession | null;

  constructor(binding: WasmDocumentSession) {
    // The version handshake alone is not enough if an optional asset was
    // partially deployed. Do not hand an incomplete Rust owner to the UI.
    const methods = ["state", "getNode", "getShape", "renameNode", "moveNode", "resizeNode", "booleanNode", "strokeNode", "previewOffset", "offsetNode", "outlineStroke",
      "undo", "redo", "exportX", "free"] as const;
    if (methods.some(method => typeof binding[method] !== "function")) {
      if (typeof binding.free === "function") auditRustCall("x-wasm.RustDocumentSession.free", () => binding.free());
      throw new Error("Incomplete Rust command-session ABI");
    }
    this.binding = binding;
    openSessions++;
  }
  private current(): WasmDocumentSession {
    if (!this.binding) throw new Error("Rust document session has been closed");
    return this.binding;
  }
  private native<T>(method: string, invoke: (binding: WasmDocumentSession) => T): T {
    const binding = this.current(); // JS-side use-after-close is NOT a Rust call.
    return auditRustCall(`x-wasm.RustDocumentSession.${method}`, () => invoke(binding));
  }
  state(): RustStateChange { return stateValue(this.native("state", b => b.state())); }
  getNode(id: string): RustNodeChange | null { return nodeValue(JSON.parse(this.native("getNode", b => b.getNode(id))) as unknown); }
  getShape(id: string): RustOffsetChange { return offsetValue(JSON.parse(this.native("getShape", b => b.getShape(id))) as unknown); }
  renameNode(id: string, name: string): RustStateChange { return stateValue(this.native("renameNode", b => b.renameNode(id, name))); }
  moveNode(id: string, dx: number, dy: number): RustStateChange { return stateValue(this.native("moveNode", b => b.moveNode(id, dx, dy))); }
  resizeNode(id: string, w: number, h: number): RustStateChange { return stateValue(this.native("resizeNode", b => b.resizeNode(id, w, h))); }
  booleanNode(first: string, second: string, op: BooleanOp): RustStateChange {
    return stateValue(this.native("booleanNode", b => b.booleanNode(first, second, op)));
  }
  strokeNode(id: string, width: number, color: string, align: RustStrokeChange["align"], join: RustStrokeChange["join"]): RustStateChange {
    return stateValue(this.native("strokeNode", b => b.strokeNode(id, width, color, align, join)));
  }
  previewOffset(id: string, distance: number, join: "miter" | "bevel" | "round"): RustOffsetChange | null {
    const value: unknown = JSON.parse(this.native("previewOffset", b => b.previewOffset(id, distance, join)));
    return value === null ? null : offsetValue(value);
  }
  offsetNode(id: string, distance: number, join: "miter" | "bevel" | "round"): RustStateChange {
    return stateValue(this.native("offsetNode", b => b.offsetNode(id, distance, join)));
  }
  outlineStroke(id: string): RustStateChange {
    return stateValue(this.native("outlineStroke", b => b.outlineStroke(id)));
  }
  undo(): RustStateChange { return stateValue(this.native("undo", b => b.undo())); }
  redo(): RustStateChange { return stateValue(this.native("redo", b => b.redo())); }
  /** A complete .x document is returned ONLY at an explicit save. */
  exportX(): string { return this.native("exportX", b => b.exportX()); }

  /** Phase 9: Export a node to PNG/JPG/PDF via the Rust raster pipeline.
   *  Returns a Uint8Array of the encoded file bytes, suitable for creating
   *  a Blob for download. Much higher quality than canvas.toDataURL. */
  async exportNode(id: string, format: "png" | "jpg" | "pdf", scale: number): Promise<Uint8Array> {
    const binding = this.current();
    if (!binding.exportNode) {
      throw new Error("Rust export not available in this bridge version");
    }
    const raw = this.native("exportNode", () => binding.exportNode!(id, format, scale));
    const result = JSON.parse(raw) as { ok: boolean; bytes?: string; width?: number; height?: number; format?: string; error?: string };
    if (!result.ok || !result.bytes) {
      throw new Error(result.error ?? "Rust export failed");
    }
    const binaryStr = atob(result.bytes);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
  }

  /** Phase 9: Add a point to an existing vector segment. Atomic undo. */
  vectorAddPoint(id: string, segmentIdx: number, x: number, y: number): RustStateChange {
    const binding = this.current();
    if (!binding.vectorAddPoint) {
      throw new Error("Rust vector editing not available in this bridge version");
    }
    return stateValue(this.native("vectorAddPoint", () => binding.vectorAddPoint!(id, segmentIdx, x, y)));
  }

  /** Phase 9: Convert a corner ↔ smooth point. Atomic undo. */
  vectorConvertPoint(id: string, anchorIdx: number): RustStateChange {
    const binding = this.current();
    if (!binding.vectorConvertPoint) {
      throw new Error("Rust vector editing not available in this bridge version");
    }
    return stateValue(this.native("vectorConvertPoint", () => binding.vectorConvertPoint!(id, anchorIdx)));
  }

  /** Phase 10: Commit a pen-drawn path as a vector node with smooth bezier
   *  curves. ONE atomic undo step. Points is an array of [x, y] pairs. */
  commitPenPath(parentId: string, points: [number, number][]): RustStateChange {
    const binding = this.current();
    if (!binding.commitPenPath) {
      throw new Error("Rust pen commit not available in this bridge version");
    }
    const json = JSON.stringify(points);
    return stateValue(this.native("commitPenPath", () => binding.commitPenPath!(parentId, json)));
  }

  /** Phase 10: Commit a pencil stroke with RDP simplification and Catmull-Rom
   *  bezier fitting. ONE atomic undo step. */
  smoothPencilPath(parentId: string, points: [number, number][], tolerance: number): RustStateChange {
    const binding = this.current();
    if (!binding.smoothPencilPath) {
      throw new Error("Rust pencil smoothing not available in this bridge version");
    }
    const json = JSON.stringify(points);
    return stateValue(this.native("smoothPencilPath", () => binding.smoothPencilPath!(parentId, json, tolerance)));
  }

  /** Phase 10: Erase geometry from a vector node along a stroke path.
   *  ONE atomic undo step. */
  eraseGeometry(targetId: string, erasePoints: [number, number][], radius: number): RustStateChange {
    const binding = this.current();
    if (!binding.eraseGeometry) {
      throw new Error("Rust eraser not available in this bridge version");
    }
    const json = JSON.stringify(erasePoints);
    return stateValue(this.native("eraseGeometry", () => binding.eraseGeometry!(targetId, json, radius)));
  }

  close(): void {
    const binding = this.binding;
    this.binding = null;
    if (binding) {
      openSessions--;
      auditRustCall("x-wasm.RustDocumentSession.free", () => binding.free());
    }
  }
}

/** No fallback to a second JS command engine: callers must keep their
 * existing engine until a native .x document can be opened without loss.
 * Invalid .x throws, while a missing/older optional artifact returns null. */
export async function openRustSession(x: string, signal?: AbortSignal): Promise<RustSessionClient | null> {
  // The optional bridge can take time to download. A route that was left while
  // it loaded must not create a second Rust history when initialization ends.
  if (signal?.aborted || !(await initWasmBridge()) || signal?.aborted) return null;
  const Session = rustSessionConstructor();
  return Session ? new RustSessionClient(auditRustCall("x-wasm.RustDocumentSession.new", () => new Session(x))) : null;
}
