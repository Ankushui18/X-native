/**
 * Phase 5 (P1.11) — the design API.
 *
 * A structured-JSON read API over a live `Snapshot`: selection, layers,
 * variables/tokens, components, layout, assets, annotations, and code
 * generation. Every method returns an `ApiResult` envelope —
 * `{ ok: true, data }` or `{ ok: false, error: { code, message } }` — list
 * methods paginate (`limit`/`offset`) and search methods filter, so agents
 * and integrations get predictable shapes instead of raw engine internals.
 *
 * The Rust track's stdio MCP server (`x_native mcp`) covers file-based
 * agents; this module covers the live editor session (selection, current
 * modes, current components) and is exposed on `window.__xNativeDesignApi`
 * by `installDesignApi`. Pure over snapshots, so it is headless-testable.
 */
import type {
  CodeMapping,
  ComponentMaster,
  Snapshot,
  VariableItem,
  XNode,
} from "./types";
import {
  cssVarFor,
  generateSubtreeCode,
  inferLayout,
  instanceProps,
  isInstance,
  mappingFor,
  mappingIsNative,
  mappingSyncStatus,
  type TreeFormat,
} from "./codegen";
import { resolveVariable } from "./variables";

export const DESIGN_API_VERSION = "1.0";

/* ── envelope ─────────────────────────────────────────────────────────── */

export type ApiErrorCode = "NOT_FOUND" | "BAD_ARGS" | "UNSUPPORTED" | "EMPTY" | "INTERNAL";

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const err = <T>(code: ApiErrorCode, message: string): ApiResult<T> => ({
  ok: false,
  error: { code, message },
});

