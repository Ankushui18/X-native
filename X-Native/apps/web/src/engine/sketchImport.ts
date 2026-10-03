/**
 * .sketch format import.
 *
 * A .sketch file is a ZIP of JSON: `document.json` lists page references and
 * each `pages/<id>.json` holds a layer tree. That means it can be opened in
 * the browser with no native code — the Rust `crates/x-format/src/sketch.rs`
 * importer is the reference for the field mapping here, but it is unreachable
 * from the web app, so this is a direct TypeScript reader rather than a
 * binding to it.
 *
 * Supported: artboards, groups, rectangles (incl. corner radius), ovals, text,
 * shape paths, symbol masters/instances (flattened to plain layers), fills,
 * borders, opacity and rotation.
 *
 * Not supported: symbol override resolution, shared styles, bitmaps, gradients
 * beyond the first stop, blur and shadow effects. Anything unrecognised is
 * counted and reported rather than silently dropped.
 */

import { Zip } from "./zip";
import type { ImportedNode, ImportResult } from "./svgImport";
import type { Effect, FillType, GradientStop, TextAlign } from "./types";

type J = Record<string, unknown>;

const obj = (v: unknown): J | null => (typeof v === "object" && v !== null ? (v as J) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Format stores colour channels as 0..1 floats. */
function sketchColor(v: unknown): string | null {
  const c = obj(v);
  if (!c) return null;
  const to = (x: unknown) => Math.max(0, Math.min(255, Math.round(num(x) * 255)));
  const hex = `#${[to(c.red), to(c.green), to(c.blue)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  const a = num(c.alpha, 1);
  return a >= 0.999 ? hex : `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
}

/** First enabled fill or gradient; keeps disabled entries in the array. */
function sketchFillInfo(layer: J): {
  fill: string | null;
  fillType?: FillType;
  gradientStops?: GradientStop[];
} {
  const style = obj(layer.style);
  for (const f of arr(style?.fills)) {
    const fo = obj(f);
    if (!fo || fo.isEnabled === false) continue;
    const fillTypeNum = num(fo.fillType, 0);
    if (fillTypeNum === 1 || fillTypeNum === 2) {
      const grad = obj(fo.gradient);
      const stops: GradientStop[] = [];
      for (const st of arr(grad?.stops)) {
        const sto = obj(st);
        if (sto) {
          const sc = sketchColor(sto.color);
          if (sc) {
            stops.push({ position: num(sto.position, 0), color: sc });
          }
        }
      }
      return {
        fill: stops[0]?.color ?? "#000000",
        fillType: fillTypeNum === 2 ? "radial" : "linear",
        gradientStops: stops.length ? stops : undefined,
      };
    }
    const c = sketchColor(fo.color);
    if (c) return { fill: c, fillType: "solid" };
  }
  return { fill: null };
}

function firstBorder(layer: J): { color: string; width: number } | null {
  const style = obj(layer.style);
  for (const b of arr(style?.borders)) {
    const bo = obj(b);
    if (!bo || bo.isEnabled === false) continue;
    const c = sketchColor(bo.color);
    if (c) return { color: c, width: num(bo.thickness, 1) };
  }
  return null;
}

function sketchEffects(layer: J): Effect[] {
  const effects: Effect[] = [];
  const style = obj(layer.style);
  if (!style) return effects;

  for (const s of arr(style.shadows)) {
    const so = obj(s);
    if (!so || so.isEnabled === false) continue;
    const c = sketchColor(so.color);
    effects.push({
      kind: "drop-shadow",
      color: c ?? "rgba(0,0,0,0.25)",
      x: num(so.offsetX, 0),
      y: num(so.offsetY, 4),
      blur: num(so.blurRadius, 4),
      spread: num(so.spread, 0),
      visible: true,
    });
  }

  for (const s of arr(style.innerShadows)) {
    const so = obj(s);
    if (!so || so.isEnabled === false) continue;
    const c = sketchColor(so.color);
    effects.push({
      kind: "inner-shadow",
      color: c ?? "rgba(0,0,0,0.25)",
      x: num(so.offsetX, 0),
      y: num(so.offsetY, 2),
      blur: num(so.blurRadius, 4),
      spread: num(so.spread, 0),
      visible: true,
    });
  }

  const blur = obj(style.blur);
  if (blur && blur.isEnabled !== false) {
    const type = num(blur.type, 0);
    // 0 = Gaussian (layer-blur), 3 = Background blur
    effects.push({
      kind: type === 3 ? "background-blur" : "layer-blur",
      color: "rgba(0,0,0,0)",
      x: 0,
      y: 0,
      blur: num(blur.radius, 10),
      spread: 0,
      visible: true,
    });
  }

  return effects;
}

/** `"{1, 2}"` -> [1, 2]; Format encodes points as strings. */
function parsePoint(v: unknown): { x: number; y: number } | null {
  const s = str(v);
  if (!s) return null;
  const m = /\{\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\}/.exec(s);
  if (!m) return null;
  const x = parseFloat(m[1]);
  const y = parseFloat(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export async function importSketch(buf: ArrayBuffer): Promise<ImportResult> {
  const zip = new Zip(buf);
  const nodes: ImportedNode[] = [];
  let skipped = 0;
  let maxX = 0;
  let maxY = 0;

  // document.json names the pages; fall back to scanning pages/*.json for
  // files that omit or mis-write the reference list.
  let pagePaths: string[] = [];
  try {
    const doc = obj(await zip.readJson("document.json"));
    pagePaths = arr(doc?.pages)
      .map((p) => str(obj(p)?._ref))
      .filter((s): s is string => !!s)
      .map((s) => `${s}.json`);
  } catch {
    /* fall through to the scan below */
  }
  const present = new Set(zip.names());
  pagePaths = pagePaths.filter((p) => present.has(p));
  if (!pagePaths.length) {
    pagePaths = zip.names().filter((n) => /^pages\/.+\.json$/.test(n));
  }
  if (!pagePaths.length) throw new Error("no pages in this file");

  // Only the first page is imported: the engine has its own page model and
  // silently merging several pages into one canvas would overlap them.
  const page = obj(await zip.readJson(pagePaths[0]));
  if (!page) throw new Error("unreadable archive page");

  const walk = (layer: J, ox: number, oy: number) => {
    if (layer.isVisible === false) return;
    const cls = str(layer._class) ?? "";
    const frame = obj(layer.frame);
    const x = ox + num(frame?.x);
    const y = oy + num(frame?.y);
    const w = num(frame?.width);
    const h = num(frame?.height);
    const name = str(layer.name) ?? cls;
    const style = obj(layer.style);
    const ctx = obj(style?.contextSettings);
    const opacity = Math.max(0, Math.min(1, num(ctx?.opacity, 1)));
    // Format stores rotation counter-clockwise; the engine uses clockwise.
    const rotation = -num(layer.rotation);
    const fillInfo = sketchFillInfo(layer);
    const border = firstBorder(layer);
    const effects = sketchEffects(layer);
    const borderOpts = obj(style?.borderOptions);
    const dashes = arr(borderOpts?.dashPattern).map((d) => num(d, 0));
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);

    const base: Partial<ImportedNode> = {
      name,
      fill: fillInfo.fill ?? "#00000000",
      fillVisible: fillInfo.fill !== null,
      fillType: fillInfo.fillType,
      gradientStops: fillInfo.gradientStops,
      strokePaint: border?.color ?? "#00000000",
      strokeVisible: !!border,
      strokeWidth: border?.width ?? 0,
      opacity,
      rotation,
      effects: effects.length ? effects : undefined,
      strokeDash: dashes[0] || undefined,
      strokeGap: dashes[1] || undefined,
      locked: layer.isLocked === true,
      hidden: layer.isVisible === false,
    };

    switch (cls) {
      case "artboard":
      case "group":
      case "shapeGroup":
      case "symbolMaster": {
        // Containers contribute their own background when they have a fill,
        // then their children are laid out in absolute coordinates. The engine
        // gets a flat list, so children carry the accumulated offset.
        if (cls === "artboard" || fillInfo.fill) {
          nodes.push({ kind: "rect", ...base, x, y, w: Math.max(1, w), h: Math.max(1, h) } as ImportedNode);
        }
        for (const c of arr(layer.layers)) {
          const co = obj(c);
          if (co) walk(co, x, y);
        }
        return;
      }
      case "rectangle": {
        const pts = arr(layer.points);
        const radius =
          num(obj(pts[0])?.cornerRadius, NaN) || num(layer.fixedRadius, 0);
        nodes.push({
          kind: "rect",
          ...base,
          x,
          y,
          w: Math.max(1, w),
          h: Math.max(1, h),
          ...(radius > 0 ? { cornerRadii: [radius, radius, radius, radius] as [number, number, number, number] } : {}),
        } as ImportedNode);
        return;
      }
      case "oval":
        nodes.push({ kind: "ellipse", ...base, x, y, w: Math.max(1, w), h: Math.max(1, h) } as ImportedNode);
        return;
      case "text": {
        const as = obj(layer.attributedString);
        const content = str(as?.string) ?? "";
        if (!content.trim()) return;
        const rawAttrs = arr(obj(as?.attributes)?.attributes ?? as?.attributes);
        const firstAttr = obj(rawAttrs[0]);
        const runAttrs = obj(firstAttr?.attributes ?? firstAttr);
        const font = obj(runAttrs?.NSFontAttribute);
        const size = num(font?.size, 0) || Math.max(8, Math.min(h, 16));
        // Text colour usually lives on the attribute run, not style.fills.
        const runColor = sketchColor(obj(runAttrs?.MSAttributedStringColorAttribute)?.color);
        const paraStyle = obj(runAttrs?.NSParagraphStyle);
        const alignNum = num(paraStyle?.alignment, 0);
        const textAlign: TextAlign = alignNum === 1 ? "right" : alignNum === 2 ? "center" : "left";
        const lineHeight = num(paraStyle?.maximumLineHeight, 0) || undefined;
        const letterSpacing = num(runAttrs?.NSKern, 0) || undefined;

        nodes.push({
          kind: "text",
          ...base,
          x,
          y,
          w: Math.max(8, w),
          h: Math.max(size, h),
          fill: fillInfo.fill ?? runColor ?? "#000000",
          fillVisible: true,
          text: content,
          fontSize: size,
          fontWeight: /bold|semibold|medium/i.test(str(font?.name) ?? "") ? 600 : 400,
          textAlign,
          lineHeight,
          letterSpacing,
        } as ImportedNode);
        return;
      }
      case "shapePath":
      case "triangle":
      case "star":
      case "polygon": {
        const pts = arr(layer.points)
          .map((p) => parsePoint(obj(p)?.point))
          .filter((p): p is { x: number; y: number } => !!p)
          // Format normalises path points to the layer's 0..1 box.
          .map((p) => ({ x: p.x * w, y: p.y * h }));
        if (pts.length < 2) {
          skipped++;
          return;
        }
        nodes.push({
          kind: "vector",
          ...base,
          x,
          y,
          w: Math.max(1, w),
          h: Math.max(1, h),
          path: pts,
          closed: layer.isClosed !== false,
        } as ImportedNode);
        return;
      }
      case "symbolInstance": {
        // Overrides are not resolved, so an instance becomes a placeholder box
        // rather than the wrong artwork. Counted so the user is told.
        skipped++;
        if (fillInfo.fill) nodes.push({ kind: "rect", ...base, x, y, w: Math.max(1, w), h: Math.max(1, h) } as ImportedNode);
        return;
      }
      default: {
        // Unknown container: still descend, so its children are not lost.
        const kids = arr(layer.layers);
        if (kids.length) {
          for (const c of kids) {
            const co = obj(c);
            if (co) walk(co, x, y);
          }
        } else {
          skipped++;
        }
      }
    }
  };

  for (const l of arr(page.layers)) {
    const lo = obj(l);
    if (lo) walk(lo, 0, 0);
  }

  if (!nodes.length) throw new Error("no importable layers in this file");

  // Artboards sit at arbitrary canvas coordinates; normalise to the origin so
  // the import lands where it was dropped rather than far off-screen.
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  for (const n of nodes) {
    n.x -= minX;
    n.y -= minY;
  }

  return { nodes, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY), skipped };
}
