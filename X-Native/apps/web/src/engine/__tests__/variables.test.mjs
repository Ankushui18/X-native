/**
 * Headless checks for Phase 3: variable collections + modes, aliases,
 * layer bindings, swap instance, and recursive constraints.
 *
 * Run with:  npx vite-node src/engine/__tests__/variables.test.mjs
 */
import { MemoryEngine, find, defaultLayout } from "../memory.ts";
import {
  BINDABLE_PROPS,
  applyBinding,
  coerceVariableValue,
  fallbackForType,
  isAlias,
  migrateCollections,
  resolveAllForMode,
  resolveVariable,
  wouldCycle,
} from "../variables.ts";
import { saveDoc } from "../persist.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const byId = (e, id) => find(snapOf(e).pages[snapOf(e).page].root, id);
const varsOf = (e) => snapOf(e).variables ?? [];
const colsOf = (e) => snapOf(e).variableCollections ?? [];
const modesOf = (e) => snapOf(e).activeModes ?? {};
const varByName = (e, name) => varsOf(e).find((v) => v.name === name);
const colByName = (e, name) => colsOf(e).find((c) => c.name === name);

console.log("seed + collection migration:");
{
  const e = new MemoryEngine(false);
  t("fresh engine seeds 5 variables", varsOf(e).length === 5);
  const cols = colsOf(e);
  t("collections derived from seeds", cols.length === 3 && cols.every((c) => c.modes.length === 1 && c.modes[0].name === "Default"));
  t("Brand collection exists", !!colByName(e, "Brand"));
  const migrated = migrateCollections([{ collection: "A" }, { collection: "B" }, { collection: "A" }]);
  t("migrateCollections dedupes names", migrated.length === 2 && migrated[0].modes.length === 1);
}

console.log("collection + mode commands:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "addCollection", name: "Theme" });
  t("addCollection appends", colsOf(e).length === 4);
  e.dispatch({ type: "addCollection", name: "Brand" });
  t("duplicate collection rejected", colsOf(e).length === 4);
  e.dispatch({
    type: "addVariable",
    variable: { id: "v-t1", name: "accent", type: "color", value: "#ff0000", collection: "Theme" },
  });
  const theme = colByName(e, "Theme");
  e.dispatch({ type: "renameCollection", id: theme.id, name: "Theme2" });
  t("renameCollection renames + moves members", !!colByName(e, "Theme2") && varByName(e, "accent").collection === "Theme2");
  e.dispatch({ type: "renameCollection", id: theme.id, name: "Brand" });
  t("rename onto existing name rejected", !!colByName(e, "Theme2"));
  const brand = colByName(e, "Brand");
  e.dispatch({ type: "addMode", collectionId: brand.id, name: "Dark" });
  t("addMode appends", colByName(e, "Brand").modes.length === 2);
  e.dispatch({ type: "addMode", collectionId: brand.id, name: "Dark" });
  t("duplicate mode rejected", colByName(e, "Brand").modes.length === 2);
  const dark = colByName(e, "Brand").modes.find((m) => m.name === "Dark");
  e.dispatch({ type: "renameMode", collectionId: brand.id, modeId: dark.id, name: "Night" });
  t("renameMode works", !!colByName(e, "Brand").modes.find((m) => m.name === "Night"));
  e.dispatch({ type: "setActiveMode", collectionId: brand.id, modeId: dark.id });
  t("setActiveMode records", modesOf(e)[brand.id] === dark.id);
  e.dispatch({ type: "setActiveMode", collectionId: brand.id, modeId: "nope" });
  t("unknown mode rejected", modesOf(e)[brand.id] === dark.id);
  e.dispatch({ type: "setActiveMode", collectionId: brand.id, modeId: dark.id });
  const snap1 = resolveVariable(varsOf(e), colsOf(e), { [brand.id]: dark.id }, "var-1");
  e.dispatch({ type: "patchVariable", id: "var-1", patch: { value: "#00ff00" } });
  const snap2 = resolveVariable(varsOf(e), colsOf(e), { [brand.id]: dark.id }, "var-1");
  const snapDefault = resolveVariable(varsOf(e), colsOf(e), {}, "var-1");
  t("new mode snapshots defaults (no leak)", snap1.value === "#0d99ff" && snap2.value === "#0d99ff" && snapDefault.value === "#00ff00");
  e.dispatch({ type: "deleteMode", collectionId: brand.id, modeId: dark.id });
  t("deleteMode removes + resets active", colByName(e, "Brand").modes.length === 1);
  e.dispatch({ type: "deleteMode", collectionId: brand.id, modeId: colByName(e, "Brand").modes[0].id });
  t("last mode protected", colByName(e, "Brand").modes.length === 1);
  e.dispatch({ type: "deleteCollection", id: colByName(e, "Theme2").id });
  t("deleteCollection removes members", !varByName(e, "accent") && colsOf(e).length === 3);
}

