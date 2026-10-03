/** Run 20: image crop interaction (audit P1 #10) — the seven workflow
 *  categories, end to end: entry (double-click / crop button), the eight
 *  crop handles resizing the region about a fixed focal anchor, aspect lock
 *  (default + ⇧, ⌘/⌃ frees) to the original image or a selected ratio,
 *  focal movement (body drag pans the picture, never the crop box),
 *  rotation-aware crop chrome (own rotation and rotated ancestry), the ⌥/⇧
 *  modifiers, and Enter / click-away committing the whole session as ONE
 *  undo step. Mounted Canvas with real mouse events and recorded paints
 *  (jsdom: interaction wiring, not browser pixels).
 *
 * Run with:  npx vite-node src/ui/__tests__/imageCropInteraction.test.mjs
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, localToWorld } from "../../engine/memory.ts";
import { cropHandleRects, dragCropHandle, moveCrop } from "../cropModel.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });

// ═══════════════════════════ pure crop math ═══════════════════════════
console.log("pure crop model (focal anchor, aspect, pan)");
{
  const r0 = { x: 0.2, y: 0.15, w: 0.4, h: 0.5 };
  // 3: locked corner drag squares the region — pixel aspect = the original
  // image's (square in normalised space) — anchored at the opposite corner.
  const locked = dragCropHandle(r0, "se", 0.54, 0.4, { lockAspect: true });
  t("3-pure: locked corner drag keeps the original image's aspect",
    near(locked.w, 0.34) && near(locked.h, 0.34) && near(locked.x, 0.2) && near(locked.y, 0.15),
    JSON.stringify(locked));
  // 2: the focal point — the corner opposite the held handle — never moves.
  t("2-pure: handle drag anchors the opposite corner (focal point)",
    near(locked.x, r0.x) && near(locked.y, r0.y), JSON.stringify(locked));
  const free = dragCropHandle(r0, "se", 0.54, 0.4, { lockAspect: false });
  t("3-pure: freed corner drag follows the pointer on both axes",
    near(free.w, 0.34) && near(free.h, 0.25) && near(free.x, 0.2) && near(free.y, 0.15),
    JSON.stringify(free));
  // 3: a selected ratio locks to that ratio instead of the original image.
  const ratio = dragCropHandle(r0, "se", 0.54, 0.4, { lockAspect: true, aspect: 2 });
  t("3-pure: a selected ratio governs the locked region",
    near(ratio.w / ratio.h, 2) && near(ratio.x, 0.2) && near(ratio.y, 0.15),
    JSON.stringify(ratio));
  // 6: ⌥ mirrors about the centre — both sides move, the centre is the anchor.
  const sym = dragCropHandle(r0, "se", 0.54, 0.475, { symmetric: true, lockAspect: true });
  t("6-pure: ⌥ resizes from the centre",
    near(sym.x + sym.w / 2, 0.4) && near(sym.y + sym.h / 2, 0.4) && near(sym.w, sym.h),
    JSON.stringify(sym));
  // 4: grab-style pan — the window moves against the pointer so the picture
  // follows the hand; the region size is untouched.
  const mv = moveCrop(r0, -0.12, -0.1);
  t("4-pure: pan moves the window (picture follows the pointer), size intact",
    near(mv.x, 0.08) && near(mv.y, 0.05) && near(mv.w, r0.w) && near(mv.h, r0.h),
    JSON.stringify(mv));
  const hs = cropHandleRects({ x: 100, y: 100, w: 200, h: 200 }, 8);
  t("2-pure: eight handles on the crop box", hs.length === 8);
}

// ═══════════════════════════ mounted canvas ═══════════════════════════
const window = installDom();

/** The overlay only paints once the source reports loaded: a probe image
 *  answers synchronously from its src ("…/WxH"), like realCanvas2d's. */
