# Response to the pasted P0/P1/P2 report — 2026-10-04

**Scope of this round.** A report arrived listing four P0s, seven P1s and a page of P2s.
Every claim was checked against the tree at `8fbda13` before anything was changed,
because this repo has twice been audited by a process that read one package and
concluded the feature was missing. Each row below carries the `file:line` that decides
it, and where the claim is already fixed it names the suite that pins the fix — a
comment is not proof, but a comment plus a test that fails when the behaviour regresses
is.

Three claims were real. All three are in the persistence layer, and all three were about
the one thing that matters more than parity: a document the browser refuses to hold.

## Verdicts

| Report claim | Verdict | Evidence |
|---|---|---|
| **P0** wheel zoom attached as a React prop, `preventDefault` ignored | **already fixed** | `Canvas.tsx:7971-8015`: a hand-registered listener on `wrap` with `{ passive: false }`, whose comment names this exact failure ("React attaches `wheel` passively at the root… zoomed the browser page *as well as* the canvas"), reads the live snapshot instead of captured state, and anchors the zoom on the cursor. `styles.css:760-767` puts `touch-action: none` on `.canvas-wrap`, with a comment tying it to the same handler. The suggested fix is the shipped code. |
| **P0** open paths default to `strokeAlign: "inside"` and lose their stroke | **already fixed** | `memory.ts:4164` `const cap = open ? "round" : "none"`, `:4176-4177` `strokeWidth: brush 8 / pencil 3 / closed 1 / pen 2` and `strokeAlign: open ? "center" : "inside"`; `memory.ts:173` gives line/arrow `center` at creation; `wasmVectorOps.ts:183-184` re-derives `center` for an open path even when the document claims otherwise. Pinned by `openPathStroke.dom.test.mjs` ("an open path stored inside still paints one band… never at the doubled width") and `strokeSidesBrush.test.mjs`. |
| **P0** no File menu, no explicit save, export buried, dashboard export reads localStorage only | **already fixed** | `chrome.tsx:752` "Before this the editor had no File menu at all"; `:900-930` File ▸ Save local copy (⇧⌘S), Open local copy… (`.json` picker at `:929-937`), File colour profile, Preferred profile, Export assets (⇧⌘E). The dashboard's copy reads `localCopyOf` → `readDoc` (localStorage, **then** the IndexedDB overflow) — `files.ts:166-186`, whose comment predicts this report's sentence: "asking `readDocSync` about them answers 'nothing stored locally'". Pinned by `exportPathway.dom.test.mjs` (27 assertions) and `persistence.test.mjs` §1-4. |
| **P0** quota returns `"saved"`; the IndexedDB fallback is write-only | **REAL — fixed** | `persist.ts`, details below. |
| **P1** align buttons silently fail on auto-layout children | **fixed, and the report said to verify it** | `layout.ts:880-917` `layoutKeyPatch` maps a spatial key onto main/cross by the flow's direction and refuses the main axis for an Auto-gap stack; `:1004` `insideStrokeWidth` is the same "the layout must know what the paint does" family. Verified, nothing changed. |
| **P1** inspector controls overflow the 240px panel | **fixed** | `min-width: 0` on the panel's flex chains (`styles.css:379, 528, 556, 747, 923, 1128, 1154, 1168`), which is what lets a nested row shrink instead of pushing the dash toggle out of the box. |
| **P1** Space+drag pan dies when an input holds focus | **already fixed** | `Canvas.tsx:245-260` `keepsSpaceKey` — a name that means "this field takes Space as a *character*" (textareas, contenteditable, `type=text`) — and `:1276-1279`, where the window-level handler lets Space through for every other focused control. The suggested "blur non-text inputs" is deliberately not what it does: blurring on modifier-key loss is a worse experience than not owning the key in a text field. |
| **P1** zoom range corrupted on reload | **REAL — fixed** | `persist.ts` validator against `view.ts:14-16`, details below. |
| **P1** "New file…" is destructive | **by design, and labelled as such** | `chrome.tsx:1738-1760`: a `danger` confirm whose body is "The file stored in this browser is deleted and a blank one opens. This cannot be undone.", with a comment explaining why it is that way (autosave made the document sticky, so the palette needs a way back to blank). `Dashboard.tsx:428-436` is the non-destructive path (`createFile` from a template). Not a defect; a note on wording is below. |
| **P2** no tooltips, no empty states, Escape does not cancel a drag, inconsistent focus | **mostly stale** | `tooltip.test.mjs`, `firstRun.test.mjs` (empty-state card, its kbd chips "the empty-state recipe's"), `escape.test.mjs`, `modalkeys.test.mjs` are all in `npm test`'s chain. |
| **P2** "No stacked fills/strokes — no `fills[]` or `strokes[]` arrays" | **false as written** | `types.ts:726` `fills?: Paint[]` and `:730` `strokes?: StrokeLayer[]` exist and are read (`:508` explains the single-value fields describe the *bottom* entry); `patternFill`/`patternStroke`/`strokeSidesBrush` suites exercise them. What I did **not** audit this round is whether the authoring UI lets you reorder/duplicate a stack the way Figma does — that is a real question, and a different one from "the model has no arrays". |
| **P2** no "Copy as SVG", slash-named layers do not nest export folders, no shared styles/slots/multiplayer/device frames | **not verified as present; plausible gaps** | An SVG→clipboard path exists (`inspector.tsx:9458` `rasterizeSvgToClipboard`) and the Dev-mode row copies code (`:4423`), but I found no `Copy as SVG` text row and no slash-to-folder logic in the bulk exporter (its suite has no nesting assertion). These are feature requests, not regressions, and none of them is data loss. |

