/**
 * X-Native Canonical Command/Transaction System (Phase 0 Foundation)
 *
 * All document mutations flow through explicit, atomic Transactions composed
 * of reversible Operations. This guarantees:
 * 1. Deterministic local Undo/Redo by inverting operations.
 * 2. Immutable transaction log stream for future Phase 6 CRDT sync.
 * 3. Atomic multi-property or multi-node mutations with rollback on failure.
 * 4. Extensibility for Plugin API and automation scripting.
 */

import type { XNode, VectorNetwork } from "./types";
import type { Modifier } from "./modifierStack";

export type TransactionId = string;

export interface BaseOperation {
  type: string;
}

export interface SetPropertyOp extends BaseOperation {
  type: "setProperty";
  targetId: string;
  property: string;
  oldValue: any;
  newValue: any;
}

export interface InsertNodeOp extends BaseOperation {
  type: "insertNode";
  parentId: string;
  node: XNode;
  index?: number;
}

export interface RemoveNodeOp extends BaseOperation {
  type: "removeNode";
  parentId: string;
  nodeId: string;
  previousIndex: number;
  previousNode: XNode;
}

export interface MoveNodeOp extends BaseOperation {
  type: "moveNode";
  nodeId: string;
  oldParentId: string;
  newParentId: string;
  oldIndex: number;
  newIndex: number;
}

export interface SetVariableOp extends BaseOperation {
  type: "setVariable";
  variableId: string;
  oldValue: any;
  newValue: any;
}

export interface SetVectorNetworkOp extends BaseOperation {
  type: "setVectorNetwork";
  targetId: string;
  oldNetwork?: VectorNetwork;
  newNetwork: VectorNetwork;
}

export interface ApplyModifierOp extends BaseOperation {
  type: "applyModifier";
  targetId: string;
  modifier: Modifier;
  index?: number;
}

export interface RemoveModifierOp extends BaseOperation {
  type: "removeModifier";
  targetId: string;
  index: number;
  previousModifier: Modifier;
}

export interface SetExpressionOp extends BaseOperation {
  type: "setExpression";
  targetId: string;
  property: string;
  oldExpr?: string;
  newExpr: string;
}

export type Operation =
  | SetPropertyOp
  | InsertNodeOp
  | RemoveNodeOp
  | MoveNodeOp
  | SetVariableOp
  | SetVectorNetworkOp
  | ApplyModifierOp
  | RemoveModifierOp
  | SetExpressionOp;

export interface TransactionMetadata {
  label?: string;
  authorId?: string;
  origin?: "user" | "script" | "plugin" | "history" | "sync";
}

export interface Transaction {
  id: TransactionId;
  timestamp: number;
  operations: Operation[];
  metadata?: TransactionMetadata;
}

/**
 * Creates a unique transaction id with high-resolution timestamp.
 */
let txCounter = 0;
export function createTransactionId(): TransactionId {
  txCounter += 1;
  return `tx_${Date.now()}_${txCounter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Computes the exact mathematical inverse of an Operation.
 */
export function invertOperation(op: Operation): Operation {
  switch (op.type) {
    case "setProperty":
      return {
        type: "setProperty",
        targetId: op.targetId,
        property: op.property,
        oldValue: op.newValue,
        newValue: op.oldValue,
      };

    case "insertNode":
      return {
        type: "removeNode",
        parentId: op.parentId,
        nodeId: op.node.id,
        previousIndex: op.index ?? 0,
        previousNode: JSON.parse(JSON.stringify(op.node)),
      };

    case "removeNode":
      return {
        type: "insertNode",
        parentId: op.parentId,
        node: JSON.parse(JSON.stringify(op.previousNode)),
        index: op.previousIndex,
      };

    case "moveNode":
      return {
        type: "moveNode",
        nodeId: op.nodeId,
        oldParentId: op.newParentId,
        newParentId: op.oldParentId,
        oldIndex: op.newIndex,
        newIndex: op.oldIndex,
      };

    case "setVariable":
      return {
        type: "setVariable",
        variableId: op.variableId,
        oldValue: op.newValue,
        newValue: op.oldValue,
      };

    case "setVectorNetwork":
      return {
        type: "setVectorNetwork",
        targetId: op.targetId,
        oldNetwork: JSON.parse(JSON.stringify(op.newNetwork)),
        newNetwork: op.oldNetwork ? JSON.parse(JSON.stringify(op.oldNetwork)) : { vertices: [], segments: [] },
      };

    case "applyModifier":
      return {
        type: "removeModifier",
        targetId: op.targetId,
        index: op.index ?? 0,
        previousModifier: JSON.parse(JSON.stringify(op.modifier)),
      };

    case "removeModifier":
      return {
        type: "applyModifier",
        targetId: op.targetId,
        modifier: JSON.parse(JSON.stringify(op.previousModifier)),
        index: op.index,
      };

    case "setExpression":
      return {
        type: "setExpression",
        targetId: op.targetId,
        property: op.property,
        oldExpr: op.newExpr,
        newExpr: op.oldExpr ?? "",
      };

    default:
      throw new Error(`Cannot invert unknown operation type: ${(op as any).type}`);
  }
}

/**
 * Computes the exact mathematical inverse of a Transaction.
 * Inverting a transaction reverses the operations and inverts each one.
 */
export function invertTransaction(tx: Transaction): Transaction {
  const invertedOps: Operation[] = [];
  for (let i = tx.operations.length - 1; i >= 0; i--) {
    invertedOps.push(invertOperation(tx.operations[i]));
  }
  return {
    id: createTransactionId(),
    timestamp: Date.now(),
    operations: invertedOps,
    metadata: {
      ...tx.metadata,
      label: tx.metadata?.label ? `Undo: ${tx.metadata.label}` : "Inverted Transaction",
      origin: "history",
    },
  };
}

/**
 * TransactionStream manages undo/redo history and provides delta streaming
 * to subscribers (such as future CRDT engines or plugin loggers).
 */
export class TransactionStream {
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  private subscribers: Set<(tx: Transaction) => void> = new Set();
  private maxHistory: number;

  constructor(maxHistory: number = 200) {
    this.maxHistory = maxHistory;
  }

  /**
   * Records and emits an executed transaction into the stream.
   * Clears redo stack unless originated from history.
   */
  public push(tx: Transaction): void {
    if (tx.operations.length === 0) return;

    if (tx.metadata?.origin !== "history") {
      this.redoStack.length = 0;
      this.undoStack.push(tx);
      if (this.undoStack.length > this.maxHistory) {
        this.undoStack.shift();
      }
    }

    // Broadcast to delta stream subscribers
    for (const sub of this.subscribers) {
      try {
        sub(tx);
      } catch (err) {
        console.error("Error in transaction subscriber:", err);
      }
    }
  }

  /**
   * Prepares undo: pops the last transaction and returns its inverted counterpart.
   */
  public popUndo(): Transaction | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    const inv = invertTransaction(tx);
    this.redoStack.push(tx);
    return inv;
  }

  /**
   * Prepares redo: pops the last redo transaction and returns it for re-application.
   */
  public popRedo(): Transaction | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    this.undoStack.push(tx);
    return tx;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public subscribe(callback: (tx: Transaction) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  public clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  public getHistory(): { undoCount: number; redoCount: number } {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
    };
  }
}
