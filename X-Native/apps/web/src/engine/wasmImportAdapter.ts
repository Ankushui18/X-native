/** Rust .x v1 is NOT the web persisted document or ImportedNode schema.
 * Convert the supported interchange subset explicitly; reject a whole import
 * on unknown visual data, so the original TS parser can recover the file. */
import type { ImportedNode, ImportResult } from "./svgImport";
import type { PathPoint, VectorNetwork } from "./types";

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid Rust document object");
  return v as Obj;
};
const number = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("Invalid Rust document number");
  return v;
};
const text = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("Invalid Rust document string");
  return v;
};
function keys(v: Obj, allowed: string[]) {
  const unsupported = Object.keys(v).filter((k) => !allowed.includes(k));
  if (unsupported.length) throw new Error(`Unsupported Rust document properties: ${unsupported.join(", ")}`);
}
function paint(v: unknown): string {
  const p = object(v);
  keys(p, ["t", "c"]);
  if (p.t !== "solid" || typeof p.c !== "string" || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(p.c)) {
    throw new Error("Unsupported Rust paint; use TS importer");
  }
  return p.c;
}
function vector(v: unknown): { path: PathPoint[]; vectorNetwork: VectorNetwork; closed: boolean } {
  if (!Array.isArray(v) || v.length > 100_000) throw new Error("Invalid Rust path");
  const vertices: VectorNetwork["vertices"] = [], segments: VectorNetwork["segments"] = [], loops: number[][] = [];
  let start = -1, last = -1, loop: number[] = [], closed = false;
  for (const cmd of v) {
    if (!Array.isArray(cmd)) throw new Error("Invalid Rust path command");
    const [op, ...raw] = cmd, nums = raw.map(number);
    if (op === "M" && nums.length === 2) {
      start = last = vertices.length; vertices.push({ x: nums[0], y: nums[1] }); loop = [start];
    } else if ((op === "L" && nums.length === 2 || op === "C" && nums.length === 6) && last >= 0) {
      const end = vertices.length, x = nums[nums.length - 2], y = nums[nums.length - 1];
      vertices.push({ x, y });
      segments.push({ start: last, end, ...(op === "C" ? {
        tangentStart: { x: nums[0] - vertices[last].x, y: nums[1] - vertices[last].y },
        tangentEnd: { x: nums[2] - x, y: nums[3] - y },
      } : {}) });
      last = end; loop.push(end);
    } else if (op === "Z" && nums.length === 0 && start >= 0) {
      segments.push({ start: last, end: start }); loops.push(loop); closed = true; start = last = -1;
    } else throw new Error("Unsupported Rust path command");
  }
  // The network is authoritative for disconnected contours. The legacy path
  // is only the first contour, never a flattened connection between contours.
  const path: PathPoint[] = [];
  const edges = new Map(segments.map((s) => [s.start, s]));
  if (vertices.length) {
    let cur = 0;
    const indices = new Map<number, number>();
    while (!indices.has(cur)) {
      indices.set(cur, path.length);
      path.push({ ...vertices[cur] });
      const edge = edges.get(cur);
      if (!edge) break;
      if (edge.tangentStart) Object.assign(path[path.length - 1], { ox: edge.tangentStart.x, oy: edge.tangentStart.y });
      cur = edge.end;
    }
    for (const vertex of indices.keys()) {
      const edge = edges.get(vertex), endIndex = edge && indices.get(edge.end);
      if (edge?.tangentEnd && endIndex !== undefined) {
        Object.assign(path[endIndex], { ix: edge.tangentEnd.x, iy: edge.tangentEnd.y });
      }
    }
  }
  return { path, vectorNetwork: { vertices, segments, regions: loops.length ? [{ windingRule: "NONZERO", loops }] : undefined }, closed };
}

