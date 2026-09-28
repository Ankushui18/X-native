# Phase 2 · Task 2C — Outline Stroke

> **Implementation status: guard ON; not promoted.** The Rust geometry/editor/session
> implementation exists, but no genuine generated-WASM 30/30 corpus has run for this
> task. The opt-in browser document view therefore keeps `OUTLINE_STROKE_GUARD_ACTIVE`
> enabled. Unit, mock, native-host, or TypeScript-only coverage is not promotion evidence.

## Implemented native path

- `x-core::stroke_outline::outline_stroke_path` materializes one bounded live stroke
  as closed filled vector contours. It validates finite input and fixed budgets, keeps
  dash phase, supports inside/center/outside alignment, asymmetric caps, miter/bevel/
  round joins, and a sorted variable-width profile.
- `x-editor::Editor::outline_stroke_node` makes the rewrite one `ReplaceNode` command:
  the stroke paint becomes the vector fill, identity/selection/history are retained,
  and undo/redo restore the source node exactly.
- `x-native::outline_text_glyph_nodes` and `outline_text_glyph_layers` shape text via
  `x-text` and atomically replace one text layer with ordered editable glyph-vector
  siblings. Empty/whitespace outlines are declined rather than producing empty nodes.
- The bounded `DocumentSession::OutlineStroke` and V6 `x-wasm` ABI return an
  `outline` delta on apply, undo, and redo. It contains one source/result layer
  projection plus the full sole-stroke metadata needed to restore dashes, cap ends,
  joins, miter limit, alignment, and width-profile stations without returning a page.
  The session deliberately declines non-lossless paint stacks, transforms, effects,
  children, locks, unsupported forms, malformed profiles, and budget overflow.

## Promotion sequence (not yet completed)

1. Keep `OUTLINE_STROKE_GUARD_ACTIVE` true in the web session host.
2. Build generated `x-wasm` artifacts and run a **genuine** 30-case corpus through
   `RustDocumentSession.outlineStroke`, not a mock class and not direct TypeScript.
3. While the guard remains on, compare committed filled ink to an independent reference
   for every case and verify bounded deltas, identity, apply/undo/redo, and explicit
   checkpoint recovery.
4. Record the artifact/build/run evidence. Only then may the default browser guard be
   lifted; normal `MemoryEngine` ownership remains outside this task.

A minimum corpus should cover open and closed centerlines; each cap; miter/bevel/round
joins including a miter-limit fallback; dash arrays and positive/negative phase; uniform
and tapered profile stations; primitive and vector sources; transparent line fills;
apply/undo/redo; and refusal/no-history cases. Thirty passing cases are a floor, not a
claim of general document equivalence.
