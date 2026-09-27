/**
 * A modal owns the keyboard (PM-U9).
 *
 * Tab was the modal's (PM-U7) and Escape was the modal's (PM-U3); everything
 * else reached straight through the veil. With the export sheet open and focus on
 * one of its own buttons — which is exactly where Tab lands — `Delete` **removed
 * the selected layer behind the sheet**, the tool letters switched tools behind
 * it, `⌘A` selected the whole page behind it, and `⌘Z` then undid a deletion the
 * user never asked for. Typing in a modal's *field* was already safe (the chord
 * surface's typing guard covers input/textarea), so the whole exposure was the
 * modal's buttons.
 *
 * `ui/escape.ts` now records whether an entry is *modal* (a sheet that veils the
 * editor) or not, and the three global key surfaces — the editor's chord surface
 * in `chrome.tsx`, the canvas's own key handler, and the App's zen/radial chords —
 * ask `modalOpen()` before doing anything. Non-modal overlays are deliberately
 * excluded: a popover or menu does not veil the canvas, and Delete with a context
 * menu open should still delete.
 *
 * Run with:  npx vite-node src/ui/__tests__/modalkeys.test.mjs
 */
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(UI, "..");
const read = (f) => readFileSync(path.join(UI, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

const { installDom, mountSurface } = await import("./domEnv.mjs");
installDom();
const { bindHotkeys } = await import("../chrome.tsx");
const { clearEscapes, modalOpen, openModals, pushEscape, escapeStack } = await import("../escape.ts");

/* ── the registry's own answer ───────────────────────────────────────────── */

clearEscapes();
t("nothing open: no modal", modalOpen() === false && openModals().length === 0);

const releaseMenu = pushEscape("menu", () => {});
t(`a non-modal overlay does not claim the keyboard (${escapeStack().join(",")})`,
  modalOpen() === false && openModals().length === 0);

const releaseSheet = pushEscape("sheet", () => {}, null, true);
t(`a modal one does (${openModals().join(",")})`, modalOpen() === true && openModals().join(",") === "sheet");

const releaseDialog = pushEscape("dialog", () => {}, null, true);
t("and a second modal does not change the answer", modalOpen() === true && openModals().length === 2);

releaseDialog();
releaseSheet();
t("with only the menu left, the keyboard is the editor's again",
  modalOpen() === false && escapeStack().join(",") === "menu");
releaseMenu();
clearEscapes();

/* ── the export sheet, mounted: the finding itself ───────────────────────── */

const treeSize = (engine) => {
  const walk = (n) => 1 + (n.children ?? []).reduce((a, c) => a + walk(c), 0);
  return walk(engine.snapshot().pages[engine.snapshot().page].root);
};

let closed = 0;
const sheet = await mountSurface("inspector", {
  layer(engine) {
    engine.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100, extra: { name: "Behind" } });
    return engine.snapshot().selection[0];
  },
  props: { exportOpen: true, onCloseExport: () => { closed++; } },
});
const doc = sheet.document;
const engine = sheet.engine;

// The sheet registers itself, so mounting it is enough — the modality does not
// depend on the App state that happened to open it.
t(`the sheet claims the keyboard by being on screen (${openModals().join(",")})`,
  modalOpen() === true && openModals().includes("export-sheet"));

let actions = 0;
const unbind = bindHotkeys(engine, {
  onActions: () => {
    actions++;
  },
  onHide: () => {},
  onMinimize: () => {},
  onPresentExit: () => {},
});

/** A real keypress, dispatched from the focused element so the capture listener
 *  on window sees it in the capture phase, as a browser would run it. */
const press = (key, opts = {}) => {
  const el = doc.activeElement ?? doc.body;
  return el.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
};

// Focus a button inside the sheet — this is where Tab lands, and it is the state
// the finding was measured in (the typing guard does not cover buttons).
const back = [...doc.querySelectorAll(".xmodal button")].find((b) => b.className.includes("icon-btn"));
back.focus();
t(`focus is on one of the sheet's own buttons (${doc.activeElement?.className})`,
  doc.activeElement === back && !!doc.activeElement?.closest(".xmodal"));

