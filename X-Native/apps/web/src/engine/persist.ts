import type { ComponentMaster, Page, SharedStyle } from "./types";

/** Bump when the persisted shape changes incompatibly. A mismatch is discarded
 *  rather than migrated blindly, so a stale document can never half-load. */
const VERSION = 1;
const KEY = "x-native-document";

/** Only the document and the viewport are persisted. Transient interaction
 *  state (current tool, selection, present mode, open comment) is deliberately
 *  excluded: restoring a session mid-gesture is confusing, and Figma likewise
 *  reopens a file with nothing selected. */
export interface PersistedDoc {
  version: number;
  fileName: string;
  pages: Page[];
  components: ComponentMaster[];
  styles: SharedStyle[];
  page: number;
  zoom: number;
  panX: number;
  panY: number;
  showRulers: boolean;
  showMinimap: boolean;
  showComments: boolean;
}

export interface LoadResult {
  doc: PersistedDoc | null;
  /** True when something was stored but could not be used, so the caller can
   *  tell the user their work was replaced by a fresh document. */
  corrupt: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Structural validation. Anything failing this is treated as corrupt and the
 *  app falls back to a clean document instead of crashing on first render. */
function validate(v: unknown): PersistedDoc | null {
  if (!isObj(v)) return null;
  if (v.version !== VERSION) return null;
  if (typeof v.fileName !== "string") return null;
  if (!Array.isArray(v.pages) || v.pages.length === 0) return null;
  for (const p of v.pages) {
    if (!isObj(p) || !isObj(p.root) || typeof p.name !== "string") return null;
    if (!Array.isArray((p.root as Record<string, unknown>).children)) return null;
  }
  if (!Array.isArray(v.components)) return null;
  // Documents written before shared styles have no array; give them one so
  // callers never have to null-check it.
  if (!Array.isArray(v.styles)) v.styles = [];
  const num = (x: unknown, lo: number, hi: number, dflt: number) =>
    typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : dflt;
  const pages = v.pages as Page[];
  // Pages written before comments existed have no `comments` array; give them
  // one so callers never have to null-check it.
  for (const p of pages) {
    if (!Array.isArray(p.comments)) p.comments = [];
    // Pages written before ruler guides existed have no array.
    if (!Array.isArray(p.guides)) p.guides = [];
  }
  return {
    version: VERSION,
    fileName: v.fileName,
    pages,
    components: v.components as ComponentMaster[],
    styles: v.styles as SharedStyle[],
    page: num(v.page, 0, pages.length - 1, 0),
    zoom: num(v.zoom, 0.1, 8, 1),
    panX: num(v.panX, -1e7, 1e7, 0),
    panY: num(v.panY, -1e7, 1e7, 0),
    showRulers: v.showRulers === true,
    showMinimap: v.showMinimap === true,
    showComments: v.showComments === true,
  };
}

export function loadDoc(): LoadResult {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { doc: null, corrupt: false }; // storage unavailable (private mode)
  }
  if (!raw) return { doc: null, corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: null, corrupt: true };
  }
  const doc = validate(parsed);
  if (!doc) {
    // A version bump is an expected discard, not corruption worth reporting.
    const known = isObj(parsed) && typeof parsed.version === "number" && parsed.version !== VERSION;
    return { doc: null, corrupt: !known };
  }
  return { doc, corrupt: false };
}

export type SaveStatus = "saved" | "quota" | "error";

const IDB_NAME = "x-native-db";
const IDB_STORE = "documents";
const IDB_KEY = "current";

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveDocToIdb(doc: PersistedDoc): Promise<boolean> {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(doc, IDB_KEY);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function loadDocFromIdb(): Promise<PersistedDoc | null> {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(IDB_KEY);
      req.onsuccess = () => {
        const validated = validate(req.result);
        resolve(validated);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function saveDoc(doc: Omit<PersistedDoc, "version">): SaveStatus {
  if (suppressed) return "saved";
  const fullDoc: PersistedDoc = { version: VERSION, ...doc };
  // Back up to IndexedDB for unlimited quota storage (handles documents with heavy base64 images)
  saveDocToIdb(fullDoc).catch(() => {});

  try {
    localStorage.setItem(KEY, JSON.stringify(fullDoc));
    return "saved";
  } catch (err) {
    // Images are stored inline as data URLs, so a large document can exceed the
    // ~5MB localStorage budget. IndexedDB handles multi-hundred-MB storage.
    const quota =
      isObj(err) &&
      (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
    return quota ? "saved" : "error";
  }
}

/** Set by clearDoc so the pagehide flush during the subsequent reload cannot
 *  immediately write the in-memory document straight back out. */
let suppressed = false;

export function saveSuppressed(): boolean {
  return suppressed;
}

export function clearDoc(): void {
  suppressed = true;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing useful to do */
  }
  openIdb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
    } catch {}
  }).catch(() => {});
}
