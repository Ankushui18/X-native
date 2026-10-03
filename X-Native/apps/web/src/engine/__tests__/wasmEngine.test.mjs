import assert from "node:assert/strict";
import React, { useSyncExternalStore } from "react";
import { JSDOM } from "jsdom";
import { WasmEngine, decodeDocumentState } from "../WasmEngine.ts";
import { MemoryEngine, find } from "../memory.ts";
import { __enableBridgeAuditForTests, bridgeAuditSnapshot } from "../bridgeRuntimeAudit.ts";
import { __resetWasmForTests, initWasmBridge } from "../wasmBridge.ts";

const emptyEnvelope = JSON.stringify({
  ok: true,
  doc: { format: "x-native", version: 1, pages: [] },
});

function moduleWithPoc() {
  let revision = 0;
  let nextId = 1;
  let nodes = [];
  let variables = {
    "var-1": "#0d99ff",
    "var-2": "#6366f1",
    "var-3": "8",
    "var-4": "16",
    "var-5": "8",
  };
  let modeValues = {};
  let activeModes = {};
  let componentOverrides = {};
  let variablesTouched = false;
  let componentsTouched = false;
  let undoStack = [];
  let redoStack = [];
  let lastRenderKey = "";
  const commands = [];
  const renderCalls = [];
  const cloneNodes = (list) =>
    list.map((node) => ({
      ...node,
      ...(node.componentProperties
        ? { componentProperties: { ...node.componentProperties } }
        : {}),
    }));
  const cloneNestedRecord = (rec) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, { ...v }]));
  const currentActiveMode = () => Object.values(activeModes)[0] ?? null;
  const resolvedVariables = () => {
    const mode = currentActiveMode();
    const out = { ...variables };
    if (mode && modeValues[mode]) {
      Object.assign(out, modeValues[mode]);
    }
    return out;
  };
  const snapshot = () => {
    const vars = resolvedVariables();
    return {
      revision,
      canUndo: undoStack.length > 0,
      nodes: cloneNodes(nodes).map((n) => ({
        ...n,
        ...(n.fillVariable && vars[n.fillVariable] ? { fill: vars[n.fillVariable] } : {}),
      })),
      ...(variablesTouched ? { variables: vars } : {}),
      ...(variablesTouched && Object.keys(activeModes).length > 0
        ? { activeModes: { ...activeModes } }
        : {}),
      ...(componentsTouched
        ? { componentOverrides: cloneNestedRecord(componentOverrides) }
        : {}),
    };
  };
  const captureHistoryState = () => ({
    nodes: cloneNodes(nodes),
    variables: { ...variables },
    modeValues: cloneNestedRecord(modeValues),
    activeModes: { ...activeModes },
    componentOverrides: cloneNestedRecord(componentOverrides),
    variablesTouched,
    componentsTouched,
  });
  const restoreHistoryState = (st) => {
    nodes = cloneNodes(st.nodes);
    variables = { ...st.variables };
    modeValues = cloneNestedRecord(st.modeValues);
    activeModes = { ...st.activeModes };
    componentOverrides = cloneNestedRecord(st.componentOverrides);
    variablesTouched = st.variablesTouched;
    componentsTouched = st.componentsTouched;
  };
  const pushHistory = () => {
    undoStack.push(captureHistoryState());
    redoStack = [];
  };
  const glue = {
    default: async () => {},
    bridgeVersion: () => 1,
    engineVersion: () => "x-wasm 0.1.0 (rust; wasm-engine-test)",
    importFigToX: () => emptyEnvelope,
    importSketchToX: () => emptyEnvelope,
    importSvgToX: () => emptyEnvelope,
    init_wasm_engine: () => {
      revision = 0;
      nextId = 1;
      nodes = [];
      variables = {
        "var-1": "#0d99ff",
        "var-2": "#6366f1",
        "var-3": "8",
        "var-4": "16",
        "var-5": "8",
      };
      modeValues = {};
      activeModes = {};
      componentOverrides = {};
      variablesTouched = false;
      componentsTouched = false;
      undoStack = [];
      redoStack = [];
      lastRenderKey = "";
      return snapshot();
    },
    render_frame: (canvasId, state) => {
      if (!canvasId || typeof canvasId !== "string") {
        throw new Error("canvas_id must be a non-empty string");
      }
      const dpr = typeof state.devicePixelRatio === "number" && state.devicePixelRatio > 0
        ? state.devicePixelRatio
        : 1;
      const vw = typeof state.viewportWidth === "number" && state.viewportWidth > 0
        ? state.viewportWidth
        : 1200;
      const vh = typeof state.viewportHeight === "number" && state.viewportHeight > 0
        ? state.viewportHeight
        : 800;
      const pixelWidth = Math.max(1, Math.round(vw * dpr));
      const pixelHeight = Math.max(1, Math.round(vh * dpr));
      const renderKey = `${canvasId}:${state.revision}:${state.nodes?.length ?? 0}:${pixelWidth}x${pixelHeight}@${dpr}`;
      const skippedUnchanged = renderKey === lastRenderKey;
      lastRenderKey = renderKey;
      renderCalls.push({ canvasId, state, pixelWidth, pixelHeight, dpr, skippedUnchanged });
      const nodeCount = Array.isArray(state.nodes) ? state.nodes.length : 0;
      return {
        revision: state.revision ?? 0,
        nodeCount,
        commandCount: nodeCount,
        drawCalls: skippedUnchanged ? 0 : nodeCount,
        devicePixelRatio: dpr,
        pixelWidth,
        pixelHeight,
        skippedUnchanged,
      };
    },
    dispatch_command: (command) => {
      commands.push(command);
      if (command.type === "createNode" || command.type === "CreateNode") {
        if (
          command.nodeType !== "rect" &&
          command.nodeType !== "frame" &&
          command.nodeType !== "text" &&
          command.nodeType !== "ellipse"
        ) {
          throw new Error("Unsupported command");
        }
        if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
          throw new Error("Coordinates must be finite");
        }
        const w = command.width ?? 100;
        const h = command.height ?? 80;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          throw new Error("Dimensions must be positive finite numbers");
        }
        pushHistory();
        const id =
          command.nodeType === "frame"
            ? `wasm-poc-frame-${nextId}`
            : command.nodeType === "text"
              ? `wasm-poc-text-${nextId}`
              : command.nodeType === "ellipse"
                ? `wasm-poc-ellipse-${nextId}`
                : `wasm-poc-rect-${nextId}`;
        const name =
          command.nodeType === "frame"
            ? `Frame ${nextId}`
            : command.nodeType === "text"
              ? `Text ${nextId}`
              : command.nodeType === "ellipse"
                ? `Ellipse ${nextId}`
                : `Rectangle ${nextId}`;
        nextId++;
        revision++;
        const hasValidParent =
          typeof command.parentId === "string" &&
          nodes.some((n) => n.id === command.parentId);
        nodes.push({
          id,
          name,
          kind: command.nodeType,
          x: command.x,
          y: command.y,
          w,
          h,
          ...(hasValidParent ? { parentId: command.parentId } : {}),
          rotation: 0,
          opacity: 1,
          ...(command.nodeType !== "frame" ? { fill: "#000000" } : {}),
          ...(command.nodeType === "text"
            ? { text: typeof command.text === "string" && command.text ? command.text : "Text" }
            : {}),
        });
        return snapshot();
      }
      if (command.type === "moveNode" || command.type === "MoveNode") {
        const target = nodes.find((n) => n.id === command.id);
        if (!target) {
          throw new Error(`node not found: ${command.id}`);
        }
        if (!Number.isFinite(command.dx) || !Number.isFinite(command.dy)) {
          throw new Error("Move deltas must be finite");
        }
        if (command.dx !== 0 || command.dy !== 0 || command.parentId !== undefined) {
          pushHistory();
          target.x += command.dx;
          target.y += command.dy;
          if (typeof command.parentId === "string") {
            if (command.parentId && nodes.some((n) => n.id === command.parentId)) {
              target.parentId = command.parentId;
            } else {
              delete target.parentId;
            }
          }
          revision++;
        }
        return snapshot();
      }
      if (command.type === "resizeNode" || command.type === "ResizeNode") {
        const target = nodes.find((n) => n.id === command.id);
        if (!target) {
          throw new Error(`node not found: ${command.id}`);
        }
        if (!Number.isFinite(command.width) || !Number.isFinite(command.height) || command.width <= 0 || command.height <= 0) {
          throw new Error("Resize dimensions must be positive finite numbers");
        }
        pushHistory();
        if (typeof command.x === "number") target.x = command.x;
        if (typeof command.y === "number") target.y = command.y;
        target.w = command.width;
        target.h = command.height;
        revision++;
        return snapshot();
      }
      if (command.type === "deleteNode" || command.type === "DeleteNode") {
        if (command.id === "wasm-poc-page") {
          throw new Error("cannot delete the root node");
        }
        const idx = nodes.findIndex((n) => n.id === command.id);
        if (idx < 0) {
          throw new Error(`node not found: ${command.id}`);
        }
        pushHistory();
        const removedIds = new Set([command.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of nodes) {
            if (n.parentId && removedIds.has(n.parentId) && !removedIds.has(n.id)) {
              removedIds.add(n.id);
              changed = true;
            }
          }
        }
        nodes = nodes.filter((n) => !removedIds.has(n.id));
        revision++;
        return snapshot();
      }
      if (command.type === "booleanOperation" || command.type === "BooleanOperation") {
        if (!Array.isArray(command.targetIds) || command.targetIds.length < 2) {
          throw new Error("booleanOperation requires at least 2 target node ids");
        }
        const targets = command.targetIds.map((tid) => {
          const found = nodes.find((n) => n.id === tid);
          if (!found) throw new Error(`node not found: ${tid}`);
          return found;
        });
        pushHistory();
        const minX = Math.min(...targets.map((t) => t.x));
        const minY = Math.min(...targets.map((t) => t.y));
        const maxX = Math.max(...targets.map((t) => t.x + t.w));
        const maxY = Math.max(...targets.map((t) => t.y + t.h));
        const bw = Math.max(1, maxX - minX);
        const bh = Math.max(1, maxY - minY);
        const parentId = targets[0].parentId;
        const fill = targets[0].fill ?? "#000000";
        const targetSet = new Set(command.targetIds);
        nodes = nodes.filter((n) => !targetSet.has(n.id));
        const id = `wasm-poc-bool-${nextId}`;
        nextId++;
        revision++;
        const opLabels = {
          union: "Union",
          subtract: "Subtract",
          intersect: "Intersect",
          exclude: "Exclude",
        };
        const rx = bw / 2;
        const ry = bh / 2;
        const k = 0.5522847498307936;
        nodes.push({
          id,
          name: opLabels[command.operation] ?? "Union",
          kind: "boolean",
          x: minX,
          y: minY,
          w: bw,
          h: bh,
          ...(parentId ? { parentId } : {}),
          rotation: 0,
          opacity: 1,
          fill,
          booleanOp: command.operation,
          pathCommands: [
            { op: "M", x: bw, y: ry },
            { op: "C", c1x: bw, c1y: ry + k * ry, c2x: rx + k * rx, c2y: bh, x: rx, y: bh },
            { op: "C", c1x: rx - k * rx, c1y: bh, c2x: 0, c2y: ry + k * ry, x: 0, y: ry },
            { op: "C", c1x: 0, c1y: ry - k * ry, c2x: rx - k * rx, c2y: 0, x: rx, y: 0 },
            { op: "C", c1x: rx + k * rx, c1y: 0, c2x: bw, c2y: ry - k * ry, x: bw, y: ry },
            { op: "Z" },
          ],
        });
        return snapshot();
      }
      if (command.type === "applyAutoLayout" || command.type === "ApplyAutoLayout") {
        const frame = nodes.find((n) => n.id === command.frameId && n.kind === "frame");
        if (!frame) {
          throw new Error(`frame not found: ${command.frameId}`);
        }
        pushHistory();
        const pad = command.padding;
        const gap = command.gap;
        const axis = command.axis;
        frame.autoLayout = { axis, padding: pad, gap };
        const children = nodes.filter((n) => n.parentId === frame.id);
        let cursor = pad;
        let maxCross = 0;
        for (const ch of children) {
          if (axis === "horizontal") {
            ch.x = cursor;
            ch.y = pad;
            cursor += ch.w + gap;
            if (ch.h > maxCross) maxCross = ch.h;
          } else {
            ch.x = pad;
            ch.y = cursor;
            cursor += ch.h + gap;
            if (ch.w > maxCross) maxCross = ch.w;
          }
        }
        if (children.length > 0) {
          const mainSpan = cursor - gap + pad;
          const crossSpan = maxCross + pad * 2;
          if (axis === "horizontal") {
            frame.w = mainSpan;
            frame.h = crossSpan;
          } else {
            frame.w = crossSpan;
            frame.h = mainSpan;
          }
        }
        revision++;
        return snapshot();
      }
      if (command.type === "updateNode" || command.type === "UpdateNode") {
        const target = nodes.find((n) => n.id === command.id);
        if (!target) {
          throw new Error(`node not found: ${command.id}`);
        }
        pushHistory();
        if (typeof command.name === "string" && command.name.trim()) {
          target.name = command.name.trim();
        }
        if (typeof command.fill === "string") {
          target.fill = command.fill === "none" ? null : command.fill;
        }
        if (typeof command.stroke === "string") {
          if (command.stroke === "none" || command.stroke === "") {
            delete target.stroke;
            delete target.strokeWidth;
          } else {
            target.stroke = command.stroke;
            if (!target.strokeWidth) target.strokeWidth = 1;
          }
        }
        if (typeof command.strokeWidth === "number") {
          if (command.strokeWidth <= 0) {
            delete target.stroke;
            delete target.strokeWidth;
          } else {
            target.strokeWidth = command.strokeWidth;
            if (!target.stroke) target.stroke = "#000000";
          }
        }
        if (typeof command.opacity === "number") {
          target.opacity = command.opacity;
        }
        if (typeof command.rotation === "number") {
          target.rotation = command.rotation;
        }
        if (typeof command.radius === "number") {
          if (command.radius > 0) target.radius = command.radius;
          else delete target.radius;
        }
        if (typeof command.text === "string" && target.kind === "text") {
          target.text = command.text;
        }
        if (typeof command.fillVariable === "string") {
          if (command.fillVariable) target.fillVariable = command.fillVariable;
          else delete target.fillVariable;
        }
        revision++;
        return snapshot();
      }
      if (command.type === "updateVariable" || command.type === "UpdateVariable") {
        if (!command.id || typeof command.id !== "string") {
          throw new Error("variable id must be a non-empty string");
        }
        pushHistory();
        const mode = currentActiveMode();
        if (mode) {
          modeValues[mode] = { ...(modeValues[mode] ?? {}), [command.id]: String(command.value) };
        } else {
          variables[command.id] = String(command.value);
        }
        variablesTouched = true;
        revision++;
        return snapshot();
      }
      if (command.type === "setVariableMode" || command.type === "SetVariableMode") {
        if (!command.collectionId || typeof command.collectionId !== "string") {
          throw new Error("collectionId must be a non-empty string");
        }
        pushHistory();
        if (command.modeId) {
          activeModes[command.collectionId] = command.modeId;
        } else {
          delete activeModes[command.collectionId];
        }
        variablesTouched = true;
        revision++;
        return snapshot();
      }
      if (
        command.type === "updateComponentProperty" ||
        command.type === "UpdateComponentProperty"
      ) {
        if (!command.instanceId || !command.propertyName) {
          throw new Error("instanceId and propertyName must be non-empty strings");
        }
        pushHistory();
        const instId = command.instanceId;
        const propName = command.propertyName;
        const val = String(command.value);
        componentOverrides[instId] = {
          ...(componentOverrides[instId] ?? {}),
          [propName]: val,
        };
        const inst = nodes.find((n) => n.id === instId);
        if (inst) {
          inst.componentProperties = {
            ...(inst.componentProperties ?? {}),
            [propName]: val,
          };
          const children = nodes.filter((n) => n.parentId === instId);
          if (val === "true" || val === "false") {
            const visible = val === "true";
            const child = children[0];
            if (child) {
              if (!visible) child.visible = false;
              else delete child.visible;
            }
          } else {
            const textChild = children.find((c) => c.kind === "text");
            if (textChild) textChild.text = val;
          }
        }
        componentsTouched = true;
        revision++;
        return snapshot();
      }
      if (command.type === "outlineStroke" || command.type === "OutlineStroke") {
        const target = nodes.find((n) => n.id === command.id);
        if (!target || !target.strokeWidth || target.strokeWidth <= 0) {
          throw new Error(`node cannot be outlined: ${command.id}`);
        }
        pushHistory();
        const sw = target.strokeWidth;
        const strokeColor = target.stroke ?? "#000000";
        target.kind = "path";
        target.fill = strokeColor;
        delete target.stroke;
        delete target.strokeWidth;
        target.x -= sw / 2;
        target.y -= sw / 2;
        target.w += sw;
        target.h += sw;
        target.pathCommands = [
          { op: "M", x: 0, y: 0 },
          { op: "L", x: target.w, y: 0 },
          { op: "L", x: target.w, y: target.h },
          { op: "L", x: 0, y: target.h },
          { op: "Z" },
        ];
        revision++;
        return snapshot();
      }
      if (command.type === "offsetPath" || command.type === "OffsetPath") {
        const target = nodes.find((n) => n.id === command.id);
        if (!target) {
          throw new Error(`node not found: ${command.id}`);
        }
        pushHistory();
        const d = command.distance;
        target.kind = "path";
        target.x -= d;
        target.y -= d;
        target.w = Math.max(1, target.w + d * 2);
        target.h = Math.max(1, target.h + d * 2);
        target.pathCommands = [
          { op: "M", x: 0, y: 0 },
          { op: "L", x: target.w, y: 0 },
          { op: "L", x: target.w, y: target.h },
          { op: "L", x: 0, y: target.h },
          { op: "Z" },
        ];
        revision++;
        return snapshot();
      }
      if (command.type === "duplicateNode" || command.type === "DuplicateNode") {
        const target = nodes.find((n) => n.id === command.id);
        if (!target) {
          throw new Error(`node not found: ${command.id}`);
        }
        pushHistory();
        const prefix =
          target.kind === "frame"
            ? "wasm-poc-frame"
            : target.kind === "text"
              ? "wasm-poc-text"
              : target.kind === "ellipse"
                ? "wasm-poc-ellipse"
                : target.kind === "boolean"
                  ? "wasm-poc-bool"
                  : target.kind === "path"
                    ? "wasm-poc-path"
                    : "wasm-poc-rect";
        const dupId = `${prefix}-${nextId}`;
        nextId++;
        const dx = command.dx ?? 16;
        const dy = command.dy ?? 16;
        nodes.push({
          ...target,
          id: dupId,
          name: `${target.name} copy`,
          x: target.x + dx,
          y: target.y + dy,
          ...(target.pathCommands
            ? { pathCommands: target.pathCommands.map((c) => ({ ...c })) }
            : {}),
          ...(target.autoLayout ? { autoLayout: { ...target.autoLayout } } : {}),
        });
        revision++;
        return snapshot();
      }
      if (command.type === "undo" || command.type === "Undo") {
        if (!undoStack.length) {
          return snapshot();
        }
        redoStack.push(captureHistoryState());
        restoreHistoryState(undoStack.pop());
        revision++;
        return snapshot();
      }
      if (command.type === "redo" || command.type === "Redo") {
        if (!redoStack.length) {
          return snapshot();
        }
        undoStack.push(captureHistoryState());
        restoreHistoryState(redoStack.pop());
        revision++;
        return snapshot();
      }
      throw new Error("Unsupported command");
    },
  };
  return { glue, commands, renderCalls };
}

