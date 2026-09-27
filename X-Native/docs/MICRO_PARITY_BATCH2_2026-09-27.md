# Comprehensive Micro-Parity Audit — Batch 2

Date: 2026-09-27. Branch: `arena/01a0e1ff-x-native`.
Scope: web editor issues **#1, #4, #11 only**. Batch 1 remains intact;
Batch 3 and unassigned issue #6 were not implemented in this turn.

Paths below are relative to `X-Native/`; `src/...` abbreviates `apps/web/src/...`.
The before-line references identify the code at the end of Batch 1 (the supplied
snippets used approximate locations and were not directly compatible with it).

## Findings → differences → fixes → regressions

| Audit item | Exact pre-Batch-2 evidence | Change and current source | Regression evidence |
| --- | --- | --- | --- |
| **#1 Stroke alignment dropdown — High** | `src/ui/inspector.tsx:6128-6145` already exposed Inside/Center/Outside through icons, not a dropdown. Defaults were already correct at `src/engine/memory.ts:135`. | `src/ui/inspector.tsx:6128-6144` replaces the icon segment with the existing shared `XSelect`. It patches alignment without dimensions, supports mixed/multiple selections in one undo step, and leaves lines/arrows centered. | `src/ui/__tests__/batch2.dom.test.mjs:27-78`: mounted dropdown, options/default, all alignments, dimensions/weight unchanged, spill/hit testing, outside SVG mask, undo, multi-selection and line/arrow exceptions. Chromium additionally sampled real outside-stroke pixels. |
| **#4 Outline text as individual glyph layers — High** | `src/engine/textVector.ts:261-419` returned one merged path/network. Both `src/engine/memory.ts:3766-3774` (Outline stroke) and `:3840-3853` (Convert text to vector) rewrote one text node. Flatten also consumed this merged API at `:3635` and `:3719`. | `src/engine/textVector.ts:431-489` adds `convertTextToGlyphPaths`, retaining the merged converter for Flatten. `src/engine/memory.ts:1671-1710` creates typed glyph nodes at the original sibling slot, selects them, preserves paints/effects and transforms, and guards locks/instance members. Both commands call it at `:3802-3809` and `:3875-3879`. | `src/engine/__tests__/glyphOutline.test.mjs:1-145`: 54 checks. The mounted Layers panel/menu test at `src/ui/__tests__/batch2.dom.test.mjs:80-92` confirms two named vector layers for “Hi”. Chromium also tested the actual context-menu action with browser raster tracing. |
| **#11 Boolean shortcuts — Medium** | The mapping already existed at `src/ui/chrome.tsx:2407-2431`, but the earlier alignment block at `:1997-2021` intercepted physical **Alt/Option+Shift+S**, dispatching align-bottom instead of Subtract. A second key-only listener would not solve that ordering bug and would mishandle macOS Option characters. | `src/ui/chrome.tsx:1997-2023` handles booleans before alignment (`:2024-2046`). Physical `event.code` remains authoritative; a key fallback covers events with no code. Existing Ctrl+Alt+Shift compatibility is retained. | `src/ui/__tests__/batch2.dom.test.mjs:94-140` exercises all four operations with physical codes, macOS Option characters, no-code events and the Windows Ctrl variant; checks one dispatch, preventDefault, undo, typing guards and modal guards. The Subtract collision failed before moving the block and passes afterward. |

## Why the supplied code was adapted

- **No unsafe casts:** new nodes are explicitly typed `XNode`; there is no
  `as unknown as XNode`. Engine-owned IDs, history and tree revisions are reused.
- **Outline is not Flatten:** changing the old converter's return type globally
  would also change both Flatten consumers. It intentionally remains one result.
- **Contours are not glyphs:** the dot/stem of “i” and inner/outer loops of “O”
  belong to one glyph. Browser and fallback conversion isolate a glyph first,
  then retain all of its contours in one EVENODD network.
- **Positions are applied once:** glyph results carry local geometry and explicit
  x/y placement, not cumulative x inside both the path and the node. Browser
  advances use prefix measurements; spaces advance without empty vector layers.
  Newlines, letter spacing and configured line height are covered.
- **Existing document structure is preserved:** replacement uses `splice` at the
  text layer's original sibling index rather than appending above unrelated layers.
  An in-flow auto-layout text item retains its original box as a group containing
  separately editable glyphs, avoiding new inter-glyph layout gaps. Ordinary
  text is replaced directly by sibling vectors. Empty/whitespace-only text is a no-op.
