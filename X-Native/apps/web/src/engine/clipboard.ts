/**
 * System clipboard bridge.
 *
 * Two directions, one module:
 *
 * - **Out** (`writeClipboard`): a copy in this app has to reach the OS
 *   clipboard, or ⌘V in another tab, another document or another program has
 *   nothing to read. `text/html` carries the layers twice over — once as this
 *   app's own base64 payload (full fidelity, including everything the SVG
 *   exporter cannot express) and once as plain SVG, which is what a browser, a
 *   deck or third-party viewer will render. `text/plain` carries the words.
 * - **In** (`parseClipboard`): the paste ladder. The clipboard carries scene data as a
 *   base64 `fig-kiwi` buffer in `data-buffer`, so an imported copy decodes
 *   through the same importer as a dropped `.fig` file and arrives as editable
 *   layers rather than a flat picture. Below that: our own payload, raw SVG,
 *   files (a screenshot, an image, a `.fig`/`.svg`/`.sketch` from the Finder)
 *   and finally plain text, which becomes a text layer.
 *
 * Everything here is DOM-light on purpose: the parsers take a structural
 * `ClipboardSource` rather than a `DataTransfer`, so the parity tests can feed
 * them recorded clipboard data.
 */

import type { XNode } from "./types";

/** Write text to the system clipboard without ever surfacing an unhandled
 *  rejection. `navigator.clipboard.writeText` rejects when the document is not
 *  focused or the permission is denied, and `void promise` suppresses the value
 *  but not the rejection — which showed up as a NotAllowedError page error.
 *  Falls back to a hidden textarea + execCommand where the async API is
 *  unavailable, so "Copy as code" still works in those contexts. */
export function copyText(text: string): void {
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      /* Clipboard is genuinely unavailable; callers still show their toast. */
    }
  };
  const api = navigator.clipboard;
  if (!api?.writeText) {
    fallback();
    return;
  }
  api.writeText(text).catch(fallback);
}

/* ------------------------------------------------------------------ base64 */

/** base64 of arbitrary bytes. `btoa` only takes a binary string, and building
 *  one with `String.fromCharCode(...bytes)` blows the argument list on a large
 *  scene buffer, so it is chunked. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Inverse of `bytesToBase64`. Whitespace is ignored because a base64 string
 *  that travelled through an HTML attribute is often re-wrapped at 76 columns. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/* ------------------------------------------------------- this app's payload */

/** The attribute this app stamps into `text/html`. a base64
 *  string on an otherwise empty element — is reused deliberately: custom MIME
 *  types do not survive the trip through the OS clipboard on every platform,
 *  and HTML does. */
export const NATIVE_ATTR = "data-x-native";
/** Bumped if the payload shape changes, so an older reader can say so instead
 *  of half-importing. */
export const NATIVE_VERSION = 1;

export interface NativeClipPayload {
  version: number;
  /** Where the copy came from, for the paste toast and for diagnostics. */
  source?: string;
  copiedAt?: number;
  nodes: XNode[];
}

/** `text/html` for a copy of `nodes`. `svg` is the human-readable rendering of
 *  the same layers; it may be empty when the exporter could not produce one. */
export function nativeClipHtml(nodes: XNode[], svg: string, source?: string): string {
  const payload: NativeClipPayload = {
    version: NATIVE_VERSION,
    copiedAt: Date.now(),
    ...(source ? { source } : {}),
    nodes,
  };
  const b64 = bytesToBase64(utf8(JSON.stringify(payload)));
  return (
    `<meta charset="utf-8"><span ${NATIVE_ATTR}="${b64}" ` +
    `data-x-native-version="${NATIVE_VERSION}"></span>${svg}`
  );
}

/** The layers out of our own `text/html`, or null when the clipboard is not
 *  ours. Anything that does not parse is null rather than a throw: a paste must
 *  fall through to the next rung of the ladder, never fail loudly. */
export function nativeClipFromHtml(html: string): XNode[] | null {
  const raw = attrOf(html, NATIVE_ATTR);
  if (!raw) return null;
  try {
    const payload = JSON.parse(fromUtf8(base64ToBytes(raw))) as Partial<NativeClipPayload>;
    if (!payload || !Array.isArray(payload.nodes) || !payload.nodes.length) return null;
    return payload.nodes as XNode[];
  } catch {
    return null;
  }
}

/** What a copy of `nodes` says when it is pasted somewhere that only reads
 *  text: the words inside the layers, which standard clipboards write. A copy of
 *  shapes has no words, so it falls back to the layer names. */
export function clipPlainText(nodes: XNode[]): string {
  const words: string[] = [];
  const walk = (n: XNode) => {
    if (n.kind === "text" && typeof n.text === "string" && n.text.trim()) words.push(n.text);
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of nodes) walk(n);
  return (words.length ? words : nodes.map((n) => n.name)).join("\n");
}

/* ------------------------------------------------------------ Binary scene payload */

/** The JSON encoded into `data-metadata`. */
export interface FigClipMeta {
  fileKey?: string;
  pasteID?: number;
  dataType?: string;
}

