import type { GradientStop, XNode } from "./types";
import { cssRgba, parseHex, toHexA } from "../ui/color";

/** Linear sRGB → OKLab mix so ramps are smoother than canvas sRGB (and Figma’s default). */
function mixHex(a: string, b: string, t: number): string {
  const A = parseHex(a);
  const B = parseHex(b);
  const u = Math.max(0, Math.min(1, t));
  const la = rgbToOklab(A.r, A.g, A.b);
  const lb = rgbToOklab(B.r, B.g, B.b);
  const rgb = oklabToRgb(
    la[0] + (lb[0] - la[0]) * u,
    la[1] + (lb[1] - la[1]) * u,
    la[2] + (lb[2] - la[2]) * u,
  );
  return toHexA(rgb[0], rgb[1], rgb[2], A.a + (B.a - A.a) * u);
}

function lin(c: number) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function srgb(c: number) {
  const x = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * lin(r) + 0.5363325363 * lin(g) + 0.0514459929 * lin(b);
  const m = 0.2119034982 * lin(r) + 0.6806995451 * lin(g) + 0.1073969566 * lin(b);
  const s = 0.0883024619 * lin(r) + 0.2817188376 * lin(g) + 0.6299787005 * lin(b);
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    srgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    srgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * Resolve a node's ramp to a sorted stop list, falling back to the legacy
 * two-colour `fill`/`fillB` pair when no explicit stops are authored.
 */
function stopsOf(n: XNode): GradientStop[] {
  const raw = n.gradientStops ?? [];
  if (raw.length >= 2) {
    return [...raw].sort((p, q) => p.position - q.position);
  }
  return [
    { color: n.fill, position: 0 },
    { color: n.fillB || "#ffffff", position: 1 },
  ];
}

/**
 * Paint a ramp onto a canvas gradient.
 *
 * Each adjacent pair is subdivided and interpolated in OKLab, which keeps
 * mid-tones from going grey the way canvas' native sRGB interpolation does.
 */
/** Compress a ramp into 0..0.5 and mirror it into 0.5..1 for conic sweeps. */
function conicStops(stops: GradientStop[]): GradientStop[] {
  const fwd = stops.map((s) => ({ color: s.color, position: s.position / 2 }));
  const back = [...stops]
    .reverse()
    .map((s) => ({ color: s.color, position: 1 - s.position / 2 }));
  return [...fwd, ...back];
}

function ramp(g: CanvasGradient, stops: GradientStop[]) {
  const per = 6;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    for (let k = 0; k <= per; k++) {
      const t = k / per;
      const pos = a.position + (b.position - a.position) * t;
      try {
        g.addColorStop(Math.max(0, Math.min(1, pos)), mixHex(a.color, b.color, t));
      } catch {
        /* invalid stop */
      }
    }
  }
}

export function fillStyle(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): string | CanvasGradient {
  const stops = stopsOf(n);
  const a = stops[0].color;
  const gx = n.fillGX ?? 0.5;
  const gy = n.fillGY ?? 0;
  const hx = n.fillHX ?? 0.5;
  const hy = n.fillHY ?? 1;
  if (n.fillType === "linear") {
    const g = ctx.createLinearGradient(sx + gx * sw, sy + gy * sh, sx + hx * sw, sy + hy * sh);
    ramp(g, stops);
    return g;
  }
  if (n.fillType === "radial") {
    const cx = sx + gx * sw;
    const cy = sy + gy * sh;
    const r = Math.hypot((hx - gx) * sw, (hy - gy) * sh) || Math.max(sw, sh) / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    ramp(g, stops);
    return g;
  }
  if (n.fillType === "angular" && typeof ctx.createConicGradient === "function") {
    const ang = Math.atan2((hy - gy) * sh, (hx - gx) * sw);
    const g = ctx.createConicGradient(ang, sx + gx * sw, sy + gy * sh);
    ramp(g, conicStops(stops));
    return g;
  }
  return cssRgba(a);
}

/**
 * Paint a node's fill stack: the base `fill` first, then any extra `fills`
 * on top, bottom-to-top the way Figma layers them. The current path must
 * already be set by the caller.
 */
export function paintFill(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
) {
  paintOnePaint(ctx, n, sx, sy, sw, sh);
  for (const p of n.fills ?? []) {
    if (p.visible === false) continue;
    // Each extra fill is described by a Paint; project it onto the same
    // node-shaped surface by borrowing the node's geometry fields.
    const layer: XNode = {
      ...n,
      fill: p.color,
      fillType: p.type,
      fillOpacity: p.opacity,
      gradientStops: p.stops ?? [],
      fillGX: p.gx ?? n.fillGX,
      fillGY: p.gy ?? n.fillGY,
      fillHX: p.hx ?? n.fillHX,
      fillHY: p.hy ?? n.fillHY,
      fills: undefined,
    };
    ctx.save();
    if (p.blend && p.blend !== "normal") {
      ctx.globalCompositeOperation = p.blend as GlobalCompositeOperation;
    }
    if (p.opacity != null && p.opacity < 1) ctx.globalAlpha *= p.opacity;
    paintOnePaint(ctx, layer, sx, sy, sw, sh);
    ctx.restore();
  }
}

