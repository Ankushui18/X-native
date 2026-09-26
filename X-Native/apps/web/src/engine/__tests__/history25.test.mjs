/**
 * Headless checks for §25 (undo / redo): no-op gestures keep the redo chain,
 * guard-refused commands neither pollute the stack nor eat redo, burst
 * context never leaks across gestures or undo/redo, view and present state
 * stays out of history, nested gestures are one step, and stray ends are
 * harmless.
 *
 * Run with:  npx vite-node src/engine/__tests__/history25.test.mjs
 *
 * Step counts are read by undoing to exhaustion: `MemoryEngine(false)`
 * starts empty, every flow below runs on a fresh engine, and bursts are
 * broken with `select` (a non-history command) so no test depends on the
 * 600ms coalesce window elapsing in real time.
 */
import { MemoryEngine, find } from "../memory.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

const addRect = (e, x = 0) => {
  e.dispatch({ type: "add", kind: "rect", x, y: 0, w: 100, h: 100 });
  return e.snapshot().selection[0];
};
/** Steps on the undo stack, counted destructively. */
const undoDepth = (e) => {
  let d = 0;
  while (e.snapshot().canUndo) {
    e.dispatch({ type: "undo" });
    d++;
  }
  return d;
};
const at = (e, id) => {
  const n = find(e.snapshot().pages[0].root, id);
  return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null;
};

{
  console.log("refused commands: no entry, no redo harm, no borrowed burst");
  const e = new MemoryEngine(false);
  e.dispatch({ type: "select", ids: [] });
  e.dispatch({ type: "delete" });
  t("delete with no selection pushes nothing", !e.snapshot().canUndo);
  e.dispatch({ type: "paste" });
  t("paste with an empty clipboard pushes nothing", !e.snapshot().canUndo);
  e.dispatch({ type: "patch", id: "missing", patch: { x: 5 } });
  t("a patch to a missing layer pushes nothing", !e.snapshot().canUndo);

  const r = new MemoryEngine(false);
  const id = addRect(r);
  r.dispatch({ type: "undo" });
  t("undo arms redo", r.snapshot().canRedo);
  r.dispatch({ type: "select", ids: [] });
  r.dispatch({ type: "delete" });
  t("a refused command keeps redo", r.snapshot().canRedo && !r.snapshot().canUndo);

  // A no-op resize must not lend its burst identity to the next real one:
  // both share the `resize` coalesce key with no select between them.
  const z = new MemoryEngine(false);
  const zid = addRect(z);
  const box0 = at(z, zid);
  z.dispatch({ type: "resize", id: zid, ...box0 });
  z.dispatch({ type: "resize", id: zid, ...box0, w: 140 });
  t("a refused resize still leaves the real one undoable", undoDepth(z) === 2);
}

{
  console.log("gestures: one step, and abandoned ones keep redo");
  const e = new MemoryEngine(false);
  const id = addRect(e);
  e.dispatch({ type: "begin" });
  e.dispatch({ type: "move", ids: [id], dx: 10, dy: 0 });
  e.dispatch({ type: "move", ids: [id], dx: 10, dy: 0 });
  e.dispatch({ type: "end" });
  t("a drag is one step", undoDepth(e) === 2);
  t("undoing the drag restores the start", (() => {
    const g = new MemoryEngine(false);
    const gid = addRect(g);
    g.dispatch({ type: "begin" });
    g.dispatch({ type: "move", ids: [gid], dx: 30, dy: 0 });
    g.dispatch({ type: "end" });
    g.dispatch({ type: "undo" });
    return at(g, gid).x === 0;
  })());

  const r = new MemoryEngine(false);
  addRect(r);
  r.dispatch({ type: "undo" });
  r.dispatch({ type: "begin" });
  r.dispatch({ type: "end" });
  t("a click that never moves keeps redo", r.snapshot().canRedo && !r.snapshot().canUndo);

  const c = new MemoryEngine(false);
  const cid = addRect(c);
  c.dispatch({ type: "undo" });
  c.dispatch({ type: "begin" });
  c.dispatch({ type: "move", ids: [cid], dx: 5, dy: 0 });
  c.dispatch({ type: "end" });
  t("a real gesture still branches redo", !c.snapshot().canRedo && c.snapshot().canUndo);
}

