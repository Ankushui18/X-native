/**
 * The selected connection, published so that Escape can be answered where it is
 * decided — the same problem the pen draft solved (see ui/penDraft.ts).
 *
 * Both the canvas and the app's hotkey layer listen for keydown in the capture
 * phase on `window`, and the canvas re-registers its listener whenever its
 * state changes, which moves it to the *end* of the listener list. The hotkey
 * layer's Escape (deselect / walk up) therefore runs first — so the canvas
 * branch that drops the connection chip never saw the key, and Escape on a
 * selected connector looked dead even though the handler was right there.
 *
 * The chip registers its dismissal for as long as a connection is selected; the
 * Escape branch calls it and consumes the key.
 */
let dismiss: (() => void) | null = null;

export function registerConnDismiss(fn: (() => void) | null): void {
  dismiss = fn;
}

/** True when a connection was selected and has now been dropped; the caller
 *  owns the keypress. */
export function dismissSelectedConnection(): boolean {
  const fn = dismiss;
  if (!fn) return false;
  dismiss = null;
  fn();
  return true;
}