function paintOnePaint(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
) {
  const a = n.fill;
  const stops = stopsOf(n);
  const gx = n.fillGX ?? 0.5;
  const gy = n.fillGY ?? 0;
  const hx = n.fillHX ?? 0.5;
  const hy = n.fillHY ?? 1;
  if (n.fillType === "diamond") {
    paintDiamond(ctx, n, sx, sy, sw, sh);
    return;
  }
  if (n.fillType === "radial") {
    ctx.save();
    ctx.clip();
    const cx = sx + gx * sw;
    const cy = sy + gy * sh;
    const rn = Math.hypot(hx - gx, hy - gy) || 0.5;
    ctx.translate(cx, cy);
    ctx.scale(Math.max(0.001, sw * rn), Math.max(0.001, sh * rn));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    ramp(g, stops);
    ctx.fillStyle = g;
    ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();
    return;
  }
  if (n.fillType === "linear") {
    const g = ctx.createLinearGradient(sx + gx * sw, sy + gy * sh, sx + hx * sw, sy + hy * sh);
    ramp(g, stops);
    ctx.fillStyle = g;
    ctx.fill();
    return;
  }
  if (n.fillType === "angular" && typeof ctx.createConicGradient === "function") {
    const ang = Math.atan2((hy - gy) * sh, (hx - gx) * sw);
    const g = ctx.createConicGradient(ang, sx + gx * sw, sy + gy * sh);
    // A cone wraps, so mirror the ramp back to the first colour at t=1 to
    // avoid a hard seam at the sweep origin.
    ramp(g, conicStops(stops));
    ctx.fillStyle = g;
    ctx.fill();
    return;
  }
  ctx.fillStyle = cssRgba(a);
  ctx.fill();
}

function paintDiamond(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
) {
  const stops = stopsOf(n);
  const gx = n.fillGX ?? 0.5;
  const gy = n.fillGY ?? 0.5;
  const hx = n.fillHX ?? 0.5;
  const hy = n.fillHY ?? 1;
  const cx = sx + gx * sw;
  const cy = sy + gy * sh;
  const rx = Math.abs((hx - gx) * sw) || sw / 2;
  const ry = Math.abs((hy - gy) * sh) || sh / 2;
  const mids: [number, number][] = [
    [cx, cy - ry],
    [cx + rx, cy],
    [cx, cy + ry],
    [cx - rx, cy],
  ];
  ctx.save();
  ctx.clip();
  for (let i = 0; i < 4; i++) {
    const p = mids[i];
    const q = mids[(i + 1) % 4];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p[0], p[1]);
    ctx.lineTo(q[0], q[1]);
    ctx.closePath();
    ctx.clip();
    const g = ctx.createLinearGradient(cx, cy, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    ramp(g, stops);
    ctx.fillStyle = g;
    ctx.fillRect(sx - rx, sy - ry, sw + rx * 2, sh + ry * 2);
    ctx.restore();
  }
  ctx.restore();
}

const imgCache = new Map<string, HTMLCanvasElement>();

