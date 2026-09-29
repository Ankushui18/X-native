# Figma · Create designs · Behavior comparison tracker

One block per parity run (`Run N`), newest first. A run follows the standard
8-step pipeline: audit → probe (measure deviations) → fix (TS-only) → unit
suite → full regression → sabotage verification (break each fix, watch its
specific test fail, restore byte-exact and md5-compare) → document → ship.

Sources of truth for each behavior are Figma's own help articles, quoted
inline in the probe/test headers and the engine comments they pin.

---

## Run 16 · Copy, Paste & Duplicate parity ✅ (2026-09-29)

**Figma, Copy and paste objects (4409078832791); Frames in Figma Design
(360041539473).**

### Behaviors

| Behavior | Figma rule (doc quote) | Implementation |
|---|---|---|
| Duplicate a plain object | "new objects are placed on top of the original" | ⌘D lands exactly on the source (was +10/+10) |
| Duplicate a top-level frame | "the new frame will be placed to the right of the original" | `x + w + 20`, same y (20 = chosen gap; doc fixes the direction, not the pixels) |
| ⌘D distance cascade | "Figma will continue the same distance between objects" | `lastDupDelta` re-derived from the copy's net displacement vs `dupBaseline`, so drags and arrow-key nudges compose |
| ⌘D rotation cascade | "the new objects will continue rotating at the degree amount of the original duplicate" | `dRot` tracked beside dx/dy; repeats indefinitely; a fresh selection breaks the chain |
| Frame quick-add | explicit dx/dy | exact placement; never seeds or rewrites the cascade memory |
| Paste (⌘V) | considers the canvas view | group **centred** on the world point under the viewport middle (`anchor: "center"`) |
| Paste here | "Position your cursor where you want the top left of your copied object" | group **top-left** on the cursor (the default for any pointed paste); onto an auto layout frame the child is `absolutePosition` — "on top of the frame, not inside it" |
| Paste over selection (⌘⇧V) | "on top of a selected frame, not inside it ... match the x, y position of the selected object" | new `over` paste mode: selection's parent, one z-slot above, top-left on the selection's x,y |
| Paste to replace (⇧⌘R) | "remove a selected object ... and replace it with the object copied to your clipboard ... The pasted object will adopt the constraints of the object it replaced" | new `pasteToReplace` command: each selected object swaps for a fresh clipboard clone at its position + z-slot, adopting `constraintH/V`; locked/instance targets refuse; empty clipboard no-ops (no history); one undo step covers the batch |
| Multi-paste | "pasted in the order that they are copied and will repeat if there are additional frames ... the extra objects are pasted into the last frame" | with several frames selected: one clip item per frame in copied order, cycling when frames outnumber objects; extras into the last frame; each item centred in its frame (doc fixes distribution, not the per-item point) |
| Clipboard isolation | — (safety invariant) | deep-clone freeze at copy time; pastes share no references with the source or each other (JSON-clone + reid per paste) |

### Measured deviations

Probe: `tests/probes/clipboard/duplicatePasteParity.mjs`
(`npx vite-node tests/probes/clipboard/duplicatePasteParity.mjs`)

**Pre-fix: 11 DIFFs** — A1..A5 (offset/cascade), B1/B2 (paste-here anchoring
group centred instead of top-left), C1 (⌘⇧V pasted *inside* the selected
frame at original coords), D1 (`pasteToReplace` missing — silent no-op),
E1/E2 (multi-frame paste dumped everything at the page root).
**Post-fix: 0 deviations / 16 checks ok.**

Control rows that passed pre- and post-fix: explicit dx/dy exactness (A6),
z-order directly above the original (A7), extras-into-last single-frame path
(E3), clipboard freeze/reference isolation (F1/F2).

### Files

- `src/engine/memory.ts` — duplicate handler rewritten (on-top default,
  frame-right rule, baseline-compared translation + rotation cascade); paste
  handler restructured (multi-host distribution, `over` mode, top-left/center
  anchors, auto-layout on-top rule); new `pasteToReplace` case with guide
  cleanup; `DUP_FRAME_GAP = 20`.
- `src/engine/types.ts` — `paste` gains `over` + `anchor`; new
  `pasteToReplace` command (documented with doc quotes).
- `src/ui/Canvas.tsx` — clipboard ladder threads `over`/`anchor`; pointed
  menu pastes anchor top-left, ⌘V stays centred on the viewport; ⇧⌘V rides
  `over` for nodes (⇧ keeps its in-place meaning for the text/link ladder).
- `src/ui/chrome.tsx` — ⇧⌘R chord (claimed before the browser's hard
  reload), ⌘V fallback carries `over`, Edit menu gains Paste to replace.
- `src/ui/ContextMenu.tsx` — Paste over selection (⌘⇧V) and Paste to replace
  (⇧⌘R) items in both the canvas and layers menus; `pasteOver` rides the
  async system-clipboard ladder like the menu Paste.
- `src/engine/__tests__/duplicatePasteParity.test.mjs` — 41 checks
  (registered in `npm test` after `scaleGeometry.test.mjs`).
- `src/engine/__tests__/parity.test.mjs` — two assertions re-based to the
  documented behavior (centre-anchor paste is now explicit; plain ⌘D lands
  on top), intent of both tests preserved.

### Sabotage verification (each restored byte-exact, md5 `cfa922cf92889c3cbaf7912028e7df07`)

| Sabotage | Expected failure | Result |
|---|---|---|
| Frame-right rule disabled (`if (false && …)`) | A2, A2b, B4 fail | exactly those 3 fail ✅ |
| Rotation dropped from the cascade (`+ delta.dRot` removed) | B3, B3b fail | exactly those 2 fail ✅ |
| Constraint adoption removed from `pasteToReplace` | E2 fails | exactly E2 fails ✅ |

### Decisions where the doc is silent

- **Frame gap 20px** — the doc fixes the direction ("to the right"), not the
  spacing; 20 matches canvas quick-add guides and grid multiples.
- **Multi-paste per-item placement = centred in the frame** — the doc pins
  only the distribution order/repeat/extras rules.
- **Paste over / replace with a multi-object clipboard** keeps the group's
  arrangement, top-left anchored at the target — consistent with the
  single-object "match the x, y position" rule.
- **Menu Paste to replace** uses the in-app clipboard (the browser offers no
  permission-free clipboard read from a menu click); the keyboard chord and
  `pasteOver` menu item ride the async system-clipboard ladder first.

---

## Runs 1–15

Documented in their audit reports, probe headers and test headers
(`docs/AUDIT_*.md`, `tests/probes/**`, `src/engine/__tests__/**`). Run 15
(scale-tool parity for vector networks, boolean groups and type lengths):
`tests/probes/scale/vectorGeometry.mjs`,
`src/engine/__tests__/scaleGeometry.test.mjs`, PR #46.
