/** Run 21: gradient canvas handles (audit P1 #9) — the seven interaction
 *  categories, end to end.
 *
 *  AUDIT (what already existed vs what this run added):
 *  · EXISTING — direct axis line + endpoint circles (r6) + interior stop dots
 *    (r4.5) painted on the selected layer; mousedown hit-tests for stops (r9,
 *    clamped between neighbours) and endpoints (r8, snapped to edges/centre,
 *    ⇧ constrains the angle); hover cursors; FillPicker's bar editor with
 *    insert/remove, the "Flip gradient direction" button and the "Rotate
 *    gradient" button; all bound to the same node fields the canvas reads, so
 *    the inspector sync is bidirectional by construction.
 *  · ADDED — (a) double-click on the axis inserts an interpolated stop;
 *    (b) right-click on a stop dot deletes it (two-stop floor, menu stays
 *    closed — the click was the action); (c) midpoint handles between every
 *    adjacent stop pair, backed by `gradientMidpoints` and rendered through
 *    the ramp's eased interpolation; (d) a radial focal ring (fillFX/fillFY)
 *    that both paints and renders (two-circle radial) with the centre still
 *    independently draggable.
 *
 *  jsdom + recorded paints: interaction wiring and paint-call geometry, not
 *  browser pixels.
 *
 *  Run with:  npx vite-node src/ui/__tests__/gradientCanvasHandles.test.mjs
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, localToWorld } from "../../engine/memory.ts";
import { gradTarget, mixHex } from "../../engine/paint.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const near = (a, b, eps = 0.001) => Math.abs(a - b) <= eps;
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });

// ═══════════════════════════ model-level (gradTarget) ═══════════════════════
console.log("gradTarget resolves focal + midpoints");
{
  const linear = node("rect", "L", 0, 0, 100, 100, {
    fill: "#ff0000", fillB: "#0000ff", fillType: "linear",
    fillGX: 0, fillGY: 0.5, fillHX: 1, fillHY: 0.5,
    gradientStops: [
      { color: "#ff0000", position: 0 },
      { color: "#00ff00", position: 0.5 },
      { color: "#0000ff", position: 1 },
    ],
    gradientMidpoints: [0.7, 0.5],
  });
  const gl = gradTarget(linear);
  t("model: midpoints ride on the resolved ramp", JSON.stringify(gl.mids) === JSON.stringify([0.7, 0.5]));
  const radial = node("rect", "R", 0, 0, 100, 100, {
    fill: "#ff0000", fillB: "#0000ff", fillType: "radial",
    fillGX: 0.4, fillGY: 0.6, fillHX: 0.4, fillHY: 1, fillFX: 0.2, fillFY: 0.3,
  });
  const gr = gradTarget(radial);
  t("model: focal resolves from fillFX/fillFY", near(gr.fx, 0.2) && near(gr.fy, 0.3), JSON.stringify([gr.fx, gr.fy]));
  const plain = node("rect", "P", 0, 0, 100, 100, { fill: "#ff0000", fillB: "#0000ff", fillType: "radial" });
  const gp = gradTarget(plain);
  t("model: unauthored focal defaults to the centre", near(gp.fx, gp.gx) && near(gp.fy, gp.gy));
}

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
      createLinearGradient: (...a) => {
        paints.push(["createLinearGradient", ...a]);
        return { addColorStop: (p, c) => paints.push(["addColorStop", p, c]) };
      },
      createRadialGradient: (...a) => {
        paints.push(["createRadialGradient", ...a]);
        return { addColorStop: (p, c) => paints.push(["addColorStop", p, c]) };
      },
      createConicGradient: (...a) => {
        paints.push(["createConicGradient", ...a]);
        return { addColorStop: (p, c) => paints.push(["addColorStop", p, c]) };
      },
    },
    { get: (target, key) => (key in target ? target[key] : (...args) => paints.push([key, ...args])) },
  );
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830,
});

const LEFT = 50, TOP = 30;
/** A 200×100 rect at (100,100) with a horizontal three-stop ramp: the axis
 *  runs world (100,150) → (300,150); stops sit at x = 100/200/300 and the
 *  default midpoints at x = 150/250. The engine revives the seed, so all
 *  reads go through ui.node(id). */
