/**
 * The first-run hint's memory, and the card it drives (LP-U4).
 *
 * An empty canvas was the coldest screen in the product: the dock, the panels and
 * the inspector all render, and not one of them says what to do. The fix is a
 * card over the empty page that teaches the three chords and then gets out of the
 * way — permanently, because a hint that comes back every session is noise.
 *
 * "Permanently" is the part worth testing: it is one localStorage key, read
 * before first paint so the card does not flash for someone who has already
 * dismissed it. localStorage throws in private mode, is absent in node and is
 * absent in SSR, so `firstRun.ts` guards every access and takes an injected
 * store — which is what the first half of this file exercises, with no browser
 * and no DOM. The second half is the source contract for the card itself:
 * rendered from classes, dismissed through the shared button primitive, and
 * click-through so it cannot eat the drag it is describing.
 *
 * The visible half — where the card sits, that a drag through it really draws —
 * belongs to the browser suite (§44 of e2e/behaviour.mjs).
 *
 * Run with:  npx vite-node src/ui/__tests__/firstRun.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  EMPTY_CANVAS_HINT_KEY,
  dismissEmptyCanvasHint,
  emptyCanvasHintDismissed,
  hintStore,
} from "../firstRun.ts";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`FAIL ${name}`);
};

/** A store that remembers, so "next session" can be simulated. */
function mem() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

/* ── the memory ─────────────────────────────────────────────────────────── */

t("a first-time visitor has not dismissed the hint", emptyCanvasHintDismissed(mem()) === false);
const store = mem();
dismissEmptyCanvasHint(store);
t("dismissing records it", emptyCanvasHintDismissed(store) === true);
// A reload is a new reader over the same persisted key, not the same object.
const nextSession = { getItem: (k) => store._map.get(k) ?? null, setItem: () => {} };
t("and the dismissal outlives the session that made it", emptyCanvasHintDismissed(nextSession) === true);
t(`the record is one key, set to "1" (${[...store._map].map(([k, v]) => `${k}=${v}`).join()})`,
  store._map.size === 1 && store._map.get(EMPTY_CANVAS_HINT_KEY) === "1");

const hostile = {
  getItem() { throw new Error("private mode"); },
  setItem() { throw new Error("private mode"); },
};
let threw = "";
try {
  emptyCanvasHintDismissed(hostile);
  dismissEmptyCanvasHint(hostile);
} catch (e) {
  threw = String(e && e.message);
}
t(`a store that throws on both ends is survived (${threw || "no throw"})`, threw === "");
t("and reads as not-dismissed, so the hint still shows", emptyCanvasHintDismissed(hostile) === false);
t("no store at all is the same answer", emptyCanvasHintDismissed(null) === false);
let storeThrew = "";
let resolved;
try {
  resolved = hintStore();
} catch (e) {
  storeThrew = String(e && e.message);
}
t(`hintStore() does not throw where there is no localStorage (${storeThrew || "no throw"})`, !storeThrew);
t(`and resolves to ${resolved === null ? "null" : "a store"} in node`,
  resolved === null || typeof resolved.getItem === "function");

// The browser suite wipes every `x-native-*` key except the theme before a check
// runs, so a namespaced key is what lets §44 start from a first-time visitor.
t(`the key is namespaced for that wipe (${EMPTY_CANVAS_HINT_KEY})`,
  EMPTY_CANVAS_HINT_KEY.startsWith("x-native-") && EMPTY_CANVAS_HINT_KEY !== "x-native-theme");

/* ── the card it drives ─────────────────────────────────────────────────── */

const canvas = read("Canvas.tsx");
const css = readFileSync(path.join(UI, "..", "styles.css"), "utf8");

t("the card is rendered from a class, not a style object",
  /className="canvas-hint"/.test(canvas) && !/className="canvas-hint"[^>]*?\bstyle=/.test(canvas));
t("and only for an empty page outside a presentation",
  /firstRun && docRoot\.children\.length === 0 && !snap\.presentFrame/.test(canvas));
t("the state is seeded from the persisted dismissal, so it cannot flash",
  /useState\(\(\) => !emptyCanvasHintDismissed\(\)\)/.test(canvas));
t("dismissing persists before it hides",
  /dismissEmptyCanvasHint\(\);\s*setFirstRun\(false\);/.test(canvas));
t("the control is the shared button primitive, not a raw <button>",
  /className="canvas-hint-x"/.test(canvas) && !/<button[^>]*canvas-hint/.test(canvas));
t("and it teaches the chords it names",
  /<kbd>F<\/kbd>/.test(canvas) && /<kbd>R<\/kbd>/.test(canvas) && /<kbd>T<\/kbd>/.test(canvas));

// The card floats over the surface whose drag it is describing.
const block = (selector) => {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
};
const hintCss = block(".canvas-hint {");
t("the sheet positions the card over the canvas", /position: absolute/.test(hintCss));
t("and makes it click-through", /pointer-events: none/.test(hintCss));
t("while its own button keeps its events", /pointer-events: auto/.test(block(".canvas-hint-x {")));
t("the card stays under the comment pins and the minimap",
  /z-index: 5/.test(hintCss) && /z-index: 6/.test(block(".cm-layer {")) && /z-index: 7/.test(block(".minimap {")));
for (const sel of [".canvas-hint-title", ".canvas-hint-body"]) {
  t(`styles.css defines ${sel}`, css.includes(`${sel} {`));
}
// Tokens, not literals: the card has to answer the theme like every other surface.
const painted = [".canvas-hint {", ".canvas-hint-title {", ".canvas-hint-body {", ".canvas-hint-x {"]
  .map((sel) => block(sel))
  .filter(Boolean);
const literals = painted.flatMap((b) => b.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []);
t(`the card is painted with tokens only (${literals.join(" ") || "no literals"})`, literals.length === 0);
t("and its kbd chips are the empty-state recipe's, not a second one",
  /\.empty-hint kbd,\s*\n\s*\.canvas-hint kbd \{/.test(css));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
