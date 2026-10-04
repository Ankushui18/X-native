# X-Native Design System — identity v3, **ION**

- Date: 2026-10-04. Status: DOCUMENTED from verified source (`apps/web/src/styles.css`,
  `apps/web/src/ui/x-ui.tsx`, `canvasChrome.ts`, the drift/tokens suites). Supersedes the
  "Graphite & Signal" columns this file carried; those tokens are gone from the sheet, not renamed.
- Visuals verified in a browser this round (light and dark, dashboard and editor).

## The identity

**ION.** Cool graphite neutrals with an indigo cast, one electric-violet brand, and a small set of
technical signal colours that each have exactly one job. The previous identity was green-on-slate
("Graphite & Signal"); the one before that was Figma's own chrome. ION is neither: the accent is violet
(`#5b3df5`), the neutrals never go pure black, every surface is a hairline, and the canvas chrome
(selection, guides, targets, masks, components) is a *family* of distinct inks rather than one green
wearing several hats.

| | Value | Why this one |
|---|---|---|
| Brand | `--accent` `#5b3df5` (hover `#4a2cd8`, press `#3a20ad`, ink `--b-700`) | electric violet — unambiguous against the canvas, the signal colours and every OS accent |
| Component identity | `--comp` `#0092b5` | cyan; never the brand, so an instance never reads as a selection |
| Drop target | `--cv-target` `#00b3d4` | cyan again, only for "you may drop here" |
| Guides | `--cv-guide` `#ff2d55` | magenta; the one colour a document is unlikely to contain |
| Mask | `--cv-mask` `#e39400` | amber; masks are structure, not selection |
| Success / danger / warning | `--green #0f9d63` · `--red #dc2b3c` · `--amber #b45309` | semantic only, never decorative |

## Colors (tokens, light + dark)

| Role | Token | Light | Dark |
|---|---|---|---|
| App bg / canvas / panel / elevated | `--bg` / `--canvas` / `--panel` / `--elevated` | `#f5f6fb` / `#eef0f8` / `#ffffff` / `#ffffff` | `#0b0d16` / `#07080f` / `#111320` / `#151827` |
| Hover / active / selected wash | `--hover` / `--active` / `--sel` | `#eef0f8` / `#e6e8f3` / violet .12 | brighter by one step |
| Lines 1/2/3 | `--line` / `--line-2` / `--line-3` | ink .10 / .18 / .30 | white .10 / .17 / .28 |
| Ink 1/2/3 + disabled | `--text` / `--muted` / `--dim` / `--disabled` | `#171a2b` / ink .68 / ink .46 / ink .32 | `#eef0f8` / white .66 / .46 / .30 |
| Accent family | `--accent`, `-hover`, `-press`, `-ink`, `--on-accent` | violet 600/700/800, ink 700, on-accent white | `#8b7cff` / `#9d90ff` / `#7a68f0`, on-accent `#0b0d16` |
| Washes | `--accent-wash` / `--accent-ring` / `--comp-wash` / `--red-wash` / `--amber-wash` / `--green-wash` | violet .14 / .40, cyan .14, red .12, amber .12, green .14 | same inks, brighter |
| Fields, dock, overlays | `--input` / `--well` / `--field-focus` / `--dock` / `--scrim` / `--checker` | `#f5f6fb` / `#f5f6fb` / `#ffffff` / white .9 / ink .46 / `#c9ccda` | `#151827` / `#111320` / `#1a1e30` / `#0b0d16` .92 / ink .55 |
| Canvas chrome (`--cv-*`, 20 roles) | `--cv-sel` `#5b3df5` · `-wash` .14 · `-glow` .32 · `--cv-ink` `#ffffff` · `--cv-lock` `#8e93a8` · `--cv-guide` `#ff2d55` · `--cv-target` `#00b3d4` · `--cv-mask` `#e39400` · `--cv-chip` ink .94 · `--cv-chip-line` white .16 · `--cv-chip-ink` `#f4f5fa` · `--cv-well` `#eef0f8` · `--cv-line` `#d8dbe9` · `--cv-dim` `#8a8fa6` · `--cv-scrim` ink .46 · `--grid` violet .07 · `--canvas-label` ink .5 | dark retunes 17 of them (`--cv-sel` `#8b7cff`, well/panel `#111320`, canvas `#07080f`, grid .1, …); `--cv-ink`, `--cv-chip-ink` and `--cv-dim` are shared |

