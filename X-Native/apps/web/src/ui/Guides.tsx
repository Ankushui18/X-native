import { useEffect, useRef, useState } from "react";
import type { Engine, RulerGuide } from "../engine/types";

/**
 * Ruler guides: the lines a designer drags out of a ruler to align against.
 *
 * A DOM layer rather than part of the canvas paint, for the same reason the
 * comment pins are: these need hit-testing and a drag cursor, and rebuilding
 * the whole document render on every pointer move to drag one line would be
 * wasteful.
 *
 * The rulers canvas is `pointer-events: none`, so the 20px rails here are what
 * the user actually grabs to pull a new guide onto the canvas.
 */

const RAIL = 20;

export function Guides({
  guides,
  engine,
  zoom,
  panX,
  panY,
  width,
  height,
}: {
  guides: RulerGuide[];
  engine: Engine;
  zoom: number;
  panX: number;
  panY: number;
  width: number;
  height: number;
}) {
  const [drag, setDrag] = useState<{ id: string; axis: "x" | "y" } | null>(null);
  const [hint, setHint] = useState<{ axis: "x" | "y"; at: number } | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);

  const toWorldX = (clientX: number) => {
    const box = layer.current?.getBoundingClientRect();
    return ((clientX - (box?.left ?? 0)) - panX) / zoom;
  };
  const toWorldY = (clientY: number) => {
    const box = layer.current?.getBoundingClientRect();
    return ((clientY - (box?.top ?? 0)) - panY) / zoom;
  };

  // Drag is tracked on the window so the pointer can leave the layer — and so
  // releasing over a ruler rail deletes the guide, as Figma does.
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const at = drag.axis === "x" ? toWorldX(e.clientX) : toWorldY(e.clientY);
      engine.dispatch({ type: "moveGuide", id: drag.id, at: Math.round(at) });
    };
    const up = (e: MouseEvent) => {
      const box = layer.current?.getBoundingClientRect();
      const lx = e.clientX - (box?.left ?? 0);
      const ly = e.clientY - (box?.top ?? 0);
      // Dropped back on a rail, or dragged off the viewport: discard it.
      if (lx < RAIL || ly < RAIL || lx > width || ly > height) {
        engine.dispatch({ type: "removeGuide", id: drag.id });
      }
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, engine, zoom, panX, panY, width, height]);

  /** Pull a new guide out of a rail; it is created immediately and then
   *  dragged, so the same move/up handling covers both cases. */
  const startNew = (axis: "x" | "y", e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Without this the press also reaches the canvas underneath, which starts
    // a marquee and changes the selection while the guide is being dragged.
    e.stopPropagation();
    const at = Math.round(axis === "x" ? toWorldX(e.clientX) : toWorldY(e.clientY));
    engine.dispatch({ type: "addGuide", axis, at });
    const created = engine.snapshot().pages[engine.snapshot().page].guides;
    const last = created[created.length - 1];
    if (last) setDrag({ id: last.id, axis });
  };

  return (
    <div className="guide-layer" ref={layer}>
      {/* Grab strips over the ruler rails. */}
      <div
        className="guide-rail guide-rail-top"
        onMouseDown={(e) => startNew("y", e)}
        onMouseMove={(e) => setHint({ axis: "y", at: Math.round(toWorldY(e.clientY)) })}
        onMouseLeave={() => setHint(null)}
        title="Drag down for a horizontal guide"
      />
      <div
        className="guide-rail guide-rail-left"
        onMouseDown={(e) => startNew("x", e)}
        onMouseMove={(e) => setHint({ axis: "x", at: Math.round(toWorldX(e.clientX)) })}
        onMouseLeave={() => setHint(null)}
        title="Drag right for a vertical guide"
      />
      {guides.map((g) => {
        const pos = g.axis === "x" ? panX + g.at * zoom : panY + g.at * zoom;
        // Off-screen guides still exist; just skip drawing them.
        if (pos < RAIL - 1 || pos > (g.axis === "x" ? width : height)) return null;
        return (
          <div
            key={g.id}
            className={`guide guide-${g.axis}${drag?.id === g.id ? " on" : ""}`}
            style={g.axis === "x" ? { left: pos } : { top: pos }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              setDrag({ id: g.id, axis: g.axis });
            }}
            onDoubleClick={() => engine.dispatch({ type: "removeGuide", id: g.id })}
            role="separator"
            aria-label={`${g.axis === "x" ? "Vertical" : "Horizontal"} guide at ${g.at}`}
            aria-orientation={g.axis === "x" ? "vertical" : "horizontal"}
          >
            {drag?.id === g.id && <span className="guide-badge">{g.at}</span>}
          </div>
        );
      })}
      {hint && !drag && (
        <div
          className={`guide guide-${hint.axis} guide-hint`}
          style={
            hint.axis === "x"
              ? { left: panX + hint.at * zoom }
              : { top: panY + hint.at * zoom }
          }
        />
      )}
    </div>
  );
}
