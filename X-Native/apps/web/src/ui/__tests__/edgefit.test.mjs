/**
 * Nothing off the edge, nothing out of reach (RW-U1, FR-U4, PM-U6).
 *
 * Three unrelated-looking defects with one shape: a piece of chrome that the
 * product puts on screen without asking whether the screen has room for it, or
 * whether the keyboard can get to it.
 *
 *  - RW-U1  the tool dock was a fixed 44px strip, absolutely centred in
 *    `.canvas-col` with no width limit. The column is narrower than the window
 *    whenever a panel is docked, so at ~900px the tail of the dock — Dev Mode,
 *    Actions — was off-screen and unreachable, and the only escape was `minUi`,
 *    which hides the panels to make room. The ≤860px override that did exist
 *    made it a scroll container, which is worse than it sounds: `overflow-x:
 *    auto` computes `overflow-y` to `auto` too, and the tool flyouts escape 40px
 *    above a 44px strip, so on a phone the boolean menu opened into a clipped
 *    box. The dock is bounded by its own column now and wraps.
 *  - FR-U4  the size/angle badge hangs 8px below the selection box, so a
 *    selection whose bottom edge is at the canvas bottom paints its one readout
 *    off-screen — usually mid-resize of something tall, which is when it is
 *    wanted. `clampBadge` flips it above the box and clamps as a last resort.
 *  - PM-U6  the Export assets sheet opened with focus still on whatever
 *    launched it, so a keyboard user tabbed in from the top of the document
 *    behind the veil. Every other modal input in the app focuses itself.
 *
 * jsdom has no layout engine, so the dock half is asserted against the sheet
 * (which is what the browser will read) and the geometry half against the pure
 * function the paint loop calls; §46 of the browser suite measures the real
 * rects. The focus half is real here: React focuses on commit and jsdom keeps
 * `document.activeElement`.
 *
 * Run with:  npx vite-node src/ui/__tests__/edgefit.test.mjs
 */
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { clampBadge } from "../zoom.ts";
import { mountSurface } from "./domEnv.mjs";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(UI, "..", "styles.css"), "utf8");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

/* ── FR-U4: the badge stays on the canvas ────────────────────────────────── */

const view = { w: 1200, h: 800 };

const roomy = clampBadge({ x: 400, y: 300, w: 90, h: 20 }, view, { flipY: 272 });
t(`with room below it stays below (${roomy.x},${roomy.y} flipped ${roomy.flipped})`,
  roomy.x === 400 && roomy.y === 300 && roomy.flipped === false);

const atEdge = clampBadge({ x: 400, y: 772, w: 90, h: 20 }, view, { flipY: 272 });
t(`exactly fitting the pad does not flip (y ${atEdge.y})`, atEdge.y === 772 && !atEdge.flipped);

const over = clampBadge({ x: 400, y: 773, w: 90, h: 20 }, view, { flipY: 272 });
t(`one pixel over flips it above the box (y ${over.y}, flipped ${over.flipped})`,
  over.y === 272 && over.flipped === true);

const offBottom = clampBadge({ x: 400, y: 900, w: 90, h: 20 }, view, { flipY: 872 });
t(`and when above is off-screen too, it clamps into view (y ${offBottom.y})`,
  offBottom.y === 772 && !offBottom.flipped);

const noFlip = clampBadge({ x: 400, y: 900, w: 90, h: 20 }, view);
t(`without a flip target it clamps instead of guessing (y ${noFlip.y})`,
  noFlip.y === 772 && !noFlip.flipped);

const taller = clampBadge({ x: 400, y: 900, w: 90, h: 1200 }, view, { flipY: -400 });
t(`a badge taller than the view pins to the top pad, never negative (y ${taller.y})`,
  taller.y === 8 && !taller.flipped);

const left = clampBadge({ x: -60, y: 300, w: 90, h: 20 }, view, { flipY: 272 });
const right = clampBadge({ x: 1180, y: 300, w: 90, h: 20 }, view, { flipY: 272 });
t(`the x axis is clamped both ways (${left.x} … ${right.x})`,
  left.x === 8 && right.x === 1102);

const padded = clampBadge({ x: -60, y: 790, w: 90, h: 20 }, view, { pad: 24 });
t(`and the pad is a parameter, not a constant (x ${padded.x}, y ${padded.y})`,
  padded.x === 24 && padded.y === 756);

const tiny = clampBadge({ x: 0, y: 0, w: 90, h: 20 }, { w: 40, h: 12 }, { flipY: -30 });
t(`a view smaller than the badge still yields finite numbers (${tiny.x},${tiny.y})`,
  Number.isFinite(tiny.x) && Number.isFinite(tiny.y) && tiny.x === 8 && tiny.y === 8);

