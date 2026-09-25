import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Engine, Snapshot, Tool, XNode, VariableItem } from "../engine/types";
import { collectColors, find } from "../engine/memory";
import { alignKey } from "../engine/layout";
import { addAutoLayout, removeAllAutoLayout, removeAutoLayout, suggestAutoLayout } from "./layoutActions";
import { Icon, TOOL_ICON, caretSize, kindIcon, rowIconSize } from "./icons";
import { Tooltip } from "./Tooltip";
import { plural, toast } from "./toast";
import { selectInverse, selectMatching } from "./selectSame";
import { popoverArmed } from "./popoverGuard";
import {
  DEFAULT_NUDGE,
  getNudgePrefs,
  parseNudge,
  setNudgePrefs,
  subscribeNudge,
} from "./nudgePrefs";
import { finishPenDraft } from "./penDraft";
import { THEME_OPTIONS, useTheme } from "./theme";
import { ContextMenu, isGroupNode, layerMenu, pageMenu, runMenu } from "./ContextMenu";
import { align } from "./inspector";
import { stepZoom, zoomAboutCentre, zoomCenter, zoomTo } from "./zoom";
import { roundToPixel } from "./round";

import { clearDoc } from "../engine/persist";
import { copyText, notePasteModifiers, pasteEventMissing } from "../engine/clipboard";
import { armEyedrop, isNone } from "./color";
import { getEngineInfo } from "../engine/wasmBridge";

export type NavId = "file" | "assets" | "tools" | "variables" | "agent";

