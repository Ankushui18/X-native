/** Run 22: vector cut tool (audit P1 #10) — the seven interaction categories,
 *  end to end, on the mounted canvas.
 *
 *  AUDIT (what existed before this run):
 *  · `vecSubTool` had no "cut" member — the audit already recorded Cut (X) as
 *    an ABSENT tool ("`vecSubTool` eraser/lasso union members are dead
 *    type-only values"), and bare X was unbound (⇧X swaps fill/stroke, ⌘X is
 *    the clipboard cut). The vector-edit toolbar carried Select/Pen/Bend/
 *    Paint/Shape Builder plus Simplify/Clean up, and clicking a segment in
 *    select-subtool only INSERTED a point — nothing ever split a path.
 *  · What this run added: the "cut" subtool (toolbar button + bare X), the
 *    split-at-point / split-on-segment click cuts, the drag-across cut that
 *    severs every crossed segment and promotes the freed runs to their own
 *    layers, the dashed blade preview, one-begin/end undo steps, and an
 *    Escape that leaves cut mode before it leaves point edit.
 *  · The geometry helpers (`splitPathAtPoint`, `cutPathWithLine`) live with
 *    the rest of the vector network maths in engine/geometry.ts, next to
 *    `insertPointOnPath` and `pathToVectorNetwork`; the cuts re-enter the
 *    document through `patchPath` / `addPath`, which rebuild the node's
 *    VectorNetwork the same way every other path edit does.
 *
 *  jsdom + recorded paints: interaction wiring and paint-call geometry, not
 *  browser pixels.
 *
 *  Run with:  npx vite-node src/ui/__tests__/vectorCutTool.test.mjs
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, find, node } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });

// ═══════════════════════════ mounted canvas ═══════════════════════════
const window = installDom();
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;

let paints = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy(
    {
      canvas: this,
      measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
      getLineDash: () => [],
    },
    {
      get: (target, key) => (key in target ? target[key] : (...args) => paints.push([key, ...args])),
    },
  );
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830,
});

const LEFT = 50, TOP = 30;

async function mount(children, selection = [], view = {}) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "p", name: "Page", root: page(...children), guides: [], comments: [] }],
    page: 0, zoom: 1, panX: 0, panY: 0, ...view,
  });
  engine.dispatch({ type: "select", ids: selection });
  const dispatches = [];
  const origDispatch = engine.dispatch.bind(engine);
  engine.dispatch = (cmd) => { dispatches.push(cmd); return origDispatch(cmd); };
  function Host() {
    const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap }));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  paints = [];
  await act(async () => reactRoot.render(React.createElement(Host)));
  const surface = host.querySelector(".canvas-wrap");
  const ui = {
    engine, host, surface, dispatches,
    node: (id) => find(engine.snapshot().pages[0].root, id),
    one: (sel) => host.querySelector(sel),
    marker: () => paints.length,
    tail: (m) => paints.slice(m),
    async mouse(type, x, y, extra = {}) {
      await act(async () =>
        surface.dispatchEvent(new window.MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: x + LEFT, clientY: y + TOP, button: 0, ...extra,
        })));
    },
    async drag(x0, y0, x1, y1, extra = {}) {
      await ui.mouse("mousedown", x0, y0, extra);
      await ui.mouse("mousemove", (x0 + x1) / 2, (y0 + y1) / 2, extra);
      await ui.mouse("mousemove", x1, y1, extra);
      await ui.mouse("mouseup", x1, y1, extra);
    },
    async key(k, extra = {}) {
      await act(async () =>
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })));
    },
    async dispatch(cmd) { await act(async () => engine.dispatch(cmd)); },
    async close() { await act(async () => reactRoot.unmount()); host.remove(); },
  };
  return ui;
}

const lines = (tail) => {
  let out = [];
  for (let i = 0; i < tail.length - 1; i++) {
    if (tail[i][0] === "moveTo" && tail[i + 1][0] === "lineTo") out.push([tail[i][1], tail[i][2], tail[i + 1][1], tail[i + 1][2]]);
  }
  return out;
};
const vecs = (ui) => ui.engine.snapshot().pages[0].root.children.filter((c) => c.kind === "vector");
const xy = (n) => JSON.stringify(n.path.map((p) => [p.x, p.y]));
const cutBtn = (ui) => ui.one('.vector-edit-toolbar button[title="Cut tool (X)"]');
const cutOn = (ui) => {
  const b = cutBtn(ui);
  return !!b && b.className.includes("on");
};

/** A fresh open path in point edit, with cut mode engaged via X. */
async function cutFixture(worldPts) {
  const ui = await mount([], []);
  await ui.dispatch({ type: "addPath", points: worldPts.map(([x, y]) => ({ x, y })), closed: false });
  const id = ui.engine.snapshot().selection[0];
  await ui.key("Enter");
  if (ui.engine.snapshot().vecEdit !== id) throw new Error("fixture: Enter did not enter vector edit");
  await ui.key("x");
  if (!cutOn(ui)) throw new Error("fixture: X did not arm cut mode");
  return { ui, id };
}

