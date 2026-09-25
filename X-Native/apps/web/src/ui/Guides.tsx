import { useEffect, useRef, useState } from "react";
import type { Engine, RulerGuide, XNode } from "../engine/types";
import { deepestFrame, worldPos } from "../engine/memory";
import { ContextMenu } from "./ContextMenu";

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
 *
 * Guides are canvas-global by default; one dropped onto a frame becomes a
 * frame-level guide — stored in the frame's space, so it moves with the frame
 * — exactly like Figma. ⌥-drag duplicates a guide. Clicking selects it
 * (Delete removes it, Escape deselects); right-click removes it via a menu.
 */

const RAIL = 20;

export function Guides({
  guides,
  root,
  engine,
  zoom,
  panX,
  panY,
  width,
  height,
}: {
  guides: RulerGuide[];
  root: XNode;
  engine: Engine;
  zoom: number;
  panX: number;
  panY: number;
  width: number;
  height: number;
}) {
  const [drag, setDrag] = useState<{ id: string; axis: "x" | "y"; fresh: boolean } | null>(null);
  const [hint, setHint] = useState<{ axis: "x" | "y"; at: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const sel = engine.snapshot().selectedGuide;

  const toWorldX = (clientX: number) => {
    const box = layer.current?.getBoundingClientRect();
    return (clientX - (box?.left ?? 0) - panX) / zoom;
  };
  const toWorldY = (clientY: number) => {
    const box = layer.current?.getBoundingClientRect();
    return (clientY - (box?.top ?? 0) - panY) / zoom;
  };
  /** Frame-space origin of a guide in world units, or 0 for canvas guides.
   *  Null when the frame is gone (a stale guide, never painted). */
  const baseOf = (g: RulerGuide): number | null => {
    if (!g.frameId) return 0;
    const wp = worldPos(root, g.frameId);
    if (!wp) return null;
    return g.axis === "x" ? wp.x : wp.y;
  };
  const worldAt = (g: RulerGuide): number | null => {
    const base = baseOf(g);
    return base == null ? null : base + g.at;
  };

  // Drag is tracked on the window so the pointer can leave the layer — and so
  // releasing over a ruler rail deletes the guide.
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      // Live snapshot, not the render's props: a keypress mid-drag (undo,
      // nudge) can swap the tree under the pointer-held gesture.
      const live = engine.snapshot();
      const lroot = live.pages[live.page].root;
      const g = live.pages[live.page].guides.find((x) => x.id === drag.id);
      if (!g) return;
      const wp = g.frameId ? worldPos(lroot, g.frameId) : null;
      if (g.frameId && !wp) return;
      const base = !g.frameId ? 0 : g.axis === "x" ? (wp?.x ?? 0) : (wp?.y ?? 0);
      const at = Math.round((drag.axis === "x" ? toWorldX(e.clientX) : toWorldY(e.clientY)) - base);
      engine.dispatch({ type: "moveGuide", id: drag.id, at });
    };
    const up = (e: MouseEvent) => {
      const box = layer.current?.getBoundingClientRect();
      const lx = e.clientX - (box?.left ?? 0);
      const ly = e.clientY - (box?.top ?? 0);
      // Dropped back on a rail, or dragged off the viewport: discard it.
      if (lx < RAIL || ly < RAIL || lx > width || ly > height) {
        engine.dispatch({ type: "removeGuide", id: drag.id });
        setDrag(null);
        return;
      }
      if (drag.fresh) {
        // A newborn guide lands on a frame or on the canvas depending on
        // where it is released; a frame guide is stored in frame space.
        const live = engine.snapshot();
        const lroot = live.pages[live.page].root;
        const wx = toWorldX(e.clientX);
        const wy = toWorldY(e.clientY);
        const host = deepestFrame(lroot, wx, wy);
        if (host) {
          const wp = worldPos(lroot, host.id);
          const base = drag.axis === "x" ? (wp?.x ?? 0) : (wp?.y ?? 0);
          const at = Math.round((drag.axis === "x" ? wx : wy) - base);
          engine.dispatch({ type: "moveGuide", id: drag.id, at });
          engine.dispatch({ type: "setGuideFrame", id: drag.id, frameId: host.id });
        } else {
          engine.dispatch({ type: "setGuideFrame", id: drag.id, frameId: null });
        }
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

  const select = (id: string | null) => {
    // Guide and layer selections are mutually exclusive; clearing the layers
    // first also keeps Delete/Escape routing unambiguous in chrome.
    engine.dispatch({ type: "select", ids: [] });
    engine.dispatch({ type: "selectGuide", id });
  };

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
    if (last) {
      setDrag({ id: last.id, axis, fresh: true });
      engine.dispatch({ type: "select", ids: [] });
      engine.dispatch({ type: "selectGuide", id: last.id });
    }
  };

  const pressGuide = (g: RulerGuide, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) {
      // ⌥-drag duplicates the guide; the copy inherits canvas/frame level.
      engine.dispatch({ type: "addGuide", axis: g.axis, at: g.at, frameId: g.frameId });
      const created = engine.snapshot().pages[engine.snapshot().page].guides;
      const last = created[created.length - 1];
      if (last) {
        setDrag({ id: last.id, axis: g.axis, fresh: false });
        engine.dispatch({ type: "select", ids: [] });
        engine.dispatch({ type: "selectGuide", id: last.id });
      }
      return;
    }
    setDrag({ id: g.id, axis: g.axis, fresh: false });
    select(g.id);
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
        const wat = worldAt(g);
        if (wat == null) return null;
        const pos = g.axis === "x" ? panX + wat * zoom : panY + wat * zoom;
        // Off-screen guides still exist; just skip drawing them.
        if (pos < RAIL - 1 || pos > (g.axis === "x" ? width : height)) return null;
        return (
          <div
            key={g.id}
            className={`guide guide-${g.axis}${drag?.id === g.id ? " on" : ""}${sel === g.id ? " sel" : ""}`}
            style={g.axis === "x" ? { left: pos } : { top: pos }}
            onMouseDown={(e) => pressGuide(g, e)}
            onDoubleClick={() => engine.dispatch({ type: "removeGuide", id: g.id })}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              select(g.id);
              setMenu({ x: e.clientX, y: e.clientY, id: g.id });
            }}
            role="separator"
            aria-label={`${g.axis === "x" ? "Vertical" : "Horizontal"} guide at ${Math.round(wat)}${g.frameId ? " (on frame)" : ""}`}
            aria-orientation={g.axis === "x" ? "vertical" : "horizontal"}
          >
            {drag?.id === g.id && <span className="guide-badge">{Math.round(wat)}</span>}
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ kind: "action", id: "remove", label: "Remove guide", icon: "trash" }]}
          onRun={(id) => {
            if (id === "remove") engine.dispatch({ type: "removeGuide", id: menu.id });
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
