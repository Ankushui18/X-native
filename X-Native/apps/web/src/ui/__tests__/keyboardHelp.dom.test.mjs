/**
 * Existing keyboard-shortcuts panel parity: it is a bottom dock, not a modal
 * veil, so the canvas remains usable while the reference panel is open.
 */
import { readFileSync } from "node:fs";

const { installDom } = await import("./domEnv.mjs");
const win = installDom();
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { HelpBtn } = await import("../chrome.tsx");
const { clearEscapes, closeTopEscape, escapeStack, modalOpen } = await import("../escape.ts");
const { document } = win;

let pass = 0;
let fail = 0;
const t = (name, ok) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const act = React.act;
clearEscapes();
const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => root.render(React.createElement(HelpBtn)));

const press = async (key, opts = {}) => {
  await act(async () => {
    document.activeElement.dispatchEvent(new win.KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, ...opts,
    }));
  });
};
const click = async (el) => act(async () => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true })));

const trigger = host.querySelector("button.help");
await click(trigger);
t("Help and resources opens the existing shortcuts panel", !!host.querySelector(".shortcuts-sheet"));
t("the shortcuts panel does not claim modal keyboard ownership", modalOpen() === false);

const dock = host.querySelector(".help-pop.shortcuts-dock");
await click(dock);
t("clicking the dock's transparent placement area does not dismiss the panel", !!host.querySelector(".shortcuts-sheet"));
await click(host.querySelector(".shortcuts-close"));
t("the panel's close button dismisses it", !host.querySelector(".shortcuts-sheet"));

await press("?", { ctrlKey: true, shiftKey: true });
t("Control+Shift+? opens the shortcuts panel", !!host.querySelector(".shortcuts-sheet"));
t("the open panel registers in the Escape stack without claiming modality", escapeStack().includes("shortcuts") && !modalOpen());
await act(async () => closeTopEscape());
t("Escape closes the panel", !host.querySelector(".shortcuts-sheet"));

const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const dockRule = css.match(/\.help-pop\.shortcuts-dock\s*\{([^}]*)\}/)?.[1] ?? "";
const cardRule = css.match(/\.help-card\.shortcuts-sheet\s*\{([^}]*)\}/)?.[1] ?? "";
t("the dock is bottom-aligned, transparent, and lets pointer input pass through", /align-items:\s*flex-end/.test(dockRule) && /background:\s*transparent/.test(dockRule) && /pointer-events:\s*none/.test(dockRule));
t("only the shortcuts card receives pointer input", /pointer-events:\s*auto/.test(cardRule));

await act(async () => root.unmount());
host.remove();
clearEscapes();
console.log(`keyboardHelp: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
