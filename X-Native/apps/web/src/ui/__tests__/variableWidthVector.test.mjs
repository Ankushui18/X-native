/** Run 23: variable-width vector interaction (audit P1 #11) — the seven
 *  interaction categories, end to end, on the mounted canvas.
 *
 *  AUDIT (what existed before this run):
 *  · The model (`strokeWidthProfile`, `normalizeWidthProfile`,
 *    `sampleVariableWidth`), the outline painter (`outlineVariableStroke`),
 *    the station sampler (`widthProfileStations`) and the inspector's
 *    WidthProfileEditor strip all worked — but on canvas the profile dots
 *    were DISPLAY-ONLY ("the inspector's profile strip edits them"). The
 *    audit listed a variable-width *subtool* as absent; this run makes the
 *    stroke itself interactive instead: hover shows a pink handle, a click
 *    adds a width point, points drag along the stroke normal, ⇧ selects
 *    several, Delete removes them, and every adjustment is one undo step.
 *  · Constraints ride the shared `variableWidthBlockReason` (dashed, branch,
 *    plus this run's pattern and brush reasons), so the canvas and the
 *    inspector refuse with the same words.
 *
 *  jsdom + recorded paints: interaction wiring and paint-call geometry, not
 *  browser pixels.
 *
 *  Run with:  npx vite-node src/ui/__tests__/variableWidthVector.test.mjs
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
const { subscribeToast } = await import("../toast.ts");
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
    engine, host, surface,
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
    async key(k, extra = {}) {
      await act(async () =>
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })));
    },
    async dispatch(cmd) { await act(async () => engine.dispatch(cmd)); },
    async close() { await act(async () => reactRoot.unmount()); host.remove(); },
  };
  return ui;
}

const arcs = (tail, r, x, y) =>
  tail.some((e) => e[0] === "arc" && Math.abs(e[3] - r) < 1e-9 && near(e[1], x, 1e-6) && near(e[2], y, 1e-6));
const labels = (tail, s) => tail.filter((e) => e[0] === "fillText" && e[1] === s).length;
const prof = (ui, id) => ui.node(id).strokeWidthProfile;
const mults = (p) => (p ?? []).map((q) => Math.round(q.widthMultiplier * 1000) / 1000);
const poss = (p) => (p ?? []).map((q) => q.position);

/** A straight open vector from world (100,150) to (300,150), stroke 10,
 *  selected, optionally with a seeded profile. addPath min-normalizes, so the
 *  path sits at local (0,0)→(200,0) under the node at (100,150). */
async function fixture(profile) {
  const ui = await mount([], []);
  await ui.dispatch({ type: "addPath", points: [{ x: 100, y: 150 }, { x: 300, y: 150 }], closed: false });
  const id = ui.engine.snapshot().selection[0];
  await ui.dispatch({
    type: "patch", id,
    patch: { strokeWidth: 10, ...(profile ? { strokeWidthProfile: profile } : {}) },
  });
  return { ui, id };
}
const P3 = [{ position: 0, widthMultiplier: 1 }, { position: 0.5, widthMultiplier: 1 }, { position: 1, widthMultiplier: 1 }];

// ─────────────────────── 1 · width point creation ───────────────────────
console.log("1 · creation: hover the stroke → pink handle → click adds a point");
{
  const { ui, id } = await fixture(null);
  let m = ui.marker();
  await ui.mouse("mousemove", 200, 150);
  let tail = ui.tail(m);
  t("1-hover: a pink handle appears over the plain solid stroke", arcs(tail, 5, 200, 150),
    JSON.stringify(tail.filter((e) => e[0] === "arc")));
  m = ui.marker();
  await ui.mouse("mousedown", 200, 150);
  await ui.mouse("mouseup", 200, 150);
  const p = prof(ui, id);
  t("1-add: the click adds a width point at the projected position", p?.length === 1 && near(p[0].position, 0.5),
    JSON.stringify(p));
  t("1-add: the point keeps the interpolated width (1× on a flat profile)",
    p?.length === 1 && near(p[0].widthMultiplier, 1));
  tail = ui.tail(m);
  t("1-add: the new point is selected and labeled with its width in px", labels(tail, "10px") >= 1,
    JSON.stringify(tail.filter((e) => e[0] === "fillText")));
  t("1-add: its station dot is painted", arcs(tail, 3.5, 200, 150));
  await ui.dispatch({ type: "undo" });
  t("1-undo: one undo removes the point again", prof(ui, id) === undefined || prof(ui, id)?.length === 0,
    JSON.stringify(prof(ui, id)));
  await ui.close();
}

