# Canvas, Dashboard & UI↔Code Connectivity Audit — 2026-09-17

**Scope.** The application layer (`X-Native/apps/x-designer`, 37.5k lines — `x_native_app` GUI +
CLI bins), the canvas/editor chrome, the dashboard, and bidirectional traceability between UI
and code. Plus the design-identity question: *does X-Native look like a Figma clone?*

**Method.** Full read of `theme.rs`/`dashboard.rs`/`state.rs` structures; mechanical extraction
of all 180 `Action` enum variants with producer/handler cross-referencing across every app file;
capability-by-capability grep of crate APIs against the app; palette/icon/font provenance from
`x-ui/design_system.rs` and `icons.rs`.

> **Correction to AUDIT_CLAIM_REVIEW Rev. 2 (important).** Rev. 2 searched `crates/` only and
> wrongly reported "no nav rail, no app shell". The real application lives in `apps/x-designer`.
> The submitted audit's nav-rail finding was **substantially right for its commit** (`bc46c9f`,
> still absent from this history): the rail exists, and HEAD has since wired it properly —
> `Action::NavTab` switches the actual left panel (STRUCTURE/LIBRARY/TOKENS), ⌥1–5 work, the
> Agents tab has a real workspace panel, and the Tokens panel contains variable creation UI with
> an in-code note: *"the prominent rail has a real creation entry point instead of being a
> decorative highlight."* The audit's export finding remains wrong even here (PNG/JPG/PDF export
> is wired into the app). Final corrected picture is in this document.

---

## 1. Canvas audit — what the canvas actually is

The editor is a hand-rolled immediate-mode vello UI (no x-ui widgets; x-ui supplies the token
palette). Structure: tabbed title bar (36px) → left dock 280px (nav rail + STRUCTURE/LIBRARY/
TOKENS + pages list + layers tree) → canvas → right dock 340px (Design/Prototype/Inspect/UX).

Connected canvas systems (all verified with hit regions → `Action` → handler):

| System | Evidence |
|---|---|
| Rulers 22px + tick labels | `theme.rs` RULER_*, drawn + themed |
| Smart guides on move/drag | `run.rs` `smart_move` (comment: "Figma-style smart guides"), `C_SNAP` indicator |
| Selection chrome, handles, tangent handles | `C_SEL*`, vector handles action (`ToggleVectorHandles` via shortcut) |
| In-place text editing | `text_session.rs`, `C_EDIT_BORDER`, undo checkpoints via `checkpoint_text()` |
| Comment pins | `paint_comments` (editor_ui.rs:6224), avatar colors, "Figma z-order" pins, doc model `doc.comments` |
| Flow preview (prototype playback) | Toolbar button "Flow preview" (editor_ui.rs:2453); `run.rs:6461`: *"hover, click, drag or press keys; Esc back, Q exit"*; `flow_fire` → `x_native::editor::fire_action` with overlay stack + vars; **AfterDelay re-arms on navigation and overlay changes** (`arm_flow_delays`, `arm_flow_overlay_delays`); "scroll to" parity |
| Eraser, symmetry, shape builder, booleans | toolbar (former keyboard-only, fixed per in-code "audit F2"), `CtxCmd::Union` etc. |
| Find & replace (⇧⌘F), command palette (⌘K) | wired in dispatch |
| Minimize UI (⇧⌘\), themes (Graphite/Daylight/HighContrast) | wired; persisted to `~/.config/x-native/theme` |
| Board mode (FigJam-class) | `board_ui.rs` + `Action::BoardToggleGrid/Connectors/NextPage/AddPage` |
| UX analysis tab | `run_ux_*` ×6 (accessibility, contrast, flows, quality, patterns, responsive) |
| Image adjustments panel | `paint_image_adjustments` (exposure/…, reset) → `UpdateImageAdjustment`/`ResetImageAdjustments` |

**Canvas verdict:** dense, wired, and audited-before (the code contains its own "audit F1/F2"
fix series for previously-dead controls). Not a mock-up.

## 2. Dashboard audit

