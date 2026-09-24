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

## Dev Mode handoff round (Sketch handoff docs + Figma's properties panel)

Read against [Sketch · Developer handoff](https://www.sketch.com/docs/developer-handoff/),
[Sketch · Export](https://www.sketch.com/docs/developer-handoff/export/) and
[Figma · right sidebar](https://help.figma.com/hc/en-us/articles/360039832014).
Three behaviours were missing and are now in, plus one deliberate decline:

- **One language everywhere.** `ui/devPrefs.ts` owns Dev Mode's language + units, so
  the panel's snippet, the right-click **Copy/paste as ▸** submenu and ⌥⇧⌘C answer in the
  same voice. Previously the menu built its own px CSS inside the engine while the panel
  was set to, say, SwiftUI + rem — two answers for one layer. The preference is stored,
  so it outlives a reload (Figma's Inspect settings behave the same).
- **Tokens in the empty inspect panel.** With nothing selected, the properties panel is
  where Figma puts the file's styles and variables and where Sketch exports tokens as CSS
  or JSON; we now list colour/number variables + paint styles grouped by collection, each
  row click-to-copy, with **CSS** / **JSON** / `tokens.json` download. Numbers are labelled
  as unitless rather than quietly gaining `px`.
- **A handoff link opens in Dev Mode**, on the layer it names — the closest we can get to
  Sketch's "preview with inspecting enabled" while a file lives only in this browser.
- **Declined:** Figma's "Property labels" toggle from the ⌄ menu by the zoom %. Labels in
  both panels are inline JSX in ~40 places; hiding a subset would read as broken rather
  than as a preference. Revisit only with one CSS-driven class on `.app`.

## Pen tool vs Figma's vector networks

Read against [Vector networks](https://help.figma.com/hc/en-us/articles/360040450213-Vector-networks).
A headless pass (`audit_pen.mjs`) measured what our pen actually did before the change:

| Figma | X-Native before | evidence |
| --- | --- | --- |
| Escape finishes the path and **leaves it open** | Escape threw the drawing away | `vectors before 0 → after Escape 0`, verdict "work discarded" |
| Clicking away / Enter finishes, still open | Enter **sealed** it, so a drawn line came back as a filled polygon | panel showed a grey Fill on a 3-point path |
| Networks "can have multiple paths that branch out in various directions without creating and combining separate paths" | every stroke became a **new top-level layer**; a vertex of the selected shape could not be continued from | `vectors 2 → 3`, "made a second, separate shape" |
| Hovering a point to close shows "a small circle next to the cursor" | no affordance at all; closing silently worked only on the first point | `cursor near vs away: "" / ""` |
| Click and drag makes a curve | drag handles worked, but only on a brand-new shape | unchanged |

The engine already had the model for this — `VectorNetwork` (vertices + segments graph),
`pathToVectorNetwork`/`vectorNetworkToPath`, an `addVectorBranch` command and a Vector Network
panel reading "Vertices / Segments / Branching (≥3) / Closed". The pen simply never used
any of it: it accumulated `PathPoint[]` and committed `addPath`. So this was a wiring job,
not a new subsystem.

Now in:

- **Escape and Enter finish an open path** (`addPath { closed: false }`); closing stays the
  deliberate act of clicking a point, so a drawn line no longer turns into a filled shape.
  The tool stays the pen, so the next path starts at once.
- **Branching**: with a vector selected, pressing `P` and clicking one of its vertices anchors
  the pen there — the ring plus a rubber band show it — and each further click extends that
  **same layer** through `addVectorBranch`. Verified: `vectors 3 → 3, sameLayer: true`, and the
  panel went from 3 vertices/2 segments to **4 vertices/4 segments with Branching (≥3): 1**.
- **A branch outside the old bounds grows the layer.** `addVectorBranch` used to write the
  vertices and leave `x/y/w/h` alone, so hover, marquee and the export crop still answered for
  the previous box. The origin now shifts and the frame grows with the geometry
  (`Y 600 → 460`, `H → 300` in the run above).
- **The close/join ring** is drawn on whichever point the next click would join, on every draft
  point rather than only the first, which is what makes closing discoverable.

One real trap surfaced here, worth remembering: both `Canvas`'s key handler and `bindHotkeys`
listen for `keydown` on `window` in the **capture** phase, and `Canvas` re-registers its listener
whenever the draft changes — which moves it to the *end* of the listener list. After the first
click, the app's Escape (deselect) therefore won and the pen's own Escape never ran. The pen
draft is now published through `ui/penDraft.ts` and finished by whoever handles the key, exactly
once. Same lesson as `popoverGuard.ts`: ownership of a key has to be explicit, because
capture-phase order is decided by registration order.

Still open, in priority order:

1. Drag-to-curve works only for a point on a brand-new shape; a branch segment is straight.
   `addVectorBranch` already takes `tangentStart`/`tangentEnd`, so this is UI work in the
   `penDrag` path plus a tangent patch on the segment after mouseup.
2. The doc's six **end caps** for open paths (None / line arrow / triangle / reversed triangle /
   circle / diamond, with the two-endpoint case in the sidebar and the multi-point case in the
   advanced stroke menu). The engine stores `strokeCap` per vertex; the panel does not expose it.
3. Creating *any* layer while a frame is selected puts it at page level, not inside the frame
   — `addPath` and the rect/ellipse path share that root cause, so it is fixed once, globally,
   or it will read as a pen-only quirk.
4. Clicking a **middle** vertex of an in-progress draft should branch there (Figma); we still
   only join the first point, because a draft lives in `PathPoint[]` until it is committed.

## Text and typography vs Figma's text docs

Evidence: Figma's "Text and typography" help section, read article by article.
Two of its articles carry the behaviour we could actually test here: *Adjust text
dimensions and resizing* and *Explore text properties* (the latter enumerates the
Typography panel: text styles, font family, weight and style, size, line height,
letter spacing, horizontal and vertical alignment, then the type settings behind
the `⋯`). Sketch's text docs were consulted for the same list; they add nothing
Figma's does not already cover, so Figma's wording is what is quoted below.

Measured first, then fixed. Each row was driven in a headless browser and read
back from the panel or the pixels.

| Figma's rule | Before | Now |
| --- | --- | --- |
| Single click with the text tool creates an **auto width** layer | already right (`Auto W` selected, box hugs the copy) | kept |
| Click-drag creates a **Fixed size** box the size you dragged | already right (240x190 box kept) | kept |
| Resizing the bounding box by hand sets resizing to **Fixed size** | right, per axis, in x-core's `resize` command | kept; the first attempt at fixing this was reverted as a duplicate of the engine rule |
| Auto width breaks a line only where Return is pressed, so wrap style does nothing there | n/a | wrapper runs only when the layer wraps |
| **Wrap style**: Balance distributes the lines evenly, Pretty also avoids a lone final word | absent | `XNode.textWrap`, honoured by the canvas, the editor overlay and the auto-height measure |
| **Paragraph spacing** beyond the space between lines | honoured in the paint | kept |
| **Truncate text** plus max lines, with the ellipsis fitting the box | honoured | kept |
| **Vertical alignment** of the block inside the box | honoured, with the panel's three buttons and a Dev Mode row | kept |
| Line height as Auto / a length | Auto is `0` with a `1.2` fallback, click the label to reset | kept; the percent mode x-core carries as `lhm`/`lhp` is not surfaced in the panel |
| **Lists**: numbered and bulleted paragraphs | absent from the web layer although `x-core` carries `list_style` | `XNode.listStyle`: marker hangs in the gutter, the paragraph is indented beside it |
| **Paragraph indentation** (Details tab) | absent, `paragraph_indent` exists in `x-core` | `XNode.paragraphIndent`, first line of each paragraph |
| Choosing a resizing mode refits the box | the flags moved, the box did not, until the next keystroke | `hugSize` runs with every mode change |
| A type metric changes the space the copy needs | font size, weight, letter spacing, case and truncation left a stale box | every type field re-hugs the axes set to hug |

### Where the wrap styles came from

`balanceLines` lives in `engine/geometry.ts` so it is unit-tested and shared.
Greedy first-fit already produces the fewest lines a paragraph can have, so the
line count is fixed and the only freedom is where the breaks fall: the function
searches for the partition whose **widest line is narrowest** (a small DP over
words x lines, with a sum-of-squares tie-break so ties keep the earlier line
fuller, the way a greedy break leaves them). Pretty takes the same partition and
then deals with the widow: it borrows a word from the line above, which keeps the
line count the editor overlay is already showing, and lifts the lone word up only
when that would overflow. Results are memoised because this runs inside the paint,
paragraphs over 220 words fall back to the greedy break, and unspaced scripts
(CJK) are left to the wrapper, which has no word boundaries to move.

On a seven-line paragraph at 240px the greedy break reaches 235px wide with a
35px tail; Balance brings the widest line down to 214px with every line between
173 and 214. The two renders are pixel-identical only when nothing improves.

### Shared text layout

`ui/textLayout.ts` is new: the glyph cache, `wrapLines`, `textMetrics`, the list
gutter and `hugSize` moved out of `Canvas.tsx` so the inspector measures with the
same rules the canvas paints with. Duplicated measuring is how a text layer ends
up with a box sized by one rule and text drawn by another; the auto-height
re-measure also now counts **wrapped** lines rather than Return characters, which
is what E2 below exposed.

### Verified in the browser

- E2 - Auto height on a wrapped paragraph: `H 20 -> 77` (four lines at 19.2).
- F1 - font size 16 to 40 on an auto width layer: `W 129 -> 317`, `H 20 -> 48`.
- F3 - then 64 with auto height: `H -> 154`, i.e. two wrapped lines, box and text
  still agreeing.
- Wrap style Off / Balance / Pretty each change the canvas (md5 of the paint
  differ), and the panel's select round-trips the value.
- Bulleted and numbered lists: `w-numbers.png` shows `1.` in the gutter with the
  paragraph indented beside it and the lines balanced.
- Dev Mode's List tab gains rows for Wrap style, List, Vertical alignment and
  Paragraph indent, and the CSS snippet emits `text-wrap`, `list-style-type` and
  `text-indent` - three properties that translate to web CSS exactly, which is
  the point of the snippet.
- Legacy files: the guards compare against `"balance"`/`"pretty"` rather than
  testing unequal to `"auto"`, so a document saved before this round keeps the
  greedy break instead of inheriting a mode from `undefined`.
- 162 parity checks pass (`npm test`), 13 of them new and about wrapping;
  `tsc -b` clean; no page errors in any of the runs.

### Deliberate differences

- Dragging one edge of a text layer fixes **that axis** rather than the whole
  setting as Figma's caution describes it, because our three buttons name axes
  (Auto W / Auto H / Fixed) and x-core's `resize` already works per axis. The
  visible outcome for a single-line box is the same.
- The editing overlay hands `text-wrap: balance|pretty` to the browser instead of
  re-running the DP in the DOM, so the caret and the committed text agree without
  a second implementation, and a list's overlay is indented by the gutter so the
  text does not jump on commit (the marker itself cannot live in a textarea).
- `x-core` has both a `WrapStyle` (normal / break-word) and a `TextWrap`
  (auto / balance / pretty, the `tw` binding). The web field mirrors `TextWrap`
  under the name Figma uses in its panel; the overflow rule is not surfaced.

### Still open in this area

Text styles (create, apply, the specimen in the panel) - paint styles exist in our
engine and a text style needs the same slots on the type fields, which is its own
round. Letter spacing in percent, OpenType features (ligatures, numerals, fractions),
variable font axes, writing directions and scripts, hanging punctuation, whole-paragraph
indentation as well as first line, links inside text, and middle truncation
(`x-core` has `TextTruncation::{End, Middle}`, the web node has a boolean). Small caps
is currently an uppercase transform, not a typeface feature. The Rust side already
carries `list_style` and `paragraph_indent`, so the wasm renderer needs the same two
when it is next built; `textWrap` has no Rust counterpart yet.

## Open

- Sketch's top-bar Insert menu and Figma's Assets panel tab, "Additional
  labels", and panel-width `⋯` overflow — real features in both apps, each its
  own project, none a defect today.
- The panel split handle (dragging the inspector wider) exists but has not been
  reviewed for the Dev Mode layout at narrow widths.
- Text styles on type fields, plus the wrapping settings the panel does not
  expose yet: percent letter spacing, OpenType and variable-font axes, hanging
  punctuation, whole-paragraph indentation, links in text, middle truncation.
  Listed in full at the end of the typography section above.
