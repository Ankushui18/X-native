/** Frame interaction QA (2026-09-29 audit): the selection chrome, handle
 * hit-testing and drag maths must land where a layer is *painted*, including
 * every ancestor's rotation / flip - and a resize handle must always outrank
 * the corner rotation ring. Mounted Canvas, real mouse events, recorded paint
 * calls (jsdom: interaction wiring, not browser pixels). */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, hitTest, localToWorld, worldPlacement, worldPos, worldDeltaToParent, worldPointToParent, parentHandedness } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const shape = (kind, name, children = [], extra = {}) => node(kind, name, 100, 100, 400, 400, { children, ...extra });

// ---------------------------------------------------------------- engine
{
  const child = node("rect", "Child", 20, 20, 80, 40, {});
  const parent = node("frame", "P", 100, 100, 300, 200, { children: [child], rotation: 90 });
  const root = page(parent);
  const wp = worldPlacement(root, child.id);
  // Parent turns about (250,200); child centre local (60,40) → world (310,110).
  t("worldPlacement centres a child of a 90° frame where it is painted", near(wp.x + 40, 310) && near(wp.y + 20, 110), JSON.stringify(wp));
  t("worldPlacement reports the total rotation", near(wp.node.rotation, 90));
  t("worldPlacement never mutates the document", find(root, child.id).rotation === 0 && find(root, child.id).x === 20);
  t("worldPos stays a translation-only offset for the engine", worldPos(root, child.id).x === 120 && worldPos(root, child.id).node === child);
  t("placement agrees with hitTest", hitTest(root, 310, 110, { deep: true }) === child && hitTest(root, 160, 140, { deep: true }) !== child);
  const d = worldDeltaToParent(root, child.id, 30, 0);
  t("a +30 screen-x drag is a -30 local-y move under a 90° parent", near(d.dx, 0) && near(d.dy, -30), JSON.stringify(d));
  const p = worldPointToParent(root, child.id, 310, 110);
  t("world→parent point lands on the child's local centre", near(p.x, 60) && near(p.y, 40), JSON.stringify(p));
  t("rotation-only ancestry keeps handedness", parentHandedness(root, child.id) === 1);
  parent.rotation = 0;
  parent.flipH = true;
  const fp = worldPlacement(root, child.id);
  t("flipped parent mirrors the placement (local 20..100 → world 300..380)", near(fp.x, 300) && fp.node.flipH === true, JSON.stringify(fp));
  t("flipped ancestry inverts handedness", parentHandedness(root, child.id) === -1);
  const fd = worldDeltaToParent(root, child.id, 30, 0);
  t("a +30 screen-x drag is a -30 local-x move under a flipped parent", near(fd.dx, -30) && near(fd.dy, 0));
  parent.flipH = false;
  const same = worldPlacement(root, child.id);
  t("plain ancestry returns the real node untouched", same.node === child && same.x === 120 && same.y === 120);
  const top = worldPlacement(root, parent.id);
  t("a top-level layer is its own placement", top.node === parent && top.x === 100);
  // Nested rotation composes: 30° inside 60° reads as 90°.
  parent.rotation = 60;
  child.rotation = 30;
  t("nested angles add", near(worldPlacement(root, child.id).node.rotation, 90));
  // The engine's world-delta move.
  child.rotation = 0;
  parent.rotation = 90;
  const eng = new MemoryEngine(false, { pages: [{ id: "p", name: "Page", root, guides: [], comments: [] }], page: 0, zoom: 1, panX: 0, panY: 0 });
  eng.dispatch({ type: "move", ids: [child.id], dx: 30, dy: 0, world: true });
  let c = find(eng.snapshot().pages[0].root, child.id);
  t("move{world} follows the pointer inside a rotated frame", c.x === 20 && c.y === -10, JSON.stringify({ x: c.x, y: c.y }));
  eng.dispatch({ type: "move", ids: [child.id], dx: 30, dy: 0 });
  c = find(eng.snapshot().pages[0].root, child.id);
  t("plain move keeps its parent-local meaning", c.x === 50 && c.y === -10);
}