`dashboard.rs` opens with: *"Dashboard screen — pixel clone of `ui/dashboard-v2.html`. Every
coordinate below is the measured getBoundingClientRect() of the Chromium-rendered reference."*
The HTML reference is not in the repo (authored off-tree). Structure: 40px top bar (logo +
wordmark + centered 480px search + right actions), 260px sidebar (HOME: Recents/Drafts/Starred/
Trash; LOCAL WORKSPACE; TEAMS), quick-action cards, recents grid (Grid/List), first-launch
onboarding modal (persisted dismissal marker), all hit-wired (`OpenDraft`, `SelectDoc`,
`DashNav`, `StarRecent`… — every one resolves through `dispatch`).

Local-first honesty substitutions instead of Figma's cloud copy: *"No account required"*,
*"Cloud teams are not available yet"*, *"Not available in this build"* (for Upgrade/Invite).

**Dashboard verdict:** functionally its own tool; **visually** the layout grammar (and likely the
original mock) is Figma's file browser — see §4.

## 3. UI ↔ code traceability

**UI → code (does every control do something?):** 180 `Action` variants extracted. Producer =
constructed in a hit region/menu/shortcut; handler = matched in `dispatch` (or `loading_action`).

- **Producers with no handler: 0.** (Apparent hit `LoadingClose` routes through
  `loading_action()` while a document loads; the `{}` arm in the main dispatch is an
  exhaustiveness guard.)
- **Handlers with no producer: 2.** `SetTheme` (constructed only by regression tests; real UI
  uses `CycleTheme` and the app-menu dark-mode toggle) and `SetImageAdjustments` (its live
  siblings `UpdateImageAdjustment`/`ResetImageAdjustments` drive the actual panel).
- Prior in-code audits ("Audit F1" icon-cache no-op, "Audit F2" keyboard-only toolbar buttons)
  show dead-UI hygiene is already practiced here.

**Code → UI (does every capability have an entry point?):**

| Capability (crate API) | UI entry | Status |
|---|---|---|
| SVG export (`export_svg*`) | app menu / export | ✅ |
| PNG/JPG raster (`export_raster`, `encode_png/jpg`) | export + clipboard image | ✅ |
| PDF (`export_pdf*`) | export | ✅ |
| `.fig` import (Kiwi) | `import_figma_document` + clipboard Figma JSON | ✅ |
| Sketch import | wired | ✅ |
| **Sketch export** (`export_sketch`) | — | ❌ no caller |
| **Tailwind codegen** (`selection_to_tailwind`) | — | ❌ (JSX + CSS are wired) |
| **Library accept update** (`accept_update`, `diff_library`) | notification kind exists | ❌ no acceptance flow |
| Library publish (`library_from_parts` → `save_xlib`) | `Action::PublishLibrary` → `.xlib` save dialog | ✅ |
| Variables create | TOKENS panel: 4 kind buttons + "Generate variables from tokens" | ✅ |
| **Variables edit/rename/delete/modes** | — | ⚠️ "renamed in the document JSON afterwards" (in-code comment); undo absent — direct table inserts, not `variable_commands` |
| Prototype interactions + delays + overlays | Flow preview | ✅ |
| SmartAnimate | transition enum selectable in Prototype tab | ⚠️ selectable; interpolation fidelity unverified |
| `x-editor::Player` struct | `flow_*` loop supersedes it in-app (Player used in headless/CLI paths) | ⚠️ architectural duplication |
| MCP server | `x_native mcp file.x` (stdio) + Agents tab status | ✅ |
| Comments (add/resolve) | canvas pins | ✅ (model still flat — no threads) |
| Archived versions | app menu "Open archived version" | ✅ |
| **New this session:** `variable_commands` (undo), `FontManager::families()` | — | by design backend-first; panel work remains |

## 4. Do we look like Figma?

