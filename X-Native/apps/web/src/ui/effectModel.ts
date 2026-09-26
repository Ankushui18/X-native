import type { Effect, EffectKind, XNode } from "../engine/types";
import { parseHex } from "./color";

/**
 * How many of each effect a single layer may carry, and how rows are reordered.
 * Effects section is a stack like the fill stack: order decides what
 * paints over what, so the rows have to be movable.
 */
/** Per-layer effect budget. */
export const EFFECT_LIMITS: Partial<Record<EffectKind, number>> = {
  "drop-shadow": 8,
  "inner-shadow": 8,
  "layer-blur": 1,
  "background-blur": 1,
  noise: 2,
  texture: 1,
  glass: 1,
};

export function countKind(effects: readonly Effect[], kind: EffectKind): number {
  return effects.filter((e) => e.kind === kind).length;
}

/** True when another `kind` still fits, per the table above. */
export function canAddEffect(effects: readonly Effect[], kind: EffectKind): boolean {
  const limit = EFFECT_LIMITS[kind];
  return limit === undefined || countKind(effects, kind) < limit;
}

/**
 * The effect list the canvas paints: the stored stack plus the type-menu
 * hover preview, when one targets this layer and there is room for it.
 * Render-only - the preview never enters history or the document.
 */
export function withPreviewEffect(
  effects: readonly Effect[],
  preview: { id: string; kind: EffectKind; effect: Effect } | null | undefined,
  id: string,
): readonly Effect[] {
  if (!preview || preview.id !== id) return effects;
  if (preview.effect.kind !== preview.kind) return effects;
  if (!canAddEffect(effects, preview.kind)) return effects;
  return [...effects, preview.effect];
}

/**
 * A background blur (or glass, which reads the same beneath) only shows
 * through a fill between 0.10% and 99.99% opacity: fully transparent shows
 * nothing to blur through, fully opaque covers it.
 */
export function bgBlurSeesThrough(fillAlpha: number): boolean {
  return fillAlpha >= 0.001 && fillAlpha <= 0.9999;
}

/**
 * Move an effect to another slot, when its row is dragged. The
 * row lands where it was dropped rather than swapping, matching the fill stack.
 */
export function moveEffect<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/** Toast text for the row that would not fit. */
export function limitMessage(kind: EffectKind, limit: number): string {
  const label = {
    "drop-shadow": "Drop shadow",
    "inner-shadow": "Inner shadow",
    "layer-blur": "Layer blur",
    "background-blur": "Background blur",
    noise: "Noise",
    texture: "Texture",
    glass: "Glass",
  }[kind];
  return `${label} · a layer takes ${limit === 1 ? "one" : limit} at a time`;
}

/**
 * Which effects carry a blend mode. Blend-mode compatibility names exactly
 * three of them - inner shadows, drop shadows and noise - and "Pass through",
 * which the same article says cannot be applied to a fill or an effect, is
 * therefore not in the menu either.
 */
export function effectCanBlend(kind: EffectKind): boolean {
  return kind === "drop-shadow" || kind === "inner-shadow" || kind === "noise";
}

/**
 * "Show behind transparent areas" is a drop-shadow setting:
 * inner shadows don't support it, and the other kinds have no shadow at
 * all to show through anything.
 */
export function effectCanShowBehind(kind: EffectKind): boolean {
  return kind === "drop-shadow";
}

/**
 * Whether the layer has anything transparent for a shadow to show through,
 * compatible effects list:
 * fills all under 100% opacity, a stroke with no fill, a fill or stroke that
 * blends with something other than Normal, or a centre or outside stroke under
 * 100% opacity. A layer that fails all four is fully opaque, so the checkbox
 * cannot do anything for it.
 */
export function canShowBehindTransparent(n: XNode): boolean {
  const paints = (n.fills ?? []).filter((p) => p.visible !== false);
  const hasFill = n.fillVisible !== false && !!n.fill && n.fill !== "none";
  const hasStroke = n.strokeVisible !== false && n.strokeWidth > 0 && !!n.strokePaint;
  const alpha = (c?: string) => (c ? parseHex(c).a : 1);
  const blended = (b?: string) => !!b && !/^(normal|pass-?through)$/i.test(b);
  if (blended(n.blendMode) || blended(n.fillBlend) || paints.some((p) => blended(p.blend))) {
    return true;
  }
  if (paints.length > 0 && paints.every((p) => Math.min(p.opacity ?? 1, alpha(p.color)) < 1)) {
    return true;
  }
  if (!paints.length && hasFill && (n.fillOpacity ?? 1) < 1) return true;
  if (!hasFill && hasStroke) return true;
  const align = n.strokeAlign ?? "center";
  if (hasStroke && align !== "inside" && Math.min(n.strokeOpacity ?? 1, alpha(n.strokePaint)) < 1) {
    return true;
  }
  return false;
}
