/**
 * Phase 5 (P1.9) — subtree code generation.
 *
 * The single-node snippet generators in `ui/inspector.tsx` answer "what is
 * this layer"; this module answers "how do I build this subtree". It walks a
 * node and its children once into a small intermediate tree (`CodeElement`),
 * inferring layout (Auto Layout → flex/grid, freeform → absolute), resolving
 * values against design tokens, and honouring component → code mappings —
 * then renders that tree for each supported framework.
 *
 * Everything here is pure over `Snapshot` + `XNode`, so the same functions
 * feed Dev Mode, the design API (`engine/designApi.ts`), and headless tests.
 */
import type {
  AutoLayout,
  CodeMapping,
  ComponentMaster,
  Snapshot,
  VariableItem,
  VariableValue,
  XNode,
} from "./types";
import { sideWidths } from "./strokeModel";

export type TreeFormat = "tsx" | "html" | "tailwind" | "css" | "vue" | "svelte";
export type CodeUnit = "px" | "rem";

/** Layout inference for one container: what CSS layout the node becomes. */
export type InferredLayout =
  | { kind: "flex"; direction: "row" | "column" }
  | { kind: "grid" }
  | { kind: "absolute" }
  | { kind: "none" };

export interface ComponentRef {
  name: string;
  importPath?: string;
  /** Props in render order: [codeProp, renderedValue] — `null` renders bare. */
  props: [string, string | null][];
  children?: string;
  framework: string;
}

/** The intermediate tree: one element per emitted node. */
export interface CodeElement {
  tag: string;
  className: string;
  text?: string;
  /** CSS declarations in order, token refs already applied. */
  styles: [string, string][];
  /** Tailwind utilities in order (only meaningful for the tailwind emitter). */
  tailwind: string[];
  children: CodeElement[];
  layout: InferredLayout;
  componentRef?: ComponentRef;
  /** "No CSS equivalent" caveats, rendered as comments by the emitters. */
  notes: string[];
  raw: XNode;
}

export interface CodegenOptions {
  format: TreeFormat;
  unit?: CodeUnit;
  /** 0 = the root alone ("Layer" scope in Dev Mode). Default: Infinity. */
  maxDepth?: number;
  snap?: Snapshot | null;
}

/* ── small string helpers ─────────────────────────────────────────────── */

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "layer";
}

