# Vector-edit Figma parity follow-up — 2026-10-03

Status: implementation is prepared for review in PR [#58](https://github.com/Ankushui18/X-native/pull/58). This is a focused parity pass, not a claim that every Figma vector workflow is identical.

## Reference and comparison method

Primary reference: Figma Help, [Edit vector layers](https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers). The page documents entering vector edit, Q for Lasso, dragging a freeform boundary around points/paths, and point-box operations. The interaction details relevant to this pass are:

- Lasso is a drag gesture in vector-edit mode; Q activates it.
- With multiple points selected, Shift-dragging a point-box corner rotates the points in 15° increments.
- Shift constrains a resize, Alt/Option resizes from center, and Space temporarily repositions points during a resize or rotation.

The implementation comparison was checked against the current web source and the focused Canvas DOM tests, not inferred from the older parity reports alone. The 2026-09-25/26 audits are historical; Batch 3 added point-box resizing on 2026-09-27, and the current Cut subtool is also already present.

## Behavior matrix

| Interaction | Before this pass | Now |
|---|---|---|
| Vector-edit Lasso | `vecSubTool` had a dead `"lasso"` value; no toolbar control or drag handler. | Toolbar control and Q shortcut. Drag draws a freeform page-space boundary and selects enclosed anchors; Shift adds and Alt subtracts. Escape exits Lasso first, then vector edit. |
| Lassoed paths | No gesture. | Segments whose sampled curve is mostly inside the polygon select their endpoint anchors. This is the closest fit to the existing anchor-index model; see residuals below. |
| Multi-point point box | Eight resize handles and topology-preserving resize existed; no rotation gesture. | Shift-drag from a corner rotates selected anchors and their attached Bézier handles, snapped to 15°. A rotation cursor and live angle badge expose the affordance. |
| Proportional resize | Shift resize existed on the point box. | Shift on an edge still constrains proportions. Shift on a corner now follows Figma’s corner-rotation behavior; the earlier mounted test incorrectly used a corner for its proportional-resize case and has been corrected to use an edge. |
| Center resize | Alt/Option resize existed. | Retained for edge/corner resize. Rotation does not change the pivot. |
| Temporary reposition | No point-box Space gesture. | Space during a resize/rotation translates the selected points in page space. Releasing Space rebases the active gesture, avoiding a jump when resize/rotation continues. |
| History and geometry | Web point-box resize was already one gesture and retained graph topology. | Rotation and Space-plus-resize remain one undoable gesture. `patchVectorNetwork` preserves the current node frame while editing; exit normalization keeps the resulting world-space path fixed. Unselected vertices and region/segment data are retained. |
| Core editor | Rust already had a side-effect-free Lasso query for anchors, but it did not update selection state or rotate selected points. Its Lasso query only used the target node’s transform. | Added a stateful replace/add/subtract Lasso-selection API, full ancestor-aware world-space anchor mapping, and one-undo selected-point rotation that rotates attached Bézier controls. |

## Implementation and verification

Web:

- `X-Native/apps/web/src/ui/vectorLasso.ts` owns polygon inclusion, curve sampling and replace/add/subtract selection rules.
- `X-Native/apps/web/src/ui/pointBox.ts` owns page-space point rotation/translation while preserving network topology and tangent vectors.
- `X-Native/apps/web/src/ui/Canvas.tsx` wires the toolbar, Q/Escape behavior, drag preview, Shift-corner 15° rotation, Space reposition/rebase, and angle readout.
- `X-Native/apps/web/src/ui/__tests__/vectorEditTools.dom.test.mjs` covers geometry, transformed ancestors, Lasso modifiers, mounted gestures, cursor/angle affordances, undo, and exit normalization. Batch 3 tests were updated so corner Shift tests rotation and edge Shift tests proportional resize.
- The mounted DOM tests and canvas rendering assertions verify visible control state and previews. A browser binary is unavailable in this environment, so this pass did not produce a real-browser screenshot or pixel-diff comparison.

Core:

- `crates/x-editor/src/vector_edit.rs` now applies nested transforms when finding Lasso hits and exposes selection and point-rotation APIs. The rotation preserves the layer transform and rewrites selected anchors plus their own incoming/outgoing controls as a single `ReplaceNode` undo step.
- Rust validation is not currently available in this environment (`cargo`/`rustc` are absent); the new Rust tests are present but could not be executed here.

Initial baseline before edits: `npm run build` passed; the five focused baseline files passed 334 tests. After this pass, the production build passed, the mounted vector-edit tests passed 23/23, and Batch 3 passed 131/131. The first full run exposed an unnecessary duplicate paint: the sub-tool reset effect created a fresh empty Lasso array on mount, so `frameInteraction.dom.test.mjs` observed the idle “Outer” frame label twice. The effect now preserves state when already reset; that suite passed 65/65, and the final full web suite passed 3,715 checks across 70 summarized suites with 0 failures.

## Remaining differences / scope limits

- The web Lasso operates on the editable `node.path` walk (or `shapePoly` fallback), matching the current point-index selection and overlay. It does not expose branch-only vertices in an arbitrary `VectorNetwork`; branch-wide vector editing is a separate model/UI gap.
- Path selection is represented by selecting segment endpoint anchors. The web uses a majority-inside curve-sampling rule rather than a native segment-selection object, so exact edge/boundary semantics may differ from Figma.
- The new core APIs and Rust tests are present, but `cargo`/`rustc` are unavailable here so their compilation and execution remain unverified. The current web editor is driven by `MemoryEngine`; these Rust methods are not the Canvas runtime’s command path.
- Vector-edit Eraser and Variable-width subtools remain a separate parity gap. The main Eraser is not the same as Figma’s vector-edit Eraser, and its current partial-erase path can split retained runs into separate layers. This pass did not change eraser output semantics.
- Only point-box rotation is covered here. Multi-node transform, simultaneous edits across several vector layers, and every possible graph/region topology still need their own parity pass.

These remaining items are intentionally listed rather than describing the vector editor as fully Figma-equivalent.
