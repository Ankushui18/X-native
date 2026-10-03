# Figma Help parity audit 05 — About color models

**Date:** 2026-10-01
**Scope:** Compare the next article in the Figma Help sequence with X-Native. UI-only fixes are authorized; no core/engine changes.
**Article:** [About color models](https://help.figma.com/hc/en-us/articles/360043042113-About-color-models)

## Reference behavior

Figma exposes Hex, RGB, HSB, HSL, and CSS notation for the same color. Hex is the default; choosing another notation does not itself alter appearance. RGB/HSL/HSB have channel fields and a separate alpha percentage; Hex accepts 6 digits plus separate alpha or 8 digits with alpha. CSS accepts RGBA, HSL, `color(display-p3 ...)`, `color(srgb ...)`, OKLCH, and OKLAB notation. The article notes that Figma preserves the entered CSS color space, and distinguishes color-model notation from file/display color profiles.

## X-Native behavior traced before implementation

- All five model labels exist, Hex is the default, and the same stored color is presented via model-specific fields. RGB/HSL/HSB have editable channel fields; all models have a separate opacity percentage, while CSS values can include alpha. Hex accepts 3/4/6/8 digit forms.
- Model changes are available by clicking a cycle button or pressing Tab, but there is no direct model dropdown for selecting a particular notation.
- The CSS parser accepts hex, RGB(A), and HSL(A), but rejects `color(display-p3 ...)`, `color(srgb ...)`, OKLCH, and OKLAB.
- The document paint value is stored as sRGB-like hex and the UI converts accepted values to RGB. Thus the Figma behavior of preserving an authored wide-gamut/CSS color space is not available in the current model.
- Color-model switching itself is UI state and does not modify the paint. Color profiles (sRGB/Display P3 document and export behavior) are a separate topic and are not in scope here.

Relevant code and tests:
- `X-Native/apps/web/src/ui/FillPicker.tsx` — direct model selector, editable notation fields, and keyboard cycling.
- `X-Native/apps/web/src/ui/color.ts` — CSS color parsing and UI conversion helpers.
- `X-Native/apps/web/src/ui/__tests__/colorModels.test.mjs` — parser conversions, direct model selection, and the no-visual-change invariant.

## UI-only fixes implemented

- Replaced the model-cycle-only click affordance with a labeled selector for direct Hex/RGB/CSS/HSL/HSB choice. Keyboard cycling remains available when focus is not in a form control; selecting a model does not patch the paint.
- Extended the UI CSS parser to accept `color(srgb ...)`, `color(display-p3 ...)`, OKLCH, and OKLAB values, including alpha. These inputs convert to the closest clipped sRGB channels that the current paint value can store. Added parser and mounted picker regression tests.

## Remaining limitation

The UI can parse modern CSS color-space notation but cannot preserve P3/OKLab/OKLCH authored values, gamut, or profile through paint storage/render/export without core/model work. This audit does not change color profiles, document/export color management, or any other help topic.

## Verification

- `npm run build` — passed (TypeScript and Vite production build); Vite emits the existing non-blocking large-chunk warning.
- `npx vite-node src/ui/__tests__/colorModels.test.mjs` — 9 passed, 0 failed.
- `npx vite-node src/ui/__tests__/eyedropper.test.mjs` — 20 passed, 0 failed after changing the picker selector.
- `npx vite-node src/ui/__tests__/drift.test.mjs` — 24 passed, 0 failed; its UI ceiling reflects the selector replacing a button.
- `npm test` — passed the complete web test suite.
- `git diff --check` — passed.

Only UI code, UI tests, the web test script, the UI drift census, and this audit report were changed for this topic; no core/engine file was changed.

## Audit sequence

This is the fifth one-article audit, following image properties, crop image, eyedropper, and guide to fills.
