import type { StrokeSides, XNode } from "./types";

/**
 * The stroke and effect rules that need no canvas, kept apart from the painter
 * so they can be tested and reused by the panel, the SVG writer and Dev Mode.
 */

/** Individual strokes picker, in the order its fields appear. */
export const SIDES: { id: StrokeSides; label: string }[] = [
  { id: "all", label: "All sides" },
  { id: "top", label: "Top" },
  { id: "right", label: "Right" },
  { id: "bottom", label: "Bottom" },
  { id: "left", label: "Left" },
  { id: "custom", label: "Custom" },
];

/** Which of [top, right, bottom, left] carry a stroke, and how thick. */
export function sideWidths(
  sides: StrokeSides | undefined,
  perSide: readonly number[] | undefined,
  weight: number,
): [number, number, number, number] {
  const w = Math.max(0, weight);
  switch (sides ?? "all") {
    case "top":
      return [w, 0, 0, 0];
    case "right":
      return [0, w, 0, 0];
    case "bottom":
      return [0, 0, w, 0];
    case "left":
      return [0, 0, 0, w];
    case "custom": {
      const p = perSide ?? [0, 0, 0, 0];
      return [0, 1, 2, 3].map((i) => Math.max(0, p[i] ?? 0)) as [number, number, number, number];
    }
    default:
      return [w, w, w, w];
  }
}

/**
 * The band each side's stroke is clipped to: the region of the plane that is
 * nearer to that side than to any other, bounded by 45° mitre lines through the
 * corners. That is exactly how CSS splits a border between its sides, so a
 * top-only stroke spans the full width and tapers away at the corners instead of
 * stopping short of them - a cone from the centre would only be right for a
 * square. Returned as polygons, in [top, right, bottom, left] order.
 */
export function sideCones(x: number, y: number, w: number, h: number): [number, number][][] {
  const A = w + h + 8;
  const x1 = x + w;
  const y1 = y + h;
  // Each wedge is capped by a line far outside the box and closed by the two 45°
  // mitre lines through its corners, which meet at the apex listed last.
  return [
    [[x - A, y - A], [x1 + A, y - A], [x + w / 2, y + w / 2]],
    [[x1 + A, y - A], [x1 + A, y1 + A], [x1 - h / 2, y + h / 2]],
    [[x - A, y1 + A], [x1 + A, y1 + A], [x + w / 2, y1 - w / 2]],
    [[x - A, y - A], [x - A, y1 + A], [x + h / 2, y + h / 2]],
  ];
}

/** Only allows individual strokes on rectangles, frames, components and instances. */
export function sidesSupported(kind: XNode["kind"]): boolean {
  return kind === "rect" || kind === "frame" || kind === "component" || kind === "instance";
}

/**
 * "Dashes" field: `dash, gap, dash, gap…`. Any odd-length list repeats,
 * which is what makes `4 2 1` a usable pattern. Returns null for input that
 * cannot be a pattern, so the caller can refuse it instead of clearing the dash.
 */
export function parseDashPattern(text: string): number[] | null {
  const parts = text
    .trim()
    .split(/[\s,]+/)
    .filter((p) => p.length > 0);
  if (!parts.length) return [];
  const out: number[] = [];
  for (const p of parts) {
    if (!/^-?\d*\.?\d+$/.test(p)) return null;
    const v = Number(p);
    if (!Number.isFinite(v) || v < 0) return null;
    out.push(v);
  }
  return out;
}

/** The dash sequence to feed a canvas, in device-independent pixels. */
export function dashArray(
  pattern: readonly number[] | undefined,
  dash: number,
  gap: number,
  scale = 1,
): number[] {
  if (pattern && pattern.length) return pattern.map((v) => Math.max(0.01, v * scale));
  if (dash > 0) return [dash * scale, Math.max(0.01, (gap || dash) * scale)];
  return [];
}

/**
 * "Miter angle": any join sharper than the angle is bevelled. The
 * canvas asks for the ratio between the miter's length and the stroke width,
 * which for an angle θ is 1 / sin(θ / 2) - so 180° bevels everything (that is
 * the bevel join) and 0° never does (the miter join).
 */
export function miterLimitFromAngle(degrees: number | undefined): number {
  const a = degrees ?? 0;
  if (a <= 0) return 1_000_000;
  if (a >= 180) return 1;
  return 1 / Math.sin((a * Math.PI) / 360);
}
