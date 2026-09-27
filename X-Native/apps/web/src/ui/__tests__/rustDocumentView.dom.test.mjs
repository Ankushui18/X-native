import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDom } from "./domEnv.mjs";

const win = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { docFromTemplate } = await import("../../engine/files.ts");
const { node } = await import("../../engine/memory.ts");
const { initWasmBridge, __resetWasmForTests } = await import("../../engine/wasmBridge.ts");
const { RustDocumentView } = await import("../RustDocumentView.tsx");
const { readRoute, decideRouteChange } = await import("../fileRoute.ts");
const { act } = React;
const clone = x => JSON.parse(JSON.stringify(x));

const fixture = () => {
  const doc = docFromTemplate("blank");
  doc.fileName = "Rust / preview";
  doc.pages[0].root.children.push(
    node("rect", "Card", 10, 20, 70, 40, { fill: "#13aabb" }),
    node("rect", "Hidden", -5, 0, 25, 50, { fill: "#445566", visible: false, locked: true }),
  );
  return doc;
};
const moduleWith = Session => ({
  default: async () => {}, bridgeVersion: () => 1, engineVersion: () => "x-wasm 0.34.0 (rust)",
  importFigToX: () => "", importSketchToX: () => "", importSvgToX: () => "",
  sessionBridgeVersion: () => 3, RustDocumentSession: Session,
});
const calls = { opens: 0, exports: 0, queries: 0, edits: 0, closes: 0 };
class FakeRust {
  constructor(x) { calls.opens++; this.doc = JSON.parse(x); this.revision = 0; this.undos = []; this.redos = []; }
  get(id) { return this.doc.pages[0].children.find(n => n.id === id); }
  state(node = null) { return JSON.stringify({ revision: this.revision, node, canUndo: this.undos.length > 0, canRedo: this.redos.length > 0 }); }
  getNode(id) {
    calls.queries++;
    const n = this.get(id);
    return JSON.stringify(n ? { id, name: n.name ?? id, x: n.x, y: n.y, w: n.w, h: n.h } : null);
  }
  edit(id, change) {
    calls.edits++;
    const n = this.get(id), before = { name: n.name, x: n.x, y: n.y, w: n.w, h: n.h };
    change(n); const after = { name: n.name, x: n.x, y: n.y, w: n.w, h: n.h };
    this.undos.push({ id, before, after }); this.redos.length = 0; this.revision++;
    return this.state({ id, ...after });
  }
  moveNode(id, dx, dy) {
    const result = this.edit(id, n => { n.x += dx; n.y += dy; });
    if (FakeRust.badNextDelta) {
      FakeRust.badNextDelta = false;
      const corrupt = JSON.parse(result); corrupt.node.id = "unknown-rust-id";
      return JSON.stringify(corrupt);
    }
    return result;
  }
  renameNode(id, name) { return this.edit(id, n => { n.name = name.trim(); }); }
  resizeNode(id, w, h) { return this.edit(id, n => { n.w = w; n.h = h; }); }
  booleanNode(first, second, name) {
    // A predetermined fixture response exercises the DOM/ABI, NOT a JS
    // implementation of Boolean geometry. Genuine contours are tested in CI.
    const before = clone(this.doc.pages[0].children);
    const a = this.get(first), b = this.get(second);
    if (!a || !b || a === b) throw new Error("Invalid Boolean operands");
    const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.w, b.x + b.w), bottom = Math.max(a.y + a.h, b.y + b.h);
    const w = right - left, h = bottom - top;
    const ring = [[0, 0], [w, 0], [w, h], [0, h]];
    const result = { ...clone(a), id: "rust-bool-result", name: name[0].toUpperCase() + name.slice(1),
      x: left, y: top, w, h, kind: { t: "vector", path: [
        ["M", 0, 0], ["L", w, 0], ["L", w, h], ["L", 0, h], ["Z"],
      ] } };
    const index = Math.min(before.findIndex(n => n.id === first), before.findIndex(n => n.id === second));
    this.doc.pages[0].children = before.filter(n => n.id !== first && n.id !== second);
    this.doc.pages[0].children.splice(index, 0, result);
    const change = { id: result.id, name: result.name, x: left, y: top, w, h, index,
      kind: "vector", fill: a.fill.c, visible: a.visible, locked: a.locked, rings: [ring] };
    this.undos.push({ boolean: true, before, after: clone(this.doc.pages[0].children),
      result: change, removed: [first, second] });
    this.redos.length = 0; this.revision++; calls.edits++;
    return JSON.stringify({ ...JSON.parse(this.state()),
      boolean: { upsert: [change], removed: [first, second] } });
  }
  undo() {
    const op = this.undos.pop();
    if (!op) return this.state();
    this.redos.push(op); this.revision++;
    if (op.boolean) {
      this.doc.pages[0].children = clone(op.before);
      return JSON.stringify({ ...JSON.parse(this.state()), boolean: {
        removed: [op.result.id], upsert: op.removed.map(id => {
          const n = this.get(id);
          return { id, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h,
            index: op.before.findIndex(v => v.id === id), kind: "rect",
            fill: n.fill.c, visible: n.visible, locked: n.locked };
        }),
      } });
    }
    Object.assign(this.get(op.id), op.before);
    return this.state({ id: op.id, ...op.before });
  }
  redo() {
    const op = this.redos.pop();
    if (!op) return this.state();
    this.undos.push(op); this.revision++;
    if (op.boolean) {
      this.doc.pages[0].children = clone(op.after);
      return JSON.stringify({ ...JSON.parse(this.state()), boolean: {
        removed: op.removed, upsert: [op.result],
      } });
    }
    Object.assign(this.get(op.id), op.after);
    return this.state({ id: op.id, ...op.after });
  }
  exportX() { calls.exports++; return JSON.stringify(this.doc); }
  free() { calls.closes++; }
}
const urls = new Map(), revoked = [];
URL.createObjectURL = blob => { const url = `blob:rust-preview/${urls.size + 1}`; urls.set(url, blob); return url; };
URL.revokeObjectURL = url => revoked.push(url);

