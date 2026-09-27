/**
 * One Escape owner, one place that hands the caret back, one trap — and (PM-U9)
 * one place that knows whether the keyboard belongs to a modal.
 *
 * That last part is the round-13 finding. Tab was the modal's (round 11) and
 * Escape was the modal's (round 9); everything else reached straight through the
 * veil. With the export sheet open and focus on one of its own buttons — which
 * is where Tab lands — `Delete` **removed the selected layer behind the sheet**,
 * the tool letters switched tools behind it, `⌘A` selected the whole page behind
 * it, and `⌘Z` then undid the deletion the user never asked for. Typing in a
 * modal's *field* was already safe (the chord surface's typing guard covers
 * `input`/`textarea`), so the exposure was exactly the modal's buttons.
 *
 * So the registry records whether an entry is *modal* (a sheet that veils the
 * editor and holds Tab) or not (a popover, menu, flyout or the radial menu — the
 * user is still working with the canvas, and Delete with a context menu open
 * should still delete). `modalOpen()` is what the three global key surfaces ask
 * before they do anything.
 *
 * The original finding, for context:
 *
 * Escape used to be answered by whoever happened to be listening, in whichever
 * phase they happened to register:
 *
 *  - the App kept its own five-overlay cascade (`findOpen → nudgeOpen →
 *    exportOpen → actions → figInspector`) behind an `onEscapeOverlay` prop;
 *  - the dialog bus attached a *capture* listener when a dialog mounted;
 *  - XDialog, XPopover, the context menu, the fill picker, the radial menu, the
 *    shortcuts sheet and two inspector menus each attached their own *bubble*
 *    listener;
 *  - and the canvas cascade in `bindHotkeys` deferred to any of them through a
 *    counter (`popoverGuard`), which protected the selection but closed nothing.
 *
 * Two consequences, both wrong. **Order followed registration, not the screen**:
 * the central capture handler is bound at app mount, so with a dialog on top of
 * the export sheet one Escape closed the *sheet behind* the dialog and left the
 * dialog up; with Find open and the shortcuts sheet opened on top of it, one
 * Escape closed Find — the sheet's own bubble listener was starved by the
 * `stopImmediatePropagation` that the central handler used to consume the press.
 * And **one press could close two things**: the presentation's Escape was
 * implemented twice, once in the central cascade and once in the player, so a
 * single Escape walked back two frames.
 *
 * So: every overlay registers while it is open and unregisters when it closes,
 * the stack's top is the overlay opened most recently, and one press closes
 * exactly that one. `bindHotkeys` is the only caller of `closeTopEscape`; it
 * asks before anything else answers, and consumes the keypress when the stack
 * had something, so no second listener gets a turn. Surfaces that are *modes*
 * rather than overlays — cropping, placing an image, editing a path's points,
 * presenting — keep their own documented place in the canvas cascade, which now
 * runs only when the overlay stack is empty.
 *
 * The second half of the same finding is the caret. An overlay that closes
 * unmounts the field it had focused, so focus fell to `<body>`: the next Tab
 * started again from the top of the document, and a keyboard user who opened the
 * export sheet from the palette was dropped outside the editor they were in. The
 * registry therefore remembers what had focus *before* the overlay took it and
 * gives it back when the overlay goes away — see `homeFor` for why the capture
 * happens at render time rather than when the effect runs.
 */
import { useEffect, useRef } from "react";

type Entry = { id: string; close: () => void; home: HTMLElement | null; modal: boolean };

const stack: Entry[] = [];

/* ── the focus trail ─────────────────────────────────────────────────────── */

/** The last element that took focus, ignoring `<body>` and the document root:
 *  clicking empty canvas chrome "focuses" the page, and remembering that would
 *  overwrite the control the user actually came from. */
let lastFocus: HTMLElement | null = null;
let listening = false;

