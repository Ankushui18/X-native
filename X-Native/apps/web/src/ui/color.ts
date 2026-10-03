import type { ColorProfile } from "../engine/types";
import { convertRgbProfile } from "../engine/colorProfile";

export type FillType = "solid" | "linear" | "radial" | "angular" | "diamond" | "image" | "pattern" | "brush" | "dynamic";
export type ColorModel = "hex" | "rgb" | "css" | "hsl" | "hsb";
export type EyedropModel = Exclude<ColorModel, "css">;
export type EyedropSource =
  | { kind: "variable"; id: string; name: string; value: string; prop: "fill" | "strokePaint" }
  | { kind: "style"; id: string; name: string; value: string; prop: "fill" | "strokePaint" };
export interface EyedropSampleContext {
  shiftKey: boolean;
  create: boolean;
  source?: EyedropSource;
}
export type EyedropCallback = (hex: string, context?: EyedropSampleContext) => void;
export type ImageFit = "fill" | "fit" | "crop" | "tile";

export const FILL_TYPES: { id: FillType; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "linear", label: "Linear" },
  { id: "radial", label: "Radial" },
  { id: "angular", label: "Angular" },
  { id: "diamond", label: "Diamond" },
  { id: "image", label: "Image" },
  { id: "pattern", label: "Pattern" },
  // Stroke-only types (the picker filters them out of fills): a bristled
  // brush stroke and a procedural wiggle, both centre-only.
  { id: "brush", label: "Brush" },
  { id: "dynamic", label: "Dynamic" },
];

export const COLOR_MODELS: { id: ColorModel; label: string }[] = [
  { id: "hex", label: "Hex" },
  { id: "rgb", label: "RGB" },
  { id: "css", label: "CSS" },
  { id: "hsl", label: "HSL" },
  { id: "hsb", label: "HSB" },
];

export const IMAGE_FITS: { id: ImageFit; label: string }[] = [
  { id: "fill", label: "Fill" },
  { id: "fit", label: "Fit" },
  { id: "crop", label: "Crop" },
  { id: "tile", label: "Tile" },
];

export const IMAGE_ADJS: { key: ImageAdjKey; label: string }[] = [
  { key: "imageExposure", label: "Exposure" },
  { key: "imageContrast", label: "Contrast" },
  { key: "imageSaturation", label: "Saturation" },
  { key: "imageTemperature", label: "Temperature" },
  { key: "imageTint", label: "Tint" },
  { key: "imageHighlights", label: "Highlights" },
  { key: "imageShadows", label: "Shadows" },
];

export type ImageAdjKey =
  | "imageExposure"
  | "imageContrast"
  | "imageSaturation"
  | "imageTemperature"
  | "imageTint"
  | "imageHighlights"
  | "imageShadows";

export function nextColorModel(m: ColorModel): ColorModel {
  const i = COLOR_MODELS.findIndex((x) => x.id === m);
  return COLOR_MODELS[(i + 1) % COLOR_MODELS.length].id;
}

/**
 * Supported blend modes in menu order. "Pass through" is
 * missing on purpose: the article says it cannot be applied to a fill or an
 * effect, so callers that offer it (frames and groups only) prepend it.
 */
export const BLENDS = [
  "Normal",
  "Darken",
  "Multiply",
  "Plus darker",
  "Color burn",
  "Lighten",
  "Screen",
  "Plus lighter",
  "Color dodge",
  "Overlay",
  "Soft light",
  "Hard light",
  "Difference",
  "Exclusion",
  "Hue",
  "Saturation",
  "Color",
  "Luminosity",
];

/**
 * The composite operation a stored blend name maps to. Names come from the
 * menus with human labels ("Soft light"), while the layers/fills store
 * lowercase values, so both spellings have to land on the same op. Plus
 * darker/lighter are canvas's own `darker`/`lighter`.
 */
