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

/** Rotation is a *cursor*, not a piece of chrome — that is the whole of Figma's
 *  affordance: "Hover just outside one of the layer's bounds until the rotation
 *  cursor appears" (help 360039956914; "the corner bounds", 360039818874).
 *  Every corner arms it — one ring per corner of the selection box, identical
 *  for a single layer and for the combined multi box (the multi-press gesture
 *  already works on all four; a single selection must not arm only the top
 *  right). Nothing is painted: the stem + hollow dot that used to be drawn
 *  here was ours, and batch 45 settled that Figma draws nothing.
 *
 *  The 8px closest to a corner belongs to the resize handles, so the ring
 *  starts outside it; both the cursor and the press measure this one function,
 *  so the cursor can never promise a target the press then misses. The `kind`
 *  argument stays for call-site stability — the ring is kind-independent, as
 *  Figma's is. */
export const ROTATION_RING = { min: 8, max: 24 };

/** The four corners of the (already screen-transformed) selection box. */
export function rotationCorners(x: number, y: number, w: number, h: number): [number, number][] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

export function rotationHandleHit(_kind: NodeKind, px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  return rotationCorners(x, y, w, h).some(([cx, cy]) => {
    const d = Math.hypot(px - cx, py - cy);
    return d >= ROTATION_RING.min && d <= ROTATION_RING.max;
  });
}
