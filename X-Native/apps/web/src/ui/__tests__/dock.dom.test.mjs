/**
 * The tool dock's multi-selection end, mounted (TB-U5).
 *
 * The boolean flyout was the one menu in the dock that laid itself out inline:
 * `style={{ width: 180, left: 0 }}` on the `.fly` (narrower than the recipe's
 * own 220px min-width, so it was the only menu that clipped its shortcut chips),
 * `style={{ width: "auto", padding: "0 6px", gap: 3 }}` on its trigger, an
 * inline hairline separator, and — next door — the count label and the
 * vector-edit "Done" button, the latter hardcoding `#fff` on the accent so it
 * could not follow the theme. Every tool group already had the recipe this now
 * uses: `tool split`, a `.caret` gutter and a plain `.fly`.
 *
 * jsdom has no stylesheet, so what is asserted here is the structure and the
 * behaviour — which node renders, with what class, name and role, and what a
 * click dispatches. The computed half (min-width, the accent's ink in the dark
 * theme) belongs to the browser suite.
 *
 * Run with:  npx vite-node src/ui/__tests__/dock.dom.test.mjs
 */
import { mountToolbar, strayInlineStyles } from "./domEnv.mjs";

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

const ui = await mountToolbar({ layer: "pair" });

/* ── the dock styles itself from the sheet ───────────────────────────────── */

const strays = strayInlineStyles(ui.inlineStyles(ui.one(".dock")));
t(`the dock carries no inline layout (${strays.length} stray: ${strays.join(" ") || "none"})`,
  strays.length === 0);
t(`the count is a class, not a style object (${ui.text(".sel-count")})`,
  ui.text(".sel-count") === "2 selected");
t("the multi-selection toolset is the shared one", !!ui.one(".toolset.multi"));

/* ── the boolean tool is a split tool like every tool group ──────────────── */

const tool = ui.one('.tool[data-group="bool"]');
t(`the boolean tool is split (${tool?.className})`, !!tool && tool.className.includes("tool split"));
const hit = tool?.querySelector(".hit");
t("its trigger has no inline geometry", !!hit && !hit.hasAttribute("style"));
t(`its caret is the shared gutter (${tool?.querySelector(".caret")?.getAttribute("aria-label")})`,
  !!tool?.querySelector("i.caret") && !!tool.querySelector(".caret").getAttribute("aria-label"));
t(`the trigger advertises its menu (${hit?.getAttribute("aria-haspopup")}, expanded ${hit?.getAttribute("aria-expanded")})`,
  hit?.getAttribute("aria-haspopup") === "menu" && hit?.getAttribute("aria-expanded") === "false");

/* ── the flyout is the .fly recipe, with a separator that is one ─────────── */

t("the menu is closed to begin with", !ui.one('.tool[data-group="bool"] .fly'));
await ui.click(hit);
const fly = ui.one('.tool[data-group="bool"] .fly');
t(`clicking the trigger opens the menu (${fly?.getAttribute("role")})`,
  !!fly && fly.getAttribute("role") === "menu" && fly.getAttribute("aria-label") === "Boolean operations");
t("and the trigger says it is open", hit.getAttribute("aria-expanded") === "true");
t("the menu takes the recipe's own width (no inline style)", !fly.hasAttribute("style"));

const rows = [...fly.querySelectorAll('button[role="menuitem"]')];
const labels = rows.map((b) => b.textContent.trim());
t(`every operation is still on the menu (${labels.join(" / ")})`,
  labels.length === 5 &&
    labels.some((l) => l.startsWith("Union selection")) &&
    labels.some((l) => l.startsWith("Flatten selection")));
t(`each keeps its chord (${rows.map((b) => b.querySelector(".sc")?.textContent).join(" ")})`,
  rows.every((b) => !!b.querySelector(".sc")));
t(`the separator is the shared hairline (${fly.querySelectorAll(".fly-div").length}, role ${fly.querySelector(".fly-div")?.getAttribute("role")})`,
  fly.querySelectorAll(".fly-div").length === 1 &&
    fly.querySelector(".fly-div").getAttribute("role") === "separator");
t("the whole menu is inline-free", strayInlineStyles(ui.inlineStyles(fly)).length === 0);

/* ── and it still does what it says ──────────────────────────────────────── */

await ui.click(rows.find((b) => b.textContent.includes("Intersect")));
const made = ui.snap().selection.map((id) => ui.node(id)?.kind).filter(Boolean);
t(`an operation makes the boolean (kind ${made.join(", ")})`, made.length === 1 && made[0] === "boolean");
t("and the menu closes behind it", !ui.one('.tool[data-group="bool"] .fly'));

/* ── the vector-edit commit button wears the accent from the tokens ──────── */

t("no Done button while no path is being edited", !ui.one(".hit.vec-done"));
await ui.dispatch({ type: "setVecEdit", id: ui.snap().selection[0] });
const done = ui.one(".hit.vec-done");
t(`editing points puts Done in the dock (${done?.getAttribute("title")})`,
  !!done && (done.getAttribute("title") || "").startsWith("Done editing path"));
t("it is a class, not an inline accent", !done.hasAttribute("style"));
await ui.click(done);
t(`and it leaves vector edit (${ui.snap().vecEdit})`, ui.snap().vecEdit === null);

await ui.unmount();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
