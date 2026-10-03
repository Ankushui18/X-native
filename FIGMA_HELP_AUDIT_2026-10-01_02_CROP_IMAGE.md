# Figma Help parity audit 02 — Crop an image

**Date:** 2026-10-01
**Scope:** Compare one Figma Design Help article with X-Native, then implement the relevant fixes.
**Category:** [Figma Design](https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design)
**Article:** [Crop an image](https://help.figma.com/hc/en-us/articles/360040675194-Crop-an-image)

## Reference behavior

Figma's article describes entering Crop by double-clicking an image, using the Crop image action, or switching the image fill mode to Crop. In Crop mode it documents:

- A crop-value slider, aspect-ratio picker, and **Resize to fit** action.
- Crop-window handles; aspect is maintained by default, with Control/Fn allowing a free ratio.
- Option/Alt edits opposite sides symmetrically.
- Enter or clicking elsewhere applies the crop; the image can be repositioned from the faded overflow area.
- Free image rotation by dragging an outside corner; Shift snaps to 15° increments.
- Image resizing by dragging an image edge.
- Quick crop by Command (Mac) or Ctrl (Windows) while dragging image corners.

The page also has GIFs of Crop mode and a cropped-bird example. They were not captured as reference pixels, so this audit makes no screenshot/pixel-parity claim.

## Baseline comparison

Before the changes below, X-Native already supported Crop entry, a faded image overlay, an outlined crop window with eight handles, repositioning, Enter/click-away apply, Escape cancel, and normalized non-destructive `imageCrop` data. It did not expose ratio/zoom/fit controls or Crop-mode rotate, image-edge-resize, and quick-crop gestures. A separate 90° fill rotation did not replace the article's free-rotation interaction.

## Implemented fixes

- Added an in-Crop toolbar with image/square/4:3/16:9/3:2/free aspect choices, zoom control, free-rotation slider, **Resize to fit**, Cancel, and Done.
- Added outside-image rotation handles. Dragging rotates the image fill continuously; Shift snaps the absolute angle to 15° increments.
- Added image-edge dragging to scale the image within a stable frame, with Alt scaling around the center.
- Added Command/Ctrl-drag on selected image corners to enter Crop and begin adjusting the crop window.
- Kept crop actions grouped into one undo step. Cancel/Escape restores the starting crop, dimensions, rotation, and fill mode.
- Expanded the intermediate raster bounds for arbitrary image rotation so rotated corners are not clipped before fitting/painting.

The crop ratio presets and toolbar are an X-Native implementation of the documented controls, not a claim that every Figma control has identical placement or visual styling.

## Relevant files

- `X-Native/apps/web/src/ui/Canvas.tsx` — crop entry, overlay, toolbar, and gestures.
- `X-Native/apps/web/src/engine/cropModel.ts` — crop rectangle and handle geometry.
- `X-Native/apps/web/src/engine/paint.ts` — rotated image raster bounds and image processing.
- `X-Native/apps/web/src/styles.css` — crop-toolbar styling.
- `X-Native/apps/web/src/ui/__tests__/imageCropInteraction.test.mjs` — crop and gesture regressions.
- `X-Native/apps/web/src/ui/__tests__/imageAdjustments.test.mjs` — raster rotation and pixel regressions.

## Existing behavior and related limitation

Crop entry via double-click/action, eight crop handles, image repositioning, default aspect locking, modifier-based free/symmetric adjustments, Enter/click-away apply, Escape cancel, and normalized `imageCrop` data remain supported. Entering Crop through an image stroke/fill route is still limited by the separate image-stroke gap recorded in audit 01; image-as-stroke support was not implemented here.

## Verification and limits

- `imageCropInteraction.test.mjs`: **58 passed, 0 failed**.
- `imageAdjustments.test.mjs`: **5 passed**, including Tint polarity, a real-canvas arbitrary-rotation corner check, and fractional-angle cache behavior.
- `images.test.mjs`: **54 passed** in the earlier focused run.
- Full `npm test`: **passed** after documenting and updating the intentional `Canvas.tsx` chrome-drift budget for the new toolbar in `drift.test.mjs`.
- `npx tsc -b`: **passed** after the crop/rotation implementation.
- `git diff --check`: **passed**.
- The Figma article's embedded media were not captured as side-by-side fixtures; visual parity is limited to described behavior and X-Native renderer/source inspection.

## Audit sequence

This is the second one-article audit. The requested behavior is implemented and regression-tested; no approval was needed or requested before changes.
