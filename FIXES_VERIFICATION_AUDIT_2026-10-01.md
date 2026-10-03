# Fixes verification audit — approved baseline and current parity work

**Date:** 2026-10-01
**Branch:** `arena/01a0f35f-x-native`
**Purpose:** Verify the fixes already made against the approved P0 foundation and eyedropper scope. This is a retrospective implementation audit, not authorization to add features.

## Executive result

The approved foundation fixes are present and covered by executable tests: cancellable canvas wheel navigation; local-copy save/load; corrected open-path stroke defaults; and visible export entry points including page export. Eyedropper sampling now applies the sampled value to a selected fill, with the documented platform shortcut behavior. The latest keyboard-help audit separately refined the existing shortcuts panel to be bottom-docked and non-modal.

This does **not** mean every item mentioned in the older foundation discrepancy report is closed. Specific zoom-range/selection-fit gaps and feature-boundary limitations remain below.

## Fixes checked

| Area | Verified implementation | Test evidence | Result |
|---|---|---|---|
| Canvas zoom and pan | A native, non-passive wheel listener cancels the browser default; Ctrl/Cmd-wheel zoom stays anchored to the pointer; ordinary and Shift-wheel pan; Space+drag pans, including after an inspector field had focus; blur releases Space. | `canvasNavigation.dom.test.mjs`: 25 passed. | P0 interaction fixed. Browser-level proof against real Chromium page zoom was not run in this audit. |
| Save / load | File menu saves and opens portable `.x.json` local copies. The copy includes image bytes rather than storage-only references; load validates the document and opens it as a separate file. | `persistence.test.mjs`: 49 passed, including image round-trip, malformed/newer-document rejection, download, open, and IndexedDB-backed copy. | Approved local-copy path verified. It is not Figma's native `.fig` format or cloud collaboration. |
| Tool defaults | Open vector paths use center alignment and round caps; pencil strokes use the documented 3 px default; brush strokes stay center-aligned. Closed shapes retain inside alignment. | `openPathStroke.dom.test.mjs`: 12 passed; engine parity coverage also asserts pen/pencil/brush defaults. | P0 open-path rendering/default issue fixed without changing correct closed-shape defaults. |
| Export pathway | File menu exposes Export assets; the page can be exported with nothing selected; an open pen stroke survives the SVG path. Bulk export lists configured layers/descendants. | `exportPathway.dom.test.mjs`: 27 passed; `exportBulk.dom.test.mjs`: 5 passed. | Core export path verified. This does not imply native `.fig` export or Figma's nested-folder download behavior. |
| Eyedropper | The rendered canvas pixel is sampled; the global selected-fill workflow applies the sampled literal value, semantic variable/style sampling is supported for fill/stroke, and no-selection sampling copies a value. | `eyedropper.test.mjs`: 21 passed, including a direct assertion that the global sampled value changes the selected fill. | Apply-sampled-color behavior verified. |
| Eyedropper shortcut | `I` remains the cross-platform tool shortcut. On macOS, **Control+C** activates the eyedropper; **Command+C** remains ordinary copy. On Windows, **Ctrl+C** remains ordinary copy. | Platform-specific shortcut tests in `eyedropper.test.mjs`. | Matches the audited Figma article's macOS Control+C wording. If “Cmd/Ctrl+C” was intended to mean Command+C on macOS or Ctrl+C on Windows, that is not the current behavior. |
| Existing shortcuts panel | Panel now docks at the bottom and does not veil canvas pointer/keyboard work; it remains Escape-managed. No new keyboard feature was added. | `keyboardHelp.dom.test.mjs`: 9 passed; `escape.test.mjs`: 49 passed; `modalkeys.test.mjs`: 37 passed. | Existing panel behavior refined and checked. |

## Remaining gaps / boundaries

- The engine accepts zoom levels from 0.02× to 64×, but `persist.validate` still clamps restored zoom to 0.1×–8×. A reload at an extreme zoom can therefore change the saved viewport.
- “Zoom to selection” still caps the fitted zoom at 100%, so a small selection is centered rather than magnified to fill the viewport.
- The keyboard-help article documents arrow-key panning when nothing is selected. X-Native currently uses arrows for nudging and does not pan the empty canvas with them. The gap is recorded, not implemented as a new keyboard gesture in this scope.
- The eyedropper recovers semantic source identity for fills/strokes, not every effect, gradient stop, image, or page backdrop; those samples may be applied as literal colors.
- Save/load is X-Native's portable JSON local-copy format, not Figma `.fig`; native format interchange and collaboration/permission behavior are outside this baseline.
- Figma Motion keyframe authoring and animation export remain unsupported; prototype transitions are not treated as equivalent.

## Verification run

- Full `npm test` suite — passed on this branch after the keyboard-panel change. The direct eyedropper application assertion was then added and its focused test rerun successfully.
- Focused regression runs: canvas navigation (25), persistence (49), open-path stroke (12), export pathway (27), bulk export (5), eyedropper (21), keyboard panel (9), Escape stack (49), and modal-key ownership (37) — all passed.
- `npm run build` — passed with the existing Vite advisory for the >500 kB main chunk.
- DOM tests emit existing happy-dom canvas/React `act(...)` warnings; they did not fail the suite.

## Scope decision

No unrelated product surface or new feature was added for this audit. The two zoom gaps and the documented shortcut-platform distinction are left explicit rather than being silently claimed as fixed.
