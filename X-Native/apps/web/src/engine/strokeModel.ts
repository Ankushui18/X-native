import type { StrokeSides, VariableWidthPoint, VariableWidthProfile, VectorNetwork, XNode } from "./types";

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

/** Figma starts (and joins) every dashed line with a half-length dash. */
export function dashOffset(dashes: readonly number[]): number {
  return dashes.length ? dashes[0] / 2 : 0;
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

/* ── Variable-width profiles ──────────────────────────────────────────────
 * A profile is only honoured on vector/line/arrow centerlines; every other
 * consumer (paint, export, hit test, outline-stroke) funnels through these
 * helpers so "does this node have an active profile?" can never drift. */

const PROFILE_EPS = 1e-6;
/** Clamp a multiplier into the sane range: negative widths are meaningless, and
 *  anything past 8× the panel weight is a runaway drag, not a design choice. */
export const MAX_WIDTH_MULTIPLIER = 8;

/** Sort by position, clamp position to 0..1 and multipliers to 0..8. */
export function normalizeWidthProfile(points: readonly VariableWidthPoint[] | undefined): VariableWidthPoint[] {
  if (!points || !points.length) return [];
  return [...points]
    .map((p) => ({
      position: Math.min(1, Math.max(0, Number.isFinite(p.position) ? p.position : 0)),
      widthMultiplier: Math.min(
        MAX_WIDTH_MULTIPLIER,
        Math.max(0, Number.isFinite(p.widthMultiplier) ? p.widthMultiplier : 1),
      ),
    }))
    .sort((a, b) => a.position - b.position);
}

/**
 * Width multiplier at arc-length `t` (0..1), linearly interpolated between
 * the neighbouring control points and clamped to the end points outside the
 * profile's span. Accepts the bare points array the node stores or the
 * `{ points }` profile the modifier stack carries.
 */
export function sampleVariableWidth(
  profile: readonly VariableWidthPoint[] | VariableWidthProfile | undefined,
  t: number,
): number {
  const list: readonly VariableWidthPoint[] | undefined =
    profile == null ? undefined : "points" in profile ? profile.points : profile;
  const pts = normalizeWidthProfile(list);
  if (!pts.length) return 1.0;
  if (t <= pts[0].position) return pts[0].widthMultiplier;
  if (t >= pts[pts.length - 1].position) return pts[pts.length - 1].widthMultiplier;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    if (t >= p0.position && t <= p1.position) {
      const span = p1.position - p0.position;
      const f = span <= PROFILE_EPS ? 0 : (t - p0.position) / span;
      return p0.widthMultiplier + (p1.widthMultiplier - p0.widthMultiplier) * f;
    }
  }
  return 1.0;
}

/** True when the profile actually varies the width — anything else (missing,
 *  empty, all-equal) takes the uniform fast path everywhere. */
export function hasVariableWidth(points: readonly VariableWidthPoint[] | undefined): boolean {
  const pts = normalizeWidthProfile(points);
  if (pts.length < 2) return false;
  const first = pts[0].widthMultiplier;
  return pts.some((p) => Math.abs(p.widthMultiplier - first) > PROFILE_EPS);
}

/** Largest multiplier in the profile; the hit test and arrowheads size from this. */
export function maxWidthMultiplier(points: readonly VariableWidthPoint[] | undefined): number {
  const pts = normalizeWidthProfile(points);
  if (!pts.length) return 1;
  return Math.max(...pts.map((p) => p.widthMultiplier));
}

/** Effective stroke width at arc-length `t` for a profiled node. */
export function widthAt(n: XNode, t: number): number {
  return Math.max(0, n.strokeWidth) * sampleVariableWidth(n.strokeWidthProfile, t);
}

/** A network branches when a vertex joins three or more segments; chains and
 *  loops (max degree 2) take width profiles, branching networks do not. */
export function isBranchingNetwork(net: VectorNetwork | undefined): boolean {
  if (!net || net.segments.length < 2) return false;
  const deg = new Map<number, number>();
  for (const s of net.segments) {
    deg.set(s.start, (deg.get(s.start) ?? 0) + 1);
    deg.set(s.end, (deg.get(s.end) ?? 0) + 1);
  }
  for (const d of deg.values()) if (d > 2) return true;
  return false;
}

/** Whether `n` paints its base stroke through the variable-width outline. */
export function usesVariableWidth(n: XNode): boolean {
  if (n.kind !== "vector" && n.kind !== "line" && n.kind !== "arrow") return false;
  if (!(n.strokeWidth > 0) || !n.strokeVisible || !n.strokePaint || isNonePaint(n.strokePaint)) return false;
  // A profiled outline follows one centerline; on a branching network it
  // would swallow the branches' strokes, so branching stays uniform.
  if (isBranchingNetwork(n.vectorNetwork)) return false;
  return hasVariableWidth(n.strokeWidthProfile);
}

function isNonePaint(paint: string): boolean {
  return !paint || paint === "none" || paint === "#00000000";
}

/**
 * How far a node's visible strokes spill past its box: outside strokes by
 * their full weight, centre strokes by half — painted pixels stay clickable.
 * Inside strokes never leave the box. Variable-width centerlines spill by
 * their hottest point.
 */
export function strokeSpill(n: XNode): number {
  const spill = (w: number, align: string | undefined) =>
    align === "outside" ? Math.max(0, w) : align === "center" ? Math.max(0, w) / 2 : 0;
  const forced = n.kind === "line" || n.kind === "arrow" ? "center" : undefined;
  let pad = 0;
  if (n.strokeVisible && n.strokeWidth > 0 && n.strokePaint && !isNonePaint(n.strokePaint)) {
    const w = usesVariableWidth(n) ? n.strokeWidth * maxWidthMultiplier(n.strokeWidthProfile) : n.strokeWidth;
    pad = Math.max(pad, spill(w, forced ?? n.strokeAlign));
  }
  for (const s of n.strokes ?? []) {
    if (s.visible === false || !(s.width > 0) || !s.color || isNonePaint(s.color)) continue;
    pad = Math.max(pad, spill(s.width, forced ?? s.align));
  }
  return pad;
}