The canvas chrome row is the `--cv-*` family: the roles the 2D surfaces paint with, read once per frame
by `apps/web/src/ui/canvasChrome.ts` — `readCanvasChrome` is pure, `canvasChrome()` does the style read,
and `withAlpha(role, α)` thins a role instead of hardcoding another `rgba(…)`. Three rules make it hold.
**Selection ink is not the control accent**: `--accent` is contrast-tuned for panel surfaces, `--cv-sel`
sits on `--canvas`, and the two are allowed to disagree. **The family carries chrome only**: a value
written into the document (a slice's stroke, a paint-bucket default, a glass tint, a boolean mask) stays
a *named* `DOC_*` constant at its call site, because it must not move with the viewer's theme or the SVG
export would. **The Figma opt-in is one block**: `html[data-canvas-chrome="figma"]` re-points only the
selection family, the grid and the drop target to `#0d99ff`; it cannot touch `--accent`, and
`canvasChrome.test.mjs` §5 fails if it grows a key. `canvasChrome.test.mjs` also pins the module's
fallbacks to the light column of this table, key for key.

## Scales (the vocabulary)

- **Space**: `--sp-0…--sp-24`, a strict 4px ladder (0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40,
  48, 56, 64, 72, 80, 96). No gap, pad or margin in the chrome is off it.
- **Height**: `--h-sm` 22, `--h-md` 26 (row and field), `--h-lg` 30, `--h-section` 26, `--h-dock` 44.
- **Radius**: `--r-0…--r-6` (2/3/4/6/8/10/12) plus `--r-pill` and the by-role names `--r-control` (4) /
  `--r-surface` (6) / `--r-popover` (8) / `--r-modal` (12). Inputs 4, panels 6, popovers 8, dialogs 12 —
  stated so a new surface does not invent a fifth.
- **Type**: `--fs-3xs…--fs-3xl` (9…22) with `--fw-*`, `--lh-*` and the role shorthands `--t-label`
  (600 10/13), `--t-control` (500 11/14), `--t-body` (400 11/15), `--t-section` (600 11/16) and
  `--t-num` (tabular, for anything read as a number). Inter for UI, JetBrains Mono for code and lined-up
  numerals; both self-hosted.
- **Motion**: `--dur-1/2/3` (90/140/220ms) with one `--ease`; a control transitions background, border,
  colour and shadow, and nothing else.
- **Elevation**: `--elev-raised` / `--elev-floating` / `--elev-overlay` / `--elev-modal`; shadows are
  never written by hand.
- **Geometry**: `--hairline` (1px), `--ring-w` (2px, the focus ring), `--rail` 54, `--left-w` 248,
  `--right-w` 296 (both panel widths are user-draggable, written back as inline custom properties).
- **Icons**: 12 (rows) / 14 (controls) / 16 (toolbar) via `caretSize()` / `rowIconSize()`; 20px is
  reserved for marks. Canvas frame labels are a constant 11px.

## How the scales are kept

`src/ui/__tests__/tokens.test.mjs` is the contract, and it fails on all four of:

1. a hex literal or `rgba()` in a component rule of `styles.css` (three exceptions: the saturation
   square's two axes and the hue strip — a colour model, not chrome, each named as a pattern);
2. a `var(--x)` whose `--x` is never declared;
3. a raw `font-size`, `border-radius` or spacing value in a component rule (the ladders are complete, so
   a new number is a signal), or a surface anchored on a fraction of a pixel;
4. a colour literal in `src/ui` that is not *named on the line that writes it* — `const NAME = "#…"`,
   `NAME: "#…"`, or a labelled table row like `["White", "#ffffff"]`.

`src/ui/__tests__/drift.test.mjs` counts what is still raw per surface (inline style objects, quoted
hexes, `title=`, raw `<button>`, raw `<select>`) and holds each file at its measured ceiling. The two
suites are the two halves of one rule: the ratchet says *how much* raw styling is left, the token suite
says *what it is allowed to be*. Every row is at its measured value — a round that earns a lower number
lowers it in the same commit.

Debt: the legacy alias block at the end of the token column (`--blue`, `--fg`, `--border` and the older
`--elev-*` spellings) keeps pre-round call sites compiling; new code reads the role names above.
`--blue` and `--blue-hover` are aliases OF the accent, not a second blue — rename, never reuse.

Debt, measured and ratcheted (2026-10-04, after identity v3): `src/ui/*.tsx` carries **414 inline
`style={{` objects, 69 quoted hex literals, 370 native `title=`, 386 raw `<button>` and 59 raw
`<select>`** across 22 surfaces, each number pinned per file in `drift.test.mjs`. The ION round lowered
seven rows (`ZenHUD` 16/14/9/6/0 → 2/0/5/3/0, `RadialMenu` 3/6 → 1/0, `icons.tsx` 0/3 → 0/0, `Canvas`
colours 14 → 9, `FigInspectorModal` 10 → 0, `chrome` 4 → 1, `inspector` 190/44 → 189/22). What remains
in those colour columns is *document ink* — a default fill, a sample file's palette, a device bezel, a
code generator's fallback — and none of it is anonymous any more.

## Components (source of truth → adoption)

- Button/input/numeric/select/segmented/popover/dialog/tabs: `x-ui.tsx` (`XButton`/`XInput`/
  `XNumericInput`/`XSelect`/`XSegmentedControl`/`XPopover`/`XDialog`/`XTabs`) + `PropertyField`,
  `XSection`, `ContextToolbar`. ADOPTION (measured 2026-09-26, `<X…` call sites outside `x-ui.tsx`):
  `XButton` 14 (DialogHost + the inspector's vector card), `XSegmentedControl` 5 (dev-seg, the vector
  card's mirroring + offset join), `XPopover` 2 (EffectPopover, the bind picker), `XDialog` 2,
  `XTabs` 1, `ContextToolbar` 1 — and still **0** for `XInput`, `XNumericInput`, `XSelect`,
  `PropertyField` and `XSection`, which the inspector's own `Field`/`Section` predate and outclass
  (arithmetic, Mixed, multi-value, scrub, fold + persistence). The migration is therefore *not*
  "replace Field with XNumericInput"; it is either promote `Field`/`Section` into x-ui or retire the
  five orphans — decide before adopting them anywhere new.
- Action rows vs switches: a segmented control is for a value the layer has (`role="tab"` + one
  `aria-selected` + one tab stop). A row of one-shot actions — align, distribute, tidy — is the
  panel's `.align > .g` idiom of plain buttons behind `Tooltip`, with no selection claim. Passing
  `value=""` to `XSegmentedControl` for such a row is a defect, not a shortcut: its roving tabindex
  then gives every tab `tabindex="-1"` and the row leaves the tab order.
- Inspector: `Section` (collapse + persist + `openSection` bus) + `Field` (arithmetic, Mixed,
  multi-values, tokens, disabled-reasons) + `ColorRow` (swatch/hex/opacity/visibility/export/remove +
  anchored picker) + `BindingChip`. All new rows compose these; no bespoke headers (IN-U3/U4).
- Tooltip: `Tooltip.tsx` (label + shortcut, 380ms + chaining, portal, clamped) — replaces ALL native
  `title=` on controls (§2.3); add focus trigger (TY-U6).
- Menus: `ContextMenu.tsx` (clamped, Esc, arrows + submenus) for all right-click + "more" menus.
- Toast: inverted chip, bottom-center, 1.6–4s; failures always carry reasons.
- Tabs: ONE system — `XTabs` styling for text tabs; one seg primitive for icon segs (PM-U5/IN-U7).
- Canvas overlays: selection ring + kind-dialect handles (frame 7px / shape 6px / vector diamond /
  hug-text sides / line ends), purple for components, rotate zone 6–22px + angle badge, size badge
  (add viewport clamp, FR-U4), locked dialect REQUIRED (FR-U1), top-level-only labels.

## Rules
0. Cross-component signals are window CustomEvents named `x-…`, and every one of them is listed in
   `ui/__tests__/events.test.mjs` — with the file that sends it and the file that hears it. A dispatch with
   no listener is a phantom control (the radial's Bend slice promised a tool and did nothing for months);
   a listener with no dispatch is dead wiring; a listener without its matching `removeEventListener` leaks
   one handler per mount. The test fails on all three, and on any new event that is not in the census.


1. No new raw `<button>`/`<select>`/tooltip/`title=` in product surfaces — compose the primitives.
2. No hardcoded colors/geometry in chrome — tokens (or canvas-fed tokens) only.
3. Every icon-only control: Tooltip label + shortcut, focus-visible, aria-label.
4. Every popover: anchor + viewport clamp + Esc + outside-click + initial focus.
5. Every dialog: `XDialog` (or pattern twin), focus in, Esc/outside-close, no native prompt/confirm,
   and the keyboard stays inside it while it is open (`useFocusTrap`, ui/escape.ts): Tab at the last
   control wraps to the first, Shift+Tab at the first wraps to the last, disabled controls are not stops.
   Non-modal overlays (popovers, menus, flyouts) are deliberately not trapped — Tab leaving them is how
   a keyboard user gets out.
6. A modal owns the keyboard while it is open: Escape (one owner, `ui/escape.ts`), Tab (the trap), and
   nothing else reaches the editor — the global chords (tool letters, ⌘A/⌘Z, Delete, ⌘K, zen, the radial
   menu) stand down on `modalOpen()`. A modal registers with `modal: true`; a popover, menu or flyout does
   not, because the user is still working with the canvas under it and Delete there should still delete.
7. Transient status is announced, not just drawn: a confirmation goes to both channels — the `.toast` pill
   and the hidden `LiveStatus` region (`ui/announce.tsx`, `role="status"`/`aria-live="polite"`), which is
   mounted before it has anything to say. A stream that arrives on its own is a `role="log"` (`LiveLog`).
   Those are the product's only live regions; the one `assertive` message is the dialog's validation error.
   Never make the visible pill a live region as well, or the user hears everything twice.
6. Multi-select: Mixed-or-aggregate everywhere; first-layer values must never masquerade (IN-U1/TY-U3).
7. Bound props: visible indicator + "explicit edit wins" (FS-U1/U5/U6).