export interface PageParams {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

const MAX_LIMIT = 500;

function paginate<T>(all: T[], params?: PageParams): Page<T> {
  const limit = Math.min(Math.max(1, params?.limit ?? 100), MAX_LIMIT);
  const offset = Math.max(0, params?.offset ?? 0);
  return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
}

/* ── node helpers ─────────────────────────────────────────────────────── */

function walk(root: XNode, visit: (n: XNode, pageId: string, trail: XNode[]) => void, pageId: string): void {
  const trail: XNode[] = [];
  const rec = (n: XNode): void => {
    visit(n, pageId, trail);
    trail.push(n);
    for (const c of n.children ?? []) rec(c);
    trail.pop();
  };
  rec(root);
}

/** Find a node anywhere in the snapshot, with its page and ancestor trail. */
function locate(snap: Snapshot, id: string): { node: XNode; pageId: string; trail: XNode[] } | undefined {
  for (const page of snap.pages) {
    let found: { node: XNode; pageId: string; trail: XNode[] } | undefined;
    walk(
      page.root,
      (n, pageId, trail) => {
        if (!found && n.id === id) found = { node: n, pageId, trail: [...trail] };
      },
      page.id,
    );
    if (found) return found;
  }
  return undefined;
}

/** Compact, JSON-safe node shape. Full nodes go out only on explicit ask. */
export interface NodeSummary {
  id: string;
  pageId: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  childIds: string[];
  childCount: number;
  componentId?: string;
  isComponent?: boolean;
  variant?: string;
  children?: NodeSummary[];
}

function summarize(n: XNode, pageId: string, depth: number): NodeSummary {
  const s: NodeSummary = {
    id: n.id,
    pageId,
    name: n.name,
    kind: n.kind,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    childIds: (n.children ?? []).map((c) => c.id),
    childCount: n.children?.length ?? 0,
  };
  if (n.componentId) s.componentId = n.componentId;
  if (n.isComponent) s.isComponent = true;
  if (n.variant) s.variant = n.variant;
  if (depth > 0) s.children = (n.children ?? []).map((c) => summarize(c, pageId, depth - 1));
  return s;
}

function worldRect(node: XNode, trail: XNode[]): { x: number; y: number; w: number; h: number } {
  let x = node.x;
  let y = node.y;
  for (const ancestor of trail) {
    x += ancestor.x;
    y += ancestor.y;
  }
  return { x, y, w: node.w, h: node.h };
}

function collectionNameOf(snap: Snapshot, collection: string): string {
  const cols = snap.variableCollections ?? [];
  return cols.find((c) => c.id === collection)?.name ?? collection ?? "tokens";
}

function resolvedValue(snap: Snapshot, v: VariableItem): unknown {
  const r = resolveVariable(snap.variables ?? [], snap.variableCollections ?? [], snap.activeModes ?? {}, v.id);
  if (!r || r.broken) return v.value;
  return r.value;
}

/* ── selection & layers ───────────────────────────────────────────────── */

export interface SelectionData {
  count: number;
  ids: string[];
  nodes: NodeSummary[];
}

function getSelection(snap: Snapshot): ApiResult<SelectionData> {
  const nodes: NodeSummary[] = [];
  for (const id of snap.selection) {
    const hit = locate(snap, id);
    if (hit) nodes.push(summarize(hit.node, hit.pageId, 0));
  }
  return ok({ count: nodes.length, ids: nodes.map((n) => n.id), nodes });
}

export interface NodeData {
  summary: NodeSummary;
  full?: XNode;
}

function getNode(
  snap: Snapshot,
  params: { id: string; depth?: number; full?: boolean },
): ApiResult<NodeData> {
  if (!params.id) return err("BAD_ARGS", "getNode needs { id }.");
  const hit = locate(snap, params.id);
  if (!hit) return err("NOT_FOUND", `No node "${params.id}".`);
  const depth = Math.min(Math.max(0, params.depth ?? 0), 12);
  const data: NodeData = { summary: summarize(hit.node, hit.pageId, depth) };
  if (params.full) data.full = hit.node;
  return ok(data);
}

export interface LayersParams extends PageParams {
  page?: string;
  parent?: string;
  kind?: string;
}

function getLayers(snap: Snapshot, params: LayersParams = {}): ApiResult<Page<NodeSummary> & { parent: string; pageId: string }> {
  const page = params.page
    ? snap.pages.find((p) => p.id === params.page || p.name === params.page)
    : snap.pages[snap.page] ?? snap.pages[0];
  if (!page) return err("NOT_FOUND", `No page "${params.page}".`);
  let parent: XNode = page.root;
  if (params.parent) {
    const hit = locate(snap, params.parent);
    if (!hit) return err("NOT_FOUND", `No parent node "${params.parent}".`);
    parent = hit.node;
  }
  let kids = (parent.children ?? []).map((c) => summarize(c, page.id, 0));
  if (params.kind) kids = kids.filter((k) => k.kind === params.kind);
  return ok({ ...paginate(kids, params), parent: parent.id, pageId: page.id });
}

export interface FindParams extends PageParams {
  kind?: string;
  name?: string;
  nameIs?: string;
  id?: string;
  under?: string;
  instanceOf?: string;
  visible?: boolean;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

function findNodes(snap: Snapshot, params: FindParams = {}): ApiResult<Page<NodeSummary>> {
  let roots: { root: XNode; pageId: string }[] = snap.pages.map((p) => ({ root: p.root, pageId: p.id }));
  if (params.under) {
    const hit = locate(snap, params.under);
    if (!hit) return err("NOT_FOUND", `No node "${params.under}".`);
    roots = [{ root: hit.node, pageId: hit.pageId }];
  }
  const needle = params.name?.toLowerCase();
  const out: NodeSummary[] = [];
  for (const { root, pageId } of roots) {
    walk(
      root,
      (n) => {
        if (params.kind && n.kind !== params.kind) return;
        if (params.id && n.id !== params.id) return;
        if (params.nameIs && n.name !== params.nameIs) return;
        if (needle && !n.name.toLowerCase().includes(needle)) return;
        if (params.instanceOf && !(isInstance(n) && n.componentId === params.instanceOf)) return;
        if (params.visible !== undefined && (n.visible ?? true) !== params.visible) return;
        if (params.minW !== undefined && n.w < params.minW) return;
        if (params.minH !== undefined && n.h < params.minH) return;
        if (params.maxW !== undefined && n.w > params.maxW) return;
        if (params.maxH !== undefined && n.h > params.maxH) return;
        out.push(summarize(n, pageId, 0));
      },
      pageId,
    );
  }
  return ok(paginate(out, params));
}

/* ── variables & tokens ───────────────────────────────────────────────── */

export interface TokenData {
  id: string;
  name: string;
  type: string;
  collection: string;
  cssVar: string;
  value: unknown;
  mode?: string;
}

function tokenOf(snap: Snapshot, v: VariableItem): TokenData {
  const collection = collectionNameOf(snap, v.collection);
  return {
    id: v.id,
    name: v.name,
    type: v.type,
    collection,
    cssVar: cssVarFor(collection, v.name),
    value: resolvedValue(snap, v),
    mode: snap.activeModes?.[v.collection],
  };
}

function getVariables(snap: Snapshot, params: (PageParams & { collection?: string; type?: string }) | undefined): ApiResult<Page<TokenData>> {
  let vars = snap.variables ?? [];
  if (params?.collection) {
    vars = vars.filter(
      (v) => v.collection === params.collection || collectionNameOf(snap, v.collection) === params.collection,
    );
  }
  if (params?.type) vars = vars.filter((v) => v.type === params.type);
  return ok(paginate(vars.map((v) => tokenOf(snap, v)), params));
}

function getVariable(snap: Snapshot, params: { id: string }): ApiResult<TokenData> {
  if (!params.id) return err("BAD_ARGS", "getVariable needs { id }.");
  const v = (snap.variables ?? []).find((x) => x.id === params.id || x.name === params.id);
  if (!v) return err("NOT_FOUND", `No variable "${params.id}".`);
  return ok(tokenOf(snap, v));
}

export interface TokenUsage {
  nodeId: string;
  pageId: string;
  nodeName: string;
  prop: string;
  match: "binding" | "value";
}

function tokenUsage(snap: Snapshot, id: string, params?: PageParams): ApiResult<Page<TokenUsage>> {
  const v = (snap.variables ?? []).find((x) => x.id === id || x.name === id);
  if (!v) return err("NOT_FOUND", `No variable "${id}".`);
  const value = resolvedValue(snap, v);
  const out: TokenUsage[] = [];
  const numEq = (a: unknown, b: unknown): boolean =>
    typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9;
  for (const page of snap.pages) {
    walk(
      page.root,
      (n) => {
        for (const [prop, varId] of Object.entries(n.variableBindings ?? {})) {
          if (varId === v.id) {
            out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop, match: "binding" });
          }
        }
        // Literal matches are approximate by nature (two tokens can share a
        // value); bindings above are the ground truth.
        if (v.type === "color" && typeof value === "string") {
          const hex = value.trim().toLowerCase();
          if (n.fill?.trim().toLowerCase() === hex) {
            out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "fill", match: "value" });
          }
          if (n.strokePaint?.trim().toLowerCase() === hex) {
            out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "strokePaint", match: "value" });
          }
        }
        if (v.type === "number" && typeof value === "number") {
          if (numEq(n.fontSize, value)) out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "fontSize", match: "value" });
          if ((n.cornerRadii ?? []).some((r) => numEq(r, value))) {
            out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "cornerRadii", match: "value" });
          }
          if (numEq(n.strokeWidth, value)) out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "strokeWidth", match: "value" });
          if (n.layout && numEq(n.layout.gap, value)) {
            out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "layout.gap", match: "value" });
          }
        }
        if (v.type === "string" && typeof value === "string") {
          if (n.fontFamily === value) out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "fontFamily", match: "value" });
          if (n.text === value) out.push({ nodeId: n.id, pageId: page.id, nodeName: n.name, prop: "text", match: "value" });
        }
      },
      page.id,
    );
  }
  return ok(paginate(out, params));
}

