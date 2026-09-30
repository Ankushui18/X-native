# Product Discrepancy Report — Run 25: Foundation Fixes

**Date:** 2026-09-30 · **Branch:** `arena/01a0f1a8-x-native` @ `c98167b` · **Author:** Senior Product QA (audit only — no fixes written)
**Source of truth:** [Figma Help — Create designs](https://help.figma.com/hc/en-us/sections/4403912808599-Create-designs) and the individual Figma Learn articles cited per row.
**Scope (only):** ① Canvas navigation (zoom/pan) · ② Persistence (Save/Load) · ③ Basic layer creation & tool defaults (incl. Pen/Shape stroke defaults) · ④ Basic export.
**Method:** every claim is traced through UI → engine → renderer in `X-Native/apps/web/src`, then compared to the Figma article. Where behaviour is measurable head­lessly it was executed (see §6 Evidence log). No code was changed.

**Severity legend**
- **P0** — data loss, a core interaction that does not work, or output that is wrong/misleading.
- **P1** — clear break from documented Figma behaviour with a workaround, or a parity break users hit daily.
- **P2** — polish, edge case, or discoverability.
- **MATCH** — audited and correct; listed so the fix phase does not re-touch it.

---

## 0. Verdict on the three issues you reported

| # | Your report | Verdict | The honest version |
|---|---|---|---|
| 1 | "Canvas zoom/scroll is broken or behaves incorrectly" | **CONFIRMED (P0)** | The zoom *maths* are right (cursor-anchored, `Canvas.tsx:7101-7113`), but the wheel listener is **passive**, so `e.preventDefault()` at `Canvas.tsx:7100` is discarded by React 18. Ctrl/⌘+wheel and trackpad pinch therefore zoom **the browser page** on top of the canvas — the exact "zoom is broken" symptom. The repo's own perf notes classified this as *"harmless but noisy"* (`X-Native/docs/PERF_TRACK_BASELINE_2026-09-25.md:84`) — that classification is wrong. See N-01. |
| 2 | "There is no Save/Export option in the UI" | **HALF TRUE** | **Save: confirmed missing.** There is no File menu, no "Save", no "Save local copy", no save-to-JSON anywhere in the editor (the editor chrome ends at *Back to files / file name / Minimize*, `chrome.tsx:798-829`). **Export: exists but is buried** — a right-panel *Export* section (`inspector.tsx:8990-9116`) and an "Export assets…" dialog (`⇧⌘E`, `chrome.tsx:1563`). The real defect is that no *File* menu exposes either, plus the export/backup paths that do exist are broken in specific cases (N-07, P-03/P-04). See §2 and §4. |
| 3 | "Pen/Shape tools default to Inside stroke instead of Figma's Center" | **HALF TRUE — and the brief needs correcting** | Figma's own documentation says: *"Most shapes are set to **inside** by default, except for lines which are set to center."* ([Apply and adjust stroke properties](https://help.figma.com/hc/en-us/articles/360049283914)). So our `inside` default for rectangles/ellipses/frames is **correct** and must not be flipped. What *is* wrong: **open pen/pencil/brush paths are created with `strokeAlign: "inside"`** (`memory.ts:171` + `addPath` `memory.ts:4055-4078`), and because they are open, the renderer's inside-alignment clip is a **zero-area clip → the stroke is erased** (`Canvas.tsx:2139-2143`; the code 12 lines above documents exactly this failure for lines). Figma also documents brush strokes as **centre-only**. This is the real P0 hiding under your report. See N-12/N-13. |

---

## 1. Canvas Navigation

| Category | Feature | Figma Behavior | Our Behavior (File:Line) | Discrepancy / Bug | Severity |
|---|---|---|---|---|---|
| Navigation | **Wheel zoom cannot cancel the browser default** | ⌘/Ctrl+scroll and trackpad pinch zoom **only the canvas**; pinch tracks the fingers ([FD4B Navigate Figma Design files](https://help.figma.com/hc/en-us/articles/30925881896727)) | `onWheel` is a React prop (`Canvas.tsx:7099`) whose `e.preventDefault()` (`:7100`) is a no-op — React 18 registers `wheel` **passively** at the root. No native non-passive listener exists anywhere (`grep addEventListener("wheel")` = 0 hits; only `inspector.tsx:8290` sets `touchAction`) | Ctrl/⌘+wheel and pinch **also zoom the whole browser page**; Chrome logs `Unable to preventDefault inside passive event listener invocation` per event. The canvas and the app page fight each other — reads as "zoom is broken" | **P0** |
| Navigation | Zoom anchored at cursor | Zoom keeps the point under the pointer fixed | Maths correct: `wheelZoomFactor` + `setZoom` + `setPan` from the cursor (`Canvas.tsx:7101-7113`, `engine/view.ts:106-114`) | **MATCH** (once N-01 is fixed; today the default action pollutes it) | — |
| Navigation | Two-finger scroll pans | Trackpad slide pans in any direction | `pan` by `deltaX/deltaY` with line/page normalisation (`Canvas.tsx:7118-7125`) | **MATCH** | — |
| Navigation | Shift+wheel horizontal pan | Shift+scroll pans horizontally | `Canvas.tsx:7115-7117` | **MATCH** | — |
| Navigation | Space+drag pan | "Hold Space while clicking and dragging" ([FD4B](https://help.figma.com/hc/en-us/articles/30925881896727)) | Implemented: `Canvas.tsx:4665-4668` (grab), `:5798-5800` (drag), Space tracked at `:1061-1064` | **MATCH** in the happy path; two defects below | — |
| Navigation | Space+drag when focus is in a panel | Space always pans (it is not text) | The key handler returns early whenever the event target is inside `.inspector` etc. (`Canvas.tsx:1019-1027`) — *before* the Space branch at `:1061` | After clicking any inspector field/button, **Space stops panning** and instead activates the focused control. Figma has no such coupling | P1 |
| Navigation | Space released outside the window | n/a | Space state is only cleared by the window `keyup` (`Canvas.tsx:1061-1063`, listeners `:1411-1415`); no `blur`/`visibilitychange` reset anywhere | Hold Space, alt-tab, release: the canvas stays stuck in pan mode until Space is tapped again | P2 |
| Navigation | Middle-mouse pan | (Undocumented in Figma; expected to pan) | `e.button === 1` starts a pan (`Canvas.tsx:4665-4667`) but nothing calls `preventDefault` | Chrome on Windows/Linux starts its **middle-click autoscroll** widget at the same time as the pan | P2 |
| Navigation | **⇧2 "Zoom to selection"** | Fits the selection to the screen — magnifying small selections (a 24px icon fills the viewport) | `zoomTo(engine,"selection")` hard-caps at 100%: `clampZoom(Math.min(1, …))` (`zoom.ts:101`) | For anything smaller than the viewport, ⇧2 is really "centre the selection": it can never zoom in. Contradicts "fit selection to screen" | P1 |
| Navigation | Zoom range vs restored viewport | Viewport is restored exactly | Engine allows **2 %–6400 %** (`view.ts:20,25`) but `persist.validate` clamps a restored zoom to **0.1–8** (`persist.ts:88`) | Reload after zooming to 5 % reopens at 10 %; 3200 % reopens at 800 %. Silent viewport corruption; `view.ts:1-12` calls the 10–800 clamp a bug it already fixed | P1 |
| Navigation | Zoom menu / readout / keys | % field in the right panel; ⇧0 100 %, ⇧1 fit, ⇧2 selection, ⌘/Ctrl ± | `ZoomMenu` (`inspector.tsx:10010-10026`), `bindHotkeys` (`chrome.tsx:2705-2731`, `:2785-2811`), palette rows (`:1630-1632`) | **MATCH** (⌘0 and ⇧0 both work; ± works) | — |
| Navigation | Hand (H) and Zoom (Z) tools | H pans; Z click/drag zooms | `chrome.tsx:1023-1025`, `Canvas.tsx:4716-4734` | **MATCH** | — |
| Navigation | Safari pinch | Pinch zooms | Only the ctrl+wheel path exists; no `gesturestart/gesturechange` listeners (`grep` = 0 hits) | Safari's pinch gestures are unhandled; combined with N-01 the page zooms instead | P2 |
| Navigation | Pan cursor feedback | Open hand → closed hand while dragging | Cursor is always `grab` while panning (`Canvas.tsx:7894-7898`) | Missing `grabbing` state | P2 |

---

## 2. Persistence — Save / Load

| Category | Feature | Figma Behavior | Our Behavior (File:Line) | Discrepancy / Bug | Severity |
|---|---|---|---|---|---|
| Persistence | **File menu with Save / Save local copy** | Main menu ▸ **File ▸ Save local copy** downloads the document; every edit auto-saves to the cloud ([Save a local copy of files](https://help.figma.com/hc/en-us/articles/360040028114) / [Export from Figma Design](https://help.figma.com/hc/en-us/articles/360040028114)) | **No menu exists at all.** The editor chrome is *Back to files / file name input / Minimize* (`chrome.tsx:798-829`); the ⌘K palette (`chrome.tsx:1493-1640`) has no Save/Save-as/Save-copy row | **A user cannot write the document to disk from the editor.** Work lives only in browser storage (localStorage/IndexedDB). Nothing to recover after "clear site data", profile switch, or a different browser | **P0** |
| Persistence | **Save to JSON / Load from JSON** | Native `.fig` local copy (round-trips back in) | The only JSON write is the **Dashboard** row menu "Export a copy" → `${name}.x.json` (`Dashboard.tsx:673` → `:176-186`); the only JSON read is the Dashboard importer (`Dashboard.tsx:417-430`, accepts `.x.json`) | No Save/Load JSON anywhere in the editor; the dashboard path is 3 clicks deep, undiscoverable, and requires leaving the file | **P0** |
| Persistence | Dashboard "Export a copy" for image-heavy files | Export always works | `exportMeta` uses `readDocSync` — **localStorage only** (`Dashboard.tsx:176-181`); `files.writeDoc` deletes the localStorage copy when it exceeds quota and keeps only the IndexedDB copy (`files.ts:139-152`) | Any file big enough to need IndexedDB (i.e. with images) exports as *"Nothing stored locally to export"* — the backup you'd reach for is the one that fails | P1 |
| Persistence | Save indicator | Truthful state | The nav rail renders a static **"Saved"** button with a dot; its only behaviour is a toast ("autosaves locally · no history") — no binding to any save result (`chrome.tsx:161-169`) | Reads "Saved" even when the last write was dropped (see next row). A status pill that lies | P1 |
| Persistence | Quota / write failure reporting | n/a | `saveDoc` returns `"saved"` for `QuotaExceededError` (`persist.ts:224-231`); the `"quota"` status is **never produced**, so `App.tsx:274-283`'s *"Document too large to autosave · export to keep a copy"* toast is **dead code**. The IndexedDB backstop it writes (`x-native-db`) is never read back — `loadDocFromIdb` (`persist.ts:180-201`) has **zero callers**; engine restore only calls `loadDoc()` (`memory.ts:1452`) | A user whose document outgrew localStorage is never told, and the legacy slot's "durability backstop" is write-only | P1 |
| Persistence | Destructive "New file…" | File ▸ New design file creates a new file and leaves the current one alone | The palette's *"New file…"* deletes **this file's** stored document, then reloads (`chrome.tsx:1533-1549` → `App.tsx:236-242`) | The only "new file" affordance inside the editor destroys the current document; there is no non-destructive path without going Home first | P1 |
| Persistence | Multi-tab editing | Cloud merge | Two tabs on the same `#/file/<id>` autosave to the same key/IDB row (`App.tsx:255-300`, `files.ts:139-152`) | Last writer silently wins; no lock, no warning | P2 |
| Persistence | Version-mismatch document | Opens newer files with a warning | `version !== 1` → `{doc:null, corrupt:false}` (`persist.ts:58-60`, `:149-150`) | A future/older format is discarded **silently** (the corrupt path does toast, `App.tsx:327`) | P2 |
| Persistence | Per-file autosave after reload / corrupted doc | Durable | `files.readDocSync → readDoc → IndexedDB` fallback (`App.tsx:122-135`, `files.ts:154-166`); corrupt restores toast (`App.tsx:327`) | **MATCH** (the per-file path *is* recoverable — the defect is the legacy `saveDoc` IDB branch above) | — |
| Persistence | Autosave cadence | Continuous | 600 ms trailing debounce + `pagehide` flush + unmount flush (`App.tsx:255-300`) | **MATCH** | — |

---

## 3. Basic Layer Creation & Tool Defaults

| Category | Feature | Figma Behavior | Our Behavior (File:Line) | Discrepancy / Bug | Severity |
|---|---|---|---|---|---|
| Creation | **Open pen/pencil/brush paths default to `strokeAlign: "inside"`** | Brush/dynamic strokes are **centre-only** ("Brush and dynamic stroke types only support center strokes"); vector caps default **Round**; open paths are never inside-aligned | `node()`: `strokeAlign: kind === "line" \|\| kind === "arrow" ? "center" : "inside"` (`memory.ts:171`); `addPath` creates the vector with a **visible** stroke (2 px, `memory.ts:4069-4073`) and no align override | The engine hands the renderer an *open* path marked *inside*. The painter then doubles the line width and **clips to the (zero-area) traced path** (`Canvas.tsx:2139-2143`), while `traceVectorSegments` never closes the subpath (`Canvas.tsx:9484-9506`). Result: **straight pen/pencil segments stroke nothing; others lose the outside half.** The code 12 lines above explains the identical failure it already fixed for lines (`Canvas.tsx:2125-2137`) and the repo's own audit predicted the pen case (`X-Native/docs/MICRO_PARITY_GAP_2026-09-25.md:48-62`) | **P0** |
| Creation | Brush stroke alignment | Centre-only, per the same article; our own UI agrees | Inspector disables the alignment control for brush/dynamic with the tooltip *"Brush and dynamic strokes are centre-only"* (`inspector.tsx:6597-6607`) and the renderer forces centre (`Canvas.tsx:2130-2133`) — yet the stored value from `addPath` is `inside` (`memory.ts:171`) | Stored state contradicts the documented rule, the UI, and the renderer: export/clipboard read `inside`, canvas paints centre | P1 |
| Creation | **Stroke default for closed shapes must stay Inside** | *"Most shapes are set to inside by default"* ([stroke article](https://help.figma.com/hc/en-us/articles/360049283914)) | `rect/ellipse/frame/poly/star` → `inside` (`memory.ts:171`) | **MATCH — do not flip this.** (Corrects the brief: only *open paths* should be centre.) | — |
| Creation | Line / arrow alignment | Lines are centre-stroked, no Position control | `center` + inspector hides the control (`memory.ts:171`, `inspector.tsx:6594-6607`) | **MATCH** (fixed in a previous run) | — |
| Creation | New shape defaults | Fill `#D9D9D9`, no stroke, name "Rectangle 1"… | `memory.ts:144-150` (fill), `:167-174` (stroke off), `freshLabel` `:5377-5394` | **MATCH** | — |
| Creation | Click-to-create sizes | Click with a shape tool → 100×100; frame keeps the last-used size | `Canvas.tsx:6849-6859` (100×100), `:6955-6958` (last frame size) | **MATCH** | — |
| Creation | Polygon / star defaults | Polygon = triangle; Star = 5 points | `count: kind === "star" ? 5 : kind === "poly" ? 3 : 0`, `starRatio: 0.4` (`memory.ts:190-191`) | **MATCH** on counts (ratio value not documented by Figma — not audited) | — |
| Creation | Tool returns to Move after drawing | Yes (Slice stays armed) | `Canvas.tsx:7037` | **MATCH** | — |
| Creation | **Default end caps** | "**Round (default)**" for vector paths ([Vector networks](https://help.figma.com/hc/en-us/articles/360040450213)); repo audit Gap 3 says the same | `strokeCap: … "none"` for `vector` (`memory.ts:172-174`) | New pen/pencil strokes render butt/square ends where Figma is round — visibly shorter and squarer | P2 |
| Creation | Pencil defaults | "Pencil sketches with a **round 3px stroke weight in black**" ([Pencil tool](https://help.figma.com/hc/en-us/articles/4402723791511)) | `addPath` uses **2 px**, `#1e1e1e`, cap `none`, align `inside` (`memory.ts:4069-4075`) | Three of four documented defaults differ | P2 |
| Creation | Escape cancels an in-progress drag | Escape discards the shape being drawn | The key handler has no branch that clears `drag.current` (`Canvas.tsx:1013-1410`); Escape only handles pen-draft/boolean/point-edit/connections | A half-drawn shape cannot be abandoned except by finishing it and undoing | P2 |
| Creation | Text defaults | Inter is the default family; click = auto-width | `fontFamily: "Inter"` (`memory.ts:196`), click → `sizingW/H: "hug"` (`Canvas.tsx:6936-6940`) | **MATCH** on family/resizing model (default point size not stated in Figma's docs → not audited) | — |
| Creation | "Set default properties" | Right-click ▸ *Set default properties* saves the current style as the default for new layers | No such command exists; `node()` hard-codes every default (`memory.ts:135-230`); `grep "default propert"` = 0 hits in `ui/` | New layers can never adopt a user's chosen style within the session | P2 |

---

## 4. Basic Export

| Category | Feature | Figma Behavior | Our Behavior (File:Line) | Discrepancy / Bug | Severity |
|---|---|---|---|---|---|
| Export | **A visible entry point** | Main menu ▸ **File ▸ Export** (⇧⌘E) plus the **Export** section at the bottom of the right sidebar ([Export from Figma Design](https://help.figma.com/hc/en-us/articles/360040028114)) | Export section exists but is **collapsed by default** (`inspector.tsx:8990-8996`, `defaultOpen={false}`); bulk dialog only via ⇧⌘E / palette row *"Export assets…"* (`chrome.tsx:1563`, `:2825`) | The capability exists; the *File ▸ Export* menu row does not. With no menu and a collapsed section, "there is no export" is a fair user perception | P1 |
| Export | **Export while nothing is selected = export the page** | *"If you want to export the entire canvas of the current page, deselect everything"* then use the Export section | With no selection the right panel renders `PageDesign` + `DesignHealth` only (`inspector.tsx:246-252`) — no Export section | The documented page-export affordance is **missing**; only the bulk dialog covers it (`inspector.tsx:301-311` defaults to the page's top level) | P1 |
| Export | Per-layer SVG export | Select layer ▸ Export ▸ format SVG ▸ Export | Works: preset row (format/scale/suffix), preview, `runExport` → `downloadBlob` (`inspector.tsx:9040-9116`, `:9133-9141`), SVG writer `engine/svgExport.ts:736-770` | **MATCH** — you *can* export a selection as SVG today (add export → change format → Export) | — |
| Export | SVG of a rotated / flipped layer | Transforms preserved | `svgNode` emits `translate/rotate/flip` about `rotOrigin` (`svgExport.ts:552-563`); single-layer viewBox starts at the layer origin (`:765-768`) | **MATCH** | — |
| Export | Inside/outside strokes in SVG | "The SVG format only supports center strokes… the stroke will be simplified" | With `simplifyStroke` (default **on** for SVG presets, `svgExport.ts:737-740`) an inside stroke is outlined (`:302-323`) | **MATCH** for the file export | — |
| Export | SVG of an *open* inside-stroked path | n/a (Figma never puts an open path inside-aligned) | Clipboard flavour `exportClipSvg` (`svgExport.ts:775-797`) passes no opts → falls to the same degenerate clip construction (`:296-320`) | "Copy as SVG" of a pen stroke loses/mangles the stroke, mirroring the canvas bug N-12 | P1 |
| Export | "Copy as SVG" in the context menu | Right-click ▸ Copy/Paste as ▸ **Copy as PNG / Copy as SVG** | The submenu ships code languages, *Copy as PNG*, *Copy link* — **no SVG row** (`ContextMenu.tsx:273-284`), even though `exportClipSvg` exists | Missing menu row | P2 |
| Export | Slash-named layers export into folders | "button/pill/default" → nested folders | `runExport` downloads `${n.name}${suffix}.${ext}` (`inspector.tsx:9150-9155`) via anchor download | No folder nesting; names containing `/` reach the filesystem as-is | P2 |
| Export | Export scale rules | SVG/PDF at 1× only; PNG/JPG 0.5–4× | `FORMAT_CAPS.oneToOne` pins vector formats and disables the scale field (`ui/exportModel.ts:44-72`, `inspector.tsx:9055-9070`) | **MATCH** | — |
| Export | Suffix appended with no separator (`HomePage` + `draft` → `HomePagedraft.png`) | Yes | `inspector.tsx:9150` | **MATCH** | — |
| Export | "Show in exports" on fills | Fill section checkbox hides a fill from exports | Implemented for fills and extra paints (`inspector.tsx:6410-6454`, `:6329-6356`; engine `svgExport.ts:545`, `:376`) | **MATCH** | — |
| Export | Export of a *selection* of many layers | One file per layer, throttled | `jobs.forEach(…, i*220ms)` (`inspector.tsx:9101-9110`, dialog `:348-360`) | **MATCH** | — |

---

## 5. Test / harness coverage of these areas

| Area | What exists | What is missing |
|---|---|---|
| Zoom maths | `src/engine/__tests__/parity.test.mjs:762-780` (notch = 1.1, 4-notch step, burst clamp, pinch inverse, line/page conversion) | Nothing exercises the DOM wiring: no test asserts the wheel listener is non-passive, that `preventDefault` is honoured, or that the anchored pan stays put |
| Pan | Engine `pan`/`setPan` are undo-exempt and `treeRev`-exempt (`memory.ts:1855-1857`, `:1937`) — unit-level only | **No test drives Space/middle-mouse pan** (`keyboard26.test.mjs` has zero `pan` references); `e2e/behaviour.mjs` never calls `page.mouse.wheel` |
| Persistence | `src/engine/__tests__/files.test.mjs`, `history25.test.mjs` | No test for quota fallback, `loadDocFromIdb` (dead code), zoom clamp on restore, or the dashboard's IDB-only export failure |
| Tool defaults | `toolbar.test.mjs`, `inspector.test.mjs`, `strokeRendering.test.mjs` | No test asserts the defaults of a **newly created** pen/pencil/brush path (`strokeAlign`, cap, width) — the P0 would have been caught by one line |
| Export | `export24.test.mjs` | Nothing asserts the *open-path inside stroke* output or the clipboard SVG flavour |

---

## 6. Evidence log (how the P0s were verified)

1. **Passive wheel** — `Canvas.tsx:7099-7100` (`onWheel` + `preventDefault`) is attached as a React prop at `Canvas.tsx:8021`; `grep -rn 'addEventListener("wheel"' src` returns **0**; `styles.css:697-702` (`.canvas-wrap`) has no `touch-action`/`overscroll-behavior`. React 18 registers `wheel` passively at the root, so the call is discarded (reproduced by independent reports: [multivector#104](https://github.com/eharquin/multivector/issues/104), [Tumble-Code#378](https://github.com/krzychdre/Tumble-Code/pull/378)); the repo already observed the console warning and mis-filed it as harmless (`X-Native/docs/PERF_TRACK_BASELINE_2026-09-25.md:84`).
2. **Engine defaults executed, not read** — a `vite-node` probe drove the real engine: `add rect` → `{fill:"#d9d9d9", strokeWidth:0, strokeVisible:false, strokeAlign:"inside"}`; `addPath` (pen, open) → `{kind:"vector", fillVisible:false, strokeWidth:2, strokeVisible:true, strokeAlign:"inside", strokeCap:"none"}`; brush → `{strokeWidth:8, strokeAlign:"inside", strokeType:"brush"}`. This is what the canvas and the exporter receive.
3. **Zero-area clip** — `traceVectorSegments` (`Canvas.tsx:9484-9506`) issues `beginPath/moveTo/lineTo/bezierCurveTo` with **no `closePath`**; the inside branch (`Canvas.tsx:2139-2143`) does `ctx.clip(); ctx.lineWidth = w*2; ctx.stroke()`. Per the Canvas 2D spec a clip uses the path's *fill* region (open subpaths implicitly closed) → for a straight pen segment the region is empty, for a bent one only the enclosed sliver survives. The app's own comment at `Canvas.tsx:2125-2137` states this exact consequence for lines, and `X-Native/docs/MICRO_PARITY_GAP_2026-09-25.md:48-62` fixed it for lines/arrows while noting *"Same fate for any open pen path…"*.
4. **Restore clamp** — `persist.ts:88` (`zoom: num(v.zoom, 0.1, 8, 1)`) vs `view.ts:20,25` (`ZOOM_MIN 0.02`, `ZOOM_MAX 64`); `view.ts:1-12` documents the 10–800 range as a bug already removed from the engine.
5. **Dead quota path** — `persist.ts:224-231` can only return `"saved"` or `"error"`; `App.tsx:274-283` branches on `"quota"`; `loadDocFromIdb` (`persist.ts:180-201`) is never imported (`grep` = only its own definition); the engine restores through `loadDoc()` only (`memory.ts:1452`).
6. **Export path** — `inspector.tsx:8990-9116` (section + Export button) and `inspector.tsx:268-369` (dialog); `Dashboard.tsx:176-186` (`readDocSync`-only download).

*(Browser-level confirmation of items 1 and 3 — i.e. watching Chrome zoom the page while ctrl+scrolling the canvas, and a straight pen segment painting zero pixels — still requires a Chromium run; there is no browser binary in this sandbox. The code/spec case is unambiguous, but I will re-verify both from the fixed build.)*

---

## 7. Proposed fix plan (P0 first — **awaiting your approval, no code written**)

> **Correction to the planned order before it starts.** The brief says *"change the default `strokeAlign` from `inside` to `center` for all new shapes/paths"*. Figma's documentation says closed shapes are **inside** by default ([stroke article](https://help.figma.com/hc/en-us/articles/360049283914)); flipping them would be a *new* parity bug. The fix should be scoped to **open paths / vector networks / brush-dynamic strokes** (and the renderer/export guards for open paths).

**P0-1 · Wheel zoom + pan (N-01)** — attach the wheel handler natively with `{ passive: false }` on `.canvas-wrap` (remove the React prop), keep the existing maths, add a `touch-action: none` rule so pinch is not stolen. Guard `blur`/`visibilitychange` to clear the Space state (N-04). Tests: a DOM test that asserts a wheel event on the wrapper is *cancelable and default-prevented*, plus an e2e `page.mouse.wheel` check that Ctrl+wheel leaves `window.visualViewport.scale`/page zoom untouched and moves only `engine.zoom`.

**P0-2 · Persistence (P-01/P-02)** — add a real *File* menu to the editor chrome with **Save to JSON** (`engine.toDoc()` → `dehydrateDoc` → Blob download), **Load from JSON** (file input → `isDocSeedLike` → hydrate → open as a new file), and **Export assets…**; keep autosave. Reuse `files.ts` so the editor writes through the same store as the dashboard (and fix `exportMeta` to `readDoc(id)` for the IDB case, P-03). Tests: round-trip `engine → JSON → engine` equality; a file with an inline image survives the trip; `readDocSync`-null path still exports.

**P0-3 · Tool defaults (N-12/N-13)** — in `addPath`, set `strokeAlign: "center"` for open paths (and `strokeCap: "round"`, pencil width 3 px per the Figma article); in `node()`, leave `inside` for closed shapes and use `center` for `vector` **only when `closed === false`** (or add the open-path guard in the painter/export instead — decide with you, since it changes stored files). Tests: a creation test asserting the defaults of every tool's freshly created node; a paint test asserting a straight 2-point pen path draws its full width under both alignments.

**P0-4 · Export pathway (E-01/E-02/E-06)** — surface Export in the new File menu (⇒ the ⇧⌘E dialog), render the Export section when nothing is selected so the page can be exported per the Figma doc, and fix the clipboard/`exportClipSvg` flavour to outline open-path strokes like the file exporter does. Tests: page-export snapshot contains all top-level layers; copy-as-SVG of a 2-point pen stroke contains a filled stroke outline (not a clip).

---

## 8. Open questions I could not settle from the docs (need your call or a browser)

1. Is Figma's ⇧2 documented to *magnify* small selections? ("Fit selection to screen" implies yes; our cap at 100 % assumes no.) I recommend removing the cap for `selection` only.
2. Should the fix preserve `strokeAlign: "inside"` in already-stored documents (compatibility) or migrate open-path vectors to `center` on load?
3. Do you want a Save-to-JSON button in the toolbar (visible) or only inside a File menu? Figma uses the menu; the brief asks for buttons.
4. Chrome/Safari pinch parity: after the passive fix, do we also want `gesturestart` handling for Safari's non-wheel pinch?

---

**Nothing in this report has been implemented.** On your approval I will execute §7 in the order given (navigation → persistence → defaults → export), each with the listed tests, and re-run the full `npm test` suite (currently installable; `node_modules` was absent and has been restored locally for verification only).
