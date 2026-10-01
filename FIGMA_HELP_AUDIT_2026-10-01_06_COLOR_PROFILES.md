# Figma Help parity audit 06 — Manage color profiles in design files

**Date:** 2026-10-01
**Scope:** Follow-on from About color models. The user authorized core/engine changes if required; this remains one article only.
**Article:** [Manage color profiles in design files](https://help.figma.com/hc/en-us/articles/360039825114-Manage-color-profiles-in-design-files)

## Reference behavior

Figma supports sRGB and Display P3 in Figma Design. New files default to sRGB, with a user preference for newly created files. A file-level action changes the document profile using either **Assign** (keep stored channel values, change appearance) or **Convert** (preserve appearance as closely as the destination gamut allows, changing values). Styles and variables do not have their values changed by conversion. The file profile is used by default when exporting, with an export-specific profile override. The article also notes that monitor support affects appearance, FigJam stays sRGB, and old unmanaged files are treated as sRGB/preferred profile.

## X-Native behavior traced before implementation

- No sRGB/Display P3 profile field existed on `Snapshot`, the persisted design document, or file preferences.
- The renderer, color picker, document colors, and exporters assumed RGB/hex or browser-default sRGB. There were no assign/convert actions, file profile UI, or export profile override.
- The existing CSS color parser accepted Display P3 syntax but converted it to clipped sRGB before storage; this did not retain profile-specific channel values.

Relevant areas: `X-Native/apps/web/src/engine/types.ts`, `memory.ts`, `persist.ts`, `files.ts`, `ui/chrome.tsx`, `ui/Canvas.tsx`, `ui/color.ts`, `ui/FillPicker.tsx`, and `engine/svgExport.ts` / `ui/inspector.tsx`.

## Implementation

- Added `ColorProfile` (`srgb` | `display-p3`) to document snapshots and persisted documents. Older files without the field fall back to the stored preferred profile (sRGB if unavailable); new files use the preference. The preference is stored in localStorage under `x-native-preferred-color-profile`.
- Added **File ▸ File color profile…** with Assign and Convert paths. Assign preserves embedded color values. Convert uses sRGB/Display P3 transfer and matrix conversions, clips target-channel values, and updates node paints, page pixel-grid colors, and component masters. Shared styles and variables are deliberately excluded. The change is undoable.
- Canvas and offscreen paint contexts request the active profile. CSS color output and CSS color parsing are profile-aware; Display P3 values can remain wide-gamut in a P3 document rather than being prematurely reduced to sRGB.
- Added a preferred-profile action for new files. Export presets can inherit the file profile or explicitly select sRGB/Display P3 in both per-layer export settings and the bulk export sheet. SVG output uses explicit `color(display-p3 …)` values for P3; raster export contexts use the selected output profile. SVG clipboard/copy output also carries the document profile.

## Parity notes and limitations

The conversion implements matrix-based colorimetric conversion with channel clipping, not Figma's exact internal gamut-mapping algorithm. Browser and display support affects visible P3 rendering; when a browser rejects a P3 canvas context, the app falls back to its default 2D context. PDF export currently rasterizes through the selected canvas profile but does not add an explicit ICC profile/tag in the PDF wrapper. FigJam is not part of X-Native's scope.

## Verification

- `npx vite-node src/engine/__tests__/colorProfile.test.mjs` — 17 passed.
- `npx vite-node src/ui/__tests__/colorModels.test.mjs` — 9 passed.
- `npx vite-node src/ui/__tests__/persistence.test.mjs` — 49 passed.
- `npx vite-node src/ui/__tests__/drift.test.mjs` — 24 passed.
- `npm run build` — passed (`tsc -b` + Vite production build; Vite reports the existing large-chunk advisory).
- Full `npm test` — passed; expected File menu rows and intentional UI drift budgets were updated for the profile actions and export selectors.
- `git diff --check` — passed.

## Audit sequence

This is the sixth one-article audit. No other color or export help topic is included.
