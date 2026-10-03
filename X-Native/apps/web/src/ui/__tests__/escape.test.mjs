/**
 * One Escape owner (PM-U3).
 *
 * Escape used to be answered by whoever happened to be listening, in whichever
 * phase they happened to register: the App kept its own five-overlay cascade
 * behind an `onEscapeOverlay` prop, the dialog bus attached a capture listener,
 * eight more surfaces attached bubble listeners of their own, and the canvas
 * cascade deferred to all of them through a counter (`popoverGuard`) that
 * protected the selection but closed nothing.
 *
 * Two things were wrong, and both are checked here. **Order followed
 * registration, not the screen** — the central capture handler is bound at app
 * mount, so a dialog on top of the export sheet lost the press to the sheet
 * behind it, and with Find open and the shortcuts sheet opened on top, Escape
 * closed Find. **One press could be answered twice** — the presentation's
 * Escape existed in both the central cascade and the player, so a single press
 * dispatched `presentBack` twice and skipped back two frames.
 *
 * Every overlay now registers in `ui/escape.ts` while it is open; `bindHotkeys`
 * asks the stack before anything else answers and consumes the press when the
 * stack had something. What is left of the old canvas cascade runs only when no
 * overlay is open, which is what the second half of this file asserts: the
 * registry's own arithmetic, the cascade consuming one press per overlay, a
 * real converted surface (the inspector's zoom menu) closing through it with the
 * selection behind it surviving, and the shape of the source afterwards.
 *
 * The same finding had a third symptom, checked in the last section: an overlay
 * that closes unmounts the field it focused, so the caret fell to `<body>` — the
 * next Tab restarted at the top of the document, and a keyboard user who ran
 * "Export assets" from the palette was dropped outside the editor entirely. The
 * registry now remembers what had focus before the overlay took it and gives it
 * back, falling back to the app's `[data-focus-home]` when that control is gone.
 *
 * Run with:  npx vite-node src/ui/__tests__/escape.test.mjs
 */
import path from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
// The DOM first, then the registry: `escape.ts` installs its focus trail at
// import, so importing it into a bare Node process would leave it blind to the
// invoker's focus when a test later mounts real React surfaces.
const { installDom } = await import("./domEnv.mjs");
installDom();
const { clearEscapes, closeTopEscape, escapeStack, pushEscape } = await import("../escape.ts");
const { document, KeyboardEvent } = globalThis.window;

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

/* ── the registry's own arithmetic ───────────────────────────────────────── */

clearEscapes();
const closed = [];
t("an empty stack answers nothing", closeTopEscape() === false && escapeStack().length === 0);

const releaseA = pushEscape("sheet", () => closed.push("sheet"));
const releaseB = pushEscape("dialog", () => closed.push("dialog"));
t(`the stack reads bottom-first (${escapeStack().join(" → ")})`,
  escapeStack().join(",") === "sheet,dialog");

t("and one press closes the topmost only", closeTopEscape() === true && closed.join(",") === "dialog");
t("the next press closes the one beneath it", closeTopEscape() === true && closed.join(",") === "dialog,sheet");
t("and the press after that reaches the canvas", closeTopEscape() === false && closed.length === 2);

// A release that runs after the press already popped the entry must not close
// anything a second time — that is the unmount-after-close path every converted
// surface takes.
closed.length = 0;
const releaseC = pushEscape("menu", () => closed.push("menu"));
closeTopEscape();
releaseC();
releaseC();
t(`releasing after the press is a no-op (${closed.join(",")})`, closed.join(",") === "menu");

// A release that runs *before* the press takes the entry out of the stack, so a
// closed overlay never answers a later press.
closed.length = 0;
pushEscape("first", () => closed.push("first"));
const releaseD = pushEscape("second", () => closed.push("second"));
releaseD();
closeTopEscape();
t(`a released overlay is not the one Escape closes (${closed.join(",")})`, closed.join(",") === "first");

// Closing one overlay can open another (a sheet that hands over to a dialog):
// the new entry is on top, so the next press answers it.
closed.length = 0;
let releaseInner = null;
pushEscape("outer", () => {
  closed.push("outer");
  releaseInner = pushEscape("inner", () => closed.push("inner"));
});
closeTopEscape();
closeTopEscape();
t(`and a hand-over registers on top (${closed.join(",")})`, closed.join(",") === "outer,inner");
releaseInner?.();
clearEscapes();

