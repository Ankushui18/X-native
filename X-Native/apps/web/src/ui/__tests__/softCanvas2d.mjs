/**
 * A small software Canvas2D, plus the canvas and layers-panel mount helpers,
 * shared by the mask tests (run 5's per-pixel alpha, run 6's mask reach).
 *
 * The recording contexts in this folder can prove that a composite op was
 * *asked for*; they cannot prove what the pixels did. This one executes the
 * paint for real - rect paths, solid and linear/radial gradient fills,
 * globalAlpha, source-over and destination-in, scaled tile blits, clip rects,
 * filters and strokes - into a plain Uint8ClampedArray, so a test can read the
 * alpha a painter produced. Text, effects and hit-test calls are no-ops.
 *
 * Tiles are never inserted into the document, so the DOM cannot find every
 * context the paint creates: `contexts` is the registry, in creation order.
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node } from "../../engine/memory.ts";

/** The mask tolerance: 6% of the 0..1 alpha scale. */
export const near = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------------- *
 * A tiny software Canvas2D.
 *
 * Only what the paint path needs for a rectangle + gradient scene: an affine
 * CTM (the canvas paints in device coordinates, the tiles included), rect
 * paths, solid and linear-gradient fills, globalAlpha, source-over and
 * destination-in, and the pixel read-back the non-alpha mask reductions use.
 * Unknown calls are no-ops so text, effects and hit-test paths stay harmless.
 * ------------------------------------------------------------------------- */
let ctxSeq = 0;
/** Every context this file hands out, tiles included (tiles are never in the
 *  document, so the DOM cannot find them). */
