/**
 * The canvas-chrome preference: what the menu offers, how a stored value is
 * reduced, what the attribute does, and which wiring has to stay in place for a
 * flip to reach the pixels.
 *
 * (Batch 45, 2026-10-04. The tester's screenshots showed Figma painting blue
 * selection chrome and nothing at the rotation target; this app's chrome is
 * emerald by decision, so the answer was not to recolour the app but to give the
 * canvas a second palette that can be switched on. `themeModel.ts` owns the
 * preference, `styles.css` owns the colours — the contract that the override
 * block is *complete* lives next door in `canvasChrome.test.mjs` §5 — and this
 * file owns the two things nobody has noticed going wrong: a preference that
 * parses but never persists, and a preference that persists but never repaints.)
 *
 * No DOM here: `applyCanvasChromePref` takes its root as an argument, so a plain
 * object with a `dataset` is the whole test rig, and the wiring half is source
 * text — which is also how it survives a refactor of the component tree.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CANVAS_CHROME_OPTIONS,
  DEFAULT_CANVAS_CHROME_PREF,
  applyCanvasChromePref,
  canvasChromeLabel,
  normalizeCanvasChromePref,
} from "../themeModel.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

/* ------------------------------------------------------------ 1. what is on offer */
t(`the menu has two options (${CANVAS_CHROME_OPTIONS.map((o) => o.label).join(", ")})`,
  CANVAS_CHROME_OPTIONS.length === 2);
t("the first one is the default, so a fresh install matches what ships",
  CANVAS_CHROME_OPTIONS[0].id === DEFAULT_CANVAS_CHROME_PREF);
t("ids are unique", new Set(CANVAS_CHROME_OPTIONS.map((o) => o.id)).size === CANVAS_CHROME_OPTIONS.length);
t("labels are sayable, not identifiers",
  CANVAS_CHROME_OPTIONS.every((o) => /[a-z]/.test(o.label) && o.label !== o.id));
t("and every option is something the normalizer accepts",
  CANVAS_CHROME_OPTIONS.every((o) => normalizeCanvasChromePref(o.id) === o.id));
t("the menu labels itself", canvasChromeLabel("figma") === "Figma blue" && canvasChromeLabel("editor") === "Editor");
t("and a value the menu does not offer labels as the default rather than `undefined`",
  canvasChromeLabel("graphite") === "Editor");

/* ------------------------------------------- 2. a stored preference, reduced */
const CASES = [
  ["figma", "figma"],
  ["editor", "editor"],
  ["  Figma  ", "figma"],
  ["FIGMA", "figma"],
  // First visit, and everything a hostile or older build could have written.
  [null, "editor"],
  [undefined, "editor"],
  ["", "editor"],
  ["graphite", "editor"],
  ["0", "editor"],
  [0, "editor"],
  [{}, "editor"],
  [["figma"], "editor"],
];
for (const [raw, want] of CASES) {
  t(`normalize(${JSON.stringify(raw)}) → ${want}`, normalizeCanvasChromePref(raw) === want,
    String(normalizeCanvasChromePref(raw)));
}

/* ---------------------------------------------- 3. the attribute the sheet reads */
{
  const root = { dataset: {} };
  applyCanvasChromePref("figma", root);
  t('figma writes data-canvas-chrome="figma"', root.dataset.canvasChrome === "figma",
    JSON.stringify(root.dataset));
  applyCanvasChromePref("editor", root);
  t("editor removes it again — an absent attribute is the state the sheet assumes",
    !("canvasChrome" in root.dataset) && root.dataset.canvasChrome === undefined,
    JSON.stringify(root.dataset));
  applyCanvasChromePref("editor", root);
  t("and switching off twice is idempotent, not a thrown delete",
    !("canvasChrome" in root.dataset), JSON.stringify(root.dataset));
  applyCanvasChromePref("figma", root);
  t("the other theme attributes survive the write", (() => {
    root.dataset.theme = "dark";
    applyCanvasChromePref("figma", root);
    return root.dataset.theme === "dark" && root.dataset.canvasChrome === "figma";
  })());
  let threw = "";
  try {
    applyCanvasChromePref("figma", null);
    applyCanvasChromePref("figma", {});
  } catch (e) {
    threw = String(e && e.message);
  }
  t(`a root that is not there does not throw (${threw || "no throw"})`, !threw);
}

