/**
 * Headless checks for §26 (keyboard behavior): the engine surface behind the
 * new chords — one-way stroke/fill removal (`/` and `⌥/`), node-level italic
 * (⌘I) through patch and SVG export, the relabelled mask/outline menu rows
 * (⌃⌘M / ⇧⌘O), clamped page flips (PgUp/PgDn), and opacity patching (digits).
 *
 * The chords themselves live in `bindHotkeys` (DOM capture phase) and the
 * menu/layers roving in React handlers, so they are verified by code tracing
 * against Figma's documented chords; see the §26 ledger. This file pins the
 * dispatch-level behavior those handlers rely on.
 *
 * Run with:  npx vite-node src/engine/__tests__/keyboard26.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import { svgNode } from "../svgExport.ts";
import { canvasMenu, layerMenu } from "../../ui/ContextMenu.tsx";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

const addRect = (e, over = {}) => {
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100, ...over });
  return e.snapshot().selection[0];
};
const at = (e, id) => find(e.snapshot().pages[e.snapshot().page].root, id);
const flat = (items) => {
  const out = new Map();
  for (const it of items) {
    if (it.kind === "action") { if (!out.has(it.id)) out.set(it.id, it); }
    else if (it.kind === "sub") for (const s of it.items) { if (s.kind === "action" && !out.has(s.id)) out.set(s.id, s); }
  }
  return out;
};

console.log("KB-004 removeStroke / removeFill:");
{
  const e = new MemoryEngine(false);
  const id = addRect(e);
  e.dispatch({ type: "patch", id, patch: { strokeVisible: true, strokePaint: "#ff0000", strokeWidth: 2 } });
  e.dispatch({ type: "removeStroke" });
  const n = at(e, id);
  t("removeStroke hides the stroke", n.strokeVisible === false);
  t("removeStroke keeps the paint underneath", n.strokePaint === "#ff0000");
  e.dispatch({ type: "undo" });
  t("removeStroke undoes", at(e, id).strokeVisible === true);
}
{
  const e = new MemoryEngine(false);
  const id = addRect(e);
  e.dispatch({ type: "removeFill" });
  const n = at(e, id);
  t("removeFill hides the fill", n.fillVisible === false);
  t("removeFill keeps the fill color", typeof n.fill === "string" && n.fill.length > 0);
  e.dispatch({ type: "undo" });
  t("removeFill undoes", at(e, id).fillVisible === true);
}
{
  const e = new MemoryEngine(false);
  const id = addRect(e);
  e.dispatch({ type: "patch", id, patch: { locked: true, strokeVisible: true } });
  e.dispatch({ type: "removeStroke" });
  e.dispatch({ type: "removeFill" });
  const n = at(e, id);
  t("removals skip locked layers", n.strokeVisible === true && n.fillVisible === true);
}
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "removeStroke" });
  e.dispatch({ type: "removeFill" });
  t("removals with no selection are harmless", e.snapshot().selection.length === 0);
}

console.log("KB-002 italic:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 200, h: 100, text: "Hi" });
  const id = e.snapshot().selection[0];
  t("fresh text has no italic flag (= normal)", at(e, id).fontStyle === undefined);
  // The ⌘I handler loop, verbatim in dispatch terms: toggle per text node.
  const toggle = () => {
    const root = e.snapshot().pages[e.snapshot().page].root;
    for (const sid of e.snapshot().selection) {
      const n = find(root, sid);
      if (n && n.kind === "text")
        e.dispatch({ type: "patch", id: sid, patch: { fontStyle: n.fontStyle === "italic" ? "normal" : "italic" } });
    }
  };
  toggle();
  t("first toggle italicises", at(e, id).fontStyle === "italic");
  e.dispatch({ type: "select", ids: [id] }); // break the patch burst (§25)
  toggle();
  t("second toggle returns to normal", at(e, id).fontStyle === "normal");
  e.dispatch({ type: "undo" });
  t("italic toggle undoes", at(e, id).fontStyle === "italic");
}
{
  const snode = (over = {}) => ({
    id: "t1", visible: true, x: 0, y: 0, w: 200, h: 100, rotation: 0, opacity: 1,
    fill: "#111111", fillVisible: true, fillType: "solid", fillOpacity: 1,
    strokeVisible: false, strokeWidth: 0, strokePaint: "", strokeOpacity: 1,
    kind: "text", text: "Abc", fontFamily: "Inter", fontSize: 16, fontWeight: 400,
    lineHeight: 20, letterSpacing: 0, textAlign: "left", textAlignVertical: "top",
    textDecoration: "none", textCase: "none", truncate: false, maxLines: 1,
    sizingW: "fixed", sizingH: "fixed",
    cornerRadii: [0, 0, 0, 0], overflow: "visible",
    children: [], path: [], closed: false, effects: [], ...over,
  });
  t("italic exports font-style", svgNode(snode({ fontStyle: "italic" })).includes('font-style="italic"'));
  t("upright exports no font-style", !svgNode(snode({})).includes("font-style"));
}

console.log("KB-005/KB-016 menu labels:");
{
  const sel = flat(canvasMenu(1, false, false));
  const layers = flat(layerMenu(false));
  t("canvas-menu mask labelled ⌃⌘M", sel.get("useAsMask")?.shortcut === "⌃⌘M");
  t("layers-panel mask labelled ⌃⌘M", layers.get("useAsMask")?.shortcut === "⌃⌘M");
  t("outline stroke labelled ⇧⌘O", sel.get("outlineStroke")?.shortcut === "⇧⌘O");
}

console.log("KB-010 page flips clamp:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "setPage", index: -1 });
  const lo = e.snapshot().page === 0;
  e.dispatch({ type: "setPage", index: 999 });
  const hi = e.snapshot().page === e.snapshot().pages.length - 1;
  t("PgUp on the first page stays", lo);
  t("PgDn on the last page stays", hi);
}

console.log("KB-014 opacity patch:");
{
  const e = new MemoryEngine(false);
  const a = addRect(e);
  e.dispatch({ type: "select", ids: [a] });
  e.dispatch({ type: "patch", id: a, patch: { opacity: 0.25 } });
  t("digit value patches opacity", at(e, a).opacity === 0.25);
  e.dispatch({ type: "undo" });
  t("opacity patch undoes", at(e, a).opacity === 1);
}
