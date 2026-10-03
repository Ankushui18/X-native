/**
 * Vector sub-tool rules (PM-U10).
 *
 * `vecSubTool` is the mode inside the vector-edit toolbar — Select, Bend, Paint,
 * Shape Builder — and the toolbar is on screen when one of three things is true:
 * a vector is in point edit (`vecEdit`), the pen tool is active, or a pen path is
 * in progress (`draft`). That is the guard the toolbar itself renders under, so
 * it is also the honest answer to "can this sub-tool be used at all right now".
 *
 * It lives here rather than inline because three callers need the same answer and
 * the same sentence: the toolbar's own buttons, the pen, and the radial menu's
 * Bend slice — which until now dispatched a window event nothing listened for, so
 * choosing it reset the user's tool and did nothing else.
 */

export interface VectorContext {
  /** The id of the vector in point edit, or null. */
  vecEdit: string | null;
  /** The active tool id (`"select"`, `"pen"`, …). */
  tool: string;
  /** Is a pen path in progress? */
  drafting: boolean;
}

/** Is the vector-edit toolbar up, i.e. does a sub-tool mean anything? */
export function vectorToolbarOpen(c: VectorContext): boolean {
  return !!c.vecEdit || c.tool === "pen" || c.drafting;
}

/** What the Bend request can do, and what to say when it cannot. `need` is the
 *  sentence the toast shows — written once so the radial and the toolbar cannot
 *  tell the user two different things. */
export function bendReadiness(c: VectorContext): { ok: true; say: string } | { ok: false; need: string } {
  if (vectorToolbarOpen(c)) {
    return { ok: true, say: "Bend tool active (drag segment to curve)" };
  }
  return {
    ok: false,
    need: "Select a vector, press Enter to edit its points, then Bend — or start a pen path",
  };
}
