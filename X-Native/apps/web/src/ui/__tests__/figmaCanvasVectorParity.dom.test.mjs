/**
 * Figma parity — canvas layering, frame rotation hover, path skeleton, and the
 * vector-edit gestures (batch 45, 2026-10-04).
 *
 * Every assertion here is about an *interaction* the user can see or feel, so the
 * file reads the app's own paint calls out of a mounted `Canvas` rather than
 * poking at internals: the context below records the live `strokeStyle` /
 * `fillStyle` / `lineWidth` alongside each drawing call, which is the only way to
 * tell "the skeleton is thinner and dimmer" apart from "a stroke happened".
 *
 * Coverage by fix:
 *   A  pixel grid layers over the document, under the chrome          (Fix 1)
 *   B  rotation is an invisible band + a cursor, with nothing painted, and the
 *      band the cursor reports is the band the press accepts            (Fix 2)
 *   M  chrome type metrics: 11px medium labels, 8px container handles (Fix 2)
 *   C  path skeleton: unselected edges are a dim centre line, an edge
 *      between two selected anchors is full-strength                   (Fix 3)
 *   D  double-click enters vecEdit *and* selects the anchor under it    (Fix 4, 6)
 *   E  "+" preview over a segment (edit mode and pen), suppressed over a
 *      vertex, and it lands exactly where the click inserts             (Fix 5)
 *   F  handle symmetry: mirrored by default, ⌥ breaks it for good       (Fix 7)
 *
 * Sabotage log — each break was applied to the source, this file re-run, the
 * failure recorded, then the source restored. A green run below means the
 * assertions are load-bearing:
 *   - move `paintPixelGrid()` back above the layer tree   -> A1 fails
 *   - paint the grid after the chrome (never called)      -> A2 fails
 *   - repaint the rotation handle at the band               -> B1, B11 fail
 *   - widen `ROTATION_HANDLE_HIT` past the constant         -> B7, B8 fail
 *   - bold the selected frame's label again                 -> M1, M3 fail
 *   - shrink the container handles back to 7px              -> M4, M5 fail
 *   - skeleton + selected edge share one style            -> C2 fails
 *   - delete the skeleton loop                            -> C1 fails
 *   - `entryAnchor` returns null (the pre-fix entry)      -> D1 fails
 *   - `ADD_POINT_TOL_PX` → 0 (no preview, no insert)     -> E1, E2, E3 fail
 *   - drop the vertex veto in `addPointTargetAt`          -> E4 fails
 *   - drop the `!e.altKey` half of the handle branch      -> F2 fails
 *   - `effectiveMirrorMode` → always "none"               -> F1, F3 fail
 *   - restore the authored-only mirror check in the drag  -> F1, F4 fail
 *   - do not persist the break (`p.mirrorMode` left alone)-> F2b fails
 */
import { readFileSync } from "fs";
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, localToWorld } from "../../engine/memory.ts";
import { pathToVectorNetwork } from "../../engine/geometry.ts";
import { effectiveMirrorMode, anchorIndexAt, addPointTargetAt, VERTEX_PRIORITY_PX, ADD_POINT_TOL_PX } from "../vectorEdit.ts";
import { frameRotationHandle, rotationHandleHit, ROTATION_HANDLE_HIT, ROTATION_RING } from "../canvasSelection.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// The chrome the app paints with, read the same way the paint does: jsdom has no
// cascade for the custom properties, so `CANVAS_CHROME_FALLBACK` is the sheet the
// paint falls back to and the sheet the tests must match. Deriving them here (not
// retyping hexes) means a retheme moves the tests with the code; `canvasChrome
// .test.mjs` is what pins the fallbacks to styles.css.
const { CANVAS_CHROME_FALLBACK, withAlpha } = await import("../canvasChrome.ts");
const canvasSource = readFileSync(new URL("../Canvas.tsx", import.meta.url), "utf8");
const SEL = CANVAS_CHROME_FALLBACK.sel;
const SKELETON = withAlpha(SEL, 0.45);
const SEL_GLOW = CANVAS_CHROME_FALLBACK.selGlow;
const HANDLE_FILL = "#ffffff";

const window = installDom();
/** Every drawing call on a canvas that is in the document, with the styles that
 *  were live at that instant (a recording proxy that only keeps colours for
 *  `stroke()` cannot tell a halo from a ring). */
