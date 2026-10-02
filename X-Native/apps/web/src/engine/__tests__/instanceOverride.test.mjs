/**
 * Instance overrides (Figma help 360039150733 "Apply changes to instances"):
 * Instances accept text/fill/stroke/effect overrides; detach instance
 * (⌥⌘B) converts the instance into a plain editable copy; overrides
 * persist across variant swaps when layer names match.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // Detach instance ⌥⌘B: case "detachInstance" turns an instance into a
  // regular frame/group so it can be edited freely.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  // Create a component master.
  const master = node("frame", "Button", 0, 0, 120, 40, { isComponent: true });
  const label = node("text", "Label", 10, 10, 100, 20, { text: "Click me" });
  master.children.push(label);
  r.children.push(master);
  engine.dispatch({ type: "select", ids: [master.id] });
  engine.dispatch({ type: "makeComponent" });
  const cid = find(r, master.id).componentId;

  // Create an instance of that component on the canvas.
  const inst = node("frame", "Button", 200, 0, 120, 40, { componentId: cid, isComponent: false });
  const ilbl = node("text", "Label", 10, 10, 100, 20, { text: "Click me", componentId: cid });
  inst.children.push(ilbl);
  r.children.push(inst);
  t("instance created with componentId set", inst.componentId === cid);

  // Detach.
  engine.dispatch({ type: "select", ids: [inst.id] });
  engine.dispatch({ type: "detachInstance" });
  const after = find(r, inst.id);
  t("detachInstance clears componentId", !after.componentId);
  t("detached instance is no longer marked isComponent", after.isComponent !== true);
  t("children remain after detach", after.children.length === 1);
}

{
  // Override fill color on an instance.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const master = node("rect", "Chip", 0, 0, 80, 32, { isComponent: true, fill: "#cccccc" });
  r.children.push(master);
  engine.dispatch({ type: "select", ids: [master.id] });
  engine.dispatch({ type: "makeComponent" });
  const cid = find(r, master.id).componentId;
  const inst = node("rect", "Chip", 200, 0, 80, 32, { componentId: cid, isComponent: false, fill: "#cccccc" });
  r.children.push(inst);

  // Apply an override: new fill.
  engine.dispatch({ type: "patch", id: inst.id, patch: { fill: "#ff0000" } });
  t("instance fill override stores", find(r, inst.id).fill === "#ff0000");
  t("master fill is unchanged after override", find(r, master.id).fill === "#cccccc");
}

{
  // Override text content on an instance.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const master = node("frame", "B", 0, 0, 120, 40, { isComponent: true });
  const mlbl = node("text", "Label", 10, 10, 100, 20, { text: "OK" });
  master.children.push(mlbl);
  r.children.push(master);
  engine.dispatch({ type: "select", ids: [master.id] });
  engine.dispatch({ type: "makeComponent" });
  const cid = find(r, master.id).componentId;
  const inst = node("frame", "B", 200, 0, 120, 40, { componentId: cid, isComponent: false });
  const ilbl = node("text", "Label", 10, 10, 100, 20, { text: "OK", componentId: cid });
  inst.children.push(ilbl);
  r.children.push(inst);

  engine.dispatch({ type: "patch", id: ilbl.id, patch: { text: "Cancel" } });
  t("instance text override stores on child", find(r, ilbl.id).text === "Cancel");
}

console.log(`\n${pass} passed, ${fail} failed`);