const getTokens = getVariables;

function getTokenUsage(snap: Snapshot, params: { id: string } & PageParams): ApiResult<Page<TokenUsage>> {
  if (!params.id) return err("BAD_ARGS", "getTokenUsage needs { id }.");
  return tokenUsage(snap, params.id, params);
}

function getVariableUsage(snap: Snapshot, params: { id: string } & PageParams): ApiResult<Page<TokenUsage>> {
  if (!params.id) return err("BAD_ARGS", "getVariableUsage needs { id }.");
  return tokenUsage(snap, params.id, params);
}

/* ── components ───────────────────────────────────────────────────────── */

export interface ComponentData {
  id: string;
  name: string;
  nodeId: string;
  property: string;
  properties: { id: string; name: string; type: string; defaultValue: string | boolean }[];
  variants: string[];
  mappings: { framework: string; component: string; importPath?: string; sync: string }[];
}

function componentOf(master: ComponentMaster): ComponentData {
  return {
    id: master.id,
    name: master.name,
    nodeId: master.node.id,
    property: master.property,
    properties: (master.properties ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      defaultValue: p.defaultValue,
    })),
    variants: master.variants.map((v) => v.name),
    mappings: (master.codeMappings ?? []).map((m) => ({
      framework: m.framework,
      component: m.componentName,
      importPath: m.importPath,
      sync: mappingSyncStatus(master, m),
    })),
  };
}

