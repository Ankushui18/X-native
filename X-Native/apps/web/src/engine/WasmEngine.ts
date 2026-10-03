import { auditRustCall } from "./bridgeRuntimeAudit";
import {
  getEngineInfo,
  initWasmBridge,
  wasmPocExports,
  type WasmAutoLayoutAxis,
  type WasmBooleanOperationType,
  type WasmOffsetJoin,
  type WasmPocCommand,
  type WasmPocExports,
  type WasmPocNodeType,
  type WasmUpdateNodePatch,
} from "./wasmBridge";

export type WasmNodeKind = WasmPocNodeType | "text" | "ellipse" | "boolean" | "path";

export type WasmPathCmd =
  | { readonly op: "M"; readonly x: number; readonly y: number }
  | { readonly op: "L"; readonly x: number; readonly y: number }
  | {
      readonly op: "C";
      readonly c1x: number;
      readonly c1y: number;
      readonly c2x: number;
      readonly c2y: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly op: "Z" };

export interface WasmAutoLayoutSnapshot {
  readonly axis: WasmAutoLayoutAxis;
  readonly padding: number;
  readonly gap: number;
}

export interface WasmNodeSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: WasmNodeKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly parentId?: string | null;
  readonly parent_id?: string | null;
  readonly rotation?: number;
  readonly opacity?: number;
  readonly fill?: string | null;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly text?: string;
  readonly radius?: number;
  readonly visible?: boolean;
  readonly componentProperties?: Readonly<Record<string, string>>;
  readonly pathCommands?: readonly WasmPathCmd[];
  readonly booleanOp?: WasmBooleanOperationType;
  readonly autoLayout?: WasmAutoLayoutSnapshot;
}

export interface DocumentState {
  readonly revision: number;
  readonly canUndo: boolean;
  readonly nodes: readonly WasmNodeSnapshot[];
  readonly variables?: Readonly<Record<string, string>>;
  readonly activeModes?: Readonly<Record<string, string>>;
  readonly componentOverrides?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly devicePixelRatio?: number;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly panX?: number;
  readonly panY?: number;
  readonly zoom?: number;
}

export interface RenderFrameStats {
  readonly revision: number;
  readonly nodeCount: number;
  readonly commandCount: number;
  readonly drawCalls: number;
  readonly devicePixelRatio: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly skippedUnchanged: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid Rust WASM DocumentState.${field}`);
  }
  return value;
}

function decodeStringRecord(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const out: Record<string, string> = {};
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      if (typeof k === "string" && typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  }
  if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  }
  return undefined;
}

function decodeNestedStringRecord(
  raw: unknown,
): Record<string, Record<string, string>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const out: Record<string, Record<string, string>> = {};
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      if (typeof k === "string") {
        const inner = decodeStringRecord(v);
        if (inner) out[k] = inner;
      }
    }
    return out;
  }
  if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const inner = decodeStringRecord(v);
      if (inner) out[k] = inner;
    }
    return out;
  }
  return undefined;
}

function cloneState(state: DocumentState): DocumentState {
  return {
    revision: state.revision,
    canUndo: state.canUndo,
    nodes: state.nodes.map((node) => ({
      ...node,
      ...(node.componentProperties
        ? { componentProperties: { ...node.componentProperties } }
        : {}),
      ...(node.pathCommands ? { pathCommands: node.pathCommands.map((c) => ({ ...c })) } : {}),
      ...(node.autoLayout ? { autoLayout: { ...node.autoLayout } } : {}),
    })),
    ...(state.variables ? { variables: { ...state.variables } } : {}),
    ...(state.activeModes ? { activeModes: { ...state.activeModes } } : {}),
    ...(state.componentOverrides
      ? {
          componentOverrides: Object.fromEntries(
            Object.entries(state.componentOverrides).map(([k, v]) => [k, { ...v }]),
          ),
        }
      : {}),
    ...(state.devicePixelRatio !== undefined ? { devicePixelRatio: state.devicePixelRatio } : {}),
    ...(state.viewportWidth !== undefined ? { viewportWidth: state.viewportWidth } : {}),
    ...(state.viewportHeight !== undefined ? { viewportHeight: state.viewportHeight } : {}),
    ...(state.panX !== undefined ? { panX: state.panX } : {}),
    ...(state.panY !== undefined ? { panY: state.panY } : {}),
    ...(state.zoom !== undefined ? { zoom: state.zoom } : {}),
  };
}

function decodePathCmd(raw: unknown, nodeIndex: number, cmdIndex: number): WasmPathCmd {
  if (!isObject(raw) || typeof raw.op !== "string") {
    throw new Error(`Invalid Rust WASM nodes[${nodeIndex}].pathCommands[${cmdIndex}]`);
  }
  if (raw.op === "M" || raw.op === "MoveTo") {
    return {
      op: "M",
      x: finiteNumber(raw.x, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].x`),
      y: finiteNumber(raw.y, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].y`),
    };
  }
  if (raw.op === "L" || raw.op === "LineTo") {
    return {
      op: "L",
      x: finiteNumber(raw.x, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].x`),
      y: finiteNumber(raw.y, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].y`),
    };
  }
  if (raw.op === "C" || raw.op === "CurveTo") {
    return {
      op: "C",
      c1x: finiteNumber(raw.c1x, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].c1x`),
      c1y: finiteNumber(raw.c1y, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].c1y`),
      c2x: finiteNumber(raw.c2x, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].c2x`),
      c2y: finiteNumber(raw.c2y, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].c2y`),
      x: finiteNumber(raw.x, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].x`),
      y: finiteNumber(raw.y, `nodes[${nodeIndex}].pathCommands[${cmdIndex}].y`),
    };
  }
  if (raw.op === "Z" || raw.op === "Close") {
    return { op: "Z" };
  }
  throw new Error(`Invalid Rust WASM nodes[${nodeIndex}].pathCommands[${cmdIndex}].op`);
}

