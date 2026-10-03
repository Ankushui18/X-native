import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_THEME_PREF,
  normalizeThemePref,
  resolveTheme,
  type Theme,
  type ThemePref,
} from "./themeModel";

/** Preferences → Theme: Light, Dark or System. */
export { THEME_OPTIONS, themeLabel } from "./themeModel";
export type { Theme, ThemePref } from "./themeModel";

const KEY = "x-native-theme";

const Ctx = createContext<{
  pref: ThemePref;
  theme: Theme;
  setPref: (p: ThemePref) => void;
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

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
}

apply(resolve(readPref()));

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

  const value = useMemo(() => ({ pref, theme, setPref: setPrefState }), [pref, theme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme");
  return ctx;
}