export function decodeRustImport(payload: string): ImportResult {
  const envelope = object(JSON.parse(payload));
  if (envelope.ok !== true) throw new Error(typeof envelope.error === "string" ? envelope.error : "Rust importer declined");
  const doc = object(envelope.doc);
  if (doc.format !== "x-native" || doc.version !== 1 || !Array.isArray(doc.pages) || !doc.pages.length) {
    throw new Error("Unsupported Rust document schema");
  }
  // Resource-bearing documents must be handled by the existing importer until
  // their assets/styles/variables have a lossless web mapping.
  for (const key of ["assets", "styles", "components", "libraries"]) {
    const value = doc[key];
    if (value && typeof value === "object" && Object.keys(value).length) throw new Error(`Unsupported Rust ${key}`);
  }
  if (doc.variables != null) {
    const vars = object(doc.variables);
    keys(vars, ["colors", "numbers", "strings", "bools", "collections", "modes", "num_modes", "str_modes", "bool_modes"]);
    for (const table of Object.values(vars)) {
      if (Object.keys(object(table)).length) throw new Error("Unsupported Rust variables");
    }
  }
  // Native Node.h is font size for text, NOT its source bounding-box height.
  // Old glue (and SVG without explicit metrics) must continue to fall back.
  let textMetrics: Obj = {};
  if (envelope.textMetrics != null) {
    const metadata = object(envelope.textMetrics);
    keys(metadata, ["version", "nodes"]);
    if (metadata.version !== 1) throw new Error("Unsupported Rust text metrics version");
    textMetrics = object(metadata.nodes);
  }
  const usedMetrics = new Set<string>();
  let count = 0;
  function convert(value: unknown, depth = 0): ImportedNode {
    if (++count > 100_000 || depth > 256) throw new Error("Rust import exceeds document limits");
    const n = object(value), kind = object(n.kind);
    keys(n, ["id", "name", "kind", "x", "y", "w", "h", "rotation", "opacity", "visible", "locked", "fill", "stroke", "children", "corners", "smoothing", "overflow", "origin", ...(kind.t === "text" ? ["bindings", "text_align"] : [])]);
    keys(kind, kind.t === "text" ? ["t", "text"] : ["t", "radius", "path"]);
    if (!["rect", "ellipse", "line", "frame", "group", "vector", "text"].includes(String(kind.t))) {
      throw new Error("Unsupported Rust layer kind; use TS importer");
    }
    const fill = paint(n.fill);
    const out: ImportedNode = {
      kind: kind.t as ImportedNode["kind"], name: text(n.name ?? n.id),
      x: number(n.x), y: number(n.y), w: number(n.w), h: number(n.h),
      // Native Transform serializes radians; the web import contract is degrees.
      rotation: number(number(n.rotation) * 180 / Math.PI), opacity: number(n.opacity),
      fill, fillVisible: fill.length !== 9 || !fill.endsWith("00"), strokePaint: "#00000000", strokeWidth: 0, strokeVisible: false,
      hidden: n.visible === false, locked: n.locked === true,
    };
    if (kind.t === "text") {
      const id = text(n.id);
      if (!Object.prototype.hasOwnProperty.call(textMetrics, id) || usedMetrics.has(id)) throw new Error("Missing or duplicate Rust source text metrics");
      usedMetrics.add(id);
      const metrics = object(textMetrics[id]); keys(metrics, ["width", "height", "fontSize"]);
      out.w = number(metrics.width); out.h = number(metrics.height);
      out.fontSize = number(metrics.fontSize);
      if (out.fontSize <= 0 || out.fontSize !== number(n.h) || out.w !== number(n.w)) throw new Error("Invalid Rust source text metrics");
      out.text = text(kind.text);
      // No inferred weight from PostScript names. Unsupported source styling
      // still fails the whole-result TS comparison in wasmBridge.choose.
      out.fontWeight = 400;
      const align = n.text_align ?? "left";
      if (align !== "left" && align !== "center" && align !== "right") throw new Error("Unsupported Rust text alignment");
      out.textAlign = align;
      if (n.bindings != null) {
        const bindings = object(n.bindings); keys(bindings, ["font", "lh", "ls"]);
        const literalNumber = (v: unknown) => {
          const raw = text(v);
          if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error("Invalid Rust typography literal");
          return number(Number(raw));
        };
        if (bindings.font !== undefined) {
          out.fontFamily = text(bindings.font);
          if (!out.fontFamily.trim()) throw new Error("Invalid Rust font family");
        }
        if (bindings.lh !== undefined) {
          const ratio = literalNumber(bindings.lh);
          if (ratio <= 0) throw new Error("Invalid Rust line height");
          out.lineHeight = number(ratio * out.fontSize); // native ratio → web px
        }
        if (bindings.ls !== undefined) out.letterSpacing = literalNumber(bindings.ls);
      }
    }
    if (out.w < 0 || out.h < 0 || out.opacity < 0 || out.opacity > 1) throw new Error("Invalid Rust layer dimensions/opacity");
    if (n.origin != null) {
      if (!Array.isArray(n.origin) || n.origin.length !== 2) throw new Error("Invalid Rust origin");
      // The native SVG lowering uses a top-left pivot; web imported nodes
      // rotate about their center. Rebase translation so the affine is equal:
      // t_web = t_native + (pivot_native - center) - R(pivot_native - center).
      const dx = number((number(n.origin[0]) - 0.5) * out.w);
      const dy = number((number(n.origin[1]) - 0.5) * out.h);
      const a = number(n.rotation), c = Math.cos(a), s = Math.sin(a);
      out.x = number(out.x + dx - (c * dx - s * dy));
      out.y = number(out.y + dy - (s * dx + c * dy));
    }
    if (n.stroke != null) {
      const stroke = object(n.stroke); keys(stroke, ["color", "width"]);
      out.strokePaint = paint({ t: "solid", c: stroke.color }); out.strokeWidth = number(stroke.width);
      if (out.strokeWidth < 0) throw new Error("Invalid Rust stroke width");
      out.strokeVisible = out.strokeWidth > 0;
    }
    if (kind.radius != null && number(kind.radius) !== 0) out.cornerRadii = Array(4).fill(number(kind.radius)) as [number, number, number, number];
    if (n.corners != null) {
      if (!Array.isArray(n.corners) || n.corners.length !== 4) throw new Error("Invalid Rust corners");
      const [tl, tr, br, bl] = n.corners.map(number);
      out.cornerRadii = [tl, tr, bl, br]; out.cornerIndependent = true;
    }
    if (n.smoothing != null) out.cornerSmoothing = number(n.smoothing);
    if (n.overflow != null) {
      if (n.overflow !== "clip" && n.overflow !== "visible") throw new Error("Unsupported Rust overflow");
      out.overflow = n.overflow;
    }
    if (kind.t === "vector") Object.assign(out, vector(kind.path));
    if (n.children != null) {
      if (!Array.isArray(n.children)) throw new Error("Invalid Rust children");
      out.children = n.children.map((c) => convert(c, depth + 1));
    }
    return out;
  }
  const roots = doc.pages.map((p) => convert(p));
  if (usedMetrics.size !== Object.keys(textMetrics).length) throw new Error("Unused Rust source text metrics");
  const pages = roots.map((p) => ({ name: p.name, nodes: p.children ?? [] }));
  return { nodes: pages[0].nodes, pages, width: roots[0].w, height: roots[0].h, skipped: 0 };
}
