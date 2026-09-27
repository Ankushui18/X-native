/** UI-facing adapter for a Rust-owned .x document session. It is NOT an
 * alternate TypeScript document engine: there is no JS node tree or history
 * here. Open/export are explicit checkpoints; each command returns at most one
 * changed node and small history flags. The existing web MemoryEngine cannot
 * consume native .x yet and must not run in parallel with this session. */
import { initWasmBridge, rustSessionConstructor, type WasmDocumentSession } from "./wasmBridge";
import { auditRustCall, registerAuditProbe } from "./bridgeRuntimeAudit";
import type { BooleanOp } from "./types";

// Session status is an independent owner decision; the import loader being ready
// alone says nothing about this schema/route's admission or command dispatch.
let openSessions = 0;
registerAuditProbe("session", { snapshot: () => {
  // Hash query != real URL query; never log the document ID or contents.
  const hash = typeof window !== "undefined" ? window.location.hash ?? "" : "";
  const fileRoute = /^#\/file\/[^/?#]+(?:\?[^#]*)?$/.test(hash);
  const rustRequested = fileRoute && new URLSearchParams(hash.split("?")[1] ?? "").get("engine") === "rust";
  return {
    activeRustSessions: openSessions,
    activeDocumentOwner: openSessions > 0 ? "Rust command session (opt-in view)" :
      rustRequested ? "none: Rust view loading/refused; no TS shadow editor" :
      fileRoute ? "TypeScript MemoryEngine (or still loading)" : "dashboard: no document owner",
    rustRouteRequested: rustRequested,
    mode: "only an explicitly admitted #/file/<id>?engine=rust route; ordinary editor is TS",
  };
} });