export const contexts = [];
function makeContext(el) {
  const stack = [];
  let buf = null;
  let bw = 0;
  let bh = 0;
  let path = [];
  let clip = null;
  const strokes = [];
  ctxSeq++;
  const ctx = {
    canvas: el,
    __id: ctxSeq,
    m: [1, 0, 0, 1, 0, 0],
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "10px sans-serif",
    filter: "none",
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    textAlign: "left",
    textBaseline: "alphabetic",
    lineJoin: "miter",
    lineCap: "butt",
    /** The strokes this context was asked to paint, in order. */
    strokes,
    /** Every filter the paint asked for, so a mask blur is provable. */
    filters: [],
  };
  Object.defineProperty(ctx, "filter", {
    configurable: true,
    get: () => ctx.__filter ?? "none",
    set: (v) => {
      ctx.__filter = v;
      ctx.filters.push(v);
    },
  });
  const inDoc = () => document.body.contains(el);
  const ensure = () => {
    const w = Math.max(1, Number(el.width) || 1);
    const h = Math.max(1, Number(el.height) || 1);
    if (!buf || w !== bw || h !== bh) {
      bw = w;
      bh = h;
      buf = new Uint8ClampedArray(bw * bh * 4);
    }
    return buf;
  };
  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const bbox = (m, x, y, w, h) => {
    const c = [pt(m, x, y), pt(m, x + w, y), pt(m, x, y + h), pt(m, x + w, y + h)];
    return [
      Math.min(...c.map((p) => p[0])),
      Math.min(...c.map((p) => p[1])),
      Math.max(...c.map((p) => p[0])),
      Math.max(...c.map((p) => p[1])),
    ];
  };
  const parse = (v) => {
    if (typeof v !== "string") return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]{3,8})$/i.exec(v.trim());
    if (hex) {
      const d = hex[1];
      const p = (i, l) => parseInt(d.slice(i, i + l), 16);
      if (d.length === 3 || d.length === 4)
        return [
          p(0, 1) * 17,
          p(1, 1) * 17,
          p(2, 1) * 17,
          d.length === 4 ? (p(3, 1) * 17) / 255 : 1,
        ];
      return [
        d.length >= 6 ? p(0, 2) : 0,
        d.length >= 6 ? p(2, 2) : 0,
        d.length >= 6 ? p(4, 2) : 0,
        d.length >= 8 ? p(6, 2) / 255 : 1,
      ];
    }
    const fn = /^rgba?\(([^)]+)\)$/i.exec(v.trim());
    if (fn) {
      const parts = fn[1].split(",").map((s) => parseFloat(s));
      return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? parts[3] : 1];
    }
    return [0, 0, 0, 0];
  };
  const write = (x, y, rgba, alpha, op) => {
    const b = ensure();
    if (x < 0 || y < 0 || x >= bw || y >= bh) return;
    if (clip && (x < clip[0] || y < clip[1] || x >= clip[2] || y >= clip[3])) return;
    const i = (y * bw + x) * 4;
    const sa = Math.max(0, Math.min(1, (rgba[3] ?? 1) * alpha));
    if (op === "destination-in") {
      const k = 1 - sa;
      b[i + 3] = Math.round(b[i + 3] * (1 - k));
      return;
    }
    const da = b[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) {
      b[i] = b[i + 1] = b[i + 2] = b[i + 3] = 0;
      return;
    }
    for (let c = 0; c < 3; c++) {
      b[i + c] = Math.round((rgba[c] * sa + b[i + c] * da * (1 - sa)) / oa);
    }
    b[i + 3] = Math.round(oa * 255);
  };
  const gradColor = (g, px, py) => {
    const [x0, y0] = pt(g.m, g.x0, g.y0);
    const [x1, y1] = pt(g.m, g.x1, g.y1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    let u = ((px + 0.5 - x0) * dx + (py + 0.5 - y0) * dy) / len2;
    u = Math.max(0, Math.min(1, u));
    const stops = g.stops;
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (u >= stops[i].pos && u <= stops[i + 1].pos) {
        a = stops[i];
        b = stops[i + 1];
        break;
      }
    }
    const span = b.pos - a.pos || 1;
    const k = Math.max(0, Math.min(1, (u - a.pos) / span));
    return [0, 1, 2, 3].map((c) => a.rgba[c] + (b.rgba[c] - a.rgba[c]) * k);
  };
  const fill = (x0, y0, x1, y1, style) => {
    const b = ensure();
    const op = ctx.globalCompositeOperation;
    const alpha = ctx.globalAlpha;
    const isGrad = style && typeof style === "object" && style.stops;
    const solid = isGrad ? null : parse(style);
    const dx0 = Math.max(0, Math.floor(x0));
    const dy0 = Math.max(0, Math.floor(y0));
    const dx1 = Math.min(bw, Math.ceil(x1));
    const dy1 = Math.min(bh, Math.ceil(y1));
    for (let y = dy0; y < dy1; y++) {
      for (let x = dx0; x < dx1; x++) {
        write(x, y, isGrad ? gradColor(style, x, y) : solid, alpha, op);
      }
    }
    void b;
  };
  const soft = new Proxy(ctx, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        switch (key) {
          case "save":
            stack.push([
              [...target.m],
              target.globalAlpha,
              target.globalCompositeOperation,
              target.fillStyle,
              target.strokeStyle,
              clip ? [...clip] : null,
            ]);
            break;
          case "restore": {
            const s = stack.pop();
            if (s) {
              target.m = s[0];
              target.globalAlpha = s[1];
              target.globalCompositeOperation = s[2];
              target.fillStyle = s[3];
              target.strokeStyle = s[4];
              clip = s[5];
            }
            break;
          }
          case "setTransform":
            target.m =
              args.length === 6
                ? [...args]
                : [args[0], args[1], args[2], args[3], 0, 0];
            break;
          case "translate":
            target.m = mul(target.m, [1, 0, 0, 1, args[0], args[1]]);
            break;
          case "scale":
            target.m = mul(target.m, [args[0], 0, 0, args[1], 0, 0]);
            break;
          case "rotate":
            target.m = mul(target.m, [
              Math.cos(args[0]),
              Math.sin(args[0]),
              -Math.sin(args[0]),
              Math.cos(args[0]),
              0,
              0,
            ]);
            break;
          case "getTransform":
            return { a: target.m[0], b: target.m[1], c: target.m[2], d: target.m[3], e: target.m[4], f: target.m[5] };
          case "beginPath":
            path = [];
            break;
          case "rect":
          case "roundRect":
            path.push([args[0], args[1], args[2], args[3]]);
            break;
          case "moveTo":
          case "lineTo":
          case "closePath":
          case "ellipse":
          case "arcTo":
          case "arc":
            break;
          case "fill": {
            const m = [...target.m];
            for (const r of path) {
              const [x0, y0, x1, y1] = bbox(m, r[0], r[1], r[2], r[3]);
              fill(x0, y0, x1, y1, target.fillStyle);
            }
            if (!path.length) {
              const [x0, y0, x1, y1] = bbox(target.m, 0, 0, bw, bh);
              fill(x0, y0, x1, y1, target.fillStyle);
            }
            break;
          }
          case "fillRect":
            {
              const [x0, y0, x1, y1] = bbox(target.m, args[0], args[1], args[2], args[3]);
              fill(x0, y0, x1, y1, target.fillStyle);
            }
            break;
          case "clip": {
            if (!path.length) break;
            const [x0, y0, x1, y1] = bbox(target.m, path[0][0], path[0][1], path[0][2], path[0][3]);
            clip = clip
              ? [Math.max(clip[0], x0), Math.max(clip[1], y0), Math.min(clip[2], x1), Math.min(clip[3], y1)]
              : [x0, y0, x1, y1];
            break;
          }
          case "drawImage": {
            const [src, a0, a1, a2, a3] = args;
            if (!src || !src.__ctx) break;
            const sb = src.__ctx.getImageData(0, 0, src.width, src.height);
            const sw = src.width;
            const sh = src.height;
            let rect;
            if (a2 === undefined) {
              const p0 = pt(target.m, a0, a1);
              const p1 = pt(target.m, a0 + sw, a1 + sh);
              rect = [p0[0], p0[1], p1[0], p1[1]];
            } else {
              rect = bbox(target.m, a0, a1, a2, a3);
            }
            const dw = rect[2] - rect[0];
            const dh = rect[3] - rect[1];
            if (!dw || !dh) break;
            const op = target.globalCompositeOperation;
            const alpha = target.globalAlpha;
            const b = ensure();
            const [dx0, dy0, dx1, dy1] = [
              Math.max(0, Math.floor(rect[0])),
              Math.max(0, Math.floor(rect[1])),
              Math.min(bw, Math.ceil(rect[2])),
              Math.min(bh, Math.ceil(rect[3])),
            ];
            for (let y = dy0; y < dy1; y++) {
              for (let x = dx0; x < dx1; x++) {
                const sx = Math.min(sw - 1, Math.max(0, Math.floor(((x + 0.5 - rect[0]) / dw) * sw)));
                const sy = Math.min(sh - 1, Math.max(0, Math.floor(((y + 0.5 - rect[1]) / dh) * sh)));
                const si = (sy * sw + sx) * 4;
                write(
                  x,
                  y,
                  [sb.data[si], sb.data[si + 1], sb.data[si + 2], sb.data[si + 3] / 255],
                  alpha,
                  op,
                );
              }
            }
            void b;
            break;
          }
          case "createLinearGradient": {
            const g = { m: [...target.m], x0: args[0], y0: args[1], x1: args[2], y1: args[3], stops: [] };
            g.addColorStop = (pos, color) => {
              g.stops.push({ pos: Math.max(0, Math.min(1, pos)), rgba: parse(color) });
            };
            return g;
          }
          case "createRadialGradient": {
            const g = { m: [...target.m], x0: args[0], y0: args[1], x1: args[0], y1: args[1], stops: [] };
            g.addColorStop = (pos, color) => g.stops.push({ pos, rgba: parse(color) });
            return g;
          }
          case "createPattern":
            return null;
          case "measureText":
            return { width: String(args[0] ?? "").length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 };
          case "getImageData": {
            const bb = ensure();
            const [gx, gy, gw, gh] = args;
            const out = new Uint8ClampedArray(gw * gh * 4);
            for (let y = 0; y < gh; y++) {
              for (let x = 0; x < gw; x++) {
                const si = ((gy + y) * bw + (gx + x)) * 4;
                const di = (y * gw + x) * 4;
                if (si < 0 || si + 3 >= bb.length) continue;
                out[di] = bb[si];
                out[di + 1] = bb[si + 1];
                out[di + 2] = bb[si + 2];
                out[di + 3] = bb[si + 3];
              }
            }
            return { data: out, width: gw, height: gh };
          }
          case "putImageData": {
            const img = args[0];
            const [px, py] = [args[1], args[2]];
            const bb = ensure();
            for (let y = 0; y < img.height; y++) {
              for (let x = 0; x < img.width; x++) {
                const si = (y * img.width + x) * 4;
                const di = ((py + y) * bw + (px + x)) * 4;
                if (di < 0 || di + 3 >= bb.length) continue;
                bb[di] = img.data[si];
                bb[di + 1] = img.data[si + 1];
                bb[di + 2] = img.data[si + 2];
                bb[di + 3] = img.data[si + 3];
              }
            }
            break;
          }
          case "stroke":
            strokes.push({ color: target.strokeStyle, inDoc: inDoc(), id: ctx.__id });
            break;
          case "strokeRect":
            strokes.push({ color: target.strokeStyle, inDoc: inDoc(), id: ctx.__id });
            break;
          case "setLineDash":
          case "getLineDash":
            return key === "getLineDash" ? [] : undefined;
          case "clearRect": {
            const [x0, y0, x1, y1] = bbox(target.m, args[0], args[1], args[2], args[3]);
            const bb = ensure();
            for (let y = Math.max(0, y0 | 0); y < Math.min(bh, y1); y++) {
              for (let x = Math.max(0, x0 | 0); x < Math.min(bw, x1); x++) {
                const i = (y * bw + x) * 4;
                bb[i] = bb[i + 1] = bb[i + 2] = bb[i + 3] = 0;
              }
            }
            break;
          }
          default:
            break;
        }
        return undefined;
      };
    },
  });
  soft.__pixels = () => ensure();
  soft.__size = () => [bw, bh];
  Object.defineProperty(el, "__ctx", { value: soft, configurable: true });
  contexts.push(soft);
  return soft;
}


