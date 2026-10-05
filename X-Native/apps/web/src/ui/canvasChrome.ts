/**
 * Canvas chrome roles (FR-U2).
 *
 * The 2D surfaces — the main canvas, the minimap, the rulers — used to carry
 * their own palette as module literals (a hardcoded brand green, a component
 * purple, `dark ? "#171c22" : "#eef1f4"`), with a comment asking whoever changed
 * `--comp` in styles.css to "change both". Two greens lived in the codebase as a
 * result: the control accent and the canvas selection ink, and the second one
 * could not follow the theme at all. The values below are identity v3's: the
 * selection family is the brand violet, the drop target its own cyan, the mask
 * its amber — four distinct roles instead of one green wearing four hats.
 *
 * This module is the single door between the sheet and the canvases:
 *
 *  - `CANVAS_CHROME_TOKENS` names the role → custom-property mapping once.
 *  - `CANVAS_CHROME_FALLBACK` is the light column of styles.css, verbatim. It is
 *    what paints when the cascade has not defined a token (SSR, a test harness,
 *    a stripped sheet). `canvasChrome.test.mjs` parses styles.css and fails if
 *    any fallback disagrees with the sheet or if the dark theme is missing a
 *    key — that is the ratchet that replaces "kept in step by hand".
 *  - `readCanvasChrome(get)` is pure: hand it any `token → value` lookup and it
 *    returns a full chrome record, so it is testable without a DOM or a canvas.
 *  - `canvasChrome()` does the `getComputedStyle` read for callers that do not
 *    already hold one (Minimap, Rulers). Callers that do (Canvas' paint effect)
 *    should pass their own lookup so a frame costs one style resolution.
 *
 * Selection ink is intentionally a role of its own rather than `--accent`: the
 * ring and handles sit on the document canvas, not on a panel, so they are
 * contrast-tuned against `--canvas`. The reverse holds too, and is the reason the
 * minimap viewport and the ruler range wash were moved off `--accent` onto `sel` /
 * `selWash`: a *canvas* surface that reads the *panel* accent cannot answer the
 * canvas-chrome theme (`View → Canvas chrome`), and a second green in the chrome
 * is what the FR-U2 round was created to remove. That is a rule now, not a habit:
 * the only panel tokens left in this record are the ones FR-U2 shares on purpose —
 * surface, well, grid, label, component identity — and the control accent is not one
 * of them, so no canvas surface can be themed by the appearance switch and left
 * behind. Document ink is NOT in this record — a default fill or a new slice's
 * stroke is written into the file and must not move when the theme changes; those
 * stay named literals at their call sites.
 */

/** Role → custom property. Every key here must exist in both theme blocks. */
export const CANVAS_CHROME_TOKENS = {
  /** Selection ring, handles, labels, badges, outline mode. */
  sel: "--cv-sel",
  /** Marquee / selection interior wash. */
  selWash: "--cv-sel-wash",
  /** Handle halo under the ring. */
  selGlow: "--cv-sel-glow",
  /** Ink drawn on top of canvas chrome: handle centres, badge text, marker outlines. */
  ink: "--cv-ink",
  /** Locked layer's chrome — ring, pill, grab guards. */
  lock: "--cv-lock",
  /** Smart guides and equal-spacing badges. */
  guide: "--cv-guide",
  /** Drop-target outline and crop handles. */
  target: "--cv-target",
  /** Mask outline. */
  mask: "--cv-mask",
  /** On-canvas card backing (spec notes, measurements). */
  chip: "--cv-chip",
  /** On-canvas card hairline. */
  chipLine: "--cv-chip-line",
  /** On-canvas card body text. */
  chipInk: "--cv-chip-ink",
  /** Minimap backing: canvas-coloured in light, panel-coloured in dark. */
  well: "--cv-well",
  /** Ruler rails — the panel surface the rulers are set into. */
  panel: "--panel",
  /** Ruler hairline and ticks. */
  line: "--cv-line",
  /** Ruler numerals and other dim canvas text. */
  dim: "--cv-dim",
  /** Scrim that dims the document outside a crop window. */
  scrim: "--cv-scrim",
  /** Document canvas backing (pre-existing token, folded in for one read). */
  canvas: "--canvas",
  /** Dot/line grid. */
  grid: "--grid",
  /** Frame-name labels drawn on the canvas. */
  label: "--canvas-label",
  /** Component / instance identity. */
  comp: "--comp",
} as const;

