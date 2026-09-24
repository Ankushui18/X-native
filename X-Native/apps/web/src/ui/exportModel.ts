/**
 * Export settings, as Figma's "Export formats and settings for static designs"
 * documents them.
 *
 * The article is unusually specific - it publishes a capability table per format
 * - so this module is that table, plus the scale syntax, in one place. The
 * inspector renders the settings a format actually supports and the exporter
 * reads the same capabilities, so a control can never appear for something the
 * output does not do.
 */
import type { ExportFormat, ExportPreset } from "../engine/types";

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
 * Figma's capability table, verbatim. PNG and JPG take the two overlap
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

/** Figma's default JPG quality is High and its default PDF quality is Medium. */
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

/**
 * The size an export will come out at.
 *
 * Figma's scale field takes a plain multiplier, or a size with a unit: `2x` is
 * twice the layer, `500w` is 500 wide with the height following the aspect
 * ratio, `300h` is 300 tall with the width following it. A vector format is
 * pinned at 1x - the article is explicit that "Figma only supports exports for
 * SVGs at 1x" and the same for PDFs - so `2x` on an SVG still comes out at the
 * design size rather than silently scaling a "vector" file.
 */
export function exportSize(
  node: { w: number; h: number },
  preset: { format: ExportFormat; scale: number | string },
): ExportSize {
  const caps = FORMAT_CAPS[preset.format];
  const w = Math.max(1, node.w);
  const h = Math.max(1, node.h);
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
    // Both overlap settings are on out of the box, as in Figma.
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

/** A new preset for a format, with Figma's defaults. */
export function newPreset(format: ExportFormat, scale: number | string = 1): ExportPreset {
  return { format, scale: FORMAT_CAPS[format].oneToOne ? 1 : (scale as number), suffix: "" };
}
