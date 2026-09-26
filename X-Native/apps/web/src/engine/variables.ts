/**
 * Variable resolution: collections, modes, aliases, and layer bindings.
 *
 * Figma's model, reduced to what the engine needs:
 * - A variable lives in a collection and holds one value per mode. Slots
 *   without an override fall back to the default `value`.
 * - A slot may hold an alias ({ alias: variableId }) instead of a literal.
 *   Aliases must point at a same-type variable; broken chains (missing
 *   target, type mismatch, cycle) resolve to a type-appropriate fallback
 *   and report `broken` so the UI can flag them instead of crashing.
 * - Layers bind props to variables by id; the engine re-applies the
 *   resolved value on every relayout, under the collection's active mode.
 */
import type {
  VariableCollection,
  VariableItem,
  VariableType,
  VariableValue,
  XNode,
} from "./types";

export type VariableLiteral = string | number | boolean;

export function isAlias(v: VariableValue | undefined): v is { alias: string } {
  return !!v && typeof v === "object" && typeof (v as { alias?: unknown }).alias === "string";
}

/** Zero value used when an alias chain is broken. */
export function fallbackForType(type: VariableType): VariableLiteral {
  switch (type) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "color":
      return "#00000000";
    case "string":
      return "";
  }
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Coerce raw editor text into a typed literal. Strict on purpose: the
 * variables panel surfaces the error instead of storing garbage.
 */
export function coerceVariableValue(
  type: VariableType,
  raw: string,
): { ok: true; value: VariableLiteral } | { ok: false; error: string } {
  const text = raw.trim();
  switch (type) {
    case "number": {
      if (!text) return { ok: false, error: "Must be a number." };
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `"${raw}" is not a number.` };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false, error: `Use "true" or "false".` };
    }
    case "color": {
      if (COLOR_RE.test(text) || text.startsWith("rgb(") || text.startsWith("rgba("))
        return { ok: true, value: text };
      return { ok: false, error: "Must be a color like #0d99ff." };
    }
    case "string":
      return { ok: true, value: raw };
  }
}

/**
 * Layer props that may bind to a variable, with the variable type each
 * needs. Mirrors Figma's scope lists (number: width/height, gap, padding,
 * corner radius, font weight/size/line-height/letter-spacing/paragraph
 * spacing/indent, stroke, opacity, text content; string: text, font
 * family/weight-or-style; color: fill/stroke; boolean: visibility).
 * `text` also accepts numbers (Figma renders them as content).
 */
export const BINDABLE_PROPS: Record<string, VariableType> = {
  fill: "color",
  strokePaint: "color",
  strokeWidth: "number",
  opacity: "number",
  fontSize: "number",
  cornerRadii: "number",
  visible: "boolean",
  text: "string",
  w: "number",
  h: "number",
  letterSpacing: "number",
  lineHeight: "number",
  paragraphSpacing: "number",
  paragraphIndent: "number",
  fontWeight: "number",
  fontFamily: "string",
  layoutGap: "number",
  layoutPadding: "number",
};

export interface ResolvedVariable {
  value: VariableLiteral;
  broken: boolean;
  reason?: "missing" | "cycle" | "type-mismatch";
}

function collectionOf(collections: VariableCollection[], v: VariableItem): VariableCollection | undefined {
  return collections.find((c) => c.name === v.collection);
}

function slotValue(v: VariableItem, modeId: string | undefined): VariableValue {
  if (modeId && v.values && v.values[modeId] !== undefined) return v.values[modeId];
  return v.value;
}

/**
 * Resolve one variable to a literal under the given active modes.
 * Returns null when the id is unknown; `broken` is set (with a safe
 * fallback value) when the alias chain cannot be followed.
 */
export function resolveVariable(
  vars: VariableItem[],
  collections: VariableCollection[],
  activeModes: Record<string, string>,
  id: string,
  seen: Set<string> = new Set(),
): ResolvedVariable | null {
  const v = vars.find((x) => x.id === id);
  if (!v) return null;
  if (seen.has(id)) return { value: fallbackForType(v.type), broken: true, reason: "cycle" };
  const col = collectionOf(collections, v);
  const modeId = col ? (activeModes[col.id] ?? col.modes[0]?.id) : undefined;
  const raw = slotValue(v, modeId);
  if (!isAlias(raw)) return { value: raw as VariableLiteral, broken: false };
  seen.add(id);
  const target = vars.find((x) => x.id === raw.alias);
  if (!target) return { value: fallbackForType(v.type), broken: true, reason: "missing" };
  if (target.type !== v.type) return { value: fallbackForType(v.type), broken: true, reason: "type-mismatch" };
  return resolveVariable(vars, collections, activeModes, target.id, seen);
}

/**
 * Name/id -> literal map for expression evaluation, under the active modes.
 * Broken entries resolve to their fallback so expressions never see an
 * alias object.
 */
