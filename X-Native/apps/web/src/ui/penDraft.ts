/**
 * The pen draft, published so that Escape can be answered where it is decided.
 *
 * Both the canvas and the app's hotkey layer listen for keydown in the capture
 * phase on `window`. The canvas re-registers its listener whenever its draft
 * changes, which moves it to the *end* of the listener list — so after the first
 * click, the hotkey layer's Escape (deselect) wins and runs first, and the pen's
 * own Escape either never ran or ran against a state the other had already
 * changed. That is why "Escape to finish the path" quietly threw a drawing away:
 * neither handler reliably owned the key.
 *
 * So the answer lives here: the canvas registers a finisher for as long as a
 * draft exists, the Escape branch calls it, and whoever gets there first is the
 * one that commits — once.
 */
let finisher: (() => void) | null = null;

export function registerPenFinisher(fn: (() => void) | null): void {
  finisher = fn;
}

export function hasPenDraft(): boolean {
  return finisher !== null;
}

/** True when there was a draft to finish, so the caller can consume the key. */
export function finishPenDraft(): boolean {
  const fn = finisher;
  if (!fn) return false;
  finisher = null;
  fn();
  return true;
}