/* -------------------------------------------------- 4. the wiring that makes it real */
{
  const theme = read("theme.tsx");
  const model = read("themeModel.ts");
  const canvas = read("Canvas.tsx");
  const rulers = read("Rulers.tsx");
  const minimap = read("Minimap.tsx");
  const chrome = read("chrome.tsx");

  // Its own key: the colour scheme and the canvas palette are independent choices.
  t("the preference persists under its own storage key",
    /x-native-canvas-chrome/.test(theme) && /localStorage\.setItem\(\s*CHROME_KEY\s*,\s*next\s*\)/.test(theme));
  t("and is read before the first paint, so a reload does not flash the other palette",
    /applyCanvasChromePref\(readChromePref\(\)/.test(theme));
  t("the read goes through the normalizer, so a stale value cannot survive",
    /normalizeCanvasChromePref\(localStorage\.getItem\(CHROME_KEY\)\)/.test(theme));
  t("the writer itself lives in the model, not in the component",
    /export function applyCanvasChromePref/.test(model) && !/dataset\.canvasChrome\s*=/.test(theme));
  t("the provider exposes both the value and the setter",
    /chromePref,\s*setChromePref\s*[,}]/.test(theme));
  // Ordering, because it is the bug that actually happened: applied from a
  // `ThemeProvider` effect, the write could land after the canvas had re-read the
  // cascade — the preference persisted, the sheet said blue, and the ring stayed
  // emerald. That is what it did in a browser. jsdom's effect order will not
  // reproduce it on demand (a sabotage putting it back passes the pixel file), so
  // the order is pinned here, in text, and `figmaChromeTheme.dom.test.mjs`
  // asserts the consequence that matters: the canvas does repaint for the flip.
  const setter = (theme.match(/const setChromePref = useCallback\(\([\s\S]*?\}, \[\]\);/) ?? [""])[0];
  t("the setter writes the attribute before it updates state",
    /applyCanvasChromePref\(next[\s\S]*?setChromePrefState\(next\)/.test(setter), setter.slice(0, 80));
  t("and nothing applies it from an effect", !/useEffect\(\(\) => \{\s*applyCanvasChromePref/.test(theme));
  // A memo left on `[pref, theme]` hands back the same object, every consumer
  // bails out of its re-render, and the chrome keeps painting the old colour
  // until the user pans. That is the bug these two lines exist to keep dead.
  const memo = (theme.match(/const value = useMemo\([\s\S]*?\);/) ?? [""])[0];
  const memoDeps = (memo.match(/\[([^\]]*)\]\s*,?\s*\);/) ?? [])[1] ?? "";
  t("the context memo carries the chrome preference and its setter",
    /setChromePref\s*[,}]/.test(memo) && /chromePref,/.test(memo), memo.slice(0, 70));
  t("and depends on it, so consumers actually re-render",
    memoDeps.includes("chromePref"), `deps: ${memoDeps || "not found"}`);

  // Each surface reads the palette out of the cascade at paint time, so the only
  // thing that makes a flip visible is a dependency that changed.
  t("Canvas takes it from the context", /const \{ theme, chromePref \} = useTheme\(\);/.test(canvas));
  t("and lists it in the paint effect's deps", /\}, \[[^\]]*\btheme, chromePref,[^\]]*\]/.test(canvas),
    (canvas.match(/\}, \[snap, band,[^\n]*/)?.[0] ?? "no deps line").slice(0, 90));
  t("the rulers repaint for it", /theme,\s*chrome\]/.test(rulers) && /chrome: string;/.test(rulers));
  t("the minimap repaints for it", /theme,\s*chrome\]/.test(minimap) && /chrome: string;/.test(minimap));
  t("Canvas passes the preference to both",
    (canvas.match(/chrome=\{chromePref\}/g) ?? []).length === 2,
    String((canvas.match(/chrome=\{chromePref\}/g) ?? []).length));

  // The menu half: an option nobody can click is a feature flag.
  t("the rail menu offers the options", /CANVAS_CHROME_OPTIONS\.map/.test(chrome));
  t("and marks the live one", /chromePref === o\.id/.test(chrome));
  t("it is a separate row, not a fourth theme entry",
    /Canvas chrome/.test(chrome) && !/THEME_OPTIONS\.map[\s\S]{0,200}setChromePref/.test(chrome));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