/** Read one attribute out of an HTML fragment without a DOM. The parsers run in
 *  Node for the parity tests, and a base64 value has no characters that need
 *  entity-decoding, so a regex is both enough and dependency-free. */
function attrOf(html: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(html);
  if (!m) return null;
  return m[1] ?? m[2] ?? "";
}

/** Delimits both clipboard strings with HTML comments inside the
 *  attribute value — `<!--(figma)BASE64(/figma)-->` — so the delimiters come
 *  back with the value and have to be cut off before decoding. */
function unwrapFig(raw: string, tag: string): string {
  return raw
    .replace(new RegExp(`<!--\\(${tag}\\)`, "gi"), "")
    .replace(new RegExp(`\\(/${tag}\\)-->`, "gi"), "")
    .replace(/<!--|-->/g, "")
    .trim();
}

/** A base64 run inside the fragment, whether it arrived as an attribute or as a
 *  bare `<!--(tag)…(/tag)-->` comment (both shapes have been observed). */
function figString(html: string, attr: string, tag: string): string | null {
  const viaAttr = attrOf(html, attr);
  const candidates = [viaAttr ? unwrapFig(viaAttr, tag) : null];
  const m = new RegExp(`\\(${tag}\\)\\s*([A-Za-z0-9+/=\\s]{16,}?)\\s*\\(/${tag}\\)`, "i").exec(html);
  candidates.push(m ? m[1] : null);
  for (const c of candidates) {
    if (!c) continue;
    const b64 = c.replace(/[^A-Za-z0-9+/=]/g, "");
    // A scene buffer is never short: an empty frame is ~26 KB of
    // base64. Refusing the short ones keeps a stray attribute from being
    // mistaken for a design.
    if (b64.length >= 64) return b64;
  }
  return null;
}

/** The imported scene buffer, decoded, plus its metadata. Null when the
 *  fragment carries no binary scene markers — which is the common case, and the reason
 *  the paste ladder can ask every rung in turn. */
export function figmaClipFromHtml(html: string): { buffer: Uint8Array; meta: FigClipMeta | null } | null {
  const buffer = figString(html, "data-buffer", "figma");
  if (!buffer) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(buffer);
  } catch {
    return null;
  }
  let meta: FigClipMeta | null = null;
  const metaRaw = figString(html, "data-metadata", "figmeta");
  if (metaRaw) {
    try {
      const parsed = JSON.parse(fromUtf8(base64ToBytes(metaRaw))) as FigClipMeta;
      if (parsed && typeof parsed === "object") meta = parsed;
    } catch {
      /* metadata is diagnostic only; the buffer is what gets imported */
    }
  }
  return { buffer: bytes, meta };
}

/* ------------------------------------------------------------------- writing */

export interface ClipWrite {
  html: string;
  text: string;
  /** Optional raster, for the apps that only read `image/png`. */
  png?: Blob;
}

/** Put `w` on the OS clipboard. The async Clipboard API is the real path; the
 *  hidden-selection + `copy`-event fallback keeps working where it is missing or
 *  refused, because `clipboardData.setData` inside a `copy` handler needs no
 *  permission at all. Never throws and never leaves a rejection floating. */
export function writeClipboard(w: ClipWrite): void {
  if (typeof navigator === "undefined") return;
  const api = navigator.clipboard;
  if (api?.write && typeof ClipboardItem !== "undefined") {
    const parts: Record<string, Blob> = {
      "text/html": new Blob([w.html], { type: "text/html" }),
      "text/plain": new Blob([w.text], { type: "text/plain" }),
    };
    // Not every browser accepts three flavours at once (Safari has historically
    // refused a mixed image+text item), so an item that will not write is
    // retried without the raster before falling back to execCommand.
    if (w.png) parts["image/png"] = w.png;
    api.write([new ClipboardItem(parts)]).catch(() => {
      if (!w.png) {
        writeClipboardLegacy(w);
        return;
      }
      const textOnly: Record<string, Blob> = {
        "text/html": new Blob([w.html], { type: "text/html" }),
        "text/plain": new Blob([w.text], { type: "text/plain" }),
      };
      api.write([new ClipboardItem(textOnly)]).catch(() => writeClipboardLegacy(w));
    });
    return;
  }
  writeClipboardLegacy(w);
}

/** The pre-async-API path: select an off-screen element and let a `copy`
 *  listener dictate the flavours. Still the only way to write `text/html`
 *  without a permission prompt in some browsers. */
function writeClipboardLegacy(w: ClipWrite): void {
  if (typeof document === "undefined") return;
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    e.clipboardData?.setData("text/html", w.html);
    e.clipboardData?.setData("text/plain", w.text);
  };
  const holder = document.createElement("div");
  try {
    document.addEventListener("copy", onCopy);
    holder.setAttribute("contenteditable", "true");
    holder.innerHTML = w.html;
    holder.style.position = "fixed";
    holder.style.left = "-10000px";
    holder.style.top = "0";
    holder.style.opacity = "0";
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand("copy");
    sel?.removeAllRanges();
  } catch {
    /* Nothing left to try; the in-app clipboard still has the copy. */
  } finally {
    holder.remove();
    document.removeEventListener("copy", onCopy);
  }
}