const before = { nodes: treeSize(engine), tool: engine.snapshot().tool, sel: engine.snapshot().selection.length };
press("Delete");
await sheet.settle();
const afterDelete = { nodes: treeSize(engine), sel: engine.snapshot().selection.length };
t(`Delete behind the sheet removes nothing (${before.nodes} → ${afterDelete.nodes} nodes, selection ${before.sel} → ${afterDelete.sel})`,
  afterDelete.nodes === before.nodes && afterDelete.sel === before.sel);

press("r");
await sheet.settle();
t(`a tool letter behind the sheet switches nothing (${engine.snapshot().tool})`,
  engine.snapshot().tool === before.tool);

press("a", { metaKey: true });
await sheet.settle();
t(`⌘A behind the sheet selects nothing (${engine.snapshot().selection.length} selected)`,
  engine.snapshot().selection.length === before.sel);

press("z", { metaKey: true });
await sheet.settle();
t(`and ⌘Z has nothing to undo, because nothing happened (${treeSize(engine)} nodes)`,
  treeSize(engine) === before.nodes);

press("k", { metaKey: true });
await sheet.settle();
t(`⌘K does not open the palette on top of it (${actions} call${actions === 1 ? "" : "s"})`, actions === 0);

// Tab and Escape are still the modal's — the two rounds before this one.
press("Escape");
await sheet.settle();
t(`Escape closes the sheet, exactly once (${closed} call, stack ${escapeStack().join(",") || "empty"})`,
  closed === 1 && escapeStack().length === 0);
t("and does not throw the caret at <body> on its way out",
  doc.activeElement !== doc.body && doc.activeElement !== doc.documentElement);

/* ── the scope proof: with the sheet gone, the same keys work ────────────── */

await sheet.unmount();
t(`unmounting releases the claim (${openModals().join(",") || "no modals"})`, modalOpen() === false);

const nodesNow = treeSize(engine);
press("r");
await sheet.settle();
t(`the same tool letter switches the tool again (${engine.snapshot().tool})`,
  engine.snapshot().tool === "rect");
press("Delete");
await sheet.settle();
t(`and Delete deletes again (${nodesNow} → ${treeSize(engine)} nodes)`, treeSize(engine) === nodesNow - 1);
unbind();
clearEscapes();

/* ── a dialog: the modal's own keys are still its own ────────────────────── */

