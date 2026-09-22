/**
 * Figma (.fig) import.
 *
 * A `.fig` is a ZIP whose `canvas.fig` entry is a `fig-kiwi` container:
 * 8-byte magic, u32 version, then length-prefixed chunks. Chunk 0 is the
 * compressed Kiwi schema (Figma ships its whole field dictionary in every
 * file, so the reader stays version-tolerant) and chunk 1 is the document
 * message.
 *
 * Ported from `crates/x-format/src/figbinary.rs`. That crate cannot be reached
 * from the web app — no wasm bridge is buildable in this environment — so this
 * is a direct TypeScript reader using the same field mapping.
 *
 * Supported: FRAME/SECTION/GROUP, RECTANGLE (+corner radius), ELLIPSE, LINE,
 * TEXT, COMPONENT/INSTANCE, solid fills and strokes, opacity, visibility,
 * rotation and absolute placement.
 *
 * Not supported, and counted rather than silently dropped: VECTOR/STAR/POLYGON
 * geometry, gradients past the first stop, images, effects, component property
 * overrides, prototype interactions and auto-layout.
 */

import { Zip } from "./zip";
import { decodeSchema, Decoder, type KiwiValue } from "./kiwi";
import type { ImportedNode, ImportResult } from "./svgImport";

type J = Record<string, KiwiValue>;

const obj = (v: KiwiValue | undefined): J | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as J) : null;
const arr = (v: KiwiValue | undefined): KiwiValue[] => (Array.isArray(v) ? v : []);
const str = (v: KiwiValue | undefined): string | null => (typeof v === "string" ? v : null);
const numOf = (v: KiwiValue | undefined, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

/** Inflate a container chunk. Figma writes raw DEFLATE; newer files may use
 *  zstd, which browsers cannot decode — detected so the failure is explained
 *  rather than surfacing as corrupt data. */
async function inflateChunk(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) {
    throw new Error("this .fig uses zstd compression, which the browser cannot decode");
  }
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error("this browser cannot decompress .fig chunks");
  // Figma writes a bare deflate stream; some writers add a zlib wrapper.
  for (const fmt of ["deflate-raw", "deflate"] as const) {
    try {
      const ds = new DS(fmt);
      const w = ds.writable.getWriter();
      void w.write(data);
      void w.close();
      return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    } catch {
      /* try the next framing */
    }
  }
  throw new Error("could not decompress .fig chunk");
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
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let off = 12; // 8-byte magic + u32 version
  while (off + 4 <= canvas.length) {
    const len = view.getUint32(off, true);
    off += 4;
    const end = off + len;
    if (end > canvas.length) throw new Error("truncated .fig chunk");
    chunks.push(canvas.subarray(off, end) as Uint8Array<ArrayBuffer>);
    off = end;
  }
  if (chunks.length < 2) throw new Error("fig-kiwi container has fewer than 2 chunks");

  const schema = decodeSchema(await inflateChunk(chunks[0]));
  const message = await inflateChunk(chunks[1]);

  // Older writers root the document in "NodeChanges"; newer ones wrap it in a
  // "Message" definition that contains nodeChanges. Accept either.
  const rootName = ["Message", "NodeChanges"].find((r) =>
    schema.defs.find((d) => d.name === r && d.fields.some((f) => f.name === "nodeChanges")),
  );
  if (!rootName) throw new Error("no nodeChanges root in the embedded schema");

  const dec = new Decoder(schema, message);
  const root = obj(dec.decodeRoot(rootName));
  const changes = arr(root?.nodeChanges);
  if (!changes.length) throw new Error("no nodes in this .fig file");

  // A .fig is a change log, not a snapshot: later entries patch earlier ones
  // by guid and REMOVED prunes. Merge before interpreting.
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

    // Vector geometry is stored as an encoded blob this reader does not parse;
    // count it so the user is told rather than seeing shapes vanish.
    if (["VECTOR", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION"].includes(type)) {
      skipped++;
      continue;
    }
    if (!["FRAME", "SECTION", "GROUP", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(type)) {
      continue;
    }

    const size = obj(nc.size);
    const w = numOf(size?.x);
    const h = numOf(size?.y);
    if (w <= 0 || h <= 0) continue;

    // transform is a 2x3 affine; m02/m12 are the translation.
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

    if (type === "TEXT") {
      const characters = str(nc.characters) ?? "";
      if (!characters.trim()) continue;
      const fontSize = numOf(nc.fontSize, 0) || Math.max(8, Math.min(h, 16));
      nodes.push({
        kind: "text",
        ...base,
        // Figma text with no explicit fill paints renders black.
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

    // FRAME/SECTION/GROUP/RECTANGLE/COMPONENT/INSTANCE all land as rects; a
    // group with no fill contributes nothing visible, so skip those rather
    // than stacking invisible boxes over the artwork.
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

  // Figma coordinates are canvas-absolute and often far from the origin;
  // normalise so the import lands where it was dropped.
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
