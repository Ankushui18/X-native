import type { NodeKind, XNode } from "../engine/types";
import { findParent, hitTest, isEffectivelyLocked } from "../engine/memory";

/** Canvas clicks stop at a container; only double-click/Enter opens that scope.
 * Keep the engine's geometric hit test independent of this interaction policy. */
export function canvasClickTarget(root: XNode, x: number, y: number, selection: string[]): XNode | null {
  const leaf = hitTest(root, x, y, { deep: true });
  if (!leaf) return null;
  const path: XNode[] = [];
  for (let n: XNode | null = leaf; n && n !== root; n = findParent(root, n.id)) path.unshift(n);
  // A click on an already selected container must not drill, nor must the two
  // presses preceding dblclick reset a previously drilled selection to its root.
  const selected = path.find((n) => selection.includes(n.id));
  if (selected) return selected;
  if (selection.length === 1) {
    const parent = findParent(root, selection[0]);
    const scope = parent ? path.indexOf(parent) : -1;
    if (scope >= 0) return path[scope + 1] ?? parent;
  }
  return path[0] ?? leaf;
}

/** Pick exactly one level, using the transform/clip/paint-order-aware hit test.
 * Clicking empty container space follows Enter's first-selectable-child rule. */
export function drillChild(root: XNode, container: XNode, x: number, y: number): XNode | null {
  if (isEffectivelyLocked(root, container.id)) return null;
  let n = hitTest(root, x, y, { deep: true });
  while (n && n !== container) {
    const parent = findParent(root, n.id);
    if (parent === container) return n;
    n = parent;
  }
  return container.children.find((c) => c.visible && !c.locked) ?? null;
}

/** Frame-like containers use a detached rotation handle. In Figma the rotation
 *  target sits above the top-right corner, connected by a short vertical stem —
 *  never at top-centre (that position was an earlier draft that never matched
 *  the shipped UI, reported as "rotation icon is in top middle"). Offset and
 *  hit radius stay constant in screen pixels as the document zoom changes.
 *
 *  The three numbers below are the whole contract: the painter draws at
 *  `ROTATION_HANDLE_STEM`/`ROTATION_HANDLE_RADIUS` and the hit test accepts
 *  `ROTATION_HANDLE_HIT`, both from here, so a hover state cannot advertise a
 *  target the press then misses (or vice versa). */
export const ROTATION_HANDLE_STEM = 20;
export const ROTATION_HANDLE_RADIUS = 5;
/** Figma's rotate affordance is a ~20px-wide grab target; 10px of radius from
 *  the centre of a 5px dot is the honest match, and it is generous enough that
 *  the handle stays grabbable at 25% zoom. */
export const ROTATION_HANDLE_HIT = 10;
/** Non-frame layers rotate from a ring outside the top-right corner. */
export const ROTATION_RING = { min: 8, max: 24 };

export function frameRotationHandle(kind: NodeKind, x: number, y: number, w: number, _h: number) {
  // Figma places the rotation target above the top-right corner, with a
  // ~20px gap between the corner and the handle centre. Components and
  // instances inherit the same affordance — they're also containers.
  return kind === "frame" || kind === "component" || kind === "instance"
    ? { x: x + w, y: y - ROTATION_HANDLE_STEM }
    : null;
}

export function rotationHandleHit(kind: NodeKind, px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  const handle = frameRotationHandle(kind, x, y, w, h);
  if (handle) return Math.hypot(px - handle.x, py - handle.y) <= ROTATION_HANDLE_HIT;
  // Non-frame shapes: the rotation target is a larger ring outside the top-right
  // corner (22px radius), not a corner overlap with 8px — so the cursor and
  // the press handler agree about corner-resize vs. rotate.
  const tr = { x: x + w, y: y };
  const d = Math.hypot(px - tr.x, py - tr.y);
  return d >= ROTATION_RING.min && d <= ROTATION_RING.max;
}
