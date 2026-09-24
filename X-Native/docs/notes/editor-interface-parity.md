# Editor interface parity — Figma and Sketch

Date: 2026-09-24
Status: implemented, committed on `arena/01a0d002-x-native` (`c5e8d9c`, `cc1965a`)
Sources: Figma Help Center — “Hide or minimize the UI” (article 41414918021271),
“Explore the navigation bar and left sidebar” (360039831974); Sketch docs —
“The Toolbar” and “The Inspector”.

Rule held throughout: **the UI is ours, the functions and behaviour are theirs**.
Nothing below copies Figma's pixels; each one is a capability our app did not have.

## Side by side

The audit the whole document is part of: every area of the Figma Design help
category, what Figma does, what this app does, and how the two were compared.
"Measured" means it was run and the number is below or in the round's own
section; "read" means verified by reading the code rather than assumed, which is
the weaker of the two and is labelled as such. An empty verdict is work that is
listed in Figma's category but has not been reached yet - it is not a claim that
we match.

| Area | Figma | Ours | How it was compared | Verdict |
| --- | --- | --- | --- | --- |
| Canvas: zoom | 2%-6400%, ⇧+/⇧− double and halve, ⌘0, ⇧1 fit, ⇧2 selection | same | browser, 22-value preset list | **match** |
| Canvas: zoom anchor | pointer for a wheel, centre for the keyboard | same | browser, 0px drift at the pointer | **match** |
| Canvas: opening a file | Zoom to fit | same | browser, a doc stored at 50% opens fitted | **match** |
| Canvas: pixel preview | off / 1x / 2x, ⌃P / ⌃⌥P | same | browser, edge blend 1px live → 4px at 1x, exact multiples | **match** |
| Canvas: pixel grid | ⌘' overlay, from 400% up | same | browser, overlay only above 400% | **match** |
| Canvas: snap to pixel grid | ⇧⌘', on by default, independent of the overlay | same | engine + browser, 505.00 vs 580.25 | **match** (was wrong) |
| Canvas: layout guides | ⇧G hides every frame's grid | same | browser, 93,021 grid pixels → 0 → 93,021 | **match** |
| Canvas: frame names | 11px, accent on hover and selection, numbered defaults | same | browser, 4.50:1 in every theme | **match** (was wrong) |
| Canvas: rulers, guides | ⇧R, drag from a ruler | rulers and guides exist | read | **partial** - guide creation not audited |
| Canvas: outline mode | ⌘Y / ⌥-hover | not built | - | **missing** |
| Canvas: nudge values | small 1, big 10, settable | same | engine + browser, +8 / +24 | **match** |
| Export: formats | PNG, JPG, SVG, PDF | same | browser, real files | **match** |
| Export: scale | presets, or `2x` / `500w` / `300h` | same | browser, 500w → 500×400, 300h → 375×300 | **match** (was missing) |
| Export: SVG and PDF scale | 1x only | 1x only | browser, locked readout shows 1x | **match** (was wrong) |
| Export: settings | per-format table: overlap, bounding box, id, outline text, simplify stroke, quality, resampling | the table, minus outline text | browser, real svg bytes | **partial** |
| Export: suffix | appended to the name, no separator | same | browser, "Rectangle 1-2x.png" | **match** |
| Export: DPI | 72, ×scale | 72, ×scale | arithmetic | **match** |
| Export: colour profile | Same as file / sRGB / Display P3 | sRGB | read | **partial** |
| Import: `.fig` | n/a | own parser, 20 loops on the sample | engine, pixel samples 10 → 1161 | **match** |
| Import: Sketch | yes | reads `.sketch` | read | **partial** |
| Styles | colour, text, effect, layout-grid styles | shared styles in the engine | read | **partial** |
| Components | masters, instances, variants, properties, slots | masters and instances | (the app has both plus overrides) | **partial** |
| Variables | collections, modes, remote | a `tokens` tab and a variable list | read | **partial** |
| Text | styles, lists, OpenType, variable fonts, CJK, RTL, links, emoji | wrapping, alignment, decoration, auto-height, letter spacing | read | **partial** |
| Auto layout | horizontal, vertical, grid, wrap, per-child settings | a `layout` model, padding, gap, alignment, hug/fill/fixed | read | **partial** |
| Prototypes | triggers, actions, animations, easing, overlays, flows | flows, overlays, transitions, present mode | read | **partial** |
| Comments | threads, replies, resolve, mentions | threads, replies, resolve | read | **partial** |
| Multiplayer | cursors, cursor chat, spotlight, branching, history | none of it; a local file | - | **n/a** - no server |
| Libraries | publish, update, swap, descriptions | none | - | **missing** |
| Plugins / widgets / Dev Mode plugins | yes | none | - | **missing** |

Two rows deserve the label "was wrong" rather than "was missing", because the
feature existed and did the opposite of the article: snapping read the overlay's
flag instead of its own, and SVGs accepted a scale Figma refuses.

## Inventory

The work is an audit of the whole **Figma Design** help category
(<https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design>), taken
one article at a time, in rounds. This is the list, so progress is visible
rather than implied. A tick means the behaviour is implemented and measured; a
round's own section below says what was measured.

**Tour the interface**
- [x] Change the canvas background colour — the page's fill, its own section below
- [x] Toolbar — tools, groups with flyouts, the caret set
- [x] Navigation bar and left sidebar — tabs, pages, layers tree
- [x] Right sidebar — position, layout, appearance, fill, stroke, effects
- [x] Hide or minimize the UI — `⌘\` / `⇧⌘\`, verified by reading the code
- [x] Actions menu — the searchable list, and now Preferences › Nudge amount…
- [x] Keyboard shortcuts — the cheat sheet, kept in step with the handler
- [x] **Nudge values** — small 1 / big 10, settable. This round
- [x] Adjust your zoom and view options — the zoom numbers, then the rest of it
- [ ] Custom thumbnails — a frame marked as the file's preview
- [ ] Create and manage guides — the canvas guides exist; the article is not audited
- [ ] Layer outlines — `⌥`-hover to outline, `⌘Y` outline mode
- [ ] Find and replace — text and layer names across the file

**Create designs** — layers, frames, shapes, masks, vector networks, boolean
operations, flatten, bulk edit, matching objects, parent/child/sibling, select,
alignment, copy/paste, scale, sections, measure distances, lock/visibility/
rename, smart selection, constraints, layout guides all landed in the rounds
listed below. Not yet audited: **shape builder** (31616004109847), **convert
strokes to paths** (33052305733015), **offset path** (33792861450263) and
**bulk edit** (21635177948567) as its own article.

**Text and typography** — 16 articles, and the largest single block left. The
typography round covered the basics; text styles, bulleted/numbered lists,
OpenType features, variable fonts, CJK and RTL text, links in text and emoji
are all still open.

**Color, gradients, and images** — patterns as a fill or stroke, interactive
cropping, the eyedropper (the tool exists), mixed-selection colour editing (landed),
and the colour models are the remaining items.

**Additional properties** — strokes, effects and corners are done; the
sub-options listed under *Open* are not.

**Use auto layout** — six articles; the app has a `layout` model and the
inspector drives it, but none of the six has been audited.

**Figma Draw, Build design systems, Create prototypes, Import and export, Work
together in files** — chunks 2 and 3 of the category are not fetched yet, so
these are listed but not broken down.

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

## Colour, gradients and images vs Figma's colour docs

Same loop, on Figma's "Color, gradients, and images" section: read what each
article says the tool does, measure ours against it, fix what actually
diverges. Most of it was already true. The picker carries all five colour models
including HSB and the RGB / HEX / CSS / HSL / HSB notation dropdown; `BLENDS` in
`ui/color.ts` is exactly Figma's sixteen blend modes and `canvasBlend` maps
every one of them (plus `pass-through` for groups); gradients work on fills and
strokes with draggable stops, `+` to add, minus to delete, Flip and Rotate;
image fills keep Fill / Fit / Crop / Tile across scaling, have the tile size, the
seven adjustments and `Rotate 90º` that turns only the fill. Four things were
not.

### The contrast check

Figma's picker has a "Check color contrast" row and we had nothing like it. It
now sits under the blend row in `FillPicker`, and the maths is the WCAG 2.1
definition rather than an approximation, so the number in the panel is the
number a developer gets out of an audit tool: sRGB linearised through the
`0.03928 / 1.055` piecewise curve, then `(max + 0.05) / (min + 0.05)`, range
1:1 to 21:1. The targets are the article's: 4.5:1 for normal text and 3:1 for
large text and graphics at AA, 7:1 and 4.5:1 at AAA, with the catch that
**graphics has no AAA tier**, so the AAA badge is hidden rather than reported as
a failure when the category is Graphics.

- The category starts on `Auto`, which reads the layer: text at 24px, or 19px
  and bold, is large text and gets the 3:1 line; anything else is normal text;
  `Graphics` is a manual choice.
- The fill's own opacity is composited before measuring, and the background is
  resolved by walking up the ancestry to the first visible solid fill, falling
  back to white, which is the answer you would get by sampling the canvas.
  Typing a hex overrides it and a reset button goes back to the layer's own.
- Figma's auto-correct is "click the ✗ indicator"; ours is a **Fix** button that
  appears only while AA fails. `nearestAccessible` moves the colour's HSB value
  until it clears the target and leaves hue and saturation intact, which is what
  "the nearest compliant color" means in practice: `#00FF00` on white reads
  1.37:1, Fix writes `008A00` into the row it came from, 4.53:1, badges flip.
