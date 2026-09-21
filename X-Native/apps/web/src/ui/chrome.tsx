import { useRef, useState } from "react";
import type { Engine, Snapshot, Tool, XNode } from "../engine/types";
import { collectColors, defaultLayout } from "../engine/memory";
import { Icon, TOOL_ICON, kindIcon } from "./icons";
import { useTheme, type ThemePref } from "./theme";
import { ContextMenu, isGroupNode, layerMenu, pageMenu, runMenu } from "./ContextMenu";

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
  const { pref, setPref } = useTheme();
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
            <button
              onClick={() => {
                engine.dispatch({ type: "select", ids: [] });
                engine.dispatch({ type: "setPage", index: 0 });
                setMenu(false);
              }}
            >
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
            <div className="kicker">Theme</div>
            {(["light", "dark", "graphite", "daylight", "system"] as ThemePref[]).map((p) => (
              <button key={p} className={pref === p ? "on" : ""} onClick={() => setPref(p)}>
                {p === "light"
                  ? "Light"
                  : p === "dark"
                    ? "Dark"
                    : p === "graphite"
                      ? "Graphite"
                      : p === "daylight"
                        ? "Daylight"
                        : "System"}
                {pref === p && <span className="sc">✓</span>}
              </button>
            ))}
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
      <button
        className="nav"
        title="File notifications"
        onClick={() => window.alert("You're up to date. No file notifications.")}
      >
        <Icon name="page" size={16} />
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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const match = !q || n.name.toLowerCase().includes(q.toLowerCase());
  if (!match && !n.children.some((c) => c.name.toLowerCase().includes(q.toLowerCase()))) {
    return null;
  }
  return (
    <>
      <div
        className={`row${sel.includes(n.id) ? " sel" : ""}${n.isComponent || n.kind === "component" || n.kind === "instance" ? " comp" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => engine.dispatch({ type: "select", ids: [n.id] })}
        onDoubleClick={() => setRenaming(true)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          engine.dispatch({ type: "select", ids: [n.id] });
          setMenu({ x: e.clientX, y: e.clientY });
        }}
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
        <Icon
          name={
            n.isComponent || n.kind === "component" || n.kind === "instance"
              ? "component"
              : kindIcon(n.kind, n.imageSrc)
          }
          size={14}
        />
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={layerMenu(isGroupNode(n))}
          onRun={(id) => runMenu(engine, id, { onRename: () => setRenaming(true) })}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

export function LeftPanel({
  engine,
  snap,
  nav,
  onMinimize,
  onActions,
}: {
  engine: Engine;
  snap: Snapshot;
  nav: NavId;
  onMinimize: () => void;
  onActions?: () => void;
}) {
  const [q, setQ] = useState("");
  const [pagesOpen, setPagesOpen] = useState(true);
  const [pageMenuAt, setPageMenuAt] = useState<{ x: number; y: number; i: number } | null>(null);
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  engine.dispatch({ type: "setPage", index: i });
                  setPageMenuAt({ x: e.clientX, y: e.clientY, i });
                }}
                onDoubleClick={() => {
                  const name = window.prompt("Rename page", p.name);
                  if (name) engine.dispatch({ type: "renamePage", name });
                }}
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
      {nav === "assets" && <AssetsPane engine={engine} snap={snap} />}
      {nav === "variables" && <VarsPane engine={engine} snap={snap} />}
      {nav === "tools" && <ToolsPane onActions={onActions} />}
      {nav === "agent" && <AgentPane engine={engine} />}
      {pageMenuAt && (
        <ContextMenu
          x={pageMenuAt.x}
          y={pageMenuAt.y}
          items={pageMenu(snap.pages.length > 1)}
          onRun={(id) =>
            runMenu(engine, id, {
              onRename: () => {
                const p = snap.pages[pageMenuAt.i];
                const name = window.prompt("Rename page", p.name);
                if (name) engine.dispatch({ type: "renamePage", name });
              },
            })
          }
          onClose={() => setPageMenuAt(null)}
        />
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
        <button className="hit" title="Resources" onClick={onActions}>
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
  const { setPref } = useTheme();
  const items = [
    { label: "Undo", sc: "⌘Z", run: () => engine.dispatch({ type: "undo" }) },
    { label: "Redo", sc: "⇧⌘Z", run: () => engine.dispatch({ type: "redo" }) },
    { label: "Duplicate", sc: "⌘D", run: () => engine.dispatch({ type: "duplicate" }) },
    { label: "Delete", sc: "⌫", run: () => engine.dispatch({ type: "delete" }) },
    { label: "Hide UI", sc: "⌘\\", run: onHide },
    { label: "Minimize UI", sc: "⇧⌘\\", run: () => onMinimize?.() },
    { label: "Dev Mode", sc: "⇧D", run: () => engine.dispatch({ type: "setRightTab", tab: "inspect" }) },
    { label: "Theme: Light", sc: "", run: () => setPref("light") },
    { label: "Theme: Dark", sc: "", run: () => setPref("dark") },
    { label: "Theme: Graphite", sc: "", run: () => setPref("graphite") },
    { label: "Theme: Daylight", sc: "", run: () => setPref("daylight") },
    { label: "Theme: System", sc: "", run: () => setPref("system") },
    { label: "Create component", sc: "⌘⌥K", run: () => engine.dispatch({ type: "makeComponent" }) },
    { label: "Union", sc: "⌘⌥U", run: () => engine.dispatch({ type: "boolean", op: "union" }) },
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
    onPresentExit?: () => void;
  },
) {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if (engine.snapshot().presentFrame && e.key !== "Escape") return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      engine.dispatch({ type: "makeComponent" });
      return;
    }
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
    if (meta && !e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      engine.dispatch({ type: "copy" });
      return;
    }
    if (meta && !e.altKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      engine.dispatch({ type: "cut" });
      return;
    }
    if (meta && e.key.toLowerCase() === "v") {
      e.preventDefault();
      engine.dispatch({ type: "paste" });
      return;
    }
    if (meta && e.key.toLowerCase() === "a") {
      e.preventDefault();
      engine.dispatch({ type: "selectAll" });
      return;
    }
    if (meta && e.key.toLowerCase() === "g") {
      e.preventDefault();
      engine.dispatch({ type: e.shiftKey ? "ungroup" : "group" });
      return;
    }
    if (meta && e.key === "]") {
      e.preventDefault();
      engine.dispatch({ type: "arrange", dir: e.shiftKey ? "front" : "forward" });
      return;
    }
    if (meta && e.key === "[") {
      e.preventDefault();
      engine.dispatch({ type: "arrange", dir: e.shiftKey ? "back" : "backward" });
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      engine.dispatch({ type: "lockSel" });
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      engine.dispatch({ type: "hideSel" });
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      engine.dispatch({ type: "delete" });
      return;
    }
    if (e.key === "Escape") {
      if (engine.snapshot().presentFrame) {
        extra.onPresentExit?.();
        return;
      }
      extra.onPresentExit?.();
      engine.dispatch({ type: "select", ids: [] });
      engine.dispatch({ type: "setTool", tool: "select" });
      return;
    }
    if (meta && e.altKey && e.key.toLowerCase() === "u") {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "union" });
      return;
    }
    if (meta && e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "subtract" });
      return;
    }
    if (meta && e.altKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "intersect" });
      return;
    }
    if (meta && e.altKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "exclude" });
      return;
    }
    if (!meta && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const id = engine.snapshot().selection[0];
      if (id) engine.dispatch({ type: "autoLayout", id, layout: defaultLayout() });
      return;
    }
    if (!meta && e.shiftKey && e.code === "Digit0") {
      e.preventDefault();
      engine.dispatch({ type: "setZoom", zoom: 1 });
      return;
    }
    if (!meta && e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      engine.dispatch({ type: "setZoom", zoom: 0.5 });
      return;
    }
    if (!meta && e.shiftKey) {
      const shifted: Record<string, Tool> = {
        s: "section",
        p: "pencil",
        l: "arrow",
        i: "image",
        e: "eraser",
      };
      const t = shifted[e.key.toLowerCase()];
      if (t) {
        e.preventDefault();
        engine.dispatch({ type: "setTool", tool: t });
        return;
      }
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

function AssetsPane({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const [q, setQ] = useState("");
  const comps = snap.components.filter(
    (c) => !q || c.name.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <div className="search">
        <Icon name="search" size={14} />
        <input placeholder="Search assets…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="section-label">Local components</div>
      <div className="tree">
        {comps.length === 0 && (
          <p className="empty">Create a component (⌘⌥K) to see it here. Double-click to place an instance.</p>
        )}
        {comps.map((c) => (
          <div
            key={c.id}
            className="row"
            onDoubleClick={() =>
              engine.dispatch({ type: "placeComponent", id: c.id, x: 80, y: 80 })
            }
          >
            <Icon name="component" size={14} />
            <span className="name">{c.name}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function VarsPane({ engine, snap }: { engine: Engine; snap: Snapshot }) {
  const colors = Array.from(new Set(collectColors(snap.pages[snap.page].root)));
  return (
    <>
      <div className="h-row">
        <h3 style={{ margin: 0, fontSize: 11, fontWeight: 500, padding: "8px 4px" }}>Color Primitive</h3>
        <button
          className="plus"
          title="Add from selection"
          onClick={() => {
            const id = snap.selection[0];
            if (id) engine.dispatch({ type: "copyCode" });
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="insp-pad" style={{ display: "grid", gap: 4, padding: "0 12px" }}>
        {colors.length === 0 && <p className="muted">No colors in this file yet.</p>}
        {colors.map((c) => (
          <button
            key={c}
            className="color-row"
            style={{ width: "100%", textAlign: "left" }}
            onClick={() => {
              const id = snap.selection[0];
              if (id) engine.dispatch({ type: "patch", id, patch: { fill: c, fillVisible: true } });
            }}
          >
            <span className="swatch" style={{ background: c }} />
            <span className="hex">{c.replace("#", "")}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function ToolsPane({ onActions }: { onActions?: () => void }) {
  const tools = ["Place image", "Duplicate", "Group", "Undo", "Redo", "Zoom to 100%"];
  return (
    <>
      <p className="muted">Plugins and actions for this file.</p>
      <div className="presets">
        {tools.map((t) => (
          <button key={t} onClick={() => onActions?.()}>
            {t}
          </button>
        ))}
      </div>
    </>
  );
}

function AgentPane({ engine }: { engine: Engine }) {
  const [chats, setChats] = useState<{ title: string; body: string }[]>([
    { title: "New chat", body: "Ask the agent to add a frame, text, or color." },
  ]);
  const [msg, setMsg] = useState("");
  const send = () => {
    const t = msg.trim();
    if (!t) return;
    setChats((c) => [...c, { title: t.slice(0, 28), body: t }]);
    setMsg("");
    if (/frame/i.test(t)) {
      engine.dispatch({ type: "add", kind: "frame", x: 120, y: 80, w: 390, h: 844, extra: { name: "Agent frame" } });
    } else if (/text/i.test(t)) {
      engine.dispatch({
        type: "add",
        kind: "text",
        x: 140,
        y: 120,
        w: 240,
        h: 32,
        extra: { text: t, name: "Agent text" },
      });
    } else if (/rect|box/i.test(t)) {
      engine.dispatch({ type: "add", kind: "rect", x: 160, y: 160, w: 160, h: 80 });
    }
  };
  return (
    <>
      <div className="file-head">
        <button className="share" style={{ marginLeft: 0 }} onClick={() => setChats([{ title: "New chat", body: "" }])}>
          New chat
        </button>
      </div>
      <div className="tree">
        {chats.map((c, i) => (
          <div key={i} className="row">
            <Icon name="agent" size={14} />
            <span className="name">{c.title}</span>
          </div>
        ))}
      </div>
      <div className="search">
        <input
          placeholder="Ask to add a frame, text…"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
      </div>
    </>
  );
}

export function HelpBtn() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="help" title="Help" onClick={() => setOpen((v) => !v)}>
        <Icon name="help" size={14} />
      </button>
      {open && (
        <div className="help-pop" onClick={() => setOpen(false)}>
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <h4>Shortcuts</h4>
            {[
              ["V", "Move"],
              ["F", "Frame"],
              ["R", "Rectangle"],
              ["O", "Ellipse"],
              ["T", "Text"],
              ["⌘Z", "Undo"],
              ["⌘D", "Duplicate"],
              ["⌘G", "Group"],
              ["⌘K", "Actions"],
              ["⇧D", "Dev Mode"],
              ["⌘\\", "Hide UI"],
              ["P", "Pen"],
              ["⇧P", "Pencil"],
              ["⌘⌥K", "Component"],
              ["⌘⌥U", "Union"],
            ].map(([k, l]) => (
              <div key={k} className="proto-row">
                <span>{l}</span>
                <strong>{k}</strong>
              </div>
            ))}
            <button className="export-run" style={{ margin: "8px 12px", width: "calc(100% - 24px)" }} onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
