/**
 * Headless contract for the two surfaces the P2 drift round 4 rebuilt: the
 * inspector's vector card (IN-U4) and the dock's boolean flyout (TB-U5).
 *
 * Both were *styled* drift, not behaviour drift, and the browser suite is the
 * place that asserts on behaviour (it has its own checks for what the card
 * dispatches). What a browser cannot do in this sandbox is run at all, so the
 * structural half of the finding is pinned here instead, against the source:
 *
 *  - the card is built from the shared primitives (`Section`, `Field`,
 *    `XButton`, `XSegmentedControl`) — the point of the fix, and the thing a
 *    future edit is most likely to quietly undo by hand-writing a button;
 *  - neither surface carries an inline `style={{…}}` object or a literal hex
 *    colour, which is what made them unreachable by the theme (§29);
 *  - every class they name exists in `styles.css`, so a renamed or deleted rule
 *    fails here rather than rendering as unstyled markup nobody sees.
 *
 * Run with:  npx vite-node src/ui/__tests__/vectorcard.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..");
const inspector = readFileSync(path.join(UI, "inspector.tsx"), "utf8");
const chrome = readFileSync(path.join(UI, "chrome.tsx"), "utf8");
const css = readFileSync(path.join(UI, "..", "styles.css"), "utf8");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

/** The `<Section …> … </Section>` block that owns the vector card, found by the
 *  section id it persists under rather than by a line number, so edits above it
 *  cannot move the target. */
function sectionBlock(src, id) {
  const at = src.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const start = src.lastIndexOf("<Section", at);
  if (start < 0) return null;
  // Walk forward, counting `<Section` / `</Section>` so a nested section (the
  // card has none today, but the panel does) cannot end the block early.
  let depth = 0;
  const re = /<\/?Section\b/g;
  re.lastIndex = start;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    depth += m[0] === "</Section" ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + "</Section>".length);
  }
  return null;
}

/** The dock's boolean tool, from its `data-group` marker to the divider that
 *  closes the multi-select toolset. */
function boolToolBlock(src) {
  const start = src.indexOf('data-group="bool"');
  if (start < 0) return null;
  const end = src.indexOf('<div className="div" />', start);
  return end < 0 ? null : src.slice(start, end);
}

/** Every `className` token a JSX fragment names, minus the ones a component
 *  composes at runtime (`x-btn`, `seg`, `on` … come from x-ui, not the sheet). */
function classesOf(jsx) {
  const out = new Set();
  for (const m of jsx.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const c of raw.split(/\s+/)) if (c) out.add(c);
  }
  return [...out];
}