const window = installDom();
window.HTMLCanvasElement.prototype.getContext = function () {
  if (!this.__ctx) makeContext(this);
  return this.__ctx;
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 50,
  top: 30,
  x: 50,
  y: 30,
  width: 1000,
  height: 800,
  right: 1050,
  bottom: 830,
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { LeftPanel } = await import("../chrome.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;


const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });

export async function mountCanvas(children, view = {}) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(...children), guides: [], comments: [] }],
    page: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    ...view,
  });
  function Host() {
    const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap }));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  await act(async () => reactRoot.render(React.createElement(Host)));
  const canvasEl = host.querySelector("canvas");
  const ui = {
    engine,
    host,
    ctx: canvasEl.__ctx,
    /** The raw device pixel at a screen coordinate: alpha is 0..1. */
    pixelAt(x, y) {
      const b = canvasEl.__ctx.__pixels();
      const w = canvasEl.__ctx.__size()[0];
      const i = (y * w + x) * 4;
      return { r: b[i], g: b[i + 1], b: b[i + 2], a: b[i + 3] / 255 };
    },
    // Screen pixel (the paint runs in device coordinates: the app folds zoom
    // into the geometry, and 1 CSS px is 1 device px in jsdom).
    alphaAt(x, y) {
      const b = canvasEl.__ctx.__pixels();
      const w = canvasEl.__ctx.__size()[0];
      const i = (y * w + x) * 4;
      const [r, g, bl, a] = [b[i], b[i + 1], b[i + 2], b[i + 3]];
      if (a === 0) return { a: 0, r, g, bl };
      // The layer is #3b82f6 over the page's white fill, so the channel mix
      // recovers the composited coverage of the masked content.
      return { a: (255 - r) / (255 - 59), r, g, bl };
    },
    async dispatch(cmd) {
      await act(async () => engine.dispatch(cmd));
    },
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
  return ui;
}

export async function mountPanel(children) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(...children), guides: [], comments: [] }],
    page: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  function Host() {
    const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(LeftPanel, { engine, snap, nav: "file", onMinimize() {} }));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  await act(async () => reactRoot.render(React.createElement(Host)));
  return {
    engine,
    host,
    rows: () =>
      [...host.querySelectorAll(".tree [data-row-id]")].map((row) => ({
        id: row.getAttribute("data-row-id"),
        name: (row.querySelector(".name")?.textContent || "").trim(),
        badged: !!row.querySelector(".mask-child-badge"),
        upArrow: !!row.querySelector(".mask-child-badge [data-mask-arrow='up']"),
        maskIcon: !!row.querySelector("svg circle"),
      })),
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
}
