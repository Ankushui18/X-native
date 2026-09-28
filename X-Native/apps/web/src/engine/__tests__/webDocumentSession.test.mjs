import assert from "node:assert/strict";
import { docFromTemplate } from "../files.ts";
import { node } from "../memory.ts";
import { __resetWasmForTests, initWasmBridge } from "../wasmBridge.ts";
import { admitWebDocument, decodeWebDocument, openWebDocumentSession, RustWebDocumentSession, WEB_DOCUMENT_SESSION_VERSION } from "../webDocumentSession.ts";

const clone = x => JSON.parse(JSON.stringify(x));
const fixture = () => {
  const doc = docFromTemplate("blank");
  doc.fileName = 'Design \u007f \" \u000391';
  doc.pages[0].name = "Different page label";
  doc.pages[0].root.children.push(node("rect", "Box \u000391", 10, 20, 30, 40, {
    fill: "#a1b2c3", visible: false, locked: true,
  }));
  doc.panX = -250.5; doc.panY = 123; doc.zoom = 1.5;
  doc.showFlows = false;
  return doc;
};

let passed = 0, failed = 0;
async function test(label, fn) {
  __resetWasmForTests();
  try { await fn(); passed++; console.log(`  ok ${label}`); }
  catch (err) { failed++; console.error(`FAIL ${label}`, err); }
}
const moduleWith = Session => {
  if (Session?.prototype && typeof Session.prototype.outlineStroke !== "function") {
    Session.prototype.outlineStroke = () => "{}";
  }
  return {
    default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm 0.34.0 (rust)",
    importFigToX: () => "", importSketchToX: () => "", importSvgToX: () => "",
    sessionBridgeVersion: () => 6, RustDocumentSession: Session,
  };
};

await test("one-page rect document and persisted v1 metadata round-trip exactly", () => {
  assert.equal(WEB_DOCUMENT_SESSION_VERSION, 2);
  for (const seed of [docFromTemplate("blank"), fixture(), { ...fixture(), version: 1 }]) {
    const x = admitWebDocument(seed);
    assert.ok(x, "supported doc should be admitted");
    assert.deepEqual(decodeWebDocument(x, seed), seed);
    const raw = JSON.parse(x);
    assert.equal(raw.pages.length, 1);
    assert.equal(raw.pages[0].blend, "pass-through");
    assert.equal(raw.pages[0].show_name, false);
    if (seed.pages[0].root.children.length) {
      assert.equal(raw.pages[0].children?.[0]?.show_name, false);
      assert.equal(raw.pages[0].children?.[0]?.visible, false);
    }
  }
});

await test("ellipse, polygon and star admit losslessly; unsafe shape parameters decline", () => {
  const seed = docFromTemplate("blank");
  seed.pages[0].root.children.push(
    node("ellipse", "Ellipse", 14, 20, 80, 50, { fill: "#224466" }),
    node("poly", "Polygon", 94, 50, 78, 72, { count: 6, fill: "#7799aa" }),
    node("star", "Star", -16, 0, 90, 90, { count: 7, starRatio: 0.35, fill: "#bc88dd" }),
  );
  const raw = JSON.parse(admitWebDocument(seed));
  assert.deepEqual(raw.pages[0].children.map(n => n.kind),
    [{ t: "ellipse" }, { t: "poly", sides: 6 }, { t: "star", points: 7, ratio: 0.35 }]);
  assert.deepEqual(decodeWebDocument(JSON.stringify(raw), seed), seed);
  for (const change of [
    n => n.count = 61,
    n => n.count = 2,
    n => n.starRatio = 1.5,
    n => n.starRatio = 0.01,
    n => n.strokeWidth = 1,
  ]) {
    const unsafe = clone(seed); change(unsafe.pages[0].root.children[2]);
    assert.equal(admitWebDocument(unsafe), null);
  }
});

