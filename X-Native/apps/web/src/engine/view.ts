/**
 * Viewport constants shared by the engine and the canvas.
 *
 * The zoom range is Figma's: 2% to 6400%. A designer expects to be able to
 * scroll out until a whole 1440-wide page is a postage stamp, and in until a
 * single pixel is a fist — the previous 10%–800% clamp made both impossible,
 * which is what "the canvas doesn't behave like Figma" usually means.
 *
 * Kept in `engine/` rather than `ui/zoom.ts` because the engine clamps on
 * dispatch, and an engine must not import from the UI layer.
 */

/** 2% */
export const ZOOM_MIN = 0.02;
/** 6400% */
export const ZOOM_MAX = 64;

export const clampZoom = (z: number): number =>
  Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1;

/** The percentages Figma lists in its zoom menu, in order. Two rungs per
 *  doubling, which is why the steps look irregular: 100, 128, 200, 256, 400 -
 *  every press is visible, and every value is one a designer recognises from
 *  the field at the top of the right sidebar. */
export const ZOOM_PRESETS = [
  0.02, 0.03, 0.04, 0.06, 0.08, 0.12, 0.16, 0.25, 0.32, 0.5, 0.64, 1, 1.28, 2, 2.56, 4, 5.12, 8,
  10.24, 16, 32, 64,
] as const;

/** Next/previous zoom for the keyboard and the menu. Figma's zoom in and out
 *  shortcuts double and halve - the zoom-out a designer gets with them is
 *  100, 50, 25, 13, 6 - so a press is a whole step, not a nudge, and the value
 *  you started from never matters. */
export function stepZoom(current: number, dir: 1 | -1): number {
  return clampZoom(current * (dir === 1 ? 2 : 0.5));
}

/** Multiply the current zoom, keeping the result inside the clamp. Used by the
 *  wheel and pinch gestures, where the step is proportional, not absolute. */
export function zoomBy(current: number, factor: number): number {
  return clampZoom(current * factor);
}

/** Where the pan has to sit for the design point currently under `anchor` to
 *  stay under it when the zoom changes from `zoom` to `next`.
 *
 *  The canvas keeps the viewport's position in `panX/panY` rather than the
 *  centre of the view, so changing the zoom alone leaves the drawing anchored
 *  to the canvas's top-left corner: press ⇧+ twice and the artboard has walked
 *  off the right of the window. Figma keeps the middle of the canvas still (and
 *  the pointer, for a wheel), which is what this computes. */
export function panForZoom(pan: number, zoom: number, next: number, anchor: number): number {
  return anchor - ((anchor - pan) / zoom) * next;
}

/** A wheel event, reduced to the facts the zoom needs. */
export interface WheelGesture {
  deltaY: number;
  /** 0 for pixels (Chrome trackpads, most mice), 1 for lines (Firefox and some
   *  Windows drivers), 2 for pages. */
  deltaMode?: number;
  /** True when the browser flags the gesture as a pinch - a ctrl+wheel event. */
  pinch?: boolean;
}

/** Pixels a line and a page are worth. Without this a wheel reports three lines
 *  where a trackpad reports forty pixels, and the canvas answers ten times too
 *  little - the "zoom only works on my trackpad" complaint. */
const LINE_PX = 16;
const PAGE_PX = 100;

export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
  if (deltaMode === 1) return delta * LINE_PX;
  if (deltaMode === 2) return delta * PAGE_PX;
  return delta;
}

/** One wheel notch, as browsers report it in pixels. */
const NOTCH_PX = 100;
/** Per notch, so a scroll of four notches is four steps rather than a leap. */
const NOTCH_STEP = 1.1;
/** A pinch arrives as a stream of one- and two-pixel deltas; a wheel sends a
 *  whole notch at a time. Telling them apart by size rather than by the ctrl
 *  flag - which is set for both - is the difference between a trackpad that
 *  tracks the fingers and a wheel where one notch jumps 2.7x. */
const PINCH_MAX_PX = 40;

/** Zoom factor for one wheel or pinch event. */
export function wheelZoomFactor(gesture: WheelGesture): number {
  const dy = normalizeWheelDelta(gesture.deltaY, gesture.deltaMode);
  if (Math.abs(dy) < PINCH_MAX_PX) {
    // 0.01 keeps a two-finger pinch at roughly 1:1 with finger movement.
    return Math.exp(-dy * 0.01);
  }
  // A wheel notch, or several of them when one event carries a burst. Capped so
  // a flick of a high-resolution wheel cannot cross the whole zoom range.
  const factor = Math.pow(NOTCH_STEP, -dy / NOTCH_PX);
  return Math.min(2, Math.max(0.5, factor));
}

/** Zoom label as Figma writes it: whole percents, no decimals below 100%,
 *  one decimal above where it would otherwise be useless. */
export function zoomLabel(z: number): string {
  const pct = z * 100;
  if (Math.abs(pct - Math.round(pct)) < 0.05) return `${Math.round(pct)}%`;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Parse a typed percentage ("150", "1.5x", "12 %") into a zoom factor. */
export function parseZoomInput(text: string): number | null {
  const m = /(-?\d+(?:\.\d+)?)\s*(%|x|×)?/i.exec(text.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampZoom(/x|×/i.test(m[2] || "") ? n : n / 100);
}
