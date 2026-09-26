/**
 * Headless checks for §22: context-menu rows against their real bindings and
 * guards — shortcut-label honesty (MN-001), no twin Flatten rows (MN-002),
 * Group offered for a lone layer (MN-003), inapplicable rows greyed out via
 * MenuCaps (MN-004), and Ungroup offered for boolean groups (MN-005).
 *
 * The palette sc-label fixes (MN-006/007/008) and the React menu mechanics
 * (hover-intent submenus, positioning, dismissal) are verified by code
 * tracing; see the §22 ledger.
 *
 * Run with:  npx vite-node src/engine/__tests__/menu.test.mjs
 */
import { canvasMenu, layerMenu, isGroupNode } from "../../ui/ContextMenu.tsx";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

// Flatten a menu tree (top level + one submenu level) into id -> item.
const flat = (items) => {
  const out = new Map();
  for (const it of items) {
    if (it.kind === "action") { if (!out.has(it.id)) out.set(it.id, it); }
    else if (it.kind === "sub") for (const s of it.items) { if (s.kind === "action" && !out.has(s.id)) out.set(s.id, s); }
  }
  return out;
};
const flattens = (items) => {
  let n = 0;
  for (const it of items) {
    if (it.kind === "action" && it.id === "flatten") n++;
    else if (it.kind === "sub") for (const s of it.items) if (s.kind === "action" && s.id === "flatten") n++;
  }
  return n;
};
const sub = (items, label) => items.find((it) => it.kind === "sub" && it.label === label);

// MN-001: the binding is ⌥⌘A, on both the empty- and selection-canvas menus.
t("MN-001 empty-canvas select-matching labelled ⌥⌘A", flat(canvasMenu(0, false, false)).get("selectMatching")?.shortcut === "⌥⌘A");
t("MN-001 selection select-matching labelled ⌥⌘A", flat(canvasMenu(1, false, false)).get("selectMatching")?.shortcut === "⌥⌘A");

// MN-002: exactly one Flatten row for multi-select (inside Boolean); the
// standalone row survives only for a lone selection.
t("MN-002 multi-select has exactly one Flatten", flattens(canvasMenu(2, false, false)) === 1);
t("MN-002 multi-select Flatten lives in the Boolean submenu",
  (sub(canvasMenu(2, false, false), "Boolean")?.items ?? []).some((r) => r.kind === "action" && r.id === "flatten"));
t("MN-002 single-select keeps the standalone Flatten, no Boolean submenu",
  canvasMenu(1, false, false).some((r) => r.kind === "action" && r.id === "flatten") &&
  !sub(canvasMenu(1, false, false), "Boolean"));

// MN-003: Group is a wrap, offered for a lone layer too.
t("MN-003 single-select offers Group selection ⌘G",
  flat(canvasMenu(1, false, false)).get("group")?.shortcut === "⌘G");

// MN-004: caps grey out rows that would silently no-op; default is enabled.
{
  const m = flat(canvasMenu(1, false, false, [], false, { detach: false, reset: false, vectorize: false, outline: false }));
  t("MN-004 canvas caps disable detach/reset/vectorize/outline",
    m.get("detachInstance")?.enabled === false && m.get("resetOverrides")?.enabled === false &&
    m.get("convertTextToVector")?.enabled === false && m.get("outlineStroke")?.enabled === false);
  const d = flat(canvasMenu(1, false, false));
  t("MN-004 canvas defaults leave those rows enabled",
    d.get("detachInstance")?.enabled !== false && d.get("resetOverrides")?.enabled !== false &&
    d.get("convertTextToVector")?.enabled !== false && d.get("outlineStroke")?.enabled !== false);
  const l = flat(layerMenu(false, false, { detach: false, reset: false }));
  t("MN-004 layer caps disable detach/reset",
    l.get("detachInstance")?.enabled === false && l.get("resetOverrides")?.enabled === false);
}

// MN-005: boolean groups get Ungroup; childless booleans and plain layers don't.
t("MN-005 boolean with children is group-like", isGroupNode({ kind: "boolean", children: [{ kind: "rect", children: [] }] }));
t("MN-005 childless boolean is not group-like", !isGroupNode({ kind: "boolean", children: [] }));
t("MN-005 group/frame-Group still group-like, rect/null not",
  isGroupNode({ kind: "group", children: [] }) && isGroupNode({ kind: "frame", name: "Group", children: [] }) &&
  !isGroupNode({ kind: "rect", children: [] }) && !isGroupNode(null));
t("MN-005 boolean Ungroup row appears on the canvas menu",
  flat(canvasMenu(1, true, false)).get("ungroup")?.shortcut === "⇧⌘G");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
