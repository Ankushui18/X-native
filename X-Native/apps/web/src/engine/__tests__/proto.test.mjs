/**
 * Headless checks for §23: present navigation/history against the Figma
 * play-your-prototypes evidence — Back at the root stays put (PT-001),
 * Navigate resolves to top-level frames (PT-002), trigger bubbling is
 * innermost-wins with all rows running (multi-action), and hotspot hints
 * default off (PT-008).
 *
 * The runner, panel, player, and hotkey fixes (PT-003–PT-007, PT-009–PT-019)
 * are React-side and verified by code tracing; see the §23 ledger.
 *
 * Run with:  npx vite-node src/engine/__tests__/proto.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import { triggerInteractions } from "../protoEval.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const rootOf = (e) => snapOf(e).pages[snapOf(e).page].root;
const framesOf = (e) => rootOf(e).children.filter((n) => n.kind === "frame");
const lastChildId = (n) => n.children[n.children.length - 1].id;
const add = (e, kind, parent) => {
  e.dispatch({ type: "add", kind, x: 0, y: 0, w: 100, h: 100, parent });
  return lastChildId(parent ? find(rootOf(e), parent) : rootOf(e));
};
const ix = (trigger, action, destination) => ({ trigger, action, destination, animation: "instant", delay: 0 });

// PT-001: Back at the history root stays on the frame (Figma) instead of
// clearing presentFrame (which dropped out of present mode).
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "presentStart" });
  const start = snapOf(e).presentFrame;
  t("PT-001 present starts on a frame", !!start && snapOf(e).presentStack.length === 1);
  e.dispatch({ type: "presentBack" });
  t("PT-001 back at root keeps the frame", snapOf(e).presentFrame === start);
  t("PT-001 back at root keeps a one-deep stack", snapOf(e).presentStack.length === 1);
}

// PT-001 regression: Back with history still pops.
{
  const e = new MemoryEngine(false);
  const [a, b] = framesOf(e);
  e.dispatch({ type: "presentStart", id: a.id });
  e.dispatch({ type: "presentGo", id: b.id });
  e.dispatch({ type: "presentBack" });
  t("PT-001 back with history pops to the start", snapOf(e).presentFrame === a.id && snapOf(e).presentStack.length === 1);
}

// PT-002: Navigate lands on top-level frames (Figma).
{
  const e = new MemoryEngine(false);
  const [a] = framesOf(e);
  const nestedRect = add(e, "rect", a.id);
  e.dispatch({ type: "presentStart", id: a.id });
  e.dispatch({ type: "presentGo", id: nestedRect });
  t("PT-002 nested-layer destination resolves to its top frame", snapOf(e).presentFrame === a.id);
}
{
  const e = new MemoryEngine(false);
  const [, b] = framesOf(e);
  e.dispatch({ type: "presentStart" });
  e.dispatch({ type: "presentGo", id: b.id });
  t("PT-002 top-frame destination passes through", snapOf(e).presentFrame === b.id);
}
{
  // Root-level group with frame children: group rule picks the child frame,
  // and the climb keeps it (already top-level).
  const e = new MemoryEngine(false);
  const [a, b] = framesOf(e);
  e.dispatch({ type: "select", ids: [a.id, b.id] });
  e.dispatch({ type: "group" });
  const g = rootOf(e).children.find((n) => n.kind === "group");
  e.dispatch({ type: "presentStart", id: a.id });
  e.dispatch({ type: "presentGo", id: g.id });
  t("PT-002 group destination still resolves into a frame", snapOf(e).presentFrame === a.id || snapOf(e).presentFrame === b.id);
}

// Trigger collection: innermost node wins, ALL its rows run (X's multi-action
// story: one row per action sharing a trigger), misses bubble, else null.
{
  const e = new MemoryEngine(false);
  const [a] = framesOf(e);
  const parent = add(e, "rect", a.id);
  const child = add(e, "rect", parent);
  e.dispatch({ type: "setInteractions", id: parent, interactions: [ix("onClick", "back", "")] });
  e.dispatch({ type: "setInteractions", id: child, interactions: [ix("onClick", "navigate", a.id), ix("onClick", "setVariable", "")] });
  const hit = triggerInteractions(rootOf(e), child, "onClick");
  t("PT-bubble innermost node wins", hit?.nodeId === child);
  t("PT-bubble all same-trigger rows run", hit?.list.length === 2);
  const bubbled = triggerInteractions(rootOf(e), child, "mouseEnter");
  t("PT-bubble nothing matches anywhere yields null", bubbled === null);
  e.dispatch({ type: "setInteractions", id: parent, interactions: [ix("mouseEnter", "back", "")] });
  const up = triggerInteractions(rootOf(e), child, "mouseEnter");
  t("PT-bubble misses rise to the ancestor", up?.nodeId === parent);
}

// presentStart still prefers the page's flow starting point.
{
  const e = new MemoryEngine(false);
  const fs = framesOf(e);
  e.dispatch({ type: "patchPage", patch: { flowStart: fs[2].id } });
  e.dispatch({ type: "presentStart" });
  t("PT-start flowStart wins the default", snapOf(e).presentFrame === fs[2].id);
}

// PT-008: hotspot hints default off (flash on missed clicks instead).
{
  const e = new MemoryEngine(false);
  t("PT-008 hotspot hints default off", snapOf(e).prototypeHotspots === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
