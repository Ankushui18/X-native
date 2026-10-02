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
 *
 *  Run: vite-node src/ui/__tests__/persistence.test.mjs */
import { installDom } from "./domEnv.mjs";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const tick = () => new Promise((r) => setTimeout(r, 0));
// Async hydration (file read -> IndexedDB image resolve -> callback) can take
// more than two macrotasks in jsdom; poll instead of assuming a fixed count.
const waitFor = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await tick();
  }
  return pred();
};

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
  await waitFor(() => !!opened);
  t("picking a local copy hands the document to the editor", !!opened && opened.name === "Photo study", JSON.stringify(opened?.name));
  t("...with its image resolved", opened?.doc?.pages?.[0]?.root?.children?.[0]?.imageSrc === IMAGE);

  // A file that is not ours is refused with a toast, and opens nothing.
  opened = null;
  const junk = new window.File(["{}"], "junk.json", { type: "application/json" });
  Object.defineProperty(picker, "files", { configurable: true, value: [junk] });
  const before = toasts.length;
  await act(() => picker.dispatchEvent(new window.Event("change", { bubbles: true })));
  await waitFor(() => toasts.length > before);
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

console.log(`persistence: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
