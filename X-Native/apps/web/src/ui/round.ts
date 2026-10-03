import type { Engine } from "../engine/types";
import { find } from "../engine/memory";
import { plural, toast } from "./toast";

/**
 * "Round to Pixel": snap the selection's own box to whole pixels
 * without switching on document-wide pixel fitting. Exposes it in the
 * Inspector header and on ⇧⌘P; both paths call this.
 */
export function roundToPixel(engine: Engine) {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  let n = 0;
  for (const id of snap.selection) {
    const node = find(root, id);
    if (!node) continue;
    n++;
    engine.dispatch({
      type: "patch",
      id,
      patch: {
        x: Math.round(node.x),
        y: Math.round(node.y),
        w: Math.max(1, Math.round(node.w)),
        h: Math.max(1, Math.round(node.h)),
      },
    });
  }
  toast(n ? `Rounded ${plural(n, "layer")} to whole pixels` : "Select a layer to round");
  return n;
}
