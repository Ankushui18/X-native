/**
 * Run 5 - Figma parity, masks: per-pixel alpha and the two mask indicators.
 *
 * Source of truth: Figma's *Masks* article,
 * https://help.figma.com/hc/en-us/articles/360040450253-Masks
 *  - "When working with alpha masks, masks are applied based on the opacity of
 *    the mask. The higher the opacity, the more that is revealed. Zero percent
 *    opacity reveals nothing. This means we can utilize blurs and opacity in our
 *    masks: ... Use layer blur effects to replicate feathering ... Add fills,
 *    strokes, and gradients with varying opacity"
 *  - "If a mask contains any area with an opacity of more than zero percent,
 *    then its outlines are used as the mask and the entire mask assumes 100%
 *    opacity." (vector)
 *  - "Luminance ... The brighter the area of a mask, the more that is revealed".
 *  - "Once the setting on, masks in your file are outlined in green. Note: If
 *    all layers being masked are hidden or have zero percent opacity, then the
 *    object's mask outlines won't appear."
 *  - "the mask icon identifies the mask, with an upward-facing arrow along the
 *    layers that are being masked"
 *  - "To stop using an object as a mask ... Right-click the mask and select
 *    Remove mask ... toggle it off"
 *
 * The alpha half runs against a small software Canvas2D (rect fills, linear
 * gradients, tile blits, destination-in, getImageData/putImageData) so the
 * feathered edge is *measured in pixel alpha*, not inferred from a call log:
 * the recorded-call tests in this folder can only prove that a composite op was
 * asked for. What this file cannot cover stays flagged in the comparison doc:
 * real GPU filtering, font rasterisation and browser cursor feedback.
 *
 * Run: vite-node src/ui/__tests__/maskAlpha.test.mjs
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find } from "../../engine/memory.ts";
import { partitionMaskRuns, reduceMaskAlpha } from "../../engine/paint.ts";
import { runMenu, layerMenu, canvasMenu } from "../ContextMenu.tsx";

let pass = 0,
  fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? ` - ${extra}` : ""}`);
};
const near = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;

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
const contexts = [];
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
const softMask = (extra = {}) =>
  node("rect", "Gradient mask", 0, 0, 100, 100, {
    isMask: true,
    fillType: "linear",
    fill: "#ffffff",
    fillVisible: true,
    fillGX: 0,
    fillGY: 0.5,
    fillHX: 1,
    fillHY: 0.5,
    gradientStops: [
      { color: "#ffffffff", position: 0 },
      { color: "#00000000", position: 1 },
    ],
    ...extra,
  });
const content = (extra = {}) => node("rect", "Content", 0, 0, 100, 100, { fill: "#3b82f6", ...extra });
const pair = (mask, kid = content(), extra = {}) =>
  node("frame", "Mask object", 0, 0, 100, 100, {
    // An explicit white background keeps the sampled pixels readable: the
    // revealed coverage is (255 - red) / (255 - 59) against white.
    fill: "#ffffff",
    fillVisible: true,
    children: [mask, kid],
    ...extra,
  });

async function mountCanvas(children, view = {}) {
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

/* ------------------------------------------------------------------ *
 * 1. Alpha masks are per-pixel: a gradient reveals a soft ramp.
 * ------------------------------------------------------------------ */
{
  const mask = softMask();
  const ui = await mountCanvas([pair(mask)]);
  const at = (x) => ui.alphaAt(x, 50).a;
  const ramp = [5, 25, 50, 75, 95].map(at);
  const monotone = ramp.every((v, i) => i === 0 || v <= ramp[i - 1] + 0.02);
  t("alpha mask: gradient mask reveals a monotone ramp", monotone, JSON.stringify(ramp.map((v) => +v.toFixed(3))));
  t("alpha mask: opaque end of the mask is fully revealed", near(ramp[0], 0.95, 0.08), `a(5px)=${ramp[0].toFixed(3)}`);
  t("alpha mask: transparent end reveals (almost) nothing", near(ramp[4], 0.05, 0.08), `a(95px)=${ramp[4].toFixed(3)}`);
  t("alpha mask: the midpoint is half revealed, not clipped", near(ramp[2], 0.5, 0.1), `a(50px)=${ramp[2].toFixed(3)}`);
  const soft = [];
  for (let x = 0; x < 100; x++) {
    const a = at(x);
    if (a > 0.05 && a < 0.95) soft.push(a);
  }
  t(
    "alpha mask: the edge is feathered across many pixels, not binary",
    soft.length >= 40,
    `${soft.length} pixels in the 0.05..0.95 band`,
  );
  // Every second sample has to stay near the analytic ramp (a linear gradient
  // in the mask is linear in the revealed alpha).
  const worst = [10, 20, 30, 40, 60, 70, 80, 90].reduce(
    (m, x) => Math.max(m, Math.abs(at(x) - (1 - x / 100))),
    0,
  );
  t("alpha mask: the ramp follows the mask's own opacity", worst < 0.08, `worst deviation ${worst.toFixed(3)}`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 2. Zero-percent opacity in the mask reveals nothing ("Zero percent
 *    opacity reveals nothing"), and a hidden mask hides its content.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([pair(softMask({ opacity: 0 }))]);
  t("alpha mask: a mask at 0% opacity reveals nothing", ui.alphaAt(50, 50).a === 0, `a=${ui.alphaAt(50, 50).a}`);
  await ui.close();
}
{
  const mask = softMask();
  mask.visible = false;
  const ui = await mountCanvas([pair(mask)]);
  t("hidden mask layer stops masking (no reveal at all)", ui.alphaAt(20, 50).a === 0 || ui.alphaAt(20, 50).a === 1);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 3. Vector masks ignore translucency: any painted pixel is fully opaque,
 *    so the same gradient cut as a vector mask has a hard edge.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([pair(softMask({ maskType: "vector" }))]);
  const vals = [5, 25, 50, 75, 95].map((x) => ui.alphaAt(x, 50).a);
  const binary = vals.every((v) => v < 0.02 || v > 0.98);
  t("vector mask: same gradient cuts hard, not soft", binary, JSON.stringify(vals.map((v) => +v.toFixed(3))));
  t("vector mask: painted area stays fully revealed", vals[0] > 0.98, `a(5px)=${vals[0].toFixed(3)}`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 4. Luminance masks follow brightness, and the reduction itself is the
 *    documented one.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([
    pair(
      softMask({
        maskType: "luminance",
        gradientStops: [
          { color: "#ffffffff", position: 0 },
          { color: "#000000ff", position: 1 },
        ],
      }),
    ),
  ]);
  const vals = [0, 25, 50, 75, 99].map((x) => ui.alphaAt(x, 50).a);
  const monotone = vals.every((v, i) => i === 0 || v <= vals[i - 1] + 0.02);
  t("luminance mask: brightness ramps the reveal", monotone && vals[0] > 0.9 && vals[4] < 0.1, JSON.stringify(vals.map((v) => +v.toFixed(3))));
  t("luminance mask: mid grey is about half", near(vals[2], 0.5, 0.12), `a(50px)=${vals[2].toFixed(3)}`);
  t("reduceMaskAlpha keeps Figma's three types apart", [
    reduceMaskAlpha("alpha", 10, 10, 10, 77) === 77,
    reduceMaskAlpha("vector", 10, 10, 10, 1) === 255,
    reduceMaskAlpha("vector", 10, 10, 10, 0) === 0,
    reduceMaskAlpha("luminance", 255, 255, 255, 255) === 255,
    reduceMaskAlpha("luminance", 0, 0, 0, 255) === 0,
  ].every(Boolean));
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 5. Feathering: a layer blur on the mask reaches the mask tile ("Use layer
 *    blur effects to replicate feathering"), and the mask's own paint is what
 *    feeds the clip - no reduction pass for alpha masks.
 * ------------------------------------------------------------------ */
{
  const mask = softMask();
  mask.effects = [
    { kind: "layer-blur", color: "#000000", x: 0, y: 0, blur: 12, spread: 0, visible: true },
  ];
  const ui = await mountCanvas([pair(mask)]);
  const filters = contexts.flatMap((c) => c.filters).filter((f) => f === "blur(12px)");
  t("blurred mask: the blur is applied while the mask is painted", filters.length >= 1, `${filters.length} blur(12px) assignments`);
  t("blurred mask: content is still revealed through it", ui.alphaAt(5, 50).a > 0.8, `a(5px)=${ui.alphaAt(5, 50).a.toFixed(3)}`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 6. Show mask outlines: green, on the canvas, and gone when the article says
 *    it is gone.
 * ------------------------------------------------------------------ */
// Each mount builds its own contexts (the canvas element included), so the
// count is scoped to the contexts created after the mark.
const mark = () => contexts.length;
const greenStrokes = (from = 0) =>
  contexts
    .slice(from)
    .flatMap((ctx) => ctx.strokes.map((s) => ({ ...s, color: String(s.color) })))
    .filter((s) => s.color.toLowerCase() === "#00c853");

{
  const from = mark();
  const ui = await mountCanvas([pair(softMask())]);
  const before = greenStrokes(from).length;
  await ui.dispatch({ type: "toggleMaskOutlines" });
  const on = greenStrokes(from);
  t("mask outlines off by default: no green outline", before === 0, `${before} strokes`);
  t("mask outlines on: the mask is outlined in green", on.length === 1, `${on.length} green strokes`);
  t("mask outlines land on the canvas, not inside a masked tile", on.every((s) => s.inDoc), JSON.stringify(on.map((s) => s.inDoc)));
  await ui.close();
}
{
  // "If all layers being masked are hidden or have zero percent opacity, then
  // the object's mask outlines won't appear."
  const hiddenKid = content();
  hiddenKid.visible = false;
  const from = mark();
  const ui = await mountCanvas([pair(softMask(), hiddenKid)]);
  await ui.dispatch({ type: "toggleMaskOutlines" });
  t("all masked layers hidden: no mask outline", greenStrokes(from).length === 0, `${greenStrokes(from).length} green strokes`);
  await ui.close();
}
{
  const zeroKid = content({ opacity: 0 });
  const from = mark();
  const ui = await mountCanvas([pair(softMask(), zeroKid)]);
  await ui.dispatch({ type: "toggleMaskOutlines" });
  t("all masked layers at 0% opacity: no mask outline", greenStrokes(from).length === 0, `${greenStrokes(from).length} green strokes`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 7. The layers panel: the mask glyph, and the upward arrow on the layers
 *    being masked (the ones above the mask).
 * ------------------------------------------------------------------ */
async function mountPanel(children) {
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
{
  const mask = softMask();
  const panel = await mountPanel([pair(mask, content())]);
  const rows = panel.rows();
  const maskRow = rows.find((r) => r.name === "Gradient mask");
  const kidRow = rows.find((r) => r.name === "Content");
  t("panel: the mask row is flagged with the mask glyph", !!maskRow && maskRow.maskIcon);
  t("panel: the masked layer (above the mask) carries the arrow", !!kidRow && kidRow.badged);
  t("panel: that arrow points up at the mask below", !!kidRow && kidRow.upArrow);
  t("panel: the mask's own row carries no arrow", !!maskRow && !maskRow.badged);
  t("panel: rows below the mask are not marked", rows.filter((r) => r.badged).length === 1, JSON.stringify(rows));
  await panel.close();
}
{
  // A mask above its content masks nothing (Figma: "If the mask sits above the
  // image, it won't be masked"), so no row may be marked there either.
  const mask = softMask();
  const above = node("frame", "Mask above", 0, 0, 100, 100, { children: [content(), mask] });
  const panel = await mountPanel([above]);
  const rows = panel.rows();
  t("panel: a mask on top masks nothing, so nothing is marked", rows.every((r) => !r.badged), JSON.stringify(rows));
  await panel.close();
}
{
  const maskA = softMask();
  const maskB = softMask();
  const layers = node("frame", "Two masks", 0, 0, 100, 100, { children: [maskA, content(), maskB, content()] });
  const runs = partitionMaskRuns(layers.children);
  t(
    "painter: a mask clips the siblings above it until the next mask",
    runs.length === 2 &&
      runs[0].mask === maskA &&
      runs[0].kids.length === 1 &&
      runs[1].mask === maskB &&
      runs[1].kids.length === 1,
    JSON.stringify(runs.map((r) => ({ mask: r.mask?.name, kids: r.kids.length }))),
  );
  const panel = await mountPanel([layers]);
  const rows = panel.rows();
  t("panel: each mask marks only the layers between it and the next mask", rows.filter((r) => r.badged).length === 2, JSON.stringify(rows));
  await panel.close();
}

/* ------------------------------------------------------------------ *
 * 8. Use as mask toggles: the row reads "Remove mask" and ⌃⌘M's command clears
 *    the flag ("To stop using an object as a mask ... toggle it off").
 * ------------------------------------------------------------------ */
{
  const mask = softMask();
  mask.isMask = false;
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(pair(mask, content())), guides: [], comments: [] }],
    page: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  const livePair = () => engine.snapshot().pages[0].root.children[0];
  const liveMask = () => livePair().children[0];
  const label = (isMask) =>
    [
      ...layerMenu(false, false, { mask: isMask }),
      ...canvasMenu(1, false, false, [], false, { mask: isMask }),
    ]
      .filter((r) => r.id === "useAsMask")
      .map((r) => r.label);
  engine.dispatch({ type: "select", ids: [liveMask().id] });
  t("menu: the row offers Use as mask before masking", label(false).every((l) => l === "Use as mask"), JSON.stringify(label(false)));
  await runMenu(engine, "useAsMask");
  t("use as mask sets the flag", liveMask().isMask === true);
  t("menu: the row offers Remove mask once it is one", label(true).every((l) => l === "Remove mask"), JSON.stringify(label(true)));
  const ctx = liveMask().id;
  await runMenu(engine, "useAsMask");
  t("use as mask toggles back off (⌃⌘M removes the mask)", liveMask().isMask === false, `${ctx} isMask=${liveMask().isMask}`);
  t("removing the mask leaves the layers themselves alone", livePair().children.length === 2 && !liveMask().isMask);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
