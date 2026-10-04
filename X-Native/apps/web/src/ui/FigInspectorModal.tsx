import { importFig } from "../engine/wasmBridge";
import React, { useState, useEffect } from "react";
import { inspectFigFile, type FigInspectionReport } from "../engine/figImport";
import { Icon } from "./icons";
import { toast } from "./toast";
import { copyText } from "../engine/clipboard";
import type { Engine } from "../engine/types";

interface FigInspectorModalProps {
  engine: Engine;
  onClose: () => void;
}

export function FigInspectorModal({ engine, onClose }: FigInspectorModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<FigInspectionReport | null>(null);
  const [rawBuffer, setRawBuffer] = useState<ArrayBuffer | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "nodes" | "vectors" | "schema" | "json">("overview");
  const [selectedNodeGuid, setSelectedNodeGuid] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>("ALL");
  const [schemaSearch, setSchemaSearch] = useState<string>("");

  const loadSample = async (url: string, name: string) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP error ${resp.status} fetching ${url}`);
      const buf = await resp.arrayBuffer();
      setRawBuffer(buf);
      const rep = await inspectFigFile(buf, name);
      setReport(rep);
      if (rep.nodes.length > 0) {
        const firstVec = rep.nodes.find((n) => n.hasVectorGeometry) || rep.nodes[0];
        setSelectedNodeGuid(firstVec.guid);
      }
      toast(`Inspected ${name} successfully`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast(`Failed to inspect file: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      setRawBuffer(buf);
      const rep = await inspectFigFile(buf, file.name);
      setReport(rep);
      if (rep.nodes.length > 0) {
        const firstVec = rep.nodes.find((n) => n.hasVectorGeometry) || rep.nodes[0];
        setSelectedNodeGuid(firstVec.guid);
      }
      toast(`Inspected ${file.name}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast(`Failed to load: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleImportToCanvas = async () => {
    if (!rawBuffer) return;
    try {
      setLoading(true);
      const res = await importFig(rawBuffer);
      let count = 0;
      for (const n of res.nodes) {
        engine.dispatch({
          type: "add",
          kind: n.kind,
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          extra: {
            name: n.name,
            fill: n.fill,
            fillVisible: n.fillVisible,
            strokePaint: n.strokePaint,
            strokeVisible: n.strokeVisible,
            strokeWidth: n.strokeWidth,
            rotation: n.rotation,
            opacity: n.opacity,
            cornerRadii: n.cornerRadii ?? [0, 0, 0, 0],
            path: n.path ?? [],
            vectorNetwork: n.vectorNetwork,
            closed: n.closed ?? false,
            text: n.text ?? "",
            fontSize: n.fontSize ?? 16,
            fontWeight: n.fontWeight ?? 400,
          },
        });
        count++;
      }
      toast(`Imported ${count} layers onto canvas`);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Import failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  // Automatically load OpenFigs.fig on initial mount if nothing loaded
  useEffect(() => {
    void loadSample("/samples/OpenFigs.fig", "OpenFigs.fig");
  }, []);

  const selectedNode = report?.nodes.find((n) => n.guid === selectedNodeGuid);
  const vectorNodes = report?.nodes.filter((n) => n.hasVectorGeometry) ?? [];
  const filteredNodes = report?.nodes.filter((n) => filterType === "ALL" || n.type === filterType) ?? [];
  const filteredSchema = report?.schemaDefs.filter((d) =>
    !schemaSearch || d.name.toLowerCase().includes(schemaSearch.toLowerCase()),
  ) ?? [];

  return (
    <div
      className="fim-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fim-box"
      >
        {/* Header */}
        <div
          className="fim-head"
        >
          <div className="fim-head-title">
            <Icon name="folder" size={20} />
            <div>
              <div className="fim-title">
                Design File Inspector
              </div>
              <div className="fim-label">
                {report?.fileName ?? "No file loaded"} • Binary & Vector Network Analyzer
              </div>
            </div>
          </div>

          <div className="fim-row8">
            <button
              className="export-run fim-close"
              disabled={!rawBuffer || loading}
              onClick={handleImportToCanvas}
              title="Import all layers into the active X-Native canvas"
            >
              <Icon name="plus" size={12} />
              Import to Canvas
            </button>
            <button className="icon-btn" onClick={onClose} title="Close inspector">
              ✕
            </button>
          </div>
        </div>

        {/* Toolbar / Samples */}
        <div
          className="fim-toolbar"
        >
          <span className="fim-toolbar-label">Sample Files:</span>
          <button
            className={`fim-chip${report?.fileName === "OpenFigs.fig" ? " on" : ""}`}
            onClick={() => loadSample("/samples/OpenFigs.fig", "OpenFigs.fig")}
          >
            OpenFigs.fig (v106, 21 Vector Blobs)
          </button>
          <button
            className={`fim-chip${report?.fileName === "circle.fig" ? " on" : ""}`}
            onClick={() => loadSample("/samples/circle.fig", "circle.fig")}
          >
            circle.fig (v101, Zstd Chunks)
          </button>

          <label
            className="fim-toggle"
          >
            <Icon name="upload" size={12} />
            <span>Open Custom .fig…</span>
            <input
              type="file"
              accept=".fig"
              className="fim-hidden"
              onChange={handleFileUpload}
            />
          </label>
        </div>

        {/* Sub-Navigation Tabs */}
        <div
          className="fim-tabs"
        >
          {[
            { id: "overview", label: "Overview & Chunks" },
            { id: "nodes", label: `Nodes & Hierarchy (${report?.activeNodesCount ?? 0})` },
            { id: "vectors", label: `Vector Networks (${vectorNodes.length})` },
            { id: "schema", label: `Kiwi Schema (${report?.schemaDefsCount ?? 0})` },
            { id: "json", label: "Decoded JSON" },
          ].map((t) => (
            <button
              key={t.id}
              className={`fim-tab${activeTab === t.id ? " on" : ""}`}
              aria-current={activeTab === t.id}
              onClick={() => setActiveTab(t.id as any)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body Area */}
        <div className="fim-body">
          {loading && (
            <div className="fim-empty">
              Decoding and analyzing Kiwi binary format…
            </div>
          )}

          {error && (
            <div
              className="fim-error"
            >
              {error}
            </div>
          )}

          {!loading && report && activeTab === "overview" && (
            <div className="fim-grid16">
              {/* Metric Cards */}
              <div className="fim-metrics">
                <div className="fim-metric">
                  <div className="fim-label">PRELUDE & VERSION</div>
                  <div className="fim-metric-value">
                    {report.prelude} v{report.version}
                  </div>
                  <div className="fim-metric-note">
                    Binary Container
                  </div>
                </div>

                <div className="fim-metric">
                  <div className="fim-label">CHUNKS & PAYLOAD</div>
                  <div className="fim-metric-value">
                    {report.chunksCount} Chunks
                  </div>
                  <div className="fim-metric-note">
                    {report.chunks.map((c) => `${c.compression} (${Math.round(c.byteLength / 1024)}KB)`).join(" • ")}
                  </div>
                </div>

                <div className="fim-metric">
                  <div className="fim-label">KIWI DEFINITIONS</div>
                  <div className="fim-metric-value">
                    {report.schemaDefsCount} Types
                  </div>
                  <div className="fim-metric-note">
                    Embedded field dictionary
                  </div>
                </div>

                <div className="fim-metric">
                  <div className="fim-label">VECTOR BLOBS</div>
                  <div className="fim-metric-value">
                    {report.blobsCount} Blobs
                  </div>
                  <div className="fim-metric-note">
                    Vector paths & networks
                  </div>
                </div>
              </div>

              {/* Node Types Breakdown */}
              <div className="fim-card">
                <div className="fim-card-title">Layers by Type</div>
                <div className="fim-wrap">
                  {Object.entries(report.nodesByType).map(([type, count]) => (
                    <div
                      key={type}
                      className="fim-type"
                    >
                      <span className="fim-strong">{type}</span>
                      <span
                        className="fim-count"
                      >
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chunks Details */}
              <div className="fim-card">
                <div className="fim-card-title">Container Chunks Structure</div>
                <div className="fim-grid8">
                  {report.chunks.map((c) => (
                    <div
                      key={c.index}
                      className="fim-chunk"
                    >
                      <div>
                        <strong>Chunk {c.index}:</strong> {c.index === 0 ? "Kiwi Binary Schema" : "NodeChanges & Blobs Message"}
                      </div>
                      <div className="fim-meta">
                        <span>Size: {c.byteLength} bytes ({Math.round(c.byteLength / 1024)} KB)</span>
                        <span className="fim-tag">
                          {c.compression}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!loading && report && activeTab === "nodes" && (
            <div className="fim-split">
              {/* Nodes List */}
              <div
                className="fim-pane"
              >
                <div className="fim-pane-head">
                  <select
                    aria-label="Filter by type"
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="fim-search"
                  >
                    <option value="ALL">All Types ({report.nodes.length})</option>
                    {Object.keys(report.nodesByType).map((t) => (
                      <option key={t} value={t}>
                        {t} ({report.nodesByType[t]})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="fim-scroll">
                  {filteredNodes.map((n) => (
                    <div
                      key={n.guid}
                      onClick={() => setSelectedNodeGuid(n.guid)}
                      className={`fim-node${selectedNodeGuid === n.guid ? " sel" : ""}`}
                    >
                      <div className="fim-between">
                        <strong className="fim-name">{n.name}</strong>
                        <span className="fim-guid">{n.guid}</span>
                      </div>
                      <div className="fim-node-meta">
                        <span>{n.type}</span>
                        {n.w > 0 && <span>{Math.round(n.w)} × {Math.round(n.h)}</span>}
                        {n.hasVectorGeometry && <span className="fim-ink-accent">• Vector ({n.vectorCommandsCount} cmds)</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Node Inspector */}
              <div
                className="fim-detail"
              >
                {selectedNode ? (
                  <div className="fim-grid14">
                    <div className="fim-between-c">
                      <div>
                        <h3 className="fim-h3">{selectedNode.name}</h3>
                        <div className="fim-dim11">
                          GUID: <code>{selectedNode.guid}</code> • Type: <code>{selectedNode.type}</code>
                        </div>
                      </div>
                      <button
                        className="export-run fim-btn-xs"
                        onClick={() => {
                          copyText(JSON.stringify(selectedNode.raw, null, 2));
                          toast("Copied node properties");
                        }}
                      >
                        Copy Node JSON
                      </button>
                    </div>

                    <div className="fim-pairs">
                      <div className="fim-tile">
                        <div className="fim-tile-label">BOUNDS & PLACEMENT</div>
                        <div className="fim-mt4">
                          X: {selectedNode.x.toFixed(1)}, Y: {selectedNode.y.toFixed(1)}
                        </div>
                        <div>
                          Width: {selectedNode.w.toFixed(1)}, Height: {selectedNode.h.toFixed(1)}
                        </div>
                      </div>

                      <div className="fim-tile">
                        <div className="fim-tile-label">PAINT & STROKE</div>
                        <div className="fim-swatch-row">
                          <span>Fill:</span>
                          {selectedNode.fill && (
                            <span
                              className="fim-swatch"
                              style={{ background: selectedNode.fill }}
                            />
                          )}
                          <code>{selectedNode.fill ?? "None"}</code>
                        </div>
                        <div>Stroke: <code>{selectedNode.stroke ?? "None"}</code> ({selectedNode.strokeWeight}px)</div>
                      </div>
                    </div>

                    {selectedNode.hasVectorGeometry && (
                      <div className="fim-note">
                        <div className="fim-note-title">
                          Vector Network Analysis
                        </div>
                        <div className="fim-row16">
                          <span>Commands: <strong>{selectedNode.vectorCommandsCount}</strong></span>
                          <span>Vertices: <strong>{selectedNode.vectorVerticesCount}</strong></span>
                          <span>Segments: <strong>{selectedNode.vectorSegmentsCount}</strong></span>
                          <span>Branching Vertices: <strong>{selectedNode.branchingCount}</strong></span>
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="fim-sub-title">Raw Decoded Kiwi Object</div>
                      <pre
                        className="fim-code"
                      >
                        {JSON.stringify(selectedNode.raw, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="fim-empty">
                    Select a node from the list to inspect
                  </div>
                )}
              </div>
            </div>
          )}

          {!loading && report && activeTab === "vectors" && (
            <div className="fim-grid16">
              <div className="fim-dim11">
                Vector networks extracted from binary <code>commandsBlob</code> and <code>vectorNetworkBlob</code>:
              </div>

              {vectorNodes.map((n) => {
                const sampleCmds = n.sampleCommands || [];
                // Generate a quick SVG path preview from sample commands
                let pathD = "";
                for (const cmd of sampleCmds) {
                  if (cmd.type === "M") pathD += `M ${cmd.x} ${cmd.y} `;
                  else if (cmd.type === "L") pathD += `L ${cmd.x} ${cmd.y} `;
                  else if (cmd.type === "C") pathD += `C ${cmd.x1} ${cmd.y1}, ${cmd.x2} ${cmd.y2}, ${cmd.x} ${cmd.y} `;
                  else if (cmd.type === "Z") pathD += `Z `;
                }

                return (
                  <div
                    key={n.guid}
                    className="fim-figure"
                  >
                    {/* SVG Preview */}
                    <div
                      className="fim-preview"
                    >
                      <svg
                        viewBox={`0 0 ${Math.max(1, n.w)} ${Math.max(1, n.h)}`}
                      >
                        <path
                          d={pathD}
                          fill={n.fill || "var(--accent)"}
                          stroke={n.stroke || "var(--panel)"}
                          strokeWidth={Math.max(1, n.strokeWeight)}
                        />
                      </svg>
                    </div>

                    {/* Details */}
                    <div className="fim-col8">
                      <div className="fim-between">
                        <div>
                          <strong className="fim-strong14">{n.name}</strong>
                          <span className="fim-dim11-ml">
                            GUID {n.guid}
                          </span>
                        </div>
                        <button
                          className="export-run fim-btn-xs"
                          onClick={() => {
                            copyText(pathD);
                            toast("Copied SVG path");
                          }}
                        >
                          Copy SVG Path
                        </button>
                      </div>

                      <div className="fim-row14">
                        <span>Total Commands: <strong>{n.vectorCommandsCount}</strong></span>
                        <span>Vertices: <strong>{n.vectorVerticesCount}</strong></span>
                        <span>Segments: <strong>{n.vectorSegmentsCount}</strong></span>
                        <span>Branching Degree ≥ 3: <strong>{n.branchingCount}</strong></span>
                      </div>

                      <div className="fim-mt6">
                        <div className="fim-label-mb">
                          First Decoded Commands:
                        </div>
                        <pre
                          className="fim-code-sm"
                        >
                          {JSON.stringify(sampleCmds, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!loading && report && activeTab === "schema" && (
            <div className="fim-col12">
              <div className="fim-between-c">
                <span className="fim-dim11">
                  The .fig binary contains {report.schemaDefsCount} self-describing Kiwi schema type definitions:
                </span>
                <input
                  placeholder="Search types (e.g. Vector, Paint, Node)..."
                  value={schemaSearch}
                  onChange={(e) => setSchemaSearch(e.target.value)}
                  className="fim-select"
                />
              </div>

              <div
                className="fim-tablewrap"
              >
                <table className="fim-table">
                  <thead>
                    <tr className="fim-thead">
                      <th className="fim-th">Type Name</th>
                      <th className="fim-th">Kind</th>
                      <th className="fim-th">Fields Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSchema.slice(0, 100).map((d) => (
                      <tr key={d.name} className="fim-tr">
                        <td className="fim-td-mono">{d.name}</td>
                        <td className="fim-td-dim">{d.kind}</td>
                        <td className="fim-td">{d.fieldsCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && report && activeTab === "json" && (
            <div className="fim-col8-full">
              <div className="fim-between">
                <span className="fim-dim11">
                  Full decoded Kiwi message payload:
                </span>
                <button
                  className="export-run fim-btn"
                  onClick={() => {
                    copyText(report.rawMessageJson);
                    toast("Copied JSON payload");
                  }}
                >
                  Copy All JSON
                </button>
              </div>
              <pre
                className="fim-code-lg"
              >
                {report.rawMessageJson}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
