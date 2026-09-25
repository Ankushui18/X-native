/**
 * Headless checks for Phase 5 (P1.9/P1.10): the subtree code generator —
 * layout inference, token resolution, component mappings, and emitters.
 *
 * Run with:  npx vite-node src/engine/__tests__/codegen.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import {
  buildCodeTree,
  computeMasterHash,
  cssVarFor,
  generateAndroidXml,
  generateSubtreeCode,
  generateTailwindTheme,
  generateUIKitCode,
  inferLayout,
  isInstance,
  mappingFor,
  mappingSyncStatus,
  slugify,
  toPascal,
} from "../codegen.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const rootOf = (e) => snapOf(e).pages[snapOf(e).page].root;
const sel = (e) => snapOf(e).selection[0];
const FLEX = { direction: "vertical", gap: 8, padding: [16, 16, 16, 16], sizing: "hug", cross: "fill", wrap: false, align: "center", justify: "min" };

/** A frame with two children; returns { frame, kids } node ids. */
function cardDoc(e, layout = FLEX) {
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 320, h: 200, extra: { name: "Card" } });
  const frame = sel(e);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 40, parent: frame, extra: { name: "Thumb" } });
  const a = sel(e);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 48, w: 200, h: 20, parent: frame, extra: { name: "Title", text: "Hello" } });
  const b = sel(e);
  if (layout) e.dispatch({ type: "autoLayout", id: frame, layout });
  return { frame, a, b };
}

console.log("P5-A layout inference:");
{
  const e = new MemoryEngine(false);
  const { frame, a } = cardDoc(e);
  const f = find(rootOf(e), frame);
  t("flex frame infers flex", inferLayout(f).kind === "flex");
  t("vertical maps to column", inferLayout(f).direction === "column");
  t("leaf infers none", inferLayout(find(rootOf(e), a)).kind === "none");

  const e2 = new MemoryEngine(false);
  const g = cardDoc(e2, null);
  t("freeform frame infers absolute", inferLayout(find(rootOf(e2), g.frame)).kind === "absolute");

  const e3 = new MemoryEngine(false);
  const h = cardDoc(e3, { ...FLEX, direction: "grid", columns: 2, gapCols: 12, gapRows: 20 });
  t("grid direction infers grid", inferLayout(find(rootOf(e3), h.frame)).kind === "grid");

  t("slugify basic", slugify("Primary Button!") === "primary-button");
  t("slugify empty falls back", slugify("!!!") === "layer");
  t("toPascal basic", toPascal("my card") === "MyCard");
  t("cssVarFor slashes", cssVarFor("Brand", "brand/primary") === "--brand-brand-primary");
}

console.log("P5-A css emitter:");
{
  const e = new MemoryEngine(false);
  const { frame } = cardDoc(e);
  const css = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e) });
  t("flex container rules", css.includes("display: flex;") && css.includes("flex-direction: column;"));
  t("gap resolves to built-in token", css.includes("gap: var(--spacing-spacing-sm);"));
  t("padding literal", css.includes("padding: 16px 16px 16px 16px;"));
  t("align center", css.includes("align-items: center;"));
  t("child class emitted", css.includes(".thumb {") && css.includes(".title {"));
  t("text content not in css", !css.includes("Hello"));
  t("font rules for text", css.includes("font-size:") && css.includes("font-weight:"));

  const ab = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e), maxDepth: 0 });
  t("maxDepth 0 renders root only", ab.includes(".card {") && !ab.includes(".thumb"));

  const e2 = new MemoryEngine(false);
  const g = cardDoc(e2, null);
  const abs = generateSubtreeCode(find(rootOf(e2), g.frame), { format: "css", snap: snapOf(e2) });
  t("absolute parent is relative", abs.includes("position: relative;"));
  t("absolute child placed", abs.includes("position: absolute;") && abs.includes("top: 48px;"));

  const e3 = new MemoryEngine(false);
  const h = cardDoc(e3, { ...FLEX, direction: "grid", columns: 2, gapCols: 12, gapRows: 20 });
  const grid = generateSubtreeCode(find(rootOf(e3), h.frame), { format: "css", snap: snapOf(e3) });
  t("grid columns", grid.includes("grid-template-columns: repeat(2, 1fr);"));
  t("grid row/col gaps", grid.includes("gap: 20px 12px;"));

  const rem = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e), unit: "rem" });
  t("rem units", rem.includes("width: 20rem;") && rem.includes("padding: 1rem 1rem 1rem 1rem;"));
}

