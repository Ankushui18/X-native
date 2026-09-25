/**
 * Procedural Modifier Stack (Phase 1 Geometry Engine)
 *
 * Instead of destructive flattening, layers can define a procedural modifier
 * pipeline. The base geometry is processed through an ordered stack of modifiers:
 *
 * Base Geometry (e.g. Rectangle, Vector, Text)
 *   ↓ RoundedCorners(radius, smoothing)
 *   ↓ Offset(distance, join, miterLimit)
 *   ↓ Boolean(op, targetGeometry)
 *   ↓ Simplify(tolerance)
 *   ↓ Stroke(width, profile, cap, join)
 *   ↓ Transform(affine_matrix)
 *
 * Every modifier has explicit parameters and re-evaluates the resulting geometry
 * on demand, retaining the original geometry non-destructively.
 */

import type { PathPoint, VectorNetwork, StrokeCap, StrokeJoin } from "./types";
import {
  offsetPath,
  simplifyPath,
  booleanPath,
  outlineStroke,
  pathToVectorNetwork,
  pathBounds,
} from "./geometry";

export interface VariableWidthPoint {
  /** Normalized position along curve: 0.0 (start) to 1.0 (end). */
  position: number;
  /** Width multiplier relative to base strokeWidth (e.g. 1.0 = normal, 2.0 = double, 0.0 = taper to point). */
  widthMultiplier: number;
}

export interface VariableWidthProfile {
  points: VariableWidthPoint[];
}

export interface RoundedCornersModifier {
  type: "roundedCorners";
  enabled?: boolean;
  radius: number;
  smoothing?: number;
  cornerIndices?: number[];
}

export interface OffsetModifier {
  type: "offset";
  enabled?: boolean;
  distance: number;
  join?: "miter" | "round" | "bevel";
  miterLimit?: number;
}

export interface BooleanModifier {
  type: "boolean";
  enabled?: boolean;
  op: "union" | "subtract" | "intersect" | "exclude";
  targetNodeId?: string;
  targetGeometry?: PathPoint[];
}

export interface SimplifyModifier {
  type: "simplify";
  enabled?: boolean;
  tolerance: number;
}

export interface StrokeModifier {
  type: "stroke";
  enabled?: boolean;
  width: number;
  cap?: StrokeCap;
  join?: StrokeJoin;
  miterLimit?: number;
  dashes?: number[];
  variableWidth?: VariableWidthProfile;
}

export interface TransformModifier {
  type: "transform";
  enabled?: boolean;
  /** Affine matrix [a, b, c, d, tx, ty] where x' = a*x + c*y + tx, y' = b*x + d*y + ty */
  matrix: [number, number, number, number, number, number];
}

export type Modifier =
  | RoundedCornersModifier
  | OffsetModifier
  | BooleanModifier
  | SimplifyModifier
  | StrokeModifier
  | TransformModifier;

export interface GeometryInput {
  path: PathPoint[];
  closed: boolean;
  vectorNetwork?: VectorNetwork;
}

export interface EvaluatedGeometry {
  path: PathPoint[];
  closed: boolean;
  vectorNetwork?: VectorNetwork;
  bounds: { x: number; y: number; w: number; h: number };
}

/**
 * Applies affine matrix [a, b, c, d, tx, ty] to a PathPoint.
 */
function applyAffine(pt: PathPoint, m: [number, number, number, number, number, number]): PathPoint {
  const [a, b, c, d, tx, ty] = m;
  const out: PathPoint = {
    x: a * pt.x + c * pt.y + tx,
    y: b * pt.x + d * pt.y + ty,
  };
  if (pt.ix !== undefined && pt.iy !== undefined) {
    out.ix = a * pt.ix + c * pt.iy;
    out.iy = b * pt.ix + d * pt.iy;
  }
  if (pt.ox !== undefined && pt.oy !== undefined) {
    out.ox = a * pt.ox + c * pt.oy;
    out.oy = b * pt.ox + d * pt.oy;
  }
  if (pt.cornerRadius !== undefined) out.cornerRadius = pt.cornerRadius;
  if (pt.mirrorMode !== undefined) out.mirrorMode = pt.mirrorMode;
  return out;
}

