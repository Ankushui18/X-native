/**
 * No phantom wiring (PM-U10).
 *
 * The product's cross-component signals travel as window events — `x-native-*`
 * CustomEvents — because a menu in `chrome.tsx` cannot call into `Canvas.tsx` and
 * a radial slice cannot reach into the vector toolbar. That bus had never been
 * audited as a whole, and one wire was dangling: the radial menu's **Bend Tool**
 * slice dispatched `x-native-bend-tool`, and nothing anywhere listened, so
 * choosing it reset the user's tool and did nothing else while the real Bend
 * button sat in the vector-edit toolbar. A menu item that promises a tool and
 * delivers a no-op is exactly the "phantom control" the design rules forbid.
 *
 * This file is the bus's census, in the shape of the drift ratchet: every event
 * name in the source must be listed below with what sends it and what hears it,
 * a name that appears without a row fails, and a row whose counts move fails
 * until someone updates it. An event may legitimately have no listener — the
 * `observerOnly` rows are ones e2e or a test listens for — but it cannot be an
 * accident.
 *
 * Run with:  npx vite-node src/ui/__tests__/events.test.mjs
 */
import path from "path";
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const events = await import("../vectorEdit.ts");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

/* ── the census ──────────────────────────────────────────────────────────── */

/** Every `x-…` name that is the literal first argument of an `addEventListener`
 *  (hears it) or of a `new CustomEvent(` (sends it), with the file it lives in.
 *  Matching the *call* rather than "a window of nearby lines" is what keeps CSS
 *  class names (`x-dialog`), storage keys (`x-native-recents`) and the
 *  `removeEventListener` that mirrors each listener out of the census. */
