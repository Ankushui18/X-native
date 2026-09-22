import { useRef, useState } from "react";
import type { Engine, Snapshot, Tool, XNode } from "../engine/types";
import { collectColors, defaultLayout } from "../engine/memory";
import { Icon, TOOL_ICON, kindIcon } from "./icons";
import { Tooltip } from "./Tooltip";
import { plural, toast } from "./toast";
import { useTheme, type ThemePref } from "./theme";
import { ContextMenu, isGroupNode, layerMenu, pageMenu, runMenu } from "./ContextMenu";
import { align } from "./inspector";
import { stepZoom, zoomTo } from "./zoom";

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
      <div className="logo-wrap">
        <button className="logo" title="Main menu" onClick={() => setMenu((v) => !v)}>
          <Icon name="logo" size={20} />
        </button>
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
      </div>
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

/** Locate a node and its parent in the page tree. */
function findNode(
  root: XNode,
  id: string,
  parent: XNode | null = null,
): { node: XNode; parent: XNode | null; id: string } | null {
  if (root.id === id) return { node: root, parent, id };
  for (const c of root.children) {
    const hit = findNode(c, id, root);
    if (hit) return hit;
  }
  return null;
}

function matchesLayer(n: XNode, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return n.name.toLowerCase().includes(needle) || n.children.some((c) => matchesLayer(c, q));
}

/** Where a layer drag would land: above a row, below it, or inside it. */
type DropZone = "before" | "after" | "inside";

interface LayerDrag {
  ids: string[];
  overId: string;
  zone: DropZone;
}

