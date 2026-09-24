import { useEffect, useRef } from "react";

/**
 * Figma-style rulers along the top and left edges of the viewport.
 *
 * Drawn on their own canvas so ticks stay crisp at any DPR and redrawing them
 * never touches the document render. Tick spacing steps through a 1/2/5
 * sequence so labels stay roughly 80px apart at every zoom level, and the
 * current selection is highlighted the way Figma shades the selected range.
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
}: {
  zoom: number;
  panX: number;
  panY: number;
  width: number;
  height: number;
  /** Selection bounds in world space, if anything is selected. */
  selection: { x: number; y: number; w: number; h: number } | null;
  theme: string;
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

    const dark = theme === "dark";
    const bg = dark ? "#181922" : "#ffffff";
    const line = dark ? "#333647" : "#e5e5e5";
    const text = dark ? "#94a3b8" : "#8c8c8c";
    const accent = "#6366f1";

    // Rails
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, SIZE);
    ctx.fillRect(0, 0, SIZE, height);

    // Highlight the selected range
    if (selection) {
      ctx.fillStyle = dark ? "rgba(99,102,241,.25)" : "rgba(99,102,241,.18)";
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

    // Vertical ruler — labels rotated, matching Figma.
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
  }, [zoom, panX, panY, width, height, selection, theme]);

  return <canvas className="rulers" ref={ref} aria-hidden="true" />;
}
