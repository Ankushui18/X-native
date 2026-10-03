import type { ColorProfile, XNode } from "./types";

const PREFERRED_PROFILE_KEY = "x-native-preferred-color-profile";

export function getPreferredColorProfile(): ColorProfile {
  try {
    return localStorage.getItem(PREFERRED_PROFILE_KEY) === "display-p3" ? "display-p3" : "srgb";
  } catch {
    return "srgb";
  }
}

export function setPreferredColorProfile(profile: ColorProfile): void {
  try {
    localStorage.setItem(PREFERRED_PROFILE_KEY, profile);
  } catch {
    // A blocked preference store falls back to sRGB on the next launch.
  }
}

function decode(value: number): number {
  const a = Math.abs(value);
  return Math.sign(value) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4);
}

function encode(value: number): number {
  const a = Math.abs(value);
  const s = a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, Math.sign(value) * s)) * 255);
}

/** Convert an encoded RGB triplet between the sRGB and Display P3 primaries. */
export function convertRgbProfile(
  rgb: { r: number; g: number; b: number },
  from: ColorProfile,
  to: ColorProfile,
): { r: number; g: number; b: number } {
  if (from === to) return { ...rgb };
  const r = decode(Math.max(0, Math.min(255, rgb.r)) / 255);
  const g = decode(Math.max(0, Math.min(255, rgb.g)) / 255);
  const b = decode(Math.max(0, Math.min(255, rgb.b)) / 255);
  const p3ToSrgb = from === "display-p3";
  const x = p3ToSrgb
    ? 0.4865709486 * r + 0.2656676932 * g + 0.1982172852 * b
    : 0.4123907993 * r + 0.3575843394 * g + 0.1804807884 * b;
  const y = p3ToSrgb
    ? 0.2289745641 * r + 0.6917385218 * g + 0.0792869141 * b
    : 0.2126390059 * r + 0.7151686788 * g + 0.0721923154 * b;
  const z = p3ToSrgb
    ? 0.0451133819 * g + 1.0439443689 * b
    : 0.0193308187 * r + 0.1191947798 * g + 0.9505321522 * b;
  const target = p3ToSrgb
    ? [
        3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z,
        -0.9692436363 * x + 1.8759675025 * y + 0.0415550574 * z,
        0.0556300797 * x - 0.2039769589 * y + 1.0569715142 * z,
      ]
    : [
        2.4934969119 * x - 0.9313836179 * y - 0.4027107845 * z,
        -0.8294889696 * x + 1.7626640603 * y + 0.0236246858 * z,
        0.0358458302 * x - 0.0761723893 * y + 0.956884524 * z,
      ];
  return { r: encode(target[0]), g: encode(target[1]), b: encode(target[2]) };
}

export function convertColorValue(value: string, from: ColorProfile, to: ColorProfile): string {
  if (from === to || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return value;
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  const { r: nr, g: ng, b: nb } = convertRgbProfile({ r, g, b }, from, to);
  const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${hex(nr)}${hex(ng)}${hex(nb)}${value.length === 9 ? value.slice(7, 9).toLowerCase() : ""}`;
}

const COLOR_FIELDS = new Set([
  "fill", "fillB", "strokePaint", "color", "underlineColor", "overlayBackdropColor", "pixelGridColor",
]);

/**
 * Convert colors embedded in document nodes. Shared styles and variables are
 * intentionally not walked: Figma preserves their authored values when the
 * document profile is converted.
 */
export function convertNodeColors(root: XNode, from: ColorProfile, to: ColorProfile): void {
  if (from === to) return;
  const seen = new WeakSet<object>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (COLOR_FIELDS.has(key) && typeof child === "string") {
        (value as Record<string, unknown>)[key] = convertColorValue(child, from, to);
      } else if (child && typeof child === "object") {
        walk(child);
      }
    }
  };
  walk(root);
}