class ProbeImage {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this._src = "";
    this.onload = null;
  }
  set src(v) {
    this._src = v;
    const m = /(\d+)x(\d+)/.exec(String(v));
    this.naturalWidth = m ? +m[1] : 400;
    this.naturalHeight = m ? +m[2] : 300;
    this.complete = this.naturalWidth > 0;
    if (this.complete && this.onload) this.onload();
  }
  get src() { return this._src; }
}
window.Image = ProbeImage;
globalThis.Image = ProbeImage;
// paint.ts probes `instanceof HTMLCanvasElement` on every image fill.
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.HTMLImageElement = window.HTMLImageElement;

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

const LEFT = 50, TOP = 30;
/** An image layer with a pre-set interior crop rect (200×200 box at 100,100;
 *  the probe reads 400×300 from the src). The engine revives the seed, so
 *  tests always read live state back through ui.node(id). */
const IMG = (extra = {}) =>
  node("rect", "Img", 100, 100, 200, 200, {
    imageSrc: "cropimg/400x300", fillType: "image", imageFit: "fill",
    imageCrop: { x: 0.2, y: 0.15, w: 0.4, h: 0.5 }, ...extra,
  });

async function mount(children, selection = [], view = {}) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "p", name: "Page", root: page(...children), guides: [], comments: [] }],
    page: 0, zoom: 1, panX: 0, panY: 0, ...view,
  });
  engine.dispatch({ type: "select", ids: selection });
  // Every dispatch the Canvas (or the test) makes is recorded: the session's
  // begin/end pairing is part of what category 7 asserts.
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
    root: () => engine.snapshot().pages[0].root,
    node: (id) => find(engine.snapshot().pages[0].root, id),
    world: (id, lx, ly) => localToWorld(engine.snapshot().pages[0].root, id, lx, ly),
    marker: () => paints.length,
    tail: (m) => paints.slice(m),
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
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
      await act(async () => surface.dispatchEvent(new window.MouseEvent("dblclick", {
        bubbles: true, cancelable: true, clientX: x + LEFT, clientY: y + TOP, button: 0, ...extra,
      })));
    },
    async key(key) {
      await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true,
      })));
    },
    async cropEvent(id = children[0].id) {
      await act(async () => window.dispatchEvent(new window.CustomEvent("x-native-crop-image", { detail: { id } })));
    },
    async dispatch(cmd) { await act(async () => engine.dispatch(cmd)); },
    async close() { await act(async () => reactRoot.unmount()); host.remove(); },
  };
  return ui;
}

/** The crop overlay's eight 8×8 handle fills in one paint tail. */
const cropHandleFills = (tail) =>
  tail.filter(([c, , , w, h]) => c === "fillRect" && w === 8 && h === 8);
