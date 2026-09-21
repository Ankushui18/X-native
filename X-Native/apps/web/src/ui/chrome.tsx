import { useRef, useState } from "react";
import type { Engine, Snapshot, Tool, XNode } from "../engine/types";
import { Icon, TOOL_ICON, kindIcon } from "./icons";

export type NavId = "file" | "assets" | "tools" | "variables" | "agent";

export function NavRail({
  engine,
  nav,
  setNav,
  onActions,
}: {
  engine: Engine;
  nav: NavId;
  setNav: (n: NavId) => void;
  onActions: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const items: { id: NavId; icon: string; label: string; tab?: "layers" | "assets" | "tokens" }[] = [
    { id: "file", icon: "layers", label: "File", tab: "layers" },
    { id: "agent", icon: "agent", label: "Agent" },
    { id: "assets", icon: "component", label: "Assets", tab: "assets" },
    { id: "tools", icon: "tools", label: "Tools" },
    { id: "variables", icon: "vars", label: "Vars", tab: "tokens" },
  ];
  return (
    <nav className="rail">
      <button className="logo" title="Main menu" onClick={() => setMenu((v) => !v)}>
        <Icon name="logo" size={20} />
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button>
              Back to files <span className="sc">⌘Esc</span>
            </button>
            <hr />
            <button onClick={onActions}>
              Actions <span className="sc">⌘K</span>
            </button>
            <button onClick={() => engine.dispatch({ type: "undo" })}>
              Undo <span className="sc">⌘Z</span>
            </button>
            <button onClick={() => engine.dispatch({ type: "redo" })}>
              Redo <span className="sc">⇧⌘Z</span>
            </button>
            <hr />
            <button onClick={() => engine.dispatch({ type: "duplicate" })}>
              Duplicate <span className="sc">⌘D</span>
            </button>
            <button onClick={() => engine.dispatch({ type: "delete" })}>
              Delete <span className="sc">⌫</span>
            </button>
            <hr />
            <button>Preferences</button>
          </div>
        )}
      </button>
      {items.map((it) => (
        <button
          key={it.id}
          className={`nav${nav === it.id ? " on" : ""}`}
          title={it.label}
          onClick={() => {
            setNav(it.id);
            if (it.tab) engine.dispatch({ type: "setLeftTab", tab: it.tab });
          }}
        >
          <Icon name={it.icon} size={16} />
          <span>{it.label}</span>
        </button>
      ))}
      <div className="spacer" />
      <button className="nav" title="File notifications">
        <Icon name="help" size={16} />
        <span>Alerts</span>
      </button>
    </nav>
  );
}

