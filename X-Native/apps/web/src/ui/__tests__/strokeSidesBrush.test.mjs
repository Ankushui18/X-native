/** Run 24: stroke sides & brush interaction (audit P1 #13) — the seven
 *  interaction categories, end to end, on the mounted canvas + inspector.
 *
 *  AUDIT (what existed before this run):
 *  · §11 of the behaviour audit had already verified individual strokes on
 *    rect/frame/component/instance (side seg + custom 4-field widths, cone-
 *    clipped per-side rendering), the position dropdown with line/arrow
 *    centre-forcing, joins hidden for lines, and the engine's `previewStroke`
 *    action — but nothing DISPATCHED it, ellipses had no join gate, and
 *    "Brush and Dynamic stroke types: no X-Native equivalent — OUT OF SCOPE."
 *  · This run: the support matrix enforced with disabled options + tooltips
 *    (lines: no position, no joins; full ellipses: no joins), hover previews
 *    wired for position/cap/join/style (a new Solid/Dashed/Dotted style row),
 *    and Brush (centre-only, direction, 3 bristle passes) plus Dynamic
 *    (centre-only, freq/wiggle/smooth wobble polyline) implemented as stroke
 *    types that cannot be dashed or take a width profile. Every change is a
 *    single patch, so each is one undo step.
 *
 *  jsdom + recorded paints: interaction wiring and paint-call geometry.
 *
 *  Run with:  npx vite-node src/ui/__tests__/strokeSidesBrush.test.mjs
 */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, find, node } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });

// ═══════════════════════════ mounted canvas (recording) ═══════════════════════════
const window = installDom();
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { RightPanel } = await import("../inspector.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;

let paints = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy(
    {
      canvas: this,
      measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
      getLineDash: () => [],
    },
    {
      get: (target, key) => (key in target ? target[key] : (...args) => paints.push([key, ...args])),
      set: (target, key, value) => {
        if (key === "lineCap" || key === "lineJoin" || key === "lineWidth" || key === "lineDashOffset") {
          paints.push([key, value]);
        }
        target[key] = value;
        return true;
      },
    },
  );
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830,
});

const LEFT = 50, TOP = 30;

