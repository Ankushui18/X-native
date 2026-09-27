import { useEffect, useRef, useState } from "react";
import type { DocSeed } from "../engine/files";
import { admitWebDocument, openWebDocumentSession, type RustWebDocumentSession } from "../engine/webDocumentSession";
import type { RustNodeChange, RustStateChange } from "../engine/rustSession";
import { LiveStatus } from "./announce";
import { XButton } from "./x-ui";

/** Explicitly opt-in, bounded web host for the Rust-owned rectangle dialect.
 * NOT the production designer: it never constructs MemoryEngine, runs layout,
 * or writes to the file store. An initial read-only presentation projection is
 * patched from Rust's one-node deltas; the engine/undo live exclusively in WASM.
 * The only whole-document read after open is the user's explicit download. */
export interface RustPreviewOwner {
  close: () => void;
  hasEdits: () => boolean;
}
interface Props {
  fileId: string;
  seed: DocSeed | null;
  onHome: () => void;
  onStandard: () => void;
  /** The router confirms unsaved edits and closes Rust synchronously BEFORE
   * MemoryEngine mounts, including for browser Back and manual URL edits. */
  onRelease: (owner: RustPreviewOwner | null) => void;
}

type Phase = "opening" | "ready" | "unsupported" | "unavailable" | "fault";
interface RectView extends RustNodeChange {
  fill: string;
  visible: boolean;
  locked: boolean;
}
const INITIAL_STATE: RustStateChange = { revision: 0, node: null, canUndo: false, canRedo: false };

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function downloadName(name: string): string {
  return `${name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim().slice(0, 120) || "Untitled"}.x.json`;
}