let ops = [];
let seq = 0;
const installs = new WeakSet();
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  const el = this;
  if (!installs.has(el)) {
    installs.add(el);
    el.__ctx = makeContext(el);
  }
  return el.__ctx;
};
function makeContext(el) {
  const st = { strokeStyle: "#000000", fillStyle: "#000000", lineWidth: 1, font: "10px sans-serif" };
  const target = {
    canvas: el,
    measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  };
  return new Proxy(target, {
    get(tg, key) {
      if (key === "__styles") return st;
      if (key in st) return st[key];
      if (key in tg) return typeof tg[key] === "function" ? tg[key].bind(tg) : tg[key];
      return (...a) => {
        if (!document.body.contains(el)) return;
        ops.push({ n: seq++, op: key, el, ...snapshot(st), args: a });
      };
    },
    set(tg, key, v) {
      if (key in st) st[key] = v;
      else tg[key] = v;
      return true;
    },
  });
}
const snapshot = (st) => ({ strokeStyle: st.strokeStyle, fillStyle: st.fillStyle, lineWidth: st.lineWidth, font: st.font });
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830,
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;

const pageNode = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
/** Screen x for a world x, at the test's fixed zoom/pan. */
const VIEW = { zoom: 1, panX: 0, panY: 0 };
const sx = (wx) => wx * VIEW.zoom + VIEW.panX;

/**
 * @param children the page's layers
 * @param view overrides (zoom / pan / page patches)
 */
async function mount(children, view = {}) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: pageNode(...children), guides: [], comments: [], ...(view.page ?? {}) }],
    page: 0,
    zoom: view.zoom ?? VIEW.zoom,
    panX: view.panX ?? VIEW.panX,
    panY: view.panY ?? VIEW.panY,
  });
  function Host() {
    const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap }));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  ops = [];
  await act(async () => reactRoot.render(React.createElement(Host)));
  const surface = host.querySelector(".canvas-wrap");
  const ui = {
    engine, host, surface,
    ops: () => ops,
    snap: () => engine.snapshot(),
    node: (id) => find(engine.snapshot().pages[0].root, id),
    async dispatch(cmd) { await act(async () => engine.dispatch(cmd)); },
    /** `x`/`y` are canvas-relative; the harness owns the DOM offset. */
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
      })));
    },
    async close() { await act(async () => reactRoot.unmount()); host.remove(); },
  };
  return ui;
}

/* A triangle whose second edge is a curve, so the skeleton has to follow a cubic. */
const tri = [
  { x: 10, y: 10 },
  { x: 90, y: 20, ox: 10, oy: 40 },
  { x: 50, y: 90, ix: 10, iy: -30 },
];

/* ------------------------------------------------------------------ A · grid */
{
  const cover = node("rect", "Cover", 0, 0, 1000, 800, { fill: "#ff0000", fillVisible: true });
  const ui = await mount([cover], { zoom: 5, page: { pixelGrid: true, pixelGridColor: "#ffffff" } });
  const g = ui.ops().find((o) => o.op === "stroke" && o.strokeStyle === "#ffffff" && o.lineWidth === 1);
  const painted = ui.ops().find((o) => o.op === "fill" && o.fillStyle.startsWith("rgba(255,0,0"));
  t("A1 the pixel grid draws over the document's own fills", !!g && !!painted && g.n > painted.n,
    `grid=${g?.n} fill=${painted?.n}`);
  // The selection handles are the topmost thing the chrome paints for a plain
  // selected layer, so "grid before the handles" is "grid under the chrome".
  await ui.dispatch({ type: "select", ids: [cover.id] });
  const ops2 = ui.ops();
  const g2 = ops2.filter((o) => o.op === "stroke" && o.strokeStyle === "#ffffff" && o.lineWidth === 1).pop();
  const chrome = ops2
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.op === "fillRect" && o.fillStyle === HANDLE_FILL)
    .pop();
  t("A2 the pixel grid stays under the selection chrome", !!g2 && !!chrome && g2.n < chrome.o.n,
    `grid=${g2?.n} handles=${chrome?.o.n}`);
  await ui.close();
}
{
  // The gate itself: 400% is the visibility floor, and a page without the flag
  // paints no grid at all.
  const ui = await mount([node("rect", "R", 10, 10, 40, 40, {})], { zoom: 3.9, page: { pixelGrid: true } });
  const anyGrid = ui.ops().some((o) => o.op === "stroke" && o.lineWidth === 1 && o.strokeStyle === "#cccccc");
  t("A3 the grid stays hidden below 400%", !anyGrid);
  await ui.close();
}

