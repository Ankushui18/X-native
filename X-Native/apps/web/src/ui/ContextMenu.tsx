import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine, XNode } from "../engine/types";
import { find } from "../engine/memory";
import { Icon } from "./icons";

export type MenuItem =
  | { kind: "action"; id: string; label: string; shortcut?: string; icon?: string; enabled?: boolean }
  | { kind: "sep" }
  | { kind: "sub"; label: string; icon?: string; items: MenuItem[] };

export function ContextMenu({
  x,
  y,
  items,
  onRun,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", on);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", on);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const h = items.reduce((s, it) => s + (it.kind === "sep" ? 7 : 28), 10);
  const w = 220;
  const left = Math.max(4, Math.min(x, window.innerWidth - w - 8));
  const top = Math.max(4, Math.min(y, window.innerHeight - h - 8));

  return createPortal(
    <div className="ctx" style={{ left, top, width: w }} role="menu">
      {items.map((it, i) => {
        if (it.kind === "sep") return <hr key={i} />;
        if (it.kind === "sub") {
          return (
            <div
              key={i}
              className="ctx-row sub"
              onMouseEnter={() => setOpenSub(i)}
              onMouseLeave={() => setOpenSub((n) => (n === i ? null : n))}
            >
              {it.icon && <Icon name={it.icon} size={14} />}
              <span>{it.label}</span>
              <span className="sc">
                <Icon name="chevron-right" size={12} />
              </span>
              {openSub === i && (
                <div className="ctx fly-sub">
                  {it.items.map((s, j) =>
                    s.kind === "action" ? (
                      <button
                        key={j}
                        disabled={s.enabled === false}
                        onClick={() => {
                          onRun(s.id);
                          onClose();
                        }}
                      >
                        {s.icon && <Icon name={s.icon} size={14} />}
                        {s.label}
                        {s.shortcut && <span className="sc">{s.shortcut}</span>}
                      </button>
                    ) : (
                      <hr key={j} />
                    ),
                  )}
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            className="ctx-row"
            disabled={it.enabled === false}
            onClick={() => {
              onRun(it.id);
              onClose();
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            {it.label}
            {it.shortcut && <span className="sc">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

export function canvasMenu(sel: number, isGroup: boolean, hasImage: boolean): MenuItem[] {
  if (sel === 0) {
    return [
      { kind: "action", id: "paste", label: "Paste", shortcut: "⌘V", icon: "clipboard" },
      { kind: "action", id: "selectAll", label: "Select all", shortcut: "⌘A", icon: "rect" },
    ];
  }
  const items: MenuItem[] = [
    { kind: "action", id: "cut", label: "Cut", shortcut: "⌘X", icon: "scissors" },
    { kind: "action", id: "copy", label: "Copy", shortcut: "⌘C", icon: "copy" },
    { kind: "action", id: "paste", label: "Paste", shortcut: "⌘V", icon: "clipboard" },
    { kind: "action", id: "copyCode", label: "Copy as code", icon: "code" },
    { kind: "action", id: "duplicate", label: "Duplicate", shortcut: "⌘D", icon: "copy" },
    { kind: "sep" },
  ];
  if (sel > 1) items.push({ kind: "action", id: "group", label: "Group selection", shortcut: "⌘G", icon: "group" });
  if (isGroup) items.push({ kind: "action", id: "ungroup", label: "Ungroup", shortcut: "⇧⌘G", icon: "group" });
  items.push({ kind: "action", id: "wrapSection", label: "Wrap in new section", icon: "section" });
  items.push({ kind: "action", id: "makeComponent", label: "Create component", shortcut: "⌘⌥K", icon: "component" });
  items.push({ kind: "action", id: "detachInstance", label: "Detach instance", icon: "component" });
  items.push({ kind: "action", id: "useAsMask", label: "Use as mask", shortcut: "⌘⌥M", icon: "rect" });
  items.push({ kind: "action", id: "flipH", label: "Flip horizontal", shortcut: "⇧H", icon: "flip-h" });
  items.push({ kind: "action", id: "flipV", label: "Flip vertical", shortcut: "⇧V", icon: "flip-v" });
  if (hasImage) {
    /* image-specific items already covered by flip */
  }
  items.push({ kind: "sep" });
  items.push({
    kind: "sub",
    label: "Arrange",
    icon: "layers",
    items: [
      { kind: "action", id: "front", label: "Bring to front", shortcut: "⇧⌘]", icon: "chevrons-up" },
      { kind: "action", id: "forward", label: "Bring forward", shortcut: "⌘]", icon: "chevron-up" },
      { kind: "action", id: "backward", label: "Send backward", shortcut: "⌘[", icon: "chevron-down" },
      { kind: "action", id: "back", label: "Send to back", shortcut: "⇧⌘[", icon: "chevrons-down" },
    ],
  });
  if (sel > 1) {
    items.push({
      kind: "sub",
      label: "Boolean",
      icon: "rect",
      items: [
        { kind: "action", id: "union", label: "Union selection", shortcut: "⌥⇧U" },
        { kind: "action", id: "subtract", label: "Subtract", shortcut: "⌥⇧S" },
        { kind: "action", id: "intersect", label: "Intersect", shortcut: "⌥⇧I" },
        { kind: "action", id: "exclude", label: "Exclude", shortcut: "⌥⇧E" },
        { kind: "action", id: "flatten", label: "Flatten" },
      ],
    });
  }
  items.push({ kind: "sep" });
  items.push({ kind: "action", id: "flatten", label: "Flatten selection", shortcut: "⌘E" });
  items.push({ kind: "action", id: "outlineStroke", label: "Outline stroke", shortcut: "⇧⌘O" });
  items.push({ kind: "sep" });
  items.push({ kind: "action", id: "lockSel", label: "Lock/Unlock", shortcut: "⇧⌘L", icon: "lock" });
  items.push({ kind: "action", id: "hideSel", label: "Show/Hide", shortcut: "⇧⌘H", icon: "eye-off" });
  items.push({ kind: "action", id: "selectAll", label: "Select all", shortcut: "⌘A" });
  items.push({ kind: "action", id: "delete", label: "Delete", shortcut: "⌫", icon: "trash" });
  return items;
}

export function layerMenu(isGroup: boolean): MenuItem[] {
  return [
    { kind: "action", id: "rename", label: "Rename", shortcut: "⌘R", icon: "text" },
    { kind: "sep" },
    { kind: "action", id: "cut", label: "Cut", shortcut: "⌘X", icon: "scissors" },
    { kind: "action", id: "copy", label: "Copy", shortcut: "⌘C", icon: "copy" },
    { kind: "action", id: "paste", label: "Paste", shortcut: "⌘V", icon: "clipboard" },
    { kind: "action", id: "duplicate", label: "Duplicate", shortcut: "⌘D", icon: "copy" },
    { kind: "sep" },
    { kind: "action", id: "makeComponent", label: "Create component", shortcut: "⌘⌥K", icon: "component" },
    { kind: "action", id: "detachInstance", label: "Detach instance", icon: "component" },
    { kind: "sep" },
    ...(isGroup
      ? [{ kind: "action" as const, id: "ungroup", label: "Ungroup", shortcut: "⇧⌘G", icon: "group" }]
      : []),
    { kind: "action", id: "lockSel", label: "Lock/Unlock", shortcut: "⇧⌘L", icon: "lock" },
    { kind: "action", id: "hideSel", label: "Show/Hide", shortcut: "⇧⌘H", icon: "eye-off" },
    { kind: "sep" },
    { kind: "action", id: "delete", label: "Delete", shortcut: "⌫", icon: "trash" },
  ];
}

export function pageMenu(canDelete: boolean): MenuItem[] {
  return [
    { kind: "action", id: "renamePage", label: "Rename page", icon: "text" },
    { kind: "action", id: "duplicatePage", label: "Duplicate page", icon: "copy" },
    { kind: "action", id: "deletePage", label: "Delete page", shortcut: "⌫", icon: "trash", enabled: canDelete },
  ];
}

export function runMenu(
  engine: Engine,
  id: string,
  extra?: { x?: number; y?: number; onRename?: () => void },
) {
  switch (id) {
    case "cut":
      engine.dispatch({ type: "cut" });
      break;
    case "copy":
      engine.dispatch({ type: "copy" });
      break;
    case "paste":
      engine.dispatch({ type: "paste", x: extra?.x, y: extra?.y });
      break;
    case "copyCode":
      engine.dispatch({ type: "copyCode" });
      break;
    case "duplicate":
      engine.dispatch({ type: "duplicate" });
      break;
    case "delete":
      engine.dispatch({ type: "delete" });
      break;
    case "selectAll":
      engine.dispatch({ type: "selectAll" });
      break;
    case "group":
      engine.dispatch({ type: "group" });
      break;
    case "union":
    case "subtract":
    case "intersect":
    case "exclude":
      engine.dispatch({ type: "boolean", op: id });
      break;
    case "ungroup":
      engine.dispatch({ type: "ungroup" });
      break;
    case "wrapSection":
      engine.dispatch({ type: "wrapSection" });
      break;
    case "front":
      engine.dispatch({ type: "arrange", dir: "front" });
      break;
    case "forward":
      engine.dispatch({ type: "arrange", dir: "forward" });
      break;
    case "backward":
      engine.dispatch({ type: "arrange", dir: "backward" });
      break;
    case "back":
      engine.dispatch({ type: "arrange", dir: "back" });
      break;
    case "lockSel":
      engine.dispatch({ type: "lockSel" });
      break;
    case "hideSel":
      engine.dispatch({ type: "hideSel" });
      break;
    case "flipH":
      engine.dispatch({ type: "flip", axis: "h" });
      break;
    case "flipV":
      engine.dispatch({ type: "flip", axis: "v" });
      break;
    case "duplicatePage":
      engine.dispatch({ type: "duplicatePage" });
      break;
    case "deletePage":
      engine.dispatch({ type: "deletePage" });
      break;
    case "rename":
    case "renamePage":
      extra?.onRename?.();
      break;
    case "makeComponent":
      engine.dispatch({ type: "makeComponent" });
      break;
    case "detachInstance":
      engine.dispatch({ type: "detachInstance" });
      break;
    case "flatten":
      engine.dispatch({ type: "flatten" });
      break;
    case "outlineStroke":
      engine.dispatch({ type: "outlineStroke" });
      break;
    case "useAsMask": {
      const s = engine.snapshot();
      if (s.selection.length >= 2) engine.dispatch({ type: "group" });
      const snap = engine.snapshot();
      const root = snap.pages[snap.page].root;
      const id0 = snap.selection[0];
      const n = id0 ? find(root, id0) : null;
      if (n?.children.length) {
        engine.dispatch({ type: "patch", id: n.children[0].id, patch: { isMask: true } });
      } else if (id0) {
        engine.dispatch({ type: "patch", id: id0, patch: { isMask: true } });
      }
      break;
    }
    default:
      break;
  }
}

export function isGroupNode(n?: XNode | null): boolean {
  return !!n && (n.kind === "group" || (n.kind === "frame" && n.name === "Group"));
}
