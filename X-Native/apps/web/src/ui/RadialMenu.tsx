/**
 * Marking / Radial Menu (Phase 7 Leapfrog Differentiation)
 *
 * Fast gesture-based radial menu providing rapid access to primary vector
 * creation and editing tools without moving the cursor across the canvas.
 * Triggered via shortcut ('Q' or '~') or radial gesture.
 */

import { useEffect, useState } from "react";
import type { Engine } from "../engine/types";

export interface RadialSlice {
  id: string;
  label: string;
  shortcut: string;
  icon: string;
  action: (engine: Engine) => void;
}

const SLICES: RadialSlice[] = [
  { id: "select", label: "Select", shortcut: "V", icon: "select", action: (e) => e.dispatch({ type: "setTool", tool: "select" }) },
  { id: "frame", label: "Frame", shortcut: "F", icon: "frame", action: (e) => e.dispatch({ type: "setTool", tool: "frame" }) },
  { id: "rect", label: "Rectangle", shortcut: "R", icon: "rect", action: (e) => e.dispatch({ type: "setTool", tool: "rect" }) },
  { id: "pen", label: "Pen", shortcut: "P", icon: "pen", action: (e) => e.dispatch({ type: "setTool", tool: "pen" }) },
  { id: "bend", label: "Bend Tool", shortcut: "⌥", icon: "vector", action: (e) => {
    e.dispatch({ type: "setTool", tool: "select" });
    window.dispatchEvent(new CustomEvent("x-native-bend-tool"));
  } },
  { id: "shapeBuilder", label: "Shape Builder", shortcut: "B", icon: "shapes", action: (e) => {
    e.dispatch({ type: "shapeBuilder", op: "merge" });
  } },
  { id: "text", label: "Text", shortcut: "T", icon: "text", action: (e) => e.dispatch({ type: "setTool", tool: "text" }) },
  { id: "cleanup", label: "Clean Up", shortcut: "✨", icon: "visual-search", action: (e) => {
    e.dispatch({ type: "vectorCleanup" });
  } },
];

export function RadialMenu({
  engine,
  x,
  y,
  onClose,
}: {
  engine: Engine;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const radius = 100;
  const innerRadius = 38;
  const numSlices = SLICES.length;
  const sliceAngle = (Math.PI * 2) / numSlices;

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const dx = e.clientX - x;
      const dy = e.clientY - y;
      const dist = Math.hypot(dx, dy);

      if (dist < innerRadius * 0.7) {
        setActiveIdx(null);
        return;
      }

      let angle = Math.atan2(dy, dx);
      // Offset so slice 0 starts at -Math.PI/2 (top)
      angle += Math.PI / 2 + sliceAngle / 2;
      while (angle < 0) angle += Math.PI * 2;
      while (angle >= Math.PI * 2) angle -= Math.PI * 2;

      const idx = Math.floor(angle / sliceAngle) % numSlices;
      setActiveIdx(idx);
    };

    const handleUp = (e: MouseEvent) => {
      e.stopPropagation();
      if (activeIdx !== null && SLICES[activeIdx]) {
        SLICES[activeIdx].action(engine);
      }
      onClose();
    };

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp, { capture: true });
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp, { capture: true });
      window.removeEventListener("keydown", handleKey);
    };
  }, [x, y, activeIdx, engine, onClose, sliceAngle, numSlices]);

  return (
    <div
      style={{
        position: "fixed",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        width: radius * 2 + 20,
        height: radius * 2 + 20,
        pointerEvents: "auto",
        zIndex: 9999,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <svg
        width={radius * 2 + 20}
        height={radius * 2 + 20}
        viewBox={`${-radius - 10} ${-radius - 10} ${radius * 2 + 20} ${radius * 2 + 20}`}
        style={{ filter: "drop-shadow(0 8px 24px rgba(0, 0, 0, 0.45))" }}
      >
        {SLICES.map((s, i) => {
          const a0 = -Math.PI / 2 + (i - 0.5) * sliceAngle;
          const a1 = -Math.PI / 2 + (i + 0.5) * sliceAngle;
          const isSelected = activeIdx === i;

          const p0x = Math.cos(a0) * innerRadius;
          const p0y = Math.sin(a0) * innerRadius;
          const p1x = Math.cos(a0) * radius;
          const p1y = Math.sin(a0) * radius;
          const p2x = Math.cos(a1) * radius;
          const p2y = Math.sin(a1) * radius;
          const p3x = Math.cos(a1) * innerRadius;
          const p3y = Math.sin(a1) * innerRadius;

          const d = `M ${p0x} ${p0y} L ${p1x} ${p1y} A ${radius} ${radius} 0 0 1 ${p2x} ${p2y} L ${p3x} ${p3y} A ${innerRadius} ${innerRadius} 0 0 0 ${p0x} ${p0y} Z`;

          const midAngle = (a0 + a1) / 2;
          const iconR = (innerRadius + radius) / 2;
          const ix = Math.cos(midAngle) * iconR;
          const iy = Math.sin(midAngle) * iconR;

          return (
            <g key={s.id}>
              <path
                d={d}
                fill={isSelected ? "var(--accent, #10b981)" : "#1e1e22"}
                stroke="#2a2a30"
                strokeWidth={1.5}
                style={{
                  transition: "fill 0.1s ease",
                  cursor: "pointer",
                }}
              />
              <g transform={`translate(${ix}, ${iy})`}>
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={isSelected ? "#ffffff" : "#cccccc"}
                  fontSize={10}
                  fontWeight={600}
                  fontFamily="system-ui, sans-serif"
                >
                  {s.label}
                </text>
              </g>
            </g>
          );
        })}

        {/* Center hub */}
        <circle
          cx={0}
          cy={0}
          r={innerRadius - 4}
          fill="#141416"
          stroke="var(--accent, #10b981)"
          strokeWidth={2}
        />
        <text
          x={0}
          y={0}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#ffffff"
          fontSize={11}
          fontWeight={700}
          fontFamily="system-ui, sans-serif"
        >
          {activeIdx !== null ? SLICES[activeIdx].shortcut : "X"}
        </text>
      </svg>
    </div>
  );
}