const GRAD = (extra = {}) =>
  node("rect", "Grad", 100, 100, 200, 100, {
    fill: "#ff0000",
    fillB: "#0000ff",
    fillType: "linear",
    fillGX: 0,
    fillGY: 0.5,
    fillHX: 1,
    fillHY: 0.5,
    gradientStops: [
      { color: "#ff0000", position: 0 },
      { color: "#00ff00", position: 0.5 },
      { color: "#0000ff", position: 1 },
    ],
    ...extra,
  });

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
    async dbl(x, y, extra = {}) {
      await act(async () =>
        surface.dispatchEvent(new window.MouseEvent("dblclick", {
          bubbles: true, cancelable: true, clientX: x + LEFT, clientY: y + TOP, button: 0, ...extra,
        })));
    },
    async ctx(x, y, extra = {}) {
      await act(async () =>
        surface.dispatchEvent(new window.MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: x + LEFT, clientY: y + TOP, button: 2, ...extra,
        })));
    },
    async dispatch(cmd) { await act(async () => engine.dispatch(cmd)); },
    async close() { await act(async () => reactRoot.unmount()); host.remove(); },
  };
  return ui;
}

const arcs = (tail, r) => tail.filter(([c, , , rad]) => c === "arc" && (r == null || rad === r));
const squares = (tail) =>
  tail.filter(([c, , , w, h]) => c === "fillRect" && w === 5 && h === 5).map(([, x, y]) => [x, y]);
const lines = (tail) => {
  let out = [];
  for (let i = 0; i < tail.length - 1; i++) {
    if (tail[i][0] === "moveTo" && tail[i + 1][0] === "lineTo") out.push([tail[i][1], tail[i][2], tail[i + 1][1], tail[i + 1][2]]);
  }
  return out;
};
const positions = (n) => (n.gradientStops ?? []).map((s) => Math.round(s.position * 1e4) / 1e4);

// ─────────────────────── 1 · direct handles ───────────────────────
console.log("1 · direct handles: line, endpoints, stops, midpoints");
{
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  const m0 = ui.marker();
  await ui.dispatch({ type: "select", ids: [g.id] }); // force a repaint tick
  const tail = ui.tail(m0);
  t("1-handles: the axis line is painted end to end",
    lines(tail).some(([x0, y0, x1, y1]) => near(x0, 100) && near(y0, 150) && near(x1, 300) && near(y1, 150)),
    JSON.stringify(lines(tail).slice(0, 3)));
  t("1-handles: both endpoint circles (r6) sit on the axis",
    arcs(tail, 6).some(([, x, y]) => near(x, 100) && near(y, 150)) &&
    arcs(tail, 6).some(([, x, y]) => near(x, 300) && near(y, 150)),
    JSON.stringify(arcs(tail, 6)));
  t("1-handles: the interior stop dot (r4.5) is painted at its ramp position",
    arcs(tail, 4.5).some(([, x, y]) => near(x, 200) && near(y, 150)),
    JSON.stringify(arcs(tail, 4.5)));
  const sq = squares(tail);
  t("1-handles: midpoint squares sit between every adjacent stop pair",
    sq.some(([x, y]) => near(x, 147.5) && near(y, 147.5)) &&
    sq.some(([x, y]) => near(x, 247.5) && near(y, 147.5)),
    JSON.stringify(sq));
  await ui.close();
  // Control: nothing paints without a selection.
  const g2 = GRAD();
  const ui2 = await mount([g2], []);
  const m1 = ui2.marker();
  await ui2.dispatch({ type: "select", ids: [] });
  const tail2 = ui2.tail(m1);
  t("1-handles: no gradient chrome without a selection",
    lines(tail2).filter(([x0, y0, x1, y1]) => near(y0, 150) && near(y1, 150) && x0 === 100).length === 0 &&
    arcs(tail2, 6).length === 0,
    JSON.stringify({ lines: lines(tail2).length, arcs6: arcs(tail2, 6).length }));
  await ui2.close();
}