// ─────────────────────── 1 · tool activation ───────────────────────
console.log("1 · activation: toolbar button and the X shortcut");
{
  const { ui, id } = await cutFixture([[100, 100], [200, 100], [300, 200]]);
  t("1-activation: point edit opens the vector edit toolbar", !!ui.one(".vector-edit-toolbar"));
  t("1-activation: the Cut button sits in the toolbar", !!cutBtn(ui));
  // cutFixture armed it with X — verify both directions, then the button.
  t("1-activation: pressing X enters cut mode", cutOn(ui));
  await ui.key("x");
  t("1-activation: pressing X again exits cut mode", !cutOn(ui));
  await act(async () => cutBtn(ui).click());
  t("1-activation: the toolbar button enters cut mode", cutOn(ui));
  t("1-activation: the edited path is still in point edit", ui.engine.snapshot().vecEdit === id);
  await ui.close();
}

// ─────────────────────── 2 · split at point ───────────────────────
console.log("2 · split at point: click a vector point → two paths");
{
  const { ui, id } = await cutFixture([[100, 100], [200, 100], [200, 200], [300, 200]]);
  const before = ui.node(id);
  const baseline = xy(before);
  const box0 = [before.x, before.y, before.w, before.h];
  // Click the third anchor, world (200,200).
  await ui.mouse("mousedown", 200, 200);
  await ui.mouse("mouseup", 200, 200);
  const vs = vecs(ui);
  t("2-point: clicking a vector point splits the path into two layers", vs.length === 2,
    JSON.stringify(vs.map((v) => v.path.length)));
  const orig = ui.node(id);
  const spawned = vs.find((v) => v.id !== id);
  t("2-point: the original keeps the run up to the clicked point",
    xy(orig) === JSON.stringify([[0, 0], [100, 0], [100, 100]]), xy(orig));
  t("2-point: the far side becomes its own layer, starting at the clicked anchor",
    !!spawned && spawned.x === 200 && spawned.y === 200 && xy(spawned) === JSON.stringify([[0, 0], [100, 0]]),
    spawned ? `${spawned.x},${spawned.y} ${xy(spawned)}` : "no layer");
  t("2-point: the layer box never moves", box0.join() === [orig.x, orig.y, orig.w, orig.h].join());
  await ui.dispatch({ type: "undo" });
  t("2-point: one undo restores the uncut path", vecs(ui).length === 1 && xy(ui.node(id)) === baseline);
  await ui.close();
}

