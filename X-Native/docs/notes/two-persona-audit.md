# Two Figma users walk the app — what it tells them, how it answers

Date: 2026-09-24. Round: **communication + interaction audit** (the previous rounds covered
the editor surface, Dev Mode, minimise/hide, export — see `editor-interface-parity.md`).

## Method

Two personas, one real browser each pass, driven by a script so the same questions can be
asked again after any change:

| Persona | Who | What they were told to do |
| --- | --- | --- |
| **A — designer** | arrives from Figma, lives on the canvas | new file → frame → rect → text → auto layout → fill picker → component → undo/redo → ⌘K → help → Share → reload |
| **B — developer** | arrives from Figma Dev Mode, never edits | ⇧D → copy CSS → units → List click-to-copy → select-by-colour → ⌥ measure → ⇧T annotation → ⇧⌘E export → right-click → reload → follow a link |

Two things were recorded at **every** step, not just the visual result:

1. **What the app said** — a `MutationObserver` over `.toast` captured every message shown
   during the run, so the copy could be read as a set rather than one at a time.
2. **What the app did** — DOM state (layers, selection, panel sections, clipboard contents,
   files written by an export), plus `pageerror` for anything thrown.

Harnesses live outside the repo (`/home/user/browsertools/audit*.mjs`, recipe in
`editor-interface-parity.md`: `@sparticuz/chromium` + `puppeteer-core`, 1600×940, clipboard
permissions granted). Runs: `audit.mjs` (whole sweep), `audit2/3/4` (re-probes),
`audit5.mjs` (fix verification), `audit6/7.mjs` (menu, clipboard, deep link).

Headless caveats kept in mind while reading: the ⌘  ⇧ glyphs render as boxes (no Inter in
the sandbox image), and `clipboard.write([ClipboardItem])` for **images** is refused, which is
why Copy as PNG exercised its fallback rather than its happy path.

---

## Log A — the designer

| Step | What happened | What the app told her |
| --- | --- | --- |
| Dashboard → New design file | editor opened on an empty `Page 1` | **nothing at all** (before this round) |
| `R` + drag | rectangle drawn, both the row and the panel followed the selection | silent, correct |
| `T`, type, `Esc` | text layer named after its content | silent, correct |
| `⇧A` on a frame | auto layout on (direction / align / gap controls appear inside Layout) | no confirmation, no mention of `⌥A` |
| fill swatch | `.fill-pop` opens anchored under the row | correct |
| `⌘⌥K` | component created, panel shows the component block | silent |
| `⌘Z` / `⇧⌘Z` | undo/redo both land | silent — Figma is too, so acceptable |
| `⌘K`, type `comp` | palette listed **three** commands | two of them were *zoom* commands that don't match the query |
| `⇧?`… help | shortcuts sheet opens, search inside it works | fine |
| Share | clipboard got `Untitled · Page 1 · http://…` | toast said “Link copied” while the clipboard held a sentence |
| reload | every layer, the component and the viewport came back | — |

## Log B — the developer

| Step | What happened | What the app told him |
| --- | --- | --- |
| `⇧D` with nothing selected | Dev Mode empty state | teaches `⌥`-hover measure, `⇧⌘E`, `⇧D` — good |
| copy CSS from the code bar | CSS in a comment header | toast “Copied CSS” |
| units → `rem` | snippet re-renders in rem, no px left | — |
| List view, click a row | value lands on the clipboard | toast names the value (`125, 13`) |
| `⇧⌘E` | sheet with 3 exportables, 1 checked (the selected layer) | “Exporting 1 asset from "Page 1"” and a real file `Filter Sheet.png` on disk |
| `⇧T` → type → Enter | focus jumped into the note field, note posted | “Annotation pinned to Filter Sheet” |
| reload | **the annotation was gone** | and it never said so |
| right-click a layer | 24-row menu, correctly grouped | “Copy as code” had no shortcut; there was no Copy as PNG and no Copy link |
| hover anything | 56 tooltips, **all** native OS tooltips, 0 of them naming a chord | slow, unstyled, and silent about the keyboard |

---

## Findings, ranked

P0 = data loss or a claim that isn't true. P1 = a Figma user's muscle memory lands nowhere.
P2 = rough edge, P3 = polish.

