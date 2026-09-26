/**
 * Promise-based modal dialog bus (PM-U1).
 *
 * The app used to reach for `window.prompt` / `window.confirm`: blocking
 * browser chrome that freezes the whole tab, cannot be styled, renders
 * system fonts over the Graphite & Signal UI, cannot validate a value, and
 * could not be asserted on by the behaviour suite. Every call site now
 * awaits one of the three helpers below, which render through the shared
 * `XDialog` primitive instead.
 *
 * The API mirrors the natives so the migration is mechanical:
 *   - `askConfirm` -> boolean (Cancel / Escape / backdrop = false)
 *   - `askPrompt`  -> the typed string, or null when cancelled
 *   - `askChoice`  -> the picked option's value, or null when cancelled
 *
 * Requests are queued, not replaced: the component-property flow asks for a
 * type and then a name, and each answer must land in the dialog the user is
 * actually looking at. This module holds no React so the queue and the
 * resolution rules stay headlessly testable; `DialogHost` is the single
 * subscriber that draws whatever is at the head of the queue.
 */

/** One button in a choice dialog. `value` is what `askChoice` resolves with. */
export type DialogOption = {
  label: string;
  value: string;
  /** Renders with the accent fill, and takes focus when the dialog opens. */
  primary?: boolean;
};

type Base = {
  /** Monotonic, so `DialogHost` can key its body and reset local state. */
  id: number;
  title: string;
  /** Optional explanatory line above the field. */
  body?: string;
};

export type DialogRequest =
  | (Base & {
      kind: "confirm";
      confirmLabel: string;
      cancelLabel: string;
      /** Styles the confirm button as destructive (delete, discard). */
      danger: boolean;
    })
  | (Base & {
      kind: "prompt";
      label?: string;
      value: string;
      placeholder?: string;
      /** Grey helper line under the field: format hints, ranges, units. */
      hint?: string;
      confirmLabel: string;
      cancelLabel: string;
      /** Returns an error to show and keep the dialog open, or null to accept. */
      validate?: (value: string) => string | null;
    })
  | (Base & {
      kind: "choice";
      options: DialogOption[];
      cancelLabel: string;
    });

let nextId = 1;
const queue: DialogRequest[] = [];
const listeners = new Set<() => void>();
// Callbacks live beside the queue rather than inside the request so a request
// stays plain data — that is what `currentDialog()` hands to React.
const resolvers = new Map<number, (value: never) => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** `DialogHost`'s subscription. `useSyncExternalStore` wants a stable getter. */
export function subscribeDialog(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The request on screen (head of the queue), or null when nothing is open. */
export function currentDialog(): DialogRequest | null {
  return queue[0] ?? null;
}

/**
 * Settle the dialog the host is showing and advance the queue.
 *
 * Safe to call twice for the same request: Escape and a button click can
 * both land in one tick, and the second call finds the request already
 * spliced out and does nothing.
 */
export function resolveDialog(req: DialogRequest, value: string | boolean | null): void {
  const i = queue.indexOf(req);
  if (i < 0) return;
  queue.splice(i, 1);
  const resolve = resolvers.get(req.id) as ((v: string | boolean | null) => void) | undefined;
  resolvers.delete(req.id);
  if (resolve) {
    if (req.kind === "confirm") resolve(value === true);
    else resolve(typeof value === "string" ? value : null);
  }
  emit();
}

function ask<T>(req: DialogRequest, cancelled: T): Promise<T> {
  if (!listeners.size) {
    // No host is mounted — a test harness, or a tree that forgot `<DialogHost />`.
    // Resolve the cancelled value so callers never hang, but say so loudly: a
    // dialog that silently does nothing is the class of bug this replaces.
    console.warn(`[x-native] "${req.title}" dialog requested with no DialogHost mounted`);
    return Promise.resolve(cancelled);
  }
  return new Promise<T>((resolve) => {
    resolvers.set(req.id, resolve as (value: never) => void);
    queue.push(req);
    emit();
  });
}

/**
 * Ask a yes/no question. Returns false on Cancel, Escape, or backdrop click,
 * so `if (!(await askConfirm(...))) return;` reads exactly like the old
 * `if (!window.confirm(...)) return;`.
 */
export function askConfirm(opts: {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return ask<boolean>(
    {
      id: nextId++,
      kind: "confirm",
      title: opts.title,
      body: opts.body,
      confirmLabel: opts.confirmLabel ?? "Confirm",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      danger: !!opts.danger,
    },
    false,
  );
}

/**
 * Ask for a single line of text. Resolves to the raw string (call sites trim)
 * or null when cancelled. An empty string is a valid answer — pass `validate`
 * when it is not.
 */
export function askPrompt(opts: {
  title: string;
  label?: string;
  body?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  return ask<string | null>(
    {
      id: nextId++,
      kind: "prompt",
      title: opts.title,
      body: opts.body,
      label: opts.label,
      value: opts.value ?? "",
      placeholder: opts.placeholder,
      hint: opts.hint,
      confirmLabel: opts.confirmLabel ?? "Save",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      validate: opts.validate,
    },
    null,
  );
}

/**
 * Ask which of several named outcomes to take — the replacement for a
 * two-way `confirm()` whose Cancel branch quietly meant something.
 * Resolves to the chosen option's value, or null when cancelled.
 */
export function askChoice(opts: {
  title: string;
  body?: string;
  options: DialogOption[];
  cancelLabel?: string;
}): Promise<string | null> {
  return ask<string | null>(
    {
      id: nextId++,
      kind: "choice",
      title: opts.title,
      body: opts.body,
      options: opts.options,
      cancelLabel: opts.cancelLabel ?? "Cancel",
    },
    null,
  );
}

/** Test-only: drop anything queued so one check cannot leak into the next. */
export function resetDialogs(): void {
  queue.length = 0;
  resolvers.clear();
  nextId = 1;
  emit();
}
