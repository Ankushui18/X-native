/**
 * Figma (.fig) import and binary inspection.
 *
 * A `.fig` is a ZIP whose `canvas.fig` entry is a `fig-kiwi` container:
 * 8-byte magic ("fig-kiwi"), u32 version, then length-prefixed chunks. Chunk 0 is the
 * compressed Kiwi schema (Figma ships its whole field dictionary in every
 * file, so the reader stays version-tolerant) and chunk 1 is the document
 * message. The container is also reachable on its own: Figma's ⌘C writes one,
 * base64'd, into the clipboard's `text/html` — `importFigContainer` is that
 * entry point, and it is what makes paste-from-Figma work.
 *
 * Supported: FRAME/SECTION/GROUP, RECTANGLE (+corner radius), ELLIPSE, LINE,
 * TEXT, COMPONENT/INSTANCE, solid fills and strokes, opacity, visibility,
 * rotation, absolute placement, and VECTOR/STAR/POLYGON geometry parsed directly
 * from commandsBlob and vectorNetworkBlob.
 */

import { Zip } from "./zip";
import { decodeSchema, Decoder, type KiwiValue } from "./kiwi";
import type { ImportedPage, ImportedNode, ImportedPaint, ImportResult } from "./svgImport";
import type { Effect, FillType, ImageFit, PathPoint, VectorNetwork, VectorSegment, VectorVertex } from "./types";
import { decompress as zstdDecompress } from "fzstd";
import { pathToVectorNetwork } from "./geometry";
import { rememberImage } from "./assets";

type J = Record<string, KiwiValue>;