console.log("resolution (modes + aliases):");
{
  const e = new MemoryEngine(false);
  const brand = colByName(e, "Brand");
  e.dispatch({ type: "addMode", collectionId: brand.id, name: "Dark" });
  const darkId = colByName(e, "Brand").modes.find((m) => m.name === "Dark").id;
  const st = () => ({ vars: varsOf(e), cols: colsOf(e), modes: modesOf(e) });
  t("default slot resolves", resolveVariable(st().vars, st().cols, st().modes, "var-1").value === "#0d99ff");
  e.dispatch({ type: "patchVariable", id: "var-1", patch: { values: { [darkId]: "#000000" } } });
  e.dispatch({ type: "patchVariable", id: "var-1", patch: { values: { other: "#111111" } } });
  const v1 = varsOf(e).find((v) => v.id === "var-1");
  t("per-mode values merge slot by slot", v1.values[darkId] === "#000000" && v1.values.other === "#111111");
  t("inactive mode does not leak", resolveVariable(st().vars, st().cols, st().modes, "var-1").value === "#0d99ff");
  e.dispatch({ type: "setActiveMode", collectionId: brand.id, modeId: darkId });
  t("active mode override wins", resolveVariable(st().vars, st().cols, st().modes, "var-1").value === "#000000");
  e.dispatch({ type: "deleteMode", collectionId: brand.id, modeId: darkId });
  t("deleteMode scrubs overrides", varsOf(e).find((v) => v.id === "var-1").values[darkId] === undefined);

  // Aliases.
  e.dispatch({ type: "addVariable", variable: { id: "v-a", name: "a", type: "color", value: "#123456", collection: "Brand" } });
  e.dispatch({ type: "addVariable", variable: { id: "v-b", name: "b", type: "color", value: { alias: "v-a" }, collection: "Brand" } });
  e.dispatch({ type: "addVariable", variable: { id: "v-c", name: "c", type: "color", value: { alias: "v-b" }, collection: "Brand" } });
  const r = (id) => resolveVariable(varsOf(e), colsOf(e), modesOf(e), id);
  t("alias follows target", r("v-b").value === "#123456" && !r("v-b").broken);
  t("alias chain resolves", r("v-c").value === "#123456" && !r("v-c").broken);
  t("isAlias detects refs", isAlias(varByName(e, "b").value) && !isAlias(varByName(e, "a").value));
  e.dispatch({ type: "patchVariable", id: "v-a", patch: { value: { alias: "v-c" } } });
  t("cyclic alias refused at author", varByName(e, "a").value === "#123456");
  t("wouldCycle spots loops + self",
    wouldCycle(varsOf(e), colsOf(e), "v-a", "v-c") === true &&
    wouldCycle(varsOf(e), colsOf(e), "v-a", "v-a") === true &&
    wouldCycle(varsOf(e), colsOf(e), "v-c", "v-a") === false);
  e.dispatch({ type: "addVariable", variable: { id: "v-self", name: "self", type: "color", value: { alias: "v-self" }, collection: "Brand" } });
  t("self alias refused on create", !varByName(e, "self"));
  e.dispatch({ type: "addVariable", variable: { id: "v-a", name: "dupe", type: "color", value: "#000000", collection: "Brand" } });
  t("duplicate variable id refused", varsOf(e).filter((v) => v.id === "v-a").length === 1);
  const legacy = [
    { id: "lx", name: "lx", type: "color", value: { alias: "ly" }, collection: "Brand" },
    { id: "ly", name: "ly", type: "color", value: { alias: "lx" }, collection: "Brand" },
  ];
  const rl = resolveVariable(legacy, colsOf(e), modesOf(e), "lx");
  t("legacy cycle still reports broken", rl.broken === true && rl.reason === "cycle" && rl.value === fallbackForType("color"));
  e.dispatch({ type: "patchVariable", id: "v-b", patch: { value: { alias: "ghost" } } });
  t("missing target reports broken", r("v-b").broken === true && r("v-b").reason === "missing");
  e.dispatch({ type: "addVariable", variable: { id: "v-n", name: "n", type: "number", value: 7, collection: "Brand" } });
  e.dispatch({ type: "patchVariable", id: "v-b", patch: { value: { alias: "v-n" } } });
  t("cross-type alias reports broken", r("v-b").broken === true && r("v-b").reason === "type-mismatch");
  t("unknown id returns null", r("ghost") === null);
  const all = resolveAllForMode(varsOf(e), colsOf(e), modesOf(e));
  t("resolveAll keys by name + id", all["primary"] === "#0d99ff" && all["var-1"] === "#0d99ff");
}

