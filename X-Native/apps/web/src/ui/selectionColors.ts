import type { Engine, GradientStop, Snapshot, XNode } from "../engine/types";
import { find } from "../engine/memory";
import { plural, toast } from "./toast";

/**
 * Selection colors: a summary of every colour
 * inside the current selection, grouped by what it paints and sorted by how
 * often it appears. Editing a row recolours the *selection* only (Figma:
 * "View and adjust colors in a mixed selection" — these controls edit colors
 * in the selected layers); finding everything else on the page that shares the
 * colour stays available as the explicit hex action ("Select all with same
 * fill"), so an ordinary swatch edit never silently repaints unselected work.
 */

export type ColorBucket = "Fill" | "Border" | "Text";

export interface ColorUsage {
  hex: string;
  bucket: ColorBucket;
  count: number;
  ids: string[];
  /** The fill opacity shared by every use of this colour, or null when the
   *  selection is mixed - the field shows nothing until it can show one value. */
  opacity: number | null;
}

const NONE = "#00000000";

function norm(value: string | undefined): string | null {
  if (!value || value.length < 7 || value === NONE) return null;
  return value.slice(0, 7).toLowerCase();
}

/** The colours a single paint contributes. Selection colors skips image
 *  and pattern fills, shows gradients by the colours in their ramp (those are
 *  the pixels that are actually on the canvas), and skips mask paints — Figma's
 *  mixed-selection color rules exclude masks, which tint rather than paint. A
 *  leftover `color` string on an image fill would otherwise be listed as if it
 *  painted. */
function paintColors(
  type: string | undefined,
  color: string | undefined,
  stops: GradientStop[] | undefined,
  opacity: number | undefined,
): { hex: string; opacity: number | undefined }[] {
  if (type === "image" || type === "pattern" || type === "mask" || !color) return [];
  if (type && type !== "solid" && stops && stops.length)
    return stops
      .map((s) => ({ hex: norm(s.color) ?? "", opacity }))
      .filter((e) => e.hex);
  const hex = norm(color);
  return hex ? [{ hex, opacity }] : [];
}

/** Where one usage colour lives inside a paint: the base colour itself, or
 *  specific gradient stops. Listing, matching and editing must agree on this
 *  granularity or a displayed row edits nothing (gradient stops used to be
 *  listed but never matched). */
interface PaintRefinement {
  base: boolean;
  stopIndexes: number[];
}
function refinePaint(
  type: string | undefined,
  color: string | undefined,
  stops: GradientStop[] | undefined,
  hex: string,
): PaintRefinement | null {
  if (type === "image" || type === "pattern" || type === "mask") return null;
  if (type && type !== "solid" && stops && stops.length) {
    const idx = stops.map((s) => norm(s.color)).map((c) => (c === hex ? 1 : -1)).filter((i) => i > 0);
    return idx.length ? { base: false, stopIndexes: idx } : null;
  }
  return norm(color) === hex ? { base: true, stopIndexes: [] } : null;
}

/** One eligible paint occurrence: where a usage colour actually lives, so
 *  editing writes exactly the base colour or stop that was listed. */
interface PaintSite {
  kind: "fill" | "stroke";
  /** Index into `fills`/`strokes`; -1 = the node's base fill/stroke fields. */
  slot: number;
  /** For gradient paints, which stops carry the colour; empty = base color. */
  stopIndexes: number[];
  opacity: number;
}

/** The eligible paint occurrences of `node` carrying `hex` in this bucket.
 *  Shared by listing (via colorUsageAll), matching and editing so the three
 *  can never disagree (F01/F10). Mask layers are skipped entirely — Figma's
 *  mixed-selection rules exclude mask paints — and boolean members' paints are
 *  skipped because the boolean group's own paints describe what it renders. */
function sitesForColor(n: XNode, hex: string, bucket: ColorBucket): PaintSite[] {
  const out: PaintSite[] = [];
  if (n.isMask || n.booleanOp !== null) return out;
  const wantFill = bucket === "Fill" || bucket === "Text";
  if (bucket === "Text" && n.kind !== "text") return out;
  if (bucket === "Fill" && n.kind === "text") return out;
  if (wantFill) {
    if (n.fillVisible !== false) {
      const base = refinePaint(n.fillType, n.fill, n.gradientStops, hex);
      if (base && base.base) out.push({ kind: "fill", slot: -1, stopIndexes: [], opacity: n.fillOpacity ?? 1 });
      if (base && base.stopIndexes.length)
        out.push({ kind: "fill", slot: -1, stopIndexes: base.stopIndexes, opacity: n.fillOpacity ?? 1 });
      for (let i = 0; i < (n.fills?.length ?? 0); i++) {
        const f = n.fills![i];
        if (f.visible === false) continue;
        const r = refinePaint(f.type, f.color, f.stops, hex);
        if (!r) continue;
        out.push({ kind: "fill", slot: i, stopIndexes: r.base ? [] : r.stopIndexes, opacity: f.opacity ?? 1 });
      }
    }
    return out;
  }
  if (n.strokeVisible === false || !(n.strokeWidth ?? 0) > 0) return out;
  const base = refinePaint(undefined, n.strokePaint, undefined, hex);
  if (base?.base) out.push({ kind: "stroke", slot: -1, stopIndexes: [], opacity: n.strokeOpacity ?? 1 });
  for (let i = 0; i < (n.strokes?.length ?? 0); i++) {
    const st = n.strokes![i];
    if (st.visible === false) continue;
    const r = refinePaint(undefined, st.color, undefined, hex);
    if (r?.base) out.push({ kind: "stroke", slot: i, stopIndexes: [], opacity: st.opacity ?? 1 });
  }
  return out;
}

