/**
 * A DOM for the headless UI tests.
 *
 * The behaviour suite (`e2e/behaviour.mjs`) is the place that asserts on the
 * running app, and it needs a Chromium — which the development sandbox does not
 * have, so a UI fix shipped without one could only be marked NOT VERIFIED.
 * jsdom is not a browser (no layout, no painting, no canvas backend), but it
 * *is* a DOM: enough to mount a panel, read the markup the components actually
 * produce, click it, type into it and watch the engine answer. That covers the
 * structural half of a UI finding — which node renders, with what class, name,
 * role and state, and what a click dispatches — and it runs in `npm test` next
 * to the engine checks.
 *
 * What it cannot verify stays flagged as such: computed styles, geometry, focus
 * rings, hover, and anything painted on the canvas. Those still belong to the
 * browser suite.
 *
 * One ordering rule, learned the hard way: the globals must exist *before*
 * react-dom is imported. A top-level `import "react-dom/client"` is evaluated
 * before any statement in this module, so react-dom would decide — with no
 * `document` in sight — that it cannot use the platform's input events and fall
 * back to its legacy IE value-change polyfill, which then throws
 * `activeElement.detachEvent is not a function` on every keystroke. Everything
 * below is therefore imported lazily, from inside `mountSurface`.
 *
 * Usage:
 *   import { mountPanel } from "./domEnv.mjs";
 *   const ui = await mountPanel({ layer: "vector" });
 *   await ui.click(ui.byText("Align points top", ".vec-align button"));
 *
 *   const dock = await mountToolbar({ layer: "pair" });
 *   await dock.click(dock.one('.tool[data-group="bool"] .hit'));
 */
import { JSDOM } from "jsdom";

let installed = false;
let mods = null;

/** Put jsdom's globals where React and the app's feature checks look for them.
 *  Idempotent: a suite that mounts twice installs once. */
export function installDom() {
  if (installed) return globalThis.window;
  const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const set = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set("window", window);
  set("document", window.document);
  // Node exposes `navigator` as a getter-only global, so it has to be redefined
  // rather than assigned.
  set("navigator", window.navigator);
  for (const key of [
    "HTMLElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "PointerEvent",
    "getComputedStyle",
    "localStorage",
    "DOMParser",
  ])
    if (window[key] !== undefined) set(key, window[key]);
  set("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
  set("cancelAnimationFrame", (id) => clearTimeout(id));

  // The app asks the platform about colour scheme, reduced motion and viewport
  // width; jsdom implements none of them, and a missing `matchMedia` throws
  // during the first render instead of degrading.
  if (!window.matchMedia)
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    });
  set("matchMedia", window.matchMedia);
  if (!window.ResizeObserver)
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  set("ResizeObserver", window.ResizeObserver);
  // A selected layer row scrolls itself into view (chrome.tsx), and jsdom has no
  // layout to scroll: without the stub the row's effect throws on mount, so no
  // test could ever mount a panel that renders rows.
  if (!window.Element.prototype.scrollIntoView)
    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  if (!window.Element.prototype.scrollTo)
    window.Element.prototype.scrollTo = function scrollTo() {};
  // React 18 warns on every render unless the environment says it is a test one.
  set("IS_REACT_ACT_ENVIRONMENT", true);

  installed = true;
  return window;
}

/** Load React, the engine and the surfaces — after the DOM exists (see above). */
async function load() {
  if (mods) return mods;
  installDom();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MemoryEngine } = await import("../../engine/memory.ts");
  const { RightPanel } = await import("../inspector.tsx");
  const { Toolbar, LeftPanel } = await import("../chrome.tsx");
  mods = {
    React: React.default,
    act: React.act,
    useSyncExternalStore: React.useSyncExternalStore,
    createRoot,
    MemoryEngine,
    surfaces: { inspector: RightPanel, toolbar: Toolbar, left: LeftPanel },
  };
  return mods;
}

/** Documents to mount against. Each is built through the engine's own commands,
 *  so the panel sees what a user's document would look like — including the
 *  engine's own coordinate choices (an `addPath` stores its points relative to
 *  the layer's box, which is why a test asserts on relations, not absolutes). */
const LAYERS = {
  /** An open three-point path: the card's vertex rows have something to show. */
  vector(engine) {
    engine.dispatch({
      type: "addPath",
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 80 },
        { x: 50, y: 40 },
      ],
      closed: false,
    });
    return engine.snapshot().selection[0];
  },
  /** A plain rectangle: the card must not appear for it (no phantom surface). */
  rect(engine) {
    engine.dispatch({ type: "add", kind: "rect", x: 40, y: 40, w: 120, h: 80 });
    return engine.snapshot().selection[0];
  },
  /** Nothing at all. A fresh engine seeds a starter page, so "empty" is built
   *  the way a visitor makes it: select every top-level layer and delete. This
   *  is the state the layers tree's and the canvas's empty answers answer to
   *  (LP-U3 / LP-U4). No id comes back because there is nothing to select. */
  empty(engine) {
    const snap = engine.snapshot();
    const kids = snap.pages[snap.page].root.children.map((n) => n.id);
    if (kids.length) {
      engine.dispatch({ type: "select", ids: kids });
      engine.dispatch({ type: "delete" });
    }
    return null;
  },
  /** Two shapes, both selected: what the dock's multi-selection end needs
   *  before it shows the component and boolean actions at all. */
  pair(engine) {
    engine.dispatch({ type: "add", kind: "rect", x: 40, y: 40, w: 120, h: 80 });
    const a = engine.snapshot().selection[0];
    engine.dispatch({ type: "add", kind: "ellipse", x: 220, y: 60, w: 90, h: 90 });
    const b = engine.snapshot().selection[0];
    engine.dispatch({ type: "select", ids: [a, b] });
    return a;
  },
};

