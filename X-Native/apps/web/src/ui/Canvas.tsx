import { useEffect, useRef } from "react";
import type { Engine, NodeKind, Snapshot, Tool, XNode } from "../engine/types";
import { hitTest, worldPos } from "../engine/memory";

const CREATE: Tool[] = [
  "frame",
  "rect",
  "ellipse",
  "text",
  "line",
  "arrow",
  "poly",
  "star",
];

function kindOf(t: Tool): NodeKind | null {
  if (t === "slice" || t === "pen" || t === "pencil" || t === "brush") return "rect";
  if (CREATE.includes(t)) return t as NodeKind;
  return null;
}

export function Canvas({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | {
        mode: "pan" | "move" | "create" | "resize" | "marquee";
        sx: number;
        sy: number;
        wx: number;
        wy: number;
        orig?: { x: number; y: number; w: number; h: number };
        corner?: number;
        id?: string;
      }
    | null
  >(null);
  const space = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") space.current = e.type === "keydown";
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  useEffect(() => {
    const c = ref.current;
    const box = wrap.current;
    if (!c || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth;
    const h = box.clientHeight;
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#e5e5e5";
    ctx.fillRect(0, 0, w, h);
    // Figma's faint pixel grid at ≥100%
    if (snap.zoom >= 1) {
      ctx.strokeStyle = "rgba(0,0,0,0.04)";
      ctx.lineWidth = 1;
      const step = 8 * snap.zoom;
      ctx.beginPath();
      for (let x = snap.panX % step; x < w; x += step) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = snap.panY % step; y < h; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
    }
    const root = snap.pages[snap.page].root;
    const z = snap.zoom;
    const paint = (n: XNode, px: number, py: number) => {
      if (!n.visible) return;
      const x = px + n.x;
      const y = py + n.y;
      ctx.save();
      if (n.rotation) {
        ctx.translate(x + n.w / 2, y + n.h / 2);
        ctx.rotate((n.rotation * Math.PI) / 180);
        ctx.translate(-(x + n.w / 2), -(y + n.h / 2));
      }
      ctx.globalAlpha *= n.opacity;
      const sx = snap.panX + x * z;
      const sy = snap.panY + y * z;
      const sw = n.w * z;
      const sh = n.h * z;
      const r = n.cornerRadii[0] * z;
      const round = () => {
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(sx, sy, sw, sh, r);
        else ctx.rect(sx, sy, sw, sh);
      };
      if (n.kind === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(sx + sw / 2, sy + sh / 2, Math.abs(sw / 2), Math.abs(sh / 2), 0, 0, Math.PI * 2);
      } else if (n.kind === "line" || n.kind === "arrow") {
        ctx.beginPath();
        ctx.moveTo(sx, sy + sh / 2);
        ctx.lineTo(sx + sw, sy + sh / 2);
      } else if (n.kind === "star") {
        starPath(ctx, sx + sw / 2, sy + sh / 2, Math.min(sw, sh) / 2, 5);
      } else if (n.kind === "poly") {
        polyPath(ctx, sx + sw / 2, sy + sh / 2, Math.min(sw, sh) / 2, 3);
      } else {
        round();
      }
      if (n.fill && n.fill !== "#00000000" && n.kind !== "line" && n.kind !== "arrow") {
        ctx.fillStyle = n.fill;
        ctx.fill();
      }
      if (n.strokeWidth > 0 && n.strokePaint !== "#00000000") {
        ctx.strokeStyle = n.strokePaint;
        ctx.lineWidth = Math.max(1, n.strokeWidth * z);
        ctx.stroke();
      }
      if (n.kind === "text") {
        ctx.fillStyle = n.fill;
        ctx.font = `${n.fontWeight} ${Math.max(8, n.fontSize * z)}px Inter, system-ui`;
        ctx.textBaseline = "top";
        ctx.fillText(n.text || "Text", sx, sy);
      }
      if (n.kind === "frame" && n.overflow !== "visible") {
        round();
        ctx.clip();
      }
      for (const ch of n.children) paint(ch, x, y);
      ctx.restore();
    };
    for (const ch of root.children) paint(ch, 0, 0);

    // frame names
    ctx.font = "500 11px Inter, system-ui";
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    const label = (n: XNode, px: number, py: number) => {
      const x = px + n.x;
      const y = py + n.y;
      if (n.kind === "frame") {
        ctx.fillText(n.name, snap.panX + x * z, snap.panY + y * z - 14);
      }
      for (const c of n.children) label(c, x, y);
    };
    for (const ch of root.children) label(ch, 0, 0);

    for (const id of snap.selection) {
      const wp = worldPos(root, id);
      if (!wp) continue;
      const sx = snap.panX + wp.x * z;
      const sy = snap.panY + wp.y * z;
      const sw = wp.node.w * z;
      const sh = wp.node.h * z;
      ctx.strokeStyle = "#7c5cfc";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx, sy, sw, sh);
      const hs = [
        [sx, sy],
        [sx + sw, sy],
        [sx, sy + sh],
        [sx + sw, sy + sh],
      ];
      for (const [hx, hy] of hs) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
        ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
      }
    }
  }, [snap]);

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return {
      x: (cx - r.left - snap.panX) / snap.zoom,
      y: (cy - r.top - snap.panY) / snap.zoom,
    };
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button === 1 || snap.tool === "hand" || space.current) {
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, wx: 0, wy: 0 };
      return;
    }
    const wpt = toWorld(e.clientX, e.clientY);
    const root = snap.pages[snap.page].root;
    const create = kindOf(snap.tool);
    if (create) {
      drag.current = {
        mode: "create",
        sx: e.clientX,
        sy: e.clientY,
        wx: wpt.x,
        wy: wpt.y,
      };
      return;
    }
    // resize handles
    if (snap.selection.length === 1) {
      const wp = worldPos(root, snap.selection[0]);
      if (wp) {
        const z = snap.zoom;
        const sx = snap.panX + wp.x * z;
        const sy = snap.panY + wp.y * z;
        const r = wrap.current!.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const hs = [
          [sx, sy],
          [sx + wp.node.w * z, sy],
          [sx, sy + wp.node.h * z],
          [sx + wp.node.w * z, sy + wp.node.h * z],
        ];
        for (let i = 0; i < 4; i++) {
          if (Math.hypot(px - hs[i][0], py - hs[i][1]) < 8) {
            drag.current = {
              mode: "resize",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              orig: { x: wp.x, y: wp.y, w: wp.node.w, h: wp.node.h },
              corner: i,
              id: wp.node.id,
            };
            return;
          }
        }
      }
    }
    const hit = hitTest(root, wpt.x, wpt.y);
    if (hit) {
      const ids = e.shiftKey
        ? snap.selection.includes(hit.id)
          ? snap.selection.filter((i) => i !== hit.id)
          : [...snap.selection, hit.id]
        : [hit.id];
      engine.dispatch({ type: "select", ids });
      engine.dispatch({ type: "begin" });
      drag.current = {
        mode: "move",
        sx: e.clientX,
        sy: e.clientY,
        wx: wpt.x,
        wy: wpt.y,
      };
    } else {
      engine.dispatch({ type: "select", ids: [] });
      drag.current = { mode: "marquee", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y };
    }
  };

  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "pan") {
      engine.dispatch({ type: "pan", dx: e.clientX - d.sx, dy: e.clientY - d.sy });
      d.sx = e.clientX;
      d.sy = e.clientY;
    } else if (d.mode === "move" && snap.tool === "select") {
      const dx = (e.clientX - d.sx) / snap.zoom;
      const dy = (e.clientY - d.sy) / snap.zoom;
      if (dx || dy) {
        engine.dispatch({ type: "move", ids: snap.selection, dx, dy });
        d.sx = e.clientX;
        d.sy = e.clientY;
      }
    }
  };

  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "create") {
      const a = toWorld(d.sx, d.sy);
      const b = toWorld(e.clientX, e.clientY);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      let w = Math.abs(b.x - a.x);
      let h = Math.abs(b.y - a.y);
      const k = kindOf(snap.tool);
      if (!k) return;
      if (k === "text") {
        w = Math.max(w, 120);
        h = Math.max(h, 24);
      } else {
        w = Math.max(w, 8);
        h = Math.max(h, 8);
      }
      engine.dispatch({ type: "add", kind: k, x, y, w, h });
    }
    if (d.mode === "resize" && d.orig && d.id != null && d.corner != null) {
      const b = toWorld(e.clientX, e.clientY);
      const o = d.orig;
      let { x, y, w, h } = o;
      if (d.corner === 0) {
        w = o.x + o.w - b.x;
        h = o.y + o.h - b.y;
        x = b.x;
        y = b.y;
      } else if (d.corner === 1) {
        w = b.x - o.x;
        h = o.y + o.h - b.y;
        y = b.y;
      } else if (d.corner === 2) {
        w = o.x + o.w - b.x;
        h = b.y - o.y;
        x = b.x;
      } else {
        w = b.x - o.x;
        h = b.y - o.y;
      }
      engine.dispatch({
        type: "resize",
        id: d.id,
        x,
        y,
        w: Math.max(1, w),
        h: Math.max(1, h),
      });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      engine.dispatch({ type: "setZoom", zoom: snap.zoom * factor });
    } else {
      engine.dispatch({ type: "pan", dx: -e.deltaX, dy: -e.deltaY });
    }
  };

  const cursor =
    snap.tool === "hand" || space.current
      ? "grab"
      : CREATE.includes(snap.tool)
        ? "crosshair"
        : "default";

  return (
    <div
      className="canvas-wrap"
      ref={wrap}
      style={{ cursor }}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
      onWheel={onWheel}
    >
      <canvas ref={ref} />
    </div>
  );
}

function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  n: number,
) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (i * Math.PI) / n - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.4;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function polyPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  n: number,
) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
