import { useState } from "react";
import type { Engine, LeftTab, RightTab, Snapshot, Tool, XNode } from "../engine/types";
import { defaultLayout, worldPos } from "../engine/memory";
import { Icon, TOOL_ICON, kindIcon } from "./icons";

export function TitleBar({ snap }: { snap: Snapshot }) {
  return (
    <header className="title">
      <button className="brand" title="Main menu">
        <Icon name="figma" size={18} />
        <Icon name="chevron" size={12} />
      </button>
      <div className="file-name">{snap.fileName}</div>
      <div className="spacer" />
      <button className="icon-btn" title="Present">
        <Icon name="play" />
      </button>
      <button className="share">Share</button>
    </header>
  );
}

function LayerRow({
  n,
  depth,
  sel,
  engine,
}: {
  n: XNode;
  depth: number;
  sel: string[];
  engine: Engine;
}) {
  return (
    <>
      <div
        className={`row${sel.includes(n.id) ? " sel" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => engine.dispatch({ type: "select", ids: [n.id] })}
      >
        <Icon name={kindIcon(n.kind)} size={14} />
        <span className="name">{n.name}</span>
        <button
          className="mini"
          title={n.visible ? "Hide" : "Show"}
          onClick={(e) => {
            e.stopPropagation();
            engine.dispatch({ type: "patch", id: n.id, patch: { visible: !n.visible } });
          }}
        >
          <Icon name={n.visible ? "eye" : "eye-off"} size={14} />
        </button>
        <button
          className="mini"
          title={n.locked ? "Unlock" : "Lock"}
          onClick={(e) => {
            e.stopPropagation();
            engine.dispatch({ type: "patch", id: n.id, patch: { locked: !n.locked } });
          }}
        >
          <Icon name={n.locked ? "lock" : "unlock"} size={14} />
        </button>
      </div>
      {n.children.map((c) => (
        <LayerRow key={c.id} n={c} depth={depth + 1} sel={sel} engine={engine} />
      ))}
    </>
  );
}

export function LeftPanel({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const root = snap.pages[snap.page].root;
  const tabs: { id: LeftTab; label: string }[] = [
    { id: "layers", label: "Layers" },
    { id: "assets", label: "Assets" },
  ];
  return (
    <aside className="panel left">
      <div className="pills">
        {tabs.map((t) => (
          <button
            key={t.id}
            aria-pressed={snap.leftTab === t.id}
            onClick={() => engine.dispatch({ type: "setLeftTab", tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="section-label">
        <Icon name="chevron" size={12} />
        Pages
      </div>
      {snap.pages.map((p, i) => (
        <div
          key={p.id}
          className={`row${i === snap.page ? " sel" : ""}`}
          onClick={() => engine.dispatch({ type: "setPage", index: i })}
        >
          <Icon name="page" size={14} />
          <span className="name">{p.name}</span>
        </div>
      ))}
      <div className="section-label">
        <Icon name="chevron" size={12} />
        Layers
      </div>
      <div className="tree">
        {snap.leftTab !== "layers" ? (
          <p className="empty">No published libraries</p>
        ) : (
          root.children.map((n) => (
            <LayerRow key={n.id} n={n} depth={0} sel={snap.selection} engine={engine} />
          ))
        )}
      </div>
    </aside>
  );
}

export function RightPanel({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const tabs: { id: RightTab; label: string }[] = [
    { id: "design", label: "Design" },
    { id: "prototype", label: "Prototype" },
    { id: "inspect", label: "Inspect" },
  ];
  const root = snap.pages[snap.page].root;
  const id = snap.selection[0];
  const wp = id ? worldPos(root, id) : null;
  const n = wp?.node;
  return (
    <aside className="panel right">
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            aria-current={snap.rightTab === t.id}
            onClick={() => engine.dispatch({ type: "setRightTab", tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="inspector">
        {snap.rightTab === "prototype" && (
          <p className="muted">
            Drag the blue node on the right of a selected frame to connect a flow — Prototype tab
            in Figma.
          </p>
        )}
        {snap.rightTab === "inspect" && (
          <p className="muted">
            Dev Mode: CSS, iOS, Android, and Tailwind from the selection. Native Inspect still
            owns codegen.
          </p>
        )}
        {snap.rightTab === "design" && !n && (
          <p className="empty">Select a layer to edit properties</p>
        )}
        {snap.rightTab === "design" && n && wp && (
          <Design n={n} x={wp.x} y={wp.y} engine={engine} />
        )}
      </div>
    </aside>
  );
}

function Design({
  n,
  x,
  y,
  engine,
}: {
  n: XNode;
  x: number;
  y: number;
  engine: Engine;
}) {
  const num = (key: "x" | "y" | "w" | "h" | "rotation" | "opacity" | "fontSize", v: number) => {
    if (key === "x" || key === "y") {
      engine.dispatch({
        type: "move",
        ids: [n.id],
        dx: key === "x" ? v - x : 0,
        dy: key === "y" ? v - y : 0,
      });
      return;
    }
    if (key === "w" || key === "h") {
      engine.dispatch({
        type: "resize",
        id: n.id,
        x: n.x,
        y: n.y,
        w: key === "w" ? v : n.w,
        h: key === "h" ? v : n.h,
      });
      return;
    }
    engine.dispatch({ type: "patch", id: n.id, patch: { [key]: v } });
  };
  return (
    <>
      <div className="insp-pad">
        <div className="align">
          {["align-left", "align-hcenter", "align-right", "align-top", "align-vcenter", "align-bottom"].map(
            (ic) => (
              <button key={ic} title={ic}>
                <Icon name={ic} />
              </button>
            ),
          )}
        </div>
        <div className="grid2">
          <Field label="X" value={x} onChange={(v) => num("x", v)} />
          <Field label="Y" value={y} onChange={(v) => num("y", v)} />
          <Field label="W" value={n.w} onChange={(v) => num("w", v)} />
          <Field label="H" value={n.h} onChange={(v) => num("h", v)} />
          <Field icon="rotate" value={n.rotation} onChange={(v) => num("rotation", v)} />
          <Field
            icon="radius"
            value={n.cornerRadii[0]}
            onChange={(v) =>
              engine.dispatch({
                type: "patch",
                id: n.id,
                patch: { cornerRadii: [v, v, v, v] },
              })
            }
          />
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={n.overflow !== "visible"}
          onChange={(e) =>
            engine.dispatch({
              type: "patch",
              id: n.id,
              patch: { overflow: e.target.checked ? "clip" : "visible" },
            })
          }
        />
        Clip content
      </label>
      <div className="hr" />
      <div className="h-row">
        <h3>Auto layout</h3>
        <button
          className="plus"
          title={n.layout ? "Remove auto layout" : "Add auto layout"}
          onClick={() =>
            engine.dispatch({
              type: "autoLayout",
              id: n.id,
              layout: n.layout ? null : defaultLayout(),
            })
          }
        >
          <Icon name={n.layout ? "minus" : "plus"} size={14} />
        </button>
      </div>
      {n.layout && (
        <>
          <div className="dir-btns">
            <button
              className={n.layout.direction === "horizontal" ? "on" : ""}
              title="Horizontal"
              onClick={() =>
                engine.dispatch({
                  type: "autoLayout",
                  id: n.id,
                  layout: { ...n.layout!, direction: "horizontal" },
                })
              }
            >
              <Icon name="layout-h" />
            </button>
            <button
              className={n.layout.direction === "vertical" ? "on" : ""}
              title="Vertical"
              onClick={() =>
                engine.dispatch({
                  type: "autoLayout",
                  id: n.id,
                  layout: { ...n.layout!, direction: "vertical" },
                })
              }
            >
              <Icon name="layout-v" />
            </button>
          </div>
          <div className="insp-pad">
            <Field
              label="G"
              value={n.layout.gap}
              onChange={(v) =>
                engine.dispatch({
                  type: "autoLayout",
                  id: n.id,
                  layout: { ...n.layout!, gap: v },
                })
              }
            />
          </div>
        </>
      )}
      <div className="hr" />
      <div className="h-row">
        <h3>Fill</h3>
        <button className="plus" title="Add fill">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="insp-pad">
        <ColorRow
          value={n.fill}
          opacity={Math.round(n.opacity * 100)}
          onChange={(fill) => engine.dispatch({ type: "patch", id: n.id, patch: { fill } })}
          onOpacity={(v) => num("opacity", v / 100)}
        />
      </div>
      <div className="h-row">
        <h3>Stroke</h3>
        <button className="plus">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
        <ColorRow
          value={n.strokePaint}
          opacity={100}
          onChange={(strokePaint) =>
            engine.dispatch({ type: "patch", id: n.id, patch: { strokePaint } })
          }
        />
        <Field
          label="W"
          value={n.strokeWidth}
          onChange={(strokeWidth) =>
            engine.dispatch({ type: "patch", id: n.id, patch: { strokeWidth } })
          }
        />
      </div>
      {n.kind === "text" && (
        <>
          <div className="hr" />
          <div className="h-row">
            <h3>Typography</h3>
          </div>
          <div className="insp-pad" style={{ display: "grid", gap: 4 }}>
            <input
              className="hex"
              style={{
                height: 32,
                background: "var(--input)",
                borderRadius: 6,
                padding: "0 8px",
                textTransform: "none",
              }}
              value={n.text}
              onChange={(e) =>
                engine.dispatch({ type: "patch", id: n.id, patch: { text: e.target.value } })
              }
            />
            <Field label="S" value={n.fontSize} onChange={(v) => num("fontSize", v)} />
          </div>
        </>
      )}
      <div className="hr" />
      <div className="h-row">
        <h3>Effects</h3>
        <button className="plus">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="h-row">
        <h3>Export</h3>
        <button className="plus">
          <Icon name="plus" size={14} />
        </button>
      </div>
    </>
  );
}

function Field({
  label,
  icon,
  value,
  onChange,
}: {
  label?: string;
  icon?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      {icon ? <Icon name={icon} size={14} /> : <label>{label}</label>}
      <input
        value={fmt(value)}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

function ColorRow({
  value,
  opacity = 100,
  onChange,
  onOpacity,
}: {
  value: string;
  opacity?: number;
  onChange: (v: string) => void;
  onOpacity?: (v: number) => void;
}) {
  const hex = value.length >= 7 ? value.slice(0, 7) : "#000000";
  return (
    <div className="color-row">
      <label className="swatch" style={{ background: hex }}>
        <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} />
      </label>
      <input
        className="hex"
        value={hex.replace("#", "")}
        onChange={(e) => onChange("#" + e.target.value.replace("#", ""))}
      />
      {onOpacity && (
        <input
          className="op"
          value={`${opacity}%`}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onOpacity(v);
          }}
        />
      )}
    </div>
  );
}

function fmt(v: number) {
  const r = Math.round(v);
  return Math.abs(v - r) < 0.05 ? String(r) : v.toFixed(1);
}

type Group = {
  id: string;
  tools: { id: Tool; label: string; shortcut: string }[];
};

const GROUPS: Group[] = [
  {
    id: "move",
    tools: [
      { id: "select", label: "Move", shortcut: "V" },
      { id: "scale", label: "Scale", shortcut: "K" },
    ],
  },
  {
    id: "frame",
    tools: [
      { id: "frame", label: "Frame", shortcut: "F" },
      { id: "slice", label: "Slice", shortcut: "S" },
    ],
  },
  {
    id: "shape",
    tools: [
      { id: "rect", label: "Rectangle", shortcut: "R" },
      { id: "ellipse", label: "Ellipse", shortcut: "O" },
      { id: "line", label: "Line", shortcut: "L" },
      { id: "arrow", label: "Arrow", shortcut: "⇧L" },
      { id: "poly", label: "Polygon", shortcut: "" },
      { id: "star", label: "Star", shortcut: "" },
    ],
  },
  {
    id: "pen",
    tools: [
      { id: "pen", label: "Pen", shortcut: "P" },
      { id: "pencil", label: "Pencil", shortcut: "⇧P" },
      { id: "brush", label: "Brush", shortcut: "B" },
      { id: "eraser", label: "Eraser", shortcut: "⇧E" },
    ],
  },
  { id: "text", tools: [{ id: "text", label: "Text", shortcut: "T" }] },
  { id: "comment", tools: [{ id: "comment", label: "Comment", shortcut: "C" }] },
  { id: "hand", tools: [{ id: "hand", label: "Hand", shortcut: "H" }] },
];

export function Toolbar({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const [open, setOpen] = useState<string | null>(null);
  const last = (g: Group) =>
    g.tools.find((t) => t.id === snap.tool)?.id ?? g.tools[0].id;

  return (
    <div className="dock" role="toolbar" aria-label="Tools">
      {GROUPS.map((g) => {
        const current = last(g);
        const active = g.tools.some((t) => t.id === snap.tool);
        const multi = g.tools.length > 1;
        return (
          <div
            key={g.id}
            className={`tool${active ? " active" : ""}${open === g.id ? " open" : ""}`}
            onMouseLeave={() => setOpen((o) => (o === g.id ? null : o))}
          >
            <button
              className="hit"
              title={g.tools.find((t) => t.id === current)?.label}
              onClick={() => engine.dispatch({ type: "setTool", tool: current })}
              onContextMenu={(e) => {
                e.preventDefault();
                if (multi) setOpen(g.id);
              }}
            >
              <Icon name={TOOL_ICON[current]} size={16} />
            </button>
            {multi && (
              <div className="fly">
                {g.tools.map((t) => (
                  <button
                    key={t.id}
                    className={snap.tool === t.id ? "on" : ""}
                    onClick={() => {
                      engine.dispatch({ type: "setTool", tool: t.id });
                      setOpen(null);
                    }}
                  >
                    <Icon name={TOOL_ICON[t.id]} size={16} />
                    {t.label}
                    {t.shortcut && <span className="sc">{t.shortcut}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="div" />
      <div className="tool">
        <button className="hit" title="Actions">
          <Icon name="search" size={16} />
        </button>
      </div>
    </div>
  );
}

export function ZoomBar({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  return (
    <div className="zoom-bar">
      <button
        title="Zoom out"
        onClick={() => engine.dispatch({ type: "setZoom", zoom: snap.zoom / 1.2 })}
      >
        <Icon name="zoom-out" size={14} />
      </button>
      <span>{Math.round(snap.zoom * 100)}%</span>
      <button
        title="Zoom in"
        onClick={() => engine.dispatch({ type: "setZoom", zoom: snap.zoom * 1.2 })}
      >
        <Icon name="zoom-in" size={14} />
      </button>
    </div>
  );
}

export function bindHotkeys(engine: Engine) {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      engine.dispatch({ type: e.shiftKey ? "redo" : "undo" });
      return;
    }
    if (meta && e.key.toLowerCase() === "d") {
      e.preventDefault();
      engine.dispatch({ type: "duplicate" });
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      engine.dispatch({ type: "delete" });
      return;
    }
    if (e.key === "Escape") {
      engine.dispatch({ type: "select", ids: [] });
      engine.dispatch({ type: "setTool", tool: "select" });
      return;
    }
    const map: Record<string, Tool> = {
      v: "select",
      k: "scale",
      f: "frame",
      t: "text",
      r: "rect",
      o: "ellipse",
      l: "line",
      p: "pen",
      h: "hand",
      b: "brush",
      c: "comment",
      s: "slice",
    };
    if (!meta && map[e.key.toLowerCase()]) {
      engine.dispatch({ type: "setTool", tool: map[e.key.toLowerCase()] });
    }
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") engine.dispatch({ type: "nudge", dx: -step, dy: 0 });
    if (e.key === "ArrowRight") engine.dispatch({ type: "nudge", dx: step, dy: 0 });
    if (e.key === "ArrowUp") engine.dispatch({ type: "nudge", dx: 0, dy: -step });
    if (e.key === "ArrowDown") engine.dispatch({ type: "nudge", dx: 0, dy: step });
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
