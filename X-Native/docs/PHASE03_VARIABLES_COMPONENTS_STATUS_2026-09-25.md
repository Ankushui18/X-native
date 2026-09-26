# Phase 3 — Variables & Components (TS track): status @ 2026-09-25

## Shipped

**P3-A · Variable collections + modes + aliases + persistence**
- New `engine/variables.ts`: mode-aware resolution, alias chains with
  cycle / missing / cross-type detection (safe fallback + `broken` flag),
  strict typed coercion for editor input, and the bindable-prop table.
- Variables are per-mode values now: `value` (default) + `values[modeId]`
  overrides. Collections own modes; `activeModes` picks one per collection.
- New commands: `addCollection` / `renameCollection` / `deleteCollection`,
  `addMode` / `renameMode` / `deleteMode` / `setActiveMode`. Guards: no
  duplicate names, last mode protected, renames move members, deletes drop
  members and scrub overrides.
- Variables, collections, and active modes **persist** (they were
  session-only before). Old documents seed defaults and derive collections
  from legacy `collection` names.
- Expressions see literals resolved under the active modes — never raw
  alias objects.

**P3-B · Layer bindings**
- `XNode.variableBindings` (prop → variable id), 8 typed props: fill,
  strokePaint, strokeWidth, opacity, fontSize, cornerRadii, visible, text.
  Type-checked + kind-checked at bind time; re-applied every relayout;
  explicit expressions win on conflict; direct edits detach (same rule as
  shared styles).
- Variables panel: per-row property picker + bind button, swatch click
  binds fill, value pill edits the *active mode's* slot, `@name` writes an
  alias, broken aliases show `⚠ broken`.
- Inspector Fill/Stroke rows show a bound-variable chip with unbind.

**P3-C · Swap instance + instance-swap properties**
- `swapInstance` command + Instance-section dropdown: keeps id/position/
  name, takes the new master's content, preserves same-named prop values.
  No-ops on masters and plain layers.
- `instance-swap` component-property type: targets a nested instance by
  name, swaps it to the chosen component. Prop control is a component
  dropdown; `+ Property` prompt accepts the new type.

**P3-D · Recursive constraints**
- `applyConstraints` recurses into resized children, so stretch/scale
  cascades down the subtree instead of stopping at the first level.

**P3-E · Token export**
- Dev Tokens resolve under the active modes, label multi-mode groups
  (`Brand · Dark`), and export aliases as DTCG references (`{brand.primary}`).

**Drive-by fix**: `persist.ts` validated annotations against `a.text`
instead of `a.note`, silently dropping every annotation on reload. Fixed.

## Verification
- `tsc --noEmit` clean, `vite build` clean, dev server HMR clean.
- `npm test`: **890 + 64 = 954 passed, 0 failed**
  (`variables.test.mjs` covers seeds, CRUD guards, resolution incl. cycles,
  coercion, bindings + detach, persistence round-trip, swap, constraints).

## Behaviour notes
- Deleting a variable leaves bindings/aliases pointing at it (shown
  broken) so **undo heals** them instead of leaving silent gaps.
- A prototype `setVariable` write replaces the default slot; mode
  overrides keep working on top of it.
- Changing a variable's type resets its slots to the new type's fallback.
- Unbinding keeps the current value; only future updates stop.

## Follow-ups (not started)
1. Variable picker popover on inspector numeric/text fields (binding today
   starts from the variables panel, except Fill/Stroke chips which unbind).
2. Per-mode value grid in the panel (today: edit flips the active slot).
3. `cornerRadii` binding writes all four corners uniformly.
4. Publish/consume variables across files (library model) — needs product
   scoping beyond a single document.
5. Annotations filter fix (above) has no dedicated test yet.
