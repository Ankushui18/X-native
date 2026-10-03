/**
 * Preferences ▸ "Use smart quotes/symbols" (360039957174 §Add smart symbols):
 * "Enable this setting … to quickly convert characters to special symbols."
 * App-level like the nudge amounts, kept in localStorage.
 */
const KEY = "x-native-smart-symbols";

let current = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

const listeners = new Set<() => void>();

export function smartSymbolsEnabled(): boolean {
  return current;
}

export function subscribeSmartSymbols(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSmartSymbols(on: boolean): boolean {
  current = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* the preference still applies for this session */
  }
  for (const fn of listeners) fn();
  return current;
}