function decodeAutoLayout(raw: unknown, nodeIndex: number): WasmAutoLayoutSnapshot {
  if (!isObject(raw)) {
    throw new Error(`Invalid Rust WASM nodes[${nodeIndex}].autoLayout`);
  }
  const axis = raw.axis;
  if (axis !== "horizontal" && axis !== "vertical") {
    throw new Error(`Invalid Rust WASM nodes[${nodeIndex}].autoLayout.axis`);
  }
  const padding = finiteNumber(raw.padding, `nodes[${nodeIndex}].autoLayout.padding`);
  const gap = finiteNumber(raw.gap, `nodes[${nodeIndex}].autoLayout.gap`);
  return { axis, padding, gap };
}

export function decodeDocumentState(raw: unknown): DocumentState {
  if (!isObject(raw)) throw new Error("Rust WASM DocumentState must be an object");
  const revision = finiteNumber(raw.revision, "revision");
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("Invalid Rust WASM DocumentState.revision");
  }
  if (typeof raw.canUndo !== "boolean") {
    throw new Error("Invalid Rust WASM DocumentState.canUndo");
  }
  if (!Array.isArray(raw.nodes)) {
    throw new Error("Invalid Rust WASM DocumentState.nodes");
  }
  const nodes: WasmNodeSnapshot[] = raw.nodes.map((node, index) => {
    if (!isObject(node)) throw new Error(`Invalid Rust WASM node ${index}`);
    if (
      typeof node.id !== "string" || !node.id ||
      typeof node.name !== "string" ||
      (node.kind !== "rect" &&
        node.kind !== "frame" &&
        node.kind !== "text" &&
        node.kind !== "ellipse" &&
        node.kind !== "boolean" &&
        node.kind !== "path")
    ) throw new Error(`Invalid Rust WASM node ${index}`);
    const w = finiteNumber(node.w, `nodes[${index}].w`);
    const h = finiteNumber(node.h, `nodes[${index}].h`);
    if (w <= 0 || h <= 0) throw new Error(`Invalid Rust WASM node ${index} dimensions`);
    const rawParent = node.parentId !== undefined ? node.parentId : node.parent_id;
    if (rawParent !== undefined && rawParent !== null && typeof rawParent !== "string") {
      throw new Error(`Invalid Rust WASM nodes[${index}].parent_id`);
    }
    if (node.rotation !== undefined && (typeof node.rotation !== "number" || !Number.isFinite(node.rotation))) {
      throw new Error(`Invalid Rust WASM nodes[${index}].rotation`);
    }
    if (node.opacity !== undefined && (typeof node.opacity !== "number" || !Number.isFinite(node.opacity))) {
      throw new Error(`Invalid Rust WASM nodes[${index}].opacity`);
    }
    if (node.fill !== undefined && node.fill !== null && typeof node.fill !== "string") {
      throw new Error(`Invalid Rust WASM nodes[${index}].fill`);
    }
    if (node.text !== undefined && node.text !== null && typeof node.text !== "string") {
      throw new Error(`Invalid Rust WASM nodes[${index}].text`);
    }
    const rawPathCommands = node.pathCommands !== undefined ? node.pathCommands : node.path_commands;
    if (rawPathCommands !== undefined && rawPathCommands !== null && !Array.isArray(rawPathCommands)) {
      throw new Error(`Invalid Rust WASM nodes[${index}].pathCommands`);
    }
    const pathCommands = Array.isArray(rawPathCommands)
      ? rawPathCommands.map((cmd, cmdIdx) => decodePathCmd(cmd, index, cmdIdx))
      : undefined;
    const rawBooleanOp = node.booleanOp !== undefined ? node.booleanOp : node.boolean_op;
    if (
      rawBooleanOp !== undefined &&
      rawBooleanOp !== null &&
      rawBooleanOp !== "union" &&
      rawBooleanOp !== "subtract" &&
      rawBooleanOp !== "intersect" &&
      rawBooleanOp !== "exclude"
    ) {
      throw new Error(`Invalid Rust WASM nodes[${index}].booleanOp`);
    }
    const rawAutoLayout = node.autoLayout !== undefined ? node.autoLayout : node.auto_layout;
    const autoLayout =
      rawAutoLayout !== undefined && rawAutoLayout !== null
        ? decodeAutoLayout(rawAutoLayout, index)
        : undefined;
    const rawStrokeWidth = node.strokeWidth !== undefined ? node.strokeWidth : node.stroke_width;
    const rawComponentProps =
      node.componentProperties !== undefined
        ? node.componentProperties
        : node.component_properties;
    const componentProperties = decodeStringRecord(rawComponentProps);
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      x: finiteNumber(node.x, `nodes[${index}].x`),
      y: finiteNumber(node.y, `nodes[${index}].y`),
      w,
      h,
      ...(typeof rawParent === "string" && rawParent
        ? { parentId: rawParent, parent_id: rawParent }
        : rawParent === null
          ? { parentId: null, parent_id: null }
          : {}),
      ...(typeof node.rotation === "number" ? { rotation: node.rotation } : {}),
      ...(typeof node.opacity === "number" ? { opacity: node.opacity } : {}),
      ...(typeof node.fill === "string" ? { fill: node.fill } : node.fill === null ? { fill: null } : {}),
      ...(typeof node.stroke === "string" ? { stroke: node.stroke } : {}),
      ...(typeof rawStrokeWidth === "number" ? { strokeWidth: rawStrokeWidth } : {}),
      ...(typeof node.text === "string" ? { text: node.text } : {}),
      ...(typeof node.radius === "number" ? { radius: node.radius } : {}),
      ...(typeof node.visible === "boolean" ? { visible: node.visible } : {}),
      ...(componentProperties !== undefined ? { componentProperties } : {}),
      ...(pathCommands !== undefined ? { pathCommands } : {}),
      ...(rawBooleanOp !== undefined && rawBooleanOp !== null ? { booleanOp: rawBooleanOp } : {}),
      ...(autoLayout !== undefined ? { autoLayout } : {}),
    };
  });
  const variables = decodeStringRecord(raw.variables);
  const rawActiveModes = raw.activeModes !== undefined ? raw.activeModes : raw.active_modes;
  const activeModes = decodeStringRecord(rawActiveModes);
  const rawComponentOverrides =
    raw.componentOverrides !== undefined ? raw.componentOverrides : raw.component_overrides;
  const componentOverrides = decodeNestedStringRecord(rawComponentOverrides);
  return {
    revision,
    canUndo: raw.canUndo,
    nodes,
    ...(variables !== undefined ? { variables } : {}),
    ...(activeModes !== undefined ? { activeModes } : {}),
    ...(componentOverrides !== undefined ? { componentOverrides } : {}),
  };
}

