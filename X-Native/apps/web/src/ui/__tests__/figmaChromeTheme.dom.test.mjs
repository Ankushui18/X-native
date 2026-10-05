/**
 * The Figma-blue canvas chrome, in pixels — the one claim the rest of the suite
 * could only make in text (batch 45 follow-up, 2026-10-04).
 *
 * `canvasChrome.test.mjs` §5 proves `styles.css` declares the override correctly,
 * and `canvasChromePref.test.mjs` proves the attribute is written, persisted, and
 * taken as a paint dependency by all three surfaces. What neither proves is the
 * link between them: that a value read out of the cascade ends up as the colour of
 * a ring on the canvas. jsdom has no cascade for custom properties —
 * `getPropertyValue("--cv-sel")` answers "" — so that last step used to be a human
 * one, and it was the step the whole theme exists for.
 *
 * So this file brings the missing machine: a small reader for the sheet's
 * top-level `:root` / `html[…]` rules, applied in document order and installed as
 * jsdom's `getComputedStyle` for custom properties only. Then it mounts the real
 * canvas on the real Skia backend (`realCanvas2d`), clicks the real menu row in
 * the real `NavRail`, and reads composited device pixels: brand violet before the
 * click, Figma azure after, violet again after switching back — and nothing at all
 * where the painted rotation handle used to live, in either palette.
 *
 * The model deliberately does not re-derive specificity. It applies the *last*
 * matching rule, which is correct here only because the sheet is ordered that way —
 * and §5 of `canvasChrome.test.mjs` pins exactly that ordering for the
 * `[data-canvas-chrome]` block. If the sheet ever needs real specificity, this file
 * must stop agreeing with a browser, and it should: the sheet would then be wrong.
 *
 * The rails and the thumbnail are sampled beside the canvas because that is where a
 * chrome theme is easiest to half-do: both framed the selection with the *panel*
 * accent (`--accent`), which no canvas-chrome theme is allowed to move. They read
 * the selection role now, and the `accent` / `accentWash` roles were deleted from
 * `canvasChrome.ts`, so nothing can reach back through the door — the file that
 * owns the whitelist is `canvasChrome.test.mjs` §5.
 *
 * It earned its keep on the first run. The click wrote the attribute, the sheet
 * said blue, and the pixels stayed on the old ink — because the preference had been
 * applied from a `useEffect` in `ThemeProvider`, and the write landed in the same
 * commit as the repaint it was supposed to drive. `theme.tsx` now writes it in the
 * setter, before the state update, and `canvasChromePref.test.mjs` pins that order
 * in text as well, because the text pin is free.
 *
 * The second claim here had to be corrected, and the reason is worth keeping. An
 * earlier round recorded that re-creating the effect shape as a sabotage *passed*
 * this file — jsdom's passive-effect order was said not to reproduce the browser's,
 * so the ordering was claimed uncatchable in pixels. It is catchable: the last run
 * of that break fails 5 assertions, with exactly the bug's signature (the ring, the
 * label, the rails and the thumbnail still on the default ink against a blue
 * sheet). The zero
 * had been produced by the sabotage *driver*, which re-read the pristine file for
 * every patch instead of the patched one, so a break expressed as two edits to one
 * file applied the second and silently undid the first — the harness measured
 * "nothing writes the attribute" and concluded "the ordering does not matter here".
 * A green sabotage log is not evidence about the product until the rig that
 * produced it has itself been checked.
 *
 * Sabotage log — each break applied to the source, this file re-run, then
 * restored; the number after the arrow is how many assertions caught it, and
 * where it is not this file, the other file is named:
 *   - `--cv-sel` dropped from the figma block                   -> 8  (+2 in `canvasChrome` §5)
 *   - the attribute never written                                -> 5  (+2 in `canvasChromePref`)
 *   - the flip dropped from the canvas paint effect's deps       -> 2
 *   - the rotation dot repainted at the band                     -> 2  (+2 in the parity file)
 *   - the layer label stopped following the selection            -> 2
 *   - the ruler markers stopped following the selection          -> 2
 *   - the minimap painted the selection in a literal green       -> 2  (+1 in `canvasChromePref`)
 *   - the rulers' range wash did the same                        -> 0 here, 1 in `canvasChromePref`
 *   - the theme recoloured `--accent` in the sheet               -> 2 in `canvasChrome` §5
 *   - `accent` added back to the role map                        -> 1 in `canvasChrome` §5
 *   - the multi-selection box shrunk to 5px                      -> 1 in the parity file
 *   - the apply moved back into a parent `useEffect`              -> 5 — see above
 *
 * The one zero here is the harness's shape, not a gap in the claim: a wash at 0.14
 * alpha over white survives neither the hue rule nor a channel distance, so the ink
 * of the ruler range and the minimap viewport rectangle is pinned as source. What
 * the pixels do cover is that the two companions repaint at all for a flip, and in
 * which hue their selection marks are.
 *
 * Run with: npx vite-node src/ui/__tests__/figmaChromeTheme.dom.test.mjs
 *
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(path.join(HERE, "..", "..", "styles.css"), "utf8");

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};

/* ------------------------------------------------- the sheet, read as a cascade */

