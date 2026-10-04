/**
 * P3 parity pins (BEHAVIOR_OUTPUT_PARITY_AUDIT_2026-10-04.md, Step 7):
 *
 *   F9  Fill promotion at full width — "Child objects of an auto layout frame
 *       will also be set to Fill container if they are manually resized to the
 *       full available space of the parent frame" (guide 360040451373). A
 *       resize commit landing within a pixel promotes the fixed axis to fill;
 *       a hugging parent, a wrapping flow, and the Scale tool are exempt.
 *   F10 letter spacing carries a unit, like line height: px or a percent of
 *       the font size. `effectiveLetterSpacing` is the single resolver for
 *       measure, paint, SVG export, outlining, and codegen; proportional
 *       scaling leaves the percent number alone (it rides the font size).
 *
 * Run with:  npx vite-node src/ui/__tests__/p3BehaviorParity.test.mjs
 *
 * Sabotage ledger (each entry must catch at least one assertion):
 *   promotion dropped                       -> "resized to the full inner…"
 *   promotion fires on a hugging parent     -> "a hugging parent never promotes"
 *   tolerance lost (exact equality)         -> "one pixel off still promotes"
 *   percent ignored in the resolver         -> every F10 size pin
 *   percent rescaled by the Scale tool      -> "percent tracking survives ×2"
 *   SVG emits the raw percent number        -> "SVG exports the resolved px"
 */
import { effectiveLetterSpacing } from "../textLayout.ts";
import { svgNode } from "../../engine/svgExport.ts";
import { MemoryEngine, find, pickTextStyle } from "../../engine/memory.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const t = (n, c, extra) => {
  if (c) { pass++; console.log("  ok  " + n); }
  else { fail++; console.log("  FAIL " + n + (extra ? " — " + extra : "")); }
};
const here = fileURLToPath(new URL(".", import.meta.url));
const src = (rel) => readFileSync(here + rel, "utf8");

/* ------------------------------- F9 ------------------------------------ */
console.log("F9 full-width resize promotes to Fill container (360040451373):");
{
  const L = (over = {}) => ({
    direction: "horizontal", gap: 0, padding: [0, 0, 0, 0],
    sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min", ...over,
  });
  const setup = (layoutOver = {}, kidW = 100) => {
    const e = new MemoryEngine(false);
    const root = () => e.snapshot().pages[e.snapshot().page].root;
    e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 400, h: 300 });
    const F = root().children.at(-1).id;
    e.dispatch({ type: "autoLayout", id: F, layout: L(layoutOver) });
    e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: kidW, h: 40, parent: F });
    const K = find(root(), F).children.at(-1).id;
    return { e, at: (id) => find(e.snapshot().pages[e.snapshot().page].root, id), F, K };
  };
  {
    const { e, at, F, K } = setup({ padding: [20, 20, 20, 20] });
    e.dispatch({ type: "resize", id: K, x: at(K).x, y: at(K).y, w: 360, h: 40 });
    t("resized to the full inner width, the fixed child becomes Fill", at(K).sizingW === "fill",
      at(K).sizingW);
    void F;
  }
  {
    const { e, at, K } = setup({ padding: [20, 20, 20, 20] });
    e.dispatch({ type: "resize", id: K, x: at(K).x, y: at(K).y, w: 357, h: 40 });
    t("a pixel beyond tolerance stays Fixed", at(K).sizingW === "fixed", at(K).sizingW);
    e.dispatch({ type: "resize", id: K, x: at(K).x, y: at(K).y, w: 359.2, h: 40 });
    t("one pixel off still promotes (the |Δ| ≤ 1 rule)", at(K).sizingW === "fill", at(K).sizingW);
  }
  {
    // Siblings count: inner 400 - 40 padding - 100 sibling - 10 gap = 250.
    const e = new MemoryEngine(false);
    const root = () => e.snapshot().pages[e.snapshot().page].root;
    e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 400, h: 300 });
    const F = root().children.at(-1).id;
    e.dispatch({ type: "autoLayout", id: F, layout: L({ gap: 10, padding: [20, 20, 20, 20] }) });
    e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 40, parent: F });
    e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 120, h: 40, parent: F });
    const B = find(root(), F).children.at(-1).id;
    e.dispatch({ type: "resize", id: B, x: find(root(), B).x, y: 20, w: 250, h: 40 });
    t("available space = inner minus the sibling and the gap", find(root(), B).sizingW === "fill",
      find(root(), B).sizingW);
  }
  {
    const { e, at, K } = setup({ sizing: "hug", cross: "hug" });
    e.dispatch({ type: "resize", id: K, x: at(K).x, y: at(K).y, w: 360, h: 40 });
    t("a hugging parent never promotes (its hug IS the child)", at(K).sizingW !== "fill",
      at(K).sizingW);
  }
  {
    const { e, at, K } = setup({ padding: [20, 20, 20, 20] });
    e.dispatch({ type: "resize", id: K, x: at(K).x, y: at(K).y, w: 100, h: 260 });
    t("cross axis too: full inner height fills the container cross", at(K).sizingH === "fill",
      at(K).sizingH);
  }
  {
    const { e, at, K } = setup({ wrap: true, padding: [20, 20, 20, 20] });
    e.dispatch({ type: "resize", id: K, x: at(K).x, y: at(K).y, w: 360, h: 40 });
    t("wrapping flows are per-line — no promotion", at(K).sizingW === "fixed", at(K).sizingW);
  }
  {
    const { e, at, K } = setup({ padding: [20, 20, 20, 20] });
    e.dispatch({ type: "resize", id: K, x: at(K).x, y: at(K).y, w: 360, h: 40, scaleProps: true });
    t("the Scale tool scales without reinterpreting sizing", at(K).sizingW === "fixed", at(K).sizingW);
  }
  {
    const e = new MemoryEngine(false);
    const root = () => e.snapshot().pages[e.snapshot().page].root;
    e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 400, h: 300 });
    const F = root().children.at(-1).id;
    e.dispatch({ type: "autoLayout", id: F, layout: L({ padding: [20, 20, 20, 20] }) });
    e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 360, h: 40, parent: F });
    const K = find(root(), F).children.at(-1).id;
    e.dispatch({ type: "patch", id: K, patch: { sizingW: "fill" } });
    e.dispatch({ type: "resize", id: K, x: find(root(), K).x, y: 20, w: 180, h: 40 });
    t("shrinking a Fill child off the edge demotes it to Fixed (unchanged rule)",
      find(root(), K).sizingW === "fixed");
  }
}

