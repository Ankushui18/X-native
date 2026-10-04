import { useEffect, useRef } from "react";
import { canvasChrome } from "./canvasChrome";

/**
 * Rulers along the top and left edges of the viewport.
 *
 * Drawn on their own canvas so ticks stay crisp at any DPR and redrawing them
 * never touches the document render. Tick spacing steps through a 1/2/5
 * sequence so labels stay roughly 80px apart at every zoom level, and the
 * current selection is highlighted along the selected range.
 */

const SIZE = 20;

/** Nice tick interval in world units targeting ~80px between labels. */
function tickStep(zoom: number) {
  const target = 80 / zoom;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) {
    if (pow * m >= target) return pow * m;
  }
  return pow * 10;
}

export function Rulers({
  zoom,
  panX,
  panY,
  width,
  height,
  selection,
  theme,
  chrome,
}: {
  zoom: number;
  panX: number;
  panY: number;
  width: number;
  height: number;
  /** Selection bounds in world space, if anything is selected. */
  selection: { x: number; y: number; w: number; h: number } | null;
  theme: string;
  /** The canvas-chrome preference. These surfaces read their palette out of the CSS
   *  cascade, so a chrome flip changes what the *same* `theme` value resolves to;
   *  without this in the deps the rails keep the old selection ink until something
   *  else moves the view. */
  chrome: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    cv.style.width = `${width}px`;
    cv.style.height = `${height}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Chrome comes from the sheet, not from a hand-maintained dark/light pair
    // (FR-U2); `theme` and `chrome` stay in the deps so the rails re-read on a flip.
    const chrome = canvasChrome();
    const bg = chrome.panel;
    const line = chrome.line;
    const text = chrome.dim;
    const accent = chrome.sel;

    // Rails
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, SIZE);
    ctx.fillRect(0, 0, SIZE, height);

    // Highlight the selected range
    if (selection) {
      ctx.fillStyle = chrome.selWash;
      const sx = panX + selection.x * zoom;
      const sy = panY + selection.y * zoom;
      ctx.fillRect(sx, 0, selection.w * zoom, SIZE);
      ctx.fillRect(0, sy, SIZE, selection.h * zoom);
    }

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, SIZE + 0.5);
    ctx.lineTo(width, SIZE + 0.5);
    ctx.moveTo(SIZE + 0.5, 0);
    ctx.lineTo(SIZE + 0.5, height);
    ctx.stroke();

    const step = tickStep(zoom);
    const minor = step / 5;
    ctx.font = "9px Inter, system-ui, sans-serif";
    ctx.fillStyle = text;
    ctx.strokeStyle = text;

    // Horizontal ruler
    const wx0 = (SIZE - panX) / zoom;
    const wx1 = (width - panX) / zoom;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (let v = Math.floor(wx0 / minor) * minor; v <= wx1; v += minor) {
      const sx = Math.round(panX + v * zoom) + 0.5;
      if (sx < SIZE) continue;
      const major = Math.abs(v % step) < minor / 2;
      ctx.beginPath();
      ctx.moveTo(sx, major ? SIZE - 7 : SIZE - 4);
      ctx.lineTo(sx, SIZE);
      ctx.stroke();
      if (major) ctx.fillText(String(Math.round(v)), sx + 3, SIZE - 8);
    }

    // Vertical ruler — labels rotated.
    const wy0 = (SIZE - panY) / zoom;
    const wy1 = (height - panY) / zoom;
    for (let v = Math.floor(wy0 / minor) * minor; v <= wy1; v += minor) {
      const sy = Math.round(panY + v * zoom) + 0.5;
      if (sy < SIZE) continue;
      const major = Math.abs(v % step) < minor / 2;
      ctx.beginPath();
      ctx.moveTo(major ? SIZE - 7 : SIZE - 4, sy);
      ctx.lineTo(SIZE, sy);
      ctx.stroke();
      if (major) {
        ctx.save();
        ctx.translate(SIZE - 8, sy - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(String(Math.round(v)), 0, 0);
        ctx.restore();
      }
    }

    // Corner square covers the ruler intersection.
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(0, SIZE + 0.5);
    ctx.lineTo(SIZE + 0.5, SIZE + 0.5);
    ctx.lineTo(SIZE + 0.5, 0);
    ctx.stroke();
    if (selection) {
      ctx.fillStyle = accent;
      ctx.fillRect(SIZE - 4, SIZE - 4, 3, 3);
    }
  }, [zoom, panX, panY, width, height, selection, theme, chrome]);

  return <canvas className="rulers" ref={ref} aria-hidden="true" />;
}