/** Top-level rule bodies of `styles.css`, in document order, at-rules skipped. */
function rootRules(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let i = 0;
  let selStart = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "@") {
      // At-rules are their own scope: skip the whole block, braces balanced.
      const brace = src.indexOf("{", i);
      const semi = src.indexOf(";", i);
      if (brace < 0 || (semi >= 0 && semi < brace)) {
        i = (semi < 0 ? src.length : semi + 1);
        selStart = i;
        continue;
      }
      let d = 0;
      let j = brace;
      for (; j < src.length; j++) {
        if (src[j] === "{") d++;
        else if (src[j] === "}" && --d === 0) break;
      }
      i = j + 1;
      selStart = i;
      continue;
    }
    if (c === "{") {
      const sel = src.slice(selStart, i).trim();
      let d = 1;
      let j = i + 1;
      for (; j < src.length && d > 0; j++) {
        if (src[j] === "{") d++;
        else if (src[j] === "}") d--;
      }
      out.push({ sel, body: src.slice(i + 1, j - 1) });
      i = j;
      selStart = j;
      continue;
    }
    if (c === "}") {
      selStart = i + 1;
    }
    i++;
  }
  return out;
}

const RULES = rootRules(sheet);

/** Does one selector apply to `<html>` with these attributes? */
function matches(sel, attrs) {
  return sel.split(",").some((raw) => {
    const part = raw.trim();
    if (part === ":root" || part === "html") return true;
    const m = /^html((?:\[[^\]]+\])+)$/.exec(part);
    if (!m) return false;
    for (const cond of m[1].match(/\[[^\]]+\]/g) ?? []) {
      const c = /^\[([^\]=]+)(?:="?([^\]"]*)"?)?\]$/.exec(cond);
      if (!c) return false;
      const value = attrs[c[1]];
      if (c[2] === undefined) {
        if (value === undefined) return false;
      } else if (value !== c[2]) return false;
    }
    return true;
  });
}

const declCache = new Map();
/** The custom properties `<html>` resolves to, with the given attributes. */
function cascadeFor(attrs) {
  const key = JSON.stringify(attrs);
  if (declCache.has(key)) return declCache.get(key);
  const out = {};
  for (const rule of RULES) {
    if (!matches(rule.sel, attrs)) continue;
    for (const d of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[d[1]] = d[2].trim();
    }
  }
  declCache.set(key, out);
  return out;
}

const rootAttrs = () => {
  const d = document.documentElement.dataset;
  return { "data-theme": d.theme, "data-canvas-chrome": d.canvasChrome };
};

/* ------------------------------------------------------ jsdom, given a cascade */

// Loaded for its side effect: it replaces `HTMLCanvasElement.prototype.getContext`
// with a Skia backing, which is what makes reading real pixels possible. The mount
// below is this file's own, because it needs the rail in the same tree.
await import("./realCanvas2d.mjs");
const window = globalThis.window;
const realGetComputedStyle = window.getComputedStyle.bind(window);
let reads = 0;
const misses = new Set();

