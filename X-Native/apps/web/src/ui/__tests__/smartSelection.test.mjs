/**
 * Smart selection: equal-gap dragging (Figma help 360040450233, "Arrange
 * layers with Smart selection").
 *
 * "To make a Smart selection, all layers must be an equal distance apart and
 * overlap on either the x or y axis (1D) […] additional pink handles will
 * appear between each layer. These handles allow you to adjust the vertical or
 * horizontal spacing between layers." … "Click and drag the handle to adjust
 * the space between layers. A tooltip above your cursor shows the current
 * space between layers, in pixels."
 *
 * The point of the feature is that one handle drives *every* gap in the run,
 * so the load-bearing assertions here are the two gaps read back after a
 * single drag of the middle handle, plus the pill paints that show the live
 * value. This is behaviour through the mounted Canvas (real handlers, real
 * dispatches) - not a browser pixel test.
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find } from "../../engine/memory.ts";
import { smartSelectionGaps } from "../../engine/snapping.ts";
import { setNudgePrefs } from "../nudgePrefs.ts";

let pass = 0, fail = 0;
const t = (name, ok) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const square = (name, x, y = 0) => node("rect", name, x, y, 100, 100);
const gaps = (...xs) => xs.slice(1).map((x, i) => x - (xs[i] + 100));

// Detector: the 1D rule the article states, on its own.
{
  const boxes = (xs, ys = xs.map(() => 0)) => xs.map((x, i) => ({ id: `b${i}`, x, y: ys[i], w: 100, h: 100 }));
  const even = smartSelectionGaps(boxes([0, 120, 240]));
  t("an equal row is one 1D smart selection", even.length === 2 && even.every((g) => g.axis === "x"));
  t("each handle sits at the mid-point of its gap", even[0].at === 110 && even[1].at === 230);
  t("the handle carries the space it adjusts", even.every((g) => g.size === 20));
  t("the handle is centered on the band the layers share", even.every((g) => g.cross === 50));
  t("an unequal run is not a smart selection", smartSelectionGaps(boxes([0, 120, 260])).length === 0);
  t("touching layers have no gap to drag", smartSelectionGaps(boxes([0, 100, 220])).length === 0);
  const column = smartSelectionGaps(boxes([0, 0, 0], [0, 120, 240]));
  t("an equal column is a smart selection on the y axis", column.length === 2 && column.every((g) => g.axis === "y"));
  t("two layers are still a 1D smart selection", smartSelectionGaps(boxes([0, 120])).length === 1);
  t("a single pair has one space to adjust whenever it is apart at all",
    smartSelectionGaps(boxes([0, 130])).length === 1 &&
    smartSelectionGaps(boxes([0, 100])).length === 0);
  t("layers that miss each other across the axis are not 1D",
    smartSelectionGaps(boxes([0, 120], [0, 400])).length === 0);
}

// Engine command: the gap value is applied to every pair at once.
{
  const engine = new MemoryEngine(false);
  const root = engine.snapshot().pages[0].root;
  const a = square("A", 0), b = square("B", 120), c = square("C", 240);
  root.children = [a, b, c];
  engine.dispatch({ type: "select", ids: [a.id, b.id, c.id] });
  engine.dispatch({ type: "distributeSpacing", ids: [a.id, b.id, c.id], axis: "h", gap: 60 });
  const xs = [a, b, c].map((n) => find(engine.snapshot().pages[0].root, n.id).x);
  t("distributeSpacing sets every gap to the dragged value", xs.join() === "0,160,320");
  engine.dispatch({ type: "distributeSpacing", ids: [a.id, b.id, c.id], axis: "h", gap: -40 });
  const xs2 = [a, b, c].map((n) => find(engine.snapshot().pages[0].root, n.id).x);
  t("a negative gap clamps to zero instead of overlapping", xs2.join() === "0,100,200" && gaps(...xs2).join() === "0,0");
}

const window = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;
// Paint calls, split into frames: every overlay paint starts by filling the
// surface, so a new frame begins on that call. The pill assertions below read
// the frame the test just caused, not a pile of earlier ones.
let frames = [[]];
const frame = () => frames[frames.length - 1];
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({
    canvas: this,
    measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === "fillRect" && args[0] === 0 && args[1] === 0 && args[2] >= 1000) frames.push([]);
        frame().push([key, ...args]);
      };
    },
  });
};
const resetFrames = () => { frames = [[]]; };
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830 });

async function mount(children, selection = []) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(...children), guides: [], comments: [] }],
    page: 0, zoom: 1, panX: 0, panY: 0,
  });
  engine.dispatch({ type: "select", ids: selection });
  function Host() {
    const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap }));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  await act(async () => reactRoot.render(React.createElement(Host)));
  const surface = host.querySelector(".canvas-wrap");
  const ui = {
    engine, host, surface,
    node: (id) => find(engine.snapshot().pages[0].root, id),
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
      })));
    },
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
  return ui;
}
/** The gap pills, found by their paint shape: 16px tall pods, 10px type. */
setNudgePrefs({ big: 10 });
const pills = () => frame().filter(([call, , , , h]) => call === "roundRect" && h === 16).length;
const pillText = () => frame().filter(([call]) => call === "fillText").map(([, s]) => s);
const row = () => [A, B, C].map((n) => ui.node(n.id).x);
const col = () => [A, B, C].map((n) => ui.node(n.id).y);

