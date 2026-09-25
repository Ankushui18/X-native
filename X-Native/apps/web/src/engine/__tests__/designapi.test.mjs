/**
 * Headless checks for Phase 5 (P1.11): the design API — envelopes, routing,
 * pagination/filtering, and per-method shapes.
 *
 * Run with:  npx vite-node src/engine/__tests__/designapi.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import { apiCall, describeApi, DESIGN_API_VERSION } from "../designApi.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const rootOf = (e) => snapOf(e).pages[snapOf(e).page].root;
const sel = (e) => snapOf(e).selection[0];
const call = (e, method, params) => apiCall(snapOf(e), method, params);
const unwrap = (r) => (r.ok ? r.data : (() => { throw new Error(JSON.stringify(r.error)); })());

function demoDoc() {
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 320, h: 200, extra: { name: "Card" } });
  const frame = sel(e);
  e.dispatch({ type: "add", kind: "rect", x: 16, y: 16, w: 100, h: 40, parent: frame, extra: { name: "Thumb", fill: "#ff0000" } });
  const thumb = sel(e);
  e.dispatch({ type: "add", kind: "text", x: 16, y: 64, w: 200, h: 20, parent: frame, extra: { name: "Title", text: "Hello" } });
  const title = sel(e);
  e.dispatch({ type: "autoLayout", id: frame, layout: { direction: "vertical", gap: 8, padding: [16, 16, 16, 16], sizing: "hug", cross: "fill", wrap: false, align: "min", justify: "min" } });
  e.dispatch({ type: "select", ids: [thumb] });
  return { e, frame, thumb, title };
}

console.log("P5-D router + envelope:");
{
  const { e } = demoDoc();
  const bad = call(e, "nope");
  t("unknown method is UNSUPPORTED", !bad.ok && bad.error.code === "UNSUPPORTED");
  const missing = call(e, "getNode", { id: "ghost" });
  t("missing node is NOT_FOUND", !missing.ok && missing.error.code === "NOT_FOUND");
  const noArgs = call(e, "getNode", {});
  t("missing id is BAD_ARGS", !noArgs.ok && noArgs.error.code === "BAD_ARGS");
  const desc = describeApi();
  t("catalog versioned", desc.version === DESIGN_API_VERSION);
  t("catalog covers routes", Object.keys(desc.methods).length >= 25);
  t("envelope documented", desc.envelope.includes("ok: false"));
}

console.log("P5-D selection + layers:");
{
  const { e, frame, thumb, title } = demoDoc();
  const s = unwrap(call(e, "getSelection"));
  t("selection count", s.count === 1 && s.ids[0] === thumb);

  const n = unwrap(call(e, "getNode", { id: title }));
  t("node summary shape", n.summary.name === "Title" && n.summary.kind === "text");
  const deep = unwrap(call(e, "getNode", { id: frame, depth: 1 }));
  t("node depth expands", deep.summary.children?.length === 2);
  const full = unwrap(call(e, "getNode", { id: frame, full: true }));
  t("full node attached", full.full?.layout?.direction === "vertical");

  const layers = unwrap(call(e, "getLayers", { parent: frame }));
  t("layers list children", layers.total === 2 && layers.parent === frame);
  const texts = unwrap(call(e, "getLayers", { parent: frame, kind: "text" }));
  t("layers kind filter", texts.total === 1 && texts.items[0].name === "Title");
  const paged = unwrap(call(e, "getLayers", { parent: frame, limit: 1, offset: 1 }));
  t("layers paginate", paged.items.length === 1 && paged.total === 2 && paged.offset === 1);

  const found = unwrap(call(e, "findNodes", { under: frame, name: "tit" }));
  t("find by name substring", found.total === 1 && found.items[0].id === title);
  const exact = unwrap(call(e, "findNodes", { under: frame, nameIs: "Title" }));
  t("find by exact name", exact.total === 1);
  const kinds = unwrap(call(e, "findNodes", { kind: "rect" }));
  t("find by kind", kinds.total >= 1 && kinds.items.every((x) => x.kind === "rect"));
  const under = unwrap(call(e, "findNodes", { under: frame, kind: "text" }));
  t("find under subtree", under.total === 1);
  const sized = unwrap(call(e, "findNodes", { minW: 300 }));
  t("find by size", sized.items.every((x) => x.w >= 300));
}

console.log("P5-D variables + tokens:");
{
  const { e, thumb } = demoDoc();
  e.dispatch({ type: "addCollection", name: "Brand" });
  const col = snapOf(e).variableCollections.find((c) => c.name === "Brand").id;
  void col;
  e.dispatch({ type: "addVariable", variable: { id: "v-red", name: "brand/primary", type: "color", value: "#ff0000", collection: "Brand" } });
  e.dispatch({ type: "bindVariable", id: thumb, prop: "fill", variableId: "v-red" });

  const vars = unwrap(call(e, "getVariables"));
  t("variables listed", vars.total >= 6);
  const brand = unwrap(call(e, "getVariables", { collection: "Brand" }));
  t("variables filter by collection", brand.items.every((v) => v.collection === "Brand"));
  const one = unwrap(call(e, "getVariable", { id: "v-red" }));
  t("variable cssVar", one.cssVar === "--brand-brand-primary" && one.value === "#ff0000");
  const byName = unwrap(call(e, "getVariable", { id: "brand/primary" }));
  t("variable by name", byName.id === "v-red");

  const usage = unwrap(call(e, "getVariableUsage", { id: "v-red" }));
  t("binding usage found", usage.items.some((u) => u.nodeId === thumb && u.match === "binding"));
  const tokens = unwrap(call(e, "getTokens", { type: "color" }));
  t("tokens alias filters", tokens.items.every((x) => x.type === "color"));
  const tuse = unwrap(call(e, "getTokenUsage", { id: "v-red" }));
  t("token usage alias", tuse.total === usage.total);
}

console.log("P5-D components:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 120, h: 40, extra: { name: "Button" } });
  const rect = sel(e);
  e.dispatch({ type: "select", ids: [rect] });
  e.dispatch({ type: "makeComponent" });
  const master = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "placeComponent", id: master.id, x: 10, y: 10 });
  const inst = sel(e);
  e.dispatch({
    type: "setCodeMapping", componentId: master.id,
    mapping: { id: "m1", framework: "react", componentName: "Button", importPath: "./Button", props: [{ prop: "Variant", codeProp: "variant", kind: "prop" }] },
  });

  const comps = unwrap(call(e, "getComponents"));
  t("components listed", comps.total >= 1);
  const comp = unwrap(call(e, "getComponent", { id: master.id }));
  t("component shape", comp.name === "Button" && comp.mappings.length === 1);
  const insts = unwrap(call(e, "getInstances", { id: master.id }));
  t("instances found", insts.total === 1 && insts.items[0].id === inst);
  const props = unwrap(call(e, "getComponentProperties", { id: inst }));
  t("instance live props", props.instanceId === inst && props.properties.length >= 1);
  const defs = unwrap(call(e, "getComponentProperties", { id: master.id }));
  t("master default props", defs.instanceId === undefined);
  const variants = unwrap(call(e, "getVariants", { id: master.id }));
  t("variants listed", variants.variants.includes("Default"));

  const maps = unwrap(call(e, "getCodeMapping", { id: master.id }));
  t("mapping data", maps[0].component === "Button" && maps[0].sync === "never");
  const fw = unwrap(call(e, "getCodeMapping", { id: master.id, framework: "vue" }));
  t("mapping framework filter", fw.length === 0);
  const cc = unwrap(call(e, "getCodeComponent", { id: inst }));
  t("code component resolved", cc.mapped && cc.component === "Button" && cc.props[0].name === "variant");
  const plain = unwrap(call(e, "getCodeComponent", { id: rect }));
  t("non-instance unmapped", !plain.mapped && plain.reason === "not-an-instance");
}

console.log("P5-D layout, paint, type, assets:");
{
  const { e, frame, thumb, title } = demoDoc();
  const al = unwrap(call(e, "getAutoLayout", { id: frame }));
  t("auto layout + inferred", al.layout.direction === "vertical" && al.inferred === "flex");
  const alc = unwrap(call(e, "getAutoLayout", { id: thumb }));
  t("leaf has no layout", alc.layout === null && alc.inferred === "none");
  const con = unwrap(call(e, "getConstraints", { id: thumb }));
  t("constraints shape", "horizontal" in con && "vertical" in con);

  // Place the title right of the thumb for a known gap.
  e.dispatch({ type: "select", ids: [title] });
  const gap = unwrap(call(e, "getSpacing", { a: thumb, b: title }));
  t("spacing numbers", typeof gap.horizontal === "number" && typeof gap.vertical === "number");

  const colors = unwrap(call(e, "getColors"));
  t("colors inventoried", colors.items.some((c) => c.color === "#ff0000"));
  const type = unwrap(call(e, "getTypography"));
  t("typography inventoried", type.total >= 1 && type.items[0].count >= 1);
  const assets = unwrap(call(e, "getAssets"));
  t("assets shape", Array.isArray(assets.images) && assets.fonts.length >= 1);
  const ann = unwrap(call(e, "getAnnotations"));
  t("annotations listed", ann.total >= 0);
  const ver = unwrap(call(e, "getDesignVersion"));
  t("version counts", ver.nodes >= 3 && ver.pages >= 1);
}

console.log("P5-D generateCode:");
{
  const { e, frame, thumb } = demoDoc();
  const tree = unwrap(call(e, "generateCode", { id: frame, format: "html" }));
  t("html tree", tree.scope === "subtree" && tree.code.includes("<style>"));
  const layer = unwrap(call(e, "generateCode", { id: thumb, format: "css", scope: "layer" }));
  t("css layer", layer.scope === "layer" && layer.code.includes("background: #ff0000;"));
  const def = unwrap(call(e, "generateCode", { id: frame }));
  t("default format tsx", def.format === "tsx" && def.code.includes("React.FC"));
  const badFmt = call(e, "generateCode", { id: frame, format: "uikit" });
  t("bad format is UNSUPPORTED", !badFmt.ok && badFmt.error.code === "UNSUPPORTED");
  const rem = unwrap(call(e, "generateCode", { id: frame, format: "css", unit: "rem" }));
  t("rem through api", rem.code.includes("width: 20rem;"));
}

console.log(`designApi: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