function mount(seed, strict = false) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const releases = [];
  const props = {
    fileId: "qa-file", seed,
    onHome: () => {}, onStandard: () => {},
    onRelease: fn => releases.push(fn),
  };
  const element = React.createElement(RustDocumentView, props);
  return {
    host, root, releases,
    async render() {
      await act(async () => root.render(strict ? React.createElement(React.StrictMode, null, element) : element));
      await act(async () => { await Promise.resolve(); });
    },
    byText(label) { return [...host.querySelectorAll("button")].find(b => b.textContent.trim() === label); },
    async click(label) {
      const button = this.byText(label);
      assert.ok(button, `missing button ${label}`);
      await act(async () => button.dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
    },
    async type(name) {
      const input = host.querySelector("#rust-layer-name"); assert.ok(input);
      const set = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
      await act(async () => { input.focus(); set.call(input, name); input.dispatchEvent(new win.Event("input", { bubbles: true })); });
    },
    async close() { await act(async () => root.unmount()); host.remove(); },
  };
}

assert.deepEqual(readRoute("#/file/a%20b"), { view: "file", id: "a b", rust: false });
assert.deepEqual(readRoute("#/file/a%20b?f=box&engine=rust"), { view: "file", id: "a b", rust: true });
assert.deepEqual(readRoute("#/file/a?engine=ts"), { view: "file", id: "a", rust: false });
assert.deepEqual(readRoute("#/file/%bad"), { view: "home" });
assert.deepEqual(readRoute("#/"), { view: "home" });
const rustRoute = readRoute("#/file/a?engine=rust");
const sameRustRoute = readRoute("#/file/a?f=rect&engine=rust");
const standardRoute = readRoute("#/file/a");
assert.equal(decideRouteChange(rustRoute, sameRustRoute, true, () => { throw Error("must not prompt"); }), "same-owner");
assert.equal(decideRouteChange(rustRoute, standardRoute, true, () => false), "cancel");
assert.equal(decideRouteChange(rustRoute, standardRoute, true, () => true), "switch");
assert.equal(decideRouteChange(rustRoute, standardRoute, false, () => { throw Error("must not prompt"); }), "switch");
assert.equal(decideRouteChange(rustRoute, readRoute("#/file/b?engine=rust"), true, () => false), "cancel");
// Owner swap is in the router, not in a MemoryEngine adapter. A browser Back
// must close Rust synchronously before it can render the production Editor.
const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
assert.match(app, /owner\?\.close\(\);\s*acceptedHash\.current = window\.location\.hash;\s*routeRef\.current = next;\s*setRoute\(next\)/);
assert.match(app, /decideRouteChange\(previous, next, !!owner\?\.hasEdits\(\), \(\) => window\.confirm/);
assert.match(app, /if \(pending\) write\(\);\s*window\.removeEventListener\("pagehide", flush\)/);
assert.match(app, /seed\.rust !== route\.rust/);
assert.match(app, /if \(route\.rust\) \{\s*return \(\s*<RustDocumentView/);
console.log("  ok explicit route and close-before-TS-owner boundary");

__resetWasmForTests();
assert.equal(await initWasmBridge(async () => moduleWith(FakeRust)), true);
const source = fixture(), snapshot = clone(source);
const ui = mount(source, true); // React StrictMode must still open ONE Rust history
await ui.render();
assert.equal(calls.opens, 1);
assert.equal(calls.exports, 1, "full Rust export occurs only at open");
assert.equal(calls.queries, 2, "one-node reads at open, not a shadow document");
assert.equal(ui.host.querySelectorAll(".rust-preview-layers button").length, 2);
assert.equal(ui.host.querySelectorAll(".rust-preview-rect").length, 1, "hidden rect is not painted");
assert.ok(ui.host.textContent.includes("not autosaved"));
assert.equal(ui.host.querySelector(".rust-preview-rect").style.background, "rgb(19, 170, 187)");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.left, "10px");
const cleanExit = new win.Event("beforeunload", { cancelable: true });
win.dispatchEvent(cleanExit);
assert.equal(cleanExit.defaultPrevented, false);
await ui.click("Move right 10");
const unsavedExit = new win.Event("beforeunload", { cancelable: true });
win.dispatchEvent(unsavedExit);
assert.equal(unsavedExit.defaultPrevented, true, "browser unload prompts after Rust-owned edits");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.left, "20px");
assert.equal(calls.exports, 1, "move responds with one-node delta; no .x per edit");
assert.equal(ui.host.querySelector(".rust-preview-toolbar span:not([role])").textContent, "Rust revision 1");
await ui.type("Renamed");
await ui.click("Rename");
assert.equal(ui.host.querySelector(".rust-preview-rect").getAttribute("aria-label"), "Renamed");
await ui.click("Undo");
assert.equal(ui.host.querySelector(".rust-preview-rect").getAttribute("aria-label"), "Card");
await ui.click("Redo");
assert.equal(ui.host.querySelector(".rust-preview-rect").getAttribute("aria-label"), "Renamed");
await ui.click("Wider 10");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.width, "80px");
assert.ok(ui.host.textContent.includes("Size 80 × 40"));
await ui.click("Undo");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.width, "70px");
await ui.click("Redo");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.width, "80px");
await ui.click("Shorter 10");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.height, "30px");
await ui.click("Undo");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.height, "40px");
await ui.click("Redo");
assert.equal(ui.host.querySelector(".rust-preview-rect").style.height, "30px");
assert.equal(calls.exports, 1, "resize/history never serialize the full document");
assert.deepEqual(source, snapshot, "React presentation never mutates original web seed");
await ui.click("Prepare download");
assert.equal(calls.exports, 2);
const link = ui.host.querySelector("a[download]");
assert.ok(link && link.getAttribute("download") === "Rust _ preview.x.json");
const downloaded = JSON.parse(await urls.get(link.href).text());
assert.equal(downloaded.pages[0].root.children[0].x, 20);
assert.equal(downloaded.pages[0].root.children[0].name, "Renamed");
assert.deepEqual([downloaded.pages[0].root.children[0].w, downloaded.pages[0].root.children[0].h], [80, 30]);
assert.deepEqual(downloaded.pages[0].root.children[1], snapshot.pages[0].root.children[1]);
await ui.click("Move down 10");
assert.equal(ui.host.querySelector("a[download]"), null, "stale link invalidated on Rust edit");
assert.ok(revoked.includes(link.href));
assert.equal(calls.exports, 2);
// Simulate App's synchronous hashchange release. Cleanup is idempotent.
const owner = ui.releases.find(x => x && typeof x.close === "function"); assert.ok(owner);
assert.equal(owner.hasEdits(), true);
owner.close();
assert.equal(calls.closes, 1);
await ui.close();
assert.equal(calls.closes, 1);
console.log("  ok mounted Rust-only view: small rename/move/resize deltas, Rust history, explicit download and cleanup");

