import type { XNode } from "../engine/types";
import { balanceLines } from "../engine/geometry";
import { fontFamilyStack } from "../engine/textInput";
import { resolvedTextSpans, type StyledSpan } from "./textSpans";

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

/** A web font can resolve after we first measured its fallback under the same
 * ctx.font string. Clear those widths when FontFaceSet finishes loading. */
export function invalidateTextMeasureCache() {
  MEASURE_CACHE.clear();
}

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
 * A list paragraph's marker and its level (360040449773): "Figma currently
 * supports up to five levels of indentation" and "numbered list counters
 * rotate between numbers, alphabetical characters, and roman numerals with
 * each indentation". Bullets keep one glyph at every level.
 */
export function listLevelOf(n: XNode, pi: number): number {
  const lv = n.listLevels?.[pi];
  return Math.max(0, Math.min(4, Math.round(lv ?? 0)));
}

/** Per-paragraph list override: `null` = the counter was deleted on that line
 *  ("Backspace or Delete at the beginning of a list item to delete the
 *  counter, but keep the same level of indentation"). */
export function paraListStyle(n: XNode, pi: number): XNode["listStyle"] {
  // `paraList[pi] === null` marks a counter deleted by Backspace at the item
  // start: the paragraph keeps its indent level but stops counting. Any
  // other entry leaves the layer's list style in charge.
  const p = n.paraList?.[pi];
  return p === null ? "none" : n.listStyle ?? "none";
}

/** Per-paragraph wrap style (360039956634 §Wrap style applies per paragraph). */
export function paraWrapOf(n: XNode, pi: number): XNode["textWrap"] {
  return n.paraWrap?.[pi] ?? n.textWrap ?? "auto";
}

/**
 * Effective line height in world units (360039956634 §Line height): a fixed
 * px value, a percentage of the font size ("Figma will convert the value for
 * you, to the nearest pixel" — the caller converts on unit switch; here the
 * percent simply resolves against the font size), or Auto = the font's OWN
 * default line height, which "varies between typefaces". The per-node
 * `textMetrics` stamped by the engine (measureText's font bounding box) is
 * the Figma answer; the 1.2em constant survives only as the fallback for a
 * layer that has never been measured (headless first paint, codegen before
 * the fonts are loaded). Span sizes rescale the recorded box proportionally,
 * so an override larger than the base keeps the same font's ratio.
 */
/** Effective letter spacing in px. Figma's ↔ field takes px or a percent of
 * the font size ("Letter spacing: % is relative to the font size" in the text
 * guide 360039956634), exactly like line height's unit - so one resolver
 * feeds measurement, paint, export, and outlining alike. */
export function effectiveLetterSpacing(
  n: Pick<XNode, "letterSpacing" | "letterSpacingUnit" | "fontSize">,
  scale = 1,
): number {
  const v = n.letterSpacing || 0;
  return (n.letterSpacingUnit === "percent" ? (v / 100) * n.fontSize : v) * scale;
}

export function effectiveLineHeight(n: XNode, fontSize?: number): number {
  const fs = Math.max(1, fontSize ?? n.fontSize);
  const unit = n.lineHeightUnit ?? (n.lineHeight > 0 ? "px" : "auto");
  if (unit === "percent" && n.lineHeight > 0) return Math.max(1, (n.lineHeight / 100) * fs);
  if (unit === "px" && n.lineHeight > 0) return Math.max(1, n.lineHeight);
  const m = n.textMetrics;
  if (m && m.fontBoundingBoxAscent != null && m.fontBoundingBoxDescent != null && m.fontSize) {
    return Math.max(1, ((m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) * fs) / m.fontSize);
  }
  return Math.max(1, fs * 1.2);
}

function alphaCounter(i: number): string {
  let s = "";
  let v = i;
  do {
    s = String.fromCharCode(97 + (v % 26)) + s;
    v = Math.floor(v / 26) - 1;
  } while (v >= 0);
  return s;
}

function romanCounter(n: number): string {
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let v = Math.max(1, Math.floor(n));
  let s = "";
  for (const [k, r] of table) while (v >= k) { s += r; v -= k; }
  return s;
}

export function listMarker(style: XNode["listStyle"], index: number, level = 0): string {
  if (style === "bulleted") return "\u2022";
  if (style === "numbered") {
    // Level % 3 rotates the counter form: 1. / a. / i. / 1. / a. ...
    const rot = level % 3;
    if (rot === 1) return `${alphaCounter(index)}.`;
    if (rot === 2) return `${romanCounter(index + 1)}.`;
    return `${index + 1}.`;
  }
  return "";
}

