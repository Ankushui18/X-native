/**
 * Headless checks for §17 (components): member-geometry refusal, structural
 * guards, identity rules, variant-aware publish/sync, and override carry.
 *
 * Run with:  npx vite-node src/engine/__tests__/components.test.mjs
 */
import { MemoryEngine, find, defaultLayout } from "../memory.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));
const R = (e) => e.snapshot().pages[e.snapshot().page].root;
const lastId = (e) => { const r = R(e); return r.children[r.children.length - 1].id; };
const kid = (e, parentId, i) => find(R(e), parentId).children[i].id;
const kidByName = (e, parentId, name) => find(R(e), parentId).children.find((c) => c.name === name);

/** Frame with two named rects, converted to a component. Returns { master, cid }. */
function makeMaster(e, w = 200, h = 100) {
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w, h });
  const f = lastId(e);
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 40, h: 40, parent: f });
  e.dispatch({ type: "patch", id: kid(e, f, 0), patch: { name: "A" } });
  e.dispatch({ type: "add", kind: "rect", x: 60, y: 10, w: 40, h: 40, parent: f });
  e.dispatch({ type: "patch", id: kid(e, f, 1), patch: { name: "B" } });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "makeComponent" });
  return { master: f, cid: find(R(e), f).componentId };
}
/** Duplicate a master; returns the new instance id. */
function makeInstance(e, master) {
  e.dispatch({ type: "select", ids: [master] });
  e.dispatch({ type: "duplicate" });
  return e.snapshot().selection[0];
}

console.log("C-A member geometry refusal:");
{
  const e = new MemoryEngine(false);
  const { master } = makeMaster(e);
  const inst = makeInstance(e, master);
  const mA = kidByName(e, inst, "A").id;
  e.dispatch({ type: "patch", id: mA, patch: { x: 999 } });
  t("member position refused", find(R(e), mA).x === 10 && !find(R(e), mA).overrides?.x);
  e.dispatch({ type: "patch", id: mA, patch: { w: 5 } });
  t("member size refused", find(R(e), mA).w === 40);
  e.dispatch({ type: "patch", id: mA, patch: { cornerRadii: [9, 9, 9, 9] } });
  t("member radii refused", JSON.stringify(find(R(e), mA).cornerRadii) === "[0,0,0,0]");
  e.dispatch({ type: "patch", id: mA, patch: { fill: "#ff0000" } });
  t("member fill allowed + recorded", find(R(e), mA).fill === "#ff0000" && find(R(e), mA).overrides?.fill === "#ff0000");
  e.dispatch({ type: "patch", id: mA, patch: { name: "A2" } });
  t("member rename allowed", find(R(e), mA).name === "A2");
  e.dispatch({ type: "patch", id: inst, patch: { x: 50 } });
  t("instance root moves", find(R(e), inst).x === 50);
  e.dispatch({ type: "patch", id: inst, patch: { layout: defaultLayout() } });
  t("root layout refused", find(R(e), inst).layout == null);
  e.dispatch({ type: "patchPath", id: mA, path: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false });
  t("member vector edit refused", find(R(e), mA).path.length === 0);
}