export function toPascal(name: string): string {
  const p = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return p || "Component";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** FNV-1a over a string; used for mapping sync hashes, not security. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/* ── token index ────────────────────────────────────────────────────────
 * Exact value matches resolve to variables: colors to `var(--…)`, numbers
 * (radii, gaps, sizes) to numeric variables, font families to string
 * variables. Type-gated, so a 16px size never steals a 16-character string
 * token's name.
 */

export interface TokenIndex {
  colors: Map<string, string>;
  numbers: Map<string, string>;
  strings: Map<string, string>;
}

function tokenizeSegment(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `VariableItem.collection` holds the collection *name* (renames propagate
 * by name); very old documents may hold an id, so try both.
 */
function collectionNameOf(snap: Snapshot | null, collection: string): string {
  if (!snap?.variableCollections?.length) return collection || "tokens";
  const byId = snap.variableCollections.find((c) => c.id === collection);
  if (byId) return byId.name;
  if (snap.variableCollections.some((c) => c.name === collection)) return collection;
  return collection || "tokens";
}

/** `--collection-name`; slashes in token paths become dashes. */
export function cssVarFor(collection: string, name: string): string {
  const c = tokenizeSegment(collection) || "tokens";
  const n = name
    .split("/")
    .map(tokenizeSegment)
    .filter(Boolean)
    .join("-");
  return `--${c}-${n || "token"}`;
}

function resolveVariableValue(
  v: VariableItem,
  byId: Map<string, VariableItem>,
  activeMode?: string,
  seen?: Set<string>,
): VariableValue | undefined {
  const guard = seen ?? new Set<string>();
  if (guard.has(v.id)) return undefined;
  guard.add(v.id);
  const raw: VariableValue =
    activeMode && v.values && v.values[activeMode] !== undefined
      ? v.values[activeMode]
      : v.value;
  if (typeof raw === "object" && raw && "alias" in raw) {
    const target = byId.get((raw as { alias: string }).alias);
    if (!target) return undefined;
    return resolveVariableValue(target, byId, activeMode, guard);
  }
  return raw;
}

export function buildTokenIndex(snap?: Snapshot | null): TokenIndex {
  const index: TokenIndex = { colors: new Map(), numbers: new Map(), strings: new Map() };
  if (!snap?.variables?.length) return index;
  const byId = new Map(snap.variables.map((v) => [v.id, v]));
  const collectionName = (id: string) => collectionNameOf(snap, id);
  for (const v of snap.variables) {
    const mode = snap.activeModes?.[v.collection];
    const resolved = resolveVariableValue(v, byId, mode);
    if (resolved === undefined) continue;
    const cssVar = cssVarFor(collectionName(v.collection), v.name);
    if (v.type === "color" && typeof resolved === "string") {
      const key = resolved.trim().toLowerCase();
      if (!index.colors.has(key)) index.colors.set(key, cssVar);
    } else if (v.type === "number" && typeof resolved === "number") {
      const key = String(Math.round(resolved * 100) / 100);
      if (!index.numbers.has(key)) index.numbers.set(key, cssVar);
    } else if (v.type === "string" && typeof resolved === "string") {
      if (!index.strings.has(resolved)) index.strings.set(resolved, cssVar);
    }
  }
  return index;
}

/* ── layout inference (P1.9: "build layout inference") ────────────────── */

export function inferLayout(n: XNode): InferredLayout {
  if (!n.children?.length) return { kind: "none" };
  const layout = n.layout;
  if (!layout) return { kind: "absolute" };
  if (layout.direction === "grid") return { kind: "grid" };
  return {
    kind: "flex",
    direction: layout.direction === "horizontal" ? "row" : "column",
  };
}

interface Ctx {
  unit: CodeUnit;
  tokens: TokenIndex;
  snap: Snapshot | null;
  varsById: Map<string, VariableItem>;
  format: TreeFormat;
  maxDepth: number;
  used: Map<string, number>;
}

function len(px: number, unit: CodeUnit): string {
  if (unit === "rem") {
    const v = Math.round((px / 16) * 100) / 100;
    return `${v}rem`;
  }
  return `${Math.round(px * 100) / 100}px`;
}

function uniqueClass(ctx: Ctx, name: string): string {
  const base = slugify(name);
  const seen = ctx.used.get(base) ?? 0;
  ctx.used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen + 1}`;
}

function tokenColor(ctx: Ctx, hex: string): string | undefined {
  return ctx.tokens.colors.get(hex.trim().toLowerCase());
}

function tokenNumber(ctx: Ctx, value: number): string | undefined {
  return ctx.tokens.numbers.get(String(Math.round(value * 100) / 100));
}

/**
 * A live variable binding always wins over value matching: the designer
 * said "this fill IS brand/primary", so the code says `var(--…)` even if
 * some other token happens to share the hex.
 */
function boundVar(ctx: Ctx, n: XNode, prop: string): string | undefined {
  const id = n.variableBindings?.[prop];
  if (!id) return undefined;
  const v = ctx.varsById.get(id);
  if (!v) return undefined;
  return cssVarFor(collectionNameOf(ctx.snap, v.collection), v.name);
}

function paintOrToken(ctx: Ctx, paint: string): string {
  return tokenColor(ctx, paint) ? `var(${tokenColor(ctx, paint)})` : paint;
}

function numOrToken(ctx: Ctx, value: number): string {
  const t = tokenNumber(ctx, value);
  return t ? `var(${t})` : len(value, ctx.unit);
}

/* ── style resolution: one node → declarations ────────────────────────── */

function flexContainerDecls(layout: AutoLayout, ctx: Ctx, out: [string, string][]): void {
  out.push(["display", "flex"]);
  out.push(["flex-direction", layout.direction === "horizontal" ? "row" : "column"]);
  if (layout.gapMode === "auto") {
    // Auto gap has no single `gap` value: the leftover space is distributed
    // by `spacing`, which maps onto justify-content, not gap.
    if (layout.spacing === "around") out.push(["justify-content", "space-around"]);
    else if (layout.spacing === "evenly") out.push(["justify-content", "space-evenly"]);
    else out.push(["justify-content", "space-between"]);
  } else {
    if (layout.gap) out.push(["gap", numOrToken(ctx, layout.gap)]);
    if (layout.justify === "center") out.push(["justify-content", "center"]);
    else if (layout.justify === "between") out.push(["justify-content", "space-between"]);
    else if (layout.justify === "max") out.push(["justify-content", "flex-end"]);
  }
  const [pl, pr, pt, pb] = layout.padding;
  if (pl || pr || pt || pb) {
    out.push(["padding", [pt, pr, pb, pl].map((v) => len(v, ctx.unit)).join(" ")]);
  }
  if (layout.align === "center") out.push(["align-items", "center"]);
  else if (layout.align === "max") out.push(["align-items", "flex-end"]);
  else if (layout.align === "baseline") out.push(["align-items", "baseline"]);
  if (layout.wrap) out.push(["flex-wrap", "wrap"]);
}

function gridContainerDecls(layout: AutoLayout, ctx: Ctx, out: [string, string][]): void {
  out.push(["display", "grid"]);
  const cols = Math.max(1, layout.columns ?? 1);
  if (layout.colTracks?.length) {
    out.push([
      "grid-template-columns",
      layout.colTracks
        .map((t) =>
          t.mode === "fill"
            ? `${t.fr ?? 1}fr`
            : t.mode === "fixed"
              ? len(t.size ?? 0, ctx.unit)
              : "auto",
        )
        .join(" "),
    ]);
  } else {
    out.push(["grid-template-columns", `repeat(${cols}, 1fr)`]);
  }
  if (layout.rowTracks?.length) {
    out.push([
      "grid-template-rows",
      layout.rowTracks
        .map((t) =>
          t.mode === "fill"
            ? `${t.fr ?? 1}fr`
            : t.mode === "fixed"
              ? len(t.size ?? 0, ctx.unit)
              : "auto",
        )
        .join(" "),
    ]);
  }
  const gapC = layout.gapCols ?? layout.gap;
  const gapR = layout.gapRows ?? layout.gap;
  if (gapC || gapR) {
    if (gapC === gapR) out.push(["gap", numOrToken(ctx, gapC)]);
    else out.push(["gap", `${len(gapR, ctx.unit)} ${len(gapC, ctx.unit)}`]);
  }
  const [pl, pr, pt, pb] = layout.padding;
  if (pl || pr || pt || pb) {
    out.push(["padding", [pt, pr, pb, pl].map((v) => len(v, ctx.unit)).join(" ")]);
  }
}

function resolveStyles(
  n: XNode,
  ctx: Ctx,
  parent: InferredLayout | null,
  isRoot: boolean,
): { decls: [string, string][]; notes: string[] } {
  const decls: [string, string][] = [];
  const notes: string[] = [];
  const inferred = inferLayout(n);

  // Sizing: fill in a flex parent becomes flex growth; hug drops the fixed
  // size so content decides; otherwise the size is pinned.
  const inFlex = parent?.kind === "flex";
  const inGrid = parent?.kind === "grid";
  if (n.sizingW === "fill" && (inFlex || inGrid)) {
    if (inFlex && parent.kind === "flex" && parent.direction === "row") decls.push(["flex", "1"]);
    else decls.push(["align-self", "stretch"]);
  } else if (n.sizingW !== "hug" || isRoot) {
    if (!(n.kind === "text" && n.sizingW === "hug")) decls.push(["width", len(n.w, ctx.unit)]);
  }
  if (n.sizingH === "fill" && (inFlex || inGrid)) {
    if (inFlex && parent.kind === "flex" && parent.direction === "column") decls.push(["flex", "1"]);
    else if (!inGrid) decls.push(["align-self", "stretch"]);
  } else if (n.sizingH !== "hug" || isRoot) {
    if (!(n.kind === "text" && n.sizingH === "hug")) decls.push(["height", len(n.h, ctx.unit)]);
  }
  if ((n.sizingW === "hug" || n.sizingH === "hug") && inFlex) decls.push(["flex-shrink", "0"]);

  // Position: freeform children are absolutely placed; their parent is the
  // positioning context.
  if (!isRoot && parent?.kind === "absolute") {
    decls.push(["position", "absolute"]);
    decls.push(["left", len(n.x, ctx.unit)]);
    decls.push(["top", len(n.y, ctx.unit)]);
  }
  if (!isRoot && inferred.kind === "absolute") decls.push(["position", "relative"]);
  if (isRoot && inferred.kind === "absolute") decls.push(["position", "relative"]);

  const boundRadius = boundVar(ctx, n, "cornerRadii");
  if (boundRadius) {
    decls.push(["border-radius", `var(${boundRadius})`]);
  } else if (n.cornerRadii?.some((r) => r > 0)) {
    if (n.cornerIndependent) {
      const [tl, tr, br, bl] = [n.cornerRadii[0], n.cornerRadii[1], n.cornerRadii[3], n.cornerRadii[2]];
      decls.push(["border-radius", [tl, tr, br, bl].map((r) => numOrToken(ctx, r)).join(" ")]);
    } else {
      decls.push(["border-radius", numOrToken(ctx, n.cornerRadii[0])]);
    }
    if (n.cornerSmoothing) {
      notes.push(`corner smoothing ${Math.round(n.cornerSmoothing * 100)}% — border-radius is a circular arc`);
    }
  } else if (n.kind === "ellipse" && !n.arcData) {
    decls.push(["border-radius", "50%"]);
  }
  if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
    const bound = boundVar(ctx, n, "fill");
    decls.push(["background", bound ? `var(${bound})` : paintOrToken(ctx, n.fill)]);
  }
  if (n.strokeVisible && n.strokeWidth > 0 && n.strokePaint) {
    const sides = sideWidths(n.strokeSides, n.strokeSideW, n.strokeWidth);
    const boundStroke = boundVar(ctx, n, "strokePaint");
    const boundWidth = boundVar(ctx, n, "strokeWidth");
    const paint = boundStroke ? `var(${boundStroke})` : paintOrToken(ctx, n.strokePaint);
    const wLen = (w: number) =>
      boundWidth && w === n.strokeWidth ? `var(${boundWidth})` : len(w, ctx.unit);
    if (sides.some((w) => w !== sides[0])) {
      decls.push(["border-width", sides.map((w) => wLen(w)).join(" ")]);
      decls.push(["border-style", sides.map((w) => (w > 0 ? "solid" : "none")).join(" ")]);
      decls.push(["border-color", paint]);
    } else {
      decls.push(["border", `${wLen(sides[0])} solid ${paint}`]);
    }
    if (n.strokeDashPattern?.length) {
      notes.push(`dashes ${n.strokeDashPattern.join(", ")} — no CSS equivalent`);
    }
  }
  if (n.opacity < 1 || boundVar(ctx, n, "opacity")) {
    const bound = boundVar(ctx, n, "opacity");
    decls.push(["opacity", bound ? `var(${bound})` : String(Math.round(n.opacity * 100) / 100)]);
  }

  if (n.layout) {
    if (n.layout.direction === "grid") gridContainerDecls(n.layout, ctx, decls);
    else flexContainerDecls(n.layout, ctx, decls);
  }

  if (n.kind === "text") {
    const family = ctx.tokens.strings.get(n.fontFamily);
    decls.push(["font-family", family ? `var(${family})` : `"${n.fontFamily}", sans-serif`]);
    const boundSize = boundVar(ctx, n, "fontSize");
    const sizeToken = tokenNumber(ctx, n.fontSize);
    decls.push([
      "font-size",
      boundSize ? `var(${boundSize})` : sizeToken ? `var(${sizeToken})` : len(n.fontSize, ctx.unit),
    ]);
    const boundText = n.variableBindings?.text ? ctx.varsById.get(n.variableBindings.text) : undefined;
    if (boundText) notes.push(`text bound to variable "${boundText.name}"`);
    decls.push(["font-weight", String(n.fontWeight)]);
    if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
      // Text fill is the glyph color, not a background.
      const bg = decls.findIndex(([k]) => k === "background");
      if (bg >= 0) decls.splice(bg, 1);
      decls.push(["color", paintOrToken(ctx, n.fill)]);
    }
    if (n.lineHeight) decls.push(["line-height", len(Math.round(n.lineHeight), ctx.unit)]);
    if (n.letterSpacing) decls.push(["letter-spacing", len(n.letterSpacing, ctx.unit)]);
    if (n.textAlign && n.textAlign !== "left") decls.push(["text-align", n.textAlign]);
    if (n.textWrap === "balance" || n.textWrap === "pretty") {
      decls.push(["text-wrap", n.textWrap]);
    }
    if (n.paragraphIndent) decls.push(["text-indent", len(n.paragraphIndent, ctx.unit)]);
    if (n.textCase === "upper") decls.push(["text-transform", "uppercase"]);
    else if (n.textCase === "lower") decls.push(["text-transform", "lowercase"]);
    else if (n.textCase === "title") decls.push(["text-transform", "capitalize"]);
    else if (n.textCase === "small-caps") decls.push(["font-variant", "small-caps"]);
    if (n.textDecoration === "underline") decls.push(["text-decoration", "underline"]);
    else if (n.textDecoration === "strikethrough") decls.push(["text-decoration", "line-through"]);
    if (n.truncate) {
      if (n.maxLines > 1) {
        decls.push(["display", "-webkit-box"]);
        decls.push(["-webkit-line-clamp", String(n.maxLines)]);
        decls.push(["-webkit-box-orient", "vertical"]);
        decls.push(["overflow", "hidden"]);
      } else {
        decls.push(["overflow", "hidden"]);
        decls.push(["text-overflow", "ellipsis"]);
        decls.push(["white-space", "nowrap"]);
      }
    }
  }

  if (n.effects?.length) {
    const shadows = n.effects
      .filter((e) => e.visible && (e.kind === "drop-shadow" || e.kind === "inner-shadow"))
      .map(
        (e) =>
          `${e.kind === "inner-shadow" ? "inset " : ""}${[e.x, e.y, e.blur, e.spread]
            .map((v) => len(v, ctx.unit))
            .join(" ")} ${paintOrToken(ctx, e.color)}`,
      );
    if (shadows.length) decls.push(["box-shadow", shadows.join(", ")]);
    const bgBlur = n.effects.find((e) => e.visible && e.kind === "background-blur");
    if (bgBlur) decls.push(["backdrop-filter", `blur(${len(bgBlur.blur, ctx.unit)})`]);
    const layerBlur = n.effects.find((e) => e.visible && e.kind === "layer-blur");
    if (layerBlur) decls.push(["filter", `blur(${len(layerBlur.blur, ctx.unit)})`]);
    for (const e of n.effects) {
      if (e.visible && (e.kind === "noise" || e.kind === "glass" || e.kind === "texture")) {
        notes.push(`${e.kind} effect — no CSS equivalent`);
      }
    }
  }

  if (n.kind === "vector" || n.kind === "line" || n.kind === "arrow") {
    notes.push("vector — export the layer as SVG and inline it here");
  }
  return { decls, notes };
}

/* ── tailwind resolution: one node → utilities ────────────────────────── */

function twLen(v: number): string {
  return `${Math.round(v * 100) / 100}px`;
}

function resolveTailwind(
  n: XNode,
  ctx: Ctx,
  parent: InferredLayout | null,
  isRoot: boolean,
): string[] {
  const cls: string[] = [];
  const inferred = inferLayout(n);
  const inFlex = parent?.kind === "flex";
  const inRow = inFlex && parent.kind === "flex" && parent.direction === "row";
  const inCol = inFlex && parent.kind === "flex" && parent.direction === "column";

  if (n.sizingW === "fill" && (inFlex || parent?.kind === "grid")) {
    cls.push(inRow ? "flex-1" : "self-stretch");
  } else if (n.sizingW !== "hug" || isRoot) {
    if (!(n.kind === "text" && n.sizingW === "hug")) cls.push(`w-[${twLen(n.w)}]`);
  }
  if (n.sizingH === "fill" && (inFlex || parent?.kind === "grid")) {
    cls.push(inCol ? "flex-1" : parent?.kind === "grid" ? "self-stretch" : "self-stretch");
  } else if (n.sizingH !== "hug" || isRoot) {
    if (!(n.kind === "text" && n.sizingH === "hug")) cls.push(`h-[${twLen(n.h)}]`);
  }
  if ((n.sizingW === "hug" || n.sizingH === "hug") && inFlex) cls.push("shrink-0");

  if (!isRoot && parent?.kind === "absolute") {
    cls.push("absolute", `left-[${twLen(n.x)}]`, `top-[${twLen(n.y)}]`);
  }
  if (inferred.kind === "absolute") cls.push("relative");

  if (n.cornerRadii?.some((r) => r > 0)) {
    if (n.cornerIndependent) {
      const [tl, tr, br, bl] = [n.cornerRadii[0], n.cornerRadii[1], n.cornerRadii[3], n.cornerRadii[2]];
      if (tl) cls.push(`rounded-tl-[${twLen(tl)}]`);
      if (tr) cls.push(`rounded-tr-[${twLen(tr)}]`);
      if (br) cls.push(`rounded-br-[${twLen(br)}]`);
      if (bl) cls.push(`rounded-bl-[${twLen(bl)}]`);
    } else {
      const t = tokenNumber(ctx, n.cornerRadii[0]);
      cls.push(t ? `rounded-[var(${t})]` : `rounded-[${twLen(n.cornerRadii[0])}]`);
    }
  } else if (n.kind === "ellipse" && !n.arcData) {
    cls.push("rounded-full");
  }
  if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
    const bound = boundVar(ctx, n, "fill");
    const t = tokenColor(ctx, n.fill);
    const v = bound ? `var(${bound})` : t ? `var(${t})` : n.fill;
    cls.push(n.kind === "text" ? `text-[${v}]` : `bg-[${v}]`);
  }
  if (n.strokeVisible && n.strokeWidth > 0 && n.strokePaint) {
    const t = tokenColor(ctx, n.strokePaint);
    const v = t ? `var(${t})` : n.strokePaint;
    cls.push(`border-[${twLen(n.strokeWidth)}]`, `border-[${v}]`);
  }
  if (n.opacity < 1) cls.push(`opacity-[${Math.round(n.opacity * 100) / 100}]`);

  if (n.layout) {
    if (n.layout.direction === "grid") {
      cls.push("grid", `grid-cols-${Math.max(1, n.layout.columns ?? 1)}`);
      const gapC = n.layout.gapCols ?? n.layout.gap;
      const gapR = n.layout.gapRows ?? n.layout.gap;
      if (gapC === gapR) {
        if (gapC) cls.push(`gap-[${twLen(gapC)}]`);
      } else {
        if (gapC) cls.push(`gap-x-[${twLen(gapC)}]`);
        if (gapR) cls.push(`gap-y-[${twLen(gapR)}]`);
      }
    } else {
      cls.push("flex", n.layout.direction === "horizontal" ? "flex-row" : "flex-col");
      if (n.layout.gapMode === "auto") {
        cls.push(
          n.layout.spacing === "around"
            ? "justify-around"
            : n.layout.spacing === "evenly"
              ? "justify-evenly"
              : "justify-between",
        );
      } else {
        if (n.layout.gap) {
          const t = tokenNumber(ctx, n.layout.gap);
          cls.push(t ? `gap-[var(${t})]` : `gap-[${twLen(n.layout.gap)}]`);
        }
        if (n.layout.justify === "center") cls.push("justify-center");
        else if (n.layout.justify === "between") cls.push("justify-between");
        else if (n.layout.justify === "max") cls.push("justify-end");
      }
      if (n.layout.align === "center") cls.push("items-center");
      else if (n.layout.align === "max") cls.push("items-end");
      else if (n.layout.align === "baseline") cls.push("items-baseline");
      if (n.layout.wrap) cls.push("flex-wrap");
    }
    const [pl, pr, pt, pb] = n.layout.padding;
    if (pl || pr || pt || pb) cls.push(`p-[${[pt, pr, pb, pl].map(twLen).join(" ")}]`);
  }

  if (n.kind === "text") {
    const sizeToken = tokenNumber(ctx, n.fontSize);
    cls.push(sizeToken ? `text-[var(${sizeToken})]` : `text-[${twLen(n.fontSize)}]`);
    if (n.fontWeight >= 700) cls.push("font-bold");
    else if (n.fontWeight >= 600) cls.push("font-semibold");
    else if (n.fontWeight >= 500) cls.push("font-medium");
    if (n.textAlign === "center") cls.push("text-center");
    else if (n.textAlign === "right") cls.push("text-right");
    if (n.textCase === "upper") cls.push("uppercase");
    else if (n.textCase === "lower") cls.push("lowercase");
    else if (n.textCase === "title") cls.push("capitalize");
    if (n.textDecoration === "underline") cls.push("underline");
    else if (n.textDecoration === "strikethrough") cls.push("line-through");
    if (n.truncate) cls.push(n.maxLines > 1 ? `line-clamp-${n.maxLines}` : "truncate");
  }

  if (n.effects?.length) {
    const shadows = n.effects
      .filter((e) => e.visible && (e.kind === "drop-shadow" || e.kind === "inner-shadow"))
      .map(
        (e) =>
          `${e.kind === "inner-shadow" ? "inset_" : ""}${[e.x, e.y, e.blur, e.spread]
            .map((v) => twLen(v).replace(/ /g, ""))
            .join("_")}_${(tokenColor(ctx, e.color) ? `var(${tokenColor(ctx, e.color)})` : e.color).replace(/ /g, "")}`,
      );
    if (shadows.length) cls.push(`shadow-[${shadows.join(",")}]`);
    const bgBlur = n.effects.find((e) => e.visible && e.kind === "background-blur");
    if (bgBlur) cls.push(`backdrop-blur-[${twLen(bgBlur.blur)}]`);
    const layerBlur = n.effects.find((e) => e.visible && e.kind === "layer-blur");
    if (layerBlur) cls.push(`blur-[${twLen(layerBlur.blur)}]`);
  }
  return cls;
}

/* ── component → code mappings (P1.10) ────────────────────────────────── */

const MAPPING_FALLBACKS: Record<TreeFormat, CodeMapping["framework"][]> = {
  tsx: ["react", "tailwind", "html"],
  html: ["html", "react", "tailwind"],
  vue: ["vue", "html"],
  svelte: ["svelte", "html"],
  tailwind: ["tailwind", "react", "html"],
  css: ["html", "react", "tailwind"],
};

/**
 * Best mapping for a framework: the preferred chain first, then any mapping
 * at all — a cross-framework pointer (flagged by the caller) beats silent
 * inline expansion.
 */
export function mappingFor(master: ComponentMaster, format: TreeFormat): CodeMapping | undefined {
  if (!master.codeMappings?.length) return undefined;
  for (const fw of MAPPING_FALLBACKS[format]) {
    const found = master.codeMappings.find((m) => m.framework === fw);
    if (found) return found;
  }
  return master.codeMappings[0];
}

/** True when the mapping is native to the format (not a fallback guess). */
export function mappingIsNative(mapping: CodeMapping, format: TreeFormat): boolean {
  return (MAPPING_FALLBACKS[format] as string[]).includes(mapping.framework);
}

export function findMaster(snap: Snapshot | null, id: string): ComponentMaster | undefined {
  return snap?.components?.find((c) => c.id === id);
}

/** Hash of the master's current shape; compared against `mapping.syncHash`. */
export function computeMasterHash(master: ComponentMaster): string {
  return fnv1a(
    JSON.stringify({
      n: master.node,
      v: master.variants,
      p: master.properties,
      prop: master.property,
    }),
  );
}

export type MappingSync = "synced" | "stale" | "never";

export function mappingSyncStatus(master: ComponentMaster, mapping: CodeMapping): MappingSync {
  if (!mapping.syncHash) return "never";
  return mapping.syncHash === computeMasterHash(master) ? "synced" : "stale";
}

/**
 * Resolve an instance's overrides through a mapping: render-ready props
 * plus children. Exported for the design API's `getCodeComponent`.
 */
export function instanceProps(
  n: XNode,
  master: ComponentMaster,
  mapping: CodeMapping,
): { props: [string, string | null][]; children?: string } {
  const props: [string, string | null][] = [];
  let children: string | undefined;
  const values: Record<string, string | boolean> = { ...(n.componentProperties ?? {}) };
  if (n.variant) values[master.property || "variant"] = n.variant;
  const mapped = new Set<string>();
  for (const pm of mapping.props) {
    if (!(pm.prop in values)) continue;
    mapped.add(pm.prop);
    const value = values[pm.prop];
    if (pm.kind === "omit") continue;
    if (pm.kind === "children") {
      children = String(value);
      continue;
    }
    const name = pm.codeProp?.trim() || slugify(pm.prop).replace(/-/g, "");
    if (typeof value === "boolean") props.push([name, value ? null : "{false}"]);
    else props.push([name, JSON.stringify(String(value))]);
  }
  // Unmapped properties still ship, under their own names, so generated
  // code never silently drops an override the designer set.
  for (const [key, value] of Object.entries(values)) {
    if (mapped.has(key)) continue;
    const name = slugify(key).replace(/-/g, "");
    if (typeof value === "boolean") props.push([name, value ? null : "{false}"]);
    else props.push([name, JSON.stringify(String(value))]);
  }
  return { props, children };
}

/* ── tree builder ─────────────────────────────────────────────────────── */

/**
 * Placed instances keep their master's kind (`placeComponent` clones the
 * master node), so instance identity is `componentId` without the master
 * flag — the same test the canvas uses — not `kind === "instance"`.
 */
export function isInstance(n: XNode): boolean {
  return !!n.componentId && !n.isComponent;
}

function tagFor(n: XNode): { tag: string; text?: string; notes: string[] } {
  const notes: string[] = [];
  if (n.kind === "text") {
    const text = n.text || "";
    return { tag: text.includes("\n") ? "p" : "span", text, notes };
  }
  if (n.fillType === "image") {
    notes.push(`image — point src at the exported asset for "${n.name}"`);
    return { tag: "img", notes };
  }
  if (n.kind === "vector" || n.kind === "line" || n.kind === "arrow") {
    notes.push("vector — export the layer as SVG and inline it here");
  }
  return { tag: "div", notes };
}

function buildElement(
  n: XNode,
  ctx: Ctx,
  parent: InferredLayout | null,
  isRoot: boolean,
  depth: number,
): CodeElement {
  const inferred = inferLayout(n);
  const className = uniqueClass(ctx, n.name);
  const { decls, notes } = resolveStyles(n, ctx, parent, isRoot);
  const tailwind = resolveTailwind(n, ctx, parent, isRoot);

  // A mapped instance renders as its code component with props — opaque,
  // never expanded — which is the whole point of the mapping.
  if (isInstance(n)) {
    const master = findMaster(ctx.snap, n.componentId);
    const mapping = master ? mappingFor(master, ctx.format) : undefined;
    if (master && mapping) {
      const { props, children } = instanceProps(n, master, mapping);
      if (!mappingIsNative(mapping, ctx.format)) {
        notes.push(`mapping is for ${mapping.framework} — verify the import`);
      }
      // The instance keeps its box styles (size/position in the parent) but
      // drops anything the code component owns; layout internals would lie.
      const boxDecls = decls.filter(([k]) =>
        ["width", "height", "flex", "flex-shrink", "align-self", "position", "left", "top"].includes(k),
      );
      const boxTw = tailwind.filter((c) =>
        /^(w-|h-|flex-1|shrink-0|self-|absolute|relative|left-|top-)/.test(c),
      );
      return {
        tag: mapping.componentName,
        className,
        styles: boxDecls,
        tailwind: boxTw,
        children: [],
        layout: inferred,
        componentRef: {
          name: mapping.componentName,
          importPath: mapping.importPath,
          props,
          children,
          framework: mapping.framework,
        },
        notes,
        raw: n,
      };
    }
    if (master && depth < ctx.maxDepth) {
      // Unmapped: expand the master's layers so the output still resembles
      // the design, and say so.
      notes.push(`unmapped instance of "${master.name}" — expanded inline`);
      const expanded = buildElement(
        { ...master.node, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h },
        ctx,
        parent,
        isRoot,
        depth,
      );
      expanded.styles = decls;
      expanded.tailwind = tailwind;
      expanded.notes = [...notes, ...expanded.notes.filter((x) => !notes.includes(x))];
      return expanded;
    }
  }

  const { tag, text, notes: tagNotes } = tagFor(n);
  for (const note of tagNotes) if (!notes.includes(note)) notes.push(note);
  const children: CodeElement[] = [];
  if (depth < ctx.maxDepth) {
    for (const child of n.children ?? []) {
      children.push(buildElement(child, ctx, inferred, false, depth + 1));
    }
  }
  return { tag, className, text, styles: decls, tailwind, children, layout: inferred, notes, raw: n };
}

export function buildCodeTree(root: XNode, opts: CodegenOptions): CodeElement {
  const ctx: Ctx = {
    unit: opts.unit ?? "px",
    tokens: buildTokenIndex(opts.snap ?? null),
    snap: opts.snap ?? null,
    varsById: new Map((opts.snap?.variables ?? []).map((v) => [v.id, v])),
    format: opts.format,
    maxDepth: opts.maxDepth ?? Infinity,
    used: new Map(),
  };
  return buildElement(root, ctx, null, true, 0);
}

/* ── emitters ─────────────────────────────────────────────────────────── */

function renderDecls(decls: [string, string][], indent: string): string {
  return decls.map(([k, v]) => `${indent}${k}: ${v};`).join("\n");
}

function collectImports(el: CodeElement, into: Map<string, string>): void {
  if (el.componentRef?.importPath) {
    into.set(el.componentRef.name, el.componentRef.importPath);
  }
  for (const child of el.children) collectImports(child, into);
}

function emitCssRules(el: CodeElement, out: string[]): void {
  if (el.componentRef) {
    out.push(`/* <${el.componentRef.name}> is a mapped code component — see its own file. */`);
    return;
  }
  if (el.notes.length) {
    for (const note of el.notes) out.push(`/* ${el.className}: ${note} */`);
  }
  if (el.styles.length) {
    out.push(`.${el.className} {\n${renderDecls(el.styles, "  ")}\n}`);
  }
  for (const child of el.children) emitCssRules(child, out);
}

export function emitCss(el: CodeElement): string {
  const out: string[] = [];
  emitCssRules(el, out);
  return out.join("\n\n");
}

function emitMarkupWith(
  el: CodeElement,
  classAttr: string,
  tailwind: boolean,
  depth = 0,
): string {
  const pad = "  ".repeat(depth);
  const cls = tailwind && el.tailwind.length ? el.tailwind.join(" ") : el.className;
  const ref = el.componentRef;
  const propStr = ref
    ? ref.props.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}=${v}`)).join("")
    : "";
  const notes = el.notes.map((x) => `${pad}<!-- ${x} -->`).join("\n");
  const prefix = notes ? `${notes}\n` : "";
  if (el.tag === "img") {
    const alt = escapeHtml(el.raw.name);
    return `${prefix}${pad}<img ${classAttr}="${cls}" src="./${el.className}.png" alt="${alt}" />`;
  }
  if (ref) {
    if (ref.children !== undefined) {
      return `${prefix}${pad}<${ref.name}${propStr}>${escapeHtml(ref.children)}</${ref.name}>`;
    }
    return `${prefix}${pad}<${ref.name}${propStr} />`;
  }
  if (el.text !== undefined && el.children.length === 0) {
    return `${prefix}${pad}<${el.tag} ${classAttr}="${cls}">${escapeHtml(el.text)}</${el.tag}>`;
  }
  if (el.children.length === 0) return `${prefix}${pad}<${el.tag} ${classAttr}="${cls}"></${el.tag}>`;
  const kids = el.children.map((c) => emitMarkupWith(c, classAttr, tailwind, depth + 1)).join("\n");
  return `${prefix}${pad}<${el.tag} ${classAttr}="${cls}">\n${kids}\n${pad}</${el.tag}>`;
}