/* ------------------------------------------------------------------- reading */

/** The modifiers that went with the last ⌘V.
 *
 * A `ClipboardEvent` carries no keyboard state — it is not a `KeyboardEvent` —
 * yet ⇧⌘V has to mean "paste in place" matching standard behavior. The
 * keydown handler therefore records the shift key here a moment before the
 * browser fires the paste event, and the paste handler reads it back. Module
 * scope because the two handlers live in different components: the key binding
 * is in `chrome.tsx`, the placement is in `Canvas.tsx`. */
const pasteMods = { inPlace: false, seen: true };

/** Called from the ⌘V key binding, before the browser's paste event lands. */
export function notePasteModifiers(inPlace: boolean): void {
  pasteMods.inPlace = inPlace;
  // A keystroke has just asked for a paste; whether the browser answers is what
  // `pasteEventMissing` reports a moment later.
  pasteMods.seen = false;
}

/** Called from the paste handler, so the key binding knows the browser did fire
 *  the event and its own fallback must stand down. */
export function markPasteEvent(): void {
  pasteMods.seen = true;
}

/** True when a ⌘V was recorded but no paste event followed it — the case where
 *  the key binding has to paste from the in-app clipboard itself. */
export function pasteEventMissing(): boolean {
  return !pasteMods.seen;
}

/** Whether the pending paste asked to land on the source coordinates. */
export function pasteInPlace(): boolean {
  return pasteMods.inPlace;
}

/** The slice of a `DataTransfer` (or an `navigator.clipboard.read()` result the
 *  caller has already flattened) that the ladder needs. Structural, so a test
 *  can hand over a recorded clipboard. */
export interface ClipboardSource {
  getData(type: string): string;
  types?: readonly string[] | string[];
  files?: FileList | File[] | null;
}

export type ClipPayload =
  /** A copy made by this app, in any tab or document: full-fidelity layers. */
  | { kind: "native"; nodes: XNode[] }
  /** A binary copy: a base64 `fig-kiwi` scene buffer. */
  | { kind: "figma"; buffer: Uint8Array; meta: FigClipMeta | null }
  /** SVG markup, from a code editor or another design tool. */
  | { kind: "svg"; text: string }
  /** Files off the OS clipboard: a screenshot, an image, a design file. */
  | { kind: "files"; files: File[] }
  /** Words: turn these into a text layer, and so do we. */
  | { kind: "text"; text: string }
  | { kind: "none" };

const looksLikeSvg = (s: string) => /<svg[\s>]/i.test(s);

/**
 * Decide what is on the clipboard, in the order that keeps the most specific
 * reading first: a file the user copied beats markup, our own payload beats
 * the binary payload (ours round-trips properties SVG cannot carry), binary beats the SVG
 * a browser may have synthesised alongside it, and plain text is the last rung
 * before "nothing useful".
 */
export function parseClipboard(src: ClipboardSource | null | undefined): ClipPayload {
  if (!src) return { kind: "none" };
  const files = src.files ? Array.from(src.files as ArrayLike<File>) : [];
  if (files.length) return { kind: "files", files };

  const html = src.getData("text/html") || "";
  if (html) {
    const native = nativeClipFromHtml(html);
    if (native) return { kind: "native", nodes: native };
    const figma = figmaClipFromHtml(html);
    if (figma) return { kind: "figma", buffer: figma.buffer, meta: figma.meta };
    if (looksLikeSvg(html)) return { kind: "svg", text: html };
  }

  const text = src.getData("text/plain") || "";
  if (looksLikeSvg(text)) return { kind: "svg", text };
  if (text.trim()) return { kind: "text", text };
  return { kind: "none" };
}

/** Flatten one item of an `navigator.clipboard.read()` result — the async path
 *  the context menu uses, where no `paste` event ever fires — into the same
 *  shape the ladder reads. An `image/png` blob becomes a File so it takes the
 *  file rung, exactly as a pasted screenshot does. */
export async function readSystemClipboard(): Promise<ClipboardSource | null> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return null;
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    // Denied, unfocused, or unsupported. The caller falls back to the in-app
    // clipboard rather than surfacing a permission error for a routine ⌘V.
    return null;
  }
  const data = new Map<string, string>();
  const files: File[] = [];
  for (const item of items) {
    for (const type of item.types) {
      try {
        const blob = await item.getType(type);
        if (type.startsWith("text/")) data.set(type, await blob.text());
        else if (type.startsWith("image/")) {
          const ext = type.split("/")[1] || "png";
          files.push(new File([blob], `pasted.${ext}`, { type }));
        }
      } catch {
        /* one unreadable flavour does not spoil the rest */
      }
    }
  }
  if (!data.size && !files.length) return null;
  return {
    getData: (type: string) => data.get(type) ?? "",
    types: [...data.keys()],
    files,
  };
}