// Three 100px squares, edge gaps of 20 on both sides: a 1D smart selection
// whose two handles sit at x = 110 and x = 230.
let A, B, C, ui;
async function row3() {
  A = square("A", 0); B = square("B", 120); C = square("C", 240);
  return mount([A, B, C], [A.id, B.id, C.id]);
}
async function col3() {
  A = square("A", 0, 0); B = square("B", 0, 120); C = square("C", 0, 240);
  return mount([A, B, C], [A.id, B.id, C.id]);
}

{
  ui = await row3();
  await ui.mouse("mousemove", 110, 50);
  t("an equal run shows one handle per gap while the layers just sit there", pills() === 2);
  t("the handle shows the current space between layers", pillText().filter((s) => s === "20").length === 2);
  await ui.close();
}
{
  ui = await row3();
  // Press the first handle, drag it 40px right: the space grows by 40 for
  // every pair, and the layers after the handle slide along.
  await ui.mouse("mousedown", 110, 50);
  t("pressing a gap handle keeps the selection", ui.engine.snapshot().selection.length === 3);
  resetFrames();
  await ui.mouse("mousemove", 150, 50);
  t("the drag moves every layer in the run, not just one", row().join() === "0,160,320");
  t("both gaps stay equal through the drag", gaps(...row()).join() === "60,60");
  t("the pill reads the live value", pillText().includes("60"));
  await ui.mouse("mouseup", 150, 50);
  t("the two gaps are still equal when the drag is released", gaps(...row()).join() === "60,60");
  await ui.close();
}
{
  ui = await row3();
  await ui.mouse("mousedown", 110, 50);
  await ui.mouse("mousemove", 70, 50);
  await ui.mouse("mouseup", 70, 50);
  t("dragging left closes the space and clamps at zero", row().join() === "0,100,200" && gaps(...row()).join() === "0,0");
  await ui.close();
}
{
  ui = await row3();
  await ui.mouse("mousedown", 110, 50);
  await ui.mouse("mousemove", 136, 50, { shiftKey: true });
  await ui.mouse("mouseup", 136, 50, { shiftKey: true });
  t("Shift steps the space by the Big nudge", gaps(...row()).join() === "50,50");
  await ui.close();
}
{
  ui = await col3();
  await ui.mouse("mousedown", 50, 110);
  await ui.mouse("mousemove", 50, 150);
  await ui.mouse("mouseup", 50, 150);
  t("a column's handle adjusts the vertical space between every layer", col().join() === "0,160,320" && gaps(...col()).join() === "60,60");
  await ui.close();
}
{
  ui = await row3();
  // Break the equality: the run is no longer a smart selection, so the
  // handles go away and a press at the old spot is an ordinary canvas press.
  await ui.engine.dispatch({ type: "select", ids: [B.id] });
  await ui.engine.dispatch({ type: "patch", id: B.id, patch: { x: 150 } });
  await ui.engine.dispatch({ type: "select", ids: [A.id, B.id, C.id] });
  await ui.mouse("mousemove", 110, 50);
  t("a run that drifts out of equality loses its handles", pills() === 0);
  await ui.mouse("mousedown", 110, 50);
  await ui.mouse("mouseup", 110, 50);
  t("a press where a stale handle used to be starts a marquee again", ui.engine.snapshot().selection.length === 0);
  await ui.close();
}
{
  ui = await row3();
  // Moving a layer is still moving a layer: the handle only takes presses
  // near the gaps.
  await ui.mouse("mousedown", 170, 50);
  await ui.mouse("mousemove", 180, 50);
  await ui.mouse("mouseup", 180, 50);
  t("pressing a layer itself still moves the selection", row().join() === "10,130,250");
  await ui.mouse("mousemove", 110, 50);
  t("the handles follow the layers they belong to", pills() === 2);
  await ui.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
