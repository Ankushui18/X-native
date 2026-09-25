/**
 * Pure prototype helpers: condition gating and trigger collection.
 *
 * Kept out of the Canvas runner so the semantics are headless-testable
 * (and reusable by any future runner, e.g. export-to-code playback).
 */
import type {
  Interaction,
  InteractionCondition,
  ProtoTrigger,
  VariableCollection,
  VariableItem,
  XNode,
} from "./types";
import { resolveVariable } from "./variables";

/**
 * Evaluate an interaction's condition against variables resolved under the
 * active modes. A broken/missing variable fails closed (false), except
 * `falsy`, which a missing value trivially satisfies.
 */
export function checkCondition(
  vars: VariableItem[],
  collections: VariableCollection[],
  activeModes: Record<string, string>,
  cond: InteractionCondition,
): boolean {
  const r = resolveVariable(vars, collections, activeModes, cond.variableId);
  if (!r || r.broken) return cond.op === "falsy";
  const v = r.value;
  switch (cond.op) {
    case "truthy":
      return v !== false && v !== 0 && v !== "" && v !== "#00000000";
    case "falsy":
      return v === false || v === 0 || v === "" || v === "#00000000";
    case "eq":
      // eslint-disable-next-line eqeqeq
      return v == cond.value;
    case "neq":
      // eslint-disable-next-line eqeqeq
      return v != cond.value;
    case "gt":
      return typeof v === "number" && typeof cond.value === "number" && v > cond.value;
    case "gte":
      return typeof v === "number" && typeof cond.value === "number" && v >= cond.value;
    case "lt":
      return typeof v === "number" && typeof cond.value === "number" && v < cond.value;
    case "lte":
      return typeof v === "number" && typeof cond.value === "number" && v <= cond.value;
  }
}

function findIn(root: XNode, id: string): XNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findIn(c, id);
    if (hit) return hit;
  }
  return null;
}

function parentIn(root: XNode, id: string): XNode | null {
  for (const c of root.children) {
    if (c.id === id) return root;
    const hit = parentIn(c, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Collect a trigger's interactions by bubbling from `startId` toward `root`:
 * the innermost node carrying at least one match wins, and ALL of its
 * matches run (in author order). Returns null when nothing matches.
 *
 * Multiple actions per trigger live here: the runner executes every entry
 * of the returned list instead of stopping at the first.
 */
export function triggerInteractions(
  root: XNode,
  startId: string,
  trigger: ProtoTrigger,
): { nodeId: string; list: Interaction[] } | null {
  let n: XNode | null = findIn(root, startId);
  while (n) {
    const list = (n.interactions ?? []).filter((i) => i.trigger === trigger);
    if (list.length) return { nodeId: n.id, list };
    n = n === root ? null : parentIn(root, n.id);
  }
  return null;
}