/** 0-based counter per paragraph: each item increments its level's counter and
 *  resets the deeper ones; paragraphs without a counter keep their indent but
 *  never count. */
export function listCounters(n: XNode, paraCount: number): number[] {
  const stack: number[] = [];
  const out: number[] = [];
  for (let pi = 0; pi < paraCount; pi++) {
    const style = paraListStyle(n, pi);
    const level = listLevelOf(n, pi);
    if (style === "none") {
      out.push(0);
      continue;
    }
    stack.length = Math.min(stack.length, level + 1);
    stack[level] = (stack[level] ?? 0) + 1;
    out.push(stack[level] - 1);
  }
  return out;
}

/**
 * Marker geometry for one paragraph. Hanging lists (absent = on) move the
 * marker outside the bounding box so the text content aligns with it; with
 * `hangingLists: false` the marker sits at the box edge and every line clears
 * it (the gutter). `textLead`/`markerX` are offsets from the paragraph's
 * first-line indent.
 */
export function listLayout(
  n: XNode,
  pi: number,
  counter: number,
  widthOf: (s: string) => number,
): { marker: string; gutter: number; textLead: number; markerX: number } {
  const style = paraListStyle(n, pi);
  const marker = style === "none" ? "" : listMarker(style, counter, listLevelOf(n, pi));
  const gutter = marker ? widthOf(`${marker} `) : 0;
  const hang = n.hangingLists !== false;
  return { marker, gutter, textLead: gutter && !hang ? gutter : 0, markerX: gutter ? -gutter : 0 };
}

/** Same font shorthand for painting, measuring text, and measuring list gutters. */
export function canvasTextFont(n: XNode, size = n.fontSize, run?: StyledSpan): string {
  return `${n.textCase === "small-caps" ? "small-caps " : ""}${n.fontStyle === "italic" ? "italic " : ""}${run?.fontWeight ?? n.fontWeight} ${Math.max(1, size)}px ${fontFamilyStack(run?.fontFamily || n.fontFamily)}`;
}

/**
 * How far the editor overlay indents its caret so it starts where the text
 * will be painted. Hanging lists put the marker outside the box, so the caret
 * needs no gutter; `hangingLists: false` clears the marker like any text does.
 */
export function listGutter(ctx: CanvasRenderingContext2D | null, n: XNode): number {
  if (!ctx || !n.listStyle || n.listStyle === "none") return 0;
  if (n.hangingLists !== false) return 0;
  ctx.font = canvasTextFont(n);
  return measureCached(ctx, `${listMarker(n.listStyle, 9)} `);
}

/**
 * Where a CSS line box puts its first baseline, from the top of the content box:
 * half the leading sits above the font's own box, then the box's ascent (CSS 2.1
 * §10.8.1). The editor overlay is a real textarea, so this - not the canvas
 * "top" baseline - is where its first row hangs from.
 */
export function cssFirstBaseline(ascent: number, descent: number, lineHeight: number): number {
  return (lineHeight - (ascent + descent)) / 2 + ascent;
}

/** The em size the font metrics are measured at - see `fontMetricRatios`. */
const METRIC_PROBE_SIZE = 1000;

/**
 * The font anchors the editor overlay needs, as ratios of the em.
 *
 * `ascent`/`descent` are the font box a CSS line box lays its leading around,
 * and `topOffset` is how far the canvas "top" baseline sits above the alphabetic
 * baseline: `measureText` reports the font's bounding box relative to whichever
 * baseline is set, so the distance between the two modes *is* the distance
 * between the two baselines. Measuring beats assuming - Blink's "top" is the em
 * box (sTypoAscent normalised to 1em: 0.80065em for Inter) while the line box
 * uses the hhea ascent (0.96875em for Inter), and engines differ.
 *
 * Measured at `METRIC_PROBE_SIZE`: TextMetrics rounds to whole pixels, and at
 * 1000px that rounding is a hundredth of a pixel once scaled to normal sizes.
 * Null where the platform reports no font metrics: the overlay then keeps its
 * placement instead of guessing an offset.
 */