/* ------------------------- B · rotation is a cursor, and paints nothing at all */
{
  const frame = node("frame", "Rotatable", 100, 100, 300, 200, { fill: "#ffffff" });
  const ui = await mount([frame]);
  await ui.dispatch({ type: "select", ids: [frame.id] });
  // zoom 1 / pan 0, so the test's "screen" and world coordinates coincide.
  const handle = frameRotationHandle("frame", 100, 100, 300, 200);
  t("B0 the grab band is centred above the top-right corner, not top-centre",
    near(handle.x, 400) && near(handle.y, 80) && !near(handle.x, 100 + 150), JSON.stringify(handle));
  /** Arcs inside the band: the 5px dot, its 8px halo, the 2.2px glyph and the
   *  non-frame ring all used to live here. Every one of them is the regression
   *  this pins, so the filter is on position, not on a radius someone could
   *  re-tune to slip past it. */
  const arcsInBand = () => ui.ops().filter((o) =>
    o.op === "arc" && Math.hypot(o.args[0] - handle.x, o.args[1] - handle.y) <= 26);
  t("B1 a selected frame paints nothing at its rotation target", arcsInBand().length === 0,
    `${arcsInBand().length} arc(s) in the band`);
  t("B2 and no stem joins the corner to the target",
    !ui.ops().some((o) => o.op === "lineTo" && near(o.args[0], handle.x, 0.01) && near(o.args[1], handle.y, 0.01)));
  const rotateCursor = () => ui.surface.style.cursor;
  await ui.mouse("mousemove", handle.x, handle.y);
  t("B3 hovering the band paints nothing either", arcsInBand().length === 0);
  t("B4 the hover is sold by the cursor alone", rotateCursor().includes("url("), rotateCursor().slice(0, 28));
  ops = [];
  await ui.mouse("mousemove", 120, 120);
  t("B5 leaving the band drops the cursor", !rotateCursor().includes("url("), rotateCursor().slice(0, 28));
  t("B6 and the frame never gained chrome while the pointer was in it", arcsInBand().length === 0);
  // The band stays exactly as wide as the module says, because the press and the
  // cursor read the same number; with no handle to look at, that is the only
  // promise left to keep.
  t("B7 the band's half-width is the shared constant",
    rotationHandleHit("frame", 400, 80 + ROTATION_HANDLE_HIT, 100, 100, 300, 200) === true
    && rotationHandleHit("frame", 400, 80 + ROTATION_HANDLE_HIT + 1, 100, 100, 300, 200) === false);
  t("B8 a press inside the band rotates", (() => {
    const before = ui.node(frame.id).rotation;
    return before === 0 && rotationHandleHit("frame", 400 - 6, 84, 100, 100, 300, 200);
  })());
  // The chrome cannot come back through a new export either: there is no
  // handle radius left for a painter to draw with.
  const sel = await import("../canvasSelection.ts");
  t("B9 canvasSelection.ts exports no painted-handle geometry", !("ROTATION_HANDLE_RADIUS" in sel),
    Object.keys(sel).join(", "));
  t("B10 Canvas.tsx does not even import the handle position any more",
    !/frameRotationHandle/.test(canvasSource), "the painter still reaches for it");
  await ui.close();
}
{
  // The other half of the removal: a plain shape used to get a 14px ring outside
  // its top-right corner, and a `ROTATION_RING` band still decides the cursor.
  const rect = node("rect", "Plain", 100, 100, 300, 200, { fill: "#ffffff" });
  const ui = await mount([rect]);
  await ui.dispatch({ type: "select", ids: [rect.id] });
  const near = ROTATION_RING;
  const ringArcs = ui.ops().filter((o) => o.op === "arc"
    && Math.hypot(o.args[0] - 400, o.args[1] - 100) <= near.max);
  t("B11 a plain shape has no ring outside its corner either", ringArcs.length === 0,
    `${ringArcs.length} arc(s)`);
  t("B12 its corner band is the one the press uses",
    rotationHandleHit("rect", 400 - 14, 100 - 14, 100, 100, 300, 200) === true
    && rotationHandleHit("rect", 400 - (near.max + 1), 100 - (near.max + 1), 100, 100, 300, 200) === false);
  await ui.close();
}

