/**
 * The MCP tool table: every `designApi` method becomes one tool, plus four
 * document tools. Schemas are hand-written from the method signatures (the
 * catalog only carries names, not types), while descriptions come straight
 * from `describeApi()` so prose cannot drift from the implementation.
 *
 * Results keep the API envelope — `{ ok: true, data }` or
 * `{ ok: false, error: { code, message } }` — as JSON text, with
 * `structuredContent` set when the payload is a plain object.
 */
import { z } from "zod";
import { apiCall, describeApi, DESIGN_API_VERSION } from "../../web/src/engine/designApi";
import { DocError, listDocs, newDoc, openDoc, snapshotOf, type Store } from "./store";
import { assertNode, cleanMapping, cleanPatch, CREATABLE, mutate, withNewIds } from "./mutate";

type Shape = Record<string, z.ZodTypeAny>;
export interface ToolDef {
  name: string;
  description: string;
  shape: Shape;
  readOnly: boolean;
  run: (store: Store, params: Record<string, unknown>) => unknown;
}

const DOC = {
  doc: z.string().optional().describe("Document name. Defaults to the open document."),
};
const PAGED = {
  limit: z.number().int().min(1).optional().describe("Max items (default 100)."),
  offset: z.number().int().min(0).optional().describe("Items to skip (default 0)."),
};
const ID = { id: z.string().describe("Node/component/variable id (names accepted where noted).") };

const CATALOG = describeApi().methods;
const desc = (method: string): string => CATALOG[method]?.description ?? method;

/** Wrap one designApi method: resolve the doc, strip `doc`, call, return. */
function api(name: string, shape: Shape): ToolDef {
  return {
    name,
    description: `${desc(name)} Envelope: { ok, data } | { ok: false, error }.`,
    shape: { ...DOC, ...shape },
    readOnly: true,
    run: (store, params) => {
      const { doc, ...rest } = params;
      return apiCall(snapshotOf(store, doc as string | undefined), name, rest);
    },
  };
}

const STR = (d: string) => z.string().optional().describe(d);
const NUM = (d: string) => z.number().optional().describe(d);
const BOOL = (d: string) => z.boolean().optional().describe(d);

