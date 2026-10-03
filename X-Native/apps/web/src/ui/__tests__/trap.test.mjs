/**
 * The veil is a wall (PM-U7).
 *
 * `aria-modal="true"` tells assistive tech that the document behind a modal is
 * inert. Nothing held the *keyboard* there: `Tab` from the last control in the
 * export sheet walked out from under the veil into the toolbar behind it, where
 * a keyboard user could press Enter and operate chrome they could not see, with
 * no way back except Shift+Tab through the whole ring again. The nudge dialog was
 * the mirror image — it never took focus at all, so it opened with the caret
 * still on whatever was behind it.
 *
 * `ui/escape.ts` owns the trap (`focusablesIn` + `useFocusTrap`), and the two
 * modals in the app — the export sheet and `XDialog`, which the nudge dialog and
 * every queued question render through — use it. This file checks the focusable
 * set on its own, then mounts both modals for real: where the caret lands when
 * they open, that Tab at the end wraps to the first control, that Shift+Tab at
 * the first wraps to the last, that disabled controls are skipped, and that
 * nothing non-modal joined in.
 *
 * Run with:  npx vite-node src/ui/__tests__/trap.test.mjs
 */
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..");
const read = (f) => readFileSync(path.join(UI, f), "utf8");
const css = () => readFileSync(path.join(UI, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

const { installDom, mountSurface } = await import("./domEnv.mjs");
installDom();
const { focusablesIn } = await import("../escape.ts");
const { document } = globalThis.window;

/* ── the focusable set ───────────────────────────────────────────────────── */

{
  const box = document.createElement("div");
  box.innerHTML = `
    <button id="first">one</button>
    <input id="field" />
    <button id="off" disabled>disabled</button>
    <a id="link" href="#">link</a>
    <div id="skip" tabindex="-1">skipped</div>
    <div hidden><button id="hidden">hidden</button></div>
    <button id="aria" aria-hidden="true">aria-hidden</button>
    <textarea id="area"></textarea>
  `;
  document.body.appendChild(box);
  const ids = focusablesIn(box).map((el) => el.id);

  t(`a text field comes before the buttons in document order (${ids.slice(0, 2).join(", ")})`,
    ids[0] === "first" && ids[1] === "field");
  t(`disabled controls are not in it (${ids.includes("off") ? "off is" : "off is not"})`, !ids.includes("off"));
  t("a tabindex=-1 element is not a Tab stop", !ids.includes("skip"));
  t("controls under [hidden] are not either", !ids.includes("hidden"));
  t("nor are aria-hidden ones", !ids.includes("aria"));
  t(`links and text areas still are (${ids.slice(2).join(", ")})`,
    ids.includes("link") && ids.includes("area"));
  t(`and nothing else is (${ids.length} of 9 controls)`, ids.length === 4);
  box.remove();
}

/* ── the export sheet ────────────────────────────────────────────────────── */

const sheet = await mountSurface("inspector", {
  layer(engine) {
    engine.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 393, h: 852, extra: { name: "Home" } });
    return engine.snapshot().selection[0];
  },
  props: { exportOpen: true, onCloseExport: () => {} },
});
const doc = sheet.document;
const modal = doc.querySelector(".xmodal");
const filter = doc.querySelector(".xmodal-filter");

t("the sheet is on screen", !!modal && !!filter);
t(`and the trap took the caret on open (${doc.activeElement?.className})`, doc.activeElement === filter);

// The export button starts enabled (the sheet pre-checks the page's top level);
// clearing the selection is how a user disables it, and the ring then has to
// skip it — a disabled control is not a Tab stop.
const run = doc.querySelector(".export-run");
const clear = [...doc.querySelectorAll(".xmodal-head button.link")].find((b) => b.textContent.trim() === "Clear");
await sheet.click(clear);
t(`Clear disables the export button (${run?.disabled ? "disabled" : "still enabled"})`, !!run?.disabled);

const items = focusablesIn(modal);
t(`the ring starts at the filter and skips the disabled button (${items.length} stops)`,
  items[0] === filter && !items.includes(run));
const last = items[items.length - 1];
t(`so the last stop is the control before it (${last?.className || last?.tagName})`,
  last !== run && !!(run.compareDocumentPosition(last) & 2 /* last precedes run */));