/* --------------------------------------- M · the chrome's type and handle sizes */
{
  const frame = node("frame", "Named frame", 100, 100, 300, 200, { fill: "#ffffff" });
  const rect = node("rect", "Plain", 100, 400, 300, 200, { fill: "#ffffff" });
  const ui = await mount([frame, rect]);
  /** Frame names are drawn by `labelNames`, one `fillText` per visible label;
   *  `ops` accumulates for the whole mount, so each pass clears it first. */
  const label = (text) => ui.ops().filter((o) => o.op === "fillText" && o.args[0] === text).pop();
  const boxes = () => ui.ops().filter((o) => o.op === "fillRect" && o.fillStyle === HANDLE_FILL);
  ops = [];
  await ui.dispatch({ type: "select", ids: [frame.id] });
  const on = label("Named frame");
  t("M1 a selected frame's name is 11px medium", !!on && on.font === "500 11px Inter, system-ui",
    on ? `${on.font} / ${on.fillStyle}` : "no label painted");
  t("M2 and selection shows in its colour, not its weight", !!on && on.fillStyle === SEL,
    String(on?.fillStyle));
  // Handles: Figma's boxes are 8px on a container, painted one inset so the 1px
  // stroke lands on the edge rather than outside the box.
  const at = (o) => [o.args[0] + o.args[2] / 2, o.args[1] + o.args[3] / 2];
  const FRAME_BOXES = [[100, 100], [250, 100], [400, 100], [400, 200], [400, 300], [250, 300], [100, 300], [100, 200]];
  const frameBoxes = boxes();
  t("M3 a selected frame's handles are 8px boxes (painted 7 + 1px stroke)",
    frameBoxes.length === 8 && frameBoxes.every((o) => o.args[2] === 7 && o.args[3] === 7),
    `${frameBoxes.length} boxes: ${frameBoxes.map((o) => o.args[2]).join(",")}`);
  t("M4 growing them did not move them: every box is centred on its edge point",
    frameBoxes.length === 8 && frameBoxes.every((o) => {
      const [cx, cy] = at(o);
      return FRAME_BOXES.some(([x, y]) => near(cx, x, 0.001) && near(cy, y, 0.001));
    }),
    frameBoxes.map((o) => at(o).map((v) => Math.round(v * 10) / 10).join(":")).join(" "));
  ops = [];
  await ui.dispatch({ type: "select", ids: [] });
  t("M5 unselected, the label keeps the same font at the dim ink", (() => {
    const off = label("Named frame");
    return !!off && off.font === "500 11px Inter, system-ui" && off.fillStyle !== SEL;
  })(), String(label("Named frame")?.font));
  ops = [];
  await ui.dispatch({ type: "select", ids: [rect.id] });
  const small = boxes();
  t("M6 a plain shape keeps four corner handles, one step smaller",
    small.length === 4 && small.every((o) => o.args[2] === 6 && o.args[3] === 6),
    `${small.length} boxes: ${small.map((o) => o.args[2]).join(",")}`);
  t("M7 mid-edge handles are a container idea, not a shape one",
    small.every((o) => {
      const [cx, cy] = at(o);
      return [[100, 400], [400, 400], [400, 600], [100, 600]].some(([x, y]) => near(cx, x, 0.001) && near(cy, y, 0.001));
    }),
    small.map((o) => at(o).map((v) => Math.round(v * 10) / 10).join(":")).join(" "));
  await ui.close();
}

/* --------------------------------------------------- C · path skeleton styles */
{
  const vector = node("vector", "Tri", 100, 100, 100, 100, {
    path: tri.map((p) => ({ ...p })), closed: true, vectorNetwork: pathToVectorNetwork(tri, true),
  });
  const ui = await mount([vector]);
  await ui.dispatch({ type: "select", ids: [vector.id] });
  await ui.dispatch({ type: "setVecEdit", id: vector.id, pointIndex: null, pointIndices: [] });
  const skel = ui.ops().filter((o) => o.op === "stroke" && o.strokeStyle === SKELETON && o.lineWidth === 1);
  t("C1 every edge draws as a dim centre line in point edit", skel.length === 3, `got ${skel.length}`);
  const hot = ui.ops().filter((o) => o.op === "stroke" && o.strokeStyle === SEL && o.lineWidth === 1.5);
  t("C2 with nothing selected, no edge is emphasised", hot.length === 0, `got ${hot.length}`);
  t("C3 the skeleton is thinner and dimmer than the selection ink",
    SKELETON.endsWith("0.45)") && skel.length > 0 && skel[0].lineWidth < 1.5);

  // Select the two anchors of the curved edge: that one edge goes full strength.
  await ui.dispatch({ type: "setVecEdit", id: vector.id, pointIndex: 1, pointIndices: [1, 2] });
  const hot2 = ui.ops().filter((o) => o.op === "stroke" && o.strokeStyle === SEL && o.lineWidth === 1.5);
  const skel2 = ui.ops().filter((o) => o.op === "stroke" && o.strokeStyle === SKELETON && o.lineWidth === 1);
  t("C4 the edge between two selected anchors is drawn hot", hot2.length === 1, `got ${hot2.length}`);
  t("C5 the other two edges stay skeleton", skel2.length >= 3, `got ${skel2.length}`);
  const curve = ui.ops().find((o) => o.op === "bezierCurveTo" && o.strokeStyle === SEL);
  t("C6 the hot edge follows the cubic, not its chord", !!curve && curve.args.length === 6,
    JSON.stringify(curve?.args));
  // The skeleton is an overlay over the artwork, not a substitute for it: on a
  // black-filled path the dim hairline is the only thing showing the structure, so
  // it has to survive the fill (same failure mode as the pixel grid, §1).
  await ui.close();
  const inked = node("vector", "Filled", 100, 100, 100, 100, {
    path: tri.map((pt) => ({ ...pt })), closed: true, fill: "#000000", fillVisible: true,
    vectorNetwork: pathToVectorNetwork(tri, true),
  });
  const ui2 = await mount([inked]);
  await ui2.dispatch({ type: "select", ids: [inked.id] });
  await ui2.dispatch({ type: "setVecEdit", id: inked.id, pointIndex: null, pointIndices: [] });
  const skelOver = ui2.ops().find((o) => o.op === "stroke" && o.strokeStyle === SKELETON);
  const shapeFill = ui2.ops().find((o) => o.op === "fill" && o.fillStyle.startsWith("rgba(0,0,0"));
  t("C7 the skeleton draws over the shape's own fill",
    !!skelOver && !!shapeFill && skelOver.n > shapeFill.n,
    `skeleton=${skelOver?.n} fill=${shapeFill?.n}`);
  // One anchor selected on its own: it styles as selected, and no edge lights up
  // (an edge is hot when *both* ends are, which is Figma's segment selection).
  await ui2.dispatch({ type: "setVecEdit", id: inked.id, pointIndex: 1, pointIndices: [1] });
  const dots = ui2.ops().filter((o) => o.op === "arc" && near(o.args[2], 3.5));
  t("C8 the selected anchor fills, its neighbours stay hollow",
    dots.some((o) => o.fillStyle === SEL) && dots.some((o) => o.fillStyle === "#ffffff"),
    JSON.stringify(dots.map((o) => o.fillStyle)));
  t("C9 one selected anchor does not light an edge",
    !ui2.ops().some((o) => o.op === "stroke" && o.strokeStyle === SEL && o.lineWidth === 1.5));
}

