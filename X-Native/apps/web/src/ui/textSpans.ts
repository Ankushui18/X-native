import type { Engine, TextRun, XNode } from "../engine/types";

/** Offsets are UTF-16 offsets, like HTMLTextAreaElement.selectionStart/End.
 * Runs written here partition [0, text.length); imported sparse runs are
 * resolved against the layer defaults. Adjacent identical runs are coalesced. */
const keys = ["fontFamily", "fontWeight", "fontSize", "fill", "textDecoration"] as const;
export type SpanStyle = Pick<XNode, (typeof keys)[number]>;
export type StyledSpan = TextRun & SpanStyle;
export type TextRange = { id: string; start: number; end: number };

const selections = new WeakMap<Engine, TextRange>();
export function rememberTextRange(engine: Engine, range: TextRange | null) {
  if (range && range.end > range.start) selections.set(engine, range);
  else selections.delete(engine);
}
export function selectedTextRange(engine: Engine, n: XNode, selected: readonly string[]): TextRange | null {
  const range = selections.get(engine);
  return range && selected.length === 1 && selected[0] === n.id && n.kind === "text" &&
    range.start >= 0 && range.end <= n.text.length ? range : null;
}
const styleOf = (n: XNode, run?: TextRun): SpanStyle => ({
  fontFamily: run?.fontFamily ?? n.fontFamily,
  fontWeight: run?.fontWeight ?? n.fontWeight,
  fontSize: run?.fontSize ?? n.fontSize,
  fill: run?.fill ?? n.fill,
  textDecoration: run?.textDecoration ?? n.textDecoration,
});
const sameStyle = (a: StyledSpan, b: StyledSpan) => keys.every((key) => a[key] === b[key]);
function merge(parts: StyledSpan[]): StyledSpan[] {
  const out: StyledSpan[] = [];
  for (const part of parts) {
    if (part.end <= part.start) continue;
    const prev = out[out.length - 1];
    if (prev && prev.end === part.start && sameStyle(prev, part)) prev.end = part.end;
    else out.push({ ...part });
  }
  return out;
}
export function resolvedTextSpans(n: XNode): StyledSpan[] {
  if (!n.text?.length) return [];
  const boundaries = new Set([0, n.text.length]);
  for (const r of n.textRuns ?? []) {
    boundaries.add(Math.max(0, Math.min(n.text.length, r.start)));
    boundaries.add(Math.max(0, Math.min(n.text.length, r.end)));
  }
  const cuts = [...boundaries].sort((a, b) => a - b);
  return merge(cuts.slice(0, -1).map((start, i) => {
    const end = cuts[i + 1];
    // Later overlapping imported runs win. New edits always write disjoint runs.
    const run = [...(n.textRuns ?? [])].reverse().find((r) => r.start <= start && r.end >= end);
    return { start, end, ...styleOf(n, run) };
  }));
}
export function styleTextRange(n: XNode, start: number, end: number, over: Partial<SpanStyle>): TextRun[] {
  start = Math.max(0, Math.min(n.text.length, start));
  end = Math.max(start, Math.min(n.text.length, end));
  if (end === start) return n.textRuns ?? [];
  const parts: StyledSpan[] = [];
  for (const r of resolvedTextSpans(n)) {
    if (r.start < start && r.end > start) parts.push({ ...r, end: start });
    const a = Math.max(r.start, start), b = Math.min(r.end, end);
    if (a < b) parts.push({ ...r, start: a, end: b, ...over });
    if (r.start >= start && r.end <= end) continue;
    if (r.start < end && r.end > end) parts.push({ ...r, start: end });
    else if (r.end <= start || r.start >= end) parts.push(r);
  }
  return merge(parts);
}

/** Retain styling of the unchanged prefix/suffix when a textarea edit commits.
 * Inserted characters inherit the nearest preceding style (or the next style
 * at offset zero). Replacement inherits the style at the start of the edit. */
export function spansAfterTextEdit(n: XNode, next: string): TextRun[] | undefined {
  if (!n.textRuns?.length || next === n.text) return n.textRuns;
  let prefix = 0;
  while (prefix < n.text.length && prefix < next.length && n.text[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n.text.length - prefix && suffix < next.length - prefix &&
    n.text[n.text.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const oldEnd = n.text.length - suffix, newEnd = next.length - suffix;
  const spans = resolvedTextSpans(n);
  const insertedStyle = spans.find((r) => r.start < prefix && r.end >= prefix) ??
    spans.find((r) => r.start <= prefix && r.end > prefix) ?? spans.at(-1);
  const parts: StyledSpan[] = [];
  for (const r of spans) {
    if (r.start < prefix) parts.push({ ...r, end: Math.min(r.end, prefix) });
  }
  if (newEnd > prefix && insertedStyle)
    parts.push({ ...insertedStyle, start: prefix, end: newEnd });
  for (const r of spans) {
    if (r.end > oldEnd) parts.push({ ...r, start: Math.max(r.start, oldEnd) + newEnd - oldEnd, end: r.end + newEnd - oldEnd });
  }
  return merge(parts);
}