- The row is wired to the base fill, every extra fill and the base stroke. Stroke
  *extras* are left out: they are the least common case and their row has no
  layer to point at for a background.

### Fill rows are the paint stack, topmost first

The guide to fills says to "hover the left edge of the fill to reveal the drag
handle; click and drag to reorder", and its list reads topmost-first while ours
read bottom-first. The engine was right either way: `paintFill` paints the base
`fill` scalars first and stacks `fills[]` above them bottom-to-top, so it was the
display that was reversed. Extras now render reversed with the base row pinned
last, each carrying a grip and *Bring forward* / *Send backward*, and `moveFill`
does the move in one undo step. The canvas is the proof: with `#0000FF` in the
top row the centre pixel is blue, *Bring forward* on the green row makes it
green, and dragging a row past another swaps both the list and the pixels.

Strokes stay base-first and have no reorder control, because the base stroke row
also carries the shared width, alignment and dash tools, and moving it would
drag those tools with it. Dev Mode's property list now reads topmost-first too,
so a designer and a developer are counting the same stack from the same end.

### Selection colors is about the selection

Three fixes to the section we borrowed from Sketch:

- It summarised the first selected layer. Both apps summarise the *selection*, so
  `colorUsageAll(nodes)` merges every selected layer, and a colour they share is
  still one row with a count of two.
- `paintColors` decides what a paint contributes: image and pattern fills
  nothing, gradients the colours in their ramp (a gradient's leftover `color`
  string would otherwise be listed as if it painted something), and hidden fills
  nothing.
- Each row has Figma's percentage field. It writes the base
  `fillOpacity` / `strokeOpacity` and any matching entry in `fills[]` /
  `strokes[]`, for the layers the row was built from: the selection, not the
  page, because quietly repainting something the designer never picked is worse
  than a narrower tool. One undo step for the whole row. Layers that disagree
  show `Mixed` until you set a value; out-of-range input clamps and the field
  snaps back to what was applied; Escape cancels without costing an undo step.

### Still open in this area

- **Pattern fills**, Figma's fifth fill type, have no UI and no painter. Scaling
  an image fill is the workaround we have.
- The **crop tool** is the other real gap. We have Crop as an image *fit mode* -
  the fill moves inside the layer - but not Figma's modal: crop handles, a crop
  value slider, an aspect-ratio picker, Resize to fit, ⌥ mirroring the opposite
  edge, ⌃ freeing the ratio, ⌘-dragging a corner to quick-crop, and
  non-destructive re-entry afterwards.
- Figma shows Selection colors only for a mixed selection; ours follows Sketch
  and shows it whenever there is a colour to list, since the count and the
  click-to-select are the useful part even for one layer.
- Reordering a paint is drag or the two buttons; there is no keyboard path yet.

Tests: 22 added to `parity.test.mjs` (12 contrast, 10 selection colors) on top
of the 162 from earlier rounds, 184 passing; `tsc -b` clean.

## Layers and selection vs Figma's two layer sections

The next two sections of Figma's docs - "Work with layers" and "Create and edit
layers" - are 27 articles, most of them about selecting and moving things rather
than drawing them. Measured against the app, a lot of it was already true:
arrows nudge and ⇧+arrows take the big step; the six alignment buttons carry
Figma's ⌥A/⌥D/⌥W/⌥S/H/⌥V and align a single layer to its parent; ⇧-clicking one
aligns a multi-selection to each layer's *own* parent; distribute keeps the
outermost layers where they are; `Enter` selects a child, `⇧Enter` the parent,
`Tab`/`⇧Tab` walk siblings; ⌘-click deep-selects, ⌘-marquee reaches nested layers,
⇧-click removes a layer from the selection; ⌥ held measures distances; ⌘/Ctrl
bypasses snapping mid-drag; booleans, flatten, outline stroke, copy/paste
properties, masks, sections, ruler guides and layout grids are all there. Seven
things were not, and all seven are now.

### The Scale tool scales content

`K` already existed as a drag mode, but it was a drag mode only: no panel, and
the drag did not even hold the ratio. Against the article it now behaves:

- With `K` armed, the Layout section grows a **Scale** block - a multiplier
  dropdown (0.5x to 3x), a field that takes any typed multiplier and clears
  itself afterwards, and the nine-point **anchor box** that decides which corner
  or edge holds still. Verifying with a 100x100 rect and the bottom-right anchor
  at 2x: `x 560 y 160 100x100 → x 460 y 60 200x200` - that corner did not move.
- Typing `W` while `K` is active sets `H` from the ratio, and a corner drag
  preserves the ratio on its own, with no ⇧ needed.  still constrains a plain
  resize, and - the half of the article that is easy to miss - **⌃ releases a
  ratio that is locked on the layer**: measured on a locked 200x100, a corner
  drag gave 248x124 normally and 248x108 with Control held.
- Scaling goes through the engine's `scaleProps`, which multiplies the subtree:
  child positions and sizes, stroke weights and per-stroke widths, font size,
  letter spacing, line height, corner radii, effect offsets/blur/spread, path
  points, auto-layout gaps and padding. A plain resize instead re-applies the
  parent's constraints and leaves content alone, and both halves are pinned by
  tests.
- While there, the property set was widened, because scaling a layer and leaving
  these behind is visibly wrong: the dash pattern (`strokeDash`/`strokeGap`),
  paragraph spacing and indent, and the auto-layout `min/max` limits - otherwise
  a layer shrunk to half stays trapped behind the minimum it had before.
- A multi-selection scales as one group (members are mapped through the same
  affine map, so gaps grow too) in a single undo step, and locked layers are
  skipped, as the article says.

### Equations in the numeric fields