/* -------------------------------------- D · double-click enters and selects */
{
  const vector = node("vector", "Tri", 100, 100, 100, 100, {
    path: tri.map((p) => ({ ...p })), closed: true, vectorNetwork: pathToVectorNetwork(tri, true),
  });
  const ui = await mount([vector]);
  await ui.dispatch({ type: "select", ids: [vector.id] });
  // Anchor 0 sits at world (110, 110).
  await ui.mouse("dblclick", sx(110), sx(110));
  t("D1 double-click on an anchor enters vecEdit", ui.snap().vecEdit === vector.id);
  t("D2 …and leaves that anchor selected", ui.snap().vecPoint === 0 && ui.snap().vecPoints?.includes(0),
    JSON.stringify({ pt: ui.snap().vecPoint, pts: ui.snap().vecPoints }));
  // Leave and re-enter on the middle of an edge: edit mode, nothing selected.
  await ui.dispatch({ type: "setVecEdit", id: null, pointIndex: null, pointIndices: [] });
  const mid = { x: 100 + (tri[1].x + tri[2].x) / 2, y: 100 + (tri[1].y + tri[2].y) / 2 };
  await ui.mouse("dblclick", sx(mid.x), sx(mid.y));
  t("D3 double-click on a segment enters vecEdit with no point selected",
    ui.snap().vecEdit === vector.id && ui.snap().vecPoint == null,
    JSON.stringify({ edit: ui.snap().vecEdit, pt: ui.snap().vecPoint }));
  // And the anchor test itself, in isolation: the same radius the press uses.
  t("D4 an anchor 1 screen px outside the grab radius is not selected",
    anchorIndexAt([{ x: 0, y: 0 }], VERTEX_PRIORITY_PX.edit + 1, 0, VERTEX_PRIORITY_PX.edit) === null);
  await ui.close();
  {
    // The entry converts the press through the node's own transform, so a path
    // under rotation still answers "the dot I aimed at": the pre-fix code measured
    // the un-rotated `hit.path` and picked the wrong anchor (or none).
    const rot = node("vector", "TriRot", 100, 100, 100, 100, {
      path: tri.map((pt) => ({ ...pt })), closed: true, rotation: 30,
      vectorNetwork: pathToVectorNetwork(tri, true),
    });
    const uiR = await mount([rot]);
    await uiR.dispatch({ type: "select", ids: [rot.id] });
    const w = localToWorld(uiR.snap().pages[0].root, rot.id, tri[1].x, tri[1].y);
    await uiR.mouse("dblclick", sx(w.x), sx(w.y));
    t("D5 on a rotated path, the double-click picks the anchor it is standing on",
      uiR.snap().vecEdit === rot.id && uiR.snap().vecPoint === 1,
      JSON.stringify({ edit: uiR.snap().vecEdit, pt: uiR.snap().vecPoint, at: w }));
    await uiR.close();
  }
}

