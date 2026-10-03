/**
 * Headless checks for the shared tooltip surface (audit §2.3).
 *
 * The component and the `title` bridge are covered in the browser by the
 * behaviour suite; what is worth pinning without a DOM is the label contract
 * every call site and the bridge both depend on:
 *
 *  - `splitShortcutLabel` decides whether a trailing bracket is a shortcut or
 *    part of the label. Getting it wrong either eats prose ("Clean up vector
 *    (sketch to perfect Bézier)") or drops a real key hint.
 *  - `showDelay` implements the chain rule — the first tooltip waits, the next
 *    one along the same row does not — which is also the accessible name's
 *    source of truth for controls that only had `title`.
 *
 * Run with:  npx vite-node src/ui/__tests__/tooltip.test.mjs
 */
import { markShown, showDelay, splitShortcutLabel } from "../Tooltip.tsx";

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`not ok - ${name}`);
};
const eq = (name, actual, expected) =>
  t(`${name} (${JSON.stringify(actual)})`, JSON.stringify(actual) === JSON.stringify(expected));

/* ── label + shortcut split ────────────────────────────────────────────── */

const split = (s) => splitShortcutLabel(s);
eq("a delete hint splits", split("Delete connection (⌫)"), { label: "Delete connection", shortcut: "⌫" });
eq("a chord splits", split("Auto Layout (⇧A)"), { label: "Auto Layout", shortcut: "⇧A" });
eq("a slashed label splits", split("Move / Select (V)"), { label: "Move / Select", shortcut: "V" });
eq("a command chord splits", split("Copy (⌘C)"), { label: "Copy", shortcut: "⌘C" });
t("an empty label is not a shortcut", split("()").label === "()");

// prose in brackets is part of the label, not a key
eq("prose in brackets stays in the label", split("Clean up vector (sketch to perfect Bézier)").shortcut, undefined);
eq("a sentence in brackets stays in the label", split("Done (Esc / ↵ / Double-click to finish)"), {
  label: "Done (Esc / ↵ / Double-click to finish)",
});
t("a plain label has no shortcut", split("Export scale").shortcut === undefined);
t("a bracketed word is not a key", split("Layer (selected)").shortcut === undefined);
t("surrounding space is trimmed", split("  Close  ").label === "Close");

/* ── chain rule ────────────────────────────────────────────────────────── */

t("the first tooltip waits", showDelay() > 0);
t("keyboard focus is instant", showDelay(true) === 0);
markShown();
t("the next tooltip along the row is instant", showDelay() === 0);

console.log(`tooltip: ${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