function camel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function emitTsxNode(el: CodeElement, depth: number): string {
  const pad = "  ".repeat(depth);
  const ref = el.componentRef;
  const propStr = ref
    ? ref.props.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}=${v}`)).join("")
    : "";
  const notes = el.notes.map((x) => `${pad}{/* ${x} */}`).join("\n");
  const prefix = notes ? `${notes}\n` : "";
  const style =
    el.styles.length && !ref
      ? `\n${pad}  style={{\n${el.styles
          .map(([k, v]) => `${pad}    ${camel(k)}: ${JSON.stringify(v)},`)
          .join("\n")}\n${pad}  }}`
      : "";
  const boxStyle =
    el.styles.length && ref
      ? `\n${pad}  style={{\n${el.styles
          .map(([k, v]) => `${pad}    ${camel(k)}: ${JSON.stringify(v)},`)
          .join("\n")}\n${pad}  }}`
      : "";
  if (el.tag === "img") {
    const alt = escapeHtml(el.raw.name);
    return `${prefix}${pad}<img src={\`./${el.className}.png\`} alt="${alt}"${style} />`;
  }
  if (ref) {
    if (ref.children !== undefined) {
      return `${prefix}${pad}<${ref.name}${propStr}${boxStyle}>${escapeHtml(ref.children)}</${ref.name}>`;
    }
    return `${prefix}${pad}<${ref.name}${propStr}${boxStyle} />`;
  }
  if (el.text !== undefined && el.children.length === 0) {
    return `${prefix}${pad}<${el.tag}${style}>${escapeHtml(el.text)}</${el.tag}>`;
  }
  if (el.children.length === 0) return `${prefix}${pad}<${el.tag}${style} />`;
  const kids = el.children.map((c) => emitTsxNode(c, depth + 1)).join("\n");
  return `${prefix}${pad}<${el.tag}${style}>\n${kids}\n${pad}</${el.tag}>`;
}

