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

## Dev Mode (second round, same session)

Figma's *Guide to inspecting* is the reference; the panel was rebuilt on our own
tokens instead of the inline styles and the REST-schema table it used to show:
Code | List toggle, a language menu with the units setting in its footer,
click-to-copy property rows, a typographic specimen for text layers, component
info with a route to the main component, an Assets list, Interactions, and
annotations with a "pin a property" menu (`⇧T` focuses the note field, like
Figma's Annotate). The `.fig` reader left the panel for the rail and ⌘K.

Three defects were only findable in a real browser — worth recording because
neither type-checking nor the engine suite could have caught them:

1. `⇧⌘\` never fired. The handler tested `e.key === "\\"`, but holding Shift
   turns that physical key into another character, so *minimize* was dead while
   *hide* worked. Keyed off `e.code` now.
2. Minimize UI collapsed the canvas to zero width. The rail and left panel are
   grid items, and `display: none` let auto-placement slide the canvas into the
   first (0 px) column: a blank document. They collapse in place instead.
3. A modal rendered through a `document.body` portal cannot see its own
   keydowns — neither a listener it attaches itself nor React's synthetic
   handlers fire for a key targeted at `body`. Escape on the export sheet now
   goes through the central hotkey handler, which already owns the palette and
   the `.fig` modal.

## Verifying in a browser, from this sandbox

`storage.googleapis.com` is blocked, so `puppeteer`'s usual download fails, but
`@sparticuz/chromium` carries the binary in its npm tarball and installs fine:

```sh
mkdir -p /tmp/bt && cd /tmp/bt && npm i @sparticuz/chromium puppeteer-core
node -e 'const fs=require("fs"),z=require("zlib");const b="node_modules/@sparticuz/chromium/bin";
fs.writeFileSync("/tmp/chromium.tar",z.brotliDecompressSync(fs.readFileSync(b+"/chromium.tar.br")));'
# extract the chromium binary, then al2023.tar.br into /tmp/ails and fonts.tar.br
# into /tmp/aifonts, and launch with:
#   env: { LD_LIBRARY_PATH: "/tmp/ails/lib", FONTCONFIG_FILE: "/tmp/fonts.conf" }
```

`LD_LIBRARY_PATH` is required (the bundle has `libnspr4`/`libnss3`, the image
does not). Fonts are cosmetic: without them, `⌥ ⇧ ⌘` glyphs render as boxes in
screenshots, which is a sandbox artefact and not a bug in the UI.

## Open

- Sketch's top-bar Insert menu and Figma's Assets panel tab, "Additional
  labels", and panel-width `⋯` overflow — real features in both apps, each its
  own project, none a defect today.
- The panel split handle (dragging the inspector wider) exists but has not been
  reviewed for the Dev Mode layout at narrow widths.
