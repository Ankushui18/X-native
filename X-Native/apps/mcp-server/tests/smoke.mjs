// End-to-end: spawn the bundled server over stdio and drive it as an agent
// would. Seeds one hand-written document (the engine backfills the fields
// a hand seed omits) and exercises open, reads, codegen and error envelopes.
import { test, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "index.js");
const DOCS = mkdtempSync(join(tmpdir(), "x-mcp-"));

const RECT_ID = "rect-1";
const TEXT_ID = "text-1";
writeFileSync(
  join(DOCS, "smoke.json"),
  JSON.stringify({
    fileName: "Smoke",
    pages: [
      {
        id: "page-1", name: "Page 1",
        root: {
          id: "root-1", kind: "frame", name: "Page 1", x: 0, y: 0, w: 1400, h: 1400,
          children: [
            { id: RECT_ID, kind: "rect", name: "Button", x: 10, y: 10, w: 120, h: 36, fill: "#0d99ff" },
            { id: TEXT_ID, kind: "text", name: "Label", x: 10, y: 60, w: 120, h: 20, text: "Hello" },
          ],
        },
        comments: [], guides: [], pixelGrid: false, pixelGridColor: "#cccccc",
      },
    ],
    components: [], styles: [], page: 0, zoom: 1, panX: 0, panY: 0,
    showRulers: false, showMinimap: false, showComments: false,
  }),
);

let client;
before(async () => {
  client = new Client({ name: "smoke", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST, "--docs", DOCS], stderr: "ignore" }));
});
after(async () => { await client.close(); });

const dataOf = (res) => {
  assert.equal(res.content.length, 1);
  return JSON.parse(res.content[0].text);
};

test("advertises the full tool surface", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(tools.length, 37);
  for (const want of ["getNode", "findNodes", "getCodeMapping", "generateCode", "list_docs", "open_doc", "new_doc", "describe_api"])
    assert.ok(names.includes(want), `missing ${want}`);
  const gen = tools.find((t) => t.name === "generateCode");
  assert.deepEqual(gen.inputSchema.required, ["id"]);
  assert.ok(gen.inputSchema.properties.format.enum.includes("tsx"));
});

test("open_doc + reads resolve the seed", async () => {
  assert.deepEqual(dataOf(await client.callTool({ name: "open_doc", arguments: { name: "smoke" } })).data.file, "Smoke");
  const layers = dataOf(await client.callTool({ name: "getLayers", arguments: {} }));
  assert.equal(layers.ok, true);
  assert.equal(layers.data.items.length, 2);
  const found = dataOf(await client.callTool({ name: "findNodes", arguments: { kind: "text" } }));
  assert.equal(found.data.items[0].id, TEXT_ID);
  const node = dataOf(await client.callTool({ name: "getNode", arguments: { id: TEXT_ID, full: true } }));
  assert.equal(node.data.full.text, "Hello");
});

test("generateCode renders the subtree", async () => {
  const res = dataOf(await client.callTool({ name: "generateCode", arguments: { id: RECT_ID, format: "html" } }));
  assert.equal(res.ok, true);
  assert.equal(res.data.format, "html");
  assert.match(res.data.code, /class="button"/);
});

test("domain errors stay enveloped", async () => {
  const res = await client.callTool({ name: "getNode", arguments: { id: "missing" } });
  assert.equal(res.isError, true);
  assert.equal(dataOf(res).error.code, "NOT_FOUND");
  const res2 = await client.callTool({ name: "open_doc", arguments: { name: "nope" } });
  assert.equal(res2.isError, true);
  assert.equal(dataOf(res2).error.code, "NOT_FOUND");
});

test("new_doc creates and lists", async () => {
  const res = dataOf(await client.callTool({ name: "new_doc", arguments: { name: "blank" } }));
  assert.equal(res.data.created, true);
  assert.ok(existsSync(join(DOCS, "blank.json")));
  const list = dataOf(await client.callTool({ name: "list_docs", arguments: {} }));
  assert.deepEqual(list.data.docs, ["blank", "smoke"]);
});
