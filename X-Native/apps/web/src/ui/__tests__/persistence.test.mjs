/** Persistence (Run 25, P0-2): a document must survive the trip to a file and
 *  back, the File menu must offer that trip, and a file too big for
 *  localStorage must still export.
 *
 *  Three things are pinned here, each of which was broken or absent:
 *
 *  1. **The round trip.** Save serialises the live document with its images
 *     inline; loading validates, hydrates and reopens it. The image is compared
 *     byte for byte, because "the shape came back" is not the claim — `asset:`
 *     refs would restore a rectangle with an empty picture on another machine.
 *  2. **The File menu.** The trigger exists in the chrome, opens a menu with
 *     both rows, and the Save row writes the JSON to the downloads folder — the
 *     blob is captured and parsed, so this is the real path and not a helper.
 *     The Open row reads a chosen file back through the same callback App uses.
 *  3. **The IndexedDB fallback.** `localCopyOf` must read through `readDoc`
 *     (localStorage, then the IndexedDB overflow), because a document with
 *     images is exactly the one that overflowed. jsdom has no IndexedDB, so the
 *     suite installs a small one — the code under test is the real store.
 *  4. **The autosave slot's own overflow.** The slot is a separate two-tier store
 *     with the same failure modes, and each of its three answers used to be wrong:
 *     quota reported "saved" (so the toast wired to it could never fire), the
 *     IndexedDB backup had no reader at all, and the validator still carried the
 *     10%–800% zoom range the engine had outgrown, resetting an extreme viewport to
 *     100% on reload. Section 5 pins all three, and the boot rescue that turns an
 *     overflow-only document into a file rather than losing it.
 *
 *  Sabotage log — each break applied to the source, this file re-run, then
 *  restored; the number after the arrow is how many assertions caught it. All eight
 *  were caught, and the last line is the break this round made in its own source
 *  while writing the fix — a comment rewritten on top of the call it documented,
 *  deleting the backup. tsc stayed clean, because an exported function nobody calls
 *  is not an unused local; the ordering pin is what noticed:
 *    - quota answered `"saved"` again (the shipped bug)             -> 2
 *    - the quota path left the stale slot in place                  -> 2
 *    - `loadDocHydrated` reads the slot only, never the backup      -> 2
 *    - the boot rescue dropped from `App.tsx` (sync adoption only)  -> 2
 *    - `zoom` back to `num(v.zoom, 0.1, 8, 1)`                      -> 4
 *    - the rescue wired but never announced                         -> 1
 *    - the adoption guard dropped from the shared helper            -> 1
 *    - the `saveDocToIdb` call deleted from `saveDoc`               -> 1
 *
 *  Run: vite-node src/ui/__tests__/persistence.test.mjs */
import { installDom } from "./domEnv.mjs";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const window = installDom();
const { document } = window;

/* ── a small IndexedDB ────────────────────────────────────────────────────────
 * jsdom does not ship one, and the fallback cannot be verified without it: the
 * point of the test is that the bytes come back out of the store, not that a
 * function was called. Only what the three stores use: `open` (with and without
 * a version), one store per database, `put`/`get`/`delete`, and the
 * request/transaction callbacks the callers set *after* calling. */
function installFakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  globalThis.indexedDB = {
    open(name, version) {
      let db = dbs.get(name);
      const created = !db;
      if (!db) {
        db = { version: version ?? 1, stores: new Map() };
        dbs.set(name, db);
      }
      const store = (n) => {
        if (!db.stores.has(n)) db.stores.set(n, new Map());
        return db.stores.get(n);
      };
      const handle = {
        get version() { return db.version; },
        objectStoreNames: { contains: (n) => db.stores.has(n) },
        createObjectStore: (n) => void store(n),
        close() {},
        transaction(name) {
          const map = store(name);
          const tx = { oncomplete: null, onerror: null, onabort: null, objectStore: () => ({
            put(value, key) {
              const r = { onsuccess: null, onerror: null, result: undefined };
              later(() => { map.set(key, value); r.onsuccess?.(); later(() => tx.oncomplete?.()); });
              return r;
            },
            get(key) {
              const r = { onsuccess: null, onerror: null, result: undefined };
              later(() => { r.result = map.get(key); r.onsuccess?.(); later(() => tx.oncomplete?.()); });
              return r;
            },
            delete(key) {
              map.delete(key);
              later(() => tx.oncomplete?.());
              return { onsuccess: null, onerror: null, result: undefined };
            },
          }) };
          return tx;
        },
      };
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: handle };
      later(() => {
        if (created) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return dbs;
}
installFakeIndexedDB();
// `createFile` paints a thumbnail through a canvas jsdom cannot provide.
window.HTMLCanvasElement.prototype.getContext = () => null;

const { MemoryEngine, find, node } = await import("../../engine/memory.ts");
const { isDocSeedLike } = await import("../../engine/files.ts");
const { localCopyOf, writeDoc, readDoc, readDocSync } = await import("../../engine/files.ts");
const { hydrateDoc } = await import("../../engine/assets.ts");
const { localCopyJson, localCopyName, readLocalCopy } = await import("../localCopy.ts");
const { subscribeToast } = await import("../toast.ts");
const { mountLeftPanel } = await import("./domEnv.mjs");
const { act } = await import("react");
const { closeTopEscape, escapeStack } = await import("../escape.ts");

/** A one-pixel PNG, as the editor holds it: inline, not an `asset:` ref. */
const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const docWithPhoto = () => ({
  fileName: "Photo study",
  pages: [
    {
      id: "page_1",
      name: "Page 1",
      root: node("frame", "Page 1", 0, 0, 2000, 2000, {
        fill: "#00000000",
        overflow: "visible",
        showName: false,
        children: [
          node("rect", "Photo", 120, 80, 320, 200, {
            fillType: "image",
            imageSrc: IMAGE,
            imageFit: "fill",
            fillOpacity: 0.8,
          }),
          node("rect", "Box", 520, 80, 120, 120, { fill: "#10b981" }),
        ],
      }),
      guides: [],
      comments: [],
    },
  ],
  components: [],
  styles: [],
  page: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  showRulers: false,
  showMinimap: false,
  showComments: false,
});

const toasts = [];
subscribeToast((m) => toasts.push(m));

/* ── 1. The round trip: save → clear → load → assert ─────────────────────── */
{
  const engine = new MemoryEngine(false, docWithPhoto());
  const json = localCopyJson(engine.toDoc());

  t("the saved copy is self-describing", JSON.parse(json).version === 1);
  t("images travel in the file, not as store refs", json.includes(IMAGE) && !json.includes("asset:"));

  // "Clear the engine state": a fresh engine over an empty document.
  const blank = new MemoryEngine(false, {
    fileName: "Untitled",
    pages: [{ id: "pg", name: "Page 1", root: node("frame", "Page 1", 0, 0, 2000, 2000, { children: [] }), guides: [], comments: [] }],
    components: [],
    styles: [],
    page: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    showRulers: false,
    showMinimap: false,
    showComments: false,
  });
  t("the cleared engine has no photo", !find(blank.snapshot().pages[0].root, "no-such-node") && blank.snapshot().pages[0].root.children.length === 0);

  const read = await readLocalCopy(json, "photo-study.x.json");
  t("the local copy validates and loads", read.ok, read.ok ? "" : read.error);
  if (read.ok) {
    const restored = new MemoryEngine(false, read.doc);
    const root = restored.snapshot().pages[0].root;
    const photo = root.children.find((c) => c.name === "Photo");
    const box = root.children.find((c) => c.name === "Box");
    t("the image-filled shape comes back", !!photo);
    t("...with the image data byte-identical", photo?.imageSrc === IMAGE, `${photo?.imageSrc?.slice(0, 32)}…`);
    t("...and its geometry and opacity intact", photo?.x === 120 && photo?.w === 320 && photo?.fillOpacity === 0.8, JSON.stringify([photo?.x, photo?.w, photo?.fillOpacity]));
    t("the other layer comes back too", box?.fill === "#10b981" && box?.x === 520);
    t("the document keeps its name", restored.snapshot().fileName === "Photo study");
    t("the reopened file is named after the copy", read.name === "Photo study", read.name);
  }
}

/* ── 2. Loading is defensive ─────────────────────────────────────────────── */
{
  const notJson = await readLocalCopy("{ this is not json", "x.json");
  t("a file that is not JSON is refused with a sentence", !notJson.ok && /not valid JSON/.test(notJson.error), JSON.stringify(notJson));
  const notDoc = await readLocalCopy(JSON.stringify({ hello: "world" }), "x.json");
  t("a JSON file that is not an X document is refused", !notDoc.ok && /not an X document/.test(notDoc.error), JSON.stringify(notDoc));
  const future = await readLocalCopy(JSON.stringify({ version: 99, ...docWithPhoto() }), "x.json");
  t("a document from a newer build is refused, not half-loaded", !future.ok && /version 99/.test(future.error), JSON.stringify(future));
  const noVersion = await readLocalCopy(JSON.stringify(docWithPhoto()), "handmade.x.json");
  t("a document written before the version field still opens", noVersion.ok && noVersion.name === "Photo study");
  t("an unnamed document falls back to the file name", (await readLocalCopy(JSON.stringify({ ...docWithPhoto(), fileName: "" }), "photo-study.x.json")).name === "photo-study");
  t("the download name is sanitised", localCopyName('a/b:c*d?"e').endsWith(".x.json") && !/[\\/:*?"<>|]/.test(localCopyName('a/b:c*d?"e')), localCopyName('a/b:c*d?"e'));
}

/* ── 3. The File menu ───────────────────────────────────────────────────── */
let opened = null;
const panel = await mountLeftPanel({ props: { onOpenLocalCopy: (name, doc) => void (opened = { name, doc }) } });
{
  const trigger = panel.one('button[aria-haspopup="menu"]');
  t("the File menu trigger is in the chrome", !!trigger, String(!!trigger));
  t("...and it is closed to start with", trigger?.getAttribute("aria-expanded") === "false", trigger?.getAttribute("aria-expanded"));

  await panel.click(trigger);
  const menu = panel.one('[role="menu"]');
  t("clicking it opens a menu", !!menu && trigger?.getAttribute("aria-expanded") === "true");
  const rows = panel.all('[role="menuitem"]').map((b) => b.textContent?.trim() ?? "");
  t("the menu offers Save local copy", rows.some((r) => /Save local copy/.test(r)), JSON.stringify(rows));
  t("the menu offers Open local copy", rows.some((r) => /Open local copy/.test(r)), JSON.stringify(rows));
  // Export and color profile management are part of the File menu.
  t("the menu offers Export assets", rows.some((r) => /Export assets/.test(r)), JSON.stringify(rows));
  t("the menu offers file color profile management", rows.some((r) => /File color profile/.test(r)), JSON.stringify(rows));
  t("the menu offers a preferred profile for new files", rows.some((r) => /Preferred profile/.test(r)), JSON.stringify(rows));
  t("all five file actions are present", rows.length === 5, JSON.stringify(rows));
  t("the keyboard starts on the first row", document.activeElement?.getAttribute("role") === "menuitem");
  t("the file picker exists and only accepts JSON", !!panel.one('input[type="file"]') && /json/.test(panel.one('input[type="file"]')?.getAttribute("accept") ?? ""), panel.one('input[type="file"]')?.getAttribute("accept"));

  // The panel's own document is the engine's: give it a name and a photo, so
  // the save row serialises a real picture and not an empty page.
  await panel.dispatch({ type: "setFileName", name: "Photo study" });
  await panel.dispatch({
    type: "add",
    kind: "rect",
    x: 120,
    y: 80,
    w: 320,
    h: 200,
    extra: { fillType: "image", imageSrc: IMAGE, imageFit: "fill" },
  });

  // Clicking Save writes the JSON: capture the blob the way the browser gets it.
  const urls = [];
  // The component resolves `URL` from the module scope, which in this runner is
  // Node's — so both names get the stub, and the blob the app really built is
  // what the assertions read.
  const realCreate = globalThis.URL.createObjectURL;
  const realRevoke = globalThis.URL.revokeObjectURL;
  const realClick = window.HTMLAnchorElement.prototype.click;
  globalThis.URL.createObjectURL = window.URL.createObjectURL = (blob) => {
    urls.push(blob);
    return "blob:persistence-test";
  };
  globalThis.URL.revokeObjectURL = window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {}; // jsdom cannot navigate
  let anchorName = "";
  try {
    const save = panel.all('[role="menuitem"]').find((b) => /Save local copy/.test(b.textContent ?? ""));
    Object.defineProperty(window.HTMLAnchorElement.prototype, "download", {
      configurable: true,
      set(v) { anchorName = v; },
      get() { return anchorName; },
    });
    await panel.click(save);
  } finally {
    globalThis.URL.createObjectURL = window.URL.createObjectURL = realCreate;
    globalThis.URL.revokeObjectURL = window.URL.revokeObjectURL = realRevoke;
    window.HTMLAnchorElement.prototype.click = realClick;
  }
  t("Save local copy downloads one file", urls.length === 1, String(urls.length));
  t("...named after the document", anchorName === "Photo study.x.json", anchorName);
  const downloaded = urls[0] ? await urls[0].text() : "";
  t("...whose bytes parse as a document", isDocSeedLike(JSON.parse(downloaded || "null")));
  t("...carrying the image", downloaded.includes("iVBORw0KGgo"), "");
  t("the menu closes once a row is chosen", !panel.one('[role="menu"]'));

  // Opening: hand the hidden input a real File and let the component read it.
  await panel.click(panel.one('button[aria-haspopup="menu"]'));
  const picker = panel.one('input[type="file"]');
  const saved = localCopyJson(docWithPhoto());
  const file = new window.File([saved], "photo-study.x.json", { type: "application/json" });
  Object.defineProperty(picker, "files", { configurable: true, value: [file] });
  await act(() => picker.dispatchEvent(new window.Event("change", { bubbles: true })));
  await tick();
  await tick();
  t("picking a local copy hands the document to the editor", !!opened && opened.name === "Photo study", JSON.stringify(opened?.name));
  t("...with its image resolved", opened?.doc?.pages?.[0]?.root?.children?.[0]?.imageSrc === IMAGE);

  // A file that is not ours is refused with a toast, and opens nothing.
  opened = null;
  const junk = new window.File(["{}"], "junk.json", { type: "application/json" });
  Object.defineProperty(picker, "files", { configurable: true, value: [junk] });
  const before = toasts.length;
  await act(() => picker.dispatchEvent(new window.Event("change", { bubbles: true })));
  await tick();
  t("a JSON file that is not a document is refused", opened === null);
  t("...and says why", toasts.length > before && /not an X document/.test(toasts[toasts.length - 1]), JSON.stringify(toasts.slice(before)));

  // Escape: the open menu owns the key in the app's one cascade (bindHotkeys is
  // its only caller), gets the press, and hands the caret back to the trigger.
  const trigger2 = panel.one('button[aria-haspopup="menu"]');
  t("the open menu owns Escape", escapeStack().includes("file-menu"), JSON.stringify(escapeStack()));
  await act(async () => {
    closeTopEscape();
  });
  t("Escape closes the menu", !panel.one('[role="menu"]'));
  t("...and the caret returns to the trigger", document.activeElement === trigger2, document.activeElement?.className);
  t("...and the menu releases the key", !escapeStack().includes("file-menu"), JSON.stringify(escapeStack()));
}
await panel.unmount();

/* ── 4. The IndexedDB fallback ───────────────────────────────────────────── */
{
  const doc = docWithPhoto();
  writeDoc("big-file", doc);
  // A document with images overflows localStorage: the file store drops the
  // local copy and keeps the IndexedDB one.
  window.localStorage.removeItem("x-native-doc:big-file");
  t("localStorage has nothing for this file", readDocSync("big-file") === null);

  const viaStore = await readDoc("big-file");
  t("readDoc still finds the bytes in IndexedDB", !!viaStore && viaStore.fileName === "Photo study");

  const copy = await localCopyOf("big-file");
  t("a file whose localStorage copy is gone still exports", !!copy, String(!!copy));
  t("...with its image resolved back to bytes", copy?.pages?.[0]?.root?.children?.[0]?.imageSrc === IMAGE);

  // The other half of the contract: a file this browser has never had.
  t("an unknown file exports nothing", (await localCopyOf("never-seen")) === null);

  // And the ref → bytes resolution a stored (dehydrated) document needs: the
  // store keeps `asset:` refs, a local copy must not.
  window.HTMLCanvasElement.prototype.getContext = () => null;
  const { putAsset, dehydrateDoc } = await import("../../engine/assets.ts");
  const ref = putAsset(IMAGE);
  const stored = dehydrateDoc(doc);
  t("the store's own copy carries a ref, not bytes", stored.pages[0].root.children[0].imageSrc === ref, stored.pages[0].root.children[0].imageSrc);
  writeDoc("ref-file", stored);
  const portable = await localCopyOf("ref-file");
  t("a local copy of a stored document resolves the ref", portable?.pages?.[0]?.root?.children?.[0]?.imageSrc === IMAGE, String(portable?.pages?.[0]?.root?.children?.[0]?.imageSrc).slice(0, 24));
  // …and the object the store handed back is not the one we rewrote.
  const stillRef = readDocSync("ref-file");
  t("resolving a ref does not rewrite the stored document", stillRef?.pages?.[0]?.root?.children?.[0]?.imageSrc === ref);

  const leftover = dehydrateDoc(doc);
  void hydrateDoc(leftover);
  t("hydrate leaves an inline image alone", leftover.pages[0].root.children[0].imageSrc === IMAGE);
}

/* ── 5. The slot's own overflow (batch 45 follow-up) ──────────────────────────
 * Sections 1-4 are about a *file*'s copy. The autosave slot is a different store
 * with the same two-tier shape, and all three of its safety claims used to be
 * broken at once: a quota failure answered "saved", the IndexedDB backup had no
 * reader, and the validator carried a zoom range the engine had outgrown. They are
 * tested together because they are one story — what happens to a document the
 * browser refuses to hold. */
{
  const { readFileSync } = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = (f) => readFileSync(path.join(HERE, "..", "..", "src", f), "utf8").replace(/^/, "");
  const persistSrc = readFileSync(path.join(HERE, "..", "..", "engine", "persist.ts"), "utf8");
  const appSrc = readFileSync(path.join(HERE, "..", "..", "App.tsx"), "utf8");
  const { ZOOM_MIN, ZOOM_MAX, clampZoom } = await import("../../engine/view.ts");
  const { saveDoc, loadDoc, loadDocHydrated, clearDoc, saveDocToIdb, loadDocFromIdb } =
    await import("../../engine/persist.ts");
  const { migrateLegacyDoc, migrateLegacyDocFromIdb, listFiles } = await import("../../engine/files.ts");
  void persistSrc; void src;

  const doc = docWithPhoto();
  const at = (zoom) => ({ ...doc, zoom });
  /** A slot copy that must beat whatever the backup holds, for the two-tier rule. */
  const newerSlot = { ...doc, fileName: "Newer in the slot" };

  // The range is the engine's, so widening it there cannot leave this behind.
  t("the slot keeps the engine's own zoom range at both ends",
    saveDoc(at(ZOOM_MIN)) === "saved" && loadDoc().doc?.zoom === ZOOM_MIN,
    String(loadDoc().doc?.zoom));
  void saveDoc(at(ZOOM_MAX));
  t("…including the far one", loadDoc().doc?.zoom === ZOOM_MAX, String(loadDoc().doc?.zoom));
  void saveDoc(at(ZOOM_MAX * 10));
  t("an extreme out of range narrows instead of resetting",
    loadDoc().doc?.zoom === ZOOM_MAX, String(loadDoc().doc?.zoom));
  void saveDoc(at(Number.NaN));
  t("and a value that is not a number is the one honest default",
    loadDoc().doc?.zoom === 1, String(loadDoc().doc?.zoom));
  // On the code, not the prose: the comment above the line names the old call on
  // purpose, and a regex that cannot tell the two apart fails for the wrong reason.
  t("the validator no longer writes a second range in a `num` call",
    !/zoom:\s*num\(v\.zoom/.test(persistSrc) && /zoom:\s*clampZoom\(/.test(persistSrc));
  t("…and agrees with the engine on what the extremes are",
    clampZoom(ZOOM_MIN) === ZOOM_MIN && clampZoom(ZOOM_MAX) === ZOOM_MAX);

  // Quota. The slot is left holding an older document, which is worse than empty.
  // jsdom's `Storage` is a named-property object: assigning `store.setItem = fn`
  // writes an *item* called "setItem" and leaves the prototype method alone, which
  // is how the first draft of these lines "proved" nothing. Swap the whole
  // `localStorage` global, delegating every method that must still work.
  const realStore = window.localStorage;
  const slot = "x-native-document";
  const useStore = (overrides) => {
    const store = {
      getItem: (k) => realStore.getItem(k),
      setItem: (k, v) => realStore.setItem(k, v),
      removeItem: (k) => realStore.removeItem(k),
      ...overrides,
    };
    for (const o of [globalThis, window]) {
      Object.defineProperty(o, "localStorage", { configurable: true, value: store });
    }
  };
  const restoreStore = () => {
    for (const o of [globalThis, window]) {
      Object.defineProperty(o, "localStorage", { configurable: true, value: realStore });
    }
  };
  const throwAs = (name) =>
    useStore({
      setItem: () => {
        const err = new Error("storage full");
        err.name = name;
        throw err;
      },
    });
  realStore.setItem(slot, JSON.stringify({ version: 1, ...at(1), fileName: "Yesterday" }));
  throwAs("QuotaExceededError");
  const quotaStatus = saveDoc(doc);
  restoreStore();
  t("a full localStorage answers quota, not saved", quotaStatus === "quota", quotaStatus);
  t("so the toast wired to it is reachable",
    /status === "quota"/.test(appSrc) && /too large to autosave/.test(appSrc));
  t("the stale slot is dropped rather than served as current",
    loadDoc().doc === null, JSON.stringify(loadDoc().doc?.fileName));
  // Two halves, and neither one leans on a timer. The *ordering* that makes a quota
  // failure survivable — the backup is issued before the slot is touched, so the
  // newest bytes are already durable when the slot write throws — is a property of
  // the source, pinned as text like the `theme.tsx` effect ordering. Whether a
  // reader then exists is behavioural, so it is asserted through the same function
  // with the write awaited: `saveDoc` fires the backup and forgets it, and an
  // assertion that waits for a fire-and-forget IDB write in jsdom is a flake.
  t("the backup is issued before the slot write, not after it",
    /saveDocToIdb\(fullDoc\)[\s\S]{0,240}localStorage\.setItem\(KEY/.test(persistSrc));
  await saveDocToIdb({ version: 1, ...doc });
  const rescued = await loadDocHydrated();
  t("a slot that is empty is not treated as an empty browser",
    loadDoc().doc === null && rescued.doc?.fileName === doc.fileName,
    String(rescued.doc?.fileName));
  // The reader is not a pass-through: the same `validate` guards it, so a backup
  // written by an older app is discarded instead of half-loaded.
  await saveDocToIdb({ version: 99, ...doc });
  realStore.setItem(slot, JSON.stringify({ version: 1, ...newerSlot }));
  t("a stale version in the backup is refused, not trusted", (await loadDocFromIdb()) === null);
  t("…and the hydrated read answers with the slot instead of reporting a win",
    (await loadDocHydrated()).doc?.fileName === "Newer in the slot",
    String((await loadDocHydrated()).doc?.fileName));
  await saveDocToIdb({ version: 1, ...doc, styles: undefined });
  t("…and repairs what it should, the way the slot read does",
    Array.isArray((await loadDocFromIdb())?.styles));
  t("…which is the only thing that ever read IndexedDB before",
    /await loadDocFromIdb\(\)/.test(persistSrc) && /await loadDocFromIdb\(\)/.test(
      readFileSync(path.join(HERE, "..", "..", "engine", "files.ts"), "utf8")));

  // The rule that lets the loader pick without a timestamp: a present slot is never
  // older than the backup, because a failed slot write deletes the slot.
  realStore.setItem(slot, JSON.stringify({ version: 1, ...newerSlot }));
  const winner = await loadDocHydrated();
  t("when both tiers hold a document, the slot answers",
    winner.doc?.fileName === "Newer in the slot", String(winner.doc?.fileName));

  throwAs("NS_ERROR_DOM_QUOTA_REACHED");
  const mozStatus = saveDoc(doc);
  restoreStore();
  t("the Firefox spelling is the same answer", mozStatus === "quota", mozStatus);
  realStore.setItem(slot, JSON.stringify({ version: 1, ...at(1), fileName: "Keep me" }));
  throwAs("SecurityError");
  const errStatus = saveDoc(doc);
  restoreStore();
  t("a failure that is not quota says error and keeps what was there",
    errStatus === "error" && loadDoc().doc?.fileName === "Keep me",
    `${errStatus} / ${loadDoc().doc?.fileName}`);

  // The boot rescue: a document only IndexedDB holds must still become a file.
  clearDoc();
  t("a cleared slot really is empty", loadDoc().doc === null);
  // `clearDoc`'s IndexedDB delete is fire-and-forget on purpose — a browser being
  // told to forget its copy has nothing to hand back — so the claim pinned here is
  // that it reaches for both tiers at all, not that a timer has run by now.
  t("…and the clear reaches the backup too, not only the slot",
    /localStorage\.removeItem\(KEY\);[\s\S]{0,240}delete\(IDB_KEY\)/.test(persistSrc));
  t("…and the sync adoption has nothing to work with", migrateLegacyDoc() === null);
  await saveDocToIdb({ version: 1, ...doc });
  const n0 = listFiles(true).filter((f) => f.legacy).length;
  const meta = await migrateLegacyDocFromIdb();
  t("the overflow copy is adopted as a file, not left in the store",
    meta?.legacy === true && meta.name === doc.fileName, JSON.stringify(meta?.name));
  t("adoption adds exactly one file", listFiles(true).filter((f) => f.legacy).length === n0 + 1);
  t("and the adopted file reads back with its photo intact",
    (await readDoc(meta.id))?.pages?.[0]?.root?.children?.[0]?.imageSrc === IMAGE);
  t("a second boot adopts nothing", (await migrateLegacyDocFromIdb()) === null &&
    listFiles(true).filter((f) => f.legacy).length === n0 + 1);
  t("the editor calls the rescue where the sync one runs",
    /migrateLegacyDoc\(\);[\s\S]{0,400}migrateLegacyDocFromIdb\(\)/.test(appSrc));
  // A file appearing on the dashboard with no explanation is its own bug report:
  // the slot was empty, then it was not, and nothing said why.
  t("…and the recovery is announced rather than silently present",
    /migrateLegacyDocFromIdb\(\)[\s\S]{0,200}toastMsg\(/.test(appSrc));
  // Both readers share one guard, so neither can double up on a later boot. The
  // document has to be put back first — `clearDoc` above is what a real boot would
  // *not* have done — because an unguarded sync adoption of it would mint a second
  // Draft for work that is already a file.
  realStore.setItem(slot, JSON.stringify({ version: 1, ...newerSlot }));
  t("the sync adoption respects the same guard, so a boot never doubles up",
    migrateLegacyDoc() === null && listFiles(true).filter((f) => f.legacy).length === n0 + 1,
    `${listFiles(true).filter((f) => f.legacy).length - n0} legacy files after a second boot`);
}

console.log(`persistence: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
