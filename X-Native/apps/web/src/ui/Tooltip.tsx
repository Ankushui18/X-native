import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Figma-style tooltip: a dark pill that appears after a short delay and always
 * shows the keyboard shortcut alongside the label. The native `title` attribute
 * can't do this — it waits ~1.5s, can't be styled, and drops the shortcut — so
 * every control that has a shortcut should use this instead.
 *
 * Once one tooltip has been shown the delay is skipped for a moment, matching
 * Figma's behaviour of tracking along a toolbar without re-waiting each time.
 */

const DELAY = 380;
const CHAIN_MS = 500;
let lastShown = 0;

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

  const show = () => {
    cancel();
    const wait = Date.now() - lastShown < CHAIN_MS ? 0 : DELAY;
    timer.current = window.setTimeout(() => {
      setPos(null);
      setOpen(true);
    }, wait);
  };
  const hide = () => {
    cancel();
    if (open) lastShown = Date.now();
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
        onPointerEnter={show}
        onPointerLeave={hide}
        onPointerDown={hide}
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
