# Phase 2 · Task 2 — aligned uniform strokes

> **Verified bounded slice.** [CI run 36377086997](https://github.com/Ankushui18/X-native/actions/runs/36377086997)
> passed the Rust gate, Web chrome, software-Vulkan screenshots and the
> **genuine generated-WASM stroke corpus (30/30)**. This does not claim every
> existing stroke, arbitrary vector or text outline is native. Positive/negative
> offset paths and text/shape/variable-width outlining are subsequent tasks.

## One geometry and history owner

- `x-core::stroke_alignment::aligned_stroke_band` computes two *node-local*
  contours for a closed, convex polygon. A positive width locates the visible
  band relative to the original edge: inside `[0, -width]`, center
  `[+width/2, -width/2]`, outside `[+width, 0]`. Polygon winding chooses the
  outward normal. Offset **edge intersections**, not averaged vertex normals,
  produce miter corners; an outward corner over the specified miter limit
  bevels. An explicit bevel chamfers the outward silhouette only. A collapsed
  inset has no hole. Nonfinite/degenerate/concave inputs, round joins and
  excessive geometry are refused, not silently approximated.
- Both `x-render`'s IR/raster sinks and direct Vello scene use these `x-core`
  contours for the proven single-layer, plain rectangle dialect. Reversing the
  inner ring provides a hole under the native NONZERO fill rule; the optional
  web preview draws the same two rings under SVG EVENODD. Other native stroke
  shapes continue using their existing renderer, **not** this new geometry.
- `x-editor::Editor::set_aligned_rect_stroke` is one undoable `ReplaceNode`.
  A solid opaque stroke and its align/join options persist in the existing
  native materialized stroke stack; setting width zero removes it. The
  `DocumentSession::Stroke` command admits direct, visible, unlocked, flat,
  opaque rectangles only. Edit/undo/redo return a style and at most twelve
  contour anchors, not the page. A styled resize also returns its changed node
  bounds plus reprojected contours. Moves leave local contours unchanged. Rust
  remains the sole history owner; there is no parallel TS command engine.
- The web session ABI is versioned separately from file format. `strokeNode`
  crosses the same stateful WASM boundary; a bad ABI or malformed delta is
  refused. Explicit export/checkpoint validates **every** materialized layer
  option before converting to web stroke fields. Initial admission still
  requires unstyled rectangles; pre-styled general files use the standard
  editor. The `#/file/<id>?engine=rust` preview remains opt-in, non-autosaved
  and closes before any TypeScript document owner mounts.

## Guard and verification

The small `strokeBandOracle.ts` is an independent, analytical **diagnostic** for
rectangles, not a web document renderer or history. With the genuine-WASM 30/30
parity proven, default edits use the Rust result **without** a per-edit TS
comparison. The opt-in URL `?stroke=audit#/file/<id>?engine=rust` compares native
contours to the oracle; if a mismatch is found *after* Rust changed history,
the UI freezes editing and offers a strict recovery export rather than starting
a second engine. Strict ABI, schema, delta and checkpoint checks remain active
in every mode. The legacy TypeScript engine and normal editor remain unchanged.

The real-artifact corpus uses five rectangles (ordinary, fractional/negative
origin, thick enough to collapse an inset, a 1×1 edge case and a large
fractional rectangle) × three alignments × two joins = **30 cases**. It checks
exact contour bounds, fill semantics and options, opaque paint, bounded deltas,
no-ops, refusal without revision, undo/redo, explicit `.x` checkpoint and
resize reprojection through the generated bindgen class. Rust unit tests cover
reversed winding, acute-corner miter fallback, invalid concave topology and
native IR/raster rendering. Mock DOM tests only check application plumbing;
they do not stand in for the real-WASM corpus.

**Still withheld:** open/concave/curved paths, rounded rectangles, round joins,
caps, dash patterns, gradients, multiple stacks, text and variable-width stroke
outlining. These need their own losslessness and equivalence gates. No default
web document/history/Auto Layout authority is claimed for this preview.
