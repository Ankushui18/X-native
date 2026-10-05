/**
 * One action, one undo step — the canvas half of §25.
 *
 * Figma: "Each press steps back one action" (saasdesign.io/learn/figma-undo),
 * "Press undo, then an equal number of redos, and the file returns to exactly
 * the state it held before" — so a handle drag must be a single step, and the
 * edit made after it must be its own step.
 *
 * Regression this pins: the on-release `end` dispatch listed the drag modes by
 * hand and omitted `rotate`, `bend`, `starRatio`, `starRadius`, `starCount`,
 * `polyRadius`, `polyCount` and `radius`. Those drags opened a history group
 * on press and never closed it, so the engine stayed in "grouping" mode and
 * every later edit merged into that one entry: a single ⌘Z rolled back the
 * handle drag *and* everything the user did after it. The fix routes the
 * release through the one `GESTURE_MODES` set the press sites feed.
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find } from "../../engine/memory.ts";
import { pathToVectorNetwork } from "../../engine/geometry.ts";

let pass = 0, fail = 0;
const t = (name, ok) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const window = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;

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
      return () => {};
    },
  });
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830 });

const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });

/** Mount the real Canvas over a one-node page at zoom 1, pan 0, so world
 *  coordinates are screen coordinates (the client offset is +50/+30). */
async function mount(child, selection = [child.id]) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(child), guides: [], comments: [] }],
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
  const mouse = async (type, x, y, extra = {}) => {
    await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
    })));
  };
  return {
    engine,
    node: () => find(engine.snapshot().pages[0].root, child.id),
    async drag(from, to, extra = {}) {
      await mouse("mousedown", from[0], from[1], extra);
      await mouse("mousemove", to[0], to[1], extra);
      await mouse("mouseup", to[0], to[1], extra);
    },
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
}

/** Run the leak check for one handle drag: after the drag, a follow-up edit
 *  must be its own step (one undo takes back only the edit) and the drag must
 *  be its own step too (a second undo takes it back). */
async function assertOwnSteps(name, ui, read, drag) {
  const before = read(ui);
  await drag(ui);
  const dragged = read(ui);
  t(`${name}: the drag changes the document`, JSON.stringify(dragged) !== JSON.stringify(before));
  ui.engine.dispatch({ type: "patch", id: ui.node().id, patch: { fill: "#ff0000" } });
  t(`${name}: the follow-up edit lands`, ui.node().fill === "#ff0000");
  ui.engine.dispatch({ type: "undo" });
  const afterUndo = read(ui);
  t(`${name}: one undo takes back only the follow-up edit`, JSON.stringify(afterUndo) === JSON.stringify(dragged));
  t(`${name}: that undo restored the fill, not the drag`, ui.node().fill !== "#ff0000");
  ui.engine.dispatch({ type: "undo" });
  t(`${name}: a second undo takes back the drag itself`, JSON.stringify(read(ui)) === JSON.stringify(before));
  await ui.close();
}

const deg = (r) => Math.round((r * 180) / Math.PI);

// --- rotation ---------------------------------------------------------------
{
  const r = node("rect", "R", 0, 0, 100, 100);
  const ui = await mount(r);
  await assertOwnSteps("rotate", ui, (u) => u.node().rotation, async (u) => {
    // The rotation band is 8..24px outside a corner (`ROTATION_RING`).
    await u.drag([-14, -14], [20, -30]);
  });
  const r2 = node("rect", "R", 0, 0, 100, 100);
  const ui2 = await mount(r2);
  await ui2.drag([-14, -14], [20, -30]);
  t("rotate: the ring press actually rotated the layer", Math.abs(ui2.node().rotation) > 1);
  await ui2.close();
}

// --- corner radius pin ------------------------------------------------------
{
  const r = node("rect", "R", 0, 0, 100, 100);
  const ui = await mount(r);
  await assertOwnSteps("radius", ui, (u) => u.node().cornerRadii[0], async (u) => {
    // With no radius yet the top-left pin sits 9px in from the corner.
    await u.drag([9, 9], [40, 40]);
  });
  await ui.close();
}

