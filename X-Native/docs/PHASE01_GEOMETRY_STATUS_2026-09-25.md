# Phase 1 — Geometry: status 2026-09-25

Companion to `docs/CANONICAL_ARCHITECTURE_2026.md`. This documents what
exists, what it does, and what it does **not** do yet.

## What shipped (this commit)

`x-core` — planar analysis + modifier evaluation, all pure-std (no
external geometry engine), no new dependencies:

### `vector_network.rs` — derived planar analysis
- `VectorNetwork::validate()` — unknown vertices, degenerate self-loops.
- `VectorNetwork::authored_loops()` — stored regions flattened to
  polylines (cubics as 4-subdivision Béziers; straight segments kept
  exact), sorted region/loop order (deterministic).
- `VectorNetwork::analyze()` → `PlanarAnalysis { faces, outer, winding,
  filled, rule }` — half-edge face walk (DCEL-style): faces are **derived
  from the planar graph**, never stored. Orientation convention pinned by
  test: bounded face cells have positive signed area in raw (y-down)
  coordinates; unbounded cells negative; `outer` = first negative-area
  cell.
- Exact, topology-agnostic point queries (computed directly from the
  authored loops, correct for disconnected components too):
  - `point_is_filled(p)` — algebraic winding number under the network's
    `winding_rule` (NonZero / EvenOdd; `None` → NonZero).
  - `winding_at(p)` — raw winding number.
  - `region_at(p)` — stored region whose territory (loops XOR) contains
    `p`.
  - `face_at(p)` — face cell strictly containing `p` (left-side test on
    every boundary half-edge).
- Documented limitation: for disconnected components (e.g. holes as
  nested vertex-disjoint loops) one topological face may appear as several
  face *cells*; the point queries above are authoritative, face cells are
  the primitive for the upcoming arrangement/boolean work.

### `modifier.rs` — non-destructive modifier stack
- `ModifierStack::evaluate(&VectorNetwork) -> Result<VectorNetwork,
  ModifierError>` — recomputes on demand, base untouched, pure
  composition in stack order.
- `Transform` — vertex positions **and** curve tangents; corner radii
  scaled by mean axis scale; non-finite params rejected
  (`InvalidParameter`).
- `Simplify` — Douglas–Peucker on authored loops (open/closed; closed
  anchored at min-x for determinism), rebuilds a straight-edge network,
  dedupes vertices by exact coordinates, drops content that has no
  region (edges-only debris), never empties a loop below 3 vertices
  (keeps original shape instead).
- `Boolean` / `Offset` / `RoundedCorners` / `Stroke` → explicit
  `ModifierError::RequiresGeometryEngine` (they need the arrangement /
  offsetting engine over the node-level path representation). Loud
  failure beats silent approximation.

### Tests
16 integration tests in `vector_network::planar_tests` +
`modifier::modifier_tests` covering: single-loop fill; loop-orientation
independence; reversed holes (unfilled under both rules, winding 0);
same-wind nested loops (|w|=2: NonZero filled, EvenOdd unfilled — SVG/
Figma semantics); disjoint components; internal edges splitting faces;
cubic flattening for winding; empty network; validation failures;
transform correctness + NaN rejection; simplify (small features removed,
large kept, zero tolerance = identity); stack purity/composability.

## Verification note (important)

This sandbox **could not fetch crate dependencies** (network egress to
crates.io / static.rust-lang.org blocked; partial offline toolchain
only), so `cargo check -p x-core` was not runnable here. The code was
therefore first developed and fully test-verified in a zero-dependency
scratch crate (Rust 1.97.0, std only), then ported **verbatim** into
`x-core` (diff-verified equivalent, `rustfmt --check` clean). CI runs the
real `cargo test -p x-core`; treat this commit as validated there.

## What is NOT done (next, in blueprint order)
1. Boolean ops on the raw `VectorNetwork` (arrangement + curve
   intersection + splitting; today only `GeometryBoolean` over the
   node-level path model, `booleans.rs`).
2. `Offset` / `RoundedCorners` / `Stroke` (offsetting engine).
3. Stroke semantics in `paint.rs` (width/cap/join/variable-width
   rendering).
4. Command/Transaction system + stable-id policy as the single mutation
   source (Phase 0 close-out for mutations).
5. Deterministic serialization (sorted ids in serde output).
6. Benchmarks A–F before any performance claim.