// ─────────────────────── 2 · width adjustment ───────────────────────
console.log("2 · adjustment: drag a point → width interpolates between points");
{
  const { ui, id } = await fixture(P3);
  let m = ui.marker();
  await ui.mouse("mousemove", 200, 150);
  t("2-hover: a ring marks the existing point under the pointer", arcs(ui.tail(m), 7, 200, 150));
  await ui.mouse("mousedown", 200, 150);
  await ui.mouse("mousemove", 200, 155);
  await ui.mouse("mousemove", 200, 160);
  await ui.mouse("mouseup", 200, 160);
  let p = prof(ui, id);
  t("2-drag: dragging 10px across a 10px stroke takes 1× → 3×",
    JSON.stringify(mults(p)) === JSON.stringify([1, 3, 1]), JSON.stringify(mults(p)));
  t("2-drag: positions never move", JSON.stringify(poss(p)) === JSON.stringify([0, 0.5, 1]),
    JSON.stringify(poss(p)));
  await ui.dispatch({ type: "undo" });
  t("2-undo: a single undo takes the whole drag back to 1×",
    JSON.stringify(mults(prof(ui, id))) === JSON.stringify([1, 1, 1]), JSON.stringify(mults(prof(ui, id))));
  await ui.dispatch({ type: "redo" });
  t("2-redo: redo re-applies the drag in one step",
    JSON.stringify(mults(prof(ui, id))) === JSON.stringify([1, 3, 1]), JSON.stringify(mults(prof(ui, id))));
  // A click between two different widths interpolates: 3×@0.5 → 1×@1 is 2×@0.75.
  m = ui.marker();
  await ui.mouse("mousemove", 250, 150);
  await ui.mouse("mousedown", 250, 150);
  await ui.mouse("mouseup", 250, 150);
  p = prof(ui, id);
  const added = (p ?? []).find((q) => near(q.position, 0.75));
  t("2-interp: a point added between 3× and 1× lands at 2×", !!added && near(added.widthMultiplier, 2),
    JSON.stringify(p));
  await ui.dispatch({ type: "undo" });
  t("2-interp: that add is its own undo step", prof(ui, id)?.length === 3, JSON.stringify(prof(ui, id)));
  await ui.close();
}

// ─────────────────────── 3 · multi-select ───────────────────────
console.log("3 · multi-select: ⇧-click several points, drag adjusts together");
{
  const { ui, id } = await fixture(P3);
  await ui.mouse("mousemove", 100, 150);
  await ui.mouse("mousedown", 100, 150);
  await ui.mouse("mouseup", 100, 150);
  await ui.mouse("mousemove", 300, 150);
  await ui.mouse("mousedown", 300, 150, { shiftKey: true });
  await ui.mouse("mouseup", 300, 150, { shiftKey: true });
  let m = ui.marker();
  await ui.mouse("mousedown", 100, 150);
  await ui.mouse("mousemove", 100, 160);
  await ui.mouse("mouseup", 100, 160);
  let tail = ui.tail(m);
  const p = prof(ui, id);
  t("3-drag: both selected points moved together (endpoints 1×→3×)",
    JSON.stringify(mults(p)) === JSON.stringify([3, 1, 3]), JSON.stringify(mults(p)));
  t("3-drag: the unselected middle point kept its width", mults(p)[1] === 1);
  t("3-drag: both selected handles show their new width", labels(tail, "30px") >= 2,
    JSON.stringify(tail.filter((e) => e[0] === "fillText")));
  t("3-drag: both selected handles are highlighted", tail.filter((e) => e[0] === "arc" && Math.abs(e[3] - 6) < 1e-9).length >= 2,
    JSON.stringify(tail.filter((e) => e[0] === "arc")));
  await ui.dispatch({ type: "undo" });
  t("3-undo: one undo restores the whole multi-drag",
    JSON.stringify(mults(prof(ui, id))) === JSON.stringify([1, 1, 1]), JSON.stringify(mults(prof(ui, id))));
  await ui.close();
}