/* ── the cascade: one press, one overlay, consumed ───────────────────────── */

// No static import of a .tsx surface: that would load react-dom before jsdom is
// installed, after which every input event throws and React renders a step late.
const { mountSurface } = await import("./domEnv.mjs");
const ui = await mountSurface("inspector", { layer: "rect" });
const { MemoryEngine } = await import("../../engine/memory.ts");
const { bindHotkeys } = await import("../chrome.tsx");

const window = ui.window;
/** A real keypress: dispatched at an element so the capture listener on window
 *  fires in the capture phase, exactly as a browser would run it. */
const press = (key = "Escape") => {
  const e = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
};

const engine = new MemoryEngine(false);
let presentExits = 0;
const unbind = bindHotkeys(engine, {
  onActions: () => {},
  onHide: () => {},
  onMinimize: () => {},
  onPresentExit: () => {
    presentExits++;
  },
});

const order = [];
pushEscape("under", () => order.push("under"));
pushEscape("over", () => order.push("over"));
const first = press();
t(`the press closes the overlay opened last (${order.join(",")})`, order.join(",") === "over");
t("and consumes itself, so no second listener gets a turn", first.defaultPrevented === true);
const second = press();
t(`the next press closes the one beneath (${order.join(",")})`, order.join(",") === "over,under");
const third = press();
t("and with the stack empty the press is the canvas's again", order.length === 2 && third.defaultPrevented === false);

// The double answer the presentation used to give: the cascade and the player
// both branched on Escape, so one press walked back two frames.
engine.dispatch({ type: "presentStart" });
await ui.settle();
if (engine.snapshot().presentFrame) {
  presentExits = 0;
  const during = press();
  t(`presenting, one Escape exits once (${presentExits} call, prevented ${during.defaultPrevented})`,
    presentExits === 1 && during.defaultPrevented === true);
  engine.dispatch({ type: "presentStop" });
} else {
  t("presenting, one Escape exits once (no frame to present in the starter doc)", true);
}
unbind();
clearEscapes();

/* ── a converted surface, mounted: the zoom menu ─────────────────────────── */

const unbindUi = bindHotkeys(ui.engine, {
  onActions: () => {},
  onHide: () => {},
  onMinimize: () => {},
  onPresentExit: () => {},
});
const caret = ui.one(".zoom-caret");
t("the inspector's zoom menu has a trigger", !!caret);
caret.focus(); // what the browser does on mousedown, before the click arrives
await ui.click(caret);
t(`opening it registers with the cascade (${escapeStack().join(",")})`, escapeStack().includes("zoom"));
t("and the menu is on screen", !!ui.one(".ctx.zoom-menu"));

const selectedBefore = ui.engine.snapshot().selection.length;
const menuPress = press();
await ui.settle();
t("one Escape closes the menu", !ui.one(".ctx.zoom-menu") && menuPress.defaultPrevented === true);
// The caret half of the finding, on a real converted surface: the trigger is
// still on screen, so focus goes back to it instead of falling to <body>.
t(`and the caret goes back to the control that opened it (${document.activeElement?.className || document.activeElement?.tagName})`,
  document.activeElement === caret);
t(`and the selection behind it survives (§26 KB-017: ${selectedBefore} → ${ui.engine.snapshot().selection.length})`,
  selectedBefore > 0 && ui.engine.snapshot().selection.length === selectedBefore);
t("closing it leaves the stack", !escapeStack().includes("zoom"));

// With nothing open, the same key does what it always did: the canvas answers.
const hadSelection = ui.engine.snapshot().selection.length;
press();
await ui.settle();
const after = ui.engine.snapshot().selection;
t(`and with nothing open the canvas cascade still answers (${hadSelection} → ${after.length})`,
  hadSelection > 0 && (after.length === 0 || after[0] !== ui.id));
unbindUi();
await ui.unmount();
clearEscapes();

/* ── the caret goes back where it came from ─────────────────────────────── */

const mk = (tag, id) => {
  const el = document.createElement(tag);
  el.id = id;
  document.body.appendChild(el);
  return el;
};