// ─────────────────────── 3 · split on segment ───────────────────────
console.log("3 · split on segment: click the path → insert a point, then split");
{
  const { ui, id } = await cutFixture([[100, 100], [200, 100], [200, 200], [300, 200]]);
  const baseline = xy(ui.node(id));
  // Click mid-segment A→B at world (150,100): no anchor there yet.
  await ui.mouse("mousedown", 150, 100);
  await ui.mouse("mouseup", 150, 100);
  const vs = vecs(ui);
  t("3-segment: clicking a segment inserts a point and splits there", vs.length === 2,
    JSON.stringify(vs.map((v) => v.path.length)));
  const orig = ui.node(id);
  const spawned = vs.find((v) => v.id !== id);
  t("3-segment: the new anchor sits exactly on the click",
    orig.path.length === 2 && near(orig.path[1].x, 50) && near(orig.path[1].y, 0),
    xy(orig));
  t("3-segment: the original now runs A → new point",
    xy(orig) === JSON.stringify([[0, 0], [50, 0]]), xy(orig));
  t("3-segment: the rest hangs off the same new point in a new layer",
    !!spawned && spawned.x === 150 && spawned.y === 100 &&
      xy(spawned) === JSON.stringify([[0, 0], [50, 0], [50, 100], [150, 100]]),
    spawned ? `${spawned.x},${spawned.y} ${xy(spawned)}` : "no layer");
  await ui.dispatch({ type: "undo" });
  t("3-segment: one undo restores the uncut path", vecs(ui).length === 1 && xy(ui.node(id)) === baseline);
  await ui.close();
}

// ─────────────────────── 4 · drag to separate ───────────────────────
console.log("4 · drag to separate: the blade severs every segment it crosses");
{
  const { ui, id } = await cutFixture([[100, 80], [200, 180], [300, 80], [400, 80]]);
  const before = ui.node(id);
  const baseline = xy(before);
  const box0 = [before.x, before.y, before.w, before.h];
  // The drag runs along y=130 from x=150 (on segment A→B) to x=250 (on
  // segment B→C): crossings at (150,130) and (250,130).
  await ui.drag(150, 130, 250, 130);
  const vs = vecs(ui);
  t("4-drag: two crossings cut the path into three objects", vs.length === 3,
    JSON.stringify(vs.map((v) => v.path.length)));
  const orig = ui.node(id);
  const mid = vs.find((v) => v.x === 150 && v.y === 130);
  const tail = vs.find((v) => v.x === 250 && v.y === 80);
  t("4-drag: the original keeps only the head, ending on the first crossing",
    xy(orig) === JSON.stringify([[0, 0], [50, 50]]), xy(orig));
  t("4-drag: the crossings land exactly where the blade crossed",
    orig.path.length === 2 && near(orig.path[1].x, 50) && near(orig.path[1].y, 50),
    xy(orig));
  t("4-drag: the dragged portion becomes its own layer (head → apex → exit)",
    !!mid && xy(mid) === JSON.stringify([[0, 0], [50, 50], [100, 0]]),
    mid ? xy(mid) : "no middle layer");
  t("4-drag: the tail past the second crossing is a third layer",
    !!tail && xy(tail) === JSON.stringify([[0, 50], [50, 0], [150, 0]]),
    tail ? xy(tail) : "no tail layer");
  t("4-drag: severed layers carry their world anchor", !!mid && !!tail &&
    mid.x + mid.path[1].x === 200 && mid.y + mid.path[1].y === 180 &&
    tail.x + tail.path[1].x === 300 && tail.y + tail.path[1].y === 80);
  t("4-drag: the original layer box is untouched", box0.join() === [orig.x, orig.y, orig.w, orig.h].join());
  await ui.dispatch({ type: "undo" });
  t("4-drag: one undo reverts the whole cut", vecs(ui).length === 1 && xy(ui.node(id)) === baseline);
  await ui.close();
}

