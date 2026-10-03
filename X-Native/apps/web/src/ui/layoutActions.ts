/**
 * The four auto layout actions, from "Toggle on auto layout in designs"
 * in one place because every surface that offers
 * them has to agree:
 *
 * - the keyboard: `⇧A` add, `⌥⇧A` remove, `⌃⇧A` suggest
 * - the right sidebar: the `+` beside the Layout section, its `−`, the magic
 *   wand, and the flow buttons
 * - the context menu: Add auto layout / Remove auto layout, and
 *   More layout options ▸ Suggest auto layout, Remove all auto layout
 * - the Actions menu
 *
 * The article's two rules live here rather than in the engine, because both
 * need to say something to the person doing it:
 *
 * - "Auto layout is only supported on frames. If you have one or more layers
 *   selected, an auto layout frame wraps them." A frame gets
 *   the layout; a group is converted; anything else is wrapped.
 * - "Auto layout cannot be removed from component instances. You will need to
 *   detach the instance from the component to make these edits, or update the
 *   main component." Ours says so instead of doing nothing.
 */
import type { AutoLayout, BooleanOp, Engine, Snapshot, XNode } from "../engine/types";
import { find, findParent, insideInstance } from "../engine/memory";
import { defaultGrid, defaultLayout, suggestLayout } from "../engine/layout";
import { WasmEngine } from "../engine/WasmEngine";
import {
  wasmPocExports,
  type WasmOffsetJoin,
  type WasmUpdateNodePatch,
} from "../engine/wasmBridge";
import { toast } from "./toast";

export function isWasmManagedNodeKind(kind: unknown): boolean {
  return (
    kind === "rect" ||
    kind === "frame" ||
    kind === "text" ||
    kind === "ellipse" ||
    kind === "boolean" ||
    kind === "path" ||
    kind === "vector"
  );
}

export function extractWasmUpdateNodePatch(patch: Partial<XNode>): WasmUpdateNodePatch | null {
  const out: WasmUpdateNodePatch = {};
  let hasField = false;
  if (typeof patch.name === "string" && patch.name.trim()) {
    out.name = patch.name.trim();
    hasField = true;
  }
  if (patch.fillVisible === false) {
    out.fill = "none";
    hasField = true;
  } else if (typeof patch.fill === "string" && patch.fill) {
    out.fill = patch.fill;
    hasField = true;
  }
  if (patch.strokeVisible === false) {
    out.stroke = "none";
    hasField = true;
  } else if (typeof patch.strokePaint === "string" && patch.strokePaint) {
    out.stroke = patch.strokePaint;
    hasField = true;
  }
  if (typeof patch.strokeWidth === "number" && Number.isFinite(patch.strokeWidth)) {
    out.strokeWidth = Math.max(0, patch.strokeWidth);
    hasField = true;
  }
  if (typeof patch.opacity === "number" && Number.isFinite(patch.opacity)) {
    out.opacity = patch.opacity;
    hasField = true;
  }
  if (typeof patch.rotation === "number" && Number.isFinite(patch.rotation)) {
    out.rotation = patch.rotation;
    hasField = true;
  }
  if (
    Array.isArray(patch.cornerRadii) &&
    !patch.cornerIndependent &&
    typeof patch.cornerRadii[0] === "number" &&
    Number.isFinite(patch.cornerRadii[0])
  ) {
    out.radius = Math.max(0, patch.cornerRadii[0]);
    hasField = true;
  }
  if (typeof patch.text === "string") {
    out.text = patch.text;
    hasField = true;
  }
  return hasField ? out : null;
}

export function syncNodePatchToWasm(
  engine: Engine,
  id: string,
  patch: Partial<XNode>,
  onSync?: (state: import("../engine/WasmEngine").DocumentState) => void,
): void {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  const node = find(root, id);
  if (!node || !isWasmManagedNodeKind(node.kind)) return;
  const wasmPatch = extractWasmUpdateNodePatch(patch);
  if (!wasmPatch) return;
  void WasmEngine.getOrCreate()
    .then((wasm) => wasm.updateNode(id, wasmPatch))
    .then((wasmState) => {
      if (onSync) {
        onSync(wasmState);
      } else {
        engine.dispatch({
          type: "syncWasmState",
          state: wasmState,
        });
      }
    })
    .catch((error) => {
      if (wasmPocExports()) {
        console.warn("[X-Native] WASM updateNode fallback to MemoryEngine:", error);
      }
    });
}

