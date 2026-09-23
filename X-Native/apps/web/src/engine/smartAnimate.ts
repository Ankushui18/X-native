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

/** Easing curves matching Figma and CSS specifications. */
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
      // Smooth damped spring (slight overshoot, settling at 1.0)
      return 1 - Math.exp(-6 * clampT) * Math.cos(6.5 * clampT);
    case "bouncy":
      // Bouncy spring with noticeable overshoot oscillation
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
  path: string;
}

function collectNodes(root: XNode): { byId: Map<string, NodeEntry>; byPath: Map<string, NodeEntry> } {
  const byId = new Map<string, NodeEntry>();
  const byPath = new Map<string, NodeEntry>();

  function walk(n: XNode, currentPath: string) {
    const entry: NodeEntry = { node: n, path: currentPath };
    byId.set(n.id, entry);
    if (currentPath) byPath.set(currentPath, entry);
    for (const ch of n.children) {
      const subPath = currentPath ? `${currentPath}/${ch.name}` : ch.name;
      walk(ch, subPath);
    }
  }

  walk(root, "");
  return { byId, byPath };
}

/**
 * Smart-animate the destination frame against the frame it replaced at progress `t`.
 * Follows Figma's rule: layers are matched by ID or ancestor name path.
 * Matched layers morph (position, size, opacity, rotation, corner radii, and fill).
 * Unmatched layers in destination dissolve in (opacity 0 -> target).
 */
export function interpolateMatchingLayers(
  fromFrame: XNode,
  toFrame: XNode,
  t: number,
  easing: ProtoEasing = "easeOut",
): Map<string, InterpolatedNode> {
  const progress = solveEasing(easing, t);
  const fromNodes = collectNodes(fromFrame);
  const toNodes = collectNodes(toFrame);
  const result = new Map<string, InterpolatedNode>();

  for (const [id, toEntry] of toNodes.byId) {
    const to = toEntry.node;
    // Match by ID first, then by hierarchical name path
    const fromEntry = fromNodes.byId.get(id) ?? fromNodes.byPath.get(toEntry.path);

    if (fromEntry) {
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
        cornerRadii: [...to.cornerRadii],
        fill: to.fill,
      });
    }
  }

  // Record exiting layers (present in fromFrame, absent in toFrame) to dissolve out
  for (const [id, fromEntry] of fromNodes.byId) {
    if (fromEntry.node === fromFrame) continue;
    if (!toNodes.byId.has(id) && (!fromEntry.path || !toNodes.byPath.has(fromEntry.path))) {
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
        cornerRadii: [...from.cornerRadii],
        fill: from.fill,
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