await test("native aligned stroke options survive strict explicit checkpoint; extra options cannot be dropped", () => {
  const seed = fixture();
  seed.pages[0].root.children[0].visible = true;
  seed.pages[0].root.children[0].locked = false;
  const raw = JSON.parse(admitWebDocument(seed));
  const n = raw.pages[0].children[0];
  n.stroke = { color: "#236b9e", width: 8 };
  n.fill_layers = [{ paint: { t: "solid", c: n.fill.c }, opacity: 1, visible: true, blend: "normal" }];
  n.stroke_layers = [{ color: "#236b9e", width: 8, opacity: 1, visible: true, blend: "normal",
    align: "outside", cap_start: "none", cap_end: "none", join: "bevel", dash: [], dash_offset: 0, miter: 4 }];
  n.effect_layers = [];
  const saved = decodeWebDocument(JSON.stringify(raw), seed);
  const expected = clone(seed);
  Object.assign(expected.pages[0].root.children[0], {
    strokePaint: "#236b9e", strokeWidth: 8, strokeVisible: true, strokeAlign: "outside", strokeJoin: "bevel",
  });
  assert.deepEqual(saved, expected);
  assert.equal(admitWebDocument(saved), null, "preexisting web styles remain outside the *initial* admission gate");
  for (const mutate of [
    n => { n.stroke_layers[0].join = "round"; },
    n => { n.stroke_layers[0].miter = 8; },
    n => { n.stroke_layers[0].dash = [3, 2]; },
    n => { delete n.fill_layers; },
    n => { n.stroke_layers.push(clone(n.stroke_layers[0])); },
    n => { n.stroke_layers[0].color = "#000000"; },
  ]) {
    const changed = clone(raw); mutate(changed.pages[0].children[0]);
    assert.throws(() => decodeWebDocument(JSON.stringify(changed), seed), /Unsupported|stroke|layer/i);
  }
});

await test("rejects all unsupported document/page metadata and unknown properties", () => {
  const changes = [
    d => d.pages.push(clone(d.pages[0])),
    d => d.pages[0].comments.push({ id: "c", text: "note" }),
    d => d.pages[0].guides.push({ position: 10 }),
    d => d.pages[0].pixelGrid = true,
    d => d.pages[0].flowStart = "box",
    d => d.pages[0].newField = null,
    d => d.pages.futureField = true,
    d => d.components.futureField = true,
    d => d.pages[0].guides.futureField = true,
    d => d.styles.push({ name: "brand" }),
    d => d.components.push({ name: "button" }),
    d => d.annotations = [{ note: "handoff" }],
    d => d.variables = [{ name: "primary" }],
    d => d.variableCollections = [{ name: "theme" }],
    d => d.activeModes = { theme: "dark" },
    d => d.version = 2,
    d => d.extra = "future schema",
    d => d.page = 1,
    d => d.zoom = Infinity,
  ];
  for (const change of changes) {
    const doc = fixture(); change(doc);
    assert.equal(admitWebDocument(doc), null, change.toString());
  }
});

await test("rejects any nontrivial or unknown node property rather than projecting it away", () => {
  const changes = [
    n => n.rotation = 17,
    n => n.opacity = 0.5,
    n => n.cornerRadii[0] = 4,
    n => n.strokeWidth = 2,
    n => n.strokeVisible = true,
    n => n.fillType = "linear",
    n => n.fill = "#AABBCC",
    n => n.fill = "#aabbcc80",
    n => n.fillVisible = false,
    n => n.layout = { direction: "horizontal" },
    n => n.effects.push({ kind: "layer-blur", blur: 5 }),
    n => n.interactions.push({ action: "navigate" }),
    n => n.imageSrc = "data:image/png;base64,AA==",
    n => n.kind = "text",
    n => n.children.push(node("rect", "nested", 0, 0, 10, 10)),
    n => n.children.futureField = true,
    n => n.rotOrigin = Array(2),
    n => Object.defineProperty(n, "hiddenField", { value: 1 }),
    n => n[Symbol("future")] = true,
    n => n.futureField = undefined,
    n => n.x = NaN,
    n => n.w = 0,
    n => n.visible = null,
    n => n.id = "",
  ];
  for (const change of changes) {
    const doc = fixture(); change(doc.pages[0].root.children[0]);
    assert.equal(admitWebDocument(doc), null, change.toString());
  }
  const duplicate = fixture(); duplicate.pages[0].root.children.push(clone(duplicate.pages[0].root.children[0]));
  assert.equal(admitWebDocument(duplicate), null);
  const changedRoot = fixture(); changedRoot.pages[0].root.fill = "#ffffff";
  assert.equal(admitWebDocument(changedRoot), null);
});