console.log("typed coercion:");
{
  t("number accepts", coerceVariableValue("number", "12.5").value === 12.5);
  t("number rejects junk", !coerceVariableValue("number", "abc").ok && !coerceVariableValue("number", "").ok);
  t("boolean accepts pair", coerceVariableValue("boolean", "true").value === true && coerceVariableValue("boolean", "false").value === false);
  t("boolean rejects junk", !coerceVariableValue("boolean", "yes").ok);
  t("color accepts hex + rgb", coerceVariableValue("color", "#fff").ok && coerceVariableValue("color", "#ffffffff").ok && coerceVariableValue("color", "rgb(1,2,3)").ok);
  t("color rejects names", !coerceVariableValue("color", "red").ok);
  t("string accepts anything", coerceVariableValue("string", " hi ").value === " hi ");
  t("patch type-change resets slots", (() => {
    const e = new MemoryEngine(false);
    e.dispatch({ type: "patchVariable", id: "var-3", patch: { type: "boolean" } });
    const v = varsOf(e).find((x) => x.id === "var-3");
    return v.value === false && Object.keys(v.values ?? {}).length === 0;
  })());
}

console.log("layer bindings:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const id = snapOf(e).selection[0];
  t("bindable prop table covers 18 props", Object.keys(BINDABLE_PROPS).length === 18 && BINDABLE_PROPS.fill === "color");
  e.dispatch({ type: "bindVariable", id, prop: "fill", variableId: "var-1" });
  t("bind applies immediately", byId(e, id).fill === "#0d99ff" && byId(e, id).variableBindings.fill === "var-1");
  // Mode switch re-applies the binding.
  const brand = colByName(e, "Brand");
  e.dispatch({ type: "addMode", collectionId: brand.id, name: "Dark" });
  const darkId = colByName(e, "Brand").modes.find((m) => m.name === "Dark").id;
  e.dispatch({ type: "patchVariable", id: "var-1", patch: { values: { [darkId]: "#000000" } } });
  e.dispatch({ type: "setActiveMode", collectionId: brand.id, modeId: darkId });
  t("mode switch re-applies bindings", byId(e, id).fill === "#000000");
  // Guards.
  e.dispatch({ type: "bindVariable", id, prop: "fill", variableId: "var-3" });
  t("type mismatch rejected", byId(e, id).variableBindings.fill === "var-1");
  e.dispatch({ type: "bindVariable", id, prop: "text", variableId: "var-1" });
  t("text prop on rect rejected", !byId(e, id).variableBindings.text);
  e.dispatch({ type: "bindVariable", id, prop: "strokeWidth", variableId: "var-3" });
  t("number binds", byId(e, id).strokeWidth === 8);
  e.dispatch({ type: "addVariable", variable: { id: "v-vis", name: "show", type: "boolean", value: false, collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id, prop: "visible", variableId: "v-vis" });
  t("boolean binds visibility", byId(e, id).visible === false);
  // Detach on direct edit.
  e.dispatch({ type: "patch", id, patch: { fill: "#ffffff" } });
  t("direct edit detaches that prop", !byId(e, id).variableBindings.fill && byId(e, id).fill === "#ffffff");
  t("other bindings survive", byId(e, id).variableBindings.strokeWidth === "var-3");
  e.dispatch({ type: "unbindVariable", id, prop: "strokeWidth" });
  t("unbind keeps value, drops entry", byId(e, id).strokeWidth === 8 && !byId(e, id).variableBindings?.strokeWidth);
  // Text bindings on a text node.
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 100, h: 30 });
  const tid = snapOf(e).selection[0];
  e.dispatch({ type: "addVariable", variable: { id: "v-t", name: "label", type: "string", value: "Hi", collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: tid, prop: "text", variableId: "v-t" });
  t("string binds text content", byId(e, tid).text === "Hi");
  t("applyBinding rejects inapplicable", applyBinding(byId(e, id), "text", "x") === false);
}

