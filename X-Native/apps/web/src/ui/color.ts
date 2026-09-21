export type FillType = "solid" | "linear" | "radial" | "angular" | "diamond" | "image";

export const FILL_TYPES: { id: FillType; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "linear", label: "Linear" },
  { id: "radial", label: "Radial" },
  { id: "angular", label: "Angular" },
  { id: "diamond", label: "Diamond" },
  { id: "image", label: "Image" },
];

export const BLENDS = [
  "Normal",
  "Darken",
  "Multiply",
  "Color burn",
  "Lighten",
  "Screen",
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

export function parseHex(raw: string): { r: number; g: number; b: number; a: number } {
  let s = raw.trim().replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 4) s = s.split("").map((c) => c + c).join("");
  if (s.length === 6) s += "ff";
  if (s.length !== 8) return { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: parseInt(s.slice(0, 2), 16) || 0,
    g: parseInt(s.slice(2, 4), 16) || 0,
    b: parseInt(s.slice(4, 6), 16) || 0,
    a: (parseInt(s.slice(6, 8), 16) || 255) / 255,
  };
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

export function cssRgba(hex: string, opacity = 1): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, opacity))})`;
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
  "#0d99ff",
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
