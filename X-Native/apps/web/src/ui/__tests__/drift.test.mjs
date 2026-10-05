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
 *  that earns it. Raised 2026-09-29 for the text run-14 surfaces (link input +
 *  hover chip on the canvas; the Type-settings details in the inspector), with
 *  Canvas's colour row lowered to its measured 12. Raised 2026-09-30 for the
 *  vector Cut tool (run-22): one title + one button in the vector-edit
 *  toolbar, both earning their row. Raised again 2026-09-30 for run-24
 *  (stroke sides & brush): five `title=` tooltips on the disabled support-
 *  matrix options (position/style/dash) and one Style pill row in the
 *  inspector, plus XSelect's `title` passthrough — the tooltips are the
 *  spec'd feedback for disabled options, so they earn the row.
 *
 *  Canvas.tsx's remaining colours are the triaged half of the pile: document ink
 *  — the `DOC_*` constants, a glass effect's default tint, `#00000000` fills for
 *  newly created sections/slices, a noise renderer's black, a boolean mask's
 *  white. Those are written into saved files and their SVG exports, so they must
 *  NOT answer the theme; canvasChrome.test.mjs pins that boundary instead.
 *  RustDocumentView's two inline values are document root geometry and node
 *  ink/geometry (not chrome); three native buttons provide aria-pressed layer
 *  selection/canvas semantics and form submission. Other controls use XButton;
 *  its title/colour debt starts at zero.
 *  Minimap.tsx and Rulers.tsx are at zero: they have no literals left to drift.
 *  Raised 2026-10-01 for the Crop an image audit: its canvas crop toolbar adds
 *  one colour literal, three action buttons, and one aspect-ratio select.
 *  Raised 2026-10-01 for the Parent/child/Frames re-audit: selection handles
 *  repainted as Figma-style hollow white squares (HANDLE_FILL constant = 1 new
 *  colour literal) with a top-right rotation target and stem for containers.
 *  Raised 2026-10-01 for the Guide to fills audit: two inspector reorder
 *  buttons and three tooltips for extra stroke paints. Raised for About color
 *  models to replace the picker model button with a native select. Raised for
 *  Manage color profiles: two File-menu profile actions, two export-profile
  *  selectors, and the inline settings row that lays them out. Raised again
  *  for Export static designs: one filename hover title on bulk-export thumbnails.
 *  Raised 2026-10-03 for vector-edit Lasso (Q): one native toolbar button and
 *  its title tooltip make the newly added tool discoverable. Raised
 *  2026-10-04 for the letter-spacing unit (audit F10): one native select for
 *  px/% on the Type row and its title tooltip, mirroring the Leading unit
 *  control exactly — the parity fix needs the unit field, and the ledger is
 *  the mechanism that says so.
 *
 *  LOWERED 2026-10-04 for identity v3 (the ION token system), in the same
 *  commit that earned it. Every row below is the measured value after the
 *  round, not the old ceiling with slack: the four surfaces that carried the
 *  retired emerald and the ad-hoc dark glass —
 *    ZenHUD.tsx        16/14/9/6/0 → 2/0/5/3/0   (composed from .zen-* classes)
 *    RadialMenu.tsx     3/6/0/0/0  → 1/0/0/0/0   (SVG paint moved to the sheet)
 *    icons.tsx          0/3/0/0/0  → 0/0/0/0/0   (brand mark reads .brand-*)
 *    Canvas.tsx        11/14/13/16/1 → 11/9/13/16/1 (10 anonymous paint
 *                       literals became 9 named document-ink constants)
 *    FigInspectorModal 113/10/2/8/1 → 113/0/2/8/1 (its eight emerald/white/
 *                       red literals are tokens now)
 *    chrome.tsx        49/4/41/72/2 → 49/1/41/72/2
 *    inspector.tsx     190/44/248/200/49 → 189/22/248/200/49
 *                       (and → 13/22/248/200/49 in the 2026-10-05 sweep)
 *  LOWERED 2026-10-05 for the modal sweep: FigInspectorModal's 113 inline
 *  style objects became one .fim-* recipe block in the sheet, so the file
 *  keeps a single inline value — the colour swatch's runtime fill —
 *    FigInspectorModal 113/0/2/8/1 → 1/0/2/8/1
 *  The same rewrite retired the file's one Figma-blue wash
 *  (rgba(13,153,255,.15) → .fim-node.sel's var(--sel)) and its 8px radius
 *  default, so the row reads the shared control rhythm now.
 *  LOWERED 2026-10-05 for the inspector sweep: inspector.tsx's 185 inline
 *  style objects became a named vocabulary in the sheet — layout primitives,
 *  rows and stacks, the input/select/range recipes, tags and cards — so the
 *  file keeps only the values a renderer has to compute:
 *    inspector.tsx 185/22/248/200/49 → 13/22/248/200/49
 *  The 13 survivors are document ink (a swatch's fill, a paint's colour), a
 *  severity dot, a boolean preview's opacity, a computed font stack and two
 *  template-string style panes. The sweep also retired every magic pixel the
 *  panel carried inline and snapped sub-ladder padding to the spacing ladder.
 *  The invariant those rows now hold is enforced from the other side by
 *  tokens.test.mjs: a colour literal in src/ui must be *named* (a `const`, an
 *  object property or a labelled table row) or it fails, and no rule in
 *  styles.css below the token layers may paint a colour outright. */

const CEILING = {
  //                 inline colour title button select
  // 2026-10-05: four floating surfaces left the component for the sheet — the
  // frame-rename field, the link box, the link hover pill and the emoji
  // picker all ride the control rhythm now (`.frame-name-edit input`,
  // `.link-input input`, `.link-hover`, `.emoji-pick`).
  "Canvas.tsx": [7, 9, 13, 16, 1],
  "Comments.tsx": [3, 0, 3, 5, 0],
  "ContextMenu.tsx": [1, 0, 0, 2, 0],
  // Raised 2026-10-03 for the dev-only Rust WASM POC trigger (one named button).
  "Dashboard.tsx": [1, 0, 12, 34, 1],
  "DialogHost.tsx": [0, 0, 1, 0, 0],
  // Lowered 2026-10-05 (modal sweep): 113 inline style objects → one .fim-*
  // recipe block in the sheet; the swatch keeps the single runtime fill.
  "FigInspectorModal.tsx": [1, 0, 2, 8, 1],
  // Raised 2026-10-01 batch 21: add-stop (+) / remove-stop (−) buttons in the
  // gradient editor, both with `title=` and `aria-label=` (per the gradients
  // article the + and − next to "Stops" are the documented affordance). That
  // is one new title and one new button; the remove-stop title replaced the
  // trash-only icon so the title count goes up by one (from the new +).
  "FillPicker.tsx": [12, 2, 16, 19, 2],
  // Raised 2026-10-05 for the Fonts dialog (reference captures: family field
  // opens a searchable picker, style field opens the upright/italic menu).
  // One inline value: each family row paints its own typeface at runtime.
  // Five buttons (close, clear-search, the family row map, two style-menu
  // maps) and one source-filter select; no title and no colour literal.
  "FontPicker.tsx": [1, 0, 0, 5, 1],
  "Guides.tsx": [0, 0, 2, 0, 0],
  "Minimap.tsx": [0, 0, 0, 0, 0],
  "PresentationPlayer.tsx": [5, 0, 12, 9, 2],
  "RadialMenu.tsx": [1, 0, 0, 0, 0],
  "Rulers.tsx": [0, 0, 0, 0, 0],
  "RustDocumentView.tsx": [2, 0, 0, 3, 0],
  "Tooltip.tsx": [1, 0, 0, 0, 0],
  "ZenHUD.tsx": [2, 0, 5, 3, 0],
  "announce.tsx": [0, 0, 0, 0, 0],
  // Raised 2026-09-30 for the File menu (P0-2): a trigger and two rows, the
  // chrome's first menu of its own — no title and no inline style, so only
  // the button row moves. One more row for Export assets… (P0-4).
  // Raised 2026-10-04 for the batch-45 canvas-chrome switch (View → Canvas
  // chrome): one `<button>` in the rail menu, drawn from `CANVAS_CHROME_OPTIONS`
  // so the row is the whole cost — no `title=`, no inline style, and the model
  // (`themeModel.ts`) keeps its [0, 0, 0, 0, 0].
  "chrome.tsx": [49, 1, 41, 72, 2],
  "devices.tsx": [21, 35, 1, 0, 0],
  "icons.tsx": [0, 0, 0, 0, 0],
  // Raised 2026-10-01 batch 21: Overflow scroll dropdown in the Layout section
  // for frames — one extra native <select>, plus a three-column inline grid
  // around it and the helper text.
  // 2026-10-05: four inline styles became classes — the three size tags
  // (`.auto-tag`) and the Flow group header's ad-hoc `marginBottom: 6`. The
  // group headers now carry the rows' own gutter from the sheet.
  // Lowered 2026-10-05 (inspector sweep): 185 inline style objects → the
  // .ins-* vocabulary in the sheet; 13 runtime values stay inline.
  // 2026-10-05: the font family/weight <select>s became the dialog and menu
  // triggers — two fewer native selects, two more field buttons.
  // Raised the same day for the capture-shaped menus/popovers: the vector-path
  // menu (Edit object/Offset/Simplify), the boolean menu with its ⌥⇧ chips,
  // and the stroke-settings popover (Basic/Dynamic/Brush) — header triggers,
  // menu rows, tab buttons and the Style/profile/point selects all earn the
  // row; the Flatten chip rides sc(), no title and no inline value added.
  "inspector.tsx": [13, 22, 248, 214, 51],
  "theme.tsx": [0, 0, 0, 0, 0],
  "x-ui.tsx": [3, 0, 14, 15, 1],
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