function styled(el, base) {
  const map = cascadeFor(rootAttrs());
  return new Proxy(base, {
    get(tg, key) {
      if (key === "getPropertyValue") {
        return (token) => {
          if (token in map) {
            reads++;
            return map[token];
          }
          if (token.startsWith("--cv-")) misses.add(token);
          return tg.getPropertyValue(token);
        };
      }
      const v = tg[key];
      return typeof v === "function" ? v.bind(tg) : v;
    },
  });
}

const patchedGetComputedStyle = (el, pseudo) => {
  const base = realGetComputedStyle(el, pseudo);
  return el === document.documentElement ? styled(el, base) : base;
};
window.getComputedStyle = patchedGetComputedStyle;
globalThis.getComputedStyle = patchedGetComputedStyle;

const { CANVAS_CHROME_FALLBACK } = await import("../canvasChrome.ts");

/* ------------------------------------------------------------- colour helpers */

// The two inks this file measures. In identity v3 the editor's selection chrome is
// the brand *violet* and the opt-in Figma palette is the azure — two blues, so the
// hue rule below separates them by which channel is strongest, and a scan that
// muddled them would pass while proving nothing.
const BRAND = { r: 0x5b, g: 0x3d, b: 0xf5 };
const BLUE = { r: 0x0d, g: 0x99, b: 0xff };
const hue = (p) => {
  if (p.g > p.r + 12 && p.g > p.b + 12) return "green";
  if (p.b > p.r + 12 && p.b > p.g + 12) return p.r > p.g + 12 ? "violet" : "azure";
  if (p.r > p.g + 12 && p.r > p.b + 12) return "red";
  return "other";
};
const close = (p, c) => Math.abs(p.r - c.r) <= 8 && Math.abs(p.g - c.g) <= 8 && Math.abs(p.b - c.b) <= 8;
const scan = (grab, x0, y0, x1, y1) => {
  const n = { violet: 0, azure: 0, green: 0, red: 0, other: 0, brand: 0, figma: 0 };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = grab(x, y);
      n[hue(p)]++;
      if (close(p, BRAND)) n.brand++;
      if (close(p, BLUE)) n.figma++;
    }
  }
  return n;
};
const sum = (a, b, key) => a[key] + b[key];

/* ---------------------------------------------------- 1. the reader is honest */

t(`the reader found the sheet's root rules (${RULES.length} top-level blocks)`, RULES.length > 20);
{
  const light = cascadeFor({ "data-theme": "light" });
  const dark = cascadeFor({ "data-theme": "dark" });
  const figma = cascadeFor({ "data-theme": "light", "data-canvas-chrome": "figma" });
  const figmaDark = cascadeFor({ "data-theme": "dark", "data-canvas-chrome": "figma" });
  t("it resolves the light selection ink to the brand violet", light["--cv-sel"] === "#5b3df5", String(light["--cv-sel"]));
  t("and the dark column retunes it rather than repeating it (that is FR-U2b, done)",
    dark["--cv-sel"] === "#8b7cff", String(dark["--cv-sel"]));
  t("the Figma attribute turns it azure", figma["--cv-sel"] === "#0d99ff", String(figma["--cv-sel"]));
  t("in the dark scheme too — the opt-in override is one palette, not two",
    figmaDark["--cv-sel"] === "#0d99ff", String(figmaDark["--cv-sel"]));
  t("the grid follows it, at each scheme's own alpha",
    figma["--grid"] === "rgba(13, 153, 255, 0.07)" && figmaDark["--grid"] === "rgba(13, 153, 255, 0.1)",
    `${figma["--grid"]} / ${figmaDark["--grid"]}`);
  // The accent is declared as a ramp reference (`--accent: var(--b-600)`), so the
  // reader hands back the *declaration*, not a resolved colour — the contract is
  // that the override does not restate it, and that the ramp lands on the brand.
  t("while the panel accent stays the app's",
    figma["--accent"] === light["--accent"] && figma["--b-600"] === "#5b3df5",
    `${figma["--accent"]} → ${figma["--b-600"]}`);
  t("and so does the drop target: the switch moves the selection, not the whole canvas",
    figma["--cv-target"] === "#0d99ff" && light["--cv-target"] === "#00b3d4", `${figma["--cv-target"]} / ${light["--cv-target"]}`);
  t("the value came from the sheet, not from the fallbacks",
    figma["--cv-sel"] !== CANVAS_CHROME_FALLBACK.sel && light["--cv-sel"] === CANVAS_CHROME_FALLBACK.sel);
  t("an unknown attribute answers nothing rather than guessing",
    cascadeFor({ "data-canvas-chrome": "figma" })["--cv-sel"] === "#0d99ff"
    && cascadeFor({ "data-theme": "graphite" })["--cv-sel"] === "#5b3df5");
}