// ─────────────────────── 4 · delete ───────────────────────
console.log("4 · delete: Delete/Backspace removes the selected width point");
{
  const { ui, id } = await fixture(P3);
  await ui.mouse("mousemove", 200, 150);
  await ui.mouse("mousedown", 200, 150);
  await ui.mouse("mouseup", 200, 150);
  const beforeDel = ui.marker();
  await ui.key("Delete");
  let p = prof(ui, id);
  t("4-delete: Delete drops the selected point", p?.length === 2 && JSON.stringify(poss(p)) === JSON.stringify([0, 1]),
    JSON.stringify(p));
  t("4-delete: the selection clears with it",
    ui.tail(beforeDel).filter((e) => e[0] === "arc" && Math.abs(e[3] - 6) < 1e-9).length === 0);
  await ui.dispatch({ type: "undo" });
  t("4-undo: one undo restores the point", prof(ui, id)?.length === 3, JSON.stringify(prof(ui, id)));
  // Select both survivors and delete them: below two points the profile clears.
  await ui.mouse("mousemove", 100, 150);
  await ui.mouse("mousedown", 100, 150);
  await ui.mouse("mouseup", 100, 150);
  await ui.mouse("mousemove", 300, 150);
  await ui.mouse("mousedown", 300, 150, { shiftKey: true });
  await ui.mouse("mouseup", 300, 150, { shiftKey: true });
  await ui.key("Delete");
  t("4-clear: deleting below two points clears the profile entirely",
    prof(ui, id) === undefined || (prof(ui, id)?.length ?? 0) < 2, JSON.stringify(prof(ui, id)));
  await ui.dispatch({ type: "undo" });
  t("4-clear: one undo brings the profile back", prof(ui, id)?.length === 3, JSON.stringify(prof(ui, id)));
  await ui.close();
}

// ─────────────────────── 5 · visual feedback ───────────────────────
console.log("5 · feedback: pink hover handle, ringed station, selected highlight");
{
  const { ui, id } = await fixture(P3);
  let m = ui.marker();
  await ui.mouse("mousemove", 150, 150);
  let tail = ui.tail(m);
  t("5-hover: mid-segment hover shows the pink preview (r5)", arcs(tail, 5, 150, 150));
  t("5-hover: no station ring without a station there", !arcs(tail, 7, 150, 150));
  m = ui.marker();
  await ui.mouse("mousemove", 200, 150);
  tail = ui.tail(m);
  t("5-hover: hovering an existing point rings it (r7)", arcs(tail, 7, 200, 150));
  t("5-hover: the ring replaces the preview", !arcs(tail, 5, 200, 150));
  m = ui.marker();
  await ui.mouse("mousedown", 200, 150);
  await ui.mouse("mouseup", 200, 150);
  tail = ui.tail(m);
  t("5-select: the clicked point gets the selected highlight (r6)", arcs(tail, 6, 200, 150));
  t("5-select: its width value is shown", labels(tail, "10px") >= 1,
    JSON.stringify(tail.filter((e) => e[0] === "fillText")));
  await ui.close();
}

