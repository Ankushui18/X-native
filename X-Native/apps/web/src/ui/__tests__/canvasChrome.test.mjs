/**
 * Canvas chrome contracts (FR-U2, docs/PRODUCT_UI_AUDIT_2026-09-26.md §10).
 *
 * The canvases used to carry their own palette as module literals — `BRAND_ACCENT
 * = "#10b981"`, `COMP_PURPLE = "#a855f7"` with a comment asking a human to keep
 * it "in step by hand" with `--comp`, `dark ? "#171c22" : "#eef1f4"` in the
 * minimap and again in the rulers. Chrome could not answer the theme, and the
 * codebase had two different "accent" greens with no way to tell which was which.
 *
 * `canvasChrome.ts` is now the only door between styles.css and the 2D surfaces.
 * This file is what keeps that door honest, with three contracts:
 *
 *  1. FALLBACK ≡ SHEET. `CANVAS_CHROME_FALLBACK` must equal the *light* column of
 *     styles.css, key for key. The fallback is what paints when the cascade has
 *     not resolved (a test harness, a stripped sheet), so a disagreement is the
 *     same silent drift the hand-sync comment used to beg about — only now a test
 *     names the key.
 *  2. BOTH THEMES DECLARE EVERY ROLE. A token the dark block forgot would fall
 *     back to the light value, i.e. reintroduce the bug in the one theme nobody
 *     looks at first.
 *  3. THE SOURCES CARRY NO CHROME LITERALS. Canvas.tsx / Minimap.tsx / Rulers.tsx
 *     may still hold *document* ink — a default fill, a new slice's stroke, a
 *     boolean mask's white — because those are written into the file and must not
 *     move when the appearance changes. Every such literal is a named `DOC_*`
 *     constant or a commented default; anything else is chrome that escaped.
 *
 * Nothing here needs a canvas, a DOM or a browser: `readCanvasChrome` is pure and
 * the rest is source text. Run with: npx vite-node src/ui/__tests__/canvasChrome.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CANVAS_CHROME_FALLBACK,
  CANVAS_CHROME_TOKENS,
  canvasChrome,
  readCanvasChrome,
  withAlpha,
} from "../canvasChrome.ts";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(UI, "..", "styles.css"), "utf8");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`FAIL ${name}`);
};

/** Collapse the cosmetic differences between two declarations of one colour. */
const norm = (v) =>
  String(v).trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").toLowerCase();

/** Declarations of the first top-level block whose selector matches `re`. */
function block(re) {
  const m = re.exec(css);
  if (!m) return null;
  const open = css.indexOf("{", m.index);
  if (open < 0) return null;
  let depth = 0;
  let i = open;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) break;
  }
  const out = {};
  // Comments first: prose in this sheet mentions tokens by name (`--accent: the
  // control accent …`), and a naive declaration scan reads that as a value.
  const body = css.slice(open + 1, i).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[d[1]] = d[2].trim();
  }
  return out;
}

