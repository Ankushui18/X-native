# Architecture migration plan: TypeScript editor engine → Rust authority

**Status / scope.** Documentation spike for Run 18. This file records the current code split and a staged migration proposal; it does not claim the Rust engine already owns the browser editor. Inspected paths are listed so the plan can be revisited against code rather than assumptions.

## 1. Current ownership map

The web editor is still primarily stateful in TypeScript. `apps/web/src/engine/memory.ts` owns `MemoryEngine`, document snapshots, history, command dispatch, layer mutations and web-side layout/constraint resolution. `apps/web/src/ui/Canvas.tsx` owns pointer interpretation and derives group transforms before dispatching `resize`, `move` and `patch` commands. `ui/scaleModel.ts` is a pure arithmetic module; it is not itself an engine owner.

| Semantics | TypeScript implementation | Rust implementation / current relationship |
|---|---|---|
| Document commands, selection/history, transactions | `apps/web/src/engine/memory.ts` (`MemoryEngine.dispatch`, undo/redo, node-tree mutation) | `crates/x-core/src/document.rs`, `transaction.rs`, `transform.rs`; `crates/x-wasm/src/session.rs` exposes a bounded `CommandBridge`. The WASM session is not yet the browser editor's document owner. |
| Auto Layout (flow, grid, wrap, hug/fill, min/max, baseline) | `memory.ts` layout application/reconciliation and `apps/web/src/engine/layout.ts` helpers used by inspector/canvas; behavior is called during TS mutations. | `crates/x-core/src/auto_layout.rs`, `grid.rs`, `layout_types.rs`. Rust has a real layout pass, but the web editor does not route its canonical document layout through it. |
| Frame constraints | `memory.ts::applyConstraints`, invoked by resize/reparent and related mutations | `x-core` transform/constraint fields exist; confirm exact parity before migration. No full TS-vs-WASM browser command parity gate today. |
| World/local coordinates and node transforms | `memory.ts` (`worldMatrix`, `worldPlacement`, point/delta conversions); Canvas has interaction-specific group bounds | `x-core/src/transform.rs`, `geometry.rs`; WASM session's move/resize methods do not yet express full nested/multi-selection interaction semantics. |
| Scale/resize of content | `memory.ts::scaleProps`, vector remapping and resize command; `ui/scaleModel.ts` provides pure group affine functions | Rust has vector/network/transform primitives; the current session resize API is narrower than the web command (no selection list, constraints policy, scale-properties flag). |
| Vector boolean / clipping | TS oracle/fallback paths plus the web runtime bridge and fixture comparators | `x-core/src/booleans.rs`, `clip.rs`, `bezier_clip.rs`; this is one of the more developed Rust geometry areas, but browser authority/fallback policy still needs explicit closure. |
| Stroke outlines/alignment/offset | TS interaction and oracle adapters; `wasmBridge.ts` gates selected native geometry calls by parity | `x-core/src/stroke_outline.rs`, `stroke_alignment.rs`, `offset_path.rs`; `x-wasm` exposes selected stroke/offset session calls. |
| Paint, effects, image transforms, typography, prototype, variables, components, import/export | Broad web semantics live in `apps/web/src/engine/*` and render/UI modules | Corresponding partial crates/modules include `paint.rs`, `image_transform.rs`, `components.rs`, `variables.rs`, `prototype.rs`, `assets.rs`, `styles.rs`, and import/export glue. Coverage varies; keep this inventory precise per migration slice. |
| WASM bridge/runtime | `apps/web/src/engine/wasmBridge.ts`, adapters, parity/fallback audit | `crates/x-wasm/src/lib.rs` plus generated wasm-bindgen module and `session.rs`. Import functions and a bounded stateful session exist; successful initialization is not equivalent to Rust being the editor authority. |

### Present browser boundary

The current wasm-bindgen `RustDocumentSession` boundary accepts a serialized `.x` document and exposes state/node reads, rename, single-node move/resize, booleans, stroke/offset/outline operations, undo/redo, and export. It does not accept the full web command union, does not own the live browser selection/undo transaction stream, and does not return a general typed document delta for every editor command. `wasmBridge.ts` explicitly treats TypeScript as the oracle/fallback for unproven slices. Therefore the immediate architecture goal is not to expand the bridge call-by-call while preserving duplicate semantics; it is to define and then migrate an explicit command/state contract.

## 2. Strict TypeScript ↔ Rust command/state contract

### Authority rules