export function emitTsx(el: CodeElement, rootName: string): string {
  const name = toPascal(rootName);
  const imports = new Map<string, string>();
  collectImports(el, imports);
  const importLines = [...imports.entries()].map(([comp, path]) => `import { ${comp} } from "${path}";`);
  const head = [`import React from "react";`, ...importLines].join("\n");
  return `${head}\n\nexport const ${name}: React.FC = () => {\n  return (\n${emitTsxNode(el, 2)}\n  );\n};`;
}

export function emitHtml(el: CodeElement): string {
  return `${emitMarkupWith(el, "class", false)}\n\n<style>\n${emitCss(el)
    .split("\n")
    .map((l) => (l ? `  ${l}` : l))
    .join("\n")}\n</style>`;
}

export function emitTailwind(el: CodeElement): string {
  const notes = new Set<string>();
  const walk = (x: CodeElement): void => {
    for (const n of x.notes) notes.add(n);
    for (const c of x.children) walk(c);
  };
  walk(el);
  const head = notes.size
    ? `<!-- ${[...notes].join(" / ")} -->\n`
    : "";
  return `${head}${emitMarkupWith(el, "class", true)}`;
}

export function emitVue(el: CodeElement): string {
  const imports = new Map<string, string>();
  collectImports(el, imports);
  const script = imports.size
    ? `<script setup>\n${[...imports.entries()]
        .map(([comp, path]) => `import ${comp} from "${path}";`)
        .join("\n")}\n</script>\n\n`
    : "";
  return `${script}<template>\n${emitMarkupWith(el, "class", false)}\n</template>\n\n<style scoped>\n${emitCss(el)}\n</style>`;
}

