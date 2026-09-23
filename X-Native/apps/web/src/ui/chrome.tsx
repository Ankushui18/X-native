import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Engine, Snapshot, Tool, XNode, VariableItem } from "../engine/types";
import { collectColors, defaultLayout, find } from "../engine/memory";
import { Icon, TOOL_ICON, kindIcon } from "./icons";
import { Tooltip } from "./Tooltip";
import { plural, toast } from "./toast";
import { useTheme, type ThemePref } from "./theme";
import { ContextMenu, isGroupNode, layerMenu, pageMenu, runMenu } from "./ContextMenu";
import { align } from "./inspector";
import { stepZoom, zoomTo } from "./zoom";
import { clearDoc } from "../engine/persist";
import { copyText } from "../engine/clipboard";
import { isNone } from "./color";
import { getEngineInfo } from "../engine/wasmBridge";

export type NavId = "file" | "assets" | "tools" | "variables" | "agent";

export function NavRail({
  engine,
  nav,
  setNav,
  onActions,
  onInspectFig,
}: {
  engine: Engine;
  nav: NavId;
  setNav: (n: NavId) => void;
  onActions: () => void;
  onInspectFig?: () => void;
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
            <button
              onClick={() => {
                onInspectFig?.();
                setMenu(false);
              }}
            >
              Inspect Figma (.fig) <span className="sc">⇧⌘F</span>
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
        title="Inspect Figma (.fig) file"
        onClick={onInspectFig}
      >
        <Icon name="figma" size={16} />
        <span>Figma</span>
      </button>
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
  const lastDown = useRef(0);
  // ⌘R renames the selected layer. Rename lives in this row's local state, so
  // the global hotkey reaches it through a targeted event rather than by
  // lifting the state up.
  useEffect(() => {
    const onReq = (e: Event) => {
      if ((e as CustomEvent<string>).detail === n.id) setRenaming(true);
    };
    window.addEventListener("x-rename-layer", onReq);
    return () => window.removeEventListener("x-rename-layer", onReq);
  }, [n.id]);
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
        // A real double-click on a draggable element does not reliably emit
        // dblclick (the drag machinery claims the second press), so rename is
        // triggered from the mousedown pair instead. Verified: before this,
        // double-clicking a layer row never opened the rename field.
        onMouseDown={(e) => {
          if (e.button !== 0 || renaming) return;
          const t = performance.now();
          if (t - lastDown.current < 400) {
            e.preventDefault();
            setRenaming(true);
          }
          lastDown.current = t;
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
            aria-label={open ? `Collapse ${n.name}` : `Expand ${n.name}`}
            aria-expanded={open}
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

function LeftPanelImpl({
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
          aria-label="File name"
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
              aria-label="Find layers"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="section-label">
            <button
              className="twist"
              aria-label={pagesOpen ? "Collapse pages" : "Expand pages"}
              aria-expanded={pagesOpen}
              onClick={() => setPagesOpen((v) => !v)}
            >
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
      { id: "image", label: "Place image/video…", shortcut: "⇧⌘K" },
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


/** The layers tree only depends on the document, the page and the selection.
 *  Without this guard every pan/zoom dispatch re-rendered every layer row,
 *  which dominated frame time on large documents (~47ms/frame at 1400 nodes). */
export const LeftPanel = memo(LeftPanelImpl, (a, b) =>
  a.nav === b.nav &&
  a.engine === b.engine &&
  a.onMinimize === b.onMinimize &&
  a.onActions === b.onActions &&
  a.snap.pages === b.snap.pages &&
  a.snap.page === b.snap.page &&
  a.snap.selection === b.snap.selection &&
  a.snap.fileName === b.snap.fileName,
);

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
              {multi && (
                <i
                  className="caret"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => (o === g.id ? null : g.id));
                  }}
                />
              )}
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
  onInspectFig,
}: {
  engine: Engine;
  onPresent?: () => void;
  onClose: () => void;
  onHide: () => void;
  onMinimize?: () => void;
  onInspectFig?: () => void;
}) {
  const [q, setQ] = useState("");
  const { setPref } = useTheme();
  const items = [
    {
      label: "Inspect Figma (.fig) file",
      sc: "⇧⌘F",
      run: () => onInspectFig?.(),
    },
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
    { label: "Minimap", sc: "⇧M", run: () => engine.dispatch({ type: "toggleMinimap" }) },
    {
      // With autosave the document is now sticky, so there has to be a way back
      // to a blank file. Destructive and unrecoverable, hence the confirm.
      label: "New file…",
      sc: "",
      run: () => {
        if (!window.confirm("Discard the current document and start a new file?")) return;
        clearDoc();
        window.location.reload();
      },
    },
    { label: "Show/hide comments", sc: "⇧C", run: () => engine.dispatch({ type: "toggleComments" }) },
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
    if (e.shiftKey && !meta && !e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      engine.dispatch({ type: "toggleComments" });
      return;
    }
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
    if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
      const id = engine.snapshot().selection[0];
      if (id) {
        e.preventDefault();
        engine.dispatch({ type: "setLeftTab", tab: "layers" });
        window.dispatchEvent(new CustomEvent("x-rename-layer", { detail: id }));
        return;
      }
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
    if (!meta && !e.altKey && e.shiftKey && e.key.toLowerCase() === "m") {
      e.preventDefault();
      engine.dispatch({ type: "toggleMinimap" });
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
    if (meta && !e.shiftKey && e.key.toLowerCase() === "b") {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          engine.dispatch({ type: "patch", id, patch: { fontWeight: n.fontWeight >= 700 ? 400 : 700 } });
        }
      }
      return;
    }
    if (meta && !e.shiftKey && e.key.toLowerCase() === "u") {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          engine.dispatch({
            type: "patch",
            id,
            patch: { textDecoration: n.textDecoration === "underline" ? "none" : "underline" },
          });
        }
      }
      return;
    }
    if (meta && e.shiftKey && (e.key === ">" || e.code === "Period")) {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          engine.dispatch({ type: "patch", id, patch: { fontSize: Math.max(1, (n.fontSize || 14) + 1) } });
        }
      }
      return;
    }
    if (meta && e.shiftKey && (e.key === "<" || e.code === "Comma")) {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          engine.dispatch({ type: "patch", id, patch: { fontSize: Math.max(1, (n.fontSize || 14) - 1) } });
        }
      }
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
    if (meta && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      engine.dispatch({ type: "setTool", tool: "image" });
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
  const [subTab, setSubTab] = useState<"vars" | "styles">("vars");
  const [col, setCol] = useState("All");
  const colors = Array.from(new Set(collectColors(snap.pages[snap.page].root)));
  const sel = snap.selection[0];
  const selNode = sel ? findNode(snap.pages[snap.page].root, sel)?.node : null;

  const vars = snap.variables ?? [];
  const collections = ["All", ...Array.from(new Set(vars.map((v) => v.collection)))];
  const filteredVars = col === "All" ? vars : vars.filter((v) => v.collection === col);

  return (
    <>
      <div className="dir-row" style={{ padding: "8px 12px", gap: 4 }}>
        <button
          className={subTab === "vars" ? "on" : ""}
          style={{
            flex: 1,
            height: 26,
            fontSize: 11,
            borderRadius: 6,
            border: 0,
            background: subTab === "vars" ? "var(--sel)" : "var(--hover)",
            cursor: "pointer",
          }}
          onClick={() => setSubTab("vars")}
        >
          Variables
        </button>
        <button
          className={subTab === "styles" ? "on" : ""}
          style={{
            flex: 1,
            height: 26,
            fontSize: 11,
            borderRadius: 6,
            border: 0,
            background: subTab === "styles" ? "var(--sel)" : "var(--hover)",
            cursor: "pointer",
          }}
          onClick={() => setSubTab("styles")}
        >
          Styles
        </button>
      </div>

      {subTab === "vars" && (
        <>
          <div className="h-row" style={{ padding: "4px 12px" }}>
            <div style={{ display: "flex", gap: 4, overflowX: "auto" }}>
              {collections.map((c) => (
                <button
                  key={c}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 10,
                    border: 0,
                    background: col === c ? "var(--blue)" : "var(--input)",
                    color: col === c ? "var(--on-accent)" : "var(--text)",
                    cursor: "pointer",
                  }}
                  onClick={() => setCol(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <button
              className="plus"
              title="Add Variable"
              onClick={() => {
                const name = window.prompt("Variable name", "token-1");
                if (!name) return;
                const typeStr = window
                  .prompt("Type: color, number, string, or boolean", "color")
                  ?.toLowerCase();
                const type = (
                  ["color", "number", "string", "boolean"].includes(typeStr || "")
                    ? typeStr
                    : "color"
                ) as VariableItem["type"];
                const valStr = window.prompt(
                  `Value for ${type}`,
                  type === "color" ? "#0d99ff" : type === "number" ? "16" : "text",
                );
                if (valStr === null) return;
                const value =
                  type === "number"
                    ? Number(valStr) || 0
                    : type === "boolean"
                      ? valStr === "true"
                      : valStr;
                const collection = col === "All" ? "Brand" : col;
                engine.dispatch({
                  type: "addVariable",
                  variable: { id: "var_" + Date.now(), name, type, value, collection },
                });
                toast(`Added variable ${name}`);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>

          <div
            className="insp-pad"
            style={{
              display: "grid",
              gap: 4,
              padding: "4px 12px",
              maxHeight: "calc(100vh - 280px)",
              overflowY: "auto",
            }}
          >
            {filteredVars.map((v) => (
              <div
                key={v.id}
                className="color-row"
                style={{
                  padding: "4px 6px",
                  borderRadius: 6,
                  background: "var(--hover)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                }}
              >
                {v.type === "color" && (
                  <span
                    className="swatch"
                    style={{
                      background: String(v.value),
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      flexShrink: 0,
                      cursor: "pointer",
                    }}
                    title="Click to apply color to selected layer fill"
                    onClick={() => {
                      if (sel) {
                        engine.dispatch({
                          type: "patch",
                          id: sel,
                          patch: { fill: String(v.value) },
                        });
                        toast(`Applied ${v.name} to fill`);
                      }
                    }}
                  />
                )}
                {v.type === "number" && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "1px 4px",
                      borderRadius: 3,
                      background: "var(--input)",
                    }}
                  >
                    #
                  </span>
                )}
                {v.type === "string" && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "1px 4px",
                      borderRadius: 3,
                      background: "var(--input)",
                    }}
                  >
                    T
                  </span>
                )}
                <span
                  style={{
                    flex: 1,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {v.name}
                </span>
                <span
                  style={{
                    color: "var(--dim)",
                    fontSize: 10,
                    cursor: "pointer",
                    padding: "2px 4px",
                    borderRadius: 4,
                    background: "var(--input)",
                  }}
                  title="Click to edit value"
                  onClick={() => {
                    const next = window.prompt(`Edit value for ${v.name}`, String(v.value));
                    if (next === null) return;
                    const value =
                      v.type === "number"
                        ? Number(next) || 0
                        : v.type === "boolean"
                          ? next === "true"
                          : next;
                    engine.dispatch({ type: "patchVariable", id: v.id, patch: { value } });
                  }}
                >
                  {String(v.value)}
                </span>
                <button
                  className="icon-btn"
                  title={`Delete ${v.name}`}
                  onClick={() => engine.dispatch({ type: "deleteVariable", id: v.id })}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {subTab === "styles" && (
        <>
          <div className="h-row">
            <h3 style={{ margin: 0, fontSize: 11, fontWeight: 500, padding: "8px 4px" }}>Styles</h3>
            <button
              className="plus"
              title="Create style from selection"
              onClick={() => {
                if (!selNode) {
                  toast("Select a layer to create a style from its fill or stroke");
                  return;
                }
                const hasStroke = selNode.strokeWidth > 0 && !isNone(selNode.strokePaint);
                const kind: "fill" | "stroke" =
                  hasStroke && window.confirm("Create from the stroke?\n\nOK = stroke, Cancel = fill")
                    ? "stroke"
                    : "fill";
                const name = window.prompt(`Style name (${kind})`, selNode.name || "Style");
                if (name === null) return;
                engine.dispatch({ type: "createStyle", kind, name });
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          <div className="insp-pad" style={{ display: "grid", gap: 4, padding: "0 12px" }}>
            {snap.styles.length === 0 && (
              <p className="muted">
                No styles yet. Select a layer and press + to save its fill as a reusable style.
              </p>
            )}
            {snap.styles.map((st) => {
              const bound = selNode?.fillStyle === st.id;
              const boundStroke = selNode?.strokeStyle === st.id;
              return (
                <div key={st.id} className="color-row" style={{ width: "100%" }}>
                  <button
                    className="swatch"
                    title={`Apply ${st.name} to the fill — shift-click for the stroke`}
                    aria-label={`Apply style ${st.name}`}
                    style={{
                      background: st.color,
                      border: bound || boundStroke ? "2px solid var(--accent)" : undefined,
                    }}
                    onClick={(e) => {
                      if (!sel) {
                        toast("Select a layer first");
                        return;
                      }
                      const kind = e.shiftKey ? "stroke" : "fill";
                      engine.dispatch({ type: "applyStyle", kind, styleId: st.id });
                      if (kind === "stroke") toast(`Applied ${st.name} to the stroke`);
                    }}
                  />
                  <span className="hex" style={{ flex: 1 }}>
                    {st.name}
                  </span>
                  {(bound || boundStroke) && (
                    <button
                      className="mini"
                      title={`Detach the selection from ${st.name}`}
                      aria-label={`Detach style ${st.name}`}
                      onClick={() => {
                        if (bound) engine.dispatch({ type: "detachStyle", kind: "fill" });
                        if (boundStroke) engine.dispatch({ type: "detachStyle", kind: "stroke" });
                        toast(`Detached from ${st.name}`);
                      }}
                    >
                      <Icon name="unlock" size={14} />
                    </button>
                  )}
                  <button
                    className="mini"
                    title={`Edit ${st.name}`}
                    aria-label={`Edit style ${st.name}`}
                    onClick={() => {
                      const next = window.prompt(`Colour for ${st.name}`, st.color);
                      if (!next) return;
                      const hex = next.trim().startsWith("#") ? next.trim() : `#${next.trim()}`;
                      engine.dispatch({ type: "editStyle", id: st.id, color: hex });
                    }}
                  >
                    <Icon name="eyedropper" size={14} />
                  </button>
                  <button
                    className="mini minus"
                    title={`Delete ${st.name}`}
                    aria-label={`Delete style ${st.name}`}
                    onClick={() => engine.dispatch({ type: "deleteStyle", id: st.id })}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="hr" />
          <div className="h-row">
            <h3 style={{ margin: 0, fontSize: 11, fontWeight: 500, padding: "8px 4px" }}>
              Color Primitive
            </h3>
            <button
              className="plus"
              title="Copy selected layer's colour"
              onClick={() => {
                const id = snap.selection[0];
                const n = id ? findNode(snap.pages[snap.page].root, id)?.node : null;
                if (!n) {
                  toast("Select a layer to copy its colour");
                  return;
                }
                const hex = (n.fill || "").slice(0, 7);
                if (!hex) {
                  toast("That layer has no solid fill");
                  return;
                }
                void copyText(hex);
                toast(`Copied ${hex}`);
              }}
            >
              <Icon name="copy" size={14} />
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
      )}
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

interface ShortcutItem {
  id: string;
  name: string;
  keys: string[];
}

const SHORTCUT_TABS: { tab: string; items: ShortcutItem[] }[] = [
  {
    tab: "Essential",
    items: [
      { id: "undo", name: "Undo", keys: ["⌘", "Z"] },
      { id: "redo", name: "Redo", keys: ["⇧", "⌘", "Z"] },
      { id: "copy", name: "Copy", keys: ["⌘", "C"] },
      { id: "paste", name: "Paste", keys: ["⌘", "V"] },
      { id: "duplicate", name: "Duplicate", keys: ["⌘", "D"] },
      { id: "delete", name: "Delete", keys: ["⌫"] },
      { id: "select-all", name: "Select all", keys: ["⌘", "A"] },
      { id: "search", name: "Quick actions / Search", keys: ["⌘", "/"] },
      { id: "hide-ui", name: "Show / hide UI", keys: ["⌘", "\\"] },
      { id: "dev-mode", name: "Dev Mode toggle", keys: ["⇧", "D"] },
      { id: "measure", name: "Measure distance", keys: ["⌥ (hold)"] },
    ],
  },
  {
    tab: "Tools",
    items: [
      { id: "move", name: "Move tool", keys: ["V"] },
      { id: "scale", name: "Scale tool", keys: ["K"] },
      { id: "frame", name: "Frame tool", keys: ["F"] },
      { id: "section", name: "Section tool", keys: ["⇧", "S"] },
      { id: "slice", name: "Slice tool", keys: ["S"] },
      { id: "rect", name: "Rectangle", keys: ["R"] },
      { id: "line", name: "Line", keys: ["L"] },
      { id: "arrow", name: "Arrow", keys: ["⇧", "L"] },
      { id: "ellipse", name: "Ellipse", keys: ["O"] },
      { id: "place-image", name: "Place image / video", keys: ["⇧", "⌘", "K"] },
      { id: "pen", name: "Pen tool", keys: ["P"] },
      { id: "pencil", name: "Pencil tool", keys: ["⇧", "P"] },
      { id: "brush", name: "Brush tool", keys: ["B"] },
      { id: "text", name: "Text tool", keys: ["T"] },
      { id: "hand", name: "Hand tool", keys: ["H"] },
      { id: "comment", name: "Comment", keys: ["C"] },
    ],
  },
  {
    tab: "View",
    items: [
      { id: "zoom-in", name: "Zoom in", keys: ["⌘", "+"] },
      { id: "zoom-out", name: "Zoom out", keys: ["⌘", "-"] },
      { id: "zoom-100", name: "Zoom to 100%", keys: ["⌘", "0"] },
      { id: "zoom-fit", name: "Zoom to fit", keys: ["⇧", "1"] },
      { id: "zoom-sel", name: "Zoom to selection", keys: ["⇧", "2"] },
      { id: "rulers", name: "Rulers", keys: ["⇧", "R"] },
      { id: "pixel-grid", name: "Pixel grid", keys: ["⇧", "'"] },
      { id: "layout-grids", name: "Layout grids", keys: ["⇧", "G"] },
      { id: "outline", name: "Outline mode", keys: ["⌘", "Y"] },
    ],
  },
  {
    tab: "Text",
    items: [
      { id: "bold", name: "Bold", keys: ["⌘", "B"] },
      { id: "underline", name: "Underline", keys: ["⌘", "U"] },
      { id: "font-inc", name: "Increase font size", keys: ["⌘", "⇧", ">"] },
      { id: "font-dec", name: "Decrease font size", keys: ["⌘", "⇧", "<"] },
      { id: "align-left", name: "Text align left", keys: ["⌥", "⌘", "L"] },
      { id: "align-center", name: "Text align center", keys: ["⌥", "⌘", "T"] },
      { id: "align-right", name: "Text align right", keys: ["⌥", "⌘", "R"] },
    ],
  },
  {
    tab: "Arrange",
    items: [
      { id: "group", name: "Group selection", keys: ["⌘", "G"] },
      { id: "ungroup", name: "Ungroup selection", keys: ["⇧", "⌘", "G"] },
      { id: "frame-sel", name: "Frame selection", keys: ["⌥", "⌘", "G"] },
      { id: "front", name: "Bring to front", keys: ["⌥", "⌘", "]"] },
      { id: "forward", name: "Bring forward", keys: ["⌘", "]"] },
      { id: "back", name: "Send to back", keys: ["⌥", "⌘", "["] },
      { id: "backward", name: "Send backward", keys: ["⌘", "["] },
      { id: "flip-h", name: "Flip horizontal", keys: ["⇧", "H"] },
      { id: "flip-v", name: "Flip vertical", keys: ["⇧", "V"] },
      { id: "align-l", name: "Align left", keys: ["⌥", "A"] },
      { id: "align-r", name: "Align right", keys: ["⌥", "D"] },
      { id: "align-t", name: "Align top", keys: ["⌥", "W"] },
      { id: "align-b", name: "Align bottom", keys: ["⌥", "S"] },
      { id: "align-h", name: "Align horizontal centers", keys: ["⌥", "H"] },
      { id: "align-v", name: "Align vertical centers", keys: ["⌥", "V"] },
    ],
  },
  {
    tab: "Components",
    items: [
      { id: "comp-create", name: "Create component", keys: ["⌥", "⌘", "K"] },
      { id: "comp-detach", name: "Detach instance", keys: ["⌥", "⌘", "B"] },
      { id: "comp-reset", name: "Reset all overrides", keys: ["⌥", "⌘", "/"] },
      { id: "auto-layout", name: "Add auto layout", keys: ["⇧", "A"] },
      { id: "remove-layout", name: "Remove auto layout", keys: ["⌥", "⇧", "A"] },
      { id: "mask", name: "Use as mask", keys: ["⌘", "⌥", "M"] },
      { id: "flatten", name: "Flatten selection", keys: ["⌘", "E"] },
      { id: "union", name: "Union selection", keys: ["⌥", "⇧", "U"] },
      { id: "heal", name: "Delete & heal vector point", keys: ["⇧", "⌫"] },
    ],
  },
];

export function HelpBtn() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("Essential");
  const [query, setQuery] = useState("");
  const [usedKeys, setUsedKeys] = useState<Set<string>>(() => new Set(["undo", "move"]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const isInput =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          (el as HTMLElement).isContentEditable);
      if (!isInput && (e.key === "?" || (e.shiftKey && e.code === "Slash"))) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      let matchedId: string | null = null;
      if (meta && k === "z") matchedId = e.shiftKey ? "redo" : "undo";
      else if (meta && k === "c") matchedId = "copy";
      else if (meta && k === "v") matchedId = "paste";
      else if (meta && k === "d") matchedId = "duplicate";
      else if (meta && k === "a") matchedId = "select-all";
      else if (meta && k === "g") matchedId = e.shiftKey ? "ungroup" : "group";
      else if (meta && k === "b") matchedId = "bold";
      else if (meta && k === "u") matchedId = "underline";
      else if (e.shiftKey && k === "a") matchedId = "auto-layout";
      else if (e.shiftKey && k === "d") matchedId = "dev-mode";
      else if (
        !meta &&
        !e.shiftKey &&
        ["v", "k", "f", "r", "o", "t", "p", "h", "c", "s", "l"].includes(k)
      ) {
        const toolMap: Record<string, string> = {
          v: "move",
          k: "scale",
          f: "frame",
          r: "rect",
          o: "ellipse",
          t: "text",
          p: "pen",
          h: "hand",
          c: "comment",
          s: "slice",
          l: "line",
        };
        matchedId = toolMap[k] ?? null;
      }
      if (matchedId) {
        setUsedKeys((prev) => {
          if (prev.has(matchedId!)) return prev;
          const next = new Set(prev);
          next.add(matchedId!);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const allItems = useMemo(() => SHORTCUT_TABS.flatMap((t) => t.items), []);
  const displayedItems = useMemo(() => {
    if (query.trim()) {
      const q = query.toLowerCase();
      return allItems.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.keys.some((k) => k.toLowerCase().includes(q)),
      );
    }
    return SHORTCUT_TABS.find((t) => t.tab === activeTab)?.items ?? [];
  }, [query, activeTab, allItems]);

  return (
    <>
      <button className="help" title="Keyboard shortcuts (⇧?)" onClick={() => setOpen((v) => !v)}>
        <Icon name="help" size={14} />
      </button>
      {open && (
        <div className="help-pop" onClick={() => setOpen(false)}>
          <div className="help-card shortcuts-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-head">
              <h3>Keyboard Shortcuts</h3>
              <button className="shortcuts-close" onClick={() => setOpen(false)} aria-label="Close">
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="shortcuts-search">
              <input
                placeholder="Search shortcuts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
            {!query.trim() && (
              <div className="shortcuts-tabs">
                {SHORTCUT_TABS.map((t) => (
                  <button
                    key={t.tab}
                    className={activeTab === t.tab ? "active" : ""}
                    onClick={() => setActiveTab(t.tab)}
                  >
                    {t.tab}
                  </button>
                ))}
              </div>
            )}
            <div className="shortcuts-body">
              {displayedItems.map((it) => {
                const used = usedKeys.has(it.id);
                return (
                  <div
                    key={it.id}
                    className={`shortcut-row${used ? " used" : ""}`}
                    title={used ? "You have used this shortcut in this session" : undefined}
                  >
                    <div className="shortcut-name">
                      {used && <span className="used-badge" title="Used" />}
                      <span>{it.name}</span>
                    </div>
                    <div className="shortcut-keys">
                      {it.keys.map((k, idx) => (
                        <kbd key={idx}>{k}</kbd>
                      ))}
                    </div>
                  </div>
                );
              })}
              {!displayedItems.length && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    textAlign: "center",
                    padding: "24px 0",
                    color: "var(--dim)",
                  }}
                >
                  No shortcuts found matching "{query}"
                </div>
              )}
            </div>
            <div className="shortcuts-footer">
              <span>
                {usedKeys.size} of {allItems.length} shortcuts mastered
              </span>
              <span>Engine: {getEngineInfo().name}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
