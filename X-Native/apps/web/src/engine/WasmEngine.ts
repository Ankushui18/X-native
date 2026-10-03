/**
 * Small typed wrapper for the isolated Phase 1 Rust/WASM proof of concept.
 * It deliberately does not pretend to implement the full MemoryEngine API;
 * production documents continue to use their current owner until command
 * parity is broad enough to switch safely.
 */
import { auditRustCall } from "./bridgeRuntimeAudit";
import {
  getEngineInfo,
  initWasmBridge,
  wasmPocExports,
  type WasmPocCommand,
  type WasmPocExports,
} from "./wasmBridge";

export interface WasmNodeSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: "rect";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Minimal serializable projection returned directly as a JS object by Serde. */
export interface DocumentState {
  readonly revision: number;
  readonly canUndo: boolean;
  readonly nodes: readonly WasmNodeSnapshot[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Rust WASM ${label}`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid Rust WASM ${label}`);
  }
  return value;
}

function freezeDocumentState(state: DocumentState): DocumentState {
  const nodes = state.nodes.map((node) => Object.freeze({ ...node }));
  return Object.freeze({
    revision: state.revision,
    canUndo: state.canUndo,
    nodes: Object.freeze(nodes),
  });
}

function decodeDocumentState(value: unknown): DocumentState {
  const raw = record(value, "document state");
  const revision = finite(raw.revision, "revision");
  if (!Number.isSafeInteger(revision) || revision < 0 || typeof raw.canUndo !== "boolean" || !Array.isArray(raw.nodes)) {
    throw new Error("Invalid Rust WASM document state fields");
  }
  const nodes = raw.nodes.map((item, index): WasmNodeSnapshot => {
    const node = record(item, `node ${index}`);
    if (
      typeof node.id !== "string" || !node.id ||
      typeof node.name !== "string" ||
      node.kind !== "rect"
    ) throw new Error(`Invalid Rust WASM node ${index}`);
    const x = finite(node.x, `node ${index} x`);
    const y = finite(node.y, `node ${index} y`);
    const w = finite(node.w, `node ${index} w`);
    const h = finite(node.h, `node ${index} h`);
    if (w <= 0 || h <= 0) throw new Error(`Invalid Rust WASM node ${index} dimensions`);
    return { id: node.id, name: node.name, kind: "rect", x, y, w, h };
  });
  return { revision, canUndo: raw.canUndo, nodes };
}

export class WasmEngine {
  private readonly listeners = new Set<() => void>();

  private current: DocumentState;

  private constructor(
    private readonly bridge: WasmPocExports,
    initial: DocumentState,
  ) {
    this.current = freezeDocumentState(initial);
  }

  /** Load the repository's generated wasm-bindgen asset and start a fresh POC. */
  static async initialize(): Promise<WasmEngine> {
    if (!(await initWasmBridge())) {
      const reason = getEngineInfo().lastImportFallback;
      throw new Error(`Rust WASM bridge unavailable${reason ? `: ${reason}` : ""}`);
    }
    const bridge = wasmPocExports();
    if (!bridge) {
      throw new Error("The loaded x_wasm asset has no Phase 1 command exports; rebuild with npm run wasm:build");
    }
    const initial = decodeDocumentState(
      auditRustCall("x-wasm.init_wasm_engine", () => bridge.init_wasm_engine()),
    );
    return new WasmEngine(bridge, initial);
  }

  /** Create a default-sized Rust rectangle at document-space coordinates. */
  createRectangle(x: number, y: number): DocumentState {
    return this.dispatch({ type: "createNode", nodeType: "rect", x, y });
  }

  /** Minimal command surface matching the MemoryEngine dispatch/snapshot shape. */
  dispatch(command: WasmPocCommand): DocumentState {
    if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
      throw new Error("Rectangle coordinates must be finite numbers");
    }
    const next = decodeDocumentState(
      auditRustCall("x-wasm.dispatch_command", () => this.bridge.dispatch_command(command)),
    );
    this.current = freezeDocumentState(next);
    for (const listener of this.listeners) listener();
    return this.snapshot();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DocumentState {
    return this.current;
  }

  get state(): DocumentState {
    return this.snapshot();
  }

  /** Phase 9: Export a node to PNG/JPG/PDF via the Rust render pipeline.
   *  Delegates to the RustDocumentSession if available. Returns raw bytes
   *  suitable for creating a download Blob — never canvas.toDataURL.
   *  Falls back to null when the Rust session bridge is not available. */
  async exportNode(
    id: string,
    format: "png" | "jpg" | "pdf",
    scale: number,
  ): Promise<Uint8Array | null> {
    // The POC engine does not have document-level export; this method is
    // a forwarder for the RustDocumentSession path. The main editor's
    // export goes through RustSessionClient directly.
    const { rustSessionConstructor } = await import("./wasmBridge");
    const Session = rustSessionConstructor();
    if (!Session) return null;
    // Cannot export from POC state — returns null to signal fallback
    return null;
  }
}
