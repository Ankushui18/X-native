/**
 * Writes for the MCP server: validate, dispatch through the real engine
 * (so undo, constraints and relayout all behave), then persist the file.
 *
 * Every mutation auto-saves — there is no separate save step to forget, and
 * a crashed agent never leaves a dirty in-memory doc behind the file.
 *
 * Patches go through an allowlist, not raw `Partial<XNode>`: the engine
 * assigns patch keys onto the node, so a typo'd key would silently grow a
 * junk field that every later load carries. Structural fields (id, kind,
 * children, layout objects, bindings) stay behind dedicated commands.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { MemoryEngine } from "../../web/src/engine/memory";
import { apiCall } from "../../web/src/engine/designApi";
import type { CodeMapping, Snapshot, XNode } from "../../web/src/engine/types";
import { DocError, docPath, listDocs, openDoc, type Store } from "./store";

/** Kinds `add` can construct directly (no operands or masters needed). */
export const CREATABLE = [
  "frame", "group", "rect", "ellipse", "text",
  "line", "arrow", "poly", "star", "vector",
] as const;

const NUM_KEYS = new Set([
  "x", "y", "w", "h", "rotation", "opacity",
  "fillOpacity", "strokeOpacity", "strokeWidth", "strokeDash", "strokeGap",
  "fontSize", "fontWeight", "lineHeight", "letterSpacing", "cornerSmoothing",
]);
const STR_KEYS = new Set([
  "name", "fill", "fillB", "fillBlend",
  "strokePaint", "strokeAlign", "strokeCap", "strokeJoin",
  "text", "fontFamily", "maskType", "variant", "overflow",
]);
const BOOL_KEYS = new Set(["visible", "locked", "fillVisible", "strokeVisible", "isMask"]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Keep only allowlisted keys with sane values; reject the rest loudly. */
export function cleanPatch(patch: unknown): Partial<XNode> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new DocError("BAD_ARGS", "patch must be an object of layer properties.");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "cornerRadii") {
      if (!Array.isArray(value) || value.length !== 4 || !value.every(isNum)) {
        throw new DocError("BAD_ARGS", "cornerRadii must be [topLeft, topRight, bottomRight, bottomLeft].");
      }
      out.cornerRadii = [...value];
    } else if (NUM_KEYS.has(key)) {
      if (!isNum(value)) throw new DocError("BAD_ARGS", `"${key}" must be a finite number.`);
      if ((key === "w" || key === "h") && value <= 0) {
        throw new DocError("BAD_ARGS", `"${key}" must be positive.`);
      }
      out[key] = value;
    } else if (STR_KEYS.has(key)) {
      if (typeof value !== "string") throw new DocError("BAD_ARGS", `"${key}" must be a string.`);
      out[key] = value;
    } else if (BOOL_KEYS.has(key)) {
      if (typeof value !== "boolean") throw new DocError("BAD_ARGS", `"${key}" must be a boolean.`);
      out[key] = value;
    } else {
      throw new DocError(
        "BAD_ARGS",
        `Cannot set "${key}" (id, kind, children and layout objects are structural — use the dedicated commands).`,
      );
    }
  }
  return out as Partial<XNode>;
}

const MAPPING_FRAMEWORKS = [
  "react", "html", "vue", "svelte", "tailwind", "swiftui", "compose", "flutter", "uikit",
] as const;

/** Validate a component → code mapping; fill in id when the agent omits it. */
export function cleanMapping(mapping: unknown): CodeMapping {
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    throw new DocError("BAD_ARGS", "mapping must be an object.");
  }
  const m = mapping as Record<string, unknown>;
  if (!MAPPING_FRAMEWORKS.includes(m.framework as (typeof MAPPING_FRAMEWORKS)[number])) {
    throw new DocError("BAD_ARGS", `framework must be one of: ${MAPPING_FRAMEWORKS.join(", ")}.`);
  }
  if (typeof m.componentName !== "string" || !m.componentName) {
    throw new DocError("BAD_ARGS", "mapping needs a componentName.");
  }
  if (!Array.isArray(m.props)) {
    throw new DocError("BAD_ARGS", "mapping needs props: [{ prop, kind, codeProp? }].");
  }
  for (const p of m.props) {
    if (typeof p !== "object" || p === null || typeof (p as { prop?: unknown }).prop !== "string") {
      throw new DocError("BAD_ARGS", "Each prop mapping needs at least { prop }.");
    }
  }
  return {
    id: typeof m.id === "string" && m.id ? m.id : `map-${randomUUID().slice(0, 8)}`,
    framework: m.framework as CodeMapping["framework"],
    componentName: m.componentName,
    ...(typeof m.importPath === "string" ? { importPath: m.importPath } : {}),
    ...(typeof m.file === "string" ? { file: m.file } : {}),
    ...(typeof m.version === "string" ? { version: m.version } : {}),
    props: m.props as CodeMapping["props"],
  };
}

export function assertNode(engine: MemoryEngine, id: string): void {
  const hit = apiCall(engine.snapshot(), "getNode", { id });
  if (!hit.ok) throw new DocError("NOT_FOUND", `No node "${id}".`);
}

function allIds(snap: Snapshot): Set<string> {
  const ids = new Set<string>();
  const walk = (n: XNode): void => {
    ids.add(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  for (const p of snap.pages) walk(p.root);
  return ids;
}

/** Resolve the doc name (same rules as reads), run the edit, persist the file. */
export function mutate(store: Store, doc: string | undefined, fn: (engine: MemoryEngine) => unknown): unknown {
  let name = doc;
  if (name === undefined) {
    if (store.active && store.engines.has(store.active)) {
      name = store.active;
    } else {
      const docs = listDocs(store);
      if (docs.length === 1) name = docs[0];
      else if (docs.length === 0) throw new DocError("BAD_ARGS", "No documents yet. Create one with new_doc, then retry.");
      else throw new DocError("BAD_ARGS", `Several documents exist (${docs.join(", ")}). Pass { doc } or call open_doc first.`);
    }
  }
  const { engine } = openDoc(store, name);
  const out = fn(engine);
  writeFileSync(docPath(store, name), JSON.stringify(engine.toDoc()));
  return out;
}

/** Ids that appeared by running `fn` — how add/duplicate report their results. */
export function withNewIds(engine: MemoryEngine, fn: () => void): string[] {
  const before = allIds(engine.snapshot());
  fn();
  const fresh: string[] = [];
  const walk = (n: XNode): void => {
    if (!before.has(n.id)) fresh.push(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  // The snapshot cache refreshes on dispatch, so this walks the new tree.
  for (const p of engine.snapshot().pages) walk(p.root);
  return fresh;
}