async function mount(children, selection = []) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "p", name: "Page", root: page(...children), guides: [], comments: [] }],
    page: 0, zoom: 1, panX: 0, panY: 0,
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
  // The inspector rides the same engine (strokeRendering's pattern).
  function Panel() {
    const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(RightPanel, { engine, snap }));
  }
  const panelHost = document.createElement("div");
  document.body.appendChild(panelHost);
  const panelRoot = createRoot(panelHost);
  await act(async () => panelRoot.render(React.createElement(Panel)));
  const surface = host.querySelector(".canvas-wrap");
  const ui = {
    engine, host, panelHost, surface,
    node: (id) => find(engine.snapshot().pages[0].root, id),
    sel: () => engine.snapshot().selection[0],
    q: (sel) => panelHost.querySelector(sel),
    qa: (sel) => [...panelHost.querySelectorAll(sel)],
    marker: () => paints.length,
    tail: (m) => paints.slice(m),
    async mouse(type, x, y, extra = {}) {
      await act(async () =>
        surface.dispatchEvent(new window.MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: x + LEFT, clientY: y + TOP, button: 0, ...extra,
        })));
    },
    async click(el) { await act(async () => el.click()); },
    async hover(el) {
      await act(async () => el.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
    },
    async unhover(el) {
      await act(async () => el.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    },
    async change(el, value) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, String(value));
        el.dispatchEvent(new window.Event("input", { bubbles: true }));
        el.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async select(el, value) {
      await act(async () => {
        el.value = value;
        el.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async key(k, extra = {}) {
      await act(async () =>
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })));
    },
    async dispatch(cmd) { await act(async () => engine.dispatch(cmd)); },
    async close() {
      await act(async () => panelRoot.unmount());
      panelHost.remove();
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
  return ui;
}

// ── selectors ──
const alignSel = (ui) => ui.q('select[aria-label="Stroke alignment"]');
const sideBtn = (ui, label) => ui.qa(".stroke-sides button").find((b) => b.getAttribute("title") === label);
const styleBtn = (ui, label) => ui.qa(".stroke-style button").find((b) => b.textContent.trim() === label);
const capBtn = (ui, title) => ui.qa(".seg.icons.caps button").find((b) => b.getAttribute("title") === title);
const joinBtn = (ui, title) => ui.qa("button").find((b) => b.getAttribute("title") === title);
const joinSeg = (ui) => {
  const b = joinBtn(ui, "Join miter") ?? joinBtn(ui, "Join bevel") ?? joinBtn(ui, "Join round");
  return b ? b.parentElement : null;
};
const typePick = async (ui, label) => {
  const hex = ui.q('input[aria-label="Stroke colour hex"]');
  await ui.click(hex.parentElement.querySelector("button.swatch"));
  const pop = () => document.body.querySelector(".fill-pop");
  await ui.click(pop().querySelector(".type-btn"));
  await ui.click([...pop().querySelectorAll(".type-menu button")].find((b) => b.textContent.includes(label)));
};
const strokeCount = (tail) => tail.filter((e) => e[0] === "stroke").length;
const clips = (tail) => tail.filter((e) => e[0] === "clip");
const translates = (tail) => tail.filter((e) => e[0] === "translate");
const lineTos = (tail) => tail.filter((e) => e[0] === "lineTo");
const hasLineTo = (tail, x, y, eps = 0.02) =>
  tail.some((e) => e[0] === "lineTo" && Math.abs(e[1] - x) < eps && Math.abs(e[2] - y) < eps);

/** End the engine's 600ms patch-coalescing burst so the NEXT patch owns its
 *  own undo entry (select is non-history and breaks the burst). */
const brk = async (ui) => ui.dispatch({ type: "select", ids: [ui.sel()] });

const rect100 = (extra = {}) =>
  node("rect", "R", 100, 100, 200, 100, {
    fillVisible: false, fill: "#00000000",
    strokeVisible: true, strokePaint: "#000000", strokeWidth: 10,
    strokeAlign: "center", strokeSides: "all", strokeDash: 0, strokeGap: 0,
    ...extra,
  });

// ─────────────────────── 1 · individual stroke sides ───────────────────────
console.log("1 · sides: Top/Bottom/Left/Right/All toggles, per-side widths, one undo");
{
  const r = rect100();
  const ui = await mount([r], [r.id]);
  t("1-ui: the side seg offers All/Top/Right/Bottom/Left/Custom",
    ["All sides", "Top", "Right", "Bottom", "Left", "Custom"].every((l) => sideBtn(ui, l)),
    ui.qa(".stroke-sides button").map((b) => b.getAttribute("title")).join(","));
  t("1-ui: All is on by default", sideBtn(ui, "All sides").className.includes("on"));

  // Rendering deltas: chrome strokes are constant, the node's own are not.
  let base = ui.marker();
  await ui.dispatch({ type: "patch", id: r.id, patch: { strokeSides: "all" } });
  const allCount = strokeCount(ui.tail(base));
  base = ui.marker();
  await ui.dispatch({ type: "patch", id: r.id, patch: { strokeSides: "custom", strokeSideW: [0, 0, 0, 0] } });
  const zeroTail = ui.tail(base);
  const zero = strokeCount(zeroTail);
  t("1-render: custom with all widths 0 paints nothing for the layer", zero === allCount - 1,
    `${zero} vs all ${allCount}`);
  base = ui.marker();
  await ui.dispatch({ type: "patch", id: r.id, patch: { strokeSides: "top" } });
  const topTail = ui.tail(base);
  t("1-render: Top paints exactly one cone-clipped pass", strokeCount(topTail) === zero + 1,
    `${strokeCount(topTail)} vs ${zero}`);
  // The top cone: box (100,100)-(300,200), A = w+h+8 = 308. Its first corner
  // is a moveTo; the far top-right corner (300+308, 100-308) is a lineTo.
  t("1-render: the pass is clipped to the top side's 45° cone",
    clips(topTail).length >= 1 && hasLineTo(topTail, 300 + 308, 100 - 308),
    JSON.stringify(topTail.filter((e) => e[0] === "lineTo" || e[0] === "moveTo").slice(0, 6)));
  base = ui.marker();
  await ui.dispatch({ type: "patch", id: r.id, patch: { strokeSides: "all" } });
  t("1-render: All paints without any cone clip", clips(ui.tail(base)).length === 0,
    JSON.stringify(clips(ui.tail(base))));

  // The side seg drives it from the panel (burst broken first: the recent
  // strokeSides patches would otherwise coalesce with the click).
  await brk(ui);
  await ui.click(sideBtn(ui, "Bottom"));
  t("1-click: Bottom turns on and patches the model",
    sideBtn(ui, "Bottom").className.includes("on") && ui.node(r.id).strokeSides === "bottom",
    ui.node(r.id).strokeSides);
  await ui.dispatch({ type: "undo" });
  t("1-undo: one undo returns to All", ui.node(r.id).strokeSides === "all", ui.node(r.id).strokeSides);

  // Custom → per-side widths.
  await brk(ui);
  await ui.click(sideBtn(ui, "Custom"));
  t("1-custom: Custom seeds the four fields with the current weight",
    ui.node(r.id).strokeSides === "custom" &&
      JSON.stringify(ui.node(r.id).strokeSideW) === JSON.stringify([10, 10, 10, 10]),
    JSON.stringify(ui.node(r.id).strokeSideW));
  const fields = ui.qa(".stroke-sides + .grid4 input");
  t("1-custom: the T/R/B/L fields are on the panel", fields.length === 4, String(fields.length));
  if (fields.length === 4) {
    await brk(ui);
    await ui.change(fields[0], 24);
    t("1-custom: each side keeps its own width",
      JSON.stringify(ui.node(r.id).strokeSideW) === JSON.stringify([24, 10, 10, 10]),
      JSON.stringify(ui.node(r.id).strokeSideW));
    await ui.dispatch({ type: "undo" });
    t("1-undo: the width edit is one step", JSON.stringify(ui.node(r.id).strokeSideW) === JSON.stringify([10, 10, 10, 10]));
  }
  await ui.close();
}

// ─────────────────────── 2 · support matrix ───────────────────────
console.log("2 · matrix: lines have no position/join, ellipses join only when arced");
{
  // Line: no position control at all, centre retained, joins disabled+tip.
  const l = node("line", "L", 100, 150, 200, 1, { strokeVisible: true, strokePaint: "#000000", strokeWidth: 4, strokeAlign: "center" });
  const ui = await mount([l], [l.id]);
  t("2-line: no position dropdown", !alignSel(ui));
  t("2-line: stored position stays Center", ui.node(l.id).strokeAlign === "center");
  const seg = joinSeg(ui);
  t("2-line: the join seg is present but disabled, with the why",
    !!seg && seg.getAttribute("title") === "Lines have no joins" &&
      [...seg.querySelectorAll("button")].every((b) => b.disabled),
    seg ? seg.getAttribute("title") : "no seg");
  // A stray patch still cannot move a line off centre at paint time.
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeAlign: "inside" } });
  const m = ui.marker();
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeWidth: 5 } });
  t("2-line: paint never clips the shaft — centre-forced regardless of the field",
    clips(ui.tail(m)).length === 0, JSON.stringify(clips(ui.tail(m))));
  await ui.close();

  // Full ellipse: joins disabled with tooltip; arced → enabled.
  const e = node("ellipse", "E", 100, 100, 200, 200, { strokeVisible: true, strokePaint: "#000000", strokeWidth: 6, strokeAlign: "center" });
  const ui2 = await mount([e], [e.id]);
  const seg2 = joinSeg(ui2);
  t("2-ellipse: a full ellipse's joins are disabled with a tooltip",
    !!seg2 && seg2.getAttribute("title") === "Ellipses have joins only once arced" &&
      [...seg2.querySelectorAll("button")].every((b) => b.disabled),
    seg2 ? seg2.getAttribute("title") : "no seg");
  t("2-ellipse: position stays available for ellipses", !!alignSel(ui2));
  await ui2.dispatch({ type: "patch", id: e.id, patch: { arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 } } });
  const seg3 = joinSeg(ui2);
  t("2-ellipse: arced, the joins enable", !!seg3 && [...seg3.querySelectorAll("button")].every((b) => !b.disabled));
  await ui2.close();
}