const obj = (v: KiwiValue | undefined): J | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as J) : null;
const arr = (v: KiwiValue | undefined): KiwiValue[] => (Array.isArray(v) ? v : []);
const str = (v: KiwiValue | undefined): string | null => (typeof v === "string" ? v : null);
const numOf = (v: KiwiValue | undefined, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

/**
 * Inflate a container chunk. Figma writes raw DEFLATE or Zstandard (zstd).
 */
async function inflateChunk(data: Uint8Array): Promise<Uint8Array> {
  // zstd frame magic: 0x28, 0xb5, 0x2f, 0xfd
  if (data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) {
    return zstdDecompress(data);
  }
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error("this browser environment cannot decompress .fig chunks");
  for (const fmt of ["deflate-raw", "deflate"] as const) {
    try {
      const ds = new DS(fmt);
      const w = ds.writable.getWriter();
      void w.write(data as unknown as BufferSource);
      void w.close();
      return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    } catch {
      /* try next */
    }
  }
  throw new Error("could not decompress .fig chunk");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export interface FigmaPathCmd {
  type: "M" | "L" | "Q" | "C" | "Z";
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
}

/**
 * Parses Figma's binary `commandsBlob` into vector path commands.
 */
export function parseCommandsBlob(bytes: Uint8Array): FigmaPathCmd[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const cmds: FigmaPathCmd[] = [];
  while (p < bytes.byteLength) {
    const op = v.getUint8(p);
    p += 1;
    if (op === 0) {
      cmds.push({ type: "Z" });
    } else if (op === 1) {
      if (p + 8 > bytes.byteLength) break;
      const x = v.getFloat32(p, true); p += 4;
      const y = v.getFloat32(p, true); p += 4;
      cmds.push({ type: "M", x, y });
    } else if (op === 2) {
      if (p + 8 > bytes.byteLength) break;
      const x = v.getFloat32(p, true); p += 4;
      const y = v.getFloat32(p, true); p += 4;
      cmds.push({ type: "L", x, y });
    } else if (op === 3) {
      if (p + 16 > bytes.byteLength) break;
      const cx = v.getFloat32(p, true); p += 4;
      const cy = v.getFloat32(p, true); p += 4;
      const x = v.getFloat32(p, true); p += 4;
      const y = v.getFloat32(p, true); p += 4;
      cmds.push({ type: "Q", cx, cy, x, y });
    } else if (op === 4) {
      if (p + 24 > bytes.byteLength) break;
      const x1 = v.getFloat32(p, true); p += 4;
      const y1 = v.getFloat32(p, true); p += 4;
      const x2 = v.getFloat32(p, true); p += 4;
      const y2 = v.getFloat32(p, true); p += 4;
      const x = v.getFloat32(p, true); p += 4;
      const y = v.getFloat32(p, true); p += 4;
      cmds.push({ type: "C", x1, y1, x2, y2, x, y });
    } else {
      break;
    }
  }
  return cmds;
}

/**
 * Converts Figma path commands to `PathPoint[]`.
 */
export function figmaCommandsToPathPoints(cmds: FigmaPathCmd[]): { path: PathPoint[]; closed: boolean } {
  const path: PathPoint[] = [];
  let closed = false;
  for (const cmd of cmds) {
    if (cmd.type === "M" || cmd.type === "L") {
      path.push({ x: cmd.x!, y: cmd.y! });
    } else if (cmd.type === "C") {
      const prev = path[path.length - 1];
      if (prev) {
        prev.ox = cmd.x1! - prev.x;
        prev.oy = cmd.y1! - prev.y;
      }
      path.push({
        x: cmd.x!,
        y: cmd.y!,
        ix: cmd.x2! - cmd.x!,
        iy: cmd.y2! - cmd.y!,
      });
    } else if (cmd.type === "Q") {
      const prev = path[path.length - 1];
      const p0x = prev ? prev.x : 0;
      const p0y = prev ? prev.y : 0;
      const cx = cmd.cx!;
      const cy = cmd.cy!;
      const p1x = cmd.x!;
      const p1y = cmd.y!;
      const cp1x = p0x + (2 / 3) * (cx - p0x);
      const cp1y = p0y + (2 / 3) * (cy - p0y);
      const cp2x = p1x + (2 / 3) * (cx - p1x);
      const cp2y = p1y + (2 / 3) * (cy - p1y);
      if (prev) {
        prev.ox = cp1x - prev.x;
        prev.oy = cp1y - prev.y;
      }
      path.push({
        x: p1x,
        y: p1y,
        ix: cp2x - p1x,
        iy: cp2y - p1y,
      });
    } else if (cmd.type === "Z") {
      closed = true;
    }
  }
  return { path, closed };
}

/** Figma colours are 0..1 floats with separate paint-level opacity. */
function paintColor(paint: J | null): string | null {
  if (!paint) return null;
  if (paint.visible === false) return null;
  if (str(paint.type) && str(paint.type) !== "SOLID") return null;
  const c = obj(paint.color);
  if (!c) return null;
  const to = (x: KiwiValue | undefined) => Math.max(0, Math.min(255, Math.round(numOf(x) * 255)));
  const hex = `#${[to(c.r), to(c.g), to(c.b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  const a = numOf(c.a, 1) * numOf(paint.opacity, 1);
  return a >= 0.999 ? hex : `${hex}${Math.round(Math.max(0, a) * 255).toString(16).padStart(2, "0")}`;
}

function firstPaint(node: J, key: string): string | null {
  for (const p of arr(node[key])) {
    const c = paintColor(obj(p));
    if (c) return c;
  }
  return null;
}

export async function importFig(buf: ArrayBuffer): Promise<ImportResult> {
  const zip = new Zip(buf);
  const canvasName = zip.names().find((n) => n.endsWith("canvas.fig"));
  if (!canvasName) throw new Error("no canvas.fig entry in this .fig archive");
  return importFigContainer(await zip.read(canvasName), zip);
}

/** True when `bytes` start with the `fig-kiwi` prelude, so a caller can tell a
 *  Figma scene buffer from arbitrary base64 that happened to be on the
 *  clipboard before handing it to the (async, decompressing) importer. */
export function isFigKiwi(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 8)) === "fig-kiwi";
}

/**
 * Parse a bare `fig-kiwi` container — the same bytes a `.fig` archive carries
 * in its `canvas.fig` entry, but without the ZIP around them.
 *
 * This is exactly what Figma puts on the system clipboard when you ⌘C a layer:
 * the scene is serialised to a small Figma file, base64'd, and written into the
 * `data-buffer` attribute of an empty `<span>` inside `text/html` (see
 * `clipboard.ts`). Decoding that attribute therefore lands here, and a paste
 * from Figma gets the same reader — schema, chunk inflation, paint and vector
 * handling — as a `.fig` dropped on the canvas.
 *
 * `archive` is the ZIP the container came out of, when there was one: image
 * fills live beside the scene as separate `images/…` entries, so only a `.fig`
 * file can supply their bytes. A clipboard buffer is the container on its own
 * and has no such entries, so it is omitted and the layers import without them.
 */
export async function importFigContainer(canvas: Uint8Array, archive?: Zip): Promise<ImportResult> {
  const magic = new TextDecoder().decode(canvas.subarray(0, 8));
  if (canvas.length < 12 || magic !== "fig-kiwi") {
    throw new Error('not a fig-kiwi canvas (missing "fig-kiwi" prelude)');
  }

  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  const chunks: Uint8Array[] = [];
  let off = 12;
  while (off + 4 <= canvas.length) {
    const len = view.getUint32(off, true);
    off += 4;
    const end = off + len;
    if (end > canvas.length) throw new Error("truncated .fig chunk");
    chunks.push(canvas.subarray(off, end));
    off = end;
  }
  if (chunks.length < 2) throw new Error("fig-kiwi container has fewer than 2 chunks");

  const schema = decodeSchema(await inflateChunk(chunks[0]));
  const message = await inflateChunk(chunks[1]);

  const rootName = ["Message", "NodeChanges"].find((r) =>
    schema.defs.find((d) => d.name === r && d.fields.some((f) => f.name === "nodeChanges")),
  );
  if (!rootName) throw new Error("no nodeChanges root in the embedded schema");

  const dec = new Decoder(schema, message);
  const root = obj(dec.decodeRoot(rootName));
  const changes = arr(root?.nodeChanges);
  if (!changes.length) throw new Error("no nodes in this .fig file");

  const blobs = arr(root?.blobs).map((b) => obj(b) ?? {});

  const guidKey = (g: J | null): string | null =>
    g ? `${numOf(g.sessionID)}:${numOf(g.localID)}` : null;
  const guidOf = (nc: J): string | null => guidKey(obj(nc.guid));
  const merged = new Map<string, J>();
  for (const raw of changes) {
    const nc = obj(raw);
    if (!nc) continue;
    const id = guidOf(nc);
    if (!id) continue;
    if (str(nc.phase) === "REMOVED") {
      merged.delete(id);
      continue;
    }
    const prev = merged.get(id);
    merged.set(id, prev ? { ...prev, ...nc } : nc);
  }

  /* ------------------------------------------------------------- paints */

  /** Kiwi spellings are the menu labels in capitals: PASS_THROUGH, PLUS_DARKER. */
  const blendName = (v: KiwiValue | undefined): string | undefined => {
    const raw = str(v);
    if (!raw) return undefined;
    if (raw === "PASS_THROUGH") return "pass-through";
    const words = raw.toLowerCase().split("_");
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  };

  const hexOf = (c: J | null): string => {
    const to = (x: KiwiValue | undefined) => Math.max(0, Math.min(255, Math.round(numOf(x) * 255)));
    return `#${[to(c?.r), to(c?.g), to(c?.b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  };

  /** Gradient direction and radius, in the 0..1 box our paint model uses.
   *  Figma stores the two handles as 0..1 fractions of the node's box. */
  const gradientOf = (paint: J): Partial<ImportedPaint> => {
    const stops = arr(paint.stops)
      .map((s) => {
        const st = obj(s);
        if (!st) return null;
        const c = obj(st.color);
        const a = c ? numOf(c.a, 1) : 1;
        return {
          color: hexOf(c) + (a >= 0.999 ? "" : Math.round(Math.max(0, a) * 255).toString(16).padStart(2, "0")),
          position: Math.max(0, Math.min(1, numOf(st.position))),
        };
      })
      .filter((s): s is { color: string; position: number } => !!s);
    const tf = arr(paint.transform).map((n) => numOf(n));
    // Figma's transform is [[m00 m01 m02] [m10 m11 m12]]; the first handle is
    // the gradient's start, the second its end (or its radius, for radial).
    const gx = tf.length >= 9 ? tf[2] : 0.5;
    const gy = tf.length >= 9 ? tf[5] : 0;
    const hx = tf.length >= 9 ? tf[6] - tf[2] + 0.5 : 0.5;
    const hy = tf.length >= 9 ? tf[9] - tf[5] : 1;
    return { stops: stops.length >= 2 ? stops : undefined, gx, gy, hx, hy };
  };

  /** One Kiwi paint as the engine's Paint row. Returns null for paints we do
   *  not draw: patterns are still out of scope, and an invisible paint is the
   *  caller's to keep as `visible: false` rather than to drop. */
  const paintRow = (raw: KiwiValue): ImportedPaint | null => {
    const p = obj(raw);
    if (!p) return null;
    const type = str(p.type) ?? "SOLID";
    const visible = p.visible !== false;
    const opacity = Math.max(0, Math.min(1, numOf(p.opacity, 1)));
    const blend = blendName(p.blendMode);
    if (type === "SOLID") {
      const c = obj(p.color);
      const a = c ? numOf(c.a, 1) : 1;
      return { type: "solid", color: hexOf(c), opacity: opacity * a, visible, blend };
    }
    if (type.startsWith("GRADIENT_")) {
      const kind: FillType =
        type === "GRADIENT_LINEAR"
          ? "linear"
          : type === "GRADIENT_RADIAL"
            ? "radial"
            : type === "GRADIENT_ANGULAR"
              ? "angular"
              : "diamond";
      const g = gradientOf(p);
      return { type: kind, color: g.stops?.[0]?.color ?? "#00000000", opacity, visible, blend, ...g };
    }
    if (type === "IMAGE") {
      const ref = obj(p.imageRef);
      const hash = str(ref?.hash);
      const src = hash ? imageData.get(hash) : undefined;
      if (!src) return null;
      const fit: ImageFit =
        str(p.scaleMode) === "FIT" ? "fit" : str(p.scaleMode) === "TILE" ? "tile" : "fill";
      return { type: "image", color: "#00000000", opacity, visible, blend, imageSrc: src, imageFit: fit };
    }
    return null;
  };

  /** Paint list of a node's `fillPaints` / `strokePaints`, bottom to top. */
  const paintsOf = (nc: J, key: string): ImportedPaint[] => {
    const out: ImportedPaint[] = [];
    for (const raw of arr(nc[key])) {
      const row = paintRow(raw);
      if (row) out.push(row);
    }
    return out;
  };

  /** Kiwi effects. Figma's offsets and radii are already in our units; only
   *  the names differ. */
  const effectsOf = (nc: J): Effect[] => {
    const out: Effect[] = [];
    for (const raw of arr(nc.effects)) {
      const e = obj(raw);
      if (!e) continue;
      const type = str(e.type) ?? "";
      const kind: Effect["kind"] | null =
        type === "DROP_SHADOW"
          ? "drop-shadow"
          : type === "INNER_SHADOW"
            ? "inner-shadow"
            : type === "LAYER_BLUR"
              ? "layer-blur"
              : type === "BACKGROUND_BLUR"
                ? "background-blur"
                : null;
      if (!kind) continue;
      const c = obj(e.color);
      const alpha = c ? numOf(c.a, 1) : 1;
      const offset = obj(e.offset);
      out.push({
        kind,
        color: hexOf(c) + (alpha >= 0.999 ? "" : Math.round(Math.max(0, alpha) * 255).toString(16).padStart(2, "0")),
        x: kind === "layer-blur" || kind === "background-blur" ? 0 : numOf(offset?.x),
        y: kind === "layer-blur" || kind === "background-blur" ? 0 : numOf(offset?.y),
        blur: numOf(e.radius),
        spread: numOf(e.spread),
        visible: e.visible !== false,
        blend: blendName(e.blendMode),
        showBehind: e.showShadowBehindNode === true,
      });
    }
    return out;
  };

  const strokeAlignOf = (v: KiwiValue | undefined): "inside" | "outside" | "center" => {
    const s = str(v);
    return s === "OUTSIDE" ? "outside" : s === "CENTER" ? "center" : s === "INSIDE" ? "inside" : "inside";
  };

  /* --------------------------------------------------------- image assets */

  const imageData = new Map<string, string>();
  /** Hashes the file's paints actually point at: a `.fig` also carries a
   *  thumbnail beside its images, and there is no reason to store bytes no
   *  layer can show. */
  const wanted = new Set<string>();
  for (const n of merged.values()) {
    for (const key of ["fillPaints", "strokePaints"]) {
      for (const raw of arr(n[key])) {
        const hash = str(obj(obj(raw)?.imageRef)?.hash);
        if (hash) wanted.add(hash);
      }
    }
  }
  const mimeFor = (name: string): string =>
    /\.jpe?g$/i.test(name)
      ? "image/jpeg"
      : /\.gif$/i.test(name)
        ? "image/gif"
        : /\.webp$/i.test(name)
          ? "image/webp"
          : "image/png";
  for (const name of archive?.names() ?? []) {
    if (!/^images\//i.test(name) || /\/$/.test(name)) continue;
    const hash = name.slice(name.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    if (!hash || imageData.has(hash) || !wanted.has(hash)) continue;
    try {
      const bytes = await archive!.read(name);
      let bin = "";
      // Chunked, or a few megabytes of images blow the argument limit.
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const url = `data:${mimeFor(name)};base64,${btoa(bin)}`;
      imageData.set(hash, url);
      // Straight into the asset store: the document will only ever hold a ref.
      rememberImage(url);
    } catch {
      /* an image we cannot read is one the layer will not show */
    }
  }

  /* ------------------------------------------------------------ the tree */

  interface FigNode {
    guid: string;
    parent: string | null;
    /** Figma's fractional index for this child within its parent. */
    position: string;
    order: number;
    change: J;
  }

  const all: FigNode[] = [];
  let order = 0;
  for (const nc of merged.values()) {
    const guid = guidOf(nc);
    if (!guid) continue;
    const parentIndex = obj(nc.parentIndex);
    all.push({
      guid,
      parent: guidKey(obj(parentIndex?.guid)),
      position: str(parentIndex?.position) ?? "",
      order: order++,
      change: nc,
    });
  }

  const canvases = all.filter((n) => str(n.change.type) === "CANVAS");
  // Figma keeps components' internals on a canvas marked `internalOnly`; a
  // designer never sees it as a page, and importing it would look like a
  // second untitled page full of shapes nobody placed.
  const realCanvases = canvases.filter((c) => c.change.internalOnly !== true);
  const byGuid = new Map(all.map((n) => [n.guid, n]));
  const isCanvas = (n: FigNode) => str(n.change.type) === "CANVAS";
  const isDocument = (n: FigNode) => str(n.change.type) === "DOCUMENT";

  /** Children of a node, in Figma's own order. Positions are Figma's
   *  fractional index strings ("!" first, "~" last, otherwise an increasing
   *  base-94 pair), so a plain lexicographic sort is the document order. */
  const childOf = new Map<string | null, FigNode[]>();
  for (const n of all) {
    if (isCanvas(n) || isDocument(n)) continue;
    const key = n.parent && byGuid.has(n.parent) ? n.parent : null;
    const list = childOf.get(key) ?? [];
    list.push(n);
    childOf.set(key, list);
  }
  for (const list of childOf.values()) {
    list.sort((a, b) => (a.position === b.position ? a.order - b.order : a.position < b.position ? -1 : 1));
  }

  let skipped = 0;

  const build = (fig: FigNode): ImportedNode | null => {
    const nc = fig.change;
    const type = str(nc.type) ?? "";
    const size = obj(nc.size);
    const t = obj(nc.transform);
    const m00 = numOf(t?.m00, 1);
    const m01 = numOf(t?.m01, 0);
    const m10 = numOf(t?.m10, 0);
    const rotation = Math.abs(m01) > 1e-6 || Math.abs(m10) > 1e-6 ? (Math.atan2(m10, m00) * 180) / Math.PI : 0;
    // Node transforms in a .fig are relative to the parent, so x/y go in as-is:
    // the old importer treated them as absolute and re-based the whole file to
    // (0, 0), which moved a frame away from where its author put it.
    const x = numOf(t?.m02);
    const y = numOf(t?.m12);
    const w = numOf(size?.x, 100);
    const h = numOf(size?.y, 100);
    const name = str(nc.name) ?? type;
    const opacity = Math.max(0, Math.min(1, numOf(nc.opacity, 1)));
    const fills = paintsOf(nc, "fillPaints");
    const strokes = paintsOf(nc, "strokePaints");
    const strokeWeight = numOf(nc.strokeWeight, 0);
    const shadow = str(nc.blendMode);
    const base: ImportedNode = {
      kind: "rect",
      name,
      x,
      y,
      w,
      h,
      rotation,
      fill: fills[0]?.color ?? "#00000000",
      fillVisible: fills.some((f) => f.visible),
      strokePaint: strokes[0]?.color ?? "#00000000",
      strokeVisible: strokes.some((s) => s.visible) && strokeWeight > 0,
      strokeWidth: strokes.length ? strokeWeight : 0,
      opacity,
      hidden: nc.visible === false,
      locked: nc.locked === true,
      blendMode: shadow && shadow !== "PASS_THROUGH" ? blendName(shadow) : "pass-through",
      effects: effectsOf(nc),
    };
    if (fills.length > 1) base.fills = fills;
    if (fills.length) {
      base.fillType = fills[0].type;
      if (fills[0].stops) base.gradientStops = fills[0].stops;
      base.fillGX = fills[0].gx;
      base.fillGY = fills[0].gy;
      base.fillHX = fills[0].hx;
      base.fillHY = fills[0].hy;
      base.fillBlend = fills[0].blend;
      base.imageSrc = fills[0].imageSrc;
      base.imageFit = fills[0].imageFit;
    }
    if (strokeWeight > 0) {
      base.strokeAlign = strokeAlignOf(nc.strokeAlign);
      base.strokeCap = str(nc.strokeCap) === "ROUND" ? "round" : str(nc.strokeCap) === "SQUARE" ? "square" : "none";
      base.strokeJoin = str(nc.strokeJoin) === "ROUND" ? "round" : str(nc.strokeJoin) === "BEVEL" ? "bevel" : "miter";
      const dashes = arr(nc.strokeDashes).map((d) => numOf(d));
      if (dashes.length) {
        base.strokeDash = dashes[0];
        base.strokeGap = dashes[1] ?? dashes[0];
      }
    }

    const kids = (childOf.get(fig.guid) ?? [])
      .map(build)
      .filter((n): n is ImportedNode => !!n);
    const container =
      type === "FRAME" || type === "GROUP" || type === "SECTION" || type === "COMPONENT" || type === "COMPONENT_SET" || type === "INSTANCE";
    if (kids.length) base.children = kids;

    if (container) {
      const kind: ImportedNode["kind"] =
        type === "GROUP" ? "group" : type === "INSTANCE" ? "instance" : type === "COMPONENT" || type === "COMPONENT_SET" ? "component" : "frame";
      // A frame paints its own background only when the file says so; a group
      // never does, and an instance's frame-like box is a container too.
      if (type !== "FRAME" && type !== "COMPONENT" && type !== "COMPONENT_SET" && type !== "INSTANCE") {
        base.fill = "#00000000";
        base.fillVisible = false;
        base.fills = undefined;
      }
      if (kind === "instance" || kind === "component") {
        base.fill = fills[0]?.color ?? "#00000000";
        base.fillVisible = fills.some((f) => f.visible);
      }
      return { ...base, kind };
    }

    if (["VECTOR", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION", "LINE", "ELLIPSE", "TEXT", "RECTANGLE"].includes(type)) {
      if (["VECTOR", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION"].includes(type)) {
        // Every contour, not just the first. An icon is drawn as a dozen
        // separate subpaths (one per curve of the logo), and reading only the
        // first left a blob where the mark should be.
        const contours: { path: PathPoint[]; closed: boolean; evenOdd: boolean }[] = [];
        const geoms = arr(nc.fillGeometry).concat(arr(nc.strokeGeometry));
        for (const g of geoms) {
          const gobj = obj(g);
          const bIdx = numOf(gobj?.commandsBlob, -1);
          if (bIdx < 0 || !blobs[bIdx]) continue;
          const rawBytes = blobs[bIdx].bytes;
          if (typeof rawBytes !== "string") continue;
          const conv = figmaCommandsToPathPoints(parseCommandsBlob(hexToBytes(rawBytes)));
          if (!conv.path.length) continue;
          contours.push({ ...conv, evenOdd: str(gobj?.windingRule) === "EVENODD" });
        }
        if (!contours.length) {
          skipped++;
          return null;
        }
        // One layer, one network, a loop per contour - which is how a vector
        // network holds a shape with holes in it. Regions only make a closed
        // shape, so a path with an open contour stays segments-only, the way
        // an open vector was already drawn.
        const vertices: VectorVertex[] = [];
        const segments: VectorSegment[] = [];
        const loops: number[][] = [];
        let evenOdd = false;
        for (const c of contours) {
          const net = pathToVectorNetwork(c.path, c.closed);
          const base0 = vertices.length;
          vertices.push(...net.vertices);
          for (const seg of net.segments) segments.push({ ...seg, start: seg.start + base0, end: seg.end + base0 });
          if (net.regions?.length) {
            for (const loop of net.regions[0].loops) loops.push(loop.map((i) => i + base0));
            if (c.evenOdd) evenOdd = true;
          }
        }
        const allClosed = contours.every((c) => c.closed);
        const vectorNetwork: VectorNetwork = {
          vertices,
          segments,
          ...(allClosed && loops.length ? { regions: [{ windingRule: evenOdd ? ("EVENODD" as const) : ("NONZERO" as const), loops }] } : {}),
        };
        const main = contours.reduce((a, b) => (b.path.length > a.path.length ? b : a));
        return { ...base, kind: "vector", path: main.path, vectorNetwork, closed: main.closed };
      }
      if (type === "LINE") {
        return { ...base, kind: "line", path: [{ x: 0, y: 0 }, { x: w, y: h }], closed: false };
      }
      if (type === "ELLIPSE") return { ...base, kind: "ellipse" };
      if (type === "TEXT") {
        const characters = str(nc.characters) ?? "";
        if (!characters.trim()) return null;
        const fontName = obj(nc.fontName);
        const style = str(fontName?.style) ?? "";
        const weight = /black|heavy/i.test(style)
          ? 900
          : /bold/i.test(style)
            ? 700
            : /semi\s*bold|demi/i.test(style)
              ? 600
              : /medium/i.test(style)
                ? 500
                : /light|thin/i.test(style)
                  ? 300
                  : 400;
        const alignRaw = str(nc.textAlignHorizontal);
        const lineHeight = obj(nc.lineHeight);
        return {
          ...base,
          kind: "text",
          text: characters,
          fontSize: numOf(nc.fontSize, 0) || Math.max(8, Math.min(h, 16)),
          fontWeight: weight,
          textAlign: alignRaw === "CENTER" ? "center" : alignRaw === "RIGHT" ? "right" : alignRaw === "JUSTIFIED" ? "justified" : "left",
          fontFamily: str(fontName?.family) ?? undefined,
          lineHeight: numOf(lineHeight?.value, 0) || undefined,
          letterSpacing: obj(nc.letterSpacing) ? numOf(obj(nc.letterSpacing)?.value, 0) : undefined,
        };
      }
      const rects = arr(nc.rectangleCornerRadii).map((n) => numOf(n));
      const radius = numOf(nc.cornerRadius, 0);
      const radii: [number, number, number, number] = rects.length === 4 ? (rects as [number, number, number, number]) : [radius, radius, radius, radius];
      base.cornerRadii = radii;
      base.cornerIndependent = rects.length === 4 && new Set(rects.map((n) => Math.round(n * 100))).size > 1;
      base.cornerSmoothing = numOf(nc.cornerSmoothing, 0) || undefined;
      return { ...base, kind: "rect" };
    }

    skipped++;
    return null;
  };

  const buildList = (list: FigNode[]) => list.map(build).filter((n): n is ImportedNode => !!n);
  // Layers whose parent is not in the file at all. A .fig written by an older
  // tool (or hand-made for a test) has no parentIndex anywhere, and every layer
  // then looks like an orphan; they belong on the first page, not nowhere.
  let orphans = (childOf.get(null) ?? []).filter((n) => !isCanvas(n) && !isDocument(n));
  const pages: ImportedPage[] = [];
  for (const canvas of (realCanvases.length ? realCanvases : canvases)) {
    let list = childOf.get(canvas.guid) ?? [];
    if (!list.length && orphans.length) {
      list = orphans;
      orphans = [];
    }
    pages.push({ name: str(canvas.change.name) || "Page 1", nodes: buildList(list) });
  }
  if (orphans.length) {
    if (pages.length) pages[0].nodes = pages[0].nodes.concat(buildList(orphans));
    else pages.push({ name: "Page 1", nodes: buildList(orphans) });
  }
  if (!pages.length) pages.push({ name: "Page 1", nodes: [] });

  const first = pages.find((p) => p.nodes.length) ?? pages[0];
  const nodes = first.nodes;
  if (!nodes.length && !pages.some((p) => p.nodes.length)) {
    throw new Error("no importable layers in this .fig file");
  }
  // Bounds of the whole file, measured from the outermost layers in: a page
  // that sits at negative coordinates still has a size.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const measure = (list: ImportedNode[], ox: number, oy: number) => {
    for (const n of list) {
      minX = Math.min(minX, ox + n.x);
      minY = Math.min(minY, oy + n.y);
      maxX = Math.max(maxX, ox + n.x + n.w);
      maxY = Math.max(maxY, oy + n.y + n.h);
      if (n.children) measure(n.children, ox + n.x, oy + n.y);
    }
  }
  for (const p of pages) measure(p.nodes, 0, 0);

  return {
    nodes,
    pages,
    width: Number.isFinite(minX) ? Math.max(1, maxX - minX) : 1,
    height: Number.isFinite(minY) ? Math.max(1, maxY - minY) : 1,
    skipped,
    images: imageData.size,
  };
}

// ----------------------------------------------------------------------------
// Detailed .fig Inspection (Kiwi Binary, Nodes, Vector Network Analyzer)
// ----------------------------------------------------------------------------

export interface FigInspectionNode {
  guid: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
  stroke: string | null;
  strokeWeight: number;
  hasVectorGeometry: boolean;
  vectorCommandsCount: number;
  sampleCommands?: FigmaPathCmd[];
  vectorVerticesCount: number;
  vectorSegmentsCount: number;
  branchingCount: number;
  raw: Record<string, unknown>;
}

export interface FigInspectionReport {
  fileName?: string;
  prelude: string;
  version: number;
  chunksCount: number;
  chunks: { index: number; byteLength: number; compression: "deflate" | "zstd" }[];
  schemaDefsCount: number;
  schemaDefs: { name: string; kind: string; fieldsCount: number }[];
  blobsCount: number;
  totalNodeChanges: number;
  activeNodesCount: number;
  nodesByType: Record<string, number>;
  nodes: FigInspectionNode[];
  rawMessageJson: string;
}

/**
 * Reads and inspects a .fig binary file in full depth, returning schema definitions,
 * node hierarchy, vector network geometry analysis, and raw JSON.
 */
export async function inspectFigFile(buf: ArrayBuffer, fileName = "document.fig"): Promise<FigInspectionReport> {
  const zip = new Zip(buf);
  const canvasName = zip.names().find((n) => n.endsWith("canvas.fig"));
  if (!canvasName) throw new Error("no canvas.fig entry in this .fig archive");
  const canvas = await zip.read(canvasName);

  const prelude = new TextDecoder().decode(canvas.subarray(0, 8));
  if (canvas.length < 12 || !prelude.startsWith("fig-")) {
    throw new Error('Not a valid Figma binary file (missing "fig-" prelude)');
  }

  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  const version = view.getUint32(8, true);

  const rawChunks: Uint8Array[] = [];
  const chunkInfos: { index: number; byteLength: number; compression: "deflate" | "zstd" }[] = [];
  let off = 12;
  let chunkIdx = 0;
  while (off + 4 <= canvas.length) {
    const len = view.getUint32(off, true);
    off += 4;
    const end = off + len;
    if (end > canvas.length) throw new Error("truncated .fig chunk");
    const chunkData = canvas.subarray(off, end);
    const isZstd = chunkData[0] === 0x28 && chunkData[1] === 0xb5 && chunkData[2] === 0x2f && chunkData[3] === 0xfd;
    chunkInfos.push({
      index: chunkIdx,
      byteLength: len,
      compression: isZstd ? "zstd" : "deflate",
    });
    rawChunks.push(chunkData);
    off = end;
    chunkIdx++;
  }

  if (rawChunks.length < 2) throw new Error("fig-kiwi container has fewer than 2 chunks");

  const schema = decodeSchema(await inflateChunk(rawChunks[0]));
  const message = await inflateChunk(rawChunks[1]);

  const rootName = ["Message", "NodeChanges"].find((r) =>
    schema.defs.find((d) => d.name === r && d.fields.some((f) => f.name === "nodeChanges")),
  );
  if (!rootName) throw new Error("no nodeChanges root in the embedded schema");

  const dec = new Decoder(schema, message);
  const root = obj(dec.decodeRoot(rootName));
  const changes = arr(root?.nodeChanges);
  const blobs = arr(root?.blobs).map((b) => obj(b) ?? {});

  const guidOf = (nc: J): string | null => {
    const g = obj(nc.guid);
    if (!g) return null;
    return `${numOf(g.sessionID)}:${numOf(g.localID)}`;
  };

  const merged = new Map<string, J>();
  for (const raw of changes) {
    const nc = obj(raw);
    if (!nc) continue;
    const id = guidOf(nc);
    if (!id) continue;
    if (str(nc.phase) === "REMOVED") {
      merged.delete(id);
      continue;
    }
    const prev = merged.get(id);
    merged.set(id, prev ? { ...prev, ...nc } : nc);
  }

  const nodesByType: Record<string, number> = {};
  const inspectedNodes: FigInspectionNode[] = [];

  for (const nc of merged.values()) {
    const type = str(nc.type) ?? "UNKNOWN";
    nodesByType[type] = (nodesByType[type] || 0) + 1;

    const size = obj(nc.size);
    const w = numOf(size?.x, 0);
    const h = numOf(size?.y, 0);
    const t = obj(nc.transform);
    const x = numOf(t?.m02, 0);
    const y = numOf(t?.m12, 0);

    const fill = firstPaint(nc, "fillPaints");
    const stroke = firstPaint(nc, "strokePaints");
    const strokeWeight = numOf(nc.strokeWeight, 0);
    const name = str(nc.name) ?? type;
    const opacity = Math.max(0, Math.min(1, numOf(nc.opacity, 1)));
    const visible = nc.visible !== false;

    let hasVectorGeometry = false;
    let vectorCommandsCount = 0;
    let sampleCommands: FigmaPathCmd[] | undefined;
    let vectorVerticesCount = 0;
    let vectorSegmentsCount = 0;
    let branchingCount = 0;

    const geoms = arr(nc.fillGeometry).concat(arr(nc.strokeGeometry));
    for (const g of geoms) {
      const gobj = obj(g);
      const bIdx = numOf(gobj?.commandsBlob, -1);
      if (bIdx >= 0 && blobs[bIdx]) {
        const rawBytes = blobs[bIdx].bytes;
        if (typeof rawBytes === "string") {
          hasVectorGeometry = true;
          const cmds = parseCommandsBlob(hexToBytes(rawBytes));
          vectorCommandsCount += cmds.length;
          if (!sampleCommands) sampleCommands = cmds.slice(0, 10);
          const conv = figmaCommandsToPathPoints(cmds);
          if (conv.path.length) {
            const vn = pathToVectorNetwork(conv.path, conv.closed);
            vectorVerticesCount += vn.vertices.length;
            vectorSegmentsCount += vn.segments.length;
            for (let vi = 0; vi < vn.vertices.length; vi++) {
              let deg = 0;
              for (const s of vn.segments) {
                if (s.start === vi || s.end === vi) deg++;
              }
              if (deg >= 3) branchingCount++;
            }
          }
        }
      }
    }

    inspectedNodes.push({
      guid: guidOf(nc) ?? "",
      name,
      type,
      visible,
      opacity,
      x,
      y,
      w,
      h,
      fill,
      stroke,
      strokeWeight,
      hasVectorGeometry,
      vectorCommandsCount,
      sampleCommands,
      vectorVerticesCount,
      vectorSegmentsCount,
      branchingCount,
      raw: nc as Record<string, unknown>,
    });
  }

  const schemaDefs = schema.defs.map((d) => ({
    name: d.name,
    kind: d.kind,
    fieldsCount: d.fields.length,
  }));

  return {
    fileName,
    prelude: prelude.trim(),
    version,
    chunksCount: rawChunks.length,
    chunks: chunkInfos,
    schemaDefsCount: schema.defs.length,
    schemaDefs,
    blobsCount: blobs.length,
    totalNodeChanges: changes.length,
    activeNodesCount: merged.size,
    nodesByType,
    nodes: inspectedNodes,
    rawMessageJson: JSON.stringify(root, null, 2),
  };
}
