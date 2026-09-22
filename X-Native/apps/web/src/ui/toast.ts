/**
 * Tiny toast bus.
 *
 * Figma confirms actions whose result is off-screen or irreversible-looking
 * ("Copied to clipboard", "5 layers deleted"). Previously the only toast in the
 * app was "Link copied", so every other action completed in silence. This lets
 * any module raise one without threading callbacks through the tree.
 */

type Listener = (message: string) => void;

const listeners = new Set<Listener>();

/** Show a transient confirmation. Keep the text short and past-tense. */
export function toast(message: string) {
  for (const fn of listeners) fn(message);
}

export function subscribeToast(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** `n` items, correctly singular/plural — "1 layer", "3 layers". */
export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
