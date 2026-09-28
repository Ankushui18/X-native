/** Independent TypeScript *filled-ink reference* for the Rust Outline Stroke
 * command. This is NOT a second document engine and NOT the old
 * `geometry.outlineStroke` helper: that one walks averaged normals and cannot
 * model alignment bands, dashes or joins. This reference computes the analytic
 * rectangular stroke band (alignment, miter/bevel/round outer corners, the
 * miter-limit bevel fallback) in plain JavaScript and classifies sampled
 * points under NONZERO winding, skipping samples close to the committed
 * contour so a faceted round join cannot turn a tolerance into a finding.
 *
 * The genuine generated-WASM `outline-stroke-corpus.mjs` run in CI produced
 * 30/30 independent filled-ink cases with the web guard still active, so the
 * promoted web owner dispatches the Rust command directly and does not consult
 * this reference per edit. `?outline=audit` opts into the diagnostic: the
 * committed vector is compared with this model before the DOM accepts the
 * delta. The source geometry and style come from the command's own undo
 * projection — the web host keeps no JS copy of the layer, and the bounded
 * shape query is gated on the offset dialect, which does not admit a live
 * stroke — so this reference is the independent half of that comparison, not a
 * second source of truth. A decisive disagreement pauses editing; a source the
 * model cannot cover is reported as `not-run`, never as a pass. This module
 * never paints, stores history or reads a document.
 */
import { auditDecision } from "./bridgeRuntimeAudit";
import type { RustOutlineChange, RustOutlineStrokeStyle } from "./rustSession";

type Point = [number, number];
type Rings = Point[][];
interface Rect { x: number; y: number; w: number; h: number }
interface Band { outer: number; inner: number; join: "miter" | "bevel" | "round" }

const EPS = 1e-8;
/** x-core compares the corner miter ratio against the limit; a right angle's
 * ratio is exactly sqrt(2), so a smaller limit bevels every rectangle corner. */
const RIGHT_ANGLE_MITER = Math.SQRT2;
/** x-core emits at most 15-degree arcs, so a sample farther than this from
 * every committed edge cannot be inside a facet/arc sliver. */
const EDGE_CLEARANCE = 0.42;

/** `?outline=audit` — the route uses the real URL's search query, not its
 * document-ID hash. */
export function outlineAuditRequested(): boolean {
  try { return typeof location !== "undefined" && new URLSearchParams(location.search).get("outline") === "audit"; }
  catch { return false; }
}

export interface OutlineAuditVerdict {
  /** Every decisive sample agreed with the model. */
  verified: boolean;
  /** `false` means the model covered too little to count as evidence; the
   * caller reports `not-run` instead of inventing a pass or a finding. */
  decisive: boolean;
  /** Short, classed reason: never node ids, coordinates or user data. */
  reason: string;
}

/** The one centreline dialect this reference models: an unrounded rectangle
 * that owned one live stroke — the only source the promoted web preview offers
 * the command. Its corners are solved by x-core without curvature, so both
 * boundaries are plain rectangles. The caller passes the source projection the
 * command's own undo returned. */
export function outlineReferenceRect(source: RustOutlineChange): Rect | null {
  if (source.kind !== "rect" || source.radius !== 0 || !source.stroke) return null;
  if (![source.x, source.y, source.w, source.h].every(Number.isFinite) ||
      source.w <= 0 || source.h <= 0) return null;
  return { x: source.x, y: source.y, w: source.w, h: source.h };
}

function bandModel(rect: Rect, style: RustOutlineStrokeStyle): Band | null {
  const { width, align, join, miterLimit, dash, widthProfile } = style;
  if (!Number.isFinite(width) || width <= 0 || width > 2048) return null;
  // Dashes and variable-width stations need the perimeter/dash-phase model the
  // promoted corpus proves; this bounded reference deliberately declines them.
  if (dash.length || widthProfile.length) return null;
  if (!Number.isFinite(miterLimit) || miterLimit < 1 || miterLimit > 64) return null;
  const outer = align === "inside" ? 0 : align === "center" ? width / 2 : width;
  const inner = align === "inside" ? width : align === "center" ? width / 2 : 0;
  // A band that reaches across the rectangle (or collapses the inner ring) is
  // not the two-ring model any more. Decline rather than guess.
  const limit = Math.min(rect.w, rect.h);
  if (2 * outer >= limit || 2 * inner >= limit) return null;
  const effective = join === "miter" && miterLimit + EPS >= RIGHT_ANGLE_MITER ? "miter"
    : join === "miter" ? "bevel" : join;
  return { outer, inner, join: effective };
}

function inBox(lx: number, ly: number, d: number, rect: Rect): boolean {
  return lx >= -d - EPS && lx <= rect.w + d + EPS && ly >= -d - EPS && ly <= rect.h + d + EPS;
}

/** x-core offsets the whole width on one side of a closed centreline: the
 * alignment side keeps the requested join, the centreline side stays sharp. */
function modelInk(band: Band, rect: Rect, lx: number, ly: number): boolean {
  // An inside stroke keeps the centreline itself as its outer boundary.
  if (!inBox(lx, ly, band.outer, rect)) return false;
  if (band.outer > 0 && band.join !== "miter") {
    // Outward corners only: bevel cuts the diagonal and round replaces it with
    // a quarter disc of the offset radius.
    const u = Math.max(-lx, lx - rect.w, 0);
    const v = Math.max(-ly, ly - rect.h, 0);
    if (u > 0 || v > 0) {
      if (band.join === "bevel" ? u + v > band.outer + EPS : u * u + v * v > band.outer * band.outer + EPS) {
        return false;
      }
    }
  }
  return !(band.inner > 0 && inBox(lx, ly, -band.inner, rect));
}