export function dispatchOutlineStrokeWithWasmFallback(
  engine: Engine,
  id?: string,
  onSync?: (state: import("../engine/WasmEngine").DocumentState, outlinedId: string) => void,
): void {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  const targetId = id ?? (snap.selection.length === 1 ? snap.selection[0] : undefined);
  const node = targetId ? find(root, targetId) : null;
  if (
    node &&
    !node.locked &&
    node.kind !== "text" &&
    node.strokeWidth > 0 &&
    isWasmManagedNodeKind(node.kind)
  ) {
    void WasmEngine.getOrCreate()
      .then((wasm) => wasm.outlineStroke(node.id))
      .then((wasmState) => {
        if (onSync) {
          onSync(wasmState, node.id);
        } else {
          engine.dispatch({
            type: "syncWasmState",
            state: wasmState,
            selectId: node.id,
          });
        }
      })
      .catch((error) => {
        if (wasmPocExports()) {
          console.warn("[X-Native] WASM outlineStroke fallback to MemoryEngine:", error);
        }
        engine.dispatch({ type: "outlineStroke", ...(id ? { id } : {}) });
      });
    return;
  }
  engine.dispatch({ type: "outlineStroke", ...(id ? { id } : {}) });
}

export function dispatchOffsetPathWithWasmFallback(
  engine: Engine,
  distance: number,
  join: WasmOffsetJoin = "miter",
  id?: string,
  onSync?: (state: import("../engine/WasmEngine").DocumentState, offsetId: string) => void,
): void {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  const targetId = id ?? (snap.selection.length === 1 ? snap.selection[0] : undefined);
  const node = targetId ? find(root, targetId) : null;
  if (
    node &&
    !node.locked &&
    node.kind !== "text" &&
    node.kind !== "frame" &&
    isWasmManagedNodeKind(node.kind) &&
    Number.isFinite(distance) &&
    distance !== 0
  ) {
    void WasmEngine.getOrCreate()
      .then((wasm) => wasm.offsetPath(node.id, distance, join))
      .then((wasmState) => {
        if (onSync) {
          onSync(wasmState, node.id);
        } else {
          engine.dispatch({
            type: "syncWasmState",
            state: wasmState,
            selectId: node.id,
          });
        }
      })
      .catch((error) => {
        if (wasmPocExports()) {
          console.warn("[X-Native] WASM offsetPath fallback to MemoryEngine:", error);
        }
        engine.dispatch({ type: "offsetPath", ...(id ? { id } : {}), distance, join });
      });
    return;
  }
  engine.dispatch({ type: "offsetPath", ...(id ? { id } : {}), distance, join });
}

export function dispatchDuplicateWithWasmFallback(
  engine: Engine,
  dx = 16,
  dy = 16,
  onSync?: (state: import("../engine/WasmEngine").DocumentState) => void,
): void {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  const targetId = snap.selection.length === 1 ? snap.selection[0] : undefined;
  const node = targetId ? find(root, targetId) : null;
  if (node && !node.locked && isWasmManagedNodeKind(node.kind)) {
    void WasmEngine.getOrCreate()
      .then((wasm) => wasm.duplicateNode(node.id, dx, dy))
      .then((wasmState) => {
        if (onSync) {
          onSync(wasmState);
        } else {
          engine.dispatch({
            type: "syncWasmState",
            state: wasmState,
          });
        }
      })
      .catch((error) => {
        if (wasmPocExports()) {
          console.warn("[X-Native] WASM duplicateNode fallback to MemoryEngine:", error);
        }
        engine.dispatch({ type: "duplicate", dx, dy });
      });
    return;
  }
  engine.dispatch({ type: "duplicate", dx, dy });
}