Figma reads X, Y, W, H, rotation, font size and friends as arithmetic. The panel
used `parseFloat`, which quietly turned `120/3` into `120`. `ui/fieldExpr.ts`
now handles `+ - * / ^ ( )` with the documented precedence and a right-associative
`^`, plus the two forms that combine with the value in the field: `+10` means ten
more than now, `*2` doubles it. Refusals matter as much as parses: a division by
zero, an unbalanced paren or a NaN leaves the field showing what the document
actually holds, and unit suffixes keep the old leniency, so `120px` is still 120.
Live typing is untouched - `12/` while you type must not move the layer - so
evaluation happens on commit.

### Reaching the layer you mean

- Right-click offers **Select layer**, the list of everything under the cursor in
  Layers-panel order: a container above the layers inside it, topmost first,
  hidden layers left out and **locked layers kept with a padlock**, since that
  menu is how you select a locked layer at all. Picking a row selects only that
  layer. Verified: right-clicking a rect inside a frame listed
  `Frame, Rectangle`; choosing `Frame` moved the selection to the frame.
- **Select all with same** covers Figma's Edit-menu list - Properties, Fill,
  Stroke, Effect, Text properties, Font - matching on paints (base and extra
  lists, hidden paints ignored), effect parameters, and the whole type recipe.
- **Select matching layers** (`⌥⌘A`) implements the article's rule rather than a
  name search: same layer name, same ancestor names, same depth in the
  hierarchy, and never the same top-level frame - the point is the copy in the
  *other* frame. Text layers are the documented exception: a layer still named
  after its content is identified by its typography, so two buttons that read
  "Submit" and "Send" match while a renamed one must match by name. The canvas
  run showed the nested `Rectangle` in both frames selected together, and the
  first version of the key matched a *loose* layer to a nested one as well,
  which is how the depth ended up inside the key.
- **Select inverse** (`⇧⌘A`) takes everything at the same level that is not
  selected, scoped to siblings because ⌘A is; a toast says so when nothing
  matches, rather than clearing the selection silently.
- The Layers panel gained **Collapse all layers**, which folds every expanded
  container but leaves the selected layer's path open (measured 4 rows → 3 with
  a layer inside one frame selected).

### A submenu that moved out from under the pointer

Wiring these made an existing defect obvious: the context menu re-measured its
own height on every render and re-centred vertically, so opening a submenu grew
the list, shifted it by about a row, and the row under the pointer changed - the
wrong submenu opened, or the right one closed. The position now freezes while a
submenu is open, and a submenu also opens on click, `→` or `Enter` (hover-only
menus were unreachable from the keyboard and on touch). The shortcuts sheet
gained the two new chords, and a duplicated "Annotate selection" row that had
been sitting in the list went with them.

### Still open in this area

- **Multi-edit text** and **Multi-edit variants**: with several text layers
  picked, Figma shows a *Multi-edit text* button (and `Enter`) that edits them all
  at once; `Q` does the same across variants. Ours edits the first layer.
- **Tidy up** - distribute's stricter cousin, which arranges a selection into a
  1D or 2D grid from its top-left and reports the mode spacing - is not
  implemented; distribute is.
- **Changing the rotation origin** (`⌥R`, then dragging the target) is not
  implemented; rotation is always about the centre of the selection.
- Figma blocks scaling layers nested inside a component instance. Our resize path
  does not distinguish instance children, so it lets you do it.
- Matching objects inside **sections** are scoped to their section in Figma; our
  matcher ignores sections.
- Point dragging in vector edit has no equivalent of Figma's **Snap to
  geometry**, and the three snap preferences are two toggles here (the grid
  button, ⇧ for pixel snap) rather than a preferences row.
- Smart selection / tidy-up spacing handles, and the view-only selection outline
  (dashed parent box) belong to the prototype and commenting rounds.

Tests: 56 added to `parity.test.mjs` (17 equations, 8 scale geometry, 22 selection
helpers, 9 engine content-scaling) - 240 passing; `tsc -b` clean.

## Strokes, effects and corner radius

Three sections of the design panel that Figma documents together, so they went
in one pass. The official articles are the source for every number here; where
the panel and the article disagree, the article won.

### What the rules turned out to be

- Stroke **position** (Inside / Center / Outside) belongs to every shape except
  lines and arrows, which are centre-only, and the **weight is not part of the
  layer's dimensions**. A layer stacks several strokes, each with its own
  colour and opacity; only colour styles apply to them.
- **Individual strokes are only for rectangles, frames, components and
  instances** - `All | Top | Right | Bottom | Left | Custom`, four weight
  fields, and a side set to `0` simply goes away. Ellipses, polygons, stars,
  text and vectors do not get the choice at all.
- Dashed strokes carry a **dash cap** (None / Round / Projecting), a custom
  pattern is a plain `dash, gap, dash, gap...` list, and Figma starts and ends a
  dashed line with a **half dash**. The dotted recipe is centre position, weight
  and dash both 1, gap 0 or 1, round cap.
- **Join** is Miter / Bevel / Rounded with a **miter angle** threshold, not the
  SVG miter limit: at a threshold of 90 degrees, every corner of 90 degrees or
  tighter is bevelled.
- Effects are capped per layer: **8 drop shadows, 8 inner shadows, 2 noise, one
  layer blur, one background blur, one texture, one glass**. `+` opens on Drop
  shadow, rows drag to reorder, and the list order is the paint order.
- Corner smoothing is a **whole-shape** property: the independent-corners panel
  carries one slider for all four corners, never four, and the `iOS` button sets
  it to 60%. **Individual corner radius cannot be set on an instance.**

### The per-side strokes that only painted their corners

Per-side strokes are painted by clipping the shape, stroking it full-weight, and
letting each side keep only its own wedge. My first version clipped to a cone
drawn from the centre of the box to each corner - which is exactly right for a
square and wrong for everything else: on a 200x120 rectangle the top band ended
more than a third short of the top edge. Counting red pixels along the top and
bottom edges gave **1360 of about 2400**, with the corners reaching 140 and the
middle not painted at all.

The fix was to build each wedge the way CSS does it: the 45 degree lines through
the *box corners*, so every side owns a trapezoid (a triangle at a square
corner) that meets its neighbours on the mitre. Same box after that: top band
**2476 pixels**, tapering to 37 at each end exactly where the side mitres fall;
Right and Left 1228 each; custom weights `40 / 4 / 4 / 4` put 3569 pixels on the
top band against 304 on the sides, the 10:1 ratio the fields asked for.

The audit caught a second bug on the way, one that no screenshot review would
have caught: `clip()` does not disturb the current path, but *building* the
clipping polygon does - `beginPath()` wipes the shape that was traced a moment
earlier, so the stroke went round the clip wedge instead of the shape. That is
why both the canvas and the export painter now re-trace the shape inside the
clip before stroking. `closePath()` before `clip()` matters too, or the wedge is
open on the outer edge and paints to infinity.

### Miter angle, dashes and the export path

The inspector takes Figma's **angle** (10 to 179 degrees, default 90) and the
export takes SVG's `stroke-miterlimit`; one helper converts between them, and the
limit is clamped so no threshold ever bevels everything. Converting the
threshold rather than the corner means a square corner lands exactly on the
boundary, which is the article's "90 degrees or less" rule. Measured on a fresh
rectangle with a 20 px centre stroke: threshold 0 (every corner bevelled) 11566
pixels of ink with 552 at the corner; threshold 179 (nothing bevelled) 11346 and
497 - identical to pressing Join Bevel, as it should be. A 90 degree threshold
exports `stroke-miterlimit="1.414"`.

Dash and gap are number fields; the custom pattern is a list. Figma caps a
custom dash at 12 pairs, refuses a dash or gap above 1000, and reverts
nonsense rather than accepting it - the field marks itself invalid and puts the
old value back. The pattern round-trips (`12, 6` stays `12, 6`), reaches the
export as `stroke-dasharray="12 6"`, and the starting offset is half a dash so
the line opens and closes as the article says it should. Round dash caps are
visible where they belong: 23386 pixels of stroke ink with None, 34761 with
Round.

