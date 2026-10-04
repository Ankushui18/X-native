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
 * default system themes do when there is nothing better to go on.
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

/* ---------------------------------------------------------------- canvas chrome */

/**
 * Which palette the 2D surfaces paint their selection chrome in.
 *
 * `editor` (the default) is this app's emerald selection ink. `figma` moves the
 * same family of canvas roles to Figma's blue - ring, handles, layer label, size
 * and angle chips, the vector skeleton, the rulers and the minimap viewport.
 * It is deliberately *not* a theme for the app: panels, buttons and the rail keep
 * `--accent` either way, because that ink is contrast-tuned for panel surfaces
 * while selection ink sits on the document canvas (see the FR-U2 comment in
 * styles.css). The values live in that sheet under
 * `html[data-canvas-chrome="figma"]` and reach the canvas through
 * `canvasChrome.ts`, the only door between CSS and the 2D surfaces - so this
 * preference owns one attribute on `<html>` and nothing else.
 */
export type CanvasChromePref = "editor" | "figma";

/** The menu, in order. The first entry is the default. */
export const CANVAS_CHROME_OPTIONS: { id: CanvasChromePref; label: string }[] = [
  { id: "editor", label: "Editor" },
  { id: "figma", label: "Figma blue" },
];

export const DEFAULT_CANVAS_CHROME_PREF: CanvasChromePref = "editor";

/**
 * A stored preference, reduced to one of the two. Anything unrecognised - the
 * null of a first visit, a value a future build invented - becomes the default,
 * so a stale `localStorage` entry can never leave the canvas unstyled.
 */
export function normalizeCanvasChromePref(raw: unknown): CanvasChromePref {
  if (typeof raw !== "string") return DEFAULT_CANVAS_CHROME_PREF;
  const v = raw.trim().toLowerCase();
  return v === "editor" || v === "figma" ? v : DEFAULT_CANVAS_CHROME_PREF;
}

/** Label for a canvas-chrome preference, for the menu and the quick-actions list. */
export function canvasChromeLabel(pref: CanvasChromePref): string {
  return CANVAS_CHROME_OPTIONS.find((o) => o.id === pref)?.label ?? "Editor";
}

/**
 * Write the attribute the sheet keys its override block off. The default
 * *removes* it rather than writing `editor`: an absent attribute is the state the
 * rest of the sheet assumes, and a stale `[data-canvas-chrome]` left behind by a
 * toggle that was switched off is the failure mode this avoids.
 */
export function applyCanvasChromePref(
  pref: CanvasChromePref,
  root: { dataset: Record<string, string | undefined> } | null | undefined,
): void {
  if (!root || !root.dataset) return;
  if (pref === "figma") root.dataset.canvasChrome = "figma";
  else delete root.dataset.canvasChrome;
}

