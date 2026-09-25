/**
 * File-backed document store for the MCP server.
 *
 * The editor keeps documents in localStorage/IndexedDB, which do not exist
 * for a headless agent — so each document here is one self-contained JSON
 * file (`<name>.json`, the `DocSeed` shape) inside the docs directory.
 * Engines are cached per document, so opening once then calling twenty tools
 * does not re-parse twenty times. Images must be inline `data:` URLs: the
 * `asset:` refs the editor writes need its IndexedDB hydrator, which v1 does
 * not ship — a document carrying refs loads, but its pictures stay empty.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryEngine, node } from "../../web/src/engine/memory";
import type { Page, Snapshot } from "../../web/src/engine/types";
import type { DocSeed } from "../../web/src/engine/files";

export interface Store {
  dir: string;
  engines: Map<string, MemoryEngine>;
  active: string | null;
}

export function createStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  return { dir, engines: new Map(), active: null };
}

/** Domain error with an API error code, so tool results stay enveloped. */
export class DocError extends Error {
  code: "NOT_FOUND" | "BAD_ARGS" | "INTERNAL";
  constructor(code: DocError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || !/^[\w\-. ]+$/.test(name)) {
    throw new DocError("BAD_ARGS", `Bad document name ${JSON.stringify(name)}: letters, digits, spaces, "_" and "-" only.`);
  }
  return name;
}

export function docPath(store: Store, name: string): string {
  // basename() keeps a name inside the docs dir even if it grew a separator.
  return join(store.dir, `${basename(checkName(name))}.json`);
}

/** A blank page: transparent root frame, like the editor's own new page. */
export function blankDoc(fileName: string): DocSeed {
  const root = node("frame", "Page 1", 0, 0, 1400, 1400, {
    fill: "#00000000",
    overflow: "visible",
    children: [],
  });
  const page: Page = {
    id: `page-${randomUUID()}`,
    name: "Page 1",
    root,
    comments: [],
    guides: [],
    pixelGrid: false,
    pixelGridColor: "#cccccc",
    pixelSnap: true,
    flowStart: "",
  };
  return {
    fileName,
    pages: [page],
    components: [],
    styles: [],
    page: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    showRulers: false,
    showMinimap: false,
    showComments: false,
  };
}

export function listDocs(store: Store): string[] {
  return readdirSync(store.dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .sort();
}

function readDocFile(store: Store, name: string): DocSeed {
  const path = docPath(store, name);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new DocError(
      "NOT_FOUND",
      `No document "${name}". Use new_doc to create it, or list_docs to see what exists.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DocError("BAD_ARGS", `"${name}.json" is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DocError("BAD_ARGS", `"${name}.json" is not an X-Native document.`);
  }
  const doc = parsed as Partial<DocSeed>;
  if (typeof doc.fileName !== "string" || !Array.isArray(doc.pages) || doc.pages.length === 0) {
    throw new DocError("BAD_ARGS", `"${name}.json" needs { fileName: string, pages: [at least one page] }.`);
  }
  return doc as DocSeed;
}

/** Load (or fetch from cache) and make active. Returns whether it was already open. */
export function openDoc(store: Store, name: string): { engine: MemoryEngine; alreadyOpen: boolean } {
  checkName(name);
  const cached = store.engines.get(name);
  if (cached) {
    store.active = name;
    return { engine: cached, alreadyOpen: true };
  }
  // restore=false: there is no localStorage here; the file is the document.
  // The constructor backfills partial/older nodes, so hand-written seeds load.
  const engine = new MemoryEngine(false, readDocFile(store, name));
  if (engine.restoreFailed) {
    throw new DocError("BAD_ARGS", `"${name}.json" could not be repaired into a document.`);
  }
  store.engines.set(name, engine);
  store.active = name;
  return { engine, alreadyOpen: false };
}

export function newDoc(store: Store, name: string): MemoryEngine {
  checkName(name);
  const doc = blankDoc(name);
  writeFileSync(docPath(store, name), JSON.stringify(doc, null, 2));
  const engine = new MemoryEngine(false, doc);
  store.engines.set(name, engine);
  store.active = name;
  return engine;
}

/**
 * Resolve which document a tool call means: explicit `doc`, else the active
 * one, else the only one if exactly one exists — otherwise the agent must say.
 */
export function snapshotOf(store: Store, doc?: string): Snapshot {
  if (doc !== undefined) return openDoc(store, doc).engine.snapshot();
  if (store.active) {
    const engine = store.engines.get(store.active);
    if (engine) return engine.snapshot();
  }
  const docs = listDocs(store);
  if (docs.length === 1) return openDoc(store, docs[0]).engine.snapshot();
  if (docs.length === 0) {
    throw new DocError("BAD_ARGS", "No documents yet. Create one with new_doc, then retry.");
  }
  throw new DocError("BAD_ARGS", `Several documents exist (${docs.join(", ")}). Pass { doc } or call open_doc first.`);
}
