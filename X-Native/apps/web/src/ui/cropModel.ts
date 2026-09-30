import { coverCrop, normalizeCropRect } from "../engine/paint";

export type CropRect = { x: number; y: number; w: number; h: number };
export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** The starting rect for a crop gesture: stored, or the cover region. */
export function initialCropRect(
  stored: CropRect | undefined,
  iw: number,
  ih: number,
  w: number,
  h: number,
): CropRect {
  return stored ? normalizeCropRect(stored) : coverCrop(iw, ih, w, h);
}

/** Layer-local point (0..1) to image-normalised coordinates under a crop. */
export function layerToImage(rect: CropRect, lx: number, ly: number): { u: number; v: number } {
  return { u: rect.x + lx * rect.w, v: rect.y + ly * rect.h };
}

/**
 * Screen box of the full image extent, given the layer box the crop rect
 * fills. The faded overflow the crop tool shows outside the layer.
 */
export function cropFullExtent(
  box: { x: number; y: number; w: number; h: number },
  rect: CropRect,
): { x: number; y: number; w: number; h: number } {
  const w = box.w / Math.max(0.01, rect.w);
  const h = box.h / Math.max(0.01, rect.h);
  return { x: box.x - rect.x * w, y: box.y - rect.y * h, w, h };
}

/** Eight handle squares on a box, for hit-testing and painting. */
export function cropHandleRects(
  box: { x: number; y: number; w: number; h: number },
  size: number,
): { handle: CropHandle; x: number; y: number }[] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x2 = box.x + box.w;
  const y2 = box.y + box.h;
  const pts: [CropHandle, number, number][] = [
    ["nw", box.x, box.y],
    ["n", cx, box.y],
    ["ne", x2, box.y],
    ["e", x2, cy],
    ["se", x2, y2],
    ["s", cx, y2],
    ["sw", box.x, y2],
    ["w", box.x, cy],
  ];
  return pts.map(([handle, x, y]) => ({ handle, x: x - size / 2, y: y - size / 2 }));
}

/**
 * Drag an edge/corner handle; the pointer arrives in image-normalised
 * coordinates. Corners keep the region's pixel aspect equal to the image's
 * (square in normalised space) unless freed; ⌥ mirrors about the centre.
 * `aspect` retargets the lock — the region's width/height in normalised
 * space (1 = the original image, a selected ratio R in pixels arrives as
 * R·ih/iw) — so a ratio picker shares the same math as the default lock.
 */
export function dragCropHandle(
  rect: CropRect,
  handle: CropHandle,
  u: number,
  v: number,
  opts?: { lockAspect?: boolean; symmetric?: boolean; aspect?: number },
): CropRect {
  const sym = !!opts?.symmetric;
  const lock = !!opts?.lockAspect && handle.length === 2;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  let nx = rect.x;
  let ny = rect.y;
  let nx2 = x2;
  let ny2 = y2;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  if (sym) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    if (west || east) {
      const hw = Math.abs(u - cx);
      nx = cx - hw;
      nx2 = cx + hw;
    }
    if (north || south) {
      const hh = Math.abs(v - cy);
      ny = cy - hh;
      ny2 = cy + hh;
    }
  } else {
    if (west) nx = u;
    if (east) nx2 = u;
    if (north) ny = v;
    if (south) ny2 = v;
  }
  if (lock) {
    // One governed dimension: the region grows to cover the pointer's larger
    // span, the other follows the target width/height ratio (1 = the square
    // normalised region whose pixel aspect is the original image's). The
    // opposite edges stay put — the anchor pixel does not move.
    const a = opts?.aspect && opts.aspect > 0 ? opts.aspect : 1;
    const spanW = nx2 - nx;
    const spanH = ny2 - ny;
    const s = Math.max(0.01, spanW / a, spanH);
    const w2 = a * s;
    if (sym) {
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      nx = cx - w2 / 2;
      nx2 = cx + w2 / 2;
      ny = cy - s / 2;
      ny2 = cy + s / 2;
    } else {
      if (west) nx = nx2 - w2;
      else nx2 = nx + w2;
      if (north) ny = ny2 - s;
      else ny2 = ny + s;
    }
  }
  const x0 = Math.min(nx, nx2);
  const y0 = Math.min(ny, ny2);
  return normalizeCropRect({ x: x0, y: y0, w: Math.abs(nx2 - nx), h: Math.abs(ny2 - ny) });
}

/** Pan the crop window by a normalised delta, pinned inside the image. */
export function moveCrop(rect: CropRect, du: number, dv: number): CropRect {
  return normalizeCropRect({ x: rect.x + du, y: rect.y + dv, w: rect.w, h: rect.h });
}