console.log("variable persistence:");
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const e = new MemoryEngine(false);
  e.dispatch({ type: "addCollection", name: "Theme" });
  const theme = colByName(e, "Theme");
  e.dispatch({ type: "addMode", collectionId: theme.id, name: "Dark" });
  const darkId = colByName(e, "Theme").modes.find((m) => m.name === "Dark").id;
  e.dispatch({ type: "addVariable", variable: { id: "v-x", name: "x", type: "number", value: 1, values: { [darkId]: 2 }, collection: "Theme" } });
  e.dispatch({ type: "setActiveMode", collectionId: theme.id, modeId: darkId });
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const id = snapOf(e).selection[0];
  e.dispatch({ type: "bindVariable", id, prop: "strokeWidth", variableId: "v-x" });
  const doc = e.toDoc();
  t("toDoc carries variables + modes", doc.variables.length === 6 && doc.variableCollections.length === 4 && doc.activeModes[theme.id] === darkId);
  saveDoc(doc);
  const e2 = new MemoryEngine(true);
  t("collections survive reload", (snapOf(e2).variableCollections ?? []).length === 4);
  t("variables survive reload", (snapOf(e2).variables ?? []).some((v) => v.id === "v-x"));
  t("active mode survives reload", (snapOf(e2).activeModes ?? {})[theme.id] === darkId);
  t("binding applies under restored mode", byId(e2, id).strokeWidth === 2);
  delete globalThis.localStorage;
}

console.log("swap instance:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50 });
  const a = snapOf(e).selection[0];
  e.dispatch({ type: "patch", id: a, patch: { fill: "#ff0000" } });
  e.dispatch({ type: "makeComponent" });
  const compA = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50 });
  const b = snapOf(e).selection[0];
  e.dispatch({ type: "patch", id: b, patch: { fill: "#0000ff" } });
  e.dispatch({ type: "makeComponent" });
  const compB = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "placeComponent", id: compA.id, x: 200, y: 200 });
  const inst = snapOf(e).selection[0];
  t("instance starts as A", byId(e, inst).componentId === compA.id && byId(e, inst).fill === "#ff0000");
  e.dispatch({ type: "swapInstance", id: inst, componentId: compB.id });
  const after = byId(e, inst);
  t("swap keeps identity, takes B content", after && after.id === inst && after.componentId === compB.id && after.fill === "#0000ff");
  t("swap keeps position", after.x === 200 && after.y === 200);
  e.dispatch({ type: "swapInstance", id: compB.node.id, componentId: compA.id });
  t("swap on master is a no-op", find(snapOf(e).pages[snapOf(e).page].root, compB.node.id).isComponent === true);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const plain = snapOf(e).selection[0];
  e.dispatch({ type: "swapInstance", id: plain, componentId: compA.id });
  t("swap on plain layer is a no-op", !byId(e, plain).componentId);
}

