/**
 * Escape should close an open popover before it clears the canvas selection.
 *
 * The app's hotkey handler listens on `window` in the capture phase, so it
 * runs before any listener a popover attaches, and a popover cannot win that
 * race by stopping propagation. Popovers therefore announce themselves here,
 * and the central handler yields while one is open — the same shape as the
 * eyedropper's `armed` flag for the same reason.
 */
let armed = 0;

/** Mark a popover as open for as long as it is mounted. */
export function armPopover(): () => void {
  armed++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    armed = Math.max(0, armed - 1);
  };
}

export function popoverArmed(): boolean {
  return armed > 0;
}