/** Colours used inside `node`, counted, grouped and ordered by frequency. */
export function colorUsage(node: XNode): ColorUsage[] {
  return colorUsageAll([node]);
}

/** The row lists the colours of the *selection*, not of one layer: every
 *  selected layer contributes, and a colour used by two of them is still one
 *  row. Passing several nodes is what makes a multi-select read correctly.
 *  Boolean groups contribute their own paints only — member paints belong to
 *  the operation, not the artwork (F10). */
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
    const boolGroup = n.booleanOp !== null;
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
    // A boolean group renders as one shape from its members' geometry; the
    // members' own paints are hidden behind the group paint, so they must not
    // produce rows (and would double-count the group colour).
    if (!boolGroup) for (const ch of n.children) walk(ch);
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

/** Layers on the page whose eligible paints carry this usage colour. */
export function matchingIds(root: XNode, usage: ColorUsage): string[] {
  const out: string[] = [];
  const walk = (n: XNode) => {
    if (n.visible === false) return;
    if (sitesForColor(n, usage.hex, usage.bucket).length) out.push(n.id);
    if (n.booleanOp === null) for (const ch of n.children) walk(ch);
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
 * Set the opacity of every paint occurrence that carries this colour, in one
 * undo step — The percentage field on a Selection colors row. It writes the
 * layers the row was built from (the selection), not every layer on the page:
 * silently repainting something the designer never picked is worse than a
 * narrower tool. Gradient stops are addressed precisely (the stop the row
 * lists is the stop that changes); a solid/gradient paint's own opacity still
 * applies to the whole paint, because the row lists the colours it paints.
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
    const sites = sitesForColor(n, usage.hex, usage.bucket);
    for (const s of sites) {
      if (s.kind === "stroke") {
        if (s.slot < 0) patch.strokeOpacity = o;
        else {
          const strokes = [...(n.strokes ?? [])];
          if (strokes[s.slot]) strokes[s.slot] = { ...strokes[s.slot], opacity: o };
          patch.strokes = strokes;
        }
        continue;
      }
      // Fill sites: only rewrite the base fill fields when no stacked fill
      // also matches, so a stacked edit can't clobber the base and vice versa.
      const stackSite = sites.find((x) => x.kind === "fill" && x.slot >= 0);
      if (stackSite) {
        const fills = [...(n.fills ?? [])];
        const f = fills[stackSite.slot];
        if (f) fills[stackSite.slot] = { ...f, opacity: o };
        patch.fills = fills;
      } else if (s.slot < 0) {
        patch.fillOpacity = o;
      }
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
 * Recolour the selected layers that share `usage`'s colour, in one undo step.
 * A node can carry a base paint and a paint list, so both are rewritten where
 * they match — anything else leaves a half-updated layer behind. Gradient
 * stops listed by the row are rewritten in place without moving their
 * positions. Scope is the row's own layers (the selection); page-wide
 * gathering stays behind the explicit "Select all with this colour" action.
 */
export function recolorMatches(engine: Engine, root: XNode, usage: ColorUsage, next: string): number {
  const ids = [...new Set(usage.ids)];
  let touched = 0;
  engine.dispatch({ type: "begin" });
  for (const id of ids) {
    const n = find(root, id);
    if (!n) continue;
    const sites = sitesForColor(n, usage.hex, usage.bucket);
    if (!sites.length) continue;
    const patch: Record<string, unknown> = {};
    if (usage.bucket === "Border") {
      if (sites.some((s) => s.kind === "stroke" && s.slot < 0)) {
        patch.strokePaint = next;
        patch.strokeVisible = true;
      }
      const strokeSites = sites.filter((s) => s.kind === "stroke" && s.slot >= 0);
      if (strokeSites.length && n.strokes?.length) {
        patch.strokes = n.strokes.map((st, i) =>
          strokeSites.some((s) => s.slot === i) ? { ...st, color: next } : st,
        );
      }
    } else {
      const fillSites = sites.filter((s) => s.kind === "fill");
      const baseSites = fillSites.filter((s) => s.slot < 0);
      const stackSites = fillSites.filter((s) => s.slot >= 0);
      for (const s of baseSites) {
        if (s.stopIndexes.length) {
          const stops = [...(n.gradientStops ?? [])];
          for (const i of s.stopIndexes) if (stops[i]) stops[i] = { ...stops[i], color: next };
          patch.gradientStops = stops;
        } else {
          patch.fill = next;
          patch.fillVisible = true;
        }
      }
      if (stackSites.length && n.fills?.length) {
        patch.fills = n.fills.map((f, i) => {
          const s = stackSites.find((x) => x.slot === i);
          if (!s) return f;
          if (s.stopIndexes.length) {
            const stops = [...(f.stops ?? [])];
            for (const j of s.stopIndexes) if (stops[j]) stops[j] = { ...stops[j], color: next };
            return { ...f, stops };
          }
          return { ...f, color: next };
        });
      }
    }
    if (Object.keys(patch).length) {
      engine.dispatch({ type: "patch", id, patch: patch as never });
      touched++;
    }
  }
  engine.dispatch({ type: "end" });
  if (touched) toast(`Recoloured ${plural(touched, "layer")} · ${next.toUpperCase()}`);
  return touched;
}
