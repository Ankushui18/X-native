/**
 * Local file store behind the dashboard.
 *
 * Figma keeps files on a server; this product is offline-first, so the store is
 * localStorage (metadata, read synchronously so the dashboard paints
 * immediately) with IndexedDB as the overflow for documents that carry inline
 * image data URLs and would blow the ~5MB quota.
 *
 * A file is `{ name, doc }`. The document shape is exactly what
 * `persist.saveDoc` writes, so opening a file is just seeding the engine with
 * it — there is no second document format.
 */
import { blankPage, demoPage, node, uid } from "./memory";
import type { Page, XNode } from "./types";
import type { PersistedDoc } from "./persist";

export type DocSeed = Omit<PersistedDoc, "version">;

export interface FileMeta {
  id: string;
  name: string;
  /** Which template the file started from — drives the empty-state preview. */
  template: TemplateId;
  createdAt: number;
  editedAt: number;
  openedAt: number;
  /** Data URL preview of the current page, regenerated on save. */
  thumb?: string;
  /** Page and layer counts, shown in the file card's meta line. */
  pages: number;
  nodes: number;
  /** True when the file has prototype connections — the card gets a play chip. */
  prototyped?: boolean;
  /** Project/folder name; undefined means the file sits in Drafts. */
  project?: string;
  /** Set on the row created by migrating a pre-dashboard autosave. */
  legacy?: boolean;
  /** The bundled sample file, recreated when the store is empty. */
  demo?: boolean;
  trashed?: boolean;
}

const META_KEY = "x-native-files";
const DOC_PREFIX = "x-native-doc:";
let cache: FileMeta[] | null = null;