function outputRings(outline: RustOutlineChange): Rings | null {
  if (outline.kind !== "vector") return null;
  const rings: Rings = [];
  let ring: Point[] = [];
  for (const command of outline.path) {
    // The web checkpoint cannot represent curves, so a non-linear result is
    // outside this reference rather than a finding.
    if (command[0] !== "M" && command[0] !== "L" && command[0] !== "Z") return null;
    if (command[0] === "Z") {
      if (ring.length < 3) return null;
      rings.push(ring);
      ring = [];
    } else ring.push([outline.x + command[1], outline.y + command[2]]);
  }
  if (ring.length || !rings.length) return null;
  return rings;
}

/** Nonzero winding containment, the fill rule native `.x` vectors use. */
function windingContains(rings: Rings, point: Point): boolean {
  let winding = 0;
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (a[1] <= point[1]) {
      if (b[1] > point[1] && cross > 0) winding++;
    } else if (b[1] <= point[1] && cross < 0) winding--;
  }
  return winding !== 0;
}

function edgeDistance(rings: Rings, point: Point): number {
  let best = Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    const t = denominator <= EPS ? 0
      : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator));
    best = Math.min(best, Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)));
  }
  return best;
}

/** Bounded, deterministic lattice + explicit join probes, exactly the sampling
 * discipline the promoted corpus uses: a dense grid of at most 57x33 points
 * with near-boundary samples skipped, plus the corner points where miter,
 * bevel and round differ. Pure: no native call, no history, no paint. */
export function outlineInkVerdict(rect: Rect, style: RustOutlineStrokeStyle,
    outline: RustOutlineChange): OutlineAuditVerdict {
  const band = bandModel(rect, style);
  if (!band) return { verified: false, decisive: false, reason: "stroke style outside the rectangle band model" };
  const rings = outputRings(outline);
  if (!rings) return { verified: false, decisive: false, reason: "result is not a closed linear vector contour" };
  if (outline.fill !== style.color) {
    return { verified: false, decisive: true, reason: "committed fill is not the source stroke paint" };
  }
  // A faceted round join sits strictly inside the analytic arc, so no decisive
  // sample may come closer to a committed edge than the facet sagitta.
  const clearance = EDGE_CLEARANCE + 0.02 * Math.max(band.outer, band.inner, 1);
  const margin = Math.max(band.outer, band.inner) + 6;
  let compared = 0, ink = 0, empty = 0;
  const disagrees = (lx: number, ly: number): boolean => {
    const point: Point = [rect.x + lx, rect.y + ly];
    if (edgeDistance(rings, point) < clearance) return false;
    const expected = modelInk(band, rect, lx, ly);
    const actual = windingContains(rings, point);
    compared++;
    if (expected) ink++; else empty++;
    return expected !== actual;
  };
  for (let iy = 0; iy <= 32; iy++) for (let ix = 0; ix <= 56; ix++) {
    const lx = -margin + (rect.w + 2 * margin) * ix / 56;
    const ly = -margin + (rect.h + 2 * margin) * iy / 32;
    if (disagrees(lx, ly)) return { verified: false, decisive: true, reason: "committed ink differs from the rectangle band model" };
  }
  // The grid deliberately skips the corner squares. These probes are decisive
  // for the alignment side only, which is where x-core applies the join.
  if (band.outer > 0) {
    const r = band.outer;
    const probes: [number, number][] = [
      [-0.8 * r, -0.8 * r],
      [-0.8 * r, -0.3 * r],
      [rect.w / 2, -0.6 * r],
      [rect.w + 0.8 * r, rect.h + 0.8 * r],
    ];
    for (const [lx, ly] of probes) {
      if (lx < -r || ly < -r || lx > rect.w + r || ly > rect.h + r) continue;
      if (disagrees(lx, ly)) return { verified: false, decisive: true, reason: "committed join ink differs from the rectangle band model" };
    }
  }
  if (compared < 96 || !ink || !empty) {
    return { verified: false, decisive: false, reason: "insufficient decisive samples for the rectangle band model" };
  }
  return { verified: true, decisive: true, reason: "committed filled ink equals the independent rectangle band model" };
}

/** Record the opt-in diagnostic. Only a decisive disagreement blocks: the
 * caller has already committed the same command the default route runs, so
 * pausing is honest, while an uncovered source is reported as `not-run`. */
export function recordOutlineAudit(verdict: OutlineAuditVerdict): void {
  auditDecision({ bridge: "session", operation: "outline",
    result: verdict.verified ? "rust" : "none",
    guard: verdict.verified ? "passed" : verdict.decisive ? "blocked" : "not-run",
    candidate: true,
    reason: verdict.verified ? "opt-in outline audit: committed ink equals the independent rectangle band model"
      : verdict.decisive ? `opt-in outline audit rejected the committed ink: ${verdict.reason}`
        : `opt-in outline audit did not cover this source: ${verdict.reason}` });
  if (!verdict.verified && verdict.decisive) {
    throw new Error("Outline ink did not match the independent rectangle reference; editing must pause.");
  }
}