console.log("P5-A style fidelity:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100, extra: { name: "Card" } });
  const frame = sel(e);
  e.dispatch({ type: "add", kind: "rect", x: 8, y: 8, w: 64, h: 32, parent: frame, extra: { name: "Pill", fill: "#ff0000", cornerRadii: [8, 8, 8, 8] } });
  const pill = sel(e);
  const css = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e) });
  t("fill literal", css.includes("background: #ff0000;"));
  t("radius resolves to first matching token", css.includes("border-radius: var(--spacing-spacing-sm);"));

  // Duplicate names dedupe.
  e.dispatch({ type: "add", kind: "rect", x: 8, y: 48, w: 64, h: 32, parent: frame, extra: { name: "Pill" } });
  const css2 = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e) });
  t("class names dedupe", css2.includes(".pill {") && css2.includes(".pill-2 {"));

  // Vector children carry an honest note, not fake CSS.
  e.dispatch({ type: "add", kind: "vector", x: 0, y: 0, w: 10, h: 10, parent: frame, extra: { name: "Mark" } });
  const css3 = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e) });
  t("vector note", css3.includes("export the layer as SVG"));

  // Truncated text clamps.
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 100, h: 20, parent: frame, extra: { name: "T", text: "x", truncate: true, maxLines: 2 } });
  const css4 = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e) });
  t("line clamp", css4.includes("-webkit-line-clamp: 2;"));
  void pill;
}

console.log("P5-A tokens → code:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "addCollection", name: "Brand" });
  const col = snapOf(e).variableCollections.find((c) => c.name === "Brand").id;
  e.dispatch({ type: "addVariable", variable: { id: "v-red", name: "brand/primary", type: "color", value: "#ff0000", collection: col } });
  e.dispatch({ type: "addVariable", variable: { id: "v-gap", name: "space/md", type: "number", value: 8, collection: col } });
  const { frame, a } = cardDoc(e);
  e.dispatch({ type: "bindVariable", id: a, prop: "fill", variableId: "v-red" });
  const css = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e) });
  t("bound fill emits var", css.includes("background: var(--brand-brand-primary);"));
  t("value-matched gap emits var", css.includes("gap: var(--spacing-spacing-sm);"));
  // Binding wins even when the value drifts from the variable.
  e.dispatch({ type: "patchVariable", id: "v-red", patch: { value: "#00ff00" } });
  const cssDrift = generateSubtreeCode(find(rootOf(e), frame), { format: "css", snap: snapOf(e) });
  t("binding survives value drift", cssDrift.includes("background: var(--brand-brand-primary);"));

  const tw = generateSubtreeCode(find(rootOf(e), frame), { format: "tailwind", snap: snapOf(e) });
  t("tailwind bound fill", tw.includes("bg-[var(--brand-brand-primary)]"));

  const theme = generateTailwindTheme(snapOf(e));
  t("theme has colors", theme.includes('"brand-primary": "var(--brand-brand-primary)"'));
  t("theme has spacing", theme.includes('"space-md": "var(--brand-space-md)"'));
  t("empty theme notes", generateTailwindTheme(null).includes("No variables"));
}

console.log("P5-A framework emitters:");
{
  const e = new MemoryEngine(false);
  const { frame } = cardDoc(e);
  const node = () => find(rootOf(e), frame);
  const tsx = generateSubtreeCode(node(), { format: "tsx", snap: snapOf(e) });
  t("tsx component shell", tsx.includes("export const Card: React.FC") && tsx.includes("style={{"));
  t("tsx text content", tsx.includes(">Hello</span>"));
  t("tsx inline flex", tsx.includes('display: "flex"'));

  const html = generateSubtreeCode(node(), { format: "html", snap: snapOf(e) });
  t("html markup + style", html.includes('<div class="card">') && html.includes("<style>"));

  const tw = generateSubtreeCode(node(), { format: "tailwind", snap: snapOf(e) });
  t("tailwind utilities", tw.includes("flex flex-col") && tw.includes("gap-[var(--spacing-spacing-sm)]"));

  const vue = generateSubtreeCode(node(), { format: "vue", snap: snapOf(e) });
  t("vue sfc", vue.includes("<template>") && vue.includes("<style scoped>"));

  const svelte = generateSubtreeCode(node(), { format: "svelte", snap: snapOf(e) });
  t("svelte block", svelte.includes("<style>") && svelte.includes('class="card"'));
}