const boolSeed = fixture();
Object.assign(boolSeed.pages[0].root.children[1], { x: 30, y: 25, w: 40, h: 30,
  name: "Second", visible: true, locked: false });
const preview = mount(boolSeed);
await preview.render();
const exportsBeforeBool = calls.exports;
assert.equal(preview.byText("Union").disabled, true, "must select two admitted rectangles");
const second = [...preview.host.querySelectorAll(".rust-preview-layers button")].find(b => b.textContent.includes("Second"));
await act(async () => second.dispatchEvent(new win.MouseEvent("click", { bubbles: true, shiftKey: true })));
assert.equal(preview.byText("Union").disabled, false);
await preview.click("Union");
assert.equal(preview.host.querySelectorAll(".rust-preview-layers button").length, 1);
assert.equal(preview.host.querySelector(".rust-preview-rect path").getAttribute("fill"), "#13aabb");
assert.match(preview.host.querySelector(".rust-preview-rect path").getAttribute("d"), /M0 0 L70 0/);
assert.equal(preview.byText("Wider 10").disabled, true, "unproved vector resize stays disabled");
assert.equal(calls.exports, exportsBeforeBool, "Boolean returns structural delta, never full document");
await preview.click("Undo");
assert.equal(preview.host.querySelectorAll(".rust-preview-layers button").length, 2);
assert.equal(preview.host.querySelector(".rust-preview-rect path"), null);
await preview.click("Redo");
assert.ok(preview.host.querySelector(".rust-preview-rect path"));
assert.equal(calls.exports, exportsBeforeBool, "undo/redo also use structural deltas");
await preview.click("Prepare download");
const vectorLink = preview.host.querySelector("a[download]");
assert.ok(vectorLink);
const savedVector = JSON.parse(await urls.get(vectorLink.href).text()).pages[0].root.children[0];
assert.equal(savedVector.kind, "vector");
assert.equal(savedVector.vectorNetwork.regions[0].loops.length, 1);
assert.equal(savedVector.vectorNetwork.vertices.length, 4);
await preview.close();
console.log("  ok Boolean preview: two-layer selection, vector paint, atomic history, explicit vector checkpoint");

