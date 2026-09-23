# Editor interface parity — Figma and Sketch

Date: 2026-09-24
Status: implemented, committed on `arena/01a0d002-x-native` (`c5e8d9c`, `cc1965a`)
Sources: Figma Help Center — “Hide or minimize the UI” (article 41414918021271),
“Explore the navigation bar and left sidebar” (360039831974); Sketch docs —
“The Toolbar” and “The Inspector”.

Rule held throughout: **the UI is ours, the functions and behaviour are theirs**.
Nothing below copies Figma's pixels; each one is a capability our app did not have.

## What the study found

Already at parity, verified by reading the code rather than assumed: `⌘\` hides
the whole interface, `⇧⌘\` minimizes it, the same two commands are in the Actions
palette (⌘K), and a minimize control sits atop the left sidebar next to the file
name — exactly what Figma documents.

## Gaps closed

1. **Selection colors** (Sketch's inspector section). Our version appeared only
   on multi-select and read only the selected layers' own fills, so a frame
   reported nothing. It now walks the whole selection subtree, groups by
   Fill / Border / Text, sorts by frequency, and offers both apps' behaviours on
   one row: the swatch recolors *every* layer on the page sharing that colour in
   a single undo step (Sketch's “click it to update them all at once”), the hex
   selects them all (Figma's “Select all with same fill”, ⇧ to add).
   `src/ui/selectionColors.ts` holds the walk so the inspector stays presentational.
2. **Export assets sheet.** `⇧⌘E` — the same shortcut in both apps, previously
   absent here — opens a sheet listing every exportable layer on the page with a
   checkbox, format, scale and suffix per row, thumbnails that focus the layer
   (Figma), and a staggered run because browsers throttle simultaneous downloads.
   Reachable from the Export section's “All…” and from ⌘K.
3. **Minimized panel floats.** Figma keeps the document at full width and lays
   the right sidebar *over* it, expanding on selection and collapsing on
   deselect. We were squeezing the canvas to dock the panel instead. The card now
   floats below the toolbar, which stays visible in this state.
4. **Right-click an empty canvas** offers Minimize UI / Hide UI, the second route
   Figma documents for people who never open a menu bar.
5. **The zoom tool explains itself.** A cursor cannot say “drag to fit an area”,
   so the tool keeps a transient HUD on canvas with its three gestures and the
   live percentage.
6. **Panel header**: the Dev Mode switch reads as a state (tinted, underlined)
   rather than a recoloured icon button, and Present / Share gained real tooltips.

## Deliberately not copied

- Sketch's top-bar Insert menu, notification/comment counters and Share sheet
  chrome — we keep our left dock plus ⌘K palette for the same reach.
- Figma's “Additional labels” toggle, Assets panel tab, and panel-width overflow
  `⋯` menu — real features, but each is its own project; none is a defect today.

## Open

- **Dev Mode quality** (the last item of the original defect list) is still
  untouched: the Inspect tab exists with measurements and code, but the panel
  split handle and FigInspector's annotation tools have not been reviewed.
- No browser was available in this session (several Chromium downloads are
  blocked from the sandbox), so this round is verified by `tsc -b`, the 149
  engine assertions, and Vite transform checks on each touched module — the
  *look* of the new surfaces is not yet eyeballed. Worth a pass in the preview.
