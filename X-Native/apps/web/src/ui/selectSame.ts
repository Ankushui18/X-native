import { find, findParent } from "../engine/memory";
import type { Engine, Snapshot, XNode } from "../engine/types";
import { plural, toast } from "./toast";

/**
 * The selection helpers for "Select layers and objects" and "Identify
 * matching objects": pick one layer out of a stack, grab everything that shares
 * a property, and grab the same object in every frame.
 *
 * All three are pure walks over the page, which keeps them testable without a
 * canvas and keeps behaviour identical whether the command came from the right
 * click menu, the command list, or a shortcut.
 */

/** Paint roles the "same …" commands understand. */
export type SameKind = "fill" | "stroke" | "effect" | "text" | "font" | "properties" | "instance";

export const SAME_KINDS: { id: SameKind; label: string }[] = [
  { id: "properties", label: "Properties" },
  { id: "fill", label: "Fill" },
  { id: "stroke", label: "Stroke" },
  { id: "effect", label: "Effect" },
  { id: "text", label: "Text properties" },
  { id: "font", label: "Font" },
  { id: "instance", label: "Instance" },
];

const NONE = "#00000000";

function hex(value: string | undefined): string | null {
  if (!value || value === NONE || value.length < 7) return null;
  return value.slice(0, 7).toLowerCase();
}

/** Every colour a layer paints with, fills or strokes depending on `kind`. A
 *  hidden paint does not count: it is not on the canvas, so it is not a match. */
function painted(n: XNode, kind: "fill" | "stroke"): string[] {
  const out: string[] = [];
  if (kind === "fill") {
    if (n.fillVisible !== false) {
      const base = hex(n.fill);
      if (base) out.push(base);
      for (const f of n.fills ?? []) {
        if (f.visible === false) continue;
        const c = hex(f.color);
        if (c) out.push(c);
      }
    }
  } else if (n.strokeVisible !== false && n.strokeWidth > 0) {
    const base = hex(n.strokePaint);
    if (base) out.push(base);
    for (const s of n.strokes ?? []) {
      if (s.visible === false) continue;
      const c = hex(s.color);
      if (c) out.push(c);
    }
  }
  return [...new Set(out)];
}

function effects(n: XNode): string[] {
  return (n.effects ?? [])
    .filter((e) => e.visible !== false)
    .map((e) =>
      [
        e.kind,
        e.color ?? "",
        Math.round((e.x ?? 0) * 100) / 100,
        Math.round((e.y ?? 0) * 100) / 100,
        Math.round((e.blur ?? 0) * 100) / 100,
        Math.round((e.spread ?? 0) * 100) / 100,
      ].join("|"),
    );
}

/** The type recipe "same text properties" compares. Metrics that change how the
 *  copy looks, not what it says, so two layers with the same style match even
 *  when their strings differ. */
function typography(n: XNode): string {
  return [
    n.fontFamily,
    n.fontSize,
    n.fontWeight,
    n.lineHeight || "auto",
    n.letterSpacing,
    n.paragraphSpacing || 0,
    n.textAlign,
    n.textAlignVertical,
    n.textDecoration,
    n.textCase ?? "origin",
    n.textWrap ?? "auto",
    n.listStyle ?? "none",
  ].join("|");
}

/**
 * What "same properties" compares: everything a designer would notice about the
 * layer except where it sits. Size is included, so two identical buttons match
 * while a wider one does not.
 */
function properties(n: XNode): string {
  return [
    n.kind,
    Math.round(n.w * 100) / 100,
    Math.round(n.h * 100) / 100,
    n.opacity,
    (n.cornerRadii ?? []).join(","),
    n.strokeWidth,
    hex(n.strokePaint) ?? "",
    painted(n, "fill").join(","),
    effects(n).join(","),
    n.blendMode ?? "normal",
    n.kind === "text" ? typography(n) : "",
  ].join(";");
}

function shares(n: XNode, ref: XNode, kind: SameKind): boolean {
  if (n === ref) return false;
  switch (kind) {
    case "fill": {
      const mine = painted(ref, "fill");
      return mine.length > 0 && painted(n, "fill").some((c) => mine.includes(c));
    }
    case "stroke": {
      const mine = painted(ref, "stroke");
      return mine.length > 0 && painted(n, "stroke").some((c) => mine.includes(c));
    }
    case "effect": {
      const mine = effects(ref);
      return mine.length > 0 && effects(n).some((e) => mine.includes(e));
    }
    case "text":
      return n.kind === "text" && ref.kind === "text" && typography(n) === typography(ref);
    case "font":
      return (
        n.kind === "text" &&
        ref.kind === "text" &&
        n.fontFamily === ref.fontFamily &&
        n.fontWeight === ref.fontWeight
      );
    case "properties":
      return properties(n) === properties(ref);
    case "instance": {
      const mine = ref.componentId && !ref.isComponent ? ref.componentId : null;
      return !!mine && !!n.componentId && !n.isComponent && n.componentId === mine;
    }
  }
}

/** Every layer on the page that shares the reference layer's `kind`. */
export function sameIds(root: XNode, ref: XNode, kind: SameKind): string[] {
  const out: string[] = [];
  const walk = (n: XNode) => {
    if (n.visible === false) return;
    for (const ch of n.children) {
      if (ch.visible !== false && shares(ch, ref, kind)) out.push(ch.id);
      walk(ch);
    }
  };
  walk(root);
  return out;
}

/** A text layer still named after its content was never named by hand, which is
 *  the rule to identify it by its typography instead of its name. */