export function decodeRenderFrameStats(raw: unknown): RenderFrameStats {
  if (!isObject(raw)) throw new Error("Rust WASM RenderFrameStats must be an object");
  return {
    revision: finiteNumber(raw.revision, "revision"),
    nodeCount: finiteNumber(raw.nodeCount, "nodeCount"),
    commandCount: finiteNumber(raw.commandCount, "commandCount"),
    drawCalls: finiteNumber(raw.drawCalls, "drawCalls"),
    devicePixelRatio: finiteNumber(raw.devicePixelRatio, "devicePixelRatio"),
    pixelWidth: finiteNumber(raw.pixelWidth, "pixelWidth"),
    pixelHeight: finiteNumber(raw.pixelHeight, "pixelHeight"),
    skippedUnchanged: Boolean(raw.skippedUnchanged),
  };
}

/**
 * TypeScript command & rendering wrapper around `crates/x-wasm`
 * (`init_wasm_engine`, `dispatch_command`, and `render_frame`).
 */
export class WasmEngine {
  private static activeInstance: WasmEngine | null = null;
  private static initializingPromise: Promise<WasmEngine> | null = null;
  private currentState: DocumentState;

  private constructor(
    private readonly bridge: WasmPocExports,
    initial: DocumentState,
  ) {
    this.currentState = initial;
  }

