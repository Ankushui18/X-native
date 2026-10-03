/** Vector-edit Lasso, point-box rotation, and Space-reposition integration tests. */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, localToWorld } from "../../engine/memory.ts";
import { pathToVectorNetwork } from "../../engine/geometry.ts";
import { pointBox, pointBoxHandles, rotatePointNetwork, translatePointNetwork } from "../pointBox.ts";
import { lassoSelectPathPoints, pointInLasso } from "../vectorLasso.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const window = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;
let paints = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({
    canvas: this,
    measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  }, {
    get(target, key) {
      return key in target ? target[key] : (...args) => paints.push([key, ...args]);
    },
  });
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830 });

async function mountCanvas(path, extra = {}) {
  const vector = node("vector", "Vector", 0, 0, 120, 120, {
    path: path.map((p) => ({ ...p })), closed: false,
    vectorNetwork: pathToVectorNetwork(path, false), ...extra,
  });
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(vector), guides: [], comments: [] }], page: 0,
    zoom: 1, panX: 0, panY: 0,
  });
  engine.dispatch({ type: "select", ids: [vector.id] });
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
    engine, host, surface, id: vector.id,
    snap: () => engine.snapshot(),
    node: () => find(engine.snapshot().pages[0].root, vector.id),
    async dispatch(cmd) { await act(async () => engine.dispatch(cmd)); },
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
      })));
    },
    async key(type, key, code = key) {
      await act(async () => document.body.dispatchEvent(new window.KeyboardEvent(type, {
        bubbles: true, cancelable: true, key, code,
      })));
    },
    async close() { await act(async () => reactRoot.unmount()); host.remove(); },
  };
  return ui;
}

// Pure selection and point-network transformations keep graph topology and
// attached control tangents while mapping through nested transforms.
{
  const root = page(node("frame", "Parent", 30, 20, 200, 200, { rotation: 35, flipH: true, children: [
    node("vector", "Child", 10, 15, 120, 120, {
      path: [{x:10,y:10,ox:10,oy:0},{x:50,y:10,ix:-10,iy:0},{x:90,y:50}],
      vectorNetwork: pathToVectorNetwork([{x:10,y:10,ox:10,oy:0},{x:50,y:10,ix:-10,iy:0},{x:90,y:50}], false),
    }),
  ] }));
  const child = root.children[0].children[0];
  const before = pointBox(root, child.id, [0, 1]);
  const rotated = rotatePointNetwork(root, child.id, before.network, before.indices, before.bounds, 90);
  const after0 = localToWorld(root, child.id, rotated.vertices[0].x, rotated.vertices[0].y);
  const after1 = localToWorld(root, child.id, rotated.vertices[1].x, rotated.vertices[1].y);
  const center = { x: before.bounds.x + before.bounds.w / 2, y: before.bounds.y + before.bounds.h / 2 };
  const rotateExpected = (p) => ({ x: center.x - (p.y - center.y), y: center.y + (p.x - center.x) });
  const old0 = localToWorld(root, child.id, before.network.vertices[0].x, before.network.vertices[0].y);
  const old1 = localToWorld(root, child.id, before.network.vertices[1].x, before.network.vertices[1].y);
  const exp0 = rotateExpected(old0), exp1 = rotateExpected(old1);
  t("point-box rotation maps selected vertices through rotated/flipped ancestors", near(after0.x, exp0.x) && near(after0.y, exp0.y) && near(after1.x, exp1.x) && near(after1.y, exp1.y));
  const oldOut = localToWorld(root, child.id, before.network.vertices[0].x + before.network.segments[0].tangentStart.x, before.network.vertices[0].y + before.network.segments[0].tangentStart.y);
  const newOut = localToWorld(root, child.id, rotated.vertices[0].x + rotated.segments[0].tangentStart.x, rotated.vertices[0].y + rotated.segments[0].tangentStart.y);
  const oldIn = localToWorld(root, child.id, before.network.vertices[1].x + before.network.segments[0].tangentEnd.x, before.network.vertices[1].y + before.network.segments[0].tangentEnd.y);
  const newIn = localToWorld(root, child.id, rotated.vertices[1].x + rotated.segments[0].tangentEnd.x, rotated.vertices[1].y + rotated.segments[0].tangentEnd.y);
  const expOut = rotateExpected(oldOut), expIn = rotateExpected(oldIn);
  t("point-box rotation rotates selected Bézier tangents in world space", near(newOut.x, expOut.x) && near(newOut.y, expOut.y) && near(newIn.x, expIn.x) && near(newIn.y, expIn.y));
  const shifted = translatePointNetwork(root, child.id, before.network, before.indices, 12, -7);
  const moved0 = localToWorld(root, child.id, shifted.vertices[0].x, shifted.vertices[0].y);
  t("Space translation is page-space under nested transforms", near(moved0.x, old0.x + 12) && near(moved0.y, old0.y - 7));
  t("unselected network vertices remain unchanged by point transforms", same(rotated.vertices[2], before.network.vertices[2]));
}
{
  const path = [
    {x:10,y:10,ox:10,oy:0},
    {x:50,y:10,ix:-10,iy:0},
    {x:90,y:10},
    {x:90,y:50},
  ];
  const poly = [{x:5,y:0},{x:60,y:0},{x:60,y:20},{x:5,y:20}];
  const world = (x,y) => ({x,y});
  const picked = lassoSelectPathPoints(path, false, poly, world);
  t("Lasso selects enclosed anchors and a path segment mostly inside", same(picked, [0,1]));
  t("lasso edges count as inside", pointInLasso({x:5,y:10}, poly));
  t("Shift-Lasso adds without duplicates", same(lassoSelectPathPoints(path, false, poly, world, [1,3], "add"), [0,1,3]));
  t("Alt-Lasso subtracts only hits", same(lassoSelectPathPoints(path, false, poly, world, [0,1,3], "subtract"), [3]));
  t("degenerate Lasso leaves the prior set alone", same(lassoSelectPathPoints(path, false, [{x:0,y:0},{x:1,y:1}], world, [2]), [2]));
}