export function fontMetricRatios(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  run?: StyledSpan,
): { ascent: number; descent: number; topOffset: number } | null {
  const priorFont = ctx.font;
  const priorBaseline = ctx.textBaseline;
  try {
    ctx.font = canvasTextFont(n, METRIC_PROBE_SIZE, run);
    ctx.textBaseline = "alphabetic";
    const alpha = ctx.measureText("H");
    const ascent = alpha.fontBoundingBoxAscent;
    const descent = alpha.fontBoundingBoxDescent;
    ctx.textBaseline = "top";
    const topAscent = ctx.measureText("H").fontBoundingBoxAscent;
    if (!Number.isFinite(ascent) || !Number.isFinite(descent) || !Number.isFinite(topAscent)) return null;
    return {
      ascent: ascent / METRIC_PROBE_SIZE,
      descent: descent / METRIC_PROBE_SIZE,
      topOffset: (ascent - topAscent) / METRIC_PROBE_SIZE,
    };
  } finally {
    ctx.font = priorFont;
    ctx.textBaseline = priorBaseline;
  }
}

/**
 * How far the editor overlay's first row sits below the top of its own box.
 * The painter draws the row `inset` pixels below the layer's top and hangs it
 * off the canvas "top" baseline; a textarea would hang it off the CSS line box.
 * The difference is the correction, so entering or leaving edit cannot move the
 * glyphs.
 */
export function overlayRowShift(
  ratios: { ascent: number; descent: number; topOffset: number },
  fontSize: number,
  lineHeight: number,
  inset = 0,
): number {
  const ascent = ratios.ascent * fontSize;
  const descent = ratios.descent * fontSize;
  return inset + ratios.topOffset * fontSize - cssFirstBaseline(ascent, descent, lineHeight);
}

/**
 * Where the painter puts the first row inside the box: a Fixed-size layer's
 * vertical alignment (a hug axis ignores it, like the renderer) plus the
 * vertical-trim shift. Shared with the editor overlay, so the row cannot move
 * when edit starts.
 */
