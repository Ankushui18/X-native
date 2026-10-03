# Figma Help parity audit — Export formats and settings for static designs

**Date:** 2026-10-01
**Reference:** [Export formats and settings for static designs](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings-for-static-designs)

## Scope

Compared the article's static PNG, JPG, SVG, and PDF export formats and per-format options with X-Native's export model, inspector, SVG renderer, and PDF writer. This audit does not cover animated exports or the separate export workflow article.

## Existing parity

- X-Native offers PNG, JPG, SVG, and PDF, scale entry (multipliers and fixed width/height), suffixes, and format capability-driven settings.
- SVG and PDF are pinned to 1x; the size model supports the article's `x`, `w`, and `h` syntax for raster outputs. PNG/JPG exports now stamp 72 × effective scale DPI metadata (`pHYs` for PNG and JFIF density for JPEG).
- The UI offers file/sRGB/Display P3 profile selection. PNG/JPG support overlap controls and a text-layer-only bounding-box control; SVG exposes SVG-specific controls; PDF has image quality and resampling controls. JPG defaults to High and PDF to Medium; resampling defaults to Detailed.
- SVG text outlining, overlap handling for slices, and detailed/basic raster resampling already have implementation paths.

## Findings and changes

1. **PDF compatibility version — fixed.** The browser PDF writer declared PDF 1.4, while the article says Figma exports PDF 1.7. Updated the generated PDF header to 1.7.
2. **PDF quality control — fixed.** The inspector displayed Low/Medium/High for PDF, but sent only RGBA pixels to a lossless Flate image stream, so the selected quality did not affect output. PDF export now JPEG-encodes the RGB image at the chosen quality while retaining alpha in a lossless soft mask. This makes the setting meaningful and preserves transparency.
3. **Raster DPI metadata — fixed.** The article specifies 72 DPI multiplied by the effective scale. PNG and JPG exports now write matching resolution metadata (PNG `pHYs` pixels-per-meter; JPEG JFIF pixels-per-inch), including fixed-width/fixed-height exports.
4. **Bounding-box setting — partially fixed; behavior remains incomplete.** The control is now shown only for text-layer selections, matching the article's availability rule. The SVG/raster exporter still does not implement the described text-bound trimming versus retaining the text box, so this remains a functional parity gap.
5. **PDF content — remaining limitation.** X-Native's PDF is a single raster image with an optional soft mask, not editable vector paths, text/glyphs, and images as described in the article. Image quality is honored, but output is still raster-backed.
6. **SVG defaults — remaining difference.** X-Native resolves Outline text and Simplify stroke as on for every SVG preset. The article says Outline text defaults on when at least one text layer is selected, and Simplify stroke defaults on for vector networks with inside/outside strokes. These broader defaults need contextual selection-aware resolution and remain follow-up work.
7. **Image quality documentation nuance.** The article's PNG format bullet links to the image-quality section, but its settings table and the detailed quality section specify JPG and PDF. X-Native's capability table follows the latter, more specific guidance; PNG remains lossless.

## Tests

Added focused checks for PNG/JPEG DPI metadata (including PNG chunk CRC and repeat-tagging), PDF 1.7, JPEG image filtering, retained alpha soft mask, the lossless fallback, and text-only visibility of the bounding-box control. Existing export capability and quality-default tests remain applicable.

- `pdfExport.test.mjs`: 5 passed.
- `rasterMetadata.test.mjs`: 8 passed.
- `export24.test.mjs`: 43 passed.
- `exportPathway.dom.test.mjs`: 27 passed.
- `exportSettings.dom.test.mjs`: 2 passed.
- Full `npm test`: passed on the final run.
- `npm run build`: passed (Vite emitted the repository's existing large-chunk advisory).
