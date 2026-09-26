# Figma Behavior Parity Audit — X-Native (TS)

- Date: 2026-09-26. Branch: `arena/01a0d904-x-native`, HEAD `6e0e90d` (base `c7c6d34`).
- Working ledger (per-section evidence, code refs, Deferred lists): `X-Native/docs/BEHAVIOR_AUDIT_2026-09-26.md` (§§5–26).
- This document is the §44.5 deliverable: what was audited, what Figma does, what X did, and what was found.
- Companion: `FIGMA_BEHAVIOR_PARITY_FIXES.md` (every fix, files, tests, verification).
- Path note: the repo has no repo-root `docs/`; both deliverables live in `X-Native/docs/` alongside the ledger.

## 1. Scope

Only features X-Native already has, benchmarked against documented Figma behavior. No new Figma-only
capabilities were added (pattern/video fills, branching, multiplayer, version history, FigJam/AI tools, etc.).
Graphite & Signal visual identity and the existing engine architecture were preserved; fixes went to the
smallest correct layer (engine model → canvas interaction → inspector/chrome surface).

## 2. Method and method limits (read before citing this audit)

- Source of Figma truth: official Figma help-center articles per area (named in each § below) plus the
  Figma keyboard-shortcut article for chords. No Figma client was available in this sandbox; "Figma behavior"
  = behavior as documented in those articles.
- Every X behavior was inspected in source (`X-Native/apps/web/src`), exercised through headless
  unit/component tests, and cross-checked against the cited article.
- Sandbox limits, stated plainly:
  - **No browser.** The E2E runner (`e2e/behaviour.mjs`) requires Chromium; provisioning failed
    (no cargo, puppeteer CLI unusable, direct Chrome-for-Testing download blocked, zero GUI libs).
    **E2E is NOT VERIFIED**, not claimed.
  - **No Rust toolchain.** The product track is TypeScript (`track=ts`); Rust results are N/A, not claimed.
  - Pointer/keyboard interactions were **code-traced and headless-tested, not physically clicked.**
    Anything requiring a live pointer (drag feel, hover paint timing) is marked as such in §8.

## 3. Severity rubric

- **P0** — feature unusable, data corruption, or destructive-on-common-path. Fix immediately.
- **P1** — significant behavior mismatch a user hits in normal flows, or accepted-but-unrenderable values.
- **P2** — polish/minor: labels, tooltips, micro-feedback, edge cases, dead code.

## 4. Executive counts (§44.6–44.7)

| Measure | Count |
|---|---|
| Audit areas (prompt §§5–26 + transverse §§27–30) | 22/22 areas audited |
| Findings with fix IDs | **225** (P0 9, P1 123, P2 93) |
| Fixed on this branch | **224** (P0 9/9, P1 122/123, P2 93/93) |
| Open (known, recorded §8) | 1 × P1: rotation-sign convention (§7 deviation) |
| Deferred holes recorded (no fix ID) | locked-layer patch whitelist (P1), tidy readout w/o surface (P2) |
| Verified-parity confirmations (no fix needed) | 40+ (listed per §) |
| Out-of-scope capabilities recorded (not attempted) | ≈60 (condensed §9; 2 later superseded: tidy-up §20, italic §26) |
| Suite | 1216 → **1776 passed / 0 failed** (22 files; § trackers record ~610 added checks, net +560 after consolidation) |
| TS build / `tsc -b` | ✓ 0 errors; `npm run build` ✓ 4.31s |
| E2E / Rust | NOT VERIFIED (no browser) / N/A (no toolchain; TS track) |

## 5. Figma references used (official help articles, by area)

Frames; Select layers and objects; Adjust alignment, rotation, and position; Navigate the canvas;
Create and manage guides (+ grids article); Apply fills; Apply strokes; Apply effects; Crop images +
mask/place-image articles; Format text; Vector networks + Pen tool; Layers panel; Components;
Variables; Auto layout; Inspector/fields per-prop docs; Toolbar; Menus; Prototype triggers/actions;
Export; Version history/undo; Keyboard shortcuts. Full per-section citation lines live in the ledger.

## 6. Findings by area — Figma behavior vs X behavior

Disposition: **FIXED** (shipped + tested), **OPEN** (recorded, not fixed), **PARITY** (verified, no action).

### §5 Frames (F-001–F-009 + macOS chord cleanup) — 5 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| F-001 | Frame tool = F **or A** | Only F bound | P2 | FIXED |
| F-002 | ⌥⌘G wraps selection in a frame | Help text advertised it; nothing bound, menu display-only | P1 | FIXED |
| F-003 | ⌘⌫ inside a frame ungroups one level (keeps children) | Deleted the whole selection | P1 | FIXED |
| F-004 | Click-placed top-level frames reuse last top-level size | Nested frames inherited parent size | P2 | FIXED |
| F-005 | ⌥⌘E resizes frame to fit content | Chord + function missing | P1 | FIXED |
| F-006 | Device presets land left of current frame at same Y; repeats swap device | Cascaded diagonally | P2 | FIXED |
| F-007 | Esc climbs one level (child→frame→top→page) | Esc cleared selection at frame level | P1 | FIXED |
| F-008 | Frame hover shows quick-add badges | No badges (only duplicate existed) | P2 | FIXED |
| F-009 | W/H fields scrub | No scrub on dimension fields | P2 | FIXED |
| — | Boolean chords work on macOS | `e.code`-only branch dead on macOS dead-keys; duplicate branch | P1 | FIXED |
| — | Type-aware chrome: 6–22px corner rotate zone, handles, top-level-only labels | Confirmed in source (Canvas.tsx rotate zone ≤22/≥6 verified this session) | — | PARITY |

### §6 Selection (S-001–S-005) — 3 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| S-001 | Click on an already-selected group drills into it | Click did nothing (group stayed selected) | P1 | FIXED |
| S-002 | ⇧-range selects siblings (same parent) only | Ranged across parents | P1 | FIXED |
| S-003 | Layers-panel hover highlights canvas object | No hover highlight | P2 | FIXED |
| S-004 | ⇧-marquee replaces the marquee set (anchor kept) | ⇧-marquee unioned onto selection | P1 | FIXED |
| S-005 | Select-same covers Instance | Instance missing from select-same | P2 | FIXED |

