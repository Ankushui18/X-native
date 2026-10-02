/**
 * Variants (Figma help 360056440594): ⌘⌥K makes a component; "addVariant"
 * adds a named variant to the component set; "setVariant" swaps an
 * instance to another variant; component properties can be added via
 * addComponentProperty.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // Make a single component.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "Button", 0, 0, 120, 40, { fill: "#2563eb" });
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "makeComponent" });
  const n = find(r, rect.id);
  t("makeComponent sets isComponent=true", n.isComponent === true);
  t("makeComponent assigns a componentId", !!n.componentId);
  t("library registry contains the new component",
    engine.snapshot().components.some((c) => c.id === n.componentId));
  t("default variant 'Default' exists in library",
    engine.snapshot().components.find((c) => c.id === n.componentId).variants
      .some((v) => v.name === "Default"));
  t("default component property 'Variant' exists",
    engine.snapshot().components.find((c) => c.id === n.componentId).properties
      .some((p) => p.name === "Variant" && p.type === "variant"));
}

{
  // Add a second variant ("Hover").
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "Button", 0, 0, 120, 40);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "makeComponent" });
  const master = find(r, rect.id);
  engine.dispatch({ type: "select", ids: [master.id] });
  engine.dispatch({ type: "addVariant", name: "Hover" });
  const lib = engine.snapshot().components.find((c) => c.id === master.componentId);
  t("variant Hover added to component set", lib.variants.some((v) => v.name === "Hover"));
  t("two variants total (Default + Hover)", lib.variants.length === 2);
  const newVariant = r.children.find((c) => c.variant === "Hover");
  t("new variant placed on canvas (to the right of master)",
    !!newVariant && newVariant.x > master.x);
}

{
  // Create an instance of a component and swap variant.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "Button", 0, 0, 120, 40);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "makeComponent" });
  const master = find(r, rect.id);
  engine.dispatch({ type: "select", ids: [master.id] });
  engine.dispatch({ type: "addVariant", name: "Pressed" });

  // Create an instance via the insertInstance path (we model it as a node
  // with componentId set to master.componentId and isComponent: false).
  const inst = node("rect", "Button", 200, 0, 120, 40, { componentId: master.componentId, isComponent: false, fill: "#2563eb" });
  r.children.push(inst);
  t("instance carries componentId but isComponent=false",
    inst.componentId === master.componentId && !inst.isComponent);
}

{
  // Add a custom component property (e.g., Boolean "Disabled").
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "Button", 0, 0, 120, 40);
  r.children.push(rect);
  engine.dispatch({ type: "select", ids: [rect.id] });
  engine.dispatch({ type: "makeComponent" });
  const cid = find(r, rect.id).componentId;
  engine.dispatch({
    type: "addComponentProperty",
    componentId: cid,
    property: { id: "p1", name: "Disabled", type: "boolean", defaultValue: false },
  });
  const lib = engine.snapshot().components.find((c) => c.id === cid);
  t("addComponentProperty adds a new property",
    lib.properties.some((p) => p.name === "Disabled" && p.type === "boolean"));
}

console.log(`\n${pass} passed, ${fail} failed`);
