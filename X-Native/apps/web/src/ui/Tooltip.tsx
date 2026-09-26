import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Floating tooltip: a dark pill that appears after a short delay and always
 * shows the keyboard shortcut alongside the label. The native `title` attribute
 * can't do this — it waits ~1.5s, can't be styled, and drops the shortcut — so
 * every control that has a shortcut should use this instead.
 *
 * Once one tooltip has been shown the delay is skipped for a moment, matching
 * the standard behaviour of tracking along a toolbar without re-waiting each time.
 */

const DELAY = 380;
const CHAIN_MS = 500;
let lastShown = 0;

/** How long a tooltip waits before appearing. Skipped (0) right after another
 *  tooltip was shown, so tracking along a toolbar does not re-wait each time.
 *  Shared with the `title` bridge so both paths keep one rhythm. */
export function showDelay(immediate = false): number {
  return immediate || Date.now() - lastShown < CHAIN_MS ? 0 : DELAY;
}

/** Called when a tooltip closes so the next one along the same row is instant. */
export function markShown(): void {
  lastShown = Date.now();
}

/** Split a control's label into the text and the shortcut chip the pill shows
 *  beside it: "Delete connection (⌫)" → "Delete connection" + "⌫". Only a
 *  trailing parenthesised *key token* splits; bracketed prose stays part of the
 *  label ("Clean up vector (sketch to perfect Bézier)"). */
export function splitShortcutLabel(text: string): { label: string; shortcut?: string } {
  const trimmed = text.trim();
  const m = /^(.*?)\s*\(([^()]{1,18})\)$/.exec(trimmed);
  if (!m || !m[1]) return { label: trimmed };
  const key = m[2].trim();
  const isKey =
    /[⌘⇧⌥⌃⌫↵⇥⎋]/.test(key) || /^[A-Za-z0-9]{1,3}(\s*[/+]\s*[A-Za-z0-9]{1,3})*$/.test(key);
  return isKey ? { label: m[1].trim(), shortcut: key } : { label: trimmed };
}

export function Tooltip({
  label,
  shortcut,
  placement = "top",
  children,
}: {
  label: string;
  shortcut?: string;
  placement?: "top" | "bottom" | "left";
  children: ReactNode;
}) {
  const host = useRef<HTMLSpanElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => () => cancel(), []);

  const show = (immediate = false) => {
    cancel();
    timer.current = window.setTimeout(() => {
      setPos(null);
      setOpen(true);
    }, showDelay(immediate));
  };
  const hide = () => {
    cancel();
    if (open) markShown();
    setOpen(false);
  };

  // Position after render so the real tooltip size is known, and clamp to the
  // viewport so a tooltip near an edge stays fully readable.
  useLayoutEffect(() => {
    if (!open || !host.current || !tip.current) return;
    // `display: contents` keeps the wrapper out of layout (so it can't disturb
    // flex/grid parents), but that also makes its own rect collapse to zero.
    // Measure the real child element instead.
    const anchor = (host.current.firstElementChild as HTMLElement) ?? host.current;
    const a = anchor.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    let left = a.left + a.width / 2 - t.width / 2;
    let top = placement === "bottom" ? a.bottom + 8 : a.top - t.height - 8;
    if (placement === "left") {
      left = a.left - t.width - 8;
      top = a.top + a.height / 2 - t.height / 2;
    }
    left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - t.height - 6));
    setPos({ left, top });
  }, [open, placement, label, shortcut]);

  return (
    <>
      <span
        ref={host}
        className="tip-host"
        onPointerEnter={() => show()}
        onPointerLeave={hide}
        onPointerDown={hide}
        // Keyboard users get the same label as pointer users (TY-U6): focus
        // shows it at once, and only for keyboard focus, so clicking a button
        // does not leave a tooltip hanging over the thing just pressed.
        onFocus={(e) => {
          if ((e.target as HTMLElement).matches?.(":focus-visible")) show(true);
        }}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tip}
            className="tip"
            role="tooltip"
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {label}
            {shortcut && <span className="tip-sc">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