// ─────────────────────── 3 · hover previews ───────────────────────
console.log("3 · previews: position/cap/join/style hover paints, leave clears");
{
  const r = rect100({ strokeAlign: "inside" });
  const ui = await mount([r], [r.id]);
  const pv = () => ui.engine.snapshot().previewStroke;

  // Position: option hover → align preview on canvas; leave → cleared.
  const sel = alignSel(ui);
  t("3-pos: the panel has the position dropdown", !!sel);
  const outsideOpt = [...sel.querySelectorAll("option")].find((o) => o.value === "outside");
  let m = ui.marker();
  await ui.hover(outsideOpt);
  const posTail = ui.tail(m);
  t("3-pos: hovering Outside previews it", pv()?.id === r.id && pv()?.align === "outside",
    JSON.stringify(pv()));
  t("3-pos: the preview paints an outside stroke (inverse clip)",
    posTail.some((e) => e[0] === "clip" && e[1] === "evenodd"),
    JSON.stringify(clips(posTail)));
  await ui.unhover(sel);
  t("3-pos: leaving the select clears the preview", pv() === null, JSON.stringify(pv()));

  // Focus/blur mirrors it for keyboard users.
  await act(async () => {
    sel.dispatchEvent(new window.FocusEvent("focus", { bubbles: false }));
    sel.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  });
  t("3-pos: focusing previews the current value", pv()?.align === "inside", JSON.stringify(pv()));
  await act(async () => {
    sel.dispatchEvent(new window.FocusEvent("blur", { bubbles: false }));
    sel.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  t("3-pos: blurring clears it", pv() === null);

  // Cap: hover round → lineCap round on the next paint; a cap-only preview
  // must NOT drag the inside align to centre (no evenodd clip appears).
  const cap = capBtn(ui, "Cap round");
  t("3-cap: the cap row exists", !!cap);
  m = ui.marker();
  await ui.hover(cap);
  const capTail = ui.tail(m);
  t("3-cap: hovering previews the cap", pv()?.cap === "round", JSON.stringify(pv()));
  t("3-cap: the paint sets a round lineCap", capTail.some((e) => e[0] === "lineCap" && e[1] === "round"),
    JSON.stringify(capTail));
  t("3-cap: a cap preview keeps the stored align (no outside clip)",
    !capTail.some((e) => e[0] === "clip" && e[1] === "evenodd"),
    JSON.stringify(clips(capTail)));
  await ui.unhover(cap);
  t("3-cap: leaving clears it", pv() === null);

  // Join: hover bevel → lineJoin bevel.
  const j = joinBtn(ui, "Join bevel");
  m = ui.marker();
  await ui.hover(j);
  t("3-join: hovering previews the join", pv()?.join === "bevel", JSON.stringify(pv()));
  t("3-join: the paint sets a bevel join", ui.tail(m).some((e) => e[0] === "lineJoin" && e[1] === "bevel"),
    JSON.stringify(ui.tail(m).filter((e) => e[0] === "lineJoin")));
  await ui.unhover(j);
  t("3-join: leaving clears it", pv() === null);

  // Style: the Solid/Dashed/Dotted row exists; hovering Dashed previews the
  // dashes WITHOUT patching the model.
  const dashed = styleBtn(ui, "Dashed");
  t("3-style: the style row offers Solid/Dashed/Dotted",
    !!styleBtn(ui, "Solid") && !!dashed && !!styleBtn(ui, "Dotted"));
  m = ui.marker();
  await ui.hover(dashed);
  const dashTail = ui.tail(m);
  t("3-style: hovering previews the preset dashes", pv()?.dash?.strokeDash === 10, JSON.stringify(pv()?.dash));
  t("3-style: the paint applies them", dashTail.some((e) => e[0] === "setLineDash" && e[1]?.[0] === 10),
    JSON.stringify(dashTail.filter((e) => e[0] === "setLineDash")));
  t("3-style: nothing was committed", ui.node(r.id).strokeDash === 0, String(ui.node(r.id).strokeDash));
  await ui.unhover(dashed);
  t("3-style: leaving clears the preview", pv() === null);
  await ui.close();
}

// ─────────────────────── 4 · brush stroke type ───────────────────────
console.log("4 · brush: centre-only, direction, 3 passes, no dashes/profile");
{
  const v = node("vector", "V", 100, 150, 200, 1, {
    path: [{ x: 0, y: 0 }, { x: 200, y: 0 }],
    closed: false, fillVisible: false, fill: "#00000000",
    strokeVisible: true, strokePaint: "#000000", strokeWidth: 10, strokeAlign: "center",
  });
  const ui = await mount([v], [v.id]);
  // Start dashed so the switch has something to clear.
  await ui.click(styleBtn(ui, "Dashed"));
  t("4-prep: the layer starts dashed", ui.node(v.id).strokeDash === 10);

  await typePick(ui, "Brush");
  const n = ui.node(v.id);
  t("4-type: the picker switches the stroke to Brush", n.strokeType === "brush", String(n.strokeType));
  t("4-type: the switch lands centre-aligned and undashed in one patch",
    n.strokeAlign === "center" && n.strokeDash === 0 && n.strokeGap === 0,
    `${n.strokeAlign} ${n.strokeDash}`);
  await ui.dispatch({ type: "undo" });
  const back = ui.node(v.id);
  t("4-undo: one undo restores the dashed solid stroke with its dashes",
    (back.strokeType ?? "solid") === "solid" && back.strokeDash === 10,
    JSON.stringify({ type: back.strokeType, dash: back.strokeDash }));
  await ui.dispatch({ type: "redo" });
  t("4-redo: redo re-applies brush", ui.node(v.id).strokeType === "brush");

  // Direction control on the panel.
  const dir = ui.q('[aria-label="Brush direction"]');
  t("4-dir: the brush direction field shows", !!dir);
  if (dir) {
    await brk(ui);
    await ui.change(dir, 90);
    t("4-dir: the angle patches", ui.node(v.id).strokeBrushAngle === 90, String(ui.node(v.id).strokeBrushAngle));
    await ui.dispatch({ type: "undo" });
  }

  // Rendering: three bristle passes offset along the direction.
  let m = ui.marker();
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeBrushAngle: 0 } });
  let tail = ui.tail(m);
  const tr0 = translates(tail).filter((e) => Math.abs(Math.abs(e[1]) - 3.5) < 1e-9);
  t("4-render: direction 0 offsets the bristles along +x",
    tr0.length === 2 && tr0.every((e) => Math.abs(e[2]) < 1e-9),
    JSON.stringify(translates(tail)));
  const strokes0 = strokeCount(tail);
  t("4-render: three passes, not one", strokes0 >= 3, String(strokes0));
  m = ui.marker();
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeBrushAngle: 90 } });
  tail = ui.tail(m);
  const tr90 = translates(tail).filter((e) => Math.abs(Math.abs(e[2]) - 3.5) < 1e-9);
  t("4-render: direction 90 turns them vertical",
    tr90.length === 2 && tr90.every((e) => Math.abs(e[1]) < 1e-9),
    JSON.stringify(translates(tail)));

  // Centre-only: the dropdown itself is disabled with the why, and a stray
  // align patch cannot clip the brush stroke at paint time.
  const align4 = alignSel(ui);
  t("4-pos: position disables with the centre-only tooltip",
    !!align4 && align4.disabled && align4.getAttribute("title") === "Brush and dynamic strokes are centre-only",
    align4 ? `${align4.disabled} ${align4.getAttribute("title")}` : "missing");
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeAlign: "inside" } });
  m = ui.marker();
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeBrushAngle: 0 } });
  t("4-centre: brush paint never clips to inside",
    clips(ui.tail(m)).filter((e) => e[1] !== true).length === 0,
    JSON.stringify(clips(ui.tail(m))));
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeAlign: "center" } });

  // Cannot be dashed: controls disabled with tooltips, render ignores dashes.
  t("4-dash: the style pills disable with the why",
    ["Solid", "Dashed", "Dotted"].every((l) => {
      const b = styleBtn(ui, l);
      return b && b.disabled && b.getAttribute("title") === "Brush and dynamic strokes cannot be dashed";
    }));
  await ui.click(ui.q('button[title="Advanced stroke settings"]'));
  const dashField = ui.qa(".adv-stroke input")[0];
  const dashWrap = ui.q(".adv-stroke");
  t("4-dash: the dash fields disable with the why",
    !!dashWrap && dashWrap.getAttribute("title") === "Brush and dynamic strokes cannot be dashed" &&
      !!dashField && dashField.disabled,
    dashWrap ? dashWrap.getAttribute("title") : "no adv");
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeDash: 7, strokeGap: 3 } });
  m = ui.marker();
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeBrushAngle: 0 } });
  t("4-dash: the painter ignores dashes on a brush stroke",
    !ui.tail(m).some((e) => e[0] === "setLineDash" && e[1]?.length),
    JSON.stringify(ui.tail(m).filter((e) => e[0] === "setLineDash")));
  await ui.dispatch({ type: "patch", id: v.id, patch: { strokeDash: 0, strokeGap: 0 } });

  // No width profile: the strip disables with the shared reason.
  const fieldset = ui.q("fieldset.width-profile");
  t("4-profile: the width-profile strip exists for vectors", !!fieldset);
  t("4-profile: brush disables it with the shared reason",
    !!fieldset && fieldset.disabled &&
      fieldset.getAttribute("title") === "Brush strokes use a fixed width" &&
      /Brush strokes use a fixed width/.test(fieldset.textContent),
    fieldset ? `${fieldset.getAttribute("title")} disabled=${fieldset.disabled}` : "none");

  // The brush TOOL stamps the same type on drawn strokes.
  await ui.dispatch({ type: "setTool", tool: "brush" });
  await ui.dispatch({ type: "addPath", points: [{ x: 400, y: 400 }, { x: 460, y: 410 }], closed: false });
  const drawn = ui.engine.snapshot().selection[0];
  t("4-tool: brush-drawn strokes carry the brush type",
    ui.node(drawn).brushStroke === true && ui.node(drawn).strokeType === "brush",
    JSON.stringify({ marker: ui.node(drawn).brushStroke, type: ui.node(drawn).strokeType }));
  await ui.close();
}