// ─────────────────────── 2 · stop handles ───────────────────────
console.log("2 · stops: drag, double-click adds, right-click deletes");
{
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  const box0 = { x: ui.node(g.id).x, y: ui.node(g.id).y, w: ui.node(g.id).w, h: ui.node(g.id).h };
  // Drag the middle stop along the axis: 0.5 → 0.75, neighbours pinned.
  const d0 = ui.dispatches.length;
  await ui.drag(200, 150, 250, 150);
  const n1 = ui.node(g.id);
  const cmds = ui.dispatches.slice(d0).map((c) => c.type);
  t("2-stop-drag: the stop follows the pointer along the axis",
    positions(n1)[1] === 0.75 && n1.gradientStops.length === 3, JSON.stringify(positions(n1)));
  t("2-stop-drag: neighbour stops and the layer box stay put",
    positions(n1)[0] === 0 && positions(n1)[2] === 1 &&
    n1.x === box0.x && n1.y === box0.y && n1.w === box0.w && n1.h === box0.h,
    JSON.stringify({ pos: positions(n1), box: [n1.x, n1.y, n1.w, n1.h] }));
  t("2-stop-drag: one history gesture (begin … end)",
    cmds.includes("begin") && cmds[cmds.length - 1] === "end" && cmds.filter((c) => c === "begin").length === 1,
    JSON.stringify(cmds));
  // Double-click ON the axis adds a stop in the ramp's colour there.
  await ui.dbl(170, 150);
  const n2 = ui.node(g.id);
  const expectColor = mixHex("#ff0000", "#00ff00", (0.35 - 0) / (0.75 - 0));
  t("2-insert: double-click on the axis inserts an interpolated stop",
    n2.gradientStops.length === 4 && near(positions(n2)[1], 0.35, 1e-9) &&
    n2.gradientStops[1].color.toLowerCase() === expectColor.toLowerCase(),
    JSON.stringify({ pos: positions(n2), colors: n2.gradientStops.map((s) => s.color) }));
  // The insert is one undo step.
  await ui.dispatch({ type: "undo" });
  t("2-insert: one undo removes the inserted stop again",
    ui.node(g.id).gradientStops.length === 3, JSON.stringify(positions(ui.node(g.id))));
  await ui.close();
}
{
  // Right-click on a stop dot deletes it; the menu does not open. A click
  // away from any stop still opens the normal canvas menu.
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  await ui.ctx(200, 150); // the interior stop dot at ramp position 0.5
  t("2-delete: right-click on a stop dot deletes that stop",
    ui.node(g.id).gradientStops.length === 2 && positions(ui.node(g.id)).join() === "0,1",
    JSON.stringify(positions(ui.node(g.id))));
  t("2-delete: the canvas menu stays closed — the click was the action",
    !document.querySelector(".ctx"), JSON.stringify(document.body.innerHTML.slice(0, 60)));
  await ui.close();
}
{
  // Control: two-stop floor + menu opens off-stop.
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  await ui.ctx(210, 180); // on the layer, far from every handle
  t("2-delete-control: right-click off any stop opens the canvas menu",
    !!document.querySelector(".ctx") && ui.node(g.id).gradientStops.length === 3,
    JSON.stringify({ menu: !!document.querySelector(".ctx"), stops: positions(ui.node(g.id)) }));
  await ui.close();
  // Two-stop floor: with only the legacy pair, the interior is empty —
  // nothing to delete, menu opens.
  const g2 = node("rect", "Two", 100, 100, 200, 100, {
    fill: "#ff0000", fillB: "#0000ff", fillType: "linear",
    fillGX: 0, fillGY: 0.5, fillHX: 1, fillHY: 0.5,
  });
  const ui2 = await mount([g2], [g2.id]);
  await ui2.ctx(200, 150); // dead centre of a two-stop ramp: no interior dot
  t("2-delete-floor: a two-stop ramp keeps both stops and opens the menu",
    !!document.querySelector(".ctx") && ui2.node(g2.id).gradientStops.length === 0,
    JSON.stringify({ menu: !!document.querySelector(".ctx"), stops: positions(ui2.node(g2.id)) }));
  await ui2.close();
}

