/**
 * Design health: lint rules over a snapshot, a 0–100 score, and quick fixes.
 *
 * Pure functions of `Snapshot`, so the same engine drives the in-editor
 * panel and any headless/CI use. Rules flag facts, never taste: every issue
 * names the layer(s) or variable(s) involved, and fixable issues carry a
 * `fix` the panel can dispatch directly.
 */
import type {
  ComponentMaster,
  Snapshot,
  VariableCollection,
  VariableItem,
  XNode,
} from "./types";
import { isAlias, resolveVariable } from "./variables";

export type LintSeverity = "error" | "warning" | "info";

export type LintFix =
  | { kind: "delete-variable"; variableId: string }
  | { kind: "delete-style"; styleId: string }
  | { kind: "reset-overrides"; nodeId: string }
  | { kind: "create-variable-bind"; nodeId: string; prop: string; color: string }
  | { kind: "select"; nodeId: string; page?: number };

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Layer ids involved (first is the primary selection target). */
  nodeIds: string[];
  /** Page index for `nodeIds` (issues never span pages). */
  page: number;
  variableIds: string[];
  fix?: LintFix;
}

export interface LintReport {
  score: number;
  issues: LintIssue[];
  counts: Record<LintSeverity, number>;
}

function walk(n: XNode, fn: (node: XNode, ancestors: XNode[]) => void, ancestors: XNode[] = []): void {
  fn(n, ancestors);
  for (const c of n.children) walk(c, fn, [...ancestors, n]);
}

/** Auto-generated layer names, mirroring `labelFor` in memory.ts. */
const AUTO_BASE: Record<string, string> = {
  frame: "Frame",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  line: "Line",
  arrow: "Arrow",
  poly: "Polygon",
  star: "Star",
  vector: "Vector",
  boolean: "Boolean",
  component: "Component",
  instance: "Instance",
};

function isAutoName(n: XNode): boolean {
  const base = AUTO_BASE[n.kind] ?? "Layer";
  return new RegExp(`^${base} \\d+$`).test(n.name);
}

function isNonePaint(v: string | undefined): boolean {
  return !v || v === "#00000000" || v.toLowerCase() === "none";
}

function normHex(v: string): string {
  return v.trim().toLowerCase();
}

