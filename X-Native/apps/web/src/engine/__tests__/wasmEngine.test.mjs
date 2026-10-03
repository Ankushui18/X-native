import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WasmEngine } from "../WasmEngine.ts";
import { __resetWasmForTests, initWasmBridge, wasmPocExports } from "../wasmBridge.ts";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`, error);
  }
}

function moduleWithPoc() {
  let state = { revision: 0, canUndo: false, nodes: [] };
  const commands = [];
  const clone = () => structuredClone(state);
  return {
    commands,
    module: {
      default: async () => {},
      bridgeVersion: () => 1,
      engineVersion: () => "x-wasm 0.34.0 (rust)",
      importFigToX: () => "{}",
      importSketchToX: () => "{}",
      importSvgToX: () => "{}",
      init_wasm_engine: () => clone(),
      dispatch_command: (command) => {
        commands.push(command);
        const id = `wasm-poc-rect-${state.nodes.length + 1}`;
        state = {
          revision: state.revision + 1,
          canUndo: true,
          nodes: [...state.nodes, {
            id,
            name: `Rectangle ${state.nodes.length + 1}`,
            kind: "rect",
            x: command.x,
            y: command.y,
            w: 100,
            h: 80,
          }],
        };
        return clone();
      },
    },
  };
}

await test("typed wrapper initializes, dispatches a rectangle command, and snapshots Rust state", async () => {
  __resetWasmForTests();
  const fixture = moduleWithPoc();
  assert.equal(await initWasmBridge(async () => fixture.module), true);
  assert.equal(typeof wasmPocExports()?.dispatch_command, "function");
  const wasmEngine = await WasmEngine.initialize();
  assert.deepEqual(wasmEngine.snapshot(), { revision: 0, canUndo: false, nodes: [] });
  let notified = 0;
  const unsubscribe = wasmEngine.subscribe(() => { notified++; });

  const state = wasmEngine.createRectangle(100, 100);
  assert.equal(notified, 1);
  unsubscribe();
  assert.deepEqual(fixture.commands, [{ type: "createNode", nodeType: "rect", x: 100, y: 100 }]);
  assert.deepEqual(state, {
    revision: 1,
    canUndo: true,
    nodes: [{ id: "wasm-poc-rect-1", name: "Rectangle 1", kind: "rect", x: 100, y: 100, w: 100, h: 80 }],
  });
});

await test("snapshots are stable and immutable; invalid coordinates never cross the bridge", async () => {
  __resetWasmForTests();
  const fixture = moduleWithPoc();
  await initWasmBridge(async () => fixture.module);
  const wasmEngine = await WasmEngine.initialize();
  const state = wasmEngine.createRectangle(100, 100);
  assert.strictEqual(wasmEngine.snapshot(), state);
  assert.throws(() => { state.nodes[0].x = 999; }, TypeError);
  assert.equal(wasmEngine.snapshot().nodes[0].x, 100);
  assert.throws(() => wasmEngine.createRectangle(Number.NaN, 20), /finite/);
  assert.equal(fixture.commands.length, 1);
});

await test("older generated assets still load for existing imports but clearly decline the POC", async () => {
  __resetWasmForTests();
  const old = moduleWithPoc().module;
  delete old.init_wasm_engine;
  delete old.dispatch_command;
  assert.equal(await initWasmBridge(async () => old), true);
  assert.equal(wasmPocExports(), undefined);
  await assert.rejects(WasmEngine.initialize(), /no Phase 1 command exports/);
});

await test("the dev dashboard button calls the App proof and logs the returned state", async () => {
  const dashboard = readFileSync(join(here, "../../ui/Dashboard.tsx"), "utf8");
  const app = readFileSync(join(here, "../../App.tsx"), "utf8");
  assert.match(dashboard, /import\.meta\.env\.DEV && onRunWasmPoc/);
  assert.match(dashboard, /aria-label="Run Rust WASM proof of concept"/);
  assert.match(app, /wasmEngine\.createRectangle\(100, 100\)/);
  assert.match(app, /console\.log\("\[X-Native\] Rust WASM DocumentState:", state\)/);
});

__resetWasmForTests();
console.log(`wasmEngine: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