console.log("C-B structural guards:");
{
  const e = new MemoryEngine(false);
  const { master } = makeMaster(e);
  const inst = makeInstance(e, master);
  const mA = kidByName(e, inst, "A").id;
  e.dispatch({ type: "select", ids: [mA] });
  e.dispatch({ type: "delete" });
  t("member delete refused", !!kidByName(e, inst, "A"));
  e.dispatch({ type: "duplicate" });
  t("member duplicate refused", find(R(e), inst).children.length === 2);
  e.dispatch({ type: "select", ids: [mA] });
  e.dispatch({ type: "nudge", dx: 5, dy: 0 });
  t("member nudge refused", find(R(e), mA).x === 10);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 5, h: 5, parent: inst });
  t("add into instance refused", find(R(e), inst).children.length === 2);
  e.dispatch({ type: "add", kind: "rect", x: 300, y: 300, w: 5, h: 5 });
  const outsider = lastId(e);
  e.dispatch({ type: "reorder", ids: [outsider], parent: inst, index: 9 });
  t("reorder into instance refused", find(R(e), inst).children.length === 2);
  const rootN = R(e).children.length;
  e.dispatch({ type: "select", ids: [mA, outsider] });
  e.dispatch({ type: "group" });
  t("group with member refused", R(e).children.length === rootN);
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "ungroup" });
  t("instance never ungroups", find(R(e), inst).children.length === 2);
  const orderBefore = find(R(e), master).children.map((c) => c.name).join(",");
  e.dispatch({ type: "select", ids: [mA] });
  e.dispatch({ type: "arrange", dir: "front" });
  t("member arrange skipped", find(R(e), master).children.map((c) => c.name).join(",") === orderBefore);
  e.dispatch({ type: "autoLayout", id: inst, layout: defaultLayout() });
  t("instance layout refused", find(R(e), inst).layout == null);
}

console.log("C-C identity rules:");
{
  const e = new MemoryEngine(false);
  const { master, cid } = makeMaster(e);
  const inst = makeInstance(e, master);
  const libsBefore = e.snapshot().components.length;
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "makeComponent" });
  t("component from instance mints a fresh id", e.snapshot().components.length === libsBefore + 1);
  t("original library untouched", e.snapshot().components.some((c) => c.id === cid));
  t("remade master carries the new id", find(R(e), inst).componentId !== cid && find(R(e), inst).isComponent);
}
{
  const e = new MemoryEngine(false);
  const { master, cid } = makeMaster(e);
  const inst = makeInstance(e, master);
  const mA = kidByName(e, inst, "A").id;
  e.dispatch({ type: "patch", id: mA, patch: { fill: "#00ff00" } });
  e.dispatch({ type: "select", ids: [master] });
  e.dispatch({ type: "detachInstance" });
  t("master cannot detach", find(R(e), master).isComponent && !!e.snapshot().components.find((c) => c.id === cid));
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "detachInstance" });
  const d = find(R(e), inst);
  t("detach clears the link", !d.isComponent && !d.componentId);
  t("detach clears dead overrides", d.overrides === undefined && d.children.every((c) => c.overrides === undefined));
}
{
  // Nested instances stay linked through a detach.
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const r2 = lastId(e);
  e.dispatch({ type: "select", ids: [r2] });
  e.dispatch({ type: "makeComponent" });
  const m2 = r2;
  const cid2 = find(R(e), m2).componentId;
  e.dispatch({ type: "select", ids: [m2] });
  e.dispatch({ type: "duplicate" });
  const nested = e.snapshot().selection[0];
  const { master } = makeMaster(e);
  e.dispatch({ type: "reorder", ids: [nested], parent: master, index: 9 });
  const inst = makeInstance(e, master);
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "detachInstance" });
  const still = find(R(e), inst).children.find((c) => c.componentId === cid2 && !c.isComponent);
  t("nested instance survives detach", !!still);
}