function getComponents(snap: Snapshot, params?: PageParams): ApiResult<Page<ComponentData>> {
  return ok(paginate((snap.components ?? []).map(componentOf), params));
}

function findMaster(snap: Snapshot, id: string): ComponentMaster | undefined {
  return (snap.components ?? []).find((c) => c.id === id || c.name === id || c.node.id === id);
}

function getComponent(snap: Snapshot, params: { id: string }): ApiResult<ComponentData> {
  if (!params.id) return err("BAD_ARGS", "getComponent needs { id }.");
  const master = findMaster(snap, params.id);
  if (!master) return err("NOT_FOUND", `No component "${params.id}".`);
  return ok(componentOf(master));
}

function getInstances(snap: Snapshot, params: { id: string } & PageParams): ApiResult<Page<NodeSummary>> {
  if (!params.id) return err("BAD_ARGS", "getInstances needs { id }.");
  const master = findMaster(snap, params.id);
  if (!master) return err("NOT_FOUND", `No component "${params.id}".`);
  const out: NodeSummary[] = [];
  for (const page of snap.pages) {
    walk(
      page.root,
      (n) => {
        if (isInstance(n) && n.componentId === master.id) out.push(summarize(n, page.id, 0));
      },
      page.id,
    );
  }
  return ok(paginate(out, params));
}

export interface ComponentPropsData {
  componentId: string;
  component: string;
  instanceId?: string;
  properties: { name: string; type: string; defaultValue: string | boolean; value: string | boolean }[];
}

function getComponentProperties(snap: Snapshot, params: { id: string }): ApiResult<ComponentPropsData> {
  if (!params.id) return err("BAD_ARGS", "getComponentProperties needs { id }.");
  // An instance id resolves to live values; a master id to defaults.
  const hit = locate(snap, params.id);
  if (hit && isInstance(hit.node)) {
    const master = findMaster(snap, hit.node.componentId);
    if (!master) return err("NOT_FOUND", `Instance "${params.id}" points at a missing component.`);
    return ok({
      componentId: master.id,
      component: master.name,
      instanceId: hit.node.id,
      properties: (master.properties ?? []).map((p) => ({
        name: p.name,
        type: p.type,
        defaultValue: p.defaultValue,
        value: hit.node.componentProperties?.[p.name] ?? p.defaultValue,
      })),
    });
  }
  const master = findMaster(snap, params.id);
  if (!master) return err("NOT_FOUND", `No component or instance "${params.id}".`);
  return ok({
    componentId: master.id,
    component: master.name,
    properties: (master.properties ?? []).map((p) => ({
      name: p.name,
      type: p.type,
      defaultValue: p.defaultValue,
      value: p.defaultValue,
    })),
  });
}

function getVariants(snap: Snapshot, params: { id: string }): ApiResult<{ componentId: string; component: string; variants: string[] }> {
  if (!params.id) return err("BAD_ARGS", "getVariants needs { id }.");
  const master = findMaster(snap, params.id);
  if (!master) return err("NOT_FOUND", `No component "${params.id}".`);
  return ok({ componentId: master.id, component: master.name, variants: master.variants.map((v) => v.name) });
}

export interface CodeMappingData {
  id: string;
  framework: string;
  component: string;
  importPath?: string;
  file?: string;
  version?: string;
  props: { prop: string; codeProp?: string; kind: string }[];
  sync: string;
  syncedAt?: number;
}

