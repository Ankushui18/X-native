# Figma Help parity audit — Export static designs from Figma

**Date:** 2026-10-01
**Reference:** [Export static designs from Figma](https://help.figma.com/hc/en-us/articles/360040028114-Export-static-designs-from-Figma)

## Scope

Compared the linked static-export workflow article with X-Native's export sidebar, slice rendering, File ▸ Export assets sheet, and Dev Mode asset panel. The separate animated-export and file-sharing articles are out of scope.

## Existing parity

- The inspector supports per-layer export configurations, multiple presets, preview, and a page export when nothing is selected.
- Slices can be added to the export flow; export output is cropped to the slice region.
- File ▸ Export assets opens a modal with per-row format/scale/dimensions, checkboxes, filtering, preview thumbnails, and export.
- Clicking a row thumbnail selects and zooms to that layer; Dev Mode exposes selected-object assets and downloads.

## Findings and changes

1. **Bulk candidates — fixed.** The dialog included unconfigured frames and slices, and stopped walking below a frame. The article defines bulk export as selections that already have export configurations. The sheet now lists only configured, visible layers and continues through frames/groups so configured descendants are included. Matching rows start checked; users can uncheck rows before exporting.
2. **Filename discovery — fixed.** Hovering a layer name exposed the output filename, but its thumbnail did not. The thumbnail now exposes the same filename tooltip.
3. **Slash-separated folder names — remaining platform limitation.** The article says slash-separated names become nested folders. X-Native currently supplies the layer name as a browser download filename; the browser download API does not provide a portable way to create those nested folders. The layer name and suffix are retained, but folder organization is not reproduced.
4. **Native Figma file export — not implemented.** The article also lists downloading the entire file as `.fig`. X-Native's local document export uses its own `.x.json` format; it does not emit Figma's native `.fig` format. This is a separate file-format capability and was not approximated in this static-asset workflow change.
5. **Access-role restrictions — not modeled.** The reference distinguishes viewer/editor access and owner restrictions on copying/exporting. X-Native has no corresponding collaboration permission model, so those visibility/authorization rules cannot be mirrored here.

## Tests

Added a DOM regression test that configures a frame and nested child, verifies both appear, excludes an unconfigured frame, checks the initial selected state, and checks the filename tooltip on both thumbnail and name. Updated the existing export-sheet focus fixture to use an actual configured layer.

- `exportBulk.dom.test.mjs`: 5 passed.
- `edgefit.test.mjs`: 26 passed.
- Full `npm test`: passed.
- `npm run build`: passed; Vite emitted its large-chunk advisory.
