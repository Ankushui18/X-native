import type { Engine, GradientStop, Snapshot, XNode } from "../engine/types";
import { find } from "../engine/memory";
import { plural, toast } from "./toast";

/**
 * Selection colors, borrowed from Sketch's Inspector: a summary of every colour
 * inside the current selection, grouped by what it paints and sorted by how
 * often it appears. Sketch lets you hover a swatch to highlight matching layers
 * and click it to recolor them all; here a click *selects* everything on the
 * page painted with that colour (Figma's "Select all with same fill"), which is
 * the step you actually take before recoloring, and it needs no bespoke canvas
 * highlight pass to stay fast on big documents.
 */

export type ColorBucket = "Fill" | "Border" | "Text";

export interface ColorUsage {
  hex: string;
  bucket: ColorBucket;
  count: number;
  ids: string[];
  /** The fill opacity shared by every use of this colour, or null when the
   *  selection is mixed - Figma's field shows nothing until it can show one value. */
  opacity: number | null;
}

const NONE = "#00000000";

function norm(value: string | undefined): string | null {
  if (!value || value.length < 7 || value === NONE) return null;
  return value.slice(0, 7).toLowerCase();
}

/**
 * The colours a single paint contributes. Figma's Selection colors skips image
 * and pattern fills, and shows gradients by the colours in their ramp, because
 * those are the pixels that are actually on the canvas; a leftover `color`
 * string on an image fill would otherwise be listed as if it painted.
 */
function paintColors(
  type: string | undefined,
  color: string | undefined,
  stops: GradientStop[] | undefined,
  opacity: number | undefined,
): { hex: string; opacity: number | undefined }[] {
  if (type === "image" || type === "pattern" || !color) return [];
  if (type && type !== "solid" && stops && stops.length)
    return stops
      .map((s) => ({ hex: norm(s.color) ?? "", opacity }))
      .filter((e) => e.hex);
  const hex = norm(color);
  return hex ? [{ hex, opacity }] : [];
}

/** Colours used inside `node`, counted, grouped and ordered by frequency. */
export function colorUsage(node: XNode): ColorUsage[] {
  return colorUsageAll([node]);
}

/** Figma's row lists the colours of the *selection*, not of one layer: every
 *  selected layer contributes, and a colour used by two of them is still one
 *  row. Passing several nodes is what makes a multi-select read correctly. */
export function colorUsageAll(nodes: XNode[]): ColorUsage[] {
  const map = new Map<string, ColorUsage & { opacities: (number | undefined)[] }>();
  const add = (hex: string | null, bucket: ColorBucket, id: string, key: string, opacity?: number) => {
    if (!hex) return;
    const hit = map.get(key);
    if (hit) {
      hit.count++;
      hit.ids.push(id);
      hit.opacities.push(opacity);
    } else {
      map.set(key, { hex, bucket, count: 1, ids: [id], opacity: null, opacities: [opacity] });
    }
  };
  const walk = (n: XNode) => {
    if (n.visible === false) return;
    if (n.fillVisible !== false) {
      for (const e of paintColors(n.fillType, n.fill, n.gradientStops, n.fillOpacity ?? 1))
        add(e.hex, n.kind === "text" ? "Text" : "Fill", n.id, `${n.kind === "text" ? "Text" : "Fill"}:${e.hex}`, e.opacity);
      for (const f of n.fills ?? []) {
        if (f.visible === false) continue;
        for (const e of paintColors(f.type, f.color, f.stops, f.opacity ?? 1))
          add(e.hex, n.kind === "text" ? "Text" : "Fill", n.id, `${n.kind === "text" ? "Text" : "Fill"}:${e.hex}`, e.opacity);
      }
    }
    if (n.strokeVisible !== false && n.strokeWidth > 0) {
      for (const e of paintColors(undefined, n.strokePaint, undefined, n.strokeOpacity ?? 1))
        add(e.hex, "Border", n.id, `Border:${e.hex}`, e.opacity);
      for (const st of n.strokes ?? []) {
        if (st.visible === false) continue;
        for (const e of paintColors(undefined, st.color, undefined, st.opacity ?? 1))
          add(e.hex, "Border", n.id, `Border:${e.hex}`, e.opacity);
      }
    }
    for (const ch of n.children) walk(ch);
  };
  for (const start of nodes) walk(start);
  return [...map.values()]
    .map(({ opacities, ...u }) => {
      const first = opacities[0];
      const uniform = opacities.every((o) => (o ?? 1) === (first ?? 1));
      return { ...u, opacity: uniform ? (first ?? 1) : null };
    })
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
}

/** Every layer on the page painted `hex` in the same role, so a click can jump
 *  straight to them. */
