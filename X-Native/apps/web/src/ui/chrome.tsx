import type { Engine, LeftTab, RightTab, Snapshot, Tool, XNode } from "../engine/types";
import { TOOL_META } from "../engine/types";
import { defaultLayout, worldPos } from "../engine/memory";
import { Icon, TOOL_ICON } from "./icons";

export function TitleBar({ snap }: { snap: Snapshot }) {
  return (
    <header className="title">
      <div className="logo" title="X-Native">
        <svg viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="1.6">
          <path d="M2 12L12 2M4 2h8v8" />
        </svg>
      </div>
      <div className="file-tab">{snap.fileName}</div>
      <div className="spacer" />
      <span className="muted">Web chrome · engine API</span>
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
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => engine.dispatch({ type: "select", ids: [n.id] })}
      >
        <Icon name={kindIcon(n.kind)} className="icon icon-sm" />
        <span className="name">{n.name}</span>
        <button
          className="mini"
          title={n.visible ? "Hide" : "Show"}
          onClick={(e) => {
            e.stopPropagation();
            engine.dispatch({ type: "patch", id: n.id, patch: { visible: !n.visible } });
          }}
        >
          <Icon name={n.visible ? "eye" : "eye-off"} className="icon icon-sm" />
        </button>
        <button
          className="mini"
          title={n.locked ? "Unlock" : "Lock"}
          onClick={(e) => {
            e.stopPropagation();
            engine.dispatch({ type: "patch", id: n.id, patch: { locked: !n.locked } });
          }}
        >
          <Icon name={n.locked ? "lock" : "unlock"} className="icon icon-sm" />
        </button>
      </div>
      {n.children.map((c) => (
        <LayerRow key={c.id} n={c} depth={depth + 1} sel={sel} engine={engine} />
      ))}
    </>
  );
}

function kindIcon(k: XNode["kind"]): string {
  switch (k) {
    case "frame":
      return "frame";
    case "ellipse":
      return "circle";
    case "text":
      return "type";
    case "line":
      return "line";
    case "star":
      return "star";
    case "poly":
      return "triangle";
    default:
      return "square";
  }
}

export function LeftPanel({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const root = snap.pages[snap.page].root;
  const tabs: { id: LeftTab; label: string }[] = [
    { id: "layers", label: "Layers" },
    { id: "assets", label: "Assets" },
    { id: "tokens", label: "Tokens" },
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
      <div className="section-label">Pages</div>
      <div>
        {snap.pages.map((p, i) => (
          <div
            key={p.id}
            className={`row${i === snap.page ? " sel" : ""}`}
            onClick={() => engine.dispatch({ type: "setPage", index: i })}
          >
            <span className="name">{p.name}</span>
          </div>
        ))}
        <button className="ghost" onClick={() => engine.dispatch({ type: "addPage" })}>
          + Add page
        </button>
      </div>
      <div className="section-label">Layers</div>
      <div className="tree">
        {snap.leftTab !== "layers" ? (
          <p className="empty">
            {snap.leftTab === "assets" ? "No local libraries" : "Tokens live on the native TOKENS tab"}
          </p>
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
        <button
          className="zoom-chip"
          title="Zoom menu"
          onClick={() => engine.dispatch({ type: "setZoom", zoom: snap.zoom === 1 ? 0.75 : 1 })}
        >
          {Math.round(snap.zoom * 100)}%
        </button>
      </div>
      <div className="inspector">
        {snap.rightTab === "prototype" && (
          <p className="muted">
            Prototype interactions stay in the native FLOW player (`x-editor`). Connect frames there;
            this chrome only authors Design properties.
          </p>
        )}
        {snap.rightTab === "inspect" && (
          <p className="muted">
            Inspect emits CSS / SwiftUI / Compose / XML / Tailwind / JSX from `x-format::codegen` in
            the native app. Selection: {n ? n.name : "none"}.
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
      const dx = key === "x" ? v - x : 0;
      const dy = key === "y" ? v - y : 0;
      engine.dispatch({ type: "move", ids: [n.id], dx, dy });
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
      <div className="grid2">
        <Field label="W" value={n.w} onChange={(v) => num("w", v)} />
        <Field label="H" value={n.h} onChange={(v) => num("h", v)} />
        <Field label="X" value={x} onChange={(v) => num("x", v)} />
        <Field label="Y" value={y} onChange={(v) => num("y", v)} />
        <Field label="∠" value={n.rotation} onChange={(v) => num("rotation", v)} />
        <Field
          label="R"
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
          title="Add auto layout"
          onClick={() =>
            engine.dispatch({
              type: "autoLayout",
              id: n.id,
              layout: n.layout ? null : defaultLayout(),
            })
          }
        >
          <Icon name={n.layout ? "x-mark" : "plus"} className="icon icon-sm" />
        </button>
      </div>
      {n.layout && (
        <div className="grid2">
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
          <button
            className="ghost"
            onClick={() =>
              engine.dispatch({
                type: "autoLayout",
                id: n.id,
                layout: {
                  ...n.layout!,
                  direction: n.layout!.direction === "horizontal" ? "vertical" : "horizontal",
                },
              })
            }
          >
            {n.layout.direction === "horizontal" ? "Horizontal" : "Vertical"}
          </button>
        </div>
      )}
      <div className="hr" />
      <h3>Fill</h3>
      <ColorRow
        value={n.fill}
        onChange={(fill) => engine.dispatch({ type: "patch", id: n.id, patch: { fill } })}
      />
      <h3>Stroke</h3>
      <ColorRow
        value={n.strokePaint}
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
      {n.kind === "text" && (
        <>
          <div className="hr" />
          <h3>Typography</h3>
          <input
            className="hex"
            value={n.text}
            onChange={(e) =>
              engine.dispatch({ type: "patch", id: n.id, patch: { text: e.target.value } })
            }
          />
          <Field label="S" value={n.fontSize} onChange={(v) => num("fontSize", v)} />
        </>
      )}
      <div className="hr" />
      <Field label="%" value={n.opacity * 100} onChange={(v) => num("opacity", v / 100)} />
    </>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
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

function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hex = value.length === 9 ? value.slice(0, 7) : value;
  return (
    <div className="color-row">
      <label className="swatch" style={{ background: hex }}>
        <input type="color" value={hex || "#000000"} onChange={(e) => onChange(e.target.value)} />
      </label>
      <input className="hex" value={hex.replace("#", "")} onChange={(e) => onChange("#" + e.target.value)} />
    </div>
  );
}

function fmt(v: number) {
  const r = Math.round(v);
  return Math.abs(v - r) < 0.05 ? String(r) : v.toFixed(1);
}

export function Toolbar({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  return (
    <div className="dock" role="toolbar" aria-label="Tools">
      {TOOL_META.map((t) => (
        <button
          key={t.id}
          className={snap.tool === t.id ? "active" : ""}
          title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
          onClick={() => engine.dispatch({ type: "setTool", tool: t.id as Tool })}
        >
          <Icon name={TOOL_ICON[t.id]} />
        </button>
      ))}
      <div className="div" />
      <button title="Command palette (⌘K)" onClick={() => {}}>
        <Icon name="search" />
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
