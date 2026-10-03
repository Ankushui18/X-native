/**
 * The layers panel's empty states, mounted (LP-U3).
 *
 * An empty page used to render `<div class="tree">` with nothing in it: the one
 * panel in the product that had no sentence for "there is nothing here yet".
 * Assets had one ("Create a component (⌘⌥K) to see it here"), the inspector had
 * a whole recipe for one (`.empty-state` + title + body + hint with `<kbd>`),
 * and the layer search had a third blank nobody wrote for at all — a query with
 * no hits hides every row, so "no match" and "empty page" looked identical.
 *
 * This asserts the structure and the behaviour in jsdom: which state renders for
 * which document, what it says, that drawing replaces it, and that the two
 * blanks are two different sentences. The computed half (padding, the centred
 * flex, the kbd chips' borders) belongs to the browser suite.
 *
 * Run with:  npx vite-node src/ui/__tests__/leftpanel.dom.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mountLeftPanel, strayInlineStyles } from "./domEnv.mjs";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

/* ── an empty page teaches ──────────────────────────────────────────────── */

const ui = await mountLeftPanel();

const state = ui.one(".tree .empty-state");
t("an empty page renders a teaching state inside the tree", !!state);
t(`titled, not decorative (${ui.text(".tree .empty-title")})`, ui.text(".tree .empty-title") === "No layers on this page");
t(`it says what the tree will hold (${ui.text(".tree .empty-body").slice(0, 48)}…)`,
  /lands here as a row you can name, group, hide, lock and reorder/.test(ui.text(".tree .empty-body")));
t("it carries an icon rather than starting with bare text", !!state?.querySelector("svg"));

const kbds = [...(ui.one(".tree .empty-hint")?.querySelectorAll("kbd") ?? [])].map((k) =>
  (k.textContent || "").trim(),
);
t(`and its hints are the real chords (${kbds.join(" ")})`,
  ["F", "R", "T", "⌘", "K"].every((k) => kbds.includes(k)));

t("the tree itself has no rows to show", ui.all(".tree [data-row-id]").length === 0);

const strays = strayInlineStyles(ui.inlineStyles(state));
t(`the state carries no inline layout (${strays.join(" ") || "none"})`, strays.length === 0);

// The recipe is the inspector's, not a fourth one: same classes, same sheet.
const chrome = read("chrome.tsx");
const inspector = read("inspector.tsx");
const css = readFileSync(path.join(UI, "..", "styles.css"), "utf8");
for (const rule of [".empty-state", ".empty-title", ".empty-body", ".empty-hint", ".empty"]) {
  t(`styles.css defines ${rule}`, css.includes(`${rule} {`) || css.includes(`${rule},`));
}
for (const cls of ["empty-state", "empty-title", "empty-body", "empty-hint"]) {
  t(`both the panel and the inspector use .${cls} (one recipe, two surfaces)`,
    chrome.includes(cls) && inspector.includes(cls));
}

/* ── drawing is the end of the empty state ──────────────────────────────── */

await ui.dispatch({ type: "add", kind: "rect", x: 40, y: 40, w: 120, h: 80 });
await ui.settle();
t("one rectangle later the teaching state is gone", !ui.one(".tree .empty-state"));
t("and the row it promised is there", ui.all(".tree [data-row-id]").length === 1);

/* ── a search with no hits is a different sentence ──────────────────────── */

const search = ui
  .all(".search input")
  .find((i) => i.getAttribute("aria-label") === "Find layers");
t("the panel's search field is addressable by its accessible name", !!search);

await ui.type(search, "zzz-no-such-layer");
await ui.settle();
t("a query nothing answers hides every row", ui.all(".tree [data-row-id]").length === 0);
const msg = ui.text(".tree .empty");
t(`and says so, quoting the term (${msg})`,
  msg.includes("No layer matches") && msg.includes("zzz-no-such-layer"));
t("without claiming the page is empty", !ui.one(".tree .empty-state"));

await ui.type(search, "Rectangle");
await ui.settle();
t("a query that does answer shows the row again", ui.all(".tree [data-row-id]").length === 1);
t("and drops the message", !ui.one(".tree .empty"));

await ui.type(search, "");
await ui.settle();
t("clearing the search shows the whole page with no message",
  ui.all(".tree [data-row-id]").length === 1 && !ui.one(".tree .empty"));

await ui.unmount();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
