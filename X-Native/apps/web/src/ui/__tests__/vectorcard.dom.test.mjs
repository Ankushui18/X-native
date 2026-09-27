/**
 * The inspector's vector card, mounted (IN-U4).
 *
 * `vectorcard.test.mjs` pins the card's *source* contract; this pins what it
 * actually renders and what a click does, in a real DOM (jsdom — see
 * `domEnv.mjs` for what that can and cannot prove). The card was the last
 * bespoke block in the panel: a `<strong>` header, `export-run` buttons resized
 * by inline padding, raw `<input type="number">`s with no accessible name and a
 * hand-written icon row. It is the shared primitives now, and these are the
 * things that would silently break if it drifted back:
 *
 *  - the header is a `Section`, so it folds and persists like every other block;
 *  - the numbers are `Field`s, so they carry arithmetic, a scrub cursor and an
 *    accessible name that does not collide with the layer's own X/Y/radius;
 *  - the two switches are tablists with a real selected tab, and the six
 *    alignment actions are plain buttons that claim no selection;
 *  - every action still dispatches the engine command it did before.
 *
 * Run with:  npx vite-node src/ui/__tests__/vectorcard.dom.test.mjs
 */
import { mountPanel, strayInlineStyles } from "./domEnv.mjs";

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

/* ── the card is there for a vector, and not for anything else ───────────── */

const ui = await mountPanel({ layer: "vector" });
const id = ui.snap().selection[0];
t("a vector layer renders the card", !!ui.one(".vec-card"));

const rect = await mountPanel({ layer: "rect" });
t("a rectangle renders no vector card", !rect.one(".vec-card"));
await rect.unmount();

/* ── the header is the shared Section, not a bespoke one ─────────────────── */

const toggle = ui.one('.h-row .sec-toggle h2');
const headers = ui.all(".h-row .sec-toggle h2").map((h) => h.textContent.trim());
t(`the card is a Section among the others (${headers.slice(0, 6).join(" / ")} …)`, headers.includes("Vector"));
t("no bespoke <strong> header is left", ui.all(".vec-card strong").length === 0);
const chip = ui.one(".h-act .vec-chip");
t(`the action slot carries the chip (${chip?.textContent.trim()})`, chip?.textContent.trim() === "Native Graph");
const editBtn = ui.byText("Edit points", ".h-act button");
t(`and the section's own edit button (${editBtn?.className})`, !!editBtn && /x-btn/.test(editBtn.className));

/* ── styled from the sheet, not inline ───────────────────────────────────── */

const strays = strayInlineStyles(ui.inlineStyles(ui.one(".vec-card")));
t(`the card styles itself from classes (${strays.length} stray inline: ${strays.join(" ") || "none"})`, strays.length === 0);
t("no export-run button is left in the card", ui.all(".vec-card .export-run").length === 0);

/* ── alignment: six one-shot actions, named for what they move ───────────── */

const alignBtns = ui.all(".vec-align .g button");
t(`the alignment row is the panel's .align idiom (${alignBtns.length} buttons in ${ui.all(".vec-align .g").length} groups)`,
  alignBtns.length === 6 && ui.all(".vec-align .g").length === 2);
t(`every action is named (${alignBtns.map((b) => b.getAttribute("aria-label")).length}/6)`,
  alignBtns.every((b) => (b.getAttribute("aria-label") || "").startsWith("Align points")));
t("and none of them claims to be a selected tab",
  alignBtns.every((b) => b.getAttribute("role") !== "tab" && b.getAttribute("aria-selected") === null));

// `addPath` stores a path's points relative to the layer's own box, so the
// assertion is the relation Figma's align promises — every point on the top
// edge — not an absolute coordinate the engine never claimed.
const ysBefore = ui.node(id).path.map((p) => p.y);
await ui.click(ui.byText("Align points top", ".vec-align button"));
const ys = ui.node(id).path.map((p) => p.y);
t(`Align points top puts every point on the top edge (y ${ysBefore.join(",")} → ${ys.join(",")})`,
  ys.every((y) => y === Math.min(...ysBefore)) && new Set(ys).size === 1);