console.log("P5-B component → code mapping:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 120, h: 40, extra: { name: "Button" } });
  const rect = sel(e);
  e.dispatch({ type: "select", ids: [rect] });
  e.dispatch({ type: "makeComponent" });
  const master = snapOf(e).components[snapOf(e).components.length - 1];
  e.dispatch({ type: "placeComponent", id: master.id, x: 10, y: 10 });
  const inst = find(rootOf(e), sel(e));
  t("placed copy is an instance", isInstance(inst));
  t("master is not an instance", !isInstance(find(rootOf(e), rect)));

  // Unmapped instances expand inline with a note.
  const plain = generateSubtreeCode(inst, { format: "css", snap: snapOf(e) });
  t("unmapped expands", plain.includes("unmapped instance"));

  e.dispatch({
    type: "setCodeMapping",
    componentId: master.id,
    mapping: {
      id: "m1", framework: "react", componentName: "Button", importPath: "./Button",
      props: [{ prop: "Variant", codeProp: "variant", kind: "prop" }],
    },
  });
  const lib = snapOf(e).components.find((c) => c.id === master.id);
  t("mapping stored", lib.codeMappings?.length === 1);
  t("mappingFor finds react", mappingFor(lib, "tsx")?.componentName === "Button");
  t("mappingFor falls back (vue→html→react)", mappingFor(lib, "vue")?.componentName === "Button");
  t("sync never before check", mappingSyncStatus(lib, lib.codeMappings[0]) === "never");

  const tsx = generateSubtreeCode(find(rootOf(e), sel(e)), { format: "tsx", snap: snapOf(e) });
  t("mapped instance is a tag", tsx.includes("<Button") && tsx.includes('variant="Default"'));
  t("mapped import emitted", tsx.includes('import { Button } from "./Button"'));

  const vue = generateSubtreeCode(find(rootOf(e), sel(e)), { format: "vue", snap: snapOf(e) });
  t("vue import style", vue.includes('import Button from "./Button"'));

  e.dispatch({ type: "syncCodeMapping", componentId: master.id, mappingId: "m1" });
  const lib2 = snapOf(e).components.find((c) => c.id === master.id);
  t("sync marks synced", mappingSyncStatus(lib2, lib2.codeMappings[0]) === "synced");
  t("hash is stable", computeMasterHash(lib2) === computeMasterHash(lib2));

  // Editing the master (re-synced via makeComponent) drifts the mapping.
  e.dispatch({ type: "patch", id: rect, patch: { fill: "#00ff00" } });
  e.dispatch({ type: "select", ids: [rect] });
  e.dispatch({ type: "makeComponent" });
  const lib3 = snapOf(e).components.find((c) => c.id === master.id);
  t("master edit marks stale", mappingSyncStatus(lib3, lib3.codeMappings[0]) === "stale");

  e.dispatch({ type: "deleteCodeMapping", componentId: master.id, mappingId: "m1" });
  t("mapping deleted", (snapOf(e).components.find((c) => c.id === master.id).codeMappings ?? []).length === 0);
  e.dispatch({ type: "undo" });
  t("mapping delete undoes", snapOf(e).components.find((c) => c.id === master.id).codeMappings?.length === 1);
}

console.log("P5-A native single-node emitters:");
{
  const e = new MemoryEngine(false);
  const { frame, a, b } = cardDoc(e);
  const kit = generateUIKitCode(find(rootOf(e), frame));
  t("uikit stack view", kit.includes("UIStackView()") && kit.includes("axis = .vertical"));
  t("uikit spacing", kit.includes("spacing = 8"));
  const label = generateUIKitCode(find(rootOf(e), b));
  t("uikit label", label.includes("UILabel()") && label.includes('text = "Hello"'));
  const pill = generateUIKitCode(find(rootOf(e), a));
  t("uikit view frame", pill.includes("UIView()") && pill.includes("CGRect("));

  const lin = generateAndroidXml(find(rootOf(e), frame));
  t("xml linear layout", lin.includes("<LinearLayout") && lin.includes('orientation="vertical"'));
  const tv = generateAndroidXml(find(rootOf(e), b));
  t("xml text view", tv.includes("<TextView") && tv.includes('android:text="Hello"'));
  const vw = generateAndroidXml(find(rootOf(e), a));
  t("xml view size", vw.includes("<View") && vw.includes('layout_width="100dp"'));
}

console.log(`codegen: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