console.log("instance-swap property:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 20, h: 20 });
  e.dispatch({ type: "makeComponent" });
  const iconA = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 20, h: 20 });
  e.dispatch({ type: "makeComponent" });
  const iconB = snapOf(e).components[snapOf(e).components.length - 1];
  // Card master containing a nested instance of A.
  e.dispatch({ type: "placeComponent", id: iconA.id, x: 0, y: 0 });
  const nested = snapOf(e).selection[0];
  const nestedName = byId(e, nested).name;
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 60 });
  const cardBody = snapOf(e).selection[0];
  e.dispatch({ type: "select", ids: [nested, cardBody] });
  e.dispatch({ type: "makeComponent" });
  const card = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({
    type: "addComponentProperty",
    componentId: card.id,
    property: { id: "prop-swap", name: "Icon", type: "instance-swap", defaultValue: iconA.id, targetNodeName: nestedName },
  });
  e.dispatch({ type: "placeComponent", id: card.id, x: 300, y: 0 });
  const cardInst = snapOf(e).selection[0];
  const nestedInInst = (rootId) => byId(e, rootId).children.find((c) => c.name === nestedName);
  t("nested instance starts as A", nestedInInst(cardInst).componentId === iconA.id);
  e.dispatch({ type: "setComponentProperty", id: cardInst, propName: "Icon", value: iconB.id });
  t("instance-swap prop swaps nested content", nestedInInst(cardInst).componentId === iconB.id);
  e.dispatch({ type: "setComponentProperty", id: cardInst, propName: "Icon", value: iconA.id });
  t("swap back works", nestedInInst(cardInst).componentId === iconA.id);
}

console.log("recursive constraints:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 200 });
  const f = snapOf(e).selection[0];
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 100, h: 100, parent: f, extra: { constraintH: "stretch", constraintV: "stretch" } });
  const c = snapOf(e).selection[0];
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 50, h: 50, parent: c, extra: { constraintH: "stretch", constraintV: "stretch" } });
  const g = snapOf(e).selection[0];
  e.dispatch({ type: "resize", id: f, x: 0, y: 0, w: 300, h: 300 });
  t("stretch child follows parent", byId(e, c).w === 200 && byId(e, c).h === 200);
  t("stretch grandchild cascades", byId(e, g).w === 150 && byId(e, g).h === 150);
}

console.log("§18 number text + dimensions:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 100, h: 30 });
  const tid = snapOf(e).selection[0];
  e.dispatch({ type: "addVariable", variable: { id: "v-num", name: "count", type: "number", value: 16, collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: tid, prop: "text", variableId: "v-num" });
  t("number binds text content", byId(e, tid).text === "16");
  e.dispatch({ type: "patchVariable", id: "v-num", patch: { value: 42 } });
  t("number text stays live", byId(e, tid).text === "42");
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const rid = snapOf(e).selection[0];
  e.dispatch({ type: "bindVariable", id: rid, prop: "w", variableId: "v-num" });
  t("number binds width", byId(e, rid).w === 42);
  e.dispatch({ type: "resize", id: rid, x: 0, y: 0, w: 99, h: 10 });
  t("resize detaches width + sticks", !byId(e, rid).variableBindings?.w && byId(e, rid).w === 99);
}

console.log("§18 type change scrub:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50 });
  const id = snapOf(e).selection[0];
  e.dispatch({ type: "bindVariable", id, prop: "fill", variableId: "var-1" });
  e.dispatch({ type: "patchVariable", id: "var-1", patch: { type: "number" } });
  t("type change scrubs mismatched bindings", !byId(e, id).variableBindings?.fill);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 100, h: 30 });
  const tid = snapOf(e).selection[0];
  e.dispatch({ type: "addVariable", variable: { id: "v-s", name: "s", type: "string", value: "hi", collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: tid, prop: "text", variableId: "v-s" });
  e.dispatch({ type: "patchVariable", id: "v-s", patch: { type: "number" } });
  t("text binding survives string→number", byId(e, tid).variableBindings?.text === "v-s" && byId(e, tid).text === "0");
}

