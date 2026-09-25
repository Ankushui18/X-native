/**
 * Preferences → "Nudge amount…": the two distances the arrow keys move
 * a layer by. Small nudge is 1 and big nudge is 10 out of the box, both in
 * resolution-independent points - the same unit this app's design pixels are -
 * and both are settable, which is the whole feature: nudging by a spacing token
 * (8, 12, 16) is the common case, and being stuck at 1/10 means holding the
 * arrow key down and counting.
 *
 * App-wide, not per file, and it outlives a reload, which is where preferences keep
 * it too: it is a preference about your hands, not about the document.
 */

export interface NudgePrefs {
  small: number;
  big: number;
}

export const DEFAULT_NUDGE: NudgePrefs = { small: 1, big: 10 };

/** Safe bounds. A nudge of 0 would make the arrow keys do nothing, and
 *  past 10000 a single press throws the layer off any page. */
export const NUDGE_MIN = 0.01;
export const NUDGE_MAX = 10000;

/**
 * One field, as typed. Returns null for anything that is not a usable number,
 * so the caller can keep what it had rather than writing NaN into a preference.
 * A comma is accepted as the decimal separator: half of Europe types `0,5`.
 */
export function parseNudge(raw: string): number | null {
  const s = String(raw ?? "").trim().replace(",", ".");
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return clampNudge(Math.abs(n));
}

export function clampNudge(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_NUDGE.small;
  return Math.min(NUDGE_MAX, Math.max(NUDGE_MIN, n));
}

/**
 * Whatever is in storage, reduced to something usable. An older or hand-edited
 * value that is missing, empty or nonsense falls back per field, so a corrupt
 * `small` does not take `big` down with it.
 */
export function normalizeNudge(raw: unknown): NudgePrefs {
  const src = (raw ?? {}) as Partial<Record<keyof NudgePrefs, unknown>>;
  const one = (v: unknown, fallback: number): number => {
    const n = typeof v === "number" ? v : parseNudge(String(v ?? ""));
    return n == null ? fallback : clampNudge(n);
  };
  return { small: one(src.small, DEFAULT_NUDGE.small), big: one(src.big, DEFAULT_NUDGE.big) };
}

/** The step one arrow-key press moves a layer by. */
export function nudgeStep(prefs: NudgePrefs, big: boolean): number {
  return big ? prefs.big : prefs.small;
}

const KEY = "x-native-nudge";

function read(): NudgePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") return normalizeNudge(parsed);
      // A bare number is what an older build might have written, and it is
      // also what somebody hand-editing devtools would try.
      const only = parseNudge(raw);
      if (only != null) return { ...DEFAULT_NUDGE, small: only };
    }
  } catch {
    /* private mode, or a corrupt write: the defaults are a fine answer */
  }
  return { ...DEFAULT_NUDGE };
}

let current: NudgePrefs = read();
const listeners = new Set<() => void>();

/** Cached object - useSyncExternalStore re-renders on identity change. */
export function getNudgePrefs(): NudgePrefs {
  return current;
}

export function subscribeNudge(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setNudgePrefs(patch: Partial<NudgePrefs>): NudgePrefs {
  current = normalizeNudge({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* the preference still applies for this session */
  }
  listeners.forEach((f) => f());
  return current;
}

export function resetNudgePrefs(): NudgePrefs {
  return setNudgePrefs(DEFAULT_NUDGE);
}