### §7 Transform (T-001–T-005 + rotation-sign deviation) — P1 2 fixed + 1 open, P2 3 fixed

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| T-001 | Align/distribute/rotation-origin chords work on macOS | `e.key` chords dead on macOS (dead-keys) | P1 | FIXED |
| T-002 | Aspect lock respects min/max constraints | Lock ignored min/max | P2 | FIXED |
| T-003 | Equations accept tokens like `w/2`, `h-8` | Token parse rejected valid tokens | P2 | FIXED |
| T-004 | ⌥-scrub works from numeric inputs | No ⌥-scrub from inputs | P2 | FIXED |
| T-005 | Shadow offsets rotate with the layer | Shadows stayed axis-aligned on rotate | P1 | FIXED |
| T-DEV | Rotation sign convention matches Figma | Sign convention unverified vs Figma | P1 | **OPEN** |

### §8 Navigation (N-001–N-002) — 1 × P1, 1 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| N-001 | Zoom labels read "Zoom in / Zoom out" | Labels swapped | P2 | FIXED |
| N-002 | Pixel snap applies to all move paths | Gaps: some move paths skipped snapping | P1 | FIXED |

### §9 Guides & grids (G-000–G-007) — 1 × P0, 5 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| G-000 | Rulers/guides visible and grabbable | Guides invisible AND ungrabbable (CSS classes missing) | P0 | FIXED |
| G-001 | Repeated nudges coalesce to one undo step | One undo entry per nudge | P2 | FIXED |
| G-002 | Guides selectable (Delete/Esc/menu act on them) | No guide selection at all | P1 | FIXED |
| G-003 | Frames have frame-level guides | Only canvas guides existed | P1 | FIXED |
| G-004 | Resize snaps to guides | Resize ignored guides | P1 | FIXED |
| G-005 | Canvas margin 10% | 8% margin | P2 | FIXED |
| G-006 | Fixed grids render columns/rows/gutter/margins | Settings stored but renderer ignored them | P1 | FIXED |
| G-007 | Layout-grid fields (count, gutter, margins) in inspector | Fields missing | P1 | FIXED |

### §10 Fills (P-001–P-010) — 6 × P1, 4 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| P-001 | Angular gradient mirrors correctly | Mirrored output | P1 | FIXED |
| P-002 | Conic sweep starts at Figma origin | Sweep origin 90° off | P1 | FIXED |
| P-003 | Radial gradients can be elliptical | Forced circular | P1 | FIXED |
| P-004 | Gradient handles target visible stops | Handles targeted hidden/removed stops | P1 | FIXED |
| P-005 | Rotate/blend apply to extra fills | Dead on extras (first fill only) | P1 | FIXED |
| P-006 | − removes the fill | Only hid it (ghost fill) | P2 | FIXED |
| P-007 | Delete removes selected stop | Delete ignored stop selection | P2 | FIXED |
| P-008 | Inserted stop takes neighbor color | Inserted wrong color | P2 | FIXED |
| P-009 | Same-color stops stay distinguishable/selected | Selection lost on same-color stops | P2 | FIXED |
| P-010 | Image fill type always resolvable | Dead-end choice when no image | P1 | FIXED |

### §11 Strokes (K-001–K-009) — 3 × P1, 6 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| K-001 | Dash phase/offset honored | Phase ignored | P2 | FIXED |
| K-002 | Dash cap style honored | Caps wrong on dashed strokes | P2 | FIXED |
| K-003 | Join style hover preview | No preview | P2 | FIXED |
| K-004 | Width profiles render on branching paths | Branching swallowed the stroke | P1 | FIXED |
| K-005 | Outside spill clickable/selectable | Spill region unclickable | P1 | FIXED |
| K-006 | Join control visible with arrowheads | Join hidden when arrows on | P2 | FIXED |
| K-007 | Only supported stroke fills offered | Phantom gradient/image/blend controls (edits silently dropped) | P1 | FIXED |
| K-008 | Circle line tip offered | Missing tip | P2 | FIXED |
| K-009 | "Align" label for stroke position | Label mismatch | P2 | FIXED |

### §12 Effects (L-001–L-010) — 8 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| L-001 | Noise/texture stack in Figma order | Wrong stack order | P1 | FIXED |
| L-002 | Multiple noise effects + correct labels | First-noise-only + mislabeled | P1 | FIXED |
| L-003 | Multiple shadows on text/booleans | First-shadow-only on text/bool | P1 | FIXED |
| L-004 | Show-behind honored | Ignored | P1 | FIXED |
| L-005 | Spread gated to supporting types | Spread applied where invalid | P1 | FIXED |
| L-006 | Effect hover preview | No preview | P2 | FIXED |
| L-007 | ⌘D in effects popover duplicates the effect | Duplicated the whole layer | P1 | FIXED |
| L-008 | Background blur on invalid target warns | Silent no-op | P2 | FIXED |
| L-009 | Shadows render with extra-only fills | No shadow when only extra fills | P1 | FIXED |
| L-010 | Noise renders on line layers | Noise vanished on lines | P1 | FIXED |

### §13 Images & masks (M-001–M-010 + export peek + labels) — 1 × P0, 5 × P1, 4 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| M-001 | Masks clip text/alpha/blur correctly | Mask clip wrong for text, alpha, blurred content | P0 | FIXED |
| M-002 | Mask outlines viewable | No outlines view | P2 | FIXED |
| M-003 | Crop tool with handles | No crop interaction | P1 | FIXED |
| M-004 | Place-image flow | No place flow | P1 | FIXED |
| M-005 | Image cascade order | Wrong cascade | P2 | FIXED |
| M-006 | Tile mode + adjustments modeled | Model gaps (tile/adjust) | P1 | FIXED |
| M-007/008 | — | Verified parity, no action | — | PARITY |
| M-009 | Stacked image fills render | Only first image fill rendered | P1 | FIXED |
| M-010 | Fit readout label | Wrong label | P2 | FIXED |
| M-EX | Export peeks through masks correctly | Export peeked unmasked output | P1 | FIXED |
| M-LBL | Video labels correct | Wrong labels | P2 | FIXED |