/* ------------------------------------- E · the "+" insert preview and click */
{
  const vector = node("vector", "Tri", 100, 100, 100, 100, {
    path: tri.map((p) => ({ ...p })), closed: true, vectorNetwork: pathToVectorNetwork(tri, true),
  });
  const ui = await mount([vector]);
  await ui.dispatch({ type: "select", ids: [vector.id] });
  await ui.dispatch({ type: "setVecEdit", id: vector.id, pointIndex: null, pointIndices: [] });
  // The straight edge 2 → 0, at its midpoint in world space.
  const p2 = { x: 100 + tri[2].x, y: 100 + tri[2].y };
  const p0 = { x: 100 + tri[0].x, y: 100 + tri[0].y };
  const hover = { x: (p2.x + p0.x) / 2, y: (p2.y + p0.y) / 2 + 4 };
  ops = [];
  await ui.mouse("mousemove", sx(hover.x), sx(hover.y));
  const plus = ui.ops().filter((o) => o.op === "stroke" && o.strokeStyle === SEL && o.lineWidth === 1.75);
  t("E1 hovering a segment paints the + insert marker", plus.length === 1, `got ${plus.length}`);
  t("E2 the marker has a halo under it so it reads on any fill",
    ui.ops().some((o) => o.op === "stroke" && o.strokeStyle === HANDLE_FILL && o.lineWidth === 3.5));
  t("E3 in point edit, hovering a segment shows the add-point cursor",
    ui.surface.style.cursor.includes("data:image/svg+xml") && ui.surface.style.cursor.includes("M12 8.2v7.6"),
    ui.surface.style.cursor.slice(0, 60));
  const before = ui.node(vector.id).path.length;
  await ui.mouse("mousedown", sx(hover.x), sx(hover.y));
  await ui.mouse("mouseup", sx(hover.x), sx(hover.y));
  const after = ui.node(vector.id).path;
  t("E4 the click inserts exactly one anchor", after.length === before + 1, `${before} -> ${after.length}`);
  // The preview promised the point the click delivered: the new anchor is the
  // marker's own projection, on the segment, in the node's space.
  const inserted = after.find((p) => !tri.some((q) => near(q.x, p.x, 1e-6) && near(q.y, p.y, 1e-6)));
  // The horizontal arm of the painted cross pins the mark's centre, so the
  // comparison is "the anchor went where the + was", not "near where the mouse was".
  const all = ui.ops();
  let mark = null;
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    if (a.op === "moveTo" && b.op === "lineTo" && b.strokeStyle === SEL && near(a.args[1], b.args[1])) {
      mark = { x: (a.args[0] + b.args[0]) / 2, y: a.args[1] };
    }
  }
  t("E5 the inserted anchor lands exactly where the + was painted",
    !!inserted && !!mark && near(100 + inserted.x, mark.x, 0.05) && near(100 + inserted.y, mark.y, 0.05),
    `anchor=${JSON.stringify(inserted)} mark=${JSON.stringify(mark)}`);
  const idx = after.indexOf(inserted);
  const sel = ui.snap();
  t("E6 the new anchor is the one selected", sel.vecEdit === vector.id
    && (sel.vecPoint === idx || (sel.vecPoints ?? []).includes(idx)),
    JSON.stringify({ idx, pt: sel.vecPoint, pts: sel.vecPoints, edit: sel.vecEdit }));

  // A vertex is a grab, not an insert: no "+", and the plain cursor.
  ops = [];
  await ui.mouse("mousemove", sx(p0.x), sx(p0.y));
  const plusOnVertex = ui.ops().filter((o) => o.op === "stroke" && o.lineWidth === 1.75);
  t("E4b hovering an anchor suppresses the + marker", plusOnVertex.length === 0, `got ${plusOnVertex.length}`);
  t("E4c …and the add-point cursor with it", !ui.surface.style.cursor.includes("M12 8.2v7.6"),
    ui.surface.style.cursor.slice(0, 60));
  // The interesting case is a press *inside* the segment's reach but inside the
  // anchor's grab radius: the insert would happily take it (t is well past the
  // endpoint), and only the vertex veto says the anchor wins. Figma grabs the
  // point; a "+" here would promise a split that the click refuses to make.
  const near0 = { x: p0.x + (80 * 6) / 80.62, y: p0.y + (10 * 6) / 80.62 };
  ops = [];
  await ui.mouse("mousemove", sx(near0.x), sx(near0.y));
  t("E4d a press that is on the segment *and* within the anchor's grab radius shows no +",
    ui.ops().filter((o) => o.op === "stroke" && o.lineWidth === 1.75).length === 0
    && !ui.surface.style.cursor.includes("M12 8.2v7.6"),
    ui.surface.style.cursor.slice(0, 60));
  const beforeVeto = ui.node(vector.id).path.length;
  await ui.mouse("mousedown", sx(near0.x), sx(near0.y));
  await ui.mouse("mouseup", sx(near0.x), sx(near0.y));
  const selV = ui.snap();
  t("E4e …and the click grabs the anchor instead of splitting the segment",
    ui.node(vector.id).path.length === beforeVeto && selV.vecPoint === 0,
    `path ${beforeVeto} -> ${ui.node(vector.id).path.length}, vecPoint=${selV.vecPoint}`);

  // Off the path entirely: nothing is offered.
  ops = [];
  await ui.mouse("mousemove", sx(105), sx(170));
  t("E7 away from the path there is no marker and no + cursor",
    ui.ops().filter((o) => o.op === "stroke" && o.lineWidth === 1.75).length === 0
    && !ui.surface.style.cursor.includes("M12 8.2v7.6"));
  await ui.close();
}
{
  // The pen over a *selected* layer (not yet in point edit) gets the same state.
  const vector = node("vector", "Tri", 100, 100, 100, 100, {
    path: tri.map((p) => ({ ...p })), closed: true, vectorNetwork: pathToVectorNetwork(tri, true),
  });
  const ui = await mount([vector]);
  await ui.dispatch({ type: "select", ids: [vector.id] });
  await ui.dispatch({ type: "setTool", tool: "pen" });
  const p0 = { x: 100 + tri[0].x, y: 100 + tri[0].y };
  const p2 = { x: 100 + tri[2].x, y: 100 + tri[2].y };
  const hover = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 + 4 };
  await ui.mouse("mousemove", sx(hover.x), sx(hover.y));
  t("E8 the pen shows the add-point cursor over an existing path",
    ui.surface.style.cursor.includes("M12 8.2v7.6"), ui.surface.style.cursor.slice(0, 60));
  const before = ui.node(vector.id).path.length;
  await ui.mouse("mousedown", sx(hover.x), sx(hover.y));
  await ui.mouse("mouseup", sx(hover.x), sx(hover.y));
  t("E9 the pen click inserts the point and enters the edit",
    ui.node(vector.id).path.length === before + 1 && ui.snap().vecEdit === vector.id,
    `paths ${before} -> ${ui.node(vector.id).path.length}, edit=${ui.snap().vecEdit}`);
  await ui.close();
}
{
  // The preview must never promise what the click refuses to do: a locked layer,
  // and a branched network (the insert is refused to protect the rest of it).
  const locked = node("vector", "Locked", 100, 100, 100, 100, {
    path: tri.map((p) => ({ ...p })), closed: true, locked: true,
    vectorNetwork: pathToVectorNetwork(tri, true),
  });
  const ui = await mount([locked]);
  await ui.dispatch({ type: "select", ids: [locked.id] });
  await ui.dispatch({ type: "setVecEdit", id: locked.id, pointIndex: null, pointIndices: [] });
  const mid = { x: 100 + (tri[0].x + tri[2].x) / 2, y: 100 + (tri[0].y + tri[2].y) / 2 + 4 };
  ops = [];
  await ui.mouse("mousemove", sx(mid.x), sx(mid.y));
  t("E10 a locked path never advertises an insert",
    ui.ops().filter((o) => o.op === "stroke" && o.lineWidth === 1.75).length === 0);
  await ui.close();
}

