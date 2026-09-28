import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DocSeed } from "../engine/files";
import type { BooleanOp } from "../engine/types";
import { admitWebDocument, openWebDocumentSession, type RustWebDocumentSession } from "../engine/webDocumentSession";
import { DEFAULT_RECT_STROKE_COLOR, type RustGeometryChange, type RustNodeChange, type RustStateChange, type RustStrokeChange } from "../engine/rustSession";
import { LiveStatus } from "./announce";
import { XButton, XSelect } from "./x-ui";

/** Explicitly opt-in, bounded web host for Rust-owned plain rectangles and
 * their Boolean results. NOT the production designer: no MemoryEngine, layout,
 * or file-store writes. The initial read-only presentation is patched from
 * small Rust deltas; engine and undo live exclusively in WASM. A whole-document
 * read after open only occurs for the user's explicit download. */
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
  kind: "rect";
  fill: string;
  visible: boolean;
  locked: boolean;
}
type LayerView = (RectView | RustGeometryChange) & { stroke?: RustStrokeChange };

function contourPath(rings: [number, number][][]): string {
  return rings.map(ring => ring.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ") + " Z").join(" ");
}
// Node-local document geometry. The existing two inline layout/ink values in
// this surface remain unchanged; no new hard-coded chrome styles are added.
function strokeSvgGeometry(w: number, h: number, spill: number): CSSProperties {
  return { left: -spill, top: -spill, width: w + 2 * spill, height: h + 2 * spill };
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
  const [layers, setLayers] = useState<LayerView[]>([]);
  const [history, setHistory] = useState<RustStateChange>(INITIAL_STATE);
  const [selected, setSelected] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [strokeDraft, setStrokeDraft] = useState<{ width: string; color: string;
    align: RustStrokeChange["align"]; join: RustStrokeChange["join"] }>(
    { width: "8", color: DEFAULT_RECT_STROKE_COLOR, align: "center", join: "miter" });
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
            // Query initial rectangles from Rust. Paint/flags start from the
            // admitted file; structural changes arrive only as Rust deltas.
            // No XNode tree or parallel history is retained in the web UI.
            const initial = seed.pages[0].root.children.map((n): RectView => {
              const actual = opened.getNode(n.id);
              if (!actual || actual.name !== n.name || actual.x !== n.x || actual.y !== n.y ||
                  actual.w !== n.w || actual.h !== n.h) {
                throw new Error("Rust layer query disagrees with admitted file");
              }
              return { ...actual, kind: "rect", fill: n.fill, visible: n.visible, locked: n.locked };
            });
            const state = opened.state();
            owned = opened;
            session.current = opened;
            hasEdits.current = false;
            onRelease({ close: release, hasEdits: () => hasEdits.current });
            setLayers(initial);
            const first = initial.find(r => r.visible && !r.locked) ?? null;
            setSelected(first ? [first.id] : []);
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

  const selectedLayer = layers.find(r => r.id === selected[selected.length - 1]) ?? null;
  const ready = phase === "ready" && !!session.current;
  const canBoolean = ready && selected.length === 2 &&
    selected.every(id => layers.some(r => r.id === id && r.kind === "rect" && r.visible && !r.locked && !r.stroke?.width));
  // Vector resize needs its own geometry proof; admit rename/move but not
  // resizing a vector's box independently of its Rust path contours.
  const canResize = ready && selectedLayer?.kind === "rect" && selectedLayer.w >= 1 && selectedLayer.h >= 1;
  const strokeWidth = Number(strokeDraft.width);
  const canStroke = canResize && selectedLayer?.visible && !selectedLayer.locked &&
    strokeDraft.width.trim() !== "" && Number.isFinite(strokeWidth) && strokeWidth > 0 && strokeWidth <= 2048;
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
          ((change.node || change.boolean || change.stroke) && change.revision === lastRevision.current) ||
          (change.node && (!layers.some(r => r.id === change.node!.id) || change.node.w <= 0 || change.node.h <= 0)) ||
          (change.stroke && (!layers.some(r => r.id === change.stroke!.id && r.kind === "rect") ||
            change.node && change.node.id !== change.stroke.id)) ||
          (change.boolean && (change.boolean.removed.some(id => !layers.some(r => r.id === id)) ||
            change.boolean.upsert.some(n => layers.some(r => r.id === n.id && !change.boolean!.removed.includes(r.id)))))) {
        throw new Error("Rust returned an invalid layer delta");
      }
      lastRevision.current = change.revision;
      // Status/history are supplied by Rust; JS retains only what the DOM
      // needs to paint. No speculative patch and no full JSON at command time.
      setHistory(change);
      if (change.node || change.boolean || change.stroke) {
        hasEdits.current = true;
        if (change.boolean) {
          const patch = change.boolean;
          setLayers(list => {
            const next = list.filter(r => !patch.removed.includes(r.id));
            for (const upsert of [...patch.upsert].sort((a, b) => a.index - b.index)) {
              next.splice(upsert.index, 0, upsert);
            }
            return next;
          });
          setSelected(patch.upsert.map(r => r.id));
          setDraft(patch.upsert[patch.upsert.length - 1].name);
        } else {
          const { node, stroke } = change;
          setLayers(list => list.map(layer => (node && layer.id === node.id || stroke && layer.id === stroke.id)
            ? { ...layer, ...(node ? { name: node.name, x: node.x, y: node.y, w: node.w, h: node.h } : {}),
              ...(stroke ? { stroke: stroke.width ? stroke : undefined } : {}) }
            : layer));
          if (node) setDraft(current => selected.includes(node.id) ? node.name : current);
          if (stroke && selected.includes(stroke.id)) {
            setStrokeDraft(prev => ({ width: stroke.width ? String(stroke.width) : prev.width,
              color: stroke.width ? stroke.color : prev.color,
              align: stroke.width ? stroke.align : prev.align,
              join: stroke.width ? stroke.join : prev.join }));
          }
        }
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

  function selectLayer(id: string, name: string, extend: boolean): void {
    setSelected(previous => extend ? (previous.includes(id)
      ? previous.filter(value => value !== id)
      : [...previous.slice(-1), id]) : [id]);
    setDraft(name);
    const stroke = layers.find(r => r.id === id)?.stroke;
    if (stroke) setStrokeDraft({ width: String(stroke.width), color: stroke.color, align: stroke.align, join: stroke.join });
  }

  function boolean(op: BooleanOp): void {
    if (!canBoolean) return;
    apply(rust => rust.booleanNode(selected[0], selected[1], op));
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
        <div><strong>Rust document preview</strong><span>Experimental · rectangles, aligned strokes and Boolean vectors · not autosaved</span></div>
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
          <span role="group" aria-label="Rust Boolean operations">
            {(["union", "subtract", "intersect", "exclude"] as const).map(op =>
              <XButton key={op} disabled={!canBoolean} onClick={() => boolean(op)}>
                {op[0].toUpperCase() + op.slice(1)}
              </XButton>)}
          </span>
          <span>Rust revision {history.revision}</span>
          <small>This preview never writes over your stored file. Download a copy before leaving.</small>
        </div>
        <div className="rust-preview-content">
          <aside aria-label="Rust layers" className="rust-preview-layers">
            <p>Shift-click a second rectangle to combine layers.</p>
            {layers.length === 0 ? <p>No layers in this file.</p> : layers.map(r =>
              <button type="button" key={r.id} aria-pressed={selected.includes(r.id)}
                onClick={e => selectLayer(r.id, r.name, e.shiftKey)}>
                {r.name || "Unnamed layer"} {r.kind === "vector" && "· vector"}
                {!r.visible && "· hidden"} {r.locked && "· locked"}
              </button>)}
          </aside>
          <div className="rust-preview-stage" role="region" aria-label="Rust canvas preview">
            <div className="rust-preview-world" style={{ width: seed?.pages[0].root.w, height: seed?.pages[0].root.h }}>
              {layers.filter(r => r.visible).map(r =>
                <button type="button" key={r.id} className="rust-preview-rect"
                  aria-label={r.name || "Unnamed layer"} aria-pressed={selected.includes(r.id)}
                  onClick={e => selectLayer(r.id, r.name, e.shiftKey)}
                  style={{ left: r.x, top: r.y, width: r.w, height: r.h,
                    background: r.kind === "vector" ? "transparent" : r.fill }}>
                  {r.kind === "vector" && <svg width="100%" height="100%" viewBox={`0 0 ${r.w} ${r.h}`}
                    aria-hidden="true"><path d={contourPath(r.rings ?? [])} fill={r.fill} fillRule="evenodd" /></svg>}
                  {r.stroke && r.stroke.width > 0 && (() => {
                    const spill = r.stroke!.align === "inside" ? 0 : r.stroke!.align === "center" ? r.stroke!.width / 2 : r.stroke!.width;
                    const contours = [r.stroke!.outer, ...(r.stroke!.inner.length ? [r.stroke!.inner] : [])];
                    return <svg className="rust-preview-stroke" aria-hidden="true"
                      viewBox={`${-spill} ${-spill} ${r.w + 2 * spill} ${r.h + 2 * spill}`}
                      style={strokeSvgGeometry(r.w, r.h, spill)}>
                      <path d={contourPath(contours)} fill={r.stroke!.color} fillRule="evenodd" />
                    </svg>;
                  })()}
                </button>)}
            </div>
          </div>
          <aside aria-label="Rust inspector" className="rust-preview-inspector">
            {selectedLayer ? <>
              <h2>{selectedLayer.name || "Unnamed layer"}</h2>
              <p>Position {selectedLayer.x}, {selectedLayer.y} · Size {selectedLayer.w} × {selectedLayer.h}</p>
              {selectedLayer.locked ? <p>This layer is locked. Choose an unlocked layer to edit.</p> : <>
                <form onSubmit={(e) => { e.preventDefault(); apply(s => s.renameNode(selectedLayer.id, draft)); }}>
                  <label htmlFor="rust-layer-name">Layer name</label>
                  <input id="rust-layer-name" value={draft} onChange={e => setDraft(e.target.value)} />
                  <button type="submit" disabled={!ready}>Rename</button>
                </form>
                <div className="rust-preview-nudges" role="group" aria-label="Move layer">
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedLayer.id, -10, 0))}>Move left 10</XButton>
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedLayer.id, 10, 0))}>Move right 10</XButton>
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedLayer.id, 0, -10))}>Move up 10</XButton>
                  <XButton disabled={!ready} onClick={() => apply(s => s.moveNode(selectedLayer.id, 0, 10))}>Move down 10</XButton>
                </div>
                <div className="rust-preview-nudges" role="group" aria-label="Resize rectangle">
                  <XButton disabled={!canResize || !Number.isFinite(selectedLayer.w + 10)}
                    onClick={() => apply(s => s.resizeNode(selectedLayer.id, selectedLayer.w + 10, selectedLayer.h))}>Wider 10</XButton>
                  <XButton disabled={!canResize || selectedLayer.w <= 1}
                    onClick={() => apply(s => s.resizeNode(selectedLayer.id, Math.max(1, selectedLayer.w - 10), selectedLayer.h))}>Narrower 10</XButton>
                  <XButton disabled={!canResize || !Number.isFinite(selectedLayer.h + 10)}
                    onClick={() => apply(s => s.resizeNode(selectedLayer.id, selectedLayer.w, selectedLayer.h + 10))}>Taller 10</XButton>
                  <XButton disabled={!canResize || selectedLayer.h <= 1}
                    onClick={() => apply(s => s.resizeNode(selectedLayer.id, selectedLayer.w, Math.max(1, selectedLayer.h - 10)))}>Shorter 10</XButton>
                </div>
                {selectedLayer.kind === "rect" && <form className="rust-preview-stroke-form" onSubmit={e => {
                  e.preventDefault();
                  if (canStroke) apply(s => s.strokeNode(selectedLayer.id, strokeWidth, strokeDraft.color, strokeDraft.align, strokeDraft.join));
                }}>
                  <strong>Rust stroke · exact edge offsets</strong>
                  <label htmlFor="rust-stroke-width">Width</label>
                  <input id="rust-stroke-width" type="number" min="0.01" max="2048" step="any"
                    value={strokeDraft.width} onChange={e => setStrokeDraft(v => ({ ...v, width: e.target.value }))} />
                  <label htmlFor="rust-stroke-color">Color</label>
                  <input id="rust-stroke-color" type="color" value={strokeDraft.color}
                    onChange={e => setStrokeDraft(v => ({ ...v, color: e.target.value }))} />
                  <label>Alignment
                    <XSelect ariaLabel="Stroke alignment" value={strokeDraft.align}
                      options={[{ value: "inside", label: "Inside" }, { value: "center", label: "Center" },
                        { value: "outside", label: "Outside" }]}
                      onChange={value => setStrokeDraft(v => ({ ...v, align: value as RustStrokeChange["align"] }))} />
                  </label>
                  <label>Join
                    <XSelect ariaLabel="Stroke join" value={strokeDraft.join}
                      options={[{ value: "miter", label: "Miter" }, { value: "bevel", label: "Bevel" }]}
                      onChange={value => setStrokeDraft(v => ({ ...v, join: value as RustStrokeChange["join"] }))} />
                  </label>
                  <XButton disabled={!canStroke}>Apply stroke</XButton>
                </form>}
                {selectedLayer.kind === "rect" && <XButton disabled={!ready || !selectedLayer.stroke?.width}
                  onClick={() => apply(s => s.strokeNode(selectedLayer.id, 0, strokeDraft.color, "center", "miter"))}>
                  Remove stroke
                </XButton>}
                {selectedLayer.kind === "vector" ?
                  <p>Vector resize and strokes need a separate geometry proof; move and rename remain available.</p> :
                  (selectedLayer.w < 1 || selectedLayer.h < 1) &&
                  <p>Native resize requires both dimensions to be at least 1. Other edits remain available.</p>}
              </>}
            </> : <p>Select a layer to inspect it.</p>}
          </aside>
        </div>
      </>}
    </div>
  );
}
