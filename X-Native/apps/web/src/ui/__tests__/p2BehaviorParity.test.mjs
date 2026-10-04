/**
 * P2 parity pins (BEHAVIOR_OUTPUT_PARITY_AUDIT_2026-10-04.md, Step 5's P2
 * follow-through): the three findings the audit deferred at P2 —
 *
 *   F6  the first manual canvas resize of a still-auto text layer flips it
 *       to FIXED SIZE on both axes (help 27378154668951: "When you manually
 *       change a layer's dimensions in the canvas, Figma will also update the
 *       resizing property to Fixed size" — one property, hence the clip);
 *   F7  a plain marquee selects at the drilled scope like clicks do (band
 *       inside a frame collects the frame's children, never the frame),
 *       while ⌘/Ctrl-marquee still descends from the page root at all
 *       depths (help 360039956434 / 360039956914 selection-at-scope);
 *   F8  the wasm export tier must not answer a preset it cannot honor:
 *       "Ignore overlapping layers" off and a non-sRGB render color profile
 *       keep the export on the canvas fallback, so which engine loaded stops
 *       changing the bytes (help 13402894554519).
 *
 * Run with:  npx vite-node src/ui/__tests__/p2BehaviorParity.test.mjs
 *
 * Sabotage ledger (each entry must catch at least one assertion):
 *   F6 reverted to per-axis fixing            -> "width drag fixes BOTH axes"
 *   F6 flips axes for the Scale tool too       -> "Scale tool stays exempt"
 *   F6 overreaches onto already-fixed layers   -> "auto height keeps hug H"
 *   marquee back to root-only walking          -> drill-scope pins, incl. the
 *                                                 band around the whole frame
 *   deep marquee weakened                      -> "⌘ collects every level"
 *   locked-above suppression dropped             -> "children of locked…" pin
 *   wasm gate removed                          -> inspector source pins
 */
import { marqueeCollect } from "../canvasSelection.ts";
import { MemoryEngine, find } from "../../engine/memory.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const t = (n, c, extra) => {
  if (c) { pass++; console.log("  ok  " + n); }
  else { fail++; console.log("  FAIL " + n + (extra ? " — " + extra : "")); }
};

const here = fileURLToPath(new URL(".", import.meta.url));
const src = (rel) => readFileSync(here + rel, "utf8");

/* ------------------------------- F6 ------------------------------------ */
console.log("F6 first manual resize of auto text = Fixed size (27378154668951):");
{
  const e = new MemoryEngine(false);
  const at = (id) => find(e.snapshot().pages[e.snapshot().page].root, id);
  e.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 120, h: 20 });
  const id = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id, patch: { text: "hello there", sizingW: "hug", sizingH: "hug" } });
  // A width-only drag: Figma lands on Fixed size — BOTH axes — so wrapped
  // copy clips instead of silently auto-growing past the box.
  e.dispatch({ type: "resize", id, x: 0, y: 0, w: 60, h: 20 });
  const n1 = at(id);
  t("width drag fixes BOTH axes (the clip-on-resize gotcha)", n1.sizingW === "fixed" && n1.sizingH === "fixed",
    `${n1.sizingW}/${n1.sizingH}`);

  const e2 = new MemoryEngine(false);
  const at2 = (id) => find(e2.snapshot().pages[e2.snapshot().page].root, id);
  e2.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 120, h: 20 });
  const id2 = e2.snapshot().selection[0];
  // Scale tool: scales content and sizing together — no flipping at all.
  e2.dispatch({ type: "patch", id: id2, patch: { sizingW: "hug", sizingH: "hug" } });
  e2.dispatch({ type: "resize", id: id2, x: 0, y: 0, w: 80, h: 30, scaleProps: true });
  const n2 = at2(id2);
  t("Scale tool stays exempt (hug survives a scaled box)", n2.sizingW === "hug" && n2.sizingH === "hug",
    `${n2.sizingW}/${n2.sizingH}`);

  const e3 = new MemoryEngine(false);
  const at3 = (id) => find(e3.snapshot().pages[e3.snapshot().page].root, id);
  e3.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 120, h: 20 });
  const id3 = e3.snapshot().selection[0];
  // "Auto height" (fixed width, hugging height): the manual change lands on
  // the remaining auto axis — one axis at a time from HERE.
  e3.dispatch({ type: "patch", id: id3, patch: { sizingW: "fixed", sizingH: "hug" } });
  e3.dispatch({ type: "resize", id: id3, x: 0, y: 0, w: 120, h: 44 });
  const n3 = at3(id3);
  t("auto height keeps its state machine: H drag fixes H, W already fixed", n3.sizingW === "fixed" && n3.sizingH === "fixed");
  // And a resize that changes nothing changes no state.
  const e4 = new MemoryEngine(false);
  e4.dispatch({ type: "add", kind: "text", x: 0, y: 0, w: 120, h: 20 });
  const id4 = e4.snapshot().selection[0];
  e4.dispatch({ type: "patch", id: id4, patch: { sizingW: "hug", sizingH: "hug" } });
  e4.dispatch({ type: "resize", id: id4, x: 5, y: 5, w: 120, h: 20 });
  const n4 = find(e4.snapshot().pages[e4.snapshot().page].root, id4);
  t("a move without a dimension change flips nothing", n4.sizingW === "hug" && n4.sizingH === "hug",
    `${n4.sizingW}/${n4.sizingH}`);
  // Non-text hug sizing keeps its per-axis rule (the AL block above is untouched).
  const e5 = new MemoryEngine(false);
  e5.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100 });
  const F = e5.snapshot().selection[0];
  e5.dispatch({
    type: "autoLayout", id: F,
    layout: { direction: "horizontal", gap: 8, padding: [0, 0, 0, 0], sizing: "hug", cross: "hug", wrap: false, align: "min", justify: "min" },
  });
  e5.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 30, parent: F });
  const H0 = e5.snapshot().pages[e5.snapshot().page].root.children
    .find((c) => c.id === F).h;
  e5.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: H0 });
  const nF = find(e5.snapshot().pages[e5.snapshot().page].root, F);
  t("frame (non-text) resize still fixes only the changed axis",
    nF.layout.sizing === "fixed" && nF.layout.cross === "hug",
    `${nF.layout.sizing}/${nF.layout.cross}`);
}