Both things went through the *same* helper as the canvas, which is how I checked
them: the SVG export preview is read back from the DOM rather than eyeballed in a
PNG, so `stroke-dasharray`, `stroke-miterlimit`, the per-side `clipPath` and the
corner curves (`M 55.8256 0 C 105.637...`, 55.83 = the reach of a 40 px radius
under a 60 % smoothing) are all asserted against the string.

### Effects: the budget, and the order

The `+` menu now shows how full each kind is (`Drop shadow 7/8`) and disables
what cannot fit, so the limit is visible before the click rather than after.
Reaching 8 drop shadows and clicking the disabled ninth item leaves the row count
alone; `Layer blur` stays available next to it. Reordering is a grip drag, and
the helper that does it *moves* the row rather than swapping two, so a row
dragged past the last lands last; one `⌘Z` puts the order back (measured:
X=5/10/15 becomes 10/15/5 after dragging the first row to the bottom, then 5/10/15
again after undo).

### Corners, and the instance rule

Canvas handles and inspector fields now share one corner order. My first
indicator drew the radius arc on whichever two corners the loop index happened to
hit, so a shape with only the bottom-left rounded showed an arc at the
bottom-right; the pins were laid out `TL, TR, BR, BL` while the array is
`[tl, tr, bl, br]`, so dragging the handle at the bottom right edited the bottom
left. Both come from `cornerSlots` now, and the arc is drawn only on corners
that actually have a radius. `⌥` on the handle is one corner (rectangles, per
the article), plain drag is all four, `←`/`→` nudge one step, `⇧` a big one.

Smoothing is a 0-100 percent slider with the `iOS` preset in the independent
corners panel, kept out of the collapsed row because it is not a per-corner
value. It is stored as a fraction; the exported geometry carries it as
B'zier handles at 0.8923 of the corner distance and a reach of 1.39564 r, which
is what pulls a rounded rectangle into a squircle: the ink started 21 px from
the corner at 0 % smoothing and 16 px at 60 %.

Figma refuses individual radii on an instance, so `insideInstance()` answers
"this layer or an ancestor is an instance", the four corner fields disable with
a one-line note in place, the toggle cannot open them, and `⌥`-dragging a canvas
handle on an instance says why instead of rounding all four corners behind your
back. The predicate is unit tested; the drag path is not yet exercised by hand,
because there is still no "Create instance" command in this app - that belongs
to the components round, and when it lands this is the rule it has to respect.

### What this pass deliberately left alone

Blending and compositing of effects (Figma gives every effect a blend mode,
plus "Show behind transparent areas" on drop shadows); progressive blur; the
brush and dynamic stroke styles, which are Figma Pro, and width profiles, which
need a pen round the UI cannot express yet; and the hover-preview of each
option in the position, cap, join and effect menus, which needs a canvas preview
surface rather than a tooltip. Each is listed again under *Open*.

Tests: 66 assertions added to `parity.test.mjs` (side masks, the wedge
geometry, the dash parser, the angle-to-limit conversion, effect budget and
move, corner slots and smoothing, the instance rule) - 306 passing; `tsc -b`
clean.

## Blend modes, and what a shadow shows through

The small list the strokes/effects round left open: an effect's blend mode,
"Show behind transparent areas", and the two places Figma refuses to touch a
layer that lives inside an instance. Two defects turned up on the way, one of
them a paint bug that had nothing to do with the plan.

### One list, where there had been three

The layer menu, the fill colour picker and the canvas each carried their own copy
of Figma's blend-mode list, and the copies had drifted: "Plus darker" and "Plus
lighter" were in none of them, and the canvas mapped the names through a table a
third the size of the menus. The fill stack was worse - it assigned its *label*
straight to a canvas operation, and a canvas ignores an operation it does not
recognise, so **every multi-word blend mode on a fill row silently did nothing**:
the menu writes `Soft light`, the operation is `soft-light`, and the assignment
was thrown away without a word. Measured over a mid-grey fill, a green row
labelled Soft light painted the same `0,255,0` as Normal; after the fix it paints
`16,128,16`.

There is one list now, in `ui/color.ts`, next to one name-to-operation helper
that the canvas, the engine's paint stack and the new effect rows all call. Two
of the eighteen names take a decision:

- **Plus lighter** is canvas's own `lighter` - `min(1, base + blend)`, exactly.
- **Plus darker** has no canvas equivalent, and "assign it anyway" is not an
  option, because an unknown operation is ignored rather than refused. Figma
  describes the mode as "like Darken, but with a stronger impact on mid-tones",
  which is the shape of color burn; the two also agree that blending with white
  does nothing. It maps to color burn, and the comment in the mapping says so.

### An effect carries its own blend mode

Figma offers a blend mode on three of the seven effects - inner shadows, drop
shadows and noise - so only those rows show **Apply blend mode**, and "Pass
through" is not in the menu, because the article says it cannot be applied to a
fill or an effect. The choice is stored on the effect (`Effect.blend`, "Normal"
by default) and applied while that effect paints. Same shadow, same backdrop,
one field apart, over `#3366cc`: `153,51,102` as Normal against `51,51,102` as
Multiply. An effect that predates the field paints as Normal, which the probe
checks too.

### Show behind transparent areas

Off by default, and off is the interesting state: the shadow is masked by what
the layer actually paints. For a shape with a fill that changes nothing - the
fill covers the whole outline either way - but a **stroke-only layer casts the
shadow of its ring**, not of the box it sits in. Measured on a stroke-only
rectangle over a `#3366cc` backdrop: the middle of the layer stays the backdrop
(`51,102,204`) and the ring goes to `0,0,0`; turn the checkbox on and the middle
goes to `0,0,0` as well, because the whole outline casts one.

Figma only offers the checkbox when the layer has something transparent for a
shadow to show through, and its article lists what counts: fills all under 100%
opacity, a stroke with no fill, a fill or stroke that blends with something
other than Normal, or a centre or outside stroke under 100% opacity. Our version
greys the checkbox out and says why when none of them holds - a fully opaque
layer cannot use the setting, so pretending otherwise would just cost a click.
Those four rules are unit tested, including the awkward one: an inside stroke at
50% is *not* enough on its own, because an inside stroke is entirely covered by
the fill.

### The inner shadow that ate the layer

The pixel probe found more than it was asked for. An inner shadow used to fill
the shape with the shadow colour and then punch the shape back out with
`destination-out`; on a real canvas that pass does not just remove the shadow's
source, it removes **the layer's own fill painted a moment earlier, and whatever
sat under the layer**. The probe found the hole by reading a transparent black
pixel where a `#808080` fill should have been.

It now does what CSS does for an inset shadow: clip to the shape, then fill the
ring between the shape and the edge of the canvas - even-odd, offset and blurred
- which casts the shadow inwards without ever touching the layer's paint. Spread
deflates that ring the way CSS deflates an inset shadow's hole. Over a `#808080`
fill with a 4px spread: ink at the edge `128,128,255`, centre still
`128,128,128`, and the same effect as Multiply `64,64,128`.

### Two more things Figma will not do to an instance

The Scale tool stops at layers inside an instance - "you can scale any object,
with the exception of locked layers and layers nested inside a component
instance" - and the aspect-ratio lock is unavailable on an instance's children
because the ratio belongs to the main component. Both ask the question the
individual-corner fields already asked, so they share `insideInstance`: a Scale
drag is refused with a toast, the Scale panel refuses its multiplier, and the
aspect button greys out with "Aspect ratio comes from the main component". A
plain resize is still allowed, because that is an override, which is what
instances are for.