await test("strict native checkpoint refuses extra fields and metadata instead of truncating", () => {
  const doc = fixture(), raw = JSON.parse(admitWebDocument(doc));
  for (const change of [
    x => x.default_font = "Inter",
    x => x.variables.colors.accent = "#ffffff",
    x => x.pages.push(clone(x.pages[0])),
    x => x.pages[0].children[0].stroke = { color: "#000000", width: 1 },
    x => x.pages[0].children[0].kind = { t: "text", text: "unexpected" },
    x => x.pages[0].children[0].show_name = true,
    x => x.pages[0].children[0].fill.c = "#ffffff80",
    x => x.pages[0].blend = "normal",
    x => x.pages[0].id = "other root",
  ]) {
    const modified = clone(raw); change(modified);
    assert.throws(() => decodeWebDocument(JSON.stringify(modified), doc), undefined, change.toString());
  }
});

await test("explicit vector checkpoint preserves all Boolean contours, including empty results", () => {
  const seed = fixture(), original = JSON.parse(admitWebDocument(seed));
  for (const loops of [
    [],
    [["M", 0, 0], ["L", 10, 0], ["L", 10, 10], ["L", 0, 10], ["Z"],
      ["M", 2, 2], ["L", 8, 2], ["L", 8, 8], ["L", 2, 8], ["Z"]],
  ]) {
    const native = clone(original), result = native.pages[0].children[0];
    result.kind = { t: "vector", path: loops };
    result.id = "rust-result";
    result.name = "Exclude";
    result.w = 10; result.h = 10;
    const exported = decodeWebDocument(JSON.stringify(native), seed);
    const vector = exported.pages[0].root.children[0];
    assert.equal(vector.id, "rust-result");
    assert.equal(vector.kind, "vector");
    assert.equal(vector.closed, true);
    assert.equal(vector.vectorNetwork.regions[0].windingRule, "EVENODD");
    assert.equal(vector.vectorNetwork.regions[0].loops.length, loops.length ? 2 : 0);
    assert.equal(vector.vectorNetwork.vertices.length, loops.length ? 8 : 0);
    assert.equal(admitWebDocument(exported), null, "vectors are outputs, not unproved initial inputs");
  }
  for (const path of [
    [["M", 0, 0], ["C", 2, 2, 4, 4, 5, 5], ["Z"]],
    [["M", 0, 0], ["L", 1, 1]],
    [["M", 0, 0], ["L", 1, 1], ["L", 2, 2], ["Z", "extra"]],
  ]) {
    const native = clone(original);
    native.pages[0].children[0].kind = { t: "vector", path };
    assert.throws(() => decodeWebDocument(JSON.stringify(native), seed), /native|contour|path/i);
  }
});

await test("canonical Outline Stroke fill stack checkpoints as the same single web fill", () => {
  const seed = fixture(), raw = JSON.parse(admitWebDocument(seed));
  const n = raw.pages[0].children[0];
  n.kind = { t: "vector", path: [["M", 0, 0], ["L", 30, 0], ["L", 30, 40], ["L", 0, 40], ["Z"]] };
  n.fill = { t: "solid", c: "#9142d4" };
  n.fill_layers = [{ paint: { t: "solid", c: "#9142d4" }, opacity: 1, visible: true, blend: "normal" }];
  // Outlining removes the legacy top-level live-stroke field as well as its
  // materialized stack; retaining it would be a lossy checkpoint projection.
  delete n.stroke;
  n.stroke_layers = []; n.effect_layers = [];
  const decoded = decodeWebDocument(JSON.stringify(raw), seed);
  const vector = decoded.pages[0].root.children[0];
  assert.equal(vector.kind, "vector");
  assert.equal(vector.fill, "#9142d4");
  assert.equal(vector.vectorNetwork.vertices.length, 4);
  assert.equal(admitWebDocument(decoded), null, "outlined vectors remain command outputs, not initial inputs");

  for (const mutate of [
    node => { node.fill_layers[0].opacity = 0.5; },
    node => { node.fill_layers[0].paint.c = "#000000"; },
    node => { node.stroke_layers = [{ color: "#000000", width: 1 }]; },
    node => { node.effect_layers = [{ effect: {} }]; },
  ]) {
    const unsafe = clone(raw); mutate(unsafe.pages[0].children[0]);
    assert.throws(() => decodeWebDocument(JSON.stringify(unsafe), seed), /Unsupported|native|layer/i);
  }
});

