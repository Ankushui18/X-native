/* "New file…" has to replace the file's own stored document.
 *
 * The command used to call clearDoc(), which only clears the legacy autosave
 * slot (x-native-document) before reloading. The per-file copy the editor
 * writes on every autosave (x-native-doc:<id>) stayed behind, and boot prefers
 * it - so the reload restored the very document the user had just confirmed
 * deleting, and the flush on the way out rewrote the legacy slot too.
 *
 * These lock both halves of the repair: replacing the stored document, and
 * suppressing the in-flight save so it cannot put the discarded file back.
 */
import { strict as A } from "node:assert";

// Minimal localStorage: engine storage is guarded with try/catch, so a stub is
// enough and nothing here needs a DOM.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const { clearDoc, loadDoc, saveDoc, saveSuppressed } = await import("../persist.ts");
const { createFile, docFromTemplate, readDocSync, saveFile } = await import("../files.ts");
const { node } = await import("../memory.ts");

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; if (!ok) console.log(`not ok - ${name}`); };

// A drawn document, the shape the editor autosaves.
const drawn = {
  ...docFromTemplate("blank"),
  fileName: "Demo",
  pages: [
    {
      id: "page_1",
      name: "Page 1",
      root: node("frame", "Page 1", 0, 0, 4000, 4000, {
        fill: "#00000000",
        overflow: "visible",
        showName: false,
        children: [node("rect", "Rectangle 1", 10, 10, 100, 100, { fill: "#10b981" })],
      }),
    },
  ],
};

// 1. The per-file slot is what the editor restores from, so replacing it is
//    what makes "New file" true rather than cosmetic.
const meta = createFile({ name: "Demo", template: "blank", id: "file_demo_1" });
saveFile(meta.id, drawn);
t("saveFile stores the drawn document", (readDocSync(meta.id)?.pages?.[0]?.root?.children?.length ?? -1) === 1);

// What the editor does for "New file": a blank document that keeps the name.
const blank = { ...docFromTemplate("blank"), fileName: meta.name };
saveFile(meta.id, blank);
const after = readDocSync(meta.id);
t("saving a blank document replaces the drawn one", (after?.pages?.[0]?.root?.children?.length ?? -1) === 0);
t("the filename is kept, so the file is not anonymous", after?.fileName === "Demo");
t("metadata follows the blank document", meta.pages === 1 && meta.nodes === 0);

// 2. Nothing may write the discarded document back on the way to the reload.
clearDoc();
t("clearDoc suppresses further autosaves", saveSuppressed() === true);
saveDoc(drawn);
t("a suppressed save writes nothing to the legacy slot", loadDoc().doc === null);

console.log(`files: ${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
