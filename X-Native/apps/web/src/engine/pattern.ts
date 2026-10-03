/**
 * Pattern fills — Figma's "Pattern" fill type (help.figma.com 33025308147223):
 * a source layer repeated across the fill with Tile type, Direction, Scale,
 * X/Y spacing and Alignment.
 *
 * This module holds the pure parts: the settings defaults, source resolution
 * (live by id, falling back to the snapshot taken when the source was picked)
 * and the lattice of tile origins. Rasterising the source into a tile lives in
 * paint.ts; SVG `<pattern>` export in svgExport.ts. Both share `patternCells` /
 * `patternPeriod` so canvas and export agree on geometry.
 */
import type { PatternSpec, XNode } from "./types";

export const PATTERN_TILES = [
  { id: "grid", label: "Rectangular" },
  { id: "hex", label: "Hexagonal" },
] as const;
export const PATTERN_DIRECTIONS = [
  { id: "horizontal", label: "Horizontal" },
  { id: "vertical", label: "Vertical" },
] as const;
export const PATTERN_ALIGNS = [
  { id: "start", label: "Start" },
  { id: "center", label: "Center" },
  { id: "end", label: "End" },
] as const;

export type ResolvedPattern = Required<Omit<PatternSpec, "source" | "snapshot">> & {
  source?: string;
  snapshot?: XNode;
};

/** Settings with defaults applied and values clamped to sane ranges. */
export function patternSettings(p?: PatternSpec): ResolvedPattern {
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  return {
    source: p?.source,
    snapshot: p?.snapshot,
    tile: p?.tile === "hex" ? "hex" : "grid",
    direction: p?.direction === "vertical" ? "vertical" : "horizontal",
    scale: num(p?.scale, 1, 0.01, 100),
    spacingX: num(p?.spacingX, 1, 0.05, 100),
    spacingY: num(p?.spacingY, 1, 0.05, 100),
    align: p?.align === "start" || p?.align === "end" ? p.align : "center",
  };
}

/* ---- source resolution -------------------------------------------------- */

type Lookup = (id: string) => XNode | undefined;
let lookup: Lookup | null = null;

/** The canvas registers how to find a live node by id (the current document). */
export function setPatternLookup(fn: Lookup | null) {
  lookup = fn;
}

/**
 * The layer a pattern repeats: the live source when it still exists (so edits
 * to it show up everywhere — "pattern fills are dynamic"), otherwise the
 * snapshot taken when it was picked ("pattern fills persist even if the source
 * layer is deleted").
 */
export function patternSourceNode(p?: PatternSpec): XNode | undefined {
  if (!p) return undefined;
  const live = p.source && lookup ? lookup(p.source) : undefined;
  return live ?? p.snapshot;
}

/** A detached copy of a node suitable for `PatternSpec.snapshot`. */
export function snapshotForPattern(n: XNode): XNode {
  const copy = JSON.parse(JSON.stringify(n)) as XNode;
  copy.x = 0;
  copy.y = 0;
  return copy;
}

/** True when `id` is `n` or one of its descendants (a fill can't repeat itself). */
export function containsId(n: XNode, id: string): boolean {
  if (n.id === id) return true;
  return (n.children ?? []).some((c) => containsId(c, id));
}

/* ---- lattice ------------------------------------------------------------ */

export interface PatternPeriod {
  /** Scaled tile size in layer units. */
  tw: number;
  th: number;
  /** Step between neighbouring tile origins. */
  stepX: number;
  stepY: number;
  /** Lattice origin inside the box (a tile's top-left). */
  ox: number;
  oy: number;
  /** Half-step offset applied to odd rows (horizontal hex) or columns (vertical hex). */
  hex: boolean;
  vertical: boolean;
}

export function patternPeriod(p: ResolvedPattern, srcW: number, srcH: number, boxW: number, boxH: number): PatternPeriod {
  const tw = Math.max(0.5, srcW * p.scale);
  const th = Math.max(0.5, srcH * p.scale);
  const stepX = tw * p.spacingX;
  const stepY = th * p.spacingY;
  const place = (box: number, t: number) => (p.align === "start" ? 0 : p.align === "end" ? box - t : (box - t) / 2);
  return {
    tw,
    th,
    stepX,
    stepY,
    ox: place(boxW, tw),
    oy: place(boxH, th),
    hex: p.tile === "hex",
    vertical: p.direction === "vertical",
  };
}

/** Upper bound on tiles drawn per fill; beyond it the fill stops adding tiles. */
export const MAX_PATTERN_CELLS = 20000;

/** Every tile origin (layer units) whose tile touches the 0..boxW × 0..boxH box. */
export function patternCells(per: PatternPeriod, boxW: number, boxH: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const { tw, th, stepX, stepY, ox, oy, hex, vertical } = per;
  const i0 = Math.floor((-tw - ox - stepX) / stepX);
  const i1 = Math.ceil((boxW - ox + stepX) / stepX);
  const j0 = Math.floor((-th - oy - stepY) / stepY);
  const j1 = Math.ceil((boxH - oy + stepY) / stepY);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      let x = ox + i * stepX;
      let y = oy + j * stepY;
      if (hex && !vertical && j % 2 !== 0) x += stepX / 2;
      if (hex && vertical && i % 2 !== 0) y += stepY / 2;
      if (x + tw <= 0 || y + th <= 0 || x >= boxW || y >= boxH) continue;
      out.push({ x, y });
      if (out.length >= MAX_PATTERN_CELLS) return out;
    }
  }
  return out;
}
