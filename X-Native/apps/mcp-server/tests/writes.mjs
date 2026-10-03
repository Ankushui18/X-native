// Write tools end-to-end: add/patch/move/duplicate/delete/undo/redo and
// set_code_mapping against a seeded doc, verifying reads, undo history,
// envelopes, and that every mutation hits the JSON file on disk.
import { test, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "index.js");
const DOCS = mkdtempSync(join(tmpdir(), "x-mcp-w-"));
const FILE = join(DOCS, "w.json");

writeFileSync(FILE, JSON.stringify({
  fileName: "W",
  pages: [{ id: "page-1", name: "Page 1",
    root: { id: "root-1", kind: "frame", name: "Page 1", x: 0, y: 0, w: 1400, h: 1400, children: [
      { id: "rect-1", kind: "rect", name: "Box", x: 10, y: 10, w: 120, h: 36, fill: "#0d99ff" },
    ] },
    comments: [], guides: [], pixelGrid: false, pixelGridColor: "#cccccc" }],
  components: [
    { id: "comp-1", name: "Button", node: { id: "comp-node-1", kind: "frame", name: "Button", x: 0, y: 0, w: 120, h: 36, children: [] }, variants: [], property: "", codeMappings: [] },
  ],
  styles: [], page: 0, zoom: 1, panX: 0, panY: 0,
  showRulers: false, showMinimap: false, showComments: false,
}));

let client;
before(async () => {
  client = new Client({ name: "writes", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST, "--docs", DOCS], stderr: "ignore" }));
  await client.callTool({ name: "open_doc", arguments: { name: "w" } });
});
after(async () => { await client.close(); });

const call = async (name, args) => client.callTool({ name, arguments: args });
const dataOf = (res) => JSON.parse(res.content[0].text);
const onDisk = () => JSON.parse(readFileSync(FILE, "utf8"));
const findOnDisk = (id) => {
  const walk = (n) => (n.id === id ? n : (n.children ?? []).map(walk).find(Boolean));
  return walk(onDisk().pages[0].root);
};

test("surface grew by the 8 write tools", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 37);
  for (const t of tools.filter((x) => ["add_node", "patch_node", "undo"].includes(x.name)))
    assert.equal(t.annotations.readOnlyHint, false);
});

test("add_node creates, reads back, and persists", async () => {
  const res = dataOf(await call("add_node", { kind: "text", x: 5, y: 5, w: 200, h: 24, props: { name: "Title", text: "Hi", fontSize: 20 } }));
  assert.equal(res.ok, true);
  const back = dataOf(await call("getNode", { id: res.data.id, full: true }));
  assert.equal(back.data.full.text, "Hi");
  assert.equal(back.data.full.fontSize, 20);
  assert.equal(findOnDisk(res.data.id).text, "Hi");
});

test("add_node rejects bad parents and bad props", async () => {
  const badParent = await call("add_node", { kind: "rect", x: 0, y: 0, w: 10, h: 10, parent: "ghost" });
  assert.equal(badParent.isError, true);
  assert.equal(dataOf(badParent).error.code, "NOT_FOUND");
  const badProp = await call("add_node", { kind: "rect", x: 0, y: 0, w: 10, h: 10, props: { children: [] } });
  assert.equal(badProp.isError, true);
  assert.equal(dataOf(badProp).error.code, "BAD_ARGS");
});

test("patch/move/undo/redo round-trip", async () => {
  await call("patch_node", { id: "rect-1", patch: { x: 50, fill: "#ff0000" } });
  assert.equal(dataOf(await call("getNode", { id: "rect-1", full: true })).data.full.x, 50);
  await call("move_nodes", { ids: ["rect-1"], dx: 10, dy: 0 });
  assert.equal(findOnDisk("rect-1").x, 60);
  const undo = dataOf(await call("undo", {}));
  assert.equal(undo.data.canRedo, true);
  assert.equal(findOnDisk("rect-1").x, 50);
  await call("redo", {});
  assert.equal(findOnDisk("rect-1").x, 60);
  const bad = await call("patch_node", { id: "rect-1", patch: { kind: "text" } });
  assert.equal(dataOf(bad).error.code, "BAD_ARGS");
  const missing = await call("patch_node", { id: "ghost", patch: { x: 1 } });
  assert.equal(dataOf(missing).error.code, "NOT_FOUND");
});

test("duplicate then delete", async () => {
  const dup = dataOf(await call("duplicate_nodes", { ids: ["rect-1"] }));
  assert.equal(dup.data.ids.length, 1);
  assert.ok(findOnDisk(dup.data.ids[0]));
  await call("delete_nodes", { ids: [dup.data.ids[0]] });
  assert.equal(findOnDisk(dup.data.ids[0]), undefined);
  assert.ok(findOnDisk("rect-1"));
});

test("set_code_mapping sticks and reads back", async () => {
  const res = dataOf(await call("set_code_mapping", {
    componentId: "Button",
    mapping: { framework: "react", componentName: "UIButton", importPath: "@/ui/button", props: [{ prop: "label", kind: "children" }] },
  }));
  assert.equal(res.ok, true);
  const back = dataOf(await call("getCodeMapping", { id: "comp-1" }));
  assert.equal(back.data[0].component, "UIButton");
  assert.equal(back.data[0].id, res.data.mappingId);
  const bad = await call("set_code_mapping", { componentId: "ghost", mapping: { framework: "react", componentName: "X", props: [] } });
  assert.equal(dataOf(bad).error.code, "NOT_FOUND");
});