function implicitName(n: XNode): boolean {
  if (n.kind !== "text") return false;
  const first = (n.text ?? "").split("\n")[0].slice(0, 60);
  return !n.name || n.name === "Text" || n.name === first;
}

interface PathEntry {
  top: XNode | null;
  /** The ancestor names that have to match, joined; the node's own name last. */
  key: string;
}

/**
 * Index every layer by the name-path compared when it looks for matching
 * objects. A top-level layer's key is its own name, because it has no parents; a
 * nested one's key is the chain *below* its top-level frame, which is the rule
 * that lets the same "Header" match between a "Cart" and a "Checkout" frame
 * while a differently named parent still breaks the match.
 */
export function pathIndex(root: XNode): Map<string, PathEntry> {
  const map = new Map<string, PathEntry>();
  const own = (n: XNode) => (implicitName(n) ? `text:${typography(n)}` : n.name);
  const visit = (n: XNode, top: XNode | null, parts: string[], depth: number) => {
    const name = own(n);
    // The depth leads the key: "a rectangle called Rectangle at the top level"
    // and "a rectangle called Rectangle two levels down" are different objects
    // and sharing a key here would tie them together.
    const chain = top === null ? [name] : [...parts, name];
    map.set(n.id, { top, key: `${depth}:${chain.join("/")}` });
    const nextTop = top ?? n;
    const nextParts = top === null ? [] : [...parts, name];
    for (const ch of n.children) visit(ch, nextTop, nextParts, depth + 1);
  };
  for (const ch of root.children) visit(ch, null, [], 1);
  return map;
}

/**
 * Matching-object rule: same layer name, same ancestor names, same
 * position in the hierarchy - but never the same top-level frame, since the
 * point is to find the copy in *another* frame. Depth is part of the key rather
 * than implied by it, so a loose layer and a nested one that happen to share a
 * name stay separate objects.
 */
export function matchingIds(root: XNode, ref: XNode): string[] {
  const index = pathIndex(root);
  const start = index.get(ref.id);
  if (!start) return [];
  const out: string[] = [];
  const walk = (n: XNode) => {
    if (n.visible === false) return;
    for (const ch of n.children) {
      const hit = index.get(ch.id);
      if (ch !== ref && ch.visible !== false && hit && hit.key === start.key && hit.top !== start.top)
        out.push(ch.id);
      walk(ch);
    }
  };
  walk(root);
  return out;
}

/**
 * The layers under a point, in Layers-panel order (topmost first) - the list
 * behind the "Select layer" submenu. Hidden layers are left out; locked ones
 * stay in, because selecting a locked layer is exactly what this menu is for.
 * A frame/group appears above its children, the same order the panel shows.
 */
export function layersAt(root: XNode, wx: number, wy: number, limit = 12): XNode[] {
  const out: XNode[] = [];
  const visit = (n: XNode, x: number, y: number) => {
    if (n.visible === false || out.length >= limit) return;
    const inside = x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h;
    if (!inside) return;
    out.push(n);
    for (const ch of [...n.children].reverse()) {
      visit(ch, x - n.x, y - n.y);
      if (out.length >= limit) return;
    }
  };
  for (const ch of [...root.children].reverse()) visit(ch, wx, wy);
  return out;
}

export function labelOf(kind: SameKind): string {
  return SAME_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

/** Select everything on the page sharing the current layer's `kind`. */
export function selectSame(engine: Engine, snap: Snapshot, kind: SameKind) {
  const root = snap.pages[snap.page].root;
  const id = snap.selection[0];
  const node = id ? find(root, id) : null;
  if (!node) {
    toast("Select a layer first");
    return;
  }
  const ids = sameIds(root, node, kind);
  if (!ids.length) {
    toast(`Nothing else on this page has the same ${labelOf(kind).toLowerCase()}`);
    return;
  }
  engine.dispatch({ type: "select", ids: [...new Set([node.id, ...ids])] });
  toast(`Selected ${plural(ids.length, "more layer")} · same ${labelOf(kind).toLowerCase()}`);
}

/** "Select matching layers": the same object in every other frame. */
export function selectMatching(engine: Engine, snap: Snapshot) {
  const root = snap.pages[snap.page].root;
  const id = snap.selection[0];
  const node = id ? find(root, id) : null;
  if (!node) {
    toast("Select a layer first");
    return;
  }
  const ids = matchingIds(root, node);
  if (!ids.length) {
    toast("No matching layers · a match needs the same name, parent names, and depth in another frame");
    return;
  }
  engine.dispatch({ type: "select", ids: [node.id, ...ids] });
  toast(`Selected ${plural(ids.length, "matching layer")} across frames`);
}

/**
 * Everything else at the same level: `⌘A ⇧` "select the inverse". It is
 * scoped to siblings because ⌘A itself is - inside a frame it selects the
 * frame's children, so the inverse has to mean the same neighbourhood.
 */
export function selectInverse(engine: Engine, snap: Snapshot) {
  const root = snap.pages[snap.page].root;
  const first = snap.selection[0];
  const parent = first ? findParent(root, first) ?? root : root;
  const had = new Set(snap.selection);
  const ids = parent.children.filter((c) => c.visible !== false && !c.locked && !had.has(c.id)).map((c) => c.id);
  if (!ids.length) {
    toast("Nothing else to select here");
    return;
  }
  engine.dispatch({ type: "select", ids });
  toast(`Selected ${plural(ids.length, "other layer")} at this level`);
}
