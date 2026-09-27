/** Rust .x v1 is NOT the web persisted document or ImportedNode schema.
 * Convert the supported interchange subset explicitly; reject a whole import
 * on unknown visual data, so the original TS parser can recover the file. */
import type { ImportedNode, ImportResult } from "./svgImport";
import type { Effect, PathPoint, VectorNetwork } from "./types";

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
const blendLabels: Record<string, string> = {
  normal: "Normal", darken: "Darken", multiply: "Multiply", "color-burn": "Color Burn",
  lighten: "Lighten", screen: "Screen", "color-dodge": "Color Dodge", overlay: "Overlay",
  "soft-light": "Soft Light", "hard-light": "Hard Light", difference: "Difference", exclusion: "Exclusion",
  hue: "Hue", saturation: "Saturation", color: "Color", luminosity: "Luminosity",
  "plus-darker": "Plus Darker", "plus-lighter": "Plus Lighter", "pass-through": "pass-through",
};
function figmaAppearance(n: Obj, out: ImportedNode, value: unknown) {
  const a = object(value); keys(a, ["fill", "blend", "effectCount", "uniformCorners"]);
  if (a.fill !== "none" && a.fill !== "solid") throw new Error("Unsupported FIG source fill");
  if (a.fill === "solid") {
    if (out.fill.length !== 7 && !out.fill.toLowerCase().endsWith("ff")) throw new Error("FIG solid paint is not opaque");
    out.fillType = "solid";
  } else {
    // Native text/frame defaults are rendering fallbacks, not source paints.
    // The versioned source fact is authoritative only after native stack checks.
    out.fill = "#00000000"; out.fillVisible = false;
  }
  let blend = "pass-through";
  if (a.blend !== null) {
    const mode = text(a.blend).toLowerCase().replaceAll("_", "-");
    if (!Object.prototype.hasOwnProperty.call(blendLabels, mode)) throw new Error("Unsupported FIG source blend");
    blend = blendLabels[mode];
    if ((out.blendMode ?? "Normal") !== blend) throw new Error("FIG source/native blend mismatch");
  } else if (n.blend !== undefined) throw new Error("FIG source/native blend mismatch");
  out.blendMode = blend;
  const count = number(a.effectCount);
  if (!Number.isInteger(count) || count < 0 || count > 10_000 || count !== (out.effects?.length ?? 0)) throw new Error("FIG source/native effect count mismatch");
  if (count === 0) out.effects = [];
  if (typeof a.uniformCorners !== "boolean") throw new Error("Invalid FIG corner metadata");
  if (a.uniformCorners) {
    if (out.kind !== "rect" || n.corners !== undefined) throw new Error("FIG source/native corners mismatch");
    out.cornerRadii ??= [0, 0, 0, 0]; out.cornerIndependent = false;
  }
}

/** Source-only fields are restored only after the visible native projection
 * agrees exactly. Hidden source entries have no native enum counterpart. */
function sourceEffects(value: unknown, native: Effect[]): Effect[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Invalid FIG source effects");
  const result = value.map((value): Effect => {
    const e = object(value);
    keys(e, ["kind", "color", "x", "y", "blur", "spread", "visible", "blend", "showBehind"]);
    if (e.kind !== "drop-shadow" && e.kind !== "inner-shadow" && e.kind !== "layer-blur" && e.kind !== "background-blur") throw new Error("Unsupported FIG source effect");
    const color = paint({ t: "solid", c: e.color }), x = number(e.x), y = number(e.y), blur = number(e.blur), spread = number(e.spread);
    if (blur < 0 || typeof e.visible !== "boolean" || typeof e.showBehind !== "boolean") throw new Error("Invalid FIG source effect values");
    if ((e.kind === "layer-blur" || e.kind === "background-blur") && (x !== 0 || y !== 0)) throw new Error("Invalid FIG blur offset");
    let blend: string | undefined;
    if (e.blend !== null) {
      const mode = text(e.blend).toLowerCase().replaceAll("_", "-");
      if (!Object.prototype.hasOwnProperty.call(blendLabels, mode)) throw new Error("Unsupported FIG effect blend");
      blend = blendLabels[mode];
    }
    return { kind: e.kind, color, x, y, blur, spread, visible: e.visible, blend, showBehind: e.showBehind };
  });
  const projection = result.filter(e => e.visible);
  if (projection.length !== native.length || projection.some((e, i) => {
    const n = native[i], isBlur = e.kind === "layer-blur" || e.kind === "background-blur";
    return n.kind !== e.kind || n.color !== (isBlur ? "#00000000" : e.color)
      || n.x !== e.x || n.y !== e.y || n.blur !== e.blur || n.spread !== 0 || n.visible !== true;
  })) throw new Error("FIG source/native effect projection mismatch");
  return result;
}