function LayerRow({
  n,
  depth,
  sel,
  engine,
  q,
  siblings,
  drag,
  setDrag,
  onDrop,
}: {
  n: XNode;
  depth: number;
  sel: string[];
  engine: Engine;
  q: string;
  siblings: XNode[];
  drag: LayerDrag | null;
  setDrag: (d: LayerDrag | null) => void;
  onDrop: (d: LayerDrag) => void;
}) {
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const cancelRename = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!matchesLayer(n, q)) return null;
  const container = n.kind === "frame" || n.kind === "group" || n.kind === "component";
  const isOver = drag?.overId === n.id;
  return (
    <>
      <div
        className={`row${sel.includes(n.id) ? " sel" : ""}${n.isComponent || n.kind === "component" || n.kind === "instance" ? " comp" : ""}${n.visible ? "" : " dim"}${n.locked ? " locked" : ""}${
          isOver ? ` drop-${drag!.zone}` : ""
        }${drag?.ids.includes(n.id) ? " dragging" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        draggable={!renaming}
        onDragStart={(e) => {
          // Dragging an unselected row selects it first, so the drag payload
          // always matches what the user sees highlighted.
          const ids = sel.includes(n.id) ? sel : [n.id];
          if (!sel.includes(n.id)) engine.dispatch({ type: "select", ids });
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", n.id);
          setDrag({ ids, overId: n.id, zone: "after" });
        }}
        onDragOver={(e) => {
          if (!drag || drag.ids.includes(n.id)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const r = e.currentTarget.getBoundingClientRect();
          const t = (e.clientY - r.top) / r.height;
          // Containers get a middle band that means "drop inside".
          const zone: DropZone = container
            ? t < 0.28
              ? "before"
              : t > 0.72
                ? "after"
                : "inside"
            : t < 0.5
              ? "before"
              : "after";
          if (drag.overId !== n.id || drag.zone !== zone) setDrag({ ...drag, overId: n.id, zone });
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (drag && !drag.ids.includes(n.id)) onDrop({ ...drag, overId: n.id });
          setDrag(null);
        }}
        onDragEnd={() => setDrag(null)}
        onClick={(e) => {
          // ⌘/Ctrl toggles one row; Shift extends across the visible siblings.
          if (e.metaKey || e.ctrlKey) {
            const ids = sel.includes(n.id) ? sel.filter((i) => i !== n.id) : [...sel, n.id];
            engine.dispatch({ type: "select", ids });
            return;
          }
          if (e.shiftKey && sel.length) {
            const order = siblings.map((c) => c.id);
            const anchor = order.findIndex((id) => sel.includes(id));
            const here = order.indexOf(n.id);
            if (anchor >= 0 && here >= 0) {
              const [a, b] = anchor < here ? [anchor, here] : [here, anchor];
              const range = order.slice(a, b + 1);
              engine.dispatch({ type: "select", ids: Array.from(new Set([...sel, ...range])) });
              return;
            }
          }
          engine.dispatch({ type: "select", ids: [n.id] });
        }}
        onDoubleClick={() => setRenaming(true)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!sel.includes(n.id)) engine.dispatch({ type: "select", ids: [n.id] });
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
              if (!cancelRename.current) {
                engine.dispatch({ type: "patch", id: n.id, patch: { name: e.target.value } });
              }
              cancelRename.current = false;
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelRename.current = true;
                (e.target as HTMLInputElement).blur();
              }
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
        [...n.children].reverse().map((c) => (
          <LayerRow
            key={c.id}
            n={c}
            depth={depth + 1}
            sel={sel}
            engine={engine}
            q={q}
            siblings={[...n.children].reverse()}
            drag={drag}
            setDrag={setDrag}
            onDrop={onDrop}
          />
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
  const [drag, setDrag] = useState<LayerDrag | null>(null);
  const root = snap.pages[snap.page].root;

  /**
   * Translate a drop (target row + zone) into a concrete parent + child index.
   *
   * The panel lists children top-to-bottom in reverse z-order, so "before" in
   * the panel means a *higher* index in `children`.
   */
  const onDrop = (d: LayerDrag) => {
    const target = findNode(root, d.overId);
    if (!target) return;
    if (d.zone === "inside") {
      // Dropping into a container puts the layers on top of its stack.
      engine.dispatch({ type: "reorder", ids: d.ids, parent: target.id, index: target.node.children.length });
      return;
    }
    const parent = target.parent ?? root;
    const at = parent.children.indexOf(target.node);
    if (at < 0) return;
    engine.dispatch({
      type: "reorder",
      ids: d.ids,
      parent: parent.id,
      index: d.zone === "before" ? at + 1 : at,
    });
  };
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
          <div
            className="tree"
            onDragOver={(e) => {
              if (drag) e.preventDefault();
            }}
            onDrop={() => setDrag(null)}
          >
            {[...root.children].reverse().map((n) => (
              <LayerRow
                key={n.id}
                n={n}
                depth={0}
                sel={snap.selection}
                engine={engine}
                q={q}
                siblings={[...root.children].reverse()}
                drag={drag}
                setDrag={setDrag}
                onDrop={onDrop}
              />
            ))}
          </div>
        </>
      )}
      {nav === "assets" && <AssetsPane engine={engine} snap={snap} />}
      {nav === "variables" && <VarsPane engine={engine} snap={snap} />}
      {nav === "tools" && <ToolsPane engine={engine} onActions={onActions} />}
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
      { id: "brush", label: "Brush", shortcut: "B" },
      { id: "eraser", label: "Eraser", shortcut: "" },
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
            <Tooltip
              label={g.tools.find((t) => t.id === current)?.label ?? ""}
              shortcut={g.tools.find((t) => t.id === current)?.shortcut}
            >
            <button
              className="hit"
              aria-label={g.tools.find((t) => t.id === current)?.label}
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
            </Tooltip>
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
  onPresent,
  onClose,
  onHide,
  onMinimize,
}: {
  engine: Engine;
  onPresent?: () => void;
  onClose: () => void;
  onHide: () => void;
  onMinimize?: () => void;
}) {
  const [q, setQ] = useState("");
  const { setPref } = useTheme();
  const items = [
    { label: "Move tool", sc: "V", run: () => engine.dispatch({ type: "setTool", tool: "select" }) },
    { label: "Scale tool", sc: "K", run: () => engine.dispatch({ type: "setTool", tool: "scale" }) },
    { label: "Frame", sc: "F", run: () => engine.dispatch({ type: "setTool", tool: "frame" }) },
    { label: "Section", sc: "⇧S", run: () => engine.dispatch({ type: "setTool", tool: "section" }) },
    { label: "Slice", sc: "S", run: () => engine.dispatch({ type: "setTool", tool: "slice" }) },
    { label: "Rectangle", sc: "R", run: () => engine.dispatch({ type: "setTool", tool: "rect" }) },
    { label: "Polygon", sc: "", run: () => engine.dispatch({ type: "setTool", tool: "poly" }) },
    { label: "Star", sc: "", run: () => engine.dispatch({ type: "setTool", tool: "star" }) },
    { label: "Ellipse", sc: "O", run: () => engine.dispatch({ type: "setTool", tool: "ellipse" }) },
    { label: "Line", sc: "L", run: () => engine.dispatch({ type: "setTool", tool: "line" }) },
    { label: "Arrow", sc: "⇧L", run: () => engine.dispatch({ type: "setTool", tool: "arrow" }) },
    { label: "Pen", sc: "P", run: () => engine.dispatch({ type: "setTool", tool: "pen" }) },
    { label: "Pencil", sc: "⇧P", run: () => engine.dispatch({ type: "setTool", tool: "pencil" }) },
    { label: "Brush", sc: "B", run: () => engine.dispatch({ type: "setTool", tool: "brush" }) },
    { label: "Eraser", sc: "", run: () => engine.dispatch({ type: "setTool", tool: "eraser" }) },
    { label: "Text", sc: "T", run: () => engine.dispatch({ type: "setTool", tool: "text" }) },
    { label: "Comment", sc: "C", run: () => engine.dispatch({ type: "setTool", tool: "comment" }) },
    { label: "Hand", sc: "H", run: () => engine.dispatch({ type: "setTool", tool: "hand" }) },
    { label: "Place image", sc: "⇧I", run: () => engine.dispatch({ type: "setTool", tool: "image" }) },
    { label: "Undo", sc: "⌘Z", run: () => engine.dispatch({ type: "undo" }) },
    { label: "Redo", sc: "⇧⌘Z", run: () => engine.dispatch({ type: "redo" }) },
    { label: "Duplicate", sc: "⌘D", run: () => engine.dispatch({ type: "duplicate" }) },
    { label: "Delete", sc: "⌫", run: () => engine.dispatch({ type: "delete" }) },
    { label: "Rulers", sc: "⇧R", run: () => engine.dispatch({ type: "toggleRulers" }) },
    { label: "Group", sc: "⌘G", run: () => engine.dispatch({ type: "group" }) },
    { label: "Ungroup", sc: "⇧⌘G", run: () => engine.dispatch({ type: "ungroup" }) },
    { label: "Hide UI", sc: "⌘\\", run: onHide },
    { label: "Minimize UI", sc: "⇧⌘\\", run: () => onMinimize?.() },
    { label: "Dev Mode", sc: "⇧D", run: () => engine.dispatch({ type: "setRightTab", tab: "inspect" }) },
    { label: "Prototype", sc: "", run: () => engine.dispatch({ type: "setRightTab", tab: "prototype" }) },
    { label: "Design", sc: "", run: () => engine.dispatch({ type: "setRightTab", tab: "design" }) },
    {
      label: "Present",
      sc: "",
      run: () => {
        if (onPresent) onPresent();
        else engine.dispatch({ type: "presentStart" });
      },
    },
    { label: "Theme: Light", sc: "", run: () => setPref("light") },
    { label: "Theme: Dark", sc: "", run: () => setPref("dark") },
    { label: "Theme: Graphite", sc: "", run: () => setPref("graphite") },
    { label: "Theme: Daylight", sc: "", run: () => setPref("daylight") },
    { label: "Theme: System", sc: "", run: () => setPref("system") },
    { label: "Create component", sc: "⌘⌥K", run: () => engine.dispatch({ type: "makeComponent" }) },
    { label: "Detach instance", sc: "", run: () => engine.dispatch({ type: "detachInstance" }) },
    { label: "Union", sc: "⌥⇧U", run: () => engine.dispatch({ type: "boolean", op: "union" }) },
    { label: "Subtract", sc: "⌥⇧S", run: () => engine.dispatch({ type: "boolean", op: "subtract" }) },
    { label: "Intersect", sc: "⌥⇧I", run: () => engine.dispatch({ type: "boolean", op: "intersect" }) },
    { label: "Exclude", sc: "⌥⇧E", run: () => engine.dispatch({ type: "boolean", op: "exclude" }) },
    { label: "Flatten", sc: "⌘E", run: () => engine.dispatch({ type: "flatten" }) },
    { label: "Outline stroke", sc: "⇧⌘O", run: () => engine.dispatch({ type: "outlineStroke" }) },
    { label: "Wrap in section", sc: "", run: () => engine.dispatch({ type: "wrapSection" }) },
    { label: "Use as mask", sc: "⌘⌥M", run: () => runMenu(engine, "useAsMask") },
    { label: "Bring to front", sc: "⇧⌘]", run: () => engine.dispatch({ type: "arrange", dir: "front" }) },
    { label: "Send to back", sc: "⇧⌘[", run: () => engine.dispatch({ type: "arrange", dir: "back" }) },
    { label: "Add auto layout", sc: "⇧A", run: () => {
      const id = engine.snapshot().selection[0];
      if (id) engine.dispatch({ type: "autoLayout", id, layout: defaultLayout() });
    } },
    { label: "Flip horizontal", sc: "⇧H", run: () => engine.dispatch({ type: "flip", axis: "h" }) },
    { label: "Flip vertical", sc: "⇧V", run: () => engine.dispatch({ type: "flip", axis: "v" }) },
    { label: "Zoom to 100%", sc: "⇧0", run: () => engine.dispatch({ type: "setZoom", zoom: 1 }) },
    { label: "Zoom to fit", sc: "⇧1", run: () => zoomTo(engine, "fit") },
    { label: "Zoom to selection", sc: "⇧2", run: () => zoomTo(engine, "selection") },
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
    // Must exclude Alt, otherwise this swallows ⌥⇧E (boolean Exclude).
    if (e.shiftKey && e.key.toLowerCase() === "e" && !meta && !e.altKey) {
      e.preventDefault();
      const cur = engine.snapshot().rightTab;
      engine.dispatch({ type: "setRightTab", tab: cur === "prototype" ? "design" : "prototype" });
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
    if (e.altKey && !meta && !e.shiftKey) {
      const am: Record<
        string,
        "align-left" | "align-right" | "align-top" | "align-bottom" | "align-hcenter" | "align-vcenter"
      > = {
        a: "align-left",
        d: "align-right",
        w: "align-top",
        s: "align-bottom",
        h: "align-hcenter",
        v: "align-vcenter",
      };
      const mode = am[e.key.toLowerCase()];
      if (mode) {
        e.preventDefault();
        align(engine, engine.snapshot(), mode);
        return;
      }
    }
    // Distribute spacing: ⌃⌥H / ⌃⌥V, as in Figma. The align row's tooltips
    // advertise these, so they must actually be bound.
    // NB: `meta` above is metaKey||ctrlKey, so it is always true when Ctrl is
    // held — test e.ctrlKey directly and exclude Cmd instead.
    if (e.ctrlKey && e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "h" || k === "v") {
        e.preventDefault();
        engine.dispatch({ type: "distribute", axis: k === "h" ? "h" : "v" });
        return;
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
      engine.dispatch({ type: "paste", inPlace: e.shiftKey });
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
    if (!meta && e.shiftKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      engine.dispatch({ type: "toggleRulers" });
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      engine.dispatch({ type: "hideSel" });
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const n = engine.snapshot().selection.length;
      engine.dispatch({ type: "delete" });
      // Deleting a layer that is scrolled out of view gives no visual feedback;
      // confirm it and advertise the undo, as Figma does.
      if (n) toast(`Deleted ${plural(n, "layer")} · ⌘Z to undo`);
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
    if (e.altKey && e.shiftKey && !meta) {
      const op =
        e.key.toLowerCase() === "u"
          ? "union"
          : e.key.toLowerCase() === "s"
            ? "subtract"
            : e.key.toLowerCase() === "i"
              ? "intersect"
              : e.key.toLowerCase() === "e"
                ? "exclude"
                : null;
      if (op) {
        e.preventDefault();
        engine.dispatch({ type: "boolean", op });
        return;
      }
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
    if (meta && !e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      engine.dispatch({ type: "flatten" });
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      engine.dispatch({ type: "outlineStroke" });
      return;
    }
    if ((e.ctrlKey || meta) && e.altKey && e.key.toLowerCase() === "m") {
      e.preventDefault();
      runMenu(engine, "useAsMask");
      return;
    }
    if (!meta && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const id = engine.snapshot().selection[0];
      if (id) engine.dispatch({ type: "autoLayout", id, layout: defaultLayout() });
      return;
    }
    if ((meta && e.key === "0") || (!meta && e.shiftKey && e.code === "Digit0")) {
      e.preventDefault();
      engine.dispatch({ type: "setZoom", zoom: 1 });
      return;
    }
    // Step through the zoom presets so the readout lands on round values
    // (25/50/100/200...) instead of compounding into 94% / 117% / 146%.
    if (meta && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      engine.dispatch({ type: "setZoom", zoom: stepZoom(engine.snapshot().zoom, 1) });
      return;
    }
    if (meta && e.key === "-") {
      e.preventDefault();
      engine.dispatch({ type: "setZoom", zoom: stepZoom(engine.snapshot().zoom, -1) });
      return;
    }
    if (!meta && e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      zoomTo(engine, "fit");
      return;
    }
    if (!meta && e.shiftKey && e.code === "Digit2") {
      e.preventDefault();
      zoomTo(engine, "selection");
      return;
    }
    if (!meta && e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      engine.dispatch({ type: "flip", axis: "h" });
      return;
    }
    if (!meta && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      engine.dispatch({ type: "flip", axis: "v" });
      return;
    }
    if (!meta && e.shiftKey) {
      const shifted: Record<string, Tool> = {
        s: "section",
        p: "pencil",
        l: "arrow",
        i: "image",
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
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (e.key === "ArrowLeft") engine.dispatch({ type: "nudge", dx: -step, dy: 0 });
      if (e.key === "ArrowRight") engine.dispatch({ type: "nudge", dx: step, dy: 0 });
      if (e.key === "ArrowUp") engine.dispatch({ type: "nudge", dx: 0, dy: -step });
      if (e.key === "ArrowDown") engine.dispatch({ type: "nudge", dx: 0, dy: step });
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
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

function ToolsPane({ engine, onActions }: { engine: Engine; onActions?: () => void }) {
  const tools = [
    { label: "Place image", run: () => engine.dispatch({ type: "setTool", tool: "image" }) },
    { label: "Duplicate", run: () => engine.dispatch({ type: "duplicate" }) },
    { label: "Group", run: () => engine.dispatch({ type: "group" }) },
    { label: "Undo", run: () => engine.dispatch({ type: "undo" }) },
    { label: "Redo", run: () => engine.dispatch({ type: "redo" }) },
    { label: "Zoom to 100%", run: () => engine.dispatch({ type: "setZoom", zoom: 1 }) },
    { label: "All actions…", run: () => onActions?.() },
  ];
  return (
    <>
      <p className="muted">Plugins and actions for this file.</p>
      <div className="presets">
        {tools.map((t) => (
          <button key={t.label} onClick={t.run}>
            {t.label}
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
              ["K", "Scale"],
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
              ["B", "Brush"],
              ["⇧E", "Design / Prototype"],
              ["C", "Comment"],
              ["⌘⌥K", "Component"],
              ["⌥⇧U", "Union"],
              ["⌘E", "Flatten"],
              ["⌘⌥M", "Use as mask"],
              ["⇧⌘O", "Outline stroke"],
              ["⌘drag", "Ignore snapping"],
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
