/** Batch 1: real Canvas event handlers + recorded canvas paint calls in jsdom.
 * This tests interaction wiring, not browser pixels or font/layout fidelity. */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, hitTest } from "../../engine/memory.ts";
import { canvasClickTarget, drillChild, frameRotationHandle, rotationHandleHit } from "../canvasSelection.ts";

let pass = 0, fail = 0;
const t = (name, ok) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const shape = (kind, name, children = [], extra = {}) => node(kind, name, 100, 100, 400, 400, { children, ...extra });
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

// Pure selection policy uses the existing geometry for paint order, transforms,
// visibility, inherited locks and clipping; it never reimplements box hits.
{
  const leaf = shape("rect", "Leaf", [], { x: 40, y: 40, w: 60, h: 60 });
  const inner = shape("group", "Inner", [leaf], { x: 30, y: 30, w: 200, h: 200 });
  const outer = shape("frame", "Outer", [inner]);
  const root = page(outer);
  t("plain click selects the top-level frame", canvasClickTarget(root, 180, 180, []) === outer);
  t("selected parent does not drill on single click", canvasClickTarget(root, 180, 180, [outer.id]) === outer);
  t("double-click selects the immediate child, not the deepest leaf", drillChild(root, outer, 180, 180) === inner);
  t("subsequent presses preserve the drilled scope", canvasClickTarget(root, 180, 180, [inner.id]) === inner);
  t("another double-click drills one more level", drillChild(root, inner, 180, 180) === leaf);
  t("Cmd/Ctrl deep hit still skips all containers", hitTest(root, 180, 180, { deep: true }) === leaf);
  t("empty canvas has no target", canvasClickTarget(root, 900, 900, []) === null);
  const top = shape("rect", "Top", [], { x: 40, y: 40, w: 60, h: 60 });
  inner.children.push(top);
  t("overlapping children pick the frontmost", drillChild(root, inner, 180, 180) === top);
  top.locked = true;
  t("locked child is skipped", drillChild(root, inner, 180, 180) === leaf);
  top.locked = false;
  top.visible = false;
  t("hidden child is skipped", drillChild(root, inner, 180, 180) === leaf);
  leaf.locked = true;
  t("all unavailable children leave selection unchanged", drillChild(root, inner, 180, 180) === null);
  leaf.locked = false;
  t("empty container space falls back to first selectable child", drillChild(root, inner, 310, 310) === leaf);
  outer.locked = true;
  t("inherited lock prevents drilling", drillChild(root, inner, 180, 180) === null);
}
{
  const a = shape("rect", "A", [], { x: 20, y: 20, w: 50, h: 50 });
  const b = shape("rect", "B", [], { x: 100, y: 20, w: 50, h: 50 });
  const group = shape("group", "Group", [a, b]);
  const root = page(group);
  t("clicking siblings stays in the opened scope", canvasClickTarget(root, 220, 140, [a.id]) === b);
  t("fresh group selection remains parent-first", canvasClickTarget(root, 220, 140, []) === group);
  group.kind = "boolean";
  t("boolean members drill without flattening", drillChild(root, group, 220, 140) === b);
}
{
  const child = shape("rect", "Rotated child", [], { x: 20, y: 20, w: 80, h: 40 });
  const decoy = shape("rect", "Decoy", [], { x: 180, y: 100, w: 40, h: 40 });
  const rotated = shape("frame", "Rotated", [decoy, child], { w: 300, h: 200, rotation: 90 });
  const root = page(rotated);
  // Local (60,40) -> world (310,110) after rotating about (250,200).
  t("drilling honors the parent's rotation", drillChild(root, rotated, 310, 110) === child);
  rotated.rotation = 0;
  rotated.flipH = true;
  t("drilling honors a flipped parent", drillChild(root, rotated, 340, 140) === child);
}
for (const kind of ["frame", "component", "instance"]) {
  for (const zoom of [0.25, 1, 4]) {
    const x = 100, y = 120, w = 300 * zoom, h = 200 * zoom;
    const p = frameRotationHandle(kind, x, y, w);
    // Figma places the rotation target above the top-right corner (x+w, y-20),
    // not at top-center. See frameRotationHandle in canvasSelection.ts.
    t(`${kind} handle sits above the top-right corner at zoom ${zoom}`, p.x === x + w && p.y === y - 20);
    t(`${kind} detached handle is hittable at zoom ${zoom}`, rotationHandleHit(kind, p.x, p.y, x, y, w, h));
    t(`${kind} corners no longer rotate at zoom ${zoom}`, [[x, y], [x+w, y], [x+w, y+h], [x, y+h]].every(([cx, cy]) => !rotationHandleHit(kind, cx - 10, cy - 10, x, y, w, h)));
  }
}
t("ordinary shapes retain corner rotation at top-right", rotationHandleHit("rect", 400 + 16, 100 - 16, 100, 100, 300, 200));
t("group rotation uses top-right ring", rotationHandleHit("group", 400 + 16, 100 - 16, 100, 100, 300, 200));
t("ordinary shapes do NOT rotate from top-left corner", !rotationHandleHit("rect", 90, 90, 100, 100, 300, 200));