export function NavRail({
  engine,
  nav,
  setNav,
  onActions,
  onInspectFig,
  onHome,
}: {
  engine: Engine;
  nav: NavId;
  setNav: (n: NavId) => void;
  onActions: () => void;
  onInspectFig?: () => void;
  /** Return to the dashboard. The document is already autosaved. */
  onHome?: () => void;
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
                setMenu(false);
                onHome?.();
              }}
            >
              <Icon name="navigate-back" size={14} /> Back to files
            </button>
            <button
              onClick={() => {
                engine.dispatch({ type: "select", ids: [] });
                engine.dispatch({ type: "setPage", index: 0 });
                setMenu(false);
              }}
            >
              <Icon name="layers" size={14} /> Collapse to page 1
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
              Inspect File (.fig) <span className="sc">⇧⌘F</span>
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
            {THEME_OPTIONS.map((o) => (
              <button key={o.id} className={pref === o.id ? "on" : ""} onClick={() => setPref(o.id)}>
                {o.label}
                {pref === o.id && <span className="sc">✓</span>}
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
        title="Inspect design file (.fig)"
        onClick={onInspectFig}
      >
        <Icon name="folder" size={16} />
        <span>Inspect</span>
      </button>
      <button
        className="nav"
        title="File history (show every autosaved version)"
        onClick={() => toast("This file autosaves locally · no history to show yet")}
      >
        <Icon name="refresh" size={16} />
        <span>Saved</span>
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
  collapseTick = 0,
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
  /** Bumped by the panel's Collapse button; every row folds on the next value. */
  collapseTick?: number;
}) {
  const [open, setOpen] = useState(true);
  const holds = sel.includes(n.id) || n.children.some(function test(c: XNode): boolean {
    return sel.includes(c.id) || c.children.some(test);
  });
  const isMaskedChild = (() => {
    if (!siblings || !siblings.length) return false;
    const idx = siblings.findIndex((s) => s.id === n.id);
    if (idx <= 0) return false;
    for (let i = 0; i < idx; i++) {
      if (siblings[i].isMask) return true;
    }
    return false;
  })();
  useEffect(() => {
    if (!collapseTick) return;
    // Keeps the selected layer visible when it folds everything, so a row
    // that contains it stays open.
    if (!holds) setOpen(false);
  }, [collapseTick]);
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
            <Icon name={open ? "chevron" : "chevron-right"} size={caretSize()} />
          </button>
        ) : (
          <span style={{ width: 16 }} />
        )}
        {isMaskedChild ? (
          <span
            className="mask-child-badge"
            title="Masked by layer below"
            style={{ fontSize: 11, color: "var(--muted)", marginRight: 2, userSelect: "none" }}
          >
            ↳
          </span>
        ) : null}
        <Icon
          name={
            n.isMask
              ? "mask"
              : n.isComponent || n.kind === "component" || n.kind === "instance"
                ? "component"
                : kindIcon(n.kind, n.imageSrc)
          }
          size={14}
        />
        {/* "After you use this action, any nested auto layout frames that were
            created are indicated with a blue dot in the layers section in the
            left panel." The dot marks any auto layout frame, which is the same
            thing shown and is how a suggested frame is spotted. */}
        {n.layout ? <span className="al-dot" title="Auto layout" /> : null}
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
          title={`${n.visible ? "Hide" : "Show"} layer (⇧⌘H)`}
          onClick={(e) => {
            e.stopPropagation();
            engine.dispatch({ type: "patch", id: n.id, patch: { visible: !n.visible } });
          }}
        >
          <Icon name={n.visible ? "eye" : "eye-off"} size={14} />
        </button>
        <button
          className="mini"
          title={`${n.locked ? "Unlock" : "Lock"} layer (⇧⌘L)`}
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
            collapseTick={collapseTick}
          />
        ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={layerMenu(isGroupNode(n), !!n.layout)}
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
  onHome,
}: {
  engine: Engine;
  snap: Snapshot;
  nav: NavId;
  onMinimize: () => void;
  onActions?: () => void;
  onHome?: () => void;
}) {
  const [q, setQ] = useState("");
  const [pagesOpen, setPagesOpen] = useState(true);
  const [pageMenuAt, setPageMenuAt] = useState<{ x: number; y: number; i: number } | null>(null);
  const [drag, setDrag] = useState<LayerDrag | null>(null);
  // One counter for the whole tree: bumping it tells every row to fold, and the
  // rows answer by themselves so no open-state has to be lifted up here.
  const [collapseTick, setCollapseTick] = useState(0);
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
        {onHome && (
          <Tooltip label="Back to files" placement="bottom">
            <button className="icon-btn back" onClick={onHome} aria-label="Back to files">
              <Icon name="navigate-back" size={14} />
            </button>
          </Tooltip>
        )}
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.06em",
            color: "var(--blue)",
            background: "rgba(99, 102, 241, 0.12)",
            border: "1px solid rgba(99, 102, 241, 0.25)",
            padding: "2px 6px",
            borderRadius: 4,
            marginRight: 6,
            userSelect: "none",
            flexShrink: 0,
          }}
        >
          X-NATIVE
        </span>
        <input
          className="name"
          aria-label="File name"
          value={snap.fileName}
          onChange={(e) => engine.dispatch({ type: "setFileName", name: e.target.value })}
        />
        <button className="icon-btn" title={"Minimize UI (⇧⌘\\)"} onClick={onMinimize}>
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
              <Icon name={pagesOpen ? "chevron" : "chevron-right"} size={caretSize()} />
            </button>
            Pages
            <span className="grow" />
            <button
              className="icon-btn"
              title="Add page (a page is a top-level canvas)"
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
            <Icon name="chevron" size={caretSize()} />
            Layers
            <span className="grow" />
            <button
              className="icon-btn"
              title="Collapse all layers (the selected layer's path stays open)"
              aria-label="Collapse all layers"
              onClick={() => setCollapseTick((v) => v + 1)}
            >
              <Icon name="collapse-layers" size={rowIconSize()} />
            </button>
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
                collapseTick={collapseTick}
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
      { id: "zoom", label: "Zoom", shortcut: "Z" },
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
      <div className="toolset">
      {GROUPS.map((g) => {
        const current = last(g);
        const active = g.tools.some((t) => t.id === snap.tool);
        const multi = g.tools.length > 1;
        const cur = g.tools.find((t) => t.id === current);
        return (
          <div
            key={g.id}
            className={`tool${active ? " active" : ""}${open === g.id ? " open" : ""}${multi ? " split" : ""}`}
            onMouseLeave={() => {
              if (hold.current) window.clearTimeout(hold.current);
              setOpen((o) => (o === g.id ? null : o));
            }}
          >
            <Tooltip label={cur?.label ?? ""} shortcut={cur?.shortcut}>
            <button
              className="hit"
              aria-label={cur?.label}
              aria-haspopup={multi ? "menu" : undefined}
              aria-expanded={multi ? open === g.id : undefined}
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
                  title={`More tools (${g.tools.length})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => (o === g.id ? null : g.id));
                  }}
                >
                  <Icon name="chevron" size={caretSize()} />
                </i>
              )}
            </button>
            </Tooltip>
            {multi && (
              <div className="fly" role="menu">
                {g.tools.map((t) => (
                  <button
                    key={t.id}
                    role="menuitemradio"
                    aria-checked={snap.tool === t.id}
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
                <div className="fly-hint">Hold Space to pan · {g.id === "move" ? "V moves, H hands" : "click a tool to switch"}</div>
              </div>
            )}
          </div>
        );
      })}
      </div>
      <div className="div" />
      <div className="toolset right">
      <div className="tool">
        <Tooltip label="Resources" shortcut="⌘/">
          <button className="hit" aria-label="Resources" onClick={onActions}>
            <Icon name="resources" size={16} />
          </button>
        </Tooltip>
      </div>
      <div className={`tool${snap.rightTab === "inspect" ? " active" : ""}`}>
        <Tooltip label={snap.rightTab === "inspect" ? "Exit Dev Mode" : "Dev Mode"} shortcut="⇧D">
          <button
            className="hit"
            aria-label="Dev Mode"
            aria-pressed={snap.rightTab === "inspect"}
            onClick={() =>
              engine.dispatch({
                type: "setRightTab",
                tab: snap.rightTab === "inspect" ? "design" : "inspect",
              })
            }
          >
            <Icon name="dev" size={16} />
          </button>
        </Tooltip>
      </div>
      <div className="tool">
        <Tooltip label="Actions" shortcut="⌘/">
          <button className="hit" aria-label="Actions" onClick={onActions}>
            <Icon name="search" size={16} />
          </button>
        </Tooltip>
      </div>
      </div>
      {snap.vecEdit && (
        <>
          <div className="div" />
          <div className="tool">
            <button
              className="hit"
              style={{
                background: "var(--accent)",
                color: "#fff",
                padding: "0 10px",
                width: "auto",
                borderRadius: 6,
                fontWeight: 500,
                fontSize: 12,
                gap: 4,
              }}
              onClick={() => engine.dispatch({ type: "setVecEdit", id: null, pointIndex: null })}
              title="Done editing path (Esc or ⌘↵)"
            >
              <Icon name="check" size={14} />
              Done
            </button>
          </div>
        </>
      )}
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
      label: "Inspect file (.fig)",
      sc: "⇧⌘F",
      run: () => onInspectFig?.(),
    },
    { label: "Move tool", sc: "V", run: () => engine.dispatch({ type: "setTool", tool: "select" }) },
    { label: "Zoom tool", sc: "Z", run: () => engine.dispatch({ type: "setTool", tool: "zoom" }) },
    {
      label: "Round to whole pixels",
      sc: "⇧⌘P",
      run: () => roundToPixel(engine),
    },
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
    { label: "Pixel preview: off", sc: "⌃P", run: () => engine.dispatch({ type: "setPixelPreview", preview: "off" }) },
    { label: "Pixel preview: 1×", sc: "", run: () => engine.dispatch({ type: "setPixelPreview", preview: "1x" }) },
    { label: "Pixel preview: 2×", sc: "⌃⌥P", run: () => engine.dispatch({ type: "setPixelPreview", preview: "2x" }) },
    { label: "Layout guides", sc: "⇧G", run: () => engine.dispatch({ type: "toggleLayoutGuides" }) },
    { label: "Property labels", sc: "", run: () => engine.dispatch({ type: "togglePropertyLabels" }) },
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
    { label: "Export assets…", sc: "⇧⌘E", run: () => window.dispatchEvent(new CustomEvent("x-native-export-dialog")) },
    { label: "Dev Mode", sc: "⇧D", run: () => engine.dispatch({ type: "setRightTab", tab: "inspect" }) },
    {
      label: "Annotate selection",
      sc: "⇧T",
      run: () => {
        engine.dispatch({ type: "setRightTab", tab: "inspect" });
        window.dispatchEvent(new CustomEvent("x-native-annotate"));
      },
    },
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
    { label: "Theme: System", sc: "", run: () => setPref("system") },
    {
      label: "Nudge amount…",
      sc: "",
      run: () => window.dispatchEvent(new CustomEvent("x-native-nudge-dialog")),
    },
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
    {
      label: "Copy as code",
      sc: "⌥⇧⌘C",
      run: () => window.dispatchEvent(new CustomEvent("x-native-copy-code", { detail: { format: null } })),
    },
    { label: "Copy as PNG", sc: "", run: () => window.dispatchEvent(new CustomEvent("x-native-copy-png")) },
    { label: "Add auto layout", sc: "⇧A", run: () => addAutoLayout(engine, engine.snapshot()) },
    { label: "Remove auto layout", sc: "⌥⇧A", run: () => removeAutoLayout(engine, engine.snapshot()) },
    // "Select Suggest auto layout from the Actions menu."
    { label: "Suggest auto layout", sc: "⌃⇧A", run: () => suggestAutoLayout(engine, engine.snapshot()) },
    { label: "Remove all auto layout", sc: "", run: () => removeAllAutoLayout(engine, engine.snapshot()) },
    { label: "Flip horizontal", sc: "⇧H", run: () => engine.dispatch({ type: "flip", axis: "h" }) },
    { label: "Flip vertical", sc: "⇧V", run: () => engine.dispatch({ type: "flip", axis: "v" }) },
    { label: "Zoom to 100%", sc: "⇧0", run: () => zoomAboutCentre(engine, 1) },
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
      {items.length === 0 && (
        <div className="actions-empty">
          No command matches “{q.trim()}” — try “component”, “export” or “zoom”.
        </div>
      )}
      {items.map((i, idx) => (
        <button
          key={`${i.label}-${idx}`}
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
    /** Close the topmost modal; returns whether one was open. */
    onEscapeOverlay?: () => boolean;
  },
) {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing =
      t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable ||
      !!t.closest?.("input, textarea, select, [contenteditable='true'], .x-field, .x-popover, .inspector");
    // Escape belongs to the open sheet, even while one of its own fields has
    // focus — so it is resolved before the typing guard below can skip it.
    if (e.key === "Escape" && !engine.snapshot().presentFrame && extra.onEscapeOverlay?.()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (typing) return;
    // The alignment box in the right panel answers to its own keys while it has
    // focus - arrows, W/A/S/D, B and X - so just those stand down. Everything
    // else, tool letters included, still belongs to the app.
    if (!e.metaKey && !e.ctrlKey && alignKey(e.key) && t.closest?.("[data-align-box]")) return;
    if (engine.snapshot().presentFrame && e.key !== "Escape") return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      engine.dispatch({ type: "makeComponent" });
      return;
    }
    if (meta && e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      engine.dispatch({ type: "detachInstance" });
      toast("Instance detached");
      return;
    }
    // Detach Symbol: ⇧⌘Y
    if (meta && e.shiftKey && e.key.toLowerCase() === "y") {
      e.preventDefault();
      engine.dispatch({ type: "detachInstance" });
      toast("Instance detached");
      return;
    }
    // Copy/Paste as ▸ Copy as code chord, so the clipboard path works
    // without hunting through a menu.
    if (meta && e.altKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      // Ask the panel's renderer rather than building a second answer here, so
      // the chord follows the language and units in the Dev Mode menu.
      window.dispatchEvent(new CustomEvent("x-native-copy-code", { detail: { format: null } }));
      return;
    }
    if (meta && e.altKey && !e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      engine.dispatch({ type: "copyProperties" });
      toast("Copied properties");
      return;
    }
    if (meta && e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      engine.dispatch({ type: "pasteProperties" });
      toast("Pasted properties");
      return;
    }
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      extra.onActions();
      return;
    }
    // ⌘/ — the chord the shortcut sheet has always advertised for the Actions
    // menu, and the one the article means by "select Suggest auto layout from
    // the Actions menu". Forward slash is `Slash` on every layout.
    if (meta && !e.shiftKey && !e.altKey && e.code === "Slash") {
      e.preventDefault();
      extra.onActions();
      return;
    }
    // Keyed off `code`, not `key`: holding Shift turns this keyboard's
    // backslash into another character, which silently broke the minimize half
    // of the pair while ⌘\ (unshifted) kept working.
    const backslash = e.code === "Backslash" || e.key === "\\" || e.key === "|";
    const period = !e.shiftKey && (e.code === "Period" || e.key === ".");
    if (meta && e.shiftKey && backslash) {
      e.preventDefault();
      extra.onMinimize();
      return;
    }
    // ⌘\ / ⌘. — toggle clean canvas / interface visibility
    if (meta && (backslash || period)) {
      e.preventDefault();
      extra.onHide();
      return;
    }
    // ⇧T — Annotate: Dev Mode on, note field focused, ready to type.
    if (e.shiftKey && !meta && !e.altKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      if (engine.snapshot().rightTab !== "inspect") {
        engine.dispatch({ type: "setRightTab", tab: "inspect" });
      }
      window.dispatchEvent(new CustomEvent("x-native-annotate"));
      return;
    }
    // ⇧T — Annotate: Dev Mode on, note field focused, ready to type.
    if (e.shiftKey && !meta && !e.altKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      if (engine.snapshot().rightTab !== "inspect") {
        engine.dispatch({ type: "setRightTab", tab: "inspect" });
      }
      window.dispatchEvent(new CustomEvent("x-native-annotate"));
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
    // ⌥1..3 / ⌃1..3 switch navigation panes
    if ((e.altKey || (e.ctrlKey && !meta && !e.shiftKey)) && extra.onNav) {
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
    // Distribute spacing: ⌃⌥H / ⌃⌥V. The align row's tooltips
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
    if (meta && e.key.toLowerCase() === "f") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("x-native-find"));
      return;
    }
    if ((!meta && e.shiftKey && e.key.toLowerCase() === "o") || (meta && e.key.toLowerCase() === "y")) {
      e.preventDefault();
      engine.dispatch({ type: "toggleOutlines" });
      return;
    }
    const isEyedrop =
      (!meta && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i") ||
      (e.ctrlKey && !meta && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c");
    if (isEyedrop) {
      e.preventDefault();
      armEyedrop((c) => {
        const id0 = engine.snapshot().selection[0];
        if (id0) engine.dispatch({ type: "patch", id: id0, patch: { fill: c } });
      });
      return;
    }
    // ⇧X swaps fill and stroke
    if (!meta && !e.altKey && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      engine.dispatch({ type: "swapFillStroke" });
      return;
    }
    // ⇧B toggles stroke / border
    if (!meta && !e.altKey && e.shiftKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      engine.dispatch({ type: "toggleStroke" });
      return;
    }
    if (e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      engine.dispatch({ type: "tidyUp" });
      toast("Tidied up selection");
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
      // The keystroke is handed to the browser on purpose. `preventDefault()`
      // here suppresses the `paste` event, and that event is the only
      // permission-free look at the system clipboard — which is where a copy
      // from the clipboard, from another tab, or from a screenshot is waiting. Canvas
      // owns the event and places what it finds; the in-app clipboard is the
      // fallback when the system one holds nothing this app can read.
      notePasteModifiers(e.shiftKey);
      // Insurance for a browser that does not fire `paste` at all: the copy
      // made inside this document must still paste, as it did before. A real
      // paste event clears the flag within a frame, so this never doubles up.
      const inPlace = e.shiftKey;
      window.setTimeout(() => {
        if (pasteEventMissing()) engine.dispatch({ type: "paste", inPlace });
      }, 250);
      return;
    }
    // Auto layout, exactly as the guide's shortcut table has it: ⇧A adds one
    // with the defaults, ⌥⇧A removes it, ⌃⇧A suggests the values from how the
    // objects are already arranged. This is tested before the ⌘A family below,
    // which owns ⌘⇧A: the chord is ⌃ (Control), and Select inverse in this
    // app has always been ⇧⌘A, so the two do not have to collide.
    if (!e.metaKey && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const snap = engine.snapshot();
      if (!snap.selection.length) return;
      if (e.ctrlKey) suggestAutoLayout(engine, snap);
      else if (e.altKey) removeAutoLayout(engine, snap);
      else addAutoLayout(engine, snap);
      return;
    }
    // Two selection helpers share the ⌘A chord with Select all: with ⌥ it
    // gathers the same object in every other frame, with ⇧ it takes everything
    // at this level that is not already picked.
    if (meta && e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectMatching(engine, engine.snapshot());
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectInverse(engine, engine.snapshot());
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
    // ⌘L adds stack layout, ⌥⌘L removes stack layout
    if (meta && !e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      const snap = engine.snapshot();
      if (!snap.selection.length) return;
      if (e.altKey) removeAutoLayout(engine, snap);
      else addAutoLayout(engine, snap);
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
      // confirm it and advertise the undo.
      if (n) toast(`Deleted ${plural(n, "layer")} · ⌘Z to undo`);
      return;
    }
    if (e.key === "Escape") {
      // A popover that is open owns Escape: its own handler closes it, and the
      // selection behind it must survive the keypress.
      if (popoverArmed()) return;
      // An in-progress pen path owns it next: Escape finishes the shape and
      // leaves it open, instead of deselecting out from under
      // the drawing. The tool stays the pen, so the next path starts at once.
      if (finishPenDraft()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
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
    if ((meta && e.key === "0") || (!meta && e.shiftKey && e.code === "Digit0")) {
      e.preventDefault();
      zoomAboutCentre(engine, 1);
      return;
    }
    // Step through the zoom presets so the readout lands on round values
    // (25/50/100/200...) instead of compounding into 94% / 117% / 146%.
    if (!meta && !e.altKey && e.shiftKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomAboutCentre(engine, stepZoom(engine.snapshot().zoom, 1));
      return;
    }
    if (!meta && !e.altKey && e.shiftKey && (e.key === "-" || e.key === "_")) {
      e.preventDefault();
      zoomAboutCentre(engine, stepZoom(engine.snapshot().zoom, -1));
      return;
    }
    if (meta && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomAboutCentre(engine, stepZoom(engine.snapshot().zoom, 1));
      return;
    }
    if (meta && e.key === "-") {
      e.preventDefault();
      zoomAboutCentre(engine, stepZoom(engine.snapshot().zoom, -1));
      return;
    }
    // ⇧F — "View > Prototype flows": hide the noodles and hotspot
    // handles without leaving Design mode.
    if (!meta && !e.altKey && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      engine.dispatch({ type: "toggleFlows" });
      return;
    }
    // ⇧G — View > Layout guides: every frame's grid at once, so a
    // reviewer can look at spacing without losing the grids themselves.
    if (!meta && !e.altKey && e.shiftKey && e.key.toLowerCase() === "g") {
      e.preventDefault();
      engine.dispatch({ type: "toggleLayoutGuides" });
      return;
    }
    // ⌃P / ⌃⌥P cycle Pixel preview: the canvas as the raster it would
    // export as. (Also offers 2× at ⌃⌥P.)
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key.toLowerCase() === "p" || e.code === "KeyP")) {
      e.preventDefault();
      const cur = engine.snapshot().pixelPreview;
      engine.dispatch({
        type: "setPixelPreview",
        preview: e.altKey ? (cur === "2x" ? "off" : "2x") : cur === "1x" ? "off" : "1x",
      });
      return;
    }
    // ⌘' shows the pixel grid, ⌘⇧' toggles snapping to it — standard pair.
    // Matched on the physical key as well as the character, because with Shift
    // held the quote key *is* a different character: on a US layout ⇧' arrives
    // as `"`, on a German one ⇧2 as `@`, and matching only on those meant the
    // snapping half of the pair did nothing at all.
    if (meta && (e.code === "Quote" || e.key === "'" || e.key === "@")) {
      e.preventDefault();
      const cur = engine.snapshot();
      const page = cur.pages[cur.page];
      engine.dispatch({
        type: "patchPage",
        patch: e.shiftKey ? { pixelSnap: !(page.pixelSnap ?? true) } : { pixelGrid: !page.pixelGrid },
      });
      return;
    }
    // Standard zoom keyboard set: ⇧1/2 stay bound above, so both
    // vocabularies work.
    if (meta && !e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      zoomTo(engine, "fit");
      return;
    }
    if (meta && !e.shiftKey && e.code === "Digit2") {
      e.preventDefault();
      zoomTo(engine, "selection");
      return;
    }
    if (meta && !e.shiftKey && e.code === "Digit3") {
      e.preventDefault();
      zoomCenter(engine);
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
    // ⇧⌘E — bulk-export command (File ▸ Export…).
    if (meta && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("x-native-export-dialog"));
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      roundToPixel(engine);
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
      z: "zoom",
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
    // Preferences > Nudge amount: 1 and 10 out of the box, both
    // settable, ⇧ for the big one. Nudges are exact - they apply the number you
    // asked for whether or not snap-to-pixel-grid is on - because an explicit
    // distance is a request, while a drag is a gesture the grid may round.
    const prefs = getNudgePrefs();
    const step = e.shiftKey ? prefs.big : prefs.small;
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
  const [addingVar, setAddingVar] = useState(false);
  const [varName, setVarName] = useState("token-1");
  const [varType, setVarType] = useState<VariableItem["type"]>("color");
  const [varVal, setVarVal] = useState("#10b981");
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
              onClick={() => setAddingVar((v) => !v)}
            >
              <Icon name={addingVar ? "x-mark" : "plus"} size={14} />
            </button>
          </div>

          {addingVar && (
            <div
              style={{
                margin: "4px 12px 8px",
                padding: 8,
                borderRadius: 6,
                background: "var(--input)",
                display: "grid",
                gap: 6,
                fontSize: 11,
              }}
            >
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  style={{
                    flex: 1,
                    padding: "4px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontSize: 11,
                  }}
                  placeholder="Variable name"
                  value={varName}
                  onChange={(e) => setVarName(e.target.value)}
                />
                <select
                  style={{
                    padding: "4px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontSize: 11,
                  }}
                  value={varType}
                  onChange={(e) => {
                    const t = e.target.value as VariableItem["type"];
                    setVarType(t);
                    if (t === "color") setVarVal("#10b981");
                    else if (t === "number") setVarVal("16");
                    else if (t === "boolean") setVarVal("true");
                    else setVarVal("text");
                  }}
                >
                  <option value="color">Color</option>
                  <option value="number">Number</option>
                  <option value="string">String</option>
                  <option value="boolean">Boolean</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  style={{
                    flex: 1,
                    padding: "4px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontSize: 11,
                  }}
                  placeholder="Value"
                  value={varVal}
                  onChange={(e) => setVarVal(e.target.value)}
                />
                <button
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: 0,
                    background: "var(--blue)",
                    color: "#ffffff",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    if (!varName.trim()) return;
                    const value =
                      varType === "number"
                        ? Number(varVal) || 0
                        : varType === "boolean"
                          ? varVal === "true"
                          : varVal;
                    const collection = col === "All" ? "Brand" : col;
                    engine.dispatch({
                      type: "addVariable",
                      variable: { id: "var_" + Date.now(), name: varName.trim(), type: varType, value, collection },
                    });
                    toast(`Added variable ${varName}`);
                    setAddingVar(false);
                    setVarName("token-" + (vars.length + 1));
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}

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
    { label: "Zoom to 100%", run: () => zoomAboutCentre(engine, 1) },
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
      { id: "select-matching", name: "Select matching layers", keys: ["⌥", "⌘", "A"] },
      { id: "select-inverse", name: "Select inverse", keys: ["⇧", "⌘", "A"] },
      { id: "search", name: "Quick actions / Search", keys: ["⌘", "/"] },
      { id: "hide-ui", name: "Show / hide UI", keys: ["⌘", "\\"] },
      { id: "dev-mode", name: "Dev Mode toggle", keys: ["⇧", "D"] },
      { id: "annotate", name: "Annotate selection", keys: ["⇧", "T"] },
      { id: "measure", name: "Measure distance", keys: ["⌥ (hold)"] },
      { id: "export-all", name: "Export assets", keys: ["⇧", "⌘", "E"] },
      { id: "export-all", name: "Export assets", keys: ["⇧", "⌘", "E"] },
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
      { id: "pixel-grid", name: "Pixel grid", keys: ["⌘", "'"] },
      { id: "pixel-snap", name: "Snap to pixel grid", keys: ["⌘", "⇧", "'"] },
      { id: "pixel-preview", name: "Pixel preview 1×", keys: ["⌃", "P"] },
      { id: "pixel-preview-2", name: "Pixel preview 2×", keys: ["⌃", "⌥", "P"] },
      { id: "zoom-tool", name: "Zoom tool", keys: ["Z"] },
      { id: "zoom-fit", name: "Zoom to fit", keys: ["⇧", "1"] },
      { id: "zoom-sel", name: "Zoom to selection", keys: ["⇧", "2"] },
      { id: "zoom-center", name: "Center selection", keys: ["⌘", "3"] },
      { id: "round-pixel", name: "Round to whole pixels", keys: ["⇧", "", "P"] },
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
      { id: "rot-origin", name: "Change the rotation origin", keys: ["⌥", "R"] },
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
      { id: "suggest-layout", name: "Suggest auto layout (from how the objects sit)", keys: ["⌃", "⇧", "A"] },
      { id: "align-box-keys", name: "Alignment box, once clicked: arrows step, W/A/S/D jump to an edge", keys: ["↑", "↓", "←", "→"] },
      { id: "align-box-baseline", name: "Alignment box: text baseline alignment on and off", keys: ["B"] },
      { id: "align-box-gap", name: "Alignment box: switch the gap between a number and Auto", keys: ["X"] },
      { id: "pad-shorthand", name: "Padding field: ⌘-click, then type CSS shorthand (1,2,3 or 1,2,3,4)", keys: ["⌘", "click"] },
      { id: "mask", name: "Use as mask", keys: ["⌘", "⌥", "M"] },
      { id: "flatten", name: "Flatten selection", keys: ["⌘", "E"] },
      { id: "union", name: "Union selection", keys: ["⌥", "⇧", "U"] },
      { id: "heal", name: "Delete & heal vector point", keys: ["⇧", "⌫"] },
    ],
  },
];

/**
 * Preferences → "Nudge amount…" dialog: two fields, and it applies as
 * you leave them - there is no OK button, and there should not be
 * one here. Typing a decimal point, or clearing the field to retype, must not
 * write a value, so a field only commits when it parses.
 */
export function NudgeDialog({ onClose }: { onClose: () => void }) {
  const prefs = useSyncExternalStore(subscribeNudge, getNudgePrefs, getNudgePrefs);
  const [small, setSmall] = useState(String(prefs.small));
  const [big, setBig] = useState(String(prefs.big));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const commit = (which: "small" | "big", raw: string) => {
    const n = parseNudge(raw);
    if (n == null) {
      // Nothing usable typed: put back what is actually in effect rather than
      // leaving the field showing something the app is not using.
      if (which === "small") setSmall(String(prefs.small));
      else setBig(String(prefs.big));
      return;
    }
    setNudgePrefs({ [which]: n });
    if (which === "small") setSmall(String(n));
    else setBig(String(n));
  };

  return (
    <div className="help-pop" onClick={onClose}>
      <div
        className="help-card nudge-dialog"
        role="dialog"
        aria-label="Nudge amount"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h3>Nudge amount</h3>
          <button className="shortcuts-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="nudge-body">
          <label>
            <span>Small nudge</span>
            <input
              aria-label="Small nudge"
              value={small}
              onChange={(e) => setSmall(e.target.value)}
              onBlur={(e) => commit("small", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit("small", (e.target as HTMLInputElement).value);
              }}
            />
          </label>
          <label>
            <span>Big nudge</span>
            <input
              aria-label="Big nudge"
              value={big}
              onChange={(e) => setBig(e.target.value)}
              onBlur={(e) => commit("big", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit("big", (e.target as HTMLInputElement).value);
              }}
            />
          </label>
          <p className="hint">
            Arrow keys move a layer by the small nudge, ⇧ with the arrow keys by the big one.
            Defaults are {DEFAULT_NUDGE.small} and {DEFAULT_NUDGE.big}.
          </p>
        </div>
      </div>
    </div>
  );
}

export function HelpBtn() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("Essential");
  const [query, setQuery] = useState("");
  const [usedKeys, setUsedKeys] = useState<Set<string>>(() => new Set(["undo", "move"]));

  // The dashboard's header has no editor to hang a sheet on, so it asks for
  // this one through an event instead of duplicating the modal.
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("x-native-shortcuts", on);
    return () => window.removeEventListener("x-native-shortcuts", on);
  }, []);

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
      else if (meta && e.altKey && k === "a") matchedId = "select-matching";
      else if (e.metaKey && e.shiftKey && k === "a") matchedId = "select-inverse";
      else if (meta && k === "a") matchedId = "select-all";
      else if (meta && k === "g") matchedId = e.shiftKey ? "ungroup" : "group";
      else if (meta && k === "b") matchedId = "bold";
      else if (meta && k === "u") matchedId = "underline";
      else if (e.shiftKey && !e.metaKey && k === "a")
        matchedId = e.ctrlKey ? "suggest-layout" : e.altKey ? "remove-layout" : "auto-layout";
      else if (e.shiftKey && k === "d") matchedId = "dev-mode";
      else if (e.shiftKey && k === "t") matchedId = "annotate";
      else if (e.shiftKey && e.metaKey && k === "e") matchedId = "export-all";
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

export function FindReplaceBar({
  engine,
  snap,
  onClose,
}: {
  engine: Engine;
  snap: Snapshot;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [replaceStr, setReplaceStr] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const root = snap.pages[snap.page].root;

  const matches = useMemo(() => {
    if (!q.trim()) return [];
    const term = q.toLowerCase();
    const list: { node: XNode; textMatch: boolean }[] = [];
    const walk = (n: XNode) => {
      const nameMatch = n.name.toLowerCase().includes(term);
      const textMatch = n.kind === "text" && (n.text || "").toLowerCase().includes(term);
      if (nameMatch || textMatch) {
        list.push({ node: n, textMatch });
      }
      for (const ch of n.children) walk(ch);
    };
    walk(root);
    return list;
  }, [root, q]);

  const selectMatch = (idx: number) => {
    if (!matches.length) return;
    const clamped = (idx + matches.length) % matches.length;
    setMatchIdx(clamped);
    const m = matches[clamped];
    engine.dispatch({ type: "select", ids: [m.node.id] });
  };

  const handleNext = () => selectMatch(matchIdx + 1);
  const handlePrev = () => selectMatch(matchIdx - 1);

  const handleReplace = () => {
    if (!matches.length || matchIdx >= matches.length) return;
    const m = matches[matchIdx];
    if (m.node.kind === "text" && m.textMatch) {
      const reg = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const nextText = (m.node.text || "").replace(reg, replaceStr);
      engine.dispatch({ type: "patch", id: m.node.id, patch: { text: nextText } });
    } else {
      const reg = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const nextName = m.node.name.replace(reg, replaceStr);
      engine.dispatch({ type: "patch", id: m.node.id, patch: { name: nextName } });
    }
    toast("Replaced match");
    handleNext();
  };

  const handleReplaceAll = () => {
    if (!matches.length) return;
    let count = 0;
    const reg = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const m of matches) {
      if (m.node.kind === "text" && m.textMatch) {
        const nextText = (m.node.text || "").replace(reg, replaceStr);
        engine.dispatch({ type: "patch", id: m.node.id, patch: { text: nextText } });
        count++;
      } else {
        const nextName = m.node.name.replace(reg, replaceStr);
        engine.dispatch({ type: "patch", id: m.node.id, patch: { name: nextName } });
        count++;
      }
    }
    toast(`Replaced ${count} occurrences`);
  };

  return (
    <div
      className="find-replace-bar"
      style={{
        position: "fixed",
        top: 56,
        left: "50%",
        transform: "translateX(-50%)",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
        borderRadius: 8,
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        zIndex: 1000,
        fontSize: 12,
      }}
    >
      <input
        autoFocus
        placeholder="Find in page…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setMatchIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") {
            if (e.shiftKey) handlePrev();
            else handleNext();
          }
        }}
        style={{
          width: 140,
          padding: "4px 8px",
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--input)",
          color: "var(--text)",
          fontSize: 12,
        }}
      />
      <input
        placeholder="Replace…"
        value={replaceStr}
        onChange={(e) => setReplaceStr(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") handleReplace();
        }}
        style={{
          width: 130,
          padding: "4px 8px",
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--input)",
          color: "var(--text)",
          fontSize: 12,
        }}
      />
      <span style={{ minWidth: 60, color: "var(--dim)", fontSize: 11, textAlign: "center" }}>
        {q ? (matches.length ? `${matchIdx + 1} of ${matches.length}` : "0 matches") : ""}
      </span>
      <button className="icon-btn" title="Previous match (⇧Enter)" onClick={handlePrev} disabled={!matches.length}>
        <Icon name="chevron-up" size={14} />
      </button>
      <button className="icon-btn" title="Next match (Enter)" onClick={handleNext} disabled={!matches.length}>
        <Icon name="chevron" size={14} />
      </button>
      <button
        style={{
          padding: "3px 8px",
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--hover)",
          color: "var(--text)",
          fontSize: 11,
          cursor: "pointer",
        }}
        onClick={handleReplace}
        disabled={!matches.length}
      >
        Replace
      </button>
      <button
        style={{
          padding: "3px 8px",
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--hover)",
          color: "var(--text)",
          fontSize: 11,
          cursor: "pointer",
        }}
        onClick={handleReplaceAll}
        disabled={!matches.length}
      >
        All
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
        <Icon name="x-mark" size={14} />
      </button>
    </div>
  );
}