/* ---------------------------------- 2. the app, mounted, clicked, and sampled */

// The frame is 300×200 at world (100,100), and the view is zoom 2, so its screen
// box is (200,200)-(800,600) with pan 0 — chrome lands on whole pixel rows.
const { node } = await import("../../engine/memory.ts");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { NavRail } = await import("../chrome.tsx");
const { MemoryEngine } = await import("../../engine/memory.ts");
const { act, useSyncExternalStore } = React;

// No fill: the page's white shows through, so any saturated pixel inside the box
// or on its edge can only be chrome.
const frame = node("frame", "Frame 2121453036", 100, 100, 300, 200);
const engine = new MemoryEngine(false, {
  pages: [{ id: "p", name: "Page", root: node("frame", "Page", 0, 0, 2000, 2000, { children: [frame] }), guides: [], comments: [] }],
  page: 0,
  zoom: 2,
  panX: 0,
  panY: 0,
  // The document, not the page, owns the view overlays — and both companions are
  // mounted here because the whole point is what they paint.
  showRulers: true,
  showMinimap: true,
});

function Host() {
  const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
  return React.createElement(
    ThemeProvider,
    null,
    React.createElement(NavRail, { engine, nav: "file", setNav: () => {}, onActions: () => {} }),
    React.createElement(Canvas, { engine, snap }),
  );
}

const host = document.createElement("div");
document.body.appendChild(host);
const reactRoot = createRoot(host);
await act(async () => reactRoot.render(React.createElement(Host)));
const canvasEl = host.querySelector("canvas");
const surface = canvasEl.__probeCanvas;
const grab = () => {
  const w = surface.width;
  const h = surface.height;
  const img = surface.getContext("2d").getImageData(0, 0, w, h);
  return (x, y) => {
    const i = (y * img.width + x) * 4;
    return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] / 255 };
  };
};
const click = async (el) => act(async () => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));

// The band across the top edge of the selection ring, away from the corners, and
// the label above the frame's top-left corner.
const RING = [240, 197, 760, 204];
const LABEL = [200, 182, 360, 196];
// Where the painted rotation dot used to sit: the band centre is the frame's
// top-right corner 20px above it, i.e. world (400,80) → device (800,160).
const OLD_HANDLE = [770, 130, 830, 190];

t("the canvas mounted on the Skia backend", !!surface && surface.width > 0, `${surface?.width}×${surface?.height}`);
/** The two companion surfaces read the same cascade through `canvasChrome()`; they
 *  are where a chrome theme is easiest to half-do, so they are sampled too. */
const scanSurface = (el) => {
  const surf = el?.__probeCanvas;
  if (!surf || !surf.width) return null;
  const img = surf.getContext("2d").getImageData(0, 0, surf.width, surf.height);
  const n = { violet: 0, azure: 0, green: 0, red: 0, other: 0, brand: 0, figma: 0 };
  for (let i = 0; i < img.data.length; i += 4) {
    const q = { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] };
    n[hue(q)]++;
    if (close(q, BRAND)) n.brand++;
    if (close(q, BLUE)) n.figma++;
  }
  return n;
};
const rulersEl = host.querySelector("canvas.rulers");
const miniEl = host.querySelector(".minimap canvas");
t("the rulers and the minimap are mounted next to it", !!rulersEl && !!miniEl,
  `${host.querySelectorAll("canvas").length} canvases`);
await act(async () => engine.dispatch({ type: "select", ids: [frame.id] }));
t("and the paint asked the cascade for real custom properties", reads > 0, `${reads} reads`);
t(`every canvas role it asked for came out of the sheet (${[...misses].join(", ") || "no misses"})`,
  misses.size === 0);

