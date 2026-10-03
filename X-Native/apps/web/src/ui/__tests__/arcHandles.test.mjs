/**
 * Arc handles on the canvas (Figma help 360040450173, "Arc tool: create arcs,
 * semi-circles, and rings").
 *
 * "When you hover over the circle, a single handle will appear on the
 * right-hand side. This point (0) determines where you can begin to create an
 * arc." … "Click and drag the Arc handle up or down to change the sweep." …
 * "Now there will be three handles shown: The Sweep … The Start handle (which
 * has a dot inside it) indicates where the arc begins … you can drag this
 * around the circle to change the position of the ring. The Ratio handle at the
 * center of the circle allows you to change the circle to a ring."
 *
 * Behaviour through the mounted Canvas: the dots that are painted are the dots
 * the pointer grabs, so the paint assertions and the drag assertions are two
 * halves of the same claim.
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const R = Math.PI / 180;

const window = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;

// Paint calls split into frames: each overlay paint starts by filling the
// surface, so the pill/dot assertions read the frame the test just caused.
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
    /** The single ellipse each of these mounts places on the page. */
    node: () => engine.snapshot().pages[0].root.children[0],
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
      })));
    },
    async drag(from, to, extra = {}) {
      await ui.mouse("mousedown", from[0], from[1], extra);
      await ui.mouse("mousemove", to[0], to[1], extra);
      await ui.mouse("mouseup", to[0], to[1], extra);
    },
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
  return ui;
}
/** Every arc control dot in the last painted frame, as kind@x,y. */
const dots = () => frame()
  .filter(([call, , , r]) => call === "arc" && (r === 4.5 || r === 1.6))
  .map(([, x, y, r]) => `${r === 1.6 ? "startdot" : "dot"}@${Math.round(x)},${Math.round(y)}`);
const dotCount = () => frame().filter(([call, , , r]) => call === "arc" && r === 4.5).length;
const deg = (r) => Math.round((r * 180) / Math.PI);
const box = (n) => [n.x, n.y, n.w, n.h].map((v) => Math.round(v)).join(",");

// A 100x100 circle at 0,0: centre (50,50), radius 50; angle 0 is the right
// edge (100,50), 90 degrees is the bottom edge (50,100).
const circle = (name = "Ellipse", extra = {}) => node("ellipse", name, 0, 0, 100, 100, extra);