// ─────────────────────── 3 · midpoint handle ───────────────────────
console.log("3 · midpoints: drag adjusts interpolation, pair untouched");
{
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  const box0 = [ui.node(g.id).x, ui.node(g.id).y, ui.node(g.id).w, ui.node(g.id).h];
  const m0 = ui.marker();
  await ui.drag(150, 150, 170, 150); // pair (0 → 0.5)'s midpoint, axis 100→300
  const n1 = ui.node(g.id);
  t("3-mid: dragging the midpoint eases the pair (0.7 of their span)",
    Array.isArray(n1.gradientMidpoints) && near(n1.gradientMidpoints[0], 0.7, 1e-9) &&
    near(n1.gradientMidpoints[1], 0.5, 1e-9),
    JSON.stringify(n1.gradientMidpoints));
  t("3-mid: the stops themselves never move",
    positions(n1).join() === "0,0.5,1", JSON.stringify(positions(n1)));
  t("3-mid: the layer box is untouched",
    JSON.stringify([n1.x, n1.y, n1.w, n1.h]) === JSON.stringify(box0),
    JSON.stringify([n1.x, n1.y, n1.w, n1.h]));
  // The ramp renders through the authored midpoint: an explicit 50/50 sample
  // lands exactly at span position 0.35 with the OKLab half-mix.
  const tail = ui.tail(m0);
  const expect = mixHex("#ff0000", "#00ff00", 0.5);
  t("3-mid-render: the gradient gains a 50/50 stop exactly where the handle sits",
    tail.some(([c, p, col]) => c === "addColorStop" && near(p, 0.35, 1e-9) && String(col).toLowerCase() === expect.toLowerCase()),
    JSON.stringify(tail.filter(([c]) => c === "addColorStop").slice(0, 14)));
  await ui.close();
}

// ─────────────────────── 4 · axis handles ───────────────────────
console.log("4 · axis: endpoints rotate and scale, ⇧ constrains the angle");
{
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  // Rotate: drag the start endpoint straight down — only g moves.
  await ui.drag(100, 150, 100, 250);
  let n = ui.node(g.id);
  t("4-rotate: dragging the start endpoint rotates the axis (gy 0.5 → 1.5)",
    near(n.fillGX, 0) && near(n.fillGY, 1.5) && near(n.fillHX, 1) && near(n.fillHY, 0.5),
    JSON.stringify([n.fillGX, n.fillGY, n.fillHX, n.fillHY]));
  // ⇧ on the end handle constrains the new axis to a 45° multiple.
  await ui.drag(300, 150, 200, 40, { shiftKey: true });
  n = ui.node(g.id);
  const ang = (Math.atan2((n.fillHY - n.fillGY) * 100, (n.fillHX - n.fillGX) * 200) * 180) / Math.PI;
  t("4-rotate: ⇧ on the end handle snaps the axis to 45°",
    Math.abs(ang + 45) < 1 || Math.abs(Math.abs(ang) - 45) < 1,
    JSON.stringify({ ang, g: [n.fillGX, n.fillGY], h: [n.fillHX, n.fillHY] }));
  // Scale: the start stays put while the end stretches past the box.
  const gBefore = [n.fillGX, n.fillGY];
  await ui.drag(264.5, 85.5, 350, 200);
  n = ui.node(g.id);
  t("4-scale: dragging the end handle scales without moving the start",
    near(n.fillHX, 1.25) && near(n.fillHY, 1) &&
    near(n.fillGX, gBefore[0]) && near(n.fillGY, gBefore[1]),
    JSON.stringify({ g: [n.fillGX, n.fillGY], h: [n.fillHX, n.fillHY] }));
  await ui.close();
}