// ---------------------------------------------------------------- mounted canvas
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

async function mount(children, selection = [], view = {}) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(...children), guides: [], comments: [] }], page: 0,
    zoom: 1, panX: 0, panY: 0, ...view,
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
    root: () => engine.snapshot().pages[0].root,
    node: (id) => find(engine.snapshot().pages[0].root, id),
    world: (id, lx, ly) => localToWorld(engine.snapshot().pages[0].root, id, lx, ly),
    commands: [],
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
      })));
    },
    async drag(x0, y0, x1, y1, extra = {}) {
      const orig = engine.dispatch.bind(engine);
      ui.commands = [];
      engine.dispatch = (cmd) => { ui.commands.push(cmd); return orig(cmd); };
      await ui.mouse("mousedown", x0, y0, extra);
      await ui.mouse("mousemove", (x0 + x1) / 2, (y0 + y1) / 2, extra);
      await ui.mouse("mousemove", x1, y1, extra);
      await ui.mouse("mouseup", x1, y1, extra);
      engine.dispatch = orig;
    },
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
  return ui;
}
const box = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation });
const selectionRects = () => paints.filter(([c, , , w, h]) => c === "strokeRect" && w > 12 && h > 12).map(([, x, y, w, h]) => [x, y, w, h]);
const handleSquares = () => paints.filter(([c, , , w]) => c === "fillRect" && (w === 6 || w === 7)).map(([, x, y, w, h]) => [x, y, w, h]);

// A child of an unrotated but offset frame: the most common resize there is.
{
  const child = node("rect", "Child", 50, 50, 100, 80, {});
  const parent = node("frame", "P", 200, 100, 400, 300, { children: [child] });
  const ui = await mount([parent], [child.id]);
  await ui.drag(350, 190, 400, 190); // right-edge midpoint, +50
  t("nested child resize measures the drag in its parent's space (+50 → w 150, not 350)", ui.node(child.id).w === 150 && ui.node(child.id).x === 50, JSON.stringify(box(ui.node(child.id))));
  await ui.drag(250, 150, 270, 160); // top-left corner
  const c = ui.node(child.id);
  t("nested child corner resize keeps the opposite corner pinned", c.x === 70 && c.y === 60 && c.w === 130 && c.h === 70, JSON.stringify(box(c)));
  await ui.drag(330, 200, 360, 220, { metaKey: true }); // body, ⌘ skips snapping
  t("nested child body drag moves without resizing", ui.node(child.id).x === 100 && ui.node(child.id).y === 80 && ui.node(child.id).w === 130, JSON.stringify(box(ui.node(child.id))));
  await ui.close();
}

