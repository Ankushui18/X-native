import { useCallback, useEffect, useRef, useState } from "react";
import type { Engine, Interaction, NodeKind, PathPoint, Snapshot, Tool, XNode } from "../engine/types";
import { deepestFrame, find, findParent, hitTest, worldToLocal, worldPos } from "../engine/memory";
import { erasePath, shapePoly, simplifyPath, smoothPath } from "../engine/geometry";
import {
  snapCandidates,
  snapMove,
  snapResize,
  type Box,
  type GapBadge,
  type Guide,
} from "../engine/snapping";
import { fillStyle, paintDropShadows, paintExtraStrokes, paintFill, paintImageFill, paintInnerShadows } from "../engine/paint";
import { Rulers } from "./Rulers";
import { Guides } from "./Guides";
import { Comments } from "./Comments";
import { useTheme } from "./theme";
import { cssRgba, isNone, parseHex, takeEyedrop, toHex } from "./color";
import { ContextMenu, canvasMenu, isGroupNode, runMenu } from "./ContextMenu";
import { importSvg, type ImportedNode } from "../engine/svgImport";
import { importSketch } from "../engine/sketchImport";
import { importFig } from "../engine/figImport";
import { toast } from "./toast";

/** Snap radius in screen pixels; divided by zoom to get world tolerance. */
const SNAP_PX = 6;
/** Eraser brush radius, in screen pixels. */
const ERASER_PX = 10;
/** RDP tolerance for freehand strokes, in screen pixels. */
const PENCIL_TOLERANCE_PX = 2;

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

/** Per-node state captured at the start of a group transform. */
interface MultiOrigin {
  id: string;
  /** World-space box before the transform. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Local (parent-relative) origin, which is what `resize` actually writes. */
  lx: number;
  ly: number;
}

type Drag =
  | {
      mode:
        | "pan"
        | "move"
        | "create"
        | "resize"
        | "marquee"
        | "rotate"
        | "vec"
        | "grad"
        | "multiResize"
        | "multiRotate";
      point?: number;
      handle?: "in" | "out" | "g" | "h";
      sx: number;
      sy: number;
      wx: number;
      wy: number;
      orig?: { x: number; y: number; w: number; h: number; rotation: number };
      corner?: number;
      id?: string;
      duped?: boolean;
      axis?: "x" | "y" | null;
      /** Combined selection bounds at drag start (group transforms). */
      bounds?: { x: number; y: number; w: number; h: number };
      origs?: MultiOrigin[];
    };

/** Snapshot every selected node's world + local box before a group transform. */
function multiOrigins(root: XNode, ids: string[]): MultiOrigin[] {
  const out: MultiOrigin[] = [];
  for (const id of ids) {
    const wp = worldPos(root, id);
    if (!wp || wp.node.locked) continue;
    out.push({
      id,
      x: wp.x,
      y: wp.y,
      w: wp.node.w,
      h: wp.node.h,
      rotation: wp.node.rotation,
      lx: wp.node.x,
      ly: wp.node.y,
    });
  }
  return out;
}

