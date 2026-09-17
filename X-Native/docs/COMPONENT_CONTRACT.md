# Component contract

**Status: P0-2 of UI/UX Refinement v1 — contract done, painters incremental.**
The standard, the state language and the component inventory live in
`crates/x-ui` (`metrics`, `state`, `contract`). The designers' paint functions
still own the pixels; they move into `x-ui` as the surfaces that use them are
reworked — the board and FLOW / SHIP / UX ANALYSIS in P0-5, the rest after.

Why the split: before this milestone `x-ui` was a token crate. The app imported
its palette, its type ladder and its spacing scale, and then defined its own
control heights, its own hover colours and its own versions of every widget.
That is how one inspector ended up with 19px, 20px, 22px and 32px rows. The
contract is the part that must be shared before any of it can move.

## The standard — `x-ui::metrics`

One scale for every surface that owns property rows:

| Step | px | Used for |
|---|---|---|
| `ControlHeight::Control` | 28 | Property rows: fields, number fields, selects, square icon buttons, menu rows. |
| `ControlHeight::Dense` | 24 | Disclosure and summary rows ("Advanced", clip content, Fixed\|Fill), section headers. |
| `ControlHeight::Chip` | 16 | Checkboxes, switches, inline chips (Hug/Fixed, the padding glyph). |

Rhythm: `ROW_GAP` 8 (row→row, row→label, row→disclosure), `LABEL_GAP` 6
(label→control), `SECTION_GAP` 12 (content→hline, hline→section) — all three
taken from the shared `SpacingScale`.

`is_control_height(h)` is the test a row height has to pass;
`nearest_control_height(h)` names the step an off-scale height was reaching for
(32 → Control, 22 → Dense, 19 → Chip). The designer's `theme.rs` imports these
rather than restating them, and
`app_row_heights_are_the_component_layers` asserts it stays that way.

The four heights this replaced — a 19px sizing chip, a 20px eye button, 22px
style buttons, 32px gap/padding rows — are itemised under P0-9 in
[REFINEMENT_V1_PLAN.md](REFINEMENT_V1_PLAN.md).

## The state language — `x-ui::state`

Selection, hover and focus are three questions with three different answers:

| State | Fill role | Line role | Ink role |
|---|---|---|---|
| `Rest` | `surface_elevated` | — | `text_primary` |
| `Hover` | `surface_hover` | `border_strong` | `text_primary` |
| `Active` | `surface_active` | `border_strong` | `text_primary` |
| `Selected` | `surface_active` | `selection` | `text_primary` |
| `Disabled` | `surface` | — | `text_placeholder` |

A ring is drawn *on top of* the base state: `Ring::Focus` (keyboard focus) and
`Ring::Edit` (the in-place text editor) are both `focus_ring`, because editing
is focus. `resolve(hover, selected, focused, disabled)` applies the precedence —
disabled beats everything, selection outranks hover, focus is additive — and a
test asserts every role the module names exists in `ColorTokens`, so the state
language cannot invent a colour no theme can remap.

## The inventory — `x-ui::contract`

Each component declares its height, the step it must snap to, the states it
paints, whether it registers a hit region, whether it draws a focus ring, and
who paints it today.

| Component | Height | Step | On standard | Hit | Owner |
|---|---|---|---|---|---|
| field | 28 | Control | yes | yes | app |
| number field | 28 | Control | yes | yes | app |
| select | 28 | Control | yes | yes | app |
| square icon button | 28 | Control | yes | yes | app |
| small icon button | 24 | Dense | yes | yes | app |
| checkbox | 16 | Chip | yes | yes | app |
| switch | 16 | Chip | yes | yes | app |
| segmented chip | 16 | Chip | yes | yes | app |
| disclosure row | 24 | Dense | yes | yes | app |
| section header | 24 | Dense | yes | yes (the `plus`) | app |
| tree row | 22 | Dense | **no** | yes | app |
| menu row | 28 | Control | yes | yes | app |
| dropdown row | 32 | Control | **no** | yes | app |
| toolbar button | 32 | idiom | yes | yes | app |
| toolbar pill | 30 | idiom | yes | yes | app |
| search field | 32 | idiom | yes | yes | app |
| draft row | 48 | idiom | yes | yes | app |
| card | — | idiom | yes | yes | app |
| menu | — | container | yes | no (its rows) | app |
| tooltip | — | — | yes | no | app |
| divider | — | — | yes | no | app |
| caps label | — | — | yes | no | app |

"Idiom" means the property-row scale deliberately does not apply: a tool in a
40px bar and a file row in a dashboard list are not property rows, and forcing
them onto the scale would be the same mistake in the other direction. The test
requires such a component to be marked on-standard — there is no step it could
miss.

## The rules

1. **No phantom controls.** An `Interactive` component registers a hit region; a
   `Decorative` one never paints hover. P0-4 removed three dashboard icons and
   demoted a sidebar row for exactly this, and the test is what stops the next
   one.
2. **Every interactive component paints rest and hover.** Only components that
   can genuinely be unavailable paint `Disabled` — one does today (the square
   icon button, which is the only control the chrome can dim), counted by
   `DISABLEABLE_COMPONENTS`. A control that cannot say "not now" is a control
   that lies when it is unavailable, so the number goes up when a panel gains a
   conditional control, not before.
3. **One scale.** A component with a step that is marked on-standard is exactly
   that step tall. `OFF_STANDARD_COMPONENTS` (2: the tree row and the dropdown
   row) is the debt, and the test fails if the count and the registry disagree.
4. **The focus ring goes on components that can hold focus** — fields, number
   fields, selects, the search field. Not on rows and buttons that only respond
   to the pointer.
5. **Containers take their hits from their children.** A menu is a box; its rows
   are the controls.

## How a component lands in `x-ui`

`MIGRATED_TO_X_UI` is 0 today. The migration is per component, and the order
follows the surfaces being reworked rather than the table above:

1. The component's geometry and state move first (`metrics` already owns the
   heights; a `layout` module owning row and section geometry is the next
   increment).
2. Its painter moves last, as a function that emits paint ops — rects, text
   runs, icons — into a list the app walks once (`x-ui` has no renderer and must
   not grow one; the designer owns vello, the fonts and the icon paths). Each
   op maps to an existing helper: `fill_rrect`, `stroke_rrect`,
   `app.fonts.text` / `caps_label`, `draw_icon`.
3. The call sites start with the surface P0-5 reworks, so the adapter is proven
   where the rows are being touched anyway.

Every move raises `MIGRATED_TO_X_UI` and flips that component's `owner`.

## Related

- [SCREEN_CONTRACT.md](SCREEN_CONTRACT.md) — the surfaces these components
  build, and the rules a screen owes.
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — the palette, scales and type ladder
  every component is painted from.
- [REFINEMENT_V1_PLAN.md](REFINEMENT_V1_PLAN.md) — the milestone, including the
  P0-9 pass that produced the standard.