function effects(v: unknown): Effect[] {
  if (!Array.isArray(v) || v.length > 10_000) throw new Error("Invalid Rust effect list");
  return v.map((value): Effect => {
    const e = object(value);
    if (e.t === "drop" || e.t === "inner") {
      keys(e, ["t", "dx", "dy", "blur", "c"]);
      const blur = number(e.blur);
      if (blur < 0) throw new Error("Invalid Rust shadow blur");
      // These are the native enum's effective values, not guessed source
      // spread/visibility/blend. Source-only differences still fail choose().
      return { kind: e.t === "drop" ? "drop-shadow" : "inner-shadow", color: paint({ t: "solid", c: e.c }),
        x: number(e.dx), y: number(e.dy), blur, spread: 0, visible: true };
    }
    if (e.t === "blur" || e.t === "bgblur") {
      keys(e, ["t", "r"]);
      const blur = number(e.r);
      if (blur < 0) throw new Error("Invalid Rust blur radius");
      return { kind: e.t === "blur" ? "layer-blur" : "background-blur", color: "#00000000",
        x: 0, y: 0, blur, spread: 0, visible: true };
    }
    throw new Error("Unsupported Rust effect");
  });
}

/** Narrow identity mapping for materialized stacks created by native stroke
 * options. Never flatten multiple paints or ignore stack overrides of legacy
 * fields. The import contract has only one symmetric stroke and a dash pair. */
