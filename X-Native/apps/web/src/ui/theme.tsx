import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  applyCanvasChromePref,
  DEFAULT_CANVAS_CHROME_PREF,
  DEFAULT_THEME_PREF,
  normalizeCanvasChromePref,
  normalizeThemePref,
  resolveTheme,
  type CanvasChromePref,
  type Theme,
  type ThemePref,
} from "./themeModel";

/** Preferences → Theme: Light, Dark or System, plus the canvas-chrome family. */
export { CANVAS_CHROME_OPTIONS, THEME_OPTIONS, canvasChromeLabel, themeLabel } from "./themeModel";
export type { CanvasChromePref, Theme, ThemePref } from "./themeModel";

const KEY = "x-native-theme";
/** Kept apart from the colour scheme on purpose: the two are independent choices,
 *  and the canvas-chrome one only ever moves the canvas overlays. */
const CHROME_KEY = "x-native-canvas-chrome";

const Ctx = createContext<{
  pref: ThemePref;
  theme: Theme;
  setPref: (p: ThemePref) => void;
  chromePref: CanvasChromePref;
  setChromePref: (p: CanvasChromePref) => void;
} | null>(null);

function readPref(): ThemePref {
  try {
    return normalizeThemePref(localStorage.getItem(KEY));
  } catch {
    /* private mode: the default is a fine answer */
    return DEFAULT_THEME_PREF;
  }
}

function resolve(pref: ThemePref): Theme {
  return resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** A stored canvas-chrome preference, or the default when there is nothing. */
function readChromePref(): CanvasChromePref {
  try {
    return normalizeCanvasChromePref(localStorage.getItem(CHROME_KEY));
  } catch {
    /* private mode: the app's own palette is a fine answer */
    return DEFAULT_CANVAS_CHROME_PREF;
  }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
}

apply(resolve(readPref()));
applyCanvasChromePref(readChromePref(), document.documentElement);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [theme, setTheme] = useState<Theme>(() => resolve(readPref()));

  useEffect(() => {
    const t = resolve(pref);
    setTheme(t);
    apply(t);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      const next = resolve("system");
      setTheme(next);
      apply(next);
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);

  const [chromePref, setChromePrefState] = useState<CanvasChromePref>(readChromePref);

  // The attribute is written *here*, before the state update, and not from an
  // effect: the paint that has to show the change reads the DOM cascade, so the
  // write must already be there when it runs. From a `useEffect` on this provider
  // the order between the two effects is React's to choose, and in the browser the
  // canvas won — the preference persisted, the sheet said blue, and the ring stayed
  // emerald until something else repainted. `figmaChromeTheme.dom.test.mjs` caught
  // it in pixels. The colour-scheme flip above is immune for a different reason:
  // `theme` is state set in the same effect, so children re-render a second time
  // after the write.
  const setChromePref = useCallback((next: CanvasChromePref) => {
    applyCanvasChromePref(next, document.documentElement);
    setChromePrefState(next);
    try {
      localStorage.setItem(CHROME_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  // `theme` is in this dependency list because the canvas repaints on it; the
  // chrome preference has to change the context identity for the same reason, or
  // a switch would sit unpainted until something else moved the view.
  const value = useMemo(
    () => ({ pref, theme, setPref: setPrefState, chromePref, setChromePref }),
    [pref, theme, chromePref],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme");
  return ctx;
}