function doc(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function watchFocus(): void {
  const d = doc();
  if (!d || listening) return;
  listening = true;
  d.addEventListener(
    "focusin",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (!t || t === d.body || t === d.documentElement) return;
      lastFocus = t;
    },
    true,
  );
}
// The app imports this module at boot, long before the first overlay opens, so
// the trigger button's focusin is already being recorded by the time one does.
// (A test that installs a DOM *after* importing this file gets the lazily
// installed listener instead — see `homeFor`.)
watchFocus();

/* ── the stack ───────────────────────────────────────────────────────────── */

/** Register an open overlay. Returns the release function; call it on close.
 *  Releasing twice is harmless, and releasing an entry a press already popped
 *  is a no-op — which is what makes `close()`-then-unmount safe. */
export function pushEscape(
  id: string,
  close: () => void,
  home?: HTMLElement | null,
  modal = false,
): () => void {
  watchFocus();
  const entry: Entry = { id, close, home: home === undefined ? null : home, modal };
  stack.push(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = stack.indexOf(entry);
    if (at >= 0) stack.splice(at, 1);
    giveBackFocus(entry);
  };
}

/** Close the topmost overlay, and only it. False means nothing was open, which
 *  is the caller's cue to let the canvas cascade answer instead. */
export function closeTopEscape(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top.close();
  return true;
}

/** The open overlays, bottom of the stack first. What Escape would close, in
 *  order, one press at a time — readable in a test and in a debugger. */
export function escapeStack(): string[] {
  return stack.map((e) => e.id);
}

/** Is a *modal* overlay open? The editor's global chords stand down while one
 *  is: the modal's own controls (which the trap keeps focus inside) and Escape
 *  are the keyboard. A non-modal overlay does not answer yes — a popover or menu
 *  does not veil the editor, and the canvas keys should keep working under it. */
export function modalOpen(): boolean {
  return stack.some((e) => e.modal);
}

/** The modal ids that are open, bottom first. The same question as `modalOpen`
 *  with the answer spelled out, for tests and for the debugger. */
export function openModals(): string[] {
  return stack.filter((e) => e.modal).map((e) => e.id);
}

/** Empty the stack. Tests mount and unmount surfaces out of order, and a leaked
 *  entry would answer a press in the next case; nothing in the app calls this. */
export function clearEscapes(): void {
  stack.length = 0;
  lastFocus = null;
}

/* ── handing the caret back ──────────────────────────────────────────────── */

/** What had focus before this overlay took it.
 *
 *  Read during *render*, which is the last moment it is still knowable: by the
 *  time an effect runs the overlay has already mounted, and an overlay that
 *  autofocuses its own field (`autoFocus`, which React applies during commit,
 *  before passive effects) has replaced the invoker with itself. Reading a
 *  module-level variable is not a render-phase side effect the way writing one
 *  would be, and the same value lands in the same ref if React renders twice. */
function homeFor(): HTMLElement | null {
  watchFocus();
  const d = doc();
  if (!d) return null;
  // `lastFocus` is the invoker when the overlay was opened from a control; when
  // it was opened by a chord (⇧⌘E from the canvas, say) it is whatever had focus
  // before, which is usually nothing — that is the fallback's job below.
  return lastFocus;
}

/** Where focus goes when the invoker is gone: the palette row that opened the
 *  export sheet is unmounted by the time the sheet closes, and the honest answer
 *  then is the editor's own surface rather than `<body>`. */
function fallbackHome(): HTMLElement | null {
  const d = doc();
  const el = d?.querySelector<HTMLElement>("[data-focus-home]");
  return el ?? null;
}

function usable(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (el === doc()?.body || el === doc()?.documentElement) return false;
  // A disabled control cannot take focus, and `focus()` on one is a silent
  // no-op — better to fall through to the app's home than to leave the caret
  // where the overlay put it.
  return !(el as HTMLButtonElement).disabled;
}

/** Hand the caret back to whatever opened the overlay, and leave it alone when
 *  there is nothing to hand it to. This runs on every close path — Escape, the
 *  sheet's own close button, a click outside — because all of them unmount the
 *  element that had focus. It does not try to tell an outside click apart from
 *  Escape: a dialog returns focus to its invoker either way, and a click on
 *  another control still wins, because the browser applies its own focus as the
 *  default action of `mousedown`, after the handler that closed the overlay has
 *  finished (the click that *chose* a menu item hands the caret back to the menu's
 *  trigger, which is where the keyboard user expects to be). */
