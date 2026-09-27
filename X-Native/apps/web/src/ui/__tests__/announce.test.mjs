/**
 * Say it out loud (PM-U8).
 *
 * The toast was the product's only confirmation channel and it was a plain
 * `<div className="toast">`: no role, no live region, so a screen reader said
 * nothing when 5 layers were deleted. This file checks the announcement half —
 * that the region exists *before* the message, that the message lands in it, that
 * the pill is not itself a live region (which would say everything twice), that a
 * transcript of answers arriving on its own is a `log`, and that the product has
 * exactly one mechanism for all of it.
 *
 * Run with:  npx vite-node src/ui/__tests__/announce.test.mjs
 */
import path from "path";
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "..");
const APP = path.join(UI, "..");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (f) => strip(readFileSync(path.join(UI, f), "utf8"));
const readApp = (f) => strip(readFileSync(path.join(APP, f), "utf8"));

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

// jsdom before React: domEnv installs the globals both look for.
const { installDom } = await import("./domEnv.mjs");
installDom();
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LiveLog, LiveStatus, TOAST_MS, ToastPill, useToastMessage } = await import("../announce.tsx");
const { toast } = await import("../toast.ts");

const { document } = globalThis.window;

/* ── one mechanism, and the shape of the call sites ──────────────────────── */

const uiFiles = readdirSync(UI).filter((f) => /\.(ts|tsx)$/.test(f));
const live = uiFiles.filter((f) => /aria-live/.test(read(f)));
t(`only the announcement module declares a live region (${live.join(", ") || "none"})`,
  live.length === 1 && live[0] === "announce.tsx");
const regions = [...read("announce.tsx").matchAll(/aria-live="(\w+)"/g)].map((m) => m[1]);
t(`both of its regions are polite — nothing here interrupts (${regions.join(", ")})`,
  regions.length === 2 && regions.every((v) => v === "polite"));
const alertSources = uiFiles.filter((f) => /role="alert"/.test(read(f)));
t(`the dialog's validation error is still the product's one assertive region (${alertSources.join(", ")})`,
  alertSources.length === 1 && alertSources[0] === "DialogHost.tsx");
const assertive = uiFiles.filter((f) => /aria-live="assertive"/.test(read(f)));
t("and no surface reaches for assertive on its own", assertive.length === 0);

const appSrc = readApp("App.tsx");
t("the editor renders both channels for one message",
  /const busToast = useToastMessage\(\);\s*\n\s*const shown = toast \|\| busToast;/.test(appSrc) &&
  /<ToastPill text=\{shown\} \/>\s*\n\s*<LiveStatus text=\{shown\} \/>/.test(appSrc));
