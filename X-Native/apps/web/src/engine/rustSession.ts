/** UI-facing adapter for a Rust-owned .x document session. It is NOT an
 * alternate TypeScript document engine: there is no JS node tree or history
 * here. Open/export are explicit checkpoints; each command returns at most one
 * changed node and small history flags. The existing web MemoryEngine cannot
 * consume native .x yet and must not run in parallel with this session. */
import { initWasmBridge, rustSessionConstructor, type WasmDocumentSession } from "./wasmBridge";

export interface RustNodeChange {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface RustStateChange {
  revision: number;
  node: RustNodeChange | null;
  canUndo: boolean;
  canRedo: boolean;
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
function stateValue(json: string): RustStateChange {
  const obj = record(JSON.parse(json) as unknown, "session delta");
  keys(obj, ["revision", "node", "canUndo", "canRedo"], "session delta");
  if (typeof obj.revision !== "number" || !Number.isSafeInteger(obj.revision) || obj.revision < 0 ||
      typeof obj.canUndo !== "boolean" || typeof obj.canRedo !== "boolean") throw new Error("Invalid Rust session delta");
  return {
    revision: obj.revision,
    node: nodeValue(obj.node),
    canUndo: obj.canUndo,
    canRedo: obj.canRedo,
  };
}

export class RustSessionClient {
  private binding: WasmDocumentSession | null;

  constructor(binding: WasmDocumentSession) {
    // The version handshake alone is not enough if an optional asset was
    // partially deployed. Do not hand an incomplete Rust owner to the UI.
    const methods = ["state", "getNode", "renameNode", "moveNode", "resizeNode", "undo", "redo", "exportX", "free"] as const;
    if (methods.some(method => typeof binding[method] !== "function")) {
      if (typeof binding.free === "function") binding.free();
      throw new Error("Incomplete Rust command-session ABI");
    }
    this.binding = binding;
  }
  private current(): WasmDocumentSession {
    if (!this.binding) throw new Error("Rust document session has been closed");
    return this.binding;
  }
  state(): RustStateChange { return stateValue(this.current().state()); }
  getNode(id: string): RustNodeChange | null { return nodeValue(JSON.parse(this.current().getNode(id)) as unknown); }
  renameNode(id: string, name: string): RustStateChange { return stateValue(this.current().renameNode(id, name)); }
  moveNode(id: string, dx: number, dy: number): RustStateChange { return stateValue(this.current().moveNode(id, dx, dy)); }
  resizeNode(id: string, w: number, h: number): RustStateChange { return stateValue(this.current().resizeNode(id, w, h)); }
  undo(): RustStateChange { return stateValue(this.current().undo()); }
  redo(): RustStateChange { return stateValue(this.current().redo()); }
  /** A complete .x document is returned ONLY at an explicit save. */
  exportX(): string { return this.current().exportX(); }
  close(): void {
    const binding = this.binding;
    this.binding = null;
    binding?.free();
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
  return Session ? new RustSessionClient(new Session(x)) : null;
}