function clampByte(n: number) {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function adjKey(n: XNode) {
  return [
    n.imageSrc,
    n.imageRot | 0,
    n.imageExposure || 0,
    n.imageContrast || 0,
    n.imageSaturation || 0,
    n.imageTemperature || 0,
    n.imageTint || 0,
    n.imageHighlights || 0,
    n.imageShadows || 0,
  ].join("|");
}

function hasAdj(n: XNode) {
  return !!(
    n.imageExposure ||
    n.imageContrast ||
    n.imageSaturation ||
    n.imageTemperature ||
    n.imageTint ||
    n.imageHighlights ||
    n.imageShadows ||
    n.imageRot
  );
}

function processImage(im: HTMLImageElement, n: XNode): CanvasImageSource {
  if (!hasAdj(n)) return im;
  const key = adjKey(n);
  const hit = imgCache.get(key);
  if (hit) return hit;
  const rot = ((n.imageRot % 360) + 360) % 360;
  const iw = im.naturalWidth;
  const ih = im.naturalHeight;
  const swap = rot === 90 || rot === 270;
  const c = document.createElement("canvas");
  c.width = swap ? ih : iw;
  c.height = swap ? iw : ih;
  const x = c.getContext("2d");
  if (!x) return im;
  x.save();
  x.translate(c.width / 2, c.height / 2);
  x.rotate((rot * Math.PI) / 180);
  x.drawImage(im, -iw / 2, -ih / 2);
  x.restore();
  const exp = n.imageExposure || 0;
  const con = n.imageContrast || 0;
  const sat = n.imageSaturation || 0;
  const temp = n.imageTemperature || 0;
  const tint = n.imageTint || 0;
  const hi = n.imageHighlights || 0;
  const sh = n.imageShadows || 0;
  if (exp || con || sat || temp || tint || hi || sh) {
    const img = x.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const expM = 2 ** (exp / 100);
    const conM = 1 + con / 100;
    const satM = 1 + sat / 100;
    const tR = (temp / 100) * 40;
    const tB = -(temp / 100) * 40;
    const tiG = (tint / 100) * 40;
    const tiRB = -(tint / 100) * 20;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] * expM;
      let g = d[i + 1] * expM;
      let b = d[i + 2] * expM;
      r = (r / 255 - 0.5) * conM * 255 + 127.5;
      g = (g / 255 - 0.5) * conM * 255 + 127.5;
      b = (b / 255 - 0.5) * conM * 255 + 127.5;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = y + (r - y) * satM;
      g = y + (g - y) * satM;
      b = y + (b - y) * satM;
      r += tR + tiRB;
      g += tiG;
      b += tB + tiRB;
      const lum = y / 255;
      if (lum > 0.5) {
        const t = ((lum - 0.5) * 2 * hi) / 100;
        r += t * 255;
        g += t * 255;
        b += t * 255;
      } else {
        const t = (((0.5 - lum) * 2 * sh) / 100);
        r += t * 255;
        g += t * 255;
        b += t * 255;
      }
      d[i] = clampByte(r);
      d[i + 1] = clampByte(g);
      d[i + 2] = clampByte(b);
    }
    x.putImageData(img, 0, 0);
  }
  if (imgCache.size > 24) imgCache.clear();
  imgCache.set(key, c);
  return c;
}

/** Image fill: Fill / Fit / Crop / Tile, 90° fill rotate, non-destructive adjustments. */
export function paintImageFill(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  im: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
) {
  if (!im.naturalWidth || sw < 1 || sh < 1) return;
  const src = processImage(im, n);
  const iw = src instanceof HTMLCanvasElement ? src.width : im.naturalWidth;
  const ih = src instanceof HTMLCanvasElement ? src.height : im.naturalHeight;
  const fit = n.imageFit || "fill";
  ctx.save();
  ctx.clip();
  if (fit === "tile") {
    const z = sw / Math.max(1, n.w);
    const pat = ctx.createPattern(src, "repeat");
    if (pat) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(z, z);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, n.w, n.h);
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  const cover = fit === "fill" || fit === "crop" || !fit;
  const scale = cover ? Math.max(sw / iw, sh / ih) : Math.min(sw / iw, sh / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = sx + (sw - dw) / 2;
  const dy = sy + (sh - dh) / 2;
  ctx.drawImage(src, dx, dy, dw, dh);
  ctx.restore();
}

export function paintDropShadows(ctx: CanvasRenderingContext2D, n: XNode, z: number) {
  const drops = (n.effects ?? []).filter((e) => e.kind === "drop-shadow" && e.visible);
  for (const drop of drops) {
    const { r, g, b, a } = parseHex(drop.color);
    if (a <= 0) continue;
    ctx.save();
    const blur = Math.max(0, drop.blur) * z;
    if (blur) ctx.filter = `blur(${blur}px)`;
    ctx.translate(drop.x * z, drop.y * z);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    ctx.fill();
    if (drop.spread) {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(0, drop.spread * 2) * z;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function paintInnerShadows(ctx: CanvasRenderingContext2D, n: XNode, z: number) {
  const inners = (n.effects ?? []).filter((e) => e.kind === "inner-shadow" && e.visible);
  if (!inners.length) return;
  for (const inner of inners) {
    const { r, g, b, a } = parseHex(inner.color);
    if (a <= 0) continue;
    ctx.save();
    // Draw an offset, blurred copy of the shape, then remove the original
    // interior. The remaining pixels are the shadow constrained to the edge.
    ctx.clip();
    const color = `rgba(${r},${g},${b},${a})`;
    ctx.shadowColor = color;
    ctx.shadowBlur = Math.max(0, inner.blur) * z;
    ctx.shadowOffsetX = inner.x * z;
    ctx.shadowOffsetY = inner.y * z;
    ctx.fillStyle = color;
    ctx.fill();
    if (inner.spread > 0) {
      ctx.lineWidth = inner.spread * 2 * z;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }
}