// --- star handles -----------------------------------------------------------
const starHandle = (n, kind) => {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2, rx = n.w / 2, ry = n.h / 2;
  const pts = Math.max(3, Math.min(60, Math.round(n.count || 5)));
  if (kind === "ratio") {
    const a = Math.PI / pts - Math.PI / 2, k = Math.max(0.05, Math.min(0.95, n.starRatio ?? 0.4));
    return [cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k];
  }
  const aCount = (2 * Math.PI) / pts - Math.PI / 2;
  if (kind === "count") return [cx + Math.cos(aCount) * rx, cy + Math.sin(aCount) * ry];
  return [cx, cy - ry + Math.min(ry * 0.4, Math.max(10, (n.cornerRadii[0] || 0)))];
};
{
  const s = node("star", "S", 0, 0, 100, 100, { count: 5, starRatio: 0.4 });
  const ui = await mount(s);
  await assertOwnSteps("star ratio", ui, (u) => u.node().starRatio, async (u) => {
    const [hx, hy] = starHandle(u.node(), "ratio");
    await u.drag([hx, hy], [50, 12]);
  });
  await ui.close();
}
{
  const s = node("star", "S", 0, 0, 100, 100, { count: 5, starRatio: 0.4 });
  const ui = await mount(s);
  await assertOwnSteps("star count", ui, (u) => u.node().count, async (u) => {
    const [hx, hy] = starHandle(u.node(), "count");
    await u.drag([hx, hy], [50, 10]);
  });
  await ui.close();
}
{
  const s = node("star", "S", 0, 0, 100, 100, { count: 5, starRatio: 0.4 });
  const ui = await mount(s);
  await assertOwnSteps("star radius", ui, (u) => u.node().cornerRadii[0], async (u) => {
    const [hx, hy] = starHandle(u.node(), "radius");
    await u.drag([hx, hy], [hx, hy + 40]);
  });
  await ui.close();
}

// --- polygon handles --------------------------------------------------------
const polyHandle = (n, kind) => {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2, rx = n.w / 2, ry = n.h / 2;
  const pts = Math.max(3, Math.min(60, Math.round(n.count || 3)));
  if (kind === "count") {
    const a = (2 * Math.PI) / pts - Math.PI / 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  }
  return [cx, cy - ry + Math.min(ry * 0.4, Math.max(10, (n.cornerRadii[0] || 0)))];
};
{
  const p = node("poly", "P", 0, 0, 100, 100, { count: 3 });
  const ui = await mount(p);
  await assertOwnSteps("poly count", ui, (u) => u.node().count, async (u) => {
    const [hx, hy] = polyHandle(u.node(), "count");
    await u.drag([hx, hy], [10, 50]);
  });
  await ui.close();
}
{
  const p = node("poly", "P", 0, 0, 100, 100, { count: 3 });
  const ui = await mount(p);
  await assertOwnSteps("poly radius", ui, (u) => u.node().cornerRadii[0], async (u) => {
    const [hx, hy] = polyHandle(u.node(), "radius");
    await u.drag([hx, hy], [hx, hy + 40]);
  });
  await ui.close();
}

// --- bend (vector edit, segment drag) --------------------------------------
{
  const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }];
  const v = node("vector", "Tri", 0, 0, 100, 100, {
    path: tri.map((p) => ({ ...p })), closed: true, vectorNetwork: pathToVectorNetwork(tri, true),
  });
  const ui = await mount(v);
  // Entering vector edit must flush a render before the press: the canvas
  // handlers close over the snapshot they were rendered with, so an un-acted
  // dispatch would leave vecEdit invisible to the press (it would then hit the
  // box's own resize handle instead of the segment).
  await act(async () => {
    ui.engine.dispatch({ type: "setVecEdit", id: v.id, pointIndex: null, pointIndices: [] });
  });
  await assertOwnSteps("bend", ui, (u) => JSON.stringify(u.node().path), async (u) => {
    // On the top edge's midpoint, with the bend modifier: alt/ctrl/meta or the
    // bend sub-tool, inside 14px of the segment interior.
    await u.drag([50, 0], [50, -24], { altKey: true });
  });
  await ui.close();
}

console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
process.exit(fail ? 1 : 0);
