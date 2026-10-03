/**
 * Smart Animate Identity System (Phase 0/4 Foundation - Section 3.E)
 *
 * Matching Priority:
 * 1. Explicit `animationId` or `prototypeIdentity`
 * 2. `componentId` / `instanceId` match
 * 3. Stable structural identity (tree path e.g. "0/2/1")
 * 4. Layer `name` match
 * 5. Geometry similarity (point count, aspect ratio, bounding box)
 * 6. Heuristic fallback (closest spatial proximity)
 */

import type { ProtoEasing, XNode } from "./types";
import { parseHex, toHexA } from "../ui/color";

export interface InterpolatedNode {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  rotation: number;
  cornerRadii: [number, number, number, number];
  fill: string;
}

/** Easing curves matching standard animation specifications. */
export function solveEasing(easing: ProtoEasing = "easeOut", t: number): number {
  const clampT = Math.max(0, Math.min(1, t));
  switch (easing) {
    case "linear":
      return clampT;
    case "easeIn":
      return clampT * clampT * clampT;
    case "easeOut":
      return 1 - Math.pow(1 - clampT, 3);
    case "easeInOut":
      return clampT < 0.5 ? 4 * clampT * clampT * clampT : 1 - Math.pow(-2 * clampT + 2, 3) / 2;
    case "spring":
      return 1 - Math.exp(-6 * clampT) * Math.cos(6.5 * clampT);
    case "bouncy":
      return 1 - Math.exp(-5 * clampT) * Math.cos(9 * clampT);
    default:
      return 1 - Math.pow(1 - clampT, 3);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return a + diff * t;
}

function lerpColor(c1: string, c2: string, t: number): string {
  try {
    const p1 = parseHex(c1);
    const p2 = parseHex(c2);
    const r = Math.round(lerp(p1.r, p2.r, t));
    const g = Math.round(lerp(p1.g, p2.g, t));
    const b = Math.round(lerp(p1.b, p2.b, t));
    const a = lerp(p1.a, p2.a, t);
    return toHexA(r, g, b, a);
  } catch {
    return t < 0.5 ? c1 : c2;
  }
}

interface NodeEntry {
  node: XNode;
  structuralPath: string; // e.g. "0/1/2"
  namePath: string;       // e.g. "Root/Card/Button"
}

interface NodeIndex {
  all: NodeEntry[];
  byId: Map<string, NodeEntry>;
  byExplicitId: Map<string, NodeEntry>; // animationId or prototypeIdentity
  byComponentId: Map<string, NodeEntry>;
  byStructuralPath: Map<string, NodeEntry>;
  byName: Map<string, NodeEntry>;
}

function indexNodes(root: XNode): NodeIndex {
  const index: NodeIndex = {
    all: [],
    byId: new Map(),
    byExplicitId: new Map(),
    byComponentId: new Map(),
    byStructuralPath: new Map(),
    byName: new Map(),
  };

  function walk(n: XNode, structIdx: string, nameIdx: string) {
    const entry: NodeEntry = { node: n, structuralPath: structIdx, namePath: nameIdx };
    index.all.push(entry);
    index.byId.set(n.id, entry);

    const explicitId = n.animationId || n.prototypeIdentity;
    if (explicitId) {
      index.byExplicitId.set(explicitId, entry);
    }

    if (n.componentId) {
      index.byComponentId.set(n.componentId, entry);
    }

    if (nameIdx) {
      index.byStructuralPath.set(nameIdx, entry);
    }

    if (n.name) {
      index.byName.set(n.name, entry);
    }

    n.children.forEach((ch, i) => {
      const nextStruct = structIdx ? `${structIdx}/${i}` : `${i}`;
      const nextName = nameIdx ? `${nameIdx}/${ch.name}` : ch.name;
      walk(ch, nextStruct, nextName);
    });
  }

  walk(root, "", "");
  return index;
}

/**
 * Geometric similarity metric between two nodes: 0.0 (identical) to higher (different).
 */
function geometryDistance(a: XNode, b: XNode): number {
  if (a.kind !== b.kind) return Infinity;
  const ratioA = a.w / (a.h || 1);
  const ratioB = b.w / (b.h || 1);
  const ratioDiff = Math.abs(ratioA - ratioB);
  const sizeDiff = Math.abs(a.w - b.w) / Math.max(a.w, b.w, 1) + Math.abs(a.h - b.h) / Math.max(a.h, b.h, 1);
  return ratioDiff + sizeDiff;
}

/**
 * Spatial Euclidean distance between two nodes.
 */
function spatialDistance(a: XNode, b: XNode): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Finds the best match in `fromIndex` for a node `to` using the 6-tier matching hierarchy.
 */
function findBestMatch(
  toEntry: NodeEntry,
  fromIndex: NodeIndex,
  matchedFromIds: Set<string>,
): NodeEntry | null {
  const to = toEntry.node;

  // 1. Explicit animation_id or prototype_identity
  const explicitId = to.animationId || to.prototypeIdentity;
  if (explicitId && fromIndex.byExplicitId.has(explicitId)) {
    const candidate = fromIndex.byExplicitId.get(explicitId)!;
    if (!matchedFromIds.has(candidate.node.id)) return candidate;
  }

  // Exact node ID match
  if (fromIndex.byId.has(to.id)) {
    const candidate = fromIndex.byId.get(to.id)!;
    if (!matchedFromIds.has(candidate.node.id)) return candidate;
  }

  // 2. Component ID / instance ID match
  if (to.componentId && fromIndex.byComponentId.has(to.componentId)) {
    const candidate = fromIndex.byComponentId.get(to.componentId)!;
    if (!matchedFromIds.has(candidate.node.id)) return candidate;
  }

  // 3. Stable structural identity (path in the layer tree)
  if (toEntry.namePath && fromIndex.byStructuralPath.has(toEntry.namePath)) {
    const candidate = fromIndex.byStructuralPath.get(toEntry.namePath)!;
    if (!matchedFromIds.has(candidate.node.id) && candidate.node.kind === to.kind) {
      return candidate;
    }
  }

  // 4. Layer name match
  if (to.name && fromIndex.byName.has(to.name)) {
    const candidate = fromIndex.byName.get(to.name)!;
    if (!matchedFromIds.has(candidate.node.id) && candidate.node.kind === to.kind) {
      return candidate;
    }
  }

  // If layers have distinctly different explicit names, do NOT heuristically match them
  // (e.g. "Old Badge" must not morph into "New Badge"; they should cross-dissolve)
  const isGenericOrUnnamed = (name?: string) =>
    !name || /^(Rectangle|Frame|Group|Vector|Line|Ellipse|Polygon|Star|Text)\s*\d*$/i.test(name.trim());

  if (!isGenericOrUnnamed(to.name)) {
    return null;
  }

  // 5. Geometry similarity (matching kind, similar aspect ratio & bounds)
  let bestGeom: NodeEntry | null = null;
  let minGeomDist = 0.3; // threshold
  for (const candidate of fromIndex.all) {
    if (matchedFromIds.has(candidate.node.id) || candidate.node.id === fromIndex.all[0]?.node.id) continue;
    if (!isGenericOrUnnamed(candidate.node.name)) continue;
    const dist = geometryDistance(to, candidate.node);
    if (dist < minGeomDist) {
      minGeomDist = dist;
      bestGeom = candidate;
    }
  }
  if (bestGeom) return bestGeom;

  // 6. Heuristic fallback (closest spatial proximity with same kind)
  let bestSpatial: NodeEntry | null = null;
  let minSpatialDist = 60; // proximity radius in px
  for (const candidate of fromIndex.all) {
    if (matchedFromIds.has(candidate.node.id) || candidate.node.id === fromIndex.all[0]?.node.id) continue;
    if (!isGenericOrUnnamed(candidate.node.name)) continue;
    if (candidate.node.kind !== to.kind) continue;
    const dist = spatialDistance(to, candidate.node);
    if (dist < minSpatialDist) {
      minSpatialDist = dist;
      bestSpatial = candidate;
    }
  }

  return bestSpatial;
}

/**
 * Smart-animate the destination frame against the frame it replaced at progress `t`.
 */
export function interpolateMatchingLayers(
  fromFrame: XNode,
  toFrame: XNode,
  t: number,
  easing: ProtoEasing = "easeOut",
): Map<string, InterpolatedNode> {
  const progress = solveEasing(easing, t);
  const fromIndex = indexNodes(fromFrame);
  const toIndex = indexNodes(toFrame);
  const result = new Map<string, InterpolatedNode>();
  const matchedFromIds = new Set<string>();

  for (const toEntry of toIndex.all) {
    const to = toEntry.node;
    const fromEntry = findBestMatch(toEntry, fromIndex, matchedFromIds);

    if (fromEntry) {
      matchedFromIds.add(fromEntry.node.id);
      const from = fromEntry.node;
      const r0 = lerp(from.cornerRadii[0] ?? 0, to.cornerRadii[0] ?? 0, progress);
      const r1 = lerp(from.cornerRadii[1] ?? 0, to.cornerRadii[1] ?? 0, progress);
      const r2 = lerp(from.cornerRadii[2] ?? 0, to.cornerRadii[2] ?? 0, progress);
      const r3 = lerp(from.cornerRadii[3] ?? 0, to.cornerRadii[3] ?? 0, progress);

      result.set(to.id, {
        id: to.id,
        name: to.name,
        x: lerp(from.x, to.x, progress),
        y: lerp(from.y, to.y, progress),
        w: Math.max(1, lerp(from.w, to.w, progress)),
        h: Math.max(1, lerp(from.h, to.h, progress)),
        opacity: lerp(from.opacity ?? 1, to.opacity ?? 1, progress),
        rotation: lerpAngle(from.rotation ?? 0, to.rotation ?? 0, progress),
        cornerRadii: [r0, r1, r2, r3],
        fill: lerpColor(from.fill || "#ffffff", to.fill || "#ffffff", progress),
      });
    } else {
      // Unmatched new layer: dissolves in
      result.set(to.id, {
        id: to.id,
        name: to.name,
        x: to.x,
        y: to.y,
        w: to.w,
        h: to.h,
        opacity: (to.opacity ?? 1) * progress,
        rotation: to.rotation ?? 0,
        cornerRadii: to.cornerRadii ? [...to.cornerRadii] : [0, 0, 0, 0],
        fill: to.fill || "#ffffff",
      });
    }
  }

  // Record exiting layers to dissolve out
  for (const fromEntry of fromIndex.all) {
    if (fromEntry.node === fromFrame) continue;
    if (!matchedFromIds.has(fromEntry.node.id)) {
      const from = fromEntry.node;
      result.set(from.id, {
        id: from.id,
        name: from.name,
        x: from.x,
        y: from.y,
        w: from.w,
        h: from.h,
        opacity: (from.opacity ?? 1) * (1 - progress),
        rotation: from.rotation ?? 0,
        cornerRadii: from.cornerRadii ? [...from.cornerRadii] : [0, 0, 0, 0],
        fill: from.fill || "#ffffff",
      });
    }
  }

  return result;
}

/**
 * Apply interpolated state map onto a frame node tree, producing a cloned frame
 * ready for rendering at the current transition tick.
 */
export function applyInterpolatedFrame(
  frame: XNode,
  interpolated: Map<string, InterpolatedNode>,
  fromFrame?: XNode,
): XNode {
  function cloneAndApply(n: XNode): XNode {
    const inter = interpolated.get(n.id);
    let children = n.children.map(cloneAndApply);

    // If this is the root destination frame, append exiting top-level children from fromFrame
    if (fromFrame && n.id === frame.id) {
      for (const ch of fromFrame.children) {
        if (!n.children.some((c) => c.id === ch.id || c.name === ch.name)) {
          const exitingInter = interpolated.get(ch.id);
          const clonedExiting: XNode = {
            ...ch,
            ...(exitingInter
              ? {
                  x: exitingInter.x,
                  y: exitingInter.y,
                  w: exitingInter.w,
                  h: exitingInter.h,
                  opacity: exitingInter.opacity,
                  rotation: exitingInter.rotation,
                  cornerRadii: exitingInter.cornerRadii,
                  fill: exitingInter.fill,
                }
              : { opacity: 0 }),
            children: ch.children.map(cloneAndApply),
          };
          children.push(clonedExiting);
        }
      }
    }

    const patched: XNode = {
      ...n,
      ...(inter
        ? {
            x: inter.x,
            y: inter.y,
            w: inter.w,
            h: inter.h,
            opacity: inter.opacity,
            rotation: inter.rotation,
            cornerRadii: inter.cornerRadii,
            fill: inter.fill,
          }
        : {}),
      children,
    };
    return patched;
  }

  return cloneAndApply(frame);
}
