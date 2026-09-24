/**
 * Where the bytes of an imported image live.
 *
 * A document used to carry its images inline: every node held a `data:` URL,
 * and that string went into the JSON serialised on every autosave. Fifty
 * photographs of a megabyte each made the document 50MB - stringifying it cost
 * ~190ms per save (measured in the browser), it never fitted the ~5MB
 * localStorage budget, and the whole thing was then written a second time by
 * the per-file store. Pixels do not belong in a document; a reference does.
 *
 * In memory nothing changes: a node's `imageSrc` is still the data URL, so the
 * painter, the exporters, the importers and the fill picker are untouched. The
 * swap happens only at the persistence boundary - `asset:<id>` goes into the
 * document, the bytes go to IndexedDB, which has room for them.
 *
 * Loading is the mirror image: refs are resolved back to data URLs before the
 * document reaches the engine, because everything downstream expects the
 * picture to be there. Old documents, with their data URLs still inline, load
 * exactly as they did; the first save moves them into the store.
 */
import type { ComponentMaster, Page, XNode } from "./types";

const DB_NAME = "x-native-assets";
const STORE = "assets";
export const ASSET_PREFIX = "asset:";

/** Inline image data the painter can use, keyed by asset id. */
const urls = new Map<string, string>();
/** The reverse map, so re-saving a document does not re-hash its images. The
 *  data URL is the key: the same string object is already in memory, so this
 *  costs a reference, not a copy. */
const ids = new Map<string, string>();

export const isAssetRef = (s: string | undefined): boolean =>
  !!s && s.startsWith(ASSET_PREFIX);

export const assetId = (ref: string): string => ref.slice(ASSET_PREFIX.length);

/**
 * A short, stable id for a data URL. A full hash of a 3MB string on every save
 * would undo the point of this module, so the fingerprint samples the string -
 * its length, its head and its tail - which is exact for distinct images and
 * costs the same whether the image is 4KB or 4MB.
 */
function fingerprint(data: string): string {
  let h = 0x811c9dc5;
  const mix = (c: number) => {
    h ^= c;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(data.length);
  const head = Math.min(data.length, 2048);
  for (let i = 0; i < head; i++) mix(data.charCodeAt(i));
  for (let i = Math.max(0, data.length - 2048); i < data.length; i++) mix(data.charCodeAt(i));
  return h.toString(36);
}

/** Remember an image and get the ref to store in its place. */
export function putAsset(dataUrl: string): string {
  const known = ids.get(dataUrl);
  if (known) return known;
  const base = `${ASSET_PREFIX}${fingerprint(dataUrl)}`;
  let ref = base;
  for (let n = 1; urls.has(assetId(ref)) && urls.get(assetId(ref)) !== dataUrl; n++) {
    ref = `${base}-${n}`;
  }
  const id = assetId(ref);
  urls.set(id, dataUrl);
  ids.set(dataUrl, ref);
  void idbPut(id, dataUrl);
  return ref;
}

/**
 * Write an imported image straight to the store, before any save happens.
 * The autosave that follows stores a ref, and `pagehide` cannot lose bytes the
 * store already has.
 */
export function rememberImage(dataUrl: string | undefined): void {
  if (!dataUrl || isAssetRef(dataUrl)) return;
  putAsset(dataUrl);
}

/* ---------------------------------------------------------------- IndexedDB */

let db: Promise<IDBDatabase | null> | null = null;

/** Open, creating the object store if the database does not have it.
 *
 *  The version is not a constant but "whatever is there, plus one when the
 *  store is missing". A fixed version is not enough: a database left at that
 *  version without the store - by an interrupted first run, or by another
 *  script that opened the same name - would be opened successfully and then
 *  fail every write, and a version bump would be blocked by the connection
 *  that is already open. So a connection that cannot see the store is closed
 *  and replaced by a newer one, which is exactly the upgrade path IndexedDB
 *  expects. */
function openDb(): Promise<IDBDatabase | null> {
  if (db) return db;
  db = new Promise((resolve) => {
    const fail = () => resolve(null);
    try {
      // No version: whatever exists, at whatever version it is.
      const probe = indexedDB.open(DB_NAME);
      probe.onupgradeneeded = () => {
        const d = probe.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      probe.onerror = fail;
      probe.onblocked = fail;
      probe.onsuccess = () => {
        const first = probe.result;
        if (first.objectStoreNames.contains(STORE)) {
          resolve(first);
          return;
        }
        const next = first.version + 1;
        first.close();
        const req = indexedDB.open(DB_NAME, next);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = fail;
        req.onblocked = fail;
      };
    } catch {
      fail();
    }
  });
  return db;
}

async function idbPut(id: string, dataUrl: string): Promise<void> {
  const d = await openDb();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(dataUrl, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbGet(idsWanted: string[]): Promise<void> {
  if (!idsWanted.length) return;
  const d = await openDb();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      for (const id of idsWanted) {
        const req = store.get(id);
        req.onsuccess = () => {
          if (typeof req.result === "string") urls.set(id, req.result);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/* ------------------------------------------------------------- the two ends */

/** Refs in a tree that the in-memory cache cannot resolve yet. */
function missingRefs(node: XNode, out: Set<string>): void {
  if (isAssetRef(node.imageSrc) && !urls.has(assetId(node.imageSrc!))) out.add(assetId(node.imageSrc!));
  for (const c of node.children) missingRefs(c, out);
}

function allRefs(doc: { pages: Page[]; components: ComponentMaster[] }): Set<string> {
  const out = new Set<string>();
  for (const p of doc.pages) missingRefs(p.root, out);
  for (const c of doc.components) missingRefs(c.node, out);
  return out;
}

/**
 * Fill every `asset:` ref in a document with the image it names, in place. Run
 * this before handing a stored document to the engine.
 */
export async function hydrateDoc(doc: { pages: Page[]; components: ComponentMaster[] }): Promise<number> {
  const missing = [...allRefs(doc)];
  if (missing.length) await idbGet(missing);
  let unresolved = 0;
  const fix = (n: XNode) => {
    if (isAssetRef(n.imageSrc)) {
      const url = urls.get(assetId(n.imageSrc!));
      if (url) n.imageSrc = url;
      else unresolved++;
    }
    for (const c of n.children) fix(c);
  };
  for (const p of doc.pages) fix(p.root);
  for (const c of doc.components) fix(c.node);
  return unresolved;
}

/**
 * A copy of the document with every inline image replaced by its ref, for
 * storage. The engine's own tree is never touched - `toDoc()` hands back live
 * nodes, and turning their pictures into refs in place would blank the canvas.
 */
export function dehydrateDoc<T extends { pages: Page[]; components: ComponentMaster[] }>(doc: T): T {
  const copyNode = (n: XNode): XNode => {
    const children = n.children.map(copyNode);
    if (!n.imageSrc || isAssetRef(n.imageSrc)) return { ...n, children } as XNode;
    return { ...n, imageSrc: putAsset(n.imageSrc), children } as XNode;
  };
  return {
    ...doc,
    pages: doc.pages.map((p) => ({ ...p, root: copyNode(p.root) })),
    components: doc.components.map((c) => ({ ...c, node: copyNode(c.node) })),
  };
}

/** How many assets this session is holding, for diagnostics and tests. */
export function assetCount(): number {
  return urls.size;
}

/** Test seam: forget everything, so a case can start from a cold cache. */
export function resetAssets(): void {
  urls.clear();
  ids.clear();
}