console.log("§18 text + layout bindings:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 100, h: 30 });
  const tid = snapOf(e).selection[0];
  e.dispatch({ type: "addVariable", variable: { id: "v-ls", name: "ls", type: "number", value: 4, collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: tid, prop: "letterSpacing", variableId: "v-ls" });
  t("letterSpacing binds", byId(e, tid).letterSpacing === 4);
  e.dispatch({ type: "addVariable", variable: { id: "v-ff", name: "ff", type: "string", value: "Inter", collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: tid, prop: "fontFamily", variableId: "v-ff" });
  t("fontFamily binds", byId(e, tid).fontFamily === "Inter");
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const rid = snapOf(e).selection[0];
  e.dispatch({ type: "bindVariable", id: rid, prop: "fontFamily", variableId: "v-ff" });
  t("text bindings need a text layer", !byId(e, rid).variableBindings?.fontFamily);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 200 });
  const fid = snapOf(e).selection[0];
  e.dispatch({ type: "addVariable", variable: { id: "v-gap", name: "gap", type: "number", value: 12, collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: fid, prop: "layoutGap", variableId: "v-gap" });
  t("gap needs auto layout", !byId(e, fid).variableBindings?.layoutGap);
  e.dispatch({ type: "autoLayout", id: fid, layout: defaultLayout() });
  e.dispatch({ type: "bindVariable", id: fid, prop: "layoutGap", variableId: "v-gap" });
  t("gap binds on auto layout", byId(e, fid).layout.gap === 12);
  e.dispatch({ type: "bindVariable", id: fid, prop: "layoutPadding", variableId: "v-gap" });
  t("padding binds", JSON.stringify(byId(e, fid).layout.padding) === "[12,12,12,12]");
  e.dispatch({ type: "autoLayout", id: fid, layout: defaultLayout() });
  t("fresh preset drops gap/padding", !byId(e, fid).variableBindings?.layoutGap && !byId(e, fid).variableBindings?.layoutPadding);
  e.dispatch({ type: "bindVariable", id: fid, prop: "layoutGap", variableId: "v-gap" });
  e.dispatch({ type: "removeAllLayout", id: fid });
  t("stripLayout drops gap binding", !byId(e, fid).variableBindings?.layoutGap);
}

console.log("§18 instance binding rules:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100 });
  const f = snapOf(e).selection[0];
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 40, h: 40, parent: f });
  e.dispatch({ type: "patch", id: byId(e, f).children[0].id, patch: { name: "A" } });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "makeComponent" });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "duplicate" });
  const inst = snapOf(e).selection[0];
  const mA = byId(e, inst).children[0].id;
  const mAmaster = byId(e, f).children[0].id;
  e.dispatch({ type: "addVariable", variable: { id: "v-w", name: "vw", type: "number", value: 40, collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: mA, prop: "w", variableId: "v-w" });
  t("member takes no width binding", !byId(e, mA).variableBindings?.w);
  e.dispatch({ type: "bindVariable", id: mA, prop: "fill", variableId: "var-1" });
  t("member takes paint bindings", byId(e, mA).variableBindings?.fill === "var-1");
  e.dispatch({ type: "patch", id: f, patch: { name: "M2" } });
  t("own binding survives master sync", byId(e, inst).children[0].variableBindings?.fill === "var-1");
  e.dispatch({ type: "bindVariable", id: mAmaster, prop: "strokeWidth", variableId: "var-3" });
  t("master bind flows to live instances", byId(e, inst).children[0].variableBindings?.strokeWidth === "var-3");
  e.dispatch({ type: "unbindVariable", id: mAmaster, prop: "strokeWidth" });
  t("master unbind flows, own stays",
    !byId(e, inst).children[0].variableBindings?.strokeWidth &&
    byId(e, inst).children[0].variableBindings?.fill === "var-1");
  e.dispatch({ type: "bindVariable", id: inst, prop: "layoutGap", variableId: "v-w" });
  t("instance root takes no layout bindings", !byId(e, inst).variableBindings?.layoutGap);
}

