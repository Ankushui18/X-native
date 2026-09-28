/**
 * Opt-in, lossless admission of ONE small web-document dialect into the shared
 * Rust command session. This is a format adapter, not a second document engine:
 * only open and explicit export copy a tree. Commands and history are owned by
 * x-editor. Do not attach this to MemoryEngine's live editor/persistence loop:
 * that would create two document and undo authorities.
 *
 * V2: exactly one page, its transparent root and direct-child, solid, opaque
 * rect/ellipse/polygon/star. Native-produced vectors are supported only after
 * a session command. No nested frames, layout, effects, text, styles,
 * variables, comments, prototype or unknown fields. Reject the WHOLE file
 * otherwise; native and Web must round-trip every admitted field.
 */
import { node } from "./memory";
import type { DocSeed } from "./files";
import type { PersistedDoc } from "./persist";
import type { BooleanOp, Page, XNode } from "./types";
import { openRustSession, type RustSessionClient, type RustStateChange, type RustStrokeChange } from "./rustSession";
import { auditDecision } from "./bridgeRuntimeAudit";
import { guardOffsetPreview, offsetAuditRequested } from "./offsetPathOracle";
import {
  outlineAuditRequested, outlineInkVerdict, outlineReferenceRect, recordOutlineAudit,
} from "./outlineStrokeOracle";
import { verifyStrokeDelta } from "./strokeBandOracle";

export const WEB_DOCUMENT_SESSION_VERSION = 2;
export type WebDocument = DocSeed | PersistedDoc;

// Freeze the supported v1 web schema. If the factory gains a new field, even
// with a default, admission stops until the field's native semantics are
// reviewed. Matching the current factory alone would silently widen the gate.
const NODE_KEYS_V1 = `
  id name kind x y w h rotation rotOrigin fill fillOpacity fillVisible fillType fillB
  gradientStops fillBlend strokePaint strokeOpacity strokeVisible strokeWidth effects
  strokeAlign strokeDash strokeGap strokeCap strokeCapStart strokeCapEnd strokeJoin
  opacity visible locked overflow cornerRadii cornerIndependent cornerSmoothing
  strokeSides strokeSideW strokeDashCap strokeMiterAngle aspectLocked sizingW sizingH
  constraintH constraintV count starRatio showName exports blendMode imageSrc
  imageFit imageRot imageTile imageExposure imageContrast imageSaturation imageTemperature
  imageTint imageHighlights imageShadows text fontFamily fontSize fontWeight lineHeight
  letterSpacing paragraphSpacing textAlign textAlignVertical textWrap listStyle
  paragraphIndent textDecoration textCase truncate maxLines children layout path
  closed booleanOp componentId isComponent interactions flipH flipV fillGX fillGY
  fillHX fillHY isMask maskType variant
`.trim().split(/\s+/);
const ROOT = node("frame", "", 0, 0, 1, 1, { fill: "#00000000", overflow: "visible", showName: false });
const RECT = node("rect", "", 0, 0, 1, 1);
const ELLIPSE = node("ellipse", "", 0, 0, 1, 1);
const POLY = node("poly", "", 0, 0, 1, 1);
const STAR = node("star", "", 0, 0, 1, 1);
const VECTOR = node("vector", "", 0, 0, 1, 1);
const DOC_KEYS = `fileName pages components styles page zoom panX panY showRulers showMinimap showComments`.split(" ");
const OPTIONAL_DOC_KEYS = `version showFlows annotations variables variableCollections activeModes`.split(" ");
const PAGE_KEYS = `id name root comments guides pixelGrid pixelGridColor pixelSnap flowStart`.split(" ");
const VARIABLES = {
  colors: {}, numbers: {}, strings: {}, bools: {}, collections: {}, modes: {},
  num_modes: {}, str_modes: {}, bool_modes: {},
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Expected a plain object");
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const keys = Reflect.ownKeys(value);
  if (required.some(k => !Object.prototype.hasOwnProperty.call(value, k)) ||
      keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) {
    throw new Error("Unsupported document fields");
  }
}
/** Array holes, custom fields and non-enumerable/symbol keys must not pass as
 * equal: JSON.stringify would discard them at the Rust boundary. */