/**
 * Mount one surface on a document.
 *
 * `layer` names an entry of `LAYERS` ("vector" by default), or a function that
 * receives the engine and returns the id to select.
 */
export async function mountSurface(surface = "inspector", { layer = "vector", props = {} } = {}) {
  const { React, act, useSyncExternalStore, createRoot, MemoryEngine, surfaces } = await load();
  const Component = surfaces[surface];
  if (!Component) throw new Error(`mountSurface: unknown surface "${surface}"`);
  const window = globalThis.window;
  const { document } = window;

  /** The surface as App mounts it: the snapshot comes from the store, so a
   *  dispatch re-renders without the test having to push a new prop. */
  function Host({ engine, ...rest }) {
    const snap = useSyncExternalStore(
      (fn) => engine.subscribe(fn),
      () => engine.snapshot(),
      () => engine.snapshot(),
    );
    return React.createElement(Component, { engine, snap, ...rest });
  }

  const engine = new MemoryEngine(false);
  const id = typeof layer === "function" ? layer(engine) : LAYERS[layer](engine);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const defaults =
    surface === "toolbar"
      ? { onActions: () => {} }
      : surface === "left"
        ? { nav: "file", onMinimize: () => {} }
        : {};
  await act(async () => {
    root.render(React.createElement(Host, { engine, ...defaults, ...props }));
  });

  /** Everything the tests need, in the shape the panel renders it. */
  const ui = {
    engine,
    window,
    document,
    id,
    get container() {
      return host;
    },
    /** Re-render after a change the engine did not announce (a prop, a theme). */
    async render(props2 = {}) {
      await act(async () => {
        root.render(React.createElement(Host, { engine, ...defaults, ...props, ...props2 }));
      });
    },
    /** Let queued effects and state updates settle. */
    async settle() {
      await act(async () => {
        await Promise.resolve();
      });
    },
    all(selector) {
      return [...host.querySelectorAll(selector)];
    },
    one(selector) {
      return host.querySelector(selector);
    },
    /** Fields are addressed by accessible name, the way the browser suite does
     *  it, so a row can move or reorder without the test breaking. */
    byLabel(label) {
      return ui.all(".field input").find((el) => el.getAttribute("aria-label") === label) ?? null;
    },
    byText(text, selector = "button") {
      return (
        ui.all(selector).find(
          (el) =>
            (el.textContent || "").trim() === text ||
            el.getAttribute("aria-label") === text ||
            el.title === text,
        ) ?? null
      );
    },
    text(selector) {
      return (ui.one(selector)?.textContent || "").trim();
    },
    async click(el) {
      if (!el) throw new Error("click: no element");
      await act(async () => {
        el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    /** Type into a field the way a user does: focus, replace the value through
     *  the platform's own setter (so React sees a real change), then blur — the
     *  panel's `Field` commits on blur and on Enter. */
    async type(el, value) {
      if (!el) throw new Error("type: no element");
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      await act(async () => {
        el.focus();
      });
      await act(async () => {
        setValue.call(el, String(value));
        el.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await act(async () => {
        el.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
        el.blur();
      });
    },
    /** Press a key on an element the way a user does — the panes that act on
     *  Enter (the agent's ask) have no button to click. */
    async press(el, key) {
      if (!el) throw new Error("press: no element");
      await act(async () => {
        el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    },
    /** A dispatch the test drives itself, inside `act` so React can flush it. */
    async dispatch(cmd) {
      await act(async () => {
        engine.dispatch(cmd);
      });
    },
    /** The node the panel is showing, read back from the engine. */
    node(nodeId = id) {
      const snap = engine.snapshot();
      const walk = (n) => (n.id === nodeId ? n : n.children.map(walk).find(Boolean) ?? null);
      return walk(snap.pages[snap.page].root);
    },
    snap() {
      return engine.snapshot();
    },
    /** Every inline `style` in a subtree, as `tag.class|css` — the shape the
     *  browser suite prints, so a failure reads the same in both. */
    inlineStyles(scope) {
      const el = typeof scope === "string" ? ui.one(scope) : scope;
      return [...(el?.querySelectorAll("[style]") ?? [])].map(
        (e) =>
          `${e.tagName.toLowerCase()}.${typeof e.className === "string" ? e.className : "svg"}|${e.getAttribute("style")}`,
      );
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
  return ui;
}

/** The inline styles the *shared primitives* put on their own markup: `Icon`
 *  sizes its svg, `Field` marks its label as scrubbable. A surface is allowed
 *  these and nothing else — anything more is bespoke layout written inline,
 *  which is what the drift findings (§29) are about. */
export const PRIMITIVE_INLINE_STYLES = [
  /^svg\..*\|width: \d+px; height: \d+px; display: block;$/,
  /^(label|span)\.\|cursor: ew-resize;( display: inline-flex;)?$/,
];

/** The inline styles in `styles` that no shared primitive owns. */
export function strayInlineStyles(styles) {
  return styles.filter((s) => !PRIMITIVE_INLINE_STYLES.some((re) => re.test(s)));
}

/** The inspector (`RightPanel`), which is where a layer's properties live. */
export function mountPanel(opts) {
  return mountSurface("inspector", opts);
}

/** The floating tool dock (`Toolbar`), including its multi-selection end — which
 *  only renders once two or more layers are selected, hence the `pair`
 *  document. */
export function mountToolbar(opts) {
  return mountSurface("toolbar", { layer: "pair", ...opts });
}

/** The layers-and-pages panel (`LeftPanel`), on an empty page by default: that
 *  is the state LP-U3 is about, and a test that wants rows asks for a fixture. */
export function mountLeftPanel(opts) {
  return mountSurface("left", { layer: "empty", ...opts });
}