const openedBeforeInvalid = calls.opens;
const invalid = fixture(); invalid.styles.push({ name: "outside subset" });
const no = mount(invalid);
await no.render();
assert.equal(calls.opens, openedBeforeInvalid, "unsupported whole file never starts a second history");
assert.ok(no.host.textContent.includes("outside the safe Rust subset"));
assert.ok(no.byText("Standard editor"));
await no.close();
console.log("  ok unsupported file keeps its stored data and offers standard editor");

const subpixel = fixture(); subpixel.pages[0].root.children[0].w = 0.25;
const tiny = mount(subpixel);
await tiny.render();
assert.equal(tiny.host.querySelector(".rust-preview-rect").style.width, "0.25px");
assert.equal(tiny.byText("Wider 10").disabled, true, "native resize would clamp the other subpixel dimension");
assert.equal(tiny.byText("Taller 10").disabled, true);
assert.ok(tiny.host.textContent.includes("Native resize requires both dimensions to be at least 1"));
await tiny.click("Move right 10");
assert.equal(tiny.host.querySelector(".rust-preview-rect").style.left, "20px");
await tiny.close();
console.log("  ok subpixel files stay editable but cannot silently clamp dimensions on resize");

const corrupt = mount(fixture());
await corrupt.render();
FakeRust.badNextDelta = true;
await corrupt.click("Move right 10");
assert.ok(corrupt.host.textContent.includes("Edits are paused"));
assert.equal(corrupt.host.querySelector(".rust-preview-rect").style.left, "10px", "never guess state after corrupt delta");
assert.equal(corrupt.byText("Undo").disabled, true);
const recoveryOwner = corrupt.releases.find(x => x?.hasEdits);
assert.equal(recoveryOwner.hasEdits(), true);
await corrupt.click("Prepare download");
const recovered = JSON.parse(await urls.get(corrupt.host.querySelector("a[download]").href).text());
assert.equal(recovered.pages[0].root.children[0].x, 20, "actual Rust state is recoverable without TS replay");
await corrupt.close();
console.log("  ok malformed Rust delta freezes UI, keeps single owner and allows strict recovery export");

__resetWasmForTests();
assert.equal(await initWasmBridge(async () => { throw Error("missing optional asset"); }), false);
const missing = mount(fixture());
await missing.render();
assert.ok(missing.host.textContent.includes("Rust session is unavailable"));
assert.ok(missing.byText("Standard editor"));
await missing.close();
console.log("  ok missing WASM does not silently mount another editing history");

__resetWasmForTests();
const openedBeforeOldAbi = calls.opens;
assert.equal(await initWasmBridge(async () => ({ ...moduleWith(FakeRust), sessionBridgeVersion: () => 1 })), true);
const oldAbi = mount(fixture());
await oldAbi.render();
assert.equal(calls.opens, openedBeforeOldAbi);
assert.ok(oldAbi.host.textContent.includes("Rust session is unavailable"));
assert.ok(oldAbi.byText("Standard editor"));
await oldAbi.close();
console.log("  ok V1 session artifact keeps imports but cannot mount a stale-size Rust preview");

__resetWasmForTests();
let finish;
const waitForWasm = initWasmBridge(() => new Promise(resolve => { finish = () => resolve(moduleWith(FakeRust)); }));
const openedBeforeLeave = calls.opens;
const abandoned = mount(fixture());
await abandoned.render();
await abandoned.close();
finish();
assert.equal(await waitForWasm, true);
await Promise.resolve();
assert.equal(calls.opens, openedBeforeLeave, "aborted route cannot open Rust after unmount");
console.log("  ok leaving during WASM load cannot resurrect an editor");
