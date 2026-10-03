/** Run 18: high-impact multi-selection transform regressions.
 * Pure transform maps plus mounted canvas pointer sequences cover mixed kinds,
 * 3/10+ members, nested ancestors, rotation, group resize and constraints.
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, localToWorld } from "../../engine/memory.ts";
import { resizeGroupMembers, rotateGroupMembers } from "../scaleModel.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`); };
const near = (a, b, eps = 0.05) => Math.abs(a - b) < eps;
const B = (x, y, w, h, extra = {}) => ({ x, y, w, h, ...extra });

console.log("pure group affine transforms");
{
  const group = B(10, 20, 300, 120);
  const members = [B(10, 20, 40, 30), B(100, 40, 60, 50), B(240, 80, 70, 60)];
  const resized = resizeGroupMembers(group, members, B(-50, 0, 450, 240));
  t("resize maps all 3 members through the same x/y affine transform",
    resized.length === 3 && near(resized[0].x, -50) && near(resized[0].w, 60) &&
    near(resized[1].x, 85) && near(resized[1].y, 40) && near(resized[1].w, 90) && near(resized[1].h, 100) &&
    near(resized[2].x, 295) && near(resized[2].y, 120) && near(resized[2].w, 105) && near(resized[2].h, 120), JSON.stringify(resized));
  const ten = Array.from({ length: 12 }, (_, i) => B(20 + i * 35, 25 + (i % 3) * 15, 20, 10));
  const box = B(20, 25, 405, 40);
  const large = resizeGroupMembers(box, ten, B(20, 25, 810, 80));
  t("resize supports 10+ members without order loss", large.length === 12 && large.every((m, i) => near(m.x, 20 + i * 70) && near(m.w, 40)));
  const rotated = rotateGroupMembers(B(0, 0, 100, 100), [B(0, 0, 20, 10, { rotation: 10 }), B(80, 80, 10, 20)], 90);
  t("rotation turns centers around the group center and adds member angle", near(rotated[0].x, 85) && near(rotated[0].y, 5) && near(rotated[0].rotation, 100) && near(rotated[1].x, 5) && near(rotated[1].y, 75), JSON.stringify(rotated));
  t("zero-degree rotation is identity", JSON.stringify(rotateGroupMembers(group, members, 0)) === JSON.stringify(members.map((m) => ({ ...m, rotation: 0 }))));
}

console.log("mounted mixed-selection transforms");
const window = installDom();
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({ canvas: this, measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }), getLineDash: () => [], createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) }, { get: (target, key) => key in target ? target[key] : () => {} });
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 40, top: 25, x: 40, y: 25, width: 1200, height: 900, right: 1240, bottom: 925 });
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const act = React.act;
function page(children) { return node("frame", "Page", 0, 0, 2000, 2000, { children }); }
async function mount(children, ids, view = {}) {
  const rootNode = page(children);
  const engine = new MemoryEngine(false, { pages: [{ id: "p", name: "Page", root: rootNode, guides: [], comments: [] }], page: 0, zoom: 1, panX: 0, panY: 0, ...view });
  engine.dispatch({ type: "select", ids });
  function Host() { const snap = React.useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot()); return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap })); }
  const host = document.createElement("div"); document.body.appendChild(host);
  const reactRoot = createRoot(host);
  await act(async () => reactRoot.render(React.createElement(Host)));
  const surface = host.querySelector(".canvas-wrap");
  const mouse = async (type, x, y, extras = {}) => act(async () => surface.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x + 40, clientY: y + 25, button: 0, ...extras })));
  return { engine, root: () => engine.snapshot().pages[0].root, node: (id) => find(engine.snapshot().pages[0].root, id), mouse, close: async () => { await act(async () => reactRoot.unmount()); host.remove(); } };
}
{
  const layers = [
    node("rect", "R", 100, 100, 40, 30),
    node("text", "T", 200, 120, 60, 50, { text: "Design" }),
    node("image", "I", 300, 150, 50, 40, { imageSrc: "data:image/png;base64,AA==" }),
  ];
  const ui = await mount(layers, layers.map((n) => n.id));
  // Three mixed kinds: union (100,100)-(350,190). Drag BR by (+50,+45).
  await ui.mouse("mousedown", 350, 190);
  await ui.mouse("mousemove", 400, 235);
  await ui.mouse("mouseup", 400, 235);
  t("mounted 3-kind resize scales positions and dimensions as one group",
    near(ui.node(layers[0].id).x, 100) && near(ui.node(layers[0].id).y, 100) && near(ui.node(layers[0].id).w, 48) && near(ui.node(layers[0].id).h, 45) &&
    near(ui.node(layers[1].id).x, 220) && near(ui.node(layers[1].id).y, 130) && near(ui.node(layers[1].id).w, 72) && near(ui.node(layers[1].id).h, 75) &&
    near(ui.node(layers[2].id).x, 340) && near(ui.node(layers[2].id).y, 175) && near(ui.node(layers[2].id).w, 60) && near(ui.node(layers[2].id).h, 60), JSON.stringify(layers.map((n) => ui.node(n.id))));
  await ui.close();
}
{
  const many = Array.from({ length: 12 }, (_, i) => {
    const kind = ["rect", "text", "image", "vector"][i % 4];
    const extra = kind === "text" ? { text: `T${i}` } : kind === "image" ? { imageSrc: "data:image/png;base64,AA==" } : kind === "vector" ? { path: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], closed: false } : {};
    return node(kind, `Member ${i}`, 50 + i * 35, 300, 20, 20, extra);
  });
  const ui = await mount(many, many.map((n) => n.id));
  await ui.mouse("mousedown", 95, 310);
  await ui.mouse("mousemove", 111, 334);
  await ui.mouse("mouseup", 111, 334);
  t("mounted 12-member mixed selection moves every root by one page delta", many.every((n, i) => near(ui.node(n.id).x, 66 + i * 35) && near(ui.node(n.id).y, 324)), JSON.stringify(many.map((n) => { const m = ui.node(n.id); return [n.kind, m.x, m.y]; })));
  await ui.close();
}
{
  const inner = node("rect", "Nested child", 20, 20, 40, 40);
  const frame = node("frame", "Nested frame", 200, 100, 120, 100, { rotation: 90, children: [inner] });
  const sibling = node("vector", "V", 400, 100, 40, 40, { path: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], closed: false });
  const ui = await mount([frame, sibling], [frame.id, inner.id, sibling.id]);
  // Selected parent carries its selected descendant exactly once.
  await ui.mouse("mousedown", 220, 120);
  await ui.mouse("mousemove", 250, 140);
  await ui.mouse("mouseup", 250, 140);
  const movedFrame = ui.node(frame.id), movedInner = ui.node(inner.id);
  t("nested selected descendants are carried by their ancestor once", near(movedFrame.x, 230) && near(movedFrame.y, 120) && near(movedInner.x, 20) && near(movedInner.y, 20));
  t("mixed sibling moves with the group", near(ui.node(sibling.id).x, 430) && near(ui.node(sibling.id).y, 120), JSON.stringify(ui.node(sibling.id)));
  await ui.close();
}
{
  const constrained = node("frame", "Constrained parent", 100, 100, 100, 100, { children: [node("rect", "Stretch child", 10, 10, 20, 20, { constraintH: "stretch", constraintV: "fixed" })] });
  const sibling = node("text", "Sibling", 250, 100, 50, 50, { text: "Other" });
  const child = constrained.children[0];
  const ui = await mount([constrained, sibling], [constrained.id, sibling.id]);
  // Group BR drag scales the frame 1.25x; its stretch-constrained child follows.
  await ui.mouse("mousedown", 300, 150);
  await ui.mouse("mousemove", 350, 150);
  await ui.mouse("mouseup", 350, 150);
  t("group resize preserves frame and resolves stretch constraints", near(ui.node(constrained.id).w, 125) && near(ui.node(child.id).w, 45) && near(ui.node(child.id).h, 20), JSON.stringify(ui.node(child.id)));
  t("constrained mixed sibling follows the same group map", near(ui.node(sibling.id).x, 288) && near(ui.node(sibling.id).w, 63), JSON.stringify(ui.node(sibling.id)));
  await ui.close();
}
{
  const nested = node("rect", "Nested selection", 20, 20, 30, 20);
  const parent = node("frame", "Rotated parent", 200, 100, 120, 120, { rotation: 90, children: [nested] });
  const sibling = node("rect", "Page sibling", 400, 180, 40, 40);
  const ui = await mount([parent, sibling], [nested.id, sibling.id]);
  await ui.mouse("mousedown", 440, 220);
  await ui.mouse("mousemove", 486, 240);
  await ui.mouse("mouseup", 486, 240);
  t("resize of mixed nested/page selection writes nested geometry in parent space", near(ui.node(nested.id).w, 39) && near(ui.node(nested.id).h, 24) && near(ui.node(nested.id).x, 19) && near(ui.node(nested.id).y, 15), JSON.stringify(ui.node(nested.id)));
  t("page-level member shares nested selection affine transform", near(ui.node(sibling.id).x, 435) && near(ui.node(sibling.id).y, 192) && near(ui.node(sibling.id).w, 52) && near(ui.node(sibling.id).h, 48), JSON.stringify(ui.node(sibling.id)));
  await ui.close();
}
{
  const frame = node("frame", "Rotated nested frame", 180, 140, 100, 80, { rotation: 90, children: [node("rect", "Child", 10, 10, 20, 20)] });
  const text = node("text", "Text", 380, 140, 40, 30, { text: "Hi" });
  const ui = await mount([frame, text], [frame.id, text.id]);
  const center = { x: 305, y: 180 };
  const start = { x: 180, y: 140 };
  const end = { x: center.x + (start.y - center.y), y: center.y - (start.x - center.x) };
  await ui.mouse("mousedown", start.x, start.y);
  await ui.mouse("mousemove", end.x, end.y);
  await ui.mouse("mouseup", end.x, end.y);
  const f = ui.node(frame.id), tx = ui.node(text.id);
  t("group rotation keeps nested frame centre on the 90-degree orbit", near(f.x + f.w / 2, 305) && near(f.y + f.h / 2, 255) && near(f.rotation, 0), JSON.stringify({ x: f.x, y: f.y, r: f.rotation }));
  t("group rotation orbits sibling text around group centre", near(tx.x + tx.w / 2, 280) && near(tx.y + tx.h / 2, 85), JSON.stringify({ x: tx.x, y: tx.y }));
  await ui.close();
}
console.log(`multiSelectTransform: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