// ─────────────────────── 5 · radial focal ───────────────────────
console.log("5 · focal: the radial ring offsets the convergence, centre intact");
{
  const g = node("rect", "Radial", 100, 100, 200, 100, {
    fill: "#ff0000", fillB: "#0000ff", fillType: "radial",
    fillGX: 0.5, fillGY: 0.5, fillHX: 0.5, fillHY: 1,
    gradientStops: [
      { color: "#ff0000", position: 0 },
      { color: "#0000ff", position: 1 },
    ],
  });
  const ui = await mount([g], [g.id]);
  const m0 = ui.marker();
  await ui.dispatch({ type: "select", ids: [g.id] });
  const tail0 = ui.tail(m0);
  t("5-focal: the hollow focal ring (r11) paints around the centre",
    arcs(tail0, 11).some(([, x, y]) => near(x, 200) && near(y, 150)),
    JSON.stringify(arcs(tail0, 11)));
  // Grab the ring just outside the centre dot (r8) and drag it away.
  await ui.drag(210, 150, 225, 165);
  let n = ui.node(g.id);
  t("5-focal: the ring drag offsets the focal point",
    near(n.fillFX, 0.625) && near(n.fillFY, 0.65),
    JSON.stringify([n.fillFX, n.fillFY]));
  t("5-focal: the gradient centre never moves with it",
    near(n.fillGX, 0.5) && near(n.fillGY, 0.5) && near(n.fillHX, 0.5) && near(n.fillHY, 1),
    JSON.stringify([n.fillGX, n.fillGY, n.fillHX, n.fillHY]));
  // The renderer now converges the first stop on the focal point: the inner
  // circle of createRadialGradient sits at the dragged position.
  const m1 = ui.marker();
  await ui.dispatch({ type: "select", ids: [g.id] });
  const grads = ui.tail(m1).filter(([c]) => c === "createRadialGradient");
  t("5-focal-render: the radial starts at the focal point, not the centre",
    grads.some(([, x, y, r0, cx, cy]) => near(x, 225) && near(y, 165) && near(r0, 0) && near(cx, 200) && near(cy, 150)),
    JSON.stringify(grads));
  // Now that it is offset, the ring itself is grabbable at its own centre.
  await ui.drag(225, 165, 235, 175);
  n = ui.node(g.id);
  t("5-focal: an offset ring drags again from its own centre",
    near(n.fillFX, 0.675) && near(n.fillFY, 0.75) && near(n.fillGX, 0.5),
    JSON.stringify([n.fillFX, n.fillFY, n.fillGX, n.fillGY]));
  // Control: the centre dot still wins at the centre.
  await ui.drag(200, 150, 210, 150);
  n = ui.node(g.id);
  t("5-focal-control: pressing the centre drags the centre, not the focal",
    near(n.fillGX, 0.55) && near(n.fillGY, 0.5),
    JSON.stringify([n.fillGX, n.fillGY]));
  await ui.close();
}