// ─────────────────────── 5 · preview line ───────────────────────
console.log("5 · preview: a dashed blade line tracks the drag");
{
  const { ui, id } = await cutFixture([[100, 80], [200, 180], [300, 80], [400, 80]]);
  const m0 = ui.marker();
  await ui.mouse("mousedown", 150, 130);
  await ui.mouse("mousemove", 200, 130);
  const mid1 = ui.tail(m0);
  t("5-preview: a line from the press follows the pointer mid-drag",
    lines(mid1).some(([x0, y0, x1, y1]) => near(x0, 150) && near(y0, 130) && near(x1, 200) && near(y1, 130)),
    JSON.stringify(lines(mid1).slice(-3)));
  t("5-preview: the blade line is dashed",
    mid1.some(([c, dash]) => c === "setLineDash" && Array.isArray(dash) && dash[0] === 6 && dash[1] === 4));
  await ui.mouse("mousemove", 250, 130);
  const m1 = ui.marker();
  await ui.mouse("mouseup", 250, 130);
  const after = ui.tail(m1);
  t("5-preview: the preview disappears once the cut lands",
    !lines(after).some(([x0, y0, x1, y1]) => near(x0, 150) && near(y0, 130) && near(x1, 250) && near(y1, 130)),
    JSON.stringify(lines(after).slice(-3)));
  t("5-preview: the cut still happened", vecs(ui).length === 3);
  await ui.close();
}

// ─────────────────────── 6 · undo integration ───────────────────────
console.log("6 · undo: every cut operation is one step");
{
  const { ui, id } = await cutFixture([[100, 100], [200, 100], [200, 200], [300, 200]]);
  const baseline = xy(ui.node(id));
  // Op 1 — click split.
  await ui.mouse("mousedown", 200, 200);
  await ui.mouse("mouseup", 200, 200);
  const afterClick = vecs(ui).map((v) => [v.x, v.y, xy(v)]);
  t("6-undo: the click-split produced its two pieces", vecs(ui).length === 2);
  await ui.dispatch({ type: "undo" });
  t("6-undo: a single undo reverts the click-split entirely", vecs(ui).length === 1 && xy(ui.node(id)) === baseline,
    JSON.stringify(vecs(ui).length));
  await ui.dispatch({ type: "redo" });
  t("6-undo: redo restores the split in one step",
    vecs(ui).length === 2 && JSON.stringify(vecs(ui).map((v) => [v.x, v.y, xy(v)])) === JSON.stringify(afterClick));
  await ui.dispatch({ type: "undo" });
  // Op 2 — drag cut (one crossing on this path → two pieces).
  await ui.drag(150, 130, 250, 130);
  t("6-undo: the drag-cut produced its pieces", vecs(ui).length === 2,
    JSON.stringify(vecs(ui).map((v) => v.path.length)));
  await ui.dispatch({ type: "undo" });
  t("6-undo: a single undo reverts the entire drag-cut", vecs(ui).length === 1 && xy(ui.node(id)) === baseline);
  await ui.close();
}

// ─────────────────────── 7 · mode exit ───────────────────────
console.log("7 · exit: Escape and other tools leave cut mode");
{
  const { ui, id } = await cutFixture([[100, 100], [200, 100], [300, 200]]);
  t("7-exit: the fixture starts in cut mode", cutOn(ui));
  await ui.key("Escape");
  t("7-exit: the first Escape leaves cut mode", !cutOn(ui));
  t("7-exit: but the path stays in point edit",
    ui.engine.snapshot().vecEdit === id && !!ui.one(".vector-edit-toolbar"));
  await ui.key("x");
  t("7-exit: X re-arms cut mode", cutOn(ui));
  const selBtn = ui.one('.vector-edit-toolbar button[title="Move / Select (V)"]');
  await act(async () => selBtn.click());
  t("7-exit: clicking another tool exits cut mode", !cutOn(ui));
  await ui.key("x");
  await ui.key("Escape"); // leave cut mode
  await ui.key("Escape"); // leave point edit
  t("7-exit: the next Escape leaves point edit",
    ui.engine.snapshot().vecEdit === null && !ui.one(".vector-edit-toolbar"));
  await ui.close();
}

console.log(`vectorCutTool: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