{
  console.log("bursts break at gestures, undo/redo and selection");
  const e = new MemoryEngine(false);
  const id = addRect(e);
  e.dispatch({ type: "nudge", dx: 1, dy: 0 });
  e.dispatch({ type: "nudge", dx: 1, dy: 0 });
  e.dispatch({ type: "nudge", dx: 1, dy: 0 });
  t("a nudge burst is one step", undoDepth(e) === 2);

  const g = new MemoryEngine(false);
  const gid = addRect(g);
  g.dispatch({ type: "nudge", dx: 1, dy: 0 });
  g.dispatch({ type: "begin" });
  g.dispatch({ type: "move", ids: [gid], dx: 5, dy: 0 });
  g.dispatch({ type: "end" });
  g.dispatch({ type: "nudge", dx: 1, dy: 0 });
  t("a gesture breaks the burst", undoDepth(g) === 4);

  const u = new MemoryEngine(false);
  addRect(u);
  u.dispatch({ type: "nudge", dx: 1, dy: 0 });
  u.dispatch({ type: "undo" });
  u.dispatch({ type: "nudge", dx: 1, dy: 0 });
  t("an edit after undo is its own step", undoDepth(u) === 2);
  const u2 = new MemoryEngine(false);
  addRect(u2);
  u2.dispatch({ type: "nudge", dx: 1, dy: 0 });
  u2.dispatch({ type: "undo" });
  u2.dispatch({ type: "nudge", dx: 1, dy: 0 });
  t("and it branches redo", !u2.snapshot().canRedo);
  const s = new MemoryEngine(false);
  addRect(s);
  s.dispatch({ type: "nudge", dx: 1, dy: 0 });
  s.dispatch({ type: "select", ids: [] });
  s.dispatch({ type: "select", ids: s.snapshot().pages[0].root.children.map((c) => c.id) });
  s.dispatch({ type: "nudge", dx: 1, dy: 0 });
  t("selection breaks the burst", undoDepth(s) === 3);
}

{
  console.log("nesting, stray ends and compromised gestures");
  const e = new MemoryEngine(false);
  const id = addRect(e);
  e.dispatch({ type: "begin" });
  e.dispatch({ type: "move", ids: [id], dx: 5, dy: 0 });
  e.dispatch({ type: "begin" });
  e.dispatch({ type: "move", ids: [id], dx: 5, dy: 0 });
  e.dispatch({ type: "end" });
  e.dispatch({ type: "move", ids: [id], dx: 5, dy: 0 });
  e.dispatch({ type: "end" });
  t("a nested gesture is one step", undoDepth(e) === 2);

  const n = new MemoryEngine(false);
  const nid = addRect(n);
  n.dispatch({ type: "begin" });
  n.dispatch({ type: "begin" });
  n.dispatch({ type: "end" });
  n.dispatch({ type: "end" });
  const npos = at(n, nid);
  t("a nested no-op gesture leaves nothing", undoDepth(n) === 1 && !!npos && npos.x === 0);

  const r = new MemoryEngine(false);
  addRect(r);
  const kids = r.snapshot().pages[0].root.children.length;
  r.dispatch({ type: "undo" });
  r.dispatch({ type: "end" });
  t("a stray end keeps the redo chain", r.snapshot().canRedo);
  r.dispatch({ type: "redo" });
  t("and the redo still applies", r.snapshot().pages[0].root.children.length === kids);

  const m = new MemoryEngine(false);
  const mid = addRect(m);
  m.dispatch({ type: "begin" });
  m.dispatch({ type: "move", ids: [mid], dx: 9, dy: 0 });
  m.dispatch({ type: "undo" });
  m.dispatch({ type: "end" });
  t("an undo mid-gesture leaves both stacks alone", m.snapshot().canUndo && m.snapshot().canRedo);
}

{
  console.log("view and present state stays out of history");
  const e = new MemoryEngine(false);
  addRect(e);
  e.dispatch({ type: "toggleOutlines" });
  t("outline mode costs no step", undoDepth(e) === 1);

  const o = new MemoryEngine(false);
  addRect(o);
  o.dispatch({ type: "openOverlay", id: "x" });
  o.dispatch({ type: "closeOverlay" });
  t("present overlays cost no steps", undoDepth(o) === 1);

  const p = new MemoryEngine(false);
  addRect(p);
  p.dispatch({ type: "setPrototypeDevice", device: "ipad-pro" });
  p.dispatch({ type: "setPrototypeOrientation", orientation: "landscape" });
  p.dispatch({ type: "togglePrototypeHotspots" });
  p.dispatch({ type: "togglePrototypeLiveInputs" });
  p.dispatch({ type: "togglePrototypeSound" });
  t("present viewer options cost no steps", undoDepth(p) === 1);
}

{
  console.log("the stack caps at 200 entries");
  const e = new MemoryEngine(false);
  const id = addRect(e);
  for (let i = 0; i < 205; i++) {
    e.dispatch({ type: "select", ids: [id] });
    e.dispatch({ type: "patch", id, patch: { x: 1000 + i } });
  }
  t("205 edits keep 200 steps", undoDepth(e) === 200);
}