export function canvasBlend(m?: string): GlobalCompositeOperation {
  const k = (m || "normal").toLowerCase().replace(/\s+/g, "-");
  const map: Record<string, GlobalCompositeOperation> = {
    normal: "source-over",
    "pass-through": "source-over",
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighter: "lighten",
    "plus-lighter": "lighter",
    // Canvas has no "plus darker" (the CSS blend of that name is not one of
    // its operations, and assigning an unknown operation is silently ignored,
    // which would render as Normal). The mode acts like Darken,
    // but with a stronger impact on mid-tones", which is the shape of color
    // burn - the two also agree that blending with white does nothing.
    "plus-darker": "color-burn",
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

export function parseHex(raw: string): { r: number; g: number; b: number; a: number } {
  let s = raw.trim().replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 4) s = s.split("").map((c) => c + c).join("");
  if (s.length === 6) s += "ff";
  if (s.length !== 8) return { r: 0, g: 0, b: 0, a: 1 };
  const ch = (i: number, fb: number) => {
    const n = parseInt(s.slice(i, i + 2), 16);
    return Number.isNaN(n) ? fb : n;
  };
  return { r: ch(0, 0), g: ch(2, 0), b: ch(4, 0), a: ch(6, 255) / 255 };
}

export function toHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max < 1e-6 ? 0 : d / max, v: max };
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max - min > 1e-6) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function toCss(r: number, g: number, b: number, a = 1): string {
  const rr = Math.max(0, Math.min(255, Math.round(r)));
  const gg = Math.max(0, Math.min(255, Math.round(g)));
  const bb = Math.max(0, Math.min(255, Math.round(b)));
  const aa = Math.max(0, Math.min(1, a));
  if (aa >= 0.999) return `rgb(${rr}, ${gg}, ${bb})`;
  const t = Math.round(aa * 1000) / 1000;
  return `rgba(${rr}, ${gg}, ${bb}, ${t})`;
}

/** CSS numeric components used by modern Color 4 notation. */
function cssNumber(raw: string, percentScale = 1): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return Number.NaN;
  return raw.endsWith("%") ? (n / 100) * percentScale : n;
}

function cssAlpha(raw?: string): number {
  if (raw == null) return 1;
  const value = cssNumber(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function encodeSrgb(value: number): number {
  const magnitude = Math.abs(value);
  const encoded = magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, Math.sign(value) * encoded)) * 255);
}

function fromLinearSrgb(r: number, g: number, b: number, a: number) {
  return { r: encodeSrgb(r), g: encodeSrgb(g), b: encodeSrgb(b), a };
}

function convertParsedColor(
  color: { r: number; g: number; b: number; a: number },
  from: ColorProfile,
  to: ColorProfile,
) {
  if (from === to) return color;
  return { ...convertRgbProfile(color, from, to), a: color.a };
}

function oklabToRgb(L: number, a: number, b: number, alpha: number) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return fromLinearSrgb(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    alpha,
  );
}

export function parseCssColor(raw: string, targetProfile: ColorProfile = "srgb"): { r: number; g: number; b: number; a: number } | null {
  const s = raw.trim();
  if (!s) return null;
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?%?";
  const color4 = s.match(new RegExp(`^color\\(\\s*(srgb|display-p3)\\s+(${number})\\s+(${number})\\s+(${number})(?:\\s*\\/\\s*(${number}))?\\s*\\)$`, "i"));
  if (color4) {
    const [, space, rawR, rawG, rawB, rawAlpha] = color4;
    const r = cssNumber(rawR);
    const g = cssNumber(rawG);
    const b = cssNumber(rawB);
    const alpha = cssAlpha(rawAlpha);
    if (![r, g, b].every(Number.isFinite)) return null;
    const sourceProfile: ColorProfile = space.toLowerCase() === "display-p3" ? "display-p3" : "srgb";
    const source = {
      r: Math.round(Math.max(0, Math.min(1, r)) * 255),
      g: Math.round(Math.max(0, Math.min(1, g)) * 255),
      b: Math.round(Math.max(0, Math.min(1, b)) * 255),
      a: alpha,
    };
    return convertParsedColor(source, sourceProfile, targetProfile);
  }
  const oklab = s.match(new RegExp(`^oklab\\(\\s*(${number})\\s+(${number})\\s+(${number})(?:\\s*\\/\\s*(${number}))?\\s*\\)$`, "i"));
  if (oklab) {
    const L = cssNumber(oklab[1]);
    const a = cssNumber(oklab[2], 0.4);
    const b = cssNumber(oklab[3], 0.4);
    if (![L, a, b].every(Number.isFinite)) return null;
    return convertParsedColor(oklabToRgb(L, a, b, cssAlpha(oklab[4])), "srgb", targetProfile);
  }
  const oklch = s.match(new RegExp(`^oklch\\(\\s*(${number})\\s+(${number})\\s+(${number}(?:deg|rad|turn|grad)?)(?:\\s*\\/\\s*(${number}))?\\s*\\)$`, "i"));
  if (oklch) {
    const L = cssNumber(oklch[1]);
    const C = cssNumber(oklch[2], 0.4);
    const hue = oklch[3].toLowerCase();
    const angle = hue.endsWith("turn") ? parseFloat(hue) * 360
      : hue.endsWith("rad") ? parseFloat(hue) * (180 / Math.PI)
      : hue.endsWith("grad") ? parseFloat(hue) * 0.9
      : parseFloat(hue);
    if (![L, C, angle].every(Number.isFinite)) return null;
    const radians = angle * (Math.PI / 180);
    return convertParsedColor(oklabToRgb(L, C * Math.cos(radians), C * Math.sin(radians), cssAlpha(oklch[4])), "srgb", targetProfile);
  }
  const hexBody = s.replace("#", "");
  if (s.startsWith("#") || /^[0-9a-fA-F]{3,8}$/.test(s)) {
    if (hexBody.length === 3 || hexBody.length === 4 || hexBody.length === 6 || hexBody.length === 8)
      return parseHex(s.startsWith("#") ? s : `#${s}`);
  }
  const rgb = s.match(
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i,
  );
  if (rgb) {
    const a = rgb[4] == null ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return convertParsedColor({
      r: Math.max(0, Math.min(255, Math.round(parseFloat(rgb[1])))),
      g: Math.max(0, Math.min(255, Math.round(parseFloat(rgb[2])))),
      b: Math.max(0, Math.min(255, Math.round(parseFloat(rgb[3])))),
      a: Math.max(0, Math.min(1, Number.isNaN(a) ? 1 : a)),
    }, "srgb", targetProfile);
  }
  const hsl = s.match(
    /^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i,
  );
  if (hsl) {
    const rgbv = hslToRgb(parseFloat(hsl[1]), parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100);
    const a = hsl[4] == null ? 1 : hsl[4].endsWith("%") ? parseFloat(hsl[4]) / 100 : parseFloat(hsl[4]);
    return convertParsedColor({ ...rgbv, a: Math.max(0, Math.min(1, Number.isNaN(a) ? 1 : a)) }, "srgb", targetProfile);
  }
  return null;
}

