/**
 * Which themes exist, and what to do with a preference written by an older
 * build.
 *
 * There were five: light, dark, and two near-duplicates - Graphite (dark with a
 * violet tint) and Daylight (light with warmer greys). Both were extra names
 * over the same two colour schemes, so the menu asked a question with more
 * answers than there are, and the saved preference could name a theme the UI no
 * longer offered. Three is the set: Light, Dark, and System for "whatever the
 * OS says".
 *
 * The old values are mapped rather than dropped, so a saved `graphite` opens as
 * Dark and `daylight` as Light instead of falling back to an unstyled default.
 */

export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";

/** The menu, in order. */
export const THEME_OPTIONS: { id: ThemePref; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

/** Names an older build wrote, and the theme each one becomes. */
const LEGACY: Record<string, ThemePref> = {
  graphite: "dark",
  daylight: "light",
};

export const DEFAULT_THEME_PREF: ThemePref = "light";

/**
 * A stored preference, reduced to one of the three. Anything unrecognised -
 * including the null of a first visit - becomes the default, which is what
 * Figma's own theme setting does when it has nothing better to go on.
 */
export function normalizeThemePref(raw: unknown): ThemePref {
  if (typeof raw !== "string") return DEFAULT_THEME_PREF;
  const v = raw.trim().toLowerCase();
  if (v === "light" || v === "dark" || v === "system") return v;
  return LEGACY[v] ?? DEFAULT_THEME_PREF;
}

/** The theme a preference resolves to, given what the OS is asking for. */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): Theme {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

/** Label for a preference, for the menus and the quick-actions list. */
export function themeLabel(pref: ThemePref): string {
  return THEME_OPTIONS.find((o) => o.id === pref)?.label ?? "Light";
}