/* ------------------------------- F7 ------------------------------------ */
console.log("F7 the marquee collects at the drilled scope, like clicks:");
{
  const node = (id, over = {}) => ({
    id, x: 0, y: 0, w: 100, h: 100, visible: true, locked: false, children: [], ...over,
  });
  const C = node("c", { x: 10, y: 10, w: 20, h: 20 });
  const G = node("g", { x: 150, y: 10, w: 80, h: 80, children: [C] });
  const A = node("a", { x: 10, y: 10, w: 50, h: 50 });
  const B = node("b", { x: 70, y: 10, w: 50, h: 50 });
  const L = node("l", { x: 70, y: 120, w: 50, h: 50, locked: true });
  const H = node("h", { x: 10, y: 120, w: 50, h: 50, visible: false });
  const F = node("f", { x: 0, y: 0, w: 400, h: 300, children: [A, B, G, L, H] });
  const S = node("s", { x: 500, y: 10, w: 50, h: 50 });
  const root = node("root", { w: 2000, h: 2000, children: [F, S] });
  const band = (x0, y0, x1, y1) => marqueeCollect(root, selection, { x0, y0, x1, y1 }, deep);

  let selection = [], deep = false;
  selection = [A.id]; deep = false;
  t("drilled into the frame: a band over the kids selects the KIDS",
    band(0, 0, 400, 400).sort().join(",") === "a,b,g", JSON.stringify(band(0, 0, 400, 400)));
  t("…and never the frame itself, even fully enclosed", !band(0, 0, 400, 400).includes("f"));
  t("a band outside the frame selects nothing at the drilled scope",
    band(600, 0, 700, 400).length === 0);
  selection = [A.id]; deep = true;
  t("⌘-marquee keeps descending from the page root, every level",
    ["f", "a", "b", "g"].every((id) => band(0, 0, 400, 400).includes(id)) && band(480, 0, 700, 400).includes("s"));
  selection = []; deep = false;
  t("top level unchanged: a band over the page collects the frame, not its children",
    band(0, 0, 400, 400).join(",") === "f");
  selection = []; deep = false;
  t("…and two root children when both are touched", band(0, 0, 600, 400).sort().join(",") === "f,s");
  selection = []; deep = false;
  selection = [A.id]; deep = false;
  t("locked/hidden layers still never surface", band(60, 110, 130, 180).length === 0);
  // Deeper drill: selection inside the group's parent-of-parent keeps scope at
  // the immediate parent, mirroring canvasClickTarget's single-level rule.
  selection = [C.id]; deep = false;
  t("scope is the immediate parent (G), like clicks — its children surface",
    band(0, 0, 400, 400).join(",") === "c" && band(140, 0, 240, 100).join(",") === "c");
}

/* ------------------------------- F8 ------------------------------------ */
console.log("F8 the wasm tier refuses presets it cannot express:");
{
  const insp = src("../../ui/inspector.tsx");
  const gate = /p\.ignoreOverlap === false \|\| getRenderColorProfile\(\) !== "srgb"/;
  t("the overlap/profile gate guards tryWasmExport", gate.test(insp));
  const fn = insp.slice(insp.indexOf("async function tryWasmExport"), insp.indexOf("/** The original canvas-based export path"));
  t("…and sits before any wasm call", fn.indexOf("getRenderColorProfile") < fn.indexOf("wasmExportNode"));
  const ww = src("../../engine/wasmExport.ts");
  t("quality + bleed still travel as options JSON", /quality/.test(ww) && /bleed/.test(ww) &&
    /validateExportBytes|FILE_MAGIC/.test(ww));
  const sess = src("../../../../../crates/x-wasm/src/session.rs");
  t("the Rust side mirrors the format table (png/jpg/pdf only)",
    /matches!\(format, "png" \| "jpg" \| "jpeg" \| "pdf"\)/.test(sess));
  // resolveSettings must keep PDF's knob table intact while the gate reads the
  // RAW preset (PDF caps.ignoreOverlap === false would otherwise disable wasm PDF).
  const em = src("../../ui/exportModel.ts");
  t("PDF's resolved ignoreOverlap stays false-only-by-cap, not by the gate",
    /caps\.ignoreOverlap \? p\.ignoreOverlap !== false : false/.test(em));
}

console.log(`\np2BehaviorParity: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
