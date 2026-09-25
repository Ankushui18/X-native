/**
 * Zen Mode & Contextual HUD (Phase 7 Leapfrog Differentiation)
 *
 * Provides a floating, distraction-free Contextual Heads-Up Display when
 * working in full-canvas Zen Mode.
 */

import type { Engine, Snapshot, Tool } from "../engine/types";
import { find } from "../engine/memory";
import { Icon } from "./icons";

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
    <div
      className="zen-hud"
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(24, 24, 27, 0.88)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        borderRadius: 12,
        padding: "6px 12px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.45)",
        zIndex: 5000,
        color: "#ffffff",
        fontSize: 12,
        pointerEvents: "auto",
        userSelect: "none",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Primary Tools */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          className={`icon-btn ${snap.tool === "select" ? "on" : ""}`}
          title="Select / Move (V)"
          onClick={() => setTool("select")}
          style={{
            background: snap.tool === "select" ? "rgba(255, 255, 255, 0.16)" : "transparent",
            color: snap.tool === "select" ? "#10b981" : "#ffffff",
            padding: 5,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <Icon name="select" size={16} />
        </button>
        <button
          className={`icon-btn ${snap.tool === "frame" ? "on" : ""}`}
          title="Frame (F)"
          onClick={() => setTool("frame")}
          style={{
            background: snap.tool === "frame" ? "rgba(255, 255, 255, 0.16)" : "transparent",
            color: snap.tool === "frame" ? "#10b981" : "#ffffff",
            padding: 5,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <Icon name="frame" size={16} />
        </button>
        <button
          className={`icon-btn ${snap.tool === "rect" ? "on" : ""}`}
          title="Rectangle (R)"
          onClick={() => setTool("rect")}
          style={{
            background: snap.tool === "rect" ? "rgba(255, 255, 255, 0.16)" : "transparent",
            color: snap.tool === "rect" ? "#10b981" : "#ffffff",
            padding: 5,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <Icon name="rect" size={16} />
        </button>
        <button
          className={`icon-btn ${snap.tool === "pen" ? "on" : ""}`}
          title="Pen Tool (P)"
          onClick={() => setTool("pen")}
          style={{
            background: snap.tool === "pen" ? "rgba(255, 255, 255, 0.16)" : "transparent",
            color: snap.tool === "pen" ? "#10b981" : "#ffffff",
            padding: 5,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <Icon name="pen" size={16} />
        </button>
        <button
          className={`icon-btn ${snap.tool === "text" ? "on" : ""}`}
          title="Text (T)"
          onClick={() => setTool("text")}
          style={{
            background: snap.tool === "text" ? "rgba(255, 255, 255, 0.16)" : "transparent",
            color: snap.tool === "text" ? "#10b981" : "#ffffff",
            padding: 5,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <Icon name="text" size={16} />
        </button>
      </div>

      <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

      {/* Selected Object Quick Metrics */}
      {node ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: 11, color: "#e4e4e7" }}>
            {Math.round(node.w)} × {Math.round(node.h)}
          </span>
          {node.fill && (
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: node.fill,
                border: "1px solid rgba(255, 255, 255, 0.3)",
              }}
              title={`Fill: ${node.fill}`}
            />
          )}
          {node.strokeWidth > 0 && node.strokePaint && (
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                border: `2px solid ${node.strokePaint}`,
                background: "transparent",
              }}
              title={`Stroke: ${node.strokeWidth}px ${node.strokePaint}`}
            />
          )}
        </div>
      ) : (
        <span style={{ color: "rgba(255, 255, 255, 0.5)", fontSize: 11 }}>
          Zen Mode · Press Z or ⌘\ to exit
        </span>
      )}

      <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

      {/* Zoom level */}
      <span
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono, monospace)",
          color: "#a1a1aa",
          cursor: "pointer",
        }}
        onClick={() => engine.dispatch({ type: "setZoom", zoom: 1 })}
        title="Reset zoom to 100%"
      >
        {Math.round(snap.zoom * 100)}%
      </span>

      {/* Exit Button */}
      <button
        onClick={onExit}
        style={{
          background: "rgba(255, 255, 255, 0.08)",
          border: "1px solid rgba(255, 255, 255, 0.15)",
          color: "#ffffff",
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 11,
          fontWeight: 500,
          cursor: "pointer",
        }}
        title="Exit Zen Mode (Z)"
      >
        Exit Zen
      </button>
    </div>
  );
}
