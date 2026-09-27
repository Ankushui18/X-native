/**
 * One Escape owner (PM-U3).
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
 */
import { useEffect, useRef } from "react";

type Entry = { id: string; close: () => void };

const stack: Entry[] = [];

/** Register an open overlay. Returns the release function; call it on close.
 *  Releasing twice is harmless, and releasing an entry a press already popped
 *  is a no-op — which is what makes `close()`-then-unmount safe. */
export function pushEscape(id: string, close: () => void): () => void {
  const entry: Entry = { id, close };
  stack.push(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = stack.indexOf(entry);
    if (at >= 0) stack.splice(at, 1);
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

/** Empty the stack. Tests mount and unmount surfaces out of order, and a leaked
 *  entry would answer a press in the next case; nothing in the app calls this. */
export function clearEscapes(): void {
  stack.length = 0;
}

/** Register for as long as `id` is non-null, i.e. for as long as the surface is
 *  open. `close` is read through a ref, so a component can pass a fresh closure
 *  every render without re-registering (and without losing its place in the
 *  stack, which is what "opened most recently" means). */
export function useEscape(id: string | null, close: () => void): void {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!id) return undefined;
    return pushEscape(id, () => ref.current());
  }, [id]);
}