function arraySize(value: unknown, size: number): value is unknown[] {
  return Array.isArray(value) && value.length === size &&
    Reflect.ownKeys(value).length === size + 1 &&
    Array.from({ length: size }, (_, i) => Object.prototype.hasOwnProperty.call(value, i)).every(Boolean);
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a && b && typeof a === "object" && typeof b === "object" &&
      Array.isArray(a) === Array.isArray(b)) {
    const left = Reflect.ownKeys(a), right = Reflect.ownKeys(b);
    return left.length === right.length && left.every(k =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      equal((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k]));
  }
  return false;
}
function finite(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n); }
function label(s: unknown): s is string { return typeof s === "string"; }
const OPAQUE = /^#[0-9a-f]{6}$/;

function admittedNode(value: unknown, root: boolean, fromNative = false): XNode {
  const n = object(value);
  // Only a command result may add a vector. Initial web admission stays
  // rectangle-only; arbitrary vector documents have not passed this gate.
  const vector = fromNative && !root && n.kind === "vector";
  const poly = !root && n.kind === "poly";
  const star = !root && n.kind === "star";
  // A styled rectangle can only be produced by the versioned Rust command;
  // initial web admission still rejects every preexisting stroke/property.
  const styled = fromNative && !root && !vector && n.kind === "rect" && finite(n.strokeWidth) && n.strokeWidth > 0;
  const base = root ? ROOT : vector ? VECTOR : poly ? POLY : star ? STAR : n.kind === "ellipse" ? ELLIPSE : RECT;
  exactKeys(base as unknown as Record<string, unknown>, NODE_KEYS_V1);
  exactKeys(n, NODE_KEYS_V1, vector ? ["vectorNetwork"] : []);
  if (!label(n.id) || !n.id || !label(n.name) ||
      ![n.x, n.y, n.w, n.h].every(finite) || (n.w as number) <= 0 || (n.h as number) <= 0 ||
      typeof n.visible !== "boolean" || typeof n.locked !== "boolean" ||
      (root ? n.fill !== "#00000000" : !label(n.fill) || !OPAQUE.test(n.fill)) ||
      !Array.isArray(n.children) || (!root && n.children.length !== 0) ||
      (root && n.children.length > 2048) ||
      ((poly || star) && (!Number.isSafeInteger(n.count) || (n.count as number) < 3 || (n.count as number) > 60)) ||
      (star && (!finite(n.starRatio) || n.starRatio < 0.05 || n.starRatio > 0.95)) ||
      (styled && (!(n.strokeWidth as number <= 2048) || !label(n.strokePaint) || !OPAQUE.test(n.strokePaint) ||
        n.strokeVisible !== true || !["inside", "center", "outside"].includes(n.strokeAlign as string) ||
        !["miter", "bevel"].includes(n.strokeJoin as string)))) throw new Error("Unsupported layer");
  const children = root ? n.children.map(c => admittedNode(c, false, fromNative)) : [];
  const expected: XNode = {
    ...base, id: n.id, name: n.name, x: n.x as number, y: n.y as number,
    w: n.w as number, h: n.h as number, fill: n.fill as string,
    visible: n.visible, locked: n.locked, children,
    ...(vector ? { path: n.path as XNode["path"], vectorNetwork: n.vectorNetwork as NonNullable<XNode["vectorNetwork"]>, closed: true } : {}),
    ...((poly || star) ? { count: n.count as number } : {}),
    ...(star ? { starRatio: n.starRatio as number } : {}),
    ...(styled ? { strokeWidth: n.strokeWidth as number, strokePaint: n.strokePaint as string,
      strokeVisible: true, strokeAlign: n.strokeAlign as XNode["strokeAlign"],
      strokeJoin: n.strokeJoin as XNode["strokeJoin"] } : {}),
  };
  if (!equal(n, expected)) throw new Error("Unsupported layer properties");
  return expected;
}