function getCodeMapping(
  snap: Snapshot,
  params: { id: string; framework?: string },
): ApiResult<CodeMappingData[]> {
  if (!params.id) return err("BAD_ARGS", "getCodeMapping needs { id }.");
  const master = findMaster(snap, params.id);
  if (!master) return err("NOT_FOUND", `No component "${params.id}".`);
  let mappings = master.codeMappings ?? [];
  if (params.framework) mappings = mappings.filter((m) => m.framework === params.framework);
  return ok(
    mappings.map((m) => ({
      id: m.id,
      framework: m.framework,
      component: m.componentName,
      importPath: m.importPath,
      file: m.file,
      version: m.version,
      props: m.props,
      sync: mappingSyncStatus(master, m),
      syncedAt: m.syncedAt,
    })),
  );
}

export type CodeComponentData =
  | { mapped: false; reason: string }
  | {
      mapped: true;
      component: string;
      framework: string;
      native: boolean;
      importPath?: string;
      props: { name: string; value: string | null }[];
      children?: string;
    };

function getCodeComponent(
  snap: Snapshot,
  params: { id: string; framework?: TreeFormat },
): ApiResult<CodeComponentData> {
  if (!params.id) return err("BAD_ARGS", "getCodeComponent needs { id }.");
  const hit = locate(snap, params.id);
  if (!hit) return err("NOT_FOUND", `No node "${params.id}".`);
  if (!isInstance(hit.node)) return ok({ mapped: false, reason: "not-an-instance" });
  const master = findMaster(snap, hit.node.componentId);
  if (!master) return ok({ mapped: false, reason: "missing-master" });
  const format = params.framework ?? "tsx";
  const mapping: CodeMapping | undefined = mappingFor(master, format);
  if (!mapping) return ok({ mapped: false, reason: "no-mapping" });
  const { props, children } = instanceProps(hit.node, master, mapping);
  return ok({
    mapped: true,
    component: mapping.componentName,
    framework: mapping.framework,
    native: mappingIsNative(mapping, format),
    importPath: mapping.importPath,
    props: props.map(([name, value]) => ({ name, value })),
    children,
  });
}

/* ── layout, paint, type, assets ───────────────────────────────────────── */

function getAutoLayout(snap: Snapshot, params: { id: string }): ApiResult<{ nodeId: string; layout: unknown; inferred: string }> {
  if (!params.id) return err("BAD_ARGS", "getAutoLayout needs { id }.");
  const hit = locate(snap, params.id);
  if (!hit) return err("NOT_FOUND", `No node "${params.id}".`);
  return ok({ nodeId: hit.node.id, layout: hit.node.layout, inferred: inferLayout(hit.node).kind });
}

function getConstraints(snap: Snapshot, params: { id: string }): ApiResult<Record<string, unknown>> {
  if (!params.id) return err("BAD_ARGS", "getConstraints needs { id }.");
  const hit = locate(snap, params.id);
  if (!hit) return err("NOT_FOUND", `No node "${params.id}".`);
  const n = hit.node;
  return ok({
    nodeId: n.id,
    horizontal: n.constraintH,
    vertical: n.constraintV,
    minW: n.minW ?? null,
    maxW: n.maxW ?? null,
    minH: n.minH ?? null,
    maxH: n.maxH ?? null,
    absolutePosition: n.absolutePosition ?? false,
  });
}

function getSpacing(
  snap: Snapshot,
  params: { a: string; b: string },
): ApiResult<{ a: unknown; b: unknown; horizontal: number; vertical: number }> {
  if (!params.a || !params.b) return err("BAD_ARGS", "getSpacing needs { a, b }.");
  const ha = locate(snap, params.a);
  const hb = locate(snap, params.b);
  if (!ha) return err("NOT_FOUND", `No node "${params.a}".`);
  if (!hb) return err("NOT_FOUND", `No node "${params.b}".`);
  const ra = worldRect(ha.node, ha.trail);
  const rb = worldRect(hb.node, hb.trail);
  // Edge-to-edge gaps; negative when the boxes overlap on that axis.
  const horizontal =
    ra.x + ra.w <= rb.x ? rb.x - (ra.x + ra.w) : rb.x + rb.w <= ra.x ? ra.x - (rb.x + rb.w) : -Math.min(ra.x + ra.w - rb.x, rb.x + rb.w - ra.x);
  const vertical =
    ra.y + ra.h <= rb.y ? rb.y - (ra.y + ra.h) : rb.y + rb.h <= ra.y ? ra.y - (rb.y + rb.h) : -Math.min(ra.y + ra.h - rb.y, rb.y + rb.h - ra.y);
  return ok({ a: ra, b: rb, horizontal, vertical });
}