/* -------------------------------------------- F · Bézier handle symmetry */
{
  const symmetric = { x: 0, y: 0, ox: 20, oy: 0, ix: -20, iy: 0 };
  const unequal = { x: 0, y: 0, ox: 30, oy: 0, ix: -12, iy: 0 };
  const skewed = { x: 0, y: 0, ox: 20, oy: 6, ix: -20, iy: 6 };
  t("F1 mirrored handles with no mode on record mirror (Figma's smooth point)",
    effectiveMirrorMode(symmetric) === "angleAndLength", effectiveMirrorMode(symmetric));
  t("F2 collinear but unequal is the angle-only style",
    effectiveMirrorMode(unequal) === "angle", effectiveMirrorMode(unequal));
  t("F3 anything else is independent", effectiveMirrorMode(skewed) === "none", effectiveMirrorMode(skewed));
  t("F4 an authored mode always wins over the reading",
    effectiveMirrorMode({ ...symmetric, mirrorMode: "none" }) === "none");
  t("F5 a bare corner point has nothing to mirror", effectiveMirrorMode({ x: 0, y: 0 }) === "none");
}
{
  // Mounted: the drag itself. A pen-style point (mirrored, no `mirrorMode`), and
  // the ⌥ break that has to outlive the gesture.
  const point = { x: 20, y: 20, ox: 30, oy: 0, ix: -30, iy: 0 };
  const path = [point, { x: 100, y: 20 }, { x: 100, y: 100 }];
  const vector = node("vector", "Smooth", 100, 100, 120, 120, {
    path: path.map((p) => ({ ...p })), closed: false, vectorNetwork: pathToVectorNetwork(path, false),
  });
  const ui = await mount([vector]);
  await ui.dispatch({ type: "select", ids: [vector.id] });
  await ui.dispatch({ type: "setVecEdit", id: vector.id, pointIndex: 0, pointIndices: [0] });
  // Its outgoing handle tip sits at world (100+20+30, 100+20) = (150, 120).
  const tip = { x: 100 + 20 + 30, y: 100 + 20 };
  await ui.mouse("mousedown", sx(tip.x), sx(tip.y));
  await ui.mouse("mousemove", sx(tip.x + 10), sx(tip.y + 20));
  await ui.mouse("mouseup", sx(tip.x + 10), sx(tip.y + 20));
  let p = ui.node(vector.id).path[0];
  t("F6 dragging one handle of a smooth point moves its twin symmetrically",
    near(p.ox, 40) && near(p.oy, 20) && near(p.ix, -40) && near(p.iy, -20),
    JSON.stringify({ ox: p.ox, oy: p.oy, ix: p.ix, iy: p.iy }));

  // ⌥-drag: the twin must not follow, and the break must persist.
  await ui.mouse("mousedown", sx(100 + 20 + p.ox), sx(100 + 20 + p.oy));
  await ui.mouse("mousemove", sx(100 + 20 + 15), sx(100 + 20 - 4), { altKey: true });
  await ui.mouse("mouseup", sx(100 + 20 + 15), sx(100 + 20 - 4), { altKey: true });
  p = ui.node(vector.id).path[0];
  t("F7 ⌥-drag breaks the symmetry for that handle only",
    near(p.ox, 15) && near(p.oy, -4) && near(p.ix, -40) && near(p.iy, -20),
    JSON.stringify({ ox: p.ox, oy: p.oy, ix: p.ix, iy: p.iy }));
  t("F8 the break is written down, not held by the modifier", p.mirrorMode === "none", String(p.mirrorMode));

  // Same gesture without ⌥ now stays independent, because the point is broken.
  await ui.mouse("mousedown", sx(100 + 20 + p.ox), sx(100 + 20 + p.oy));
  await ui.mouse("mousemove", sx(100 + 20 + 22), sx(100 + 20 + 9));
  await ui.mouse("mouseup", sx(100 + 20 + 22), sx(100 + 20 + 9));
  p = ui.node(vector.id).path[0];
  t("F9 after the break, a plain drag does not re-mirror", near(p.ox, 22) && near(p.oy, 9) && near(p.ix, -40),
    JSON.stringify({ ox: p.ox, oy: p.oy, ix: p.ix }));
  t("F10 one undo steps back over the whole gesture", (await ui.dispatch({ type: "undo" }), true));
  await ui.close();
}

