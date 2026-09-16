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
- **Comment threads**: `Comment` is flat — add `parent: Option<String>` + thread rendering in
  `paint_comments`.
- Verify **SmartAnimate** interpolation end-to-end in Flow preview (transition is selectable;
  engine untested through the app path).
- Consolidate on `fire_action`: retire the duplicated `x-editor::Player` loop from app paths.
- Component **slots/descriptions**: `AddSlot` action exists — extend to full slot editing +
  description field in component props.

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
- **Templates gallery**: bundled sample documents opened as copies (replaces the retired
  "Browse templates" card honestly).
- Re-skin signature elements (cards/sidebar/wordmark) so screenshots read X-Native, not Figma.

**Verification note:** all of today's edits are static-checked (pattern-matched against
neighboring code, brace-balanced, diff-verified); the sandbox still has no Rust toolchain, so
first compile remains pending on restored build infra.
4. Optionally consolidate on `fire_action` (retire the duplicated `Player` loop) and verify
   SmartAnimate interpolation end-to-end in Flow preview.

**Bottom line.** Canvas and dashboard are real, wired software — UI→code connectivity is
effectively 100% at the Action level, and the code→UI gaps are a short, named list. The product
deliberately positions itself against being a Figma clone and mostly succeeds; to finish the
job: one color, two labels, one dialog, and the variables editing surface.