const light = block(/^\s*:root,/m);
const dark = block(/^\s*html\[data-theme="dark"\]\s*\{/m);
const keys = Object.keys(CANVAS_CHROME_TOKENS);

t("styles.css has a light (:root) theme block", !!light);
t('and a html[data-theme="dark"] block', !!dark);

/* ------------------------------------------------------------------ 1. shape */
const tokenNames = keys.map((k) => CANVAS_CHROME_TOKENS[k]);
t(
  `every role names a custom property (${keys.length} roles)`,
  tokenNames.every((n) => typeof n === "string" && n.startsWith("--")),
);
t("and no two roles share one property", new Set(tokenNames).size === tokenNames.length);
t(
  "every role has a fallback",
  keys.every((k) => typeof CANVAS_CHROME_FALLBACK[k] === "string" && CANVAS_CHROME_FALLBACK[k] !== ""),
);
t("and the fallback names no role the map lacks", Object.keys(CANVAS_CHROME_FALLBACK).every((k) => keys.includes(k)));

// The boundary that keeps document ink out: a chrome role is either a `--cv-*`
// canvas role or one of the pre-existing surface/identity tokens the canvases
// already read. A role pointing anywhere else is someone smuggling a document
// value (or a panel value) into the canvas palette.
const ALLOWED_SHARED = ["--canvas", "--grid", "--canvas-label", "--comp", "--accent", "--accent-wash", "--panel"];
const strays = tokenNames.filter((n) => !n.startsWith("--cv-") && !ALLOWED_SHARED.includes(n));
t(`chrome roles stay inside the canvas family (${strays.join(", ") || "none stray"})`, strays.length === 0);

/* ------------------------------------------------------------- 2. the reader */
const stub = readCanvasChrome((token) => ` ${token}-value `);
t(
  "readCanvasChrome resolves every role through the lookup",
  keys.every((k) => stub[k] === `${CANVAS_CHROME_TOKENS[k]}-value`),
);
t("and trims what the cascade hands back", stub.sel === "--cv-sel-value");

const blank = readCanvasChrome(() => "");
t(
  "a sheet that defines nothing still paints (every role falls back)",
  keys.every((k) => blank[k] === CANVAS_CHROME_FALLBACK[k]),
);
t("and the fallback record is not the object handed back", blank !== CANVAS_CHROME_FALLBACK);
const hostile = readCanvasChrome(() => undefined);
t(
  "a lookup returning non-strings falls back instead of throwing",
  keys.every((k) => hostile[k] === CANVAS_CHROME_FALLBACK[k]),
);
const partial = readCanvasChrome((token) => (token === "--cv-sel" ? "#123456" : ""));
t("one themed role does not disturb the rest", partial.sel === "#123456" && partial.guide === CANVAS_CHROME_FALLBACK.guide);

// No DOM in this harness: canvasChrome() must degrade to the fallbacks rather
// than throw, because the canvases call it inside a paint effect.
let noDom = null;
let threw = "";
try {
  noDom = canvasChrome();
} catch (e) {
  threw = String(e && e.message);
}
t(`canvasChrome() survives having no document (${threw || "no throw"})`, !!noDom && !threw);
t(
  "and returns the light fallbacks when it has nothing to read",
  !!noDom && keys.every((k) => noDom[k] === CANVAS_CHROME_FALLBACK[k]),
);
const withRoot = canvasChrome({});
t(
  "an explicit root with no getComputedStyle falls back too",
  keys.every((k) => withRoot[k] === CANVAS_CHROME_FALLBACK[k]),
);

/* ------------------------------------------------------- 2b. thinning a role */
t("withAlpha thins a 6-digit hex", withAlpha("#10b981", 0.14) === "rgba(16, 185, 129, 0.14)");
t("and a 3-digit one", withAlpha("#fff", 1) === "rgba(255, 255, 255, 1)");
t("and rewrites an rgba()'s alpha rather than nesting it", withAlpha("rgba(16, 185, 129, 0.9)", 0.25) === "rgba(16, 185, 129, 0.25)");
t("and an rgb() too", withAlpha("rgb(1, 2, 3)", 0.5) === "rgba(1, 2, 3, 0.5)");
t("drops an 8-digit hex's own alpha for the requested one", withAlpha("#10b98180", 0.5) === "rgba(16, 185, 129, 0.5)");
t("clamps the alpha instead of emitting nonsense", withAlpha("#10b981", 4) === "rgba(16, 185, 129, 1)" && withAlpha("#10b981", -2) === "rgba(16, 185, 129, 0)");
t(
  "and hands back anything it cannot parse, so a mis-shaped sheet degrades",
  withAlpha("var(--cv-sel)", 0.5) === "var(--cv-sel)" && withAlpha("", 0.5) === "",
);
t("every chrome role thins without throwing", keys.every((k) => typeof withAlpha(CANVAS_CHROME_FALLBACK[k], 0.3) === "string"));

/* --------------------------------------------------- 3. fallback ≡ light sheet */
if (light && dark) {
  const missingLight = [];
  const driftedLight = [];
  for (const k of keys) {
    const token = CANVAS_CHROME_TOKENS[k];
    if (!(token in light)) missingLight.push(token);
    else if (norm(light[token]) !== norm(CANVAS_CHROME_FALLBACK[k])) {
      driftedLight.push(`${token}: sheet ${light[token]} ≠ fallback ${CANVAS_CHROME_FALLBACK[k]}`);
    }
  }
  t(`the light block declares all ${keys.length} roles (${missingLight.join(", ") || "none missing"})`, missingLight.length === 0);
  t(`and every fallback equals the light sheet (${driftedLight.join("; ") || "all equal"})`, driftedLight.length === 0);

  const missingDark = keys.map((k) => CANVAS_CHROME_TOKENS[k]).filter((token) => !(token in dark));
  t(`the dark block declares all ${keys.length} roles too (${missingDark.join(", ") || "none missing"})`, missingDark.length === 0);

  // Not a pass/fail contract — the point of the round is that these *may* differ
  // now. Saying which ones do is how a designer sees what is left to retune.
  const differ = keys
    .map((k) => CANVAS_CHROME_TOKENS[k])
    .filter((token) => norm(light[token] ?? "") !== norm(dark[token] ?? ""));
  console.log(`\nroles the dark theme retunes: ${differ.join(", ") || "none yet (FR-U2b)"}`);
}

/* ------------------------------------------------------ 4. sources are clean */
const canvas = read("Canvas.tsx");
const minimap = read("Minimap.tsx");
const rulers = read("Rulers.tsx");

for (const [name, src] of [["Canvas.tsx", canvas], ["Minimap.tsx", minimap], ["Rulers.tsx", rulers]]) {
  t(`${name} reads its chrome from canvasChrome.ts`, /from "\.\/canvasChrome"/.test(src));
}

// Chrome literals that must not come back. Each one was a hardcoded role before
// this round; the token it belongs to is named in the message.
const FORBIDDEN = [
  ["#a855f7", "--comp"],
  ["#9aa0a6", "--cv-lock"],
  ["#ff3b6b", "--cv-guide"],
  ["#0d99ff", "--cv-target"],
  ["#00c853", "--cv-mask"],
  ["#f8fafc", "--cv-chip-ink"],
  ["rgba(15, 23, 42", "--cv-chip"],
  ["rgba(13, 20, 38", "--cv-chip / --cv-scrim"],
  ["rgba(16, 185, 129", "--cv-sel-wash / --cv-sel-glow"],
  ["#171c22", "--cv-well / --panel"],
  ["#eef1f4", "--cv-well / --canvas"],
  ["#8c8c8c", "--cv-dim"],
  ["#e5e5e5", "--cv-line"],
];
for (const [lit, token] of FORBIDDEN) {
  const hits = [["Canvas.tsx", canvas], ["Minimap.tsx", minimap], ["Rulers.tsx", rulers]]
    .filter(([, src]) => src.includes(lit))
    .map(([name]) => name);
  t(`no canvas surface hardcodes ${lit} (${token})${hits.length ? ` — found in ${hits.join(", ")}` : ""}`, hits.length === 0);
}

// The emerald is still allowed where it is *document* ink, but only as a named
// constant, so the next reader can see why it does not move with the theme.
const emeraldLines = canvas
  .split("\n")
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /#10b981|#10B981/.test(l));
const undocumented = emeraldLines.filter(([, l]) => !/^const DOC_/.test(l.trim()));
t(
  `every #10b981 left in Canvas.tsx is a DOC_* document constant (${undocumented.map(([n]) => `line ${n}`).join(", ") || "none stray"})`,
  undocumented.length === 0,
);
t("Canvas.tsx keeps at least one documented document-ink constant", /^const DOC_/m.test(canvas));
t(
  "and the paint path resolves the whole chrome bundle in one read",
  /readCanvasChrome\(\(token\) => css\.getPropertyValue\(token\)\)/.test(canvas),
);
t("Minimap.tsx carries no colour literal at all", !/(["'`])#[0-9a-fA-F]{3,8}\b/.test(minimap));
t("Rulers.tsx carries no colour literal at all", !/(["'`])#[0-9a-fA-F]{3,8}\b/.test(rulers));
t(
  "neither of them hand-rolls a dark/light colour pair any more",
  !/dark \? ["'#(]/.test(minimap) && !/dark \? ["'#(]/.test(rulers),
);
t(
  "both still re-read on a theme flip (theme stays a paint dependency)",
  /\btheme\b/.test(minimap) && /\btheme\b/.test(rulers),
);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
