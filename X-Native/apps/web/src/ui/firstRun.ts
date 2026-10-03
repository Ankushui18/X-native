/**
 * First-run hints (LP-U4).
 *
 * One piece of persisted state: whether the visitor has dismissed the "draw your
 * first layer" card that sits over an empty canvas. It is its own module for two
 * reasons. The dismissal has to outlive the session, so it lives in localStorage
 * — and localStorage throws in private mode, is absent in SSR, and is absent in a
 * plain node test, so every access needs a guard; writing that guard once beats
 * writing it at the call site inside a 7,000-line canvas component. And the rule
 * is testable without a browser: hand these functions any `{getItem, setItem}`
 * and they behave, which is what `firstRun.test.mjs` does.
 *
 * The key is namespaced `x-native-*` on purpose: `e2e/behaviour.mjs`'s `page()`
 * wipes every `x-native` key except the theme before a check runs, so a browser
 * check always starts with the hint showing, the way a first-time visitor does.
 */

export const EMPTY_CANVAS_HINT_KEY = "x-native-hint-empty-canvas";

/** The slice of `localStorage` these functions use — enough to fake in a test. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's store, or null where there is none (node, SSR) or it throws. */
export function hintStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** True once the visitor has dismissed the empty-canvas card. */
export function emptyCanvasHintDismissed(store: KeyValueStore | null = hintStore()): boolean {
  try {
    return store?.getItem(EMPTY_CANVAS_HINT_KEY) === "1";
  } catch {
    // A store that refuses to be read has not been told "dismissed": showing the
    // hint again is the cheaper mistake than never showing it.
    return false;
  }
}

/** Record the dismissal. A store that refuses to keep it is not an error worth
 *  throwing over — the hint simply returns next session. */
export function dismissEmptyCanvasHint(store: KeyValueStore | null = hintStore()): void {
  try {
    store?.setItem(EMPTY_CANVAS_HINT_KEY, "1");
  } catch {
    /* ignore */
  }
}