const before = scan(grab(), ...RING);
t("the selected frame's ring is painted in the brand violet", before.brand > 200, `${before.brand} exact-brand px`);
t("with no Figma azure anywhere in it", before.azure === 0 && before.figma === 0, JSON.stringify(before));
const labelBefore = scan(grab(), ...LABEL);
t("the frame's name is violet while it is selected", labelBefore.brand > 4, `${labelBefore.brand} px`);
const rulersBefore = scanSurface(rulersEl);
const miniBefore = scanSurface(miniEl);
t("the rails and the thumbnail carry the brand too",
  !!rulersBefore && !!miniBefore && rulersBefore.brand > 4 && miniBefore.brand > 20,
  JSON.stringify({ rulers: rulersBefore, minimap: miniBefore }));
const gapBefore = scan(grab(), ...OLD_HANDLE);
t("nothing is painted where the rotation handle used to be",
  gapBefore.green === 0 && gapBefore.azure === 0 && gapBefore.violet === 0 && gapBefore.other > 0,
  JSON.stringify(gapBefore));

// The menu row is the control under test, so the click goes through it. Two
// rules, learned while writing this: re-query immediately before clicking (React
// re-renders the rail whenever the document does, and a stale element handle is
// detached — a click on a detached node bubbles to nothing and the test would
// "fail" for the wrong reason), and expect the row to stay put once chosen, since
// these menu buttons do not dismiss the sheet.
const pick = async (text) => {
  if (!host.querySelector(".rail .menu")) await click(host.querySelector(".rail .logo"));
  const menu = host.querySelector(".rail .menu");
  const btn = [...(menu?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith(text));
  if (!btn) return "no such row";
  if (!btn.isConnected) return "row was detached by a re-render";
  await click(btn);
  return "";
};

await click(host.querySelector(".rail .logo"));
const menu = host.querySelector(".rail .menu");
t("the rail menu opens", !!menu);
const rows = [...(menu?.querySelectorAll("button") ?? [])].map((b) => b.textContent.replace(/\s+/g, " ").trim());
t("it offers both canvas palettes, and marks the live one",
  rows.some((r) => r.startsWith("Editor✓")) && rows.some((r) => r.startsWith("Figma blue")),
  rows.join(" | ").slice(0, 150));
await pick("Figma blue");
t("the click writes the attribute the sheet keys off",
  document.documentElement.dataset.canvasChrome === "figma", JSON.stringify(document.documentElement.dataset));
const after = scan(grab(), ...RING);
t("the ring is Figma azure now — same pixels, other palette", after.figma > 200 && after.brand === 0,
  JSON.stringify(after));
const labelAfter = scan(grab(), ...LABEL);
t("the layer name followed it", labelAfter.figma > 4 && labelAfter.brand === 0, JSON.stringify(labelAfter));
const rulersAfter = scanSurface(rulersEl);
const miniAfter = scanSurface(miniEl);
t("the ruler marker turned with it", !!rulersAfter && rulersAfter.figma > 4 && rulersAfter.brand === 0,
  JSON.stringify(rulersAfter));
t("and so did the thumbnail's selection box", !!miniAfter && miniAfter.figma > 20 && miniAfter.brand === 0,
  JSON.stringify(miniAfter));
t("and still nothing at the rotation band", (() => {
  const g = scan(grab(), ...OLD_HANDLE);
  return g.green === 0 && g.azure === 0 && g.violet === 0;
})());

await pick("Editor");
t("switching back removes the attribute instead of writing the default value",
  document.documentElement.dataset.canvasChrome === undefined, JSON.stringify(document.documentElement.dataset));
const back = scan(grab(), ...RING);
t("and the canvas is violet again", back.brand > 200 && back.azure === 0, JSON.stringify(back));
t("the choice persisted under its own key",
  window.localStorage.getItem("x-native-canvas-chrome") === "editor",
  String(window.localStorage.getItem("x-native-canvas-chrome")));
t("the colour-scheme preference was not disturbed",
  window.localStorage.getItem("x-native-theme") === "light",
  String(window.localStorage.getItem("x-native-theme")));

await act(async () => reactRoot.unmount());
host.remove();
console.log(`figmaChromeTheme: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
