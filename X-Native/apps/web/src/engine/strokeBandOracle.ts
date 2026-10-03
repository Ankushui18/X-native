/** Independent rectangle reference for the *opt-in* Rust command boundary.
 * This is NOT a TypeScript stroke/document engine. Genuine-WASM rectangle
 * parity passed 30/30 in CI run 36377086997; default edits use Rust directly.
 * ?stroke=audit retains comparison for diagnostics, never paint or history. */
import { auditDecision } from "./bridgeRuntimeAudit";
import type { RustNodeChange, RustStateChange, RustStrokeChange } from "./rustSession";

type Point = [number, number];
export function rectangleStrokeOracle(w: number, h: number, style: Pick<RustStrokeChange, "width" | "align" | "join">):
    { outer: Point[]; inner: Point[] } {
  const { width, align, join } = style;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 ||
      !Number.isFinite(width) || width < 0 || width > 2048) throw new Error("Invalid stroke oracle inputs");
  if (width === 0) return { outer: [], inner: [] };
  const out = align === "outside" ? width : align === "center" ? width / 2 : 0;
  const inset = align === "inside" ? width : align === "center" ? width / 2 : 0;
  const rectangle = (d: number): Point[] => {
    const low = d === 0 ? 0 : -d;
    return [[low, low], [w + d, low], [w + d, h + d], [low, h + d]];
  };
  const bevel: Point[] = [[-out, 0], [0, -out], [w, -out], [w + out, 0],
    [w + out, h], [w, h + out], [0, h + out], [-out, h]];
  const outer = join === "bevel" && out > 0 ? bevel : rectangle(out);
  const inner: Point[] = inset > 0 && 2 * inset >= Math.min(w, h) ? []
    : [[inset, inset], [w - inset, inset], [w - inset, h - inset], [inset, h - inset]];
  return { outer, inner };
}

export function strokeMatchesRectangle(node: Pick<RustNodeChange, "w" | "h">, stroke: RustStrokeChange): boolean {
  const expected = rectangleStrokeOracle(node.w, node.h, stroke);
  const same = (a: Point[], b: Point[]) => a.length === b.length &&
    a.every(([x, y], i) => Math.abs(x - b[i][0]) <= 1e-8 && Math.abs(y - b[i][1]) <= 1e-8);
  return same(stroke.outer, expected.outer) && same(stroke.inner, expected.inner);
}

function auditRequested(): boolean {
  try { return typeof location !== "undefined" && new URLSearchParams(location.search).get("stroke") === "audit"; }
  catch { return false; }
}

/** Only in audit mode, compare an already-acknowledged Rust edit. If it
 * disagrees, freeze the preview and offer recovery export; it would be unsafe
 * to start a second TS owner after the native history has advanced. */
export function verifyStrokeDelta(change: RustStateChange, getNode: (id: string) => RustNodeChange | null): RustStateChange {
  const stroke = change.stroke;
  if (!stroke || !auditRequested()) return change;
  const node = change.node?.id === stroke.id ? change.node : getNode(stroke.id);
  const passes = !!node && strokeMatchesRectangle(node, stroke);
  auditDecision({ bridge: "session", operation: "stroke", result: passes ? "rust" : "none",
    guard: passes ? "passed" : "blocked", candidate: true,
    reason: passes ? "native contours equal independent rectangular offsets" : "native stroke contour equivalence failed" });
  if (!passes) throw new Error("Native stroke offsets differ from the independent rectangle oracle");
  return change;
}