/** Null means KEEP the current MemoryEngine; never project a partial file. */
export function admitWebDocument(input: unknown): string | null {
  try {
    const d = object(input);
    exactKeys(d, DOC_KEYS, OPTIONAL_DOC_KEYS);
    if (d.version !== undefined && d.version !== 1) throw new Error("Unsupported persisted version");
    if (!label(d.fileName) || !arraySize(d.pages, 1) ||
        !arraySize(d.components, 0) || !arraySize(d.styles, 0) ||
        d.page !== 0 || !finite(d.zoom) || d.zoom <= 0 || !finite(d.panX) || !finite(d.panY) ||
        ![d.showRulers, d.showMinimap, d.showComments].every(v => typeof v === "boolean") ||
        (d.showFlows !== undefined && typeof d.showFlows !== "boolean") ||
        [d.annotations, d.variables, d.variableCollections].some(v => v !== undefined && !arraySize(v, 0)) ||
        (d.activeModes !== undefined && !equal(d.activeModes, {}))) throw new Error("Unsupported document metadata");
    const p = object(d.pages[0]);
    exactKeys(p, PAGE_KEYS);
    if (!label(p.id) || !p.id || !label(p.name) ||
        !arraySize(p.comments, 0) || !arraySize(p.guides, 0) ||
        p.pixelGrid !== false || p.pixelGridColor !== "#cccccc" || p.pixelSnap !== true || p.flowStart !== "") {
      throw new Error("Unsupported page metadata");
    }
    const root = admittedNode(p.root, true);
    if (p.id === root.id || new Set([root.id, ...root.children.map(c => c.id)]).size !== root.children.length + 1) {
      throw new Error("Duplicate layer ids");
    }
    return JSON.stringify(nativeDocument(root));
  } catch { return null; }
}

function nativePath(n: XNode): (string | number)[][] {
  const net = n.vectorNetwork;
  const loops = net?.regions?.[0]?.loops;
  if (!net || !loops) throw new Error("Missing native vector contours");
  return loops.flatMap(loop => loop.flatMap((i, j) => {
    const p = net.vertices[i];
    if (!p || !finite(p.x) || !finite(p.y)) throw new Error("Invalid native vector vertex");
    return [[j === 0 ? "M" : "L", p.x, p.y]];
  }).concat([["Z"]]));
}

function nativeNode(n: XNode, root: boolean): Record<string, unknown> {
  return {
    id: n.id, kind: root ? { t: "frame" } : n.kind === "vector"
      ? { t: "vector", path: nativePath(n) } : n.kind === "ellipse" ? { t: "ellipse" } :
        n.kind === "poly" ? { t: "poly", sides: n.count } :
          n.kind === "star" ? { t: "star", points: n.count, ratio: n.starRatio } :
            { t: "rect", radius: 0 },
    x: n.x, y: n.y, w: n.w, h: n.h, rotation: 0, opacity: 1,
    visible: n.visible, locked: n.locked, fill: { t: "solid", c: n.fill },
    ...(!root && n.kind === "rect" && n.strokeWidth > 0 ? {
      stroke: { color: n.strokePaint, width: n.strokeWidth },
      fill_layers: [{ paint: { t: "solid", c: n.fill }, opacity: 1, visible: true, blend: "normal" }],
      stroke_layers: [{ color: n.strokePaint, width: n.strokeWidth, opacity: 1, visible: true,
        blend: "normal", align: n.strokeAlign, cap_start: "none", cap_end: "none", join: n.strokeJoin,
        dash: [], dash_offset: 0, miter: 4 }],
      effect_layers: [],
    } : {}),
    ...(n.name === n.id ? {} : { name: n.name }),
    show_name: false,
    ...(root ? { blend: "pass-through" } : {}),
    ...(n.children.length ? { children: n.children.map(c => nativeNode(c, false)) } : {}),
  };
}
function nativeDocument(root: XNode): Record<string, unknown> {
  return {
    format: "x-native", version: 1, variables: VARIABLES, styles: {}, component_props: {},
    comments: [], assets: [], libraries: [], pages: [nativeNode(root, true)],
  };
}