await test("open gates without wasm and rejects mismatched native round trip, freeing it", async () => {
  const doc = fixture();
  assert.equal(await openWebDocumentSession({ ...doc, components: [{ name: "unsupported" }] }), null);
  assert.equal(await initWasmBridge(async () => moduleWith(undefined)), true);
  assert.equal(await openWebDocumentSession(doc), null);

  __resetWasmForTests();
  let released = 0;
  class BadSession {
    constructor(x) { this.x = x; }
    state() { return "{}"; }
    getNode() { return "null"; }
    getShape() { return "{}"; }
    previewOffset() { return "{}"; }
    offsetNode() { return "{}"; }
    renameNode() { return "{}"; }
    moveNode() { return "{}"; }
    resizeNode() { return "{}"; }
    booleanNode() { return "{}"; }
    strokeNode() { return "{}"; }
    undo() { return "{}"; }
    redo() { return "{}"; }
    exportX() { const v = JSON.parse(this.x); v.pages[0].children[0].x++; return JSON.stringify(v); }
    free() { released++; }
  }
  assert.equal(await initWasmBridge(async () => moduleWith(BadSession)), true);
  assert.equal(await openWebDocumentSession(doc), null);
  assert.equal(released, 1);
});

await test("leaving during optional WASM load cannot create a stale Rust history", async () => {
  let finishLoad;
  let constructed = 0;
  class Session { constructor() { constructed++; } }
  const loading = initWasmBridge(() => new Promise(resolve => { finishLoad = () => resolve(moduleWith(Session)); }));
  const controller = new AbortController();
  const opening = openWebDocumentSession(fixture(), controller.signal);
  controller.abort();
  finishLoad();
  assert.equal(await loading, true);
  assert.equal(await opening, null);
  assert.equal(constructed, 0);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await openWebDocumentSession(fixture(), cancelled.signal), null);
  assert.equal(constructed, 0);
});

await test("once admitted, small commands go straight to Rust; full data only on explicit export", async () => {
  const doc = fixture(), initial = clone(doc);
  const counters = { opens: 0, exports: 0, commands: 0, frees: 0 };
  class FakeSession {
    constructor(x) { counters.opens++; this.data = JSON.parse(x); this.revision = 0; }
    node(id) { const n = this.data.pages[0].children.find(v => v.id === id); return n && { id, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h }; }
    state() { return JSON.stringify({ revision: this.revision, node: null, canUndo: this.revision > 0, canRedo: false }); }
    getNode(id) { return JSON.stringify(this.node(id) ?? null); }
    getShape() { return "{}"; }
    previewOffset() { return "{}"; }
    offsetNode() { return "{}"; }
    edit(id, change) {
      counters.commands++; this.revision++;
      change(this.data.pages[0].children.find(v => v.id === id));
      return JSON.stringify({ revision: this.revision, node: this.node(id), canUndo: true, canRedo: false });
    }
    renameNode(id, name) { return this.edit(id, n => { n.name = name; }); }
    moveNode(id, dx, dy) { return this.edit(id, n => { n.x += dx; n.y += dy; }); }
    resizeNode(id, w, h) { return this.edit(id, n => { n.w = w; n.h = h; }); }
    booleanNode() { throw Error("No mock Boolean geometry"); }
    strokeNode() { throw Error("No mock stroke geometry"); }
    undo() { return this.state(); }
    redo() { return this.state(); }
    exportX() { counters.exports++; return JSON.stringify(this.data); }
    free() { counters.frees++; }
  }
  assert.equal(await initWasmBridge(async () => moduleWith(FakeSession)), true);
  const session = await openWebDocumentSession(doc);
  assert.ok(session);
  assert.deepEqual(counters, { opens: 1, exports: 1, commands: 0, frees: 0 });
  const id = doc.pages[0].root.children[0].id;
  assert.equal(session.getNode(id).name, "Box \u000391");
  assert.deepEqual(session.moveNode(id, -3, 4).node, { id, name: "Box \u000391", x: 7, y: 24, w: 30, h: 40 });
  assert.deepEqual(session.resizeNode(id, 90, 55).node, { id, name: "Box \u000391", x: 7, y: 24, w: 90, h: 55 });
  assert.equal(session.state().revision, 2);
  assert.equal(counters.commands, 2);
  assert.equal(counters.exports, 1, "no full JSON on command/read/frame");
  doc.pages[0].name = "caller mutated"; doc.pages[0].root.children[0].name = "JS shadow";
  const out = session.exportDocument();
  assert.equal(counters.exports, 2);
  initial.pages[0].root.children[0].x = 7; initial.pages[0].root.children[0].y = 24;
  initial.pages[0].root.children[0].w = 90; initial.pages[0].root.children[0].h = 55;
  assert.deepEqual(out, initial, "Rust tree + frozen shell, never mutated caller tree");
  session.close(); session.close();
  assert.equal(counters.frees, 1);
  assert.throws(() => session.exportDocument(), /closed/);
});