// Mounted Lasso: Q toggles the affordance, the drag selects anchors/segments,
// modifiers add/subtract, and Escape returns to Select before exiting edit mode.
{
  const ui = await mountCanvas([{x:10,y:10},{x:50,y:10},{x:90,y:10},{x:90,y:50}]);
  await ui.dispatch({ type: "setVecEdit", id: ui.id, pointIndex: null, pointIndices: [] });
  await ui.key("keydown", "q");
  const lassoButton = ui.host.querySelector('button[aria-label="Lasso tool"]');
  t("Q activates the vector-edit Lasso affordance", !!lassoButton?.classList.contains("on"));
  const dragPolygon = async (points, modifiers = {}) => {
    await ui.mouse("mousedown", points[0].x, points[0].y, modifiers);
    for (const p of points.slice(1)) await ui.mouse("mousemove", p.x, p.y, modifiers);
    const end = points[points.length - 1];
    await ui.mouse("mouseup", end.x, end.y, modifiers);
  };
  await dragPolygon([{x:5,y:0},{x:60,y:0},{x:60,y:20},{x:5,y:20}]);
  t("freehand Lasso drag selects its enclosed vector points", same(ui.snap().vecPoints, [0,1]));
  await dragPolygon([{x:80,y:0},{x:100,y:0},{x:100,y:60},{x:80,y:60}], { shiftKey: true });
  t("Shift-Lasso adds the second point/path selection", same(ui.snap().vecPoints, [0,1,2,3]));
  await dragPolygon([{x:5,y:0},{x:60,y:0},{x:60,y:20},{x:5,y:20}], { altKey: true });
  t("Alt-Lasso subtracts the selected point range", same(ui.snap().vecPoints, [2,3]));
  await ui.key("keydown", "Escape", "Escape");
  t("first Escape exits Lasso but preserves vector-edit mode", ui.snap().vecEdit === ui.id && !lassoButton.classList.contains("on"));
  await ui.key("keydown", "Escape", "Escape");
  t("second Escape leaves vector-edit mode", ui.snap().vecEdit == null);
  await ui.close();
}