{
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NudgeDialog } = await import("../chrome.tsx");
  const { DialogHost } = await import("../DialogHost.tsx");
  const { askPrompt, currentDialog, resetDialogs, resolveDialog } = await import("../dialog.ts");

  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NudgeDialog, { onClose: () => {} }));
  });
  t(`the nudge dialog claims the keyboard through XDialog (${openModals().join(",")})`,
    modalOpen() === true && openModals().includes("dialog"));

  const engine2 = new (await import("../../engine/memory.ts")).MemoryEngine(false);
  let hid = 0;
  const unbind2 = bindHotkeys(engine2, {
    onActions: () => {},
    onHide: () => {
      hid++;
    },
    onMinimize: () => {},
    onPresentExit: () => {},
  });
  const small = [...doc.querySelectorAll(".x-dialog input")].find((i) => i.getAttribute("aria-label") === "Small nudge");
  small.focus();
  // The modal's own field takes a keystroke the way a user types one.
  const setValue = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(small, "8");
    small.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  });
  t(`its own field still takes typing (value "${small.value}")`, small.value === "8");

  // A chord that is not the modal's: ⇧⌘\ hides the UI, and it must not fire here.
  press("\\", { metaKey: true, shiftKey: true });
  await act(async () => {});
  t(`and an editor chord is swallowed behind it (${hid} hide call${hid === 1 ? "" : "s"})`, hid === 0);
  unbind2();

  await act(async () => {
    root.unmount();
  });
  host.remove();
  clearEscapes();

  // The dialog bus: its own Enter-to-submit is the dialog's, and must survive.
  const busHost = doc.createElement("div");
  doc.body.appendChild(busHost);
  const busRoot = createRoot(busHost);
  await act(async () => {
    busRoot.render(React.createElement(DialogHost));
  });
  resetDialogs();
  // A prompt, not a confirm: a confirm is answered by its buttons, and Enter is
  // the prompt's own shortcut — which is what has to keep working behind the guard.
  let resolved = null;
  const answer = askPrompt({ title: "Rename layer", label: "Name", value: "Home" });
  answer.then((v) => { resolved = v; });
  await act(async () => {});
  t(`a queued question claims the keyboard too (${openModals().join(",")})`,
    modalOpen() === true && openModals().includes("dialog"));
  const input = doc.querySelector(".dlg-input");
  input?.focus();
  await act(async () => {
    (input ?? doc.body).dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await act(async () => {});
  t(`its own Enter still submits the question (${JSON.stringify(resolved)})`, resolved === "Home");
  // Defensive: if a future change broke the submit path, the assertion above
  // would already have failed, and this keeps the suite from waiting forever.
  if (resolved === null) resolveDialog(currentDialog(), null);
  await act(async () => {
    busRoot.unmount();
  });
  busHost.remove();
  clearEscapes();
}

/* ── a non-modal overlay does not claim it ───────────────────────────────── */

{
  const panel = await mountSurface("inspector", { layer: "rect", props: {} });
  const pdoc = panel.document;
  const caret = pdoc.querySelector(".zoom-caret");
  caret.focus();
  await panel.click(caret);
  t(`the zoom menu is open and registered (${escapeStack().join(",")})`, escapeStack().includes("zoom"));
  t("but it does not claim the keyboard", modalOpen() === false);

  let actions = 0;
  const unbind3 = bindHotkeys(panel.engine, {
    onActions: () => {
      actions++;
    },
    onHide: () => {},
    onMinimize: () => {},
    onPresentExit: () => {},
  });
  press("r");
  await panel.settle();
  t(`so the canvas keys still work under it (${panel.engine.snapshot().tool})`,
    panel.engine.snapshot().tool === "rect");
  press("k", { metaKey: true });
  await panel.settle();
  t(`and the editor's own chords do too (${actions} palette call, the same chord the sheet swallows)`,
    actions === 1);
  unbind3();
  await panel.unmount();
  clearEscapes();
}

/* ── the three key surfaces, in the source ───────────────────────────────── */

const chord = read("chrome.tsx");
t("the editor's chord surface asks before it answers",
  /if \(modalOpen\(\)\) return;\s*\n\s*if \(typing\) return;/.test(chord));
t("and asks after Escape has had its turn",
  chord.indexOf("closeTopEscape()") < chord.indexOf("if (modalOpen()) return;"));

const canvas = read("Canvas.tsx");
t("the canvas's own key handler stands down too, except for Escape",
  /if \(modalOpen\(\) && e\.key !== "Escape"\) return;/.test(canvas));
const app = readFileSync(path.join(APP, "App.tsx"), "utf8");
t("and so do the zen and radial chords",
  /const handleKey = \(e: KeyboardEvent\) => \{[\s\S]{0,400}if \(modalOpen\(\)\) return;/.test(app));

const askers = ["chrome.tsx", "Canvas.tsx"]
  .map((f) => read(f))
  .concat([app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")])
  .filter((src) => /modalOpen\(\)/.test(src));
t(`exactly three surfaces ask the question (${askers.length})`, askers.length === 3);

const registrations = {
  "App.tsx": ["actions", "export", "fig-inspector", "nudge"],
  "x-ui.tsx": ["dialog"],
  "DialogHost.tsx": ["dialog"],
  "chrome.tsx": ["shortcuts"],
  "inspector.tsx": ["export-sheet"],
};
for (const [file, ids] of Object.entries(registrations)) {
  const src = file === "App.tsx" ? app : read(file);
  const modalCalls = src.match(/useEscape\([^;]*,\s*true\);/g) ?? [];
  const named = modalCalls.map((c) => (c.match(/"([^"]+)"/) ?? [])[1]).sort();
  t(`${file.padEnd(16)} registers [${ids.join(", ")}] as modal (${named.join(", ") || "none"})`,
    named.join() === ids.join());
}
const findBar = /useEscape\(findOpen \? "find" : null, \(\) => setFindOpen\(false\)\);/.test(app);
t("and the find bar is deliberately not one — the editor works underneath it", findBar);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