export function Canvas({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  const imgs = useRef(new Map<string, HTMLImageElement>());
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [draftComment, setDraftComment] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingImage = useRef<{ x: number; y: number } | null>(null);
  const [vecEdit, setVecEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState<PathPoint[]>([]);
  const [ghost, setGhost] = useState<PathPoint | null>(null);
  const [hoverId, setHoverId] = useState("");
  const [transition, setTransition] = useState<"dissolve" | "smart" | null>(null);
  const pencil = useRef<PathPoint[] | null>(null);
  const penDrag = useRef<{ i: number; x: number; y: number } | null>(null);
  const vecPt = useRef(-1);
  const hoverIx = useRef("");
  /** Cursor implied by whatever selection chrome is under the pointer. */
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  /** Viewport size, tracked so the ruler overlay can size its own canvas. */
  const [box, setBox] = useState({ w: 0, h: 0 });
  /** Live smart-guide overlay, produced by the snapping pass during a drag. */
  const [guides, setGuides] = useState<Guide[]>([]);
  const [gapBadges, setGapBadges] = useState<GapBadge[]>([]);
  /** Static snap targets, captured once at drag start so they never shift mid-drag. */
  const snapTargets = useRef<Box[]>([]);
  const { theme } = useTheme();
  const runInteraction = useCallback(
    (ix: Interaction) => {
      const run = () => {
        if (ix.action === "back") engine.dispatch({ type: "presentBack" });
        else if (ix.action === "navigate" && ix.destination) engine.dispatch({ type: "presentGo", id: ix.destination });
        else if (ix.action === "openUrl" && ix.destination)
          window.open(ix.destination, "_blank", "noopener,noreferrer");
      };
      if (ix.animation === "instant" || ix.action === "openUrl") {
        run();
        return;
      }
      setTransition(ix.animation);
      window.setTimeout(() => {
        run();
        setTransition(null);
      }, ix.animation === "smart" ? 260 : 180);
    },
    [engine],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        space.current = e.type === "keydown";
        if (e.type === "keydown" && (e.target as HTMLElement).tagName !== "INPUT" && (e.target as HTMLElement).tagName !== "TEXTAREA")
          e.preventDefault();
      }
      if (e.type === "keydown" && e.key === "Escape" && draft.length) {
        e.stopImmediatePropagation();
        setDraft([]);
        return;
      }
      if (e.type === "keydown" && e.key === "Enter" && draft.length >= 2) {
        e.stopImmediatePropagation();
        engine.dispatch({ type: "addPath", points: draft, closed: true });
        setDraft([]);
        return;
      }
      if (e.type === "keydown" && e.key === "Backspace" && draft.length && !edit) {
        e.stopImmediatePropagation();
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
        return;
      }
      if (e.type === "keydown" && e.key === "Tab" && !edit && !draft.length) {
        const root = snap.pages[snap.page].root;
        const id = snap.selection[0];
        if (id) {
          const par = findParent(root, id) ?? root;
          const kids = par.children.filter((c) => c.visible && !c.locked);
          const i = kids.findIndex((c) => c.id === id);
          if (i >= 0 && kids.length) {
            const next = e.shiftKey ? kids[(i - 1 + kids.length) % kids.length] : kids[(i + 1) % kids.length];
            engine.dispatch({ type: "select", ids: [next.id] });
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
        }
      }
      if (e.type === "keydown" && e.key === "Enter" && !edit) {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
        const root = snap.pages[snap.page].root;
        const id = snap.selection[0];
        const n = id ? worldPos(root, id)?.node : null;
        if (e.shiftKey && id) {
          const par = findParent(root, id);
          if (par && par !== root) engine.dispatch({ type: "select", ids: [par.id] });
          e.stopImmediatePropagation();
          return;
        }
        if (n?.kind === "text") setEdit({ id: n.id, text: n.text });
        else if (
          n &&
          (n.kind === "frame" || n.kind === "group" || (n.kind === "boolean" && n.children.length > 0)) &&
          n.children.length &&
          !vecEdit
        ) {
          const child = n.children.find((c) => c.visible && !c.locked) ?? n.children[0];
          engine.dispatch({ type: "select", ids: [child.id] });
          e.stopImmediatePropagation();
        } else if (
          n &&
          !vecEdit &&
          (n.kind === "vector" ||
            n.kind === "boolean" ||
            n.kind === "rect" ||
            n.kind === "ellipse" ||
            n.kind === "poly" ||
            n.kind === "star" ||
            n.kind === "line" ||
            n.kind === "arrow")
        ) {
          if (n.kind !== "vector") engine.dispatch({ type: "flatten" });
          setVecEdit(n.id);
          e.stopImmediatePropagation();
        } else if (vecEdit) {
          setVecEdit(null);
        }
      }
      if (e.type === "keydown" && e.key === "Escape" && vecEdit) {
        setVecEdit(null);
        e.stopImmediatePropagation();
      }
      if (e.type === "keydown" && (e.key === "Delete" || e.key === "Backspace") && vecEdit && !edit) {
        const n = worldPos(snap.pages[snap.page].root, vecEdit)?.node;
        if (n?.path.length) {
          const i = vecPt.current >= 0 ? vecPt.current : n.path.length - 1;
          const path = n.path.filter((_, j) => j !== i);
          engine.dispatch({ type: "patchPath", id: n.id, path, closed: n.closed });
          vecPt.current = Math.min(i, path.length - 1);
          e.stopImmediatePropagation();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [snap, edit, draft, engine, vecEdit]);

  useEffect(() => {
    if (vecEdit && !snap.selection.includes(vecEdit)) setVecEdit(null);
  }, [snap.selection, vecEdit]);

  useEffect(() => {
    if (!snap.presentFrame) {
      hoverIx.current = "";
      return;
    }
    const n = find(snap.pages[snap.page].root, snap.presentFrame);
    const ix = (n?.interactions ?? []).find((i) => i.trigger === "afterDelay");
    if (!ix) return;
    const t = window.setTimeout(() => runInteraction(ix), Math.max(0, ix.delay ?? 800));
    return () => window.clearTimeout(t);
  }, [snap.presentFrame, snap.page, snap.pages, runInteraction]);

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
      // Viewport culling. Only childless nodes are considered: a container may
      // paint children outside its own bounds when overflow is visible, and
      // children are positioned relative to the parent, so skipping a parent
      // would wrongly skip its subtree. Bounds are padded for stroke width and
      // for any shadow offset/blur, and rotation is covered by using the
      // diagonal, so nothing that could touch a pixel on screen is dropped.
      if (!n.children.length) {
        let pad = (n.strokeWidth ?? 0) + 2;
        for (const e of n.effects ?? []) {
          if (!e.visible) continue;
          pad = Math.max(pad, Math.abs(e.x ?? 0) + Math.abs(e.y ?? 0) + Math.abs(e.blur ?? 0) + Math.abs(e.spread ?? 0));
        }
        const half = n.rotation ? Math.hypot(n.w, n.h) / 2 - Math.min(n.w, n.h) / 2 : 0;
        const m = (pad + half) * z + 4;
        const sx0 = snap.panX + x * z;
        const sy0 = snap.panY + y * z;
        if (sx0 + n.w * z + m < 0 || sy0 + n.h * z + m < 0 || sx0 - m > w || sy0 - m > h) return;
      }
      ctx.save();
      if (n.rotation || n.flipH || n.flipV) {
        const cx = snap.panX + (x + n.w / 2) * z;
        const cy = snap.panY + (y + n.h / 2) * z;
        ctx.translate(cx, cy);
        if (n.rotation) ctx.rotate((n.rotation * Math.PI) / 180);
        if (n.flipH || n.flipV) ctx.scale(n.flipH ? -1 : 1, n.flipV ? -1 : 1);
        ctx.translate(-cx, -cy);
      }
      ctx.globalAlpha *= n.opacity;
      ctx.globalCompositeOperation = canvasBlend(n.blendMode);
      const layerBlur = (n.effects ?? []).find((e) => e.kind === "layer-blur" && e.visible);
      if (layerBlur) ctx.filter = `blur(${Math.max(0, layerBlur.blur) * z}px)`;
      const sx = snap.panX + x * z;
      const sy = snap.panY + y * z;
      const sw = n.w * z;
      const sh = n.h * z;
      const radii = n.cornerIndependent
        ? n.cornerRadii.map((r) => Math.max(0, r * z))
        : Math.max(0, (n.cornerRadii[0] ?? 0) * z);
      const round = () => {
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          const rr = Array.isArray(radii) ? [radii[0], radii[1], radii[3], radii[2]] : radii;
          ctx.roundRect(sx, sy, sw, sh, rr);
        } else ctx.rect(sx, sy, sw, sh);
      };
      if (n.kind === "boolean" && n.booleanOp && n.children.length) {
        const dropB = (n.effects ?? []).find((e) => e.kind === "drop-shadow" && e.visible);
        if (dropB) {
          ctx.shadowColor = cssRgba(dropB.color);
          ctx.shadowBlur = Math.max(0, dropB.blur) * z;
          ctx.shadowOffsetX = dropB.x * z;
          ctx.shadowOffsetY = dropB.y * z;
        }
        paintBoolean(ctx, n, x, y, snap);
        if (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)) {
          ctx.save();
          ctx.strokeStyle = cssRgba(n.strokePaint);
          ctx.globalAlpha *= n.strokeOpacity ?? 1;
          ctx.lineWidth = Math.max(0.5, n.strokeWidth * z);
          ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
          ctx.setLineDash(n.strokeDash > 0 ? [n.strokeDash * z, (n.strokeGap || n.strokeDash) * z] : []);
          tracePath(ctx, n.path.length ? n.path : shapePoly(n), snap.panX + x * z, snap.panY + y * z, z, true);
          ctx.stroke();
          ctx.restore();
        }
        paintExtraStrokes(ctx, n, z, () =>
          tracePath(ctx, n.path.length ? n.path : shapePoly(n), snap.panX + x * z, snap.panY + y * z, z, true),
        );
        ctx.restore();
        return;
      }
      // Named so extra stroke layers can re-trace the same outline; a stroke
      // pass changes lineWidth and may clip, so the path has to be rebuilt.
      const traceShape = () => {
        if (n.kind === "text") {
          ctx.beginPath();
        } else if ((n.kind === "vector" || n.kind === "boolean") && n.path.length) {
          tracePath(ctx, n.path, snap.panX + x * z, snap.panY + y * z, z, n.closed);
        } else if (n.kind === "ellipse") {
          ctx.beginPath();
          ctx.ellipse(sx + sw / 2, sy + sh / 2, Math.abs(sw / 2), Math.abs(sh / 2), 0, 0, Math.PI * 2);
        } else if (n.kind === "line" || n.kind === "arrow") {
          ctx.beginPath();
          ctx.moveTo(sx, sy + sh / 2);
          ctx.lineTo(sx + sw, sy + sh / 2);
        } else if (n.kind === "star") {
          starPath(ctx, sx + sw / 2, sy + sh / 2, Math.abs(sw / 2), Math.abs(sh / 2), n.count || 5, n.starRatio || 0.4);
        } else if (n.kind === "poly") {
          polyPath(ctx, sx + sw / 2, sy + sh / 2, Math.abs(sw / 2), Math.abs(sh / 2), n.count || 3);
        } else {
          round();
        }
      };
      traceShape();
      const bgBlur = (n.effects ?? []).find(
        (e) => (e.kind === "background-blur" || e.kind === "glass") && e.visible,
      );
      if (bgBlur && sw > 1 && sh > 1) {
        try {
          ctx.save();
          ctx.clip();
          ctx.filter = `blur(${Math.max(0, bgBlur.blur) * z}px)`;
          ctx.drawImage(c, sx, sy, sw, sh, sx, sy, sw, sh);
          ctx.restore();
        } catch {
          /* tainted canvas */
        }
      }
      const canShadow =
        n.kind !== "text" &&
        (!!n.imageSrc ||
          (n.fillVisible !== false && !!n.fill && !isNone(n.fill) && n.kind !== "line" && n.kind !== "arrow") ||
          (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)));
      if (canShadow) paintDropShadows(ctx, n, z);
      if (n.fillType === "image" || (n.imageSrc && isNone(n.fill))) {
        let im = n.imageSrc ? imgs.current.get(n.imageSrc) : undefined;
        if (n.imageSrc && !im) {
          im = new Image();
          im.src = n.imageSrc;
          im.onload = () => engine.dispatch({ type: "select", ids: snap.selection });
          imgs.current.set(n.imageSrc, im);
        }
        if (im?.complete && im.naturalWidth) {
          ctx.save();
          ctx.globalAlpha *= n.fillOpacity ?? 1;
          ctx.globalCompositeOperation = canvasBlend(n.fillBlend);
          paintImageFill(ctx, n, im, sx, sy, sw, sh);
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
        ctx.globalCompositeOperation = canvasBlend(n.fillBlend);
        paintFill(ctx, n, sx, sy, sw, sh);
        ctx.restore();
      }
      const noise = (n.effects ?? []).find((e) => e.kind === "noise" && e.visible);
      if (noise) paintNoise(ctx, sx, sy, sw, sh, noise.blur);
      const glass = (n.effects ?? []).find((e) => e.kind === "glass" && e.visible);
      if (glass) {
        ctx.save();
        ctx.clip();
        ctx.globalAlpha *= 0.28;
        ctx.fillStyle = glass.color || "#ffffff";
        ctx.fill();
        ctx.restore();
      }
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      paintInnerShadows(ctx, n, z);
      if (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)) {
        ctx.save();
        ctx.globalAlpha *= n.strokeOpacity ?? 1;
        ctx.strokeStyle = cssRgba(n.strokePaint);
        const lw = Math.max(0.5, n.strokeWidth * z);
        ctx.lineCap = n.strokeCap === "round" ? "round" : n.strokeCap === "square" ? "square" : "butt";
        ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
        if (n.strokeDash > 0) {
          const dash = n.strokeDash * z;
          const gap = (n.strokeGap || n.strokeDash) * z;
          ctx.setLineDash([dash, gap]);
        } else {
          ctx.setLineDash([]);
        }
        if (n.strokeAlign === "inside") {
          ctx.save();
          ctx.clip();
          ctx.lineWidth = lw * 2;
          ctx.stroke();
          ctx.restore();
        } else if (n.strokeAlign === "outside") {
          ctx.lineWidth = lw * 2;
          ctx.stroke();
          if (n.fillVisible && !isNone(n.fill) && n.kind !== "line" && n.kind !== "arrow") {
            ctx.globalCompositeOperation = "source-over";
            paintFill(ctx, n, sx, sy, sw, sh);
          }
        } else {
          ctx.lineWidth = lw;
          ctx.stroke();
        }
        const arrowCap =
          n.kind === "arrow" ||
          ((n.kind === "line" || n.kind === "vector") && !n.closed && n.strokeCap === "arrow");
        if (arrowCap) {
          ctx.setLineDash([]);
          const ah = Math.max(6, n.strokeWidth * 3 * z);
          let ex = sx + sw;
          let ey = sy + sh / 2;
          let ux = 1;
          let uy = 0;
          if (n.kind === "vector" && n.path.length > 1) {
            const last = n.path[n.path.length - 1];
            const prev = n.path[n.path.length - 2];
            const dx = (last.x - prev.x) * z;
            const dy = (last.y - prev.y) * z;
            const len = Math.hypot(dx, dy) || 1;
            ex = snap.panX + (x + last.x) * z;
            ey = snap.panY + (y + last.y) * z;
            ux = dx / len;
            uy = dy / len;
          }
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ux * ah - uy * ah * 0.55, ey - uy * ah + ux * ah * 0.55);
          ctx.lineTo(ex - ux * ah + uy * ah * 0.55, ey - uy * ah - ux * ah * 0.55);
          ctx.closePath();
          ctx.fillStyle = cssRgba(n.strokePaint);
          ctx.fill();
        }
        ctx.restore();
      }
      paintExtraStrokes(ctx, n, z, traceShape);
      if (n.kind === "text" && edit?.id !== n.id) {
        paintText(ctx, n, sx, sy, sw, sh, z);
      }
      if (n.kind === "frame" && n.overflow !== "visible") {
        round();
        ctx.clip();
      }
      let maskOn = 0;
      for (const ch of n.children) {
        if (ch.isMask && ch.visible) {
          ctx.save();
          const mx = snap.panX + (x + ch.x) * z;
          const my = snap.panY + (y + ch.y) * z;
          const mw = ch.w * z;
          const mh = ch.h * z;
          const mcx = mx + mw / 2;
          const mcy = my + mh / 2;
          ctx.save();
          if (ch.rotation || ch.flipH || ch.flipV) {
            ctx.translate(mcx, mcy);
            if (ch.rotation) ctx.rotate((ch.rotation * Math.PI) / 180);
            if (ch.flipH || ch.flipV) ctx.scale(ch.flipH ? -1 : 1, ch.flipV ? -1 : 1);
            ctx.translate(-mcx, -mcy);
          }
          ctx.beginPath();
          if (ch.kind === "ellipse") {
            ctx.ellipse(mcx, mcy, Math.abs(mw / 2), Math.abs(mh / 2), 0, 0, Math.PI * 2);
          } else if (ch.path.length) {
            tracePath(ctx, ch.path, mx, my, z, ch.closed);
          } else if (typeof ctx.roundRect === "function") {
            const rr = ch.cornerIndependent
              ? [ch.cornerRadii[0] * z, ch.cornerRadii[1] * z, ch.cornerRadii[3] * z, ch.cornerRadii[2] * z]
              : ch.cornerRadii[0] * z;
            ctx.roundRect(mx, my, mw, mh, rr);
          } else {
            ctx.rect(mx, my, mw, mh);
          }
          ctx.restore();
          ctx.clip();
          maskOn += 1;
          continue;
        }
        paint(ch, x, y);
      }
      while (maskOn--) ctx.restore();
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
    if (!snap.presentFrame) {
      for (const ch of root.children) label(ch, 0, 0);
    }

    if (draft.length) {
      ctx.strokeStyle = "#0d99ff";
      ctx.lineWidth = 1.5;
      const preview = ghost ? [...draft, ghost] : draft;
      tracePath(ctx, preview, snap.panX, snap.panY, z, false);
      ctx.stroke();
      for (const p of draft) {
        const px = snap.panX + p.x * z;
        const py = snap.panY + p.y * z;
        if ((p.ox && p.ox !== 0) || (p.oy && p.oy !== 0) || (p.ix && p.ix !== 0) || (p.iy && p.iy !== 0)) {
          ctx.strokeStyle = "#0d99ff";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + (p.ix || 0) * z, py + (p.iy || 0) * z);
          ctx.lineTo(px + (p.ox || 0) * z, py + (p.oy || 0) * z);
          ctx.stroke();
          for (const [hx, hy] of [
            [px + (p.ix || 0) * z, py + (p.iy || 0) * z],
            [px + (p.ox || 0) * z, py + (p.oy || 0) * z],
          ] as const) {
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(hx, hy, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#0d99ff";
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
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

    if (hoverId && !snap.selection.includes(hoverId)) {
      const hp = worldPos(root, hoverId);
      if (hp) {
        ctx.save();
        const hx = snap.panX + hp.x * z;
        const hy = snap.panY + hp.y * z;
        const hw = hp.node.w * z;
        const hh = hp.node.h * z;
        if (hp.node.rotation) {
          ctx.translate(hx + hw / 2, hy + hh / 2);
          ctx.rotate((hp.node.rotation * Math.PI) / 180);
          ctx.translate(-(hx + hw / 2), -(hy + hh / 2));
        }
        ctx.strokeStyle = "#0d99ff";
        ctx.lineWidth = 1;
        ctx.strokeRect(hx + 0.5, hy + 0.5, hw, hh);
        ctx.restore();
      }
    }

    const multiSel = snap.selection.length > 1;
    for (const id of snap.selection) {
      if (edit?.id === id) continue;
      const wp = worldPos(root, id);
      if (!wp) continue;
      const sx = snap.panX + wp.x * z;
      const sy = snap.panY + wp.y * z;
      const sw = wp.node.w * z;
      const sh = wp.node.h * z;
      const accent = wp.node.isComponent || wp.node.componentId ? "#7b61ff" : "#0d99ff";
      ctx.save();
      if (wp.node.rotation || wp.node.flipH || wp.node.flipV) {
        ctx.translate(sx + sw / 2, sy + sh / 2);
        if (wp.node.rotation) ctx.rotate((wp.node.rotation * Math.PI) / 180);
        if (wp.node.flipH || wp.node.flipV) ctx.scale(wp.node.flipH ? -1 : 1, wp.node.flipV ? -1 : 1);
        ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
      // With several layers picked, each member only gets a thin outline; the
      // handles, rotate stem and size badge belong to the combined box below.
      if (multiSel) {
        ctx.restore();
        continue;
      }
      const hs = handles(sx, sy, sw, sh);
      for (const [hx, hy] of hs) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = accent;
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
      ctx.fillStyle = accent;
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
      const ft = wp.node.fillType;
      if (ft === "linear" || ft === "radial" || ft === "angular" || ft === "diamond") {
        const ax = sx + (wp.node.fillGX ?? 0.5) * sw;
        const ay = sy + (wp.node.fillGY ?? 0) * sh;
        const bx = sx + (wp.node.fillHX ?? 0.5) * sw;
        const by = sy + (wp.node.fillHY ?? 1) * sh;
        ctx.strokeStyle = "#0d99ff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.fillStyle = wp.node.fill;
        ctx.beginPath();
        ctx.arc(ax, ay, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = wp.node.fillB || "#ffffff";
        ctx.beginPath();
        ctx.arc(bx, by, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Combined bounding box for a multi-selection: one set of handles, one
    // rotate stem, one size badge — exactly like Figma.
    if (multiSel) {
      const bb = selectionBounds(root, snap.selection);
      if (bb) {
        const sx = snap.panX + bb.x * z;
        const sy = snap.panY + bb.y * z;
        const sw = bb.w * z;
        const sh = bb.h * z;
        ctx.save();
        ctx.strokeStyle = "#0d99ff";
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
        for (const [hx, hy] of handles(sx, sy, sw, sh)) {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#0d99ff";
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
        const dim = `${Math.round(bb.w)} × ${Math.round(bb.h)}`;
        ctx.font = "500 11px Inter, system-ui";
        const bw = ctx.measureText(dim).width + 16;
        const bx = sx + sw / 2 - bw / 2;
        const by = sy + sh + 8;
        ctx.fillStyle = "#0d99ff";
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, 20, 4);
          ctx.fill();
        } else ctx.fillRect(bx, by, bw, 20);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(dim, bx + bw / 2, by + 10);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.restore();
      }
    }

    // Smart guides + equal-spacing badges, drawn on top of the selection chrome.
    if (guides.length) {
      ctx.save();
      ctx.strokeStyle = "#ff3b6b";
      ctx.lineWidth = 1;
      for (const g of guides) {
        ctx.setLineDash(g.center ? [4, 3] : []);
        ctx.beginPath();
        if (g.axis === "x") {
          const gx = Math.round(snap.panX + g.at * z) + 0.5;
          ctx.moveTo(gx, snap.panY + g.from * z);
          ctx.lineTo(gx, snap.panY + g.to * z);
        } else {
          const gy = Math.round(snap.panY + g.at * z) + 0.5;
          ctx.moveTo(snap.panX + g.from * z, gy);
          ctx.lineTo(snap.panX + g.to * z, gy);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    if (gapBadges.length) {
      ctx.save();
      ctx.font = "500 10px Inter, system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const g of gapBadges) {
        const cx = g.axis === "x" ? snap.panX + g.at * z : snap.panX + g.cross * z;
        const cy = g.axis === "x" ? snap.panY + g.cross * z : snap.panY + g.at * z;
        const label = `${Math.round(g.size)}`;
        const bw = ctx.measureText(label).width + 10;
        ctx.fillStyle = "#ff3b6b";
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(cx - bw / 2, cy - 8, bw, 16, 3);
          ctx.fill();
        } else ctx.fillRect(cx - bw / 2, cy - 8, bw, 16);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, cx, cy);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.restore();
    }

    if (vecEdit) {
      const wp = worldPos(root, vecEdit);
      if (wp) {
        const pts = wp.node.path.length ? wp.node.path : shapePoly(wp.node);
        const vsx = snap.panX + wp.x * z;
        const vsy = snap.panY + wp.y * z;
        const vsw = wp.node.w * z;
        const vsh = wp.node.h * z;
        ctx.save();
        if (wp.node.rotation || wp.node.flipH || wp.node.flipV) {
          ctx.translate(vsx + vsw / 2, vsy + vsh / 2);
          if (wp.node.rotation) ctx.rotate((wp.node.rotation * Math.PI) / 180);
          if (wp.node.flipH || wp.node.flipV) ctx.scale(wp.node.flipH ? -1 : 1, wp.node.flipV ? -1 : 1);
          ctx.translate(-(vsx + vsw / 2), -(vsy + vsh / 2));
        }
        ctx.strokeStyle = "#0d99ff";
        ctx.lineWidth = 1;
        for (const p of pts) {
          const px = snap.panX + (wp.x + p.x) * z;
          const py = snap.panY + (wp.y + p.y) * z;
          if ((p.ox && p.ox !== 0) || (p.oy && p.oy !== 0) || (p.ix && p.ix !== 0) || (p.iy && p.iy !== 0)) {
            ctx.beginPath();
            ctx.moveTo(px + (p.ix || 0) * z, py + (p.iy || 0) * z);
            ctx.lineTo(px + (p.ox || 0) * z, py + (p.oy || 0) * z);
            ctx.stroke();
            for (const [hx, hy] of [
              [px + (p.ix || 0) * z, py + (p.iy || 0) * z],
              [px + (p.ox || 0) * z, py + (p.oy || 0) * z],
            ] as const) {
              ctx.fillStyle = "#fff";
              ctx.beginPath();
              ctx.arc(hx, hy, 3, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
          }
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.rect(px - 3.5, py - 3.5, 7, 7);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    if (band) {
      ctx.fillStyle = "rgba(13,153,255,0.12)";
      ctx.strokeStyle = "#0d99ff";
      ctx.lineWidth = 1;
      ctx.fillRect(band.x, band.y, band.w, band.h);
      ctx.strokeRect(band.x + 0.5, band.y + 0.5, band.w, band.h);
    }
  }, [snap, band, edit, engine, theme, draft, vecEdit, hoverId, ghost, guides, gapBadges]);

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return {
      x: (cx - r.left - snap.panX) / snap.zoom,
      y: (cy - r.top - snap.panY) / snap.zoom,
    };
  };

  /**
   * Figma-style eraser: on a vector/freehand path it removes the anchors under
   * the brush and splits the remainder into separate paths; on any other layer
   * it falls back to deleting the layer (Figma does the same for non-vectors).
   */
  const eraseAt = useCallback(
    (wx: number, wy: number) => {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      const hit = hitTest(root, wx, wy, { deep: true });
      if (!hit || hit.locked) return;
      const radius = ERASER_PX / engine.snapshot().zoom;
      if (hit.kind === "vector" && hit.path.length) {
        const wp = worldPos(root, hit.id);
        if (!wp) return;
        const runs = erasePath(hit.path, wx - wp.x, wy - wp.y, radius);
        if (runs.length === 1 && runs[0].length === hit.path.length) return;
        if (!runs.length) {
          engine.dispatch({ type: "select", ids: [hit.id] });
          engine.dispatch({ type: "delete" });
          return;
        }
        // First run stays on the original node; extra runs become new paths so
        // erasing through the middle of a stroke yields two strokes.
        engine.dispatch({ type: "patchPath", id: hit.id, path: runs[0], closed: false });
        for (const extra of runs.slice(1)) {
          engine.dispatch({
            type: "addPath",
            points: extra.map((p) => ({ ...p, x: p.x + wp.x, y: p.y + wp.y })),
            closed: false,
          });
        }
        return;
      }
      engine.dispatch({ type: "select", ids: [hit.id] });
      engine.dispatch({ type: "delete" });
    },
    [engine],
  );

  const onDown = (e: React.MouseEvent) => {
    if (edit && (e.target as HTMLElement).closest(".text-edit")) return;
    if (e.button === 2) return;
    // Freeze the snap targets for this gesture: everything except the layers
    // being dragged (and their subtrees), so a node never snaps to itself.
    snapTargets.current = snapCandidates(
      snap.pages[snap.page].root,
      new Set(snap.selection),
    );
    if (snap.presentFrame) {
      const wpt = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      let n: XNode | null = hitTest(root, wpt.x, wpt.y, { includeLocked: true });
      while (n) {
        const ix = (n.interactions ?? []).find((i) => i.trigger === "onClick");
        if (ix) {
          runInteraction(ix);
          return;
        }
        const p = findParent(root, n.id);
        n = p && p !== root ? p : null;
      }
      return;
    }
    if (snap.tool === "eraser") {
      const wpt = toWorld(e.clientX, e.clientY);
      engine.dispatch({ type: "begin" });
      eraseAt(wpt.x, wpt.y);
      drag.current = { mode: "marquee", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: "erase" };
      return;
    }
    if (snap.tool === "comment" && e.button === 0 && !space.current) {
      // Comments are annotations, not geometry. Previously this dropped a blue
      // ellipse into the layer tree, which exported and hit-tested like a real
      // shape; now it opens a draft thread anchored to the clicked point.
      // Space (and middle-click) must still pan, so defer to those.
      const wpt = toWorld(e.clientX, e.clientY);
      setDraftComment({ x: wpt.x, y: wpt.y });
      return;
    }
    if (snap.tool === "pen") {
      let wpt = toWorld(e.clientX, e.clientY);
      if (e.shiftKey && draft.length) {
        const last = draft[draft.length - 1];
        const ang = Math.round(Math.atan2(wpt.y - last.y, wpt.x - last.x) / (Math.PI / 4)) * (Math.PI / 4);
        const d = Math.hypot(wpt.x - last.x, wpt.y - last.y);
        wpt = { x: last.x + Math.cos(ang) * d, y: last.y + Math.sin(ang) * d };
      }
      if (draft.length >= 3) {
        const a = draft[0];
        if (Math.hypot(wpt.x - a.x, wpt.y - a.y) < 8 / snap.zoom) {
          engine.dispatch({ type: "addPath", points: draft, closed: true });
          setDraft([]);
          penDrag.current = null;
          return;
        }
      }
      const pt: PathPoint = { x: wpt.x, y: wpt.y };
      setDraft((d) => [...d, pt]);
      penDrag.current = { i: draft.length, x: wpt.x, y: wpt.y };
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
    // Multi-selection: hit-test the combined bounding box's handles first, so a
    // group of layers can be scaled and rotated as one.
    if (snap.selection.length > 1 && snap.tool === "select") {
      const bb = selectionBounds(root, snap.selection);
      if (bb) {
        const z = snap.zoom;
        const r = wrap.current!.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const bsx = snap.panX + bb.x * z;
        const bsy = snap.panY + bb.y * z;
        const bsw = bb.w * z;
        const bsh = bb.h * z;
        if (Math.hypot(px - (bsx + bsw / 2), py - (bsy - 20)) < 8) {
          engine.dispatch({ type: "begin" });
          drag.current = {
            mode: "multiRotate",
            sx: e.clientX,
            sy: e.clientY,
            wx: wpt.x,
            wy: wpt.y,
            bounds: bb,
            origs: multiOrigins(root, snap.selection),
          };
          return;
        }
        const hs = handles(bsx, bsy, bsw, bsh);
        for (let i = 0; i < hs.length; i++) {
          if (Math.hypot(px - hs[i][0], py - hs[i][1]) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "multiResize",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              corner: i,
              bounds: bb,
              origs: multiOrigins(root, snap.selection),
            };
            return;
          }
        }
      }
    }
    if (snap.selection.length === 1) {
      const wp = worldPos(root, snap.selection[0]);
      if (wp) {
        const z = snap.zoom;
        const sx = snap.panX + wp.x * z;
        const sy = snap.panY + wp.y * z;
        const r = wrap.current!.getBoundingClientRect();
        const rawX = e.clientX - r.left;
        const rawY = e.clientY - r.top;
        let px = rawX;
        let py = rawY;
        if (wp.node.rotation || wp.node.flipH || wp.node.flipV) {
          const cx = sx + (wp.node.w * z) / 2;
          const cy = sy + (wp.node.h * z) / 2;
          const u = wp.node.rotation ? unrot(px, py, cx, cy, wp.node.rotation) : { x: px, y: py };
          px = wp.node.flipH ? cx - (u.x - cx) : u.x;
          py = wp.node.flipV ? cy - (u.y - cy) : u.y;
        }
        const ft = wp.node.fillType;
        if (ft === "linear" || ft === "radial" || ft === "angular" || ft === "diamond") {
          const ax = sx + (wp.node.fillGX ?? 0.5) * wp.node.w * z;
          const ay = sy + (wp.node.fillGY ?? 0) * wp.node.h * z;
          const bx = sx + (wp.node.fillHX ?? 0.5) * wp.node.w * z;
          const by = sy + (wp.node.fillHY ?? 1) * wp.node.h * z;
          if (Math.hypot(px - ax, py - ay) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "grad", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, handle: "g" };
            return;
          }
          if (Math.hypot(px - bx, py - by) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "grad", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, handle: "h" };
            return;
          }
        }
        if (vecEdit === wp.node.id) {
          const pts = wp.node.path.length ? wp.node.path : shapePoly(wp.node);
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const vx = snap.panX + (wp.x + p.x) * z;
            const vy = snap.panY + (wp.y + p.y) * z;
            if (Math.hypot(px - (vx + (p.ix || 0) * z), py - (vy + (p.iy || 0) * z)) < 7) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i, handle: "in" };
              return;
            }
            if (Math.hypot(px - (vx + (p.ox || 0) * z), py - (vy + (p.oy || 0) * z)) < 7) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i, handle: "out" };
              return;
            }
            if (Math.hypot(px - vx, py - vy) < 8) {
              engine.dispatch({ type: "begin" });
              vecPt.current = i;
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i };
              return;
            }
          }
        }
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
    const hit = hitTest(root, wpt.x, wpt.y, {
      deep: e.metaKey || e.ctrlKey,
      selection: snap.selection,
    });
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
    if (snap.presentFrame) {
      const wpt = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      let n: XNode | null = hitTest(root, wpt.x, wpt.y, { deep: true, includeLocked: true });
      while (n) {
        const ix = (n.interactions ?? []).find((i) => i.trigger === "onHover");
        if (ix) {
          if (hoverIx.current !== n.id) {
            hoverIx.current = n.id;
            runInteraction(ix);
          }
          return;
        }
        const p = findParent(root, n.id);
        n = p && p !== root ? p : null;
      }
      hoverIx.current = "";
      return;
    }
    if (!drag.current && !penDrag.current && !pencil.current && snap.tool === "select") {
      const wpt = toWorld(e.clientX, e.clientY);
      const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { selection: snap.selection });
      const id = hit && !snap.selection.includes(hit.id) ? hit.id : "";
      if (id !== hoverId) setHoverId(id);
      // Mirror the mousedown hit-test so the cursor advertises what a press
      // would actually do: resize on a handle, rotate just outside a corner,
      // move over the selection itself.
      const root0 = snap.pages[snap.page].root;
      const r0 = wrap.current?.getBoundingClientRect();
      let next: string | null = null;
      if (r0 && snap.selection.length) {
        const z = snap.zoom;
        const px0 = e.clientX - r0.left;
        const py0 = e.clientY - r0.top;
        const bb = snap.selection.length === 1 ? worldPos(root0, snap.selection[0]) : null;
        const box = bb
          ? { x: bb.x, y: bb.y, w: bb.node.w, h: bb.node.h, rot: bb.node.rotation }
          : (() => {
              const b = selectionBounds(root0, snap.selection);
              return b ? { x: b.x, y: b.y, w: b.w, h: b.h, rot: 0 } : null;
            })();
        if (box) {
          const sx0 = snap.panX + box.x * z;
          const sy0 = snap.panY + box.y * z;
          let hx = px0;
          let hy = py0;
          if (box.rot) {
            const cx = sx0 + (box.w * z) / 2;
            const cy = sy0 + (box.h * z) / 2;
            const u = unrot(hx, hy, cx, cy, box.rot);
            hx = u.x;
            hy = u.y;
          }
          const hs = handles(sx0, sy0, box.w * z, box.h * z);
          for (let i = 0; i < hs.length; i++) {
            if (Math.hypot(hx - hs[i][0], hy - hs[i][1]) < 8) {
              next = resizeCursor(i, box.rot);
              break;
            }
            // Just outside a corner is the rotate zone, as in Figma.
            if (i % 2 === 0 && Math.hypot(hx - hs[i][0], hy - hs[i][1]) < 18) next = "grab";
          }
          if (
            !next &&
            hx >= sx0 &&
            hx <= sx0 + box.w * z &&
            hy >= sy0 &&
            hy <= sy0 + box.h * z
          ) {
            next = "move";
          }
        }
      }
      if (next !== hoverCursor) setHoverCursor(next);
    } else if (hoverId && snap.tool !== "select") setHoverId("");
    if (snap.tool === "pen" && draft.length && !penDrag.current) {
      let wpt = toWorld(e.clientX, e.clientY);
      if (e.shiftKey) {
        const last = draft[draft.length - 1];
        const ang = Math.round(Math.atan2(wpt.y - last.y, wpt.x - last.x) / (Math.PI / 4)) * (Math.PI / 4);
        const d = Math.hypot(wpt.x - last.x, wpt.y - last.y);
        wpt = { x: last.x + Math.cos(ang) * d, y: last.y + Math.sin(ang) * d };
      }
      const gx = Math.round(wpt.x);
      const gy = Math.round(wpt.y);
      if (!ghost || Math.round(ghost.x) !== gx || Math.round(ghost.y) !== gy) setGhost({ x: gx, y: gy });
    } else if (ghost) setGhost(null);
    if (penDrag.current) {
      const wpt = toWorld(e.clientX, e.clientY);
      const p = penDrag.current;
      const ox = wpt.x - p.x;
      const oy = wpt.y - p.y;
      if (Math.hypot(ox, oy) > 2 / snap.zoom) {
        setDraft((d) => {
          const next = d.map((pt) => ({ ...pt }));
          const i = p.i;
          if (next[i]) {
            next[i].ox = ox;
            next[i].oy = oy;
            next[i].ix = -ox;
            next[i].iy = -oy;
          }
          return next;
        });
      }
      return;
    }
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
    } else if (d.mode === "move" && (snap.tool === "select" || snap.tool === "scale")) {
      if (e.altKey && !d.duped) {
        engine.dispatch({ type: "duplicate" });
        d.duped = true;
      }
      let dx = (e.clientX - d.sx) / snap.zoom;
      let dy = (e.clientY - d.sy) / snap.zoom;
      if (e.shiftKey) {
        if (!d.axis) d.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        if (d.axis === "x") dy = 0;
        else dx = 0;
      } else {
        d.axis = null;
      }
      if (dx || dy) {
        const sel = engine.snapshot().selection;
        // Snap the moved bounding box to nearby geometry. Holding ⌘/Ctrl
        // bypasses snapping, matching Figma.
        if (!e.metaKey && !e.ctrlKey) {
          const root2 = snap.pages[snap.page].root;
          const bb = selectionBounds(root2, sel);
          if (bb) {
            const moved = { id: "sel", x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h };
            const res = snapMove(
              moved,
              snapTargets.current,
              SNAP_PX / snap.zoom,
              snap.pages[snap.page].guides,
            );
            dx += res.dx;
            dy += res.dy;
            setGuides(res.guides);
            setGapBadges(res.gaps);
          }
        } else if (guides.length || gapBadges.length) {
          setGuides([]);
          setGapBadges([]);
        }
        engine.dispatch({ type: "move", ids: sel, dx, dy });
        d.sx = e.clientX;
        d.sy = e.clientY;
      }
    } else if (d.mode === "multiResize" && d.bounds && d.origs && d.corner != null) {
      const b = toWorld(e.clientX, e.clientY);
      const next = resizeFrom(d.bounds, d.corner, b.x, b.y, {
        aspect: e.shiftKey,
        fromCenter: e.altKey,
      });
      const sxScale = next.w / Math.max(1e-6, d.bounds.w);
      const syScale = next.h / Math.max(1e-6, d.bounds.h);
      // Map each member through the same affine scale about the box origin.
      for (const o of d.origs) {
        const nx = next.x + (o.x - d.bounds.x) * sxScale;
        const ny = next.y + (o.y - d.bounds.y) * syScale;
        engine.dispatch({
          type: "resize",
          id: o.id,
          x: o.lx + (nx - o.x),
          y: o.ly + (ny - o.y),
          w: Math.max(1, o.w * sxScale),
          h: Math.max(1, o.h * syScale),
          scaleProps: snap.tool === "scale",
        });
      }
    } else if (d.mode === "multiRotate" && d.bounds && d.origs) {
      const cx = d.bounds.x + d.bounds.w / 2;
      const cy = d.bounds.y + d.bounds.h / 2;
      const b = toWorld(e.clientX, e.clientY);
      let ang = (Math.atan2(b.y - cy, b.x - cx) * 180) / Math.PI + 90;
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      const rad = (ang * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      // Orbit every member around the shared centre and spin it in place.
      for (const o of d.origs) {
        const ox = o.x + o.w / 2 - cx;
        const oy = o.y + o.h / 2 - cy;
        const wx = cx + ox * cos - oy * sin - o.w / 2;
        const wy = cy + ox * sin + oy * cos - o.h / 2;
        engine.dispatch({
          type: "resize",
          id: o.id,
          x: o.lx + (wx - o.x),
          y: o.ly + (wy - o.y),
          w: o.w,
          h: o.h,
        });
        engine.dispatch({
          type: "patch",
          id: o.id,
          patch: { rotation: Math.round(o.rotation + ang) },
        });
      }
    } else if (d.mode === "marquee" && d.id === "erase") {
      const wpt = toWorld(e.clientX, e.clientY);
      eraseAt(wpt.x, wpt.y);
    } else if (d.mode === "create" || d.mode === "marquee") {
      let x = Math.min(d.sx, e.clientX) - box.left;
      let y = Math.min(d.sy, e.clientY) - box.top;
      let w = Math.abs(e.clientX - d.sx);
      let h = Math.abs(e.clientY - d.sy);
      if (d.mode === "create" && e.shiftKey) {
        const s = Math.max(w, h);
        w = s;
        h = s;
      }
      if (d.mode === "create" && e.altKey) {
        x = d.sx - box.left - w;
        y = d.sy - box.top - h;
        w *= 2;
        h *= 2;
      }
      setBand({ x, y, w, h });
    } else if (d.mode === "resize" && d.orig && d.id != null && d.corner != null) {
      const raw = toWorld(e.clientX, e.clientY);
      const current = worldPos(snap.pages[snap.page].root, d.id);
      const node = current?.node;
      const shape = node ? { ...node, x: d.orig.x, y: d.orig.y, w: d.orig.w, h: d.orig.h } : null;
      const local = shape ? nodeLocalPoint(raw.x, raw.y, d.orig.x, d.orig.y, shape) : { x: raw.x - d.orig.x, y: raw.y - d.orig.y };
      const b = shape ? { x: d.orig.x + local.x, y: d.orig.y + local.y } : raw;
      const lock = e.shiftKey || !!node?.aspectLocked;
      const next = resizeFrom(d.orig, d.corner, b.x, b.y, {
        aspect: lock,
        fromCenter: e.altKey,
      });
      // Snap the edges the handle is actually moving (skipped while aspect is
      // locked, since a snap would break the ratio, and on ⌘/Ctrl).
      if (!lock && !e.altKey && !e.metaKey && !e.ctrlKey && current) {
        const worldBox = {
          id: d.id,
          x: current.x + (next.x - node!.x),
          y: current.y + (next.y - node!.y),
          w: next.w,
          h: next.h,
        };
        const r2 = snapResize(worldBox, d.corner, snapTargets.current, SNAP_PX / snap.zoom);
        setGuides(r2.guides);
        const movesLeft = d.corner === 0 || d.corner === 6 || d.corner === 7;
        const movesTop = d.corner === 0 || d.corner === 1 || d.corner === 2;
        if (r2.dx) {
          if (movesLeft) {
            next.x += r2.dx;
            next.w = Math.max(1, next.w - r2.dx);
          } else next.w = Math.max(1, next.w + r2.dx);
        }
        if (r2.dy) {
          if (movesTop) {
            next.y += r2.dy;
            next.h = Math.max(1, next.h - r2.dy);
          } else next.h = Math.max(1, next.h + r2.dy);
        }
      }
      engine.dispatch({
        type: "resize",
        id: d.id,
        ...next,
        scaleProps: snap.tool === "scale",
      });
    } else if (d.mode === "grad" && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const lx = local.x / Math.max(1, wp.node.w);
        const ly = local.y / Math.max(1, wp.node.h);
        if (d.handle === "g") engine.dispatch({ type: "patch", id: d.id, patch: { fillGX: lx, fillGY: ly } });
        else engine.dispatch({ type: "patch", id: d.id, patch: { fillHX: lx, fillHY: ly } });
      }
    } else if (d.mode === "vec" && d.id != null && d.point != null) {
      const wpt = toWorld(e.clientX, e.clientY);
      const loc = worldPos(snap.pages[snap.page].root, d.id);
      const n = loc?.node;
      if (n && loc) {
        const pts = (n.path.length ? n.path : shapePoly(n)).map((p) => ({ ...p }));
        const p = pts[d.point];
        const local = nodeLocalPoint(wpt.x, wpt.y, loc.x, loc.y, n);
        const lx = local.x;
        const ly = local.y;
        if (d.handle === "in") {
          p.ix = lx - p.x;
          p.iy = ly - p.y;
        } else if (d.handle === "out") {
          p.ox = lx - p.x;
          p.oy = ly - p.y;
        } else {
          p.x = lx;
          p.y = ly;
        }
        engine.dispatch({ type: "patchPath", id: n.id, path: pts, closed: n.closed });
      }
    } else if (d.mode === "rotate" && d.orig && d.id) {
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (!wp) return;
      const cx = wp.x + wp.node.w / 2;
      const cy = wp.y + wp.node.h / 2;
      const b = toWorld(e.clientX, e.clientY);
      let ang = (Math.atan2(b.y - cy, b.x - cx) * 180) / Math.PI + 90;
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      engine.dispatch({ type: "patch", id: d.id, patch: { rotation: Math.round(ang) } });
    }
  };

  const onUp = (e: React.MouseEvent) => {
    if (penDrag.current) {
      penDrag.current = null;
      return;
    }
    if (pencil.current) {
      const pts = pencil.current;
      pencil.current = null;
      if (pts.length >= 2) {
        // Raw pointer samples are dense and jagged: thin them with RDP, then
        // fit bezier handles so the stroke reads as a smooth curve. Tolerance
        // is in world units so it is consistent at any zoom.
        const tol = PENCIL_TOLERANCE_PX / snap.zoom;
        const thinned = simplifyPath(pts, tol);
        const smoothed = snap.tool === "pencil" ? smoothPath(thinned, false) : thinned;
        engine.dispatch({ type: "addPath", points: smoothed, closed: false });
      }
      setDraft([]);
      return;
    }
    const d = drag.current;
    drag.current = null;
    setBand(null);
    setGuides([]);
    setGapBadges([]);
    if (!d) return;
    if (
      d.mode === "move" ||
      d.mode === "resize" ||
      d.mode === "vec" ||
      d.mode === "grad" ||
      d.mode === "multiResize" ||
      d.mode === "multiRotate" ||
      (d.mode === "marquee" && d.id === "erase")
    )
      engine.dispatch({ type: "end" });
    if (d.mode === "move" && snap.pages[snap.page].pixelGrid) {
      const root = snap.pages[snap.page].root;
      for (const id of engine.snapshot().selection) {
        const n = worldPos(root, id)?.node;
        if (n && !n.locked)
          engine.dispatch({
            type: "patch",
            id,
            patch: { x: Math.round(n.x), y: Math.round(n.y) },
          });
      }
    }
    if (d.mode === "move") {
      const selection = engine.snapshot().selection;
      const sel = selection[0];
      const root = snap.pages[snap.page].root;
      const wp = sel ? worldPos(root, sel) : null;
      if (wp) {
        const cx = wp.x + wp.node.w / 2;
        const cy = wp.y + wp.node.h / 2;
        const frame = deepestFrame(root, cx, cy, new Set(selection));
        if (frame) {
          const frameWorld = worldPos(root, frame.id);
          for (const id of selection) {
            const item = worldPos(root, id);
            const parent = findParent(root, id);
            if (!item || item.node.id === frame.id || frame === parent || !frameWorld) continue;
            engine.dispatch({
              type: "reparent",
              ids: [item.node.id],
              parent: frame.id,
              x: item.x - frameWorld.x,
              y: item.y - frameWorld.y,
            });
          }
        }
      }
    }
    if (d.mode === "create") {
      const a = toWorld(d.sx, d.sy);
      const b = toWorld(e.clientX, e.clientY);
      const clicked = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4;
      let w = Math.abs(b.x - a.x);
      let h = Math.abs(b.y - a.y);
      let x = Math.min(a.x, b.x);
      let y = Math.min(a.y, b.y);
      const k = kindOf(snap.tool);
      if (!k) return;
      const shift = e.shiftKey;
      const alt = e.altKey;
      let rot = 0;
      if (clicked) {
        if (k === "text") {
          w = 24;
          h = 24;
        } else if (k === "line" || k === "arrow") {
          w = 100;
          h = 1;
        } else {
          w = 100;
          h = 100;
        }
        x = a.x;
        y = a.y;
      } else if (k === "line" || k === "arrow") {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        let ang = Math.atan2(dy, dx);
        if (shift) ang = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.max(1, Math.hypot(dx, dy));
        w = len;
        h = 1;
        const mx = a.x + Math.cos(ang) * (len / 2);
        const my = a.y + Math.sin(ang) * (len / 2);
        x = mx - w / 2;
        y = my - h / 2;
        rot = (ang * 180) / Math.PI;
      } else {
        if (shift) {
          const s = Math.max(w, h, 1);
          w = s;
          h = s;
        }
        if (alt) {
          x = a.x - w;
          y = a.y - h;
          w *= 2;
          h *= 2;
        }
      }
      if (k === "text" && !clicked) {
        w = Math.max(w, 8);
        h = Math.max(h, 8);
      } else if (k !== "line" && k !== "arrow" && k !== "text") {
        w = Math.max(w, 1);
        h = Math.max(h, 1);
      }
      const root = snap.pages[snap.page].root;
      const host = deepestFrame(root, x + w / 2, y + h / 2);
      let nodeX = x;
      let nodeY = y;
      let nodeW = w;
      let nodeH = h;
      let nodeRotation = rot;
      if (host) {
        const la = worldToLocal(root, host.id, a.x, a.y);
        const lb = worldToLocal(root, host.id, b.x, b.y);
        if (k === "line" || k === "arrow") {
          const dx = lb.x - la.x;
          const dy = lb.y - la.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          const ang = Math.atan2(dy, dx);
          nodeW = len;
          nodeH = 1;
          nodeX = (la.x + lb.x) / 2 - len / 2;
          nodeY = (la.y + lb.y) / 2 - 0.5;
          nodeRotation = (ang * 180) / Math.PI;
        } else if (clicked) {
          nodeX = la.x;
          nodeY = la.y;
        } else {
          nodeW = Math.max(1, Math.abs(lb.x - la.x));
          nodeH = Math.max(1, Math.abs(lb.y - la.y));
          if (shift) {
            const side = Math.max(nodeW, nodeH);
            nodeW = side;
            nodeH = side;
          }
          if (alt) {
            nodeX = la.x - nodeW;
            nodeY = la.y - nodeH;
            nodeW *= 2;
            nodeH *= 2;
          } else {
            nodeX = Math.min(la.x, lb.x);
            nodeY = Math.min(la.y, lb.y);
          }
        }
      }
      const extra: Partial<XNode> =
        snap.tool === "section"
          ? { name: "Section", fill: "#00000000", overflow: "visible" }
          : snap.tool === "slice"
            ? {
                name: "Slice",
                fill: "#00000000",
                fillVisible: false,
                strokePaint: "#0d99ff",
                strokeVisible: true,
                strokeWidth: 1,
                strokeDash: 4,
              }
          : k === "text"
            ? clicked
              ? { text: "", sizingW: "hug", sizingH: "hug", fontSize: 16 }
              : { text: "", sizingW: "fixed", sizingH: "fixed", fontSize: 16 }
            : k === "line" || k === "arrow"
              ? { rotation: nodeRotation }
              : {};
      engine.dispatch({
        type: "add",
        kind: k,
        x: nodeX,
        y: nodeY,
        w: nodeW,
        h: nodeH,
        parent: host?.id,
        extra,
      });
      if (k === "text") {
        const id = engine.snapshot().selection[0];
        if (id) setEdit({ id, text: "" });
      }
      // Figma drops back to the move tool after a shape is committed, so the
      // next drag manipulates what you just drew instead of stamping another
      // copy. Slice is the documented exception: it stays armed for repeat cuts.
      if (snap.tool !== "slice") engine.dispatch({ type: "setTool", tool: "select" });
    }
    if (d.mode === "marquee" && d.id === "erase") return;
    if (d.mode === "marquee") {
      const a = toWorld(d.sx, d.sy);
      const b = toWorld(e.clientX, e.clientY);
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const x1 = Math.max(a.x, b.x);
      const y1 = Math.max(a.y, b.y);
      const ids: string[] = [];
      const deep = e.metaKey || e.ctrlKey;
      const visit = (n: XNode, px: number, py: number, top: boolean) => {
        const x = px + n.x;
        const y = py + n.y;
        if (n !== snap.pages[snap.page].root && n.visible && !n.locked) {
          const hit = x + n.w >= x0 && y + n.h >= y0 && x <= x1 && y <= y1;
          if (hit && (deep || top)) ids.push(n.id);
        }
        const nest = deep || n === snap.pages[snap.page].root;
        if (nest) for (const c of n.children) visit(c, x, y, n === snap.pages[snap.page].root);
      };
      visit(snap.pages[snap.page].root, 0, 0, false);
      engine.dispatch({ type: "select", ids });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      const next = Math.min(8, Math.max(0.1, snap.zoom * factor));
      const box = wrap.current!.getBoundingClientRect();
      const cx = e.clientX - box.left;
      const cy = e.clientY - box.top;
      const wx = (cx - snap.panX) / snap.zoom;
      const wy = (cy - snap.panY) / snap.zoom;
      engine.dispatch({ type: "setZoom", zoom: next });
      engine.dispatch({ type: "setPan", x: cx - wx * next, y: cy - wy * next });
    } else {
      engine.dispatch({ type: "pan", dx: -e.deltaX, dy: -e.deltaY });
    }
  };

  const onDbl = (e: React.MouseEvent) => {
    const wpt = toWorld(e.clientX, e.clientY);
    const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { deep: true });
    if (hit?.kind === "text") setEdit({ id: hit.id, text: hit.text });
    else if (vecEdit && hit && hit.id === vecEdit && hit.path.length) {
      const loc = worldPos(snap.pages[snap.page].root, hit.id);
      if (loc) {
        const path = hit.path.map((pt) => ({ ...pt }));
        let best = -1;
        let bd = 8 / snap.zoom;
        for (let i = 0; i < path.length; i++) {
          const d = Math.hypot(wpt.x - (loc.x + path[i].x), wpt.y - (loc.y + path[i].y));
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (best >= 0) {
          const pt = path[best];
          const has = (pt.ox && pt.ox !== 0) || (pt.oy && pt.oy !== 0);
          if (has) {
            pt.ix = 0;
            pt.iy = 0;
            pt.ox = 0;
            pt.oy = 0;
          } else {
            pt.ox = 20;
            pt.oy = 0;
            pt.ix = -20;
            pt.iy = 0;
          }
          engine.dispatch({ type: "patchPath", id: hit.id, path, closed: hit.closed });
        }
      }
    } else if (hit && (hit.kind === "vector" || hit.kind === "boolean")) {
      engine.dispatch({ type: "select", ids: [hit.id] });
      if (hit.kind !== "vector") engine.dispatch({ type: "flatten" });
      setVecEdit(hit.id);
    } else if (hit) engine.dispatch({ type: "select", ids: [hit.id] });
  };

  const onLeave = (e: React.MouseEvent) => {
    onUp(e);
    hoverIx.current = "";
  };

  /** SVG is a vector format, so it becomes editable layers rather than a flat
   *  image fill. Everything else is placed as an image as before. */
  const placeSvg = (file: File, at?: { x: number; y: number }) => {
    const reader = new FileReader();
    reader.onload = () => {
      let result;
      try {
        result = importSvg(String(reader.result));
      } catch {
        toast(`Could not read ${file.name}`);
        return;
      }
      placeNodes(result, file.name, at);
    };
    reader.readAsText(file);
  };

  /** Shared tail for every vector-ish import: place the produced nodes as one
   *  undo step and report what happened. */
  const placeNodes = (
    result: { nodes: ImportedNode[]; skipped: number },
    fileName: string,
    at?: { x: number; y: number },
  ) => {
    if (!result.nodes.length) {
      toast(`Nothing importable in ${fileName}`);
      return;
    }
    const ox = at?.x ?? 80;
    const oy = at?.y ?? 80;
    const current = engine.snapshot();
    const root = current.pages[current.page].root;
    const host = deepestFrame(root, ox, oy);
    const origin = host ? worldToLocal(root, host.id, ox, oy) : { x: ox, y: oy };
    engine.dispatch({ type: "begin" });
    for (const n of result.nodes) {
      const { kind, name, x, y, w, h, ...rest } = n;
      // Spreading an explicit `undefined` overwrites the node factory's
      // default (cornerRadii became undefined and crashed the inspector), so
      // unset optional fields must be dropped rather than passed through.
      for (const k of Object.keys(rest) as (keyof typeof rest)[]) {
        if (rest[k] === undefined) delete rest[k];
      }
      engine.dispatch({
        type: "add",
        kind,
        x: origin.x + x,
        y: origin.y + y,
        w: Math.max(1, w),
        h: Math.max(1, h),
        parent: host?.id,
        extra: { name, ...rest } as Partial<XNode>,
      });
    }
    engine.dispatch({ type: "end" });
    toast(
      result.skipped
        ? `Imported ${result.nodes.length} layers · ${result.skipped} unsupported skipped`
        : `Imported ${result.nodes.length} layers`,
    );
  };

  const placeSketch = (file: File, at?: { x: number; y: number }) => {
    file
      .arrayBuffer()
      .then((buf) => importSketch(buf))
      .then((result) => placeNodes(result, file.name, at))
      .catch((err: unknown) => {
        toast(`Could not read ${file.name}: ${err instanceof Error ? err.message : "unreadable"}`);
      });
  };

  const placeFig = (file: File, at?: { x: number; y: number }) => {
    file
      .arrayBuffer()
      .then((buf) => importFig(buf))
      .then((result) => placeNodes(result, file.name, at))
      .catch((err: unknown) => {
        toast(`Could not read ${file.name}: ${err instanceof Error ? err.message : "unreadable"}`);
      });
  };

  const placeFiles = (files: FileList | File[], at?: { x: number; y: number }) => {
    const all = Array.from(files);
    for (const f of all) {
      if (f.type === "image/svg+xml" || /\.svg$/i.test(f.name)) placeSvg(f, at);
      else if (/\.sketch$/i.test(f.name)) placeSketch(f, at);
      else if (/\.fig$/i.test(f.name)) placeFig(f, at);
    }
    const list = all.filter(
      (f) => f.type.startsWith("image/") && f.type !== "image/svg+xml" && !/\.svg$/i.test(f.name),
    );
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
          const current = engine.snapshot();
          const root = current.pages[current.page].root;
          const host = deepestFrame(root, ox, oy);
          const local = host ? worldToLocal(root, host.id, ox, oy) : { x: ox, y: oy };
          engine.dispatch({
            type: "add",
            kind: "rect",
            x: local.x,
            y: local.y,
            w: Math.max(8, w * s),
            h: Math.max(8, h * s),
            parent: host?.id,
            extra: {
              imageSrc: src,
              fillType: "image",
              imageFit: "fill",
              name: file.name.replace(/\.[^.]+$/, ""),
              fill: "#00000000",
              fillVisible: true,
            },
          });
          ox += 24;
          oy += 24;
        };
        im.src = src;
      };
      reader.readAsDataURL(file);
    });
  };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const cursor =
    snap.tool === "hand" || space.current
      ? "grab"
      : snap.tool === "scale"
        ? "nwse-resize"
        : CREATE.includes(snap.tool) || snap.tool === "pen" || snap.tool === "pencil" || snap.tool === "brush"
          ? "crosshair"
          : snap.tool === "select" && hoverCursor
            ? hoverCursor
            : "default";

  const editBox = (() => {
    if (!edit) return null;
    const wp = worldPos(snap.pages[snap.page].root, edit.id);
    if (!wp) return null;
    const measure = ref.current?.getContext("2d");
    let textW = wp.node.w;
    let textH = wp.node.h;
    if (measure && (wp.node.sizingW === "hug" || wp.node.sizingH === "hug")) {
      measure.font = `${wp.node.fontWeight} ${wp.node.fontSize}px ${wp.node.fontFamily}, Inter, system-ui`;
      const lines = (edit.text || " ").split("\n");
      textW = Math.max(wp.node.w, ...lines.map((line) => measure.measureText(line || " ").width + 4));
      textH = Math.max(wp.node.h, lines.length * (wp.node.lineHeight || wp.node.fontSize * 1.2));
    }
    return {
      left: snap.panX + wp.x * snap.zoom,
      top: snap.panY + wp.y * snap.zoom,
      width: textW * snap.zoom,
      height: textH * snap.zoom,
      fontSize: wp.node.fontSize * snap.zoom,
      fontWeight: wp.node.fontWeight,
      lineHeight: (wp.node.lineHeight || wp.node.fontSize * 1.2) * snap.zoom,
      letterSpacing: wp.node.letterSpacing * snap.zoom,
      textAlign: wp.node.textAlign === "justified" ? "left" : wp.node.textAlign,
      color: wp.node.fill,
      fontFamily: wp.node.fontFamily,
      transform: wp.node.rotation ? `rotate(${wp.node.rotation}deg)` : undefined,
      transformOrigin: "center center",
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
      onMouseLeave={onLeave}
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
      {(snap.showComments || snap.tool === "comment") && (
        <Comments
          threads={snap.pages[snap.page].comments}
          engine={engine}
          zoom={snap.zoom}
          panX={snap.panX}
          panY={snap.panY}
          openId={snap.openComment}
          draft={draftComment}
          onDraftDone={() => setDraftComment(null)}
        />
      )}
      {snap.showRulers && (
        <Guides
          guides={snap.pages[snap.page].guides}
          engine={engine}
          zoom={snap.zoom}
          panX={snap.panX}
          panY={snap.panY}
          width={box.w}
          height={box.h}
        />
      )}
      {snap.showRulers && (
        <Rulers
          zoom={snap.zoom}
          panX={snap.panX}
          panY={snap.panY}
          width={box.w}
          height={box.h}
          theme={theme}
          selection={selectionBounds(snap.pages[snap.page].root, snap.selection)}
        />
      )}
      {transition && <div className={`proto-transition ${transition}`} aria-hidden="true" />}
      {edit && editBox && (
        <textarea
          className="text-edit"
          style={editBox}
          value={edit.text}
          autoFocus
          onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          onBlur={() => {
            const n = worldPos(snap.pages[snap.page].root, edit.id)?.node;
            const patch: Partial<XNode> = { text: edit.text };
            if (n && (n.sizingW === "hug" || n.sizingH === "hug")) {
              const ctx = ref.current?.getContext("2d");
              if (ctx) {
                ctx.font = `${n.fontWeight} ${n.fontSize}px ${n.fontFamily}, Inter, system-ui`;
                const lines = (edit.text || " ").split("\n");
                const tw = Math.max(...lines.map((l) => measureCached(ctx, l)), 8);
                const lh = n.lineHeight || n.fontSize * 1.2;
                if (n.sizingW === "hug") patch.w = Math.ceil(tw + 4);
                if (n.sizingH === "hug") patch.h = Math.ceil(Math.max(1, lines.length) * lh);
              }
            }
            engine.dispatch({ type: "patch", id: edit.id, patch });
            setEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter"))
              (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg,.sketch,.fig,image/*"
        hidden
        onChange={(e) => {
          if (e.target.files) placeFiles(e.target.files, pendingImage.current ?? undefined);
          pendingImage.current = null;
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

function paintNoise(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  density: number,
) {
  const d = Math.max(0, Math.min(1, density / 100));
  if (d <= 0 || sw < 1 || sh < 1) return;
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.35 * d;
  const count = Math.min(4000, Math.floor((sw * sh * d) / 18));
  const seed = Math.floor(sx * 13 + sy * 17);
  for (let i = 0; i < count; i++) {
    const h = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    const r = h - Math.floor(h);
    const h2 = Math.sin(seed * 4.1414 + i * 19.19) * 23421.631;
    const r2 = h2 - Math.floor(h2);
    ctx.fillRect(sx + r * sw, sy + r2 * sh, 1, 1);
  }
  ctx.restore();
}

function canvasBlend(m?: string): GlobalCompositeOperation {
  const k = (m || "normal").toLowerCase().replace(/\s+/g, "-");
  const map: Record<string, GlobalCompositeOperation> = {
    normal: "source-over",
    "pass-through": "source-over",
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
    "color-dodge": "color-dodge",
    "color-burn": "color-burn",
    difference: "difference",
    exclusion: "exclusion",
    hue: "hue",
    saturation: "saturation",
    color: "color",
    luminosity: "luminosity",
    "hard-light": "hard-light",
    "soft-light": "soft-light",
  };
  return map[k] || "source-over";
}

function unrot(px: number, py: number, cx: number, cy: number, deg: number) {
  const a = (-deg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

function nodeLocalPoint(px: number, py: number, x: number, y: number, n: XNode) {
  const cx = x + n.w / 2;
  const cy = y + n.h / 2;
  const p = n.rotation ? unrot(px, py, cx, cy, n.rotation) : { x: px, y: py };
  return {
    x: (n.flipH ? cx - (p.x - cx) : p.x) - x,
    y: (n.flipV ? cy - (p.y - cy) : p.y) - y,
  };
}

/** Axis-aligned world bounds enclosing every selected node. */
function selectionBounds(
  root: XNode,
  ids: string[],
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const wp = worldPos(root, id);
    if (!wp) continue;
    minX = Math.min(minX, wp.x);
    minY = Math.min(minY, wp.y);
    maxX = Math.max(maxX, wp.x + wp.node.w);
    maxY = Math.max(maxY, wp.y + wp.node.h);
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/**
 * Figma shows a resize cursor whose direction follows the handle *and* the
 * node's rotation, so a 90deg-rotated box still reads correctly. Handle order is
 * TL,T,TR,R,BR,B,BL,L (see `handles`); each sits 45deg apart, so rotating by the
 * node angle and snapping back to the nearest 45deg step picks the right glyph.
 */
const RESIZE_CURSORS = [
  "nwse-resize", // TL
  "ns-resize", // T
  "nesw-resize", // TR
  "ew-resize", // R
  "nwse-resize", // BR
  "ns-resize", // B
  "nesw-resize", // BL
  "ew-resize", // L
];
function resizeCursor(handle: number, rotation = 0): string {
  const step = Math.round(rotation / 45);
  return RESIZE_CURSORS[(((handle + step) % 8) + 8) % 8];
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
  opts?: { aspect?: boolean; fromCenter?: boolean },
) {
  let { x, y, w, h } = o;
  const right = o.x + o.w;
  const bottom = o.y + o.h;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  // 0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w
  if (opts?.fromCenter) {
    if (corner === 0 || corner === 1 || corner === 2 || corner === 4 || corner === 5 || corner === 6) {
      h = Math.abs(by - cy) * 2;
      y = cy - h / 2;
    }
    if (corner === 0 || corner === 2 || corner === 3 || corner === 4 || corner === 6 || corner === 7) {
      w = Math.abs(bx - cx) * 2;
      x = cx - w / 2;
    }
  } else {
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
  }
  if (opts?.aspect && o.w > 0) {
    const ratio = o.h / o.w;
    h = Math.max(1, w * ratio);
    if (opts.fromCenter) y = cy - h / 2;
    else if (corner === 0 || corner === 1 || corner === 2) y = bottom - h;
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
  rx: number,
  ry: number,
  n: number,
  ratio = 0.4,
) {
  const pts = Math.max(3, Math.min(60, Math.round(n)));
  const inner = Math.max(0.05, Math.min(0.95, ratio));
  ctx.beginPath();
  for (let i = 0; i < pts * 2; i++) {
    const a = (i * Math.PI) / pts - Math.PI / 2;
    const k = i % 2 === 0 ? 1 : inner;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function polyPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n: number,
) {
  ctx.beginPath();
  const pts = Math.max(3, Math.min(60, Math.round(n)));
  for (let i = 0; i < pts; i++) {
    const a = (i * 2 * Math.PI) / pts - Math.PI / 2;
    const x = cx + Math.cos(a) * rx;
    const y = cy + Math.sin(a) * ry;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  path: PathPoint[],
  ox: number,
  oy: number,
  z: number,
  closed: boolean,
) {
  ctx.beginPath();
  path.forEach((pt, i) => {
    const vx = ox + pt.x * z;
    const vy = oy + pt.y * z;
    if (i === 0) {
      ctx.moveTo(vx, vy);
      return;
    }
    const prev = path[i - 1];
    const has =
      (prev.ox && prev.ox !== 0) ||
      (prev.oy && prev.oy !== 0) ||
      (pt.ix && pt.ix !== 0) ||
      (pt.iy && pt.iy !== 0);
    if (has) {
      ctx.bezierCurveTo(
        ox + (prev.x + (prev.ox || 0)) * z,
        oy + (prev.y + (prev.oy || 0)) * z,
        ox + (pt.x + (pt.ix || 0)) * z,
        oy + (pt.y + (pt.iy || 0)) * z,
        vx,
        vy,
      );
    } else {
      ctx.lineTo(vx, vy);
    }
  });
  if (closed && path.length > 2) {
    const first = path[0];
    const last = path[path.length - 1];
    const has =
      (last.ox && last.ox !== 0) ||
      (last.oy && last.oy !== 0) ||
      (first.ix && first.ix !== 0) ||
      (first.iy && first.iy !== 0);
    if (has) {
      ctx.bezierCurveTo(
        ox + (last.x + (last.ox || 0)) * z,
        oy + (last.y + (last.oy || 0)) * z,
        ox + (first.x + (first.ix || 0)) * z,
        oy + (first.y + (first.iy || 0)) * z,
        ox + first.x * z,
        oy + first.y * z,
      );
    }
    ctx.closePath();
  }
}

/** Glyph-width cache. measureText dominated pan/zoom frame time on large
 *  documents because every visible string was re-measured on every frame even
 *  when neither the text nor the font had changed. Keyed by font + string, so
 *  a font change naturally misses and re-measures. Bounded to keep a long
 *  session from growing the cache without limit. */
const MEASURE_CACHE = new Map<string, number>();
const MEASURE_CACHE_MAX = 20000;

function measureCached(ctx: CanvasRenderingContext2D, s: string): number {
  if (!s) return 0;
  const key = `${ctx.font}\u0000${s}`;
  const hit = MEASURE_CACHE.get(key);
  if (hit !== undefined) return hit;
  const w = ctx.measureText(s).width;
  if (MEASURE_CACHE.size >= MEASURE_CACHE_MAX) MEASURE_CACHE.clear();
  MEASURE_CACHE.set(key, w);
  return w;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  letterSpacing: number,
): string[] {
  const paras = text.split("\n");
  const lines: string[] = [];
  const widthOf = (s: string) => {
    if (!s) return 0;
    const m = measureCached(ctx, s);
    return letterSpacing ? m + letterSpacing * Math.max(0, s.length - 1) : m;
  };
  const splitLong = (word: string) => {
    let part = "";
    for (const ch of word) {
      if (part && widthOf(part + ch) > maxW) {
        lines.push(part);
        part = ch;
      } else {
        part += ch;
      }
    }
    return part;
  };
  for (const para of paras) {
    if (!para) {
      lines.push("");
      continue;
    }
    if (maxW <= 0 || widthOf(para) <= maxW) {
      lines.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let cur = "";
    for (const token of words) {
      if (!token) continue;
      const word = token.trim();
      if (!word) {
        if (cur) cur += token;
        continue;
      }
      if (widthOf(word) > maxW) {
        if (cur.trim()) {
          lines.push(cur.trimEnd());
          cur = "";
        }
        cur = splitLong(word);
        continue;
      }
      const next = cur ? `${cur}${token}` : word;
      if (cur && widthOf(next) > maxW) {
        lines.push(cur.trimEnd());
        cur = word;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur.trimEnd());
  }
  return lines.length ? lines : [""];
}

function paintText(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  z: number,
) {
  const textFill = fillStyle(ctx, n, sx, sy, sw, sh);
  const size = Math.max(1, n.fontSize * z);
  ctx.font = `${n.fontWeight} ${size}px ${n.fontFamily}, Inter, system-ui`;
  ctx.textBaseline = "top";
  ctx.textAlign = n.textAlign === "center" ? "center" : n.textAlign === "right" ? "right" : "left";
  const clipped = n.truncate;
  if (clipped) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();
  }
  let content = n.text;
  if (!content) {
    if (clipped) ctx.restore();
    return;
  }
  if (n.textCase === "upper" || n.textCase === "small-caps") content = content.toUpperCase();
  if (n.textCase === "lower") content = content.toLowerCase();
  if (n.textCase === "title") content = content.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
  const lh = Math.max(size, (n.lineHeight || n.fontSize * 1.2) * z);
  const ls = (n.letterSpacing || 0) * z;
  const paraGap = (n.paragraphSpacing || 0) * z;
  const wrap = n.sizingW !== "hug";
  const paras = content.split("\n");
  type Row = { line: string; lastInPara: boolean };
  const rows: Row[] = [];
  for (const para of paras) {
    const wrapped = wrapLines(ctx, para || " ", wrap ? sw : 1e6, ls);
    wrapped.forEach((line, i) => rows.push({ line: para ? line : "", lastInPara: i === wrapped.length - 1 }));
  }
  let lines = rows;
  if (n.truncate) {
    const limit = Math.max(1, n.maxLines || 1);
    if (lines.length > limit) {
      const clipped = lines.slice(0, limit);
      const last = clipped[clipped.length - 1];
      const widthOf = (s: string) =>
        measureCached(ctx, s) + (ls ? ls * Math.max(0, s.length - 1) : 0);
      const maxW = wrap ? sw : Infinity;
      let line = last.line;
      if (Number.isFinite(maxW)) {
        while (line && widthOf(`${line}…`) > maxW) line = line.slice(0, -1);
        line = `${line.replace(/\s+$/, "")}…`;
      } else {
        line = `${line}…`;
      }
      clipped[clipped.length - 1] = { line, lastInPara: true };
      lines = clipped;
    }
  }
  const blockH = lines.reduce((h, r) => h + lh + (r.lastInPara ? paraGap : 0), 0) - paraGap;
  let y0 = sy;
  if (n.textAlignVertical === "middle") y0 = sy + (sh - blockH) / 2;
  if (n.textAlignVertical === "bottom") y0 = sy + sh - blockH;
  const drop = (n.effects ?? []).find((e) => e.kind === "drop-shadow" && e.visible);
  if (drop) {
    const { r, g, b, a } = parseHex(drop.color);
    ctx.shadowColor = `rgba(${r},${g},${b},${a})`;
    ctx.shadowBlur = Math.max(0, drop.blur) * z;
    ctx.shadowOffsetX = drop.x * z;
    ctx.shadowOffsetY = drop.y * z;
  }
  let ty = y0;
  const fillOn = n.fillVisible !== false && !isNone(n.fill);
  const strokeOn = n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint);
  const paintLine = (str: string, x: number, y: number, maxW?: number) => {
    if (fillOn) {
      ctx.save();
      ctx.fillStyle = textFill;
      ctx.globalAlpha *= n.fillOpacity ?? 1;
      ctx.fillText(str, x, y, maxW);
      ctx.restore();
    }
    if (strokeOn) {
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = cssRgba(n.strokePaint);
      ctx.globalAlpha *= n.strokeOpacity ?? 1;
      ctx.lineWidth = Math.max(0.5, n.strokeWidth * z);
      ctx.strokeText(str, x, y, maxW);
      ctx.restore();
    }
  };
  lines.forEach((row) => {
    const line = row.line;
    const tx =
      n.textAlign === "center" ? sx + sw / 2 : n.textAlign === "right" ? sx + sw : sx;
    const justify = n.textAlign === "justified" && wrap && !row.lastInPara && line.includes(" ");
    if (justify) {
      const words = line.trim().split(/\s+/);
      const total = words.reduce((s, w) => s + measureCached(ctx, w), 0);
      const gap = words.length > 1 ? (sw - total) / (words.length - 1) : 0;
      let x = sx;
      ctx.textAlign = "left";
      for (const w of words) {
        paintLine(w, x, ty);
        x += measureCached(ctx, w) + gap;
      }
      ctx.textAlign = "left";
    } else if (ls) {
      let x = tx;
      if (n.textAlign === "center") x = tx - (measureCached(ctx, line) + ls * Math.max(0, line.length - 1)) / 2;
      if (n.textAlign === "right") x = tx - (measureCached(ctx, line) + ls * Math.max(0, line.length - 1));
      ctx.textAlign = "left";
      for (const ch of line) {
        paintLine(ch, x, ty);
        x += measureCached(ctx, ch) + ls;
      }
      ctx.textAlign = n.textAlign === "center" ? "center" : n.textAlign === "right" ? "right" : "left";
    } else {
      paintLine(line, tx, ty, wrap ? sw : undefined);
    }
    if (fillOn && (n.textDecoration === "underline" || n.textDecoration === "strikethrough")) {
      const textWidth = measureCached(ctx, line) + ls * Math.max(0, line.length - 1);
      const yy = n.textDecoration === "underline" ? ty + size : ty + size / 2;
      const x0 = n.textAlign === "center" ? tx - textWidth / 2 : n.textAlign === "right" ? tx - textWidth : tx;
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.globalAlpha *= n.fillOpacity ?? 1;
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x0 + textWidth, yy);
      ctx.strokeStyle = cssRgba(n.fill);
      ctx.lineWidth = Math.max(1, z);
      ctx.stroke();
      ctx.restore();
    }
    ty += lh + (row.lastInPara ? paraGap : 0);
  });
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
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

const booleanCanvases = new Map<string, HTMLCanvasElement>();

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
  let oc = booleanCanvases.get(n.id);
  if (!oc) {
    oc = document.createElement("canvas");
    booleanCanvases.set(n.id, oc);
  }
  if (oc.width !== w || oc.height !== h) {
    oc.width = w;
    oc.height = h;
  }
  const o = oc.getContext("2d");
  if (!o) return;
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalAlpha = 1;
  o.globalCompositeOperation = "source-over";
  o.filter = "none";
  o.clearRect(0, 0, w, h);
  const kids = n.children.filter((c) => c.visible);
  const draw = (c: XNode, op: GlobalCompositeOperation) => {
    o.globalCompositeOperation = op;
    o.save();
    const sx = c.x * z;
    const sy = c.y * z;
    const cx = sx + (c.w * z) / 2;
    const cy = sy + (c.h * z) / 2;
    if (c.rotation || c.flipH || c.flipV) {
      o.translate(cx, cy);
      if (c.rotation) o.rotate((c.rotation * Math.PI) / 180);
      if (c.flipH || c.flipV) o.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
      o.translate(-cx, -cy);
    }
    const path = shapePoly(c);
    tracePath(o, path, sx, sy, z, c.closed || (c.kind !== "line" && c.kind !== "arrow"));
    o.fillStyle = "#ffffff";
    o.fill();
    o.restore();
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
  o.globalCompositeOperation = "source-in";
  o.fillStyle = fillStyle(o, n, 0, 0, w, h);
  o.globalAlpha = n.fillVisible === false ? 0 : n.fillOpacity ?? 1;
  o.fillRect(0, 0, w, h);
  ctx.drawImage(oc, snap.panX + px * z, snap.panY + py * z);
  if (booleanCanvases.size > 64) {
    const first = booleanCanvases.keys().next().value;
    if (first) booleanCanvases.delete(first);
  }
}
