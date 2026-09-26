import type { XNode } from "../engine/types";
import { balanceLines } from "../engine/geometry";

/**
 * The web layer's single source of truth for text layout.
 *
 * Canvas painting and the inspector's resize controls have to agree exactly on
 * where a paragraph breaks and how tall a box it needs, otherwise switching a
 * text layer to hug sizes leaves a box measured by a different rule than the
 * one that then draws inside it. Everything here works in world units: the
 * caller multiplies by the zoom.
 */

/** Glyph-width cache. measureText dominated pan/zoom frame time on large
 *  documents because every visible string was re-measured on every frame even
 *  when neither the text nor the font had changed. Keyed by font + string, so
 *  a font change naturally misses and re-measures. Bounded to keep a long
 *  session from growing the cache without limit. */
const MEASURE_CACHE = new Map<string, number>();
const MEASURE_CACHE_MAX = 20000;

export function measureCached(ctx: CanvasRenderingContext2D, s: string): number {
  if (!s) return 0;
  const key = `${ctx.font}\u0000${s}`;
  const hit = MEASURE_CACHE.get(key);
  if (hit !== undefined) return hit;
  const w = ctx.measureText(s).width;
  if (MEASURE_CACHE.size >= MEASURE_CACHE_MAX) MEASURE_CACHE.clear();
  MEASURE_CACHE.set(key, w);
  return w;
}

/**
 * Line count and widest line for a text layer, using the layer's own wrapping
 * rules. The editor overlay and the commit-on-blur re-hug both need this: with
 * a fixed width the wrapped count, not the number of Return characters, is what
 * the box has to grow to, otherwise an auto-height layer ends up shorter than
 * its own text.
 */
/**
 * A list paragraph's marker, hung in the gutter. x-core's ListStyle, the same
 * three values; the width of the marker plus a space is the gutter every line
 * of that paragraph then clears.
 */
export function listMarker(style: XNode["listStyle"], index: number): string {
  if (style === "bulleted") return "\u2022";
  if (style === "numbered") return `${index + 1}.`;
  return "";
}

/**
 * Width the markers of a list need, in world units. The editor overlay indents
 * by this much so the caret starts where the text will be painted; the marker
 * itself only reappears on commit, since a textarea cannot draw one.
 */
export function listGutter(ctx: CanvasRenderingContext2D | null, n: XNode): number {
  if (!ctx || !n.listStyle || n.listStyle === "none") return 0;
  ctx.font = `${n.fontWeight} ${n.fontSize}px ${n.fontFamily}, Inter, system-ui`;
  return measureCached(ctx, `${listMarker(n.listStyle, 9)} `);
}

/**
 * Vertical alignment only takes on a Fixed-size layer: auto-width and
 * auto-height layers ignore it, so the renderer centres nothing on a hug
 * axis. Fill counts as fixed - the box has a definite size.
 */
export function valignApplies(n: XNode): boolean {
  return n.sizingW !== "hug" && n.sizingH !== "hug";
}

/**
 * First-line indent only takes with left-aligned text; every other
 * alignment ignores the field, so measuring and painting both read this
 * instead of the raw value.
 */
export function indentOf(n: XNode): number {
  return n.textAlign === "left" ? n.paragraphIndent || 0 : 0;
}

/**
 * The layer's case transform as a pure string map. Small caps is NOT an
 * uppercasing: the renderer pairs the lowered copy with a small-caps font
 * variant, which keeps the distinct small-cap proportions instead of
 * full-height capitals.
 */
export function applyTextCase(text: string, textCase: XNode["textCase"]): string {
  if (textCase === "upper") return text.toUpperCase();
  if (textCase === "lower" || textCase === "small-caps") return text.toLowerCase();
  if (textCase === "title") return text.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
  return text;
}

/**
 * How many lines of a fixed-size box stay visible under truncation: the
 * rows its height fits, at least one. Fixed layers have no max-lines
 * setting, so the box itself is the limit.
 */
export function fitLineCount(boxH: number, lineH: number, paraGap: number): number {
  if (!(lineH > 0)) return 1;
  return Math.max(1, Math.floor((Math.max(0, boxH) + Math.max(0, paraGap)) / (lineH + Math.max(0, paraGap))));
}