### `⌥R`, the point a layer turns about

Figma turns a selection about the middle of its bounds, and lets you move that
point: `⌥R` reveals a target, dragging it moves the origin, and the layer then
turns about whatever you left it on. `Esc` puts it away again, which is how the
article describes it.

There is no need to change the renderer for this. A rotation about a moved
origin is the same spin plus a slide, so the pivot lands back where it started -
one helper does that arithmetic and both entry points call it, the canvas drag
and the `R` field in the inspector. A layer whose origin was never touched comes
out byte-identical to before, because spinning about the centre moves the pivot
not at all; the new assertions check that, plus the top-left corner holding still
through a quarter turn and the left edge holding through a half turn. The target
is drawn for a single layer: a multi-selection still turns about its bounds, as
before, and `⌥R` says so rather than showing a target that would do nothing.

### How this round was checked

The sandbox lost its Chromium during this session - the browser cache and the
probe harness both live outside the repository and did not survive - so the
pixel evidence here comes from painting through the engine's own `paint.ts` on a
Node canvas rather than from the app in a browser. Nineteen pixel assertions:
the mapping table, a shadow's own blend mode, the ring a stroke-only layer
casts, the inner shadow's ink and the fill it no longer erases, and the fill
stack's multi-word blends. The rest is covered by sixteen new engine
assertions - the four rules for the show-behind checkbox, the effect model's
limits, and the rotation origin's arithmetic - and by the build. What has **not**
been exercised is the pointer: the two instance guards, the effect popover's new
rows, and dragging the `⌥R` target are read-and-tested, not clicked. That is the
first thing to re-check when a browser is back.

Tests: 322 passing, up from 306; `tsc -b` and `vite build` clean.

## Fifty photographs, and why the canvas crawled

The first of the reported defects, and the one with a number attached. A file
with fifty images was slow to render, slow to zoom and slow to pan. It is not
the canvas: with fifty frames and fifty images on screen the painter holds 60fps
(measured in a headless Chrome, 1600x1000, at both 1x and 2x device pixel
ratios, pan and zoom both driven by real pointer and wheel events). What was
slow was the document.

Every imported image lived in the document as a base64 `data:` URL, and the
document is serialised on every autosave - twice, once for the session store and
once for the per-file store. Measured in the browser, with fifty images:

| per image | document | `JSON.stringify` | storage |
| --- | --- | --- | --- |
| 0.2 MB | 10 MB | 32 ms | over quota |
| 1 MB | 50 MB | 186 ms | over quota |
| 3 MB | 150 MB | 591 ms | over quota |

So a photographer's file froze the main thread for a fifth of a second every
time editing paused, and never fitted the 5MB localStorage budget at all - it
went to IndexedDB, which is why opening the file was slow too. This is not a
rendering problem, and no amount of painter tuning would have fixed it.

Pixels do not belong in a document; a reference does. Images now live in their
own store (`engine/assets.ts`, IndexedDB, one row per image) and a stored
document carries `asset:<id>` in `imageSrc` instead of the picture. In memory
nothing changed - a node's `imageSrc` is still a data URL, so the painter, the
exporters, the SVG and `.fig` importers and the fill picker are untouched - and
the swap happens only at the persistence boundary, on a copy, because
`engine.toDoc()` hands back live nodes and rewriting their pictures in place
would blank the canvas.

The ids are fingerprints of the image (length plus head and tail, cheap at any
size) so re-saving does not re-hash a three-megabyte string, and the same image
used twice in a document stores once. Assets are written the moment an image is
imported, not at the next save, so closing the tab mid-edit cannot lose bytes.
Old documents load exactly as they did - their data URLs are inline and stay
that way - and the first save moves them into the store. A document whose
assets are missing (opened in another browser) says so - "3 images could not be
loaded" - rather than showing empty frames.

Measured on the same fifty-photo file, 24.3MB of images: the stored document is
**156KB** with fifty refs and no data URL in it, and serialising it costs **1ms**
instead of ~90ms. The images still paint on open and still paint after a reload.

One trap for the next person: the asset database is opened at "whatever version
is there, plus one if the store is missing", not at a hard-coded version. A
database left at the hard-coded version *without* the store - which is what a
first run interrupted at the wrong moment produces - opens successfully and then
fails every write, and the version bump that would fix it is blocked by the
connection already open. The store heals itself now, and the tests cover the
round trip rather than the storage engine.

### Still to come from the same report

The other three - zoom behaving differently from Figma, a Figma file that does
not come across properly, and the SVG path - are the next passes, and are listed
under *Open* until they land.

## Zoom: what the report was about

The second of the four reported defects. The canvas was already anchored
correctly - measured in a browser, ⌘+wheel at a point off-centre holds the pixel
under the cursor to the byte, and stepping back out returns exactly what was
there, so the "zoom is different from Figma" was not the anchor. It was the
input.

Measured before: from 50%, one ⌘+wheel notch took the canvas to **136%**, and
two notches to **369%**. A wheel sends a whole notch per event, and every
ctrl+wheel event was being treated as a trackpad pinch - the exponential that
makes a pinch track the fingers 1:1 turns a wheel's 100-pixel notch into
`e = 2.718x`. A designer scrolling once lost their place completely, which is
what "doesn't zoom like Figma" feels like from the outside.

The gesture is now identified by the size of the delta rather than by the
modifier, which is set for both a pinch and a wheel: under 40 pixels is a pinch
and stays exponential, a whole notch is one fixed step (1.1x), and several
notches in one event are several steps with a cap so a flick of a
high-resolution wheel cannot cross the whole range. Line- and page-mode wheels
(Firefox, some Windows drivers) are converted to pixels first - three lines used
to be read as a three-pixel pinch and zoomed 3%, and panning had the same bug in
the other direction.

Measured after: one notch 21% -> **23%**, two -> **25%**, a five-event pinch
stream of -4 pixels -> **31%** (`e^0.2`, still 1:1 with the fingers).

Two more things from the article that did not match:

- **⇧+ and ⇧− double and halve.** Ours stepped through a private ladder, so
  from 100% the next press gave 150% where Figma gives 200%, and the zoom-out
  sequence a designer gets (100, 50, 25, 13, 6) was not reachable. Measured
  after: 31% -> 62% -> 124%, and back down 124% -> 62% in one press.
- **⇧2 with nothing selected does nothing.** Ours fell back to fitting the page,
  making it a second ⇧1. Measured after: the zoom is unchanged with an empty
  selection and goes to 100% for a selected 600x400 rectangle.
- **A file opens at Zoom to fit**, not at the viewport the last session left in
  the document - "any changes you make to zoom only apply in the current tab".
  Measured after: a file stored at 50% with a two-layer page 4,600x3,400 opens
  at **21%** with both layers on screen (two separate blue blocks in the
  screenshot), and a link naming a layer still lands on that layer.
- The zoom menu's default percentages are now the list Figma's field offers
  (2, 3, 4, 6, 8, 12, 16, 25, 32, 50, 64, 100, 128, 200, 256, 400, 512, 800,
  1024, 1600, 3200, 6400), two rungs per doubling rather than the four arbitrary
  values we had.

19 new assertions (353 total). The rest of this article came next; it is the
section below.

## The rest of "Adjust your zoom and view options"

The same article, every switch it mentions except the numbers the section above
already covers.