  static async initialize(): Promise<WasmEngine> {
    if (!(await initWasmBridge())) {
      const reason = getEngineInfo().lastImportFallback;
      throw new Error(`Rust WASM bridge unavailable${reason ? `: ${reason}` : ""}`);
    }
    const bridge = wasmPocExports();
    if (!bridge) {
      throw new Error("The loaded x_wasm asset has no Phase 1 command exports; rebuild with npm run wasm:build");
    }
    const initial = decodeDocumentState(
      auditRustCall("x-wasm.init_wasm_engine", () => bridge.init_wasm_engine()),
    );
    const engine = new WasmEngine(bridge, initial);
    WasmEngine.activeInstance = engine;
    return engine;
  }

  static getActive(): WasmEngine | null {
    const currentBridge = wasmPocExports();
    if (
      WasmEngine.activeInstance &&
      currentBridge &&
      WasmEngine.activeInstance.bridge.init_wasm_engine === currentBridge.init_wasm_engine &&
      WasmEngine.activeInstance.bridge.dispatch_command === currentBridge.dispatch_command
    ) {
      return WasmEngine.activeInstance;
    }
    return null;
  }

  static isReady(): boolean {
    const active = WasmEngine.getActive();
    return !!active && active.isReady();
  }

  static async getOrCreate(): Promise<WasmEngine> {
    const active = WasmEngine.getActive();
    if (active) return active;
    if (!WasmEngine.initializingPromise) {
      WasmEngine.initializingPromise = WasmEngine.initialize().finally(() => {
        WasmEngine.initializingPromise = null;
      });
    }
    return WasmEngine.initializingPromise;
  }

  isReady(): boolean {
    return typeof this.bridge.render_frame === "function";
  }

  snapshot(): DocumentState {
    return cloneState(this.currentState);
  }

  createRectangle(x: number, y: number): DocumentState {
    return this.dispatch({ type: "createNode", nodeType: "rect", x, y });
  }