// ─────────────────────── 6 · constraints ───────────────────────
console.log("6 · constraints: dashed/pattern/brush refuse with feedback, no handle");
{
  // Dashed.
  {
    const { ui, id } = await fixture(P3);
    await ui.dispatch({ type: "patch", id, patch: { strokeDash: 4 } });
    const seen = [];
    const off = subscribeToast((msg) => seen.push(msg));
    let m = ui.marker();
    await ui.mouse("mousemove", 200, 150);
    t("6-dash: a dashed stroke shows no width handle", !arcs(ui.tail(m), 5, 200, 150) && !arcs(ui.tail(m), 7, 200, 150));
    await ui.mouse("mousedown", 200, 150);
    await ui.mouse("mouseup", 200, 150);
    off();
    t("6-dash: pressing it explains why", seen.includes("Remove dashes to use variable width"), JSON.stringify(seen));
    t("6-dash: and nothing was added", prof(ui, id)?.length === 3, JSON.stringify(prof(ui, id)));
    await ui.close();
  }
  // Pattern stroke.
  {
    const { ui, id } = await fixture(P3);
    await ui.dispatch({ type: "patch", id, patch: { strokeType: "pattern" } });
    const seen = [];
    const off = subscribeToast((msg) => seen.push(msg));
    let m = ui.marker();
    await ui.mouse("mousemove", 200, 150);
    t("6-pattern: a pattern stroke shows no width handle", !arcs(ui.tail(m), 5, 200, 150) && !arcs(ui.tail(m), 7, 200, 150));
    await ui.mouse("mousedown", 200, 150);
    await ui.mouse("mouseup", 200, 150);
    off();
    t("6-pattern: pressing it explains why", seen.includes("Use a solid stroke to vary width"), JSON.stringify(seen));
    await ui.close();
  }
  // Brush-drawn stroke.
  {
    const ui = await mount([], []);
    await ui.dispatch({ type: "setTool", tool: "brush" });
    await ui.dispatch({
      type: "addPath",
      points: [{ x: 100, y: 150 }, { x: 160, y: 155 }, { x: 220, y: 148 }, { x: 300, y: 152 }],
      closed: false,
    });
    const id = ui.engine.snapshot().selection[0];
    await ui.dispatch({ type: "setTool", tool: "select" });
    t("6-brush: the brush marker lands on the drawn node", ui.node(id).brushStroke === true);
    const seen = [];
    const off = subscribeToast((msg) => seen.push(msg));
    let m = ui.marker();
    await ui.mouse("mousemove", 200, 151);
    t("6-brush: a brush stroke shows no width handle", !arcs(ui.tail(m), 5, 200, 151));
    await ui.mouse("mousedown", 200, 151);
    await ui.mouse("mouseup", 200, 151);
    off();
    t("6-brush: pressing it explains why", seen.includes("Brush strokes use a fixed width"), JSON.stringify(seen));
    await ui.close();
  }
  // Brush tool armed over a normal vector: no handle at all.
  {
    const { ui, id } = await fixture(P3);
    await ui.dispatch({ type: "setTool", tool: "brush" });
    const m = ui.marker();
    await ui.mouse("mousemove", 200, 150);
    t("6-brush-tool: the brush tool never shows width handles", !arcs(ui.tail(m), 5, 200, 150) && !arcs(ui.tail(m), 7, 200, 150));
    await ui.close();
  }
}

// ─────────────────────── 7 · undo granularity ───────────────────────
console.log("7 · undo: every width adjustment is exactly one undo step");
{
  const { ui, id } = await fixture(P3);
  const baseline = JSON.stringify(ui.node(id).strokeWidthProfile);
  await ui.mouse("mousemove", 200, 150);
  await ui.mouse("mousedown", 200, 150);
  await ui.mouse("mousemove", 200, 154);
  await ui.mouse("mousemove", 200, 158);
  await ui.mouse("mousemove", 200, 160);
  await ui.mouse("mouseup", 200, 160);
  t("7-drag: the adjustment landed",
    JSON.stringify(mults(prof(ui, id))) === JSON.stringify([1, 3, 1]), JSON.stringify(mults(prof(ui, id))));
  await ui.dispatch({ type: "undo" });
  t("7-undo: one undo returns the whole multi-move drag to baseline",
    JSON.stringify(ui.node(id).strokeWidthProfile) === baseline,
    `${JSON.stringify(ui.node(id).strokeWidthProfile)} vs ${baseline}`);
  await ui.dispatch({ type: "redo" });
  t("7-redo: one redo re-applies it whole",
    JSON.stringify(mults(prof(ui, id))) === JSON.stringify([1, 3, 1]), JSON.stringify(mults(prof(ui, id))));
  await ui.close();
}

console.log(`\nvariableWidthVector: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