export function RustDocumentView({ fileId, seed, onHome, onStandard, onRelease }: Props) {
  const session = useRef<RustWebDocumentSession | null>(null);
  const hasEdits = useRef(false);
  const lastRevision = useRef(0);
  const download = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("opening");
  const [rects, setRects] = useState<RectView[]>([]);
  const [history, setHistory] = useState<RustStateChange>(INITIAL_STATE);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  function revokeDownload(): void {
    const url = download.current;
    download.current = null;
    if (url) URL.revokeObjectURL(url);
  }

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasEdits.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let owned: RustWebDocumentSession | null = null;
    const release = () => {
      controller.abort();
      if (owned) owned.close();
      if (session.current === owned) session.current = null;
      owned = null;
    };
    if (!seed || !admitWebDocument(seed)) {
      setPhase("unsupported");
    } else {
      // StrictMode setup→cleanup→setup must not launch two histories. The
      // microtask also lets a same-tick route change abort before WASM loads.
      queueMicrotask(() => {
        if (controller.signal.aborted) return;
        void openWebDocumentSession(seed, controller.signal).then((opened) => {
          if (controller.signal.aborted) { opened?.close(); return; }
          if (!opened) { setPhase("unavailable"); return; }
          try {
            // Query name, position and size from Rust. Paint/flags are static
            // in this V1 dialect and cannot be changed by the session ABI.
            // No XNode tree or parallel history is retained in the web UI.
            const initial = seed.pages[0].root.children.map((n): RectView => {
              const actual = opened.getNode(n.id);
              if (!actual || actual.name !== n.name || actual.x !== n.x || actual.y !== n.y ||
                  actual.w !== n.w || actual.h !== n.h) {
                throw new Error("Rust layer query disagrees with admitted file");
              }
              return { ...actual, fill: n.fill, visible: n.visible, locked: n.locked };
            });
            const state = opened.state();
            owned = opened;
            session.current = opened;
            hasEdits.current = false;
            onRelease({ close: release, hasEdits: () => hasEdits.current });
            setRects(initial);
            const first = initial.find(r => r.visible && !r.locked) ?? null;
            setSelected(first?.id ?? null);
            setDraft(first?.name ?? "");
            lastRevision.current = state.revision;
            setHistory(state);
            setPhase("ready");
          } catch (e) {
            opened.close();
            setError(`Rust document did not open safely: ${failure(e)}`);
            setPhase("unavailable");
          }
        }).catch((e) => {
          if (!controller.signal.aborted) {
            setError(`Rust bridge unavailable: ${failure(e)}`);
            setPhase("unavailable");
          }
        });
      });
    }
    return () => {
      release();
      onRelease(null);
      revokeDownload();
    };
    // seed changes only when App loads a different stored document. onRelease
    // is stable in App; avoid restarting a live history on unrelated UI state.
  }, [seed, onRelease]);

  const selectedRect = rects.find(r => r.id === selected) ?? null;
  const ready = phase === "ready" && !!session.current;
  // The shared Editor resize operation has a minimum size of one. Previously
  // admitted subpixel files can still move/rename, but cannot resize safely.
  const canResize = ready && !!selectedRect && selectedRect.w >= 1 && selectedRect.h >= 1;
  const phaseMessage = phase === "opening" ? "Checking the document and loading Rust"
    : phase === "unsupported" ? "Unsupported file. Use the standard editor"
    : phase === "unavailable" ? "Rust unavailable. Use the standard editor"
    : phase === "fault" ? "Rust editing paused. Export a recovery copy" : "Rust preview ready";

  function apply(command: (rust: RustWebDocumentSession) => RustStateChange): void {
    const rust = session.current;
    if (!rust || phase !== "ready") return;
    try {
      const change = command(rust);
      if (change.revision < lastRevision.current ||
          (change.node && (change.revision === lastRevision.current ||
            !rects.some(r => r.id === change.node!.id) || change.node.w <= 0 || change.node.h <= 0))) {
        throw new Error("Rust returned an invalid layer delta");
      }
      lastRevision.current = change.revision;
      // Status/history are supplied by Rust; JS retains only what the DOM
      // needs to paint. No speculative patch and no full JSON at command time.
      setHistory(change);
      if (change.node) {
        hasEdits.current = true;
        setRects(list => list.map(rect => rect.id === change.node!.id
          ? { ...rect, name: change.node!.name, x: change.node!.x, y: change.node!.y,
              w: change.node!.w, h: change.node!.h }
          : rect));
        setDraft(current => selected === change.node!.id ? change.node!.name : current);
        revokeDownload();
        setDownloadUrl(null);
      }
      setError("");
    } catch (e) {
      // If a binding threw AFTER changing Rust, we cannot know whether the
      // view is still current. Freeze edits; allow a strict recovery export,
      // never start a second TS engine over possibly newer Rust data.
      hasEdits.current = true;
      setError(`Rust edit failed; editing paused. Try exporting a copy: ${failure(e)}`);
      setPhase("fault");
    }
  }

  function prepareDownload(): void {
    const rust = session.current;
    if (!rust) return;
    try {
      const doc = rust.exportDocument();
      const next = URL.createObjectURL(new Blob([JSON.stringify(doc)], { type: "application/json" }));
      revokeDownload();
      download.current = next;
      setDownloadUrl(next);
      setError("");
    } catch (e) {
      setError(`Cannot export without losing data: ${failure(e)}`);
    }
  }

  return (
    <div className="rust-preview" data-file-id={fileId}>
      <header className="rust-preview-head">
        <div><strong>Rust document preview</strong><span>Experimental · rectangle-only · not autosaved</span></div>
        <div className="rust-preview-actions">
          <XButton onClick={onHome}>Back to files</XButton>
          <XButton onClick={onStandard}>Standard editor</XButton>
          {session.current && <XButton onClick={prepareDownload}>Prepare download</XButton>}
          {downloadUrl && <a href={downloadUrl} download={downloadName(seed?.fileName ?? "Untitled")}>Download file copy</a>}
        </div>
      </header>
      <LiveStatus text={error || phaseMessage} />
      {phase === "opening" && <p className="rust-preview-message">Checking the document and loading Rust…</p>}
      {(phase === "unsupported" || phase === "unavailable") &&
        <p className="rust-preview-message">
          {phase === "unsupported" ? "This document uses features outside the safe Rust subset." : "The Rust session is unavailable for this file."}
          {" "}Nothing was changed. Use the standard editor to continue.
        </p>}
      {phase === "fault" && <p className="rust-preview-message">Edits are paused. Your Rust session is still open for an explicit recovery download.</p>}
      {error && <p className="rust-preview-error">{error}</p>}
      {(phase === "ready" || phase === "fault") && <>
        <div className="rust-preview-toolbar">
          <XButton onClick={() => apply(s => s.undo())} disabled={!ready || !history.canUndo}>Undo</XButton>
          <XButton onClick={() => apply(s => s.redo())} disabled={!ready || !history.canRedo}>Redo</XButton>
          <span>Rust revision {history.revision}</span>
          <small>This preview never writes over your stored file. Download a copy before leaving.</small>
        </div>
        <div className="rust-preview-content">
          <aside aria-label="Rust layers" className="rust-preview-layers">
            {rects.length === 0 ? <p>No rectangles in this file.</p> : rects.map(r =>
              <button type="button" key={r.id} aria-pressed={selected === r.id}
                onClick={() => { setSelected(r.id); setDraft(r.name); }}>
                {r.name || "Unnamed rectangle"} {!r.visible && "· hidden"} {r.locked && "· locked"}
              </button>)}
          </aside>
          <div className="rust-preview-stage" role="region" aria-label="Rust canvas preview">
            <div className="rust-preview-world" style={{ width: seed?.pages[0].root.w, height: seed?.pages[0].root.h }}>
              {rects.filter(r => r.visible).map(r =>
                <button type="button" key={r.id} className="rust-preview-rect"
                  aria-label={r.name || "Unnamed rectangle"} aria-pressed={selected === r.id}
                  onClick={() => { setSelected(r.id); setDraft(r.name); }}
                  style={{ left: r.x, top: r.y, width: r.w, height: r.h, background: r.fill }} />)}
            </div>
          </div>
          <aside aria-label="Rust inspector" className="rust-preview-inspector">
            {selectedRect ? <>
              <h2>{selectedRect.name || "Unnamed rectangle"}</h2>
              <p>Position {selectedRect.x}, {selectedRect.y} · Size {selectedRect.w} × {selectedRect.h}</p>
              {selectedRect.locked ? <p>This layer is locked. Choose an unlocked rectangle to edit.</p> : <>
                <form onSubmit={(e) => { e.preventDefault(); apply(s => s.renameNode(selectedRect.id, draft)); }}>
                  <label htmlFor="rust-layer-name">Layer name</label>
                  <input id="rust-layer-name" value={draft} onChange={e => setDraft(e.target.value)} />
                  <button type="submit" disabled={!ready}>Rename</button>
                </form>
                <div className="rust-preview-nudges" role="group" aria-label="Move rectangle">
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedRect.id, -10, 0))}>Move left 10</XButton>
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedRect.id, 10, 0))}>Move right 10</XButton>
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedRect.id, 0, -10))}>Move up 10</XButton>
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedRect.id, 0, 10))}>Move down 10</XButton>
                </div>
                <div className="rust-preview-nudges" role="group" aria-label="Resize rectangle">
                  <XButton disabled={!canResize || !Number.isFinite(selectedRect.w + 10)}
                    onClick={() => apply(s => s.resizeNode(selectedRect.id, selectedRect.w + 10, selectedRect.h))}>Wider 10</XButton>
                  <XButton disabled={!canResize || selectedRect.w <= 1}
                    onClick={() => apply(s => s.resizeNode(selectedRect.id, Math.max(1, selectedRect.w - 10), selectedRect.h))}>Narrower 10</XButton>
                  <XButton disabled={!canResize || !Number.isFinite(selectedRect.h + 10)}
                    onClick={() => apply(s => s.resizeNode(selectedRect.id, selectedRect.w, selectedRect.h + 10))}>Taller 10</XButton>
                  <XButton disabled={!canResize || selectedRect.h <= 1}
                    onClick={() => apply(s => s.resizeNode(selectedRect.id, selectedRect.w, Math.max(1, selectedRect.h - 10)))}>Shorter 10</XButton>
                </div>
                {(selectedRect.w < 1 || selectedRect.h < 1) &&
                  <p>Native resize requires both dimensions to be at least 1. Other edits remain available.</p>}
              </>}
            </> : <p>Select a rectangle to inspect it.</p>}
          </aside>
        </div>
      </>}
    </div>
  );
}