function readAll(): FileMeta[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(META_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    cache = Array.isArray(v) ? (v as FileMeta[]).filter((f) => f && typeof f.id === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function writeAll(list: FileMeta[]): void {
  cache = list;
  try {
    localStorage.setItem(META_KEY, JSON.stringify(list));
  } catch {
    /* metadata is a convenience index; the documents themselves are safe */
  }
}

/* -------------------------------------------------------------------------- */
/* document slots                                                             */
/* -------------------------------------------------------------------------- */

const docKey = (id: string) => `${DOC_PREFIX}${id}`;
const STORE = "x-file-docs";

function openIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("x-native", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbPut(id: string, doc: DocSeed): Promise<boolean> {
  return openIdb().then((db) => {
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(doc, id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  });
}

function idbGet(id: string): Promise<DocSeed | null> {
  return openIdb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve((req.result as DocSeed) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Persist a document. localStorage first (so a reload works without async),
 *  IndexedDB as the overflow when the payload is too big. */
export function writeDoc(id: string, doc: DocSeed): void {
  try {
    localStorage.setItem(docKey(id), JSON.stringify(doc));
    // Drop any stale IndexedDB copy so a later read can't prefer old bytes.
    idbPut(id, doc).catch(() => {});
  } catch {
    localStorage.removeItem(docKey(id));
    idbPut(id, doc).catch(() => {});
  }
}

/** Read a document. Sync path only; the IndexedDB fallback is async because a
 *  large document may have overflowed localStorage. */
export function readDocSync(id: string): DocSeed | null {
  try {
    const raw = localStorage.getItem(docKey(id));
    return raw ? (JSON.parse(raw) as DocSeed) : null;
  } catch {
    return null;
  }
}

export async function readDoc(id: string): Promise<DocSeed | null> {
  const local = readDocSync(id);
  if (local) return local;
  return (await idbGet(id)) ?? null;
}

/* -------------------------------------------------------------------------- */
/* metadata API                                                               */
/* -------------------------------------------------------------------------- */

const byRecent = (a: FileMeta, b: FileMeta) =>
  Math.max(b.openedAt, b.editedAt) - Math.max(a.openedAt, a.editedAt);

export function listFiles(includeTrashed = false): FileMeta[] {
  return readAll()
    .filter((f) => (includeTrashed ? true : !f.trashed))
    .sort(byRecent);
}

export function getFile(id: string): FileMeta | null {
  return readAll().find((f) => f.id === id) ?? null;
}

export function touchFile(id: string): void {
  const list = readAll();
  const f = list.find((x) => x.id === id);
  if (!f) return;
  f.openedAt = Date.now();
  writeAll(list);
}

export function renameFile(id: string, name: string): void {
  const list = readAll();
  const f = list.find((x) => x.id === id);
  if (!f || !name.trim()) return;
  f.name = name.trim().slice(0, 120);
  f.editedAt = Date.now();
  writeAll(list);
}

export function trashFile(id: string): void {
  const list = readAll();
  const f = list.find((x) => x.id === id);
  if (!f) return;
  f.trashed = true;
  f.editedAt = Date.now();
  writeAll(list);
}

export function restoreFile(id: string): void {
  const list = readAll();
  const f = list.find((x) => x.id === id);
  if (!f) return;
  f.trashed = false;
  writeAll(list);
}

export function deleteFile(id: string): void {
  writeAll(readAll().filter((f) => f.id !== id));
  try {
    localStorage.removeItem(docKey(id));
  } catch {
    /* nothing to drop */
  }
  openIdb()
    .then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
      } catch {
        /* best effort */
      }
    })
    .catch(() => {});
}

/** Update the index after a save: edited time, counts, thumbnail. */
export function saveFile(id: string, doc: DocSeed): void {
  const list = readAll();
  const f = list.find((x) => x.id === id);
  writeDoc(id, doc);
  if (!f) return;
  f.editedAt = Date.now();
  f.name = doc.fileName || f.name;
  f.pages = doc.pages.length;
  let nodes = 0;
  let prototyped = false;
  const walk = (n: XNode) => {
    nodes++;
    if (n.interactions?.length) prototyped = true;
    for (const c of n.children) walk(c);
  };
  for (const p of doc.pages) walk(p.root);
  f.nodes = Math.max(0, nodes - doc.pages.length);
  f.prototyped = prototyped;
  const thumb = previewFromDoc(doc);
  if (thumb) f.thumb = thumb;
  writeAll(list);
}

/** Read-modify-write on the metadata row, for callers that only change chrome-
 *  level facts (thumbnail) and must not race with an editor save. */
export function patchFile(id: string, patch: Partial<FileMeta>): void {
  const list = readAll();
  const f = list.find((x) => x.id === id);
  if (!f) return;
  Object.assign(f, patch);
  writeAll(list);
}

export function duplicateFile(id: string): FileMeta | null {
  const src = getFile(id);
  const doc = readDocSync(id);
  if (!src || !doc) return null;
  const copy = createFile({
    name: `${src.name} (copy)`,
    template: src.template,
    doc,
  });
  return copy;
}

export function createFile(
  opts: { name?: string; template?: TemplateId; doc?: DocSeed; id?: string; demo?: boolean } = {},
): FileMeta {
  const template = opts.template ?? "blank";
  const now = Date.now();
  const doc = opts.doc ?? docFromTemplate(template);
  const meta: FileMeta = {
    id: opts.id ?? uid("file"),
    demo: !!opts.demo,
    name: (opts.name ?? doc.fileName ?? "Untitled").slice(0, 120),
    template,
    createdAt: now,
    editedAt: now,
    openedAt: now,
    pages: doc.pages.length,
    nodes: 0,
  };
  let nodes = 0;
  const walk = (n: XNode) => {
    nodes++;
    for (const c of n.children) walk(c);
  };
  for (const p of doc.pages) walk(p.root);
  meta.nodes = Math.max(0, nodes - doc.pages.length);
  writeDoc(meta.id, doc);
  meta.thumb = previewFromDoc(doc) || undefined;
  const list = readAll();
  writeAll([meta, ...list]);
  return meta;
}

/* -------------------------------------------------------------------------- */
/* templates                                                                  */
/* -------------------------------------------------------------------------- */

export type TemplateId =
  | "blank"
  | "mobile"
  | "desktop"
  | "presentation"
  | "wireframe"
  | "prototype";

export const TEMPLATES: { id: TemplateId; label: string; hint: string }[] = [
  { id: "blank", label: "Design file", hint: "Empty canvas" },
  { id: "mobile", label: "Mobile app", hint: "393 × 852" },
  { id: "desktop", label: "Desktop web", hint: "1440 × 1024" },
  { id: "presentation", label: "Presentation", hint: "1920 × 1080" },
  { id: "wireframe", label: "Wireframe kit", hint: "1440 × 1024" },
  { id: "prototype", label: "Prototype flow", hint: "3 linked screens" },
];

function frame(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<XNode> = {},
): XNode {
  return node("frame", name, x, y, w, h, { fill: "#ffffff", overflow: "clip", ...extra });
}

function label(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  size = 14,
  color = "#0d1220",
  weight = 400,
): XNode {
  return node("text", name, x, y, w, h, { text, fontSize: size, fontWeight: weight, fill: color });
}

function box(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fill = "#eef1f6",
  r = 8,
): XNode {
  return node("rect", name, x, y, w, h, { fill, cornerRadii: [r, r, r, r] });
}

function pageWith(name: string, root: XNode): Page {
  const page = blankPage(name);
  page.root = root;
  return page;
}

/** Build the document a new file starts with. Mirrors Figma's "new file"
 *  templates: real frames at device sizes, already named and laid out. */
export function docFromTemplate(template: TemplateId): DocSeed {
  if (template === "blank") {
    return { fileName: "Untitled", pages: [blankPage()], components: [], styles: [], page: 0, zoom: 1, panX: 0, panY: 0, showRulers: false, showMinimap: false, showComments: false };
  }

  if (template === "presentation") {
    const slide = frame("Slide 01", 0, 0, 1920, 1080, { fill: "#0f1115" });
    slide.children = [
      label("Title", 160, 420, 1200, 120, "Design systems that ship", 88, "#ffffff", 700),
      label("Subtitle", 160, 560, 900, 60, "A working session with the product team", 28, "#9aa3b8"),
      box("Accent", 160, 660, 220, 8, "#6366f1", 4),
      box("Agenda card", 1300, 360, 460, 360, "#171a21", 24),
      label("Agenda", 1348, 412, 360, 32, "Agenda", 22, "#ffffff", 600),
      label("Agenda body", 1348, 460, 364, 200, "01 Foundations\n02 Tokens\n03 Components\n04 Handoff", 20, "#8f98ad"),
    ];
    const root = node("frame", "Page 1", 0, 0, 4000, 4000, { fill: "#00000000", overflow: "visible", showName: false, children: [slide] });
    return { fileName: "Untitled", pages: [pageWith("Slides", root)], components: [], styles: [], page: 0, zoom: 0.4, panX: 80, panY: 60, showRulers: false, showMinimap: false, showComments: false };
  }

  if (template === "wireframe") {
    const screen = frame("Desktop / Home", 0, 0, 1440, 1024, { fill: "#ffffff" });
    const rows: XNode[] = [
      box("Nav", 0, 0, 1440, 64, "#e6e9ef", 0),
      box("Logo", 32, 24, 96, 16, "#c8cddb", 4),
      box("Nav item", 760, 24, 72, 16, "#c8cddb", 4),
      box("Nav item 2", 856, 24, 72, 16, "#c8cddb", 4),
      box("CTA", 1288, 16, 120, 32, "#9aa3b8", 6),
      box("Hero", 32, 96, 1376, 320, "#dfe3ec", 12),
      label("Hero title", 96, 208, 640, 56, "Placeholder headline", 40, "#4b5567", 700),
      box("Hero body", 96, 280, 520, 16, "#c8cddb", 4),
      box("Hero body 2", 96, 308, 420, 16, "#c8cddb", 4),
    ];
    for (let i = 0; i < 3; i++) {
      const x = 32 + i * 464;
      rows.push(box(`Card ${i + 1}`, x, 456, 448, 300, "#eef1f6", 12));
      rows.push(box(`Card ${i + 1} image`, x + 24, 480, 400, 140, "#dfe3ec", 8));
      rows.push(box(`Card ${i + 1} title`, x + 24, 640, 220, 16, "#b8bfd0", 4));
      rows.push(box(`Card ${i + 1} body`, x + 24, 668, 380, 12, "#c8cddb", 4));
      rows.push(box(`Card ${i + 1} body 2`, x + 24, 690, 300, 12, "#c8cddb", 4));
    }
    rows.push(box("Footer", 32, 792, 1376, 192, "#dfe3ec", 12));
    screen.children = rows;
    const root = node("frame", "Page 1", 0, 0, 4000, 4000, { fill: "#00000000", overflow: "visible", showName: false, children: [screen] });
    return { fileName: "Untitled", pages: [pageWith("Wireframe", root)], components: [], styles: [], page: 0, zoom: 0.5, panX: 80, panY: 60, showRulers: false, showMinimap: false, showComments: false };
  }

  if (template === "desktop") {
    const screen = frame("Desktop / Home", 0, 0, 1440, 1024, { fill: "#f7f8fa" });
    const nav = frame("Nav", 0, 0, 1440, 72, { fill: "#ffffff" });
    nav.children = [
      label("Brand", 40, 26, 160, 20, "Aurora", 18, "#0d1220", 700),
      label("Link", 240, 28, 60, 16, "Product", 13, "#5a6172"),
      label("Link 2", 324, 28, 60, 16, "Pricing", 13, "#5a6172"),
      label("Link 3", 408, 28, 60, 16, "Docs", 13, "#5a6172"),
      box("CTA", 1240, 20, 160, 32, "#0d99ff", 8),
      label("CTA label", 1268, 28, 110, 16, "Get started", 13, "#ffffff", 600),
    ];
    const hero = frame("Hero", 40, 104, 1360, 320, { fill: "#0d1220", cornerRadii: [24, 24, 24, 24], overflow: "clip" });
    hero.children = [
      label("Hero title", 56, 88, 620, 96, "Ship design work, not files", 44, "#ffffff", 700),
      label("Hero body", 56, 196, 520, 48, "One workspace for design, prototype and handoff — with the whole team in it.", 15, "#9aa3b8"),
      box("Hero button", 56, 256, 148, 40, "#0d99ff", 10),
      box("Hero art", 880, 48, 424, 224, "#1b2130", 16),
    ];
    const cards: XNode[] = [];
    for (let i = 0; i < 3; i++) {
      const card = frame(`Card ${i + 1}`, 40 + i * 460, 456, 440, 260, {
        fill: "#ffffff",
        cornerRadii: [20, 20, 20, 20],
        effects: [{ kind: "dropShadow", x: 0, y: 6, blur: 24, color: "rgba(13,18,32,0.06)", visible: true, spread: 0 } as never],
      });
      card.children = [
        box(`Card ${i + 1} thumb`, 24, 24, 392, 120, ["#e8f5ff", "#eaf7ef", "#f3ecff"][i], 12),
        label(`Card ${i + 1} title`, 24, 164, 300, 24, ["Components", "Tokens", "Handoff"][i], 18, "#0d1220", 600),
        label(`Card ${i + 1} body`, 24, 196, 380, 40, "Describe what this part of the system does for the team.", 13, "#6b7280"),
      ];
      cards.push(card);
    }
    screen.children = [nav, hero, ...cards];
    const root = node("frame", "Page 1", 0, 0, 4000, 4000, { fill: "#00000000", overflow: "visible", showName: false, children: [screen] });
    return { fileName: "Untitled", pages: [pageWith("Web", root)], components: [], styles: [], page: 0, zoom: 0.5, panX: 80, panY: 60, showRulers: false, showMinimap: false, showComments: false };
  }

  if (template === "prototype") {
    const screens: XNode[] = [];
    const titles = ["Onboarding", "Browse", "Detail"];
    for (let i = 0; i < 3; i++) {
      const s = frame(`Screen ${i + 1} / ${titles[i]}`, i * 480, 0, 393, 852, { fill: "#ffffff", cornerRadii: [40, 40, 40, 40] });
      const btn = box(`Next ${i + 1}`, 24, 732, 345, 48, i === 2 ? "#10b981" : "#0d99ff", 24);
      btn.name = `Next button ${i + 1}`;
      const btnLabel = label(`Next label ${i + 1}`, 24, 748, 345, 18, i === 2 ? "Done" : "Continue", 14, "#ffffff", 600);
      btnLabel.x = 24;
      btnLabel.y = 747;
      btn.children = [btnLabel];
      s.children = [
        box("Status bar", 0, 0, 393, 44, "#f8fafc", 0),
        label("Time", 24, 14, 60, 16, "9:41", 13, "#0d1220", 600),
        label("Title", 24, 88, 300, 32, titles[i], 26, "#0d1220", 700),
        box("Card a", 24, 156, 345, 120, "#f1f3f7", 16),
        box("Card b", 24, 292, 345, 120, "#f1f3f7", 16),
        box("Card c", 24, 428, 345, 120, "#f1f3f7", 16),
        btn,
      ];
      screens.push(s);
    }
    // Wire the flow so the prototype tab has something to show immediately.
    const withLink = (src: XNode, dst: XNode) => {
      const btn = src.children.find((c) => c.name.startsWith("Next ")) ?? src.children[src.children.length - 1];
      btn.interactions = [
        { trigger: "onClick", action: "navigate", destination: dst.id, animation: "smart", duration: 300, delay: 0 },
      ];
    };
    withLink(screens[0], screens[1]);
    withLink(screens[1], screens[2]);
    const root = node("frame", "Page 1", 0, 0, 4000, 4000, {
      fill: "#00000000",
      overflow: "visible",
      showName: false,
      children: screens,
    });
    const page = pageWith("Prototype", root);
    page.flowStart = screens[0].id;
    return { fileName: "Untitled", pages: [page], components: [], styles: [], page: 0, zoom: 0.6, panX: 80, panY: 120, showRulers: false, showMinimap: false, showComments: false };
  }

  // mobile (default design-file template)
  const screen = frame("iPhone 16 Pro / Home", 0, 0, 393, 852, { fill: "#ffffff", cornerRadii: [40, 40, 40, 40] });
  screen.children = [
    box("Status bar", 0, 0, 393, 44, "#ffffff", 0),
    label("Time", 24, 14, 60, 16, "9:41", 13, "#0d1220", 600),
    box("Island", 147, 12, 100, 26, "#0d1220", 13),
    label("Title", 24, 88, 260, 32, "Good morning", 24, "#0d1220", 700),
    label("Subtitle", 24, 122, 260, 20, "3 tasks due today", 14, "#6b7280"),
    box("Search", 24, 164, 345, 44, "#f1f3f7", 12),
    label("Search label", 48, 178, 240, 16, "Search projects", 14, "#8b93a5"),
    box("Card", 24, 232, 345, 160, "#0d1220", 20),
    label("Card title", 48, 264, 240, 24, "Weekly review", 18, "#ffffff", 600),
    label("Card body", 48, 296, 260, 36, "Sync the design system checklist before Friday.", 13, "#9aa3b8"),
    box("Card button", 48, 344, 120, 30, "#0d99ff", 15),
  ];
  forApp(screen);
  const root = node("frame", "Page 1", 0, 0, 4000, 4000, { fill: "#00000000", overflow: "visible", showName: false, children: [screen] });
  return { fileName: "Untitled", pages: [pageWith("Mobile", root)], components: [], styles: [], page: 0, zoom: 0.9, panX: 80, panY: 40, showRulers: false, showMinimap: false, showComments: false };
}

/** The tab bar at the bottom of the mobile template — split out only to keep
 *  the list above readable. */
function forApp(screen: XNode): void {
  const bar = box("Tab bar", 0, 784, 393, 68, "#f8fafc", 0);
  const items = ["Home", "Search", "Library", "Profile"];
  const kids: XNode[] = [];
  items.forEach((t, i) => {
    const x = 24 + i * 92;
    kids.push(box(`Tab ${t} icon`, x + 18, 800, 20, 20, i === 0 ? "#0d99ff" : "#c3c9d6", 6));
    kids.push(label(`Tab ${t}`, x, 826, 56, 14, t, 11, i === 0 ? "#0d99ff" : "#8b93a5", i === 0 ? 600 : 400));
  });
  screen.children.push(bar, ...kids);
  screen.children.push(box("List row 1", 24, 412, 345, 68, "#f1f3f7", 16));
  screen.children.push(box("List row 2", 24, 496, 345, 68, "#f1f3f7", 16));
  screen.children.push(box("List row 3", 24, 580, 345, 68, "#f1f3f7", 16));
}

/** Turn an SVG/Sketch/.fig import into a document, so the dashboard can create
 *  a file from an import without first opening the editor. */
export function docFromImport(
  fileName: string,
  result: { nodes: { kind: string; name: string; x: number; y: number; w: number; h: number; fill?: string; fillVisible?: boolean; strokePaint?: string; strokeVisible?: boolean; strokeWidth?: number; opacity?: number; rotation?: number; cornerRadii?: [number, number, number, number]; path?: unknown; closed?: boolean; text?: string; fontSize?: number; fontWeight?: number; textAlign?: "left" | "center" | "right" }[] },
): DocSeed {
  const kids: XNode[] = [];
  for (const n of result.nodes) {
    const extra: Partial<XNode> = { name: n.name };
    if (n.fill !== undefined) extra.fill = n.fill;
    if (n.fillVisible !== undefined) extra.fillVisible = n.fillVisible;
    if (n.strokePaint !== undefined) extra.strokePaint = n.strokePaint;
    if (n.strokeVisible !== undefined) extra.strokeVisible = n.strokeVisible;
    if (n.strokeWidth !== undefined) extra.strokeWidth = n.strokeWidth;
    if (n.opacity !== undefined) extra.opacity = n.opacity;
    if (n.rotation !== undefined) extra.rotation = n.rotation;
    if (n.cornerRadii) extra.cornerRadii = n.cornerRadii;
    if (n.text !== undefined) extra.text = n.text;
    if (n.fontSize !== undefined) extra.fontSize = n.fontSize;
    if (n.fontWeight !== undefined) extra.fontWeight = n.fontWeight;
    if (n.textAlign !== undefined) extra.textAlign = n.textAlign;
    if (n.closed !== undefined) extra.closed = n.closed;
    if (Array.isArray(n.path)) extra.path = n.path as XNode["path"];
    kids.push(node(n.kind as XNode["kind"], n.name, Math.round(n.x), Math.round(n.y), Math.max(1, Math.round(n.w)), Math.max(1, Math.round(n.h)), extra));
  }
  const page = blankPage("Imported");
  page.root = node("frame", "Page 1", 0, 0, 4000, 4000, {
    fill: "#00000000",
    overflow: "visible",
    showName: false,
    children: kids,
  });
  return {
    fileName,
    pages: [page],
    components: [],
    styles: [],
    page: 0,
    zoom: 1,
    panX: 80,
    panY: 80,
    showRulers: false,
    showMinimap: false,
    showComments: false,
  };
}

/* -------------------------------------------------------------------------- */
/* previews                                                                   */
/* -------------------------------------------------------------------------- */

/** Paint a miniature of the document. Deliberately not the full renderer: the
 *  dashboard needs a recognisable shape language at 240×150, and doing it here
 *  means a file has a preview before it is ever opened. */
export function previewFromDoc(doc: DocSeed, w = 480, h = 300): string {
  if (typeof document === "undefined") return "";
  const page = doc.pages?.[doc.page ?? 0] ?? doc.pages?.[0];
  if (!page?.root) return "";
  const kids = page.root.children.filter((c) => c.visible !== false);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of kids) {
    minX = Math.min(minX, k.x);
    minY = Math.min(minY, k.y);
    maxX = Math.max(maxX, k.x + k.w);
    maxY = Math.max(maxY, k.y + k.h);
  }
  if (!Number.isFinite(minX)) return "";
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const pad = 16;
  const z = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const ox = (w - bw * z) / 2 - minX * z;
  const oy = (h - bh * z) / 2 - minY * z;

  const c: HTMLCanvasElement = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#f6f7f9";
  ctx.fillRect(0, 0, w, h);

  const paint = (n: XNode, px: number, py: number, depth: number) => {
    if (n.visible === false) return;
    const x = px + n.x * z;
    const y = py + n.y * z;
    const nw = n.w * z;
    const nh = n.h * z;
    if (x > w + 4 || y > h + 4 || x + nw < -4 || y + nh < -4) return;
    const fill = typeof n.fill === "string" && n.fill.length >= 7 && n.fillVisible !== false ? n.fill : "";
    if (n.kind === "text") {
      ctx.fillStyle = "rgba(120,128,146,0.55)";
      const lines = Math.max(1, Math.min(3, Math.round(nh / Math.max(1, (n.fontSize || 14) * z))));
      for (let i = 0; i < lines; i++) {
        const lw = i === lines - 1 ? nw * 0.55 : nw;
        ctx.fillRect(x, y + i * Math.max(2, 4), Math.max(2, lw), Math.max(1.5, Math.min(3, nh / lines - 1)));
      }
    } else if (fill) {
      const r = Math.min(6, Math.max(0, (n.cornerRadii?.[0] || 0) * z));
      ctx.fillStyle = fill;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, Math.max(1, nw), Math.max(1, nh), r);
      else ctx.rect(x, y, Math.max(1, nw), Math.max(1, nh));
      ctx.fill();
    }
    if (depth < 3) for (const ch of n.children) paint(ch, x, y, depth + 1);
  };
  for (const k of kids) paint(k, ox, oy, 0);

  return c.toDataURL("image/png");
}

/* -------------------------------------------------------------------------- */
/* misc helpers used by the dashboard                                         */
/* -------------------------------------------------------------------------- */

/** One-time upgrade: the product used to autosave a single anonymous
 *  document. Turn it into a Draft so nobody loses work by gaining a dashboard. */
export function migrateLegacyDoc(): FileMeta | null {
  if (readAll().some((f) => f.legacy)) return null;
  let doc: DocSeed | null = null;
  try {
    const raw = localStorage.getItem("x-native-document");
    doc = raw ? (JSON.parse(raw) as DocSeed) : null;
  } catch {
    doc = null;
  }
  if (!doc || !Array.isArray(doc.pages) || !doc.fileName) return null;
  const now = Date.now();
  const meta: FileMeta = {
    id: uid("file"),
    name: doc.fileName || "Untitled",
    template: "blank",
    createdAt: now,
    editedAt: now,
    openedAt: now,
    pages: doc.pages.length,
    nodes: 0,
    legacy: true,
  };
  writeDoc(meta.id, doc);
  meta.thumb = previewFromDoc(doc) || undefined;
  writeAll([meta, ...readAll()]);
  return meta;
}

export const DEMO_ID = "demo";

/** The store ships one sample file so a brand-new dashboard is not an empty
 *  grid. Recreated only when there are no files at all, so deleting it sticks. */
export function ensureDemoFile(): void {
  if (readAll().length) return;
  const page = demoPage();
  createFile({
    id: DEMO_ID,
    name: "Explore Store · prototype demo",
    template: "prototype",
    demo: true,
    doc: {
      fileName: "Explore Store · prototype demo",
      pages: [page],
      components: [],
      styles: [],
      page: 0,
      zoom: 0.75,
      panX: 40,
      panY: 20,
      showRulers: false,
      showMinimap: false,
      showComments: false,
    },
  });
}

export function relTime(ts: number): string {
  const d = Math.max(0, Date.now() - ts) / 1000;
  if (d < 45) return "just now";
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} hr ago`;
  const days = Math.round(d / 86400);
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
