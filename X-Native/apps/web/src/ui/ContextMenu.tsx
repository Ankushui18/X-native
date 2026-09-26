import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Engine, XNode } from "../engine/types";
import { plural, toast } from "./toast";
import { find } from "../engine/memory";
import { Icon, caretSize, kindIcon, type IconName } from "./icons";
import { SAME_KINDS, selectInverse, selectMatching, selectSame } from "./selectSame";
import { DEV_LANGS, type DevFormat } from "./devPrefs";
import { addAutoLayout, removeAllAutoLayout, removeAutoLayout, suggestAutoLayout } from "./layoutActions";
import { armPopover } from "./popoverGuard";

export type MenuItem =
  | { kind: "action"; id: string; label: string; shortcut?: string; icon?: IconName; enabled?: boolean }
  | { kind: "sep" }
  | { kind: "sub"; label: string; icon?: IconName; items: MenuItem[] };

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
  // §26 KB-017: an open menu is a popover — Escape closes it (below) instead
  // of clearing the canvas selection behind it.
  useEffect(() => armPopover(), []);
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

  // Row-height arithmetic is only an estimate — real rows drift with font
  // metrics and separators, so a tall menu opened near the bottom hung off the
  // edge. Measure the rendered node and re-derive the position from the true
  // height before paint.
  const ref = useRef<HTMLDivElement | null>(null);
  const estimated = items.reduce((s, it) => s + (it.kind === "sep" ? 7 : 28), 10);
  const [h, setH] = useState(estimated);
  useLayoutEffect(() => {
    // While a submenu is open the position has to hold still: re-measuring here
    // shifts the whole list by a row or so, which moves the row the pointer is
    // on, and the submenu you meant to open closes on the way.
    if (openSub !== null) return;
    const el = ref.current;
    if (!el) return;
    const real = el.getBoundingClientRect().height;
    if (Math.abs(real - h) > 0.5) setH(real);
  });

  const w = 220;
  const left = Math.max(4, Math.min(x, window.innerWidth - w - 8));
  const top = Math.max(4, Math.min(y, window.innerHeight - h - 8));

  return createPortal(
    <div
      className="ctx"
      ref={ref}
      style={{ left, top, width: w }}
      role="menu"
      onKeyDown={(e) => {
        // §26 KB-017: arrows rove the rows once focus is inside the menu —
        // Tab reaches them natively, and from there ↑/↓/Home/End walk,
        // ← backs out of a submenu. The global hotkey handler yields
        // arrows struck here (see bindHotkeys), so the canvas never nudges
        // underneath. Focus stays on the canvas while the menu is
        // mouse-driven, so Space still pans instead of firing a row.
        const rows = Array.from(
          e.currentTarget.querySelectorAll(".ctx-row:not([disabled]), .fly-sub button:not([disabled])"),
        ) as HTMLElement[];
        const at = rows.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          if (!rows.length) return;
          const to =
            e.key === "ArrowDown"
              ? rows[(at + 1 + rows.length) % rows.length]
              : rows[(at - 1 + rows.length) % rows.length];
          to.focus();
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          e.stopPropagation();
          if (!rows.length) return;
          (e.key === "Home" ? rows[0] : rows[rows.length - 1]).focus();
        } else if (e.key === "ArrowLeft" && (e.target as HTMLElement).closest?.(".fly-sub")) {
          e.preventDefault();
          e.stopPropagation();
          setOpenSub(null);
          ((e.target as HTMLElement).closest(".fly-sub")?.parentElement as HTMLElement | null)?.focus();
        }
      }}
    >
      {items.map((it, i) => {
        if (it.kind === "sep") return <hr key={i} />;
        if (it.kind === "sub") {
          return (
            <div
              key={i}
              className="ctx-row sub"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openSub === i}
              tabIndex={0}
              onMouseEnter={() => setOpenSub(i)}
              onMouseLeave={() => setOpenSub((n) => (n === i ? null : n))}
              // Click and the arrow keys open it too: hover alone left the submenu
              // unreachable with a keyboard, and a touch pointer has no hover.
              onClick={() => setOpenSub((n) => (n === i ? null : i))}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenSub(i);
                  // §26 KB-017: keyboard-opened, so land focus on the first
                  // item — arrows continue into the submenu, not past it.
                  const row = e.currentTarget;
                  window.setTimeout(() => {
                    (row.querySelector(".fly-sub button:not([disabled])") as HTMLElement | null)?.focus();
                  }, 0);
                }
                if (e.key === "ArrowLeft" || e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpenSub(null);
                }
              }}
            >
              {it.icon && <Icon name={it.icon} size={14} />}
              <span>{it.label}</span>
              <span className="sc">
                <Icon name="chevron-right" size={caretSize()} />
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

/** Canvas context menu rows: pick one layer out of the stack
 *  under the cursor, then the "everything that matches" commands. */
function selectItems(under: XNode[]): MenuItem[] {
  const out: MenuItem[] = [];
  if (under.length > 1) {
    out.push({
      kind: "sub",
      label: "Select layer",
      icon: "layers",
      items: under.map((n) => ({
        kind: "action" as const,
        id: `select-layer:${n.id}`,
        label: n.name || n.kind,
        icon: n.locked ? "lock" : kindIcon(n.kind, n.imageSrc),
        shortcut: n.locked ? "locked" : undefined,
      })),
    });
  }
  out.push({
    kind: "sub",
    label: "Select all with same",
    items: SAME_KINDS.map((k) => ({ kind: "action" as const, id: `select-same:${k.id}`, label: k.label })),
  });
  // §22 MN-001: the binding is ⌥⌘A (meta+alt+A); bare ⌥A never fired this
  // (⌥+letter is the align family), so the old "⌥A" label lied.
  out.push({ kind: "action", id: "selectMatching", label: "Select matching layers", shortcut: "⌥⌘A", icon: "rect" });
  out.push({ kind: "action", id: "selectInverse", label: "Select inverse", shortcut: "⇧⌘A" });
  out.push({ kind: "sep" });
  return out;
}

/** §22 MN-004: which context-menu rows can actually act on the current
 * selection. Figma greys out inapplicable rows instead of running silent
 * no-ops (with a misleading success toast, in our case); the call sites
 * compute these from the selected nodes and the menus default to enabled
 * so palette-style callers without a selection keep working. */
export type MenuCaps = {
  detach?: boolean;
  reset?: boolean;
  vectorize?: boolean;
  outline?: boolean;
};

export function canvasMenu(
  sel: number,
  isGroup: boolean,
  hasImage: boolean,
  under: XNode[] = [],
  hasLayout = false,
  caps: MenuCaps = {},
): MenuItem[] {
  if (sel === 0) {
    return [
      ...selectItems(under),
      { kind: "action", id: "paste", label: "Paste", shortcut: "⌘V", icon: "clipboard" },
      { kind: "action", id: "selectAll", label: "Select all", shortcut: "⌘A", icon: "rect" },
      { kind: "action", id: "placeImage", label: "Place image…", shortcut: "⇧⌘K", icon: "image" },
      // Right-clicking an empty canvas is the second way to get
      // to the UI-state commands, for people who never look at the menu bar.
      { kind: "sep" },
      { kind: "action", id: "minimizeUi", label: "Minimize UI", shortcut: "⇧⌘\\", icon: "minimize" },
      { kind: "action", id: "hideUi", label: "Hide UI", shortcut: "⌘\\", icon: "eye-off" },
    ];
  }
  const items: MenuItem[] = [
    ...selectItems(under),
    { kind: "action", id: "cut", label: "Cut", shortcut: "⌘X", icon: "scissors" },
    { kind: "action", id: "copy", label: "Copy", shortcut: "⌘C", icon: "copy" },
    { kind: "action", id: "copyProperties", label: "Copy properties", shortcut: "⌥⌘C", icon: "copy" },
    { kind: "action", id: "paste", label: "Paste", shortcut: "⌘V", icon: "clipboard" },
    { kind: "action", id: "pasteProperties", label: "Paste properties", shortcut: "⌥⌘V", icon: "clipboard" },
    {
      // Grouped under "Copy/paste as", and the language list is the
      // inspect panel's own, so the menu and the panel answer in one voice.
      kind: "sub",
      label: "Copy/paste as",
      icon: "code",
      items: [
        ...DEV_LANGS.map((l) => ({
          kind: "action" as const,
          id: `copyCode:${l.id}`,
          label: `Copy as ${l.label}`,
          shortcut: l.id === "css" ? "⌥⇧⌘C" : undefined,
          icon: "code" as IconName,
        })),
        { kind: "action" as const, id: "copyPng", label: "Copy as PNG", icon: "image" },
        { kind: "action" as const, id: "copyLink", label: "Copy link to selection", icon: "link" },
      ],
    },
    { kind: "action", id: "duplicate", label: "Duplicate", shortcut: "⌘D", icon: "copy" },
    { kind: "sep" },
  ];
  // §22 MN-003: grouping is a wrap (engine min-1, floating toolbar offers
  // it for any selection), so the menu does too — not just multi-select.
  items.push({ kind: "action", id: "group", label: "Group selection", shortcut: "⌘G", icon: "group" });
  if (isGroup) items.push({ kind: "action", id: "ungroup", label: "Ungroup", shortcut: "⇧⌘G", icon: "group" });
  items.push({ kind: "action", id: "wrapSection", label: "Wrap in new section", icon: "section" });
  items.push({ kind: "action", id: "makeComponent", label: "Create component", shortcut: "⌘⌥K", icon: "component" });
  items.push({ kind: "action", id: "detachInstance", label: "Detach instance", shortcut: "⌥⌘B", icon: "detach", enabled: caps.detach ?? true });
  items.push({ kind: "action", id: "resetOverrides", label: "Reset all overrides", icon: "reset", enabled: caps.reset ?? true });
  items.push({ kind: "action", id: "useAsMask", label: "Use as mask", shortcut: "⌃⌘M", icon: "mask" });
  items.push(...layoutMenuItems(hasLayout));
  items.push({ kind: "action", id: "flipH", label: "Flip horizontal", shortcut: "⇧H", icon: "flip-h" });
  items.push({ kind: "action", id: "flipV", label: "Flip vertical", shortcut: "⇧V", icon: "flip-v" });
  if (hasImage) {
    items.push({ kind: "action", id: "cropImage", label: "Crop image", icon: "image" });
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
        { kind: "action", id: "subtract", label: "Subtract selection", shortcut: "⌥⇧S" },
        { kind: "action", id: "intersect", label: "Intersect selection", shortcut: "⌥⇧I" },
        { kind: "action", id: "exclude", label: "Exclude selection", shortcut: "⌥⇧E" },
        { kind: "action", id: "flatten", label: "Flatten selection", shortcut: "⌘E" },
      ],
    });
  }
  items.push({ kind: "sep" });
  // §22 MN-002: multi-select already gets Flatten inside the Boolean submenu
  // above, so the standalone row is single-select only — no twin rows.
  if (sel < 2) items.push({ kind: "action", id: "flatten", label: "Flatten selection", shortcut: "⌘E" });
  items.push({ kind: "action", id: "outlineStroke", label: "Outline stroke", shortcut: "⇧⌘O", enabled: caps.outline ?? true });
  items.push({ kind: "action", id: "offsetPath", label: "Offset path…" });
  items.push({ kind: "action", id: "simplifyPath", label: "Simplify vector" });
  items.push({ kind: "action", id: "convertTextToVector", label: "Convert text to vector paths", enabled: caps.vectorize ?? true });
  items.push({ kind: "sep" });
  items.push({ kind: "action", id: "lockSel", label: "Lock/Unlock", shortcut: "⇧⌘L", icon: "lock" });
  items.push({ kind: "action", id: "hideSel", label: "Show/Hide", shortcut: "⇧⌘H", icon: "eye-off" });
  items.push({ kind: "action", id: "selectAll", label: "Select all", shortcut: "⌘A" });
  items.push({ kind: "action", id: "delete", label: "Delete", shortcut: "⌫", icon: "trash" });
  return items;
}

