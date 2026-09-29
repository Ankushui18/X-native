/**
 * A *real* Canvas2D backend for the mounted canvas — the instrument the effects
 * audit needs.
 *
 * `src/ui/__tests__/softCanvas2d.mjs` rasterises rectangles and gradients into
 * a plain Uint8ClampedArray, which is enough to read mask alpha, but it records
 * `ctx.filter` and never executes it. Every question in this audit is about what
 * a filter *does* to pixels, so this harness swaps that software backend for
 * Skia (`@napi-rs/canvas`, the same engine family Chromium uses): blur, shadow
 * blur, clip-after-filter and composite operations all run for real, and the
 * app's own paint path (`ui/Canvas.tsx` → `engine/paint.ts`) is unchanged.
 *
 * The DOM is still jsdom (there is no Chromium in the sandbox). Each jsdom
 * `<canvas>` is attached to a Skia surface; `getContext("2d")` hands back a
 * proxy over the Skia context that maps the few arguments jsdom cannot express:
 * canvas/image *sources* for `drawImage`/`createPattern`, `ctx.canvas`, and
 * `width`/`height` writes that have to resize the surface underneath.
 *
 * Why a second backend: this folder's other harness (`softCanvas2d.mjs`) records
 * `ctx.filter` and never executes it, and its pixel model has no shadows at all,
 * so every question about what a blur or a shadow *does* needs a real rasteriser.
 * `@napi-rs/canvas` is a devDependency for exactly this.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { installDom } from "./domEnv.mjs";

export { createCanvas, loadImage };

const window = installDom();

/** jsdom element -> Skia surface. */
const backings = new WeakMap();
/** src -> decoded Skia image (or canvas), so `imageSrc` layers can paint. */
const imageSources = new Map();
/** Sources a draw call asked for that the probe never registered. */
export const unregisteredSources = [];

/** Make `src` resolvable by `<img>` layers and `drawImage`. */
export function registerImage(src, skiaSource) {
  imageSources.set(src, skiaSource);
  return skiaSource;
}

/** Draw a PNG with a transparent region and return its `src`. */
export async function makeImage(src, w, h, draw) {
  const c = createCanvas(w, h);
  const x = c.getContext("2d");
  draw(x, c);
  const url = c.toDataURL("image/png");
  imageSources.set(src, await loadImage(url));
  imageSources.set(url, imageSources.get(src));
  return url;
}

function attach(el) {
  const w = Math.max(1, Math.floor(Number(el.width) || 300));
  const h = Math.max(1, Math.floor(Number(el.height) || 150));
  const sk = createCanvas(w, h);
  backings.set(el, sk);
  // A browser canvas resets when width/height is assigned, and the paint code
  // assigns before it asks for the context. Mirror both onto the surface.
  for (const prop of ["width", "height"]) {
    Object.defineProperty(el, prop, {
      configurable: true,
      get: () => sk[prop],
      set: (v) => {
        sk[prop] = Math.max(1, Math.floor(Number(v) || 0));
      },
    });
  }
  el.toDataURL = (...args) => sk.toDataURL(...args);
  return sk;
}

function sourceOf(src) {
  if (src && src.__probeCanvas) return src.__probeCanvas;
  if (src && backings.has(src)) return backings.get(src);
  if (src && typeof src === "object" && "naturalWidth" in src) {
    const hit = imageSources.get(src.currentSrc || src.src);
    if (hit) return hit;
    if (src.src) unregisteredSources.push(src.src);
    return null;
  }
  return src;
}

function contextFor(el) {
  const sk = backings.get(el) || attach(el);
  const real = sk.getContext("2d");
  if (el.__probeCtx) return el.__probeCtx;
  const wrapped = new Proxy(real, {
    get(t, key) {
      if (key === "canvas") return el;
      if (key === "drawImage") {
        return (...args) => {
          const src = sourceOf(args[0]);
          if (!src) return;
          t.drawImage(src, ...args.slice(1));
        };
      }
      if (key === "createPattern") {
        return (src, repeat) => {
          const s = sourceOf(src);
          return s ? t.createPattern(s, repeat) : null;
        };
      }
      const v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, key, v) {
      t[key] = v;
      return true;
    },
  });
  Object.defineProperty(el, "__probeCtx", { value: wrapped, configurable: true });
  el.__probeCanvas = sk;
  return wrapped;
}

window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== "2d") return null;
  return contextFor(this);
};
// `paintImageFill` type-tests the source, so the class has to exist as a global.
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830,
});

// `imgOf` keeps an `HTMLImageElement` per src and paints only once it reports
// `complete && naturalWidth`. jsdom never decodes anything, so the images the
// probe registered stand in for the network load.
class ProbeImage {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.currentSrc = "";
    this._src = "";
  }
  get src() {
    return this._src;
  }
  set src(v) {
    this._src = v;
    const hit = imageSources.get(v);
    this.complete = !!hit;
    this.naturalWidth = hit?.width ?? 0;
    this.naturalHeight = hit?.height ?? 0;
    this.currentSrc = v;
    if (this.complete) queueMicrotask(() => this.onload?.());
  }
  addEventListener(type, fn) {
    if (type === "load") this.onload = fn;
  }
}
window.Image = ProbeImage;
globalThis.Image = ProbeImage;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("./../Canvas.tsx");
const { ThemeProvider } = await import("./../theme.tsx");
const { MemoryEngine, node } = await import("../../engine/memory.ts");
const { act, useSyncExternalStore } = React;

const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });

/**
 * Mount the real canvas over the real backend.
 *
 * `pixelAt(x, y)` reads the *composited* device pixel (the page's own white
 * fill included), which is exactly what a person sees.
 */
export async function mountRealCanvas(children, view = {}) {
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
  const surface = canvasEl.__probeCanvas;
  const read = () => {
    const w = surface.width;
    const h = surface.height;
    return surface.getContext("2d").getImageData(0, 0, w, h);
  };
  const ui = {
    engine,
    host,
    canvasEl,
    surface,
    get ctx() {
      return canvasEl.getContext("2d");
    },
    /** Composited pixel, RGBA 0..255. Reads the whole surface: prefer grab(). */
    px(x, y) {
      const img = read();
      const i = (y * img.width + x) * 4;
      return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] / 255 };
    },
    /** One surface read, then a cheap per-pixel reader over it. */
    grab() {
      const img = read();
      const f = (x, y) => {
        const i = (y * img.width + x) * 4;
        return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] / 255 };
      };
      f.coverage = (x, y) => (255 - f(x, y).r) / 255;
      f.row = (y, x0, x1) => Array.from({ length: x1 - x0 + 1 }, (_, k) => f.coverage(x0 + k, y));
      return f;
    },
    /** Alpha the layer paints over the page's white fill, 0..1. */
    coverage(x, y) {
      const p = this.px(x, y);
      return (255 - p.r) / 255;
    },
    row(y, x0, x1) {
      return Array.from({ length: x1 - x0 + 1 }, (_, k) => this.coverage(x0 + k, y));
    },
    col(x, y0, y1) {
      return Array.from({ length: y1 - y0 + 1 }, (_, k) => this.coverage(x, y0 + k));
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