### §14 Typography (Y-001–Y-015) — 12 × P1, 3 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| Y-001 | Dragging auto-width/height becomes fixed | Stayed auto after drag | P1 | FIXED |
| Y-002 | Vertical align gated to fixed-height | Applied on auto-height (no-op/confusing) | P1 | FIXED |
| Y-003 | Small caps render | Not rendered | P1 | FIXED |
| Y-004 | Leading floored per Figma | No floor (collapse) | P1 | FIXED |
| Y-005 | Indent gated to supporting align | Indent on wrong aligns | P2 | FIXED |
| Y-006 | Tracking honored on justified text | Tracking dropped on justify | P1 | FIXED |
| Y-007 | Strikethrough positioned per Figma | Wrong position | P2 | FIXED |
| Y-008 | Hug height measured correctly | Wrong hug height | P1 | FIXED |
| Y-009 | Truncate + max-lines honored | Ignored | P1 | FIXED |
| Y-010 | Click another text to edit it | Click didn't switch editing target | P1 | FIXED |
| Y-011 | Advertised chords bound; ⌥⌘L doesn't nuke layout | Chords unbound; ⌥⌘L removed auto-layout | P1 | FIXED |
| Y-012 | Metric chords bound + text rehugs | Chords missing; stale hug | P1 | FIXED |
| Y-013 | Style label correct | Mislabeled | P2 | FIXED |
| Y-014 | Dev-mode CSS emits valid lists | Invalid CSS lists emitted | P1 | FIXED |
| Y-015 | Clamp accepted values to renderer capability | Phantom values accepted, never rendered | P1 | FIXED |

### §15 Vectors (V-001–V-010) — 5 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| V-001 | Boolean members drillable, not pre-flattened | Flattened up front; dead drill | P1 | FIXED |
| V-002 | Backspace with no point selected does nothing | Ate an anchor (geometry loss) | P1 | FIXED |
| V-003 | Close-ring affordance scoped | Ring offered everywhere | P2 | FIXED |
| V-004 | Click inserts point on path; new draft is explicit | Second draft started instead of insert | P1 | FIXED |
| V-005 | Arrows move selected points in edit mode | Arrows moved the whole layer | P1 | FIXED |
| V-006 | ⇧ constrains point drag | No constrain | P2 | FIXED |
| V-007 | Inserting a point preserves curve shape | Insert split/deformed the arc | P1 | FIXED |
| V-008 | Tangents stay smooth on drag | Tangent kinked | P2 | FIXED |
| V-009 | ⌥-pull drags handle independently | No ⌥-pull | P2 | FIXED |
| V-010 | Zero-length segments cleaned | Zero-length segments kept (bad hit/export) | P2 | FIXED |

### §16 Layers (L-001–L-007) — 3 × P1, 4 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| L-001 | Lock inherits: locked subtree not editable | Locked children still editable | P1 | FIXED |
| L-002 | Ungroup single-child splices; rotation preserved | Wrong splice; rotation lost | P1 | FIXED |
| L-003 | Cross-parent move works | Cross-parent move no-op | P1 | FIXED |
| L-004 | ⌥-fold folds subtree | No ⌥-fold | P2 | FIXED |
| L-005 | Selecting canvas object reveals panel row | No reveal | P2 | FIXED |
| L-006 | Whitespace-only rename rejected | Accepted (blank names) | P2 | FIXED |
| L-007 | Inline rename + drag reorder | Prompt rename only; weak reorder | P2 | FIXED |