const inlineStyles = (jsx) => [...jsx.matchAll(/style=\{\{/g)].length;
const hexes = (jsx) => [...jsx.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);

/* ── IN-U4 · the vector card is composed, not hand-written ───────────────── */

const card = sectionBlock(inspector, "vector");
t("the vector card is a Section (id=vector)", !!card);

if (card) {
  for (const prim of ["<Section", "<Field", "<XButton", "<XSegmentedControl"])
    t(`the card composes ${prim.slice(1)}`, card.includes(prim));

  // The finding: a `<strong>` header, `export-run` buttons resized by inline
  // padding, and `#fff` typed onto the accent buttons.
  t("the card has no bespoke <strong> header", !/<strong/.test(card));
  t(`the card names no export-run button`, !card.includes("export-run"));
  t(`the card carries no inline style object (${inlineStyles(card)})`, inlineStyles(card) === 0);
  const lit = hexes(card).filter((h) => !/^#[0-9a-fA-F]{0,2}$/.test(h));
  t(`the card hardcodes no colour (${lit.join(", ") || "none"})`, lit.length === 0);

  // The vertex numbers are Fields so they inherit arithmetic, label-scrub and an
  // accessible name — and their names must not collide with the *layer's* X / Y /
  // corner radius, which the browser suite and assistive tech address by
  // aria-label.
  for (const name of ["Vertex X", "Vertex Y", "Vertex corner radius"])
    t(`the card exposes "${name}"`, card.includes(`aria="${name}"`));
  t("the vertex fields do not steal the layer's aria-labels", !/aria="Corner radius"/.test(card));

  // Both switches are one segmented recipe, each with a name a screen reader can
  // read; the six point-alignment actions are *not* a switch — they take the
  // panel's own `.align` row (Tooltip + aria-label, no tab semantics, no
  // selection claim) that the Position section uses for layers.
  for (const label of ["Handle mirroring", "Offset join"])
    t(`segmented control "${label}" is named`, card.includes(`ariaLabel="${label}"`));
  t("the alignment row is the panel's .align idiom", card.includes('className="align vec-align"'));
  for (const label of [
    "Align points left",
    "Align points to horizontal center",
    "Align points right",
    "Align points top",
    "Align points to vertical center",
    "Align points bottom",
  ])
    t(`alignment button "${label.slice(12)}…" is named`, card.includes(`aria-label={POINT_ALIGN[a].label}`) && inspector.includes(label));
  t("the alignment row claims no tab selection", !/ariaLabel="Align vector points"/.test(card));

  // Every action keeps the hint it had, so the tooltip bridge still has a label
  // (and a shortcut chip) to adopt.
  for (const hint of [
    "Done editing path (Esc / ↵)",
    "Enter vector edit mode (↵)",
    "Reduce redundant anchor points with tolerance control",
    "Smooth bezier curves",
    "Expand or contract outline path with offset distance",
    "Convert stroke to vector path (⇧⌘O)",
  ])
    t(`the card keeps the hint "${hint.slice(0, 28)}…"`, card.includes(hint));

  // Behaviour is unchanged: the same engine commands, dispatched the same way.
  for (const cmd of [
    'type: "vectorAlign"',
    'type: "patchPath"',
    'type: "setPointMirror"',
    'type: "setPointCornerRadius"',
    'type: "simplifyPath"',
    'type: "offsetPath"',
    'type: "outlineStroke"',
    'type: "setVecEdit"',
  ])
    t(`the card still dispatches ${cmd.split('"')[1]}`, card.includes(cmd));

  const missing = classesOf(card).filter((c) => !css.includes(`.${c}`));
  t(`every class the card names is styled (${missing.join(", ") || "all"})`, missing.length === 0);
}

/* ── TB-U5 · the boolean flyout is the dock's own split-tool recipe ──────── */

const bool = boolToolBlock(chrome);
t("the dock still has a boolean tool", !!bool);

if (bool) {
  t("the boolean tool is a split tool", bool.includes("tool split"));
  t("its caret is the shared .caret gutter", bool.includes('className="caret"'));
  // The inline `width: 180, left: 0` made this the only menu in the dock that
  // did not use the `.fly` recipe's own min-width; the separator was inline too.
  t(`the flyout carries no inline geometry (${inlineStyles(bool)})`, inlineStyles(bool) === 0);
  t("the separator is the shared .fly-div", bool.includes('className="fly-div"'));
  const fly = bool.slice(bool.indexOf('className="fly"'));
  t("the .fly itself has no style attribute", !/className="fly"[^>]*style=/.test(fly));
  const missing = classesOf(bool).filter((c) => !css.includes(`.${c}`));
  t(`every class the tool names is styled (${missing.join(", ") || "all"})`, missing.length === 0);
}

/* ── the sheet grew the rules the two surfaces now share ─────────────────── */

for (const rule of [".vec-card", ".vec-row", ".vec-chip", ".vec-actions", ".vec-sub", ".fly-div", ".h-act"])
  t(`styles.css defines ${rule}`, css.includes(`${rule} {`) || css.includes(`${rule},`));

// A pressed toggle that opens a form has to read as pressed: the card's
// Simplify…/Offset Path… buttons pass `active`, which x-ui renders as `.on`.
t("a secondary button has an .on state", css.includes(".x-btn-secondary.on"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
