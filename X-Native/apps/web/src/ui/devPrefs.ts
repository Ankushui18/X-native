/**
 * Dev Mode preferences: the code language and the units, shared by the inspect
 * panel, the right-click "Copy/paste as" menu and the ⌥⇧⌘C chord.
 *
 * Before this module, each of those had its own idea: the panel let you pick a
 * language and px/rem, while the menu copied hand-built CSS in pixels. A
 * developer who set the panel to SwiftUI + rem and then used the menu got a
 * different answer for the same layer — so the answer lives here instead, and
 * outlives a reload.
 */
export type DevFormat = "css" | "tailwind" | "swiftui" | "compose" | "flutter" | "svg" | "figma" | "tokens";
export type DevUnit = "px" | "rem";

/** Supported languages. */
export const DEV_LANGS: { id: DevFormat; label: string; lang: string }[] = [
  { id: "css", label: "CSS", lang: "css" },
  { id: "tailwind", label: "Tailwind", lang: "html" },
  { id: "swiftui", label: "SwiftUI", lang: "swift" },
  { id: "compose", label: "Compose", lang: "kotlin" },
  { id: "flutter", label: "Flutter", lang: "dart" },
  { id: "svg", label: "SVG", lang: "xml" },
  { id: "figma", label: "Layer JSON", lang: "json" },
  { id: "tokens", label: "Design Tokens", lang: "json" },
];

export const devLangLabel = (id: DevFormat): string => DEV_LANGS.find((l) => l.id === id)?.label ?? "CSS";

const KEY = "x-native-dev-prefs";

export interface DevPrefs {
  format: DevFormat;
  unit: DevUnit;
}

const IDS = DEV_LANGS.map((l) => l.id);

function read(): DevPrefs {
  let prefs: DevPrefs = { format: "css", unit: "px" };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DevPrefs>;
      if (parsed && typeof parsed === "object") {
        if (IDS.includes(parsed.format as DevFormat)) prefs.format = parsed.format as DevFormat;
        if (parsed.unit === "rem" || parsed.unit === "px") prefs.unit = parsed.unit;
      }
    }
  } catch {
    /* private mode or a corrupt write: the defaults are a fine answer */
  }
  return prefs;
}

let current: DevPrefs = read();
const listeners = new Set<() => void>();

/** Cached snapshot object — useSyncExternalStore re-renders on identity change. */
export function getDevPrefs(): DevPrefs {
  return current;
}

export function subscribeDevPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setDevPrefs(patch: Partial<DevPrefs>): void {
  const next = { ...current, ...patch };
  if (next.format === current.format && next.unit === current.unit) return;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* still applies for this session */
  }
  listeners.forEach((fn) => fn());
}