// ─────────────────────── 5 · dynamic stroke type ───────────────────────
console.log("5 · dynamic: centre-only, freq/wiggle/smooth, no dashes/profile");
{
  const l = node("line", "L", 100, 150, 200, 1, {
    strokeVisible: true, strokePaint: "#000000", strokeWidth: 4, strokeAlign: "center",
  });
  const ui = await mount([l], [l.id]);
  await typePick(ui, "Dynamic");
  const n = ui.node(l.id);
  t("5-type: the picker switches the stroke to Dynamic", n.strokeType === "dynamic", String(n.strokeType));
  t("5-type: centre-aligned, undashed, defaults in the same patch",
    n.strokeAlign === "center" && n.strokeDash === 0 &&
      n.strokeDynFreq === 4 && n.strokeDynWiggle === 6 && n.strokeDynSmooth === 50,
    JSON.stringify({ a: n.strokeAlign, d: n.strokeDash, f: n.strokeDynFreq, w: n.strokeDynWiggle, s: n.strokeDynSmooth }));

  // Controls on the panel.
  const freq = ui.q('[aria-label="Dynamic frequency"]');
  const wig = ui.q('[aria-label="Dynamic wiggle"]');
  const sm = ui.q('[aria-label="Dynamic smooth"]');
  t("5-controls: freq/wiggle/smooth fields show", !!freq && !!wig && !!sm);
  if (wig) {
    await brk(ui);
    await ui.change(wig, 9);
    t("5-controls: wiggle patches", ui.node(l.id).strokeDynWiggle === 9, String(ui.node(l.id).strokeDynWiggle));
    await ui.dispatch({ type: "undo" });
    t("5-undo: one undo per control edit", ui.node(l.id).strokeDynWiggle === 6);
  }

  // Rendering: the centreline wobbles off y=150 with the amplitude.
  const m = ui.marker();
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynWiggle: 6, strokeDynFreq: 4, strokeDynSmooth: 100 } });
  let ys = lineTos(ui.tail(m)).map((e) => e[2]);
  t("5-render: the stroke leaves the centreline", ys.some((y) => y > 151.1), JSON.stringify(ys.slice(0, 6)));
  t("5-render: the deviation stays inside the amplitude",
    ys.every((y) => Math.abs(y - 150.5) <= 6.001), String(Math.max(...ys.map((y) => Math.abs(y - 150.5)))));
  t("5-render: both directions wave", ys.some((y) => y < 149.9) && ys.some((y) => y > 151.1));

  // Controls change the geometry.
  const before = JSON.stringify(lineTos(ui.tail(m)));
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynWiggle: 3 } });
  const t2 = ui.marker();
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynSmooth: 100 } });
  const wiggle3 = ui.tail(t2);
  t("5-render: halving the wiggle halves the wave",
    lineTos(wiggle3).every((e) => Math.abs(e[2] - 150.5) <= 3.001) &&
      JSON.stringify(lineTos(wiggle3)) !== before,
    String(Math.max(...lineTos(wiggle3).map((e) => Math.abs(e[2] - 150.5)))));
  const freqTail = ui.marker();
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynFreq: 9 } });
  t("5-render: frequency changes the wave too",
    JSON.stringify(lineTos(ui.tail(freqTail))) !== JSON.stringify(lineTos(wiggle3)) &&
      lineTos(ui.tail(freqTail)).every((e) => Math.abs(e[2] - 150.5) <= 3.001),
    `n=${lineTos(ui.tail(freqTail)).length} max=${Math.max(...lineTos(ui.tail(freqTail)).map((e) => Math.abs(e[2] - 150.5)))}`);
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynWiggle: 0 } });
  const flat = ui.marker();
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynFreq: 4 } });
  t("5-render: wiggle 0 runs straight again",
    lineTos(ui.tail(flat)).every((e) => Math.abs(e[2] - 150.5) < 1e-9),
    JSON.stringify(lineTos(ui.tail(flat)).slice(0, 4)));
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynWiggle: 6 } });

  // Centre-only + no dashes + no profile.
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeAlign: "inside" } });
  const cm = ui.marker();
  await ui.dispatch({ type: "patch", id: l.id, patch: { strokeDynWiggle: 7 } });
  t("5-centre: dynamic paint never clips", clips(ui.tail(cm)).length === 0, JSON.stringify(clips(ui.tail(cm))));
  t("5-dash: the style pills disable with the why",
    ["Solid", "Dashed", "Dotted"].every((lbl) => {
      const b = styleBtn(ui, lbl);
      return b && b.disabled && b.getAttribute("title") === "Brush and dynamic strokes cannot be dashed";
    }));
  const fieldset = ui.q("fieldset.width-profile");
  t("5-profile: dynamic disables the width-profile strip",
    !!fieldset && fieldset.disabled && fieldset.getAttribute("title") === "Dynamic strokes use a fixed width",
    fieldset ? String(fieldset.getAttribute("title")) : "none");
  await ui.close();
}