function census() {
  const found = new Map();
  const note = (map, name, file) => {
    if (!/^x-/.test(name)) return;
    const row = found.get(name) ?? { sent: [], heard: [] };
    if (!row[map].includes(file)) row[map].push(file);
    found.set(name, row);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name) && !/__tests__/.test(p)) scan(p);
    }
  };
  const scan = (p) => {
    const text = readFileSync(p, "utf8");
    const file = path.relative(SRC, p);
    for (const m of text.matchAll(/addEventListener\(\s*"([^"]+)"/g)) note("heard", m[1], file);
    for (const m of text.matchAll(/new CustomEvent\(\s*"([^"]+)"/g)) note("sent", m[1], file);
  };
  walk(SRC);
  return found;
}

/**
 * The bus, as a census: for every event, the files that send it and the file that
 * hears it, plus what it is for. A new dispatch site anywhere fails the row until
 * someone updates it — the same instrument as the chrome drift table, applied to
 * the wiring instead of the markup.
 */
const BUS = {
  "x-collapse-all": { sent: ["ui/chrome.tsx"], heard: ["ui/chrome.tsx"], why: "Actions ▸ Collapse all; the layer tree folds" },
  "x-expand-subtree": { sent: ["ui/chrome.tsx"], heard: ["ui/chrome.tsx"], why: "Actions ▸ Expand subtree; the tree re-opens it" },
  "x-eyedrop-model": { sent: ["ui/color.ts"], heard: ["ui/Canvas.tsx"], why: "the active eyedropper readout model updates the canvas loupe" },
  "x-native-annotate": { sent: ["ui/chrome.tsx"], heard: ["ui/inspector.tsx"], why: "⇧T and the Dev Mode button focus the note field" },
  "x-native-bend-tool": { sent: ["ui/RadialMenu.tsx"], heard: ["ui/Canvas.tsx"], why: "PM-U10: radial ▸ Bend Tool, answered by the canvas (was sent-and-forgotten)" },
  "x-native-copy-code": { sent: ["ui/ContextMenu.tsx", "ui/chrome.tsx"], heard: ["App.tsx"], why: "the copy-as-code commands; App writes the clipboard" },
  "x-native-copy-link": { sent: ["ui/ContextMenu.tsx"], heard: ["App.tsx"], why: "the share/copy-link commands" },
  "x-native-copy-png": { sent: ["ui/ContextMenu.tsx", "ui/chrome.tsx"], heard: ["App.tsx"], why: "the copy-as-PNG commands" },
  "x-native-copy-svg": { sent: ["ui/ContextMenu.tsx"], heard: ["App.tsx"], why: "the copy-as-SVG command; App writes the clipboard" },
  "x-native-crop-image": { sent: ["ui/ContextMenu.tsx", "ui/inspector.tsx"], heard: ["ui/Canvas.tsx"], why: "the image crop button and its menu entry" },
  "x-native-export-dialog": { sent: ["ui/chrome.tsx", "ui/inspector.tsx"], heard: ["App.tsx"], why: "⇧⌘E, File ▸ Export and the palette; App opens the sheet" },
  "x-native-find": { sent: ["ui/chrome.tsx"], heard: ["App.tsx"], why: "⌘F opens the find bar" },
  "x-native-hide-ui": { sent: ["ui/ContextMenu.tsx", "ui/inspector.tsx"], heard: ["App.tsx"], why: "the zen/hide commands" },
  "x-native-layer-copy": { sent: ["ui/chrome.tsx"], heard: ["ui/Canvas.tsx"], why: "copy commands clear the connection clipboard" },
  "x-native:link-input": { sent: ["ui/chrome.tsx", "ui/Canvas.tsx"], heard: ["ui/Canvas.tsx"], why: "⇧⌘U opens the link URL input above the selection (360045942953)" },
  "x-native-minimize-ui": { sent: ["ui/ContextMenu.tsx"], heard: ["App.tsx"], why: "the minimize command" },
  "x-native-nudge-dialog": { sent: ["ui/chrome.tsx"], heard: ["App.tsx"], why: "palette ▸ Nudge amount; App opens the dialog" },
  "x-native-open-section": { sent: ["ui/inspector.tsx"], heard: ["ui/inspector.tsx"], why: "an inspector section is revealed and focused" },
  "x-native-paste": { sent: ["ui/ContextMenu.tsx"], heard: ["ui/Canvas.tsx"], why: "the canvas context menu pastes at the click point" },
  "x-native-place-image": { sent: ["ui/ContextMenu.tsx", "ui/chrome.tsx"], heard: ["ui/Canvas.tsx"], why: "the two import paths hand the placement to the canvas" },
  "x-native-radial-menu": { sent: ["ui/chrome.tsx"], heard: ["App.tsx"], why: "the Actions menu's Marking / Radial menu row" },
  "x-native-shortcuts": { sent: ["ui/Dashboard.tsx", "ui/chrome.tsx"], heard: ["ui/chrome.tsx"], why: "the ? chord, the dashboard's help button and the palette" },
  "x-native-vec-subtool": { sent: ["ui/chrome.tsx"], heard: ["ui/Canvas.tsx"], why: "the tool row selects a vector sub-tool" },
  "x-native-zen-mode": { sent: ["ui/chrome.tsx"], heard: ["App.tsx"], why: "the zen command" },
  "x-panel-hover": { sent: ["ui/chrome.tsx"], heard: ["ui/Canvas.tsx"], why: "panel hover previews the canvas chrome" },
  "x-rename-layer": { sent: ["ui/chrome.tsx"], heard: ["ui/chrome.tsx"], why: "F2 and the context menu start an inline rename" },
};

const found = census();
const names = [...found.keys()].sort();
const list = (a) => a.join(", ");

const unlisted = names.filter((n) => !(n in BUS));
t(`every event in the source is in the census (${names.length} events${unlisted.length ? `, unlisted: ${list(unlisted)}` : ""})`,
  unlisted.length === 0);
const stale = Object.keys(BUS).filter((n) => !names.includes(n));
t(`and the census names no event the source does not have (${list(stale) || "none"})`, stale.length === 0);

for (const name of names) {
  const row = BUS[name];
  if (!row) continue;
  const got = found.get(name);
  const okSent = list([...got.sent].sort()) === list([...row.sent].sort());
  const okHeard = list([...got.heard].sort()) === list([...row.heard].sort());
  const drift = [
    okSent ? "" : `sent ${list(got.sent) || "nowhere"} (pinned ${list(row.sent)})`,
    okHeard ? "" : `heard in ${list(got.heard) || "nowhere"} (pinned ${list(row.heard)})`,
  ].filter(Boolean).join("; ");
  t(`${name.padEnd(26)} ${okSent && okHeard ? "as wired" : `CHANGED: ${drift}`} — ${row.why}`,
    okSent && okHeard);
}

// The point of the round: nothing is dispatched into the void.
const dangling = names.filter((n) => found.get(n).sent.length > 0 && found.get(n).heard.length === 0);
t(`no event is dispatched with nothing to hear it (${list(dangling) || "none"})`, dangling.length === 0);
// And no listener waits for a signal nothing sends.
const orphanListeners = names.filter((n) => found.get(n).heard.length > 0 && found.get(n).sent.length === 0);
t(`no listener waits for an event nothing sends (${list(orphanListeners) || "none"})`, orphanListeners.length === 0);
// A listener without its removal leaks one handler per mount.
const unbalanced = [];
for (const entry of readdirSync(path.join(SRC, "ui"))) {
  if (!/\.tsx?$/.test(entry)) continue;
  const text = readFileSync(path.join(SRC, "ui", entry), "utf8");
  for (const m of text.matchAll(/addEventListener\(\s*"(x-[^"]+)"/g)) {
    if (!new RegExp(`removeEventListener\\(\\s*"${m[1]}"`).test(text)) unbalanced.push(`${entry}:${m[1]}`);
  }
}
t(`every listener removes itself (${list(unbalanced) || "all balanced"})`, unbalanced.length === 0);

/* ── the wire that was dangling ──────────────────────────────────────────── */

const radial = readFileSync(path.join(SRC, "ui/RadialMenu.tsx"), "utf8");
t("the Bend slice still asks the canvas rather than acting itself",
  /x-native-bend-tool/.test(radial) && !/id: "bend"[\s\S]{0,300}setTool/.test(radial));

const canvas = readFileSync(path.join(SRC, "ui/Canvas.tsx"), "utf8");
const listener = /window\.addEventListener\("x-native-bend-tool", onBend\)/.exec(canvas);
t("and the canvas listens for it now", !!listener);
t("with a matching removal, so a remount cannot stack handlers",
  /window\.removeEventListener\("x-native-bend-tool", onBend\)/.test(canvas));
t("it answers through the shared rule, not its own copy",
  /bendReadiness\(\{ vecEdit, tool: engine\.snapshot\(\)\.tool, drafting: draft\.length > 0 \}\)/.test(canvas));
t("and it does not change the tool — which would take the toolbar off screen",
  !/onBend[\s\S]{0,700}setTool/.test(canvas));

/* ── the rule itself ─────────────────────────────────────────────────────── */

const cases = [
  [{ vecEdit: "v1", tool: "select", drafting: false }, true, "a vector in point edit"],
  [{ vecEdit: null, tool: "pen", drafting: false }, true, "the pen tool"],
  [{ vecEdit: null, tool: "select", drafting: true }, true, "a path in progress"],
  [{ vecEdit: null, tool: "select", drafting: false }, false, "nothing in play"],
  [{ vecEdit: null, tool: "frame", drafting: false }, false, "the frame tool"],
  [{ vecEdit: null, tool: "text", drafting: false }, false, "the text tool"],
];
for (const [ctx, ok, label] of cases) {
  const r = events.bendReadiness(ctx);
  t(`bend readiness: ${label} → ${r.ok ? "active" : "says what it needs"}`, r.ok === ok);
}
const refuse = events.bendReadiness({ vecEdit: null, tool: "select", drafting: false });
t(`and the refusal names the way in ("${refuse.need}")`,
  /Enter/.test(refuse.need) && /pen/.test(refuse.need));
const allow = events.bendReadiness({ vecEdit: "v1", tool: "select", drafting: false });
t(`the activation says what the tool does ("${allow.say}")`, /drag segment/.test(allow.say));
t("the toolbar's own buttons share the guard with the radial",
  /vectorToolbarOpen\(/.test(readFileSync(path.join(SRC, "ui/vectorEdit.ts"), "utf8")));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
