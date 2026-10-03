/**
 * Plugin & Extensibility Architecture (Phase 0 Foundation)
 *
 * Provides a formal sandboxed boundary between third-party extensions
 * and the core X-Native document engine. Plugins interact with the document
 * exclusively through transactions (`mutate`) and read-only snapshots (`readDocument`).
 */

import type { Transaction } from "./transaction";
import type { Snapshot } from "./types";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions: Array<"read_document" | "mutate_document" | "network" | "ui">;
}

export interface PluginError {
  code: "PERMISSION_DENIED" | "INVALID_TRANSACTION" | "EXECUTION_ERROR" | "TIMEOUT";
  message: string;
  details?: any;
}

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface PluginUIComponent {
  id: string;
  title: string;
  render: (container: HTMLElement) => () => void; // returns cleanup fn
}

export interface PluginAPI {
  /**
   * Reads an immutable snapshot of the current document state.
   * Requires 'read_document' permission.
   */
  readDocument(): Readonly<Snapshot>;

  /**
   * Applies an atomic transaction to the document.
   * Requires 'mutate_document' permission.
   */
  mutate(transaction: Transaction): Result<void, PluginError>;

  /**
   * Registers a custom panel, toolbar item, or modal UI.
   * Requires 'ui' permission.
   */
  registerUI(component: PluginUIComponent): Result<void, PluginError>;

  /**
   * Subscribes to engine events (selection change, transaction commit, tool switch).
   */
  on(event: "selection" | "transaction" | "tool", callback: (data: any) => void): () => void;
}

export interface PluginHostContext {
  getSnapshot: () => Snapshot;
  dispatchTransaction: (tx: Transaction) => void;
  eventBus: {
    on: (event: string, cb: (data: any) => void) => () => void;
    emit: (event: string, data: any) => void;
  };
}

/**
 * Creates a sandboxed PluginAPI instance bound to a specific plugin manifest.
 */
export function createPluginAPI(
  manifest: PluginManifest,
  host: PluginHostContext,
): PluginAPI {
  const registeredUI: PluginUIComponent[] = [];

  return {
    readDocument(): Readonly<Snapshot> {
      if (!manifest.permissions.includes("read_document")) {
        throw new Error(`Plugin '${manifest.id}' lacks 'read_document' permission`);
      }
      return Object.freeze(JSON.parse(JSON.stringify(host.getSnapshot())));
    },

    mutate(transaction: Transaction): Result<void, PluginError> {
      if (!manifest.permissions.includes("mutate_document")) {
        return {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: `Plugin '${manifest.id}' does not have 'mutate_document' permission`,
          },
        };
      }

      if (!transaction || !Array.isArray(transaction.operations) || transaction.operations.length === 0) {
        return {
          ok: false,
          error: {
            code: "INVALID_TRANSACTION",
            message: "Transaction must contain at least one operation",
          },
        };
      }

      try {
        // Tag transaction metadata with plugin origin
        transaction.metadata = {
          ...transaction.metadata,
          authorId: manifest.id,
          origin: "plugin",
        };
        host.dispatchTransaction(transaction);
        return { ok: true, value: undefined };
      } catch (err: any) {
        return {
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: err.message || "Failed to execute transaction",
          },
        };
      }
    },

    registerUI(component: PluginUIComponent): Result<void, PluginError> {
      if (!manifest.permissions.includes("ui")) {
        return {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: `Plugin '${manifest.id}' does not have 'ui' permission`,
          },
        };
      }
      registeredUI.push(component);
      return { ok: true, value: undefined };
    },

    on(event: "selection" | "transaction" | "tool", callback: (data: any) => void): () => void {
      return host.eventBus.on(event, callback);
    },
  };
}