export function textMetrics(ctx: CanvasRenderingContext2D, n: XNode, text: string) {
  ctx.font = `${n.fontWeight} ${n.fontSize}px ${n.fontFamily}, Inter, system-ui`;
  const wrap = n.sizingW !== "hug";
  const ls = n.letterSpacing || 0;
  const widthOf = (line: string) =>
    measureCached(ctx, line) + (ls ? ls * Math.max(0, line.length - 1) : 0);
  const indent = indentOf(n);
  // Truncation cuts the taken rows at max lines, exactly like the painter;
  // the gaps counted are the paragraph breaks that survive the cut.
  const limit = n.truncate ? Math.max(1, n.maxLines || 1) : Infinity;
  let lines = 0;
  let completeParas = 0;
  let partialTake = false;
  let maxW = 8;
  let cut = false;
  for (const [pi, para] of (text || " ").split("\n").entries()) {
    if (lines >= limit) {
      cut = true;
      break;
    }
    const marker = listMarker(n.listStyle, pi);
    const gutter = marker ? widthOf(`${marker} `) : 0;
    const avail = wrap ? n.w - gutter - indent : 1e6;
    let wrapped = wrapLines(ctx, para || " ", avail > 0 ? avail : 1e6, ls);
    if (wrap && (n.textWrap === "balance" || n.textWrap === "pretty") && n.w > 0)
      wrapped = balanceLines(wrapped, avail, widthOf, n.textWrap);
    const take = Math.min(wrapped.length, Math.max(0, limit - lines));
    for (let i = 0; i < take; i++) {
      maxW = Math.max(maxW, gutter + (i === 0 ? indent : 0) + widthOf(wrapped[i]));
    }
    if (take < wrapped.length) cut = true;
    if (take > 0 && take < wrapped.length) partialTake = true;
    if (take >= wrapped.length && take > 0) completeParas += 1;
    lines += Math.max(1, take);
  }
  // The painter hangs a gap on every taken paragraph's last row, then takes
  // one back: a cut mid-paragraph forces the flag on the cut row, which is
  // the partial take counted here.
  const gaps = Math.max(0, completeParas + (partialTake ? 1 : 0) - (lines > 0 ? 1 : 0));
  // An auto-width layer appends the ellipsis past the last line instead of
  // trimming to fit, so the box budgets for it when a cut happened.
  if (cut && !wrap) maxW += widthOf("\u2026");
  return { lines, gaps, maxW };
}

export function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  letterSpacing: number,
): string[] {
  const paras = text.split("\n");
  const lines: string[] = [];
  const widthOf = (s: string) => {
    if (!s) return 0;
    const m = measureCached(ctx, s);
    return letterSpacing ? m + letterSpacing * Math.max(0, s.length - 1) : m;
  };
  const splitLong = (word: string) => {
    let part = "";
    for (const ch of word) {
      if (part && widthOf(part + ch) > maxW) {
        lines.push(part);
        part = ch;
      } else {
        part += ch;
      }
    }
    return part;
  };
  for (const para of paras) {
    if (!para) {
      lines.push("");
      continue;
    }
    if (maxW <= 0 || widthOf(para) <= maxW) {
      lines.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let cur = "";
    for (const token of words) {
      if (!token) continue;
      const word = token.trim();
      if (!word) {
        if (cur) cur += token;
        continue;
      }
      if (widthOf(word) > maxW) {
        if (cur.trim()) {
          lines.push(cur.trimEnd());
          cur = "";
        }
        cur = splitLong(word);
        continue;
      }
      const next = cur ? `${cur}${token}` : word;
      if (cur && widthOf(next) > maxW) {
        lines.push(cur.trimEnd());
        cur = word;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur.trimEnd());
  }
  return lines.length ? lines : [""];
}

/** A 2D context that exists only to measure with: `measureText` is the one
 *  place the browser exposes font metrics, and the inspector has no canvas of
 *  its own. */
let scratch: CanvasRenderingContext2D | null = null;
export function measureCtx(): CanvasRenderingContext2D | null {
  if (!scratch && typeof document !== "undefined")
    scratch = document.createElement("canvas").getContext("2d");
  return scratch;
}

/**
 * The box a text layer should have on the axes set to hug.
 *
 * The layout re-fits immediately when a resizing mode is chosen, not on the next
 * keystroke, so the sizing flags and the geometry always travel in the same
 * patch. Pass the node with its *target* sizing to size it as it is about to
 * wrap; the padding matches what the editor commits with.
 */
/**
 * Hug height for measured rows: every row its leading, every surviving
 * paragraph break its gap, never shorter than one leading. Pure, so the
 * headless checks cover the rule the canvas-backed hugSize applies.
 */
export function hugHeight(lines: number, gaps: number, lh: number, paraGap: number): number {
  return Math.max(
    Math.ceil(lh),
    Math.ceil(Math.max(1, lines) * lh + Math.max(0, gaps) * Math.max(0, paraGap)),
  );
}

export function hugSize(
  n: XNode,
  text: string,
  axes?: { w?: boolean; h?: boolean },
): { w?: number; h?: number } {
  const ctx = measureCtx();
  if (!ctx) return {};
  const wantW = axes?.w ?? n.sizingW === "hug";
  const wantH = axes?.h ?? n.sizingH === "hug";
  const m = textMetrics(ctx, n, text);
  const lh = n.lineHeight || n.fontSize * 1.2;
  const gap = n.paragraphSpacing || 0;
  const out: { w?: number; h?: number } = {};
  if (wantW) out.w = Math.max(8, Math.ceil(m.maxW + 4));
  if (wantH) out.h = hugHeight(m.lines, m.gaps, lh, gap);
  return out;
}
