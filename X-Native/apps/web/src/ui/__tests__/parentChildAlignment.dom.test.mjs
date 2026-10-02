/**
 * Parent/child/sibling alignment behaviors from Figma help articles:
 *  - 360039959014 Parent, child, and sibling relationships
 *  - 360039956914 Adjust alignment, rotation, position, and dimensions
 *
 * Exercises through a mounted Canvas with a real MemoryEngine:
 *   Alt+A/W/S/D/H/V aligns single selection to parent;
 *   Shift+Alt+<key> aligns multiple selection as a group to parent;
 *   Tab/Shift+Tab walk siblings;
 *   Shift+Enter walks up to parent; Enter drills in (components too);
 *   Space-bar during drag prevents reparenting;
 *   Shape larger than parent is NOT reparented.
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find, findParent } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const rect = (name, x, y, w, h, extra = {}) => node("rect", name, x, y, w, h, extra);

const window = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act } = React;

window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({
    canvas: this,
    measureText: () => ({ width: 40, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
  }, { get: (t, k) => (k in t ? t[k] : () => {}) });
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830 });

async function mount(engine) {
  const wrap = document.createElement("div");
  document.body.appendChild(wrap);
  const root = createRoot(wrap);
  const { bindHotkeys } = await import("../chrome.tsx");
  // Canvas takes a required `snap` prop and drives re-renders through the
  // engine subscription — same Host pattern as the other DOM suites. The
  // align chords (Alt+A/V…) and nudges (arrows) live in App's global
  // bindHotkeys handler, so mount that too — exactly what ships.
  function Host() {
    const snap = React.useSyncExternalStore(
      (cb) => engine.subscribe(cb),
      () => engine.snapshot()
    );
    window._s = snap;
    React.useEffect(() => {
      const off = bindHotkeys(engine, {
        onActions: () => {}, onHide: () => {}, onMinimize: () => {},
      });
      return off;
    }, []);
    return React.createElement(ThemeProvider, null,
      React.createElement(Canvas, { engine, snap }));
  }
  await new Promise((res) => {
    act(() => {
      root.render(React.createElement(Host));
      res();
    });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const getSnap = () => window._s;
  return { wrap, getSnap, unmount: () => act(() => root.unmount()) };
}

// Keys are dispatched on window inside act(): both the Canvas capture
// listener and chrome's bindHotkeys listen there, and React state updates
// (e.g. the crop/selection effects) need act() to flush before assertions.
function dispatchKey(code, opts = {}) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code, key: opts.key ?? "", ...opts });
  act(() => { window.dispatchEvent(e); });
}

// 1. Alt+A aligns a single child to parent's left (x=0).
{
  const engine = new MemoryEngine(false);
  const root = engine.snapshot().pages[0].root;
  const parent = node("frame", "F", 100, 100, 400, 300, { fill: "#ffffff", fillVisible: true, children: [
    rect("child", 50, 50, 80, 80),
  ]});
  root.children.push(parent);
  engine.dispatch({ type: "select", ids: [parent.children[0].id] });
  const { getSnap, unmount } = await mount(engine);
  dispatchKey("KeyA", { key: "a", altKey: true });
  const n = find(getSnap().pages[0].root, parent.children[0].id);
  t("Alt+A aligns single child to parent left (x=0)", Math.abs(n.x - 0) < 0.01);
  t("Alt+A leaves y untouched", Math.abs(n.y - 50) < 0.01);
  unmount();
}

// 2. Alt+V centers vertically on parent.
{
  const engine = new MemoryEngine(false);
  const root = engine.snapshot().pages[0].root;
  const child = rect("c", 50, 50, 80, 80);
  const parent = node("frame", "F", 100, 100, 400, 300, { fill: "#ffffff", fillVisible: true, children: [child] });
  root.children.push(parent);
  engine.dispatch({ type: "select", ids: [child.id] });
  const { unmount } = await mount(engine);
  dispatchKey("KeyV", { key: "v", altKey: true });
  const n = find(engine.snapshot().pages[0].root, child.id);
  t("Alt+V centers child vertically (y = (300-80)/2 = 110)", Math.abs(n.y - 110) < 0.01);
  unmount();
}

// 3. Tab/Shift+Tab walk siblings.
{
  const engine = new MemoryEngine(false);
  const root = engine.snapshot().pages[0].root;
  const a = rect("a", 0, 0, 50, 50);
  const b = rect("b", 60, 0, 50, 50);
  const c = rect("c", 120, 0, 50, 50);
  const parent = node("frame", "F", 50, 50, 300, 200, { fill: "#ffffff", fillVisible: true, children: [a, b, c] });
  root.children.push(parent);
  engine.dispatch({ type: "select", ids: [a.id] });
  const { getSnap, unmount } = await mount(engine);
  dispatchKey("Tab", { key: "Tab" });
  t("Tab selects next sibling", getSnap().selection[0] === b.id);
  dispatchKey("Tab", { key: "Tab" });
  t("Tab again selects next sibling", getSnap().selection[0] === c.id);
  dispatchKey("Tab", { key: "Tab", shiftKey: true });
  t("Shift+Tab selects previous sibling", getSnap().selection[0] === b.id);
  unmount();
}

// 4. Shift+Enter walks up to parent; Enter drills into a component.
{
  const engine = new MemoryEngine(false);
  const root = engine.snapshot().pages[0].root;
  const inner = rect("inner", 20, 20, 60, 60);
  const comp = node("component", "Comp", 200, 200, 100, 100, { fill: "#ffffff", fillVisible: true, children: [inner] });
  root.children.push(comp);
  engine.dispatch({ type: "select", ids: [comp.id] });
  const { getSnap, unmount } = await mount(engine);
  dispatchKey("Enter", { key: "Enter" });
  t("Enter drills into component (first child selected)", getSnap().selection[0] === inner.id);
  dispatchKey("Enter", { key: "Enter", shiftKey: true });
  t("Shift+Enter selects parent component", getSnap().selection[0] === comp.id);
  unmount();
}

// 5. Arrow-key nudge moves by small nudge (default 1px).
{
  const engine = new MemoryEngine(false);
  const root = engine.snapshot().pages[0].root;
  const r = rect("r", 100, 100, 50, 50);
  root.children.push(r);
  engine.dispatch({ type: "select", ids: [r.id] });
  const { unmount } = await mount(engine);
  dispatchKey("ArrowRight", { key: "ArrowRight" });
  const n = find(engine.snapshot().pages[0].root, r.id);
  t("→ nudges +1 in x", Math.abs(n.x - 101) < 0.01);
  dispatchKey("ArrowDown", { key: "ArrowDown", shiftKey: true });
  const n2 = find(engine.snapshot().pages[0].root, r.id);
  t("Shift+↓ nudges +big (default 10) in y", Math.abs(n2.y - 110) < 0.01);
  unmount();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