/**
 * The auto layout entries on a layer's context menu, from "Toggle on
 * auto layout in designs": Add auto layout (when there is none), Remove auto
 * layout (when there is), and - either way - More layout options ▸ Suggest auto
 * layout, Remove all auto layout.
 *
 * The article lists these under a frame's right-click menu, and the same items
 * make sense on a plain layer because that is where an auto
 * layout frame around them" happens.
 */
function layoutMenuItems(hasLayout: boolean): MenuItem[] {
  return [
    hasLayout
      ? { kind: "action", id: "removeAutoLayout", label: "Remove auto layout", shortcut: "⌥⇧A", icon: "layout-none" }
      : { kind: "action", id: "addAutoLayout", label: "Add auto layout", shortcut: "⇧A", icon: "layout" },
    {
      kind: "sub",
      label: "More layout options",
      items: [
        { kind: "action", id: "suggestAutoLayout", label: "Suggest auto layout", shortcut: "⌃⇧A" },
        { kind: "action", id: "removeAllAutoLayout", label: "Remove all auto layout" },
      ],
    },
  ];
}

export function layerMenu(isGroup: boolean, hasLayout = false, caps: MenuCaps = {}): MenuItem[] {
  return [
    { kind: "action", id: "rename", label: "Rename", shortcut: "⌘R", icon: "text" },
    { kind: "sep" },
    ...selectItems([]),
    { kind: "action", id: "cut", label: "Cut", shortcut: "⌘X", icon: "scissors" },
    { kind: "action", id: "copy", label: "Copy", shortcut: "⌘C", icon: "copy" },
    { kind: "action", id: "copyProperties", label: "Copy properties", shortcut: "⌥⌘C", icon: "copy" },
    { kind: "action", id: "paste", label: "Paste", shortcut: "⌘V", icon: "clipboard" },
    { kind: "action", id: "pasteProperties", label: "Paste properties", shortcut: "⌥⌘V", icon: "clipboard" },
    { kind: "action", id: "duplicate", label: "Duplicate", shortcut: "⌘D", icon: "copy" },
    { kind: "sep" },
    { kind: "action", id: "makeComponent", label: "Create component", shortcut: "⌘⌥K", icon: "component" },
    { kind: "action", id: "detachInstance", label: "Detach instance", shortcut: "⌥⌘B", icon: "detach", enabled: caps.detach ?? true },
    { kind: "action", id: "resetOverrides", label: "Reset all overrides", icon: "reset", enabled: caps.reset ?? true },
    { kind: "action", id: "useAsMask", label: "Use as mask", shortcut: "⌃⌘M", icon: "mask" },
    ...layoutMenuItems(hasLayout),
    { kind: "sep" },
    ...(isGroup
      ? [{ kind: "action" as const, id: "ungroup", label: "Ungroup", shortcut: "⇧⌘G", icon: "group" as IconName }]
      : [] as MenuItem[]),
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
  if (id.startsWith("copyCode:")) {
    const format = id.slice("copyCode:".length) as DevFormat;
    window.dispatchEvent(new CustomEvent("x-native-copy-code", { detail: { format } }));
    return;
  }
  if (id.startsWith("select-layer:")) {
    // The whole point of the submenu is reaching a layer the click order hides.
    engine.dispatch({ type: "select", ids: [id.slice("select-layer:".length)] });
    return;
  }
  if (id.startsWith("select-same:")) {
    const snapNow = engine.snapshot();
    selectSame(engine, snapNow, id.slice("select-same:".length) as never);
    return;
  }
  switch (id) {
    case "addAutoLayout":
      addAutoLayout(engine, engine.snapshot());
      break;
    case "removeAutoLayout":
      removeAutoLayout(engine, engine.snapshot());
      break;
    case "suggestAutoLayout":
      suggestAutoLayout(engine, engine.snapshot());
      break;
    case "removeAllAutoLayout":
      removeAllAutoLayout(engine, engine.snapshot());
      break;
    case "selectMatching":
      selectMatching(engine, engine.snapshot());
      break;
    case "selectInverse":
      selectInverse(engine, engine.snapshot());
      break;
    case "cut":
      engine.dispatch({ type: "cut" });
      break;
    case "copy": {
      const n = engine.snapshot().selection.length;
      engine.dispatch({ type: "copy" });
      if (n) toast(`Copied ${plural(n, "layer")}`);
      break;
    }
    case "paste":
      // A menu click gives the browser no keystroke to turn into a `paste`
      // event, so the canvas is asked to read the system clipboard through the
      // async API instead — the same ladder ⌘V rides, which is what lets a copy
      // from imported clipboard data land from the right-click menu too. That listener falls back
      // to the in-app clipboard when the read is refused, so the menu keeps
      // working with nothing but a local copy on it.
      window.dispatchEvent(
        new CustomEvent("x-native-paste", { detail: { x: extra?.x, y: extra?.y } }),
      );
      break;
    case "copyCode":
      // The result lands on the clipboard with no visible change on canvas, so
      // without a toast the command looks like it did nothing. The panel owns the
      // renderer, hence the event: same language and units as the snippet shown.
      window.dispatchEvent(new CustomEvent("x-native-copy-code", { detail: { format: null } }));
      break;
    case "copyPng":
      // The rasteriser lives beside the export code in the right panel, so the
      // menu asks for it over an event rather than duplicating the renderer.
      window.dispatchEvent(new CustomEvent("x-native-copy-png"));
      break;
    case "copyLink":
      window.dispatchEvent(new CustomEvent("x-native-copy-link"));
      break;
    case "copyProperties":
      engine.dispatch({ type: "copyProperties" });
      toast("Copied properties");
      break;
    case "pasteProperties":
      engine.dispatch({ type: "pasteProperties" });
      toast("Pasted properties");
      break;
    case "duplicate":
      engine.dispatch({ type: "duplicate" });
      break;
    case "delete": {
      const n = engine.snapshot().selection.length;
      engine.dispatch({ type: "delete" });
      if (n) toast(`Deleted ${plural(n, "layer")} · ⌘Z to undo`);
      break;
    }
    case "selectAll":
      engine.dispatch({ type: "selectAll" });
      break;
    // UI-state commands live in App (they are not document mutations), so the
    // menu asks for them the same way the Actions palette does.
    case "minimizeUi":
      window.dispatchEvent(new CustomEvent("x-native-minimize-ui"));
      break;
    case "hideUi":
      window.dispatchEvent(new CustomEvent("x-native-hide-ui"));
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
    case "resetOverrides":
      engine.dispatch({ type: "resetOverrides" });
      toast("Reset all instance overrides");
      break;
    case "resetOverrides:text":
      engine.dispatch({ type: "resetOverrides", property: "text" });
      toast("Reset text override");
      break;
    case "resetOverrides:fill":
      engine.dispatch({ type: "resetOverrides", property: "fill" });
      toast("Reset fill override");
      break;
    case "resetOverrides:size":
      engine.dispatch({ type: "resetOverrides", property: "w" });
      engine.dispatch({ type: "resetOverrides", property: "h" });
      toast("Reset size override");
      break;
    case "flatten":
      engine.dispatch({ type: "flatten" });
      break;
    case "outlineStroke":
      engine.dispatch({ type: "outlineStroke" });
      break;
    case "offsetPath": {
      const distStr = window.prompt("Offset vector path distance (+ to expand, - to contract):", "8");
      if (distStr !== null) {
        const d = parseFloat(distStr);
        if (!isNaN(d) && d !== 0) {
          engine.dispatch({ type: "offsetPath", distance: d });
          toast(`Offset vector path ${d > 0 ? "+" : ""}${d}px`);
        }
      }
      break;
    }
    case "simplifyPath":
      engine.dispatch({ type: "simplifyPath" });
      toast("Simplified vector path");
      break;
    case "convertTextToVector":
      engine.dispatch({ type: "convertTextToVector" });
      toast("Converted text to vector paths");
      break;
    case "cropImage": {
      // The canvas owns the crop tool (overlay, handles, Esc semantics); the
      // menu just rings the bell with the first selected layer.
      const id0 = engine.snapshot().selection[0];
      if (id0) window.dispatchEvent(new CustomEvent("x-native-crop-image", { detail: { id: id0 } }));
      break;
    }
    case "placeImage": {
      window.dispatchEvent(new CustomEvent("x-native-place-image"));
      break;
    }
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
  // §22 MN-005: a boolean with members unwraps like a group (engine ungroup
  // takes any node with children; Figma's boolean article says to Ungroup it),
  // so it gets the Ungroup row too. Childless booleans stay excluded.
  return !!n && (n.kind === "group" || (n.kind === "frame" && n.name === "Group") || (n.kind === "boolean" && n.children.length > 0));
}