## What was broken, and what it now does

The three real defects were one story: **the autosave slot's overflow tier was a
write-only promise.**

1. **`saveDoc` answered `"saved"` to a quota failure** (`persist.ts:248-283`).
   `SaveStatus` has a `"quota"` variant and `App.tsx:306-313` has a toast wired to it
   — "Document too large to autosave · export to keep a copy" — and neither could ever
   fire, because the catch mapped the one failure it should report to success. Now
   `if (!quota) return "error";` and the quota path returns `"quota"`.
2. **Quota left a *stale* document in the slot, and nothing read the backup.**
   `localStorage.setItem` throwing after a partial state means the slot holds
   yesterday's bytes while memory holds today's — and `loadDoc()` is synchronous, so
   `MemoryEngine`'s constructor would happily restore the old document and the user
   would keep editing it. The quota path now removes the slot (empty + a copy in
   IndexedDB is the honest state; stale + silent is not), and `loadDocHydrated()` (`persist.ts:179`) —
   async, `localStorage` then the overflow — is the reader. That removed
   `loadDocFromIdb`'s distinguishing property: it had **zero callers**, which made the
   whole multi-hundred-MB backstop decorative.
   No timestamps were added, because none are needed: the backup is issued *before* the
   slot write, and a failed slot write deletes the slot, so a present slot is never
   older than the backup. That invariant is stated in the source and pinned in both
   directions (the ordering as text, the reader behaviourally).
3. **The boot migration could not see an overflow document at all.**
   `migrateLegacyDoc()` reads `localStorage["x-native-document"]` to turn a pre-dashboard
   autosave into a Draft file. A document too big for `localStorage` — which is what any
   file with images in it is — was in IndexedDB, so the migration found nothing and the
   user's work was dropped on the floor at the exact moment the app decided to adopt it.
   `adoptLegacyDoc` (`files.ts:758`) is now the shared tail of both readers, and
   `migrateLegacyDocFromIdb()` is awaited by `App.tsx:104-118` on the home route,
   toasting when it recovers a file. The guard against adopting twice lives in the
   shared helper, so neither reader can drift from it.
