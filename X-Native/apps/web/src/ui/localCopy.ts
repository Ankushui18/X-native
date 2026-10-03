/**
 * The local copy: the whole document as one portable JSON file.
 *
 * Figma's File ▸ Save local copy writes a file you can reopen anywhere. Until
 * this existed the only way out of the editor was the browser's own storage,
 * and the only JSON export lived three clicks deep in the Dashboard's row menu.
 * This module owns the format — `saveLocalCopy` writes it, `readLocalCopy`
 * validates and hydrates it — and the Dashboard's "Export a copy" reads through
 * the same two functions, so a file saved from the editor and one exported from
 * the Dashboard cannot drift apart.
 *
 * Two decisions worth naming:
 *
 * - **Images stay inline.** Autosave stores `asset:` refs (see `assets.ts`) so a
 *   fifty-photo document fits its quota; a *local copy* has to open on a machine
 *   that has never seen this browser's IndexedDB, so the bytes travel in the
 *   file. That is the difference between the two writers, and why this one
 *   serialises the engine's live document rather than a dehydrated one.
 * - **The version is written, and read leniently.** Files written before the
 *   field existed still open; a file from a newer build is refused with a
 *   sentence rather than half-loaded.
 */
import { hydrateDoc } from "../engine/assets";
import { isDocSeedLike, type DocSeed } from "../engine/files";
import type { Engine } from "../engine/types";
import { toast } from "./toast";

/** The format this build writes, and the only one it promises to read. */
export const LOCAL_COPY_VERSION = 1;

/** The download name: the file's own name minus what a filesystem refuses, with
 *  the `.x.json` extension the Dashboard importer already recognises. */
export function localCopyName(fileName: string): string {
  const base = (fileName || "Untitled")
    .replace(/[\\/:*?"<>|]/g, "-")
    // Control characters would survive into a file name on some platforms.
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 120);
  return `${base || "Untitled"}.x.json`;
}

/** The bytes of a local copy. */
export function localCopyJson(doc: DocSeed): string {
  return JSON.stringify({ version: LOCAL_COPY_VERSION, ...doc }, null, 2);
}

/** Write bytes to the user's downloads folder. */
export function downloadJson(name: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Save the live document as a local copy, and say so. Returns the name written,
 *  so a caller — or a test — can see what landed in the downloads folder. */
export function saveLocalCopy(engine: Engine, fileName: string): string {
  const name = localCopyName(fileName);
  downloadJson(name, localCopyJson(engine.toDoc() as DocSeed));
  toast(`Local copy saved · ${name}`);
  return name;
}

export type LocalCopyRead =
  | { ok: true; name: string; doc: DocSeed; unresolved: number }
  | { ok: false; error: string };

/** Validate a local copy and resolve its image refs to bytes. Never throws:
 *  every failure comes back as a sentence the caller can show. */
export async function readLocalCopy(text: string, fileName = ""): Promise<LocalCopyRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not valid JSON" };
  }
  if (!isDocSeedLike(parsed)) return { ok: false, error: "That file is not an X document" };
  const raw = parsed as DocSeed & { version?: number };
  if (raw.version !== undefined && raw.version !== LOCAL_COPY_VERSION) {
    return {
      ok: false,
      error: `That file is a version ${raw.version} document · this build opens version ${LOCAL_COPY_VERSION}`,
    };
  }
  // A private copy: hydration rewrites `imageSrc` in place, and the object we
  // were handed belongs to the caller.
  const doc = JSON.parse(JSON.stringify(raw)) as DocSeed & { version?: number };
  delete doc.version;
  const unresolved = await hydrateDoc(doc);
  const named =
    (doc.fileName || "").trim() ||
    fileName.replace(/\.x\.json$/i, "").replace(/\.json$/i, "").trim() ||
    "Untitled";
  return { ok: true, name: named, doc, unresolved };
}