export function matchingIds(root: XNode, usage: ColorUsage): string[] {
  const out: string[] = [];
  const walk = (n: XNode) => {
    if (n.visible === false) return;
    const fill = norm(n.fill);
    const strokes = [norm(n.strokePaint), ...(n.strokes ?? []).map((s) => norm(s.color))];
    if (usage.bucket === "Border") {
      if (n.strokeVisible !== false && strokes.includes(usage.hex)) out.push(n.id);
    } else {
      const paints = usage.bucket === "Text" ? n.kind === "text" : n.kind !== "text";
      const fills = [fill, ...(n.fills ?? []).map((f) => (f.visible === false ? null : norm(f.color)))];
      if (paints && n.fillVisible !== false && fills.includes(usage.hex)) out.push(n.id);
    }
    for (const ch of n.children) walk(ch);
  };
  walk(root);
  return out;
}

/** Select everything on the page that shares this colour; ⇧ keeps the current
 *  selection so you can gather several colours before acting. */
export function selectByColor(engine: Engine, snap: Snapshot, usage: ColorUsage, additive: boolean) {
  const root = snap.pages[snap.page].root;
  const found = matchingIds(root, usage);
  if (!found.length) {
    toast("Nothing else on this page uses that colour");
    return;
  }
  const keep = additive ? new Set([...snap.selection, ...found]) : new Set(found);
  engine.dispatch({ type: "select", ids: [...keep] });
  toast(`Selected ${plural(found.length, "layer")} · ${usage.bucket.toLowerCase()} ${usage.hex.toUpperCase()}`);
}

/**
 * Set the opacity of every paint that carries this colour, in one undo step -
 * Figma's percentage field on a Selection colors row. It writes the layers the
 * row was built from (the selection), not every layer on the page: silently
 * repainting something the designer never picked is worse than a narrower tool.
 * A gradient is included as a whole, because the row lists the colours it
 * paints, not a stop it owns.
 */
export function setOpacityMatches(engine: Engine, root: XNode, usage: ColorUsage, pct: number): number {
  const o = Math.max(0, Math.min(100, pct)) / 100;
  const ids = [...new Set(usage.ids)];
  let touched = 0;
  engine.dispatch({ type: "begin" });
  for (const id of ids) {
    const n = find(root, id);
    if (!n) continue;
    const patch: Record<string, unknown> = {};
    if (usage.bucket === "Border") {
      if (paintColors(undefined, n.strokePaint, undefined, n.strokeOpacity).some((e) => e.hex === usage.hex))
        patch.strokeOpacity = o;
      const strokes = n.strokes?.map((st) =>
        paintColors(undefined, st.color, undefined, st.opacity).some((e) => e.hex === usage.hex) ? { ...st, opacity: o } : st,
      );
      if (n.strokes?.length && strokes?.some((st, j) => st !== n.strokes![j])) patch.strokes = strokes;
    } else {
      if (
        n.fillVisible !== false &&
        paintColors(n.fillType, n.fill, n.gradientStops, n.fillOpacity).some((e) => e.hex === usage.hex)
      )
        patch.fillOpacity = o;
      const fills = n.fills?.map((f) =>
        f.visible === false || !paintColors(f.type, f.color, f.stops, f.opacity).some((e) => e.hex === usage.hex)
          ? f
          : { ...f, opacity: o },
      );
      if (n.fills?.length && fills?.some((f, j) => f !== n.fills![j])) patch.fills = fills;
    }
    if (Object.keys(patch).length) {
      engine.dispatch({ type: "patch", id, patch: patch as never });
      touched++;
    }
  }
  engine.dispatch({ type: "end" });
  if (touched)
    toast(
      `Set ${usage.bucket.toLowerCase()} opacity ${Math.round(o * 100)}% · ${plural(touched, "layer")} · ${usage.hex.toUpperCase()}`,
    );
  return touched;
}

/**
 * Recolour every layer on the page that shares `usage`'s colour, in one undo
 * step. A node can carry a base paint and a paint list, so both are rewritten
 * where they match — anything else leaves a half-updated layer behind.
 */
export function recolorMatches(engine: Engine, root: XNode, usage: ColorUsage, next: string): number {
  const ids = matchingIds(root, usage);
  if (!ids.length) return 0;
  engine.dispatch({ type: "begin" });
  for (const id of ids) {
    const n = find(root, id);
    if (!n) continue;
    if (usage.bucket === "Border") {
      const patch: Record<string, unknown> = {};
      if (norm(n.strokePaint) === usage.hex) {
        patch.strokePaint = next;
        patch.strokeVisible = true;
      }
      const strokes = n.strokes?.map((s) => (norm(s.color) === usage.hex ? { ...s, color: next } : s));
      if (n.strokes?.length && strokes) patch.strokes = strokes;
      if (Object.keys(patch).length) engine.dispatch({ type: "patch", id, patch: patch as never });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (norm(n.fill) === usage.hex && n.fillVisible !== false) {
      patch.fill = next;
      patch.fillVisible = true;
    }
    const fills = n.fills?.map((f) => (norm(f.color) === usage.hex ? { ...f, color: next } : f));
    if (n.fills?.length && fills) patch.fills = fills;
    if (Object.keys(patch).length) engine.dispatch({ type: "patch", id, patch: patch as never });
  }
  engine.dispatch({ type: "end" });
  toast(`Recoloured ${plural(ids.length, "layer")} · ${next.toUpperCase()}`);
  return ids.length;
}