await test("promoted offset bypasses the TS oracle but freezes on a wrong affected-layer ID", () => {
  const seed = fixture();
  const id = seed.pages[0].root.children[0].id;
  let commands = 0;
  const native = {
    getShape() { throw Error("default edit must not query a TS oracle input"); },
    previewOffset() { throw Error("default edit must not preflight a second geometry result"); },
    offsetNode() {
      commands++;
      return { revision: 1, node: null, canUndo: true, canRedo: false, offset: { id: "other" } };
    },
  };
  const owner = RustWebDocumentSession.create(native, seed);
  assert.throws(() => owner.offsetNode(id, 4, "miter"), /different layer; editing must pause/);
  assert.equal(commands, 1, "bad native acknowledgement must freeze, not silently replay in TS");
});

await test("promoted outline dispatches one Rust command and freezes on unproven result shapes", () => {
  const seed = fixture();
  const id = seed.pages[0].root.children[0].id;
  let commands = 0;
  const applied = { revision: 1, node: null, canUndo: true, canRedo: false, outline: {
    id, name: "Box 91", x: 10, y: 20, w: 30, h: 40, kind: "vector",
    path: [["M", 0, 0], ["L", 30, 0], ["L", 30, 40], ["L", 0, 40], ["Z"]],
    fill: "#a1b2c3", stroke: null } };
  const native = {
    getShape() { throw Error("the default outline route must not read a TS oracle input"); },
    outlineStroke() { commands++; return applied; },
  };
  const owner = RustWebDocumentSession.create(native, seed);
  assert.deepEqual(owner.outlineStroke(id), applied);
  assert.equal(commands, 1, "the promoted route is exactly one native ReplaceNode command");

  const strokeStyle = { width: 8, color: "#236b9e", align: "center", capStart: "none",
    capEnd: "none", join: "miter", dash: [], dashOffset: 0, miterLimit: 4, widthProfile: [] };
  for (const broken of [
    { ...applied, outline: { ...applied.outline, id: "other" } },
    { ...applied, outline: { ...applied.outline, kind: "rect", radius: 0 } },
    { ...applied, outline: { ...applied.outline, stroke: strokeStyle } },
    { ...applied, outline: { ...applied.outline, path: [["M", 0, 0], ["L", 30, 0]] } },
  ]) {
    const failing = RustWebDocumentSession.create({ outlineStroke: () => broken }, seed);
    assert.throws(() => failing.outlineStroke(id), /editing must pause/,
      "an outline acknowledgement must be a closed filled vector for the same layer");
  }
});

