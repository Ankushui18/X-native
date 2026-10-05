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
 *  4. THE OPT-IN CANVAS-CHROME OVERRIDE IS COMPLETE AND NARROW.
 *     `html[data-canvas-chrome="figma"]` (View → Canvas chrome) must move every
 *     emerald *canvas* role to the sheet's Figma blue, retune nothing else, and
 *     sit after the two theme blocks so it wins the cascade. The panel accent is
 *     out of scope by construction, in both directions: `canvasChrome.ts` has no
 *     `accent` role at all, so a canvas surface cannot ask for one, and the override
 *     block is whitelisted to `--cv-*` roles plus `--grid`, so it cannot answer for
 *     one either. Both halves are asserted here, because "why is the rail still
 *     green?" and "why did the whole app turn blue?" are the same question from
 *     opposite sides of the door.
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

// Document ink is still allowed — a default fill, a new slice's stroke, a mask's
// white — but only as a named constant, so the next reader can see why it does
// not move with the theme. Identity v3 renamed every one of them: the anonymous
// `ctx.fillStyle = "#ffffff"` lines are gone, and the file's colour literals now
// all sit on the `DOC_*` / `RASTER_*` declarations that explain themselves.
const canvasLiterals = canvas
  .split("\n")
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /(["'`])#[0-9a-fA-F]{3,8}\1/.test(l));
const unnamed = canvasLiterals.filter(([, l]) => !/^const (DOC|RASTER)_[A-Z0-9_]+ =/.test(l.trim()));
t(
  `every colour literal in Canvas.tsx is a named document constant (${unnamed.map(([n]) => `line ${n}`).join(", ") || `${canvasLiterals.length} named, none stray`})`,
  unnamed.length === 0,
);
t("Canvas.tsx keeps its documented document-ink constants", /^const DOC_/m.test(canvas) && /^const RASTER_/m.test(canvas));
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

/* ------------------------------- 5. the opt-in Figma-blue canvas-chrome block */
{
  const figma = block(/^\s*html\[data-canvas-chrome="figma"\]\s*\{/m);
  const figmaDark = block(/^\s*html\[data-canvas-chrome="figma"\]\[data-theme="dark"\]\s*\{/m);
  t('styles.css offers an html[data-canvas-chrome="figma"] block', !!figma);
  if (figma && light && dark) {
    // What the override is allowed to answer for: the *selection* family, the
    // dot grid, and the drop target. Not "everything that used to be green" —
    // under identity v3 the brand violet is the default and this block is the
    // opt-in that restores Figma's blue, so the list is a design decision that
    // has to be written down rather than inferred from a hue.
    const CANVAS_CHROME_ROLES = ["--cv-sel", "--cv-sel-wash", "--cv-sel-glow", "--cv-target", "--grid"];
    const declared = Object.keys(figma);
    const missing = CANVAS_CHROME_ROLES.filter((token) => !declared.includes(token));
    t(`the figma block restates the whole selection family (${missing.join(", ") || "none missing"})`,
      missing.length === 0);

    // The blue is one value with one definition, thinned — never a fourth hex to
    // keep in step. Every declared role must equal `--cv-target` from the block
    // (or the block's own blue, thinned by whatever the light column thinned the
    // violet by), so a 0.14 wash written as 0.4 fails and a second hue fails too.
    const blue = (String(figma["--cv-target"] ?? "").trim()) || null;
    const alphaOf = (v) => (String(v).match(/[,/]\s*([\d.]+)\s*\)/) ?? [])[1];
    const rgba = (hex, a) => {
      const h = String(hex).trim().replace("#", "");
      const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
      return `rgba(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)}, ${a})`;
    };
    /** A declared role has to be the blue, thinned the way the light sheet
     *  thinned the brand for that same role. */
    const expected = (token) => {
      const base = String(light[token] ?? "").trim();
      return /^rgba?\(/.test(base) ? rgba(blue, alphaOf(base)) : blue;
    };
    const wrong = declared.filter((token) => token in light).filter((token) => norm(figma[token]) !== norm(expected(token)));
    t(`every role it declares is the same blue, thinned the same way (${wrong.join(", ") || "all correct"})`,
      wrong.length === 0);
    t(`and the block invents no colour of its own beyond that blue (${blue})`, !!blue && /^#[0-9a-fA-F]{6}$/.test(blue));

    // The boundary, stated as a whitelist of what the block may contain rather than
    // a list of what it must not: a `[data-canvas-chrome]` rule that touched
    // `--accent` would recolour every button, focus ring and rail in the app, which
    // is the opposite of what the switch is for — and the list cannot come from the
    // token map, because the map's whole point is that the panel accent is not in it.
    const strays = declared.filter((tk) => !tk.startsWith("--cv-") && tk !== "--grid");
    t(`the override declares only canvas roles (${strays.join(", ") || "none stray"})`, strays.length === 0);
    t("and the door holds: no chrome role reads back through the panel accent",
      !tokenNames.includes("--accent") && !tokenNames.includes("--accent-wash"));
    const extra = declared.filter((tk) => !CANVAS_CHROME_ROLES.includes(tk));
    t(`and nothing outside the selection family (${extra.join(", ") || "nothing"})`, extra.length === 0);
    // Cascade arithmetic, not cosmetics: equal specificity with the theme blocks,
    // so the *only* thing that makes the override win is coming later in the file.
    const at = (re) => {
      const m = re.exec(css);
      return m ? m.index : -1;
    };
    const figmaAt = css.indexOf('html[data-canvas-chrome="figma"]');
    t("it sits after :root and after the dark block, so it wins the cascade",
      figmaAt > at(/^\s*:root,/m) && figmaAt > at(/^\s*html\[data-theme="dark"\]\s*\{/m));
    t("and the dark canvas gets its own grid alpha", !!figmaDark && "--grid" in figmaDark,
      figmaDark ? Object.keys(figmaDark).join(", ") : "no block");
    t("which is the dark sheet's alpha, not the light one",
      !!figmaDark && alphaOf(figmaDark["--grid"]) === alphaOf(dark["--grid"] ?? ""),
      `${alphaOf(figmaDark?.["--grid"] ?? "")} vs ${alphaOf(dark["--grid"] ?? "")}`);
    t("and the dark override changes nothing but the grid",
      !!figmaDark && Object.keys(figmaDark).length === 1, Object.keys(figmaDark ?? {}).join(", "));
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
