/**
 * Opt-in, lossless admission of ONE small web-document dialect into the shared
 * Rust command session. This is a format adapter, not a second document engine:
 * only open and explicit export copy a tree. Commands and history are owned by
 * x-editor. Do not attach this to MemoryEngine's live editor/persistence loop:
 * that would create two document and undo authorities.
 *
 * V1: exactly one page, its transparent root and direct-child, solid, opaque
 * rectangles. No nested frames, layout, effects, text, styles, variables,
 * comments, prototype or unknown fields. Reject the WHOLE file otherwise.
 */
import { node } from "./memory";
import type { DocSeed } from "./files";
import type { PersistedDoc } from "./persist";
import type { Page, XNode } from "./types";
import { openRustSession, type RustSessionClient } from "./rustSession";
import { auditDecision } from "./bridgeRuntimeAudit";

export const WEB_DOCUMENT_SESSION_VERSION = 1;
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

function admittedNode(value: unknown, root: boolean): XNode {
  const n = object(value), base = root ? ROOT : RECT;
  exactKeys(base as unknown as Record<string, unknown>, NODE_KEYS_V1);
  exactKeys(n, NODE_KEYS_V1);
  if (!label(n.id) || !n.id || !label(n.name) ||
      ![n.x, n.y, n.w, n.h].every(finite) || (n.w as number) <= 0 || (n.h as number) <= 0 ||
      typeof n.visible !== "boolean" || typeof n.locked !== "boolean" ||
      (root ? n.fill !== "#00000000" : !label(n.fill) || !OPAQUE.test(n.fill)) ||
      !Array.isArray(n.children) || (!root && n.children.length !== 0) ||
      (root && n.children.length > 2048)) throw new Error("Unsupported layer");
  const children = root ? n.children.map(c => admittedNode(c, false)) : [];
  const expected: XNode = {
    ...base, id: n.id, name: n.name, x: n.x as number, y: n.y as number,
    w: n.w as number, h: n.h as number, fill: n.fill as string,
    visible: n.visible, locked: n.locked, children,
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

function nativeNode(n: XNode, root: boolean): Record<string, unknown> {
  return {
    id: n.id, kind: root ? { t: "frame" } : { t: "rect", radius: 0 },
    x: n.x, y: n.y, w: n.w, h: n.h, rotation: 0, opacity: 1,
    visible: n.visible, locked: n.locked, fill: { t: "solid", c: n.fill },
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

function decodedNode(value: unknown, root: boolean): XNode {
  const n = object(value), paint = object(n.fill);
  if (!label(n.id) || !n.id || (n.name !== undefined && !label(n.name)) ||
      ![n.x, n.y, n.w, n.h].every(finite) ||
      typeof n.visible !== "boolean" || typeof n.locked !== "boolean" ||
      !label(paint.c) || !Array.isArray(n.children ?? [])) throw new Error("Invalid native layer");
  const children = root ? (n.children as unknown[] | undefined ?? []).map(c => decodedNode(c, false)) : [];
  const base = root ? ROOT : RECT;
  const candidate = {
    ...base, id: n.id, name: n.name ?? n.id, x: n.x as number, y: n.y as number,
    w: n.w as number, h: n.h as number, fill: paint.c,
    visible: n.visible, locked: n.locked, children,
  };
  // Checks *every* native field, including extra properties the lenient .x
  // parser might expose in a future build. Nothing is stripped on export.
  if (!equal(n, nativeNode(candidate, root))) throw new Error("Unsupported native layer fields");
  return admittedNode(candidate, root);
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
  if (!equal(native, nativeDocument(root))) throw new Error("Unsupported native document metadata");
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
  state() { return this.rust.state(); }
  getNode(id: string) { return this.rust.getNode(id); }
  renameNode(id: string, name: string) { return this.rust.renameNode(id, name); }
  moveNode(id: string, dx: number, dy: number) { return this.rust.moveNode(id, dx, dy); }
  resizeNode(id: string, w: number, h: number) { return this.rust.resizeNode(id, w, h); }
  undo() { return this.rust.undo(); }
  redo() { return this.rust.redo(); }
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