export interface ColorUsage {
  color: string;
  count: number;
  nodes: string[];
}

function getColors(snap: Snapshot, params?: PageParams): ApiResult<Page<ColorUsage>> {
  const counts = new Map<string, { count: number; nodes: string[] }>();
  const add = (paint: string | undefined, id: string): void => {
    if (!paint || paint === "#00000000") return;
    const key = paint.trim().toLowerCase();
    const slot = counts.get(key) ?? { count: 0, nodes: [] };
    slot.count += 1;
    if (slot.nodes.length < 5) slot.nodes.push(id);
    counts.set(key, slot);
  };
  for (const page of snap.pages) {
    walk(
      page.root,
      (n) => {
        if (n.fillVisible !== false) add(n.fill, n.id);
        if (n.strokeVisible) add(n.strokePaint, n.id);
        for (const e of n.effects ?? []) if (e.visible) add(e.color, n.id);
      },
      page.id,
    );
  }
  const items = [...counts.entries()]
    .map(([color, v]) => ({ color, count: v.count, nodes: v.nodes }))
    .sort((a, b) => b.count - a.count);
  return ok(paginate(items, params));
}

export interface TypeUsage {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  count: number;
  nodes: string[];
}

function getTypography(snap: Snapshot, params?: PageParams): ApiResult<Page<TypeUsage>> {
  const styles = new Map<string, TypeUsage>();
  for (const page of snap.pages) {
    walk(
      page.root,
      (n) => {
        if (n.kind !== "text") return;
        const key = `${n.fontFamily} ${n.fontSize}/${n.fontWeight}`;
        const slot = styles.get(key) ?? {
          fontFamily: n.fontFamily,
          fontSize: n.fontSize,
          fontWeight: n.fontWeight,
          count: 0,
          nodes: [],
        };
        slot.count += 1;
        if (slot.nodes.length < 5) slot.nodes.push(n.id);
        styles.set(key, slot);
      },
      page.id,
    );
  }
  const items = [...styles.values()].sort((a, b) => b.count - a.count);
  return ok(paginate(items, params));
}

export interface AssetsData {
  images: { nodeId: string; pageId: string; name: string; w: number; h: number; bytes: number }[];
  fonts: string[];
}

function getAssets(snap: Snapshot): ApiResult<AssetsData> {
  const images: AssetsData["images"] = [];
  const fonts = new Set<string>();
  for (const page of snap.pages) {
    walk(
      page.root,
      (n) => {
        if (n.fontFamily) fonts.add(n.fontFamily);
        if (n.fillType === "image" && n.imageSrc) {
          const b64 = n.imageSrc.includes(",") ? n.imageSrc.split(",")[1] : n.imageSrc;
          images.push({
            nodeId: n.id,
            pageId: page.id,
            name: n.name,
            w: Math.round(n.w),
            h: Math.round(n.h),
            bytes: Math.round((b64.length * 3) / 4),
          });
        }
      },
      page.id,
    );
  }
  return ok({ images, fonts: [...fonts].sort() });
}

function getAnnotations(
  snap: Snapshot,
  params: ({ nodeId?: string } & PageParams) | undefined,
): ApiResult<Page<unknown>> {
  let items = snap.annotations ?? [];
  if (params?.nodeId) items = items.filter((a) => a.nodeId === params.nodeId);
  return ok(paginate(items, params));
}

function getDesignVersion(snap: Snapshot): ApiResult<Record<string, unknown>> {
  let nodes = 0;
  for (const page of snap.pages) walk(page.root, () => nodes++, page.id);
  return ok({
    file: snap.fileName,
    api: DESIGN_API_VERSION,
    pages: snap.pages.length,
    nodes,
    components: snap.components?.length ?? 0,
    variables: snap.variables?.length ?? 0,
    collections: snap.variableCollections?.length ?? 0,
    annotations: snap.annotations?.length ?? 0,
  });
}

/* ── code ───────────────────────────────────────────────────────────────── */

const TREE_FORMATS: TreeFormat[] = ["tsx", "html", "tailwind", "css", "vue", "svelte"];

export interface GenerateCodeParams {
  id: string;
  format?: TreeFormat;
  unit?: "px" | "rem";
  scope?: "layer" | "subtree";
}

