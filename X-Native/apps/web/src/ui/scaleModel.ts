/**
 * The Scale tool's model, kept apart from the canvas so the panel, the drag, and
 * the tests all agree on one thing: scaling is an affine map of the selection's
 * box about a chosen anchor point, and every member is pushed through it.
 *
 * Figma's scale tool differs from a plain resize in exactly two ways, and both
 * are visible to a developer: the ratio is always preserved, and *content*
 * scales with the box - stroke weights, corner radii, font sizes, effects,
 * auto-layout gaps - instead of re-laying-out against the parent's constraints.
 * The engine already does the second half (`resize` with `scaleProps`), so what
 * lives here is the arithmetic of "which point stays put".
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The nine anchor points in Figma's anchor box, in reading order. */
export type ScaleAnchor = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";

export const SCALE_ANCHORS: { id: ScaleAnchor; ax: number; ay: number; label: string }[] = [
  { id: "tl", ax: 0, ay: 0, label: "Top left" },
  { id: "tc", ax: 0.5, ay: 0, label: "Top center" },
  { id: "tr", ax: 1, ay: 0, label: "Top right" },
  { id: "ml", ax: 0, ay: 0.5, label: "Left center" },
  { id: "mc", ax: 0.5, ay: 0.5, label: "Center" },
  { id: "mr", ax: 1, ay: 0.5, label: "Right center" },
  { id: "bl", ax: 0, ay: 1, label: "Bottom left" },
  { id: "bc", ax: 0.5, ay: 1, label: "Bottom center" },
  { id: "br", ax: 1, ay: 1, label: "Bottom right" },
];

/** The multiplier choices Figma's dropdown offers, plus 1x to undo a step. */
export const SCALE_FACTORS = [0.5, 0.75, 1, 1.5, 2, 3];

/** How the panel writes a multiplier: `0.75x`, `150%` would read as a size. */
export const SCALE_LABEL = (f: number): string => `${Number(f.toFixed(3))}x`;

export function anchorOf(id: ScaleAnchor): { ax: number; ay: number } {
  const hit = SCALE_ANCHORS.find((a) => a.id === id);
  return hit ? { ax: hit.ax, ay: hit.ay } : { ax: 0.5, ay: 0.5 };
}

export function unionBox(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Scale `box` by `f` about `anchor` (fractions of the box, so 0/0 is its top-left
 * and 0.5/0.5 its centre). A factor below 1 shrinks toward the anchor, which is
 * the one thing the anchor box changes: everything else is the same map.
 */
export function scaleBoxAround(box: Box, f: number, ax: number, ay: number): Box {
  const px = box.x + box.w * ax;
  const py = box.y + box.h * ay;
  return { x: px - box.w * f * ax, y: py - box.h * f * ay, w: box.w * f, h: box.h * f };
}

/** The same map, expressed as the panel's `w`/`h` fields: type a width while the
 *  ratio is preserved and the height follows from the *other* dimension. */
export function sizeKeepingRatio(box: Box, next: { w?: number; h?: number }): Box {
  const w = next.w ?? box.w;
  const h = next.h ?? box.h;
  if (next.w != null && next.h == null && box.w > 0 && box.h > 0) return { ...box, w, h: (w * box.h) / box.w };
  if (next.h != null && next.w == null && box.w > 0 && box.h > 0) return { ...box, w: (h * box.w) / box.h, h };
  return { ...box, w, h };
}

/**
 * Push a set of members through the scale of their shared box. Used for
 * multi-selections, where scaling each member about its own anchor would move
 * them apart: Figma keeps the relative positions and the gaps, so the whole
 * group maps as one.
 */
export function scaleMembers(box: Box, members: Box[], f: number, anchor: ScaleAnchor): Box[] {
  const { ax, ay } = anchorOf(anchor);
  const px = box.x + box.w * ax;
  const py = box.y + box.h * ay;
  const map = (b: Box): Box => ({
    x: px + (b.x - px) * f,
    y: py + (b.y - py) * f,
    w: b.w * f,
    h: b.h * f,
  });
  return members.map(map);
}

/** The multiplier the panel should show for a box that has already been scaled:
 *  width over the value it had when the tool was armed. */
export function factorBetween(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return 1;
  return to / from;
}

/**
 * Turn a layer to `deg` about its own rotation origin.
 *
 * The renderer (and the SVG export) always spin a layer about the centre of its
 * box, so a moved origin cannot change the drawing - it changes where the box
 * *is*. Rotating about a point means: spin by the angle turned, then slide the
 * box back so the pivot lands where it started. With the default origin the
 * spin moves the pivot not at all and the box stays put, which is why this
 * returns the same numbers the old code wrote for every layer that never
 * touched the target.
 */
export function rotateAboutOrigin(
  box: Box & { rotation: number },
  origin: readonly [number, number],
  deg: number,
): { x: number; y: number; rotation: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const px = box.x + origin[0] * box.w;
  const py = box.y + origin[1] * box.h;
  const d = ((deg - box.rotation) * Math.PI) / 180;
  const cos = Math.cos(d);
  const sin = Math.sin(d);
  const dx = px - cx;
  const dy = py - cy;
  // Where the pivot ends up once the box has turned about its centre.
  const sx = cx + dx * cos - dy * sin;
  const sy = cy + dx * sin + dy * cos;
  return { x: box.x + (px - sx), y: box.y + (py - sy), rotation: deg };
}