- **Independent edits:** glyph style arrays are deep-cloned rather than shared.
  In the flow-slot group case, group opacity/effects remain on the wrapper so they
  are not applied twice. Conversion is one undo/redo operation.

Official behavior reference checked:
[Convert text to vector paths](https://help.figma.com/hc/en-us/articles/360047239073-Convert-text-to-vector-paths)
explicitly distinguishes one-layer Flatten from individual-glyph Outline stroke.

## Files changed in this batch

1. `apps/web/src/ui/inspector.tsx` — shared stroke-alignment dropdown.
2. `apps/web/src/engine/textVector.ts` — per-glyph conversion, raster bearings and
   scale normalization, Unicode-safe iteration, dot/stem fallback for “i”.
3. `apps/web/src/engine/memory.ts` — shared typed text-outline replacement for both commands.
4. `apps/web/src/ui/chrome.tsx` — shortcut precedence and missing-code fallback.
5. `apps/web/src/engine/__tests__/glyphOutline.test.mjs` — 54 new checks.
6. `apps/web/src/ui/__tests__/batch2.dom.test.mjs` — 72 new checks.
7. `apps/web/package.json:11` — both new suites join `npm test`.
8. `docs/MICRO_PARITY_BATCH2_2026-09-27.md` — this audit/verification record.

No baseline tests were deleted, loosened or rewritten. Existing Batch 1 files
still appear in the cumulative Git diff, but were not edited in Batch 2.

## Validation gate

Run from `X-Native/apps/web`:

| Check | Result |
| --- | --- |
| `npm test` | **2,530 passed, 0 failed**, exit 0. Batch 1 baseline: 2,404; Batch 2 adds 126. |
| `npx tsc -b` | **Clean**, exit 0. |
| `git diff --check` | **Clean**. |
| Chromium workflow checks | **3 passed**, no page errors. |

The full suite retains its pre-existing React `act(...)` warnings. The passing
check count is the sum reported by the scripts, not a count of browser scenarios.

### Browser QA

Headless Chromium mounted the real Canvas, Inspector, Layers panel, context menu
and hotkey handler against a deterministic document, using the live Vite module
graph. This was targeted browser automation, not human/manual visual approval or
execution of the entire existing `e2e/behaviour.mjs` suite.

1. **Hi → right-click → Outline stroke:** two vector nodes named `Glyph "H"` and
   `Glyph "i"`, with 13 and 12 vertices respectively; both names appeared in Layers.
2. **100×100 rectangle with 10px red stroke → Outside:** a pixel 5px outside the
   left edge changed from `[255,255,255,255]` to `[255,0,0,255]`; w/h remained
   100/100 and stroke weight remained 10.
3. **Two overlapping rectangles → Alt+Shift+U:** one boolean with `op: "union"`
   and two children.

Chromium and its libraries were installed only in sandbox cache/temporary paths,
not in project dependencies or Git. This does not add a browser requirement to `npm test`.

## Renderer check and remaining limits

- **Web renderer: verified for the requested rectangle scenario.** The Canvas
  reads alignment at `src/ui/Canvas.tsx:1604`; the SVG implementation selects
  alignment at `src/engine/svgExport.ts:271-272` and uses an outside mask. Browser
  pixel sampling confirms the dropdown is not merely changing stored data.
- **Native Vello: pre-existing gap remains.** `crates/x-render/src/scene.rs:310-320`
  passes the original path to `scene.stroke`; `crates/x-render/src/text_geometry.rs:148-167`
  builds width/caps/joins/dashes but does not consume `options.align`. The native
  IR transports stroke options (`crates/x-render/src/ir.rs:818-833`), but this does
  not establish alignment-aware mesh/path offsets. No Rust renderer changes or
  Rust test/build claims are included; this is the separately scoped native work
  called out in the user's implementation note.
- **Typography is not certified as full Figma parity.** The existing outline
  mechanism is raster tracing with approximate fallback glyphs, not a complete
  font-outline/shaping engine. Grapheme clustering avoids splitting combining
  marks/surrogate pairs into layers, but contextual shaping, ligatures, rich text
  runs, automatic wrapping, alignment, truncation and complex paint fidelity
  still need dedicated work/visual comparison. No whole-product equivalence claim.

**Stop point:** Batch 2 web implementation and validation gate are complete.
Do not proceed to Batch 3 until requested.