// ─────────────────────── 6 · visual feedback ───────────────────────
console.log("6 · feedback: previews paint, invalid options are disabled with tooltips");
{
  const r = rect100({ strokeAlign: "inside", strokeDash: 0 });
  const ui = await mount([r], [r.id]);
  // Style hover previews without committing; clicking commits one patch.
  const dashed = styleBtn(ui, "Dashed");
  const m = ui.marker();
  await ui.hover(dashed);
  t("6-preview: hovering Dashed shows dashes on canvas",
    ui.tail(m).some((e) => e[0] === "setLineDash" && e[1]?.[0] === 10));
  t("6-preview: the model is untouched while hovering", ui.node(r.id).strokeDash === 0);
  await ui.unhover(dashed);
  await ui.click(dashed);
  t("6-apply: clicking commits the preset", ui.node(r.id).strokeDash === 10 && styleBtn(ui, "Dashed").className.includes("on"));
  t("6-active: the active style pill lights up", styleBtn(ui, "Dashed").className.includes("on"));
  await ui.click(styleBtn(ui, "Dotted"));
  t("6-dotted: the dotted preset lands (round dash caps)",
    ui.node(r.id).strokeDash === 2 && ui.node(r.id).strokeGap === 8 && ui.node(r.id).strokeDashCap === "round",
    JSON.stringify({ d: ui.node(r.id).strokeDash, g: ui.node(r.id).strokeGap, c: ui.node(r.id).strokeDashCap }));
  await ui.click(styleBtn(ui, "Solid"));
  t("6-solid: solid clears the dashes", ui.node(r.id).strokeDash === 0 && ui.node(r.id).strokeGap === 0);
  // Disabled matrix options carry their tooltip.
  // The `add` command builds the node itself and auto-selects it.
  await ui.dispatch({
    type: "add", kind: "line", x: 400, y: 400, w: 100, h: 1,
    extra: { strokeVisible: true, strokePaint: "#000000", strokeWidth: 4 },
  });
  const lineId = ui.sel();
  t("6-setup: the line is added and selected", !!lineId && ui.node(lineId)?.kind === "line",
    JSON.stringify({ lineId, kind: ui.node(lineId)?.kind }));
  const jseg = joinSeg(ui);
  const joinBtns = ui.qa("button").filter((b) => (b.getAttribute("title") || "").startsWith("Join"));
  t("6-tip: line joins explain themselves",
    !!jseg && jseg.getAttribute("title") === "Lines have no joins" &&
      joinBtns.length === 3 && joinBtns.every((b) => b.disabled),
    (jseg ? jseg.getAttribute("title") : "no-seg") + " " +
      JSON.stringify(joinBtns.map((b) => b.getAttribute("title") + ":" + b.disabled)));
  await ui.close();
}

