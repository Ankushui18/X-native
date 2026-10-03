# Figma Help parity audit 01 — Image properties

**Date:** 2026-09-30
**Scope:** One Figma Design Help article only; audit, no implementation changes.
**Category supplied:** [Figma Design](https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design)
**Article audited:** [Adjust the properties of an image](https://help.figma.com/hc/en-us/articles/360041098433-Adjust-the-properties-of-an-image)

## Reference behavior and visual expectation

The article says to select an image-painted layer, open the Fill or Stroke swatch, then edit image properties. It documents four image modes (Fill, Fit, Crop, Tile), tile percentage, clockwise 90° fill rotation, and seven non-destructive adjustments: Exposure, Contrast, Saturation, Temperature, Tint, Highlights, and Shadows.

The article includes a sidebar screenshot for the mode selector and example image demonstrations for scaling, rotation, and each adjustment. Its descriptive visual direction is explicit for each slider. In particular, **less Tint should look greener and more Tint should look more magenta**. These are the reference expectations used here; the article does not publish a pixel-level formula or golden image, so exact color-number parity cannot be inferred from the documentation alone.

## What X-Native currently does

- The image picker exposes Fill/Fit/Crop/Tile; Tile also exposes a percentage field.
- The picker exposes a 90° rotation button and the same seven named adjustment sliders (each currently ranges from -100 to +100).
- The canvas renderer handles Fill as cover, Fit as contain, Crop using a stored normalized crop rectangle, and Tile as a repeated image pattern. Crop interaction has separate UI-level tests.
- Image rotation and adjustments are applied in `apps/web/src/engine/paint.ts` by rasterizing into an offscreen canvas. The result is described and stored as image-fill properties, so the original image source remains intact.

Relevant implementation locations:
- `apps/web/src/ui/FillPicker.tsx` — image mode, tile size, rotate button, and adjustment sliders.
- `apps/web/src/engine/paint.ts` — image raster transform and pixel adjustments (`processImage`, `paintImageFill`).
- `apps/web/src/ui/inspector.tsx` — image-fill properties passed through the inspector and fill picker.

## Findings

### P2 — Tint slider direction is opposite to Figma's documented result

**Status: Confirmed from implementation; no code changed.**

Figma says lowering Tint makes an image greener and raising Tint makes it more magenta. In the renderer, a positive Tint adds green (`tiG`) while subtracting red and blue (`tiRB`); a negative Tint does the reverse. Therefore X-Native's positive side produces green and its negative side produces magenta—the opposite of the documented direction.

For a neutral mid-gray pixel (128, 128, 128), the current adjustment math at Tint +100 moves approximately toward (108, 168, 108), i.e. green; Tint -100 moves toward (148, 88, 148), i.e. magenta. This can be reproduced directly from `paint.ts` around lines 708–723. **Suggested fix after approval:** invert the Tint contribution signs and add a pixel-level regression test for both directions.

### P2 — Image strokes in the reference are not available in the product

**Status: Confirmed feature gap against the article's documented access path.**

The Figma article explicitly covers image properties for layers using an image as either a fill or a stroke. X-Native's image property UI is reached through fill controls; the stroke UI is solid/pattern-oriented and does not offer an image paint. The picker itself has a `noImage` path for strokes, and the image renderer is wired to fills. Consequently, an image stroke cannot be created or adjusted using the reference workflow.

This is a scope gap rather than a visual defect in existing image fills. **Suggested fix after approval:** decide whether image strokes are in scope; if yes, add image stroke paint support through the inspector, renderer, document persistence, and export paths, then test it separately.

### P2 — Adjustment visual parity is not covered by current image tests

**Status: Confirmed test-coverage gap; exact pixel mismatch remains unverified.**

The image geometry tests cover Fill/Fit/Crop/Tile draw geometry and SVG output. The image test file explicitly notes that it does not hit the adjusted-image path because that path needs a real canvas. Crop interaction has dedicated DOM tests, but I found no equivalent pixel tests for Exposure, Contrast, Saturation, Temperature, Tint, Highlights, or Shadows. The renderer uses a local approximation for those effects, while the Figma article documents directional intent but no numeric transfer curves. This means non-Tint adjustment output cannot currently be called visually equivalent from static review alone.

**Suggested fix after approval:** use the existing real-canvas/Skia test harness to assert directional pixel behavior for each adjustment, then compare a repeatable set of test-image outputs against Figma reference exports/screenshots if those can be captured. Keep the comparison image, slider value, color-space assumptions, and acceptable tolerance explicit.

## Parity summary

| Reference item | X-Native status | Audit result |
|---|---|---|
| Fill / Fit / Crop / Tile modes | Implemented | Core geometry paths exist; unit tests cover geometry. |
| Tile percentage | Implemented | UI field and repeated-pattern rendering exist. |
| Rotate fill clockwise 90° | Implemented | UI cycles in 90° steps; renderer rotates the image raster. |
| Exposure / Contrast / Saturation | Implemented | Controls and pixel math exist; exact visual parity not proven. |
| Temperature | Implemented | Direction appears consistent (positive warms, negative cools); exact visual parity not proven. |
| Tint | Implemented, but reversed | **Confirmed defect:** positive/negative directions disagree with Figma's written behavior. |
| Highlights / Shadows | Implemented | Controls and tonal branches exist; exact visual parity not proven. |
| Image as stroke | Not supported | **Confirmed scope gap** against this article's fill-or-stroke workflow. |
| Non-destructive edit | Partially evidenced | Properties are stored separately from the image source; a full save/reopen/output round-trip was not run. |

## Verification and limits

- Reviewed the Figma article text and its described/sidebar image examples, then traced the corresponding product UI and canvas image-rendering paths.
- No product code was modified.
- Installed the web dependencies with `npm ci`; started the Vite dev server on port 5173 and confirmed `GET /` returned HTTP 200. The live preview is running in this session.
- `npm run build` **passed** (`tsc -b` and Vite production build). Vite emitted its existing large-chunk warning (main JS bundle is about 1.31 MB before gzip).
- `npm test` **passed** (exit code 0), including the image renderer tests and crop interaction tests. Direct targeted runs also passed: `images.test.mjs` 52 checks and `imageCropInteraction.test.mjs` 45 checks. The suite emitted non-failing environment/test warnings, including missing canvas support in some DOM-only tests and geometry bridge fallback messages.
- The existing image tests verify image fill geometry and crop behavior but do not exercise the actual image-adjustment pixel transform. No browser executable is installed in this environment, so a browser-driven manual UI interaction was not performed.
- The linked Figma article was available as documentation, but its image attachments were not independently fetched as pixel fixtures. Accordingly, this report calls out the Tint direction defect from the written reference and code math; it does **not** claim screenshot-level pixel matching for the other sliders.
- `npm audit` reports one **critical dev-dependency advisory** in `happy-dom` (installed version is in the affected range); `npm audit --omit=dev` reports no production dependency advisories. No dependency updates were made as part of this audit.

## Next audit item

Stop here for review. After this report is reviewed, continue with one separate Figma Help article and its corresponding X-Native behavior; do not expand this audit into unrelated image workflows yet.