await test("opt-in outline audit proves committed ink against the independent rectangle model", async () => {
  const { __enableBridgeAuditForTests, bridgeAuditSnapshot, resetBridgeAudit } = await import("../bridgeRuntimeAudit.ts");
  const seed = fixture();
  const id = seed.pages[0].root.children[0].id;
  const style = { width: 8, color: "#236b9e", align: "center", capStart: "none",
    capEnd: "none", join: "miter", dash: [], dashOffset: 0, miterLimit: 4, widthProfile: [] };
  // A 10,20 30x40 rectangle with an 8-wide centred miter band: the outer ring
  // is the source rectangle expanded by 4, the hole is it inset by 4, and the
  // two rings are wound oppositely so NONZERO winding leaves the hole empty.
  const banded = { revision: 0, node: null, canUndo: true, canRedo: true, outline: {
    id, name: "Box 91", x: 6, y: 16, w: 38, h: 48, kind: "vector",
    path: [["M", 0, 0], ["L", 38, 0], ["L", 38, 48], ["L", 0, 48], ["Z"],
      ["M", 8, 8], ["L", 8, 40], ["L", 30, 40], ["L", 30, 8], ["Z"]],
    fill: "#236b9e", stroke: null } };
  const restored = { ...banded, outline: { id, name: "Box 91", x: 10, y: 20, w: 30, h: 40,
    kind: "rect", radius: 0, fill: null, stroke: style } };
  const calls = { commands: 0, undos: 0, redos: 0 };
  const native = {
    outlineStroke() { calls.commands++; return { ...banded, revision: 1 }; },
    undo() { calls.undos++; return { ...restored, revision: 2 }; },
    redo() { calls.redos++; return { ...banded, revision: 3 }; },
  };
  __enableBridgeAuditForTests(true);
  const previous = globalThis.location;
  try {
    globalThis.location = { search: "?outline=audit" };
    const owner = RustWebDocumentSession.create(native, seed);
    const result = owner.outlineStroke(id);
    assert.equal(result.revision, 3, "the audit returns the redone command, not the intermediate undo");
    assert.deepEqual(result.outline, banded.outline, "the committed vector round-trips exactly");
    assert.deepEqual(calls, { commands: 1, undos: 1, redos: 1 },
      "the audit reads no offset-gated shape query: the source comes from the command's own undo projection");
    const decision = bridgeAuditSnapshot().decisions["session.outline"];
    assert.equal(decision.last.guard, "passed");
    assert.equal(decision.last.result, "rust");

    // A source this reference does not model is reported, never asserted as a
    // pass, and never turned into a refusal: the native command still runs.
    resetBridgeAudit();
    const ellipseCalls = { commands: 0, undos: 0, redos: 0 };
    const ellipse = RustWebDocumentSession.create({
      outlineStroke() { ellipseCalls.commands++; return { ...banded, revision: 1 }; },
      undo() { ellipseCalls.undos++; return { ...restored, revision: 2, outline: { ...restored.outline, kind: "ellipse", radius: null } }; },
      redo() { ellipseCalls.redos++; return { ...banded, revision: 1 }; },
    }, seed);
    assert.equal(ellipse.outlineStroke(id).revision, 1);
    assert.deepEqual(ellipseCalls, { commands: 1, undos: 1, redos: 1 });
    assert.equal(bridgeAuditSnapshot().decisions["session.outline"].last.guard, "not-run");

    // Fabricated ink (a filled bounding box, not a band) is a decisive
    // disagreement: the command stands, but the preview must stop painting.
    resetBridgeAudit();
    const undosBeforeFabricated = calls.undos;
    const fabricatedPath = [["M", 0, 0], ["L", 38, 0], ["L", 38, 48], ["L", 0, 48], ["Z"]];
    const fabricated = RustWebDocumentSession.create({
      outlineStroke() { return { ...banded, revision: 1, outline: { ...banded.outline, path: fabricatedPath } }; },
      undo: native.undo,
      redo() { return { ...banded, revision: 3, outline: { ...banded.outline, path: fabricatedPath } }; },
    }, seed);
    assert.throws(() => fabricated.outlineStroke(id), /independent rectangle reference/);
    assert.equal(bridgeAuditSnapshot().decisions["session.outline"].last.guard, "blocked");
    assert.equal(calls.undos, undosBeforeFabricated + 2,
      "the rejected command is undone again, so native history rests on the proven source behind the freeze");
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
    resetBridgeAudit();
    __enableBridgeAuditForTests(false);
  }
});

console.log(`Web document admission: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