export function resolveAllForMode(
  vars: VariableItem[],
  collections: VariableCollection[],
  activeModes: Record<string, string>,
): Record<string, VariableLiteral> {
  const out: Record<string, VariableLiteral> = {};
  for (const v of vars) {
    const r = resolveVariable(vars, collections, activeModes, v.id);
    const value = r ? r.value : fallbackForType(v.type);
    out[v.name] = value;
    out[v.id] = value;
  }
  return out;
}

/**
 * Apply a resolved literal to a bound layer prop. Returns false when the
 * prop does not apply to this node (text-only props on a rectangle, …).
 */
export function applyBinding(node: XNode, prop: string, value: VariableLiteral): boolean {
  switch (prop) {
    case "fill":
      if (typeof value !== "string") return false;
      node.fill = value;
      return true;
    case "strokePaint":
      if (typeof value !== "string") return false;
      node.strokePaint = value;
      return true;
    case "strokeWidth":
      if (typeof value !== "number") return false;
      node.strokeWidth = Math.max(0, value);
      return true;
    case "opacity":
      if (typeof value !== "number") return false;
      node.opacity = Math.min(1, Math.max(0, value));
      return true;
    case "fontSize":
      if (node.kind !== "text" || typeof value !== "number") return false;
      node.fontSize = Math.max(1, value);
      return true;
    case "cornerRadii":
      if (!node.cornerRadii || typeof value !== "number") return false;
      node.cornerRadii = [value, value, value, value];
      return true;
    case "visible":
      if (typeof value !== "boolean") return false;
      node.visible = value;
      return true;
    case "text":
      if (node.kind !== "text") return false;
      // Numbers render as content (Figma tip for calculated copy).
      if (typeof value === "number") {
        node.text = String(value);
        return true;
      }
      if (typeof value !== "string") return false;
      node.text = value;
      return true;
    case "w":
      if (typeof value !== "number") return false;
      node.w = Math.max(1, value);
      return true;
    case "h":
      if (typeof value !== "number") return false;
      node.h = Math.max(1, value);
      return true;
    case "letterSpacing":
      if (node.kind !== "text" || typeof value !== "number") return false;
      node.letterSpacing = value;
      return true;
    case "lineHeight":
      if (node.kind !== "text" || typeof value !== "number") return false;
      node.lineHeight = value;
      return true;
    case "paragraphSpacing":
      if (node.kind !== "text" || typeof value !== "number") return false;
      node.paragraphSpacing = value;
      return true;
    case "paragraphIndent":
      if (node.kind !== "text" || typeof value !== "number") return false;
      node.paragraphIndent = value;
      return true;
    case "fontWeight":
      if (node.kind !== "text" || typeof value !== "number") return false;
      node.fontWeight = value;
      return true;
    case "fontFamily":
      if (node.kind !== "text" || typeof value !== "string") return false;
      node.fontFamily = value;
      return true;
    case "layoutGap":
      if (!node.layout || typeof value !== "number") return false;
      node.layout.gap = Math.max(0, value);
      return true;
    case "layoutPadding":
      if (!node.layout || typeof value !== "number") return false;
      node.layout.padding = [value, value, value, value];
      return true;
    default:
      return false;
  }
}

/**
 * True when aliasing `sourceId` to `targetId` in the given slot would close
 * a reference loop. Figma refuses these at author ("that selection would
 * create an infinite loop of variables"); the resolver's `broken: cycle`
 * branch stays as the backstop for legacy documents.
 */
export function wouldCycle(
  vars: VariableItem[],
  collections: VariableCollection[],
  sourceId: string,
  targetId: string,
  modeId?: string,
): boolean {
  if (sourceId === targetId) return true;
  // The new edge lives in one slot; only that slot's chain can close.
  const slotOf = (v: VariableItem): VariableValue => {
    if (modeId && v.values && v.values[modeId] !== undefined) {
      const col = collections.find((c) => c.name === v.collection);
      if (col?.modes.some((m) => m.id === modeId)) return v.values[modeId];
    }
    return v.value;
  };
  const seen = new Set<string>();
  let cur: string | undefined = targetId;
  while (cur && !seen.has(cur)) {
    if (cur === sourceId) return true;
    seen.add(cur);
    const v = vars.find((x) => x.id === cur);
    const slot = v ? slotOf(v) : undefined;
    cur = v && slot !== undefined && isAlias(slot) ? slot.alias : undefined;
  }
  return cur === sourceId;
}

/**
 * Build the default collections for a variable list that predates them
 * (old documents, fresh seeds): one collection per distinct name with a
 * single "Default" mode.
 */
export function migrateCollections(vars: VariableItem[]): VariableCollection[] {
  const names = Array.from(new Set(vars.map((v) => v.collection)));
  return names.map((name, i) => ({
    id: `col-${i + 1}`,
    name,
    modes: [{ id: `col-${i + 1}-mode-1`, name: "Default" }],
  }));
}