/**
 * Applies variable width profile interpolation to stroke expansion.
 */
export function sampleVariableWidth(profile: VariableWidthProfile | undefined, t: number): number {
  if (!profile || !profile.points || profile.points.length === 0) return 1.0;
  const pts = [...profile.points].sort((a, b) => a.position - b.position);
  if (t <= pts[0].position) return pts[0].widthMultiplier;
  if (t >= pts[pts.length - 1].position) return pts[pts.length - 1].widthMultiplier;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    if (t >= p0.position && t <= p1.position) {
      const span = p1.position - p0.position;
      const factor = span === 0 ? 0 : (t - p0.position) / span;
      return p0.widthMultiplier + (p1.widthMultiplier - p0.widthMultiplier) * factor;
    }
  }
  return 1.0;
}

/**
 * Evaluates a sequence of procedural modifiers over a base geometry.
 * Returns the final computed path and vector network.
 */
export function evaluateModifierStack(
  base: GeometryInput,
  modifiers: Modifier[],
): EvaluatedGeometry {
  let currentPath = base.path.map((p) => ({ ...p }));
  let isClosed = base.closed;
  let currentVn = base.vectorNetwork ? JSON.parse(JSON.stringify(base.vectorNetwork)) : undefined;

  for (const mod of modifiers) {
    if (mod.enabled === false) continue;

    switch (mod.type) {
      case "roundedCorners": {
        const r = Math.max(0, mod.radius);
        if (r > 0) {
          currentPath = currentPath.map((p, idx) => {
            if (!mod.cornerIndices || mod.cornerIndices.includes(idx)) {
              return { ...p, cornerRadius: r };
            }
            return p;
          });
        }
        break;
      }

      case "offset": {
        if (Math.abs(mod.distance) > 0.001) {
          currentPath = offsetPath(currentPath, mod.distance, isClosed);
          // Offsetting an open path closes it into a perimeter ribbon
          if (!isClosed && mod.distance !== 0) {
            isClosed = true;
          }
        }
        break;
      }

      case "boolean": {
        if (mod.targetGeometry && mod.targetGeometry.length >= 3) {
          const res = booleanPath(mod.op, [
            { poly: currentPath, ox: 0, oy: 0 },
            { poly: mod.targetGeometry, ox: 0, oy: 0 },
          ]);
          if (res && res.path && res.path.length > 0) {
            currentPath = res.path;
            isClosed = true;
          }
        }
        break;
      }

      case "simplify": {
        const tol = Math.max(0.1, mod.tolerance);
        currentPath = simplifyPath(currentPath, tol);
        break;
      }

      case "stroke": {
        const w = Math.max(0.5, mod.width);
        const outlined = outlineStroke(
          currentPath,
          w,
          isClosed,
          mod.cap ?? "none",
          mod.join ?? "miter",
        );
        if (outlined.length > 0) {
          currentPath = outlined;
          isClosed = true;
        }
        break;
      }

      case "transform": {
        currentPath = currentPath.map((p) => applyAffine(p, mod.matrix));
        if (currentVn && currentVn.vertices) {
          currentVn.vertices = currentVn.vertices.map((v: any) => {
            const [a, b, c, d, tx, ty] = mod.matrix;
            return {
              ...v,
              x: a * v.x + c * v.y + tx,
              y: b * v.y + d * v.y + ty,
            };
          });
        }
        break;
      }
    }
  }

  // Synchronize VectorNetwork representation
  if (!currentVn || modifiers.length > 0) {
    currentVn = pathToVectorNetwork(currentPath, isClosed);
  }

  const pb = pathBounds(currentPath, isClosed);

  return {
    path: currentPath,
    closed: isClosed,
    vectorNetwork: currentVn,
    bounds: { x: pb.minX, y: pb.minY, w: pb.w, h: pb.h },
  };
}