export interface RustNodeChange {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface RustGeometryChange extends RustNodeChange {
  index: number;
  kind: "rect" | "vector";
  fill: string;
  visible: boolean;
  locked: boolean;
  /** Present only on vector results; node-local contour anchors. */
  rings?: [number, number][][];
}
export interface RustBooleanChange {
  upsert: RustGeometryChange[];
  removed: string[];
}
export interface RustStateChange {
  revision: number;
  node: RustNodeChange | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Only structural Boolean apply/undo/redo returns this bounded patch. */
  boolean?: RustBooleanChange;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Rust ${label}`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) {
    throw new Error(`Unexpected Rust ${label} fields`);
  }
}
function nodeValue(value: unknown): RustNodeChange | null {
  if (value === null) return null;
  const obj = record(value, "node delta");
  keys(obj, ["id", "name", "x", "y", "w", "h"], "node delta");
  if (typeof obj.id !== "string" || !obj.id || typeof obj.name !== "string" ||
      typeof obj.x !== "number" || !Number.isFinite(obj.x) ||
      typeof obj.y !== "number" || !Number.isFinite(obj.y) ||
      typeof obj.w !== "number" || !Number.isFinite(obj.w) ||
      typeof obj.h !== "number" || !Number.isFinite(obj.h)) throw new Error("Invalid Rust node delta");
  return { id: obj.id, name: obj.name, x: obj.x, y: obj.y, w: obj.w, h: obj.h };
}
function geometryValue(value: unknown): RustGeometryChange {
  const obj = record(value, "Boolean layer delta");
  const vector = obj.kind === "vector";
  keys(obj, ["id", "name", "x", "y", "w", "h", "index", "kind", "fill", "visible", "locked",
    ...(vector ? ["rings"] : [])], "Boolean layer delta");
  const node = nodeValue({ id: obj.id, name: obj.name, x: obj.x, y: obj.y, w: obj.w, h: obj.h });
  if (!node || !node.id || node.id.length > 256 || node.name.length > 1024 ||
      (obj.kind !== "rect" && !vector) ||
      !Number.isSafeInteger(obj.index) || (obj.index as number) < 0 || (obj.index as number) > 2048 ||
      !(node.w > 0 && node.h > 0) || typeof obj.fill !== "string" || !/^#[0-9a-f]{6}$/.test(obj.fill) ||
      typeof obj.visible !== "boolean" || typeof obj.locked !== "boolean") throw new Error("Invalid Rust Boolean layer");
  let rings: [number, number][][] | undefined;
  if (vector) {
    if (!Array.isArray(obj.rings) || obj.rings.length > 512) throw new Error("Invalid Rust Boolean contours");
    let count = 0;
    rings = obj.rings.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 3 || (count += ring.length) > 4096) {
        throw new Error("Invalid Rust Boolean contour size");
      }
      return ring.map((p): [number, number] => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) {
          throw new Error("Invalid Rust Boolean contour point");
        }
        return [p[0], p[1]];
      });
    });
  }
  return { ...node, index: obj.index as number, kind: vector ? "vector" : "rect", fill: obj.fill,
    visible: obj.visible, locked: obj.locked, ...(vector ? { rings } : {}) };
}
function booleanValue(value: unknown): RustBooleanChange {
  const obj = record(value, "Boolean delta");
  keys(obj, ["upsert", "removed"], "Boolean delta");
  if (!Array.isArray(obj.upsert) || !Array.isArray(obj.removed) ||
      ![1, 2].includes(obj.upsert.length) || obj.upsert.length + obj.removed.length !== 3 ||
      obj.removed.some(id => typeof id !== "string" || !id)) throw new Error("Invalid Rust Boolean delta");
  const upsert = obj.upsert.map(geometryValue);
  const removed = obj.removed as string[];
  const ids = [...upsert.map(n => n.id), ...removed];
  if (new Set(ids).size !== 3) throw new Error("Duplicate Rust Boolean identities");
  return { upsert, removed };
}
function stateValue(json: string): RustStateChange {
  const obj = record(JSON.parse(json) as unknown, "session delta");
  keys(obj, ["revision", "node", "canUndo", "canRedo", ...(obj.boolean === undefined ? [] : ["boolean"])], "session delta");
  if (typeof obj.revision !== "number" || !Number.isSafeInteger(obj.revision) || obj.revision < 0 ||
      typeof obj.canUndo !== "boolean" || typeof obj.canRedo !== "boolean" ||
      (obj.boolean !== undefined && obj.node !== null)) throw new Error("Invalid Rust session delta");
  return {
    revision: obj.revision,
    node: nodeValue(obj.node),
    canUndo: obj.canUndo,
    canRedo: obj.canRedo,
    ...(obj.boolean === undefined ? {} : { boolean: booleanValue(obj.boolean) }),
  };
}

export class RustSessionClient {
  private binding: WasmDocumentSession | null;

  constructor(binding: WasmDocumentSession) {
    // The version handshake alone is not enough if an optional asset was
    // partially deployed. Do not hand an incomplete Rust owner to the UI.
    const methods = ["state", "getNode", "renameNode", "moveNode", "resizeNode", "booleanNode",
      "undo", "redo", "exportX", "free"] as const;
    if (methods.some(method => typeof binding[method] !== "function")) {
      if (typeof binding.free === "function") auditRustCall("x-wasm.RustDocumentSession.free", () => binding.free());
      throw new Error("Incomplete Rust command-session ABI");
    }
    this.binding = binding;
    openSessions++;
  }
  private current(): WasmDocumentSession {
    if (!this.binding) throw new Error("Rust document session has been closed");
    return this.binding;
  }
  private native<T>(method: string, invoke: (binding: WasmDocumentSession) => T): T {
    const binding = this.current(); // JS-side use-after-close is NOT a Rust call.
    return auditRustCall(`x-wasm.RustDocumentSession.${method}`, () => invoke(binding));
  }
  state(): RustStateChange { return stateValue(this.native("state", b => b.state())); }
  getNode(id: string): RustNodeChange | null { return nodeValue(JSON.parse(this.native("getNode", b => b.getNode(id))) as unknown); }
  renameNode(id: string, name: string): RustStateChange { return stateValue(this.native("renameNode", b => b.renameNode(id, name))); }
  moveNode(id: string, dx: number, dy: number): RustStateChange { return stateValue(this.native("moveNode", b => b.moveNode(id, dx, dy))); }
  resizeNode(id: string, w: number, h: number): RustStateChange { return stateValue(this.native("resizeNode", b => b.resizeNode(id, w, h))); }
  booleanNode(first: string, second: string, op: BooleanOp): RustStateChange {
    return stateValue(this.native("booleanNode", b => b.booleanNode(first, second, op)));
  }
  undo(): RustStateChange { return stateValue(this.native("undo", b => b.undo())); }
  redo(): RustStateChange { return stateValue(this.native("redo", b => b.redo())); }
  /** A complete .x document is returned ONLY at an explicit save. */
  exportX(): string { return this.native("exportX", b => b.exportX()); }
  close(): void {
    const binding = this.binding;
    this.binding = null;
    if (binding) {
      openSessions--;
      auditRustCall("x-wasm.RustDocumentSession.free", () => binding.free());
    }
  }
}

/** No fallback to a second JS command engine: callers must keep their
 * existing engine until a native .x document can be opened without loss.
 * Invalid .x throws, while a missing/older optional artifact returns null. */
export async function openRustSession(x: string, signal?: AbortSignal): Promise<RustSessionClient | null> {
  // The optional bridge can take time to download. A route that was left while
  // it loaded must not create a second Rust history when initialization ends.
  if (signal?.aborted || !(await initWasmBridge()) || signal?.aborted) return null;
  const Session = rustSessionConstructor();
  return Session ? new RustSessionClient(auditRustCall("x-wasm.RustDocumentSession.new", () => new Session(x))) : null;
}
