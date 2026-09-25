/**
 * x-native-mcp — the X-Native design API as an MCP server over stdio.
 * (The build prepends the shebang; keep it out of the source so esbuild
 * does not emit it twice.)
 *
 * File-based agents (Claude Code, Cursor, …) point the server at a docs
 * directory; every tool reads one JSON document through the real engine, so
 * answers match the editor exactly. v1 is read-only apart from new_doc:
 * layers, variables, components, code mappings and code generation are all
 * exposed, while editing commands stay on the roadmap.
 *
 * Usage: x-native-mcp [--docs <dir>]
 *   --docs  document directory (default: $X_NATIVE_DOCS or ./x-native-docs)
 */
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStore, DocError } from "./store";
import { TOOLS } from "./tools";

function docsDir(argv: string[]): string {
  const flag = argv.findIndex((a) => a === "--docs");
  if (flag >= 0 && argv[flag + 1]) return argv[flag + 1];
  const eq = argv.find((a) => a.startsWith("--docs="));
  if (eq) return eq.slice("--docs=".length);
  if (process.env.X_NATIVE_DOCS) return process.env.X_NATIVE_DOCS;
  return join(process.cwd(), "x-native-docs");
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: x-native-mcp [--docs <dir>]");
  console.log("  Exposes the X-Native design API over MCP (stdio).");
  console.log("  Documents are <name>.json files (DocSeed shape) in the docs dir.");
  process.exit(0);
}

const store = createStore(docsDir(process.argv.slice(2)));
const server = new McpServer({ name: "x-native", version: "0.2.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.shape, annotations: { readOnlyHint: tool.readOnly } },
    async (params) => {
      try {
        const result = tool.run(store, params as Record<string, unknown>) as unknown;
        const ok = (result as { ok?: unknown })?.ok !== false;
        const data = (result as { data?: unknown })?.data;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(ok === false ? { isError: true as const } : {}),
          ...(data !== null && typeof data === "object" && !Array.isArray(data)
            ? { structuredContent: data as Record<string, unknown> }
            : {}),
        };
      } catch (e) {
        const code = e instanceof DocError ? e.code : "INTERNAL";
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code, message } }) }],
          isError: true as const,
        };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
// stdout is the protocol — everything human goes to stderr.
console.error(`x-native-mcp: ${TOOLS.length} tools, docs in ${store.dir}`);
