import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Engine, Snapshot, Tool, XNode, VariableCollection, VariableItem, VariableValue } from "../engine/types";
import { coerceVariableValue, fallbackForType, isAlias, resolveVariable, wouldCycle } from "../engine/variables";
import {
  bindBlockReason,
  collectColors,
  find,
  findParent,
  isInstanceMember,
} from "../engine/memory";
import { shapePoly, shiftPoints } from "../engine/geometry";
import { alignKey } from "../engine/layout";
import { addAutoLayout, removeAllAutoLayout, removeAutoLayout, suggestAutoLayout } from "./layoutActions";
import { Icon, TOOL_ICON, caretSize, kindIcon, rowIconSize, type IconName } from "./icons";
import { Tooltip } from "./Tooltip";
import { plural, toast } from "./toast";
import { askChoice, askConfirm, askPrompt } from "./dialog";
import { rankSearch, loadRecents, saveRecent } from "./search";
import type { RecentEntry, SearchEntry, SearchKind } from "./search";
import { useRestoreFocus } from "./a11y";
import { selectInverse, selectMatching } from "./selectSame";
import { armPopover, popoverArmed } from "./popoverGuard";
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
import { hugSize } from "./textLayout";
import { stepZoom, zoomAboutCentre, zoomCenter, zoomTo, zoomToRect } from "./zoom";
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
  const items: { id: NavId; icon: IconName; label: string; tab?: "layers" | "assets" | "tokens" }[] = [
    { id: "file", icon: "layers", label: "File", tab: "layers" },
    { id: "agent", icon: "agent", label: "Agent" },
    { id: "assets", icon: "component", label: "Assets", tab: "assets" },
    { id: "tools", icon: "tools", label: "Tools" },
    { id: "variables", icon: "vars", label: "Vars", tab: "tokens" },
  ];
  return (
    <nav className="rail" aria-label="Primary">
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
          onClick={() => setNav(it.id)}
        >
          <Icon name={it.icon} size={16} />
          <span>{it.label}</span>
        </button>
      ))}
      <div className="spacer" />
      <div className="div" aria-hidden />
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
        title="Autosaved locally · no history to show yet"
        onClick={() => toast("This file autosaves locally · no history to show yet")}
      >
        <span className="save-dot" aria-hidden />
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

/**
 * Re-fit a text layer's hug axes after a type shortcut changed its metrics.
 * The follow-up patch lands in the engine's burst coalescer with the metric
 * patch, so one keypress stays one undo step.
 */
function rehugText(engine: Engine, id: string, over: Partial<XNode>) {
  const snap = engine.snapshot();
  const n = find(snap.pages[snap.page].root, id);
  if (!n || n.kind !== "text") return;
  if (n.sizingW !== "hug" && n.sizingH !== "hug") return;
  const fit = hugSize({ ...n, ...over } as XNode, n.text);
  if (fit.w !== undefined || fit.h !== undefined) engine.dispatch({ type: "patch", id, patch: fit });
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

/** Display order (top-to-bottom) with the mask flag precomputed: a row is a
 *  masked child when any row above it has isMask. Computed incrementally in one
 *  pass so wide trees don't pay a findIndex scan per row. */
function withMaskedAbove(kids: XNode[]): { n: XNode; maskedAbove: boolean }[] {
  let seenMask = false;
  return [...kids].reverse().map((n) => {
    const maskedAbove = seenMask;
    if (n.isMask) seenMask = true;
    return { n, maskedAbove };
  });
}

interface LayerRowProps {
  /** Last plain-clicked row: the ⇧-range starts here. A shared ref, so rows
   *  never re-render for it (and the memo comparator ignores it). */
  rangeAnchor: { current: string };
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
  /** Precomputed by withMaskedAbove (see above): any row above this one masked. */
  maskedAbove: boolean;
  /** True when an ancestor is locked: the row renders (and behaves) locked. */
  lockedAbove?: boolean;
}

function sameIds(a: XNode[], b: XNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

/** What one row's subtree last rendered, by node id. Nodes (and their children
 *  arrays) mutate in place, so prev-props vs next-props always see the same
 *  already-mutated values — the comparator must diff against this snapshot
 *  of what is actually on screen instead. Entries are only consulted for
 *  mounted rows (memo never gates the initial mount), so a doc switch cannot
 *  inherit a stale skip; capped because unmounted ids linger. */
const rowScreen = new Map<string, string>();

/** Incremental 64-bit (cyrb53-style) hasher, reused across rows so the memo
 *  pass allocates nothing. Single-threaded use only; digest() resets. */
const rowHasher = {
  h1: 0,
  h2: 0,
  reset() {
    this.h1 = 0xdeadbeef;
    this.h2 = 0x41c6ce57;
  },
  mix(n: number) {
    this.h1 = Math.imul(this.h1 ^ n, 2654435761);
    this.h2 = Math.imul(this.h2 ^ n, 1597334677);
  },
  mixStr(s: string) {
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i));
    this.mix(0x1f);
  },
  digest(): string {
    let h1 = Math.imul(this.h1 ^ (this.h1 >>> 16), 2246822507);
    let h2 = Math.imul(this.h2 ^ (this.h2 >>> 16), 2246822507);
    h1 = Math.imul(h1 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h1 >>> 13), 3266489909);
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  },
};

/** Subtree display hash of a row's node: every node field the row render
 *  reads, plus children's order/identity/masks, recursed so a memo skip on
 *  a container never prunes a descendant that must re-render (a parent skip
 *  bails out its whole React subtree). If the row render reads a new field,
 *  it must be added here or the row goes stale. `holds` is only read by the
 *  collapse effect, which always re-renders on its tick. */
function rowHash(n: XNode): string {
  const H = rowHasher;
  H.reset();
  const walk = (m: XNode) => {
    H.mixStr(m.name);
    H.mixStr(m.kind);
    H.mixStr(m.imageSrc ?? "");
    H.mix(m.visible ? 1 : 2);
    H.mix(m.locked ? 1 : 2);
    H.mix(m.isComponent ? 1 : 2);
    H.mix(m.isMask ? 1 : 2);
    H.mix(m.layout ? 1 : 2);
    H.mix(m.children.length);
    for (const c of m.children) {
      H.mixStr(c.id);
      walk(c);
    }
  };
  walk(n);
  return H.digest();
}

/** Row memo comparator. Plain props compare prev-vs-next (all are replaced,
 *  never mutated — except `siblings`, which the parent reallocates, so it
 *  compares by id content); the node diffs against the on-screen snapshot
 *  above. setDrag is a useState setter (stable); onDrop closes over the live
 *  root ref and reads the tree at drop time, so both are safe to ignore.
 *  Search matches recurse into subtree names, so any query disables the
 *  memo. */
function rowPropsEqual(a: Readonly<LayerRowProps>, b: Readonly<LayerRowProps>): boolean {
  if (a.q || b.q) return false;
  if (a.depth !== b.depth) return false;
  if ((a.collapseTick ?? 0) !== (b.collapseTick ?? 0)) return false;
  if (a.maskedAbove !== b.maskedAbove) return false;
  if (!!a.lockedAbove !== !!b.lockedAbove) return false;
  if (a.sel !== b.sel || a.engine !== b.engine || a.drag !== b.drag) return false;
  if (!sameIds(a.siblings, b.siblings)) return false;
  // Read-only: the store is written by the row's commit effect below, so an
  // abandoned render can never mark uncommitted pixels as on screen.
  return rowScreen.get(b.n.id) === rowHash(b.n);
}

const LayerRow = memo(LayerRowImpl, rowPropsEqual);

