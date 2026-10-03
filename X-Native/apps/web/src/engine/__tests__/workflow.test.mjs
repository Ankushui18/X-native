/**
 * Headless checks for Phase 4: undo coverage, design lint, fuzzy search,
 * and prototype condition/trigger semantics.
 *
 * Run with:  npx vite-node src/engine/__tests__/workflow.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import { lintDocument, contrastRatio } from "../lint.ts";
import { checkCondition, triggerInteractions } from "../protoEval.ts";
import { fuzzyScore, rankSearch, loadRecents, saveRecent } from "../../ui/search.ts";
import { resolveVariable } from "../variables.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const rootOf = (e) => snapOf(e).pages[snapOf(e).page].root;
const byId = (e, id) => find(rootOf(e), id);
const varsOf = (e) => snapOf(e).variables ?? [];
const colsOf = (e) => snapOf(e).variableCollections ?? [];

console.log("P4-A undo coverage:");
{
  const e = new MemoryEngine(false);
  const undo = () => e.dispatch({ type: "undo" });
  const redo = () => e.dispatch({ type: "redo" });

  e.dispatch({ type: "addVariable", variable: { id: "u1", name: "u1", type: "color", value: "#111111", collection: "Brand" } });
  undo();
  t("addVariable undoes", !varsOf(e).some((v) => v.id === "u1"));
  redo();
  t("addVariable redoes", varsOf(e).some((v) => v.id === "u1"));

  e.dispatch({ type: "patchVariable", id: "u1", patch: { value: "#222222" } });
  undo();
  t("patchVariable undoes", varsOf(e).find((v) => v.id === "u1").value === "#111111");

  e.dispatch({ type: "addCollection", name: "UndoCol" });
  undo();
  t("addCollection undoes", !colsOf(e).some((c) => c.name === "UndoCol"));
  redo();
  e.dispatch({ type: "addMode", collectionId: colsOf(e).find((c) => c.name === "UndoCol").id, name: "Alt" });
  undo();
  t("addMode undoes", colsOf(e).find((c) => c.name === "UndoCol").modes.length === 1);

  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50 });
  const id = snapOf(e).selection[0];
  e.dispatch({ type: "bindVariable", id, prop: "fill", variableId: "var-1" });
  undo();
  t("bindVariable undoes", !byId(e, id).variableBindings);
  redo();
  t("bindVariable redoes", byId(e, id).variableBindings?.fill === "var-1");
  e.dispatch({ type: "unbindVariable", id, prop: "fill" });
  undo();
  t("unbindVariable undoes", byId(e, id).variableBindings?.fill === "var-1");

  e.dispatch({ type: "setInteractions", id, interactions: [{ trigger: "onClick", action: "back", destination: "", animation: "instant", delay: 0 }] });
  undo();
  t("setInteractions undoes", (byId(e, id).interactions ?? []).length === 0);

  // View commands stay out of history: undo after a zoom+select reverts the
  // last document edit, not the view change.
  e.dispatch({ type: "patch", id, patch: { rotation: 30 } });
  e.dispatch({ type: "setZoom", zoom: 2 });
  e.dispatch({ type: "select", ids: [] });
  undo();
  t("view commands don't pollute history", byId(e, id).rotation === 0);

  // Swap round-trips through undo.
  e.dispatch({ type: "makeComponent" });
  const compA = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50 });
  e.dispatch({ type: "makeComponent" });
  const compB = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "placeComponent", id: compA.id, x: 0, y: 0 });
  const inst = snapOf(e).selection[0];
  e.dispatch({ type: "swapInstance", id: inst, componentId: compB.id });
  undo();
  t("swapInstance undoes", byId(e, inst).componentId === compA.id);
}

console.log("P4-B design lint:");
{
  const e = new MemoryEngine(false);
  const report = () => lintDocument(snapOf(e));
  t("fresh doc scores below 100 (unused seeds)", report().score < 100);
  t("seed variables flagged unused", report().issues.some((i) => i.rule === "unused-variable"));

  // Broken alias → error.
  e.dispatch({ type: "addVariable", variable: { id: "b1", name: "b1", type: "color", value: { alias: "ghost" }, collection: "Brand" } });
  t("broken alias is an error", report().issues.some((i) => i.rule === "broken-alias" && i.severity === "error"));

  // Using a variable clears its warning.
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const id = snapOf(e).selection[0];
  e.dispatch({ type: "bindVariable", id, prop: "fill", variableId: "var-1" });
  t("bound variable not flagged", !report().issues.some((i) => i.rule === "unused-variable" && i.variableIds.includes("var-1")));
  e.dispatch({ type: "patch", id, patch: { fill: "#123123" } });
  t("unbound off-token fill flagged", report().issues.some((i) => i.rule === "non-token-color" && i.nodeIds.includes(id)));
  const fixable = report().issues.find((i) => i.rule === "non-token-color" && i.nodeIds.includes(id) && i.fix?.kind === "create-variable-bind");
  t("non-token color carries a bind fix", !!fixable);

  // Contrast: dark-grey text on near-black fill → error.
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 200 });
  const f = snapOf(e).selection[0];
  e.dispatch({ type: "patch", id: f, patch: { fill: "#111111", fillVisible: true } });
  e.dispatch({ type: "add", kind: "text", x: 10, y: 10, w: 100, h: 30, parent: f });
  const tx = snapOf(e).selection[0];
  e.dispatch({ type: "patch", id: tx, patch: { fill: "#222222", fillVisible: true } });
  t("low contrast flagged", report().issues.some((i) => i.rule === "contrast" && i.nodeIds.includes(tx)));
  e.dispatch({ type: "patch", id: tx, patch: { fill: "#ffffff" } });
  t("fixed contrast clears", !report().issues.some((i) => i.rule === "contrast" && i.nodeIds.includes(tx)));
  t("contrast ratio math sane", Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01 && contrastRatio("#fff", "#fff") === 1);

  // Non-token spacing + radius.
  e.dispatch({ type: "autoLayout", id: f, layout: { direction: "vertical", gap: 7, padding: [3, 3, 3, 3], sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min" } });
  t("off-token gap flagged", report().issues.some((i) => i.rule === "non-token-spacing" && i.nodeIds.includes(f)));
  e.dispatch({ type: "patch", id, patch: { cornerRadii: [7, 7, 7, 7] } });
  t("off-token radius flagged", report().issues.some((i) => i.rule === "non-token-radius" && i.nodeIds.includes(id)));
  t("zero radius not flagged", !report().issues.some((i) => i.rule === "non-token-radius" && /radius 0\b/.test(i.message)));

  // Overrides + components.
  e.dispatch({ type: "select", ids: [id] });
  e.dispatch({ type: "makeComponent" });
  const comp = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "placeComponent", id: comp.id, x: 300, y: 0 });
  const inst = snapOf(e).selection[0];
  e.dispatch({ type: "patch", id: inst, patch: { fill: "#ff00ff" } });
  const ov = report().issues.find((i) => i.rule === "overridden-instance" && i.nodeIds.includes(inst));
  t("overridden instance flagged with reset fix", !!ov && ov.fix?.kind === "reset-overrides");
  e.dispatch({ type: "resetOverrides", id: inst });
  t("reset clears the flag", !report().issues.some((i) => i.rule === "overridden-instance" && i.nodeIds.includes(inst)));

  // Auto names are info-only and scoreless.
  t("auto frame name is info", report().issues.some((i) => i.rule === "auto-layer-name" && i.severity === "info"));
  const scoreBefore = report().score;
  e.dispatch({ type: "patch", id: f, patch: { name: "Custom frame" } });
  t("info issues don't move the score", report().score === scoreBefore);

  // Unused style.
  e.dispatch({ type: "select", ids: [id] });
  e.dispatch({ type: "createStyle", kind: "fill", name: "Ghost" });
  e.dispatch({ type: "detachStyle", kind: "fill" });
  const st = report().issues.find((i) => i.rule === "unused-style");
  t("unused style flagged with delete fix", !!st && st.fix?.kind === "delete-style");
}

console.log("P4-C fuzzy search:");
{
  t("exact beats prefix beats scatter",
    fuzzyScore("fill", "fill") > fuzzyScore("fill", "fill container") && fuzzyScore("fill", "fill container") > fuzzyScore("fill", "fuzzy incremental list layout"));
  t("non-subsequence rejected", fuzzyScore("xyz", "fill") === -1);
  t("word starts score higher", fuzzyScore("fb", "foo bar") > fuzzyScore("fb", "foobaz"));
  t("empty query scores zero", fuzzyScore("", "anything") === 0);
  const ranked = rankSearch(
    [{ kind: "layer", id: "1", label: "Background" }, { kind: "layer", id: "2", label: "Back" }, { kind: "layer", id: "3", label: "Foreground" }],
    "back",
  );
  t("ranking prefers tighter matches", ranked[0].id === "2" && ranked.length === 2);
  t("empty query keeps order", rankSearch([{ kind: "page", id: "p", label: "P" }], "  ").length === 1);

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  t("recents start empty", loadRecents().length === 0);
  saveRecent({ kind: "layer", id: "a", label: "A" });
  saveRecent({ kind: "page", id: "b", label: "B" });
  saveRecent({ kind: "layer", id: "a", label: "A" });
  const recents = loadRecents();
  t("recents dedupe + move to front", recents.length === 2 && recents[0].id === "a");
  delete globalThis.localStorage;
}

console.log("P4-D prototype conditions + triggers:");
{
  const e = new MemoryEngine(false);
  const st = () => ({ vars: varsOf(e), cols: colsOf(e), modes: snapOf(e).activeModes ?? {} });
  e.dispatch({ type: "addVariable", variable: { id: "c-num", name: "count", type: "number", value: 3, collection: "Brand" } });
  e.dispatch({ type: "addVariable", variable: { id: "c-on", name: "on", type: "boolean", value: true, collection: "Brand" } });
  const ck = (cond) => checkCondition(st().vars, st().cols, st().modes, cond);
  t("eq/neq compare", ck({ variableId: "c-num", op: "eq", value: 3 }) && !ck({ variableId: "c-num", op: "neq", value: 3 }));
  t("ordered comparisons", ck({ variableId: "c-num", op: "gt", value: 2 }) && ck({ variableId: "c-num", op: "lte", value: 3 }) && !ck({ variableId: "c-num", op: "lt", value: 3 }));
  t("ordered comparisons reject strings", !ck({ variableId: "c-on", op: "gt", value: 0 }));
  t("truthy/falsy", ck({ variableId: "c-on", op: "truthy" }) && !ck({ variableId: "c-on", op: "falsy" }));
  t("missing variable fails closed", !ck({ variableId: "ghost", op: "truthy" }) && ck({ variableId: "ghost", op: "falsy" }));
  // Mode-aware: condition follows the active mode.
  const brand = colsOf(e).find((c) => c.name === "Brand");
  e.dispatch({ type: "addMode", collectionId: brand.id, name: "Alt" });
  const altId = colsOf(e).find((c) => c.name === "Brand").modes.find((m) => m.name === "Alt").id;
  e.dispatch({ type: "patchVariable", id: "c-num", patch: { values: { [altId]: 10 } } });
  e.dispatch({ type: "setActiveMode", collectionId: brand.id, modeId: altId });
  t("conditions resolve under the active mode", ck({ variableId: "c-num", op: "eq", value: 10 }));

  // Trigger collection: innermost wins, all its matches run.
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 200 });
  const f = snapOf(e).selection[0];
  const mk = (action) => ({ trigger: "onClick", action, destination: "", animation: "instant", delay: 0 });
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50, parent: f });
  const c = snapOf(e).selection[0];
  e.dispatch({ type: "setInteractions", id: c, interactions: [mk("back"), mk("closeOverlay")] });
  e.dispatch({ type: "setInteractions", id: f, interactions: [mk("openUrl")] });
  const hit = triggerInteractions(rootOf(e), c, "onClick");
  t("innermost node wins with all matches", hit.nodeId === c && hit.list.length === 2);
  const miss = triggerInteractions(rootOf(e), c, "keyPress");
  t("no match returns null", miss === null);
  e.dispatch({ type: "setInteractions", id: c, interactions: [] });
  t("bubbles to parent", triggerInteractions(rootOf(e), c, "onClick").nodeId === f);
  t("resolveVariable still consistent", resolveVariable(st().vars, st().cols, st().modes, "c-num").value === 10);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
