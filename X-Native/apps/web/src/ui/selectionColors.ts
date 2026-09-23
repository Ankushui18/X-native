import type { Engine, Snapshot, XNode } from "../engine/types";
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
}

const NONE = "#00000000";

function norm(value: string | undefined): string | null {
  if (!value || value.length < 7 || value === NONE) return null;
  return value.slice(0, 7).toLowerCase();
}

/** Colours used inside `node`, counted, grouped and ordered by frequency. */
export function colorUsage(node: XNode): ColorUsage[] {
  const map = new Map<string, ColorUsage>();
  const add = (hex: string | null, bucket: ColorBucket, id: string) => {
    if (!hex) return;
    const key = `${bucket}:${hex}`;
    const hit = map.get(key);
    if (hit) {
      hit.count++;
      hit.ids.push(id);
    } else {
      map.set(key, { hex, bucket, count: 1, ids: [id] });
    }
  };
  const walk = (n: XNode) => {
    if (n.visible === false) return;
    const fill = norm(n.fill);
    if (fill && n.fillVisible !== false) add(fill, n.kind === "text" ? "Text" : "Fill", n.id);
    for (const f of n.fills ?? []) {
      if (f.visible === false) continue;
      add(norm(f.color), n.kind === "text" ? "Text" : "Fill", n.id);
    }
    const stroke = norm(n.strokePaint);
    if (stroke && n.strokeVisible !== false && n.strokeWidth > 0) add(stroke, "Border", n.id);
    for (const s of n.strokes ?? []) {
      if (s.visible === false) continue;
      add(norm(s.color), "Border", n.id);
    }
    for (const ch of n.children) walk(ch);
  };
  walk(node);
  return [...map.values()].sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
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
