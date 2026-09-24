import type { Effect, EffectKind } from "../engine/types";

/**
 * How many of each effect a single layer may carry, and how rows are reordered.
 * Figma's Effects section is a stack like the fill stack: order decides what
 * paints over what, so the rows have to be movable.
 */
/** Figma's per-layer effect budget. */
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
 * Move an effect to another slot, as Figma does when its row is dragged. The
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
