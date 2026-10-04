/**
 * Export settings for static designs.
 *
 * Publishes a capability table per format
 * - so this module is that table, plus the scale syntax, in one place. The
 * inspector renders the settings a format actually supports and the exporter
 * reads the same capabilities, so a control can never appear for something the
 * output does not do.
 */
import type { Effect, ExportFormat, ExportPreset, StrokeLayer, XNode } from "../engine/types";

export type Resampling = "detailed" | "basic";
export type Quality = "low" | "medium" | "high";

export interface FormatCaps {
  /** "Ignore overlapping layers" (PNG, JPG, SVG). */
  ignoreOverlap: boolean;
  /** "Include bounding box" - text layers only (PNG, JPG, SVG). */
  boundingBox: boolean;
  /** "Include id attribute" (SVG). */
  includeId: boolean;
  /** "Outline text" (SVG). */
  outlineText: boolean;
  /** "Simplify stroke" (SVG). */
  simplifyStroke: boolean;
  /** "Image quality" - low / medium / high (JPG, PDF). */
  quality: boolean;
  /** "Image resampling" - detailed / basic (PNG, JPG, PDF). */
  resampling: boolean;
  /** The article is explicit: SVGs and PDFs are exported at 1x only. */
  oneToOne: boolean;
}

/**
 * Export capability table. PNG and JPG take the two overlap
 * settings; SVG adds the three markup settings; PDF takes none of them but does
 * take quality and resampling.
 */
export const FORMAT_CAPS: Record<ExportFormat, FormatCaps> = {
  PNG: {
    ignoreOverlap: true,
    boundingBox: true,
    includeId: false,
    outlineText: false,
    simplifyStroke: false,
    quality: false,
    resampling: true,
    oneToOne: false,
  },
  JPG: {
    ignoreOverlap: true,
    boundingBox: true,
    includeId: false,
    outlineText: false,
    simplifyStroke: false,
    quality: true,
    resampling: true,
    oneToOne: false,
  },
  SVG: {
    ignoreOverlap: true,
    boundingBox: true,
    includeId: true,
    outlineText: true,
    simplifyStroke: true,
    quality: false,
    resampling: false,
    oneToOne: true,
  },
  PDF: {
    ignoreOverlap: false,
    boundingBox: false,
    includeId: false,
    outlineText: false,
    simplifyStroke: false,
    quality: true,
    resampling: true,
    oneToOne: true,
  },
};

export const FORMATS: ExportFormat[] = ["PNG", "JPG", "SVG", "PDF"];

/** The scales the dropdown offers. The article documents the free-text syntax
 *  below rather than this list, so the field is the real input and these are
 *  conveniences. */
