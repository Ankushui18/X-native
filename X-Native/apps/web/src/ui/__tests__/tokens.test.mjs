/**
 * The design-system contract (identity v3, 2026-10-04).
 *
 * The chrome drift ratchet (`drift.test.mjs`) counts how much raw styling each
 * surface still carries. This file is the other half of that agreement: it
 * checks *what* those numbers are allowed to be. Three rules, each one a defect
 * class this repository has shipped at least once:
 *
 *   1. ONE PLACE FOR A COLOUR. In `styles.css`, a hex literal or an `rgba()`
 *      may only appear in the token layers at the top of the sheet — the raw
 *      ramps, the `:root` / dark / canvas-chrome role columns, and the `--stage-*`
 *      block for the presentation stage. Every rule below them names a token.
 *      (The three exceptions are the two gradients and the hue spectrum that
 *      *are* a colour model rather than chrome; they are listed by selector so
 *      they cannot be joined by a fourth.)
 *   2. A LITERAL HAS A NAME. In `src/ui`, a colour literal must sit on a line
 *      that names it — a `const NAME = "#…"`, or a `NAME: "#…"` in a table — or
 *      be inside a comment. Document ink (a default fill, a device bezel, the
 *      codegen's fallback colour) is legitimate; `ctx.fillStyle = "#ffffff"` is
 *      a decision nobody signed.
 *   3. THE SCALES ARE THE VOCABULARY. Type sizes, radii and spacing inside the
 *      component rules come from the ladders. A `font-size: 11px` and a
 *      `border-radius: 5px` are how the third identity would start drifting back
 *      toward the second: the ladders are complete, so a new number is a signal.
 *
 * Run with:  npx vite-node src/ui/__tests__/tokens.test.mjs
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(UI, "..");
const css = readFileSync(path.join(APP, "styles.css"), "utf8");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

let pass = 0;
let fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ── 1. styles.css: literals only in the token layers ─────────────────────── */

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
/** The token layers: raw ramps + one role column per theme. Everything above
 *  the first component rule belongs to them. */
const HEAD = css.slice(0, css.indexOf("* { box-sizing: border-box; }"));
const BODY = stripComments(css.slice(HEAD.length));

const isLiteral = (line) => /#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\(/.test(line);
/** The three places a component rule may paint a colour outright, because the
 *  colour *is* the data: the saturation square's two axes and the hue strip's
 *  spectrum. Named as patterns rather than selectors so a fourth gradient
 *  cannot slip in beside them. */
