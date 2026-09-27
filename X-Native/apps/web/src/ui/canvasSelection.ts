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

/** Frame-like containers use a detached handle, in local screen coordinates.
 * Offset and hit radius stay constant as the document zoom changes. */
export function frameRotationHandle(kind: NodeKind, x: number, y: number, w: number) {
  return kind === "frame" || kind === "component" || kind === "instance"
    ? { x: x + w / 2, y: y - 20 }
    : null;
}

export function rotationHandleHit(kind: NodeKind, px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  const handle = frameRotationHandle(kind, x, y, w);
  if (handle) return Math.hypot(px - handle.x, py - handle.y) < 8;
  // Rotation must not overlap the <8px resize hit area; the cursor and
  // the press handler must agree about the gesture.
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].some(([hx, hy]) => {
    const distance = Math.hypot(px - hx, py - hy);
    return distance >= 8 && distance <= 22;
  });
}