export const TOOLS: ToolDef[] = [
  api("getSelection", {}),
  api("getNode", {
    ...ID,
    depth: z.number().int().min(0).max(12).optional().describe("Child levels to include (default 0)."),
    full: BOOL("Include the raw node object."),
  }),
  api("getLayers", { page: STR("Page id or name (default: current page)."), parent: STR("Parent node id (default: page root)."), kind: STR("Filter by node kind, e.g. frame, text, rect."), ...PAGED }),
  api("findNodes", {
    kind: STR("Filter by node kind."), name: STR("Case-insensitive substring of the name."), nameIs: STR("Exact name match."),
    id: STR("Exact node id."), under: STR("Search only under this subtree."), instanceOf: STR("Only instances of this component id."),
    visible: BOOL("Filter by visibility."), minW: NUM("Minimum width."), minH: NUM("Minimum height."),
    maxW: NUM("Maximum width."), maxH: NUM("Maximum height."), ...PAGED,
  }),
  api("getVariables", { collection: STR("Collection id or name."), type: STR("Variable type, e.g. color, number."), ...PAGED }),
  api("getVariable", { ...ID }),
  api("getVariableUsage", { ...ID, ...PAGED }),
  api("getTokens", { collection: STR("Collection id or name."), type: STR("Token type, e.g. color, number."), ...PAGED }),
  api("getTokenUsage", { ...ID, ...PAGED }),
  api("getComponents", { ...PAGED }),
  api("getComponent", { ...ID }),
  api("getInstances", { ...ID, ...PAGED }),
  api("getComponentProperties", { ...ID }),
  api("getVariants", { ...ID }),
  api("getCodeMapping", { ...ID, framework: STR("Prefer mappings for this framework.") }),
  api("getCodeComponent", { ...ID, framework: STR("Prefer mappings for this framework.") }),
  api("getAutoLayout", { ...ID }),
  api("getConstraints", { ...ID }),
  api("getSpacing", {
    a: z.string().describe("First node id."), b: z.string().describe("Second node id."),
  }),
  api("getColors", { ...PAGED }),
  api("getTypography", { ...PAGED }),
  api("getAssets", {}),
  api("getAnnotations", { nodeId: STR("Only annotations on this node."), ...PAGED }),
  api("getDesignVersion", {}),
  api("generateCode", {
    ...ID,
    format: z.enum(["tsx", "html", "tailwind", "css", "vue", "svelte"]).optional().describe("Output format (default tsx)."),
    unit: z.enum(["px", "rem"]).optional().describe("Length unit."),
    scope: z.enum(["layer", "subtree"]).optional().describe("Single layer or whole subtree (default: subtree when it has children)."),
  }),

  {
    name: "list_docs",
    description: "List the documents in the docs directory.",
    shape: {},
    readOnly: true,
    run: (store) => ({ ok: true, data: { docs: listDocs(store) } }),
  },
  {
    name: "open_doc",
    description: "Open a document by name (without .json) and make it active. Returns its identity and counts.",
    shape: { name: z.string().describe("Document name, without .json.") },
    readOnly: true,
    run: (store, params) => {
      const { engine } = openDoc(store, params.name as string);
      const version = apiCall(engine.snapshot(), "getDesignVersion", {});
      if (!version.ok) return version;
      return { ok: true, data: { name: params.name, ...(version.data as Record<string, unknown>) } };
    },
  },
  {
    name: "new_doc",
    description: "Create a blank document, save it, and make it active.",
    shape: { name: z.string().describe("Document name (becomes <name>.json).") },
    readOnly: false,
    run: (store, params) => {
      const engine = newDoc(store, params.name as string);
      const version = apiCall(engine.snapshot(), "getDesignVersion", {});
      if (!version.ok) return version;
      return { ok: true, data: { name: params.name, created: true, ...(version.data as Record<string, unknown>) } };
    },
  },
  {
    name: "describe_api",
    description: "Machine-readable catalog of the design API: version, envelope, error codes, methods.",
    shape: {},
    readOnly: true,
    run: () => ({ ok: true, data: { designApi: DESIGN_API_VERSION, ...describeApi() } }),
  },

  // ── writes: every one dispatches through the engine and auto-saves ──
  {
    name: "add_node",
    description: "Add a layer to a parent (default: page root). Returns the new node id. Auto-saves.",
    shape: {
      ...DOC,
      kind: z.enum(CREATABLE).describe("Layer kind."),
      x: z.number().describe("X in parent space."), y: z.number().describe("Y in parent space."),
      w: z.number().positive().describe("Width."), h: z.number().positive().describe("Height."),
      parent: z.string().optional().describe("Parent node id (default: page root)."),
      props: z.record(z.unknown()).optional().describe("Extra props: name, fill, text, fontSize, cornerRadii, … (allowlisted)."),
    },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        if (p.parent !== undefined) assertNode(engine, p.parent as string);
        const extra = p.props !== undefined ? cleanPatch(p.props) : undefined;
        const [id] = withNewIds(engine, () =>
          engine.dispatch({
            type: "add", kind: p.kind as (typeof CREATABLE)[number],
            x: p.x as number, y: p.y as number, w: p.w as number, h: p.h as number,
            ...(p.parent !== undefined ? { parent: p.parent as string } : {}),
            ...(extra ? { extra } : {}),
          }),
        );
        if (!id) throw new Error("add produced no node");
        const node = apiCall(engine.snapshot(), "getNode", { id });
        return { ok: true, data: { id, node: (node as { ok: true; data: unknown }).data } };
      }),
  },
  {
    name: "patch_node",
    description: "Set layer properties (geometry, paint, text, visibility…). Unknown keys are rejected. Auto-saves.",
    shape: { ...DOC, id: z.string().describe("Node id."), patch: z.record(z.unknown()).describe("Properties to set.") },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        assertNode(engine, p.id as string);
        engine.dispatch({ type: "patch", id: p.id as string, patch: cleanPatch(p.patch) });
        return { ok: true, data: { id: p.id } };
      }),
  },
  {
    name: "move_nodes",
    description: "Move layers by a delta (one undo step). Locked layers stay put. Auto-saves.",
    shape: { ...DOC, ids: z.array(z.string()).min(1).describe("Node ids."), dx: z.number().describe("X delta."), dy: z.number().describe("Y delta.") },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        for (const id of p.ids as string[]) assertNode(engine, id);
        engine.dispatch({ type: "move", ids: p.ids as string[], dx: p.dx as number, dy: p.dy as number });
        return { ok: true, data: { moved: p.ids } };
      }),
  },
  {
    name: "delete_nodes",
    description: "Delete layers. Auto-saves.",
    shape: { ...DOC, ids: z.array(z.string()).min(1).describe("Node ids.") },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        for (const id of p.ids as string[]) assertNode(engine, id);
        engine.dispatch({ type: "select", ids: p.ids as string[] });
        engine.dispatch({ type: "delete" });
        return { ok: true, data: { deleted: p.ids } };
      }),
  },
  {
    name: "duplicate_nodes",
    description: "Duplicate layers (engine offsets the copies). Returns the new ids. Auto-saves.",
    shape: { ...DOC, ids: z.array(z.string()).min(1).describe("Node ids.") },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        for (const id of p.ids as string[]) assertNode(engine, id);
        const fresh = withNewIds(engine, () => {
          engine.dispatch({ type: "select", ids: p.ids as string[] });
          engine.dispatch({ type: "duplicate" });
        });
        return { ok: true, data: { ids: fresh } };
      }),
  },
  {
    name: "undo",
    description: "Undo the last edit. Auto-saves.",
    shape: { ...DOC },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        engine.dispatch({ type: "undo" });
        const snap = engine.snapshot();
        return { ok: true, data: { canUndo: snap.canUndo, canRedo: snap.canRedo } };
      }),
  },
  {
    name: "redo",
    description: "Redo the last undone edit. Auto-saves.",
    shape: { ...DOC },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        engine.dispatch({ type: "redo" });
        const snap = engine.snapshot();
        return { ok: true, data: { canUndo: snap.canUndo, canRedo: snap.canRedo } };
      }),
  },
  {
    name: "set_code_mapping",
    description: "Point a component at a code component (P1.10 mapping). Auto-saves.",
    shape: {
      ...DOC,
      componentId: z.string().describe("Component master id or name."),
      mapping: z.record(z.unknown()).describe("{ framework, componentName, props: [{ prop, kind }], importPath?, file? } (id optional)."),
    },
    readOnly: false,
    run: (store, p) =>
      mutate(store, p.doc as string | undefined, (engine) => {
        // The command matches master/node ids only (and no-ops on a miss),
        // so resolve names through the API first.
        const found = apiCall(engine.snapshot(), "getComponent", { id: p.componentId as string });
        if (!found.ok) throw new DocError("NOT_FOUND", `No component "${p.componentId as string}".`);
        const mapping = cleanMapping(p.mapping);
        engine.dispatch({
          type: "setCodeMapping",
          componentId: (found.data as { id: string }).id,
          mapping,
        });
        return { ok: true, data: { mappingId: mapping.id } };
      }),
  },
];
