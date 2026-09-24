import type { Engine, Snapshot } from "../engine/types";
import { worldPos } from "../engine/memory";
import { clampZoom } from "../engine/view";

export { ZOOM_PRESETS as ZOOM_STEPS, stepZoom, clampZoom, zoomLabel, parseZoomInput } from "../engine/view";

/** The visible canvas rect, so fit/selection centre content in the viewport that
 *  is actually left over by the panels — not on an assumed 520px of chrome.
 *  Falls back to the window when the canvas is not mounted (headless tests). */
function viewport(): { w: number; h: number; x: number; y: number } {
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  const r = el?.getBoundingClientRect();
  if (r && r.width > 40 && r.height > 40) return { w: r.width, h: r.height, x: r.left, y: r.top };
  return { w: window.innerWidth - 520, h: window.innerHeight - 96, x: 240, y: 0 };
}

/** Fit the page (or the selection) into the viewport, Figma's ⇧1 / 2.
 *
 * The pan is expressed in canvas-local coordinates because the canvas element
 * is offset by the panels; using window coordinates here puts the content
 * hundreds of pixels off-centre, which is what reads as "the canvas is broken".
 */
export function zoomTo(engine: Engine, mode: "fit" | "selection", padding = 0.9) {
  const s = engine.snapshot();
  const root = s.pages[s.page].root;
  // ⇧2 with nothing selected does nothing at all in Figma - it must not fall
  // back to fitting the page, or the shortcut becomes a second ⇧1.
  if (mode === "selection" && !s.selection.length) return;
  const nodes =
    mode === "selection" && s.selection.length
      ? s.selection
          .map((id) => worldPos(root, id))
          .filter((x): x is NonNullable<typeof x> => !!x)
          .map((n) => ({ x: n.x, y: n.y, w: n.node.w, h: n.node.h }))
      : root.children
          .filter((c) => c.visible)
          .map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  if (!nodes.length) {
    engine.dispatch({ type: "setZoom", zoom: 1 });
    return;
  }
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const vp = viewport();
  // Never zoom past 100% to fit — Figma stops at real size, and users read a
  // blown-up "fit" as a bug.
  const z = clampZoom(Math.min(1, Math.min(vp.w / bw, vp.h / bh) * padding));
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  const rect = el?.getBoundingClientRect();
  const localX = rect ? 0 : vp.x;
  const localY = rect ? 0 : vp.y;
  engine.dispatch({ type: "setZoom", zoom: z });
  engine.dispatch({
    type: "setPan",
    x: localX + (vp.w - bw * z) / 2 - minX * z,
    y: localY + (vp.h - bh * z) / 2 - minY * z,
  });
}

/** Zoom around a screen point (the cursor), keeping that point fixed. */
export function zoomAtPoint(engine: Engine, next: number, cx: number, cy: number) {
  const s = engine.snapshot();
  const z = clampZoom(next);
  if (Math.abs(z - s.zoom) < 1e-9) return;
  const wx = (cx - s.panX) / s.zoom;
  const wy = (cy - s.panY) / s.zoom;
  engine.dispatch({ type: "setZoom", zoom: z });
  engine.dispatch({ type: "setPan", x: cx - wx * z, y: cy - wy * z });
}

/** Pan so the selection sits in the middle of the viewport, zoom unchanged
 *  (Sketch's ⌘3 "Center selection in the Canvas"). */
export function zoomCenter(engine: Engine) {
  const snap = engine.snapshot();
  const bb = boundsOf(snap, snap.selection);
  if (!bb) return;
  const vp = viewport();
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  const off = el ? 0 : vp.x;
  engine.dispatch({
    type: "setPan",
    x: Math.round(off + vp.w / 2 - (bb.x + bb.w / 2) * snap.zoom),
    y: Math.round(vp.h / 2 - (bb.y + bb.h / 2) * snap.zoom),
  });
}

/** Zoom so a world-space rect exactly fills the viewport — Sketch's drag-the-
 *  Zoom-tool-over-an-area gesture. */
export function zoomToRect(engine: Engine, rect: { x: number; y: number; w: number; h: number }) {
  const vp = viewport();
  const z = clampZoom(Math.min((vp.w - 48) / Math.max(1, rect.w), (vp.h - 48) / Math.max(1, rect.h)));
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  const off = el ? 0 : vp.x;
  engine.dispatch({ type: "setZoom", zoom: z });
  engine.dispatch({
    type: "setPan",
    x: Math.round(off + (vp.w - rect.w * z) / 2 - rect.x * z),
    y: Math.round((vp.h - rect.h * z) / 2 - rect.y * z),
  });
}

/** World bounds of a set of ids, or null when nothing is selectable. */
export function boundsOf(snap: Snapshot, ids: string[]) {
  const root = snap.pages[snap.page].root;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const wp = worldPos(root, id);
    if (!wp) continue;
    x0 = Math.min(x0, wp.x);
    y0 = Math.min(y0, wp.y);
    x1 = Math.max(x1, wp.x + wp.node.w);
    y1 = Math.max(y1, wp.y + wp.node.h);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