export const SCALE_PRESETS = [0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Default JPG quality is High and default PDF quality is Medium. */
export function defaultQuality(format: ExportFormat): Quality {
  return format === "JPG" ? "high" : "medium";
}

/** `toBlob`/JPEG encoder quality for each step. */
export function qualityValue(q: Quality): number {
  return q === "low" ? 0.4 : q === "medium" ? 0.7 : 0.92;
}

export interface ExportSize {
  width: number;
  height: number;
  /** The multiplier that produced it, for the readout. */
  scale: number;
}

/** Extra canvas an export needs beyond the layer's own box, per side.
 *
 * A drop shadow, a layer blur or an outside stroke paints PAST the bounds;
 * the exported area grows so the effect lands in the file rather than being
 * cut off at the box (PNG troubleshooting: an effect that "extends past
 * the layer's bounds" enlarges the export - "your 64px icon comes out at
 * 96px"). The blur reaches 1.5x its radius, the same inflation the Rust
 * renderer applies to its clip bounds (crates/x-render/src/ir.rs), so the
 * web canvas, the SVG viewBox and the native file agree on one number.
 * Inner shadows and background blur are contained by the layer and bleed
 * nothing; invisible effects count for nothing; several shadows take the
 * max per side, never a sum. */
export interface ExportBleed {
  l: number;
  t: number;
  r: number;
  b: number;
}

export function exportBleed(
  node: Partial<Pick<XNode, "effects" | "strokeWidth" | "strokeAlign" | "strokes">>,
): ExportBleed {
  let l = 0;
  let t = 0;
  let r = 0;
  let b = 0;
  for (const e of (node.effects ?? []) as Effect[]) {
    if (!e.visible || (e.kind !== "drop-shadow" && e.kind !== "layer-blur")) continue;
    const pad = 1.5 * Math.max(0, e.blur || 0);
    const dx = e.kind === "drop-shadow" ? e.x || 0 : 0;
    const dy = e.kind === "drop-shadow" ? e.y || 0 : 0;
    l = Math.max(l, pad - dx);
    r = Math.max(r, pad + dx);
    t = Math.max(t, pad - dy);
    b = Math.max(b, pad + dy);
  }
  // Outside strokes paint a full-width ring beyond the box; centre strokes
  // only reach half past it and the box itself keeps them in Figma's PNG
  // preview terms - we pad the outside case, which is the clipping bug.
  const outsidePad = (align: string | undefined, width: number | undefined) =>
    align === "outside" ? Math.max(0, width || 0) : 0;
  let sw = outsidePad(node.strokeAlign, node.strokeWidth);
  for (const st of (node.strokes ?? []) as StrokeLayer[]) {
    if (st.visible !== false) sw = Math.max(sw, outsidePad(st.align, st.width));
  }
  return { l: l + sw, t: t + sw, r: r + sw, b: b + sw };
}

/**
 * The size an export will come out at.
 *
 * Scale field takes a plain multiplier, or a size with a unit: `2x` is
 * twice the layer, `500w` is 500 wide with the height following the aspect
 * ratio, `300h` is 300 tall with the width following it. A vector format is
 * pinned at 1x - SVG/PDF exports are supported at 1x - so `2x` on an SVG still comes out at the
 * design size rather than silently scaling a "vector" file.
 */
export function exportSize(
  node: { w: number; h: number } & Partial<Pick<XNode, "effects" | "strokeWidth" | "strokeAlign" | "strokes">>,
  preset: { format: ExportFormat; scale: number | string },
): ExportSize {
  const caps = FORMAT_CAPS[preset.format];
  // The box the file is sized from: the layer plus whatever its effects
  // paint past it. A page/slice `box` carries no effects, so it stays exact.
  const bl = exportBleed(node);
  const w = Math.max(1, node.w + bl.l + bl.r);
  const h = Math.max(1, node.h + bl.t + bl.b);
  if (caps.oneToOne) return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), scale: 1 };
  const spec = parseScale(preset.scale);
  if (spec.kind === "width") {
    const width = Math.max(1, Math.round(spec.value));
    return { width, height: Math.max(1, Math.round((h * spec.value) / w)), scale: width / w };
  }
  if (spec.kind === "height") {
    const height = Math.max(1, Math.round(spec.value));
    return { width: Math.max(1, Math.round((w * spec.value) / h)), height, scale: height / h };
  }
  return {
    width: Math.max(1, Math.round(w * spec.value)),
    height: Math.max(1, Math.round(h * spec.value)),
    scale: spec.value,
  };
}

export type ScaleSpec =
  | { kind: "multiplier"; value: number }
  | { kind: "width"; value: number }
  | { kind: "height"; value: number };

/** A scale as typed: `2x`, `1.5x`, `500w`, `300h`, or a bare number for a
 *  multiplier. Anything else is null so the field can keep what it had. */
export function parseScale(raw: number | string | undefined): ScaleSpec {
  if (typeof raw === "number") return { kind: "multiplier", value: clampScale(raw) };
  const s = String(raw ?? "").trim().toLowerCase().replace(",", ".");
  const m = /^(\d*\.?\d+)\s*([xwh]?)$/.exec(s);
  if (!m) return { kind: "multiplier", value: 1 };
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return { kind: "multiplier", value: 1 };
  if (m[2] === "w") return { kind: "width", value };
  if (m[2] === "h") return { kind: "height", value };
  return { kind: "multiplier", value: clampScale(value) };
}

