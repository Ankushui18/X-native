# Comprehensive Micro-Parity Audit — Batch 1

Date: 2026-09-27. Scope: **Batch 1 only**, web editor. No Batch 2/3 implementation.
Base: `c3afa0dfcde95e29e8067c349b021cd0f583ce6e`.
Working branch: `arena/01a0e1ff-x-native` (this session's fixed branch, not the
`arena/01a0df99-x-native` branch named in the supplied audit).

Reconciled with the full audit supplied after the initial Batch 1 implementation:
- #10 exempts explicitly selected children from label culling. That exception now
  applies even to a frame directly inside another frame, and to rename hit-testing.
- #9 now paints a curved arrow exactly 20 CSS px above local top-center, replacing
  the initial circular handle at 24px.
- #7 retains one-level drilling, rather than the proposed deepest-child shortcut:
  the official selection reference distinguishes double-click from Cmd/Ctrl deep select.

## Evidence and numbering

Issue numbers below are the user's current list, not the older repository numbering.
The historical double-click finding is **Gap 8**, not #7, in
`docs/MICRO_PARITY_GAP_2026-09-25.md:166-177`. Its assertion that no drill branch
exists is stale: the base has a branch, but the earlier deep hit bypasses it.
The existing UI audit describes label behavior at
`docs/PRODUCT_UI_AUDIT_2026-09-26.md:236-240`.
Paths below are relative to `X-Native/`; `src/...` means `apps/web/src/...`.

Official references checked:
- [Figma Design](https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design)
- [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects): parent-first click; double-click/Enter selects **one** nesting level; Cmd/Ctrl-click deep-selects.
- [Adjust alignment, rotation, position, and dimensions](https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions), Rotation → Canvas: drag outside layer bounds, Shift snaps to 15°.

**Important distinction:** the rotation reference does not specify a detached top-center
handle. #9 implements the requested product behavior; it is not certified as exact
Figma handle-placement parity. Likewise, the precise ancestor-selection label-culling
rule is a requested acceptance criterion, not established by those help articles.

## Findings and fixes

| User ID | Exact pre-change evidence at the base commit | Implementation in this branch |
| --- | --- | --- |
| **#10 Canvas label culling** | `src/ui/Canvas.tsx:2163-2194` traversed every descendant, with only an immediate-frame-parent check; it did not stop at selected or hidden ancestors. Label rename repeated the traversal at `:5888-5900`. | `src/ui/Canvas.tsx:2164-2199` tracks selected ancestors and hides unselected descendant names, while preserving explicitly selected child names. Hidden subtrees are skipped. The selected frame's own eligible name and unrelated siblings remain. `:5909-5927` applies the same policy to rename hit-testing. Existing showName, viewport and presentation rules remain; explicit selection now overrides the immediate-frame-parent suppression. |
| **#9 Frame rotation handle** | `src/ui/Canvas.tsx:2662-2691` painted resize handles only. `:4420-4442` used four corner rotation zones; `:4654-4657` advertised those zones with the cursor. | `src/ui/canvasSelection.ts:36-52` defines a detached target 20 CSS px above local top-center, with an 8px hit radius. `src/ui/Canvas.tsx:2696-2708` paints the curved arrow; `:4437-4461` starts rotation only there for frame/component/instance kinds; `:4668-4674` uses the same target for hover. Corners still resize. Own rotation/flips, zoom/pan, DOM offset, Shift snapping, undo and locking are tested. Non-frame kinds and the combined multi-selection box retain corner rotation. |
| **#7 One-level double-click** | `src/ui/Canvas.tsx:5914-5915` deep-hit-tested the leaf and entered text edit first. Shape/vector/crop handling also preceded the container branch. `:5976-5993` used untransformed child rectangles, first-in-paint-order selection, and an unsafe `children[0]` fallback. Plain clicks at `:4525-4528` could also reset a drilled group selection. | `src/ui/canvasSelection.ts:6-34` establishes selection scope and resolves an immediate child through the engine's existing transform/clip/paint-order-aware hit test. `src/ui/Canvas.tsx:4544-4546` preserves scope on the clicks preceding dblclick; `:4633-4635` mirrors it for hover. `:5941-5949` drills before text/crop/vector entry. Locked/hidden children are skipped; no eligible child means no selection change. Cmd/Ctrl remains a direct deep hit. |

The shared engine `hitTest` is unchanged. It remains a geometry-level primitive with
its existing transparent-frame contract (`src/engine/memory.ts:5013-5053`), including
all existing engine tests. Parent-first and opened-scope behavior is applied at the
Canvas interaction boundary, not imposed on unrelated engine callers.

## Files changed

1. `apps/web/src/ui/Canvas.tsx` — three requested canvas fixes and matching hover/rename behavior.
2. `apps/web/src/ui/canvasSelection.ts:1-52` — small selection/rotation-target helpers used by Canvas.
3. `apps/web/src/ui/__tests__/canvasSelection.test.mjs:1-296` — 92 new regression checks.
4. `apps/web/package.json:11` — includes the new regression file in `npm test`.
5. `docs/MICRO_PARITY_BATCH1_2026-09-27.md` — this audit and verification record.

