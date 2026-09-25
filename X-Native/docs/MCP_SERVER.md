# MCP server (`x-native-mcp`)

File-based agents get the same structured design API the live editor
exposes on `window.__xNativeDesignApi` (see `DESIGN_API.md`), served over
MCP stdio from JSON documents. Implemented in `apps/mcp-server` (TS track,
P1.10); the engine is bundled, so the install is one file plus node.

## Setup

```sh
cd X-Native/apps/mcp-server
npm install && npm run build
```

Claude Code:

```sh
claude mcp add x-native -- node /path/to/X-Native/apps/mcp-server/dist/index.js --docs ./x-native-docs
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "x-native": {
      "command": "node",
      "args": ["/path/to/X-Native/apps/mcp-server/dist/index.js", "--docs", "/path/to/x-native-docs"]
    }
  }
}
```

The docs directory is created if missing. Each document is one
`<name>.json` file in the `DocSeed` shape (`fileName`, `pages`, …) — the
same JSON the editor autosaves, minus the asset store (below).

## Example session

```
→ open_doc { "name": "card" }
← { "ok": true, "data": { "name": "card", "file": "Card", "api": "1.0",
    "pages": 1, "nodes": 5, "components": 0, "variables": 5 } }

→ generateCode { "id": "card", "format": "tsx", "scope": "subtree" }
← { "ok": true, "data": { "format": "tsx", "scope": "subtree",
    "code": "import React from \"react\";\n\nexport const Card: React.FC = () => …" } }
```

Values resolve against design tokens where they match (a 16px radius comes
back as `var(--spacing-spacing-md)`), and component → code mappings apply
to instances, exactly as in Dev Mode.

## Tool catalog

| Tool | Reads | Notes |
|---|---|---|
| `getSelection` | selection | empty in file mode (no live editor) |
| `getNode` | one node | `id`, `depth?`, `full?` |
| `getLayers` | children | `page?`, `parent?`, `kind?`, paged |
| `findNodes` | search | kind/name/box/instance/visibility filters, paged |
| `getVariables` / `getTokens` | variables | `collection?`, `type?`, paged |
| `getVariable` | one variable | `id` |
| `getVariableUsage` / `getTokenUsage` | bindings | `id`, paged |
| `getComponents` | masters | paged |
| `getComponent` | one master | `id` (master, name, or node id) |
| `getInstances` | placements | `id`, paged |
| `getComponentProperties` | props | `id` |
| `getVariants` | variant names | `id` |
| `getCodeMapping` | code mappings | `id`, `framework?` |
| `getCodeComponent` | mapped render | `id`, `framework?` |
| `getAutoLayout` | layout | `id` |
| `getConstraints` | constraints | `id` |
| `getSpacing` | gaps | `a`, `b` |
| `getColors` | paint inventory | paged |
| `getTypography` | type inventory | paged |
| `getAssets` | images + fonts | |
| `getAnnotations` | handoff notes | `nodeId?`, paged |
| `getDesignVersion` | identity + counts | |
| `generateCode` | code | `id`, `format?` (tsx/html/tailwind/css/vue/svelte), `unit?`, `scope?` |
| `list_docs` | doc names | |
| `open_doc` | open + activate | `name` |
| `new_doc` | create blank | `name` |
| `describe_api` | API catalog | version, envelope, error codes, methods |
| `add_node` | add a layer | `kind`, `x`, `y`, `w`, `h`, `parent?`, `props?` → new id |
| `patch_node` | set properties | `id`, `patch` (allowlisted keys only) |
| `move_nodes` | move by delta | `ids`, `dx`, `dy` (one undo step) |
| `delete_nodes` | delete layers | `ids` |
| `duplicate_nodes` | duplicate | `ids` → new ids |
| `undo` / `redo` | history | → `canUndo`/`canRedo` |
| `set_code_mapping` | map component → code | `componentId`, `mapping` |

List tools paginate with `limit`/`offset`. Errors are MCP errors whose text
is the envelope, e.g. `{ "ok": false, "error": { "code": "NOT_FOUND" } }`.

Every write dispatches through the real engine (constraints, relayout and
undo all behave) and auto-saves the JSON file — there is no separate save
step. `patch_node`/`add_node` props go through an allowlist (geometry,
paint, text, visibility…); structural fields (`id`, `kind`, `children`,
layout objects) are rejected with `BAD_ARGS` rather than silently
corrupting the document.

## Limits (v1)
- **Images must be inline**: `asset:` refs need the editor's IndexedDB
  hydrator, so a document carrying refs loads with empty pictures.
- **No live selection**: file mode has no cursor, so `getSelection` is
  empty. A live bridge (editor ↔ server) is future work.
- Documents validate structurally (`fileName` + at least one page);
  partial nodes are backfilled, like editor restore.