const OUTLINE_VECTOR_MAX_ANCHORS = 8192;
const OUTLINE_VECTOR_MAX_LOOPS = Math.ceil(OUTLINE_VECTOR_MAX_ANCHORS / 3);
const OUTLINE_VECTOR_COORD_LIMIT = 1_100_000_000;

function nativeVector(value: unknown): Pick<XNode, "path" | "vectorNetwork" | "closed"> {
  const kind = object(value);
  exactKeys(kind, ["t", "path"]);
  if (kind.t !== "vector" || !Array.isArray(kind.path)) throw new Error("Invalid native vector");
  const loops: number[][] = [];
  const vertices: { x: number; y: number }[] = [];
  const segments: { start: number; end: number }[] = [];
  const path: XNode["path"] = [];
  let loop: number[] = [];
  for (const item of kind.path) {
    if (!Array.isArray(item) || !["M", "L", "Z"].includes(item[0])) throw new Error("Unsupported native path command");
    if (item[0] === "Z") {
      if (item.length !== 1 || loop.length < 3) throw new Error("Degenerate native contour");
      for (let i = 0; i < loop.length; i++) {
        segments.push({ start: loop[i], end: loop[(i + 1) % loop.length] });
      }
      loops.push(loop);
      loop = [];
    } else {
      if (item.length !== 3 || !finite(item[1]) || !finite(item[2]) ||
          Math.abs(item[1]) > OUTLINE_VECTOR_COORD_LIMIT || Math.abs(item[2]) > OUTLINE_VECTOR_COORD_LIMIT ||
          (item[0] === "M") !== (loop.length === 0) || vertices.length >= OUTLINE_VECTOR_MAX_ANCHORS) {
        throw new Error("Invalid native vector anchor");
      }
      const p = { x: item[1], y: item[2] };
      vertices.push(p);
      path.push(p);
      loop.push(vertices.length - 1);
    }
  }
  if (loop.length || loops.length > OUTLINE_VECTOR_MAX_LOOPS || (!loops.length && kind.path.length)) {
    throw new Error("Unclosed native vector contour");
  }
  return { path, vectorNetwork: { vertices, segments, regions: [{ windingRule: "EVENODD", loops }] }, closed: true };
}

/** Outline Stroke writes a canonical one-fill visual stack so its former
 * stroke paint remains editable. The web document model has exactly the same
 * single-solid-fill semantics in legacy form, so checkpoint decoding can
 * represent this narrow stack without dropping an observable property. */
function canonicalOutlineFillStack(raw: Record<string, unknown>, expected: Record<string, unknown>, vector: boolean, root: boolean): boolean {
  if (root || !vector || raw.stroke !== undefined || !Array.isArray(raw.fill_layers) || raw.fill_layers.length !== 1 ||
      !Array.isArray(raw.stroke_layers) || raw.stroke_layers.length !== 0 ||
      !Array.isArray(raw.effect_layers) || raw.effect_layers.length !== 0) return false;
  try {
    const layer = object(raw.fill_layers[0]);
    exactKeys(layer, ["paint", "opacity", "visible", "blend"]);
    const paint = object(layer.paint), fill = object(raw.fill);
    exactKeys(paint, ["t", "c"]); exactKeys(fill, ["t", "c"]);
    if (paint.t !== "solid" || fill.t !== "solid" || paint.c !== fill.c ||
        layer.opacity !== 1 || layer.visible !== true || layer.blend !== "normal") return false;
    const normalized = { ...raw };
    delete normalized.fill_layers; delete normalized.stroke_layers; delete normalized.effect_layers;
    return equal(normalized, expected);
  } catch {
    return false;
  }
}

