import { useEffect, useRef, useState } from "react";
import type { Engine, NodeKind, PathPoint, Snapshot, Tool, XNode } from "../engine/types";
import { find, findParent, hitTest, worldPos } from "../engine/memory";
import { useTheme } from "./theme";
import { cssRgba, isNone, takeEyedrop, toHex } from "./color";
import { ContextMenu, canvasMenu, isGroupNode, runMenu } from "./ContextMenu";

const CREATE: Tool[] = [
  "frame",
  "section",
  "rect",
  "ellipse",
  "text",
  "line",
  "arrow",
  "poly",
  "star",
  "image",
];

function kindOf(t: Tool): NodeKind | null {
  if (t === "section") return "frame";
  if (t === "slice") return "rect";
  if (t === "pen" || t === "pencil" || t === "brush") return null;
  if (t === "image") return "rect";
  if (CREATE.includes(t)) return t as NodeKind;
  return null;
}

type Drag =
  | {
      mode: "pan" | "move" | "create" | "resize" | "marquee" | "rotate";
      sx: number;
      sy: number;
      wx: number;
      wy: number;
      orig?: { x: number; y: number; w: number; h: number; rotation: number };
      corner?: number;
      id?: string;
    };

export function Canvas({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  const imgs = useRef(new Map<string, HTMLImageElement>());
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingImage = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<PathPoint[]>([]);
  const pencil = useRef<PathPoint[] | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") space.current = e.type === "keydown";
      if (e.type === "keydown" && e.key === "Escape" && draft.length) {
        setDraft([]);
        return;
      }
      if (e.type === "keydown" && e.key === "Enter" && draft.length >= 2) {
        engine.dispatch({ type: "addPath", points: draft, closed: true });
        setDraft([]);
        return;
      }
      if (e.type === "keydown" && e.key === "Enter" && !edit) {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
        const root = snap.pages[snap.page].root;
        const id = snap.selection[0];
        const n = id ? worldPos(root, id)?.node : null;
        if (n?.kind === "text") setEdit({ id: n.id, text: n.text });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [snap, edit, draft, engine]);

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
    const css = getComputedStyle(document.documentElement);
    const canvasBg = css.getPropertyValue("--canvas").trim() || "#e5e5e5";
    const grid = css.getPropertyValue("--grid").trim() || "rgba(0,0,0,0.06)";
    const canvasLabel = css.getPropertyValue("--canvas-label").trim() || "rgba(0,0,0,0.45)";
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, w, h);
    const pageRoot = snap.pages[snap.page].root;
    if (pageRoot.fillVisible !== false && !isNone(pageRoot.fill)) {
      ctx.fillStyle = cssRgba(pageRoot.fill, pageRoot.fillOpacity ?? 1);
      ctx.fillRect(0, 0, w, h);
    }
    const page = snap.pages[snap.page];
    if (page.pixelGrid || snap.zoom >= 2) {
      ctx.strokeStyle = page.pixelGrid ? page.pixelGridColor || grid : grid;
      ctx.lineWidth = 1;
      const step = snap.zoom;
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
    const root = page.root;
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
      const radii = n.cornerIndependent
        ? n.cornerRadii.map((r) => Math.max(0, r * z))
        : Math.max(0, (n.cornerRadii[0] ?? 0) * z);
      const round = () => {
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(sx, sy, sw, sh, radii);
        else ctx.rect(sx, sy, sw, sh);
      };
      if (n.kind === "boolean" && n.booleanOp && n.children.length) {
        paintBoolean(ctx, n, x, y, snap);
        ctx.restore();
        return;
      }
      if (n.kind === "vector" && n.path.length) {
        ctx.beginPath();
        n.path.forEach((pt, i) => {
          const vx = snap.panX + (x + pt.x) * z;
          const vy = snap.panY + (y + pt.y) * z;
          if (i === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        });
        if (n.closed) ctx.closePath();
      } else if (n.kind === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(sx + sw / 2, sy + sh / 2, Math.abs(sw / 2), Math.abs(sh / 2), 0, 0, Math.PI * 2);
      } else if (n.kind === "line" || n.kind === "arrow") {
        ctx.beginPath();
        ctx.moveTo(sx, sy + sh / 2);
        ctx.lineTo(sx + sw, sy + sh / 2);
      } else if (n.kind === "star") {
        starPath(ctx, sx + sw / 2, sy + sh / 2, Math.min(sw, sh) / 2, n.count || 5, n.starRatio || 0.4);
      } else if (n.kind === "poly") {
        polyPath(ctx, sx + sw / 2, sy + sh / 2, Math.min(sw, sh) / 2, n.count || 3);
      } else {
        round();
      }
      const drop = (n.effects ?? []).find((e) => e.kind === "drop-shadow" && e.visible);
      if (drop) {
        ctx.shadowColor = drop.color;
        ctx.shadowBlur = drop.blur * z;
        ctx.shadowOffsetX = (drop.x || 0) * z;
        ctx.shadowOffsetY = (drop.y || 4) * z;
      }
      if (n.imageSrc) {
        let im = imgs.current.get(n.imageSrc);
        if (!im) {
          im = new Image();
          im.src = n.imageSrc;
          im.onload = () => engine.dispatch({ type: "select", ids: snap.selection });
          imgs.current.set(n.imageSrc, im);
        }
        if (im.complete && im.naturalWidth) {
          round();
          ctx.save();
          ctx.clip();
          ctx.drawImage(im, sx, sy, sw, sh);
          ctx.restore();
        }
      } else if (
        n.fillVisible !== false &&
        n.fill &&
        !isNone(n.fill) &&
        n.kind !== "line" &&
        n.kind !== "arrow"
      ) {
        ctx.save();
        ctx.globalAlpha *= n.fillOpacity ?? 1;
        ctx.fillStyle = fillPaint(ctx, n, sx, sy, sw, sh);
        ctx.fill();
        ctx.restore();
      }
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      if (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)) {
        ctx.save();
        ctx.globalAlpha *= n.strokeOpacity ?? 1;
        ctx.strokeStyle = n.strokePaint;
        ctx.lineWidth = Math.max(1, n.strokeWidth * z);
        ctx.lineCap = n.strokeCap === "round" ? "round" : n.strokeCap === "square" ? "square" : "butt";
        ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
        if (n.strokeDash > 0) {
          const dash = n.strokeDash * z;
          const gap = (n.strokeGap || n.strokeDash) * z;
          ctx.setLineDash([dash, gap]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
        if (n.kind === "arrow" || n.strokeCap === "arrow") {
          ctx.setLineDash([]);
          const ah = Math.max(6, n.strokeWidth * 3 * z);
          ctx.beginPath();
          ctx.moveTo(sx + sw, sy + sh / 2);
          ctx.lineTo(sx + sw - ah, sy + sh / 2 - ah * 0.55);
          ctx.lineTo(sx + sw - ah, sy + sh / 2 + ah * 0.55);
          ctx.closePath();
          ctx.fillStyle = n.strokePaint;
          ctx.fill();
        }
        ctx.restore();
      }
      if (n.kind === "text" && edit?.id !== n.id) {
        ctx.fillStyle = n.fill;
        const size = Math.max(8, n.fontSize * z);
        ctx.font = `${n.fontWeight} ${size}px ${n.fontFamily}, Inter, system-ui`;
        ctx.textBaseline = n.textAlignVertical === "middle" ? "middle" : n.textAlignVertical === "bottom" ? "bottom" : "top";
        ctx.textAlign = n.textAlign === "center" ? "center" : n.textAlign === "right" ? "right" : "left";
        const tx = n.textAlign === "center" ? sx + sw / 2 : n.textAlign === "right" ? sx + sw : sx;
        const ty = n.textAlignVertical === "middle" ? sy + sh / 2 : n.textAlignVertical === "bottom" ? sy + sh : sy;
        let content = n.text || "Type something";
        if (n.textCase === "upper") content = content.toUpperCase();
        if (n.textCase === "lower") content = content.toLowerCase();
        if (n.truncate) {
          const lines = content.split("\n").slice(0, n.maxLines || 1);
          content = lines.join("\n");
        }
        ctx.fillText(content, tx, ty, sw);
        if (n.textDecoration === "underline" || n.textDecoration === "strikethrough") {
          const m = ctx.measureText(content);
          ctx.beginPath();
          const yy = n.textDecoration === "underline" ? ty + size : ty + size / 2;
          ctx.moveTo(tx, yy);
          ctx.lineTo(tx + m.width, yy);
          ctx.strokeStyle = n.fill;
          ctx.lineWidth = Math.max(1, z);
          ctx.stroke();
        }
      }
      if (n.kind === "frame" && n.overflow !== "visible") {
        round();
        ctx.clip();
      }
      for (const ch of n.children) paint(ch, x, y);
      ctx.restore();
    };
    const present = snap.presentFrame ? find(root, snap.presentFrame) : null;
    if (present) {
      const wp = worldPos(root, present.id);
      paint(present, wp ? wp.x - present.x : 0, wp ? wp.y - present.y : 0);
    } else {
      for (const ch of root.children) paint(ch, 0, 0);
    }

    ctx.font = "500 11px Inter, system-ui";
    ctx.fillStyle = canvasLabel;
    const label = (n: XNode, px: number, py: number) => {
      const x = px + n.x;
      const y = py + n.y;
      if (n.kind === "frame" && n.showName !== false) {
        ctx.fillText(n.name, snap.panX + x * z, snap.panY + y * z - 14);
      }
      for (const c of n.children) label(c, x, y);
    };
    for (const ch of root.children) label(ch, 0, 0);

    if (draft.length) {
      ctx.beginPath();
      ctx.strokeStyle = "#0d99ff";
      ctx.lineWidth = 1.5;
      draft.forEach((p, i) => {
        const px = snap.panX + p.x * z;
        const py = snap.panY + p.y * z;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      for (const p of draft) {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#0d99ff";
        ctx.beginPath();
        ctx.arc(snap.panX + p.x * z, snap.panY + p.y * z, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    if (snap.rightTab === "prototype" && !snap.presentFrame) {
      walkInteractions(root, 0, 0, (n, nx, ny, destId) => {
        const dest = worldPos(root, destId);
        if (!dest) return;
        const ax = snap.panX + (nx + n.w) * z;
        const ay = snap.panY + (ny + n.h / 2) * z;
        const bx = snap.panX + dest.x * z;
        const by = snap.panY + (dest.y + dest.node.h / 2) * z;
        ctx.strokeStyle = "#0d99ff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.bezierCurveTo(ax + 40, ay, bx - 40, by, bx, by);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ax, ay, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#0d99ff";
        ctx.fill();
      });
    }

    if (snap.presentFrame) return;

    for (const id of snap.selection) {
      if (edit?.id === id) continue;
      const wp = worldPos(root, id);
      if (!wp) continue;
      const sx = snap.panX + wp.x * z;
      const sy = snap.panY + wp.y * z;
      const sw = wp.node.w * z;
      const sh = wp.node.h * z;
      ctx.strokeStyle = "#0d99ff";
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
      const hs = handles(sx, sy, sw, sh);
      for (const [hx, hy] of hs) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#0d99ff";
        ctx.lineWidth = 1;
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
        ctx.strokeRect(hx - 3, hy - 3, 6, 6);
      }
      ctx.beginPath();
      ctx.moveTo(sx + sw / 2, sy);
      ctx.lineTo(sx + sw / 2, sy - 16);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx + sw / 2, sy - 20, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.stroke();
      const dim = `${Math.round(wp.node.w)} × ${Math.round(wp.node.h)}`;
      ctx.font = "500 11px Inter, system-ui";
      const tw = ctx.measureText(dim).width;
      const bw = tw + 16;
      const bh = 20;
      const bx = sx + sw / 2 - bw / 2;
      const by = sy + sh + 8;
      ctx.fillStyle = "#0d99ff";
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();
      } else {
        ctx.fillRect(bx, by, bw, bh);
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(dim, bx + bw / 2, by + bh / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }

    if (band) {
      ctx.fillStyle = "rgba(13,153,255,0.12)";
      ctx.strokeStyle = "#0d99ff";
      ctx.lineWidth = 1;
      ctx.fillRect(band.x, band.y, band.w, band.h);
      ctx.strokeRect(band.x + 0.5, band.y + 0.5, band.w, band.h);
    }
  }, [snap, band, edit, engine, theme, draft]);

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return {
      x: (cx - r.left - snap.panX) / snap.zoom,
      y: (cy - r.top - snap.panY) / snap.zoom,
    };
  };

  const onDown = (e: React.MouseEvent) => {
    if (edit) return;
    if (e.button === 2) return;
    if (snap.presentFrame) {
      const wpt = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      let n: XNode | null = hitTest(root, wpt.x, wpt.y);
      while (n) {
        const ix = (n.interactions ?? []).find((i) => i.trigger === "onClick");
        if (ix) {
          if (ix.action === "back") engine.dispatch({ type: "presentBack" });
          else if (ix.action === "navigate" && ix.destination)
            engine.dispatch({ type: "presentGo", id: ix.destination });
          return;
        }
        const p = findParent(root, n.id);
        n = p && p !== root ? p : null;
      }
      return;
    }
    if (snap.tool === "pen") {
      const wpt = toWorld(e.clientX, e.clientY);
      if (draft.length >= 3) {
        const a = draft[0];
        if (Math.hypot(wpt.x - a.x, wpt.y - a.y) < 8 / snap.zoom) {
          engine.dispatch({ type: "addPath", points: draft, closed: true });
          setDraft([]);
          return;
        }
      }
      setDraft((d) => [...d, wpt]);
      return;
    }
    if (snap.tool === "pencil" || snap.tool === "brush") {
      const wpt = toWorld(e.clientX, e.clientY);
      pencil.current = [wpt];
      setDraft([wpt]);
      return;
    }
    const drop = takeEyedrop();
    if (drop) {
      const c = ref.current;
      const box = wrap.current!.getBoundingClientRect();
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        const px = Math.max(0, Math.floor((e.clientX - box.left) * dpr));
        const py = Math.max(0, Math.floor((e.clientY - box.top) * dpr));
        const ctx = c.getContext("2d");
        if (ctx) {
          const d = ctx.getImageData(px, py, 1, 1).data;
          drop(toHex(d[0], d[1], d[2]));
        }
      }
      return;
    }
    if (e.button === 1 || snap.tool === "hand" || space.current) {
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, wx: 0, wy: 0 };
      return;
    }
    const wpt = toWorld(e.clientX, e.clientY);
    const root = snap.pages[snap.page].root;
    if (snap.tool === "image") {
      pendingImage.current = { x: wpt.x, y: wpt.y };
      fileRef.current?.click();
      return;
    }
    const create = kindOf(snap.tool);
    if (create && snap.tool !== "select") {
      drag.current = {
        mode: "create",
        sx: e.clientX,
        sy: e.clientY,
        wx: wpt.x,
        wy: wpt.y,
      };
      return;
    }
    if (snap.selection.length === 1) {
      const wp = worldPos(root, snap.selection[0]);
      if (wp) {
        const z = snap.zoom;
        const sx = snap.panX + wp.x * z;
        const sy = snap.panY + wp.y * z;
        const r = wrap.current!.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        if (Math.hypot(px - (sx + (wp.node.w * z) / 2), py - (sy - 20)) < 8) {
          drag.current = {
            mode: "rotate",
            sx: e.clientX,
            sy: e.clientY,
            wx: wpt.x,
            wy: wpt.y,
            orig: { x: wp.x, y: wp.y, w: wp.node.w, h: wp.node.h, rotation: wp.node.rotation },
            id: wp.node.id,
          };
          return;
        }
        const hs = handles(sx, sy, wp.node.w * z, wp.node.h * z);
        for (let i = 0; i < hs.length; i++) {
          if (Math.hypot(px - hs[i][0], py - hs[i][1]) < 8) {
            drag.current = {
              mode: "resize",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              orig: { x: wp.node.x, y: wp.node.y, w: wp.node.w, h: wp.node.h, rotation: wp.node.rotation },
              corner: i,
              id: wp.node.id,
            };
            engine.dispatch({ type: "begin" });
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
    if (pencil.current) {
      const wpt = toWorld(e.clientX, e.clientY);
      pencil.current.push(wpt);
      setDraft([...pencil.current]);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const box = wrap.current!.getBoundingClientRect();
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
    } else if (d.mode === "create" || d.mode === "marquee") {
      const x = Math.min(d.sx, e.clientX) - box.left;
      const y = Math.min(d.sy, e.clientY) - box.top;
      setBand({ x, y, w: Math.abs(e.clientX - d.sx), h: Math.abs(e.clientY - d.sy) });
    } else if (d.mode === "resize" && d.orig && d.id != null && d.corner != null) {
      const b = toWorld(e.clientX, e.clientY);
      let next = resizeFrom(d.orig, d.corner, b.x, b.y);
      const locked = worldPos(snap.pages[snap.page].root, d.id)?.node.aspectLocked;
      if (locked && d.orig.w > 0) {
        const ratio = d.orig.h / d.orig.w;
        next.h = Math.max(1, next.w * ratio);
      }
      engine.dispatch({ type: "resize", id: d.id, ...next });
    } else if (d.mode === "rotate" && d.orig && d.id) {
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (!wp) return;
      const cx = wp.x + wp.node.w / 2;
      const cy = wp.y + wp.node.h / 2;
      const b = toWorld(e.clientX, e.clientY);
      const ang = (Math.atan2(b.y - cy, b.x - cx) * 180) / Math.PI + 90;
      engine.dispatch({ type: "patch", id: d.id, patch: { rotation: Math.round(ang) } });
    }
  };

  const onUp = (e: React.MouseEvent) => {
    if (pencil.current) {
      const pts = pencil.current;
      pencil.current = null;
      if (pts.length >= 2) engine.dispatch({ type: "addPath", points: pts, closed: false });
      setDraft([]);
      return;
    }
    const d = drag.current;
    drag.current = null;
    setBand(null);
    if (!d) return;
    if (d.mode === "move" || d.mode === "resize") engine.dispatch({ type: "end" });
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
      engine.dispatch({
        type: "add",
        kind: k,
        x,
        y,
        w,
        h,
        extra:
          snap.tool === "section"
            ? { name: "Section", fill: "#00000000", overflow: "visible" }
            : undefined,
      });
    }
    if (d.mode === "marquee") {
      const a = toWorld(d.sx, d.sy);
      const b = toWorld(e.clientX, e.clientY);
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const x1 = Math.max(a.x, b.x);
      const y1 = Math.max(a.y, b.y);
      const ids: string[] = [];
      const visit = (n: XNode, px: number, py: number) => {
        const x = px + n.x;
        const y = py + n.y;
        if (n !== snap.pages[snap.page].root) {
          if (x >= x0 && y >= y0 && x + n.w <= x1 && y + n.h <= y1) ids.push(n.id);
        }
        for (const c of n.children) visit(c, x, y);
      };
      visit(snap.pages[snap.page].root, 0, 0);
      engine.dispatch({ type: "select", ids });
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

  const onDbl = (e: React.MouseEvent) => {
    const wpt = toWorld(e.clientX, e.clientY);
    const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y);
    if (hit?.kind === "text") setEdit({ id: hit.id, text: hit.text });
  };

  const placeFiles = (files: FileList | File[], at?: { x: number; y: number }) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    let ox = at?.x ?? 80;
    let oy = at?.y ?? 80;
    list.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result);
        const im = new Image();
        im.onload = () => {
          const w = im.naturalWidth;
          const h = im.naturalHeight;
          const max = 480;
          const s = Math.min(1, max / Math.max(w, h));
          engine.dispatch({
            type: "add",
            kind: "rect",
            x: ox,
            y: oy,
            w: Math.max(8, w * s),
            h: Math.max(8, h * s),
            extra: { imageSrc: src, name: file.name.replace(/\.[^.]+$/, ""), fill: "#00000000" },
          });
          ox += 24;
          oy += 24;
        };
        im.src = src;
      };
      reader.readAsDataURL(file);
    });
  };

  const cursor =
    snap.tool === "hand" || space.current
      ? "grab"
      : CREATE.includes(snap.tool) || snap.tool === "pen" || snap.tool === "pencil" || snap.tool === "brush"
        ? "crosshair"
        : "default";

  const editBox = (() => {
    if (!edit) return null;
    const wp = worldPos(snap.pages[snap.page].root, edit.id);
    if (!wp) return null;
    return {
      left: snap.panX + wp.x * snap.zoom,
      top: snap.panY + wp.y * snap.zoom,
      width: wp.node.w * snap.zoom,
      height: wp.node.h * snap.zoom,
      fontSize: wp.node.fontSize * snap.zoom,
      fontWeight: wp.node.fontWeight,
      color: wp.node.fill,
      fontFamily: wp.node.fontFamily,
    };
  })();

  return (
    <div
      className="canvas-wrap"
      ref={wrap}
      style={{ cursor }}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
      onDoubleClick={onDbl}
      onWheel={onWheel}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const wpt = toWorld(e.clientX, e.clientY);
        if (e.dataTransfer.files?.length) placeFiles(e.dataTransfer.files, wpt);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const wpt = toWorld(e.clientX, e.clientY);
        const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y);
        if (hit && !snap.selection.includes(hit.id)) {
          engine.dispatch({ type: "select", ids: [hit.id] });
        }
        if (!hit) engine.dispatch({ type: "select", ids: [] });
        setMenu({ x: e.clientX, y: e.clientY, wx: wpt.x, wy: wpt.y });
      }}
    >
      <canvas ref={ref} />
      {edit && editBox && (
        <textarea
          className="text-edit"
          style={editBox}
          value={edit.text}
          autoFocus
          onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          onBlur={() => {
            engine.dispatch({ type: "patch", id: edit.id, patch: { text: edit.text } });
            setEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/*"
        hidden
        onChange={(e) => {
          if (e.target.files) placeFiles(e.target.files, pendingImage.current ?? undefined);
          e.target.value = "";
        }}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={canvasMenu(
            snap.selection.length,
            isGroupNode(
              snap.selection[0]
                ? worldPos(snap.pages[snap.page].root, snap.selection[0])?.node
                : undefined,
            ),
            !!snap.selection[0] &&
              !!worldPos(snap.pages[snap.page].root, snap.selection[0])?.node.imageSrc,
          )}
          onRun={(id) => runMenu(engine, id, { x: menu.wx, y: menu.wy })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function fillPaint(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): string | CanvasGradient {
  const a = n.fill;
  const b = n.fillB || "#ffffff";
  if (n.fillType === "linear") {
    const g = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    return g;
  }
  if (n.fillType === "radial" || n.fillType === "diamond") {
    const g = ctx.createRadialGradient(
      sx + sw / 2,
      sy + sh / 2,
      0,
      sx + sw / 2,
      sy + sh / 2,
      Math.max(sw, sh) / 2,
    );
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    return g;
  }
  if (n.fillType === "angular" && typeof ctx.createConicGradient === "function") {
    const g = ctx.createConicGradient(0, sx + sw / 2, sy + sh / 2);
    g.addColorStop(0, a);
    g.addColorStop(0.5, b);
    g.addColorStop(1, a);
    return g;
  }
  return a;
}

function handles(sx: number, sy: number, sw: number, sh: number): [number, number][] {
  return [
    [sx, sy],
    [sx + sw / 2, sy],
    [sx + sw, sy],
    [sx + sw, sy + sh / 2],
    [sx + sw, sy + sh],
    [sx + sw / 2, sy + sh],
    [sx, sy + sh],
    [sx, sy + sh / 2],
  ];
}

function resizeFrom(
  o: { x: number; y: number; w: number; h: number },
  corner: number,
  bx: number,
  by: number,
) {
  let { x, y, w, h } = o;
  const right = o.x + o.w;
  const bottom = o.y + o.h;
  // 0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w
  if (corner === 0 || corner === 1 || corner === 2) {
    y = by;
    h = bottom - by;
  }
  if (corner === 4 || corner === 5 || corner === 6) {
    h = by - o.y;
  }
  if (corner === 0 || corner === 6 || corner === 7) {
    x = bx;
    w = right - bx;
  }
  if (corner === 2 || corner === 3 || corner === 4) {
    w = bx - o.x;
  }
  if (w < 1) {
    x += w - 1;
    w = 1;
  }
  if (h < 1) {
    y += h - 1;
    h = 1;
  }
  return { x, y, w, h };
}

function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  n: number,
  ratio = 0.4,
) {
  const pts = Math.max(3, Math.round(n));
  const inner = Math.max(0.05, Math.min(0.95, ratio));
  ctx.beginPath();
  for (let i = 0; i < pts * 2; i++) {
    const a = (i * Math.PI) / pts - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * inner;
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
  const pts = Math.max(3, Math.round(n));
  for (let i = 0; i < pts; i++) {
    const a = (i * 2 * Math.PI) / pts - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function walkInteractions(
  n: XNode,
  px: number,
  py: number,
  fn: (n: XNode, x: number, y: number, dest: string) => void,
) {
  const x = px + n.x;
  const y = py + n.y;
  for (const ix of n.interactions ?? []) {
    if (ix.action === "navigate" && ix.destination) fn(n, x, y, ix.destination);
  }
  for (const c of n.children) walkInteractions(c, x, y, fn);
}

function paintBoolean(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  px: number,
  py: number,
  snap: Snapshot,
) {
  const z = snap.zoom;
  const w = Math.max(1, Math.ceil(n.w * z));
  const h = Math.max(1, Math.ceil(n.h * z));
  const oc = document.createElement("canvas");
  oc.width = w;
  oc.height = h;
  const o = oc.getContext("2d");
  if (!o) return;
  const kids = n.children.filter((c) => c.visible);
  const draw = (c: XNode, op: GlobalCompositeOperation) => {
    o.globalCompositeOperation = op;
    o.beginPath();
    const sx = c.x * z;
    const sy = c.y * z;
    const sw = c.w * z;
    const sh = c.h * z;
    if (c.kind === "ellipse") {
      o.ellipse(sx + sw / 2, sy + sh / 2, Math.abs(sw / 2), Math.abs(sh / 2), 0, 0, Math.PI * 2);
    } else if (c.kind === "star") {
      starPath(o, sx + sw / 2, sy + sh / 2, Math.min(sw, sh) / 2, c.count || 5, c.starRatio || 0.4);
    } else if (c.kind === "poly") {
      polyPath(o, sx + sw / 2, sy + sh / 2, Math.min(sw, sh) / 2, c.count || 3);
    } else if (c.kind === "vector" && c.path.length) {
      c.path.forEach((pt, i) => {
        if (i === 0) o.moveTo(pt.x * z, pt.y * z);
        else o.lineTo(pt.x * z, pt.y * z);
      });
      if (c.closed) o.closePath();
    } else {
      o.rect(sx, sy, sw, sh);
    }
    o.fillStyle = n.fillVisible && n.fill ? n.fill : c.fill;
    o.fill();
  };
  if (!kids.length) return;
  draw(kids[0], "source-over");
  for (let i = 1; i < kids.length; i++) {
    const op = n.booleanOp;
    if (op === "subtract") draw(kids[i], "destination-out");
    else if (op === "intersect") draw(kids[i], "destination-in");
    else if (op === "exclude") draw(kids[i], "xor");
    else draw(kids[i], "source-over");
  }
  ctx.drawImage(oc, snap.panX + px * z, snap.panY + py * z);
}
