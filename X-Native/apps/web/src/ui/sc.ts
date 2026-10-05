/**
 * Platform-correct keyboard shortcut chips.
 *
 * A chord's source of truth stays the Mac-glyph form ("⌘C", "⇧⌘R", "⌃⌘M") —
 * that is what the key handlers match and what the menus are authored in.
 * What the user *reads* must match what Figma prints on their platform: the
 * reference captures (Figma on Windows) show "Ctrl+C", "Ctrl+Shift+R",
 * "Ctrl+Alt+M". So chips are translated at render time and only at render time.
 *
 * Two rules carry the whole map:
 * - lone ⌘ → "Ctrl", ⌥ → "Alt", ⇧ → "Shift", ⌃ → "Ctrl";
 * - a chord carrying BOTH ⌃ and ⌘ is Figma's "Ctrl+Alt+…" family (Use as mask
 *   is ⌃⌘M on the Mac and Ctrl+Alt+M on Windows), so in that case the ⌘
 *   prints as "Alt".
 * Windows prints modifiers in Ctrl, Alt, Shift order regardless of source
 * order, so "⌘⌥K" reads "Ctrl+Alt+K" exactly as the captures do.
 */

const MOD_ORDER = ["Ctrl", "Alt", "Shift"];

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || "");
}

/** Translate one chord for display. Identity on Mac, Figma-Windows form else. */
export function sc(chord: string | undefined): string | undefined {
  if (!chord) return chord;
  if (isMacPlatform()) return chord;
  const hasControl = chord.includes("⌃");
  const mods: string[] = [];
  for (const ch of chord) {
    if (ch === "⌘") mods.push(hasControl ? "Alt" : "Ctrl");
    else if (ch === "⌥") mods.push("Alt");
    else if (ch === "⇧") mods.push("Shift");
    else if (ch === "⌃") mods.push("Ctrl");
  }
  const key = chord.replace(/[⌘⌥⇧⌃]/g, "");
  const uniq = [...new Set(mods)].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...uniq, key].join("+");
}
