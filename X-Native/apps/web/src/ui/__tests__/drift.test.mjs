/**
 * The chrome drift ratchet (§2.2 / §29 of docs/PRODUCT_UI_AUDIT_2026-09-26.md).
 *
 * The design system's first rule is "no new raw `<button>`/`<select>`/tooltip/
 * `title=` in product surfaces — compose the primitives", and its second is "no
 * hardcoded colors/geometry in chrome — tokens only". Neither was measurable, so
 * neither was enforceable: the audit counted 207 raw buttons in the inspector
 * alone and every round found another surface with its own inline paint.
 *
 * This is the same shape as the Rust workspace's `DEAD_CODE_CEILING` in
 * `scripts/check.sh` and `docs/KNOWN_DEBT.md` §1: a number per file, pinned here,
 * that may only go down. It does not claim the pile is good — it claims the pile
 * is *known*, and that it cannot grow without someone editing this table and
 * saying so out loud.
 *
 * Reproduce the numbers instead of trusting the table:
 *
 *   node -e 'const fs=require("fs");for(const f of fs.readdirSync("src/ui").filter(f=>f.endsWith(".tsx")).sort()){
 *     const s=fs.readFileSync("src/ui/"+f,"utf8");
 *     const c=(re)=>(s.match(re)||[]).length;
 *     console.log(f, c(/style=\{\{/g), c(/(["'"'"'`])#[0-9a-fA-F]{3,8}\b\1/g), c(/\btitle=/g), c(/<button[\s>]/g), c(/<select[\s>]/g));}'
 *
 * What each column counts, and why it is not zero:
 *
 *  - `inline`  — `style={{…}}` objects. Layout that lives in a component cannot
 *    be reached by the sheet, so it cannot answer the theme, the density switch
 *    or a redesign. Not all of them are wrong: a value that only exists at
 *    runtime (a measured width, a colour fed from the document) has to be inline.
 *    Those are the ones a round keeps and annotates; the rest become classes.
 *  - `colour`  — a quoted `#rrggbb`. In chrome this bypasses the tokens (and the
 *    dark theme); in `Canvas.tsx` and `devices.tsx` much of it is *document* ink
 *    (a default fill, a device bezel) rather than chrome, which is exactly the
 *    triage a round owes the table before lowering it.
 *  - `title`   — the native tooltip attribute. Since §2.3 the bridge adopts every
 *    one of them into the shared pill, so this is a *style* debt, not a behaviour
 *    one: new code should use `<Tooltip>`, which is what the ceiling enforces.
 *  - `button` / `select` — raw elements where a primitive (`XButton`, `XSelect`,
 *    the inspector's `Field`, `.icon-btn`, `.hit`, `.seg`) already exists.
 *
 * Run with:  npx vite-node src/ui/__tests__/drift.test.mjs
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The ceilings, measured 2026-09-26 after the vector card (IN-U4) and the dock
 *  (TB-U5) were rebuilt, and lowered again the same day when the canvas chrome
 *  moved into the `--cv-*` token family (FR-U2). Lower a row in the same commit
 *  that earns it.
 *
 *  Canvas.tsx's remaining colours are the triaged half of the pile: document ink
 *  — the `DOC_*` constants, a glass effect's default tint, `#00000000` fills for
 *  newly created sections/slices, a noise renderer's black, a boolean mask's
 *  white. Those are written into saved files and their SVG exports, so they must
 *  NOT answer the theme; canvasChrome.test.mjs pins that boundary instead.
 *  Minimap.tsx and Rulers.tsx are at zero: they have no literals left to drift. */
const CEILING = {
  //                 inline colour title button select
  "Canvas.tsx": [5, 13, 10, 10, 0],
  "Comments.tsx": [3, 0, 3, 5, 0],
  "ContextMenu.tsx": [1, 0, 0, 2, 0],
  "Dashboard.tsx": [1, 0, 11, 33, 1],
  "DialogHost.tsx": [0, 0, 1, 0, 0],
  "FigInspectorModal.tsx": [113, 10, 2, 8, 1],
  "FillPicker.tsx": [12, 2, 15, 19, 1],
  "Guides.tsx": [0, 0, 2, 0, 0],
  "Minimap.tsx": [0, 0, 0, 0, 0],
  "PresentationPlayer.tsx": [5, 0, 12, 9, 2],
  "RadialMenu.tsx": [3, 6, 0, 0, 0],
  "Rulers.tsx": [0, 0, 0, 0, 0],
  "Tooltip.tsx": [1, 0, 0, 0, 0],
  "ZenHUD.tsx": [16, 14, 9, 6, 0],
  "chrome.tsx": [50, 4, 40, 64, 2],
  "devices.tsx": [21, 35, 1, 0, 0],
  "icons.tsx": [0, 3, 0, 0, 0],
  "inspector.tsx": [179, 44, 221, 192, 41],
  "theme.tsx": [0, 0, 0, 0, 0],
  "x-ui.tsx": [3, 0, 13, 15, 1],
};

const METRICS = ["inline", "colour", "title", "button", "select"];
const PATTERNS = [
  /style=\{\{/g,
  /(["'`])#[0-9a-fA-F]{3,8}\b\1/g,
  /\btitle=/g,
  /<button[\s>]/g,
  /<select[\s>]/g,
];

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`FAIL ${name}`);
};

const files = readdirSync(UI)
  .filter((f) => f.endsWith(".tsx"))
  .sort();

// A surface nobody pinned is a surface nobody has looked at: name it, so the
// table stays the census rather than a subset that happens to pass.
const unpinned = files.filter((f) => !CEILING[f]);
t(`every surface in src/ui is pinned (${unpinned.join(", ") || "all ${files.length}"})`, unpinned.length === 0);
const gone = Object.keys(CEILING).filter((f) => !files.includes(f));
t(`and the table names no surface that is gone (${gone.join(", ") || "none"})`, gone.length === 0);

const totals = [0, 0, 0, 0, 0];
for (const f of files) {
  if (!CEILING[f]) continue;
  const src = readFileSync(path.join(UI, f), "utf8");
  const counts = PATTERNS.map((re) => (src.match(re) || []).length);
  counts.forEach((c, i) => (totals[i] += c));
  const over = counts
    .map((c, i) => (c > CEILING[f][i] ? `${METRICS[i]} ${CEILING[f][i]}→${c}` : null))
    .filter(Boolean);
  // Under the ceiling is worth saying too: a row that fell means a round earned
  // it, and the table should have been lowered in the same commit.
  const under = counts
    .map((c, i) => (c < CEILING[f][i] ? `${METRICS[i]} ${CEILING[f][i]}→${c}` : null))
    .filter(Boolean);
  t(`${f.padEnd(24)} ${counts.join(" / ")}${over.length ? `  OVER: ${over.join(", ")}` : ""}${under.length ? `  (lower the ceiling: ${under.join(", ")})` : ""}`,
    over.length === 0);
}

console.log(
  `\nchrome drift: ${totals.map((v, i) => `${METRICS[i]} ${v}`).join(", ")} — ` +
    `ceiling ${METRICS.map((m, i) => `${m} ${Object.values(CEILING).reduce((a, r) => a + r[i], 0)}`).join(", ")}`,
);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