try {
  __enableBridgeAuditForTests(true);
  __resetWasmForTests();
  const fixture = moduleWithPoc();
  assert.equal(await initWasmBridge(async () => fixture.glue), true);

  const wasmEngine = await WasmEngine.initialize();
  assert.deepEqual(wasmEngine.snapshot(), {
    revision: 0,
    canUndo: false,
    nodes: [],
  });

  const state = wasmEngine.createRectangle(100, 100);
  assert.deepEqual(fixture.commands, [
    { type: "createNode", nodeType: "rect", x: 100, y: 100 },
  ]);
  assert.deepEqual(state, {
    revision: 1,
    canUndo: true,
    nodes: [
      {
        id: "wasm-poc-rect-1",
        name: "Rectangle 1",
        kind: "rect",
        x: 100,
        y: 100,
        w: 100,
        h: 80,
        rotation: 0,
        opacity: 1,
        fill: "#000000",
      },
    ],
  });

  const frameState = await wasmEngine.createNode("frame", 200, 150, 320, 240);
  assert.equal(frameState.revision, 2);
  assert.deepEqual(frameState.nodes[1], {
    id: "wasm-poc-frame-2",
    name: "Frame 2",
    kind: "frame",
    x: 200,
    y: 150,
    w: 320,
    h: 240,
    rotation: 0,
    opacity: 1,
  });

  const movedState = await wasmEngine.moveNode("wasm-poc-rect-1", 45, -20);
  assert.equal(movedState.revision, 3);
  assert.deepEqual(movedState.nodes[0], {
    id: "wasm-poc-rect-1",
    name: "Rectangle 1",
    kind: "rect",
    x: 145,
    y: 80,
    w: 100,
    h: 80,
    rotation: 0,
    opacity: 1,
    fill: "#000000",
  });

  const resizedState = await wasmEngine.resizeNode("wasm-poc-rect-1", 150, 85, 220, 130);
  assert.equal(resizedState.revision, 4);
  assert.equal(resizedState.nodes[0].x, 150);
  assert.equal(resizedState.nodes[0].y, 85);
  assert.equal(resizedState.nodes[0].w, 220);
  assert.equal(resizedState.nodes[0].h, 130);

  const undoneResize = await wasmEngine.undo();
  assert.equal(undoneResize.revision, 5);
  assert.equal(undoneResize.nodes[0].x, 145);
  assert.equal(undoneResize.nodes[0].y, 80);
  assert.equal(undoneResize.nodes[0].w, 100);
  assert.equal(undoneResize.nodes[0].h, 80);

  const redoneResize = await wasmEngine.redo();
  assert.equal(redoneResize.revision, 6);
  assert.equal(redoneResize.nodes[0].w, 220);
  assert.equal(redoneResize.nodes[0].h, 130);

  const deletedState = await wasmEngine.deleteNode("wasm-poc-rect-1");
  assert.equal(deletedState.revision, 7);
  assert.equal(deletedState.nodes.length, 1);
  assert.equal(deletedState.nodes[0].id, "wasm-poc-frame-2");

  const restoredState = await wasmEngine.undo();
  assert.equal(restoredState.revision, 8);
  assert.equal(restoredState.nodes.length, 2);
  assert.equal(restoredState.nodes[0].id, "wasm-poc-rect-1");

  const textState = await wasmEngine.createNode("text", 40, 50, 140, 24, undefined, "Hello WASM");
  assert.equal(textState.revision, 9);
  assert.deepEqual(textState.nodes[2], {
    id: "wasm-poc-text-3",
    name: "Text 3",
    kind: "text",
    x: 40,
    y: 50,
    w: 140,
    h: 24,
    rotation: 0,
    opacity: 1,
    fill: "#000000",
    text: "Hello WASM",
  });

  const ellipseState = await wasmEngine.createNode("ellipse", 220, 90, 80, 80);
  assert.equal(ellipseState.revision, 10);
  assert.deepEqual(ellipseState.nodes[3], {
    id: "wasm-poc-ellipse-4",
    name: "Ellipse 4",
    kind: "ellipse",
    x: 220,
    y: 90,
    w: 80,
    h: 80,
    rotation: 0,
    opacity: 1,
    fill: "#000000",
  });

  assert.equal(wasmEngine.isReady(), true);
  assert.equal(WasmEngine.isReady(), true);
  const firstRender = wasmEngine.renderFrame("x-native-canvas", {
    ...ellipseState,
    devicePixelRatio: 2,
    viewportWidth: 800,
    viewportHeight: 600,
  });
  assert.equal(firstRender.skippedUnchanged, false);
  assert.equal(firstRender.drawCalls, 4);
  assert.equal(firstRender.pixelWidth, 1600);
  assert.equal(firstRender.pixelHeight, 1200);
  assert.equal(firstRender.devicePixelRatio, 2);

  const cachedRender = wasmEngine.renderFrame("x-native-canvas", {
    ...ellipseState,
    devicePixelRatio: 2,
    viewportWidth: 800,
    viewportHeight: 600,
  });
  assert.equal(cachedRender.skippedUnchanged, true);
  assert.equal(cachedRender.drawCalls, 0);

  assert.throws(() => wasmEngine.createRectangle(Number.NaN, 20), /finite/);
  await assert.rejects(() => wasmEngine.createNode("rect", 10, 20, -5, 40), /positive finite/);
  await assert.rejects(() => wasmEngine.createNode("polygon", 10, 20, 50, 40), /Unsupported WASM node type/);
  await assert.rejects(() => wasmEngine.moveNode("", 10, 20), /non-empty/);
  await assert.rejects(() => wasmEngine.moveNode("wasm-poc-rect-1", Number.NaN, 0), /finite/);
  await assert.rejects(() => wasmEngine.resizeNode("", 10, 20, 100, 80), /non-empty/);
  await assert.rejects(() => wasmEngine.resizeNode("wasm-poc-rect-1", 10, 20, 0, 80), /positive finite/);
  await assert.rejects(() => wasmEngine.deleteNode(""), /non-empty/);
  await assert.rejects(() => wasmEngine.deleteNode("wasm-poc-page"), /root node/);
  assert.throws(() => decodeDocumentState({ revision: 1, canUndo: "yes", nodes: [] }), /canUndo/);
  assert.throws(
    () =>
      decodeDocumentState({
        revision: 1,
        canUndo: true,
        nodes: [{ id: "n1", name: "R", kind: "rect", x: 0, y: 0, w: 10, h: 10, rotation: Number.NaN }],
      }),
    /rotation/,
  );
  assert.throws(
    () =>
      decodeDocumentState({
        revision: 1,
        canUndo: true,
        nodes: [{ id: "n1", name: "T", kind: "text", x: 0, y: 0, w: 10, h: 10, text: 42 }],
      }),
    /text/,
  );

  const audit = bridgeAuditSnapshot();
  assert.equal(audit.functions["x-wasm.init_wasm_engine"]?.calls, 1);
  assert.equal(audit.functions["x-wasm.dispatch_command"]?.calls, 11);
  assert.equal(audit.functions["x-wasm.render_frame"]?.calls, 2);

  // Phase 2 real-editor Canvas integration test: createNode + moveNode + fallback
  {
    __resetWasmForTests();
    const canvasFixture = moduleWithPoc();
    assert.equal(await initWasmBridge(async () => canvasFixture.glue), true);
    await WasmEngine.initialize();

    const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const keys = [
      "window",
      "document",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "SVGElement",
      "HTMLCanvasElement",
      "MouseEvent",
      "KeyboardEvent",
      "Event",
      "Node",
      "Element",
      "localStorage",
      "getComputedStyle",
      "ResizeObserver",
      "DOMMatrix",
    ];
    const saved = {};
    dom.window.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    dom.window.matchMedia = () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    });
    for (const k of keys) {
      saved[k] = globalThis[k];
      if (dom.window[k]) globalThis[k] = dom.window[k];
    }
    globalThis.matchMedia = dom.window.matchMedia;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    dom.window.HTMLCanvasElement.prototype.getContext = () =>
      new Proxy(
        {
          canvas: { width: 1200, height: 800 },
          measureText: (t) => ({ width: String(t).length * 7 }),
          getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
          createConicGradient: () => ({ addColorStop() {} }),
          createPattern: () => ({}),
          getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        },
        { get: (t, p) => (p in t ? t[p] : () => {}) },
      );

    const { createRoot } = await import("react-dom/client");
    const { Canvas } = await import("../../ui/Canvas.tsx");
    const { ThemeProvider } = await import("../../ui/theme.tsx");
    const engine = new MemoryEngine(false);
    engine.snapshot().pages[0].root.children.length = 0;
    engine.dispatch({ type: "setPan", x: 0, y: 0 });
    engine.dispatch({ type: "setZoom", zoom: 1 });

    function Host() {
      const snap = useSyncExternalStore(
        (fn) => engine.subscribe(fn),
        () => engine.snapshot(),
      );
      return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap }));
    }

    const host = dom.window.document.getElementById("root");
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(Host));
      });
      await React.act(async () => {
        engine.dispatch({ type: "setPan", x: 0, y: 0 });
        engine.dispatch({ type: "setZoom", zoom: 1 });
      });
      const wrap = host.querySelector(".canvas-wrap");
      const cvs = host.querySelector("canvas");
      const rectFn = () => ({
        left: 0,
        top: 0,
        width: 1200,
        height: 800,
        right: 1200,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON() {},
      });
      wrap.getBoundingClientRect = rectFn;
      cvs.getBoundingClientRect = rectFn;

      const mouse = async (type, wx, wy) => {
        const s = engine.snapshot();
        const clientX = wx * s.zoom + s.panX;
        const clientY = wy * s.zoom + s.panY;
        await React.act(async () => {
          wrap.dispatchEvent(
            new dom.window.MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX,
              clientY,
              button: 0,
              buttons: type === "mouseup" ? 0 : 1,
            }),
          );
          await Promise.resolve();
          await Promise.resolve();
        });
      };

      // 1. Draw a rectangle on the canvas -> routed through WasmEngine.createNode
      await React.act(async () => {
        engine.dispatch({ type: "setTool", tool: "rect" });
      });
      await mouse("mousedown", 100, 120);
      await mouse("mousemove", 240, 210);
      await mouse("mouseup", 240, 210);

      const createdNode = find(engine.snapshot().pages[0].root, "wasm-poc-rect-1");
      assert.ok(createdNode, "Rust-created rectangle synchronized into editor state");
      assert.equal(createdNode.kind, "rect");
      assert.equal(createdNode.x, 100);
      assert.equal(createdNode.y, 120);
      assert.equal(createdNode.w, 140);
      assert.equal(createdNode.h, 90);
      const badge = host.querySelector('[data-testid="wasm-powered-badge"]');
      assert.ok(badge, "WASM badge rendered in UI");
      assert.match(badge.textContent ?? "", /Rendered by WASM/);
      assert.match(badge.textContent ?? "", /Powered by WASM/);
      assert.match(badge.textContent ?? "", /rev 1/);
      assert.ok(
        canvasFixture.renderCalls.some((c) => c.canvasId === "x-native-canvas"),
        "Canvas useEffect delegated rendering to wasmEngine.renderFrame",
      );

      // 2. Drag the created rectangle -> routed through WasmEngine.moveNode
      await mouse("mousedown", 150, 150);
      await mouse("mousemove", 200, 185);
      await mouse("mouseup", 200, 185);

      const movedNode = find(engine.snapshot().pages[0].root, "wasm-poc-rect-1");
      assert.ok(movedNode);
      assert.equal(movedNode.x, 150);
      assert.equal(movedNode.y, 155);
      assert.match(badge.textContent ?? "", /rev 2/);
      assert.deepEqual(canvasFixture.commands, [
        { type: "createNode", nodeType: "rect", x: 100, y: 120, width: 140, height: 90 },
        { type: "moveNode", id: "wasm-poc-rect-1", dx: 50, dy: 35 },
      ]);

      // 3. Draw a frame on the canvas -> routed through WasmEngine.createNode("frame", ...)
      await React.act(async () => {
        engine.dispatch({ type: "setTool", tool: "frame" });
      });
      await mouse("mousedown", 320, 100);
      await mouse("mousemove", 520, 260);
      await mouse("mouseup", 520, 260);

      const createdFrame = find(engine.snapshot().pages[0].root, "wasm-poc-frame-2");
      assert.ok(createdFrame, "Rust-created frame synchronized into editor state");
      assert.equal(createdFrame.kind, "frame");
      assert.equal(createdFrame.x, 320);
      assert.equal(createdFrame.y, 100);
      assert.equal(createdFrame.w, 200);
      assert.equal(createdFrame.h, 160);
      assert.match(badge.textContent ?? "", /rev 3/);

      // 4. Draw a rectangle inside the frame -> parent_id is set to wasm-poc-frame-2
      await React.act(async () => {
        engine.dispatch({ type: "setTool", tool: "rect" });
      });
      await mouse("mousedown", 350, 130);
      await mouse("mousemove", 430, 190);
      await mouse("mouseup", 430, 190);

      const nestedRect = find(engine.snapshot().pages[0].root, "wasm-poc-rect-3");
      assert.ok(nestedRect, "Nested rectangle created inside frame");
      const frameNow = find(engine.snapshot().pages[0].root, "wasm-poc-frame-2");
      assert.ok(
        frameNow.children.some((c) => c.id === "wasm-poc-rect-3"),
        "Rectangle is a child of Frame 2 in MemoryEngine tree",
      );
      assert.equal(
        WasmEngine.getActive().snapshot().nodes.find((n) => n.id === "wasm-poc-rect-3")?.parentId,
        "wasm-poc-frame-2",
        "WASM NodeSnapshot has parentId set to wasm-poc-frame-2",
      );

      // 5. Resize wasm-poc-rect-1 using its bottom-right corner handle (150 + 140 = 290, 155 + 90 = 245)
      await React.act(async () => {
        engine.dispatch({ type: "select", ids: ["wasm-poc-rect-1"] });
      });
      await mouse("mousedown", 290, 245);
      await mouse("mousemove", 310, 265);
      await mouse("mouseup", 310, 265);

      const resizedNode = find(engine.snapshot().pages[0].root, "wasm-poc-rect-1");
      assert.equal(resizedNode.w, 160);
      assert.equal(resizedNode.h, 105);
      assert.ok(
        canvasFixture.commands.some(
          (c) => c.type === "resizeNode" && c.id === "wasm-poc-rect-1" && c.width === 160 && c.height === 105,
        ),
        "Resize handle drag dispatched resizeNode to WasmEngine",
      );

      // 6. Press Delete key with wasm-poc-rect-3 selected -> routed through WasmEngine.deleteNode
      await React.act(async () => {
        engine.dispatch({ type: "select", ids: ["wasm-poc-rect-3"] });
      });
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Delete",
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-3"),
        null,
        "Deleted rectangle removed from editor tree via WasmEngine.deleteNode",
      );

      // 7. Press ⌘Z (Undo) -> routed through WasmEngine.undo, restoring wasm-poc-rect-3 inside wasm-poc-frame-2
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const restoredNested = find(engine.snapshot().pages[0].root, "wasm-poc-rect-3");
      assert.ok(restoredNested, "⌘Z restored deleted rectangle via WasmEngine.undo");
      assert.ok(
        find(engine.snapshot().pages[0].root, "wasm-poc-frame-2").children.some(
          (c) => c.id === "wasm-poc-rect-3",
        ),
        "Restored rectangle re-attached to its parent frame",
      );

      // 8. Press ⇧⌘Z (Redo) -> routed through WasmEngine.redo, removing wasm-poc-rect-3 again
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-3"),
        null,
        "⇧⌘Z redid deletion via WasmEngine.redo",
      );

      // 8b. Draw an Ellipse on Canvas -> routed through WasmEngine.createNode("ellipse", ...)
      await React.act(async () => {
        engine.dispatch({ type: "setTool", tool: "ellipse" });
      });
      await mouse("mousedown", 560, 120);
      await mouse("mousemove", 640, 200);
      await mouse("mouseup", 640, 200);
      const createdEllipse = find(engine.snapshot().pages[0].root, "wasm-poc-ellipse-4");
      assert.ok(createdEllipse, "Canvas created wasm-poc-ellipse-4 via WasmEngine.createNode");
      assert.equal(createdEllipse.kind, "ellipse");
      assert.equal(createdEllipse.w, 80);
      assert.equal(createdEllipse.h, 80);
      assert.match(badge.textContent ?? "", /createNode\(ellipse\)/);

      // 8c. Select wasm-poc-frame-2 and press ⇧A -> routed through WasmEngine.applyAutoLayout
      await React.act(async () => {
        engine.dispatch({ type: "setTool", tool: "select" });
        engine.dispatch({ type: "select", ids: ["wasm-poc-frame-2"] });
      });
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "A",
            code: "KeyA",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const laidOutFrame = find(engine.snapshot().pages[0].root, "wasm-poc-frame-2");
      assert.ok(laidOutFrame?.layout, "⇧A applied auto-layout via WasmEngine.applyAutoLayout");
      assert.equal(laidOutFrame.layout.direction, "horizontal");
      assert.deepEqual(laidOutFrame.layout.padding, [16, 16, 16, 16]);
      assert.equal(laidOutFrame.layout.gap, 12);
      assert.match(badge.textContent ?? "", /applyAutoLayout\(wasm-poc-frame-2\)/);

      // 8d. Select two WASM shapes (wasm-poc-rect-1 and wasm-poc-ellipse-4) and press ⌥⇧U -> routed through WasmEngine.booleanOperation
      await React.act(async () => {
        engine.dispatch({
          type: "select",
          ids: ["wasm-poc-rect-1", "wasm-poc-ellipse-4"],
        });
      });
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "U",
            code: "KeyU",
            altKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-1"),
        null,
        "Original rect removed after WASM boolean union",
      );
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-ellipse-4"),
        null,
        "Original ellipse removed after WASM boolean union",
      );
      const boolNode = find(engine.snapshot().pages[0].root, "wasm-poc-bool-5");
      assert.ok(boolNode, "Boolean result node created via WasmEngine.booleanOperation");
      assert.equal(boolNode.kind, "boolean");
      assert.equal(boolNode.booleanOp, "union");
      assert.ok(
        boolNode.path.some((pt) => typeof pt.ix === "number" || typeof pt.ox === "number"),
        "Boolean result path preserves smooth cubic bezier handles",
      );
      assert.ok(
        boolNode.vectorNetwork?.segments?.some((s) => s.tangentStart || s.tangentEnd),
        "Boolean result vectorNetwork preserves cubic bezier segment tangents",
      );
      assert.match(badge.textContent ?? "", /booleanOperation\(union\)/);

      // Undo the boolean union via ⌘Z -> restores wasm-poc-rect-1 and wasm-poc-ellipse-4
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "z",
            code: "KeyZ",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.ok(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-1"),
        "⌘Z restored wasm-poc-rect-1 after boolean union undo",
      );
      assert.ok(
        find(engine.snapshot().pages[0].root, "wasm-poc-ellipse-4"),
        "⌘Z restored wasm-poc-ellipse-4 after boolean union undo",
      );

      // 8e. UpdateNode + DuplicateNode (⌘D) + OutlineStroke (⇧⌘O) + OffsetPath on Canvas
      const activeWasm = await WasmEngine.getOrCreate();
      const updatedRectState = await activeWasm.updateNode("wasm-poc-rect-1", {
        name: "Styled Rect",
        fill: "#2563eb",
        stroke: "#ef4444",
        strokeWidth: 6,
        opacity: 0.9,
        rotation: 12,
        radius: 10,
      });
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: updatedRectState,
          selectId: "wasm-poc-rect-1",
        });
      });
      const styledRect = find(engine.snapshot().pages[0].root, "wasm-poc-rect-1");
      assert.equal(styledRect.name, "Styled Rect");
      assert.equal(styledRect.fill, "#2563eb");
      assert.equal(styledRect.strokePaint, "#ef4444");
      assert.equal(styledRect.strokeWidth, 6);
      assert.equal(styledRect.opacity, 0.9);
      assert.equal(styledRect.rotation, 12);
      assert.deepEqual(styledRect.cornerRadii, [10, 10, 10, 10]);

      // Press ⌘D on Canvas -> routed through WasmEngine.duplicateNode
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "d",
            code: "KeyD",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const dupRect = find(engine.snapshot().pages[0].root, "wasm-poc-rect-6");
      assert.ok(dupRect, "⌘D duplicated wasm-poc-rect-1 to wasm-poc-rect-6 via WasmEngine");
      assert.equal(dupRect.name, "Styled Rect copy");
      assert.match(badge.textContent ?? "", /duplicateNode\(wasm-poc-rect-1\)/);

      // Select wasm-poc-rect-6 and press ⇧⌘O -> routed through WasmEngine.outlineStroke
      await React.act(async () => {
        engine.dispatch({ type: "select", ids: ["wasm-poc-rect-6"] });
      });
      await React.act(async () => {
        dom.window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "O",
            code: "KeyO",
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      const outlinedNode = find(engine.snapshot().pages[0].root, "wasm-poc-rect-6");
      const outlinedW = outlinedNode.w;
      assert.equal(outlinedNode.kind, "vector");
      assert.equal(outlinedNode.fill, "#ef4444");
      assert.equal(outlinedNode.strokeWidth, 0);
      assert.match(badge.textContent ?? "", /outlineStroke\(wasm-poc-rect-6\)/);

      // OffsetPath on wasm-poc-rect-6 via WasmEngine.offsetPath
      const offsetState = await activeWasm.offsetPath("wasm-poc-rect-6", 8, "round");
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: offsetState,
          selectId: "wasm-poc-rect-6",
        });
      });
      const offsetNode = find(engine.snapshot().pages[0].root, "wasm-poc-rect-6");
      assert.equal(offsetNode.kind, "vector");
      assert.ok(offsetNode.w > outlinedW);

      // 8f. Click with Text tool on Canvas -> routed through WasmEngine.createNode("text", ...)
      await React.act(async () => {
        engine.dispatch({ type: "setTool", tool: "text" });
      });
      await mouse("mousedown", 700, 140);
      await mouse("mouseup", 700, 140);
      const createdText = find(engine.snapshot().pages[0].root, "wasm-poc-text-7");
      assert.ok(createdText, "Canvas created wasm-poc-text-7 via WasmEngine.createNode");
      assert.equal(createdText.kind, "text");
      assert.match(badge.textContent ?? "", /createNode\(text\)/);

      // 9. Reparenting via syncWasmState: moving wasm-poc-rect-1 into wasm-poc-frame-2
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: {
            revision: 99,
            canUndo: true,
            nodes: [
              {
                id: "wasm-poc-frame-2",
                name: "Frame 2",
                kind: "frame",
                x: 320,
                y: 100,
                w: 200,
                h: 160,
                parentId: null,
                rotation: 0,
                opacity: 1,
              },
              {
                id: "wasm-poc-rect-1",
                name: "Rectangle 1",
                kind: "rect",
                x: 12,
                y: 16,
                w: 80,
                h: 50,
                parentId: "wasm-poc-frame-2",
                rotation: 15,
                opacity: 0.75,
                fill: "#112233",
              },
            ],
          },
        });
      });
      const reparentedFrame = find(engine.snapshot().pages[0].root, "wasm-poc-frame-2");
      const reparentedRect = find(engine.snapshot().pages[0].root, "wasm-poc-rect-1");
      assert.ok(
        reparentedFrame.children.some((c) => c.id === "wasm-poc-rect-1"),
        "syncWasmState reparented wasm-poc-rect-1 into wasm-poc-frame-2",
      );
      assert.equal(reparentedRect.rotation, 15);
      assert.equal(reparentedRect.opacity, 0.75);
      assert.equal(reparentedRect.fill, "#112233");

      // 9b. Phase 8: Variables (updateVariable, setVariableMode) and Component Properties (updateComponentProperty)
      // Parent wasm-poc-rect-1 inside wasm-poc-frame-2 in activeWasm as well
      await activeWasm.moveNode("wasm-poc-rect-1", 0, 0, "wasm-poc-frame-2");
      // Bind wasm-poc-rect-1 to variable "var-1" and update "var-1" to "#ef4444"
      await React.act(async () => {
        engine.dispatch({
          type: "bindVariable",
          id: "wasm-poc-rect-1",
          prop: "fill",
          variableId: "var-1",
        });
      });
      await activeWasm.updateNode("wasm-poc-rect-1", {
        fillVariable: "var-1",
        fill: "#0d99ff",
      });
      const varUpdatedState = await activeWasm.updateVariable("var-1", "#ef4444");
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: varUpdatedState,
        });
      });
      assert.equal(
        engine.snapshot().variables.find((v) => v.id === "var-1")?.value,
        "#ef4444",
        "syncWasmState updated var-1 value in TS state",
      );
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-1")?.fill,
        "#ef4444",
        "syncWasmState updated bound node fill when var-1 changed",
      );

      // Add a second mode to Brand collection, switch active mode via setVariableMode, and update var-1 in Dark mode
      const brandCol = engine.snapshot().variableCollections.find((c) => c.name === "Brand");
      assert.ok(brandCol, "Brand collection exists");
      await React.act(async () => {
        engine.dispatch({
          type: "addMode",
          collectionId: brandCol.id,
          name: "Dark",
        });
      });
      const darkModeId = engine
        .snapshot()
        .variableCollections.find((c) => c.id === brandCol.id)
        ?.modes.find((m) => m.name === "Dark")?.id;
      assert.ok(darkModeId, "Dark mode created");
      const modeSwitchedState = await activeWasm.setVariableMode(brandCol.id, darkModeId);
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: modeSwitchedState,
        });
      });
      assert.equal(
        engine.snapshot().activeModes[brandCol.id],
        darkModeId,
        "syncWasmState updated activeModes for Brand collection",
      );
      const darkVarState = await activeWasm.updateVariable("var-1", "#10b981");
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: darkVarState,
        });
      });
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-1")?.fill,
        "#10b981",
        "syncWasmState resolved Dark mode variable value onto bound node",
      );

      // Undo Dark mode variable update via WasmEngine.undo()
      const undoDarkVarState = await activeWasm.undo();
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: undoDarkVarState,
        });
      });
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-1")?.fill,
        "#ef4444",
        "WasmEngine.undo() reverted Dark mode variable value",
      );

      // Component Property update (boolean toggle on wasm-poc-frame-2 hiding child wasm-poc-rect-1)
      const compPropState = await activeWasm.updateComponentProperty(
        "wasm-poc-frame-2",
        "Show Icon",
        "false",
      );
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: compPropState,
        });
      });
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-frame-2")?.componentProperties?.[
          "Show Icon"
        ],
        false,
        "syncWasmState applied boolean component property on instance",
      );
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-1")?.visible,
        false,
        "syncWasmState toggled child visibility from boolean component property",
      );

      // Undo component property toggle via WasmEngine.undo()
      const undoCompPropState = await activeWasm.undo();
      await React.act(async () => {
        engine.dispatch({
          type: "syncWasmState",
          state: undoCompPropState,
        });
      });
      assert.equal(
        find(engine.snapshot().pages[0].root, "wasm-poc-rect-1")?.visible,
        true,
        "WasmEngine.undo() restored child visibility after component property undo",
      );

      // 10. When WASM is unavailable, drawing a rectangle falls back to MemoryEngine
      __resetWasmForTests();
      const countBeforeFallback = engine.snapshot().pages[0].root.children.length;
      await React.act(async () => {
        engine.dispatch({ type: "setTool", tool: "rect" });
      });
      await mouse("mousedown", 10, 10);
      await mouse("mousemove", 70, 50);
      await mouse("mouseup", 70, 50);
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.equal(
        engine.snapshot().pages[0].root.children.length,
        countBeforeFallback + 1,
        "Graceful fallback to MemoryEngine when WASM is unavailable",
      );
    } finally {
      await React.act(async () => root.unmount());
      dom.window.close();
      for (const k of keys) {
        if (saved[k] === undefined) delete globalThis[k];
        else globalThis[k] = saved[k];
      }
    }
  }

  console.log("WasmEngine: initialization, createNode, moveNode, and Canvas synchronization passed");
} finally {
  __resetWasmForTests();
  __enableBridgeAuditForTests(false);
}