function LayerRowImpl({
  rangeAnchor,
  n,
  depth,
  sel,
  engine,
  q,
  // `siblings` stays on the props (the memo comparator diffs it) but the
  // ⇧-range reads the DOM order now, so it is not destructured here.
  drag,
  setDrag,
  onDrop,
  collapseTick = 0,
  maskedAbove,
  lockedAbove = false,
}: LayerRowProps) {
  const [open, setOpen] = useState(true);
  const holds = sel.includes(n.id) || n.children.some(function test(c: XNode): boolean {
    return sel.includes(c.id) || c.children.some(test);
  });
  const isMaskedChild = maskedAbove;
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
  const effLocked = !!lockedAbove || n.locked;
  // ⌥-click on a twistie folds/unfolds the whole subtree (Figma): the
  // clicked row broadcasts the descendant ids, each row answers for itself.
  useEffect(() => {
    const onSub = (e: Event) => {
      const d = (e as CustomEvent<{ ids: string[]; open: boolean }>).detail;
      if (d && d.ids.includes(n.id)) setOpen(d.open);
    };
    window.addEventListener("x-expand-subtree", onSub);
    return () => window.removeEventListener("x-expand-subtree", onSub);
  }, [n.id]);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // A canvas selection reveals itself in the panel: ancestors unfold and the
  // row scrolls into view, as in Figma.
  useEffect(() => {
    if (holds && !open) setOpen(true);
    if (sel.includes(n.id)) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  // Commits this row's on-screen signature for the memo comparator above.
  // Runs after every commit (no deps by design); the comparator only reads.
  useEffect(() => {
    rowScreen.set(n.id, rowHash(n));
    if (rowScreen.size > 5000) {
      const oldest = rowScreen.keys().next();
      if (!oldest.done && oldest.value !== n.id) rowScreen.delete(oldest.value);
    }
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!matchesLayer(n, q)) return null;
  const container = n.kind === "frame" || n.kind === "group" || n.kind === "component";
  const isOver = drag?.overId === n.id;
  return (
    <>
      <div
        ref={rowRef}
        data-row-id={n.id}
        tabIndex={renaming ? -1 : 0}
        onKeyDown={(e) => {
          // §26 KB-018: the tree walks with the keyboard — ↑/↓ move the
          // selection across visible rows, →/← fold and unfold. Keystrokes
          // from the rename field bubble through here too; those keep their
          // caret keys. (The global nudge handler yields arrows struck on a
          // row — see bindHotkeys.)
          if ((e.target as HTMLElement).tagName === "INPUT") return;
          const order = (): string[] =>
            Array.from(document.querySelectorAll(".tree [data-row-id]"), (el) =>
              el.getAttribute("data-row-id"),
            ).filter((id): id is string => !!id);
          const focusRow = (id: string) => {
            const el = document.querySelector(`.tree [data-row-id="${CSS.escape(id)}"]`) as HTMLElement | null;
            el?.focus();
          };
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            const ids = order();
            const to = e.key === "ArrowDown" ? ids[ids.indexOf(n.id) + 1] : ids[ids.indexOf(n.id) - 1];
            if (to) {
              engine.dispatch({ type: "select", ids: [to] });
              rangeAnchor.current = to;
              focusRow(to);
            }
          } else if (e.key === "ArrowRight") {
            if (n.children.length && !open) setOpen(true);
            else if (open && n.children.length) {
              const first = n.children.find((c) => matchesLayer(c, q)) ?? n.children[0];
              engine.dispatch({ type: "select", ids: [first.id] });
              rangeAnchor.current = first.id;
              focusRow(first.id);
            }
          } else {
            if (n.children.length && open) setOpen(false);
            else {
              const rt = engine.snapshot().pages[engine.snapshot().page].root;
              const par = findParent(rt, n.id);
              if (par && par !== rt) {
                engine.dispatch({ type: "select", ids: [par.id] });
                rangeAnchor.current = par.id;
                focusRow(par.id);
              }
            }
          }
        }}
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
          // ⌘/Ctrl toggles one row; Shift extends from the last clicked row
          // across every visible row between, as Figma does. The DOM is the
          // visible order, so expansion and search filtering are honored
          // without lifting any row state.
          if (e.metaKey || e.ctrlKey) {
            const ids = sel.includes(n.id) ? sel.filter((i) => i !== n.id) : [...sel, n.id];
            engine.dispatch({ type: "select", ids });
            rangeAnchor.current = n.id;
            return;
          }
          if (e.shiftKey && rangeAnchor.current) {
            const order = Array.from(
              document.querySelectorAll('.tree [data-row-id]'),
              (el) => el.getAttribute("data-row-id") as string,
            ).filter(Boolean);
            const anchor = order.indexOf(rangeAnchor.current);
            const here = order.indexOf(n.id);
            if (anchor >= 0 && here >= 0) {
              const [a, b] = anchor < here ? [anchor, here] : [here, anchor];
              const range = order.slice(a, b + 1);
              engine.dispatch({ type: "select", ids: Array.from(new Set([...sel, ...range])) });
              return;
            }
          }
          engine.dispatch({ type: "select", ids: [n.id] });
          rangeAnchor.current = n.id;
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
        // Hovering a layer row outlines it on the canvas, as Figma does; the
        // canvas listens for this event and paints the outline itself.
        onMouseEnter={() => window.dispatchEvent(new CustomEvent("x-panel-hover", { detail: n.id }))}
        onMouseLeave={() => window.dispatchEvent(new CustomEvent("x-panel-hover", { detail: null }))}
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
              const next = !open;
              if (e.altKey) {
                const ids: string[] = [];
                const walkT = (m: XNode) => {
                  ids.push(m.id);
                  for (const c of m.children) walkT(c);
                };
                walkT(n);
                window.dispatchEvent(new CustomEvent("x-expand-subtree", { detail: { ids, open: next } }));
              }
              setOpen(next);
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
              const v = e.target.value.trim();
              if (!cancelRename.current && v) {
                engine.dispatch({ type: "patch", id: n.id, patch: { name: v } });
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
          title={
            lockedAbove && !n.locked
              ? "Locked by parent frame — unlock the parent first"
              : `${effLocked ? "Unlock" : "Lock"} layer (⇧⌘L)`
          }
          onClick={(e) => {
            e.stopPropagation();
            // A child cannot be unlocked while its parent stays locked
            // (Figma): say so instead of flipping a flag with no effect.
            if (lockedAbove && !n.locked) {
              toast("Unlock the parent frame to unlock this layer");
              return;
            }
            engine.dispatch({ type: "patch", id: n.id, patch: { locked: !n.locked } });
          }}
        >
          <Icon name={effLocked ? "lock" : "unlock"} size={14} />
        </button>
      </div>
      {open &&
        withMaskedAbove(n.children).map(({ n: c, maskedAbove }) => (
          <LayerRow
            key={c.id}
            rangeAnchor={rangeAnchor}
            n={c}
            maskedAbove={maskedAbove}
            lockedAbove={effLocked}
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
          items={layerMenu(isGroupNode(n), !!n.layout, {
            // §22 MN-004: same grey-out rules as the canvas menu, for the
            // single row-node instead of the multi-selection.
            detach: !!n.componentId && !n.isComponent,
            reset: !!n.overrides && Object.keys(n.overrides).length > 0,
          })}
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
  const [pageRename, setPageRename] = useState<number | null>(null);
  const pageCancelRename = useRef(false);
  const [pageDrag, setPageDrag] = useState<number | null>(null);
  const [drag, setDrag] = useState<LayerDrag | null>(null);
  // One counter for the whole tree: bumping it tells every row to fold, and the
  // rows answer by themselves so no open-state has to be lifted up here.
  const [collapseTick, setCollapseTick] = useState(0);
  // §26 KB-011: the ⌥L chord reaches the button's counter through an event,
  // the same shape as the ⌘R rename request below.
  useEffect(() => {
    const on = () => setCollapseTick((v) => v + 1);
    window.addEventListener("x-collapse-all", on);
    return () => window.removeEventListener("x-collapse-all", on);
  }, []);
  const rangeAnchor = useRef("");
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
    <aside className="panel left" aria-label="Layers and pages">
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
            color: "var(--accent-ink)",
            background: "var(--sel)",
            border: "1px solid var(--accent-ring)",
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
                className={`row${i === snap.page ? " sel" : ""}${pageDrag === i ? " dragging" : ""}`}
                onClick={() => engine.dispatch({ type: "setPage", index: i })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  engine.dispatch({ type: "setPage", index: i });
                  setPageMenuAt({ x: e.clientX, y: e.clientY, i });
                }}
                onDoubleClick={() => setPageRename(i)}
                draggable={pageRename !== i}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", `page:${i}`);
                  setPageDrag(i);
                }}
                onDragOver={(e) => {
                  if (pageDrag !== null && pageDrag !== i) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (pageDrag !== null && pageDrag !== i) {
                    engine.dispatch({ type: "movePage", from: pageDrag, to: i });
                  }
                  setPageDrag(null);
                }}
                onDragEnd={() => setPageDrag(null)}
              >
                <Icon name="page" size={14} />
                {pageRename === i ? (
                  <input
                    className="name"
                    autoFocus
                    defaultValue={p.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (!pageCancelRename.current && v) {
                        engine.dispatch({ type: "setPage", index: i });
                        engine.dispatch({ type: "renamePage", name: v });
                      }
                      pageCancelRename.current = false;
                      setPageRename(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        pageCancelRename.current = true;
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                ) : (
                  <span className="name">{p.name}</span>
                )}
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
            {withMaskedAbove(root.children).map(({ n, maskedAbove }) => (
              <LayerRow
                key={n.id}
                rangeAnchor={rangeAnchor}
                n={n}
                maskedAbove={maskedAbove}
                lockedAbove={false}
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
                engine.dispatch({ type: "setPage", index: pageMenuAt.i });
                setPageRename(pageMenuAt.i);
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
      { id: "image", label: "Place image…", shortcut: "⇧⌘K" },
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


/** The layers tree only depends on the document, the page and the selection:
 *  pan/zoom snapshots skip it entirely, which dominated frame time on large
 *  documents (~1s/frame at 10k nodes before this guard engaged). Edits mutate
 *  nodes in place, so pages-identity cannot detect them — treeRev is the edit
 *  signal instead (bumped on every dispatch except pan/setPan/setZoom). The
 *  callbacks must be referentially stable or this memo never hits. */
export const LeftPanel = memo(LeftPanelImpl, (a, b) =>
  a.nav === b.nav &&
  a.engine === b.engine &&
  a.onMinimize === b.onMinimize &&
  a.onActions === b.onActions &&
  a.snap.pages === b.snap.pages &&
  a.snap.page === b.snap.page &&
  a.snap.selection === b.snap.selection &&
  a.snap.fileName === b.snap.fileName &&
  a.snap.treeRev === b.snap.treeRev,
);

export function Toolbar({
  engine,
  snap,
  onActions,
  onNav,
}: {
  engine: Engine;
  snap: Snapshot;
  onActions: () => void;
  /** App-owned nav switch. When present the Resources key opens the Assets
   *  pane (its label's promise); without it the key falls back to the
   *  palette, which is also reachable from the dedicated Actions key. */
  onNav?: (n: NavId) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [boolOpen, setBoolOpen] = useState(false);
  const hold = useRef<number | null>(null);
  // Keyboard menu support for the tool + boolean flyouts: arrows open and
  // move, Esc closes, focus returns to the trigger. An open flyout arms
  // the shared popover guard so the capture-phase global Esc yields to it
  // instead of clearing the selection behind it.
  const kbEdge = useRef<"first" | "last" | null>(null);
  useEffect(() => {
    if (open == null && !boolOpen) return;
    return armPopover();
  }, [open, boolOpen]);
  const openId = open ?? (boolOpen ? "bool" : null);
  useEffect(() => {
    if (openId == null || kbEdge.current == null) return;
    const edge = kbEdge.current;
    kbEdge.current = null;
    const menu = document.querySelector(`.dock .tool[data-group="${openId}"] .fly`);
    const items = menu
      ? (Array.from(menu.querySelectorAll('button[role^="menuitem"]')) as HTMLElement[])
      : [];
    const current = menu?.querySelector('button[role^="menuitem"].on') as HTMLElement | null;
    (edge === "last" ? items[items.length - 1] : (current ?? items[0]))?.focus();
  }, [openId]);
  const refocusTrigger = (id: string) => {
    (document.querySelector(`.dock .tool[data-group="${id}"] .hit`) as HTMLElement | null)?.focus();
  };
  const closeFly = (id: string, refocus: boolean) => {
    if (id === "bool") setBoolOpen(false);
    else setOpen(null);
    if (refocus) refocusTrigger(id);
  };
  const menuKeys = (e: ReactKeyboardEvent, id: string) => {
    if (e.key === "Tab") {
      closeFly(id, false);
      return;
    }
    if (e.key !== "Escape" && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (e.key === "Escape") {
      closeFly(id, true);
      return;
    }
    const items = Array.from(e.currentTarget.querySelectorAll('button[role^="menuitem"]')) as HTMLElement[];
    if (!items.length) return;
    const ix = items.indexOf(e.target as HTMLElement);
    if (e.key === "ArrowDown") (items[ix + 1] ?? items[0])?.focus();
    else if (e.key === "ArrowUp") (items[ix - 1] ?? items[items.length - 1])?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items[items.length - 1]?.focus();
  };
  const triggerKeys = (e: ReactKeyboardEvent, id: string, isOpen: boolean) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      kbEdge.current = e.key === "ArrowUp" ? "last" : "first";
      if (id === "bool") setBoolOpen(true);
      else setOpen(id);
    } else if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      closeFly(id, false); // focus is already on the trigger
    }
  };
  // Each group remembers its last-used tool across switches: pick the ellipse,
  // draw (which drops back to Move), and the shape group still offers the
  // ellipse — not the rectangle it defaults to. The live tool always wins
  // while it sits in the group, so there is no one-frame lag after a switch.
  const lastUsed = useRef<Record<string, Tool>>({});
  useEffect(() => {
    const g = GROUPS.find((gg) => gg.tools.some((t) => t.id === snap.tool));
    if (g) lastUsed.current[g.id] = snap.tool;
  }, [snap.tool]);
  const last = (g: Group) =>
    g.tools.some((t) => t.id === snap.tool) ? snap.tool : (lastUsed.current[g.id] ?? g.tools[0].id);

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
            data-group={g.id}
            className={`tool${active ? " active" : ""}${open === g.id ? " open" : ""}${multi ? " split" : ""}`}
            onMouseLeave={() => {
              if (hold.current) window.clearTimeout(hold.current);
              setOpen((o) => (o === g.id ? null : o));
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
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
              onKeyDown={multi ? (e) => triggerKeys(e, g.id, open === g.id) : undefined}
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
              <div className="fly" role="menu" aria-label="More tools" onKeyDown={(e) => menuKeys(e, g.id)}>
                {g.tools.map((t) => (
                  <button
                    key={t.id}
                    role="menuitemradio"
                    aria-checked={snap.tool === t.id}
                    className={snap.tool === t.id ? "on" : ""}
                    onClick={() => {
                      engine.dispatch({ type: "setTool", tool: t.id });
                      setOpen(null);
                      refocusTrigger(g.id);
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
      {snap.selection.length >= 2 && (
        <>
          <div className="div" />
          <div className="toolset" style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--dim)", padding: "0 6px" }}>
              {snap.selection.length} selected
            </span>
            <div className="tool">
              <Tooltip label="Create component" shortcut="⌥⌘K">
                <button
                  className="hit"
                  aria-label="Create component"
                  onClick={() => engine.dispatch({ type: "makeComponent" })}
                >
                  <Icon name="component" size={16} />
                </button>
              </Tooltip>
            </div>
            <div
              data-group="bool"
              className={`tool${boolOpen ? " open" : ""}`}
              onMouseLeave={() => setBoolOpen(false)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setBoolOpen(false);
              }}
            >
              <Tooltip label="Boolean groups">
                <button
                  className="hit"
                  style={{ width: "auto", padding: "0 6px", gap: 3 }}
                  aria-haspopup="menu"
                  aria-expanded={boolOpen}
                  onKeyDown={(e) => triggerKeys(e, "bool", boolOpen)}
                  aria-label="Boolean groups"
                  onClick={() => setBoolOpen((v) => !v)}
                >
                  <Icon name="boolean-union" size={16} />
                  <Icon name="chevron" size={caretSize()} />
                </button>
              </Tooltip>
              {boolOpen && (
                <div className="fly" role="menu" aria-label="Boolean operations" style={{ width: 180, left: 0 }} onKeyDown={(e) => menuKeys(e, "bool")}>
                  <button
                    role="menuitem"
                    onClick={() => {
                      engine.dispatch({ type: "boolean", op: "union" });
                      setBoolOpen(false);
                      refocusTrigger("bool");
                    }}
                  >
                    <Icon name="boolean-union" size={14} />
                    Union selection
                    <span className="sc">⌥⇧U</span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      engine.dispatch({ type: "boolean", op: "subtract" });
                      setBoolOpen(false);
                      refocusTrigger("bool");
                    }}
                  >
                    <Icon name="boolean-subtract" size={14} />
                    Subtract selection
                    <span className="sc">⌥⇧S</span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      engine.dispatch({ type: "boolean", op: "intersect" });
                      setBoolOpen(false);
                      refocusTrigger("bool");
                    }}
                  >
                    <Icon name="boolean-intersect" size={14} />
                    Intersect selection
                    <span className="sc">⌥⇧I</span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      engine.dispatch({ type: "boolean", op: "exclude" });
                      setBoolOpen(false);
                      refocusTrigger("bool");
                    }}
                  >
                    <Icon name="boolean-exclude" size={14} />
                    Exclude selection
                    <span className="sc">⌥⇧E</span>
                  </button>
                  <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
                  <button
                    role="menuitem"
                    onClick={() => {
                      engine.dispatch({ type: "flatten" });
                      setBoolOpen(false);
                      refocusTrigger("bool");
                    }}
                  >
                    <Icon name="vector" size={14} />
                    Flatten selection
                    <span className="sc">⌘E</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      <div className="div" />
      <div className="toolset right">
      <div className="tool">
        <Tooltip label="Assets" shortcut="⌥2">
          <button
            className="hit"
            aria-label="Assets"
            onClick={() => (onNav ? onNav("assets") : onActions())}
          >
            <Icon name="resources" size={16} />
          </button>
        </Tooltip>
      </div>
      <div className={`tool${snap.rightTab === "prototype" ? " active" : ""}`}>
        <Tooltip label={snap.rightTab === "prototype" ? "Back to Design" : "Prototype"} shortcut="⇧E">
          <button
            className="hit"
            aria-label="Prototype"
            aria-pressed={snap.rightTab === "prototype"}
            onClick={() =>
              engine.dispatch({
                type: "setRightTab",
                tab: snap.rightTab === "prototype" ? "design" : "prototype",
              })
            }
          >
            <Icon name="flow" size={16} />
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
  onNewFile,
  onNav,
}: {
  engine: Engine;
  onPresent?: () => void;
  onClose: () => void;
  onHide: () => void;
  onMinimize?: () => void;
  onInspectFig?: () => void;
  /** Handed to the "New file…" command once it is confirmed. The editor owns
   *  the file's stored copy, so replacing it belongs there, not in the panel. */
  onNewFile?: () => void;
  /** Switch the left pane. The panel reads App-owned nav, so this is the only
   *  way a command inside the palette can actually open a pane. */
  onNav?: (n: NavId) => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | SearchKind>("all");
  const [active, setActive] = useState(0);
  const { setPref } = useTheme();
  const snap = engine.snapshot();
  const [recents, setRecents] = useState<RecentEntry[]>(() => loadRecents());
  useRestoreFocus();
  const commands = [
    {
      // §22 MN-008: palette-only — ⇧⌘F is Find (the ⌘F branch takes all
      // shifts), so advertising it here lied. Launched from here or the button.
      label: "Inspect file (.fig)",
      sc: "",
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
      run: async () => {
        const ok = await askConfirm({
          title: "New file",
          body: "The file stored in this browser is deleted and a blank one opens. This cannot be undone.",
          confirmLabel: "Delete and start new",
          danger: true,
        });
        if (!ok) return;
        if (onNewFile) {
          onNewFile();
          return;
        }
        clearDoc();
        window.location.reload();
      },
    },
    { label: "Show/hide comments", sc: "⇧C", run: () => engine.dispatch({ type: "toggleComments" }) },
    { label: "Group", sc: "⌘G", run: () => engine.dispatch({ type: "group" }) },
    { label: "Ungroup", sc: "⇧⌘G", run: () => engine.dispatch({ type: "ungroup" }) },
    { label: "Frame selection", sc: "⌥⌘G", run: () => engine.dispatch({ type: "frameSelection" }) },
    { label: "Resize to fit", sc: "⌥⇧⌘R", run: () => engine.dispatch({ type: "resizeToFit" }) },
    { label: "Hide UI", sc: "⌘\\", run: onHide },
    // §22 MN-006/007: both palette-only — Z arms the zoom tool and Q is
    // unbound, so the old sc labels pointed at chords that do other things.
    { label: "Zen Mode (full canvas HUD)", sc: "", run: () => window.dispatchEvent(new CustomEvent("x-native-zen-mode")) },
    { label: "Marking / Radial menu", sc: "", run: () => window.dispatchEvent(new CustomEvent("x-native-radial-menu")) },
    { label: "Clean up vector (sketch to Bézier)", sc: "", run: () => engine.dispatch({ type: "vectorCleanup" }) },
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
    { label: "Prototype", sc: "⇧E", run: () => engine.dispatch({ type: "setRightTab", tab: "prototype" }) },
    { label: "Design", sc: "⇧E", run: () => engine.dispatch({ type: "setRightTab", tab: "design" }) },
    {
      label: "Present",
      sc: "⌘⌥↩",
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
    { label: "Use as mask", sc: "⌃⌘M", run: () => runMenu(engine, "useAsMask") },
    { label: "Bring to front", sc: "⇧⌘]", run: () => engine.dispatch({ type: "arrange", dir: "front" }) },
    { label: "Send to back", sc: "⇧⌘[", run: () => engine.dispatch({ type: "arrange", dir: "back" }) },
    {
      label: "Copy as code",
      sc: "⌥⇧⌘C",
      run: () => window.dispatchEvent(new CustomEvent("x-native-copy-code", { detail: { format: null } })),
    },
    { label: "Copy as PNG", sc: "⇧⌘C", run: () => window.dispatchEvent(new CustomEvent("x-native-copy-png")) },
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
  ];

  // -- unified Quick Open index -------------------------------------------
  type QuickEntry = SearchEntry & { icon?: string; pageIndex?: number; sc?: string };
  const vars = snap.variables ?? [];
  const varCollections = snap.variableCollections ?? [];
  const activeModes = snap.activeModes ?? {};
  const index: QuickEntry[] = [];
  for (const c of commands) index.push({ kind: "command", id: `cmd:${c.label}`, label: c.label, sc: c.sc || undefined });
  snap.pages.forEach((pg, pi) => {
    index.push({ kind: "page", id: pg.id, label: pg.name || `Page ${pi + 1}`, icon: "page" });
    const walkQ = (n: XNode, trail: string[]) => {
      if (n !== pg.root) {
        index.push({
          kind: "layer",
          id: n.id,
          label: n.name || n.kind,
          detail: [...trail, pg.name].filter(Boolean).slice(-3).join(" / "),
          icon: n.kind,
          pageIndex: pi,
        });
      }
      for (const ch of n.children) walkQ(ch, [...trail, n.name]);
    };
    walkQ(pg.root, []);
    const walkF = (n: XNode) => {
      if (n.kind === "frame" || n.kind === "component") {
        let count = 0;
        const inner = (m: XNode) => {
          count += (m.interactions ?? []).length;
          for (const ch of m.children) inner(ch);
        };
        inner(n);
        if (count > 0) {
          index.push({
            kind: "flow",
            id: n.id,
            label: n.name || "Frame",
            detail: `${pg.name} · ${count} interaction${count === 1 ? "" : "s"}`,
            icon: "proto",
            pageIndex: pi,
          });
        }
      }
      for (const ch of n.children) walkF(ch);
    };
    walkF(pg.root);
  });
  for (const c of snap.components) {
    index.push({
      kind: "component",
      id: c.id,
      label: c.name,
      detail: `${c.variants?.length ?? 1} variant${(c.variants?.length ?? 1) === 1 ? "" : "s"}`,
      icon: "component",
    });
  }
  for (const v of vars) {
    const r = resolveVariable(vars, varCollections, activeModes, v.id);
    index.push({
      kind: "variable",
      id: v.id,
      label: v.name,
      detail: `${v.collection} · ${v.type}${r && !r.broken ? ` · ${String(r.value)}` : ""}`,
      icon: "variable",
    });
  }

  const trimmed = q.trim();
  const pool = filter === "all" ? index : index.filter((e) => e.kind === filter);
  const ranked = rankSearch(pool, trimmed);
  const CAPS: Record<SearchKind, number> = { command: 20, layer: 15, page: 8, component: 8, variable: 8, flow: 8 };
  const seen = new Map<string, number>();
  const results = ranked.filter((e) => {
    const n = (seen.get(e.kind) ?? 0) + 1;
    seen.set(e.kind, n);
    return n <= CAPS[e.kind];
  });
  const recentEntries =
    !trimmed && filter === "all"
      ? recents
          .map((r) => index.find((e) => e.kind === r.kind && (e.id === r.id || (r.kind === "command" && e.id === `cmd:${r.id}`))))
          .filter((e): e is QuickEntry => !!e)
      : [];
  const rows = [...recentEntries, ...results];
  const clamped = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  const runEntry = (e: QuickEntry) => {
    if (e.kind === "command") {
      commands.find((c) => `cmd:${c.label}` === e.id)?.run();
    } else if (e.kind === "layer" && e.pageIndex !== undefined) {
      engine.dispatch({ type: "setPage", index: e.pageIndex });
      engine.dispatch({ type: "select", ids: [e.id] });
      zoomTo(engine, "selection");
    } else if (e.kind === "page") {
      const pi = snap.pages.findIndex((pg) => pg.id === e.id);
      if (pi >= 0) engine.dispatch({ type: "setPage", index: pi });
    } else if (e.kind === "component") {
      const z = snap.zoom || 1;
      engine.dispatch({
        type: "placeComponent",
        id: e.id,
        x: Math.round((window.innerWidth / 2 - snap.panX) / z),
        y: Math.round((window.innerHeight / 2 - snap.panY) / z),
      });
      toast(`Placed ${e.label}`);
    } else if (e.kind === "variable") {
      // The left panel follows App-owned nav; the engine's old leftTab state was
      // write-only, so this row opened nothing (LP-U2).
      onNav?.("variables");
      toast(`“${e.label}” lives in the Variables tab`);
    } else if (e.kind === "flow") {
      if (e.pageIndex !== undefined) engine.dispatch({ type: "setPage", index: e.pageIndex });
      engine.dispatch({ type: "presentStart", id: e.id });
    }
    setRecents(saveRecent({ kind: e.kind, id: e.kind === "command" ? e.label : e.id, label: e.label }));
    onClose();
  };

  const ORDER: SearchKind[] = ["command", "layer", "page", "component", "variable", "flow"];
  const TITLES: Record<SearchKind, string> = {
    command: "Commands",
    layer: "Layers",
    page: "Pages",
    component: "Components",
    variable: "Variables",
    flow: "Flows",
  };
  let gi = -1;
  const rowBtn = (e: QuickEntry) => {
    gi++;
    const i = gi;
    return (
      <button
        key={`${e.kind}-${e.id}`}
        id={`qo-${e.kind}-${e.id}`}
        role="option"
        aria-selected={i === clamped}
        className={i === clamped ? "qo-active" : ""}
        onMouseEnter={() => setActive(i)}
        onClick={() => runEntry(e)}
      >
        {e.icon && <Icon name={e.kind === "layer" ? kindIcon(e.icon) : (e.icon as IconName)} size={14} />}
        <span className="qo-label">{e.label}</span>
        {e.detail && <span className="qo-detail">{e.detail}</span>}
        {e.sc && <span className="sc">{e.sc}</span>}
      </button>
    );
  };
  return (
    <div className="actions" role="dialog" aria-label="Quick open">
      <input
        autoFocus
        placeholder="Type a command or search layers, pages, components…"
        value={q}
        role="combobox"
        aria-expanded="true"
        aria-controls="quickopen-list"
        aria-activedescendant={rows[clamped] ? `qo-${rows[clamped].kind}-${rows[clamped].id}` : undefined}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, rows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && rows[clamped]) runEntry(rows[clamped]);
        }}
      />
      <div className="qo-filters" role="group" aria-label="Result type">
        {(["all", "command", "layer", "page", "component", "variable", "flow"] as const).map((f) => (
          <button
            key={f}
            className={filter === f ? "on" : ""}
            aria-pressed={filter === f}
            onClick={() => {
              setFilter(f);
              setActive(0);
            }}
          >
            {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1) + "s"}
          </button>
        ))}
      </div>
      <div id="quickopen-list" role="listbox" aria-label="Results">
        {rows.length === 0 && (
          <div className="actions-empty">No match for “{q.trim()}” — try a layer, component, or “zoom”.</div>
        )}
        {recentEntries.length > 0 && <div className="qo-head">Recent</div>}
        {recentEntries.map((e) => rowBtn(e))}
        {ORDER.map((kind) => {
          const group = results.filter((e) => e.kind === kind);
          if (!group.length) return null;
          return (
            <div key={kind}>
              <div className="qo-head">{TITLES[kind]}</div>
              {group.map((e) => rowBtn(e))}
            </div>
          );
        })}
      </div>
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
    onPresent?: () => void;
    onPresentExit?: () => void;
    /** Close the topmost modal; returns whether one was open. */
    onEscapeOverlay?: () => boolean;
  },
) {
  // §26 KB-014: opacity-digit chaining — the last digit, when it was tapped,
  // and the document revision right after it applied.
  let lastDigit = 0;
  let lastDigitAt = 0;
  let lastDigitRev = -1;
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
    // §23 PT-010: ⌘⌥Return / Ctrl+Alt+Enter presents (Figma) — Present had
    // no chord at all. Never while presenting (that would restart the flow).
    if (meta && e.altKey && e.key === "Enter" && !engine.snapshot().presentFrame) {
      e.preventDefault();
      extra.onPresent?.();
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
    // §26 KB-012: ⌃⇧? opens the shortcuts sheet itself — Figma's panel chord,
    // verbatim from the "Use Figma products with a keyboard" article. A bare
    // Control, never ⌘: ⌘? is unbound on both platforms.
    if (!e.metaKey && e.ctrlKey && e.shiftKey && !e.altKey && e.key === "?") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("x-native-shortcuts"));
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
    // ⌘\ / ⌘. — toggle clean canvas / interface visibility. ⌥ stays out of
    // the period half: ⌥⌘. is font-weight up.
    if (meta && (backslash || (period && !e.altKey))) {
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
    // Inside vector-edit mode ⇧E/⇧B are the Eraser and Paint bucket, not the
    // tab toggle / stroke toggle they are on the bare canvas.
    if (engine.snapshot().vecEdit && !meta && !e.altKey && e.shiftKey) {
      const vk = e.key.toLowerCase();
      if (vk === "e") {
        e.preventDefault();
        engine.dispatch({ type: "setTool", tool: "eraser" });
        return;
      }
      if (vk === "b") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("x-native-vec-subtool", { detail: "paint" }));
        return;
      }
    }
    if (e.shiftKey && e.key.toLowerCase() === "e" && !meta && !e.altKey) {
      e.preventDefault();
      const cur = engine.snapshot().rightTab;
      engine.dispatch({ type: "setRightTab", tab: cur === "prototype" ? "design" : "prototype" });
      return;
    }
    // ⌥1..3 / ⌃1..3 switch navigation panes
    if ((e.altKey || (e.ctrlKey && !meta && !e.shiftKey)) && extra.onNav) {
      if (e.key === "1") extra.onNav("file");
      if (e.key === "2") extra.onNav("assets");
      if (e.key === "3") extra.onNav("variables");
    }
    // ⌥W/A/S/D/H/V align. e.code, not e.key: with ⌥ held macOS types dead-key
    // characters (å, ∑) instead of letters, which left these chords working on
    // Windows/Linux but dead on Mac. With ⇧ added the selection aligns to its
    // parent instead — the keyboard twin of ⇧-clicking an align button.
    if (e.altKey && !meta) {
      const am: Record<
        string,
        "align-left" | "align-right" | "align-top" | "align-bottom" | "align-hcenter" | "align-vcenter"
      > = {
        KeyA: "align-left",
        KeyD: "align-right",
        KeyW: "align-top",
        KeyS: "align-bottom",
        KeyH: "align-hcenter",
        KeyV: "align-vcenter",
      };
      const mode = am[e.code];
      if (mode) {
        e.preventDefault();
        align(engine, engine.snapshot(), mode, e.shiftKey);
        return;
      }
    }
    // Distribute spacing: ⌃⌥H / ⌃⌥V. The align row's tooltips
    // advertise these, so they must actually be bound.
    // NB: `meta` above is metaKey||ctrlKey, so it is always true when Ctrl is
    // held — test e.ctrlKey directly and exclude Cmd instead.
    if (e.ctrlKey && e.altKey && !e.metaKey) {
      // e.code: ⌃⌥ on macOS yields control characters in e.key, not letters.
      const k = e.code === "KeyH" ? "h" : e.code === "KeyV" ? "v" : null;
      if (k) {
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
    // §26 KB-001: Ctrl+Y redoes — the Windows redo chord (§25 deferred it
    // here), placed before the outline toggle below so ⌃Y never reaches it.
    // No ⌘: on a Mac this is a bare-Control extra, and ⌘Y keeps outlining.
    if (!e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyY") {
      e.preventDefault();
      engine.dispatch({ type: "redo" });
      return;
    }
    if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
      const id = engine.snapshot().selection[0];
      if (id) {
        e.preventDefault();
        // The rename UI lives in the layers pane; the panel follows App nav.
        extra.onNav?.("file");
        window.dispatchEvent(new CustomEvent("x-rename-layer", { detail: id }));
        return;
      }
    }
    if (meta && e.altKey && e.shiftKey && e.code === "KeyR") {
      e.preventDefault();
      engine.dispatch({ type: "resizeToFit" });
      return;
    }
    if (meta && e.key.toLowerCase() === "f") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("x-native-find"));
      return;
    }
    // §26 KB-001: outline mode is ⇧O, or ⌘Y with a true ⌘ — the old `meta`
    // test swallowed Ctrl+Y on Windows, where that chord redoes (above).
    if (
      (!meta && e.shiftKey && e.key.toLowerCase() === "o") ||
      (e.metaKey && (e.key.toLowerCase() === "y" || e.code === "KeyY"))
    ) {
      e.preventDefault();
      engine.dispatch({ type: "toggleOutlines" });
      return;
    }
    // §26 KB-015: the eyedropper is bare I (Figma). A second disjunct once
    // offered Ctrl+C, but `meta` already includes Ctrl, so `e.ctrlKey &&
    // !meta` could never hold — dead code, removed. (Ctrl+C stays Copy.)
    const isEyedrop = !meta && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i";
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
    // §26 KB-004: `/` removes the stroke, `⌥/` removes the fill (Figma; §11
    // deferred the pair here). e.code for the ⌥ half: macOS types ÷ for it,
    // so e.key never reads "/". Typing in a field never reaches this far.
    if (!meta && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "Slash" || e.key === "/")) {
      e.preventDefault();
      engine.dispatch({ type: "removeStroke" });
      return;
    }
    if (!e.metaKey && !e.ctrlKey && e.altKey && !e.shiftKey && (e.code === "Slash" || e.key === "÷")) {
      e.preventDefault();
      engine.dispatch({ type: "removeFill" });
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
    // §26 KB-008: ⌘⇧C copies the selection as a PNG (Figma) — ahead of Copy,
    // which takes every ⌘C regardless of ⇧.
    if (meta && !e.altKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("x-native-copy-png"));
      return;
    }
    if (meta && !e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      engine.dispatch({ type: "copy" });
      window.dispatchEvent(new CustomEvent("x-native-layer-copy"));
      return;
    }
    if (meta && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      engine.dispatch({ type: "cut" });
      window.dispatchEvent(new CustomEvent("x-native-layer-copy"));
      return;
    }
    if (meta && !e.altKey && e.shiftKey && (e.key.toLowerCase() === "x" || e.code === "KeyX")) {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          engine.dispatch({
            type: "patch",
            id,
            patch: { textDecoration: n.textDecoration === "strikethrough" ? "none" : "strikethrough" },
          });
        }
      }
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
      if (e.altKey && !e.shiftKey) engine.dispatch({ type: "frameSelection" });
      else engine.dispatch({ type: e.shiftKey ? "ungroup" : "group" });
      return;
    }
    // Front/back take ⌥ (what the shortcut sheet advertises) or ⇧ (what the
    // Arrange menu shows) — both chords reach the same command. §26 KB-003:
    // matched on e.code too, because on a Mac ⌥] types a dead-key character
    // instead of "]", which left the ⌥ half of the pair silently dead there.
    if (meta && (e.key === "]" || e.code === "BracketRight")) {
      e.preventDefault();
      engine.dispatch({ type: "arrange", dir: e.shiftKey || e.altKey ? "front" : "forward" });
      return;
    }
    if (meta && (e.key === "[" || e.code === "BracketLeft")) {
      e.preventDefault();
      engine.dispatch({ type: "arrange", dir: e.shiftKey || e.altKey ? "back" : "backward" });
      return;
    }
    // §26 KB-011: ⌥L collapses all layers (Figma) — the button's chord twin.
    // e.code: ⌥L types ¬ on a Mac, so e.key never reads "l" for it.
    if (!e.metaKey && !e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyL") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("x-collapse-all"));
      return;
    }
    // ⌘L adds stack layout, ⌥⌘L removes stack layout
    if (meta && !e.shiftKey && (e.key.toLowerCase() === "l" || e.code === "KeyL")) {
      e.preventDefault();
      const snap = engine.snapshot();
      if (!snap.selection.length) return;
      // ⌥⌘L is text-align-left (the sheet's claim); remove-layout lives on
      // ⇧⌥A alone now. With no text selected the chord does nothing. e.code:
      // with ⌥ held macOS reports L as ¬, so e.key never matches.
      if (e.altKey) {
        const root = snap.pages[snap.page].root;
        for (const id of snap.selection) {
          const n = find(root, id);
          if (n && n.kind === "text") engine.dispatch({ type: "patch", id, patch: { textAlign: "left" } });
        }
      } else addAutoLayout(engine, snap);
      return;
    }
    // Text align center / right / justified: the sheet has advertised the
    // first two all along with no handler behind them.
    if (meta && e.altKey && !e.shiftKey && (e.key.toLowerCase() === "t" || e.code === "KeyT")) {
      e.preventDefault();
      const snap = engine.snapshot();
      const root = snap.pages[snap.page].root;
      // §26 KB-006: Figma parks Tidy up on this same chord — it centres text,
      // but with no text selected and 2+ layers it tidies instead.
      const tnodes = snap.selection.map((id) => find(root, id)).filter((n): n is XNode => !!n);
      if (tnodes.length >= 2 && !tnodes.some((n) => n.kind === "text")) {
        engine.dispatch({ type: "tidyUp" });
        toast("Tidied up selection");
        return;
      }
      for (const id of snap.selection) {
        const n = find(root, id);
        if (n && n.kind === "text") engine.dispatch({ type: "patch", id, patch: { textAlign: "center" } });
      }
      return;
    }
    if (meta && e.altKey && !e.shiftKey && (e.key.toLowerCase() === "r" || e.code === "KeyR")) {
      e.preventDefault();
      const snap = engine.snapshot();
      const root = snap.pages[snap.page].root;
      for (const id of snap.selection) {
        const n = find(root, id);
        if (n && n.kind === "text") engine.dispatch({ type: "patch", id, patch: { textAlign: "right" } });
      }
      return;
    }
    if (meta && e.altKey && !e.shiftKey && (e.key.toLowerCase() === "j" || e.code === "KeyJ")) {
      e.preventDefault();
      const snap = engine.snapshot();
      const root = snap.pages[snap.page].root;
      for (const id of snap.selection) {
        const n = find(root, id);
        if (n && n.kind === "text") engine.dispatch({ type: "patch", id, patch: { textAlign: "justified" } });
      }
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
      // ⌘⌫ ungroups groups and frames instead of deleting them.
      if (meta && !e.shiftKey && !e.altKey) {
        const snap = engine.snapshot();
        const root = snap.pages[snap.page].root;
        const ids = snap.selection.filter((id) => {
          const n = find(root, id);
          return !!n && (n.kind === "group" || n.kind === "frame") && n.children.length > 0;
        });
        if (ids.length > 0 && ids.length === snap.selection.length) {
          e.preventDefault();
          for (const id of ids) {
            engine.dispatch({ type: "select", ids: [id] });
            engine.dispatch({ type: "ungroup" });
          }
          return;
        }
      }
      // A selected ruler guide deletes instead of the (empty) layer selection.
      const gsel = engine.snapshot();
      if (!gsel.selection.length && gsel.selectedGuide) {
        e.preventDefault();
        engine.dispatch({ type: "removeGuide", id: gsel.selectedGuide });
        return;
      }
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
      // A selected guide deselects first, without touching the tool.
      const gesc = engine.snapshot();
      if (!gesc.selection.length && gesc.selectedGuide) {
        engine.dispatch({ type: "selectGuide", id: null });
        return;
      }
      // Escape walks one level up when a nested layer is selected, and only
      // clears the selection once the top level is reached.
      const escSnap = engine.snapshot();
      const escRoot = escSnap.pages[escSnap.page].root;
      if (escSnap.selection.length === 1) {
        const par = findParent(escRoot, escSnap.selection[0]);
        if (par && par !== escRoot) {
          engine.dispatch({ type: "select", ids: [par.id] });
          return;
        }
      }
      engine.dispatch({ type: "select", ids: [] });
      engine.dispatch({ type: "setTool", tool: "select" });
      return;
    }
    // ⌥⇧U/S/I/E create booleans (as the Arrange menu advertises) and ⌥⇧F
    // flattens. e.code, not e.key: with ⌥ held macOS types dead-key
    // characters instead of letters. The Ctrl form rides along for Windows;
    // ⌘ stays excluded.
    if (e.altKey && e.shiftKey && !e.metaKey) {
      const op =
        e.code === "KeyU"
          ? "union"
          : e.code === "KeyS"
            ? "subtract"
            : e.code === "KeyI"
              ? "intersect"
              : e.code === "KeyE"
                ? "exclude"
                : null;
      if (op) {
        e.preventDefault();
        engine.dispatch({ type: "boolean", op });
        return;
      }
      if (e.code === "KeyF") {
        e.preventDefault();
        engine.dispatch({ type: "flatten" });
        return;
      }
    }
    if ((meta || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "u") {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "union" });
      return;
    }
    if ((meta || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "subtract" });
      return;
    }
    if ((meta || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "intersect" });
      return;
    }
    if ((meta || e.ctrlKey) && e.altKey && (e.key.toLowerCase() === "x" || e.key.toLowerCase() === "e")) {
      e.preventDefault();
      engine.dispatch({ type: "boolean", op: "exclude" });
      return;
    }
    if ((meta || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      engine.dispatch({ type: "flatten" });
      return;
    }
    if ((meta || e.ctrlKey) && (e.altKey || e.shiftKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      engine.dispatch({ type: "outlineStroke" });
      return;
    }
    // §26 KB-005: Use-as-mask is ⌃⌘M on the Mac, Ctrl+Alt+M on Windows —
    // Figma's Masks article, verbatim (§13 deferred the chord here). Exactly
    // one of ⌘/⌥ rides along, so the old ⌘⌥M no longer fires; e.code, because
    // ⌥M types µ on a Mac and e.key never reads "m" for it.
    if (
      e.ctrlKey &&
      (e.code === "KeyM" || e.key.toLowerCase() === "m") &&
      (e.metaKey ? !e.altKey : e.altKey)
    ) {
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
          const fontWeight = n.fontWeight >= 700 ? 400 : 700;
          engine.dispatch({ type: "patch", id, patch: { fontWeight } });
          rehugText(engine, id, { fontWeight });
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
    // §26 KB-002: ⌘I italicises (Figma) — the one text-style chord the set
    // was missing. After the boolean block, so ⌘⌥I still intersects.
    if (meta && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === "i" || e.code === "KeyI")) {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          const fontStyle = n.fontStyle === "italic" ? "normal" : "italic";
          engine.dispatch({ type: "patch", id, patch: { fontStyle } });
          rehugText(engine, id, { fontStyle });
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
          const fontSize = Math.max(1, (n.fontSize || 14) + 1);
          engine.dispatch({ type: "patch", id, patch: { fontSize } });
          rehugText(engine, id, { fontSize });
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
          const fontSize = Math.max(1, (n.fontSize || 14) - 1);
          engine.dispatch({ type: "patch", id, patch: { fontSize } });
          rehugText(engine, id, { fontSize });
        }
      }
      return;
    }
    // Font weight ⌥⌘< / >, stepping through the nine weights. e.code: with ⌥
    // held macOS reports the symbol keys as ≤ / ≥, never < / >.
    if (meta && e.altKey && !e.shiftKey && (e.code === "Comma" || e.code === "Period")) {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          const step = e.code === "Period" ? 100 : -100;
          const fontWeight = Math.max(100, Math.min(900, Math.round((n.fontWeight || 400) / 100) * 100 + step));
          engine.dispatch({ type: "patch", id, patch: { fontWeight } });
          rehugText(engine, id, { fontWeight });
        }
      }
      return;
    }
    // Letter spacing ⌥< / >, line height ⇧⌥< / >. A leading nudge off Auto
    // starts from the effective value instead of zero.
    if (!meta && !e.ctrlKey && e.altKey && (e.code === "Comma" || e.code === "Period")) {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      for (const id of engine.snapshot().selection) {
        const n = find(root, id);
        if (n && n.kind === "text") {
          e.preventDefault();
          const step = e.code === "Period" ? 1 : -1;
          if (e.shiftKey) {
            const lineHeight = Math.max(1, Math.round(n.lineHeight || n.fontSize * 1.2) + step);
            engine.dispatch({ type: "patch", id, patch: { lineHeight } });
            rehugText(engine, id, { lineHeight });
          } else {
            const letterSpacing = Math.round(((n.letterSpacing || 0) + step) * 100) / 100;
            engine.dispatch({ type: "patch", id, patch: { letterSpacing } });
            rehugText(engine, id, { letterSpacing });
          }
        }
      }
      return;
    }
    // Underline ⌥U: the help article's Mac chord (⌘U stays too). e.code
    // again - ⌥U types a ¨ dead key, so e.key never reads "u".
    if (!meta && !e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyU") {
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
    if ((meta && e.key === "0") || (!meta && e.shiftKey && e.code === "Digit0")) {
      e.preventDefault();
      zoomAboutCentre(engine, 1);
      return;
    }
    // Step through the zoom presets so the readout lands on round values
    // (25/50/100/200...) instead of compounding into 94% / 117% / 146%.
    // §26 KB-013: bare + / - step too (Figma) — ⇧ keeps working.
    if (!meta && !e.altKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomAboutCentre(engine, stepZoom(engine.snapshot().zoom, 1));
      return;
    }
    if (!meta && !e.altKey && (e.key === "-" || e.key === "_")) {
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
    // §26 KB-010: PgUp / PgDn flip pages (Figma). stopImmediatePropagation:
    // the browser would scroll the panel behind the canvas as well.
    if (!meta && !e.altKey && !e.ctrlKey && (e.key === "PageUp" || e.key === "PageDown")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const s = engine.snapshot();
      engine.dispatch({
        type: "setPage",
        index: s.page + (e.key === "PageDown" ? 1 : -1),
      });
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
      // Picker-first: the chosen files queue up and each click places one.
      // (The location-first image tool itself is still ⇧I.)
      window.dispatchEvent(new CustomEvent("x-native-place-image"));
      return;
    }
    // §26 KB-014: bare digits set opacity (Figma) — 1 is 10%, 0 is 100%.
    // Two quick taps type an exact value (2 then 5 is 25%, 0 then 0 is 0%):
    // the chain breaks when anything edits the document between the taps.
    if (!meta && !e.ctrlKey && !e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key)) {
      if (engine.snapshot().selection.length) {
        e.preventDefault();
        const d = Number(e.key);
        const s = engine.snapshot();
        const chained = s.treeRev === lastDigitRev && performance.now() - lastDigitAt < 900;
        const pct = chained ? lastDigit * 10 + d : d === 0 ? 100 : d * 10;
        lastDigit = d;
        lastDigitAt = performance.now();
        for (const id of s.selection) engine.dispatch({ type: "patch", id, patch: { opacity: pct / 100 } });
        lastDigitRev = engine.snapshot().treeRev;
        return;
      }
    }
    // §26 KB-009: N / ⇧N zoom to the next / previous top-level frame (Figma).
    // Order is canvas order (top to bottom, then left to right); a frameless
    // page ignores the chord.
    if (!meta && !e.altKey && !e.ctrlKey && (e.key.toLowerCase() === "n" || e.code === "KeyN")) {
      const s = engine.snapshot();
      const frames = s.pages[s.page].root.children.filter((c) => c.kind === "frame" && c.visible);
      if (frames.length) {
        e.preventDefault();
        const ordered = [...frames].sort((a, b) => a.y - b.y || a.x - b.x);
        const root = s.pages[s.page].root;
        const topOf = (id: string): string | null => {
          let cur: XNode | null = find(root, id);
          let top: XNode | null = null;
          while (cur && cur !== root) {
            if (root.children.includes(cur)) top = cur;
            cur = findParent(root, cur.id);
          }
          return top ? top.id : null;
        };
        let idx = -1;
        if (s.selection.length) {
          const top = topOf(s.selection[0]);
          if (top) idx = ordered.findIndex((f) => f.id === top);
        }
        if (idx < 0) {
          // No frame under the selection: start from the one nearest the
          // middle of the screen, so N always lands somewhere sensible. The
          // pan is canvas-local (see zoomTo), hence widths, never page x/y.
          const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
          const r = el?.getBoundingClientRect();
          const vw = r && r.width > 40 ? r.width : window.innerWidth - 520;
          const vh = r && r.height > 40 ? r.height : window.innerHeight - 96;
          const cx = (vw / 2 - s.panX) / s.zoom;
          const cy = (vh / 2 - s.panY) / s.zoom;
          let best = Infinity;
          ordered.forEach((f, i) => {
            const d = Math.abs(f.x + f.w / 2 - cx) + Math.abs(f.y + f.h / 2 - cy);
            if (d < best) {
              best = d;
              idx = i;
            }
          });
        }
        const next = ordered[(idx + (e.shiftKey ? -1 : 1) + ordered.length) % ordered.length];
        engine.dispatch({ type: "select", ids: [next.id] });
        zoomToRect(engine, { x: next.x, y: next.y, w: next.w, h: next.h });
        return;
      }
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
      a: "frame",
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
    // §26 KB-017/KB-018: an open context menu and a focused layer row own the
    // arrow keys — nudging underneath the menu, or while walking the tree,
    // would move the artwork behind the user's back.
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") &&
      t.closest?.(".ctx, [data-row-id]")
    )
      return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      {
        // Figma refuses position changes inside instances; skipping the
        // dispatch keeps a no-op off the undo stack. Mixed selections still
        // dispatch — the engine moves what it may and skips the rest.
        const ast = engine.snapshot();
        const aroot = ast.pages[ast.page].root;
        if (ast.selection.length && ast.selection.every((id) => isInstanceMember(aroot, id))) return;
      }
      // Inside vector edit with points selected, arrows move the anchors —
      // not the whole layer (Figma). The first nudge on a basic shape
      // converts it, exactly like dragging a point does.
      const vst = engine.snapshot();
      const vIdx =
        vst.vecEdit && vst.vecPoints && vst.vecPoints.length > 0
          ? vst.vecPoints
          : vst.vecEdit && vst.vecPoint != null && vst.vecPoint >= 0
            ? [vst.vecPoint]
            : [];
      if (vst.vecEdit && vIdx.length) {
        const vn = find(vst.pages[vst.page].root, vst.vecEdit);
        if (vn && !vn.locked) {
          const base = vn.path.length ? vn.path : shapePoly(vn);
          if (vIdx.every((i) => i >= 0 && i < base.length)) {
            engine.dispatch({
              type: "patchPath",
              id: vn.id,
              path: shiftPoints(base, vIdx, dx, dy),
              closed: vn.path.length ? !!vn.closed : (vn.kind !== "line" && vn.kind !== "arrow"),
            });
            return;
          }
        }
      }
      engine.dispatch({ type: "nudge", dx, dy });
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
  // Image inventory: every distinct imageSrc with its usages, for P4 asset
  // management. Masters are scanned too; their usages select the master node.
  const images = useMemo(() => {
    const bySrc = new Map<string, { name: string; uses: { page: number; id: string }[] }>();
    const collect = (n: XNode, page: number) => {
      if (n.imageSrc) {
        const entry = bySrc.get(n.imageSrc) ?? { name: n.name || "Image", uses: [] };
        entry.uses.push({ page, id: n.id });
        bySrc.set(n.imageSrc, entry);
      }
      for (const ch of n.children) collect(ch, page);
    };
    snap.pages.forEach((pg, pi) => collect(pg.root, pi));
    for (const c of snap.components) collect(c.node, snap.page);
    return [...bySrc.entries()].map(([src, e]) => ({ src, ...e }));
  }, [snap]);
  const filteredImages = images.filter((im) => !q || im.name.toLowerCase().includes(q.toLowerCase()));
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
            onDoubleClick={() => {
              // Figma lands a placed instance where you look: viewport
              // center, not a fixed corner every instance stacks onto.
              const z = snap.zoom || 1;
              const cx = (window.innerWidth / 2 - snap.panX) / z;
              const cy = (window.innerHeight / 2 - snap.panY) / z;
              engine.dispatch({ type: "placeComponent", id: c.id, x: Math.round(cx), y: Math.round(cy) });
            }}
          >
            <Icon name="component" size={14} />
            <span className="name">{c.name}</span>
          </div>
        ))}
      </div>
      <div className="section-label">Images ({images.reduce((n, im) => n + im.uses.length, 0)})</div>
      <div className="tree">
        {filteredImages.length === 0 && (
          <p className="empty">No images in this file yet. Place one with the image tool (⇧⌘K).</p>
        )}
        {filteredImages.map((im, i) => {
          const kb = Math.max(1, Math.round((im.src.length * 3) / 4 / 1024));
          return (
            <div
              key={i}
              className="row"
              title={`${im.uses.length} use${im.uses.length === 1 ? "" : "s"} · ~${kb} KB — click to show first use`}
              style={{ cursor: "pointer" }}
              onClick={() => {
                const first = im.uses[0];
                if (!first) return;
                engine.dispatch({ type: "setPage", index: first.page });
                engine.dispatch({ type: "select", ids: [first.id] });
                zoomTo(engine, "selection");
              }}
            >
              <img
                src={im.src}
                alt=""
                style={{ width: 22, height: 22, borderRadius: 4, objectFit: "cover", flexShrink: 0 }}
              />
              <span className="name">{im.name}</span>
              <span style={{ fontSize: 10, color: "var(--dim)", flexShrink: 0 }}>
                {im.uses.length > 1 ? `×${im.uses.length} · ` : ""}~{kb} KB
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Layer props each variable type can bind to ("apply to selection"). */
const VAR_APPLY_PROPS: Record<VariableItem["type"], { prop: string; label: string }[]> = {
  color: [
    { prop: "fill", label: "Fill" },
    { prop: "strokePaint", label: "Stroke" },
  ],
  number: [
    { prop: "strokeWidth", label: "Stroke width" },
    { prop: "opacity", label: "Opacity" },
    { prop: "fontSize", label: "Font size" },
    { prop: "fontWeight", label: "Font weight" },
    { prop: "letterSpacing", label: "Letter spacing" },
    { prop: "lineHeight", label: "Line height" },
    { prop: "paragraphSpacing", label: "Paragraph spacing" },
    { prop: "paragraphIndent", label: "Paragraph indent" },
    { prop: "cornerRadii", label: "Corner radius" },
    { prop: "w", label: "Width" },
    { prop: "h", label: "Height" },
    { prop: "layoutGap", label: "Gap" },
    { prop: "layoutPadding", label: "Padding" },
    { prop: "text", label: "Text content" },
  ],
  string: [
    { prop: "text", label: "Text content" },
    { prop: "fontFamily", label: "Font family" },
  ],
  boolean: [{ prop: "visible", label: "Visibility" }],
};

function VarRow({
  engine,
  v,
  vars,
  varCollections,
  activeModes,
  activeCol,
  activeModeId,
  sel,
  selNode,
  root,
}: {
  engine: Engine;
  v: VariableItem;
  vars: VariableItem[];
  varCollections: VariableCollection[];
  activeModes: Record<string, string>;
  activeCol: VariableCollection | null;
  activeModeId: string | undefined;
  sel: string | undefined;
  selNode: XNode | null | undefined;
  root: XNode;
}) {
  const options = VAR_APPLY_PROPS[v.type];
  const defaultProp = options[0]?.prop ?? "fill";
  const [applyProp, setApplyProp] = useState(defaultProp);
  const prop = options.some((o) => o.prop === applyProp) ? applyProp : defaultProp;
  const slot = activeModeId && v.values?.[activeModeId] !== undefined ? v.values[activeModeId] : v.value;
  const res = resolveVariable(vars, varCollections, activeModes, v.id);
  const resolved = res && !res.broken ? String(res.value) : null;
  const targetName = isAlias(slot) ? (vars.find((x) => x.id === slot.alias)?.name ?? "missing") : null;
  const modeName = activeCol?.modes.find((m) => m.id === activeModeId)?.name ?? "Default";
  const isDefaultSlot = !activeCol || activeModeId === activeCol.modes[0]?.id;

  const writeSlot = (value: VariableValue | undefined) => {
    if (isDefaultSlot) {
      engine.dispatch({
        type: "patchVariable",
        id: v.id,
        patch: { value: (value ?? fallbackForType(v.type)) as VariableValue },
      });
    } else if (activeModeId) {
      engine.dispatch({
        type: "patchVariable",
        id: v.id,
        patch: { values: { [activeModeId]: value as VariableValue } },
      });
    }
  };

  const editValue = async () => {
    const current = isAlias(slot) ? `@${targetName}` : String(slot);
    const next = await askPrompt({
      title: `Value for ${v.name}`,
      label: isDefaultSlot ? "Value" : `Value in ${modeName}`,
      hint: "@name makes it an alias of another variable",
      value: current,
      confirmLabel: "Set value",
    });
    if (next === null) return;
    if (next.startsWith("@")) {
      const target = vars.find((x) => x.name === next.slice(1) && x.type === v.type);
      if (!target) {
        toast(`No ${v.type} variable named "${next.slice(1)}"`);
        return;
      }
      if (target.id === v.id) {
        toast("A variable cannot alias itself");
        return;
      }
      if (wouldCycle(vars, varCollections, v.id, target.id, isDefaultSlot ? undefined : activeModeId)) {
        toast("Invalid — that selection would create an infinite loop of variables");
        return;
      }
      writeSlot({ alias: target.id });
      return;
    }
    const coerced = coerceVariableValue(v.type, next);
    if (!coerced.ok) {
      toast(coerced.error);
      return;
    }
    writeSlot(coerced.value);
  };

  const bind = (p: string = prop) => {
    if (!sel || !selNode) {
      toast("Select a layer first");
      return;
    }
    // One source of truth with the engine's bindVariable: the same
    // refusal reasons, so the UI and the command can never disagree.
    const blocked = bindBlockReason(root, sel, p);
    if (blocked) {
      toast(blocked);
      return;
    }
    engine.dispatch({ type: "bindVariable", id: sel, prop: p, variableId: v.id });
    const label = options.find((o) => o.prop === p)?.label ?? p;
    toast(`Bound ${v.name} to ${label.toLowerCase()}`);
  };

  const propLabel = options.find((o) => o.prop === prop)?.label ?? prop;
  return (
    <div
      className="color-row"
      style={{
        padding: "4px 6px",
        borderRadius: 6,
        background: "var(--hover)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
      }}
    >
      {v.type === "color" && (
        <span
          className="swatch"
          style={{
            background: resolved ?? "transparent",
            width: 16,
            height: 16,
            borderRadius: 4,
            flexShrink: 0,
            cursor: "pointer",
            border: resolved === null ? "1px dashed var(--dim)" : undefined,
          }}
          title={resolved === null ? "Alias is broken" : `Click to bind ${v.name} to the selected layer's fill`}
          onClick={() => bind("fill")}
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
            flexShrink: 0,
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
            flexShrink: 0,
          }}
        >
          T
        </span>
      )}
      {v.type === "boolean" && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: "1px 4px",
            borderRadius: 3,
            background: "var(--input)",
            flexShrink: 0,
          }}
        >
          B
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
        title="Double-click to rename"
        onDoubleClick={async () => {
          const name = await askPrompt({
            title: "Rename variable",
            label: "Name",
            value: v.name,
            confirmLabel: "Rename",
          });
          if (!name?.trim() || name.trim() === v.name) return;
          engine.dispatch({ type: "patchVariable", id: v.id, patch: { name: name.trim() } });
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
          maxWidth: 110,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
        title={`Click to edit${isDefaultSlot ? "" : ` ${modeName} override`} — @name makes it an alias`}
        onClick={editValue}
      >
        {resolved === null ? "⚠ broken" : targetName !== null ? `@${targetName} · ${resolved}` : resolved}
      </span>
      {options.length > 1 && (
        <select
          style={{
            fontSize: 10,
            padding: "2px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            maxWidth: 78,
            flexShrink: 0,
          }}
          value={prop}
          title="Layer property to bind"
          onChange={(e) => setApplyProp(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.prop} value={o.prop}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <button
        className="icon-btn"
        title={sel ? `Bind to the selected layer's ${propLabel.toLowerCase()}` : "Select a layer, then bind this variable to it"}
        onClick={() => bind()}
      >
        <Icon name="link" size={12} />
      </button>
      <button
        className="icon-btn"
        title={`Delete ${v.name}`}
        onClick={() => engine.dispatch({ type: "deleteVariable", id: v.id })}
      >
        <Icon name="trash" size={12} />
      </button>
    </div>
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
  const varCollections = snap.variableCollections ?? [];
  const activeModes = snap.activeModes ?? {};
  const collections = ["All", ...varCollections.map((c) => c.name)];
  const activeCol = col === "All" ? null : (varCollections.find((c) => c.name === col) ?? null);
  const activeModeId = activeCol ? (activeModes[activeCol.id] ?? activeCol.modes[0]?.id) : undefined;
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
                  title={c === "All" ? "Show every collection" : "Filter to this collection — double-click to rename"}
                  onClick={() => setCol(c)}
                  onDoubleClick={async () => {
                    if (c === "All") return;
                    const id = varCollections.find((x) => x.name === c)?.id;
                    if (!id) return;
                    const name = await askPrompt({
                      title: "Rename collection",
                      label: "Name",
                      value: c,
                      confirmLabel: "Rename",
                      validate: (val) => (val.trim() ? null : "Enter a collection name"),
                    });
                    if (!name?.trim()) return;
                    engine.dispatch({ type: "renameCollection", id, name: name.trim() });
                    setCol(name.trim());
                  }}
                >
                  {c}
                </button>
              ))}
              <button
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 10,
                  border: "1px dashed var(--border)",
                  background: "transparent",
                  color: "var(--dim)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                title="Add collection"
                onClick={async () => {
                  const name = await askPrompt({
                    title: "New collection",
                    label: "Collection name",
                    value: `Collection ${varCollections.length + 1}`,
                    confirmLabel: "Create",
                    validate: (val) => (val.trim() ? null : "Enter a collection name"),
                  });
                  if (!name?.trim()) return;
                  engine.dispatch({ type: "addCollection", name: name.trim() });
                  setCol(name.trim());
                }}
              >
                + New
              </button>
            </div>
            <button
              className="plus"
              title="Add Variable"
              onClick={() => setAddingVar((v) => !v)}
            >
              <Icon name={addingVar ? "x-mark" : "plus"} size={14} />
            </button>
          </div>

          {activeCol && (
            <div className="h-row" style={{ padding: "2px 12px" }}>
              <div style={{ display: "flex", gap: 4, overflowX: "auto", alignItems: "center", flex: 1 }}>
                <span style={{ fontSize: 10, color: "var(--dim)", flexShrink: 0 }}>Mode:</span>
                {activeCol.modes.map((m) => (
                  <button
                    key={m.id}
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 10,
                      border: 0,
                      background: activeModeId === m.id ? "var(--blue)" : "var(--input)",
                      color: activeModeId === m.id ? "var(--on-accent)" : "var(--text)",
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                    title={
                      activeModeId === m.id
                        ? "Active mode — double-click to rename"
                        : "Switch to this mode — double-click to rename"
                    }
                    onClick={() =>
                      engine.dispatch({ type: "setActiveMode", collectionId: activeCol.id, modeId: m.id })
                    }
                    onDoubleClick={async () => {
                      const name = await askPrompt({
                        title: "Rename mode",
                        label: "Name",
                        value: m.name,
                        confirmLabel: "Rename",
                        validate: (val) => (val.trim() ? null : "Enter a mode name"),
                      });
                      if (!name?.trim()) return;
                      engine.dispatch({
                        type: "renameMode",
                        collectionId: activeCol.id,
                        modeId: m.id,
                        name: name.trim(),
                      });
                    }}
                  >
                    {m.name}
                  </button>
                ))}
                <button
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 10,
                    border: "1px dashed var(--border)",
                    background: "transparent",
                    color: "var(--dim)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  title="Add mode"
                  onClick={async () => {
                    const name = await askPrompt({
                      title: "New mode",
                      label: "Mode name",
                      value: `Mode ${activeCol.modes.length + 1}`,
                      confirmLabel: "Create",
                      validate: (val) => (val.trim() ? null : "Enter a mode name"),
                    });
                    if (!name?.trim()) return;
                    engine.dispatch({ type: "addMode", collectionId: activeCol.id, name: name.trim() });
                  }}
                >
                  +
                </button>
              </div>
              {activeCol.modes.length > 1 && (
                <button
                  className="icon-btn"
                  title="Delete the active mode and its overrides"
                  onClick={async () => {
                    const m = activeCol.modes.find((x) => x.id === activeModeId);
                    if (!m) return;
                    const ok = await askConfirm({
                      title: `Delete mode "${m.name}"`,
                      body: "Values set in this mode are removed with it. The default mode keeps its values.",
                      confirmLabel: "Delete mode",
                      danger: true,
                    });
                    if (!ok) return;
                    engine.dispatch({ type: "deleteMode", collectionId: activeCol.id, modeId: m.id });
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              )}
              <button
                className="icon-btn"
                title={`Delete collection "${activeCol.name}" and its variables`}
                onClick={async () => {
                  const ok = await askConfirm({
                    title: `Delete collection "${activeCol.name}"`,
                    body: "Every variable in it is deleted, and layers bound to those variables keep their current appearance.",
                    confirmLabel: "Delete collection",
                    danger: true,
                  });
                  if (!ok) return;
                  engine.dispatch({ type: "deleteCollection", id: activeCol.id });
                  setCol("All");
                }}
              >
                <Icon name="x-mark" size={12} />
              </button>
            </div>
          )}

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
                  aria-label="Variable type"
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
                    const coerced = coerceVariableValue(varType, varVal);
                    if (!coerced.ok) {
                      toast(coerced.error);
                      return;
                    }
                    const collection = activeCol ? activeCol.name : (varCollections[0]?.name ?? "Brand");
                    engine.dispatch({
                      type: "addVariable",
                      variable: { id: "var_" + Date.now(), name: varName.trim(), type: varType, value: coerced.value, collection },
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
              <VarRow
                key={v.id}
                engine={engine}
                v={v}
                vars={vars}
                varCollections={varCollections}
                activeModes={activeModes}
                activeCol={activeCol}
                activeModeId={activeModeId}
                sel={sel}
                selNode={selNode}
                root={snap.pages[snap.page].root}
              />
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
              onClick={async () => {
                if (!selNode) {
                  toast("Select a layer to create a style from its fill or stroke");
                  return;
                }
                const hasStroke = selNode.strokeWidth > 0 && !isNone(selNode.strokePaint);
                // Was `confirm`: OK meant stroke and Cancel meant fill, so the
                // dialog had no way to say "neither" — and pressing Cancel
                // created a style anyway. Both outcomes are buttons now.
                const kind =
                  (hasStroke
                    ? await askChoice({
                        title: "Create style from",
                        body: `"${selNode.name}" has both a fill and a stroke.`,
                        options: [
                          { label: "Stroke", value: "stroke" },
                          { label: "Fill", value: "fill", primary: true },
                        ],
                      })
                    : "fill") as "fill" | "stroke" | null;
                if (kind === null) return;
                const name = await askPrompt({
                  title: `Style name (${kind})`,
                  label: "Name",
                  value: selNode.name || "Style",
                  confirmLabel: "Create style",
                });
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
                  <span
                    className="hex"
                    style={{ flex: 1 }}
                    title="Double-click to rename"
                    onDoubleClick={async () => {
                      const name = await askPrompt({
                        title: "Rename style",
                        label: "Name",
                        value: st.name,
                        confirmLabel: "Rename",
                      });
                      if (!name?.trim() || name.trim() === st.name) return;
                      engine.dispatch({ type: "editStyle", id: st.id, name: name.trim() });
                    }}
                  >
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
                    onClick={async () => {
                      const next = await askPrompt({
                        title: `Colour for ${st.name}`,
                        label: "Hex colour",
                        value: st.color,
                        hint: "The leading # is optional",
                        confirmLabel: "Set colour",
                        validate: (v) => (v.trim() ? null : "Enter a colour, e.g. #10b981"),
                      });
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
      { id: "copy-png", name: "Copy selection as PNG", keys: ["⇧", "⌘", "C"] },
      { id: "remove-stroke", name: "Remove stroke", keys: ["/"] },
      { id: "remove-fill", name: "Remove fill", keys: ["⌥", "/"] },
      { id: "opacity", name: "Set opacity (tap twice for exact %)", keys: ["1", "…", "0"] },
      { id: "collapse-all", name: "Collapse all layers", keys: ["⌥", "L"] },
      { id: "shortcuts-panel", name: "This shortcuts panel", keys: ["⌃", "⇧", "?"] },
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
      { id: "place-image", name: "Place image", keys: ["⇧", "⌘", "K"] },
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
      { id: "zoom-100", name: "Zoom to 100%", keys: ["⇧", "0"] },
      { id: "zoom-fit", name: "Zoom to fit", keys: ["⇧", "1"] },
      { id: "zoom-sel", name: "Zoom to selection", keys: ["⇧", "2"] },
      { id: "frame-next", name: "Zoom to next frame", keys: ["N"] },
      { id: "frame-prev", name: "Zoom to previous frame", keys: ["⇧", "N"] },
      { id: "rulers", name: "Rulers", keys: ["⇧", "R"] },
      { id: "pixel-grid", name: "Pixel grid", keys: ["⌘", "'"] },
      { id: "pixel-snap", name: "Snap to pixel grid", keys: ["⌘", "⇧", "'"] },
      { id: "pixel-preview", name: "Pixel preview 1×", keys: ["⌃", "P"] },
      { id: "pixel-preview-2", name: "Pixel preview 2×", keys: ["⌃", "⌥", "P"] },
      { id: "zoom-tool", name: "Zoom tool", keys: ["Z"] },
      { id: "zoom-center", name: "Center selection", keys: ["⌘", "3"] },
      { id: "round-pixel", name: "Round to whole pixels", keys: ["⇧", "⌘", "P"] },
      { id: "layout-grids", name: "Layout grids", keys: ["⇧", "G"] },
      { id: "outline", name: "Outline mode", keys: ["⌘", "Y"] },
      { id: "present", name: "Present", keys: ["⌘", "⌥", "↩"] },
    ],
  },
  {
    tab: "Text",
    items: [
      { id: "bold", name: "Bold", keys: ["⌘", "B"] },
      { id: "italic", name: "Italic", keys: ["⌘", "I"] },
      { id: "underline", name: "Underline", keys: ["⌘", "U"] },
      { id: "underline-opt", name: "Underline", keys: ["⌥", "U"] },
      { id: "strike", name: "Strikethrough", keys: ["⌘", "⇧", "X"] },
      { id: "font-inc", name: "Increase font size", keys: ["⌘", "⇧", ">"] },
      { id: "font-dec", name: "Decrease font size", keys: ["⌘", "⇧", "<"] },
      { id: "weight-inc", name: "Increase font weight", keys: ["⌘", "⌥", ">"] },
      { id: "weight-dec", name: "Decrease font weight", keys: ["⌘", "⌥", "<"] },
      { id: "tracking-inc", name: "Increase letter spacing", keys: ["⌥", ">"] },
      { id: "tracking-dec", name: "Decrease letter spacing", keys: ["⌥", "<"] },
      { id: "leading-inc", name: "Increase line height", keys: ["⇧", "⌥", ">"] },
      { id: "leading-dec", name: "Decrease line height", keys: ["⇧", "⌥", "<"] },
      { id: "align-left", name: "Text align left", keys: ["⌥", "⌘", "L"] },
      { id: "align-center", name: "Text align center", keys: ["⌥", "⌘", "T"] },
      { id: "align-right", name: "Text align right", keys: ["⌥", "⌘", "R"] },
      { id: "align-justify", name: "Text align justified", keys: ["⌥", "⌘", "J"] },
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
      { id: "tidy-up", name: "Tidy up selection (no text selected)", keys: ["⌘", "⌥", "T"] },
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
      { id: "mask", name: "Use as mask", keys: ["⌃", "⌘", "M"] },
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
      else if (meta && k === "c") matchedId = e.shiftKey && !e.altKey ? "copy-png" : "copy";
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
      // §26: highlight the chords this section added or moved.
      else if (!e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && k === "y") matchedId = "redo";
      else if (meta && !e.shiftKey && !e.altKey && k === "i") matchedId = "italic";
      else if (e.ctrlKey && e.code === "KeyM" && (e.metaKey ? !e.altKey : e.altKey)) matchedId = "mask";
      else if (!meta && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "Slash" || k === "/"))
        matchedId = "remove-stroke";
      else if (!e.metaKey && !e.ctrlKey && e.altKey && !e.shiftKey && e.code === "Slash") matchedId = "remove-fill";
      else if (!meta && !e.ctrlKey && !e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key)) matchedId = "opacity";
      else if (!meta && !e.altKey && !e.ctrlKey && k === "n") matchedId = e.shiftKey ? "frame-prev" : "frame-next";
      else if (!e.metaKey && !e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyL") matchedId = "collapse-all";
      else if (!e.metaKey && e.ctrlKey && e.shiftKey && !e.altKey && e.key === "?") matchedId = "shortcuts-panel";
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
  useRestoreFocus();
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