function decodedNode(value: unknown, root: boolean): XNode {
  const n = object(value), paint = object(n.fill);
  if (!label(n.id) || !n.id || (n.name !== undefined && !label(n.name)) ||
      ![n.x, n.y, n.w, n.h].every(finite) ||
      typeof n.visible !== "boolean" || typeof n.locked !== "boolean" ||
      !label(paint.c) || !Array.isArray(n.children ?? [])) throw new Error("Invalid native layer");
  const kind = object(n.kind);
  const vector = !root && kind.t === "vector";
  const poly = !root && kind.t === "poly";
  const star = !root && kind.t === "star";
  const ellipse = !root && kind.t === "ellipse";
  const style = !root && !vector && n.stroke !== undefined ? (() => {
    const stroke = object(n.stroke);
    if (!Array.isArray(n.stroke_layers) || n.stroke_layers.length !== 1) throw new Error("Unsupported stroke stack");
    const layer = object(n.stroke_layers[0]);
    return { strokePaint: stroke.color as string, strokeWidth: stroke.width as number, strokeVisible: true,
      strokeAlign: layer.align as XNode["strokeAlign"], strokeJoin: layer.join as XNode["strokeJoin"] };
  })() : {};
  const children = root ? (n.children as unknown[] | undefined ?? []).map(c => decodedNode(c, false)) : [];
  const base = root ? ROOT : vector ? VECTOR : poly ? POLY : star ? STAR : ellipse ? ELLIPSE : RECT;
  const candidate: XNode = {
    ...base, id: n.id, name: n.name ?? n.id, x: n.x as number, y: n.y as number,
    w: n.w as number, h: n.h as number, fill: paint.c,
    visible: n.visible, locked: n.locked, children,
    ...(vector ? nativeVector(kind) : {}),
    ...((poly || star) ? { count: (poly ? kind.sides : kind.points) as number } : {}),
    ...(star ? { starRatio: kind.ratio as number } : {}),
    ...style,
  };
  // Checks every native field, including extra properties the lenient .x
  // parser might expose in a future build. The one exception is Outline
  // Stroke's canonical single-solid-fill stack, which has the exact legacy
  // web-fill meaning and is normalized only after every stack field is proved.
  const expected = nativeNode(candidate, root);
  // Children were recursively decoded and strictly checked above. Compare only
  // the frame's own fields here so a canonical outlined child's fill stack is
  // not mistaken for an unexamined frame-level extension.
  const directMatch = root ? (() => {
    const { children: _actualChildren, ...actual } = n;
    const { children: _expectedChildren, ...expectedOwn } = expected;
    return equal(actual, expectedOwn);
  })() : equal(n, expected);
  if (!directMatch && !canonicalOutlineFillStack(n, expected, vector, root)) {
    throw new Error("Unsupported native layer fields");
  }
  return admittedNode(candidate, root, true);
}

// Only application/page metadata and root identity survive admission in JS.
// Crucially, the initial web node tree is NOT retained as a shadow document.
interface WebShell {
  document: Omit<DocSeed, "pages"> | Omit<PersistedDoc, "pages">;
  page: Omit<Page, "root">;
  rootId: string;
}
function shellOf(input: WebDocument): WebShell {
  const snapshot = JSON.parse(JSON.stringify(input)) as WebDocument;
  const { pages, ...document } = snapshot;
  const { root, ...page } = pages[0];
  return { document, page, rootId: root.id };
}