// One idiom, two rows: the card's point alignment and the Position section's
// layer alignment are the same markup (`.align > .g > button`, one icon each,
// no roles), so they read as the same control — and their names stay distinct,
// because what they move is not the same thing. The layer row carries three
// more buttons (distribute ×2, tidy up); the claim is the per-button shape, not
// the count.
const shape = (sel) =>
  [...new Set(ui.all(sel).map((b) => `${b.tagName.toLowerCase()}:${b.children.length}:${b.getAttribute("role")}`))].join("|");
const pointBtns = ui.all(".vec-align .g button");
const layerBtns = ui.all(".align:not(.vec-align) .g button");
t(`both align rows are the same button (${pointBtns.length} points / ${layerBtns.length} layers, shape ${shape(".vec-align .g button")})`,
  pointBtns.length === 6 && layerBtns.length > pointBtns.length &&
    shape(".vec-align .g button") === shape(".align:not(.vec-align) .g button") &&
    shape(".vec-align .g button") === "button:1:null");
const layerLabels = layerBtns.map((b) => b.getAttribute("aria-label"));
t(`and they do not share a name (${layerLabels[0]} vs ${alignBtns[0].getAttribute("aria-label")})`,
  layerLabels.every((l) => !l.startsWith("Align points")) &&
    alignBtns.every((b) => b.getAttribute("aria-label").startsWith("Align points")));

/* ── the two switches are real tablists ──────────────────────────────────── */

const mirror = ui.one('.vec-card .seg[aria-label="Handle mirroring"]');
const mirrorTabs = [...(mirror?.querySelectorAll('button[role="tab"]') ?? [])];
t(`mirroring is a tablist (${mirrorTabs.map((b) => b.textContent.trim()).join(" / ")})`,
  mirror?.getAttribute("role") === "tablist" && mirrorTabs.length === 3);
t(`with the layer's current value selected (${mirrorTabs.find((b) => b.getAttribute("aria-selected") === "true")?.textContent.trim()})`,
  mirrorTabs.find((b) => b.getAttribute("aria-selected") === "true")?.textContent.trim() === "No mirror");
t("and exactly one tab in the focus order",
  mirrorTabs.filter((b) => b.tabIndex === 0).length === 1);

await ui.click(mirrorTabs.find((b) => b.textContent.trim() === "Angle & len"));
t(`picking a mirroring writes the point (mode ${ui.node(id).path[0].mirrorMode})`,
  ui.node(id).path[0].mirrorMode === "angleAndLength");

/* ── the vertex numbers are Fields with names of their own ───────────────── */

const vx = ui.byLabel("Vertex X");
const vy = ui.byLabel("Vertex Y");
const vr = ui.byLabel("Vertex corner radius");
t(`the vertex rows are shared Fields (${[vx, vy, vr].filter(Boolean).length}/3)`, !!vx && !!vy && !!vr);
t("the layer's own X / Y / Corner radius keep their names",
  !!ui.byLabel("X") && !!ui.byLabel("Y") && !!ui.byLabel("Corner radius"));

await ui.type(vx, "12");
t(`typing a vertex X moves that point (${ui.node(id).path[0].x})`, ui.node(id).path[0].x === 12);
// The Field takes the panel's arithmetic, which a raw number input never did.
await ui.type(vx, "100/4");
t(`and reads it as an expression (${ui.node(id).path[0].x})`, ui.node(id).path[0].x === 25);
const yBefore = ui.node(id).path[0].y;
await ui.type(vy, "+5");
t(`relative too (${yBefore} +5 → ${ui.node(id).path[0].y})`, ui.node(id).path[0].y === yBefore + 5);
await ui.type(vr, "7");
t(`the corner radius writes the point (${ui.node(id).path[0].cornerRadius})`, ui.node(id).path[0].cornerRadius === 7);
const slider = ui.one('.vec-slider input[type="range"]');
t(`and the slider is named for the same property (${slider?.getAttribute("aria-label")})`,
  slider?.getAttribute("aria-label") === "Vertex corner radius");

/* ── the four actions, and the two that open a form ──────────────────────── */