export function dispatchUpdateVariableWithWasmFallback(
  engine: Engine,
  id: string,
  value: string | number | boolean,
  fallbackPatch: Partial<import("../engine/types").VariableItem>,
  options?: {
    collectionId?: string;
    modeId?: string;
    isDefaultMode?: boolean;
    onSync?: (state: import("../engine/WasmEngine").DocumentState) => void;
  },
): void {
  const strValue = String(value);
  void WasmEngine.getOrCreate()
    .then(async (wasm) => {
      if (options?.collectionId && options?.modeId && options.isDefaultMode === false) {
        const curMode = wasm.snapshot().activeModes?.[options.collectionId];
        if (curMode !== options.modeId) {
          await wasm.setVariableMode(options.collectionId, options.modeId);
        }
      }
      return wasm.updateVariable(id, strValue);
    })
    .then((wasmState) => {
      if (options?.onSync) {
        options.onSync(wasmState);
      } else {
        engine.dispatch({
          type: "syncWasmState",
          state: wasmState,
        });
      }
    })
    .catch((error) => {
      if (wasmPocExports()) {
        console.warn("[X-Native] WASM updateVariable fallback to MemoryEngine:", error);
      }
      engine.dispatch({
        type: "patchVariable",
        id,
        patch: fallbackPatch,
      });
    });
}

export function dispatchSetVariableModeWithWasmFallback(
  engine: Engine,
  collectionId: string,
  modeId: string,
  onSync?: (state: import("../engine/WasmEngine").DocumentState) => void,
): void {
  void WasmEngine.getOrCreate()
    .then((wasm) => wasm.setVariableMode(collectionId, modeId))
    .then((wasmState) => {
      if (onSync) {
        onSync(wasmState);
      } else {
        engine.dispatch({
          type: "syncWasmState",
          state: wasmState,
        });
      }
    })
    .catch((error) => {
      if (wasmPocExports()) {
        console.warn("[X-Native] WASM setVariableMode fallback to MemoryEngine:", error);
      }
      engine.dispatch({
        type: "setActiveMode",
        collectionId,
        modeId,
      });
    });
}

export function dispatchBindVariableWithWasmFallback(
  engine: Engine,
  id: string,
  prop: string,
  variableId: string,
): void {
  engine.dispatch({ type: "bindVariable", id, prop, variableId });
  if (prop === "fill") {
    const snap = engine.snapshot();
    const root = snap.pages[snap.page].root;
    const node = find(root, id);
    if (node && isWasmManagedNodeKind(node.kind)) {
      void WasmEngine.getOrCreate()
        .then((wasm) => wasm.updateNode(id, { fillVariable: variableId, fill: node.fill }))
        .catch((error) => {
          if (wasmPocExports()) {
            console.warn("[X-Native] WASM bindVariable sync warning:", error);
          }
        });
    }
  }
}

export function dispatchComponentPropertyWithWasmFallback(
  engine: Engine,
  instanceId: string,
  propName: string,
  value: string | boolean,
  onSync?: (state: import("../engine/WasmEngine").DocumentState) => void,
): void {
  void WasmEngine.getOrCreate()
    .then((wasm) => wasm.updateComponentProperty(instanceId, propName, String(value)))
    .then((wasmState) => {
      if (onSync) {
        onSync(wasmState);
      } else {
        engine.dispatch({
          type: "syncWasmState",
          state: wasmState,
        });
      }
    })
    .catch((error) => {
      if (wasmPocExports()) {
        console.warn("[X-Native] WASM updateComponentProperty fallback to MemoryEngine:", error);
      }
      engine.dispatch({
        type: "setComponentProperty",
        id: instanceId,
        propName,
        value,
      });
    });
}

export function dispatchUndoWithWasmFallback(engine: Engine): void {
  if (!wasmPocExports()) {
    engine.dispatch({ type: "undo" });
    return;
  }
  const prevRev = WasmEngine.getActive()?.snapshot().revision ?? 0;
  void WasmEngine.getOrCreate()
    .then((wasm) => wasm.undo())
    .then((wasmState) => {
      if (wasmState.revision !== prevRev) {
        engine.dispatch({
          type: "syncWasmState",
          state: wasmState,
          reconcileWasmNodes: true,
        });
      } else {
        engine.dispatch({ type: "undo" });
      }
    })
    .catch((error) => {
      console.warn("[X-Native] WASM undo fallback to MemoryEngine:", error);
      engine.dispatch({ type: "undo" });
    });
}