### §17 Components (C-001–C-013) — 5 × P0, 7 × P1, 1 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| C-001 | Instance member geometry doesn't leak to main | Leaked | P1 | FIXED |
| C-002 | Structural guards (can't ungroup/bool-op instances destructively) | Missing guards | P1 | FIXED |
| C-003 | Library ids unique per component | Two components shared one id (cross-talk) | P0 | FIXED |
| C-004 | Detaching master doesn't orphan instances | Orphaned instances | P1 | FIXED |
| C-005 | Instance child ids unique | Shared child ids (collision) | P0 | FIXED |
| C-006 | Reset restores the instance's own variant | Reset wrong variant | P1 | FIXED |
| C-007 | Overrides apply to own instance | Cross-wired overrides | P1 | FIXED |
| C-008 | Insert position correct | Wrong insert position | P2 | FIXED |
| C-009 | Variant edits publish to variant's own def | Silently overwrote another variant's def | P0 | FIXED |
| C-010 | Publish covers nested/override cases | Publish gaps | P1 | FIXED |
| C-011 | Overrides carry across variant switch | Overrides dropped | P1 | FIXED |
| C-012 | Sync never corrupts roots | Deep sync corruption (root mismatch) | P0 | FIXED |
| C-013 | Reset restores member state | Grafted master-root clone inside member | P0 | FIXED |

### §18 Variables (VR-001–VR-014) — 1 × P0, 10 × P1, 3 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| VR-001 | engine binds "variable" alias | Only "var" bound | P1 | FIXED |
| VR-002 | Variable picker on stroke/effects props | Picker missing there | P1 | FIXED |
| VR-003 | Tuple values guarded | Unguarded tuples crashed/coerced wrong | P1 | FIXED |
| VR-004 | Scale-factor applied | Ignored | P1 | FIXED |
| VR-005 | Arc radius accepts variables | Refused | P1 | FIXED |
| VR-006 | Number→string coercion on bind | Bind failed | P1 | FIXED |
| VR-007 | Variable ids unique | Dupe ids silently shadowed in resolution | P0 | FIXED |
| VR-008 | Cyclic aliases refused (no hang) | Cycle possible (infinite loop) | P1 | FIXED |
| VR-009 | String coercion on resolve | Wrong/missing coerce | P1 | FIXED |
| VR-010 | Unlink restores alias target value | Unlink dropped value | P1 | FIXED |
| VR-011 | Rename gestures | Missing | P2 | FIXED |
| VR-012 | Case-only rename allowed | Rejected | P2 | FIXED |
| VR-013 | Picker covers Figma-supported props | Coverage gaps | P2 | FIXED |
| VR-014 | Mode switch snapshots cleanly | Mode snapshot leaked across modes | P1 | FIXED |

### §19 Auto layout (AL-001–AL-014) — 11 × P1, 3 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| AL-001 | Arrow keys flip hug→fixed correctly | Wrong flip behavior | P1 | FIXED |
| AL-002 | Independent row/column gaps | Single gap only | P1 | FIXED |
| AL-003 | min/max honored with wrap | min/max ignored when wrapped | P1 | FIXED |
| AL-004 | Gap readout accurate | Wrong readout | P2 | FIXED |
| AL-005 | First/last margin honored | Ignored | P1 | FIXED |
| AL-006 | List reorder moves layout child | Reorder broke layout position | P1 | FIXED |
| AL-007 | Hidden children toggleable without layout loss | Silent no-op or layout loss | P1 | FIXED |
| AL-008 | Wrap drop index correct | Wrong index | P1 | FIXED |
| AL-009 | Baseline + stroke alignment | Wrong alignment | P1 | FIXED |
| AL-010 | Wrap badge shown | Missing badge | P1 | FIXED |
| AL-011 | Distribute via drag-and-drop | Missing | P1 | FIXED |
| AL-012 | Canvas drag-and-drop into layout | Gaps | P2 | FIXED |
| AL-013 | Align via drag-and-drop | Gaps | P2 | FIXED |
| AL-014 | Keyboard can leave layout context | Trapped | P1 | FIXED |

### §20 Inspector (IN-001–IN-009) — 4 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| IN-001 | Mixed-state shown for multi-select | First-value shown as if uniform | P1 | FIXED |
| IN-002 | Scale (K) vs resize distinguished | Conflated | P1 | FIXED |
| IN-003 | Tidy-up works | Missing/broken tidy-up | P1 | FIXED |
| IN-004 | Multi-select bulk actions | Missing actions | P1 | FIXED |
| IN-005 | Scrub hint on numeric fields | No hint | P2 | FIXED |
| IN-006 | ⌘⌥]/[ z-order alternates | Only ⇧ variants bound | P2 | FIXED |
| IN-007 | Distribute controls | Missing | P2 | FIXED |
| IN-008 | Help URL correct | Wrong URL | P2 | FIXED |
| IN-009 | Constraints editor | Missing editor | P2 | FIXED |

### §21 Toolbar (TB-001–TB-006) — 1 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| TB-001 | Tool state tooltip | Missing/wrong | P2 | FIXED |
| TB-002 | Advertised zoom chord wired | Advertised but unwired | P1 | FIXED |
| TB-003 | Zoom shortcuts complete | Gaps | P2 | FIXED |
| TB-004 | Add-frame affordance | Missing | P2 | FIXED |
| TB-005 | Zoom controls in menus | Missing | P2 | FIXED |
| TB-006 | — | Dead font-list code removed | P2 | FIXED |

### §22 Menus (MN-001–MN-008) — 1 × P1, 7 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| MN-001 | "Paste over selection" label | Wrong label | P2 | FIXED |
| MN-002 | Boolean menu labels | Wrong labels | P2 | FIXED |
| MN-003 | Flatten label | Wrong label | P2 | FIXED |
| MN-004 | Disabled items explain why | Silent no-ops w/ misleading toast | P1 | FIXED |
| MN-005 | Selection submenu complete | Gaps | P2 | FIXED |
| MN-006–008 | Paste/guide/vector labels per Figma | Mismatched labels | P2 | FIXED |

### §23 Prototype (PT-001–PT-019) — 12 × P1, 7 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| PT-001 | Present stays in flow | Dropped out of present | P1 | FIXED |
| PT-002 | Drag vs navigate disambiguated | Drag triggered nav | P1 | FIXED |
| PT-003 | Overlay close behavior | Wrong close | P1 | FIXED |
| PT-004 | All triggers fire | Dead triggers | P1 | FIXED |
| PT-005 | Delay authorable | Delay unauthorable | P1 | FIXED |
| PT-006 | Media triggers work | Broken | P1 | FIXED |
| PT-007 | None→dismiss transition | Missing | P1 | FIXED |
| PT-008 | Smart-animate order | Wrong order | P2 | FIXED |
| PT-009 | Scroll overflow honored | Ignored | P2 | FIXED |
| PT-010 | Reset scroll on entry | Missing | P2 | FIXED |
| PT-011 | Scroll-to gated correctly | Wrong gating | P1 | FIXED |
| PT-012 | Missing action type added (engine cmd existed) | No UI action | P1 | FIXED |
| PT-013 | — | Minor trigger label | P2 | FIXED |
| PT-014 | Overlay positioning | Wrong position | P1 | FIXED |
| PT-015 | — | Minor timing label | P2 | FIXED |
| PT-016 | — | Minor easing label | P2 | FIXED |
| PT-017 | Expression eval for numbers | Eval gap | P1 | FIXED |
| PT-018 | Variable-driven nav resolves | Silently dropped | P1 | FIXED |
| PT-019 | Variable connection lines drawn | Missing lines | P2 | FIXED |

### §24 Export (EX-001–EX-014) — 9 × P1, 5 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| EX-001 | Batch export rows | UI rows missing (engine supported) | P2 | FIXED |
| EX-002 | Slice bounds correct | Wrong bounds | P1 | FIXED |
| EX-003 | Slice model exists | No slice model | P1 | FIXED |
| EX-004 | PDF page size correct | Wrong page size | P1 | FIXED |
| EX-005 | PNG/JPG scale options | Missing scales | P1 | FIXED |
| EX-006 | SVG export choice | Missing choice | P1 | FIXED |
| EX-007 | PDF renderer correct | Wrong renderer | P1 | FIXED |
| EX-008 | Export icon button | Missing | P2 | FIXED |
| EX-009 | Filename suffix default | Wrong default | P2 | FIXED |
| EX-010 | Copy-link works | Broken | P1 | FIXED |
| EX-011 | Lossless SVG emitter | Lossy emitter | P1 | FIXED |
| EX-012 | — | Minor format label | P2 | FIXED |
| EX-013 | Re-import round-trips | Dead-end re-import | P1 | FIXED |
| EX-014 | Scrolled-slice handling | Wrong | P2 | FIXED |

### §25 History (HI-001–HI-007) — 1 × P0, 4 × P1, 2 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| HI-001 | Redo preserved across unrelated edits | Redo eaten | P1 | FIXED |
| HI-002 | First command undoes cleanly | First-cmd undo broken | P1 | FIXED |
| HI-003 | Burst edits coalesce to a real entry | Coalesced into thin air (unundoable + redo eaten) | P0 | FIXED |
| HI-004 | History guards never crash | Guard crash path | P2 | FIXED |
| HI-005 | New command resweeps correctly | Stale sweep | P2 | FIXED |
| HI-006 | Mid-sweep wheel handled | Wheel corrupted sweep | P1 | FIXED |
| HI-007 | First-entry redo works | Broken | P1 | FIXED |

### §26 Keyboard (KB-001–KB-018 + sheet) — 5 × P1, 14 × P2, all FIXED

| ID | Figma behavior | X before | Sev | Disp. |
|---|---|---|---|---|
| KB-001 | Ctrl+Y redoes (Win/Linux) | Swallowed | P1 | FIXED |
| KB-002 | ⌘I toggles italic | Chord missing + no model | P1 | FIXED |
| KB-003 | Chords work on macOS dead-keys | Dead on Mac | P1 | FIXED |
| KB-004 | `/` removes stroke, `⌥/` removes fill | Actions missing | P1 | FIXED |
| KB-005–016 | Text-edit, type-tool guard, vector, layer, pixel-zoom, grid, align, distribute, show/hide UI, boolean, layer-list chords per official article | Gaps/mismatches | P2 | FIXED |
| KB-017 | Menu arrows navigate; Esc closes menu w/o losing selection | Arrows dead; Esc cleared selection | P1 | FIXED |
| KB-018 | Library/asset chords | Missing | P2 | FIXED |
| KB-S | Shortcut sheet matches bindings | Stale entries | P2 | FIXED |

## 7. Feature matrix (§37) — one row per audited feature

Status: ✅ fixed to parity · ⏺ verified parity (no fix) · ❌ open. Tests = regression file (counts §4).

| # | Feature | Figma | X now | St | Sev | Tests |
|---|---|---|---|---|---|---|
| 1 | Frame tool chords (F/A) | F or A | F + A | ✅ | P2 | parity |
| 2 | Wrap in frame ⌥⌘G | Wraps selection | Bound + menu wired | ✅ | P1 | parity |
| 3 | Ungroup ⌘⌫ | Ungroups one level | Splices children, keeps them | ✅ | P1 | parity |
| 4 | Click-place size reuse | Reuse last top-level size | Top-level-only reuse | ✅ | P2 | parity |
| 5 | Resize to fit ⌥⌘E | Fits frame to content | Chord + fn shipped | ✅ | P1 | parity |
| 6 | Device presets | Land left, same Y; swap on repeat | Matches | ✅ | P2 | parity |
| 7 | Esc level-up | Climbs to page | Climbs child→frame→page | ✅ | P1 | parity |
| 8 | Quick-add badges | On frame hover | Badges shipped | ✅ | P2 | parity |
| 9 | Dimension scrub | W/H scrub | Scrub on W/H | ✅ | P2 | parity |
| 10 | Boolean chords on macOS | Work | code+key fallback, deduped | ✅ | P1 | parity |
| 11 | Selection chrome/rotate zone/labels | 6–22px zone, top-level labels | Verified in source | ⏺ | — | — |
| 12 | Drill into selected group | Click drills in | Drills in | ✅ | P1 | parity |
| 13 | ⇧-range | Siblings only | Same-parent only | ✅ | P1 | parity |
| 14 | Panel hover highlight | Highlights canvas | Highlights | ✅ | P2 | parity |
| 15 | ⇧-marquee | Replaces marquee set | Replaces (anchor kept) | ✅ | P1 | parity |
| 16 | Select-same instance | Covers instances | Covers | ✅ | P2 | parity |
| 17 | macOS e.key chords (align/origin) | Work | code+key fallback | ✅ | P1 | parity |
| 18 | Aspect lock + min/max | Lock respects min/max | Respects | ✅ | P2 | parity |
| 19 | Equation tokens | w/2, h−8 accepted | Accepted | ✅ | P2 | parity |
| 20 | ⌥-scrub from inputs | Scrubs | Scrubs | ✅ | P2 | parity |
| 21 | Shadow rotation | Offsets rotate w/ layer | Rotate | ✅ | P1 | parity |
| 22 | Rotation sign convention | Figma sign | UNVERIFIED | ❌ | P1 | — |
| 23 | Zoom labels | "Zoom in/out" | Fixed | ✅ | P2 | parity |
| 24 | Pixel snap | All move paths | All paths | ✅ | P1 | parity |
| 25 | Guide visibility/grab | Visible + grabbable | CSS + hit shipped | ✅ | P0 | guides |
| 26 | Nudge coalescing | One undo step | Coalesced | ✅ | P2 | guides |
| 27 | Guide selection | Selectable | Select/Delete/Esc/menu | ✅ | P1 | guides |
| 28 | Frame guides | Per-frame guides | Shipped | ✅ | P1 | guides |
| 29 | Resize→guide snap | Snaps | Snaps | ✅ | P1 | guides |
| 30 | Canvas margin | 10% | 10% | ✅ | P2 | guides |
| 31 | Fixed grids render | col/row/gutter/margin | Rendered | ✅ | P1 | guides |
| 32 | Layout-grid fields | count/gutter/margins | Fields shipped | ✅ | P1 | guides |
| 33 | Angular gradient | Correct mirror | Correct | ✅ | P1 | fills |
| 34 | Conic sweep origin | Figma origin | Fixed | ✅ | P1 | fills |
| 35 | Elliptical radial | Elliptical | Elliptical | ✅ | P1 | fills |
| 36 | Gradient handle targeting | Visible stops | Retargeted | ✅ | P1 | fills |
| 37 | Rotate/blend on extras | Apply | Apply | ✅ | P1 | fills |
| 38 | Delete fill | Removes | Removes | ✅ | P2 | fills |
| 39 | Delete stop | Removes stop | Removes | ✅ | P2 | fills |
| 40 | Insert stop color | Neighbor color | Neighbor | ✅ | P2 | fills |
| 41 | Same-color stop select | Stable | Stable | ✅ | P2 | fills |
| 42 | Image fill type | Always resolvable | No dead-end | ✅ | P1 | fills |
| 43 | Dash phase | Honored | Honored | ✅ | P2 | strokes |
| 44 | Dash cap | Correct caps | Correct | ✅ | P2 | strokes |
| 45 | Join preview | Hover preview | Preview | ✅ | P2 | strokes |
| 46 | Width profile (branching) | Renders | Renders | ✅ | P1 | strokes |
| 47 | Outside spill hit | Clickable | Clickable | ✅ | P1 | strokes |
| 48 | Join + arrows | Join visible | Visible | ✅ | P2 | strokes |
| 49 | Stroke fills offered | Supported only | Phantoms removed | ✅ | P1 | strokes |
| 50 | Circle tip | Offered | Offered | ✅ | P2 | strokes |
| 51 | Stroke align label | "Align" | Fixed | ✅ | P2 | strokes |
| 52 | Noise stack order | Figma order | Fixed | ✅ | P1 | effects |
| 53 | Multi-noise + labels | Supported + labeled | Supported | ✅ | P1 | effects |
| 54 | Multi-shadow text/bool | Supported | Supported | ✅ | P1 | effects |
| 55 | Show-behind | Honored | Honored | ✅ | P1 | effects |
| 56 | Spread gating | Gated | Gated | ✅ | P1 | effects |
| 57 | Effect preview | Hover preview | Preview | ✅ | P2 | effects |
| 58 | ⌘D in fx popover | Dupes effect | Dupes effect | ✅ | P1 | effects |
| 59 | BG-blur invalid target | Warns | Warns | ✅ | P2 | effects |
| 60 | Shadow + extra-only fill | Renders | Renders | ✅ | P1 | effects |
| 61 | Noise on lines | Renders | Renders | ✅ | P1 | effects |
| 62 | Mask rendering | Clips text/alpha/blur | partitionMaskRuns | ✅ | P0 | images |
| 63 | Mask outlines view | Viewable | Shipped | ✅ | P2 | images |
| 64 | Crop | Handles + commit | Shipped | ✅ | P1 | images |
| 65 | Place image | Flow exists | Shipped | ✅ | P1 | images |
| 66 | Image cascade | Correct order | Fixed | ✅ | P2 | images |
| 67 | Tile/adjust model | Modeled | Modeled | ✅ | P1 | images |
| 68 | Stacked image fills | All render | Render | ✅ | P1 | images |
| 69 | Fit readout | Correct label | Fixed | ✅ | P2 | images |
| 70 | Export mask peek | Masked output | Masked | ✅ | P1 | images |
| 71 | Video labels | Correct | Fixed | ✅ | P2 | images |
| 72 | Auto→fixed on drag | Becomes fixed | Fixed | ✅ | P1 | typography |
| 73 | Vertical align gate | Fixed-height only | Gated | ✅ | P1 | typography |
| 74 | Small caps | Render | Render | ✅ | P1 | typography |
| 75 | Leading floor | Floored | Floored | ✅ | P1 | typography |
| 76 | Indent gate | Gated | Gated | ✅ | P2 | typography |
| 77 | Tracking on justify | Honored | Honored | ✅ | P1 | typography |
| 78 | Strikethrough | Positioned | Fixed | ✅ | P2 | typography |
| 79 | Hug height | Measured | Fixed | ✅ | P1 | typography |
| 80 | Truncate/max-lines | Honored | Honored | ✅ | P1 | typography |
| 81 | Click-to-edit switch | Switches target | Switches | ✅ | P1 | typography |
| 82 | Advertised type chords | Bound; ⌥⌘L safe | Bound + safe | ✅ | P1 | typography |
| 83 | Metric chords + rehug | Bound + rehug | Shipped | ✅ | P1 | typography |
| 84 | Style label | Correct | Fixed | ✅ | P2 | typography |
| 85 | Dev CSS lists | Valid | Valid | ✅ | P1 | typography |
| 86 | Value clamping | Renderer-honored | Clamped | ✅ | P1 | typography |
| 87 | Boolean drill | Drillable members | Drillable | ✅ | P1 | vector |
| 88 | Backspace (no point) | No-op | No-op | ✅ | P1 | vector |
| 89 | Close-ring scope | Scoped | Scoped | ✅ | P2 | vector |
| 90 | Insert vs draft | Insert on path | Inserts | ✅ | P1 | vector |
| 91 | Arrows in edit mode | Move points | Move points | ✅ | P1 | vector |
| 92 | ⇧-constrain points | Constrains | Constrains | ✅ | P2 | vector |
| 93 | Insert preserves curve | Preserves | Preserves | ✅ | P1 | vector |
| 94 | Tangent smoothness | Smooth | Smooth | ✅ | P2 | vector |
| 95 | ⌥-pull handles | Independent | Independent | ✅ | P2 | vector |
| 96 | Zero-length segments | Cleaned | Cleaned | ✅ | P2 | vector |
| 97 | Lock inheritance | Subtree locked | Enforced | ✅ | P1 | layers |
| 98 | Ungroup single/rotation | Splice + keep rot | Fixed | ✅ | P1 | layers |
| 99 | Cross-parent move | Works | Works | ✅ | P1 | layers |
| 100 | ⌥-fold | Folds subtree | Shipped | ✅ | P2 | layers |
| 101 | Reveal on select | Reveals row | Reveals | ✅ | P2 | layers |
| 102 | Whitespace rename | Rejected | Rejected | ✅ | P2 | layers |
| 103 | Inline rename + reorder | Both work | Both work | ✅ | P2 | layers |
| 104 | Member geometry privacy | No leak to main | No leak | ✅ | P1 | components |
| 105 | Structural guards | Guarded | Guarded | ✅ | P1 | components |
| 106 | Library id uniqueness | Unique | Unique | ✅ | P0 | components |
| 107 | Master detach | No orphans | No orphans | ✅ | P1 | components |
| 108 | Instance child ids | Unique | Unique | ✅ | P0 | components |
| 109 | Reset variant | Own variant | Own | ✅ | P1 | components |
| 110 | Override wiring | Own instance | Own | ✅ | P1 | components |
| 111 | Insert position | Correct | Correct | ✅ | P2 | components |
| 112 | Variant publish target | Own def | Own def | ✅ | P0 | components |
| 113 | Publish coverage | Nested/override | Covered | ✅ | P1 | components |
| 114 | Override carry | Carry on switch | Carry | ✅ | P1 | components |
| 115 | Root sync integrity | No corruption | findInstanceRoot | ✅ | P0 | components |
| 116 | Reset purity | No graft | No graft | ✅ | P0 | components |
| 117 | variable/var alias | Both bound | Both | ✅ | P1 | variables |
| 118 | Picker on stroke/fx | Present | Present | ✅ | P1 | variables |
| 119 | Tuple guard | Guarded | Guarded | ✅ | P1 | variables |
| 120 | Scale-factor | Applied | Applied | ✅ | P1 | variables |
| 121 | Arc radius vars | Accepted | Accepted | ✅ | P1 | variables |
| 122 | Number→string bind | Coerced | Coerced | ✅ | P1 | variables |
| 123 | Variable id uniqueness | Unique | Deduped | ✅ | P0 | variables |
| 124 | Cycle refusal | Refused | Refused | ✅ | P1 | variables |
| 125 | String coerce | Correct | Correct | ✅ | P1 | variables |
| 126 | Unlink alias | Restores value | Restores | ✅ | P1 | variables |
| 127 | Rename gestures | Work | Work | ✅ | P2 | variables |
| 128 | Case-only rename | Allowed | Allowed | ✅ | P2 | variables |
| 129 | Picker coverage | Full | Full | ✅ | P2 | variables |
| 130 | Mode snapshot | Clean | Clean | ✅ | P1 | variables |
| 131 | Hug→fixed arrows | Correct flip | Correct | ✅ | P1 | autolayout |
| 132 | Dual gaps | Row+col | Shipped | ✅ | P1 | autolayout |
| 133 | min/max + wrap | Honored | Honored | ✅ | P1 | autolayout |
| 134 | Gap readout | Accurate | Accurate | ✅ | P2 | autolayout |
| 135 | First/last margin | Honored | Honored | ✅ | P1 | autolayout |
| 136 | List reorder | Keeps layout pos | Keeps | ✅ | P1 | autolayout |
| 137 | Hidden toggle | No layout loss | No loss | ✅ | P1 | autolayout |
| 138 | Wrap drop index | Correct | Correct | ✅ | P1 | autolayout |
| 139 | Baseline + stroke | Aligned | Aligned | ✅ | P1 | autolayout |
| 140 | Wrap badge | Shown | Shown | ✅ | P1 | autolayout |
| 141 | Distribute DnD | Works | Works | ✅ | P1 | autolayout |
| 142 | Canvas DnD into layout | Works | Works | ✅ | P2 | autolayout |
| 143 | Align DnD | Works | Works | ✅ | P2 | autolayout |
| 144 | Keyboard leave layout | Leaves | Leaves | ✅ | P1 | autolayout |
| 145 | Mixed-state | Shown | Shown | ✅ | P1 | inspector |
| 146 | Scale vs resize | Distinguished | Distinguished | ✅ | P1 | inspector |
| 147 | Tidy-up | Works | Works | ✅ | P1 | inspector |
| 148 | Multi-select actions | Present | Present | ✅ | P1 | inspector |
| 149 | Scrub hint | Shown | Shown | ✅ | P2 | inspector |
| 150 | Z-order alternates | ⌘⌥]/[ bound | Bound | ✅ | P2 | inspector |
| 151 | Distribute controls | Present | Present | ✅ | P2 | inspector |
| 152 | Help URL | Correct | Correct | ✅ | P2 | inspector |
| 153 | Constraints editor | Present | Present | ✅ | P2 | inspector |
| 154 | Tool tooltip | Correct | Correct | ✅ | P2 | toolbar |
| 155 | Zoom chord | Wired | Wired | ✅ | P1 | toolbar |
| 156 | Zoom shortcuts | Complete | Complete | ✅ | P2 | toolbar |
| 157 | Add-frame | Present | Present | ✅ | P2 | toolbar |
| 158 | Zoom in menus | Present | Present | ✅ | P2 | toolbar |
| 159 | Paste-over label | Correct | Correct | ✅ | P2 | menu |
| 160 | Boolean labels | Correct | Correct | ✅ | P2 | menu |
| 161 | Flatten label | Correct | Correct | ✅ | P2 | menu |
| 162 | Disabled items | Explain why | Explain | ✅ | P1 | menu |
| 163 | Selection submenu | Complete | Complete | ✅ | P2 | menu |
| 164 | Paste/guide/vector labels | Per Figma | Fixed | ✅ | P2 | menu |
| 165 | Present flow | Stays in flow | Stays | ✅ | P1 | proto |
| 166 | Drag vs nav | Disambiguated | Disambiguated | ✅ | P1 | proto |
| 167 | Overlay close | Correct | Correct | ✅ | P1 | proto |
| 168 | Triggers | All fire | All fire | ✅ | P1 | proto |
| 169 | Delay authoring | Authorable | Authorable | ✅ | P1 | proto |
| 170 | Media triggers | Work | Work | ✅ | P1 | proto |
| 171 | None→dismiss | Supported | Supported | ✅ | P1 | proto |
| 172 | Smart-animate order | Correct | Correct | ✅ | P2 | proto/parity |
| 173 | Scroll overflow | Honored | Honored | ✅ | P2 | proto |
| 174 | Reset scroll | On entry | On entry | ✅ | P2 | proto |
| 175 | Scroll-to gating | Correct | Correct | ✅ | P1 | proto |
| 176 | Missing action type | In UI | Added | ✅ | P1 | proto |
| 177 | Overlay position | Correct | Correct | ✅ | P1 | proto |
| 178 | Expression numbers | Evaluated | Evaluated | ✅ | P1 | proto |
| 179 | Variable nav | Resolves | Resolves | ✅ | P1 | proto |
| 180 | Variable conn lines | Drawn | Drawn | ✅ | P2 | proto |
| 181 | Batch export rows | Present | Present | ✅ | P2 | export24 |
| 182 | Slice bounds | Correct | Correct | ✅ | P1 | export24 |
| 183 | Slice model | Exists | Exists | ✅ | P1 | export24 |
| 184 | PDF page size | Correct | Correct | ✅ | P1 | export24 |
| 185 | PNG/JPG scales | Offered | Offered | ✅ | P1 | export24 |
| 186 | SVG choice | Offered | Offered | ✅ | P1 | export24 |
| 187 | PDF renderer | Correct | Correct | ✅ | P1 | export24 |
| 188 | Export icon button | Present | Present | ✅ | P2 | export24 |
| 189 | Suffix default | Correct | Correct | ✅ | P2 | export24 |
| 190 | Copy-link | Works | Works | ✅ | P1 | export24 |
| 191 | SVG emitter | Lossless | Lossless | ✅ | P1 | export24/codegen |
| 192 | Re-import | Round-trips | Round-trips | ✅ | P1 | export24 |
| 193 | Scrolled slice | Correct | Correct | ✅ | P2 | export24 |
| 194 | Redo preservation | Preserved | Preserved | ✅ | P1 | history25 |
| 195 | First-cmd undo | Clean | Clean | ✅ | P1 | history25 |
| 196 | Burst coalescing | Real entry | Real entry | ✅ | P0 | history25 |
| 197 | History guards | No crash | No crash | ✅ | P2 | history25 |
| 198 | Resweep on new cmd | Correct | Correct | ✅ | P2 | history25 |
| 199 | Mid-sweep wheel | Handled | Handled | ✅ | P1 | history25 |
| 200 | First-entry redo | Works | Works | ✅ | P1 | history25 |
| 201 | Ctrl+Y redo | Redoes | Redoes | ✅ | P1 | keyboard26 |
| 202 | ⌘I italic | Toggles | Toggles (+model) | ✅ | P1 | keyboard26 |
| 203 | macOS dead-key chords | Work | Guarded | ✅ | P1 | keyboard26 |
| 204 | `/` + `⌥/` | Del stroke/fill | Shipped | ✅ | P1 | keyboard26 |
| 205 | Text-edit chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 206 | Type-tool guard | Guarded | Guarded | ✅ | P2 | keyboard26 |
| 207 | Vector chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 208 | Layer chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 209 | Pixel-zoom climb | Climbs | Climbs | ✅ | P2 | keyboard26 |
| 210 | Grid chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 211 | Align chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 212 | Distribute chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 213 | Show/hide UI | Per article | Fixed | ✅ | P2 | keyboard26 |
| 214 | Boolean chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 215 | Layer-list chords | Per article | Fixed | ✅ | P2 | keyboard26 |
| 216 | Menu arrows + Esc | Nav + safe Esc | Fixed | ✅ | P1 | keyboard26 |
| 217 | Library/asset chords | Bound | Bound | ✅ | P2 | keyboard26 |
| 218 | Shortcut sheet | Matches bindings | Audited | ✅ | P2 | keyboard26 |

## 8. Micro-interaction matrix (§38)

Audited = traced in source + headless-tested unless noted. "Live-pointer" rows could not be physically
exercised (no browser) — code path verified, feel NOT VERIFIED.

| # | Micro-interaction | Audited | Verdict |
|---|---|---|---|
| 1 | Hover prelight on canvas objects | Yes | ✅ matches (selection6/parity) |
| 2 | Selection ring color/weight by type | Yes | ✅ verified parity (§5) |
| 3 | Resize handle cursors (8-pt aware) | Yes (traced) | ✅ code-verified; feel NOT VERIFIED |
| 4 | Corner rotate zone (6–22px) | Yes | ✅ re-verified in source this session |
| 5 | Snap indicator lines while drag/resize | Yes | ✅ guides snap (G-004) |
| 6 | Arrow nudge / ⇧×10 | Yes | ✅ + coalesced undo (G-001) |
| 7 | Numeric scrub (fields + ⌥-scrub) | Yes | ✅ F-009, T-004, IN-005 |
| 8 | Equation entry in fields | Yes | ✅ T-003 |
| 9 | Frame quick-add badges | Yes | ✅ F-008 |
| 10 | Guide create/drag/delete/select | Yes | ✅ G-000, G-002 |
| 11 | Gradient stop drag/insert/delete | Yes | ✅ P-007, P-008 |
| 12 | Join/effect hover previews | Yes | ✅ K-003, L-006 |
| 13 | Mask outlines view | Yes | ✅ M-002 |
| 14 | Crop handle drag + commit | Yes (traced) | ✅ code-verified; feel NOT VERIFIED |
| 15 | Baseline trim indicators | Yes | ✅ textLayout verified |
| 16 | Vector hover/insert/bend/⌥-pull | Yes (traced) | ✅ code-verified; feel NOT VERIFIED |
| 17 | Layers-panel hover + reveal | Yes | ✅ S-003, L-005 |
| 18 | Lock grey-out + enforcement | Yes | ✅ L-001 |
| 19 | Menu checkmarks/disabled reasons | Yes | ✅ MN-004 |
| 20 | Toast feedback wording | Yes | ✅ MN-004, L-008 |
| 21 | Zoom % readout + climb | Yes | ✅ N-001, KB-009 |
| 22 | Present transitions/overlays | Yes (traced) | ✅ code-verified; motion NOT VERIFIED |
| 23 | Inline rename commit/cancel | Yes | ✅ L-006, L-007 |
| 24 | Fold chevrons + ⌥-fold | Yes | ✅ L-004 |
| 25 | Asset/search filter | Yes | ✅ search verified |
| 26 | Distribute/wrap badges | Yes | ✅ AL-010 |
| 27 | Mixed-state "Mixed" labels | Yes | ✅ IN-001 |
| 28 | Cursor per tool/mode | Yes (traced) | ✅ code-verified; pixels NOT VERIFIED |

## 9. Remaining known issues (not fixed)

1. **Rotation-sign convention (P1, §7 T-DEV).** Sign of canvas rotation vs Figma unverified; needs a
   Figma-side comparison. Recorded in ledger §7 Deferred.
2. **Locked-layer patch whitelist (P1, §20 deferred hole).** A generic patch path can still touch locked
   layers without going through the L-001 guard. Needs a whitelist at the patch entry point.
3. **Tidy-up gap readout (P2, §20).** No surface shows the tidy gap value; engine computes it.
4. **E2E NOT VERIFIED.** `e2e/behaviour.mjs` exists and is wired (`npm run test:e2e`) but cannot run here:
   no Chromium, provisioning blocked (see §2). Must run in CI/with a browser.
5. **Live-pointer feel NOT VERIFIED** for drag/cursor/motion rows (§8): code paths verified, physical feel
   needs a browser session.

## 10. Out-of-scope capabilities recorded (condensed; full lists in ledger Deferred)

Smart Selection; view-only chrome; minimap drag; multiplayer cursors; guide styles/presets; pattern/video
fills; brush/dynamic strokes; gradient/image/blend stroke fills; progressive blur; GIF animation; TIFF decode;
image strokes; text-on-path; multi-edit; rich runs; % leading; underline details; list spacing; OpenType;
vertical trim; hanging punctuation; font links; spellcheck; missing-font flow; multi-point bbox; lasso select;
vector cut; variable-width subtool; per-point caps; drag-across toggles; mixed lock semantics; batch rename;
push-to-main; per-layer modes; variable scopes/descriptions/groups/search/syntax/publish; duplicate
variable/collection/mode; nested bindings; tidy readout surface; annotation tools; Figma Draw; multi-flow
prototype; prototype cardinality/combos/direction/backdrop/background/collapse; video in prototype; export
overlap render; text trim in export; zip export; DPI settings; vector PDF; video export; 144dpi import; slice
icons; whole-file export; undo labels; version history; ⌘J join; paint bucket; AI bar; versions chord;
libraries chord; box-select tool. (≈60; tidy-up and italic were superseded — shipped in §20/§26.)