// ─────────────────────── 7 · undo integration ───────────────────────
console.log("7 · undo: every stroke change is a single step");
{
  const r = rect100();
  const ui = await mount([r], [r.id]);
  const snap = () => ui.node(r.id);
  const pick = () => ({
    sides: snap().strokeSides, align: snap().strokeAlign, cap: snap().strokeCap,
    join: snap().strokeJoin, dash: snap().strokeDash, type: snap().strokeType ?? "solid",
  });
  const base = JSON.stringify(pick());
  await brk(ui);
  await ui.click(sideBtn(ui, "Top"));
  await ui.dispatch({ type: "undo" });
  t("7-sides: side toggle = one step", JSON.stringify(pick()) === base,
    JSON.stringify(pick()));
  await brk(ui);
  await ui.select(alignSel(ui), "outside");
  await ui.dispatch({ type: "undo" });
  t("7-align: position change = one step", JSON.stringify(pick()) === base, JSON.stringify(pick()));
  await brk(ui);
  await ui.click(capBtn(ui, "Cap round"));
  await ui.dispatch({ type: "undo" });
  t("7-cap: cap change = one step", JSON.stringify(pick()) === base, JSON.stringify(pick()));
  await brk(ui);
  await ui.click(joinBtn(ui, "Join bevel"));
  await ui.dispatch({ type: "undo" });
  t("7-join: join change = one step", JSON.stringify(pick()) === base, JSON.stringify(pick()));
  await brk(ui);
  await ui.click(styleBtn(ui, "Dashed"));
  await ui.dispatch({ type: "undo" });
  t("7-style: style change = one step", JSON.stringify(pick()) === base, JSON.stringify(pick()));
  await brk(ui);
  await typePick(ui, "Brush");
  await ui.dispatch({ type: "undo" });
  t("7-type: stroke type change = one step", JSON.stringify(pick()) === base, JSON.stringify(pick()));
  await ui.close();
}

console.log(`\nstrokeSidesBrush: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