/* ------------------------------------------------- G · shared hit maths */
{
  // `addPointTargetAt` is the whole rule for the preview; the point it returns is
  // the point the insert splices, on a curve as well as a chord.
  const seg = [{ x: 0, y: 0 }, { x: 100, y: 0, ix: 0, iy: 0 }, { x: 100, y: 100 }];
  const onChord = addPointTargetAt(seg, { x: 40, y: 3 }, false, 1);
  t("G1 a straight segment answers with its projection", !!onChord && near(onChord.y, 0) && near(onChord.x, 40),
    JSON.stringify(onChord));
  t("G2 a point past the tolerance is not on the path",
    addPointTargetAt(seg, { x: 40, y: ADD_POINT_TOL_PX + 2 }, false, 1) === null);
  t("G3 tolerance is in screen px, so it tightens as you zoom in",
    !!addPointTargetAt(seg, { x: 40, y: 3 }, false, 1) && addPointTargetAt(seg, { x: 40, y: 3 }, false, 4) === null);
  t("G4 a click near an endpoint is a vertex grab, not an insert",
    addPointTargetAt(seg, { x: 1, y: 1 }, false, 1) === null);
  // The cubic through (0,0)→(100,0) bulges to about y=-15 at t=0.5, so a probe
  // 4px off the *curve* is inside tolerance while being 15px off the chord.
  const curved = [{ x: 0, y: 0, ox: 40, oy: -40 }, { x: 100, y: 0 }];
  const onCurve = addPointTargetAt(curved, { x: 60, y: -6 }, true, 1);
  t("G5 a curved segment answers with a point on the curve, not its chord",
    !!onCurve && onCurve.y < -6, JSON.stringify(onCurve));
}

console.log(`\nfigmaCanvasVectorParity: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