**Snap to pixel grid was wired to the other switch.** `pages[].pixelGrid` is the
*overlay* - drawn from 400% up, off by default. The rounding in `add`, `move`,
`nudge`, `resize` and paste/duplicate read that flag, so snapping was off unless
you had the overlay on, and turning the overlay on silently changed where every
new layer landed. The geometry now reads `pixelSnap` (on by default, ⇧⌘'), which
is the flag Figma's Snap to pixel grid owns. Measured in the engine: a rectangle
added at (10.4, 20.6) sized 30.4x40.2 lands at (10, 21) 30x40; dragging it by
+0.4/+0.6 rounds again; arrow nudges stay on the grid; resizing to
5.5, 6.5, 12.5, 9.5 gives 6, 7, 13, 10; and against the old coupling, with
snapping off *showing* the pixel grid does not start snapping, and with it on
*hiding* the pixel grid does not stop it.

Clicked through in a browser at 400% zoom, where a screen pixel is a quarter of
a design pixel: one drag draws X 505, Y 475, W 50, H 38 - all whole. After ⇧⌘'
turns snapping off, the same drag lands on X **580.25**, Y **475.25**, W
**50.25**. That chord was itself broken: with Shift held the quote key arrives
as `"` rather than `'`, so the handler - which matched on the character - had
never fired, and the snapping half of Figma's pair did nothing on a US layout.
It matches the physical key now (`e.code`), so ⌘' and ⌘⇧' work on any layout.

**Pixel preview** (View > Pixel preview, ⌃P for 1x, ⌃⌥P for 2x). Frames are
re-read as the raster they would export as - one device pixel per design pixel
at 1x, two at 2x - and drawn back over themselves with smoothing off. It is a
pass over the finished canvas rather than a second renderer, so the pixels being
resampled are exactly the ones the exporter would see, and the selection, rulers
and labels drawn afterwards stay crisp. Measured at 400% over a frame and an
ellipse: the blend between two flat colours runs a median of **1 px** live,
**4 px** at 1x (all 396 runs a multiple of four - one design pixel) and **2 px**
at 2x; shared (non-pure) pixels 0.247% -> 1.27% -> 0.512% of the canvas.

**Layout guides** (⇧G, or View > Layout guides) hides every frame's grid in one
switch without deleting anything. Measured: 93,021 grid pixels -> **0** ->
93,021 on the second press, with the grid still listed in the right sidebar.

**Property labels** spells out the fields the right sidebar only draws an icon
for: with it on, the Rotation field reads "Rotation" instead of the glyph. Off
by default, as in Figma, and the sidebar keeps its width.

**Zoom keeps the middle of the canvas still.** ⇧+, ⇧−, ⇧0 and the percentage
menu set the scale without touching the pan, and the pan is measured from the
canvas's top-left corner: press ⇧+ twice and the artboard has walked off the
right of the window. (This is how it surfaced - the first attempt at measuring
pixel preview found nothing on screen to measure.) `panForZoom` now re-aims the
pan so the design point under the anchor stays put: the middle of the viewport
for the keyboard and the menu, the pointer for a wheel, as before. Measured:
⇧+ twice from a file that opens at 75% holds the frame under the centre and
lands on 400% with the content still in view.

7 new assertions (407 total, 0 failed) plus the browser probe:
`/tmp/probe/view_menu_probe.mjs` (all of the numbers above) and
`/tmp/probe/proplabels_probe.mjs` (the label itself). Screenshots:
`view_preview_off.png`, `view_preview_1x.png`, `view_preview_2x.png`,
`view_guides_on.png`, `view_guides_off.png`, `proplabels_on.png` in `/tmp/probe`.

Left from this article: **multiplayer cursors** (nothing to show until there is
multiplayer, but the toggle and its ⌥⌘\ belong in the same menu) and
**prototype flows** as a view option - the 3D-looking canvas menu Figma's
article describes is otherwise now this app's zoom field menu plus the canvas
menu, which between them carry every switch above.

## The export, held up against Figma's settings table

Figma publishes a capability table for its export settings - which format takes
which option - so this round is that table, implemented and then checked against
the bytes that actually landed.

**The scale field.** Ours cycled through five fixed multipliers, so there was no
way to ask for a size. Figma's field takes a multiplier or a size with a unit:
`2x` is twice the layer, `500w` is 500 wide with the height following the aspect
ratio, `300h` is 300 tall with the width following it, and `1.5x` and `0,75x`
are both fine. Measured on real downloads of a 400×320 rectangle:

| typed | file | pixels |
| --- | --- | --- |
| `1x` | Rectangle 1-1x.png | **400×320** |
| `2x` | Rectangle 1-2x.png | **800×640** |
| `1.5x` | Rectangle 1-frac.png | **600×480** |
| `500w` | Rectangle 1-w500.png | **500×400** |
| `300h` | Rectangle 1-h300.png | **375×300** |

**SVGs and PDFs are 1x.** The article is explicit - "Figma only supports exports
for SVGs at 1x" and the same for PDFs - and ours offered 0.5× to 4× for every
format, which is an output nobody asked for. The scale field now reads a locked
**1x** for those two formats rather than accepting a number and ignoring it.
Measured: the field is gone, the readout says 1x, and the exported SVG of the
same rectangle is 400×320.

**The settings table.** Figma's five markup settings were absent and the two
raster ones were hard-coded. There is now an "Export settings" button on each
row, and the panel is *built from* the capability table rather than written out
per format, so a control cannot appear for something the exporter does not do:

| Format | Ignore overlapping | Bounding box | id attribute | Outline text | Simplify stroke | Quality | Resampling |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PNG | ✓ | ✓ | | | | | ✓ |
| JPG | ✓ | ✓ | | | | ✓ | ✓ |
| SVG | ✓ | ✓ | ✓ | | | | |
| PDF | | | | | | ✓ | ✓ |

Measured in the panel: the SVG row offers the three markup settings with
"ignore overlapping" and "bounding box" on, and the PDF row offers resampling
and quality with Figma's defaults (Detailed, Medium) and no markup settings at
all. Ticking "id attribute" changes the real file:

```
without:  <svg xmlns="..." width="400" height="320" viewBox="0 0 400 320">
with:     <svg xmlns="..." id="Rectangle-1" width="400" height="320" viewBox="0 0 400 320">
```

A layer called "Card / Header" becomes `id="Card-Header"`, not `id="Card` and an
unparseable rest of the document - a name is not an id until it is tidied.

Two settings are implemented but not *changed* by anything we can honestly
claim: **Simplify stroke** is a switch between two spellings of the same
picture, and ours has only ever emitted the article's "off" form (double the
stroke width, then a mask or clip) - which the article says is the visually
identical alternative, and which we measured pixel-for-pixel in the SVG round.
**Outline text** needs a font engine to turn glyphs into paths; we export text
as `<text>`, which is the article's "outline text off" behaviour. Both are
listed under *Open* rather than half-built.

44 new assertions (492 total, 0 failed). Evidence: `/tmp/probe/export_parity.mjs`
(every number above), screenshot `export_settings.png`.

## Nudge amounts, and three themes instead of five

Two things reported together: "start the fixes from the inventory", and "why do
we have four themes, light dark and system, that all we don't need" plus "the
drop-down icon is different and other icons as well".

