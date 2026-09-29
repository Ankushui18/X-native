// Probe: frame interaction QA (selection overlay, handles, rotation, nesting).
// Instrument behind FRAME_INTERACTION_AUDIT_2026-09-29.md; prints measurements,
// asserts nothing. The regression suite is src/ui/__tests__/frameInteraction.dom.test.mjs.
// Run from apps/web: npx vite-node tests/probes/frames/interaction.mjs
import { installDom } from "../../../src/ui/__tests__/domEnv.mjs";
import { MemoryEngine, node, find, hitTest, localToWorld } from "../../../src/engine/memory.ts";
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const shape = (kind, name, children = [], extra = {}) => node(kind, name, 100, 100, 400, 400, { children, ...extra });
const window = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../../../src/ui/Canvas.tsx");
const { ThemeProvider } = await import("../../../src/ui/theme.tsx");
const { act, useSyncExternalStore } = React;
let paints = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({
    canvas: this,
    measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    getLineDash: () => [], createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
  }, { get(target, key) { return key in target ? target[key] : (...args) => paints.push([key, ...args]); } });
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830 });
async function mount(children, selection = [], view = {}) {
  const engine = new MemoryEngine(false, { pages: [{ id: "p", name: "Page", root: page(...children), guides: [], comments: [] }], page: 0, zoom: 1, panX: 0, panY: 0, ...view });
  engine.dispatch({ type: "select", ids: selection });
  function Host() { const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot()); return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap })); }
  const host = document.createElement("div"); document.body.appendChild(host);
  const reactRoot = createRoot(host); paints = [];
  await act(async () => reactRoot.render(React.createElement(Host)));
  const surface = host.querySelector(".canvas-wrap");
  const ui = {
    engine, host, surface, snap: () => engine.snapshot(), node: (id) => find(engine.snapshot().pages[0].root, id),
    async dispatch(cmd) { paints = []; await act(async () => engine.dispatch(cmd)); },
    async mouse(type, x, y, extra = {}) { await act(async () => surface.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra }))); },
    async drag(x0, y0, x1, y1, extra = {}) { await ui.mouse("mousedown", x0, y0, extra); await ui.mouse("mousemove", x0 + (x1 - x0) / 2, y0 + (y1 - y0) / 2, extra); await ui.mouse("mousemove", x1, y1, extra); await ui.mouse("mouseup", x1, y1, extra); },
    async close() { await act(async () => reactRoot.unmount()); host.remove(); },
  };
  return ui;
}
const rects = () => paints.filter(([c]) => c === "strokeRect").map(([, x, y, w, h]) => [x, y, w, h]);
const fmt = (n) => JSON.stringify({ x: n.x, y: n.y, w: n.w, h: n.h, rot: n.rotation });
const log = (...a) => console.log(...a);