// ─────────────────────── 6 · flip buttons ───────────────────────
console.log("6 · flip: FillPicker's flip + rotate buttons drive the canvas");
{
  const { FillPicker } = await import("../FillPicker.tsx");
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  const valueFrom = (n) => ({
    color: n.fill, opacity: 100, type: n.fillType, second: n.fillB, blend: "normal",
    gx: n.fillGX, gy: n.fillGY, hx: n.fillHX, hy: n.fillHY,
    stops: (n.gradientStops ?? []).map((s) => ({ ...s })),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pickRoot = createRoot(host);
  let lastValue = null;
  const applyTo = async (v) => {
    lastValue = v;
    await ui.dispatch({
      type: "patch",
      id: g.id,
      patch: {
        gradientStops: v.stops.map((s) => ({ ...s })),
        fill: v.color,
        fillB: v.second,
        fillGX: v.gx, fillGY: v.gy, fillHX: v.hx, fillHY: v.hy,
      },
    });
    await act(async () => pickRoot.render(React.createElement(ThemeProvider, null, React.createElement(Picker))));
  };
  const Picker = () =>
    React.createElement(FillPicker, {
      title: "Fill",
      value: valueFrom(ui.node(g.id)),
      recents: [],
      anchor: { left: 10, top: 10, right: 10, bottom: 10, width: 0, height: 0, x: 10, y: 10 },
      onChange: (v) => { lastValue = v; },
      onClose: () => {},
    });
  await act(async () => pickRoot.render(React.createElement(ThemeProvider, null, React.createElement(Picker))));
  // Flip: colours reverse along the ramp (direction flips), geometry stays.
  const flipBtn = document.querySelector('button[aria-label="Flip gradient direction"]');
  t("6-flip: the flip button exists in the gradient controls", !!flipBtn);
  const m0 = ui.marker();
  await act(async () => flipBtn.click());
  await applyTo(lastValue);
  let n = ui.node(g.id);
  t("6-flip: flipping reverses every stop's direction",
    n.gradientStops[0].color === "#0000ff" && n.gradientStops[2].color === "#ff0000" &&
    positions(n).join() === "0,0.5,1",
    JSON.stringify(n.gradientStops.map((s) => s.color)));
  t("6-flip: flipping changes no geometry",
    near(n.fillGX, 0) && near(n.fillGY, 0.5) && near(n.fillHX, 1) && near(n.fillHY, 0.5),
    JSON.stringify([n.fillGX, n.fillGY, n.fillHX, n.fillHY]));
  const linesAfterFlip = lines(ui.tail(m0));
  t("6-flip: the canvas repaints the ramp with the new colours",
    linesAfterFlip.some(([x0, y0, x1, y1]) => near(x0, 100) && near(y0, 150) && near(x1, 300) && near(y1, 150)),
    JSON.stringify(linesAfterFlip));
  // Rotate: the axis swings from horizontal to vertical (90°).
  const rotBtn = document.querySelector('button[title="Rotate gradient"]');
  t("6-flip: the rotate button exists in the gradient controls", !!rotBtn);
  const m1 = ui.marker();
  await act(async () => rotBtn.click());
  await applyTo(lastValue);
  n = ui.node(g.id);
  t("6-flip: rotating 90° turns the axis vertical in the model",
    near(n.fillGX, 0.5) && near(n.fillGY, 0) && near(n.fillHX, 0.5) && near(n.fillHY, 1),
    JSON.stringify([n.fillGX, n.fillGY, n.fillHX, n.fillHY]));
  t("6-flip: the canvas follows — the line now runs (200,100) → (200,200)",
    lines(ui.tail(m1)).some(([x0, y0, x1, y1]) => near(x0, 200) && near(y0, 100) && near(x1, 200) && near(y1, 200)),
    JSON.stringify(lines(ui.tail(m1))));
  await act(async () => pickRoot.unmount());
  host.remove();
  await ui.close();
}

// ─────────────────────── 7 · inspector sync ───────────────────────
console.log("7 · inspector: the real RightPanel syncs both ways");
{
  const { RightPanel } = await import("../inspector.tsx");
  const g = GRAD();
  const ui = await mount([g], [g.id]);
  // Mount the real inspector on the same engine.
  const panelHost = document.createElement("div");
  document.body.appendChild(panelHost);
  const panelRoot = createRoot(panelHost);
  const Panel = () => {
    const snap = useSyncExternalStore((cb) => ui.engine.subscribe(cb), () => ui.engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(RightPanel, { engine: ui.engine, snap }));
  };
  await act(async () => panelRoot.render(React.createElement(Panel)));
  const fillInput = panelHost.querySelector('input[aria-label="Fill colour hex"]');
  t("7-sync: the inspector shows the gradient layer's fill", !!fillInput, panelHost.innerHTML.slice(0, 120));
  const swatch = fillInput?.parentElement?.querySelector("button.swatch");
  t("7-sync: the fill row has its colour swatch", !!swatch);
  // Canvas → inspector FIRST: drag the stop handle on the canvas to 0.75
  // before opening the editor. (The picker closes on any outside mousedown —
  // standard popover UX — so the canvas drag leads and the editor, reading
  // the node, must open already showing the moved stop.)
  await ui.drag(200, 150, 250, 150);
  t("7-canvas→sync: the node carries the dragged stop",
    positions(ui.node(g.id))[1] === 0.75, JSON.stringify(positions(ui.node(g.id))));
  // Open the gradient editor (the inspector's gradient controls).
  await act(async () => swatch.click());
  const editor = document.querySelector(".grad-editor");
  t("7-sync: clicking the swatch opens the gradient editor", !!editor);
  const stopsOfDom = () =>
    [...document.querySelectorAll(".grad-stop")].map((el) => parseFloat(el.style.left));
  const domPos = stopsOfDom();
  t("7-canvas→sync: the open gradient editor shows the dragged stop at 75%",
    domPos.length === 3 && domPos.some((p) => Math.abs(p - 75) < 0.5),
    JSON.stringify(domPos));
  // Inspector → canvas: the Rotate button in the REAL panel patches the node
  // and the canvas axis follows.
  const rotBtn = document.querySelector('button[title="Rotate gradient"]');
  const m0 = ui.marker();
  await act(async () => rotBtn.click());
  const n1 = ui.node(g.id);
  t("7-sync→canvas: the panel's rotate patches fillGX…fillHY",
    near(n1.fillGX, 0.5) && near(n1.fillGY, 0) && near(n1.fillHX, 0.5) && near(n1.fillHY, 1),
    JSON.stringify([n1.fillGX, n1.fillGY, n1.fillHX, n1.fillHY]));
  t("7-sync→canvas: the canvas line is already the rotated one",
    lines(ui.tail(m0)).some(([x0, y0, x1, y1]) => near(x0, 200) && near(y0, 100) && near(x1, 200) && near(y1, 200)),
    JSON.stringify(lines(ui.tail(m0))));
  await act(async () => panelRoot.unmount());
  panelHost.remove();
  await ui.close();
}

console.log(`gradientCanvasHandles: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