| # | Sev | What Figma says / does | What X-Native said / did | Status |
| --- | --- | --- | --- | --- |
| 1 | **P0** | an annotation is part of the file — reload and it is still pinned | `PersistedDoc` had no `annotations` key *and* `validate()` rebuilds the document field by field, so any extra field is dropped: notes vanished on reload with no message | **fixed** — `annotations` added to the type, carried by `toDoc()`, restored by the constructor, filtered by shape in `validate()` |
| 2 | **P0** | “Copy link” puts a URL on the clipboard | Share put `File · Page · url` on the clipboard while the toast claimed “Link copied” — pasting into Slack produced a sentence | **fixed** — Share copies the bare file URL; the layer link is a separate menu command (see 8) |
| 3 | **P0** | the command list you type into never shows you commands you didn't ask for | the palette's item array contained `Zoom to fit` / `Zoom to selection` **twice**, rows were keyed by label, so React left ghost rows in the DOM: query `comp` showed two zoom commands above the real result, and a gibberish query showed those two ghosts instead of nothing | **fixed** — duplicates removed, keys made unique, plus a real empty state |
| 4 | **P1** | `Copy as code` is `⌥⇧⌘C` (Copy/Paste as ▸) | the command existed only inside the right-click menu, unmentioned and unbound | **fixed** — chord bound, menu row advertises it, palette entry added |
| 5 | **P1** | every tooltip that has a shortcut shows it (`Hide ⇧⌘H`, `Minimize UI ⇧⌘\`) | 56 `title=""` tooltips, none naming a chord, while the app has its own `<Tooltip>` used in ~17 places — two discovery systems, one of them mute | **partly fixed** — the layer-row and chrome affordances now carry their chords (`Hide layer (⇧⌘H)`, `Lock layer (⇧⌘L)`, `Minimize UI (⇧⌘\)`); the full sweep to one tooltip widget is open (P3) |
| 6 | **P1** | Figma's Add auto layout is `⇧⌥A`; `⌥A` is not free | we documented only `⇧A`. `⇧⌥A` already worked (the handler tests `shiftKey`), but the palette said `⇧A` and the help sheet listed two chips — nobody would find the Figma chord. Bare `⌥A` is Sketch's align-left and must stay | **fixed** — palette and help sheet now read `⇧⌥A`, help row says `⇧A also works`, comment in `bindHotkeys` records why bare `⌥A` is taken |
| 7 | **P1** | a brand-new file is not blank — it tells you how to start | a void canvas, no hint, no way out unless you already knew the chords | **fixed** — `.canvas-start` card: F frame · R rectangle · T text · `⌘K` commands · `⇧?` for the list. It disappears the moment the page has a layer, and it is a DOM overlay so it never reaches an export or a print |
| 8 | **P2** | handoff links name the layer (`…?f=…`); “Copy link to selection” is a menu item | the only link was the file; a developer pasting “look at this button” had to describe it | **fixed** — `linkForSelection()` + menu item; opening such a link switches page if needed, selects and frames the layer, and says so plainly when the layer is not in this copy of the file |
| 9 | **P2** | `Copy/Paste as ▸ Copy as PNG` puts pixels on the clipboard | we could only download a file; the last step of “send this to engineering” was manual | **fixed** — 2× PNG through the same `exportSvg`→canvas path as export; when the clipboard refuses images it downloads instead and says that's what it did |
| 10 | **P2** | a copy action reports the truth | `copyText()` swallows every failure (falls back to `execCommand`, then says nothing) while callers still toast “Copied …” | **open** — the fix is a `Promise<boolean>` from `copyText` and one shared “Couldn't reach the clipboard” toast; deliberately not half-done this round |
| 11 | **P2** | the panel copy and the menu copy of a layer agree | the menu/`⌥⇧⌘C` snippet is always CSS in px built inside the engine, so it ignores the Dev Mode language and the px/rem unit the developer picked one row above | **open** — needs `generateCss`/`devLen` lifted out of `ui/inspector.tsx` into a shared module; the engine cannot read UI preferences by design |
| 12 | **P2** | an empty panel and an empty canvas each say one thing | the Design panel's empty state repeated the canvas card's “Press F for a frame, R for a rectangle, T for text” verbatim | **fixed** — the panel now explains what it will become and what it is *right now* (page background + pixel grid), and points at `⌘K` |
| 13 | **P3** | annotations carry an author, a resolve, and can hold a measure | our notes are text pinned to a layer; no author, no resolve, `⇧M` measure cannot be attached to a note | **open** — listed below with the other Dev Mode gaps |
| 14 | **P3** | `Tab` hides the UI; `⇧R` rulers; panel `⋯` for width | not bound / not present; our `⌘\` `⇧⌘\` pair covers the important half | **open** — decide once, document in the help sheet |

Things the personas expected to be broken and were **not** worth changing: undo/redo
silence (Figma is silent too), selection following a drawn shape, the fill picker anchoring,
component creation feedback, List-view click-to-copy, units applying to every row, the export
sheet's default check, and reload persistence of geometry/components/styles/viewport.

---

## Verification of the fixes (same harness, after the edits)

```
V1a palette 'comp'    → ["Create component⌘⌥K"]
V1b palette 'zzzz'    → [] + “No command matches “zzzz” — try “component”, “export” or “zoom”.”
V1c palette 'zoom'    → ["Zoom toolZ","Zoom to 100%⇧0","Zoom to fit⇧1","Zoom to selection⇧2"]   (no dupes)
V3  tooltips          → "Hide layer (⇧⌘H)", "Lock layer (⇧⌘L)", "Minimize UI (⇧⌘\)"  (one backslash, verified by codepoint)
V4  share             → clipboard "…#/file/file_27" (bare link) · toast "Link copied — opens Untitled · Page 1"
V5  annotation        → posted 1 row → after reload 1 row, same text          survived: true
V6  persisted doc     → keys include "annotations", annotations: 1
V7  page errors       → []
audit7.1 copied link  → "…#/file/demo?f=frame_22"
audit7.2 open it      → expected "Filter Sheet", got "Filter Sheet", matched: true
audit7.4 start card   → present on a new file, gone after the first rectangle
audit6.V2 menu        → …,"Copy as code⌥⇧⌘C","Copy as PNG","Copy link to selection",…
audit6.V3 png         → clipboard refused images headless → "Clipboard cannot take images · downloaded the PNG instead"
audit6.V6 share       → "…#/file/demo" with `?f=` absent when nothing is selected
```

`tsc -b` clean, `npm test` 149/149.

---

## Open list, in the order this audit would take it

1. `copyText` honesty (#10) — one shared failure message, then every “Copied …” toast can be trusted.
2. Tooltip unification (#5): pick the `<Tooltip>` widget for anything with a chord, keep `title` for
   one-word rows, and stop mixing them inside a single panel.
3. Annotation depth (#13): author line, resolve/reopen, and “attach this measure to a note” for `⇧M`.
4. Clipboard images: prove the happy path once in a real browser (headless can't); the fallback is
   already written and honest.
5. Carried over from the previous round: Sketch-style Insert in the top bar, Figma's Assets tab and
   “Additional labels”, panel-width `⋯` menu, split-handle behaviour at narrow widths, slice-tool
   export, comment-tool ellipse, presentation frame corner clipping.

## Voice rules this audit produced

Say what actually happened, in the words the user just used (“Copied CSS”, not “Success”);
name the keyboard on anything clickable that has a chord; one idea per empty state; when a
failure is unavoidable, say what you did instead (“downloaded the PNG instead”); and never let a
message promise something the clipboard, the file, or the reload will not keep.

---

## Follow-up round — Dev Mode against Sketch's handoff docs and Figma's properties-panel doc

Sources read for this pass:
[Sketch · Developer handoff](https://www.sketch.com/docs/developer-handoff/),
[Sketch · Export](https://www.sketch.com/docs/developer-handoff/export/),
[Sketch · Viewing documents](https://www.sketch.com/docs/sharing-and-collaborating/using-your-workspace/viewing-documents/),
[Figma · Design, prototype, and explore layer properties in the right sidebar](https://help.figma.com/hc/en-us/articles/360039832014).

What the two docs say, and what we did about it:

| Doc behaviour | Ours before | Ours now |
| --- | --- | --- |
| Figma: right-click a layer → "Copy/paste as code (CSS, iOS, or Android), SVG, PNG, copy the link, or copy its properties" | three flat rows, one language (CSS), the rest of the languages only reachable in the panel | a **Copy/paste as ▸** submenu carrying every language the panel can render (CSS, Tailwind, SwiftUI, Compose, Flutter, SVG, JSON) plus PNG and the layer link; `⌥⇧⌘C` is labelled on the CSS row because it copies the *preferred* language |
| Figma: the panel's Code section and its copy button are the same answer | the engine built its own px CSS, so the two disagreed (finding #11) | `ui/devPrefs.ts` holds language + units; `copyLayerCode()` renders through `renderDevCode`, the very function the panel paints. Verified: panel says "Copied SwiftUI", the submenu's "Copy as CSS" says "Copied CSS · Filter Sheet" for the same layer, and the snippet follows the choice |
| Figma: with nothing selected the properties panel holds "styles and variables that are local to the file" | Dev Mode's empty state was three hints and nothing else | the empty inspect panel now ends in **Tokens in this file**: every colour and number variable plus the paint styles, grouped by collection, each row click-to-copy |
| Sketch: "download colour tokens as either CSS or JSON" (Layer/Text styles JSON only), and "as you change export settings you see a preview of the code, which you can copy" | no token export at all; a developer read colours off the Assets tab one by one | **CSS** and **JSON** buttons + a `tokens.json` download. CSS is `:root { --brand-primary: #0d99ff; … }` grouped by collection; JSON is `{ "brand": { "primary": { "value": "#0d99ff", "type": "color" } } }`. A note says numbers carry no unit, so `8` is not silently read as `8px` |
| Sketch: handoff is something you do in a browser without editing rights; Figma: view-only gets Comment + Properties | our `?f=` link landed the reader in edit mode | a handoff link now opens **already in Dev Mode**, on the linked layer |
| Figma: a `⌄` menu next to the zoom % carries "Property labels" | no such toggle; labels are inline everywhere | **declined for now**: the labels are JSX in ~40 call sites across both panels, and half-hiding them reads as broken. If it is added it must be one CSS-driven class on `.app`, not per-section flags |

Verification (headless pass, `audit8/audit9.mjs`): tokens block `rows: 5`, groups `Brand / Spacing / Radius`; token click copied `#0d99ff` with "Copied primary · #0d99ff"; CSS block began `:root {  /* Brand */  --brand-primary: #0d99ff;`; JSON parsed with groups `brand/spacing/radius`; `tokens.json` written to disk; language chosen in the panel was **still SwiftUI after a reload**; submenu listed all nine copy rows; the chord with no selection answered "Select one layer to copy its code"; `pageerror` count 0. `tsc -b` clean, 149/149 engine tests.