function generateCode(snap: Snapshot, params: GenerateCodeParams): ApiResult<{ format: string; code: string; scope: string }> {
  if (!params.id) return err("BAD_ARGS", "generateCode needs { id }.");
  const format = params.format ?? "tsx";
  if (!TREE_FORMATS.includes(format)) {
    return err("UNSUPPORTED", `Unknown format "${params.format}". One of: ${TREE_FORMATS.join(", ")}.`);
  }
  const hit = locate(snap, params.id);
  if (!hit) return err("NOT_FOUND", `No node "${params.id}".`);
  const subtree = params.scope ? params.scope === "subtree" : (hit.node.children?.length ?? 0) > 0;
  const code = generateSubtreeCode(hit.node, {
    format,
    unit: params.unit ?? "px",
    snap,
    maxDepth: subtree ? undefined : 0,
  });
  return ok({ format, code, scope: subtree ? "subtree" : "layer" });
}

/* ── router + catalog ─────────────────────────────────────────────────── */

type Handler = (snap: Snapshot, params: Record<string, never>) => ApiResult<unknown>;

const ROUTES: Record<string, Handler> = {
  getSelection: (s) => getSelection(s),
  getNode: (s, p) => getNode(s, p as unknown as { id: string }),
  getLayers: (s, p) => getLayers(s, (p as unknown as LayersParams) ?? {}),
  findNodes: (s, p) => findNodes(s, (p as unknown as FindParams) ?? {}),
  getVariables: (s, p) => getVariables(s, p as unknown as PageParams & { collection?: string; type?: string }),
  getVariable: (s, p) => getVariable(s, p as unknown as { id: string }),
  getVariableUsage: (s, p) => getVariableUsage(s, p as unknown as { id: string } & PageParams),
  getTokens: (s, p) => getTokens(s, p as unknown as PageParams & { collection?: string; type?: string }),
  getTokenUsage: (s, p) => getTokenUsage(s, p as unknown as { id: string } & PageParams),
  getComponents: (s, p) => getComponents(s, p as unknown as PageParams),
  getComponent: (s, p) => getComponent(s, p as unknown as { id: string }),
  getInstances: (s, p) => getInstances(s, p as unknown as { id: string } & PageParams),
  getComponentProperties: (s, p) => getComponentProperties(s, p as unknown as { id: string }),
  getVariants: (s, p) => getVariants(s, p as unknown as { id: string }),
  getCodeMapping: (s, p) => getCodeMapping(s, p as unknown as { id: string; framework?: string }),
  getCodeComponent: (s, p) => getCodeComponent(s, p as unknown as { id: string; framework?: TreeFormat }),
  getAutoLayout: (s, p) => getAutoLayout(s, p as unknown as { id: string }),
  getConstraints: (s, p) => getConstraints(s, p as unknown as { id: string }),
  getSpacing: (s, p) => getSpacing(s, p as unknown as { a: string; b: string }),
  getColors: (s, p) => getColors(s, p as unknown as PageParams),
  getTypography: (s, p) => getTypography(s, p as unknown as PageParams),
  getAssets: (s) => getAssets(s),
  getAnnotations: (s, p) => getAnnotations(s, p as unknown as { nodeId?: string } & PageParams),
  getDesignVersion: (s) => getDesignVersion(s),
  generateCode: (s, p) => generateCode(s, p as unknown as GenerateCodeParams),
};

/** Call one method by name. Unknown methods and throws become envelopes, never exceptions. */
export function apiCall(
  snap: Snapshot,
  method: string,
  params?: Record<string, unknown>,
): ApiResult<unknown> {
  const handler = ROUTES[method];
  if (!handler) {
    return err("UNSUPPORTED", `Unknown method "${method}". Methods: ${Object.keys(ROUTES).join(", ")}.`);
  }
  try {
    return handler(snap, (params ?? {}) as Record<string, never>);
  } catch (e) {
    return err("INTERNAL", e instanceof Error ? e.message : String(e));
  }
}

export interface MethodDoc {
  params: string[];
  returns: string;
  description: string;
}