export type CanvasChromeKey = keyof typeof CANVAS_CHROME_TOKENS;
export type CanvasChrome = Record<CanvasChromeKey, string>;

/**
 * The light column of styles.css, verbatim — contract-tested against the sheet.
 * A token the cascade has not defined still paints, and paints as light chrome.
 */
export const CANVAS_CHROME_FALLBACK: CanvasChrome = {
  sel: "#5b3df5",
  selWash: "rgba(91, 61, 245, 0.14)",
  selGlow: "rgba(91, 61, 245, 0.32)",
  ink: "#ffffff",
  lock: "#8e93a8",
  guide: "#ff2d55",
  target: "#00b3d4",
  mask: "#e39400",
  chip: "rgba(13, 15, 28, 0.94)",
  chipLine: "rgba(255, 255, 255, 0.16)",
  chipInk: "#f4f5fa",
  well: "#eef0f8",
  panel: "#ffffff",
  line: "#d8dbe9",
  dim: "#8a8fa6",
  scrim: "rgba(13, 15, 28, 0.46)",
  canvas: "#eef0f8",
  grid: "rgba(91, 61, 245, 0.07)",
  label: "rgba(23, 26, 43, 0.5)",
  comp: "#0092b5",
};

/**
 * Pure: resolve a chrome record from any `token → raw value` lookup. Values are
 * trimmed and blank ones fall back, so a partially themed sheet still paints.
 */
export function readCanvasChrome(get: (token: string) => string): CanvasChrome {
  const out = {} as CanvasChrome;
  for (const key of Object.keys(CANVAS_CHROME_TOKENS) as CanvasChromeKey[]) {
    const raw = get(CANVAS_CHROME_TOKENS[key]);
    const value = typeof raw === "string" ? raw.trim() : "";
    out[key] = value || CANVAS_CHROME_FALLBACK[key];
  }
  return out;
}

/**
 * Read chrome from the live cascade. Safe with no DOM at all (falls back), and
 * cheap enough to call once per paint: the browser hands back a cached computed
 * style object, and `getPropertyValue` on it is a lookup, not a reflow.
 */
export function canvasChrome(root?: Element | null): CanvasChrome {
  const el =
    root ??
    (typeof document !== "undefined" ? document.documentElement : null);
  if (!el || typeof getComputedStyle !== "function") {
    return { ...CANVAS_CHROME_FALLBACK };
  }
  const css = getComputedStyle(el);
  return readCanvasChrome((token) => css.getPropertyValue(token));
}

const alphaText = (a: number) => String(Math.round(a * 1000) / 1000);

/**
 * Chrome at a fraction of its own strength: one role, thinned. Canvas overlays
 * need the selection hue at several alphas — a boolean preview wash, bézier
 * tangents, a branching-vertex halo, the auto-layout padding ghosts — and
 * hardcoding `rgba(16, 185, 129, …)` for each of them is exactly how the
 * literals came back the first time. Accepts `#rgb`/`#rrggbb`/`#rrggbbaa` (the
 * source alpha is dropped in favour of the requested one) and `rgb()`/`rgba()`.
 * Anything it cannot parse — an empty token, a gradient, a `var()` — is returned
 * untouched, so a mis-shaped sheet degrades instead of throwing mid-paint.
 */
export function withAlpha(color: string, alpha: number): string {
  const src = typeof color === "string" ? color.trim() : "";
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(src);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alphaText(a)})`;
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(src);
  if (fn) {
    const parts = fn[1].split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alphaText(a)})`;
  }
  return src;
}