function LayerRow({
  n,
  depth,
  sel,
  engine,
  q,
}: {
  n: XNode;
  depth: number;
  sel: string[];
  engine: Engine;
  q: string;
}) {
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const match = !q || n.name.toLowerCase().includes(q.toLowerCase());
  if (!match && !n.children.some((c) => c.name.toLowerCase().includes(q.toLowerCase()))) {
    return null;
  }
  return (
    <>
      <div
        className={`row${sel.includes(n.id) ? " sel" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => engine.dispatch({ type: "select", ids: [n.id] })}
        onDoubleClick={() => setRenaming(true)}
      >
        {n.children.length ? (
          <button
            className="twist"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            <Icon name={open ? "chevron" : "chevron-right"} size={12} />
          </button>
        ) : (
          <span style={{ width: 16 }} />
        )}
        <Icon name={kindIcon(n.kind, n.imageSrc)} size={14} />
        {renaming ? (
          <input
            className="name"
            autoFocus
            defaultValue={n.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              engine.dispatch({ type: "patch", id: n.id, patch: { name: e.target.value } });
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="name">{n.name}</span>
        )}
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
      {open &&
        n.children.map((c) => (
          <LayerRow key={c.id} n={c} depth={depth + 1} sel={sel} engine={engine} q={q} />
        ))}
    </>
  );
}

export function LeftPanel({
  engine,
  snap,
  nav,
  onMinimize,
}: {
  engine: Engine;
  snap: Snapshot;
  nav: NavId;
  onMinimize: () => void;
}) {
  const [q, setQ] = useState("");
  const [pagesOpen, setPagesOpen] = useState(true);
  const root = snap.pages[snap.page].root;
  return (
    <aside className="panel left">
      <div className="file-head">
        <input
          className="name"
          value={snap.fileName}
          onChange={(e) => engine.dispatch({ type: "setFileName", name: e.target.value })}
        />
        <button className="icon-btn" title="Minimize UI" onClick={onMinimize}>
          <Icon name="minimize" size={14} />
        </button>
      </div>
      {nav === "file" && (
        <>
          <div className="search">
            <Icon name="search" size={14} />
            <input
              placeholder="Find…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="section-label">
            <button className="twist" onClick={() => setPagesOpen((v) => !v)}>
              <Icon name={pagesOpen ? "chevron" : "chevron-right"} size={12} />
            </button>
            Pages
            <span className="grow" />
            <button
              className="icon-btn"
              title="Add page"
              onClick={() => engine.dispatch({ type: "addPage" })}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          {pagesOpen &&
            snap.pages.map((p, i) => (
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
            {root.children.map((n) => (
              <LayerRow key={n.id} n={n} depth={0} sel={snap.selection} engine={engine} q={q} />
            ))}
          </div>
        </>
      )}
      {nav === "assets" && (
        <>
          <div className="search">
            <Icon name="search" size={14} />
            <input placeholder="Search assets…" />
          </div>
          <p className="empty">No published libraries</p>
          <div className="assets-grid">
            <div className="asset-card">Local</div>
            <div className="asset-card">Libraries</div>
          </div>
        </>
      )}
      {nav === "variables" && (
        <>
          <div className="h-row">
            <h3 style={{ margin: 0, fontSize: 11, fontWeight: 500, padding: "8px 4px" }}>
              Color Primitive
            </h3>
            <button className="plus">
              <Icon name="plus" size={14} />
            </button>
          </div>
          <p className="muted">Variables collections live here — same place as Figma’s Variables view.</p>
        </>
      )}
      {nav === "tools" && (
        <p className="muted">Plugins, widgets, and shaders. Open Actions (⌘K) to run a tool.</p>
      )}
      {nav === "agent" && (
        <>
          <div className="file-head">
            <button className="share" style={{ marginLeft: 0 }}>
              New chat
            </button>
          </div>
          <p className="muted">
            Agent history for this file. Chats stay in the left sidebar — same place as Figma’s
            Agents tab.
          </p>
        </>
      )}
    </aside>
  );
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
      { id: "hand", label: "Hand", shortcut: "H" },
      { id: "scale", label: "Scale", shortcut: "K" },
    ],
  },
  {
    id: "region",
    tools: [
      { id: "frame", label: "Frame", shortcut: "F" },
      { id: "section", label: "Section", shortcut: "⇧S" },
      { id: "slice", label: "Slice", shortcut: "S" },
    ],
  },
  {
    id: "shape",
    tools: [
      { id: "rect", label: "Rectangle", shortcut: "R" },
      { id: "line", label: "Line", shortcut: "L" },
      { id: "arrow", label: "Arrow", shortcut: "⇧L" },
      { id: "ellipse", label: "Ellipse", shortcut: "O" },
      { id: "poly", label: "Polygon", shortcut: "" },
      { id: "star", label: "Star", shortcut: "" },
      { id: "image", label: "Place image/video…", shortcut: "⇧I" },
    ],
  },
  {
    id: "pen",
    tools: [
      { id: "pen", label: "Pen", shortcut: "P" },
      { id: "pencil", label: "Pencil", shortcut: "⇧P" },
    ],
  },
  { id: "text", tools: [{ id: "text", label: "Text", shortcut: "T" }] },
  { id: "comment", tools: [{ id: "comment", label: "Comment", shortcut: "C" }] },
];

export function Toolbar({
  engine,
  snap,
  onActions,
}: {
  engine: Engine;
  snap: Snapshot;
  onActions: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const hold = useRef<number | null>(null);
  const last = (g: Group) => g.tools.find((t) => t.id === snap.tool)?.id ?? g.tools[0].id;

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
            onMouseLeave={() => {
              if (hold.current) window.clearTimeout(hold.current);
              setOpen((o) => (o === g.id ? null : o));
            }}
          >
            <button
              className="hit"
              title={g.tools.find((t) => t.id === current)?.label}
              onClick={() => engine.dispatch({ type: "setTool", tool: current })}
              onPointerDown={() => {
                if (!multi) return;
                hold.current = window.setTimeout(() => setOpen(g.id), 280);
              }}
              onPointerUp={() => {
                if (hold.current) window.clearTimeout(hold.current);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (multi) setOpen(g.id);
              }}
            >
              <Icon name={TOOL_ICON[current]} size={16} />
              {multi && <i className="caret" />}
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
        <button className="hit" title="Resources">
          <Icon name="resources" size={16} />
        </button>
      </div>
      <div className={`tool${snap.rightTab === "inspect" ? " active" : ""}`}>
        <button
          className="hit"
          title="Dev Mode"
          onClick={() =>
            engine.dispatch({
              type: "setRightTab",
              tab: snap.rightTab === "inspect" ? "design" : "inspect",
            })
          }
        >
          <Icon name="dev" size={16} />
        </button>
      </div>
      <div className="tool">
        <button className="hit" title="Actions" onClick={onActions}>
          <Icon name="search" size={16} />
        </button>
      </div>
    </div>
  );
}

export function Actions({
  engine,
  onClose,
  onHide,
  onMinimize,
}: {
  engine: Engine;
  onClose: () => void;
  onHide: () => void;
  onMinimize?: () => void;
}) {
  const [q, setQ] = useState("");
  const items = [
    { label: "Undo", sc: "⌘Z", run: () => engine.dispatch({ type: "undo" }) },
    { label: "Redo", sc: "⇧⌘Z", run: () => engine.dispatch({ type: "redo" }) },
    { label: "Duplicate", sc: "⌘D", run: () => engine.dispatch({ type: "duplicate" }) },
    { label: "Delete", sc: "⌫", run: () => engine.dispatch({ type: "delete" }) },
    { label: "Hide UI", sc: "⌘\\", run: onHide },
    { label: "Minimize UI", sc: "⇧⌘\\", run: () => onMinimize?.() },
    { label: "Dev Mode", sc: "⇧D", run: () => engine.dispatch({ type: "setRightTab", tab: "inspect" }) },
    { label: "Zoom to 100%", sc: "⇧0", run: () => engine.dispatch({ type: "setZoom", zoom: 1 }) },
    { label: "Zoom to fit", sc: "⇧1", run: () => engine.dispatch({ type: "setZoom", zoom: 0.5 }) },
  ].filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="actions">
      <input
        autoFocus
        placeholder="Type a command or search…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && items[0]) {
            items[0].run();
            onClose();
          }
        }}
      />
      {items.map((i) => (
        <button
          key={i.label}
          onClick={() => {
            i.run();
            onClose();
          }}
        >
          {i.label}
          <span className="sc">{i.sc}</span>
        </button>
      ))}
    </div>
  );
}

export function bindHotkeys(
  engine: Engine,
  extra: {
    onActions: () => void;
    onHide: () => void;
    onMinimize: () => void;
    onNav?: (n: NavId) => void;
  },
) {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      extra.onActions();
      return;
    }
    if (meta && e.shiftKey && e.key === "\\") {
      e.preventDefault();
      extra.onMinimize();
      return;
    }
    if (meta && e.key === "\\") {
      e.preventDefault();
      extra.onHide();
      return;
    }
    if (e.shiftKey && e.key.toLowerCase() === "d" && !meta) {
      e.preventDefault();
      const cur = engine.snapshot().rightTab;
      engine.dispatch({ type: "setRightTab", tab: cur === "inspect" ? "design" : "inspect" });
      return;
    }
    if (e.altKey && extra.onNav) {
      if (e.key === "1") {
        extra.onNav("file");
        engine.dispatch({ type: "setLeftTab", tab: "layers" });
      }
      if (e.key === "2") {
        extra.onNav("assets");
        engine.dispatch({ type: "setLeftTab", tab: "assets" });
      }
      if (e.key === "3") {
        extra.onNav("variables");
        engine.dispatch({ type: "setLeftTab", tab: "tokens" });
      }
    }
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
      i: "image",
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

export function usePanelDrag(
  width: number,
  set: (n: number) => void,
  min: number,
  max: number,
  invert = false,
) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const wref = useRef(width);
  wref.current = width;
  return {
    onPointerDown: (e: React.PointerEvent) => {
      start.current = { x: e.clientX, w: wref.current };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current) return;
      const dx = e.clientX - start.current.x;
      const next = invert ? start.current.w - dx : start.current.w + dx;
      set(Math.min(max, Math.max(min, next)));
    },
    onPointerUp: () => {
      start.current = null;
    },
  };
}

export function HelpBtn() {
  return (
    <button className="help" title="Help">
      <Icon name="help" size={14} />
    </button>
  );
}