console.log("C-D variants + sync:");
{
  const e = new MemoryEngine(false);
  const { master, cid } = makeMaster(e);
  e.dispatch({ type: "select", ids: [master] });
  e.dispatch({ type: "addVariant", name: "Hover" });
  const lib = () => e.snapshot().components.find((c) => c.id === cid);
  t("variant registered", lib().variants.length === 2);
  const i1 = makeInstance(e, master);
  const i2 = makeInstance(e, master);
  e.dispatch({ type: "setVariant", id: i1, name: "Hover" });
  e.dispatch({ type: "setVariant", id: i2, name: "Hover" });
  const c1 = kidByName(e, i1, "A").id;
  const c2 = kidByName(e, i2, "A").id;
  const cl = lib().variants.find((v) => v.name === "Hover").node.children.find((c) => c.name === "A").id;
  t("variant children get fresh ids", c1 !== c2 && c1 !== cl && c2 !== cl);
  // Same-named override follows its layer across a master reorder.
  const plain0 = makeInstance(e, master);
  e.dispatch({ type: "patch", id: kidByName(e, plain0, "B").id, patch: { fill: "#ff00ff" } });
  const mA = kidByName(e, master, "A").id;
  e.dispatch({ type: "select", ids: [mA] });
  e.dispatch({ type: "arrange", dir: "front" });
  e.dispatch({ type: "patch", id: master, patch: { name: "M2" } });
  const names = find(R(e), plain0).children.map((c) => c.name).join(",");
  t("instance follows master order", names === "B,A");
  t("override follows its layer", kidByName(e, plain0, "B").fill === "#ff00ff");
  // Variant instances survive default-master edits.
  e.dispatch({ type: "patch", id: master, patch: { fill: "#123456" } });
  t("variant sticks through master edits", find(R(e), i1).variant === "Hover");
  t("variant keeps its own content", find(R(e), i1).fill !== "#123456");
}
{
  // Variant-copy edits publish to the variant def, not the default node.
  const e = new MemoryEngine(false);
  const { master, cid } = makeMaster(e);
  e.dispatch({ type: "select", ids: [master] });
  e.dispatch({ type: "addVariant", name: "Hover" });
  const vcopy = e.snapshot().selection[0];
  const lib = () => e.snapshot().components.find((c) => c.id === cid);
  const defFill = lib().node.fill;
  e.dispatch({ type: "patch", id: vcopy, patch: { fill: "#0b0b0b" } });
  t("default def untouched by variant edits", lib().node.fill === defFill);
  t("variant def updated", lib().variants.find((v) => v.name === "Hover").node.fill === "#0b0b0b");
  const plain = makeInstance(e, master);
  const hov = makeInstance(e, master);
  e.dispatch({ type: "setVariant", id: hov, name: "Hover" });
  e.dispatch({ type: "patch", id: vcopy, patch: { name: "HoverMaster" } });
  t("plain instance ignores variant edits", find(R(e), plain).fill !== "#0b0b0b");
  t("variant instance receives them", find(R(e), hov).fill === "#0b0b0b");
  // Reset restores the current variant, and keeps it.
  e.dispatch({ type: "patch", id: kidByName(e, hov, "A").id, patch: { fill: "#eeeeee" } });
  e.dispatch({ type: "resetOverrides", id: hov });
  t("reset keeps the variant", find(R(e), hov).variant === "Hover");
  t("reset restores variant content", find(R(e), hov).fill === "#0b0b0b");
}

console.log("C-E repeated-sync integrity (C-012):");
{
  const e = new MemoryEngine(false);
  const { master } = makeMaster(e);
  const inst = makeInstance(e, master);
  e.dispatch({ type: "patch", id: master, patch: { name: "M2" } });
  e.dispatch({ type: "patch", id: master, patch: { fill: "#111111" } });
  e.dispatch({ type: "patch", id: kidByName(e, master, "A").id, patch: { x: 12 } });
  const kids = find(R(e), inst).children;
  t("members keep their names", kids.map((c) => c.name).join(",") === "A,B");
  t("members keep their size", kids[0].w === 40 && kids[1].w === 40);
  t("members gain no children", kids[0].children.length === 0 && kids[1].children.length === 0);
  t("member edit still publishes", kidByName(e, inst, "A").x === 12);
}
{
  // A nested instance keeps its own link through outer syncs and still
  // follows its own master.
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  const r2 = lastId(e);
  e.dispatch({ type: "select", ids: [r2] });
  e.dispatch({ type: "makeComponent" });
  const m2 = r2;
  const cid2 = find(R(e), m2).componentId;
  e.dispatch({ type: "select", ids: [m2] });
  e.dispatch({ type: "duplicate" });
  const nested = e.snapshot().selection[0];
  const { master } = makeMaster(e);
  e.dispatch({ type: "reorder", ids: [nested], parent: master, index: 9 });
  const inst = makeInstance(e, master);
  e.dispatch({ type: "patch", id: kidByName(e, master, "A").id, patch: { x: 13 } });
  const still = find(R(e), inst).children.find((c) => c.componentId === cid2 && !c.isComponent);
  t("nested link survives outer sync", !!still);
  e.dispatch({ type: "patch", id: m2, patch: { fill: "#222222" } });
  const after = find(R(e), inst).children.find((c) => c.componentId === cid2 && !c.isComponent);
  t("nested follows its own master", after && after.fill === "#222222");
}