/* both paint sites go through it, and the old unclamped formula is gone */
const canvasSrc = read("Canvas.tsx");
const calls = (canvasSrc.match(/clampBadge\(/g) ?? []).length;
t(`both badge sites clamp (single-selection + multi = ${calls} calls)`, calls === 2);
// Both sites offer the flip, and both read the recipe's gutter rather than a
// number: the badge geometry is named in Canvas.tsx (CHROME_GAP / CHROME_CHIP_H),
// so the pin follows the name instead of pinning the arithmetic text.
t("each offers the flip above the box",
  /flipY: sy - CHROME_GAP - bh/.test(canvasSrc) && /flipY: sy - CHROME_GAP - CHROME_CHIP_H/.test(canvasSrc));
t("and neither keeps the unclamped `const by = sy + sh + 8`",
  !/const by = sy \+ sh \+ 8;/.test(canvasSrc));

/* ── RW-U1: the dock is bounded by its column and never becomes a scroller ── */

const dockRule = css.match(/(?:^|\n)\.dock\s*\{([^}]*)\}/)?.[1] ?? "";
const decl = (rule, prop) => rule.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "m"))?.[1].trim();

t(`the dock is bounded by the column it hangs in (max-width ${decl(dockRule, "max-width")})`,
  decl(dockRule, "max-width") === "calc(100% - 24px)");
t(`it wraps instead of overflowing (flex-wrap ${decl(dockRule, "flex-wrap")})`,
  decl(dockRule, "flex-wrap") === "wrap");
// The strip's 44px is named --h-dock; the pin follows the name and asserts the
// ladder still resolves to 44, so retuning the token cannot silently retune the
// dock without this test saying so.
const hDock = css.match(/--h-dock:\s*([^;]+)/)?.[1].trim();
t(`and grows upward from its own height (min-height ${decl(dockRule, "min-height")} = ${hDock}, height ${decl(dockRule, "height") ?? "none"})`,
  decl(dockRule, "min-height") === "var(--h-dock)" && hDock === "44px" && !decl(dockRule, "height"));
t("wrapped rows stay centred under the cursor", decl(dockRule, "justify-content") === "center");

const toolsetRule = css.match(/(?:^|\n)\.toolset\s*\{([^}]*)\}/)?.[1] ?? "";
t(`a toolset too wide for one row wraps as well (flex-wrap ${decl(toolsetRule, "flex-wrap")}, min-width ${decl(toolsetRule, "min-width")})`,
  decl(toolsetRule, "flex-wrap") === "wrap" && decl(toolsetRule, "min-width") === "0");

t("no rule anywhere turns the dock into a scroll container (which would clip the flyouts)",
  !/\.dock[^{,\n]*\{[^}]*overflow/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")));
t("and the phone override that did is gone", !/\.dock::-webkit-scrollbar/.test(css));

/* ── PM-U6: the export sheet opens with the keyboard already inside it ───── */

const sheet = await mountSurface("inspector", {
  // A configured frame gives the sheet a row to focus past.
  layer(engine) {
    engine.dispatch({
      type: "add",
      kind: "frame",
      x: 0,
      y: 0,
      w: 393,
      h: 852,
      extra: { name: "Home" },
    });
    const id = engine.snapshot().selection[0];
    engine.dispatch({ type: "patch", id, patch: { exports: [{ format: "PNG", scale: 1, suffix: "" }] } });
    return id;
  },
  props: { exportOpen: true, onCloseExport: () => {} },
});
const doc = sheet.document;
// The sheet is a portal: it lands on <body>, not inside the mounted surface.
const dialog = doc.querySelector('.xmodal[aria-label="Export assets"]');
t("File ▸ Export opens the sheet as a modal dialog", !!dialog && dialog.getAttribute("role") === "dialog");
t(`and says it is modal (${dialog?.getAttribute("aria-modal")})`, dialog?.getAttribute("aria-modal") === "true");

const filter = doc.querySelector(".xmodal-filter");
t("the filter field is in the sheet", !!filter);
t(`opening the sheet puts focus in it (activeElement ${doc.activeElement?.className || doc.activeElement?.tagName})`,
  !!filter && doc.activeElement === filter);

const focusables = [...(dialog?.querySelectorAll("input, button, select, textarea, a[href]") ?? [])];
t(`and it is the first stop in the sheet's tab order (${focusables[0]?.className})`,
  focusables[0] === filter);
t(`the sheet lists what can be exported (${doc.querySelectorAll(".xrow").length} rows)`,
  doc.querySelectorAll(".xrow").length > 0);
await sheet.unmount();
t("closing it takes the sheet out of the document", !doc.querySelector(".xmodal"));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