{
  // Figma: "a single handle will appear on the right-hand side".
  const e = circle();
  const ui = await mount([e], [e.id]);
  t("a selected circle shows one handle, on the right-hand side", dots().join() === "dot@100,50");
  t("a circle has no Ratio handle to grab", dotCount() === 1);
  await ui.close();
}
{
  // Figma: "Now there will be three handles shown" - Sweep, Start (dot inside)
  // and Ratio - once the sweep has opened a gap.
  const e = circle("Arc", { arcData: { startingAngle: 90 * R, endingAngle: Math.PI * 2, innerRadius: 0.5 } });
  const ui = await mount([e], [e.id]);
  const painted = dots();
  t("an arc shows Sweep, Start and Ratio handles", painted.filter((d) => d.startsWith("dot@")).length === 3);
  t("the Sweep handle sits at the arc's end, on the right edge", painted.includes("dot@100,50"));
  t("the Start handle sits where the arc begins, on the bottom edge", painted.includes("dot@50,100"));
  t("the Ratio handle sits on the inner edge", painted.includes("dot@75,50"));
  t("the Start handle has a dot inside it", painted.includes("startdot@50,100"));
  await ui.close();
}
{
  // Figma: "The Ratio handle at the center of the circle allows you to change
  // the circle to a ring."
  const e = circle("Pie", { arcData: { startingAngle: 0, endingAngle: 270 * R, innerRadius: 0 } });
  const ui = await mount([e], [e.id]);
  const painted = dots();
  t("a pie shows its Ratio handle at the centre", painted.includes("dot@50,50"));
  t("the pie's Sweep handle sits at the end of the sweep", painted.includes("dot@50,0"));
  await ui.close();
}
{
  const e = circle();
  const ui = await mount([e], [e.id]);
  await ui.drag([100, 50], [50, 100]);
  const n = ui.node();
  t("dragging the Sweep handle turns the circle into a 90 degree arc", deg(n.arcData?.endingAngle) === 90);
  t("the sweep drag leaves the box alone", box(n) === "0,0,100,100");
  await ui.close();
}
{
  const e = circle();
  const ui = await mount([e], [e.id]);
  await ui.drag([100, 50], [50, 100], { shiftKey: true });
  t("Shift snaps the sweep to 15 degree steps", deg(ui.node().arcData?.endingAngle) === 90);
  await ui.close();
}
{
  // The Start handle: on the bottom edge for an arc that began at 90 degrees.
  const e = circle("Arc", { arcData: { startingAngle: 90 * R, endingAngle: Math.PI * 2, innerRadius: 0.5 } });
  const ui = await mount([e], [e.id]);
  await ui.drag([50, 100], [0, 50]);
  const n = ui.node();
  t("dragging the Start handle moves where the arc begins", deg(n.arcData?.startingAngle) === 180);
  t("the Start handle does not resize the ellipse", box(n) === "0,0,100,100");
  t("the sweep and the ring are untouched", deg(n.arcData?.endingAngle) === 360 && n.arcData?.innerRadius === 0.5);
  await ui.close();
}
{
  // Pie -> ring, the whole point of the Ratio handle.
  const e = circle("Pie", { arcData: { startingAngle: 0, endingAngle: 270 * R, innerRadius: 0 } });
  const ui = await mount([e], [e.id]);
  await ui.drag([50, 50], [75, 50]);
  const n = ui.node();
  t("dragging the Ratio handle out of a pie makes a ring", n.arcData?.innerRadius === 0.5);
  t("the ring drag does not move the ellipse", box(n) === "0,0,100,100");
  await ui.close();
}
{
  // Figma: "When you hover over the circle, a single handle will appear" - the
  // affordance works without selecting the layer first.
  const e = circle("Hovered");
  const ui = await mount([e], []);
  await ui.mouse("mousemove", 100, 50);
  t("an unselected circle shows its handle on hover", dots().join() === "dot@100,50");
  await ui.drag([100, 50], [50, 100]);
  const n = ui.node();
  t("dragging that handle selects the circle and makes the arc", deg(n.arcData?.endingAngle) === 90 && ui.engine.snapshot().selection.join() === e.id);
  await ui.close();
}
{
  // The arc drag is its own undo step, like every other handle on the canvas.
  const e = circle("Steps");
  const ui = await mount([e], [e.id]);
  await ui.drag([100, 50], [50, 0]);
  const arc = deg(ui.node().arcData?.endingAngle);
  // Away from the centre: a pie's centre is its Ratio handle now.
  await ui.drag([20, 20], [50, 50]);
  const moved = box(ui.node());
  await ui.engine.dispatch({ type: "undo" });
  const n = ui.node();
  t("one undo takes back the move, not the arc drag before it",
    box(n) === "0,0,100,100" && deg(n.arcData?.endingAngle) === arc && arc === 270 && moved === "30,30,100,100");
  await ui.close();
}
{
  // Regressions: the plain gestures still belong to the layer, not the handle.
  const e = circle("Plain");
  const ui = await mount([e], [e.id]);
  await ui.drag([50, 50], [80, 80]);
  const n = ui.node();
  t("pressing the middle of an arc-less ellipse still moves it", box(n) === "30,30,100,100" && !n.arcData);
  const e2 = circle("Move");
  const ui2 = await mount([e2], []);
  await ui2.drag([50, 50], [70, 70]);
  t("pressing an unselected ellipse's middle still selects and moves it",
    box(ui2.node()) === "20,20,100,100" && ui2.engine.snapshot().selection.join() === e2.id);
  await ui2.close();
  await ui.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
