import type { Engine } from "../engine/types";
import { worldPos } from "../engine/memory";

/** Zoom presets offered by the zoom dropdown, matching the steps designers
 *  expect from Figma rather than arbitrary 1.25x multiples. */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 1, 2, 4, 8] as const;

/** Next/previous preset above or below the current zoom. */
export function stepZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STEPS.find((z) => z > current + 1e-4) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-4) ?? ZOOM_STEPS[0];
}

export function zoomTo(engine: Engine, mode: "fit" | "selection") {
  const s = engine.snapshot();
  const root = s.pages[s.page].root;
  const nodes =
    mode === "selection" && s.selection.length
      ? s.selection.map((id) => worldPos(root, id)).filter((x): x is NonNullable<typeof x> => !!x)
      : root.children.filter((c) => c.visible).map((n) => ({ x: n.x, y: n.y, node: n }));
  if (!nodes.length) {
    engine.dispatch({ type: "setZoom", zoom: 1 });
    return;
  }
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.node.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.node.h));
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const vw = Math.max(200, window.innerWidth - 520);
  const vh = Math.max(200, window.innerHeight - 96);
  const z = Math.max(0.1, Math.min(8, Math.min(vw / bw, vh / bh) * 0.9));
  engine.dispatch({ type: "setZoom", zoom: z });
  engine.dispatch({ type: "setPan", x: (vw - bw * z) / 2 - minX * z, y: (vh - bh * z) / 2 - minY * z });
}
