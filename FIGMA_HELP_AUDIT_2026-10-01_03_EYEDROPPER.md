# Figma Help parity audit 03 — Sample colors with the eyedropper tool

**Date:** 2026-10-01
**Scope:** Compare the next article in Figma's *Color, gradients, and images* sequence with X-Native. Implementation was authorized after the audit findings; this report records the outcome for this topic only.
**Article:** [Sample colors with the eyedropper tool](https://help.figma.com/hc/en-us/articles/27643269375767-Sample-colors-with-the-eyedropper-tool)

## Reference behavior

The article describes an eyedropper that samples colors from visible layers or the page background and applies them to the selected paint property. It also documents:

- `I` as the cross-platform shortcut; on macOS, `Control+C` is an alternative for a fill, and the color picker exposes the eyedropper for other color properties.
- A loupe/readout with the sampled color's appearance and value; `Tab` switches between Hex, RGB, HSL, and HSB.
- Shift-clicking a color tied to a variable or style applies that variable/style rather than only its rendered color.
- Creating a color variable or style from a sampled pixel with a modifier chord, then applying it to the selection.
- Deselecting and clicking with the eyedropper to copy a sampled color to the clipboard; Shift copies the variable/style name and value.
- On supported macOS desktop versions, sampling outside the Figma window (not supported on Figma web or Windows).

## Implementation outcome

**Status: Core web workflows implemented; semantic source coverage remains limited to fill/stroke paints.**

- The canvas samples rendered pixels, caches the pixel before painting the loupe, and reads at device-pixel-ratio coordinates. The live sample readout follows the active Hex/RGB/HSL/HSB model; `Tab` cycles those models.
- A global `I` shortcut samples into selected fills. On macOS, `Control+C` also arms the global eyedropper for a selected layer; in an open color picker it activates the picker eyedropper. `Cmd+C` remains ordinary copy, and Windows `Control+C` remains ordinary copy. The picker button remains available for sampling other color properties.
- Shift-sampling detects variable/style identity on the sampled source and applies that binding to selected fill/stroke targets. Modifier-click or modifier-Enter can open the create-variable/style flow for the active fill/stroke target.
- With no selection, sampling copies the raw color value; Shift-copy includes the source variable/style name when semantic source information is available.
- The picker eyedropper updates the currently edited property, including literal color sampling for other picker targets.

### Remaining limitation

Semantic source detection and binding/create actions are currently implemented for node fill and stroke paints. Sampling an effect color, gradient stop, image, page backdrop, or other rendered content still returns its rendered color as a literal; it does not recover a variable/style binding for those sources/targets. Browser-based sampling is confined to X-Native's rendered canvas and does not sample outside the app window. The article's outside-window feature is specifically a supported macOS desktop capability, so this is not treated as a web parity gap.

## Relevant code and tests

- `X-Native/apps/web/src/ui/color.ts` — eyedropper callback/armed state and active readout model.
- `X-Native/apps/web/src/ui/Canvas.tsx` — loupe/readout, rendered-pixel sampling, modifiers, and cached pre-loupe pixel read.
- `X-Native/apps/web/src/ui/FillPicker.tsx` — picker action, picker-local shortcuts, color-model controls, and active-property updates.
- `X-Native/apps/web/src/ui/chrome.tsx` — global `I` and macOS `Control+C` shortcuts.
- `X-Native/apps/web/src/ui/eyedropper.ts` — source identity, binding/create helpers, and clipboard formatting.
- `X-Native/apps/web/src/ui/__tests__/eyedropper.test.mjs` — 20 focused regression checks, including rendered sampling and global/picker platform shortcut behavior.

## Verification

- `npx tsc -b` — passed.
- `npx vite-node src/ui/__tests__/eyedropper.test.mjs` — 20 passed, 0 failed.
- `npx vite-node src/ui/__tests__/events.test.mjs` — 44 passed, 0 failed; registered the new readout-model event in the event census.
- `npm test` — passed the complete web test suite, including the direct global macOS shortcut regression test.
- A browser pixel-diff of the article's embedded video/screenshots was not performed; verification is behavioral and test-based.

## Audit sequence

This is the third one-article audit, following image properties and crop image. This implementation is scoped to the eyedropper article; no other help topic was started.
