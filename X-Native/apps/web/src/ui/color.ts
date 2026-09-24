export type FillType = "solid" | "linear" | "radial" | "angular" | "diamond" | "image";
export type ColorModel = "hex" | "rgb" | "css" | "hsl" | "hsb";
export type ImageFit = "fill" | "fit" | "crop" | "tile";

export const FILL_TYPES: { id: FillType; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "linear", label: "Linear" },
  { id: "radial", label: "Radial" },
  { id: "angular", label: "Angular" },
  { id: "diamond", label: "Diamond" },
  { id: "image", label: "Image" },
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
 * Figma's blend modes, in the order its menu lists them. "Pass through" is
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
 * menus, which are Figma's labels ("Soft light"), while the layers/fills store
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
    // which would render as Normal). Figma describes the mode as "like Darken,
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

export function parseCssColor(raw: string): { r: number; g: number; b: number; a: number } | null {
  const s = raw.trim();
  if (!s) return null;
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
    return {
      r: Math.max(0, Math.min(255, Math.round(parseFloat(rgb[1])))),
      g: Math.max(0, Math.min(255, Math.round(parseFloat(rgb[2])))),
      b: Math.max(0, Math.min(255, Math.round(parseFloat(rgb[3])))),
      a: Math.max(0, Math.min(1, Number.isNaN(a) ? 1 : a)),
    };
  }
  const hsl = s.match(
    /^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i,
  );
  if (hsl) {
    const rgbv = hslToRgb(parseFloat(hsl[1]), parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100);
    const a = hsl[4] == null ? 1 : hsl[4].endsWith("%") ? parseFloat(hsl[4]) / 100 : parseFloat(hsl[4]);
    return { ...rgbv, a: Math.max(0, Math.min(1, Number.isNaN(a) ? 1 : a)) };
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

export function cssRgba(hex: string, opacity = 1): string {
  const { r, g, b, a } = parseHex(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a * opacity))})`;
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

let eyedrop: ((hex: string) => void) | null = null;
let lastDrop = 0;
export function armEyedrop(fn: (hex: string) => void) {
  eyedrop = fn;
  document.body.classList.add("eyedrop");
}
export function takeEyedrop(): ((hex: string) => void) | null {
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
 * WCAG 2.1 relative luminance. Figma's contrast check in the color picker uses
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

/** Figma's contrast categories. "Auto" resolves from the layer being painted. */
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
 * value of the color: Figma repairs a failing fill by changing how light it is,
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