export function dispatchRedoWithWasmFallback(engine: Engine): void {
  if (!wasmPocExports()) {
    engine.dispatch({ type: "redo" });
    return;
  }
  const prevRev = WasmEngine.getActive()?.snapshot().revision ?? 0;
  void WasmEngine.getOrCreate()
    .then((wasm) => wasm.redo())
    .then((wasmState) => {
      if (wasmState.revision !== prevRev) {
        engine.dispatch({
          type: "syncWasmState",
          state: wasmState,
          reconcileWasmNodes: true,
        });
      } else {
        engine.dispatch({ type: "redo" });
      }
    })
    .catch((error) => {
      console.warn("[X-Native] WASM redo fallback to MemoryEngine:", error);
      engine.dispatch({ type: "redo" });
    });
}

export function dispatchAutoLayoutWithWasmFallback(
  engine: Engine,
  id: string,
  layout: AutoLayout,
  onSync?: (state: import("../engine/WasmEngine").DocumentState) => void,
): void {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  const node = find(root, id);
  if (
    node &&
    node.kind === "frame" &&
    isWasmManagedNodeKind(node.kind) &&
    (layout.direction === "horizontal" || layout.direction === "vertical")
  ) {
    const axis = layout.direction;
    const padding = Array.isArray(layout.padding) ? layout.padding[0] : 0;
    const gap = typeof layout.gap === "number" ? layout.gap : 0;
    void WasmEngine.getOrCreate()
      .then((wasm) => wasm.applyAutoLayout(id, axis, padding, gap))
      .then((wasmState) => {
        if (onSync) {
          onSync(wasmState);
        } else {
          engine.dispatch({
            type: "syncWasmState",
            state: wasmState,
            selectId: id,
          });
        }
      })
      .catch((error) => {
        if (wasmPocExports()) {
          console.warn("[X-Native] WASM applyAutoLayout fallback to MemoryEngine:", error);
        }
        engine.dispatch({ type: "autoLayout", id, layout });
      });
    return;
  }
  engine.dispatch({ type: "autoLayout", id, layout });
}

export function dispatchBooleanWithWasmFallback(
  engine: Engine,
  snap: Snapshot,
  op: BooleanOp,
  onSync?: (state: import("../engine/WasmEngine").DocumentState, deletedIds: string[]) => void,
): void {
  const root = snap.pages[snap.page].root;
  const targetIds = snap.selection.filter((id) => {
    const n = find(root, id);
    return !!n && !n.locked && isWasmManagedNodeKind(n.kind);
  });
  if (targetIds.length >= 2 && targetIds.length === snap.selection.length) {
    void WasmEngine.getOrCreate()
      .then((wasm) => wasm.booleanOperation(targetIds, op))
      .then((wasmState) => {
        if (onSync) {
          onSync(wasmState, targetIds);
        } else {
          engine.dispatch({
            type: "syncWasmState",
            state: wasmState,
            deletedIds: targetIds,
            reconcileWasmNodes: true,
          });
        }
      })
      .catch((error) => {
        if (wasmPocExports()) {
          console.warn("[X-Native] WASM booleanOperation fallback to MemoryEngine:", error);
        }
        engine.dispatch({ type: "boolean", op });
      });
    return;
  }
  engine.dispatch({ type: "boolean", op });
}

/** Layout can live on these directly; everything else has to be wrapped. */
function takesLayoutDirectly(kind: string) {
  return kind === "frame" || kind === "component" || kind === "instance";
}

/** The nodes to act on: one named layer, or the whole selection. */
function targets(snap: Snapshot, only?: string) {
  const root = snap.pages[snap.page].root;
  const ids = only ? [only] : snap.selection;
  return ids.map((id) => find(root, id)).filter((n): n is NonNullable<typeof n> => !!n && !n.locked);
}

/**
 * `⇧A`, the panel's `+`, and the context menu's Add auto layout.
 *
 * A frame (or component, or instance) is given the layout directly. A group is
 * converted to a frame. A plain layer, or several layers, gets a new frame
 * around them - the article's note.
 */