1. A live design document has exactly one mutation authority: `x-core` through one `x-wasm` document session in Web, or `x-core` directly on Native. TypeScript may own ephemeral pointer/hover/selection presentation state, but never independently recompute/persist document geometry once a semantic is migrated.
2. UI sends semantic intent, not a second geometry implementation. Examples: `TransformSelection { ids, affine, constraint_policy }` or `ResizeFrame { id, rect, constraint_policy }`; the engine validates, applies, records history, resolves layout/constraints, and returns a committed result.
3. Every request carries `{ protocol_version, document_id, base_revision, transaction_id, command }`. Rust rejects stale revisions and malformed/non-finite geometry without partially mutating state. A gesture is one begin/update/commit transaction; intermediate preview is either Rust preview state or a pure deterministic preview request, never a second committed TS document.
4. Every successful mutation returns `{ protocol_version, document_id, revision, transaction_id, changed_nodes, removed_ids, selection_effect, diagnostics }`. `changed_nodes` is a minimal, deterministic patch set including all geometry changed transitively by constraints/Auto Layout. No hidden TS relayout after the response.
5. All lengths/coordinates are document units, angles are degrees, rectangles are parent-local in persisted state, affine matrices are page-space column-vector transforms. IDs are stable strings. Numeric values must be finite; rounding/snap policy is explicit in the command, not ambient Rust/WASM state.
6. Errors are typed (`invalid_command`, `stale_revision`, `missing_node`, `locked`, `unsupported`, `layout_conflict`, `internal`) and do not silently fall back to TS after Rust has accepted/committed a command. Fallback is allowed only before authority transfer or for an explicitly versioned unsupported capability, and must be visible in diagnostics.
7. Undo/redo, save/export, and collaboration consume the same revisioned Rust state. Serialization has a schema version separate from the ABI/protocol version. WASM ABI changes are generated from a single versioned contract and checked in Rust + TS tests.

### Initial command set

- `BeginTransaction`, `CommitTransaction`, `AbortTransaction`
- `MoveSelection { ids, page_delta, snap }`
- `TransformSelection { ids, page_affine, constraints, scale_properties }`
- `ResizeNode { id, parent_rect, constraints, scale_properties }`
- `SetProperties { id, patch }` for non-geometric edits only
- `SetSelection { ids }` may stay UI-owned initially, but Rust validates mutability/selection transformations and reports descendant normalization
- `Undo`, `Redo`, `GetSnapshot`, `GetNode`, `ExportDocument`

For browser calls, batch all gesture updates at the boundary (or use an explicit preview token); do not serialize the whole document per pointer event. Node IDs and revision numbers allow typed deltas and deterministic replay.

## 3. Auto Layout migration plan (future runs)

### Phase A — contract and fixtures (no behavior switch)

1. Inventory the exact web entry points that cause layout: initial document hydration, `MemoryEngine` command cases, inspector sizing edits, frame resize, child insert/reparent, text metric updates, variables/styles, and undo/redo. Record input/output snapshots including hidden/absolute children, stroke exclusion, grid, wrap, hug/fill, min/max, baseline, and fixed dimensions.
2. Serialize a stable `LayoutInput` DTO from web `XNode` to the `x-core::Node` layout DTO. The adapter is mechanical only: IDs, children/order, `AutoLayout`, constraints, explicit sizing, min/max, padding, gap, stroke/layout participation and text metrics. No geometry logic in the adapter.
3. Create shared JSON fixture corpus and differential runner: same input to TS and Rust, compare ordered node geometry and layout diagnostics at documented tolerances. Include adversarial nested layouts and 0/1/2/10+ children. Rust unit tests remain authoritative for its internal algorithm; generated-WASM tests check the actual deployed ABI.

### Phase B — Rust preview, TS remains commit owner

4. Expose `previewLayout(input, revision)` from WASM returning geometry deltas plus diagnostics; no mutation. Run shadow mode in browser in dev/CI and record mismatches. Do not change visual output on mismatch; fail the parity test and preserve a minimized fixture.
5. Resolve differences in one implementation at a time, adding a named fixture for each edge case. Remove the TS preview fork only after the corpus is green across generated WASM and native Rust.

### Phase C — command authority switch

6. Add `RelayoutSubtree { root_id, cause, text_metrics_revision }` to the transaction API. Rust mutates authoritative nodes and returns all transitive changed-node patches. TS applies deltas as a cache/render state only; it does not call `computeAutoLayout`/layout placement after commit.
7. Gate the switch per document session/protocol capability, not per-node opportunistic parity. Keep a deliberate rollback flag only for pre-commit unsupported versions; do not commit in Rust and then silently rerun TS.
8. Move each web mutation trigger to semantic commands and cover its undo/redo, import/save/reload, copy/paste, export, selection and mounted-canvas flow. Remove duplicate TS layout placement and its duplicate tests only after equivalent Rust/WASM tests cover the behavior.
9. Promote the differential suite to a release gate. Rust `cargo test`, wasm target build, generated-WASM parity tests, web `npm test`, and `tsc -b` must all pass before marking the migration phase complete.

### Phase D — delete duplicate semantics

10. Delete TS Auto Layout geometry mutation/constraint paths rather than leaving two owners. Retain UI-only layout metadata editing, DTO mapping, display formatting, and pure visual helpers. Add static checks preventing imports of the retired TS layout mutator from engine command dispatch.
11. Repeat the same contract-first sequence for frame constraints and group transforms. Keep `scaleModel.ts` only where it is explicitly a pure pointer-to-intent helper; the canonical application of its affine result belongs in Rust.

## 4. Run 18 multi-selection transform notes

The current browser Canvas captures a selection bounding box, calculates a uniform group map, and emits per-node `resize`/`patch` commands. The refactor in this run separates the pure group affine functions in `ui/scaleModel.ts`, normalizes selected ancestor/descendant roots, maps centers from page space back to each member's parent coordinates, and lets the existing engine resize path resolve frame constraints. This improves current TypeScript behavior but does **not** make multi-selection an already-migrated Rust semantic; contract migration is listed above.