// A child of a 90° frame: painted at world (290..330, 70..150).
{
  const child = node("rect", "Child", 20, 20, 80, 40, {});
  const parent = node("frame", "Rotated parent", 100, 100, 300, 200, { children: [child], rotation: 90 });
  const ui = await mount([parent], [child.id]);
  const [sel] = selectionRects();
  const rotations = paints.filter(([c]) => c === "rotate").map(([, a]) => Math.round((a * 180) / Math.PI));
  t("selection box is drawn about the painted centre (310,110)", sel && near(sel[0] + sel[2] / 2, 310, 0.5) && near(sel[1] + sel[3] / 2, 110, 0.5), JSON.stringify(sel));
  t("selection box turns with the parent", rotations.includes(90), JSON.stringify(rotations));
  t("no stale outline at the unrotated spot (120,120)", !selectionRects().some(([x, y]) => near(x, 120.5) && near(y, 120.5)));
  t("shape shows 8 resize handles and no centre handle", handleSquares().length === 8 && !handleSquares().some(([x, y]) => near(x + 3, 310) && near(y + 3, 110)));

  await ui.mouse("mousemove", 310, 110);
  t("hovering the painted child does not advertise a resize", !/resize/.test(ui.surface.style.cursor));
  await ui.drag(310, 110, 340, 110, { metaKey: true });
  t("dragging the painted child +30 screen-x moves it -30 along its local y", ui.node(child.id).x === 20 && ui.node(child.id).y === -10, JSON.stringify(box(ui.node(child.id))));
  t("the drag stayed a move (no resize/patch)", ui.commands.some((c) => c.type === "move" && c.world) && !ui.commands.some((c) => c.type === "resize"));
  t("manipulating the child did not change the selection", ui.engine.snapshot().selection.length === 1 && ui.engine.snapshot().selection[0] === child.id);

  const e0 = ui.world(child.id, 80, 20);
  const e1 = ui.world(child.id, 100, 20);
  await ui.mouse("mousemove", e0.x, e0.y);
  t("hover over the painted right-edge handle shows a screen-axis resize cursor", ui.surface.style.cursor === "ns-resize", ui.surface.style.cursor);
  await ui.drag(e0.x, e0.y, e1.x, e1.y);
  t("press on that handle resizes (does not rotate)", ui.commands.some((c) => c.type === "resize") && !ui.commands.some((c) => c.type === "patch" && "rotation" in (c.patch ?? {})), JSON.stringify(ui.commands.map((c) => c.type)));
  t("dragging the painted right edge +20 along local x grows w 80→100 with x,y fixed", ui.node(child.id).w === 100 && ui.node(child.id).x === 20 && ui.node(child.id).y === -10 && ui.node(child.id).h === 40, JSON.stringify(box(ui.node(child.id))));

  // Rotation: press in the corner ring outside the TL corner, sweep to the
  // ring outside the TR corner; the angle swept about the centre is what the
  // layer's own rotation gains (the parent is not mirrored).
  const c0 = ui.world(child.id, 50, 20);
  const p0 = ui.world(child.id, -11, -11);
  const p1 = ui.world(child.id, 111, -11);
  const expected = Math.round(((Math.atan2(p1.y - c0.y, p1.x - c0.x) - Math.atan2(p0.y - c0.y, p0.x - c0.x)) * 180) / Math.PI);
  await ui.mouse("mousedown", p0.x, p0.y);
  await ui.mouse("mousemove", c0.x, p0.y - 40);
  await ui.mouse("mousemove", p1.x, p1.y);
  await ui.mouse("mouseup", p1.x, p1.y);
  const r = ui.node(child.id);
  t(`rotating on screen adds the swept angle (${expected}°) to the layer's own rotation`, Math.abs(r.rotation - expected) <= 1, JSON.stringify(box(r)));
  t("rotation about the centre leaves the box in place", r.x === 20 && r.y === -10 && r.w === 100 && r.h === 40, JSON.stringify(box(r)));
  t("the parent's own rotation is untouched", ui.node(parent.id).rotation === 90);
  await ui.close();
}

// A child of a horizontally flipped frame.
{
  const child = node("rect", "FChild", 20, 20, 80, 40, {});
  const parent = node("frame", "Flipped parent", 100, 100, 300, 200, { children: [child], flipH: true });
  const ui = await mount([parent], [child.id]);
  const [sel] = selectionRects();
  t("selection box is drawn at the mirrored position (world x 300)", sel && near(sel[0], 300.5), JSON.stringify(sel));
  await ui.drag(340, 140, 370, 140, { metaKey: true });
  t("dragging right on screen moves the child left in its mirrored parent", ui.node(child.id).x === -10 && ui.node(child.id).y === 20, JSON.stringify(box(ui.node(child.id))));
  await ui.close();
}