  async createNode(
    type: WasmNodeKind,
    x: number,
    y: number,
    width: number,
    height: number,
    parentId?: string,
    text?: string,
  ): Promise<DocumentState> {
    if (type !== "rect" && type !== "frame" && type !== "text" && type !== "ellipse") {
      throw new Error(`Unsupported WASM node type: ${String(type)}`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Node coordinates must be finite numbers");
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("Node dimensions must be positive finite numbers");
    }
    return this.dispatch({
      type: "createNode",
      nodeType: type,
      x,
      y,
      width,
      height,
      ...(parentId ? { parentId } : {}),
      ...(text !== undefined ? { text } : {}),
    });
  }

  async moveNode(id: string, dx: number, dy: number, parentId?: string): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Node id must be a non-empty string");
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error("Move deltas must be finite numbers");
    }
    return this.dispatch({
      type: "moveNode",
      id,
      dx,
      dy,
      ...(parentId !== undefined ? { parentId } : {}),
    });
  }

  async resizeNode(
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Node id must be a non-empty string");
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Resize coordinates must be finite numbers");
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("Resize dimensions must be positive finite numbers");
    }
    return this.dispatch({
      type: "resizeNode",
      id,
      x,
      y,
      width,
      height,
    });
  }

  async deleteNode(id: string): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Node id must be a non-empty string");
    }
    return this.dispatch({
      type: "deleteNode",
      id,
    });
  }

  async booleanOperation(
    ids: string[],
    operation: "union" | "subtract" | "intersect" | "exclude",
  ): Promise<DocumentState> {
    if (!Array.isArray(ids) || ids.length < 2) {
      throw new Error("booleanOperation requires at least 2 target node ids");
    }
    const targetIds = ids.map((id) => {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("Target node ids must be non-empty strings");
      }
      return id.trim();
    });
    if (
      operation !== "union" &&
      operation !== "subtract" &&
      operation !== "intersect" &&
      operation !== "exclude"
    ) {
      throw new Error(`Unsupported boolean operation: ${String(operation)}`);
    }
    return this.dispatch({
      type: "booleanOperation",
      targetIds,
      operation,
    });
  }

  async applyAutoLayout(
    frameId: string,
    axis: "horizontal" | "vertical",
    padding: number,
    gap: number,
  ): Promise<DocumentState> {
    if (typeof frameId !== "string" || !frameId.trim()) {
      throw new Error("Frame id must be a non-empty string");
    }
    if (axis !== "horizontal" && axis !== "vertical") {
      throw new Error(`Unsupported auto-layout axis: ${String(axis)}`);
    }
    if (!Number.isFinite(padding) || padding < 0) {
      throw new Error("Auto-layout padding must be a non-negative finite number");
    }
    if (!Number.isFinite(gap)) {
      throw new Error("Auto-layout gap must be a finite number");
    }
    return this.dispatch({
      type: "applyAutoLayout",
      frameId: frameId.trim(),
      axis,
      padding,
      gap,
    });
  }

  async updateNode(id: string, patch: WasmUpdateNodePatch): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Node id must be a non-empty string");
    }
    if (typeof patch !== "object" || patch === null) {
      throw new Error("updateNode patch must be an object");
    }
    return this.dispatch({
      type: "updateNode",
      id: id.trim(),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.fill !== undefined ? { fill: patch.fill } : {}),
      ...(patch.stroke !== undefined ? { stroke: patch.stroke } : {}),
      ...(patch.strokeWidth !== undefined ? { strokeWidth: patch.strokeWidth } : {}),
      ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}),
      ...(patch.rotation !== undefined ? { rotation: patch.rotation } : {}),
      ...(patch.radius !== undefined ? { radius: patch.radius } : {}),
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.fillVariable !== undefined ? { fillVariable: patch.fillVariable } : {}),
    });
  }

  async updateVariable(id: string, value: string): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Variable id must be a non-empty string");
    }
    if (typeof value !== "string") {
      throw new Error("Variable value must be a string");
    }
    return this.dispatch({
      type: "updateVariable",
      id: id.trim(),
      value,
    });
  }

  async setVariableMode(collectionId: string, modeId: string): Promise<DocumentState> {
    if (typeof collectionId !== "string" || !collectionId.trim()) {
      throw new Error("collectionId must be a non-empty string");
    }
    if (typeof modeId !== "string") {
      throw new Error("modeId must be a string");
    }
    return this.dispatch({
      type: "setVariableMode",
      collectionId: collectionId.trim(),
      modeId: modeId.trim(),
    });
  }

  async updateComponentProperty(
    instanceId: string,
    propertyName: string,
    value: string,
  ): Promise<DocumentState> {
    if (typeof instanceId !== "string" || !instanceId.trim()) {
      throw new Error("instanceId must be a non-empty string");
    }
    if (typeof propertyName !== "string" || !propertyName.trim()) {
      throw new Error("propertyName must be a non-empty string");
    }
    if (typeof value !== "string") {
      throw new Error("Component property value must be a string");
    }
    return this.dispatch({
      type: "updateComponentProperty",
      instanceId: instanceId.trim(),
      propertyName: propertyName.trim(),
      value,
    });
  }

  async outlineStroke(id: string): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Node id must be a non-empty string");
    }
    return this.dispatch({
      type: "outlineStroke",
      id: id.trim(),
    });
  }

  async offsetPath(
    id: string,
    distance: number,
    join: WasmOffsetJoin = "miter",
  ): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Node id must be a non-empty string");
    }
    if (!Number.isFinite(distance) || distance === 0) {
      throw new Error("offsetPath distance must be a non-zero finite number");
    }
    if (join !== "miter" && join !== "round" && join !== "bevel") {
      throw new Error(`Unsupported offsetPath join: ${String(join)}`);
    }
    return this.dispatch({
      type: "offsetPath",
      id: id.trim(),
      distance,
      join,
    });
  }

  async duplicateNode(id: string, dx = 16, dy = 16): Promise<DocumentState> {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Node id must be a non-empty string");
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error("Duplicate offsets must be finite numbers");
    }
    return this.dispatch({
      type: "duplicateNode",
      id: id.trim(),
      dx,
      dy,
    });
  }

  async undo(): Promise<DocumentState> {
    return this.dispatch({ type: "undo" });
  }

  async redo(): Promise<DocumentState> {
    return this.dispatch({ type: "redo" });
  }

  renderFrame(canvasId: string, state: DocumentState = this.currentState): RenderFrameStats {
    if (typeof canvasId !== "string" || !canvasId.trim()) {
      throw new Error("Canvas id must be a non-empty string");
    }
    if (typeof this.bridge.render_frame !== "function") {
      throw new Error("The loaded x_wasm asset has no render_frame export; rebuild with npm run wasm:build");
    }
    const raw = auditRustCall("x-wasm.render_frame", () =>
      this.bridge.render_frame!(canvasId, state),
    );
    return decodeRenderFrameStats(raw);
  }

  dispatch(command: WasmPocCommand): DocumentState {
    if (command.type === "createNode" || command.type === "CreateNode") {
      if (
        command.nodeType !== "rect" &&
        command.nodeType !== "frame" &&
        command.nodeType !== "text" &&
        command.nodeType !== "ellipse"
      ) {
        throw new Error(`Unsupported WASM node type: ${String(command.nodeType)}`);
      }
      if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
        throw new Error("Rectangle coordinates must be finite numbers");
      }
      if (
        (command.width !== undefined && (!Number.isFinite(command.width) || command.width <= 0)) ||
        (command.height !== undefined && (!Number.isFinite(command.height) || command.height <= 0))
      ) {
        throw new Error("Node dimensions must be positive finite numbers");
      }
      if (command.text !== undefined && typeof command.text !== "string") {
        throw new Error("Text node content must be a string");
      }
    } else if (command.type === "moveNode" || command.type === "MoveNode") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
      if (!Number.isFinite(command.dx) || !Number.isFinite(command.dy)) {
        throw new Error("Move deltas must be finite numbers");
      }
    } else if (command.type === "resizeNode" || command.type === "ResizeNode") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
      if (
        (command.x !== undefined && !Number.isFinite(command.x)) ||
        (command.y !== undefined && !Number.isFinite(command.y))
      ) {
        throw new Error("Resize coordinates must be finite numbers");
      }
      if (!Number.isFinite(command.width) || !Number.isFinite(command.height) || command.width <= 0 || command.height <= 0) {
        throw new Error("Resize dimensions must be positive finite numbers");
      }
    } else if (command.type === "deleteNode" || command.type === "DeleteNode") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
    } else if (command.type === "booleanOperation" || command.type === "BooleanOperation") {
      if (
        !Array.isArray(command.targetIds) ||
        command.targetIds.length < 2 ||
        command.targetIds.some((id) => typeof id !== "string" || !id.trim())
      ) {
        throw new Error("booleanOperation requires at least 2 non-empty target node ids");
      }
      if (
        command.operation !== "union" &&
        command.operation !== "subtract" &&
        command.operation !== "intersect" &&
        command.operation !== "exclude"
      ) {
        throw new Error(`Unsupported boolean operation: ${String(command.operation)}`);
      }
    } else if (command.type === "applyAutoLayout" || command.type === "ApplyAutoLayout") {
      if (typeof command.frameId !== "string" || !command.frameId.trim()) {
        throw new Error("Frame id must be a non-empty string");
      }
      if (command.axis !== "horizontal" && command.axis !== "vertical") {
        throw new Error(`Unsupported auto-layout axis: ${String(command.axis)}`);
      }
      if (!Number.isFinite(command.padding) || command.padding < 0) {
        throw new Error("Auto-layout padding must be a non-negative finite number");
      }
      if (!Number.isFinite(command.gap)) {
        throw new Error("Auto-layout gap must be a finite number");
      }
    } else if (command.type === "updateNode" || command.type === "UpdateNode") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
      if (command.opacity !== undefined && !Number.isFinite(command.opacity)) {
        throw new Error("opacity must be a finite number");
      }
      if (command.rotation !== undefined && !Number.isFinite(command.rotation)) {
        throw new Error("rotation must be a finite number");
      }
      if (
        command.strokeWidth !== undefined &&
        (!Number.isFinite(command.strokeWidth) || command.strokeWidth < 0)
      ) {
        throw new Error("strokeWidth must be a non-negative finite number");
      }
      if (command.radius !== undefined && (!Number.isFinite(command.radius) || command.radius < 0)) {
        throw new Error("radius must be a non-negative finite number");
      }
    } else if (command.type === "outlineStroke" || command.type === "OutlineStroke") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
    } else if (command.type === "offsetPath" || command.type === "OffsetPath") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
      if (!Number.isFinite(command.distance) || command.distance === 0) {
        throw new Error("offsetPath distance must be a non-zero finite number");
      }
      if (
        command.join !== undefined &&
        command.join !== "miter" &&
        command.join !== "round" &&
        command.join !== "bevel"
      ) {
        throw new Error(`Unsupported offsetPath join: ${String(command.join)}`);
      }
    } else if (command.type === "duplicateNode" || command.type === "DuplicateNode") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
      if (
        (command.dx !== undefined && !Number.isFinite(command.dx)) ||
        (command.dy !== undefined && !Number.isFinite(command.dy))
      ) {
        throw new Error("Duplicate offsets must be finite numbers");
      }
    } else if (command.type === "updateVariable" || command.type === "UpdateVariable") {
      if (typeof command.id !== "string" || !command.id.trim()) {
        throw new Error("Variable id must be a non-empty string");
      }
      if (typeof command.value !== "string") {
        throw new Error("Variable value must be a string");
      }
    } else if (command.type === "setVariableMode" || command.type === "SetVariableMode") {
      if (typeof command.collectionId !== "string" || !command.collectionId.trim()) {
        throw new Error("collectionId must be a non-empty string");
      }
      if (typeof command.modeId !== "string") {
        throw new Error("modeId must be a string");
      }
    } else if (
      command.type === "updateComponentProperty" ||
      command.type === "UpdateComponentProperty"
    ) {
      if (typeof command.instanceId !== "string" || !command.instanceId.trim()) {
        throw new Error("instanceId must be a non-empty string");
      }
      if (typeof command.propertyName !== "string" || !command.propertyName.trim()) {
        throw new Error("propertyName must be a non-empty string");
      }
      if (typeof command.value !== "string") {
        throw new Error("Component property value must be a string");
      }
    } else if (
      command.type !== "undo" &&
      command.type !== "Undo" &&
      command.type !== "redo" &&
      command.type !== "Redo"
    ) {
      throw new Error("Unsupported WASM command");
    }
    const next = decodeDocumentState(
      auditRustCall("x-wasm.dispatch_command", () => this.bridge.dispatch_command(command)),
    );
    this.currentState = next;
    return this.snapshot();
  }
}
