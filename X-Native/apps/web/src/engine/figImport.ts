/**
 * Figma (.fig) import and binary inspection.
 *
 * A `.fig` is a ZIP whose `canvas.fig` entry is a `fig-kiwi` container:
 * 8-byte magic ("fig-kiwi"), u32 version, then length-prefixed chunks. Chunk 0 is the
 * compressed Kiwi schema (Figma ships its whole field dictionary in every
 * file, so the reader stays version-tolerant) and chunk 1 is the document
 * message.
 *
 * Supported: FRAME/SECTION/GROUP, RECTANGLE (+corner radius), ELLIPSE, LINE,
 * TEXT, COMPONENT/INSTANCE, solid fills and strokes, opacity, visibility,
 * rotation, absolute placement, and VECTOR/STAR/POLYGON geometry parsed directly
 * from commandsBlob and vectorNetworkBlob.
 */

import { Zip } from "./zip";
import { decodeSchema, Decoder, type KiwiValue } from "./kiwi";
import type { ImportedNode, ImportResult } from "./svgImport";
import type { PathPoint } from "./types";
import { decompress as zstdDecompress } from "fzstd";
import { pathToVectorNetwork } from "./geometry";

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
  const canvas = await zip.read(canvasName);

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

  const nodes: ImportedNode[] = [];
  let skipped = 0;

  for (const nc of merged.values()) {
    const type = str(nc.type) ?? "";
    if (type === "DOCUMENT" || type === "CANVAS") continue;

    const size = obj(nc.size);
    const w = numOf(size?.x, 100);
    const h = numOf(size?.y, 100);
    if (w <= 0 || h <= 0) continue;

    const t = obj(nc.transform);
    const m00 = numOf(t?.m00, 1);
    const m01 = numOf(t?.m01, 0);
    const m10 = numOf(t?.m10, 0);
    const x = numOf(t?.m02);
    const y = numOf(t?.m12);
    const rotation =
      Math.abs(m01) > 1e-6 || Math.abs(m10) > 1e-6 ? (Math.atan2(m10, m00) * 180) / Math.PI : 0;

    const fill = firstPaint(nc, "fillPaints");
    const stroke = firstPaint(nc, "strokePaints");
    const strokeWeight = numOf(nc.strokeWeight, 0);
    const name = str(nc.name) ?? type;
    const opacity = Math.max(0, Math.min(1, numOf(nc.opacity, 1)));
    if (nc.visible === false) continue;

    const base = {
      name,
      fill: fill ?? "#00000000",
      fillVisible: fill !== null,
      strokePaint: stroke ?? "#00000000",
      strokeVisible: stroke !== null && strokeWeight > 0,
      strokeWidth: stroke !== null ? strokeWeight : 0,
      opacity,
      rotation,
      x,
      y,
      w,
      h,
    };

    // Vector, Star, Polygon, Boolean operations
    if (["VECTOR", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION"].includes(type)) {
      let pathPts: PathPoint[] = [];
      let closed = false;
      const geoms = arr(nc.fillGeometry).concat(arr(nc.strokeGeometry));
      for (const g of geoms) {
        const gobj = obj(g);
        const bIdx = numOf(gobj?.commandsBlob, -1);
        if (bIdx >= 0 && blobs[bIdx]) {
          const rawBytes = blobs[bIdx].bytes;
          if (typeof rawBytes === "string") {
            const cmds = parseCommandsBlob(hexToBytes(rawBytes));
            const conv = figmaCommandsToPathPoints(cmds);
            if (conv.path.length) {
              pathPts = conv.path;
              closed = conv.closed;
              break;
            }
          }
        }
      }
      if (pathPts.length) {
        const vn = pathToVectorNetwork(pathPts, closed);
        nodes.push({
          kind: "vector",
          ...base,
          path: pathPts,
          vectorNetwork: vn,
          closed,
        });
        continue;
      }
      skipped++;
      continue;
    }

    if (!["FRAME", "SECTION", "GROUP", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(type)) {
      continue;
    }

    if (type === "TEXT") {
      const characters = str(nc.characters) ?? "";
      if (!characters.trim()) continue;
      const fontSize = numOf(nc.fontSize, 0) || Math.max(8, Math.min(h, 16));
      nodes.push({
        kind: "text",
        ...base,
        fill: fill ?? "#000000",
        fillVisible: true,
        text: characters,
        fontSize,
        fontWeight: numOf(nc.fontWeight, 400) || 400,
      });
      continue;
    }

    if (type === "ELLIPSE") {
      nodes.push({ kind: "ellipse", ...base });
      continue;
    }

    if (type === "LINE") {
      nodes.push({ kind: "line", ...base, path: [{ x: 0, y: 0 }, { x: w, y: h }], closed: false });
      continue;
    }

    if ((type === "GROUP" || type === "SECTION") && !fill) continue;
    const radius = numOf(nc.cornerRadius, 0);
    nodes.push({
      kind: "rect",
      ...base,
      ...(radius > 0
        ? { cornerRadii: [radius, radius, radius, radius] as [number, number, number, number] }
        : {}),
    });
  }

  if (!nodes.length) throw new Error("no importable layers in this .fig file");

  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    n.x -= minX;
    n.y -= minY;
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }

  return { nodes, width: Math.max(1, maxX), height: Math.max(1, maxY), skipped };
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