## Validation gate

Commands run in `X-Native/apps/web`:

| Check | Before | After Batch 1 |
| --- | --- | --- |
| `npm test` | **2,312 passed, 0 failed**, exit 0 | **2,404 passed, 0 failed**, exit 0 |
| `npx tsc -b` (local TypeScript compiler) | Clean, exit 0 | Clean, exit 0 |
| `git diff --check` | — | Clean |

Totals are the sum of the test scripts' reported passing checks, not a claim of
2,404 browser scenarios. No base-commit tests were deleted, loosened or rewritten. The new Batch 1
label-selection expectation was corrected to match the fuller audit, with seven
additional checks for the selected-child exception and curved arrow.
The new suite adds pure geometry/policy checks and mounts the real Canvas with
React/jsdom, sends mousedown/up/dblclick/move events, observes engine state and
records canvas drawing calls. It covers repeated drilling, sibling scope, overlap
order, locked/hidden children, rotated/flipped picking, text/vector edit entry,
label culling/rename, rotation cursor/drag, Shift snapping, resize and undo.

The suite's existing React `act(...)` warnings also occur in the baseline; both
runs exit successfully. `npm ci` reported 3 dependency advisories (2 moderate,
1 high); no unrelated dependency upgrades were made.

## Self-audit: limits and remaining work

**This is not a claim that every feature now matches Figma.** No browser Chromium
executable was available, so browser pixel/layout comparison and the browser E2E
suite were not run. jsdom's recorded paint calls do not prove rendered pixels.
Native Rust behavior, cross-browser behavior and whole-product parity are outside
this Batch 1 verification.

Pre-existing gaps deliberately not expanded into unrelated refactors:
- Ancestor rotation/flip is not fully represented by selection-chrome positioning:
  `src/engine/memory.ts:4800-4825` sums ancestor x/y; the overlay uses it at
  `src/ui/Canvas.tsx:2627-2648`. The new detached target follows that existing
  overlay, while drill picking uses matrix-aware `hitTest`. Tests prove the
  selected node's own transforms, not complete transformed-ancestor chrome parity.
- Frame-label placement also sums offsets (`src/ui/Canvas.tsx:2166-2169`).
- Other selection entry points, such as the context menu
  (`src/ui/Canvas.tsx:6595-6605`), retain their existing raw hit-test policy;
  they were not certified for identical selection-scope behavior.

### Read-only triage of the remaining requested items

This table records code evidence only; **neither later batch has been implemented
or signed off**. Each needs its own acceptance tests and full batch gate.

| Batch / user ID | Current code evidence | Audit disposition |
| --- | --- | --- |
| 2 / #1 alignment UI | `src/ui/inspector.tsx:6128-6145` already has inside/center/outside icon buttons. | The requested dropdown is a UI change, not missing stroke-alignment storage. |
| 2 / #4 text outline | `src/engine/memory.ts:3766-3774` replaces the text node with one vector/network. | Per-glyph layers are still missing on this path. |
| 2 / #11 boolean shortcuts | `src/ui/chrome.tsx:2407-2425` maps Alt/Option+Shift+U/S/I/E using physical key codes. | Mapping already exists; audit reachability/platform behavior before rewriting it. |
| 3 / #2 variable width | `src/ui/inspector.tsx:6313-6315` hides the editor for branching networks; `src/engine/strokeModel.ts:208-214` also excludes branching, but neither guard checks dashes. | Branch restriction exists; dashed restriction and disabled-state UX still need examination. |
| 3 / #3 scaling | `src/ui/Canvas.tsx:4907` and `:5046` already pass `scaleProps: snap.tool === "scale"`; `src/ui/inspector.tsx:3238` passes true for inspector scaling. | Existing wiring found; add focused stroke-resize/scale regressions in Batch 3. |
| 3 / #5 truncation XOR | `src/ui/inspector.tsx:3840` clears maxH when setting maxLines; `:4383` clears maxLines when setting maxH. | Both UI directions exist; engine/API and multi-selection invariants need verification. |
| 3 / #8 point-box modifiers | `src/ui/Canvas.tsx:4888-4892` supplies Shift/Alt for **layer** multi-resize; `:5075-5145` is vector-anchor movement, not a multi-point bounding-box resize. | Do not mistake multi-layer support for multi-point support. Exact point-box path still needs a dedicated audit. |

### Item #6 is not assigned to a batch

The full audit includes multi-selection move/constraints, but its execution plan
lists only ten of the eleven items. No #6 implementation was added to Batch 1.
Read-only evidence: `src/engine/memory.ts:2173-2190` updates each movable node's
x/y (with snapping and component publishing) without a direct `applyConstraints`
call; resize calls it at `:2284-2287`. That is not a complete proof about subsequent
auto-layout passes or the proposed Hug-frame drag scenario. A dedicated regression
and explicit batch assignment remain necessary before marking #6 verified.

**Stop point:** Batch 1 gate is green. Await review before Batch 2.
