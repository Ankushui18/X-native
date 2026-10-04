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
 *  affordance: move the pointer just outside the top-right corner, it turns into
 *  the rotate cursor, drag and the layer turns. Nothing is painted to advertise
 *  it (the stem + hollow dot that used to be drawn here was ours: top-centre
 *  first, then top-right per `FRAME_INTERACTION_AUDIT_2026-09-29.md`, and a
 *  side-by-side screenshot in batch 45 settled it).
 *
 *  What these numbers still own is the invisible band that both the cursor and
 *  the press measure — `ROTATION_HANDLE_STEM` where it sits (20px above the
 *  top-right corner, so the grab point is where the painted handle used to be)
 *  and `ROTATION_HANDLE_HIT` how wide it is, both constant in screen pixels as
 *  the document zooms. One source for hover and press, so the cursor can never
 *  promise a target the press then misses. */
export const ROTATION_HANDLE_STEM = 20;
/** A ~20px-wide grab target, generous enough to stay hittable at 25% zoom. */
export const ROTATION_HANDLE_HIT = 10;
/** Non-frame layers rotate from a band outside the top-right corner instead. */
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
  // Non-frame shapes: a band from 8 to 24px outside the top-right corner rather
  // than a corner overlap — the resize handles own the 8px closest to the
  // corner, so the cursor and the press agree about corner-resize vs. rotate.
  const tr = { x: x + w, y: y };
  const d = Math.hypot(px - tr.x, py - tr.y);
  return d >= ROTATION_RING.min && d <= ROTATION_RING.max;
}
