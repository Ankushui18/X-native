import type { Engine, XNode } from "../engine/types";
import { find } from "../engine/memory";
import { hasExtraNetworkGeometry } from "../engine/geometry";
import { toast } from "./toast";

export const NETWORK_EDIT_LIMIT = "This operation only supports a single path. It is unavailable for branched or compound networks to avoid losing geometry.";

export function topologyEditBlocked(n: XNode | null | undefined): boolean {
  return hasExtraNetworkGeometry(n?.vectorNetwork);
}

/** The engine refuses lossy path rewrites independently. UI callers explain
 * that refusal instead of claiming that an unsupported operation succeeded. */
export function allowTopologyEdit(engine: Engine, id?: string): boolean {
  const snap = engine.snapshot(), root = snap.pages[snap.page].root;
  const ids = id ? [id] : snap.vecEdit ? [snap.vecEdit] : snap.selection;
  if (ids.some((key) => topologyEditBlocked(find(root, key)))) {
    toast(NETWORK_EDIT_LIMIT);
    return false;
  }
  return true;
}