export function emitSvelte(el: CodeElement): string {
  const imports = new Map<string, string>();
  collectImports(el, imports);
  const script = imports.size
    ? `<script>\n${[...imports.entries()]
        .map(([comp, path]) => `import ${comp} from "${path}";`)
        .join("\n")}\n</script>\n\n`
    : "";
  return `${script}${emitMarkupWith(el, "class", false)}\n\n<style>\n${emitCss(el)}\n</style>`;
}

/**
 * One call: subtree → framework code. `maxDepth: 0` renders the root alone,
 * which is how the "Layer" scope reuses the tree emitters for the formats
 * that have no single-node generator (html, vue, svelte).
 */
export function generateSubtreeCode(root: XNode, opts: CodegenOptions): string {
  const el = buildCodeTree(root, opts);
  switch (opts.format) {
    case "css":
      return emitCss(el);
    case "html":
      return emitHtml(el);
    case "tailwind":
      return emitTailwind(el);
    case "vue":
      return emitVue(el);
    case "svelte":
      return emitSvelte(el);
    case "tsx":
    default:
      return emitTsx(el, root.name);
  }
}


/* ── single-node native emitters ───────────────────────────────────────────
 * UIKit and Android XML complete the P1.9 framework list. They follow the
 * existing single-layer generators (SwiftUI, Compose, Flutter): one node in,
 * one snippet out, with layout mapped — UIStackView / LinearLayout — and an
 * honest placeholder where children would go.
 */