function simpleStacks(n: Obj, out: ImportedNode) {
  if (!Array.isArray(n.fill_layers) || !Array.isArray(n.stroke_layers) || !Array.isArray(n.effect_layers)
    || n.fill_layers.length !== 1 || n.stroke_layers.length > 1 || n.effect_layers.length > 10_000) {
    throw new Error("Unsupported Rust visual stacks");
  }
  const identity = (layer: Obj) => {
    if (layer.opacity !== 1 || layer.visible !== true || layer.blend !== "normal") throw new Error("Unsupported Rust stack compositing");
  };
  const fill = object(n.fill_layers[0]); keys(fill, ["paint", "opacity", "visible", "blend"]); identity(fill);
  if (paint(fill.paint) !== out.fill) throw new Error("Rust fill stack overrides legacy paint");
  const activeEffects = n.effect_layers.map((value) => {
    const layer = object(value); keys(layer, ["effect", "opacity", "visible", "blend"]); identity(layer);
    return effects([layer.effect])[0];
  });
  if (JSON.stringify(activeEffects) !== JSON.stringify(out.effects ?? [])) throw new Error("Rust effect stack overrides legacy effects");
  if (!n.stroke_layers.length) {
    if (n.stroke != null) throw new Error("Rust empty stroke stack overrides legacy stroke");
    return;
  }
  if (n.stroke == null) throw new Error("Rust stroke stack has no matching legacy stroke");
  const stroke = object(n.stroke_layers[0]);
  keys(stroke, ["color", "width", "opacity", "visible", "blend", "align", "cap_start", "cap_end", "join", "dash", "dash_offset", "miter"]);
  identity(stroke);
  if (paint({ t: "solid", c: stroke.color }) !== out.strokePaint || number(stroke.width) !== out.strokeWidth) throw new Error("Rust stroke stack overrides legacy stroke");
  const align = stroke.align, cap = stroke.cap_start, join = stroke.join;
  if (align !== "inside" && align !== "center" && align !== "outside") throw new Error("Unsupported Rust stroke alignment");
  if ((cap !== "none" && cap !== "round" && cap !== "square") || cap !== stroke.cap_end) throw new Error("Unsupported Rust stroke caps");
  if (join !== "miter" && join !== "bevel" && join !== "round") throw new Error("Unsupported Rust stroke join");
  if (stroke.dash_offset !== 0 || stroke.miter !== 4) throw new Error("Unsupported Rust stroke phase/miter");
  if (!Array.isArray(stroke.dash) || stroke.dash.length > 2) throw new Error("Unsupported Rust dash pattern");
  const dash = stroke.dash.map(number);
  if (dash.some((v) => v <= 0)) throw new Error("Unsupported Rust dash segment");
  out.strokeAlign = align; out.strokeCap = cap; out.strokeJoin = join;
  if (dash.length) { out.strokeDash = dash[0]; out.strokeGap = dash[1] ?? dash[0]; }
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
  keys(envelope, ["ok", "doc", "textMetrics", "figmaCoordinates", "figmaAppearance", "figmaEffects"]);
  const doc = object(envelope.doc);
  // The .x serializer can add fields without bumping its v1 version. Never
  // turn an unknown document capability into a seemingly complete web import.
  keys(doc, ["format", "version", "pages", "default_font", "variables", "styles", "component_props", "comments", "assets", "libraries"]);
  if (doc.format !== "x-native" || doc.version !== 1 || !Array.isArray(doc.pages) || !doc.pages.length) {
    throw new Error("Unsupported Rust document schema");
  }
  if (doc.default_font !== undefined) throw new Error("Unsupported Rust default_font");
  // Even an empty resource section must have the right native container type:
  // a scalar/null here is not evidence that the source has no resources.
  for (const key of ["styles", "component_props"] as const) {
    if (doc[key] === undefined) continue;
    const value = doc[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Rust ${key}`);
    if (Object.keys(value).length) throw new Error(`Unsupported Rust ${key}`);
  }
  for (const key of ["assets", "libraries", "comments"] as const) {
    const value = doc[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error(`Invalid Rust ${key}`);
    if (value.length) throw new Error(`Unsupported Rust ${key}`);
  }
  if (doc.variables !== undefined) {
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
  // FIG's native editor normalizes each page near (40,40). Only explicit
  // versioned metadata can restore exact original top-level translations;
  // never infer offsets from native bounds or borrow coordinates from TS.
  let figmaPositions: Obj | null = null;
  if (envelope.figmaCoordinates !== undefined) {
    const metadata = object(envelope.figmaCoordinates);
    keys(metadata, ["version", "nodes"]);
    if (metadata.version !== 1) throw new Error("Unsupported FIG coordinate metadata version");
    figmaPositions = object(metadata.nodes);
  }
  let appearanceNodes: Obj | null = null;
  if (envelope.figmaAppearance !== undefined) {
    const metadata = object(envelope.figmaAppearance); keys(metadata, ["version", "images", "nodes"]);
    if (metadata.version !== 1 || metadata.images !== 0 || figmaPositions === null) throw new Error("Unsupported FIG appearance metadata");
    appearanceNodes = object(metadata.nodes);
  }
  let effectNodes: Obj | null = null;
  if (envelope.figmaEffects !== undefined) {
    const metadata = object(envelope.figmaEffects); keys(metadata, ["version", "nodes"]);
    if (metadata.version !== 1 || appearanceNodes === null) throw new Error("Unsupported FIG effects metadata");
    effectNodes = object(metadata.nodes);
  }
  const usedEffects = new Set<string>();
  const usedAppearance = new Set<string>();
  const usedPositions = new Set<string>();
  const usedMetrics = new Set<string>();
  let count = 0;
  function convert(value: unknown, depth = 0): ImportedNode {
    if (++count > 100_000 || depth > 256) throw new Error("Rust import exceeds document limits");
    const n = object(value), kind = object(n.kind);
    keys(n, ["id", "name", "kind", "x", "y", "w", "h", "rotation", "opacity", "visible", "locked", "fill", "stroke", "children", "corners", "smoothing", "overflow", "origin", "fill_layers", "stroke_layers", "effect_layers", "effects", "blend", ...(kind.t === "text" ? ["bindings", "text_align"] : [])]);
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
    if (figmaPositions !== null && depth === 1) {
      const id = text(n.id);
      if (!Object.prototype.hasOwnProperty.call(figmaPositions, id) || usedPositions.has(id)) throw new Error("Missing or duplicate FIG source position");
      usedPositions.add(id);
      const position = object(figmaPositions[id]); keys(position, ["x", "y"]);
      out.x = number(position.x); out.y = number(position.y);
    }
    if (n.effects !== undefined) out.effects = effects(n.effects);
    if (n.blend !== undefined) {
      const mode = text(n.blend);
      if (!Object.prototype.hasOwnProperty.call(blendLabels, mode)) throw new Error("Unsupported Rust blend mode");
      out.blendMode = blendLabels[mode];
    }
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
      if (align !== "left" && align !== "center" && align !== "right" && align !== "justified") throw new Error("Unsupported Rust text alignment");
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
    if (n.fill_layers !== undefined || n.stroke_layers !== undefined || n.effect_layers !== undefined) simpleStacks(n, out);
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
    if (appearanceNodes !== null && depth > 0) {
      const id = text(n.id);
      if (!Object.prototype.hasOwnProperty.call(appearanceNodes, id) || usedAppearance.has(id)) throw new Error("Missing or duplicate FIG appearance metadata");
      usedAppearance.add(id);
      if (effectNodes !== null) {
        if (!Object.prototype.hasOwnProperty.call(effectNodes, id) || usedEffects.has(id)) throw new Error("Missing or duplicate FIG effect metadata");
        usedEffects.add(id);
        out.effects = sourceEffects(effectNodes[id], out.effects ?? []);
      }
      figmaAppearance(n, out, appearanceNodes[id]);
    }
    if (n.children != null) {
      if (!Array.isArray(n.children)) throw new Error("Invalid Rust children");
      out.children = n.children.map((c) => convert(c, depth + 1));
    }
    return out;
  }
  const roots = doc.pages.map((p) => convert(p));
  if (effectNodes !== null && usedEffects.size !== Object.keys(effectNodes).length) throw new Error("Unused FIG effect metadata");
  if (appearanceNodes !== null && usedAppearance.size !== Object.keys(appearanceNodes).length) throw new Error("Unused FIG appearance metadata");
  if (usedMetrics.size !== Object.keys(textMetrics).length) throw new Error("Unused Rust source text metrics");
  const pages = roots.map((p) => ({ name: p.name, nodes: p.children ?? [] }));
  if (figmaPositions !== null) {
    if (usedPositions.size !== Object.keys(figmaPositions).length) throw new Error("Unused FIG source positions");
    if (roots.some((p) => p.kind !== "frame" || p.x !== 0 || p.y !== 0 || p.rotation !== 0)) throw new Error("Unsupported FIG page transform");
    // The web FIG interchange contract measures untranslated content extents
    // across every page, including children that extend beyond their parent.
    // It does not use the native editor's minimum 800x600 page envelope.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function measure(list: ImportedNode[], ox: number, oy: number) {
      for (const n of list) {
        const x = number(ox + n.x), y = number(oy + n.y);
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, number(x + n.w)); maxY = Math.max(maxY, number(y + n.h));
        if (n.children) measure(n.children, x, y);
      }
    }
    for (const p of pages) measure(p.nodes, 0, 0);
    const width = minX === Infinity ? 1 : Math.max(1, number(maxX - minX));
    const height = minY === Infinity ? 1 : Math.max(1, number(maxY - minY));
    return { nodes: (pages.find((p) => p.nodes.length) ?? pages[0]).nodes, pages, width, height, skipped: 0, ...(appearanceNodes !== null ? { images: 0 } : {}) };
  }
  return { nodes: pages[0].nodes, pages, width: roots[0].w, height: roots[0].h, skipped: 0 };
}