// Mount Canvas itself. Paint calls are recorded so culling is tested through
// the renderer, rather than through a regex or a duplicated visibility rule.
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
    snap: () => engine.snapshot(),
    node: (id) => find(engine.snapshot().pages[0].root, id),
    async dispatch(cmd) {
      paints = [];
      await act(async () => engine.dispatch(cmd));
    },
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
      })));
    },
    async click(x, y, extra = {}) {
      await ui.mouse("mousedown", x, y, extra);
      await ui.mouse("mouseup", x, y, extra);
    },
    async dbl(x, y) {
      await ui.click(x, y, { detail: 1 });
      await ui.click(x, y, { detail: 2 });
      await ui.mouse("dblclick", x, y, { detail: 2 });
    },
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
  return ui;
}
const paintedName = (name) => paints.some(([call, value]) => call === "fillText" && value === name);
{
  const child = shape("frame", "Nested name", [], { x: 30, y: 50, w: 120, h: 100 });
  const group = shape("group", "Parent", [child]);
  const sibling = shape("frame", "Sibling name", [], { x: 600, y: 100, w: 150, h: 120 });
  const ui = await mount([group, sibling]);
  t("unselected child frame name is painted", paintedName(child.name));
  await ui.dispatch({ type: "select", ids: [group.id] });
  t("selected group culls child name", !paintedName(child.name));
  t("unrelated sibling name stays visible", paintedName(sibling.name));
  await ui.mouse("dblclick", 140, 140);
  t("culled label does not open rename", !ui.host.querySelector(".frame-name-edit"));
  await ui.dispatch({ type: "select", ids: [child.id] });
  t("selecting only the child restores its name", paintedName(child.name));
  await ui.dispatch({ type: "select", ids: [group.id, child.id] });
  t("explicitly selected child keeps its label beside a selected ancestor", paintedName(child.name));
  await ui.dispatch({ type: "select", ids: [] });
  await ui.dispatch({ type: "patch", id: group.id, patch: { visible: false } });
  t("hidden ancestor hides descendant labels", !paintedName(child.name));
  await ui.close();
}
{
  const text = shape("text", "Text", [], { x: 40, y: 40, w: 100, h: 80, text: "Hello" });
  const group = shape("group", "Inner group", [text], { x: 30, y: 30, w: 250, h: 220 });
  const outer = shape("frame", "Outer frame", [group]);
  const ui = await mount([outer]);
  await ui.click(200, 200);
  t("mounted canvas single click selects the frame", ui.snap().selection[0] === outer.id);
  await ui.dbl(200, 200);
  t("mounted double-click drills to group", ui.snap().selection[0] === group.id);
  t("first drill does not edit nested text", !ui.host.querySelector("textarea"));
  await ui.dbl(200, 200);
  t("repeated double-click drills to text", ui.snap().selection[0] === text.id);
  t("selecting text through a container does not skip into editing", !ui.host.querySelector("textarea"));
  await ui.dbl(200, 200);
  t("double-click on selected text still starts editing", !!ui.host.querySelector("textarea"));
  await ui.close();
  for (const modifier of ["metaKey", "ctrlKey"]) {
    const deep = await mount([outer]);
    await deep.click(200, 200, { [modifier]: true });
    t(`${modifier} still selects the deepest leaf in one press`, deep.snap().selection[0] === text.id);
    await deep.close();
  }
}
// The rotate affordance is a cursor and an invisible band, nothing painted —
// Figma draws no handle (batch 45 settled it against a screenshot), and these
// assertions are what keep a future "let's show a little dot" from creeping back:
// an arc anywhere near the target is the regression, not a missing feature.
const arcsNear = (x, y, r = 26) =>
  paints.filter(([call, cx, cy, radius]) => call === "arc" && Math.hypot(cx - x, cy - y) <= r && radius <= r);
{
  const frame = shape("frame", "Rotatable", [], { w: 300, h: 200 });
  const ui = await mount([frame], [frame.id]);
  // The grab band is centred 20px above the top-right corner: (400, 80).
  t("nothing is painted at the rotation target", arcsNear(400, 80).length === 0,
    JSON.stringify(arcsNear(400, 80).slice(0, 2)));
  await ui.mouse("mousemove", 400, 80);
  t("hovering the target still paints nothing", arcsNear(400, 80).length === 0);
  const rotateCursor = ui.surface.style.cursor;
  t("the band advertises the rotation cursor", rotateCursor.includes("url("), rotateCursor.slice(0, 24));
  await ui.mouse("mousemove", 90, 90);
  t("outside the band the cursor goes away", ui.surface.style.cursor !== rotateCursor);
  // Drag the rotation target to a new spot to induce rotation.
  await ui.mouse("mousedown", 400, 80);
  await ui.mouse("mousemove", 480, 140, { shiftKey: true });
  await ui.mouse("mouseup", 480, 140);
  t("dragging inside the band rotates the frame", Math.abs(ui.node(frame.id).rotation) > 20);
  await ui.dispatch({ type: "undo" });
  t("rotation is a single undoable gesture", ui.node(frame.id).rotation === 0);
  // TL corner still resizes (does not rotate).
  await ui.mouse("mousedown", 100, 100);
  await ui.mouse("mousemove", 80, 80);
  await ui.mouse("mouseup", 80, 80);
  t("frame corner still resizes without rotation", ui.node(frame.id).w > 300 && ui.node(frame.id).rotation === 0);
  await ui.close();
}
{
  const frame = shape("frame", "Locked frame", [], { w: 300, h: 200, locked: true });
  const ui = await mount([frame], [frame.id]);
  t("locked frame paints no rotate chrome at the target", arcsNear(400, 80).length === 0);
  // Both halves of the removal, in one place: no chrome and no affordance, because
  // the paint used to be the only thing telling you the target existed.
  await ui.mouse("mousemove", 400, 80);
  t("a locked frame does not advertise the rotate cursor either", !ui.surface.style.cursor.includes("url("),
    ui.surface.style.cursor.slice(0, 24));
  await ui.mouse("mousedown", 400, 80);
  await ui.mouse("mousemove", 480, 140);
  await ui.mouse("mouseup", 480, 140);
  t("locked frame cannot rotate from the band", ui.node(frame.id).rotation === 0);
  await ui.close();
}
// Selection barriers must protect vector entry as well as text entry.
{
  const rect = shape("rect", "Shape", [], { x: 40, y: 40, w: 100, h: 80 });
  const parent = shape("group", "Group", [rect]);
  const ui = await mount([parent]);
  await ui.dbl(180, 180);
  t("double-click selects a grouped shape without entering vector edit", ui.snap().selection[0] === rect.id && !ui.snap().vecEdit);
  await ui.dbl(180, 180);
  t("next double-click enters the selected shape's vector editor", ui.snap().vecEdit === rect.id);
  await ui.close();
}
{
  const child = shape("frame", "Descendant name", [], { x: 30, y: 60, w: 100, h: 80 });
  const middle = shape("group", "Middle", [child], { x: 30, y: 30, w: 200, h: 200 });
  const parent = shape("frame", "Ancestor name", [middle]);
  const ui = await mount([parent]);
  t("frame nested through a group initially has a name", paintedName(child.name));
  await ui.dispatch({ type: "select", ids: [parent.id] });
  t("selected frame culls names through intervening groups", !paintedName(child.name));
  t("selected frame retains its own label", paintedName(parent.name));
  await ui.dispatch({ type: "select", ids: [] });
  await ui.dispatch({ type: "patch", id: child.id, patch: { showName: false } });
  t("showName=false remains respected", !paintedName(child.name));
  await ui.mouse("dblclick", 110, 90);
  t("visible frame label still opens rename", !!ui.host.querySelector(".frame-name-edit"));
  // Figma's inline rename field sits in the document as a plain rectangle -
  // the accent hairline with square corners - not as a rounded chip.
  const renameField = ui.host.querySelector(".frame-name-edit input");
  t("frame rename field is square-cornered (pre-fix: 4px radius)",
    !!renameField && renameField.style.borderRadius === "0px" &&
    parseFloat(getComputedStyle(renameField).borderTopLeftRadius) === 0);
  await ui.close();
}
// The detailed audit explicitly exempts selected children from label culling,
// including a frame directly inside another frame (not just through a group).
{
  const child = shape("frame", "Selected child name", [], { x: 30, y: 60, w: 100, h: 80 });
  const sibling = shape("frame", "Unselected child name", [], { x: 180, y: 60, w: 100, h: 80 });
  const parent = shape("frame", "Selected parent name", [child, sibling]);
  const ui = await mount([parent], [parent.id]);
  t("selected frame shows only its name with unselected direct children", paintedName(parent.name) && !paintedName(child.name) && !paintedName(sibling.name));
  await ui.dispatch({ type: "select", ids: [parent.id, child.id] });
  t("explicit direct child selection preserves both parent and child labels", paintedName(parent.name) && paintedName(child.name));
  t("unselected sibling stays culled when another child is selected", !paintedName(sibling.name));
  await ui.dispatch({ type: "patch", id: child.id, patch: { showName: false } });
  t("explicit selection does not override showName=false", !paintedName(child.name));
  await ui.dispatch({ type: "patch", id: child.id, patch: { showName: true, visible: false } });
  t("explicit selection does not show a hidden child's name", !paintedName(child.name));
  await ui.dispatch({ type: "patch", id: child.id, patch: { visible: true } });
  await ui.mouse("dblclick", 140, 150);
  t("explicitly selected child label remains a rename target", ui.host.querySelector(".frame-name-edit input")?.value === child.name);
  await ui.close();
}
// Own rotation/flip, pan, zoom and a nonzero DOM canvas offset must agree
// between paint, hover and mousedown for the detached rotation target, which
// sits above the top-right corner (screen space: offset scales with zoom).
for (const zoom of [0.25, 1, 4]) {
  const frame = shape("frame", "Transformed", [], { w: 300, h: 200 });
  const panX = 35, panY = 45;
  // frameRotationHandle works in screen (post-zoom/post-pan) coordinates
  // matching the sx/sy/sw/sh values passed in Canvas paint.
  const sx = panX + 100 * zoom;
  const sy = panY + 100 * zoom;
  const sw = 300 * zoom;
  const sh = 200 * zoom;
  // Top-right corner screen pos + 20px up (constant in screen px per
  // frameRotationHandle, which takes already-zoomed coordinates).
  const hx = sx + sw;
  const hy = sy - 20;
  const cx = sx + sw / 2;
  const cy = sy + sh / 2;
  const ui = await mount([frame], [frame.id], { zoom, panX, panY });
  await ui.mouse("mousemove", hx, hy);
  t(`transformed handle hover (0deg, zoom ${zoom})`, ui.surface.style.cursor.includes("url("));
  await ui.mouse("mousedown", hx, hy);
  const startA = Math.atan2(hy - cy, hx - cx);
  const a = startA + Math.PI / 12;
  const reach = Math.hypot(hx - cx, hy - cy);
  const tx = cx + reach * Math.cos(a);
  const ty = cy + reach * Math.sin(a);
  await ui.mouse("mousemove", tx, ty, { shiftKey: true });
  await ui.mouse("mouseup", tx, ty);
  t(`transformed handle drag rotates +15° (zoom ${zoom})`, Math.abs(ui.node(frame.id).rotation - 15) <= 1);
  await ui.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