t("and keeps its own longer warnings (the channel is shared, not the clock)",
  /setToast\("Saved document could not be read[\s\S]{0,80}4000\)/.test(appSrc) &&
  /setToast\("That link points at a layer[\s\S]{0,120}3200\)/.test(appSrc));
const dashSrc = read("Dashboard.tsx");
t("the dashboard takes the message from the shared hook", /const note = useToastMessage\(\);/.test(dashSrc));
t("and renders both channels for it too",
  /<ToastPill text=\{note\} \/>\s*\n\s*<LiveStatus text=\{note\} \/>/.test(dashSrc));
t("so the bus's 1800ms is written once, in the module",
  /export const TOAST_MS = 1800;/.test(read("announce.tsx")) &&
  !/1800/.test(dashSrc) && !/1800/.test(appSrc) && !/subscribeToast/.test(appSrc));
t("and the editor's ordinary confirmations go through the bus, not a local clock",
  /const flash = \(msg: string\) => toastMsg\(msg\);/.test(appSrc) &&
  /toastMsg\("Presenting — click hotspots/.test(appSrc));
t("what stays local is the two deliberately longer warnings",
  /setToast\("Saved document could not be read/.test(appSrc) &&
  /setToast\("That link points at a layer/.test(appSrc));
t("the agent's answers go into a log, not a plain list",
  /<LiveLog label="Agent transcript">/.test(read("chrome.tsx")));
t("and the log keeps the list class the transcript already had",
  /className=\{className\} role="log"/.test(read("announce.tsx")));

/* ── the region exists before the message ────────────────────────────────── */

/** Exactly the shape both screens render: one message, two channels. */
function Harness() {
  const text = useToastMessage();
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(ToastPill, { text }),
    React.createElement(LiveStatus, { text }),
  );
}

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => {
  root.render(React.createElement(Harness));
});

const status = () => document.querySelector("[role='status']");
const pill = () => document.querySelector(".toast");
t("the status region is mounted with nothing to say", !!status() && status().textContent === "");
t("and there is no pill until there is a message", !pill());
t(`it is a polite, atomic status region (${status()?.getAttribute("aria-atomic")})`,
  status().getAttribute("aria-live") === "polite" && status().getAttribute("aria-atomic") === "true");
t(`visually hidden, not removed (class "${status().className}")`, status().className === "sr-only");
const sheet = readFileSync(path.join(APP, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const srRule = /\.sr-only\s*\{([^}]*)\}/.exec(sheet)?.[1] ?? "";
t(`and .sr-only clips rather than display:none, which would silence it (${srRule.trim().slice(0, 40)}…)`,
  /clip:\s*rect/.test(srRule) && !/display:\s*none/.test(srRule));

/* ── a real toast lands in both channels, once ───────────────────────────── */

await act(async () => {
  toast("Deleted 3 layers · ⌘Z to undo");
});
t(`the message reaches the status region (${status()?.textContent})`,
  status().textContent === "Deleted 3 layers · ⌘Z to undo");
t("and the pill shows the same string", pill()?.textContent === status().textContent);
t("the pill is not itself a live region — one message, one announcement",
  !pill()?.hasAttribute("aria-live") && !pill()?.querySelector?.("[aria-live]") &&
  !pill().closest("[aria-live]"));

await act(async () => {
  toast("Copied to clipboard");
});
t(`a second message replaces the first (${status()?.textContent})`,
  status().textContent === "Copied to clipboard" && pill().textContent === "Copied to clipboard");

// The 1800ms clear: the pill goes away and the region empties with it, because a
// status that never clears would leave stale text in the accessibility tree.
await new Promise((r) => setTimeout(r, TOAST_MS + 250));
t(`after ${TOAST_MS}ms both channels are quiet (pill ${!!pill()}, region "${status()?.textContent}")`,
  !pill() && status().textContent === "");
t("and the region is still there for the next one", !!status());

await act(async () => {
  root.unmount();
});
host.remove();

/* ── a stream that arrives on its own ────────────────────────────────────── */

const stream = document.createElement("div");
document.body.appendChild(stream);
const streamRoot = createRoot(stream);
const greeting = React.createElement("div", { className: "row agent-row", "data-who": "agent" },
  React.createElement("span", { className: "name" }, "Hello — ask me to add something."));
const answer = React.createElement("div", { className: "row agent-row", "data-who": "agent" },
  React.createElement("span", { className: "name" }, "Added a 160 × 80 rectangle."));
await act(async () => {
  streamRoot.render(React.createElement(LiveLog, { label: "Agent transcript" }, greeting));
});
const log = document.querySelector("[role='log']");
t("the transcript is a log with a name", !!log && log.getAttribute("aria-label") === "Agent transcript");
t(`and it exists before the first answer (${log.textContent.slice(0, 24)}…)`,
  /Hello/.test(log.textContent));
t(`it is polite, and keeps the list class the pane uses (${log.className})`,
  log.getAttribute("aria-live") === "polite" && log.className === "tree");

await act(async () => {
  streamRoot.render(React.createElement(LiveLog, { label: "Agent transcript" }, greeting, answer));
});
t(`an answer arriving lands in the same region (${document.querySelectorAll("[role='log']").length} log)`,
  document.querySelectorAll("[role='log']").length === 1 && /Added a 160/.test(log.textContent));
await act(async () => {
  streamRoot.unmount();
});
stream.remove();

/* ── the product, as rendered ────────────────────────────────────────────── */

const { mountSurface } = await import("./domEnv.mjs");
const left = await mountSurface("left", { nav: "agent", props: { nav: "agent", onMinimize: () => {} } });
t(`the agent pane's transcript is the live region in the mounted app (role ${left.one("[role='log']")?.getAttribute("role")})`,
  !!left.one("[role='log']") && left.one("[role='log']").getAttribute("aria-label") === "Agent transcript");
t("and the pane renders exactly one of them", left.all("[role='log']").length === 1);
await left.unmount();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