console.log("C-F reset hardening (C-013):");
{
  const e = new MemoryEngine(false);
  const { master } = makeMaster(e);
  const inst = makeInstance(e, master);
  const mB = kidByName(e, inst, "B").id;
  e.dispatch({ type: "patch", id: mB, patch: { fill: "#ff00ff" } });
  e.dispatch({ type: "resetOverrides", id: mB });
  t("member reset heals the instance", kidByName(e, inst, "B").fill !== "#ff00ff");
  t("member reset keeps structure", find(R(e), inst).children.length === 2);
  e.dispatch({ type: "patch", id: kidByName(e, inst, "B").id, patch: { fill: "#ff00ff" } });
  e.dispatch({ type: "resetOverrides", id: kidByName(e, inst, "B").id, property: "fill" });
  const healed = kidByName(e, inst, "B");
  t("per-property member reset restores master value", healed.fill === kidByName(e, master, "B").fill);
  t("per-property reset drops the key", healed.overrides?.fill === undefined);
}

console.log("C-G master-subtree publish + swap carry:");
{
  const e = new MemoryEngine(false);
  const { master } = makeMaster(e);
  const inst = makeInstance(e, master);
  const mA = kidByName(e, master, "A").id;
  e.dispatch({ type: "patch", id: mA, patch: { x: 11 } });
  t("master-child patch publishes", kidByName(e, inst, "A").x === 11);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 5, h: 5, parent: master });
  t("master-child add publishes", find(R(e), inst).children.length === 3);
  const extra = kid(e, master, 2);
  e.dispatch({ type: "select", ids: [extra] });
  e.dispatch({ type: "delete" });
  t("master-child delete publishes", find(R(e), inst).children.length === 2);
  e.dispatch({ type: "select", ids: [mA] });
  e.dispatch({ type: "nudge", dx: 1, dy: 0 });
  t("master-child nudge publishes", kidByName(e, inst, "A").x === 12);
}
{
  // Swap carries same-named overrides and drops stale sizes.
  const e = new MemoryEngine(false);
  const a = makeMaster(e, 200, 100);
  const b = makeMaster(e, 120, 60);
  const cidB = b.cid;
  const inst = makeInstance(e, a.master);
  e.dispatch({ type: "patch", id: kidByName(e, inst, "A").id, patch: { fill: "#abcdef" } });
  e.dispatch({ type: "patch", id: inst, patch: { w: 250 } });
  e.dispatch({ type: "swapInstance", id: inst, componentId: cidB });
  t("swap relinks", find(R(e), inst).componentId === cidB);
  t("swap carries named overrides", kidByName(e, inst, "A").fill === "#abcdef");
  t("swap drops stale size", find(R(e), inst).overrides?.w === undefined);
}
{
  const e = new MemoryEngine(false);
  const { cid } = makeMaster(e);
  e.dispatch({ type: "placeComponent", id: cid, x: 33, y: 44 });
  const p = e.snapshot().selection[0];
  const n = find(R(e), p);
  t("place links an instance", !n.isComponent && n.componentId === cid && n.x === 33 && n.y === 44);
  t("place seeds defaults", n.componentProperties?.Variant === "Default");
}