// Handle priority on a small top-level shape: 80×40 puts every edge-midpoint
// handle 20px from a corner, inside the 8-22px rotation ring.
{
  const r = node("rect", "Small", 100, 100, 80, 40, {});
  const ui = await mount([r], [r.id]);
  await ui.mouse("mousemove", 180, 120);
  const cursor = ui.surface.style.cursor;
  await ui.drag(180, 120, 200, 120);
  t("small shape: the hover cursor at an edge handle promises a resize", cursor === "ew-resize", cursor);
  t("small shape: the press honours that promise (resize, not rotate)", ui.commands.some((c) => c.type === "resize") && ui.node(r.id).rotation === 0 && ui.node(r.id).w === 100, JSON.stringify(box(ui.node(r.id))));
  await ui.drag(100 - 14, 100 - 14, 200, 60);
  t("small shape: the ring outside a corner still rotates", ui.node(r.id).rotation !== 0 && ui.commands.some((c) => c.type === "patch" && "rotation" in c.patch), JSON.stringify(box(ui.node(r.id))));
  await ui.close();
}

// Frame chrome: detached rotation handle, no centre handle, corners never rotate.
{
  const f = shape("frame", "Frame A", [], { x: 100, y: 100, w: 300, h: 200 });
  const ui = await mount([f], [f.id]);
  const hs = handleSquares();
  t("frame shows exactly 8 handles", hs.length === 8, String(hs.length));
  t("frame has no centre handle", !hs.some(([x, y]) => near(x + 3.5, 250) && near(y + 3.5, 200)));
  t("frame's rotation affordance is detached above the top edge", paints.some(([c, x, y, rad]) => c === "arc" && x === 250 && y === 80 && rad === 5));
  await ui.drag(100 - 14, 100 - 14, 200, 60);
  t("the ring outside a frame corner does not rotate it", ui.node(f.id).rotation === 0 && !ui.commands.some((c) => c.type === "patch" && "rotation" in (c.patch ?? {})));
  await ui.drag(250, 200, 300, 230, { metaKey: true });
  t("dragging a frame's body moves it without resizing", ui.node(f.id).x === 150 && ui.node(f.id).y === 130 && ui.node(f.id).w === 300 && ui.node(f.id).h === 200, JSON.stringify(box(ui.node(f.id))));
  await ui.close();
}

// A rotated top-level frame: the rotation readout is the layer's own angle and
// the resize handles live on the turned edges.
{
  const f = shape("frame", "Rot45", [], { x: 100, y: 100, w: 300, h: 200, rotation: 45 });
  const ui = await mount([f], [f.id]);
  const hx = 250 + 150 * Math.SQRT1_2, hy = 200 + 150 * Math.SQRT1_2; // turned right-edge midpoint
  await ui.mouse("mousemove", 400, 200); // where the edge would be unrotated: empty canvas
  t("unrotated edge position of a rotated frame is not a handle", !/resize/.test(ui.surface.style.cursor), ui.surface.style.cursor);
  await ui.drag(hx, hy, hx + 50 * Math.SQRT1_2, hy + 50 * Math.SQRT1_2);
  t("rotated frame resizes along its own axis (+50 → w 350)", ui.node(f.id).w === 350 && ui.node(f.id).rotation === 45, JSON.stringify(box(ui.node(f.id))));
  await ui.close();
}

// Top-level frame names only: nested frames stay quiet until selected.
{
  const inner2 = shape("frame", "Inner 2", [], { x: 10, y: 10, w: 50, h: 40 });
  const inner = shape("frame", "Inner", [inner2], { x: 20, y: 20, w: 200, h: 150 });
  const outer = shape("frame", "Outer", [inner], { x: 100, y: 100, w: 400, h: 300 });
  const ui = await mount([outer]);
  const names = () => paints.filter(([c]) => c === "fillText").map(([, s]) => s).filter((s) => /^(Outer|Inner|Inner 2)$/.test(s));
  t("idle canvas labels only the top-level frame", names().join() === "Outer", names().join());
  paints = [];
  await act(async () => ui.engine.dispatch({ type: "select", ids: [inner.id] }));
  t("selecting a nested frame adds only its own label", new Set(names()).size === 2 && names().includes("Inner") && !names().includes("Inner 2"), names().join());
  await ui.close();
}

console.log(`frameInteraction: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