const handleSet = (fills) =>
  new Set(fills.map(([, x, y]) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`));
const boxOf = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h });
const sameBox = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const types = (list) => list.map((c) => c.type);
const rectIs = (r, x, y, w, h, eps = 0.01) =>
  near(r.x, x, eps) && near(r.y, y, eps) && near(r.w, w, eps) && near(r.h, h, eps);

// ─────────────────────── 1 · entry ───────────────────────
console.log("1 · entry: double-click and the crop button");
{
  const img = IMG();
  const ui = await mount([img], []);
  const expectHandles = new Set(
    cropHandleRects({ x: 100, y: 100, w: 200, h: 200 }, 8)
      .map((h) => `${Math.round(h.x * 100) / 100},${Math.round(h.y * 100) / 100}`),
  );
  t("1-entry: no crop chrome before entry",
    cropHandleFills(ui.tail(ui.marker())).length === 0);
  // The inspector / context-menu route: both dispatch x-native-crop-image.
  const d0 = ui.dispatches.length;
  const m0 = ui.marker();
  await ui.cropEvent(img.id);
  t("1-entry: crop button enters crop mode (fill mode switches to Crop)",
    ui.node(img.id).imageFit === "crop", JSON.stringify(ui.node(img.id).imageFit));
  const fills = cropHandleFills(ui.tail(m0));
  const seen = handleSet(fills);
  t("1-entry: exactly 8 crop handles appear on the box",
    fills.length === 8 && seen.size === 8 && [...expectHandles].every((k) => seen.has(k)),
    JSON.stringify([...seen]));
  t("1-entry: the session opens ONE history group (begin first)",
    JSON.stringify(types(ui.dispatches.slice(d0, d0 + 3))) === JSON.stringify(["begin", "patch", "select"]),
    JSON.stringify(types(ui.dispatches.slice(d0))));
  // Esc reverts the fill mode inside the group and ends it — no entry left.
  const d1 = ui.dispatches.length;
  await ui.key("Escape");
  const escTail = types(ui.dispatches.slice(d1));
  t("1-entry: Esc reverts the mode and ends the session (patch → end)",
    ui.node(img.id).imageFit === "fill" && escTail[escTail.length - 1] === "end",
    JSON.stringify({ fit: ui.node(img.id).imageFit, escTail }));
  t("1-entry: begin/end stay balanced across entry and Esc",
    types(ui.dispatches).filter((x) => x === "begin").length === 1 &&
    types(ui.dispatches).filter((x) => x === "end").length === 1,
    JSON.stringify(types(ui.dispatches)));
  // Double-click on the image is the other documented entry.
  const m1 = ui.marker();
  await ui.dbl(200, 200);
  t("1-entry: double-click on the image enters crop mode",
    ui.node(img.id).imageFit === "crop" && cropHandleFills(ui.tail(m1)).length === 8,
    JSON.stringify(types(ui.dispatches)));
  await ui.close();
}
{
  // Control: double-click on a non-image layer opens nothing.
  const rect = node("rect", "Plain", 100, 100, 200, 200);
  const ui = await mount([rect], []);
  const m0 = ui.marker();
  await ui.dbl(200, 200);
  t("1-entry: double-click on a non-image opens no crop mode",
    cropHandleFills(ui.tail(m0)).length === 0 && ui.node(rect.id).imageFit === "fill",
    JSON.stringify(types(ui.dispatches)));
  await ui.close();
}

// ─────────────────── 2 · eight handles resize ───────────────────
console.log("2 · handles: all eight resize the region, anchor intact");
{
  const img = IMG({ imageCrop: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 } });
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  // Free (⌃) so each drag's maths is pointer-exact: every handle moves its
  // own side(s) outward and leaves the opposite sides — the focal anchor —
  // exactly where they were. The layer box never changes.
  const handles = [
    ["nw", 100, 100, 80, 80], ["n", 200, 100, 200, 80], ["ne", 300, 100, 320, 80],
    ["e", 300, 200, 320, 200], ["se", 300, 300, 320, 320], ["s", 200, 300, 200, 320],
    ["sw", 100, 300, 80, 320], ["w", 100, 200, 80, 200],
  ];
  let ok = true, detail = "";
  for (const [name, x0, y0, x1, y1] of handles) {
    const before = { ...ui.node(img.id).imageCrop };
    const boxBefore = boxOf(ui.node(img.id));
    await ui.drag(x0, y0, x1, y1, { ctrlKey: true });
    const after = { ...ui.node(img.id).imageCrop };
    const boxAfter = boxOf(ui.node(img.id));
    const dirs = {
      nw: ["w", "n"], n: ["n"], ne: ["n", "e"], e: ["e"],
      se: ["s", "e"], s: ["s"], sw: ["s", "w"], w: ["w"],
    }[name];
    const stepOk =
      JSON.stringify(before) !== JSON.stringify(after) &&
      (dirs.includes("w") ? after.x < before.x : near(after.x, before.x)) &&
      (dirs.includes("e") ? after.x + after.w > before.x + before.w : near(after.x + after.w, before.x + before.w)) &&
      (dirs.includes("n") ? after.y < before.y : near(after.y, before.y)) &&
      (dirs.includes("s") ? after.y + after.h > before.y + before.h : near(after.y + after.h, before.y + before.h)) &&
      sameBox(boxBefore, boxAfter);
    if (!stepOk) { ok = false; detail = `${name}: ${JSON.stringify({ before, after, boxAfter })}`; }
  }
  t("2-handles: each of the 8 handles resizes its side, opposite sides (the focal point) stay, box unchanged",
    ok, detail);
  await ui.close();
}

// ─────────────────── 3 · aspect lock ───────────────────
console.log("3 · aspect lock: default and ⇧ lock, ⌘/⌃ frees");
async function aspectBlock(label, extra, expect) {
  const img = IMG();
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  // SE handle at (300,300) dragged to local (170,100): u = 0.54, v = 0.4.
  await ui.drag(300, 300, 270, 200, extra);
  const r = { ...ui.node(img.id).imageCrop };
  const ok = expect.locked
    ? near(r.w, 0.34) && near(r.h, 0.34)
    : near(r.w, 0.34) && near(r.h, 0.25);
  t(`${label}: ${expect.locked ? "region keeps the original image's aspect (w ≈ h)" : "region follows the pointer (w ≠ h)"}`,
    ok && near(r.x, 0.2) && near(r.y, 0.15), JSON.stringify(r));
  await ui.close();
}
await aspectBlock("3-aspect: default drag locks", {}, { locked: true });
await aspectBlock("3-aspect: ⇧ forces the lock", { shiftKey: true }, { locked: true });
await aspectBlock("3-aspect: ⌘/⌃ alone frees the aspect", { ctrlKey: true }, { locked: false });
await aspectBlock("3-aspect: ⇧ wins over ⌃ (⇧⌃ still locks)", { shiftKey: true, ctrlKey: true }, { locked: true });

// ─────────────────── 4 · focal movement ───────────────────
console.log("4 · focal movement: the body pans the picture, not the box");
{
  const img = IMG();
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  const boxBefore = boxOf(ui.node(img.id));
  const r0 = { ...ui.node(img.id).imageCrop };
  // Grab the middle and drag +60/+40: grab-style → the window slides the
  // other way, so x/y shrink. The layer box is never touched.
  await ui.drag(200, 200, 260, 240);
  const r1 = { ...ui.node(img.id).imageCrop };
  t("4-focal: body drag pans the image (picture follows the pointer)",
    near(r1.x, 0.08) && near(r1.y, 0.05) && near(r1.w, r0.w) && near(r1.h, r0.h),
    JSON.stringify({ r0, r1 }));
  t("4-focal: body drag never moves the crop bounding box",
    sameBox(boxBefore, boxOf(ui.node(img.id))), JSON.stringify(boxOf(ui.node(img.id))));
  await ui.close();
}

// ─────────────────── 5 · rotation in crop ───────────────────
console.log("5 · rotation: the chrome expands to the rotated bounds");
{
  // Own rotation applied while the mode is open: the handles ride the rotated
  // corners — the screen AABB of the box grows past the unrotated bounds.
  const img = IMG();
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  await ui.dispatch({ type: "patch", id: img.id, patch: { rotation: 45 } });
  const se = ui.world(img.id, 200, 200);
  t("5-rotation: a 45° box expands its handle bounds below the unrotated edge",
    se.y > 310, JSON.stringify(se));
  const r0 = { ...ui.node(img.id).imageCrop };
  const box0 = boxOf(ui.node(img.id));
  const target = ui.world(img.id, 230, 230);
  await ui.drag(se.x, se.y, target.x, target.y);
  const r1 = { ...ui.node(img.id).imageCrop };
  t("5-rotation: grabbing the rotated SE corner resizes with the corner anchor",
    near(r1.x, r0.x) && near(r1.y, r0.y) && r1.w > r0.w && r1.h > r0.h,
    JSON.stringify({ r0, r1 }));
  t("5-rotation: the box keeps its geometry and its angle",
    sameBox(box0, boxOf(ui.node(img.id))) && near(ui.node(img.id).rotation, 45),
    JSON.stringify(boxOf(ui.node(img.id))));
  // The pre-rotation corner position is no longer on a handle: it misses the
  // window entirely and the press applies the crop.
  const r2 = { ...ui.node(img.id).imageCrop };
  const m0 = ui.marker();
  await ui.drag(300, 300, 300, 300);
  t("5-rotation: the unrotated corner position misses (click-away applies)",
    cropHandleFills(ui.tail(m0)).length === 0 &&
    JSON.stringify({ ...ui.node(img.id).imageCrop }) === JSON.stringify(r2),
    JSON.stringify({ r2, now: { ...ui.node(img.id).imageCrop } }));
  await ui.close();
}
{
  // Rotated ancestry (the P1 constraint): an image inside a 90° frame still
  // takes its handle presses at the composed screen positions.
  const child = node("rect", "Kid", 60, 60, 160, 120, {
    imageSrc: "cropimg/400x300", fillType: "image", imageFit: "crop",
    imageCrop: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
  });
  const frame = node("frame", "F", 100, 100, 400, 400, { rotation: 90, children: [child] });
  const ui = await mount([frame], []);
  await ui.cropEvent(child.id);
  const se = ui.world(child.id, 160, 120);
  const target = ui.world(child.id, 190, 150);
  const r0 = { ...ui.node(child.id).imageCrop };
  await ui.drag(se.x, se.y, target.x, target.y);
  const r1 = { ...ui.node(child.id).imageCrop };
  t("5-rotation: handle grab lands at the rotated screen corner inside a rotated frame",
    near(r1.x, r0.x) && near(r1.y, r0.y) && r1.w > r0.w && r1.h > r0.h,
    JSON.stringify({ se, r0, r1 }));
  // Where the corner would sit without the ancestor's rotation: outside the
  // rotated window, so the press applies instead of grabbing.
  const r2 = { ...ui.node(child.id).imageCrop };
  const m0 = ui.marker();
  await ui.drag(160, 280, 160, 280);
  t("5-rotation: the translation-only corner misses under rotated ancestry",
    cropHandleFills(ui.tail(m0)).length === 0 &&
    JSON.stringify({ ...ui.node(child.id).imageCrop }) === JSON.stringify(r2),
    JSON.stringify({ r2, now: { ...ui.node(child.id).imageCrop } }));
  await ui.close();
}
{
  // Rotating the fill (imageRot 90°) inside the mode: the crop bounds expand
  // to the rotated picture, and drags start from the swapped-dims cover.
  const img = node("rect", "Rot", 100, 100, 400, 400, {
    imageSrc: "cropimg/800x400", fillType: "image", imageFit: "fill", imageRot: 90,
  });
  const ui = await mount([img], []);
  const m0 = ui.marker();
  await ui.cropEvent(img.id);
  const tail = ui.tail(m0);
  const eof = tail.map((c) => c[0] === "fill" && c[1] === "evenodd").lastIndexOf(true);
  const faded = eof >= 0 && tail.slice(eof).find(
    (c) => c[0] === "drawImage" && c.length === 6 && c[1]?.width === 400 && c[1]?.height === 800 && near(c[4], 400) && near(c[5], 800),
  );
  t("5-rotation: the faded crop draws the expanded rotated raster (800×400 → 400×800)",
    !!faded, JSON.stringify({ eof, faded: !!faded, source: faded && [faded[1].width, faded[1].height] }));
  t("5-rotation: 8 handles still appear for the rotated fill",
    cropHandleFills(tail).length === 8);
  // South-edge drag: the start rect is the cover of the SWAPPED dims
  // (400×800 → y 0.25, h 0.5), not the unrotated cover (y 0, h 1).
  await ui.drag(300, 500, 300, 540);
  const r = { ...ui.node(img.id).imageCrop };
  t("5-rotation: handle drag starts from the rotation-aware cover region",
    rectIs(r, 0, 0.25, 1, 0.55), JSON.stringify(r));
  await ui.close();
}

// ─────────────────── 6 · modifiers ───────────────────
console.log("6 · modifiers: ⌥ from the centre, ⇧ locks");
{
  const img = IMG();
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  await ui.drag(300, 300, 270, 230, { altKey: true });
  const r = { ...ui.node(img.id).imageCrop };
  t("6-modifiers: ⌥+corner resizes from the centre (centre invariant, aspect kept)",
    near(r.x + r.w / 2, 0.4) && near(r.y + r.h / 2, 0.4) && near(r.w, r.h),
    JSON.stringify(r));
  await ui.close();
}
{
  const img = IMG();
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  await ui.drag(300, 300, 270, 230);
  const r = { ...ui.node(img.id).imageCrop };
  // Same pointer, no ⌥: the anchor stays the opposite corner, centre moves.
  t("6-modifiers: without ⌥ the anchor is the opposite corner (centre moves)",
    near(r.x, 0.2) && near(r.y, 0.15) &&
    !(near(r.x + r.w / 2, 0.4) && near(r.y + r.h / 2, 0.4)),
    JSON.stringify(r));
  await ui.close();
}

// ─────────────────── 7 · commit & single undo ───────────────────
console.log("7 · commit: Enter applies, one undo step for the whole session");
{
  const img = IMG();
  const rect = node("rect", "R", 400, 100, 100, 80);
  const ui = await mount([img, rect], []);
  // A pre-crop edit: its undo entry must survive the session as its own step.
  await ui.dispatch({ type: "move", ids: [rect.id], dx: 30, dy: 0 });
  t("7-undo: pre-crop edit lands (baseline)", near(ui.node(rect.id).x, 430));
  const d0 = ui.dispatches.length;
  await ui.dbl(200, 200);
  await ui.drag(300, 300, 270, 230); // handle resize
  await ui.drag(200, 200, 260, 240); // focal pan
  await ui.key("Enter");
  const session = types(ui.dispatches.slice(d0));
  const begins = session.filter((x) => x === "begin").length;
  const ends = session.filter((x) => x === "end").length;
  t("7-undo: entry + two gestures + apply = balanced begin/end pairs",
    begins === 3 && ends === 3 && session[0] === "begin" && session[session.length - 1] === "end",
    JSON.stringify(session));
  const applied = { ...ui.node(img.id).imageCrop };
  t("7-undo: Enter applies the crop (rect kept, mode Crop, chrome closed)",
    !rectIs(applied, 0.2, 0.15, 0.4, 0.5) && ui.node(img.id).imageFit === "crop" &&
    cropHandleFills(ui.tail(ui.marker())).length === 0,
    JSON.stringify({ applied, fit: ui.node(img.id).imageFit }));
  // ONE undo reverts the entire session — mode, handle drag and pan together —
  // while the pre-crop edit stays put; a second undo takes that one.
  await ui.dispatch({ type: "undo" });
  const reverted = { ...ui.node(img.id).imageCrop };
  t("7-undo: one undo reverts the whole crop (rect + fill mode together)",
    rectIs(reverted, 0.2, 0.15, 0.4, 0.5) && ui.node(img.id).imageFit === "fill",
    JSON.stringify({ reverted, fit: ui.node(img.id).imageFit }));
  t("7-undo: the pre-crop edit is untouched by that undo (crop = exactly one step)",
    near(ui.node(rect.id).x, 430), JSON.stringify(ui.node(rect.id).x));
  await ui.dispatch({ type: "redo" });
  const redone = { ...ui.node(img.id).imageCrop };
  t("7-undo: one redo restores the whole session",
    rectIs(redone, applied.x, applied.y, applied.w, applied.h) && ui.node(img.id).imageFit === "crop",
    JSON.stringify({ redone, applied }));
  await ui.dispatch({ type: "undo" });
  await ui.dispatch({ type: "undo" });
  t("7-undo: a second undo takes the pre-crop edit, proving the crop was one step",
    near(ui.node(rect.id).x, 400), JSON.stringify(ui.node(rect.id).x));
  // The group stack must be closed: a fresh edit is its own undo entry.
  await ui.dispatch({ type: "patch", id: rect.id, patch: { x: 455 } });
  await ui.dispatch({ type: "undo" });
  t("7-undo: no group leaks — a later edit undoes on its own",
    near(ui.node(rect.id).x, 400), JSON.stringify(ui.node(rect.id).x));
  await ui.close();
}
{
  // Click-away applies: the press outside the window keeps the edits.
  const img = IMG();
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  await ui.drag(300, 300, 270, 230);
  const applied = { ...ui.node(img.id).imageCrop };
  await ui.drag(500, 400, 500, 400);
  t("7-undo: click outside the window applies the crop",
    JSON.stringify({ ...ui.node(img.id).imageCrop }) === JSON.stringify(applied) &&
    cropHandleFills(ui.tail(ui.marker())).length === 0,
    JSON.stringify({ applied, now: { ...ui.node(img.id).imageCrop } }));
  const begins = types(ui.dispatches).filter((x) => x === "begin").length;
  const ends = types(ui.dispatches).filter((x) => x === "end").length;
  t("7-undo: click-away leaves begin/end balanced (session ended exactly once)",
    begins === ends, JSON.stringify({ begins, ends }));
  await ui.close();
}
{
  // Esc leaves no trace in history: the next undo takes the PRE-crop edit.
  const img = IMG();
  const rect = node("rect", "R", 400, 100, 100, 80);
  const ui = await mount([img, rect], []);
  await ui.dispatch({ type: "move", ids: [rect.id], dx: 30, dy: 0 });
  await ui.cropEvent(img.id);
  await ui.drag(300, 300, 270, 230);
  await ui.key("Escape");
  const back = { ...ui.node(img.id).imageCrop };
  t("7-undo: Esc restores the entry snapshot (rect + fill mode)",
    rectIs(back, 0.2, 0.15, 0.4, 0.5) && ui.node(img.id).imageFit === "fill",
    JSON.stringify({ back, fit: ui.node(img.id).imageFit }));
  await ui.dispatch({ type: "undo" });
  t("7-undo: Esc consumed no history — the undo takes the pre-crop move",
    near(ui.node(rect.id).x, 400), JSON.stringify(ui.node(rect.id).x));
  await ui.close();
}

// ─────────────────── 8 · ratio, zoom, resize-to-fit controls ───────────────────
{
  const img = IMG();
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  const toolbar = ui.host.querySelector('[aria-label="Image crop controls"]');
  const aspect = toolbar?.querySelector('[aria-label="Crop aspect ratio"]');
  const zoom = toolbar?.querySelector('[aria-label="Crop zoom"]');
  const rotation = toolbar?.querySelector('[aria-label="Crop rotation"]');
  const fit = [...(toolbar?.querySelectorAll("button") ?? [])].find((b) => b.textContent.includes("Resize to fit"));
  t("8-controls: crop toolbar exposes aspect, zoom, rotation, and resize-to-fit controls", !!aspect && !!zoom && !!rotation && !!fit);
  if (aspect && zoom && rotation && fit) {
    await act(async () => {
      aspect.value = "16:9";
      aspect.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    t("8-aspect: selecting 16:9 updates the active crop ratio preset", aspect.value === "16:9");
    await ui.drag(300, 300, 290, 280);
    const ratioCrop = { ...ui.node(img.id).imageCrop };
    t("8-aspect: handle resize applies 16:9 in source-pixel space",
      near(ratioCrop.w / ratioCrop.h, (16 / 9) * (300 / 400), 0.02), JSON.stringify(ratioCrop));
    const beforeZoom = { ...ui.node(img.id).imageCrop };
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(zoom, "200");
      zoom.dispatchEvent(new window.Event("input", { bubbles: true }));
      zoom.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const afterZoom = { ...ui.node(img.id).imageCrop };
    t("8-zoom: 200% zoom narrows the crop around its centre", near(afterZoom.w, beforeZoom.w / 2, 0.02) && near(afterZoom.h, beforeZoom.h / 2, 0.02), JSON.stringify({ beforeZoom, afterZoom }));
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(rotation, "45");
      rotation.dispatchEvent(new window.Event("input", { bubbles: true }));
      rotation.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    t("8-rotation: free-rotation slider patches the image fill angle", ui.node(img.id).imageRot === 45, String(ui.node(img.id).imageRot));
    await act(async () => fit.click());
    t("8-fit: Resize to fit uses the rotated image bounds and clears crop data",
      ui.node(img.id).w === 495 && ui.node(img.id).h === 495 && ui.node(img.id).imageCrop === undefined,
      JSON.stringify({ w: ui.node(img.id).w, h: ui.node(img.id).h, crop: ui.node(img.id).imageCrop }));
    await ui.key("Escape");
    t("8-cancel: Escape restores crop, frame size, rotation, and prior fill mode",
      rectIs(ui.node(img.id).imageCrop, 0.2, 0.15, 0.4, 0.5) && ui.node(img.id).w === 200 && ui.node(img.id).h === 200 && ui.node(img.id).imageRot === 0 && ui.node(img.id).imageFit === "fill",
      JSON.stringify({ crop: ui.node(img.id).imageCrop, w: ui.node(img.id).w, h: ui.node(img.id).h, rotation: ui.node(img.id).imageRot, fit: ui.node(img.id).imageFit }));
  }
  await ui.close();
}

// ─────────────────── 9 · quick crop, edge-resize, and free-rotation gestures ───────────────────
{
  const img = IMG({ imageCrop: undefined });
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  const before = { x: 0.125, y: 0, w: 0.75, h: 1 }; // 400×300 cover crop into a 200×200 layer
  await ui.drag(333.33, 200, 363.33, 200);
  const after = { ...ui.node(img.id).imageCrop };
  t("9-edge-resize: dragging the faded image edge zooms the image inside a stable layer box",
    after.w < before.w && after.h < before.h && ui.node(img.id).w === 200 && ui.node(img.id).h === 200,
    JSON.stringify({ before, after, frame: [ui.node(img.id).w, ui.node(img.id).h] }));
  await ui.close();
}
{

  const img = IMG({ imageCrop: undefined });
  const ui = await mount([img], [img.id]);
  await ui.drag(300, 300, 280, 280, { ctrlKey: true });
  t("9-quick-crop: Control-dragging a selected image corner enters and edits Crop",
    ui.node(img.id).imageFit === "crop" && !!ui.node(img.id).imageCrop,
    JSON.stringify({ fit: ui.node(img.id).imageFit, crop: ui.node(img.id).imageCrop }));
  await ui.key("Enter");
  t("9-quick-crop: Enter commits the quick-crop session", cropHandleFills(ui.tail(ui.marker())).length === 0 && ui.node(img.id).imageFit === "crop");
  await ui.close();
}
{
  const img = IMG({ imageCrop: undefined });
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  const center = { x: 200, y: 200 };
  const start = { x: 347.33, y: 85.67 };
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const delta = Math.PI / 6;
  const finish = {
    x: center.x + Math.cos(startAngle + delta) * radius,
    y: center.y + Math.sin(startAngle + delta) * radius,
  };
  await ui.drag(start.x, start.y, finish.x, finish.y);
  t("9-rotate: dragging an outside image corner freely rotates the fill", near(ui.node(img.id).imageRot, 30, 1), JSON.stringify({ rotation: ui.node(img.id).imageRot, finish }));
  await ui.key("Escape");
  t("9-rotate: Escape restores the source orientation", ui.node(img.id).imageRot === 0);
  await ui.close();
}
{
  const img = IMG({ imageCrop: undefined });
  const ui = await mount([img], []);
  await ui.cropEvent(img.id);
  const center = { x: 200, y: 200 };
  const start = { x: 347.33, y: 85.67 };
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const delta = (22 * Math.PI) / 180;
  const finish = {
    x: center.x + Math.cos(startAngle + delta) * radius,
    y: center.y + Math.sin(startAngle + delta) * radius,
  };
  await ui.drag(start.x, start.y, finish.x, finish.y, { shiftKey: true });
  t("9-rotate: Shift snaps arbitrary rotation to 15° increments", near(ui.node(img.id).imageRot, 15, 1), JSON.stringify({ rotation: ui.node(img.id).imageRot }));
  await ui.close();
}

console.log(`imageCropInteraction: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