/* ------------------------------- F10 ----------------------------------- */
console.log("F10 letter spacing takes px or % of the font size (360039956634):");
{
  const node = (over = {}) => ({ fontSize: 16, letterSpacing: 0, ...over });
  t("px is the stored unit, unchanged", effectiveLetterSpacing(node({ letterSpacing: 1.5 })) === 1.5);
  t("negative tracking passes through", effectiveLetterSpacing(node({ letterSpacing: -0.4 })) === -0.4);
  t("percent reads against the font size (5% of 16 = 0.8)",
    Math.abs(effectiveLetterSpacing(node({ letterSpacing: 5, letterSpacingUnit: "percent" })) - 0.8) < 1e-9);
  t("the resolver scales with zoom, unit or not",
    Math.abs(effectiveLetterSpacing(node({ letterSpacing: 5, letterSpacingUnit: "percent" }), 2) - 1.6) < 1e-9);
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
  const svg = svgNode(snode({ letterSpacing: 5, letterSpacingUnit: "percent" }));
  t("SVG exports the resolved px, never a raw percent number",
    svg.includes('letter-spacing="0.8"') && !svg.includes('letter-spacing="5"'),
    String(svg.match(/letter-spacing="[^"]*"/)));
  const px = svgNode(snode({ letterSpacing: 1.5 }));
  t("px tracking still exports as before", px.includes('letter-spacing="1.5"'));
  // Percent tracking is a property OF the font size: proportional scaling
  // must not touch the number (px tracking does scale).
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 120, h: 20 });
  const id = e.snapshot().selection[0];
  const at = (i) => find(e.snapshot().pages[e.snapshot().page].root, i);
  e.dispatch({ type: "patch", id, patch: { letterSpacing: 5, letterSpacingUnit: "percent", sizingW: "fixed", sizingH: "fixed" } });
  e.dispatch({ type: "resize", id, x: 0, y: 0, w: 240, h: 40, scaleProps: true });
  t("percent tracking survives ×2 scaling untouched", Math.abs(at(id).letterSpacing - 5) < 1e-9,
    String(at(id).letterSpacing));
  t("the font size did scale", Math.abs(at(id).fontSize - 32) < 1e-9 || at(id).fontSize === 32,
    String(at(id).fontSize));
  const style = pickTextStyle(at(id));
  t("text styles capture the unit too", style.letterSpacingUnit === "percent");
  // Dev readouts and copied CSS speak the unit (mirror of the Leading row).
  const insp = src("../../ui/inspector.tsx");
  t("the Tracking unit control sits beside the Leading one", insp.includes('Tracking: %') &&
    insp.indexOf("Letter spacing unit") < insp.length);
  t("dev-mode readout prints 5% for a percent layer",
    /letterSpacingUnit === "percent" \? `\$\{n\.letterSpacing\}%`/.test(insp));
  const cg = src("../../engine/codegen.ts");
  t("codegen emits the CSS percent literal (letter-spacing: 5%)", cg.includes('`${n.letterSpacing}%`'));
  const mem = src("../../engine/memory.ts");
  t("text-to-path outlining resolves the unit before advancing glyphs",
    mem.includes("effectiveLetterSpacing(n)"));
}

console.log(`\np3BehaviorParity: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
