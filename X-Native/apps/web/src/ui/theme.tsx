import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** Figma Preferences → Theme, plus Graphite/Daylight from crates/x-ui. */
export type ThemePref = "light" | "dark" | "graphite" | "daylight" | "system";
export type Theme = "light" | "dark" | "graphite" | "daylight";

const KEY = "x-native-theme";

const Ctx = createContext<{
  pref: ThemePref;
  theme: Theme;
  setPref: (p: ThemePref) => void;
} | null>(null);

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "graphite" || v === "daylight" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "light";
}

function resolve(pref: ThemePref): Theme {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" || theme === "graphite" ? "dark" : "light";
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