**Short answer: no — it is not a "basic clone." It is a Figma-parity tool with its own skin,
and the places it still echoes Figma are specific and fixable.** 224 "Figma" mentions in
comments show parity-driven *development* (fine — that's benchmarking), but the shipped surface
diverges deliberately, in writing: *"X-Native calls the layer tree Structure and the asset
browser Library: the document model is a scene graph, not a Figma clone."*

**Already its own identity (verified):**
- **Violet accent #6B49F5** / selection #7C5CFC / focus #A996FF + logo green #1BCB55 — not Figma
  blue (#0D99FF). Near-black canvas **#060606** vs Figma's #1E1E1E — distinctly darker.
- **Lucide stroke icons**, not Figma's icon set. WCAG-AA-audited semantic palette with 3
  runtime themes — more design-system rigor than a clone effort would bother with.
- **Information architecture Figma doesn't have:** 5-tab left nav rail (Layers/Agents/Library/
  Tokens/Variables), Agents workspace + MCP server, Tokens tab with token extraction, UX analysis
  tab, Board mode, tabbed desktop title bar, canvas rulers (Figma has none), local-first/no-account.
- Renamed conventions: Structure (not Layers), Library, Flow preview (not Present), Tokens.

**Genuine clone artifacts (fix these):**
1. **`C_SNAP = #F24E1E` (theme.rs:185) is Figma's literal brand red-orange.** Copy-artifact from
   reference scraping. Change to the palette's own family (e.g. `warning` #F0AD4E or
   `accent_ink` #B4A4FF).
2. **"Upgrade to Pro" / "Invite team"** in the dashboard imply cloud pricing that doesn't exist
   ("Not available in this build" is the current band-aid). Reframe to local value
   ("Pro tools", "Support the project") or cut.
3. **Dashboard IA homages:** Recents/Drafts/Starred/Trash/TEAMS + quick-action cards is Figma's
   file-browser grammar, pixel-cloned from an HTML mock. Keep the IA (it's familiar and
   functional) but re-skin the signature elements: card shapes, sidebar section treatment,
   wordmark lockup — enough that a screenshot reads "X-Native".
4. **Right-panel triad Design/Prototype/Inspect** is Figma's exact tab set (+ own UX tab). This
   has become industry convention (Sketch, Framer, Penpot) — **keep it**, but that's a conscious
   choice to document, not an accident.
5. **Inter as the UI face** is Figma's choice too — but it's also the industry's default; keep
   Inter for body/UI, and differentiate the **wordmark + headings** with a distinct display face
   (cheap, high signal).

**Priority list (from this audit):**
1. ~~Swap `C_SNAP` off Figma brand red~~ **DONE 2026-09-17** — now role-derived `accent_ink` violet (theme-reactive).
2. Ship the missing capability UIs — **IN PROGRESS 2026-09-17**: Sketch **export** landed
   (5th format end-to-end: picker → dialog → jobs arm → palette command), **Tailwind** landed as
   5th INSPECT platform (+ copy status), **variables management rows** landed in the Tokens panel
   (delete / bool toggle / number ±1 stepping, undoable via the document's `var_history`
   command log). Still open: variables rename/text-value editing, library update-acceptance
   dialog, font-picker UI on the `FontManager::families()` backend.
3. ~~De-clone dashboard signature styling; fix "Upgrade to Pro" framing~~ **PARTIALLY DONE
   2026-09-17** — "Upgrade to Pro" card replaced with a free/local-first badge (no CTA, no
   `Action::Upgrade`); full dashboard re-skin still open.

## 6. Remaining fix/upgrade backlog (canvas + dashboard)

**Canvas (editor):**
- ~~Variables **rename + text-value editing**~~ **DONE 2026-09-17** — value editing
  (`FieldId::VarValue`: hex/bool/number/string with type sniffing, empty clears) AND rename
  (`FieldId::VarName`): rename lands as ONE undoable `Batch` — value moves to the new name, the
  old name becomes an alias so existing bindings keep resolving, the old entry retires.
  Renaming an alias re-points it. (v1: mode-scoped overrides keep the old name.)
- ~~Library **update-acceptance dialog**~~ **DONE 2026-09-17** — LIBRARIES section in the
  Assets panel lists pinned dependencies ("check" per row) → picks the updated .xlib
  (source-path hint → `<doc dir>/<id>.xlib` → file dialog) → `diff_library` review modal
  (scrim + change list + Accept/Keep) → `accept_update` repins, re-resolves consumers,
  recomputes `snapshot_hash` (so reopen passes integrity), and records the new source path.
- ~~**Font picker UI**~~ **EXISTS + UPGRADED 2026-09-17** — both listing sites (FONT BROWSER
  popup, LIBRARY panel) now group faces into families via `FontManager::families()`, with face
  counts; picking a family resolves to a face at render time.
- ~~**Comment threads**~~ **DONE 2026-09-17** — `Comment.parent: Option<String>` (flat
  threads: replies point at the root), serialized with backward compat (missing key loads as
  None; roundtrip-tested). UI: one pin per thread root with a reply-count badge, hover preview
  shows "+N replies", the open card lists replies (each deletable), and a Reply composer
  (reply-to-reply still attaches to the root). Resolve/delete are thread-cascade
  (resolve root ⇒ replies resolve; delete root ⇒ thread gone).
- Verify **SmartAnimate** interpolation end-to-end in Flow preview (transition is selectable;
  engine untested through the app path).
- Consolidate on `fire_action`: retire the duplicated `x-editor::Player` loop from app paths.
- ~~Component **slots/descriptions**~~ **COMPLETED 2026-09-17** — the audit undersold both:
  slot declaration (`+ Slot property`), live render substitution (ir.rs calls `resolve_slots`
  in the Instance path), and the description field (bindings["component:description"], edited
  in the master inspector) already existed. The genuine gap — filling/clearing slot content on
  INSTANCES — is now closed: the COMPONENT panel shows a SLOTS section per instance
  (status: filled/default/anchor), "from selection" copies another selected layer into the
  slot re-based on the anchor's transform (set_slot_content), and the ✕ clears it
  (clear_slot_content) — both checkpointed one-undo steps.

**Dashboard:**
- ~~**Real thumbnails**~~ **DONE 2026-09-17** — Recents grid now renders each file's first page
  through the same export pipeline as PNG export (`prepare_export` + `export_raster`), cached in
  memory (mtime-validated) and on disk (`~/.config/x-native/thumbs/`, FNV-1a of path+mtime),
  one render pumped per frame so a wall of new files warms up without hitching; failures fall
  back to the watermark card. v1 covers `.x` documents; embedded image assets preview as
  placeholders.
- **Trash restore** — blocked on a product decision first: Trash is currently a static empty
  state with NO deletion pipeline. Deleting a user file needs a policy (move to OS trash vs
  in-app list) before restore can exist.
- ~~**Templates gallery**~~ **DONE 2026-09-17** — the third quick card is now "Start from a
  template" (replacing the dead "Invite team" stub, whose action is fully removed). The modal
  gallery lists 4 built-ins (Mobile app flow / Landing page / Design system / Starter board)
  built as code and opened as independent copies (`OpenDoc::template_doc`; board template
  carries its BoardDocument and opens the Board screen). Connectivity stays clean:
  `OpenTemplates`/`CloseTemplates`/`NewFromTemplate(i)` all producers+handlers, tested.
- **Re-skin signature elements** — IN PROGRESS 2026-09-17: quick-action cards now wear the
  brand (violet icon chips `C_ACCENT_MUTED`/`C_ON_ACCENT` on every card + violet hover ring
  `C_SEL`, replacing the reference's white/gray chips and neutral borders). Sidebar/wordmark
  treatment still open.
- **Pass-1 cleanup** — DONE 2026-09-17. The accent pass shipped with four leftovers, all fixed:
  (1) the quick-card icon chip was still the *reference mock's flex artifact* — its `w-8 h-8`
  tile had been squashed to 30.7×18 inside the fixed 88px card (7.3px side padding, 1px
  above/below) and the clone copied the squash; it is now a square 32×32/r8/16px mark, the same
  one the gallery rows wear, with the card interior re-spaced around it (slot 274×88 unchanged).
  (2) `New board` and `Start from a template` wore the *same* `layout-template` glyph — the
  template card replaced the old `users` card, and two identical violet chips in one row read as
  a rendering fault; the board card is `sticky-note` now (the board's own tool icon).
  (3) gallery rows all drew one glyph — `OpenDoc::TEMPLATES` is `(name, blurb, icon)` and each
  row carries its own (frame / layout-list / component / sticky-note), pinned by a test that
  draws every catalog icon and requires geometry back (an unknown name is a silent no-op).
  (4) the team-badge letter was `C_TEXT` on the saturated team hues — 3.0:1 (blue) and 2.1:1
  (orange), under the AA floor for 10px bold; it is `C_BLACK`, matching `avatar()`. The gallery's
  `Use` button also came off 64×28/r6/`C_LINE_2`-hover (a border role used as a button fill) onto
  the house control: 64×32, `R_ROW`, `C_FIELD_2` hover; chip and CTA now share the row centre
  line. The gallery is a modal like the color picker and the library review, so Escape closes it
  (click-away was the only exit), and opening it drops the search field's focus.

**Verification note:** the fixes above are verified by CI (`scripts/check.sh`: rustfmt, clippy
with the dead-code ceiling, `cargo test --workspace`); the sandbox itself has no Rust toolchain,
so CI is the compile gate.

## 7. Design-system pass — the question "do we have one, and is it used everywhere?"

**Answer before this pass:** we had one and we were not using it everywhere. `crates/x-ui/
src/design_system.rs` owned color roles plus type/radius/spacing/icon/shadow scales, all tested —
but outside x-ui the scales were almost unreferenced (SpacingScale 0 call sites, ShadowScale 0,
DesignSystem 0, IconScale 3, RadiusScale 6, TypographyScale 7) while the app painted through
`theme.rs` aliases: ~90 raw colors, ~230 numeric radii, ~90 numeric icon sizes. The system
existed; the chrome had drifted around it, and two of the ten things the chrome needed (an alpha
ladder, a stroke width) had no home at all, so call sites invented values (`#FF3B30` for a badge,
`0x33` washes, 1px-or-1.5px borders).

**What is in the system now** (`X-Native/docs/DESIGN_SYSTEM.md` is the how-to):

- `AlphaScale` 8/20/51/66/128, `StrokeScale` hairline 1.0 / ring 1.5, `MotionScale` 120/180/240ms
  with the two easing curves, and const steps on `IconScale` and `SpacingScale` (a `const` cannot
  call `Default::default()`); `DesignSystem` carries every scale, and tests pin the ladders,
  prove each is monotonic, and prove the struct carries them all.
- two roles the chrome was missing, `danger_fill` + `on_danger`, with the new `LABEL_FILLS`
  contrast pair: the shipped badge was `#FF3B30` (white label 3.55:1, under AA); `#C0392B` is
5.44:1, and high contrast gets `#FF9A8F` + black at 10.27:1.
- the app vocabulary: `R_*` (ladder + intent aliases), `ICON_XS..XL`, `SP_1..SP_10`, `A_*`,
  `STROKE_*`, `T16`, `R_NONE`, `C_ACCENT_INK`, `C_SUCCESS[+WASH/EDGE]`, `C_SELECTION_[WASH/EDGE]`,
  `C_DISC_SCRIM` — 102 named steps, all derived from the palette.

**What the sweep changed** (pixels preserved except the itemised snaps below): 260 numeric
radii found in the production paint code, 14 kept because they round document space (vector
anchors at 1.0/1.5, one mock frame at 18.0) and 246 moved onto `R_*`; 111 numeric `draw_icon`
sizes, all moved onto `ICON_*`; 64 raw colour literals in the paint code, 10 of which became
roles (one of them a new definition, `C_DISC_SCRIM`), leaving 55 that are the user's content,
the brand set, or a scrim — and each of those now says why in a comment, checked by the
ratchet. Every wash, scrim and status paint is a role. Per file: theme.rs 19, state.rs 20,
editor_ui.rs 12, board_ui.rs 2, dashboard.rs 1, paint.rs 1. Radii
snapped onto the 2/4/6/8/12 ladder and itemised: 5.0→6 (11 sites), 3.0→4 (14), 10.0→8 (6),
7.0→`R_ROW` 8 (2, dashboard thumbnails), 14.0→12 (1 corner — the template-picker card, fill +
stroke), 0.5→0 (1, a chip the renderer was clamping to a square corner anyway). Icons: 10.0→
`ICON_XS` 12 (5 sites), 11.0→`ICON_XS` (1, with its x-inset 1→2 to stay centred), 13.0→`ICON_SM`
14 (2). Colors fixed on evidence: the success chip's wash was the *brand* green `#1BCB55` @51
(now the success role `#4CD966`, same alpha; border alpha 76→66), the board marquee's wash/edge
were hand-typed violet at alpha 40/160 (now `C_SELECTION_WASH`/`_EDGE`, same `#7C5CFC` hue, alpha
51/128), two editor check-marks `#4CBB7A`→`C_SUCCESS`, a resolved-comment pin `#6B7280`→`C_DIM`
(3.9:1→6.3:1), and the unread badge off `#FF3B30`.

**Ink fixes the audit implied** (all three invisible in High Contrast, none visible in Graphite):
the unread count was `Color::WHITE` on the danger fill — 2.04:1 in HC (black now, 10.27:1); the
find bar's `Aa` / box-select toggles were white on the accent — 1.43:1 in HC (`C_ON_ACCENT`,
14.67:1, white in the other two palettes so unchanged there); "Mark all read" and the
notification glyph were painted *in* the accent — 3.13:1 on the panel, 2.80:1 on a raised row
(`C_ACCENT_INK` = `accent_ink`, 6.0–7.8:1; Graphite's violet goes `#6B49F5`→`#B4A4FF` at those
two spots).

**The ratchet that keeps it** (`design_tokens_test.rs`, four rules over the production paint
code): no numeric `draw_icon` size; no numeric radius off the documented canvas-space list
(vector anchors at 1.0/1.5, one mock frame at 18.0); a per-file ceiling on raw color literals and
on bare `Color::WHITE`/`BLACK` ink; and no accent token in the colour slot of `fonts.text` /
`text_center` / `draw_icon`. Ceilings are a ratchet — lower them, never raise them.

**Deliberately not tokenised:** measured coordinates in the pixel-cloned dashboard (naming a
browser measurement `SP_5` would hide where the number came from) and document-space corners.
**Open, unchanged from §6:** the placeholder color (`#6B6E7A` at 2.98:1, the one audited contrast
miss left) and the dashboard's keyboard/focus model (Tab is still gated to the editor).

## 8. Light/dark, padding, responsiveness — the design review as a user, a critic and a developer

**Light and dark exist and are wired.** Three palettes ship (`Graphite` dark, `Daylight` light,
`HighContrast`), switchable from the toolbar button, the ⌘K verbs `Theme: Daylight (light)` /
`Theme: High Contrast`, with the choice persisted to `~/.config/x-native/theme`. Because every
app constant is a role authored in Graphite and resolved by value at paint time, all three work
without per-screen work — and the crate's own tests re-run the AA audit for each palette. What
was missing was *evidence*: nothing showed the light theme, so the new design sheet does (below),
alongside each ladder and the audits.

**Padding/margin.** 616 literal offsets in the paint code, 46% on the 4/6/8/12/16/20/24/32/40/48
ladder. The off-ladder half is mostly optical arithmetic — centring a 14px glyph in a 32px chip
is `(32−14)/2 = 9` — not spacing. Policy now written down: container padding comes from `SP_*`;
centring may stay arithmetic; the pixel-cloned dashboard keeps its measured interiors with a
comment per site. The sheet lists the top offsets and labels each step vs nudge.

**Responsiveness — two real bugs, both fixed:**

1. **Text in fluid boxes was drawn unmeasured.** The quick-action row divides the column
   (`(mx1−MX−3·gap)/4`): 274px per card at 1440, but **159px at the 980px minimum window** — where
   "Start from template" (≈130px) and "Infinite canvas for brainstorming" (≈170px) painted over the
   neighbouring card. Same class in the recent-file meta line, the gallery rows' name/blurb and the
   draft rows' name (which ran into the right-aligned timestamp). All four now go through
   `fonts.truncate(…)`: nothing changes at the reference width, and a narrow window ellipsises.
2. **The docks could invert the canvas.** `editor_regions()` derived the canvas as
   `win_w − right_w − (nav + left_w)` with panel widths clamped only to their own ranges
   (200–480 / 240–520). At the 980px minimum with both panels wide: 48 + 480 + 520 = 1048 →
   a canvas rect of **−68px**, with the two docks overlapping each other and a negative-width rect
   handed to paint and hit-testing. Now a canvas floor (`ED_CANVAS_MIN` = 280px) is enforced in
   `editor_regions()` (so a window resize under a dragged layout is safe) and the resizer stops
   there (so the stored width never goes bad); `docks_never_eat_the_canvas` pins 6 widths × 9 dock
   pairs. Defaults are untouched: 312px of canvas at 980, 772px at 1440.

**Critic's finding, still open (renderer, not app):** the canvas draws a frame's name with a
hard-coded slate literal inside `crates/x-render/src/scene.rs` — `#4B5563` at 0.7 alpha measures
**1.85:1 on Graphite, 3.23:1 on Daylight, 1.86:1 on High Contrast**, i.e. a frame label that is
effectively unreadable in two of the three palettes. It is outside the app's token layer because
`x-render` depends on `x-core` only and has no palette; the fix is to thread the label colour
through the render options (or draw the label with a contrasting halo), which is its own change.

**The design sheet** (`/home/user/design-preview/`, generated by `build_tokens.mjs` +
`build_audit.mjs` from `design_system.rs`, `theme.rs` and `design_tokens_test.rs`) shows the three
palettes, every ladder, the dashboard at 1440/980/1920, the fluid-width table
(card 274→159, grid 366.7→213.3, canvas 312→280 with the docks maxed) and the ratchet's
used-vs-ceiling per file.

**Bottom line.** Canvas and dashboard are real, wired software — UI→code connectivity is
effectively 100% at the Action level, and the code→UI gaps are a short, named list. The product
deliberately positions itself against being a Figma clone and mostly succeeds; to finish the
job: one color, two labels, one dialog, and the variables editing surface.

## 9. "Better than Figma" — a critic's pass over dashboard, canvas, panels and features

The bar is not "as good as Figma". It is: every surface says what it is, every
control answers the keyboard as well as the pointer, nothing dead-ends, and the
design system makes the next screen cheap to build.

### What shipped in this pass

| surface | finding | change |
|---|---|---|
| dashboard | mouse-only (Tab gated to the editor) | Tab/Shift+Tab cycle the controls (focus derived from the hit list, so new controls are reachable for free), Enter fires, Escape drops, a click moves the ring; ring is `accent @ 1.5px` |
| dashboard | no pointer affordance at all — the whole browser was a plain arrow | `cursor_for()`: Pointer on every control, Text on the search field, editor keeps resize/pan/tool grammar |
| dashboard | Trash was a dead end ("No files in Trash" and nothing else) | real empty state + "Back to Home" action; it also says nothing is removed until you empty it |
| placeholder text | exempt from the audit and failing AA in all three palettes (Graphite 2.56:1) | audited at 4.5:1 like any text role; `#939AA6` / `#5B6274` / `#B8B8B8`, each still dimmer than `text_dim` |
| panels | the resize seam lit up but said nothing | the seam goes accent and grows a centred grip pill on hover/drag |

### The critic's open list — ranked by how much it would lift the product

**1. The dashboard's information architecture is thin for a workspace.**
There is one column of cards, one 3-up grid and a drafts list. Figma's browser
carries: a real table view (name / team / edited / size, sortable, with hover
actions), project grouping with move-between-teams, "shared with me" and team
sections, multi-select with a bulk bar, and a sort control. Ours has
`DashView::{Home, Recents, Starred, Trash}` and no sort, no multi-select, no
project grouping. *This is the largest single gap.*

**2. The canvas reads as an editor but has no spatial navigation aids.**
No minimap, no "zoom to fit all pages", no page thumbnail strip, and the ruler
has no live guide readout while dragging (the guide line exists; the numeric
feedback does not). Figma's ruler + guide readout and its page thumbnails are
what make a large document feel small.

**3. The left panel has the panes but not the workflows.**
LAYERS / ASSETS / TOKENS pills exist, pages are listed, the tree supports
drag-drop (P12). Missing vs Figma: component *instances* have no "go to main
component" affordance in the row, assets have no search field, and there is no
"select matching" / "show all instances" action on a component.

**4. The right panel is the most under-used real estate.**
Four tabs (COMPOSE / FLOW / SHIP / UX ANALYSIS) with per-node sections. Missing
vs Figma: **variables and styles editing surface** (the data model exists —
the audit flagged this before and it is still the biggest feature gap), a
shared-styles list with "apply to selection", and constraint/auto-layout
controls that show the resolved values (they exist per-node but the panel does
not expose the *resolved* box model the way Figma's does).

**5. Comments and flows are single-threaded.**
Comments: one open thread at a time, no resolve-all, no filter by author.
Prototype: connections are painted, but there is no "presentation mode" entry
from the canvas (only from the panel) and no flow-start marker on the frame.

### What is already ahead of Figma (keep it)

- three audited palettes *including* a genuine high-contrast mode (Figma ships
  light/dark only, and its placeholder greys fail AA);
- ink roles that make an unreadable label impossible across palettes;
- a token layer whose literals are ratcheted by a test, with a generated design
  sheet — Figma has no equivalent guard on its own plugin/mock surfaces;
- X-Native's own workflow verbs (SHIP / UX ANALYSIS) that Figma does not have;
- pixel-audited density (22/32/40 row rhythm, Lucide 1.5 stroke, radius ladder)
  that this pass put on tokens without moving a single measured coordinate.