// Tab at the end of the ring comes back to the first control, not out to the
// toolbar behind the veil. (Focus first: jsdom dispatches a key without
// applying the browser's own default action, which is where focus would be.)
last.focus();
await sheet.press(last, "Tab");
t(`Tab at the end wraps to the first control (${doc.activeElement?.className})`, doc.activeElement === filter);

// A plain Tab inside the ring is an ordinary move.
await sheet.press(filter, "Tab");
t(`Tab inside the ring moves forward (${doc.activeElement?.className || doc.activeElement?.tagName})`,
  doc.activeElement === items[1]);

// Shift+Tab at the first control goes to the last.
filter.focus();
filter.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
await sheet.settle();
t(`Shift+Tab at the first control wraps to the last (${doc.activeElement?.className || doc.activeElement?.tagName})`,
  doc.activeElement === last);

// A caret that somehow ends up outside the modal (a stray focus, a click on the
// veil) is brought back in rather than stranded behind it.
doc.body.focus();
doc.body.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
await sheet.settle();
t(`Tab from outside the modal lands inside it (${doc.activeElement?.className || doc.activeElement?.tagName})`,
  modal.contains(doc.activeElement));

t("the ring never leaves the modal", focusablesIn(modal).every((el) => modal.contains(el)));
await sheet.unmount();

/* ── XDialog: the nudge dialog and every queued question ─────────────────── */

{
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NudgeDialog } = await import("../chrome.tsx");

  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  // The caret starts behind the dialog: a dialog that never takes focus leaves
  // it there, which is what the trap fixes.
  const behind = doc.createElement("button");
  behind.id = "behind";
  doc.body.appendChild(behind);
  behind.focus();

  await act(async () => {
    root.render(React.createElement(NudgeDialog, { onClose: () => {} }));
  });
  const box = doc.querySelector(".x-dialog");
  t("XDialog draws a modal dialog", !!box && box.getAttribute("aria-modal") === "true");
  const small = [...box.querySelectorAll("input")].find((i) => i.getAttribute("aria-label") === "Small nudge");
  t(`opening it takes the caret to its first field (${doc.activeElement?.getAttribute?.("aria-label")})`,
    doc.activeElement === small);

  const ring = focusablesIn(box);
  t(`its ring has the two nudge fields and the footer buttons (${ring.length})`, ring.length >= 3);
  ring[ring.length - 1].focus();
  await act(async () => {
    ring[ring.length - 1].dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  });
  t(`Tab at its end wraps to its first control (${doc.activeElement?.getAttribute?.("aria-label") || doc.activeElement?.className})`,
    doc.activeElement === ring[0]);

  await act(async () => {
    root.unmount();
  });
  host.remove();
  behind.remove();
}

/* ── who holds the keyboard ──────────────────────────────────────────────── */

t("the export sheet uses the trap", /useFocusTrap\(true, sheet\)/.test(read("inspector.tsx")));
t("XDialog uses it on its own box", /useFocusTrap\(true, box\)/.test(read("x-ui.tsx")));
const trapCalls = ["x-ui.tsx", "inspector.tsx", "chrome.tsx", "Canvas.tsx", "ContextMenu.tsx", "FillPicker.tsx"]
  .filter((f) => /useFocusTrap\(/.test(read(f)));
t(`and nothing non-modal does (${trapCalls.join(", ")})`, trapCalls.length === 2);
const popoverBody = read("x-ui.tsx").split("export function XPopover")[1]?.split("export function XDialog")[0] ?? "";
t("the popover does not trap Tab — leaving it is how a keyboard user gets out",
  popoverBody.length > 200 && !/useFocusTrap/.test(popoverBody));
t("a modal with no controls to hand the caret to is still focusable itself",
  /<div[\s\S]{0,120}className="xmodal"[\s\S]{0,160}tabIndex=\{-1\}/.test(read("inspector.tsx")) &&
  /className="x-dialog"[\s\S]{0,140}tabIndex=\{-1\}/.test(read("x-ui.tsx")));
const ringRule = [...css().matchAll(/[^{}]*:focus\s*\{[^}]*\}/g)]
  .map((m) => m[0])
  .find((rule) => /\.xmodal:focus/.test(rule) && /\.x-dialog:focus/.test(rule) && /outline:\s*none/.test(rule));
t("and neither draws a ring when it holds the caret itself", !!ringRule);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