function parseHex(v: string): [number, number, number] | null {
  const h = v.trim().toLowerCase();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(h);
  if (!m) return null;
  const d = m[1];
  const full = d.length === 3 ? d.split("").map((c) => c + c).join("") : d.slice(0, 6);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two paints; null when either is unparseable. */
export function contrastRatio(fg: string, bg: string): number | null {
  const a = parseHex(fg);
  const b = parseHex(bg);
  if (!a || !b) return null;
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

interface LintCtx {
  vars: VariableItem[];
  collections: VariableCollection[];
  activeModes: Record<string, string>;
  masters: ComponentMaster[];
  colorTokens: Set<string>;
  numberTokens: Set<number>;
  /** Every variable id referenced anywhere: bindings, aliases, expressions, interactions. */
  varRefs: Set<string>;
  styleRefs: Set<string>;
  /** Component ids with at least one placed instance. */
  instanced: Set<string>;
}

function collectVarRefs(snap: Snapshot, ctx: LintCtx): void {
  const ident = /\b[A-Za-z_][A-Za-z0-9_-]*\b/g;
  const names = new Map<string, string>();
  for (const v of ctx.vars) {
    names.set(v.name, v.id);
    names.set(v.id, v.id);
    const slots = [v.value, ...Object.values(v.values ?? {})];
    for (const s of slots) if (isAlias(s)) ctx.varRefs.add(s.alias);
  }
  const scanExpr = (expr: string) => {
    for (const m of expr.match(ident) ?? []) {
      const id = names.get(m);
      if (id) ctx.varRefs.add(id);
    }
  };
  const scanNode = (n: XNode) => {
    for (const id of Object.values(n.variableBindings ?? {})) ctx.varRefs.add(id);
    for (const e of Object.values(n.expressions ?? {})) if (e) scanExpr(e);
    for (const ix of n.interactions ?? []) {
      if (ix.variableId) ctx.varRefs.add(ix.variableId);
      if (ix.condition?.variableId) ctx.varRefs.add(ix.condition.variableId);
    }
    if (n.fillStyle) ctx.styleRefs.add(n.fillStyle);
    if (n.strokeStyle) ctx.styleRefs.add(n.strokeStyle);
    if (n.componentId && !n.isComponent) ctx.instanced.add(n.componentId);
  };
  for (const p of snap.pages) walk(p.root, (n) => scanNode(n));
  for (const m of ctx.masters) {
    walk(m.node, (n) => scanNode(n));
    for (const v of m.variants ?? []) walk(v.node, (n) => scanNode(n));
  }
}

/** Nearest visible solid fill above the node (exclusive), else canvas white. */
function effectiveBg(ancestors: XNode[]): string {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    const solid = !a.fillType || a.fillType === "solid";
    if (solid && a.fillVisible !== false && !isNonePaint(a.fill)) return a.fill;
  }
  return "#ffffff";
}

export function lintDocument(snap: Snapshot): LintReport {
  const ctx: LintCtx = {
    vars: snap.variables ?? [],
    collections: snap.variableCollections ?? [],
    activeModes: snap.activeModes ?? {},
    masters: snap.components ?? [],
    colorTokens: new Set(),
    numberTokens: new Set(),
    varRefs: new Set(),
    styleRefs: new Set(),
    instanced: new Set(),
  };
  for (const v of ctx.vars) {
    const r = resolveVariable(ctx.vars, ctx.collections, ctx.activeModes, v.id);
    if (!r || r.broken) continue;
    if (v.type === "color" && typeof r.value === "string") ctx.colorTokens.add(normHex(r.value));
    if (v.type === "number" && typeof r.value === "number") ctx.numberTokens.add(r.value);
  }
  collectVarRefs(snap, ctx);

  const issues: LintIssue[] = [];
  const push = (i: LintIssue) => issues.push(i);

  // Variable-scoped rules.
  for (const v of ctx.vars) {
    const r = resolveVariable(ctx.vars, ctx.collections, ctx.activeModes, v.id);
    if (r && r.broken) {
      const why = r.reason === "cycle" ? "aliases itself in a loop" : r.reason === "missing" ? "points at a deleted variable" : "points at a different-typed variable";
      push({
        rule: "broken-alias",
        severity: "error",
        message: `“${v.name}” ${why}.`,
        nodeIds: [],
        page: snap.page,
        variableIds: [v.id],
      });
    } else if (!ctx.varRefs.has(v.id)) {
      push({
        rule: "unused-variable",
        severity: "warning",
        message: `“${v.name}” is never used.`,
        nodeIds: [],
        page: snap.page,
        variableIds: [v.id],
        fix: { kind: "delete-variable", variableId: v.id },
      });
    }
  }
  for (const s of snap.styles ?? []) {
    if (!ctx.styleRefs.has(s.id)) {
      push({
        rule: "unused-style",
        severity: "warning",
        message: `Style “${s.name}” is never used.`,
        nodeIds: [],
        page: snap.page,
        variableIds: [],
        fix: { kind: "delete-style", styleId: s.id },
      });
    }
  }
  for (const m of ctx.masters) {
    if (!ctx.instanced.has(m.id) && !ctx.instanced.has(m.node.id)) {
      push({
        rule: "unused-component",
        severity: "info",
        message: `“${m.name}” has no instances.`,
        nodeIds: [m.node.id],
        page: snap.page,
        variableIds: [],
      });
    }
  }

  // Layer-scoped rules, page by page.
  snap.pages.forEach((page, pageIndex) => {
    walk(page.root, (n, ancestors) => {
      const bound = n.variableBindings ?? {};
      const solidBase = !n.fillType || n.fillType === "solid";
      if (solidBase && n.fillVisible !== false && !isNonePaint(n.fill) && !bound.fill && !ctx.colorTokens.has(normHex(n.fill))) {
        push({
          rule: "non-token-color",
          severity: "warning",
          message: `${n.name || "Layer"}: fill ${normHex(n.fill)} isn't a token.`,
          nodeIds: [n.id],
          page: pageIndex,
          variableIds: [],
          fix: { kind: "create-variable-bind", nodeId: n.id, prop: "fill", color: n.fill },
        });
      }
      if (n.strokeWidth > 0 && n.strokeVisible !== false && !isNonePaint(n.strokePaint) && !bound.strokePaint && !ctx.colorTokens.has(normHex(n.strokePaint))) {
        push({
          rule: "non-token-color",
          severity: "warning",
          message: `${n.name || "Layer"}: stroke ${normHex(n.strokePaint)} isn't a token.`,
          nodeIds: [n.id],
          page: pageIndex,
          variableIds: [],
          fix: { kind: "create-variable-bind", nodeId: n.id, prop: "strokePaint", color: n.strokePaint },
        });
      }
      (n.fills ?? []).forEach((f, i) => {
        if (f.type === "solid" && f.visible !== false && !isNonePaint(f.color) && !ctx.colorTokens.has(normHex(f.color))) {
          push({
            rule: "non-token-color",
            severity: "warning",
            message: `${n.name || "Layer"}: fill ${i + 1} (${normHex(f.color)}) isn't a token.`,
            nodeIds: [n.id],
            page: pageIndex,
            variableIds: [],
          });
        }
      });
      if (n.layout) {
        const gap = n.layout.gap;
        if (typeof gap === "number" && gap !== 0 && !ctx.numberTokens.has(gap)) {
          push({
            rule: "non-token-spacing",
            severity: "warning",
            message: `${n.name || "Layer"}: gap ${gap} isn't a token.`,
            nodeIds: [n.id],
            page: pageIndex,
            variableIds: [],
          });
        }
        const pads = new Set((n.layout.padding ?? []).filter((p) => p !== 0));
        for (const p of pads) {
          if (!ctx.numberTokens.has(p)) {
            push({
              rule: "non-token-spacing",
              severity: "warning",
              message: `${n.name || "Layer"}: padding ${p} isn't a token.`,
              nodeIds: [n.id],
              page: pageIndex,
              variableIds: [],
            });
          }
        }
      }
      if (n.cornerRadii) {
        for (const r of new Set(n.cornerRadii)) {
          if (r !== 0 && !ctx.numberTokens.has(r)) {
            push({
              rule: "non-token-radius",
              severity: "warning",
              message: `${n.name || "Layer"}: radius ${r} isn't a token.`,
              nodeIds: [n.id],
              page: pageIndex,
              variableIds: [],
            });
          }
        }
      }
      if (n.kind === "text" && n.fillVisible !== false && !isNonePaint(n.fill)) {
        const ratio = contrastRatio(n.fill, effectiveBg(ancestors));
        const threshold = n.fontSize >= 24 ? 3.0 : 4.5;
        if (ratio !== null && ratio < threshold) {
          push({
            rule: "contrast",
            severity: "error",
            message: `${n.name || "Text"}: contrast ${ratio.toFixed(2)}:1 is below ${threshold}:1.`,
            nodeIds: [n.id],
            page: pageIndex,
            variableIds: [],
          });
        }
      }
      if (n.componentId && !n.isComponent && n.overrides && Object.keys(n.overrides).length > 0) {
        push({
          rule: "overridden-instance",
          severity: "warning",
          message: `${n.name || "Instance"} has ${Object.keys(n.overrides).length} override(s).`,
          nodeIds: [n.id],
          page: pageIndex,
          variableIds: [],
          fix: { kind: "reset-overrides", nodeId: n.id },
        });
      }
      if ((n.kind === "frame" || n.kind === "component" || n.kind === "instance") && n.name && isAutoName(n)) {
        push({
          rule: "auto-layer-name",
          severity: "info",
          message: `${n.kind === "frame" ? "Frame" : "Component"} “${n.name}” still has its automatic name.`,
          nodeIds: [n.id],
          page: pageIndex,
          variableIds: [],
        });
      }
    });
  });

  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const score = Math.max(0, 100 - 10 * counts.error - 3 * counts.warning);
  return { score, issues, counts };
}
