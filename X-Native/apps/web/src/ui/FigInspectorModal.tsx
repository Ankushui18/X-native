import React, { useState, useEffect } from "react";
import { inspectFigFile, importFig, type FigInspectionReport } from "../engine/figImport";
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
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "90vw",
          maxWidth: 1100,
          height: "85vh",
          background: "var(--panel)",
          borderRadius: 12,
          boxShadow: "0 24px 48px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid var(--line)",
          color: "var(--text)",
          fontSize: 12,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="figma" size={20} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Figma File Inspector (.fig)
              </div>
              <div style={{ fontSize: 10, color: "var(--dim)" }}>
                {report?.fileName ?? "No file loaded"} • Kiwi Binary & Vector Network Analyzer
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              className="export-run"
              style={{ padding: "4px 10px", fontSize: 11, background: "#10b981" }}
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
          style={{
            padding: "8px 18px",
            borderBottom: "1px solid var(--line)",
            background: "var(--hover)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--dim)" }}>Sample Files:</span>
          <button
            className="tab"
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              fontSize: 11,
              background: report?.fileName === "OpenFigs.fig" ? "var(--accent)" : "var(--bg)",
              color: report?.fileName === "OpenFigs.fig" ? "#fff" : "var(--text)",
            }}
            onClick={() => loadSample("/samples/OpenFigs.fig", "OpenFigs.fig")}
          >
            OpenFigs.fig (v106, 21 Vector Blobs)
          </button>
          <button
            className="tab"
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              fontSize: 11,
              background: report?.fileName === "circle.fig" ? "var(--accent)" : "var(--bg)",
              color: report?.fileName === "circle.fig" ? "#fff" : "var(--text)",
            }}
            onClick={() => loadSample("/samples/circle.fig", "circle.fig")}
          >
            circle.fig (v101, Zstd Chunks)
          </button>

          <label
            style={{
              marginLeft: "auto",
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid var(--line)",
              background: "var(--bg)",
              cursor: "pointer",
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Icon name="upload" size={12} />
            <span>Open Custom .fig…</span>
            <input
              type="file"
              accept=".fig"
              style={{ display: "none" }}
              onChange={handleFileUpload}
            />
          </label>
        </div>

        {/* Sub-Navigation Tabs */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg)",
            padding: "0 18px",
          }}
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
              className="tab"
              aria-current={activeTab === t.id}
              onClick={() => setActiveTab(t.id as any)}
              style={{
                padding: "8px 14px",
                borderBottom: activeTab === t.id ? "2px solid var(--accent)" : "none",
                fontWeight: activeTab === t.id ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body Area */}
        <div style={{ flex: 1, overflowY: "auto", padding: 18, background: "var(--panel)" }}>
          {loading && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--dim)" }}>
              Decoding and analyzing Kiwi binary format…
            </div>
          )}

          {error && (
            <div
              style={{
                padding: 16,
                background: "rgba(239, 68, 68, 0.1)",
                color: "#ef4444",
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          {!loading && report && activeTab === "overview" && (
            <div style={{ display: "grid", gap: 16 }}>
              {/* Metric Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                <div style={{ padding: 14, background: "var(--hover)", borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--dim)" }}>PRELUDE & VERSION</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                    {report.prelude} v{report.version}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 2 }}>
                    Figma Binary Container
                  </div>
                </div>

                <div style={{ padding: 14, background: "var(--hover)", borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--dim)" }}>CHUNKS & PAYLOAD</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                    {report.chunksCount} Chunks
                  </div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 2 }}>
                    {report.chunks.map((c) => `${c.compression} (${Math.round(c.byteLength / 1024)}KB)`).join(" • ")}
                  </div>
                </div>

                <div style={{ padding: 14, background: "var(--hover)", borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--dim)" }}>KIWI DEFINITIONS</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                    {report.schemaDefsCount} Types
                  </div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 2 }}>
                    Embedded field dictionary
                  </div>
                </div>

                <div style={{ padding: 14, background: "var(--hover)", borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--dim)" }}>VECTOR BLOBS</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                    {report.blobsCount} Blobs
                  </div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 2 }}>
                    Vector paths & networks
                  </div>
                </div>
              </div>

              {/* Node Types Breakdown */}
              <div style={{ padding: 16, background: "var(--hover)", borderRadius: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>Layers by Figma Type</div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {Object.entries(report.nodesByType).map(([type, count]) => (
                    <div
                      key={type}
                      style={{
                        padding: "6px 12px",
                        background: "var(--bg)",
                        borderRadius: 6,
                        border: "1px solid var(--line)",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{type}</span>
                      <span
                        style={{
                          background: "var(--accent)",
                          color: "#fff",
                          borderRadius: 10,
                          padding: "1px 6px",
                          fontSize: 10,
                        }}
                      >
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chunks Details */}
              <div style={{ padding: 16, background: "var(--hover)", borderRadius: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>Container Chunks Structure</div>
                <div style={{ display: "grid", gap: 8 }}>
                  {report.chunks.map((c) => (
                    <div
                      key={c.index}
                      style={{
                        padding: "8px 12px",
                        background: "var(--bg)",
                        borderRadius: 6,
                        border: "1px solid var(--line)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <strong>Chunk {c.index}:</strong> {c.index === 0 ? "Kiwi Binary Schema" : "NodeChanges & Blobs Message"}
                      </div>
                      <div style={{ display: "flex", gap: 12, color: "var(--dim)" }}>
                        <span>Size: {c.byteLength} bytes ({Math.round(c.byteLength / 1024)} KB)</span>
                        <span style={{ textTransform: "uppercase", color: "#10b981", fontWeight: 600 }}>
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
            <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 16, height: "100%" }}>
              {/* Nodes List */}
              <div
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  overflowY: "auto",
                  background: "var(--bg)",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "4px 8px",
                      background: "var(--input)",
                      color: "var(--text)",
                      border: "1px solid var(--line)",
                      borderRadius: 4,
                    }}
                  >
                    <option value="ALL">All Types ({report.nodes.length})</option>
                    {Object.keys(report.nodesByType).map((t) => (
                      <option key={t} value={t}>
                        {t} ({report.nodesByType[t]})
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {filteredNodes.map((n) => (
                    <div
                      key={n.guid}
                      onClick={() => setSelectedNodeGuid(n.guid)}
                      style={{
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--line)",
                        cursor: "pointer",
                        background: selectedNodeGuid === n.guid ? "rgba(13,153,255,0.15)" : "transparent",
                        borderLeft: selectedNodeGuid === n.guid ? "3px solid var(--accent)" : "3px solid transparent",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <strong style={{ fontSize: 11 }}>{n.name}</strong>
                        <span style={{ fontSize: 9, color: "var(--dim)" }}>{n.guid}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 10, color: "var(--dim)" }}>
                        <span>{n.type}</span>
                        {n.w > 0 && <span>{Math.round(n.w)} × {Math.round(n.h)}</span>}
                        {n.hasVectorGeometry && <span style={{ color: "#10b981" }}>• Vector ({n.vectorCommandsCount} cmds)</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Node Inspector */}
              <div
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  padding: 16,
                  overflowY: "auto",
                  background: "var(--bg)",
                }}
              >
                {selectedNode ? (
                  <div style={{ display: "grid", gap: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: 16 }}>{selectedNode.name}</h3>
                        <div style={{ fontSize: 11, color: "var(--dim)" }}>
                          Figma GUID: <code>{selectedNode.guid}</code> • Type: <code>{selectedNode.type}</code>
                        </div>
                      </div>
                      <button
                        className="export-run"
                        style={{ padding: "4px 8px", fontSize: 10 }}
                        onClick={() => {
                          copyText(JSON.stringify(selectedNode.raw, null, 2));
                          toast("Copied node properties");
                        }}
                      >
                        Copy Node JSON
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ padding: 10, background: "var(--hover)", borderRadius: 6 }}>
                        <div style={{ color: "var(--dim)", fontSize: 10 }}>BOUNDS & PLACEMENT</div>
                        <div style={{ marginTop: 4 }}>
                          X: {selectedNode.x.toFixed(1)}, Y: {selectedNode.y.toFixed(1)}
                        </div>
                        <div>
                          Width: {selectedNode.w.toFixed(1)}, Height: {selectedNode.h.toFixed(1)}
                        </div>
                      </div>

                      <div style={{ padding: 10, background: "var(--hover)", borderRadius: 6 }}>
                        <div style={{ color: "var(--dim)", fontSize: 10 }}>PAINT & STROKE</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                          <span>Fill:</span>
                          {selectedNode.fill && (
                            <span
                              style={{
                                display: "inline-block",
                                width: 12,
                                height: 12,
                                borderRadius: 3,
                                background: selectedNode.fill,
                                border: "1px solid var(--line)",
                              }}
                            />
                          )}
                          <code>{selectedNode.fill ?? "None"}</code>
                        </div>
                        <div>Stroke: <code>{selectedNode.stroke ?? "None"}</code> ({selectedNode.strokeWeight}px)</div>
                      </div>
                    </div>

                    {selectedNode.hasVectorGeometry && (
                      <div style={{ padding: 12, background: "rgba(16, 185, 129, 0.08)", borderRadius: 6, border: "1px solid rgba(16, 185, 129, 0.2)" }}>
                        <div style={{ fontWeight: 600, color: "#10b981", marginBottom: 6 }}>
                          Vector Network Analysis
                        </div>
                        <div style={{ display: "flex", gap: 16 }}>
                          <span>Commands: <strong>{selectedNode.vectorCommandsCount}</strong></span>
                          <span>Vertices: <strong>{selectedNode.vectorVerticesCount}</strong></span>
                          <span>Segments: <strong>{selectedNode.vectorSegmentsCount}</strong></span>
                          <span>Branching Vertices: <strong>{selectedNode.branchingCount}</strong></span>
                        </div>
                      </div>
                    )}

                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>Raw Decoded Kiwi Object</div>
                      <pre
                        style={{
                          padding: 10,
                          borderRadius: 6,
                          background: "var(--input)",
                          fontSize: 10,
                          maxHeight: 260,
                          overflowY: "auto",
                        }}
                      >
                        {JSON.stringify(selectedNode.raw, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: "var(--dim)", textAlign: "center", padding: 40 }}>
                    Select a node from the list to inspect
                  </div>
                )}
              </div>
            </div>
          )}

          {!loading && report && activeTab === "vectors" && (
            <div style={{ display: "grid", gap: 16 }}>
              <div style={{ color: "var(--dim)", fontSize: 11 }}>
                Figma vector networks extracted from binary <code>commandsBlob</code> and <code>vectorNetworkBlob</code>:
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
                    style={{
                      padding: 16,
                      background: "var(--bg)",
                      border: "1px solid var(--line)",
                      borderRadius: 8,
                      display: "grid",
                      gridTemplateColumns: "180px 1fr",
                      gap: 16,
                    }}
                  >
                    {/* SVG Preview */}
                    <div
                      style={{
                        height: 180,
                        background: "var(--hover)",
                        borderRadius: 6,
                        border: "1px solid var(--line)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                      }}
                    >
                      <svg
                        viewBox={`0 0 ${Math.max(1, n.w)} ${Math.max(1, n.h)}`}
                        style={{ maxWidth: 160, maxHeight: 160 }}
                      >
                        <path
                          d={pathD}
                          fill={n.fill || "#0d99ff"}
                          stroke={n.stroke || "#ffffff"}
                          strokeWidth={Math.max(1, n.strokeWeight)}
                        />
                      </svg>
                    </div>

                    {/* Details */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <div>
                          <strong style={{ fontSize: 14 }}>{n.name}</strong>
                          <span style={{ fontSize: 11, color: "var(--dim)", marginLeft: 8 }}>
                            GUID {n.guid}
                          </span>
                        </div>
                        <button
                          className="export-run"
                          style={{ padding: "3px 8px", fontSize: 10 }}
                          onClick={() => {
                            copyText(pathD);
                            toast("Copied SVG path");
                          }}
                        >
                          Copy SVG Path
                        </button>
                      </div>

                      <div style={{ display: "flex", gap: 14, fontSize: 11 }}>
                        <span>Total Commands: <strong>{n.vectorCommandsCount}</strong></span>
                        <span>Vertices: <strong>{n.vectorVerticesCount}</strong></span>
                        <span>Segments: <strong>{n.vectorSegmentsCount}</strong></span>
                        <span>Branching Degree ≥ 3: <strong>{n.branchingCount}</strong></span>
                      </div>

                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 10, color: "var(--dim)", marginBottom: 4 }}>
                          First Decoded Commands:
                        </div>
                        <pre
                          style={{
                            padding: 8,
                            borderRadius: 4,
                            background: "var(--input)",
                            fontSize: 10,
                            maxHeight: 90,
                            overflowY: "auto",
                          }}
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
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--dim)" }}>
                  The .fig binary contains {report.schemaDefsCount} self-describing Kiwi schema type definitions:
                </span>
                <input
                  placeholder="Search types (e.g. Vector, Paint, Node)..."
                  value={schemaSearch}
                  onChange={(e) => setSchemaSearch(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    background: "var(--input)",
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    color: "var(--text)",
                    width: 260,
                  }}
                />
              </div>

              <div
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--bg)",
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: "var(--hover)", textAlign: "left" }}>
                      <th style={{ padding: "8px 12px" }}>Type Name</th>
                      <th style={{ padding: "8px 12px" }}>Kind</th>
                      <th style={{ padding: "8px 12px" }}>Fields Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSchema.slice(0, 100).map((d) => (
                      <tr key={d.name} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={{ padding: "6px 12px", fontFamily: "monospace" }}>{d.name}</td>
                        <td style={{ padding: "6px 12px", color: "var(--dim)" }}>{d.kind}</td>
                        <td style={{ padding: "6px 12px" }}>{d.fieldsCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && report && activeTab === "json" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "var(--dim)" }}>
                  Full decoded Kiwi message payload:
                </span>
                <button
                  className="export-run"
                  style={{ padding: "4px 10px", fontSize: 11 }}
                  onClick={() => {
                    copyText(report.rawMessageJson);
                    toast("Copied JSON payload");
                  }}
                >
                  Copy All JSON
                </button>
              </div>
              <pre
                style={{
                  flex: 1,
                  padding: 12,
                  background: "var(--input)",
                  borderRadius: 8,
                  overflowY: "auto",
                  fontSize: 10,
                  border: "1px solid var(--line)",
                }}
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
