# Phase 11 MCP writes — status 2026-09-25 (`track=ts`, P1.10 follow-up)

Agents can now edit, not just read: 8 write tools on `x-native-mcp`
(0.1.0 → 0.2.0, 29 → 37 tools). Every mutation dispatches through the
real engine and auto-saves the JSON file.

## New tools (`X-Native/apps/mcp-server/`)
- `add_node` — layer of 10 drawable kinds under any parent (validated;
  the engine silently falls back to root on a bad parent, so the tool
  checks first). Returns the new id + node.
- `patch_node` — property writes through an allowlist (geometry, paint,
  text, visibility…); structural keys (`id`, `kind`, `children`, …)
  rejected with `BAD_ARGS`, values type-checked.
- `move_nodes` (one undo step, locked layers stay put), `delete_nodes`,
  `duplicate_nodes` (returns new ids) — the selection-based engine ops
  wrapped with existence checks.
- `undo` / `redo` — engine history, returning `canUndo`/`canRedo`.
- `set_code_mapping` — P1.10 write path; resolves component names to
  master ids first (the command no-ops on a name).

## Implementation
- `src/mutate.ts` (new) — `cleanPatch` / `cleanMapping` validators,
  `assertNode`, `mutate()` (resolve doc → dispatch → `toDoc()` → write
  file), `withNewIds()` (id diff for add/duplicate results).
- `src/store.ts` — exported `docPath` for the save path.
- `src/tools.ts` — 8 `readOnly: false` tools; `src/index.ts` +
  `package.json` bumped to 0.2.0.
- `tests/writes.mjs` (new) — 6 end-to-end tests over real stdio:
  surface count + `readOnlyHint`, add/read-back/persist, bad-parent /
  bad-prop envelopes, patch/move/undo/redo round-trip with on-disk
  verification, duplicate/delete, mapping set + read-back.

## Docs
- `docs/MCP_SERVER.md` — catalog + auto-save/allowlist notes; the
  read-only limit is gone. Remaining limits: inline images only, no live
  selection.
- `apps/mcp-server/README.md` — write tools listed.

## Verification
`tsc --noEmit` clean · esbuild bundle · smoke + writes 11/11 · web app
untouched.