function swiftString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function uiColor(hex: string): string {
  const h = hex.replace("#", "");
  const num = (i: number): number => parseInt(h.slice(i, i + 2) || "00", 16);
  const alpha = h.length >= 8 ? Math.round((num(6) / 255) * 100) / 100 : 1;
  return `UIColor(red: ${num(0)}/255, green: ${num(1 * 2)}/255, blue: ${num(2 * 2)}/255, alpha: ${alpha})`;
}

function uiWeight(w: number): string {
  if (w >= 800) return ".black";
  if (w >= 700) return ".bold";
  if (w >= 600) return ".semibold";
  if (w >= 500) return ".medium";
  if (w <= 300) return ".light";
  return ".regular";
}

export function generateUIKitCode(n: XNode): string {
  const frame = `CGRect(x: ${Math.round(n.x)}, y: ${Math.round(n.y)}, width: ${Math.round(n.w)}, height: ${Math.round(n.h)})`;
  if (n.kind === "text") {
    const lines = [
      "let label = UILabel()",
      `label.text = "${swiftString(n.text || n.name)}"`,
      `label.font = .systemFont(ofSize: ${n.fontSize}, weight: ${uiWeight(n.fontWeight)})`,
    ];
    if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
      lines.push(`label.textColor = ${uiColor(n.fill)}`);
    }
    if (n.textAlign === "center") lines.push("label.textAlignment = .center");
    else if (n.textAlign === "right") lines.push("label.textAlignment = .right");
    if (n.truncate) lines.push(`label.numberOfLines = ${n.maxLines > 1 ? n.maxLines : 1}`);
    lines.push(`label.frame = ${frame}`);
    return lines.join("\n");
  }
  const lines: string[] = [];
  if (n.layout && n.layout.direction !== "grid") {
    lines.push("let stack = UIStackView()");
    lines.push(`stack.axis = ${n.layout.direction === "horizontal" ? ".horizontal" : ".vertical"}`);
    if (n.layout.gap) lines.push(`stack.spacing = ${n.layout.gap}`);
    if (n.layout.align === "center") lines.push("stack.alignment = .center");
    else if (n.layout.align === "max") lines.push("stack.alignment = .trailing");
    if (n.layout.justify === "between") lines.push("stack.distribution = .equalSpacing");
    else if (n.layout.justify === "center") lines.push("stack.distribution = .equalCentering");
    const [pl, pr, pt, pb] = n.layout.padding;
    if (pl || pr || pt || pb) {
      lines.push("stack.isLayoutMarginsRelativeArrangement = true");
      lines.push(`stack.layoutMargins = UIEdgeInsets(top: ${pt}, left: ${pl}, bottom: ${pb}, right: ${pr})`);
    }
    lines.push("stack.frame = " + frame);
    lines.push("// stack.addArrangedSubview(<#child#>)");
  } else {
    lines.push("let view = UIView()");
    lines.push(`view.frame = ${frame}`);
    if (n.layout?.direction === "grid") lines.push("// grid layout — use UICollectionView for cells");
    if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
      lines.push(`view.backgroundColor = ${uiColor(n.fill)}`);
    }
    if (n.cornerRadii?.some((r) => r > 0)) {
      lines.push(`view.layer.cornerRadius = ${n.cornerRadii[0]}`);
      if (n.cornerIndependent) lines.push("// independent corners need a CAShapeLayer mask");
    }
    if (n.strokeVisible && n.strokeWidth > 0 && n.strokePaint) {
      lines.push(`view.layer.borderWidth = ${n.strokeWidth}`);
      lines.push(`view.layer.borderColor = ${uiColor(n.strokePaint)}.cgColor`);
    }
    if (n.opacity < 1) lines.push(`view.alpha = ${Math.round(n.opacity * 100) / 100}`);
  }
  return lines.join("\n");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dp(v: number): string {
  return `${Math.round(v)}dp`;
}