/** The scale as it is written back into the field. Presets read "2x"; a size
 *  keeps its unit so the field still means what it says. */
export function formatScale(raw: number | string | undefined): string {
  const spec = parseScale(raw);
  if (spec.kind === "width") return `${spec.value}w`;
  if (spec.kind === "height") return `${spec.value}h`;
  const v = Math.round(spec.value * 1000) / 1000;
  return `${v}x`;
}

/** 0.01x to 64x. Below that an export is a dot; above it, a single PNG would
 *  need more memory than the tab has. */
export const SCALE_MIN = 0.01;
export const SCALE_MAX = 64;

export function clampScale(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

/**
 * Everything a preset says, with the format's defaults filled in. Presets are
 * stored in the document, so an older one has none of these fields - reading
 * through this means the exporter never sees `undefined` where a boolean goes.
 */
export interface ResolvedSettings {
  ignoreOverlap: boolean;
  boundingBox: boolean;
  includeId: boolean;
  outlineText: boolean;
  simplifyStroke: boolean;
  quality: Quality;
  resampling: Resampling;
}

export function resolveSettings(preset: ExportPreset): ResolvedSettings {
  const caps = FORMAT_CAPS[preset.format];
  const p = preset as ExportPreset & Partial<ResolvedSettings>;
  return {
    // Both overlap settings are enabled by default.
    ignoreOverlap: caps.ignoreOverlap ? p.ignoreOverlap !== false : false,
    boundingBox: caps.boundingBox ? p.boundingBox !== false : false,
    includeId: caps.includeId ? p.includeId === true : false,
    // On by default wherever the format supports it, which is what the article
    // says for a selection containing text.
    outlineText: caps.outlineText ? p.outlineText !== false : false,
    simplifyStroke: caps.simplifyStroke ? p.simplifyStroke !== false : false,
    quality: caps.quality ? (p.quality ?? defaultQuality(preset.format)) : defaultQuality(preset.format),
    resampling: caps.resampling ? (p.resampling ?? "detailed") : "detailed",
  };
}

/** A new preset for a format with default settings. */
export function newPreset(format: ExportFormat, scale: number | string = 1): ExportPreset {
  return { format, scale: FORMAT_CAPS[format].oneToOne ? 1 : (scale as number), suffix: "" };
}

/** Two presets that would write the same file: format, scale, suffix and
 *  every format setting. The bulk dialog's per-row preset starts life as a
 *  copy of the layer's first stored preset, and this is how it recognises it. */
export function samePreset(a: ExportPreset, b: ExportPreset): boolean {
  return (
    a.format === b.format &&
    String(a.scale) === String(b.scale) &&
    (a.suffix ?? "") === (b.suffix ?? "") &&
    a.ignoreOverlap === b.ignoreOverlap &&
    a.boundingBox === b.boundingBox &&
    a.includeId === b.includeId &&
    a.outlineText === b.outlineText &&
    a.simplifyStroke === b.simplifyStroke &&
    (a.quality ?? "") === (b.quality ?? "") &&
    (a.resampling ?? "") === (b.resampling ?? "")
  );
}

/** A layer's stored presets minus the one the bulk dialog is already running:
 *  the dialog row defaults to the first stored preset, so exporting it again
 *  would write the same file twice. Only the first match is dropped - a
 *  layer that genuinely stores the same preset twice exports it twice. */
export function extrasOf(stored: ExportPreset[] | undefined, dialog: ExportPreset): ExportPreset[] {
  const out: ExportPreset[] = [];
  let dropped = false;
  for (const p of stored ?? []) {
    if (!dropped && samePreset(p, dialog)) {
      dropped = true;
      continue;
    }
    out.push(p);
  }
  return out;
}
