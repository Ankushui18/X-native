# Figma Help parity audit 04 — Guide to fills

**Date:** 2026-10-01
**Scope:** Compare the next article after the eyedropper article with X-Native. The authorized implementation scope is UI-only; no engine/core changes.
**Article:** [Guide to fills](https://help.figma.com/hc/en-us/articles/360041003694-Guide-to-fills) (the older title was “Paints in Figma”).

## Reference behavior

The article covers layer fills (inside closed objects) and stroke fills (outlines on open or closed objects). A layer or stroke may have multiple paints, each with its own properties. Documented paint types are solid colors, gradients, patterns, images, and video (video is plan-limited). It describes adding fills from the Fill/Stroke section, and changing paint, opacity, visibility, order, or removing a paint. Styles and variables can also be created from paints and applied to objects.

## X-Native behavior traced — before UI changes

- The inspector has Fill and Stroke sections with add/remove controls, visibility and opacity controls, and multiple stacked paints.
- Extra fills have drag and forward/back controls. The scalar base fill is fixed at the bottom of the stack and is not reorderable relative to extra fills.
- Extra strokes can be added, edited, hidden, and removed, but have no reorder affordance. The scalar base stroke is fixed at the bottom of the stack.
- The base fill picker supports solid, gradient, pattern, and image (including GIF input); there is no video-fill type. Paint-type support for strokes is intentionally narrower than for fills. Extra stroke rows are solid-color-only.
- The base fill and base stroke rows expose style/variable controls. Extra fill/stroke rows do not carry semantic bindings in the current document model.
- The article’s general fill/stroke opacity, visibility, adding, editing, and removal flows are represented in the inspector. Fill opacity and paint-row interactions have existing coverage, but stroke stacking order has no UI coverage.

Relevant code: `X-Native/apps/web/src/ui/inspector.tsx`, `X-Native/apps/web/src/ui/FillPicker.tsx`, and shared paint-row styling in `X-Native/apps/web/src/styles.css`.

## UI-only findings and implementation

### P2 — Extra stroke paints could not be reordered in the inspector

The document model and renderer already keep extra stroke rows in bottom-to-top order, but the inspector previously provided no reorder affordance. **Fixed in the UI only:** extra stroke rows now have drag handles plus accessible forward/back buttons, with bounds preventing a row from moving below the base stroke. A mounted inspector test verifies button state, reordering in both directions, and drag-and-drop. The base scalar stroke remains fixed at the bottom, as required by the existing core representation.

### Core/model gaps intentionally left unchanged

- Video fills and gradients/images as stroke paints are not exposed by the current paint model/painter. Adding them would require core/model support and is outside the UI-only scope.
- The base scalar fill/stroke remains anchored at the bottom of its stack; changing that requires reworking the core paint representation/order contract.
- Semantic style/variable bindings are not represented on extra paint rows, so the inspector cannot add binding controls for them without core/model support.

## Verification

- `npm run build` — passed; TypeScript and production Vite build succeed (Vite reports the existing non-blocking large-chunk warning).
- `npx vite-node src/ui/__tests__/paints.test.mjs` — 5 passed, 0 failed.
- `npx vite-node src/ui/__tests__/drift.test.mjs` — 24 passed, 0 failed; the inspector ceiling was updated for the reorder controls' two buttons and three tooltips.
- `git diff --check` — passed.
- `npm test` — passed the complete web test suite after updating the UI drift ceiling.

Only UI code, UI regression tests, the web test script, and the audit report were changed for this topic; no engine/core file was changed.

## Audit sequence

This is the fourth one-article audit, following image properties, crop image, and eyedropper. No other topic is included in this change.