// 1. Plain frame: handles & label
{
  const f = shape("frame", "Frame A", [], { x: 100, y: 100, w: 300, h: 200 });
  const ui = await mount([f], [f.id]);
  log("1 plain frame selection strokeRects:", rects().filter(([,,w,h]) => w > 100).slice(0, 3));
  const fillRects = paints.filter(([c]) => c === "fillRect").map(([, x, y, w, h]) => [x, y, w, h]).filter(([,,w]) => w === 7);
  log("   handle squares (7x7):", fillRects.length, fillRects);
  log("   label fillText:", paints.filter(([c]) => c === "fillText").map(([, s, x, y]) => [s, x, y]));
  // drag body -> move
  await ui.drag(250, 200, 300, 230);
  log("   after body drag:", fmt(ui.node(f.id)));
  // drag right edge handle -> resize
  const n = ui.node(f.id);
  await ui.drag(n.x + n.w, n.y + n.h / 2, n.x + n.w + 50, n.y + n.h / 2);
  log("   after right-edge drag:", fmt(ui.node(f.id)));
  // drag corner
  const m = ui.node(f.id);
  await ui.drag(m.x + m.w, m.y + m.h, m.x + m.w + 20, m.y + m.h + 30);
  log("   after BR corner drag:", fmt(ui.node(f.id)));
  // rotation handle
  const k = ui.node(f.id);
  await ui.drag(k.x + k.w / 2, k.y - 20, k.x + k.w, k.y + k.h / 2);
  log("   after rotate handle drag:", fmt(ui.node(f.id)));
  // corner drag when rotated: does a press at the corner's UNROTATED spot still resize? (should not)
  await ui.close();
}
// 2. child inside rotated parent frame
{
  const child = shape("rect", "Child", [], { x: 20, y: 20, w: 80, h: 40 });
  const parent = shape("frame", "Rotated parent", [child], { x: 100, y: 100, w: 300, h: 200, rotation: 90 });
  const ui = await mount([parent], [child.id]);
  log("2 child in 90deg parent — selection strokeRect(s):", rects());
  log("   ctx.rotate calls:", paints.filter(([c]) => c === "rotate").map(([, a]) => +(a * 180 / Math.PI).toFixed(1)));
  // World position of child: parent rotates about (250,200). local(20..100, 20..60) -> world x = 250 - (ly-100) ... compute via hitTest
  const hitAtDrawn = hitTest(ui.snap().pages[0].root, 120 + 40, 120 + 20, { deep: true });
  log("   hitTest at UNrotated child spot (160,140):", hitAtDrawn?.name);
  // rotated: local (60,40) -> world (250 + (200-... let's brute-force search
  let found = null;
  for (let x = 0; x < 600 && !found; x += 5) for (let y = 0; y < 600 && !found; y += 5) { const h = hitTest(ui.snap().pages[0].root, x, y, { deep: true }); if (h && h.id === child.id) found = [x, y]; }
  log("   actual painted child hit found near:", found);
  // Try dragging the child from its true painted position
  await ui.drag(310, 110, 340, 110);
  log("   after +30px screen-x drag from painted centre (expect local y 20->-10):", fmt(ui.node(child.id)), "selection:", ui.snap().selection.map((id) => ui.node(id).name));
  // resize: grab the child's local right-edge midpoint where it is painted and pull it 20px further along local +x
  const L2W = (lx, ly) => localToWorld(ui.snap().pages[0].root, child.id, lx, ly);
  let e0 = L2W(80, 20), e1 = L2W(100, 20);
  await ui.mouse("mousemove", e0.x, e0.y);
  log("   cursor at painted right-edge midpoint", [e0.x, e0.y], "→", ui.surface.style.cursor.slice(0, 30));
  await ui.drag(e0.x, e0.y, e1.x, e1.y);
  log("   after dragging painted right edge +20 along local x (expect w 100, x,y unchanged):", fmt(ui.node(child.id)));
  // rotate: press in the corner rotation zone (outside TL by 15px along both local axes), then move to the TR side
  const c = L2W(50, 20);
  const p0 = L2W(-11, -11), p1 = L2W(111, -11);
  await ui.mouse("mousedown", p0.x, p0.y); await ui.mouse("mousemove", (p0.x + p1.x) / 2, (p0.y + p1.y) / 2); await ui.mouse("mousemove", p1.x, p1.y); await ui.mouse("mouseup", p1.x, p1.y);
  log("   after rotating TL-zone → TR-zone around centre", [c.x, c.y], "(expect own rot ≈ +90 → 80x40 box: angle between diagonal-ish points, ~65°):", fmt(ui.node(child.id)));
  await ui.close();
}
// 2b. flipped parent
{
  const child = shape("rect", "FChild", [], { x: 20, y: 20, w: 80, h: 40 });
  const parent = shape("frame", "Flipped parent", [child], { x: 100, y: 100, w: 300, h: 200, flipH: true });
  const ui = await mount([parent], [child.id]);
  log("2b child in flipH parent — selection strokeRect:", rects()[0], "(expect x=300.5: local 20..100 mirrored → 300..380)");
  await ui.drag(340, 140, 370, 140, { metaKey: true });
  log("   after +30 screen-x drag (expect local x 20->-10):", fmt(ui.node(child.id)));
  await ui.close();
}
// 3. nested frames: labels visible?
{
  const inner2 = shape("frame", "Inner 2", [], { x: 10, y: 10, w: 50, h: 40 });
  const inner = shape("frame", "Inner", [inner2], { x: 20, y: 20, w: 200, h: 150 });
  const outer = shape("frame", "Outer", [inner], { x: 100, y: 100, w: 400, h: 300 });
  const ui = await mount([outer]);
  const names = () => paints.filter(([c]) => c === "fillText").map(([, s]) => s);
  log("3 nested frame labels (nothing selected):", names());
  await ui.dispatch({ type: "select", ids: [outer.id] });
  log("   outer selected:", names());
  await ui.dispatch({ type: "select", ids: [inner.id] });
  log("   inner selected:", names());
  await ui.dispatch({ type: "select", ids: [] });
  await ui.mouse("mousemove", 120, 120);
  log("   hover inner:", names());
  await ui.close();
}
// 4. Auto Layout frame: which handles/controls drawn?
{
  const a = shape("rect", "A", [], { x: 0, y: 0, w: 50, h: 50 });
  const b = shape("rect", "B", [], { x: 0, y: 0, w: 50, h: 50 });
  const f = shape("frame", "AL", [a, b], { x: 100, y: 100, w: 300, h: 200, layout: { direction: "horizontal", gap: 10, padding: [10, 10, 10, 10], align: "start", justify: "start" }, sizingW: "hug", sizingH: "hug" });
  const ui = await mount([f], [f.id]);
  const fillRects = paints.filter(([c]) => c === "fillRect").map(([, x, y, w, h]) => [x, y, w, h]).filter(([,,w]) => w === 7);
  log("4 AL hug frame:", fmt(ui.node(f.id)), "handles:", fillRects.length);
  const n = ui.node(f.id);
  await ui.drag(n.x + n.w, n.y + n.h / 2, n.x + n.w + 60, n.y + n.h / 2);
  log("   after edge drag on hug frame:", fmt(ui.node(f.id)), "sizingW:", ui.node(f.id).sizingW);
  await ui.close();
}
// 5. Frame with constraints child, resize parent
{
  const c = shape("rect", "Pinned R", [], { x: 200, y: 20, w: 50, h: 50, constraints: { h: "max", v: "min" } });
  const f = shape("frame", "Constr", [c], { x: 100, y: 100, w: 300, h: 200 });
  const ui = await mount([f], [f.id]);
  await ui.drag(400, 200, 500, 200);
  log("5 constraints: frame", fmt(ui.node(f.id)), "child", fmt(ui.node(c.id)));
  await ui.close();
}
// 6. rotated frame: resize handle hit at rotated location; and body drag at rotated location
{
  const f = shape("frame", "Rot45", [], { x: 100, y: 100, w: 300, h: 200, rotation: 45 });
  const ui = await mount([f], [f.id]);
  // right edge midpoint in rotated space: center (250,200), local offset (150,0) rotated 45 -> (106.07,106.07)
  const hx = 250 + 106.07, hy = 200 + 106.07;
  await ui.mouse("mousemove", hx, hy);
  log("6 rotated frame cursor at rotated right-edge:", ui.surface.style.cursor.slice(0, 40));
  await ui.drag(hx, hy, hx + 35.36, hy + 35.36);
  log("   after rotated right-edge drag (+50 along axis):", fmt(ui.node(f.id)));
  // press at unrotated right-edge spot: should NOT resize (it's empty/inside)
  const before = fmt(ui.node(f.id));
  await ui.drag(400 + 0, 200, 450, 200);
  log("   drag at unrotated edge spot: before", before, "after", fmt(ui.node(f.id)));
  await ui.close();
}
// 7. multi-selection transform
{
  const a = shape("rect", "A", [], { x: 100, y: 100, w: 100, h: 100 });
  const b = shape("rect", "B", [], { x: 300, y: 100, w: 100, h: 100 });
  const c = shape("frame", "C", [], { x: 100, y: 300, w: 100, h: 100 });
  const ui = await mount([a, b, c], [a.id, b.id, c.id]);
  const fillRects = paints.filter(([cc]) => cc === "fillRect").map(([, x, y, w, h]) => [x, y, w, h]).filter(([,,w]) => w <= 7);
  log("7 multi handles:", fillRects.length, "rects:", rects().length);
  await ui.drag(400, 400, 450, 450);
  log("   after BR multi-resize:", fmt(ui.node(a.id)), fmt(ui.node(b.id)), fmt(ui.node(c.id)));
  await ui.drag(150, 150, 170, 160);
  log("   after multi move:", fmt(ui.node(a.id)), fmt(ui.node(b.id)), fmt(ui.node(c.id)));
  // rotate multi: corner rotation zone (8..22 px outside corner)
  await ui.drag(470 + 12, 460 + 12, 300, 470 + 60);
  log("   after multi rotate:", fmt(ui.node(a.id)), fmt(ui.node(b.id)), fmt(ui.node(c.id)));
  await ui.close();
}
process.exit(0);
