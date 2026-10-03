/**
 * Accessibility primitives: reduced-motion detection and dialog focus
 * restoration. Canvas/animation call sites gate gratuitous motion on
 * `prefersReducedMotion()`; dialogs restore focus to their opener.
 */
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}

/** Reactive reduced-motion flag for components with animated chrome. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Capture the focused element on mount and restore it on unmount, for
 * dialogs and palettes. Returns nothing; the restore runs in cleanup.
 */
export function useRestoreFocus(): void {
  useEffect(() => {
    const prev = document.activeElement;
    return () => {
      if (prev instanceof HTMLElement && document.contains(prev)) prev.focus();
    };
  }, []);
}