function checkpoint(x: string, shell: WebShell): WebDocument {
  const native = object(JSON.parse(x) as unknown);
  const pages = native.pages;
  if (!Array.isArray(pages) || pages.length !== 1) throw new Error("Unsupported native pages");
  const root = decodedNode(pages[0], true);
  // `decodedNode` already recursively proves the sole page and every layer.
  // Compare document-level metadata separately so the one permitted canonical
  // Outline Stroke child stack is not erased merely to make this outer equality
  // check pass.
  const { pages: _nativePages, ...nativeMetadata } = native;
  const { pages: _expectedPages, ...expectedMetadata } = nativeDocument(root);
  if (!equal(nativeMetadata, expectedMetadata)) throw new Error("Unsupported native document metadata");
  if (shell.rootId !== root.id) throw new Error("Native root identity changed");
  return {
    ...JSON.parse(JSON.stringify(shell.document)),
    pages: [{ ...JSON.parse(JSON.stringify(shell.page)), root }],
  } as WebDocument;
}

/** Full Rust -> web checkpoint only. A corrupted/expanded native file THROWS
 * rather than silently producing a truncated web document. */
export function decodeWebDocument(x: string, shell: WebDocument): WebDocument {
  if (!admitWebDocument(shell)) throw new Error("Unsupported web document shell");
  return checkpoint(x, shellOf(shell));
}

/** No TypeScript shadow tree/history. The sole retained web data is a copy of
 * UI/file metadata and a root ID, used only on explicit persistence. */
export class RustWebDocumentSession {
  private constructor(private readonly rust: RustSessionClient, private readonly shell: WebShell) {}
  static create(rust: RustSessionClient, input: WebDocument): RustWebDocumentSession {
    return new RustWebDocumentSession(rust, shellOf(input));
  }
  private checked(change: RustStateChange): RustStateChange {
    return verifyStrokeDelta(change, id => this.rust.getNode(id));
  }
  state() { return this.rust.state(); }
  getNode(id: string) { return this.rust.getNode(id); }
  /** Bounded one-layer geometry query, not a retained JS node tree. */
  getShape(id: string) { return this.rust.getShape(id); }
  renameNode(id: string, name: string) { return this.rust.renameNode(id, name); }
  moveNode(id: string, dx: number, dy: number) { return this.rust.moveNode(id, dx, dy); }
  resizeNode(id: string, w: number, h: number) { return this.checked(this.rust.resizeNode(id, w, h)); }
  booleanNode(first: string, second: string, op: BooleanOp) { return this.rust.booleanNode(first, second, op); }
  strokeNode(id: string, width: number, color: string, align: RustStrokeChange["align"], join: RustStrokeChange["join"]) {
    return this.checked(this.rust.strokeNode(id, width, color, align, join));
  }
  /** Genuine-WASM 30/30 offset parity: ordinary edits dispatch directly to
   * Rust. The opt-in ?offset=audit mode compares a bounded pure preview to the
   * independent TS coverage reference BEFORE changing native history. Neither
   * path owns a JS document tree or an additional undo stack. */
  offsetNode(id: string, distance: number, join: "miter" | "bevel" | "round") {
    if (!offsetAuditRequested()) {
      const applied = this.rust.offsetNode(id, distance, join);
      if (applied.offset && applied.offset.id !== id) {
        throw new Error("Native offset changed a different layer; editing must pause");
      }
      return applied;
    }
    const before = this.rust.getShape(id);
    const preview = this.rust.previewOffset(id, distance, join);
    if (preview) guardOffsetPreview(before, preview, distance, join);
    const applied = this.rust.offsetNode(id, distance, join);
    if (preview && JSON.stringify(preview) !== JSON.stringify(applied.offset)) {
      throw new Error("Rust offset changed after equivalence preflight; editing must pause");
    }
    if (!preview && applied.offset) throw new Error("Unrequested Rust offset mutation; editing must pause");
    return applied;
  }
  /** One native ReplaceNode rewrite. The genuine generated-WASM 30/30 corpus
   * passed with the promotion guard active, so ordinary edits now dispatch the
   * Rust command directly: strict ABI/schema parsing, affected-layer identity
   * and filled-vector checks apply, but there is no per-edit TS oracle.
   * `?outline=audit` opts into the independent filled-ink diagnostic. */
  outlineStroke(id: string) {
    if (!outlineAuditRequested()) return this.checkedOutline(this.rust.outlineStroke(id), id);
    // Bounded geometry read before the edit. A source this reference cannot
    // model is reported, not silently trusted and not turned into a finding.
    const rect = outlineReferenceRect(this.rust.getShape(id));
    if (!rect) {
      recordOutlineAudit({ verified: false, decisive: false, reason: "source is not an unrounded rectangle" });
      return this.checkedOutline(this.rust.outlineStroke(id), id);
    }
    const applied = this.checkedOutline(this.rust.outlineStroke(id), id);
    // Rust's own undo projection is the only faithful source style: the web
    // host keeps no JS copy of the layer or its stroke. The round trip returns
    // the session to the pre-edit depth (apply, undo, redo) and proves the
    // committed ink against the independent reference before the DOM sees it.
    const restored = this.rust.undo().outline;
    if (!restored || restored.id !== id || restored.kind !== "rect" || !restored.stroke) {
      throw new Error("Rust outline undo did not restore the source layer; editing must pause");
    }
    const verdict = outlineInkVerdict(rect, restored.stroke, applied.outline!);
    const redone = this.rust.redo();
    if (JSON.stringify(redone.outline) !== JSON.stringify(applied.outline)) {
      throw new Error("Rust outline changed after the audit round trip; editing must pause");
    }
    recordOutlineAudit(verdict);
    return redone;
  }
  private checkedOutline(change: RustStateChange, id: string): RustStateChange {
    const outline = change.outline;
    if (!outline || outline.id !== id || outline.kind !== "vector" || outline.stroke !== null ||
        !outline.path.some(command => command[0] === "Z")) {
      throw new Error("Native outline did not return its filled affected layer; editing must pause");
    }
    return change;
  }
  undo() { return this.checked(this.rust.undo()); }
  redo() { return this.checked(this.rust.redo()); }
  /** Whole document only on an explicit checkpoint; never per command/frame. */
  exportDocument(): WebDocument { return checkpoint(this.rust.exportX(), this.shell); }
  close(): void { this.rust.close(); }
}