const actions = ui.all(".vec-actions button");
t(`four actions on the shared recipe (${actions.map((b) => b.textContent.trim()).join(" / ")})`,
  actions.length === 4 && actions.every((b) => b.className.includes("x-btn")));

const simplify = ui.byText("Simplify…", ".vec-actions button");
await ui.click(simplify);
t("Simplify… opens its form", !!ui.one(".vec-sub"));
t(`and reads as pressed while it is open (${simplify.className})`, simplify.className.includes(" on"));
t("only one form is open at a time", ui.all(".vec-sub").length === 1);

const tol = ui.byLabel("Simplify tolerance");
t(`the form's number is a Field too (${tol ? "field" : "missing"})`, !!tol && !!tol.closest(".field"));
const tolSlider = ui.one('.vec-sub input[type="range"]');
t(`and its slider is named (${tolSlider?.getAttribute("aria-label")})`,
  tolSlider?.getAttribute("aria-label") === "Simplify tolerance slider");
const apply = ui.byText("Apply simplify", ".vec-sub button");
t(`Apply is the primary button (${apply?.className})`,
  !!apply && apply.className.includes("x-btn-primary") && !apply.className.includes("export-run"));

await ui.type(tol, "6");
await ui.click(apply);
t("applying closes the form", !ui.one(".vec-sub"));
t(`and the toggle is no longer pressed (${simplify.className})`, !simplify.className.includes(" on"));

const offset = ui.byText("Offset Path…", ".vec-actions button");
await ui.click(offset);
const join = ui.one('.vec-sub .seg[aria-label="Offset join"]');
t(`the offset form has its join switch (${[...(join?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).join(" / ")})`,
  join?.getAttribute("role") === "tablist" && join.querySelectorAll("button").length === 2);
const dist = ui.byLabel("Offset distance");
await ui.type(dist, "5");
const before = ui.node(id).path.length;
await ui.click(ui.byText("Apply offset", ".vec-sub button"));
const after = ui.node(id);
t(`applying the offset rewrites the path (${before} → ${after.path.length} points) and closes`,
  !ui.one(".vec-sub") && after.path.length > 0);

// The card's own guard: a vector with no stroke cannot be outlined, and the
// button says so instead of doing nothing quietly.
await ui.click(ui.byText("Outline stroke", ".vec-actions button"));
t("Outline stroke refuses a stroke-less path without touching it",
  ui.node(id).kind === "vector" && ui.node(id).path.length === after.path.length);

// Smooth is the one action that writes immediately.
const preSmooth = JSON.stringify(ui.node(id).path);
await ui.click(ui.byText("Smooth", ".vec-actions button"));
t("Smooth rewrites the handles", JSON.stringify(ui.node(id).path) !== preSmooth);

/* ── entering and leaving point edit, from the header ────────────────────── */

await ui.click(ui.byText("Edit points", ".h-act button"));
t(`Edit points enters vector edit (${ui.snap().vecEdit})`, ui.snap().vecEdit === id);
const done = ui.byText("Done", ".h-act button");
t("the header button becomes Done", !!done);
await ui.click(done);
t(`Done leaves it (${ui.snap().vecEdit})`, ui.snap().vecEdit === null);

/* ── the header folds like every other section ───────────────────────────── */

const vectorToggle = ui
  .all(".h-row .sec-toggle")
  .find((b) => b.querySelector("h2")?.textContent.trim() === "Vector");
await ui.click(vectorToggle);
t("folding the section hides the card", !ui.one(".vec-card") && vectorToggle.getAttribute("aria-expanded") === "false");
await ui.click(vectorToggle);
t("and unfolding brings it back", !!ui.one(".vec-card"));

/* ── one undo step per write, the way the panel promises ─────────────────── */

const undoBefore = ui.node(id).path[0].x;
await ui.type(ui.byLabel("Vertex X"), `${undoBefore + 9}`);
t(`the typed vertex is written (${undoBefore} → ${ui.node(id).path[0].x})`,
  ui.node(id).path[0].x === undoBefore + 9);
await ui.dispatch({ type: "undo" });
t(`and one undo returns it (${ui.node(id).path[0].x})`, ui.node(id).path[0].x === undoBefore);

await ui.unmount();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