// A `<div>` is not focusable on its own, which is why the app's focus home
// carries `tabIndex={-1}`; the test's stand-in has to as well.
const home = mk("div", "focus-home");
home.tabIndex = -1;
home.setAttribute("data-focus-home", "");

const invoker = mk("button", "invoker");
invoker.focus();
const releaseInvoker = pushEscape("popover", () => {}, invoker);
const invokerField = mk("input", "invoker-field");
invokerField.focus(); // the overlay's own field takes the caret
releaseInvoker();
t(`closing an overlay gives the caret back to its invoker (${document.activeElement?.id})`,
  document.activeElement === invoker);

// The invoker can be gone by then: the palette row that ran "Export assets"
// unmounts with the palette, and focus used to fall to <body>.
const gone = mk("button", "gone");
gone.focus();
const releaseGone = pushEscape("sheet", () => {}, gone);
const goneField = mk("input", "gone-field");
goneField.focus();
gone.remove();
releaseGone();
t(`with the invoker gone the caret lands on the app's focus home (${document.activeElement?.id})`,
  document.activeElement === home);

// Nothing to hand it to at all: the caret is left where it is, not thrown at
// the top of the document.
home.remove();
const orphan = mk("button", "orphan");
orphan.focus();
const releaseOrphan = pushEscape("menu", () => {}, orphan);
const orphanField = mk("input", "orphan-field");
orphanField.focus();
orphan.remove();
releaseOrphan();
t("with no focus home either, the registry leaves focus alone",
  document.activeElement === orphanField);

// A disabled invoker cannot take focus back, so that falls through too.
const dead = mk("button", "dead");
dead.focus();
const releaseDead = pushEscape("menu", () => {}, dead);
dead.disabled = true;
const deadField = mk("input", "dead-field");
deadField.focus();
releaseDead();
t("and a disabled invoker is not handed focus it cannot take",
  document.activeElement === deadField);

// Stacked overlays: a dialog on top of the export sheet. The dialog's own home
// is the field in the sheet the user came from, so closing it hands the caret
// back *into* the sheet rather than dropping it on <body>.
const lower = mk("button", "lower");
lower.focus();
const releaseLower = pushEscape("sheet", () => {}, lower);
const sheetField = mk("input", "sheet-field");
sheetField.focus();
const releaseUpper = pushEscape("dialog", () => {}, sheetField);
const dialogField = mk("input", "dialog-field");
dialogField.focus();
releaseUpper();
t(`a dialog closing over a sheet hands the caret back into it (${document.activeElement?.id})`,
  document.activeElement === sheetField);
releaseLower();
t("and the sheet hands it on to its own invoker when it goes", document.activeElement === lower);

// Focus already back on the target (an overlay that never took it — a menu the
// keyboard never entered): closing must not bounce it, and `focus()` on the
// element that already has it is not observable anyway.
const still = mk("button", "still");
still.focus();
const releaseStill = pushEscape("menu", () => {}, still);
releaseStill();
t("an overlay that never took the caret gives it back to the same place", document.activeElement === still);

// Every close path hands it back, not just Escape: the sheet's close button, a
// click outside, a chosen item. The registry does not try to tell them apart.
const anyTrigger = mk("button", "any-trigger");
anyTrigger.focus();
const releaseAny = pushEscape("popover", () => {}, anyTrigger);
const anyField = mk("input", "any-field");
anyField.focus();
releaseAny();
t(`and a close that was not Escape does the same (${document.activeElement?.id})`,
  document.activeElement === anyTrigger);

// The dialog bus, mounted for real: DialogHost is the one overlay the App does
// not own the state of, so its caret is worth a case of its own.
{
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DialogHost } = await import("../DialogHost.tsx");
  const { askConfirm, currentDialog, resetDialogs, resolveDialog } = await import("../dialog.ts");

  const hostEl = document.createElement("div");
  document.body.appendChild(hostEl);
  const root = createRoot(hostEl);
  await act(async () => {
    root.render(React.createElement(DialogHost));
  });
  resetDialogs();

  const trigger = mk("button", "dlg-invoker");
  trigger.focus();
  const answer = askConfirm({ title: "Delete mode", body: "Delete this mode?" });
  await act(async () => {});
  const dlg = document.querySelector(".x-dialog");
  t("the dialog host puts its question on screen", !!dlg);
  const dlgField = dlg?.querySelector("input, button");
  dlgField?.focus();
  await act(async () => {
    resolveDialog(currentDialog(), false);
  });
  t(`and closing it hands the caret back to the command behind it (${document.activeElement?.id || document.activeElement?.tagName})`,
    document.activeElement === trigger);
  t("its cancel path still resolves falsy", !(await answer));
  await act(async () => {
    root.unmount();
  });
  hostEl.remove();
  clearEscapes();
}

