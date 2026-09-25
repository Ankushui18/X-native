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
import type { Engine, Snapshot } from "../engine/types";
import { find, findParent, insideInstance } from "../engine/memory";
import { defaultGrid, defaultLayout, suggestLayout } from "../engine/layout";
import { toast } from "./toast";

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
    // An instance's layout belongs to its main component; `publishMaster` in the
    // engine carries the change there, which is the article's "or update the
    // main component".
    engine.dispatch({ type: "autoLayout", id: nodes[0].id, layout: defaultLayout() });
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
    engine.dispatch({ type: "autoLayout", id: nodes[0].id, layout: suggestLayout(nodes[0]) });
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
  if (takesLayoutDirectly(n.kind)) engine.dispatch({ type: "autoLayout", id, layout });
  else engine.dispatch({ type: "wrapAutoLayout", ids: [id], layout });
}