// Mounted point-box Shift-corner rotation is snapped to 15 degrees and commits
// one undoable network edit. Alt/Shift edge resize remains a separate gesture.
{
  const path = [{x:10,y:10},{x:50,y:10},{x:90,y:50}];
  const ui = await mountCanvas(path);
  await ui.dispatch({ type: "setVecEdit", id: ui.id, pointIndex: 0, pointIndices: [0,1] });
  const rootBefore = ui.snap().pages[0].root;
  const before = pointBox(rootBefore, ui.id, [0,1]);
  const originalWorld = before.network.vertices.map((v) => localToWorld(rootBefore, ui.id, v.x, v.y));
  const start = pointBoxHandles(before.bounds, 1)[0];
  const center = { x: before.bounds.x + before.bounds.w/2, y: before.bounds.y + before.bounds.h/2 };
  const startAngle = Math.atan2(start[1]-center.y, start[0]-center.x);
  const radius = Math.hypot(start[0]-center.x, start[1]-center.y);
  const targetAngle = startAngle + 17 * Math.PI/180;
  const target = { x: center.x + Math.cos(targetAngle)*radius, y: center.y + Math.sin(targetAngle)*radius };
  await ui.mouse("mousemove", start[0], start[1], { shiftKey: true });
  t("Shift-hover on a point-box corner advertises rotation", ui.surface.style.cursor.includes("url("));
  await ui.mouse("mousedown", start[0], start[1]);
  await ui.mouse("mousemove", target.x, target.y, { shiftKey: true });
  await ui.mouse("mouseup", target.x, target.y, { shiftKey: true });
  const expected = rotatePointNetwork(ui.snap().pages[0].root, ui.id, before.network, before.indices, before.bounds, 15);
  const actual = ui.node().vectorNetwork;
  t("Shift-dragging a point-box corner rotates the selected points", near(actual.vertices[0].x, expected.vertices[0].x) && near(actual.vertices[0].y, expected.vertices[0].y) && near(actual.vertices[1].x, expected.vertices[1].x) && near(actual.vertices[1].y, expected.vertices[1].y));
  t("point-box corner rotation preserves unselected points", same(actual.vertices[2], before.network.vertices[2]));
  const rotatedWorld = actual.vertices.map((v) => localToWorld(ui.snap().pages[0].root, ui.id, v.x, v.y));
  await ui.dispatch({ type: "setVecEdit", id: null });
  const normalizedWorld = ui.node().vectorNetwork.vertices.map((v) => localToWorld(ui.snap().pages[0].root, ui.id, v.x, v.y));
  t("exiting vector edit normalizes bounds without moving rotated output", rotatedWorld.every((p, i) => near(p.x, normalizedWorld[i].x) && near(p.y, normalizedWorld[i].y)));
  await ui.dispatch({ type: "undo" });
  const undoneWorld = ui.node().vectorNetwork.vertices.map((v) => localToWorld(ui.snap().pages[0].root, ui.id, v.x, v.y));
  t("one Undo restores the complete point-box rotation", undoneWorld.every((p, i) => near(p.x, originalWorld[i].x) && near(p.y, originalWorld[i].y)));
  await ui.close();
}

// Space temporarily moves points while a box transform is active. Releasing
// Space establishes a fresh resize baseline, so the next drag has no jump.
{
  const path = [{x:10,y:10},{x:50,y:10},{x:90,y:50}];
  const ui = await mountCanvas(path);
  await ui.dispatch({ type: "setVecEdit", id: ui.id, pointIndex: 0, pointIndices: [0,1] });
  const box = pointBox(ui.snap().pages[0].root, ui.id, [0,1]);
  const handle = pointBoxHandles(box.bounds, 1)[0];
  await ui.mouse("mousedown", handle[0], handle[1]);
  await ui.key("keydown", " ", "Space");
  await ui.mouse("mousemove", handle[0] + 20, handle[1] + 15);
  await ui.key("keyup", " ", "Space");
  await ui.mouse("mousemove", handle[0] + 30, handle[1] + 15);
  await ui.mouse("mouseup", handle[0] + 30, handle[1] + 15);
  const moved = ui.node().vectorNetwork.vertices;
  t("Space repositions selected anchors, then resize continues from the new baseline", near(moved[0].x, 40) && near(moved[0].y, 25) && near(moved[1].x, 70) && near(moved[1].y, 25));
  t("Space translation and resize leave unselected points alone", near(moved[2].x, 90) && near(moved[2].y, 50));
  await ui.dispatch({ type: "undo" });
  t("Space plus resize remains one undoable point-box gesture", same(ui.node().vectorNetwork.vertices.map(({x,y}) => ({x,y})), path));
  await ui.close();
}

console.log(`\nVector-edit tools: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