export function addAutoLayout(engine: Engine, snap: Snapshot, only?: string): void {
  const nodes = targets(snap, only);
  if (!nodes.length) return;
  if (nodes.length === 1 && takesLayoutDirectly(nodes[0].kind)) {
    // Instance layout belongs to the main component: refused here, with the
    // article's own way out (detach, or edit the master).
    if (insideInstance(snap.pages[snap.page].root, nodes[0].id)) {
      toast("Auto layout can't be added to an instance · detach it, or edit the main component");
      return;
    }
    dispatchAutoLayoutWithWasmFallback(engine, nodes[0].id, defaultLayout());
    return;
  }
  if (nodes.length === 1 && nodes[0].layout) {
    // Already laid out: nothing to wrap, and re-adding would only reset the
    // values the user set.
    engine.dispatch({ type: "select", ids: [nodes[0].id] });
    return;
  }
  engine.dispatch({ type: "wrapAutoLayout", ids: nodes.map((n) => n.id), layout: defaultLayout() });
}

/** `⌃⇧A`, the wand in the panel, and More layout options ▸ Suggest. */
export function suggestAutoLayout(engine: Engine, snap: Snapshot, only?: string): void {
  const nodes = targets(snap, only);
  if (!nodes.length) return;
  if (nodes.length === 1 && takesLayoutDirectly(nodes[0].kind)) {
    dispatchAutoLayoutWithWasmFallback(engine, nodes[0].id, suggestLayout(nodes[0]));
    return;
  }
  engine.dispatch({ type: "wrapAutoLayout", ids: nodes.map((n) => n.id), layout: suggestLayout(nodes[0]) });
}

/**
 * `⌥⇧A`, the panel's `−`, and Remove auto layout.
 *
 * Selecting a frame removes its layout. Selecting its children removes the
 * parent's - which is the only thing those children could be laid out by, and
 * saves a step of selecting the frame first.
 *
 * @returns whether anything was removed, so a caller can decide about a toast.
 */
export function removeAutoLayout(engine: Engine, snap: Snapshot, only?: string): boolean {
  const root = snap.pages[snap.page].root;
  const nodes = targets(snap, only);
  if (!nodes.length) return false;
  // Instances are the one refusal the article names.
  for (const n of nodes) {
    if (n.layout && insideInstance(root, n.id)) {
      toast("Auto layout can't be removed from an instance · detach it, or edit the main component");
      return false;
    }
  }
  // A frame removes its own layout; a child asks its parent's to go, since that
  // is the layout the child is being positioned by.
  const frames = new Map<string, string>();
  for (const n of nodes) {
    if (n.layout) frames.set(n.id, n.id);
    else {
      const p = findParent(root, n.id);
      if (p && p.layout) frames.set(p.id, p.id);
    }
  }
  if (!frames.size) return false;
  engine.dispatch({ type: "begin" });
  for (const id of frames.keys()) engine.dispatch({ type: "autoLayout", id, layout: null });
  engine.dispatch({ type: "end" });
  return true;
}

/** More layout options ▸ Remove all auto layout: the frame and everything in it. */
export function removeAllAutoLayout(engine: Engine, snap: Snapshot, only?: string): boolean {
  const root = snap.pages[snap.page].root;
  const n = only ? find(root, only) : find(root, snap.selection[0] ?? "");
  if (!n) return false;
  if (insideInstance(root, n.id)) {
    toast("Auto layout can't be removed from an instance · detach it, or edit the main component");
    return false;
  }
  engine.dispatch({ type: "removeAllLayout", id: n.id });
  return true;
}

/**
 * One of the three flows, from the Layout section's buttons or the grid picker.
 *
 * On a layer that cannot hold a layout this is the article's "create an auto
 * layout frame around them", with the flow that was just chosen; on a frame it
 * switches the flow and keeps the values that still apply.
 */
export function setFlow(
  engine: Engine,
  snap: Snapshot,
  id: string,
  direction: "vertical" | "horizontal" | "grid",
): void {
  const root = snap.pages[snap.page].root;
  const n = find(root, id);
  if (!n) return;
  const current = n.layout;
  const layout =
    direction === "grid"
      ? current?.direction === "grid"
        ? { ...current, direction: "horizontal" as const, wrap: false }
        : { ...defaultGrid(), padding: current?.padding ?? defaultGrid().padding }
      : { ...(current && current.direction !== "grid" ? current : defaultLayout()), direction, wrap: false };
  if (takesLayoutDirectly(n.kind)) dispatchAutoLayoutWithWasmFallback(engine, id, layout);
  else engine.dispatch({ type: "wrapAutoLayout", ids: [id], layout });
}