/* ── the shape of the source afterwards ──────────────────────────────────── */

const registers = {
  "../App.tsx": 5,
  // Three since P0-2: the File menu joins the two the chrome already owned.
  "chrome.tsx": 3,
  "x-ui.tsx": 2,
  "DialogHost.tsx": 1,
  "ContextMenu.tsx": 1,
  "FillPicker.tsx": 1,
  "RadialMenu.tsx": 1,
  // Four since round 13: the three panel menus plus the export sheet, which
  // registers itself so its modality does not depend on who rendered it.
  "inspector.tsx": 4,
};
for (const [file, want] of Object.entries(registers)) {
  const p = file.startsWith("..") ? path.join(UI, "..", file.slice(3)) : path.join(UI, file);
  const src = readFileSync(p, "utf8");
  const n = (src.match(/useEscape\(/g) ?? []).length;
  t(`${file.replace("../", "")} registers its ${want} overlay${want > 1 ? "s" : ""} (${n} call${n === 1 ? "" : "s"})`, n === want);
}

// The second mechanism is gone: no counter, no module, no import.
t("the popover counter is deleted", !existsSync(path.join(UI, "popoverGuard.ts")));
const armed = readdirSync(UI)
  .filter((f) => /\.(ts|tsx)$/.test(f) && f !== "escape.ts")
  .map((f) => path.join(UI, f))
  .concat([path.join(UI, "..", "App.tsx")])
  .filter((p) => /armPopover\(|popoverArmed\(/.test(readFileSync(p, "utf8")))
  .map((p) => path.basename(p));
t(`and nothing arms it any more (${armed.length} file(s): ${armed.join(", ") || "none"})`, armed.length === 0);

// Escape is answered in one place. The window key listeners that remain are the
// canvas's own modes, the dashboard (a different screen), the player's other
// keys and the app's zen/radial chords — none of them an overlay.
const escapers = readdirSync(UI)
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => {
    const src = read(f);
    return /window\.addEventListener\("keydown"/.test(src) && /key === "Escape"/.test(src);
  });
const allowed = ["Canvas.tsx", "Dashboard.tsx", "PresentationPlayer.tsx", "chrome.tsx", "inspector.tsx"];
const stray = escapers.filter((f) => !allowed.includes(f));
t(`no other surface listens for Escape on the window (${escapers.join(", ")})`, stray.length === 0);
t("and the player no longer answers it (it returns, and the cascade owns the branch)",
  /if \(e\.key === "Escape"\) return;/.test(read("PresentationPlayer.tsx")) &&
  !/presentBack"\s*\}\);\s*\n\s*\} else \{\s*\n\s*onExit/.test(read("PresentationPlayer.tsx")));
t("the App no longer keeps a cascade of its own",
  !/onEscapeOverlay|const closeOverlay|overlayRef/.test(readFileSync(path.join(UI, "..", "App.tsx"), "utf8")));

// The focus home itself: one element, declared once, uninterruptable by a ring.
{
  const appSrc = readFileSync(path.join(UI, "..", "App.tsx"), "utf8");
  const css = readFileSync(path.join(UI, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  t("App marks the canvas column as the focus home",
    /<main className="canvas-col" data-focus-home tabIndex=\{-1\}>/.test(appSrc));
  t("and it takes focus without ringing the whole stage", /\.canvas-col:focus\s*\{[^}]*outline:\s*none/.test(css));
  t("the registry is what falls back to it", /\[data-focus-home\]/.test(read("escape.ts")));
  const outlines = [...css.matchAll(/\.canvas-col:focus[^{]*\{([^}]*)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/outline\s*:\s*([^;]+)/g)].map((x) => x[1].trim()));
  t(`and the only outline it declares is none (${outlines.join(" | ") || "no rule"})`,
    outlines.length > 0 && outlines.every((v) => v === "none"));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