/** Single-node Android layout XML: LinearLayout / TextView / View. */
export function generateAndroidXml(n: XNode): string {
  const head = 'xmlns:android="http://schemas.android.com/apk/res/android"';
  if (n.kind === "text") {
    const attrs = [
      head,
      `android:layout_width="${dp(n.w)}"`,
      `android:layout_height="${dp(n.h)}"`,
      `android:text="${xmlEscape(n.text || n.name)}"`,
      `android:textSize="${n.fontSize}sp"`,
    ];
    if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
      attrs.push(`android:textColor="${n.fill.slice(0, 7).toUpperCase()}"`);
    }
    if (n.textAlign === "center") attrs.push('android:gravity="center_horizontal"');
    else if (n.textAlign === "right") attrs.push('android:gravity="end"');
    if (n.fontWeight >= 700) attrs.push('android:textStyle="bold"');
    if (n.truncate) attrs.push(`android:maxLines="${Math.max(1, n.maxLines)}"`, 'android:ellipsize="end"');
    return `<TextView\n    ${attrs.join("\n    ")} />`;
  }
  if (n.layout && n.layout.direction !== "grid") {
    const attrs = [
      head,
      `android:layout_width="${dp(n.w)}"`,
      `android:layout_height="${dp(n.h)}"`,
      `android:orientation="${n.layout.direction === "horizontal" ? "horizontal" : "vertical"}"`,
    ];
    if (n.layout.gap) attrs.push(`<!-- gap ${n.layout.gap}dp: Space views or item margins -->`);
    const [pl, pr, pt, pb] = n.layout.padding;
    if (pl || pr || pt || pb) {
      attrs.push(`android:paddingLeft="${dp(pl)}"`, `android:paddingTop="${dp(pt)}"`, `android:paddingRight="${dp(pr)}"`, `android:paddingBottom="${dp(pb)}"`);
    }
    if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
      attrs.push(`android:background="${n.fill.slice(0, 7).toUpperCase()}"`);
    }
    return `<LinearLayout\n    ${attrs.join("\n    ")}\n>\n    <!-- child views -->\n</LinearLayout>`;
  }
  const attrs = [
    head,
    `android:layout_width="${dp(n.w)}"`,
    `android:layout_height="${dp(n.h)}"`,
  ];
  if (n.layout?.direction === "grid") attrs.push("<!-- grid layout: use GridLayout / RecyclerView -->");
  if (n.fillVisible !== false && n.fill && n.fill !== "#00000000") {
    attrs.push(`android:background="${n.fill.slice(0, 7).toUpperCase()}"`);
  }
  if (n.opacity < 1) attrs.push(`android:alpha="${Math.round(n.opacity * 100) / 100}"`);
  return `<View\n    ${attrs.join("\n    ")} />`;
}

