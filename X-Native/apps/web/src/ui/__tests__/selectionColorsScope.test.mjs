/**
 * F01/F10 — Selection colors must edit only the selection, and listing,
 * matching and editing must agree on gradient stops, masks and boolean
 * members. Audit: X_NATIVE_AUDIT_2026-10-02 (mixed-selection color rules).
 */
import { MemoryEngine } from "../../engine/memory.ts";
import { colorUsageAll, recolorMatches, setOpacityMatches, matchingIds } from "../selectionColors.ts";

let passed = 0, failed = 0;
const t = (name, cond) => { if (cond) { passed++; } else { failed++; console.error("FAIL:", name); } };

function buildDoc(specs) {
  const engine = new MemoryEngine(false);
  for (const s of specs) {
    const { id, children, ...extra } = s;
    engine.dispatch({ type: "add", kind: extra.kind ?? "rectangle", x: extra.x ?? 0, y: extra.y ?? 0,
      w: extra.w ?? 100, h: extra.h ?? 100, extra: { id, ...extra, ...(children ? { children } : {}) } });
  }
  return engine;
}

const usageOf = (engine, ids, bucket, hex) => {
  const snap = engine.snapshot();
  const root = snap.pages[snap.page].root;
  const find = (n) => { if (ids.includes(n.id)) return n; for (const c of n.children) { const r = find(c); if (r) return r; } return null; };
  const nodes = ids.map((id) => find(root)).filter(Boolean);
  const usage = colorUsageAll(nodes).find((u) => u.bucket === bucket && u.hex === hex);
  return { engine, snap, root, usage };
};

// ---- F01: recolor touches the selection only, never an unselected twin ----
{
  const { engine, root, usage } = usageOf(buildDoc([
    { id: "a", fill: "#ff0000" },
    { id: "b", fill: "#0000ff" },
    { id: "c", fill: "#ff0000" }, // same red, NOT selected
  ]), ["a", "b"], "Fill", "#ff0000");
  t("row exists for the selected red", !!usage);
  t("row carries only the selected layer's id", usage.ids.join() === "a");
  const touched = recolorMatches(engine, root, usage, "#00ff00");
  t("recolor touched exactly 1 layer", touched === 1);
  const snap2 = engine.snapshot();
  const root2 = snap2.pages[snap2.page].root;
  const get = (id) => { const f = (n) => n.id === id ? n : n.children.reduce((r, ch) => r ?? f(ch), null); return f(root2); };
  t("selected A became green", get("a").fill === "#00ff00");
  t("unselected C stayed red", get("c").fill === "#ff0000");
  engine.dispatch({ type: "undo" });
  const snap3 = engine.snapshot();
  const root3 = snap3.pages[snap3.page].root;
  const get3 = (id) => { const f = (n) => n.id === id ? n : n.children.reduce((r, ch) => r ?? f(ch), null); return f(root3); };
  t("one undo restores the edit", get3("a").fill === "#ff0000");
}

// ---- page-wide matching still available for the explicit select-all action ----
{
  const { root, usage } = usageOf(buildDoc([
    { id: "a", fill: "#ff0000" },
    { id: "c", fill: "#ff0000" },
  ]), ["a"], "Fill", "#ff0000");
  const all = matchingIds(root, usage);
  t("matchingIds still finds every page user (select-all)", all.includes("a") && all.includes("c"));
}

// ---- F10: gradient stop rows are editable at the stop ----
{
  const { engine, root, usage } = usageOf(buildDoc([
    { id: "g", fillType: "linear", fill: "#ff0000",
      gradientStops: [{ position: 0, color: "#ff0000" }, { position: 1, color: "#0000ff" }] },
    { id: "plain", fill: "#0000ff" },
  ]), ["g"], "Fill", "#0000ff");
  t("blue stop row lists the gradient", !!usage && usage.ids.join() === "g");
  const touched = recolorMatches(engine, root, usage, "#00ff00");
  t("stop recolor touched the gradient layer", touched === 1);
  const snap2 = engine.snapshot();
  const gg = JSON.parse(JSON.stringify(snap2.pages[snap2.page].root));
  const findG = (n) => n.id === "g" ? n : n.children.reduce((r, ch) => r ?? findG(ch), null);
  const node = findG(gg);
  t("the listed stop changed", node.gradientStops[1].color === "#00ff00");
  t("the other stop kept its colour", node.gradientStops[0].color === "#ff0000");
  t("stop positions did not move", node.gradientStops[1].position === 1);
}

// ---- F10: mask paints excluded; boolean member paints excluded ----
{
  const { root, usage } = usageOf(buildDoc([{ id: "m", fill: "#ff0000", isMask: true }]), ["m"], "Fill", "#ff0000");
  t("mask paint produces no row", !usage);
}
{
  // Build the union with the real command, then give it a group paint.
  const e = buildDoc([{ id: "op1", fill: "#0000ff" }, { id: "op2", fill: "#ff0000" }]);
  e.dispatch({ type: "select", ids: ["op1", "op2"] });
  e.dispatch({ type: "boolean", op: "union" });
  const snapB = e.snapshot();
  const rootB = snapB.pages[snapB.page].root;
  const findB = (id) => { const f = (n) => n.id === id ? n : n.children.reduce((r, ch) => r ?? f(ch), null); return f(rootB); };
  const gid = rootB.children.find((n) => n.booleanOp === "union").id;
  e.dispatch({ type: "patch", id: gid, patch: { fill: "#0000ff" } });
  const root = e.snapshot().pages[e.snapshot().page].root;
  const boolNode = findB(gid) ?? (() => { const f = (n) => n.id === gid ? n : n.children.reduce((r, ch) => r ?? f(ch), null); return f(root); })();
  const blue = colorUsageAll([boolNode]).find((u) => u.hex === "#0000ff");
  const engine = e;
  const usages = colorUsageAll([boolNode]);
  t("boolean lists group blue once", usages.filter((u) => u.hex === "#0000ff").length === 1 &&
    usages.find((u) => u.hex === "#0000ff").count === 1);
  t("unused member red is not listed", !usages.some((u) => u.hex === "#ff0000"));
  t("row exists for the group colour", !!blue);
  const touched = recolorMatches(engine, root, blue, "#00ff00");
  t("boolean group itself recolored", touched === 1);
}

// ---- opacity field agrees with the listed sites ----
{
  const { engine, root, usage } = usageOf(buildDoc([
    { id: "s1", fill: "#ff0000" },
    { id: "s2", fill: "#ff0000" },
  ]), ["s1", "s2"], "Fill", "#ff0000");
  const touched = setOpacityMatches(engine, root, usage, 50);
  t("opacity edited both selected layers", touched === 2);
  const snap2 = engine.snapshot();
  const gg = JSON.parse(JSON.stringify(snap2.pages[snap2.page].root));
  const find = (id) => { const f = (n) => n.id === id ? n : n.children.reduce((r, ch) => r ?? f(ch), null); return f(gg); };
  t("both got 50% fill opacity", find("s1").fillOpacity === 0.5 && find("s2").fillOpacity === 0.5);
}

console.log(`selectionColorsScope: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
