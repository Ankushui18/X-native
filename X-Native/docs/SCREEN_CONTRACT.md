# Screen contract

**Status: P0-1 of UI/UX Refinement v1 — done.** The registry lives in
`crates/x-ui/src/screens.rs`; the rules it encodes are this file. A screen that
breaks one of them fails a test rather than an audit.

Refinement v1's premise is that the app has enough feature breadth and what it
lacks is *consistency*: every surface should look like it was built by the same
hand, using the same names, the same row heights and the same answer to "what
happens when there is nothing to show". That is only enforceable if the list of
surfaces — and what each one owes — exists somewhere other than in the paint
functions.

## The three screens

| Screen | Purpose | Where it sits in the loop |
|---|---|---|
| **Dashboard** | Find, open and start a file. | Entry point. It names the loop (sidebar, primary card) and teaches it on the first run; it does not host the loop. |
| **Editor** | Compose, flow, ship and analyze one file. | The loop. COMPOSE is the default right-dock tab; FLOW, SHIP and UX ANALYSIS follow it in that order. |
| **Board** | Map screens and flows on an infinite canvas. | Before the loop: a place to lay out what will later be composed and connected in FLOW. |

`ScreenId` mirrors the app's `Screen` enum, and
`every_screen_the_app_can_show_is_in_the_contract` (in the designer's regression
suite) fails when the two drift.

## Surfaces

A screen is made of surfaces, typed by `SurfaceKind`. The type decides what the
surface owes:

| Kind | Examples | Owes |
|---|---|---|
| `Toolbar` | title bar, editor toolbar, board tool rail, bulk bar | Fixed height, no scroll, no property rows. |
| `Rail` | editor nav rail | Fixed; icons, not rows. |
| `Dock` | left dock, right dock | Hosts tabs; may scroll under pinned chrome. |
| `Panel` | STRUCTURE, LIBRARY, TOKENS, COMPOSE, FLOW, SHIP, UX ANALYSIS, recents, drafts | Property rows on the control-height scale if it has any; an empty state if it can be empty. |
| `Canvas` | editor page, board canvas | User content. Never property rows; navigation is pan/zoom, not scroll. |
| `Card` | first-run onboarding | One-off, informational. |
| `Modal` | template picker, command palette, find/replace | Scrim, dismissable, no property rows. |
| `Menu` | app menu, context menu, sort menu | Rows on the menu row height; no scroll. |
| `Overlay` | notifications, tooltips | Non-blocking; no hit regions of its own. |

## The rules

**1 · Naming stays X-Native.** The workflow is COMPOSE / FLOW / SHIP / UX
ANALYSIS; the editor's docks are STRUCTURE / LIBRARY / TOKENS. A surface must
not show the internal vocabulary the rename removed — `BANNED_LABELS` in
`screens.rs` rejects *design*, *prototype*, *inspect*, *layers* and *assets* in
a surface's label, which is how the enum-variant names used to reach the UI.

**2 · Property rows snap to the scale.** A panel that owns property rows uses
the control-height standard (`x-ui::metrics`): 28px rows, 24px disclosure rows,
16px chips, 8/6/12px rhythm. `SurfaceSpec::on_standard` is the ledger — today
only COMPOSE is on it, and `OFF_STANDARD_SURFACES` counts the three that are
not (FLOW, SHIP, UX ANALYSIS). That count is P0-5's work list, and it is a
ratchet: lowering it without moving the rows fails the test.

**3 · Scroll rules are declared, not discovered.** `Fixed` chrome never
scrolls; `Content` scrolls; `Pinned` scrolls content *under* pinned chrome,
which means the scrolling region is clipped so rows cannot overdraw the header,
and the scroll clamp covers the worst case (both directions, disclosure open).
Only docks and panels may be `Pinned`.

**4 · An empty state is a place to go next.** `EmptyState::Never` (toolbars,
menus, rails — always have content), `Copy(..)` (says what is true *and* offers
the next step: the trash panel names the way back; the canvas names the frame
tool), or `Silent` — it can be empty and says nothing. `SILENT_EMPTY_STATES`
counts the six that are silent; P0-5 gives each of them copy and lowers it.

**5 · One state language.** Selection, hover and focus are three different
roles (`x-ui::state`): `selection` for what is selected, `surface_hover` for
what is under the pointer, `focus_ring` for the ring on the focused control.
Focus is *additive* — a ring on top of the base state, never instead of it.

**6 · No phantom controls.** A control that is painted with a hover state has a
hit region, or it is not a control. The app's paint functions push
`(Rect, Action)` pairs into one list per frame; that list is the evidence, and
the component contract (below) is what each control owes.

**7 · First run teaches the loop once.** The dashboard's onboarding card names
Compose → Flow → Ship and points at the editor docks for everything else; a
blank page in the editor names the frame tool, FLOW and SHIP. Neither is
dismissable and neither keeps a flag that can go stale — the canvas hint is
keyed on the page being empty and leaves when the first frame lands.

**8 · Adding a surface is a four-line change.** Add the `SurfaceId` variant, add
the row to `SURFACES`, add the variant to `SURFACE_VARIANTS`, and update the
ledgers if the new surface owns property rows or can be empty. The registry
tests then hold it to the rules above.

## What is left

The cross-screen pass (P0-5) owns everything the ledgers count:

- FLOW, SHIP and UX ANALYSIS rows onto the control-height scale;
- copy for the six silent empty states (drafts, STRUCTURE, TOKENS, the SHIP
  code panel, notifications, the board canvas);
- the board brought onto the language the editor and dashboard share.

One question the contract surfaced and P0-5 should answer: a hovered *row* is
painted `surface_elevated` (`C_ROW_HOVER`), which is the same role a resting
*field* uses (`C_FIELD`) — the state language says hover is `surface_hover`, as
inputs already do. Either a row hover is its own wash step or the contract's
hover role needs a second entry; it should not be settled by accident.
