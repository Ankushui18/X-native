# Phase 10 MCP server — status 2026-09-25 (`track=ts`, P1.10)

P1.10's "Works with MCP" checkbox, tried and shipped: `x-native-mcp`, a
stdio MCP server that serves the full `designApi` surface (all 25 methods)
from JSON documents through the real engine — no Rust `x-mcp` crate
existed, so the TS track got its own server instead of waiting for one.

## What was built (`X-Native/apps/mcp-server/`)
- `src/index.ts` — MCP server (`x-native`), stdio transport, `--docs`
  dir / `$X_NATIVE_DOCS` / `./x-native-docs`, `--help`. Single-file
  `dist/index.js` via esbuild (engine + SDK bundled, ~1MB).
- `src/store.ts` — file-backed docs (`<name>.json`, `DocSeed` shape):
  list/open/new, engine cache, active-doc resolution, structural
  validation, blank-page factory. `restore=false`, so no browser APIs.
- `src/tools.ts` — 29 tools: all 25 `designApi` methods (descriptions
  reuse `describeApi()` prose; schemas hand-written from signatures) +
  `list_docs` / `open_doc` / `new_doc` / `describe_api`. Results keep the
  API envelope as JSON text plus `structuredContent`; domain errors come
  back as MCP errors carrying the envelope.
- `tests/smoke.mjs` — 5 end-to-end tests over real stdio with the SDK
  client: tool surface (29 tools, `generateCode` schema), open + reads on
  a hand seed, codegen output, enveloped `NOT_FOUND`s, create + list.
- `README.md` + `docs/MCP_SERVER.md` (setup for Claude Code/Desktop, tool
  catalog, real session transcript, v1 limits).

## Docs/roadmap
- Roadmap P1.10 "Works with MCP" ticked (TS track, v1 read-only).
- `DESIGN_API.md` relationship section now points at the real server.

## v1 limits (documented, next steps)
Read-only apart from `new_doc` (engine `dispatch` + `toDoc()` make writes
a small follow-up); images must be inline (`asset:` refs need the
editor's IndexedDB hydrator); no live selection in file mode.

## Verification
`tsc --noEmit` clean · `vite build` n/a (esbuild bundle) · smoke 5/5 ·
real transcript captured (`open_doc` counts + tsx codegen with token
resolution). Web app untouched.