**Nudge amounts** (Figma's *Set small and big nudge values*). The arrow keys
were hard-coded to 1 and 10; Figma ships those as the *defaults* of a
preference, and the article's whole point is that you can change them - nudging
by a spacing token (8, 12, 16) is the common case, and being stuck at 1/10 means
holding the key down and counting. There is now a **Preferences › Nudge
amount…** entry in the actions menu, with the two fields Figma's dialog has, and
it applies as you leave a field (there is no OK button in Figma's, and there is
none here). Measured in a browser from X 412, Y 400:

| | X after the press |
| --- | --- |
| →, →, ↓ at the defaults | **414**, 401 |
| ⇧→ at the defaults | **424** (10) |
| after setting small 8, big 24 | small → **+8**, big → **+24** |

The values are app-wide and outlive a reload, which is where Figma keeps them.
A field only commits when it parses - typing a decimal point, or clearing the
field to retype, must not write a value - zero is refused (the keys would stop
working) and absurd values clamp. 15 assertions.

**Themes.** There were five: Light, Dark, and two near-duplicates - Graphite
(dark with a violet tint) and Daylight (light with warmer greys). Two extra
names over the same two colour schemes, so the menu asked a question with more
answers than there are. There are three now: **Light, Dark, System**, in the
actions menu and on the dashboard alike. The old preference values are *mapped*
rather than dropped - a saved `graphite` opens as Dark, `daylight` as Light -
which was checked by writing `graphite` into storage and reloading: the app came
up dark with the dark canvas. The two 100-line palette blocks and the three
one-off rules that named them are gone from the stylesheet; `--canvas`,
`--text` and the rest of the light and dark palettes are untouched, because the
audited colours in those two were right.

**Icons.** The complaint was that the drop-down chevron "is different". It was,
and so were a dozen others: call sites picked their own size, and 9, 10, 11, 12,
13, 14, 16, 20, 22 and 28 all appeared. The chevrons were the worst of it -
every one carried its own `strokeWidth` overrides (1.3 and 1.4 against the
spec's 1.25) - so a 9px chevron drew its stroke at 0.79px, lighter than the
glyph beside it. Fixed:

- the caret set is one size (`caretSize()`, 12) and one stroke weight, across
  the toolbar, the zoom field, the layers panel, the property rows, the fill
  rows, the context menu and the dashboard. Measured over the whole editor:
  **12 rendered carets, one width, 12px**.
- the panel-row tier was 13 (a size nothing else used) and is now 14, matching
  the majority of the rows that were already 14.
- a brand or empty-state mark was 20, 22 or 28 depending on where it was; 20 is
  now the single outside-the-scale size.
- the dock's caret gutter was 9px wide, so a 12px icon was clipped by its own
  box; it is 13px and the probe confirms no overflow.

Measured across the whole editor after: **81 icons, four sizes only - 12, 14,
16 and 20** - against ten before.

33 new assertions (448 total, 0 failed) plus `/tmp/probe/nudge_theme_icons.mjs`
and `icon_audit2.mjs`. Screenshots: `nudge_dialog.png`,
`icons_dashboard.png`, `icons_editor.png`.

## A frame's name, on the canvas

Reported from the running app: "Frame name is not properly visible incl canvas".
Two separate things, both real.

**The ink was under the contrast floor.** The name is text drawn straight onto
the canvas, and its colour was `--canvas-label` (`rgba(15,23,42,0.5)` in the
light theme) composited over `#f1f2f6`: **#808590, 3.31:1** - under the 4.5:1
floor for text, which is what made a frame's name read as decoration rather
than as the layer's name. The label is now pushed through the same
`nearestAccessible` search the colour picker's contrast check uses, against
whatever is really behind it: the page's own background when it has one, the
theme's canvas otherwise. Measured in a browser, sampling the ink and the canvas
out of the bitmap:

| theme | before | after |
| --- | --- | --- |
| light | 3.31:1 | **#6b6f78, 4.50:1** |
| dark | 5.16:1 | #848689, 5.16:1 (already passing, left alone) |
| graphite | 8.99:1 | #b3b3b3, unchanged |
| daylight | 5.48:1 | #5a5a5a, unchanged |

Hue and saturation are kept and only the value moves, so a theme's warm or cool
grey stays that grey. The three themes that already passed are untouched - a
"fix" that repainted them would be the bigger bug.

**Every frame was called "Frame".** Figma's first frame is "Frame 1"; ours were
all "Frame", so the Layers list and the names on the canvas were
indistinguishable the moment there were two. New layers now take the lowest
number of their kind not already in the page: Frame 1, Frame 2, Rectangle 1,
Ellipse 1, Frame 3. Numbering starts at one, matching Figma's own default names.

Two smaller things came with it, both from the same article-language: the name
now takes the accent colour when the frame is **hovered** as well as selected
(measured: the ink in the strip above the frame is `#6b6f78` idle, `#6366f1`
hovered, `#6366f1` selected), and the label pass skips frames whose name is
off-screen - it runs per frame rather than per visible pixel, so a page holding
hundreds of them was paying for `fillText` calls nobody could see.

`/tmp/probe/labelpalette.mjs` is the smallest proof (it dumps the strip's
colours); `framename_probe3.mjs` measures legibility and state across themes.
Screenshots: `labels_idle.png`, `labels_hover.png`, `labels_selected.png`,
`labels_dark.png`, `frame_labels_{light,dark,graphite,daylight}.png`.

## A Figma file that arrives as a Figma file

The third reported defect: "`.fig` import/copy incorrect". Imported through the
real UI, `OpenFigs.fig` - Figma's own logo, a frame around a vector - came in as
**two layers side by side**, a frame and a vector, with the vector sitting at
(0, 0) on the page instead of inside its frame. Three things were wrong, and all
three were measured before and after.

**Hierarchy was thrown away.** The importer read every node change in the file
and emitted a flat list, so nesting - the thing that makes a Figma file a Figma
file - was lost. Nodes carry `parentIndex`, which names the parent and holds a
fractional index string for the child's position ("`!`" first, "`~`" last), so
the tree is rebuildable exactly: children are grouped by parent and sorted by
that index. Measured now: `OpenFigs.fig` imports as **one frame containing one
vector**, and the layers panel shows the second row indented under the first
(measured x: 56 then 68). The file's own coordinates are kept rather than
re-based to the origin, which is what had moved the frame 655 points away from
where its author put it, and a page is a page - `circle.fig` imports as its
frame holding its ellipse, and a second canvas in the file becomes a second
page. Figma's `internalOnly` canvas (components' internals) is not imported: it
is not something a designer ever sees as a page.

**A vector was one contour out of twenty.** The logo is drawn as twenty separate
closed subpaths - the two big curves of the mark and eighteen seeds - and the
importer read the first `fillGeometry` entry with any points and stopped. On
screen that was a small white blob where the mark should be. Every contour is
now read, and they become one vector network with one closed loop per contour
(193 vertices, 193 segments, 20 loops), which is what a vector network is for: a
shape with holes in it. Measured after: the full fig mark with its seeds, one
layer in the layers panel, verified in the browser rather than from the parser.
A path with an open contour keeps its old segments-only shape - regions only
make a closed shape.

**Paints, effects and text were flattened to their first solid fill.** A node's
`fillPaints` and `strokePaints` are now read in full: solid colours with their
per-paint opacity and blend, gradients (linear, radial, angular, diamond, with
the ramp and the handle geometry), and images, which are pulled out of the
file's `images/` entries into the asset store so the layer holds a picture
rather than a colour. Also carried: effects (drop and inner shadows, layer and
background blur, their offsets, radii, spreads, blend and show-behind), the
layer's blend mode, opacity, hidden and locked state (a hidden layer used to be
dropped entirely), stroke alignment, cap, join and dashes, per-corner radii and
corner smoothing, and text weight, align, line height, letter spacing and
family. A container no longer paints a fill of its own; a frame's document
background is the page's business.

Verified in the browser through the app's own import button (dashboard →
"Import file…" → `OpenFigs.fig`) and its own drag-and-drop path (dropping
`sample.fig` onto the canvas: four layers, `Home`, `FigCard`, `FigDot`,
`FigLabel`, with their geometry intact). 12 new assertions (367 total), on the
real fixture files: nesting, loop count, coordinates, paints, and that the
internal canvas is not a page.