/** Machine-readable catalog of the surface (see docs/DESIGN_API.md for prose). */
export function describeApi(): { version: string; envelope: string; errors: ApiErrorCode[]; methods: Record<string, MethodDoc> } {
  const paged = ["limit?", "offset?"];
  return {
    version: DESIGN_API_VERSION,
    envelope: "{ ok: true, data } | { ok: false, error: { code, message } }",
    errors: ["NOT_FOUND", "BAD_ARGS", "UNSUPPORTED", "EMPTY", "INTERNAL"],
    methods: {
      getSelection: { params: [], returns: "SelectionData", description: "Currently selected nodes as summaries." },
      getNode: { params: ["id", "depth?", "full?"], returns: "NodeData", description: "One node: summary plus children to depth; full adds the raw node." },
      getLayers: { params: ["page?", "parent?", "kind?", ...paged], returns: "Page<NodeSummary>", description: "Direct children of a parent (default: current page root)." },
      findNodes: { params: ["kind?", "name?", "nameIs?", "id?", "under?", "instanceOf?", "visible?", "minW?", "minH?", "maxW?", "maxH?", ...paged], returns: "Page<NodeSummary>", description: "Filtered search across pages, or under one subtree." },
      getVariables: { params: ["collection?", "type?", ...paged], returns: "Page<TokenData>", description: "Variables resolved under the active modes." },
      getVariable: { params: ["id"], returns: "TokenData", description: "One variable by id or name." },
      getVariableUsage: { params: ["id", ...paged], returns: "Page<TokenUsage>", description: "Where a variable is bound or value-matched." },
      getTokens: { params: ["collection?", "type?", ...paged], returns: "Page<TokenData>", description: "Alias of getVariables (token-shaped naming)." },
      getTokenUsage: { params: ["id", ...paged], returns: "Page<TokenUsage>", description: "Alias of getVariableUsage." },
      getComponents: { params: paged, returns: "Page<ComponentData>", description: "All component masters." },
      getComponent: { params: ["id"], returns: "ComponentData", description: "One master by id, name, or node id." },
      getInstances: { params: ["id", ...paged], returns: "Page<NodeSummary>", description: "Placed instances of a component." },
      getComponentProperties: { params: ["id"], returns: "ComponentPropsData", description: "Property defs; live values when id is an instance." },
      getVariants: { params: ["id"], returns: "{ variants }", description: "Variant names of a component." },
      getCodeMapping: { params: ["id", "framework?"], returns: "CodeMappingData[]", description: "Component → code mappings plus sync status." },
      getCodeComponent: { params: ["id", "framework?"], returns: "CodeComponentData", description: "How an instance renders in code (mapping applied)." },
      getAutoLayout: { params: ["id"], returns: "{ layout, inferred }", description: "A node's auto layout plus the inferred CSS layout." },
      getConstraints: { params: ["id"], returns: "{ horizontal, vertical, min/max }", description: "Resize constraints and sizing bounds." },
      getSpacing: { params: ["a", "b"], returns: "{ horizontal, vertical }", description: "Edge-to-edge gaps between two nodes (negative = overlap)." },
      getColors: { params: paged, returns: "Page<ColorUsage>", description: "Paint inventory sorted by usage." },
      getTypography: { params: paged, returns: "Page<TypeUsage>", description: "Text style inventory sorted by usage." },
      getAssets: { params: [], returns: "AssetsData", description: "Image fills (with byte sizes) and font families." },
      getAnnotations: { params: ["nodeId?", ...paged], returns: "Page<Annotation>", description: "Dev Mode annotations, optionally for one node." },
      getDesignVersion: { params: [], returns: "{ file, counts }", description: "File identity plus document counts." },
      generateCode: { params: ["id", "format?", "unit?", "scope?"], returns: "{ format, code, scope }", description: "Subtree code in tsx|html|tailwind|css|vue|svelte." },
    },
  };
}

/**
 * Expose the API to browser automation as `window.__xNativeDesignApi`:
 * `{ version, methods(), call(method, params) }`. Installed once by the app
 * shell; `getSnapshot` keeps every call live.
 */
export function installDesignApi(getSnapshot: () => Snapshot): void {
  (window as unknown as { __xNativeDesignApi: unknown }).__xNativeDesignApi = {
    version: DESIGN_API_VERSION,
    methods: () => Object.keys(ROUTES),
    describe: () => describeApi(),
    call: (method: string, params?: Record<string, unknown>) => apiCall(getSnapshot(), method, params),
  };
}