/* ── Tailwind theme export (P5-C: tokens → code) ────────────────────────
 * A `tailwind.config` theme extension built from the document's variables,
 * so generated `bg-[var(--…)]` utilities resolve against real tokens.
 */

export function generateTailwindTheme(snap?: Snapshot | null): string {
  if (!snap?.variables?.length) return "// No variables in this document.";
  const byId = new Map(snap.variables.map((v) => [v.id, v]));
  const collectionName = (id: string) => collectionNameOf(snap, id);
  const colors: [string, string][] = [];
  const spacing: [string, string][] = [];
  const fontFamily: [string, string][] = [];
  for (const v of snap.variables) {
    const mode = snap.activeModes?.[v.collection];
    const resolved = resolveVariableValue(v, byId, mode);
    if (resolved === undefined || typeof resolved === "object") continue;
    const key = v.name
      .split("/")
      .map(tokenizeSegment)
      .filter(Boolean)
      .join("-");
    const token = `var(${cssVarFor(collectionName(v.collection), v.name)})`;
    if (v.type === "color") colors.push([key, token]);
    else if (v.type === "number") spacing.push([key, token]);
    else if (v.type === "string") fontFamily.push([key, token]);
  }
  const section = (title: string, entries: [string, string][]): string =>
    entries.length
      ? `    ${title}: {\n${entries
          .map(([k, v]) => `      "${k}": "${v}",`)
          .join("\n")}\n    },`
      : "";
  const body = [
    section("colors", colors),
    section("spacing", spacing),
    section("fontFamily", fontFamily),
  ]
    .filter(Boolean)
    .join("\n");
  return `// tailwind.config.js — generated from ${snap.fileName || "this document"}\n// Paste inside \`theme.extend\`.\n{\n${body}\n}`;
}
