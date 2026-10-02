// Batch 44: Place-image shortcut parity (Figma Design).
// Verifies the tool-map no longer maps ⇧I to "image" by directly checking
// the same predicates chrome.tsx uses.  Bare I stays the eyedropper chord
// (checked by the earlier tests at runtime; here we confirm the shifted
// table no longer contains an 'i' entry, which is the surface change that
// was causing ⇧I to enter the image-placement tool instead of being the
// unbound key Figma specifies).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(import.meta.dirname, "..", "..", "ui", "chrome.tsx"),
  "utf8",
);

// Extract the `shifted` Record literal: it should no longer list i: "image".
// We don't execute TS — we assert on source shape, because a TS parse
// would drag in React.  A conservative regex is sufficient: if the
// shifted-map block contains an 'i:' key binding the regression is back.
const shiftedBlock = src.match(/if \(!meta && e\.shiftKey\) \{[\s\S]*?const shifted: Record<string, Tool> = \{([^}]*)\}/);
if (!shiftedBlock) {
  console.error("Could not locate shifted tool map in chrome.tsx");
  process.exit(1);
}
if (/\bi\s*:/.test(shiftedBlock[1])) {
  console.error("Shifted tool map still binds 'i' (⇧I); Figma leaves ⇧I unbound, place image is ⌘⇧K");
  process.exit(1);
}
console.log("ok   shifted tool map no longer contains 'i' entry (⇧I stays unbound)");

// The unshifted map MUST still contain i:"image" is *gone* too — bare i is
// handled by the isEyedrop early-return before the tool map ever sees it,
// but the map itself still lists i for historical reasons. That entry is
// harmless because the early return precedes it. Confirm the ⌘⇧K handler
// is in place (dispatches x-native-place-image).
if (!/meta && e\.shiftKey && e\.key\.toLowerCase\(\) === "k"/.test(src)) {
  console.error("Missing ⌘⇧K place-image handler");
  process.exit(1);
}
console.log("ok   ⌘⇧K place-image handler present");

// Confirm the menu labels advertise ⌘⇧K (not ⇧I) for Place image.
const badLabel = (src.match(/sc:\s*"⇧I"/g) || []).length;
if (badLabel > 0) {
  console.error(`Found ${badLabel} menu label(s) still advertising ⇧I for Place image`);
  process.exit(1);
}
console.log("ok   menu labels advertise ⌘⇧K for Place image");

// The ⇧I toolmap entry must NOT switch to image; since we removed it from
// `shifted`, confirm there is no *other* setTool("image") fired by ⇧I.
// The bare-i eyedrop block explicitly requires !e.shiftKey so it doesn't
// catch ⇧I; and the shifted map no longer has it.
const eyedropBlock = src.match(/const isEyedrop = [^;]+;/);
if (!eyedropBlock || !/!e\.shiftKey/.test(eyedropBlock[0])) {
  console.error("Eyedrop guard missing !e.shiftKey check");
  process.exit(1);
}
console.log("ok   eyedropper guard correctly excludes ⇧I");

console.log("\n4 passed, 0 failed");