export function handlesForFill(
  type: FillType,
): { fillGX: number; fillGY: number; fillHX: number; fillHY: number } | null {
  if (type === "linear") return { fillGX: 0.5, fillGY: 0, fillHX: 0.5, fillHY: 1 };
  if (type === "radial" || type === "angular" || type === "diamond")
    return { fillGX: 0.5, fillGY: 0.5, fillHX: 0.5, fillHY: 1 };
  return null;
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function toHexA(r: number, g: number, b: number, a = 1): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${h(a * 255)}`;
}

export function withAlpha(hex: string, a: number): string {
  const { r, g, b } = parseHex(hex);
  return toHexA(r, g, b, a);
}

let renderColorProfile: ColorProfile = "srgb";
export function setRenderColorProfile(profile: ColorProfile): void {
  renderColorProfile = profile;
}

export function getRenderColorProfile(): ColorProfile {
  return renderColorProfile;
}

/** Create rendering surfaces in the active document profile when supported. */
export function getCanvas2dContext(
  canvas: HTMLCanvasElement,
  options: CanvasRenderingContext2DSettings = {},
): CanvasRenderingContext2D | null {
  const settings = { colorSpace: renderColorProfile, ...options };
  try {
    return canvas.getContext("2d", settings);
  } catch {
    return canvas.getContext("2d", options);
  }
}

export function cssRgba(hex: string, opacity = 1, profile = renderColorProfile): string {
  const { r, g, b, a } = parseHex(hex);
  const alpha = Math.max(0, Math.min(1, a * opacity));
  if (profile === "display-p3") {
    return `color(display-p3 ${r / 255} ${g / 255} ${b / 255} / ${alpha})`;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

export function isNone(hex: string): boolean {
  return !hex || hex === "#00000000" || hex.toLowerCase() === "transparent";
}

const PRESETS = [
  "#ffffff",
  "#f5f5f5",
  "#e5e5e5",
  "#d9d9d9",
  "#b3b3b3",
  "#757575",
  "#444444",
  "#2c2c2c",
  "#1e1e1e",
  "#000000",
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#6366f1",
  "#5856d6",
  "#af52de",
  "#ff2d55",
];

export const COLOR_PRESETS = PRESETS;

let eyedrop: EyedropCallback | null = null;
let lastDrop = 0;
let eyedropModel: EyedropModel = "hex";
export function setEyedropModel(model: EyedropModel) {
  eyedropModel = model;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("x-eyedrop-model", { detail: model }));
}
export function getEyedropModel(): EyedropModel {
  return eyedropModel;
}
export function nextEyedropModel(model: ColorModel): EyedropModel {
  const cycle: EyedropModel[] = ["hex", "rgb", "hsl", "hsb"];
  const index = cycle.indexOf(model as EyedropModel);
  return cycle[(index + 1 + cycle.length) % cycle.length];
}
export function armEyedrop(fn: EyedropCallback, model: EyedropModel = "hex") {
  eyedrop = fn;
  setEyedropModel(model);
  document.body.classList.add("eyedrop");
}
export function takeEyedrop(): EyedropCallback | null {
  const fn = eyedrop;
  eyedrop = null;
  document.body.classList.remove("eyedrop");
  if (fn) lastDrop = Date.now();
  return fn;
}
export function eyedropArmed(): boolean {
  return !!eyedrop;
}
export function justEyedropped(): boolean {
  return Date.now() - lastDrop < 80;
}

/* --------------------------------------------------------------- contrast */

/**
 * WCAG 2.1 relative luminance. The contrast check in the color picker uses
 * exactly this, so the ratio the picker shows is the ratio a developer's audit
 * tool will report.
 */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Contrast ratio between two colors: 1:1 for identical, 21:1 for black on white. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `fg` composited over `bg`, as an opaque hex. A label colour written as
 * `rgba(15,23,42,0.5)` is not a colour a contrast ratio can be taken of - what
 * the eye sees is that 50% wash mixed with whatever is behind it.
 */
export function compositeOver(fg: string, bg: string): string {
  const f = parseCssColor(fg);
  const b = parseCssColor(bg);
  if (!f) return bg;
  if (!b || f.a >= 0.999) return toHex(f.r, f.g, f.b);
  return toHex(
    f.r * f.a + b.r * (1 - f.a),
    f.g * f.a + b.g * (1 - f.a),
    f.b * f.a + b.b * (1 - f.a),
  );
}

/**
 * A readable version of `fg` on `bg`: the canvas's frame names, ruler numbers
 * and dimension badges, which are drawn as text straight onto whatever colour
 * the canvas happens to be. Labels clear about 7:1; ours were
 * `rgba(15,23,42,0.5)` over `#f1f2f6`, which composites to a 3.3:1 grey - under
 * the 4.5:1 floor for text, and the reason the names read as decoration rather
 * than as the layer's name. Hue and saturation are kept, only the value moves,
 * so a theme's warm or cool grey stays that grey.
 */
export function readableLabel(fg: string, bg: string, target = 4.5): string {
  const base = compositeOver(fg, bg);
  return nearestAccessible(base, bg, target);
}

/** Contrast categories. "Auto" resolves from the layer being painted. */
export type ContrastKind = "auto" | "large" | "normal" | "graphics";

export const CONTRAST_KINDS: { id: ContrastKind; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "large", label: "Large text" },
  { id: "normal", label: "Normal text" },
  { id: "graphics", label: "Graphics" },
];