console.log("§18 styles × instances:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100 });
  const f = snapOf(e).selection[0];
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 40, h: 40, parent: f });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "makeComponent" });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "duplicate" });
  const inst = snapOf(e).selection[0];
  const mA = byId(e, inst).children[0].id;
  e.dispatch({ type: "select", ids: [mA] });
  e.dispatch({ type: "createStyle", kind: "fill", name: "MemberRed" });
  const stId = snapOf(e).styles.find((x) => x.name === "MemberRed").id;
  e.dispatch({ type: "patch", id: f, patch: { name: "M3" } });
  t("member style survives master sync", byId(e, inst).children[0].fillStyle === stId);
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "applyStyle", kind: "fill", styleId: stId });
  e.dispatch({ type: "patch", id: f, patch: { name: "M4" } });
  t("root style survives master sync", byId(e, inst).fillStyle === stId);
  e.dispatch({ type: "patch", id: mA, patch: { fill: "#00ff00" } });
  e.dispatch({ type: "patch", id: f, patch: { name: "M5" } });
  t("member hand-edit drops style persistently",
    byId(e, inst).children[0].fill === "#00ff00" && !byId(e, inst).children[0].fillStyle);
}

console.log("§18 pin hygiene:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100 });
  const f = snapOf(e).selection[0];
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 40, h: 40, parent: f });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "makeComponent" });
  e.dispatch({ type: "bindVariable", id: byId(e, f).children[0].id, prop: "fill", variableId: "var-1" });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "duplicate" });
  const inst = snapOf(e).selection[0];
  t("fresh instances arrive unpinned", byId(e, inst).children[0].ownBindings === undefined);
  t("flowed binding still applies", byId(e, inst).children[0].variableBindings?.fill === "var-1");
  // Detach → recomponent resets ownership: the master unbind flows.
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "detachInstance" });
  e.dispatch({ type: "bindVariable", id: byId(e, inst).children[0].id, prop: "strokeWidth", variableId: "var-3" });
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "makeComponent" });
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "duplicate" });
  const inst2 = snapOf(e).selection[0];
  e.dispatch({ type: "unbindVariable", id: byId(e, inst).children[0].id, prop: "strokeWidth" });
  t("recomponented masters flow unbinds", !byId(e, inst2).children[0].variableBindings?.strokeWidth);
  // Reset clears pins: a later master unbind flows through.
  e.dispatch({ type: "bindVariable", id: byId(e, inst2).children[0].id, prop: "fill", variableId: "var-1" });
  e.dispatch({ type: "resetOverrides", id: inst2 });
  e.dispatch({ type: "unbindVariable", id: byId(e, inst).children[0].id, prop: "fill" });
  t("reset clears pins", !byId(e, inst2).children[0].variableBindings?.fill);
}

// FS-U6': hideSel detaches a `visible` binding (explicit edit wins).
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "addVariable", variable: { id: "v-vis", name: "vis", type: "boolean", value: true, collection: "Flags" } });
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 100, h: 60 });
  const id = snapOf(e).selection[0];
  e.dispatch({ type: "bindVariable", id, prop: "visible", variableId: "v-vis" });
  t("visible binding lands", byId(e, id).variableBindings?.visible === "v-vis");
  e.dispatch({ type: "hideSel" });
  t("hideSel toggles a bound layer", byId(e, id).visible === false);
  t("hideSel detaches the visible binding", byId(e, id).variableBindings?.visible === undefined);
  e.dispatch({ type: "select", ids: [id] });
  t("toggle survives the next relayout", byId(e, id).visible === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