One thing this round could not check: none of the three fixtures carries a real
image, so the `images/<hash>` → asset-store path is written from the format
rather than from a file that exercises it, and is listed as unverified under
*Open*.

### A note on the behaviour suite

`npm run test:e2e` (`e2e/behaviour.mjs`) stops at its first check: it expects a
demo layer called "Chip" that the current sample document does not have. It has
been stale since the dashboard was rebuilt, so it cannot be used as evidence
until it is brought up to date with the demo file.

## The SVG export, held up against the canvas

The fourth reported defect. The exporter was reading a subset of the node model
and writing that, so the file disagreed with the editor. It now lives in
`engine/svgExport.ts` - pure logic over a node, no DOM - which is what let it be
tested and rasterised instead of trusted.

Fixed, each with an assertion:

- **Effects.** There was no `<filter>` in the file at all: a layer's drop
  shadow, inner shadow and layer blur were drawn on the canvas and missing from
  the export. Each effect now emits its own filter (offset, Gaussian with the
  standard deviation half the Figma radius, flood for the colour, morphology for
  a drop shadow's spread, composited for an inner shadow), and a layer with no
  effects emits none.
- **Vector networks.** `svgPath()` exported `n.path` - one contour - so anything
  built from a network (the pen tool's shapes, and every vector the `.fig`
  importer now brings in) exported as its first loop. Loops are exported as
  subpaths of one path, with the network's winding rule as `fill-rule`, which is
  what makes a hole a hole.
- **Gradients.** Two stops were written, taken from the `fill`/`fillB` pair, so
  a three-stop ramp exported as two colours. The whole ramp is exported now:
  three stops for a three-stop ramp, each with its own `stop-opacity`, and the
  radial radius comes from the handle the canvas uses.
- **Stroke alignment.** SVG strokes are centred; Figma's are not. An inside
  stroke is the doubled stroke clipped to the shape, an outside stroke is the
  doubled stroke masked out of it, and a centre stroke is written as-is.
- **Extra fills and strokes.** `fills` and `strokes` rows are exported in order,
  above the base fill and stroke, as they are painted.
- **Rotation origin.** The layer turns about its own `rotOrigin` (Figma's ⌥
  target) rather than always about its centre.
- **Hidden layers** are not written into the file.

Two more were found by looking at the result rather than the source, which is
why the check is a rasterisation and not a string match:

- **A transparent colour exported as opaque black.** `#00000000` is how the
  model spells "no fill", and the exporter was passing the colour through with
  its alpha dropped - so a transparent layer painted a black box over everything
  under it. Alpha-zero now exports as `none`, and a partial alpha (say
  `#000000aa`) multiplies into the element's `*-opacity` instead of being lost.
- **An outside stroke was masking the layer's own fill.** The fill and the
  stroke shared one `<path>`, so the mask that hides everything inside the shape
  hid the fill with it. They are separate elements now: a filled rectangle with
  an outside stroke showed no fill at all before, and shows both after.

Measured, in the browser, on a document holding a shadowed rectangle, a
three-stop ramp, an inside-stroked and an outside-stroked rectangle, a ring
built from a two-loop network, a two-fill rectangle and a clipping frame: the
exported file is rasterised and thirteen sampled pixels are checked against what
the canvas draws - the shadow is present below the layer and bounded, the ramp's
middle is the middle colour, the outside stroke shows outside the box and the
fill still shows inside, the ring's hole is a hole, the extra fills stack, and
the clipping frame clips. **13 of 13 pass.** The same run reads the export back
through `importSvg`: the round trip returns one 100×80 layer with its colour
intact. Behind that, 18 new assertions bring the suite to 385.

Also verified through the app's own menu rather than a harness: new file, draw a
rectangle, open Export, switch the preset to SVG, Export - and a valid
`<svg width="200" height="160">` file is what lands.

Still not what the canvas draws, and now listed under *Open*: angular and
diamond gradients (SVG has no conic gradient, so a linear ramp stands in),
background blur (no SVG equivalent), effect blend modes, and the image adjust
fields (exposure, contrast, saturation).

## Open

- Sketch's top-bar Insert menu and Figma's Assets panel tab, "Additional
  labels", and panel-width `⋯` overflow — real features in both apps, each its
  own project, none a defect today.
- The panel split handle (dragging the inspector wider) exists but has not been
  reviewed for the Dev Mode layout at narrow widths.
- Colour: pattern fills are not implemented, and image cropping is a fit mode
  rather than the interactive modal Figma has; both are written up at the end of
  the colour section above.
- Layers: no multi-edit text or variants, no tidy up, no rotation-origin drag,
  and instance children can be scaled when Figma refuses. Written up at the end
  of the layers section above.
- Strokes and effects: progressive blur, brush and dynamic strokes and width
  profiles are absent, and none of the position / cap / join / blend / effect
  options preview on hover the way Figma's do. Figma's *effect styles* (a saved
  shadow or blur that can be applied to other layers), and its shortcuts for
  copying effect settings and duplicating an effect with `⌘D`, are not built.
  The effect *settings* panels are still shallower than the article: noise has no
  Mono/Duo/Multi choice, no size X/Y and no colour-or-opacity switch, texture has
  no size X/Y or clip-to-shape, glass has none of its seven parameters, and
  shadow spread does not enforce Figma's restrictions (rectangles, ellipses,
  frames and components only, and for a frame, clip content plus a visible fill
  of at least 1%). Background blur does not check the 0.10-99.99% fill-opacity
  window it needs to be visible. Written up at the end of the section above.
- The instance guards added with the blend work - the Scale tool and the
  aspect-ratio lock refusing instance children - are unit tested but were not
  clicked through, because the sandbox had no browser left. Re-check them with
  one command the next time a browser is available.
- Export: **Outline text** (needs a font engine to turn glyphs into paths) and
  **Simplify stroke** (a switch between two identical spellings of an
  inside/outside stroke, of which we emit the article's default form). The
  **"ignore overlapping layers" *disabled*** case - exporting the layers that
  intersect the selection - is not built; the enabled case is what we already
  do, and is Figma's default. **Include bounding box** is honoured for the
  enabled case; the disabled case trims a text layer to its ink, which needs
  text measurement. **Colour profile** is sRGB only; Display P3 would need a
  colour-managed export path.
- The category audit is complete: all 4 chunks of the Figma Design category have
  been fetched and the whole catalogue is in the Inventory above. What is
  listed there without a tick has not been reached yet.
- From "Adjust your zoom and view options": **multiplayer cursors** (there is
  nothing to show until there is multiplayer, but the toggle and its ⌥⌘\\
  belong in the zoom field's menu with the rest) and **prototype flows** as a
  view option. The article's single "Zoom/view options" list is otherwise split
  across the zoom field's menu and the canvas menu, which between them now carry
  every switch it names.
- What the SVG export still cannot express: angular and diamond gradients (SVG
  has no conic gradient, so the export writes a linear ramp across the box as a
  stand-in), background blur (no SVG filter samples what is behind an element),
  effect blend modes, and the image adjust fields.
- `.fig` images: the `images/<hash>` → asset-store path is written from the
  format but no fixture in the repo carries an image, so it has not been seen
  working. Component and instance links are carried as plain containers - the
  file's components do not become editable masters (that is the "Build design
  systems" article, still uncovered), and a mirrored node arrives un-mirrored,
  because the node model has no flip.
- The behaviour suite (`e2e/behaviour.mjs`) is stale: it looks for a "Chip"
  layer the demo document no longer has, so it fails on its first check.
- Text styles on type fields, plus the wrapping settings the panel does not
  expose yet: percent letter spacing, OpenType and variable-font axes, hanging
  punctuation, whole-paragraph indentation, links in text, middle truncation.
  Listed in full at the end of the typography section above.