/**
 * The ratio to clear. WCAG: 4.5 for normal text, 3 for large text and graphics,
 * 7 for AAA normal text and 4.5 for AAA large text. Graphics has no AAA tier,
 * which is why the picker only offers AAA for text categories.
 */
export function contrastTarget(kind: ContrastKind, level: "AA" | "AAA"): number {
  if (kind === "large") return level === "AAA" ? 4.5 : 3;
  if (kind === "graphics") return 3;
  return level === "AAA" ? 7 : 4.5;
}

export function passesContrast(fg: string, bg: string, kind: ContrastKind, level: "AA" | "AAA"): boolean {
  return contrastRatio(fg, bg) + 1e-6 >= contrastTarget(kind, level);
}

/**
 * The nearest color that clears `target` against `bg`, found by moving only the
 * value of the color: repair a failing fill by changing how light it is,
 * never its hue or its saturation, so the swatch still reads as the same brand
 * color. Returns the best reachable color when the target cannot be met.
 */
export function nearestAccessible(fg: string, bg: string, target: number): string {
  if (contrastRatio(fg, bg) + 1e-6 >= target) return fg;
  const { r, g, b } = parseHex(fg);
  const { h, s, v } = rgbToHsv(r, g, b);
  const at = (t: number) => {
    const c = hsvToRgb(h, s, t);
    return toHex(c.r, c.g, c.b);
  };
  const toward = contrastRatio(at(0), bg) >= contrastRatio(at(1), bg) ? 0 : 1;
  if (contrastRatio(at(toward), bg) + 1e-6 < target) return at(toward);
  let lo = v;
  let hi = toward;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(at(mid), bg) + 1e-6 >= target) hi = mid;
    else lo = mid;
  }
  return at(hi);
}
