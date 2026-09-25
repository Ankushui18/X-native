# The design API (`window.__xNativeDesignApi`)

A structured-JSON read API over the live editor session, for agents and
integrations. Implemented in `apps/web/src/engine/designApi.ts` (pure over
`Snapshot`, headless-tested in `engine/__tests__/designapi.test.mjs`),
installed once by the app shell via `installDesignApi`.

```js
const api = window.__xNativeDesignApi;
api.version;            // "1.0"
api.methods();          // ["getSelection", "getNode", ...]
api.describe();         // machine-readable catalog (params, returns, prose)
api.call("findNodes", { kind: "text", name: "price", limit: 20 });
```

## Envelope

Every call returns one of:

```json
{ "ok": true, "data": { "...": "..." } }
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "No node \"abc\"." } }
```

Error codes: `NOT_FOUND` (bad id), `BAD_ARGS` (missing/invalid params),
`UNSUPPORTED` (unknown method or format), `EMPTY` (reserved),
`INTERNAL` (a bug — throws never escape raw).

## Pagination & filtering

List methods accept `{ limit, offset }` (default limit 100, max 500) and
return `{ items, total, limit, offset }`. Search (`findNodes`) filters by
`kind`, `name` (case-insensitive substring), `nameIs` (exact), `id`,
`under` (subtree root), `instanceOf` (component id), `visible`, and
`minW`/`minH`/`maxW`/`maxH`.

## Methods

| Method | Params | Returns |
|---|---|---|
| `getSelection` | — | `{ count, ids, nodes }` |
| `getNode` | `id`, `depth?` (0–12), `full?` | summary + children to depth; `full` adds the raw node |
| `getLayers` | `page?`, `parent?`, `kind?`, page | direct children of a parent (default: current page root) |
| `findNodes` | filters + page | matching nodes across pages, or under one subtree |
| `getVariables` / `getTokens` | `collection?`, `type?`, page | variables resolved under the active modes, with `cssVar` |
| `getVariable` | `id` (id or name) | one token |
| `getVariableUsage` / `getTokenUsage` | `id`, page | `{ nodeId, prop, match }`; `binding` is ground truth, `value` is approximate |
| `getComponents` | page | masters (properties, variants, mapping sync) |
| `getComponent` | `id` (id, name, or node id) | one master |
| `getInstances` | `id`, page | placed instances of a component |
| `getComponentProperties` | `id` (instance or master) | defs; live values when `id` is an instance |
| `getVariants` | `id` | variant names |
| `getCodeMapping` | `id`, `framework?` | component → code mappings with `sync: synced\|stale\|never` |
| `getCodeComponent` | `id`, `framework?` | how an instance renders in code, or `{ mapped: false, reason }` |
| `getAutoLayout` | `id` | `{ layout, inferred }` (`flex`, `grid`, `absolute`, `none`) |
| `getConstraints` | `id` | resize constraints + min/max + absolute flag |
| `getSpacing` | `a`, `b` | edge-to-edge gaps (negative = overlap) + world rects |
| `getColors` | page | paint inventory by usage (`{ color, count, nodes }`) |
| `getTypography` | page | text-style inventory by usage |
| `getAssets` | — | `{ images: [{ …, bytes }], fonts: […] }` |
| `getAnnotations` | `nodeId?`, page | Dev Mode annotations |
| `getDesignVersion` | — | `{ file, api, pages, nodes, components, variables, … }` |
| `generateCode` | `id`, `format?`, `unit?`, `scope?` | subtree code: `tsx\|html\|tailwind\|css\|vue\|svelte` |

`generateCode` defaults to `tsx`, and to `subtree` scope when the node has
children. Token references (`var(--…)`) resolve under the active modes;
mapped instances render as their code components (see below).

## Relationship to the other surfaces

- **Dev Mode panel** — the same generators (`engine/codegen.ts`) back the
  Inspect code view; the panel and the API cannot disagree.
- **Component → code mappings** — edited in the Component/Instance section
  of the right panel (`Code mappings`), stored on the master, consumed by
  both the tree generator and `getCodeComponent`. `sync` compares the
  master against the hash taken at the last Verify.
- **MCP server** (`x-native-mcp`, stdio) — serves file-based agents with
  this same API from JSON documents (see `docs/MCP_SERVER.md`). The two
  surfaces are complementary: files on stdio, the live session here.
  (A Rust twin, `x_native mcp`, is still planned on that track.)