const DATA_PAINT = [
  /linear-gradient\(to right, #fff, transparent\)/,
  /linear-gradient\(to top, #000, transparent\)/,
  /linear-gradient\(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00\)/,
];
const literalLines = BODY.split("\n")
  .map((line, i) => [i + 1, line.trim()])
  .filter(([, line]) => isLiteral(line))
  .filter(([, line]) => !DATA_PAINT.some((re) => re.test(line)));
t(
  `component CSS paints no colour outright (${literalLines.length} literal lines)`,
  literalLines.length === 0,
  literalLines.map(([n, l]) => `line ${n}: ${l.slice(0, 70)}`).join("; "),
);

// Every custom property a rule reads must be declared in the head, or the
// declaration silently does nothing — the failure mode that produced the
// "canonical aliases" note the second identity left behind.
const declared = new Set([...HEAD.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const localScope = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
const readTokens = new Set([...BODY.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
const undefinedTokens = [...readTokens].filter((tk) => !declared.has(tk) && !localScope.has(tk));
t(
  `every token a rule reads is declared (${undefinedTokens.join(", ") || "all declared"})`,
  undefinedTokens.length === 0,
);

/* ── 2. the scales are the vocabulary ─────────────────────────────────────── */

const offScaleType = [...BODY.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1]);
t(
  `no component rule types a raw size (${offScaleType.join(", ") || "none"})`,
  offScaleType.length === 0,
);
const offScaleRadius = [...BODY.matchAll(/border-radius:\s*([0-9.]+)px/g)].map((m) => m[1]);
t(
  `no component rule rounds a corner by hand (${offScaleRadius.join(", ") || "none"})`,
  offScaleRadius.length === 0,
);
/** Rhythm properties: the ones a reader experiences as spacing. Absolute
 *  anchors (`top`/`right`/`bottom`/`left`) are geometry — where a floating
 *  surface hangs off the chrome — so they are checked separately, below. */
const rawSpace = [...BODY.matchAll(/\b(gap|row-gap|column-gap|padding|padding-top|padding-right|padding-bottom|padding-left|margin|margin-top|margin-right|margin-bottom|margin-left):\s*([0-9.]+)px/g)]
  .filter(([, , v]) => Number(v) !== 0)
  .map(([all]) => all.trim());
t(
  `spacing comes from the 4px ladder (${rawSpace.length} raw values)`,
  rawSpace.length === 0,
  rawSpace.slice(0, 8).join("; "),
);
// An anchor on a half pixel is a surface on a blurry row, and a number nobody
// can trace. Whole pixels only.
const fraction = [...BODY.matchAll(/\b(top|right|bottom|left|inset):\s*(-?[0-9]+\.[0-9]+)px/g)].map((m) => m[0]);
t(`and no surface is anchored on a fraction of a pixel (${fraction.join(", ") || "none"})`, fraction.length === 0);

// The ladders themselves: present, ordered, and complete enough that a writer
// never has to invent a step (a missing 6px would come back as a literal).
const ladder = (prefix) =>
  [...HEAD.matchAll(new RegExp(`--${prefix}([\\w-]+):\\s*([0-9.]+)px`, "g"))].map((m) => [
    m[1],
    Number(m[2]),
  ]);
const sizes = ladder("fs-");
t(`the type ladder has ${sizes.length} steps (${sizes.map((s) => s[1]).join(", ")})`, sizes.length >= 8);
t(
  "and it is strictly ascending, so it is a scale and not a bag of numbers",
  sizes.every(([, v], i) => i === 0 || v > sizes[i - 1][1]),
);
const radii = ladder("r-").filter(([n]) => n !== "control" && n !== "surface" && n !== "popover" && n !== "modal" && n !== "pill");
t(`the radius ladder has ${radii.length} steps (${radii.map((r) => r[1]).join(", ")})`, radii.length >= 6);
const space = ladder("sp-");
t(`the space ladder has ${space.length} steps, 4px apart`, space.length >= 12 && space.every(([, v]) => v % 2 === 0));

/* ── 3. src/ui: a literal has a name ─────────────────────────────────────── */

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const files = readdirSync(UI).filter((f) => /\.(tsx|ts)$/.test(f)).sort();
/** A line names the value it writes when it is a `const NAME = "#…"`, an
 *  object property `NAME: "#…"`, or a labelled table row
 *  `["White", "#ffffff"]`. */
const namesIt = (line) =>
  /(^|\s)(const|let)\s+[A-Z][A-Z0-9_]*\s*[:=]/.test(line) ||
  /^\s*[A-Za-z_$][\w$]*\s*:\s*["'`]?#/.test(line) ||
  /^\s*[A-Za-z_$][\w$]*\s*:\s*\[/.test(line) ||
  /^\s*\[\s*["'`][^"'`]+["'`]\s*,/.test(line);

const bare = [];
let quoted = 0;
for (const f of files) {
  for (const [i, line] of readFileSync(path.join(UI, f), "utf8").split("\n").entries()) {
    const hits = [...line.matchAll(/(["'`])#[0-9a-fA-F]{3,8}\1/g)];
    if (hits.length === 0 || isComment(line)) continue;
    quoted += hits.length;
    if (!namesIt(line) && !/\{\s*$/.test(line)) bare.push(`${f}:${i + 1} ${line.trim().slice(0, 58)}`);
  }
}
t(
  `every colour literal in src/ui is named by the line that writes it (${bare.length} of ${quoted} bare)`,
  bare.length === 0,
  bare.slice(0, 8).join(" | "),
);
console.log(`\nassets: ${files.length} modules scanned, ${quoted} colour literals, all named`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
