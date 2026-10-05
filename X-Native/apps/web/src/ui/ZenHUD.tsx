/**
 * Zen Mode & Contextual HUD (Phase 7 Leapfrog Differentiation)
 *
 * Provides a floating, distraction-free Contextual Heads-Up Display when
 * working in full-canvas Zen Mode.
 *
 * The HUD used to carry its whole identity inline — sixteen style objects with
 * a near-black glass, a white hairline, the retired emerald for the live tool
 * and three greys for its own type, each written at the call site — so it was
 * the one canvas surface no token reached. It is a dock surface now: the same
 * glass, the same hairline, the same accent, read from the sheet like every
 * other overlay that floats over the document (styles.css, § zen HUD). Only the
 * two document values stay inline, because a layer's own colour is data.
 */

import type { Engine, Snapshot, Tool } from "../engine/types";
import { find } from "../engine/memory";
import { Icon } from "./icons";

const TOOLS: { id: Tool; icon: "select" | "frame" | "rect" | "pen" | "text"; title: string }[] = [
  { id: "select", icon: "select", title: "Select / Move (V)" },
  { id: "frame", icon: "frame", title: "Frame (F)" },
  { id: "rect", icon: "rect", title: "Rectangle (R)" },
  { id: "pen", icon: "pen", title: "Pen Tool (P)" },
  { id: "text", icon: "text", title: "Text (T)" },
];

export function ZenHUD({
  engine,
  snap,
  onExit,
}: {
  engine: Engine;
  snap: Snapshot;
  onExit: () => void;
}) {
  const root = snap.pages[snap.page].root;
  const selId = snap.selection[0];
  const node = selId ? find(root, selId) : null;

  const setTool = (t: Tool) => {
    engine.dispatch({ type: "setTool", tool: t });
  };

  return (
    <div className="zen-hud" onClick={(e) => e.stopPropagation()}>
      {/* Primary tools — the dock's own button recipe, on glass. */}
      <div className="zen-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`zen-tool${snap.tool === t.id ? " on" : ""}`}
            title={t.title}
            aria-label={t.title}
            aria-pressed={snap.tool === t.id}
            onClick={() => setTool(t.id)}
          >
            <Icon name={t.icon} size={16} />
          </button>
        ))}
      </div>

      <span className="zen-sep" aria-hidden="true" />

      {/* The selection, at a glance: size, fill, stroke. */}
      {node ? (
        <div className="zen-metrics">
          <span className="zen-dims">
            {Math.round(node.w)} × {Math.round(node.h)}
          </span>
          {node.fill && node.fillVisible !== false && (
            <span className="zen-swatch" style={{ background: node.fill }} title={`Fill: ${node.fill}`} />
          )}
          {node.strokeWidth > 0 && node.strokePaint && (
            <span
              className="zen-stroke-swatch"
              style={{ borderColor: node.strokePaint }}
              title={`Stroke: ${node.strokeWidth}px ${node.strokePaint}`}
            />
          )}
        </div>
      ) : (
        <span className="zen-hint">Zen Mode · Press Z or ⌘\ to exit</span>
      )}

      <span className="zen-sep" aria-hidden="true" />

      {/* Zoom, and the way out. */}
      <button
        className="zen-zoom"
        onClick={() => engine.dispatch({ type: "setZoom", zoom: 1 })}
        title="Reset zoom to 100%"
      >
        {Math.round(snap.zoom * 100)}%
      </button>
      <button className="zen-exit" onClick={onExit} title="Exit Zen Mode (Z)">
        Exit Zen
      </button>
    </div>
  );
}