export function firstRowInset(
  n: XNode,
  boxH: number,
  blockH: number,
  fontSize: number,
  z: number,
): number {
  const align = valignApplies(n) ? n.textAlignVertical : "top";
  const valign = align === "middle" ? (boxH - blockH) / 2 : align === "bottom" ? boxH - blockH : 0;
  const trim = n.verticalTrim ? Math.max(1, fontSize * 0.242 * z) : 0;
  return valign + trim;
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
  if (hasMixedTextSpans(n, text)) {
    const rows = styledTextRows(ctx, n, text, n.w);
    const limit = n.truncate && n.maxLines > 0 ? Math.max(1, n.maxLines) : Infinity;
    const taken = truncateStyledRows(ctx, n, rows, limit, n.sizingW === "hug" ? Infinity : n.w);
    const gaps = Math.max(0, taken.filter((r) => r.lastInPara).length - (taken.length ? 1 : 0));
    return { lines: taken.length, gaps, maxW: Math.max(8, ...taken.map((r) => r.lead + r.width)), extra: 0 };
  }
  const uniform = n.textRuns?.length ? resolvedTextSpans(n) : [];
  ctx.font = uniform.length === 1 ? canvasTextFont(n, uniform[0].fontSize, uniform[0]) : canvasTextFont(n);
  text = applyTextCase(text, n.textCase);
  const wrap = n.sizingW !== "hug";
  const ls = effectiveLetterSpacing(n);
  const widthOf = (line: string) =>
    measureCached(ctx, line) + (ls ? ls * Math.max(0, line.length - 1) : 0);
  const indent = indentOf(n);
  // Truncation cuts the taken rows at max lines, exactly like the painter;
  // the gaps counted are the paragraph breaks that survive the cut.
  const limit = n.truncate && n.maxLines > 0 ? Math.max(1, n.maxLines) : Infinity;
  const paras = (text || " ").split("\n");
  const counters = listCounters(n, paras.length);
  let lines = 0;
  let completeParas = 0;
  let partialTake = false;
  let maxW = 8;
  let cut = false;
  let itemGaps = 0;
  for (const [pi, para] of paras.entries()) {
    if (lines >= limit) {
      cut = true;
      break;
    }
    const ll = listLayout(n, pi, counters[pi], widthOf);
    const wrapStyle = paraWrapOf(n, pi);
    // Hanging lists put the marker outside the box: only the non-hanging
    // gutter eats into the wrap width.
    const avail = wrap ? n.w - ll.textLead - indent : 1e6;
    let wrapped = wrapLines(ctx, para || " ", avail > 0 ? avail : 1e6, ls);
    if (wrap && (wrapStyle === "balance" || wrapStyle === "pretty") && n.w > 0)
      wrapped = balanceLines(wrapped, avail, widthOf, wrapStyle);
    const take = Math.min(wrapped.length, Math.max(0, limit - lines));
    for (let i = 0; i < take; i++) {
      maxW = Math.max(maxW, ll.textLead + (i === 0 ? indent : 0) + widthOf(wrapped[i]));
    }
    if (take < wrapped.length) cut = true;
    if (take > 0 && take < wrapped.length) partialTake = true;
    if (take >= wrapped.length && take > 0) completeParas += 1;
    lines += Math.max(1, take);
  }
  // List spacing (360040449773): "the distance between each line item" - the
  // gap between two consecutive list items, on top of the paragraph gap
  // (items are paragraphs too).
  {
    const takenParas = Math.min(paras.length, Math.max(0, completeParas + (partialTake ? 1 : 0)));
    for (let pi = 0; pi + 1 < takenParas; pi++) {
      if (paraListStyle(n, pi) !== "none" && paraListStyle(n, pi + 1) !== "none") itemGaps += 1;
    }
  }
  // The painter hangs a gap on every taken paragraph's last row, then takes
  // one back: a cut mid-paragraph forces the flag on the cut row, which is
  // the partial take counted here.
  const gaps = Math.max(0, completeParas + (partialTake ? 1 : 0) - (lines > 0 ? 1 : 0));
  // An auto-width layer appends the ellipsis past the last line instead of
  // trimming to fit, so the box budgets for it when a cut happened.
  if (cut && !wrap) maxW += widthOf("\u2026");
  return { lines, gaps, maxW, extra: itemGaps * Math.max(0, n.listSpacing || 0) };
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
export function hugHeight(lines: number, gaps: number, lh: number, paraGap: number, extra = 0): number {
  return Math.max(
    Math.ceil(lh),
    Math.ceil(Math.max(1, lines) * lh + Math.max(0, gaps) * Math.max(0, paraGap) + Math.max(0, extra)),
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
  const lh = effectiveLineHeight(n, Math.max(n.fontSize, ...resolvedTextSpans(n).map((r) => r.fontSize)));
  const gap = n.paragraphSpacing || 0;
  const out: { w?: number; h?: number } = {};
  if (wantW) out.w = Math.max(8, Math.ceil(m.maxW + 4));
  if (wantH) out.h = hugHeight(m.lines, m.gaps, lh, gap, m.extra ?? 0);
  return out;
}

/** A single uniform run is still one Canvas fillText and one measureText. */
export function hasMixedTextSpans(n: XNode, text = n.text): boolean {
  return !!n.textRuns?.length && text === n.text && resolvedTextSpans(n).length > 1;
}
export type StyledPiece = { text: string; run: StyledSpan; width: number };
export type StyledRow = {
  pieces: StyledPiece[]; width: number; lead: number; marker: string;
  /** Offset of the marker from the paragraph's first-line lead (hanging lists
   *  put it outside the box: a negative offset). */
  markerX: number;
  /** Extra list spacing after this paragraph's last row (360040449773). */
  itemGap: boolean;
  /** Paragraph index - each row resolves its own bidi direction (4972283635863). */
  pi: number;
  lastInPara: boolean;
};
/** The same run-aware widths and line breaks feed hug sizing and Canvas paint.
 * Positions are UTF-16 offsets into the original copy, not transformed copy.
 * A piece's own case transformation happens AFTER range lookup. */
export function styledTextRows(ctx: CanvasRenderingContext2D, n: XNode, text: string, boxW: number, scale = 1): StyledRow[] {
  const spans = resolvedTextSpans(n);
  const ls = effectiveLetterSpacing(n, scale);
  const cased = applyTextCase(text, n.textCase);
  const width = (a: number, b: number): StyledPiece[] => spans.flatMap((run) => {
    const start = Math.max(a, run.start), end = Math.min(b, run.end);
    if (end <= start) return [];
    const part = cased.length === text.length ? cased.slice(start, end) : applyTextCase(text.slice(start, end), n.textCase);
    ctx.font = canvasTextFont(n, run.fontSize * scale, run);
    const glyphWidth = (ls || n.textAlign === "justified")
      ? Array.from(part).reduce((sum, ch) => sum + measureCached(ctx, ch), 0)
      : measureCached(ctx, part);
    return [{ text: part, run, width: glyphWidth + ls * Math.max(0, Array.from(part).length - 1) }];
  });
  const measure = (a: number, b: number) => {
    const pieces = width(a, b);
    return pieces.reduce((sum, p) => sum + p.width, 0) + ls * Math.max(0, b - a - pieces.length);
  };
  const result: StyledRow[] = [];
  const paraCount = text.split("\n").length;
  const counters = listCounters(n, paraCount);
  let paraStart = 0, pi = 0;
  while (paraStart <= text.length) {
    const nextBreak = text.indexOf("\n", paraStart);
    const paraEnd = nextBreak < 0 ? text.length : nextBreak;
    ctx.font = canvasTextFont(n, n.fontSize * scale);
    const ll = listLayout(n, pi, counters[pi], (s) => measureCached(ctx, s));
    const indent = indentOf(n) * scale;
    const avail = n.sizingW === "hug" ? Infinity : Math.max(1, boxW - ll.textLead - indent);
    const ranges: { start: number; end: number }[] = [];
    let start = paraStart, end = paraStart;
    const trim = (a: number, b: number) => b - (text.slice(a, b).match(/\s+$/)?.[0].length ?? 0);
    const emit = () => { ranges.push({ start, end: trim(start, end) }); start = end; };
    // Keep whitespace in the original offsets, including the trailing space
    // before a wrap, so later spans never drift out of alignment.
    const tokens = text.slice(paraStart, paraEnd).match(/\S+\s*|\s+/gu) ?? [];
    let pos = paraStart;
    for (const token of tokens) {
      let target = pos + token.length;
      if (start < end && measure(start, target) > avail) {
        emit();
        while (start < target && /\s/u.test(text[start])) start++;
        end = start;
      }
      // Split an over-wide word by code point, without splitting surrogates.
      while (start < target && measure(start, target) > avail && avail !== Infinity) {
        let split = start;
        for (const ch of text.slice(start, target)) {
          if (split > start && measure(start, split + ch.length) > avail) break;
          split += ch.length;
        }
        if (split === start) split += Array.from(text.slice(start, target))[0]?.length ?? 1;
        ranges.push({ start, end: split });
        start = split;
      }
      end = target;
      pos = target;
    }
    ranges.push({ start, end: trim(start, end) });
    ranges.forEach((r, i) => {
      const pieces = width(r.start, r.end);
      const measured = measure(r.start, r.end);
      result.push({ pieces, width: measured, lead: ll.textLead + (i === 0 ? indent : 0),
        marker: i === 0 && paraEnd > paraStart ? ll.marker : "", markerX: ll.markerX,
        itemGap: i === ranges.length - 1 && paraListStyle(n, pi) !== "none"
          && pi + 1 < paraCount && paraListStyle(n, pi + 1) !== "none",
        pi,
        lastInPara: i === ranges.length - 1 });
    });
    if (nextBreak < 0) break;
    paraStart = nextBreak + 1;
    pi++;
  }
  return result;
}

/** Apply the same ellipsis and measured run advances to Canvas and hug sizing. */
export function truncateStyledRows(
  ctx: CanvasRenderingContext2D, n: XNode, rows: StyledRow[], limit: number, boxW: number, scale = 1,
): StyledRow[] {
  if (rows.length <= limit) return rows;
  const taken = rows.slice(0, Math.max(1, limit));
  const last = taken[taken.length - 1];
  const run = last.pieces.at(-1)?.run ?? resolvedTextSpans(n).at(-1);
  if (!run) return taken;
  const ls = effectiveLetterSpacing(n, scale);
  const pieces = last.pieces.map((p) => ({ ...p }));
  const pieceWidth = (text: string, style: StyledSpan) => {
    ctx.font = canvasTextFont(n, style.fontSize * scale, style);
    const chars = Array.from(text);
    const glyphs = ls || n.textAlign === "justified"
      ? chars.reduce((sum, ch) => sum + measureCached(ctx, ch), 0)
      : measureCached(ctx, text);
    return glyphs + ls * Math.max(0, chars.length - 1);
  };
  const ellipsis: StyledPiece = { text: "…", run, width: pieceWidth("…", run) };
  const total = () => [...pieces, ellipsis].reduce((w, p) => w + p.width, 0) + ls * pieces.length;
  while (pieces.length && total() > boxW - last.lead) {
    const tail = pieces[pieces.length - 1];
    tail.text = Array.from(tail.text).slice(0, -1).join("");
    if (tail.text) tail.width = pieceWidth(tail.text, tail.run);
    else pieces.pop();
  }
  taken[taken.length - 1] = { ...last, pieces: [...pieces, ellipsis], width: total(), lastInPara: true };
  return taken;
}
