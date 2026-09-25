import { useEffect, useRef } from "react";
import type { Engine, XNode } from "../engine/types";
import { cssRgba, isNone } from "./color";

/**
 * Document minimap with a draggable viewport rectangle.
 *
 * Drawn on its own small canvas so it never shares the main render path: the
 * document canvas already runs a culled paint on every pan frame, and adding a
 * second full-document pass there would spend the frame budget that work
 * bought back. Here the cost is bounded instead — a fixed ~180x120 surface, a
 * flat walk with no effects or text shaping, and a node cap so a 10k-layer file
 * cannot turn the thumbnail into the slowest thing on screen.
 *
 * Redraw is deliberately *not* tied to pan: panning only moves the viewport
 * rectangle, which is cheap, so the thumbnail is only repainted when the
 * document itself changes.
 */

const W = 180;
const H = 120;
const PAD = 6;
/** Beyond this the thumbnail stops adding detail rather than adding cost. */
const MAX_NODES = 1200;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/** Flatten to world-space boxes, largest first so small nodes stay visible. */
function collect(root: XNode): { boxes: Box[]; bounds: { x: number; y: number; w: number; h: number } } {
  const boxes: Box[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (n: XNode, ox: number, oy: number) => {
    if (boxes.length >= MAX_NODES) return;
    const x = ox + n.x;
    const y = oy + n.y;
    if (n.visible !== false && n.w > 0 && n.h > 0) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + n.w);
      maxY = Math.max(maxY, y + n.h);
      const paint = n.fillVisible !== false && !isNone(n.fill) ? n.fill : "";
      if (paint) boxes.push({ x, y, w: n.w, h: n.h, fill: paint });
    }
    for (const c of n.children) walk(c, x, y);
  };
  for (const c of root.children) walk(c, 0, 0);
  if (!isFinite(minX)) {
    return { boxes, bounds: { x: 0, y: 0, w: 1, h: 1 } };
  }
  return {
    boxes,
    bounds: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) },
  };
}

export function Minimap({
  root,
  engine,
  zoom,
  panX,
  panY,
  viewW,
  viewH,
  theme,
}: {
  root: XNode;
  engine: Engine;
  zoom: number;
  panX: number;
  panY: number;
  viewW: number;
  viewH: number;
  theme: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef(false);
  // Kept in a ref so the pointer handlers can map a click to world space
  // without re-subscribing every time the document repaints.
  const fit = useRef({ scale: 1, ox: 0, oy: 0 });

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const dark = theme === "dark";
    // Without a canvas-coloured backdrop the document's white frames are
    // invisible against the white panel — the thumbnail read as a few dark
    // bars floating in space.
    ctx.fillStyle = dark ? "#171c22" : "#eef1f4";
    ctx.fillRect(0, 0, W, H);
    const { boxes, bounds } = collect(root);
    // Fit the union of the document and the current viewport, not the document
    // alone: zoomed out far enough the viewport is larger than the artwork, and
    // fitting only the artwork pushed the viewport rectangle off the thumbnail.
    const vpx = -panX / zoom;
    const vpy = -panY / zoom;
    const ux = Math.min(bounds.x, vpx);
    const uy = Math.min(bounds.y, vpy);
    const uw = Math.max(bounds.x + bounds.w, vpx + viewW / zoom) - ux;
    const uh = Math.max(bounds.y + bounds.h, vpy + viewH / zoom) - uy;
    const scale = Math.min((W - PAD * 2) / uw, (H - PAD * 2) / uh, 1);
    const ox = (W - uw * scale) / 2 - ux * scale;
    const oy = (H - uh * scale) / 2 - uy * scale;
    fit.current = { scale, ox, oy };

    for (const b of boxes) {
      ctx.fillStyle = cssRgba(b.fill);
      // Sub-pixel nodes would vanish entirely; keep them as a visible dot so
      // the thumbnail still reads as the document.
      ctx.fillRect(ox + b.x * scale, oy + b.y * scale, Math.max(1, b.w * scale), Math.max(1, b.h * scale));
    }

    // Viewport rectangle: the world region the canvas is currently showing.
    const vx = ox + (-panX / zoom) * scale;
    const vy = oy + (-panY / zoom) * scale;
    const vw = (viewW / zoom) * scale;
    const vh = (viewH / zoom) * scale;
    ctx.strokeStyle = dark ? "#10b981" : "#0e9f6e";
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(vx) + 0.5, Math.round(vy) + 0.5, Math.round(vw), Math.round(vh));
    ctx.fillStyle = dark ? "rgba(16, 185, 129, 0.20)" : "rgba(14, 159, 110, 0.16)";
    ctx.fillRect(vx, vy, vw, vh);
  }, [root, zoom, panX, panY, viewW, viewH, theme]);

  /** Centre the viewport on the clicked point. */
  const goTo = (clientX: number, clientY: number) => {
    const cv = ref.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const { scale, ox, oy } = fit.current;
    const worldX = (clientX - r.left - ox) / scale;
    const worldY = (clientY - r.top - oy) / scale;
    engine.dispatch({
      type: "setPan",
      x: viewW / 2 - worldX * zoom,
      y: viewH / 2 - worldY * zoom,
    });
  };

  useEffect(() => {
    if (!drag.current) return;
    const move = (e: MouseEvent) => goTo(e.clientX, e.clientY);
    const up = () => {
      drag.current = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  return (
    <div className="minimap" aria-label="Minimap">
      <canvas
        ref={ref}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          // Without this the press also reaches the canvas beneath and starts
          // a marquee, the same trap the ruler guides hit.
          e.preventDefault();
          e.stopPropagation();
          drag.current = true;
          goTo(e.clientX, e.clientY);
        }}
      />
    </div>
  );
}
