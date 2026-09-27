/**
 * Say it out loud (PM-U8).
 *
 * The product reports almost everything through one channel: the toast. "Deleted
 * 5 layers · ⌘Z to undo", "Copied to clipboard", "Exported 3 assets". It was a
 * plain `<div className="toast">` — no role, no live region — so a screen reader
 * said nothing at all, and the app's only confirmation for a destructive action
 * was silent. The audit's own instrument agreed: across the whole product there
 * was exactly one ARIA live region, the dialog's `role="alert"` for a validation
 * error. Everything else the app says, it said visually only.
 *
 * This module is the announcement half of the toast, and the product's only
 * source of live regions:
 *
 *  - `LiveStatus` is the polite status region. It is *always mounted* — a live
 *    region that appears with its text already inside it is widely not announced,
 *    which is the one implementation detail that decides whether this works — and
 *    visually hidden, because the pill is the visual half.
 *  - `ToastPill` is that pill, unchanged: same class, same 1800ms, and
 *    deliberately **not** a live region. Two live regions carrying the same
 *    string is how a user hears everything twice.
 *  - `LiveLog` is the transcript role for a stream of messages that arrive on
 *    their own (the agent's answers). Same rule about being mounted up front:
 *    it wraps a list that exists from the first render, not one that is created
 *    when the first answer lands.
 *  - `useToastMessage` is the bus → string half both screens used to hand-roll
 *    (subscribe, remember the message, clear it after 1800ms). One owner, so the
 *    editor and the dashboard cannot drift on the duration.
 *
 * Politeness is deliberately `polite` in both places: a confirmation should wait
 * for the user to finish, and a chat answer should never interrupt. The single
 * `assertive` region in the product stays the dialog's validation error
 * (`role="alert"`), which is the one message that must not queue.
 */
import { useEffect, useState, type ReactNode } from "react";
import { subscribeToast } from "./toast";

/** How long a toast stays on screen. Was written out at both call sites. */
export const TOAST_MS = 1800;

/** The message the toast bus is currently showing, cleared after `TOAST_MS`. */
export function useToastMessage(): string {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let timer = 0;
    const off = subscribeToast((m) => {
      setMsg(m);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMsg(""), TOAST_MS);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);
  return msg;
}

/** The visible pill. Renders nothing when there is nothing to say, so the toast
 *  only occupies space while it is up (it is `position: fixed` centred, and an
 *  empty one would still paint its background and border). */
export function ToastPill({ text }: { text: string }) {
  return text ? <div className="toast">{text}</div> : null;
}

/** The announcement, for assistive tech. Always mounted: a live region created
 *  together with its content is not reliably announced — the element has to
 *  exist, empty, before the text arrives. `.sr-only` keeps it out of the layout
 *  (it is not `display: none`, which would remove it from the accessibility tree
 *  and silence it again). */
export function LiveStatus({ text }: { text: string }) {
  return (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </span>
  );
}

/** A stream of messages that arrives on its own — the agent's transcript. `log`
 *  is the role for exactly this (a chat or activity feed): additions are
 *  announced, and the region accumulates rather than replacing. */
export function LiveLog({
  label,
  className = "tree",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} role="log" aria-live="polite" aria-label={label}>
      {children}
    </div>
  );
}
