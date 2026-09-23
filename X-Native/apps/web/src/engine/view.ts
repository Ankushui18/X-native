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

/** The percentages Figma lists in its zoom menu. */
export const ZOOM_PRESETS = [0.02, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64] as const;

/** Ladder used by the keyboard: geometric, so each press is one visible step
 *  whether you are at 50% or at 3200%. */
const LADDER = [
  0.02, 0.03, 0.05, 0.08, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64,
];

/** Next/previous rung of the zoom ladder above/below the current zoom. */
export function stepZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) return LADDER.find((z) => z > current + 1e-6) ?? ZOOM_MAX;
  return [...LADDER].reverse().find((z) => z < current - 1e-6) ?? ZOOM_MIN;
}

/** Multiply the current zoom, keeping the result inside the clamp. Used by the
 *  wheel and pinch gestures, where the step is proportional, not absolute. */
export function zoomBy(current: number, factor: number): number {
  return clampZoom(current * factor);
}

/** Wheel/pitch factor for a scroll delta. Trackpad pinches arrive as a stream of
 *  small ctrl+wheel events and need an exponential response to feel direct;
 *  a mouse wheel sends one notch at a time and wants a fixed step. */
export function wheelZoomFactor(deltaY: number, continuous: boolean): number {
  if (!continuous) return deltaY < 0 ? 1.1 : 1 / 1.1;
  // 0.01 keeps a two-finger pinch at roughly 1:1 with finger movement.
  return Math.exp(-deltaY * 0.01);
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