function giveBackFocus(entry: Entry): void {
  const target = usable(entry.home) ? entry.home : fallbackHome();
  if (!usable(target)) return;
  if (target === doc()?.activeElement) return; // it never lost focus; leave it be
  target.focus({ preventScroll: true });
}

/** Register for as long as `id` is non-null, i.e. for as long as the surface is
 *  open. `close` is read through a ref, so a component can pass a fresh closure
 *  every render without re-registering (and without losing its place in the
 *  stack, which is what "opened most recently" means). */
export function useEscape(id: string | null, close: () => void, modal = false): void {
  const ref = useRef(close);
  ref.current = close;
  const home = useRef<HTMLElement | null>(null);
  const prev = useRef<string | null>(null);
  if (id !== prev.current) {
    prev.current = id;
    home.current = id ? homeFor() : null;
  }
  useEffect(() => {
    if (!id) return undefined;
    return pushEscape(id, () => ref.current(), home.current, modal);
  }, [id, modal]);
}

/* ── the veil is a wall (PM-U7) ──────────────────────────────────────────── */

/** Everything a `Tab` press can reach inside `root`, in document order: the
 *  browser's own focusable set minus what it skips — disabled controls,
 *  `tabindex="-1"` anchors, anything under `[hidden]`, and `aria-hidden` nodes
 *  (the reveal/eye buttons the panels keep off. jsdom has no layout, so
 *  `offsetParent` and computed `display` are not usable here; this is the
 *  subset of the rule that both the browser and the headless DOM agree on. */
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.closest("[hidden]")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex != null && Number(tabindex) < 0) return false;
    return true;
  });
}

/** Hold the keyboard inside a modal for as long as it is open.
 *
 *  `aria-modal="true"` tells assistive tech the rest of the document is inert,
 *  but nothing held the *keyboard* there: `Tab` from the last control in the
 *  export sheet walked out from under the veil and into the toolbar behind it,
 *  and a keyboard user who then pressed Enter was operating chrome they could
 *  not see. The trap closes the ring — `Tab` at the end goes back to the first
 *  control, `Shift+Tab` at the first goes to the last — and takes the caret on
 *  open when it is still outside, which is how a modal that does not autofocus a
 *  field (the nudge dialog, a queued question) becomes reachable at all.
 *
 *  Deliberately modal-only: a popover, menu or flyout is not modal, and Tab
 *  leaving it is how a keyboard user gets out of one. */
export function useFocusTrap(open: boolean, root: { current: HTMLElement | null }): void {
  useEffect(() => {
    if (!open) return undefined;
    const d = doc();
    const el = root.current;
    if (!d || !el) return undefined;

    const active = d.activeElement as HTMLElement | null;
    if (!active || !el.contains(active)) {
      // The first *field* if there is one — the thing worth doing — otherwise the
      // first control, otherwise the dialog itself (which its owner gives a
      // `tabIndex` when it has nothing else to hand the caret to).
      const items = focusablesIn(el);
      const field = items.find((x) => /^(INPUT|SELECT|TEXTAREA)$/.test(x.tagName));
      const target = field ?? items[0] ?? (el.tabIndex >= 0 ? el : null);
      target?.focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusablesIn(el);
      if (!items.length) {
        // Nothing to move to: the ring is a point, so hold the press rather than
        // let it fall through to the document behind the veil.
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const here = d.activeElement as HTMLElement | null;
      const ix = here ? items.indexOf(here) : -1;
      const next = ix < 0 ? (e.shiftKey ? last : first) : e.shiftKey ? items[ix - 1] ?? last : items[ix + 1] ?? first;
      if (next === here) return;
      e.preventDefault();
      e.stopPropagation();
      next.focus({ preventScroll: true });
    };
    d.addEventListener("keydown", onKey, true);
    return () => d.removeEventListener("keydown", onKey, true);
  }, [open, root]);
}