export async function openWebDocumentSession(input: unknown, signal?: AbortSignal): Promise<RustWebDocumentSession | null> {
  if (signal?.aborted) return null;
  const x = admitWebDocument(input);
  if (!x) {
    auditDecision({ bridge: "session", operation: "open", result: "none", guard: "blocked", candidate: false,
      reason: "web schema not admissible (only one page, flat opaque solid rectangles)" });
    return null;
  }
  if (signal?.aborted) return null;
  let rust: RustSessionClient | null = null;
  try {
    rust = await openRustSession(x, signal);
    if (!rust) {
      auditDecision({ bridge: "session", operation: "open", result: "none", guard: "not-run", candidate: false,
        reason: signal?.aborted ? "route cancelled" : "module unavailable or session ABI incompatible" });
      return null;
    }
    const shell = input as WebDocument;
    // Round-trip the WHOLE document before handing out a Rust-owned session.
    // If native defaults, precision or metadata differ, MemoryEngine remains
    // the only owner; never expose a partly converted Rust session.
    if (!equal(decodeWebDocument(rust.exportX(), shell), shell) || signal?.aborted) {
      throw new Error("Web/native round trip differs or open was cancelled");
    }
    const admitted = RustWebDocumentSession.create(rust, shell);
    auditDecision({ bridge: "session", operation: "open", result: "rust", guard: "passed", candidate: true,
      reason: "whole-document native/web checkpoint matched" });
    return admitted;
  } catch {
    auditDecision({ bridge: "session", operation: "open", result: "none", guard: "blocked", candidate: !!rust,
      reason: "native session open or whole-document checkpoint failed" });
    rust?.close();
    return null;
  }
}
