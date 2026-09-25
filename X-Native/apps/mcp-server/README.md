# x-native-mcp

The X-Native design API as an MCP server over stdio, for file-based agents
(Claude Code, Cursor, …). Every tool reads one JSON document through the real
engine, so answers match the editor exactly. P1.10, TS track.

- 25 design tools (selection, nodes, variables/tokens, components, layout,
  colors, typography, assets, annotations, code mapping, code generation)
- 4 document tools (`list_docs`, `open_doc`, `new_doc`, `describe_api`)
- 8 write tools (`add_node`, `patch_node`, `move_nodes`, `delete_nodes`,
  `duplicate_nodes`, `undo`, `redo`, `set_code_mapping`) — every mutation
  dispatches through the engine and auto-saves the JSON file
- Results keep the API envelope (`{ ok, data }` / `{ ok: false, error }`)
  as JSON text plus `structuredContent`.

See `../../docs/MCP_SERVER.md` for setup and the full tool catalog.

## Develop

```sh
npm install
npm run build      # single-file dist/index.js (engine bundled)
npm run typecheck
npm test           # rebuilds, then runs the stdio end-to-end suite
node dist/index.js --docs ./my-docs
```