4. **The validator carried a zoom range the engine had outgrown**
   (`zoom: num(v.zoom, 0.1, 8, 1)`, at `persist.ts:100` before this round, against `ZOOM_MIN = 0.02` / `ZOOM_MAX = 64` in
   `view.ts`). `num` does not clamp — it *replaces*, so a document saved at 1% or at
   2000% came back at exactly 100%, discarding where the user was looking. It now
   delegates to the engine's `clampZoom`, which also answers non-finite input with 1,
   so the fallback that `num` provided is kept without being duplicated. `view.ts:5-7`
   contains the comment recording that the 10%–800% clamp was once the whole range and
   was widened; this line was the last place still enforcing it.

## The bug this round made in its own source

Worth keeping, because it is the reason the sabotage convention is not theatre. The
edit that added the "issue the backup *before* localStorage" comment replaced the
comment **and its call line** — `saveDocToIdb(fullDoc).catch(() => {})` disappeared,
leaving a save path that no longer wrote the backup at all. `tsc` stayed silent (an
exported function with one fewer caller is not an unused local), and the suite stayed
silent until the new assertions were written *for that ordering*, at which point they
failed and the deleted line showed up in the diff. It is logged as a sabotage in
`persistence.test.mjs`'s header: *the `saveDocToIdb` call deleted from `saveDoc` → 1*.

The same file records a second harness lesson, learned while writing them: `saveDoc`
fires the backup and forgets it, so an assertion that *waits* for that write in jsdom is
a flake with extra steps — the first draft of the durability test polled the fake store
for eight ticks and read nothing. The claim was split instead: the ordering is a
property of the source and is pinned as text, the reader is behavioural and calls the
same `saveDocToIdb` with the write awaited. A test that needs a timer to pass is
asserting the scheduler, not the code.

## Tests

`persistence.test.mjs` 49 → **77** assertions, in a new §5 ("The slot's own overflow").
Eight sabotages, **eight caught**: quota answering `"saved"` again (2), the quota path
leaving the stale slot (2), `loadDocHydrated` reading the slot only (2), the boot rescue
dropped from `App.tsx` (2), `zoom` back to a second range in the validator (4), the
rescue wired but never announced (1), the adoption guard dropped from the shared helper
(1), the backup call deleted (1). Values are recomputed where they can be — the zoom
test imports `ZOOM_MIN`/`ZOOM_MAX`/`clampZoom` from `view.ts` rather than typing 0.1/8/64,
so widening the range there moves this test with it instead of leaving it behind, which
is precisely the mistake the validator had made.

One more honesty note about a §5 pin: `clearDoc`'s IndexedDB delete is fire-and-forget,
so the test asserts that `clearDoc` *reaches for both tiers* (source) and that the slot
is empty (behaviour), rather than awaiting a timer and calling it a guarantee.

**Gate.** `npm test` → exit 0, **2038** `ok` / 0 `FAIL`; `npm run build` → exit 0,
`✓ built in 5.12s`; `npx tsc --noEmit` clean under `noUnusedLocals` and `strict`; `drift` 24/0
with no ceiling moved (nothing here added a control or a `title=`). Adjacent suites
re-run standalone: `files` 6/0, `firstRun` 24/0, `exportPathway` 27/0,
`openPathStroke` and the canvas-chrome files unchanged and green.

## Not done, and why

The P2 list is a product backlog, not a defect list, and the two items on it that are
real — folder nesting for slash-named layers in bulk export, and a `Copy as SVG` row in
the context menu beside the existing PNG/clipboard paths — are each a small feature with
their own tests, not a fix. Full stack authoring in the inspector (reorder, duplicate,
toggle a layer of `fills[]`/`strokes[]`) is the largest genuinely missing piece I found
while checking the "no arrays" claim, and it deserves its own audit before its own code:
the model has the arrays, the renderer reads them, and what I could not confirm in an
hour of reading is whether every panel control reaches all of them.

Two wording items I noticed and did not change, so they are recorded rather than
silently ignored: "New file…" is destructive by design and its confirm says so plainly,
but the palette label could read `New file… (replaces this file)` so the danger is
visible before the confirm; and the "Save local copy" row in the File menu is an
*export* named as a save, which is the right trade for a browser app that autosaves, but
is the kind of sentence a report like this one can mistake for "no save at all".
