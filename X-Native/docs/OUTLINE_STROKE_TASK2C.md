# Phase 2 · Task 2C — Outline Stroke

> **Promoted in the opt-in Rust document view.** The genuine generated-WASM
> 30/30 corpus ran green *with the promotion guard still ON* — CI
> [36398066150](https://github.com/Ankushui18/X-native/actions/runs/36398066150)
> on the pull request and
> [36409190946](https://github.com/Ankushui18/X-native/actions/runs/36409190946)
> on `main` — and only that evidence lifted `OUTLINE_STROKE_GUARD_ACTIVE`. The
> post-promotion run
> [36413696948](https://github.com/Ankushui18/X-native/actions/runs/36413696948)
> then drove the public web owner on the real artifact. Reaching it took three
> fixes, all of them harness or audit defects rather than geometry: a smoke that
> captured its stroke revision too late, a teardown call to an unimported
> helper, and an audit that read the source through the offset-gated `getShape`.
> This is **not** a migration of the normal TypeScript editor, `MemoryEngine`,
> Auto Layout or general document persistence: `#/file/<id>?engine=rust` remains
> the only route where a Rust document owns the tree and the undo stack.

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
  Axis-aligned `Line` layers are explicitly admitted: line `w`/`h` are endpoint
  deltas, so one component may be zero while a point-like line remains rejected.
- `x-render::text_geometry::materialize_variable_strokes` selectively turns a raw
  nonempty-profile `StrokePath` into the same x-core closed fill geometry before PDF
  emission. Uniform strokes intentionally retain the native PDF route, including its
  gradient pattern-color-space encoding; malformed in-memory profiles produce no
  uniform-profile fallback.

## Promoted web boundary

- `RustWebDocumentSession.outlineStroke` no longer refuses on a guard. Ordinary edits
  dispatch **one** `x-editor` ReplaceNode command and keep the strict checks that
  already existed: ABI/schema parsing in `rustSession.ts` (closed linear contours,
  anchor/path budgets, finite bounded coordinates, exactly the declared fields), a
  matching affected-layer identity, a positive filled `vector` result whose
  `stroke` is `null`, and no document in the delta. Nothing else is added per edit:
  no JS node tree, no second history and no TypeScript geometry.
- The whole document is still copied only at admission and at an explicit
  checkpoint (`exportDocument`), which is what proves a user's downloaded copy.
  The canonical one-fill stack Outline Stroke writes is the one native stack the web
  checkpoint decoder accepts beyond the legacy single-fill form.
- The preview button is offered only for an admitted **unrounded rectangle** that
  owns one live stroke — the conservative UI subset. The richer native dialect
  (lines, arcs, ellipse/poly/star, dashes, asymmetric caps, variable-width stations)
  stays available to native callers through the same command.

## Evidence

- **Pre-promotion (guard ON).** `apps/web/tests/wasm/outline-stroke-corpus.mjs` runs
  the actual generated `RustDocumentSession.outlineStroke` over 30 rich raw `.x`
  sources — transparent axis-aligned lines plus primitive and vector closed paths,
  every alignment, all caps, miter/bevel/round joins including the miter-limit
  fallback, SVG dash phase (positive and negative), tapered and bulged width
  profiles and transparent line fills. An independent JavaScript filled-ink oracle
  samples a deterministic lattice under NONZERO winding, and each case asserts a
  bounded delta, layer identity, exact apply/undo/redo recovery and lossless
  checkpoints; three malformed sources must refuse without history. The run is
  recorded green in CI
  [36398066150](https://github.com/Ankushui18/X-native/actions/runs/36398066150)
  and [36409190946](https://github.com/Ankushui18/X-native/actions/runs/36409190946)
  **before** the guard was lifted.
- **Promotion (guard OFF).** `real-bridges.mjs` now drives the public web owner:
  an admitted one-page document gets a real Rust stroke, then `outlineStroke`
  through `openWebDocumentSession`. It asserts exactly one real
  `x-wasm.RustDocumentSession.outlineStroke` call, **zero** `getShape` reads, no
  `session.outline` audit decision, one history entry, the bounded filled delta,
  independent rectangle-band ink agreement, a lossless checkpoint, and Rust
  undo/redo restoring the stroked source byte-for-byte. The opt-in audit case
  asserts exactly one apply, one undo and one redo with **zero** shape reads —
  the source style comes from Rust's own undo projection — an agreeing committed
  vector and a `passed` audit decision; the uncovered-source case asserts one
  command, the same round trip and a `not-run` decision (never a refusal).
- CI [36413696948](https://github.com/Ankushui18/X-native/actions/runs/36413696948)
  passed the Rust gate, the web test/build job, the generated matched WASM package
  and the real-artifact smoke with those assertions, including its
  `PASS real-WASM Outline Stroke promotion: public web owner dispatches one Rust
  command with no TS oracle, opt-in ?outline=audit proves the ink, unmodelled
  sources are reported` line. That establishes real-module calls from the app
  bridge in the CI host, not a shipped deployment.

## Promotion sequence (completed)

1. `OUTLINE_STROKE_GUARD_ACTIVE` stayed on while the generated artifact ran the
   corpus; nothing in the web host was allowed to dispatch the command directly.
2. The genuine 30-case corpus ran through the low-level bindgen
   `RustDocumentSession.outlineStroke` class — not a mock and not TypeScript —
   on the packaged artifact, recorded green in the two CI runs above.
3. Every case compared committed filled ink with the independent JavaScript
   reference and verified bounded deltas, layer identity, apply/undo/redo and
   explicit-checkpoint recovery; three malformed sources refused without history.
4. Only then was the guard lifted. The post-promotion smoke then proved the
   public route a browser user reaches, and the normal `MemoryEngine` ownership
   remains outside this task.

## `?outline=audit` — the independent diagnostic

`?outline=audit#/file/<id>?engine=rust` opts into the comparison that promotion
does not require at runtime:

1. the command runs once; the host keeps no JS copy of the layer or its paint, so
   the source rect **and its true stroke style come from the command's own undo
   projection** (`getShape` is the offset dialect and refuses a layer that still
   owns a live stroke). An unrounded rectangle is the modelled dialect; anything
   else is reported, never asserted;
2. the redo returns the applied vector byte-for-byte, and the round trip ends on
   that redo, so the next user undo still removes exactly the outline;
3. `outlineStrokeOracle.ts` computes the analytic rectangle band (alignment,
   miter/bevel/round outer corners, miter-limit bevel fallback), samples a bounded
   lattice under NONZERO winding and probes the corner points where the joins
   differ, skipping samples closer to a committed edge than a 15°-arc facet could
   reach, so round-join faceting cannot become a false finding;
4. a **decisive** disagreement returns native history to the proven source (the
   rejected command stays on the redo stack), pauses editing and offers a
   recovery export, so the frozen preview and the single Rust owner still
   describe the same document; a source or style the reference cannot cover is
   recorded as `not-run` — never as a pass and never as a refusal.
   `decisions["session.outline"]` in `?bridgeAudit=1` exposes the verdict.

This diagnostic is not a second document engine and never paints, stores history or
reads a document. The default route consults none of it.

## Still withheld

The normal TypeScript editor (`MemoryEngine`), its `outlineStrokeNetwork` /
`outlineVariableStroke` path, text outlining in this web preview, Auto Layout,
arbitrary styled/transformed/nested/effect layers, dash/profile checkpointing
through the web document schema, and full-document or native-host parity remain
outside this task. Thirty passing cases are a floor, not a claim of general
document equivalence; the audit's rectangle model is a diagnostic subset, not a
general outline oracle.
