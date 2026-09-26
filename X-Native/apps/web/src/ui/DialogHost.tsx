/**
 * The single subscriber that draws whatever module asked for a dialog.
 *
 * Mounted once at the app root (`main.tsx`) so both the Dashboard and the
 * editor get it — a dialog raised from a project menu and one raised from a
 * variable row behave identically. Answers route back through
 * `resolveDialog`, which is idempotent, so Escape and a click in the same
 * tick cannot double-resolve.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { XButton, XDialog } from "./x-ui";
import {
  currentDialog,
  resolveDialog,
  subscribeDialog,
  type DialogRequest,
} from "./dialog";

export function DialogHost() {
  const req = useSyncExternalStore(subscribeDialog, currentDialog, currentDialog);
  // Keying on the request id gives each dialog fresh local state, so a queued
  // follow-up prompt starts from its own initial value instead of the last
  // dialog's leftovers.
  return req ? <DialogView key={req.id} req={req} /> : null;
}

function DialogView({ req }: { req: DialogRequest }) {
  const close = (value: string | boolean | null) => resolveDialog(req, value);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  // The prompt body owns its value (and therefore its validation), so the
  // footer's Confirm reaches it through a ref rather than by lifting state.
  const submitRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Focus the primary action so Enter and Space work without reaching for
    // the mouse. A prompt focuses its own field instead.
    if (req.kind !== "prompt") primaryRef.current?.focus();
  }, [req]);

  const closeRef = useRef(close);
  closeRef.current = close;

  // Escape belongs to the dialog, and is handled in the capture phase so it
  // cannot also reach the editor's global Escape (clear selection, exit Zen,
  // cancel a crop). Handlers registered on window in the same phase by canvas
  // modes earlier in the session still see it; nothing else does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <XDialog
      title={req.title}
      width={req.kind === "prompt" ? 420 : 460}
      onClose={() => close(null)}
      footer={
        <>
          <XButton onClick={() => close(null)}>{req.cancelLabel}</XButton>
          {req.kind === "choice" &&
            req.options.map((opt, i) => (
              <XButton
                key={opt.value}
                // Focus follows the accent button, not the first one: Enter
                // activates whatever is focused, so it must be the answer the
                // dialog is recommending.
                ref={i === primaryIndex(req.options) ? primaryRef : undefined}
                variant={opt.primary ?? i === 0 ? "primary" : "secondary"}
                onClick={() => close(opt.value)}
              >
                {opt.label}
              </XButton>
            ))}
          {req.kind === "confirm" && (
            <XButton
              ref={primaryRef}
              variant={req.danger ? "danger" : "primary"}
              onClick={() => close(true)}
            >
              {req.confirmLabel}
            </XButton>
          )}
          {req.kind === "prompt" && (
            <XButton variant="primary" onClick={() => submitRef.current()}>
              {req.confirmLabel}
            </XButton>
          )}
        </>
      }
    >
      {req.kind === "prompt" ? (
        <PromptBody req={req} onClose={close} submitRef={submitRef} />
      ) : (
        req.body && <p className="dlg-body">{req.body}</p>
      )}
    </XDialog>
  );
}

/** Which option carries the accent: its index, or the first when none says so. */
function primaryIndex(options: { primary?: boolean }[]): number {
  const i = options.findIndex((o) => o.primary);
  return i < 0 ? 0 : i;
}

function PromptBody({
  req,
  onClose,
  submitRef,
}: {
  req: Extract<DialogRequest, { kind: "prompt" }>;
  onClose: (value: string | null) => void;
  submitRef: React.MutableRefObject<() => void>;
}) {
  const [value, setValue] = useState(req.value);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const submit = () => {
    const problem = req.validate?.(value) ?? null;
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    onClose(value);
  };
  submitRef.current = submit;

  useEffect(() => {
    // Select the initial text: renames and value edits are almost always
    // typed over, matching what `window.prompt` did.
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape is the dialog's (DialogView); a binding into a popover behind a
      // modal must not close one layer at a time.
      if (e.key !== "Enter") return;
      // A focused button keeps its own activation, so Tab-then-Enter on
      // Cancel still cancels rather than submitting the field.
      if ((e.target as HTMLElement | null)?.tagName === "BUTTON") return;
      e.preventDefault();
      e.stopPropagation();
      submitRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [submitRef]);

  return (
    <>
      {req.body && <p className="dlg-body">{req.body}</p>}
      <label className="dlg-field">
        {req.label && <span className="dlg-label">{req.label}</span>}
        <input
          ref={inputRef}
          className={`dlg-input${error ? " bad" : ""}`}
          aria-label={req.label || req.title}
          aria-invalid={!!error}
          value={value}
          placeholder={req.placeholder}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
        />
      </label>
      {error ? (
        <p className="dlg-error" role="alert">
          {error}
        </p>
      ) : (
        req.hint && <p className="dlg-hint">{req.hint}</p>
      )}
    </>
  );
}
