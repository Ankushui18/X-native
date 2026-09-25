/**
 * Unified search: fuzzy matching over the Quick Open index, plus the
 * recently-used store. Pure except for the localStorage persistence, which
 * degrades silently (private mode, headless tests).
 */

export type SearchKind = "command" | "layer" | "page" | "component" | "variable" | "flow";

export interface SearchEntry {
  kind: SearchKind;
  /** Layer/page/component/variable id, or the command label for commands. */
  id: string;
  label: string;
  detail?: string;
}

export interface RecentEntry {
  kind: SearchKind;
  id: string;
  label: string;
}

/**
 * Fuzzy subsequence score, or -1 when `query` is not a subsequence of
 * `target`. Higher is better: consecutive runs beat scattered letters,
 * word starts beat mid-word, and short targets beat long ones.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (q === t) return 1_000_000;
  let qi = 0;
  let score = 0;
  let run = 0;
  let lastHit = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      run = 0;
      continue;
    }
    const wordStart = ti === 0 || /[\s\-_./]/.test(t[ti - 1]);
    score += 10 + (wordStart ? 8 : 0) + (ti === 0 ? 6 : 0);
    if (ti === lastHit + 1) {
      run++;
      score += run * 6;
    } else {
      run = 0;
    }
    lastHit = ti;
    qi++;
  }
  if (qi < q.length) return -1;
  // Prefer the match that covers more of a shorter target.
  score += Math.round((q.length / t.length) * 20);
  if (t.startsWith(q)) score += 30;
  return score;
}

/** Rank entries against a query, best first. Empty query keeps input order. */
export function rankSearch<T extends SearchEntry>(entries: T[], query: string): (T & { score: number })[] {
  const q = query.trim();
  if (!q) return entries.map((e) => ({ ...e, score: 0 }));
  const out: (T & { score: number })[] = [];
  for (const e of entries) {
    const s = Math.max(fuzzyScore(q, e.label), e.detail ? fuzzyScore(q, `${e.label} ${e.detail}`) - 5 : -1);
    if (s >= 0) out.push({ ...e, score: s });
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out;
}

const RECENT_KEY = "x-native-recents";
const RECENT_CAP = 8;

export function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentEntry =>
        !!r && typeof r === "object" && typeof (r as RecentEntry).id === "string" && typeof (r as RecentEntry).label === "string",
    );
  } catch {
    return [];
  }
}

export function saveRecent(entry: RecentEntry): RecentEntry[] {
  const next = [entry, ...loadRecents().filter((r) => !(r.kind === entry.kind && r.id === entry.id))].slice(0, RECENT_CAP);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode: recents just don't persist */
  }
  return next;
}
