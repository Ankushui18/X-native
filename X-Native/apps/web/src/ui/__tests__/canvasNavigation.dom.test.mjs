/** Canvas navigation (Run 25, P0-1): the wheel must be a *cancelable* gesture
 *  that the canvas keeps for itself, and Space must pan even when the caret was
 *  left on a panel control.
 *
 *  Why this test exists in this shape: React registers `wheel` passively at the
 *  root, so an `onWheel` prop's `preventDefault()` is discarded and Ctrl/⌘+wheel
 *  (and every trackpad pinch, which arrives as one) zoomed the browser page on
 *  top of the canvas. jsdom does not model passive listeners, so a behavioural
 *  assertion alone would pass on the broken code too — the structural assertion
 *  (a native listener registered on `.canvas-wrap` with `{ passive: false }`) is
 *  the one that fails if the fix is reverted to a JSX prop. The behavioural
 *  assertions then pin what the handler does: cancel the default, zoom about the
 *  cursor, pan otherwise.
 *
 *  Run: vite-node src/ui/__tests__/canvasNavigation.dom.test.mjs */
import { mountCanvas } from "./softCanvas2d.mjs";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const window = globalThis.window;

/** Record every `wheel` listener registered while `fn` runs. */
async function withWheelSpy(fn) {
  const proto = window.EventTarget.prototype;
  const orig = proto.addEventListener;
  const seen = [];
  proto.addEventListener = function (type, listener, options) {
    if (type === "wheel") {
      seen.push({ el: this, passive: options && typeof options === "object" ? options.passive : undefined });
    }
    return orig.call(this, type, listener, options);
  };
  try {
    return { seen, result: await fn() };
  } finally {
    proto.addEventListener = orig;
  }
}

/** Dispatch a real WheelEvent inside `act`, so the engine dispatch it causes
 *  flushes before the assertions read the snapshot. */
const wheel = async (ui, init) => {
  let ev = null;
  await ui.act(() => {
    ev = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    ui.host.querySelector(".canvas-wrap").dispatchEvent(ev);
  });
  return ev;
};

// ── 1. Registration: a native, non-passive listener on the canvas wrapper ────
const { seen, result: ui } = await withWheelSpy(() => mountCanvas([]));
const surface = ui.host.querySelector(".canvas-wrap");
t("the canvas wrapper is mounted", !!surface);
const registration = seen.find((r) => r.el === surface);
t(
  "wheel is registered natively on .canvas-wrap (not via a React prop)",
  !!registration,
  JSON.stringify(seen.map((r) => ({ tag: r.el?.tagName, cls: r.el?.className, passive: r.passive }))),
);
t("...and it is non-passive, so preventDefault is honoured", registration?.passive === false, String(registration?.passive));

// ── 2. Ctrl/⌘ + wheel: cancelled, and anchored on the cursor ────────────────
{
  const s0 = ui.engine.snapshot();
  const init = { deltaY: -100, deltaMode: 0, ctrlKey: true, clientX: 500, clientY: 400 };
  const ev = await wheel(ui, init);
  t("a ctrl+wheel over the canvas is default-prevented (page zoom is cancelled)", ev.defaultPrevented);

  const cx = init.clientX - 50; // softCanvas2d stubs the wrapper at left:50, top:30
  const cy = init.clientY - 30;
  const worldBefore = { x: (cx - s0.panX) / s0.zoom, y: (cy - s0.panY) / s0.zoom };
  const s1 = ui.engine.snapshot();
  t("ctrl+wheel zooms in", s1.zoom > s0.zoom, `${s0.zoom} → ${s1.zoom}`);
  t("one wheel notch is one step (1.1×)", near(s1.zoom, s0.zoom * 1.1, 1e-9), String(s1.zoom));
  const worldAfter = { x: (cx - s1.panX) / s1.zoom, y: (cy - s1.panY) / s1.zoom };
  t(
    "the design point under the cursor does not drift while zooming",
    near(worldBefore.x, worldAfter.x, 1e-6) && near(worldBefore.y, worldAfter.y, 1e-6),
    JSON.stringify({ worldBefore, worldAfter }),
  );
}

// ── 3. Plain wheel pans; ⇧ + wheel pans horizontally only ───────────────────
{
  const s0 = ui.engine.snapshot();
  const ev = await wheel(ui, { deltaX: 10, deltaY: 20, clientX: 500, clientY: 400 });
  const s1 = ui.engine.snapshot();
  t("a plain wheel over the canvas is default-prevented too", ev.defaultPrevented);
  t("a plain wheel is still a pan, not a zoom", s1.zoom === s0.zoom);
  t(
    "the pan follows the wheel deltas (scrolling down moves the content down)",
    s1.panX === s0.panX - 10 && s1.panY === s0.panY - 20,
    JSON.stringify([s1.panX - s0.panX, s1.panY - s0.panY]),
  );
  const evS = await wheel(ui, { deltaY: 100, shiftKey: true, clientX: 500, clientY: 400 });
  const s2 = ui.engine.snapshot();
  t("⇧+wheel is default-prevented", evS.defaultPrevented);
  t("⇧+wheel pans horizontally and leaves y alone", s2.panX === s1.panX - 100 && s2.panY === s1.panY, JSON.stringify([s2.panX - s1.panX, s2.panY - s1.panY]));
}

// ── 4. A non-cancelable event must not throw (jsdom dispatch without flags) ─
{
  const s0 = ui.engine.snapshot();
  let threw = null;
  await ui.act(() => {
    try {
      surface.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: -100, ctrlKey: true, clientX: 500, clientY: 400 }));
    } catch (err) {
      threw = String(err);
    }
  });
  const s1 = ui.engine.snapshot();
  t("a non-cancelable wheel is still handled, without throwing", !threw && s1.zoom > s0.zoom, threw || `${s0.zoom} → ${s1.zoom}`);
}

// ── 5. Space pans, including with the caret on an Inspector numeric field ───
{
  const inspector = document.createElement("div");
  inspector.className = "inspector";
  inspector.innerHTML =
    '<div class="x-num-wrap"><input class="x-num-input" aria-label="W" /></div>' +
    '<input class="x-input" aria-label="Layer name" />';
  document.body.appendChild(inspector);
  const num = inspector.querySelector(".x-num-input");
  const prose = inspector.querySelector(".x-input");

  num.focus();
  t("the Inspector numeric field holds the caret", document.activeElement === num);
  const spaceDown = new window.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
  await ui.act(() => num.dispatchEvent(spaceDown));
  t("Space on a numeric field is taken by the canvas, not typed", spaceDown.defaultPrevented);
  t("...and the caret leaves the field, so the key cannot re-activate a control", document.activeElement !== num, String(document.activeElement?.className));
  t("...and the canvas shows the pan cursor", surface.style.cursor === "grab", surface.style.cursor);

  // Space+drag after that focus: the drag must pan, not marquee.
  const dispatched = [];
  const orig = ui.engine.dispatch.bind(ui.engine);
  ui.engine.dispatch = (cmd) => {
    dispatched.push(cmd);
    return orig(cmd);
  };
  const s0 = ui.engine.snapshot();
  const mouse = (type, x, y, button = 0) =>
    ui.act(() => surface.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })));
  await mouse("mousedown", 300, 300);
  await mouse("mousemove", 340, 320);
  await mouse("mouseup", 340, 320);
  ui.engine.dispatch = orig;
  const s1 = ui.engine.snapshot();
  t("after focusing a numeric field, Space+drag pans the canvas", s1.panX === s0.panX + 40 && s1.panY === s0.panY + 20, JSON.stringify([s1.panX - s0.panX, s1.panY - s0.panY]));
  t("...as pan commands, not a marquee selection", dispatched.some((c) => c.type === "pan") && !dispatched.some((c) => c.type === "select"));

  await ui.act(() => window.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })));
  t("releasing Space leaves pan mode", surface.style.cursor !== "grab", surface.style.cursor);

  // A prose field keeps the key: Space is a character there.
  prose.focus();
  const proseSpace = new window.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
  await ui.act(() => prose.dispatchEvent(proseSpace));
  t("Space in a text field stays with the field (it is a character)", !proseSpace.defaultPrevented && document.activeElement === prose);
  t("...and the canvas does not enter pan mode", surface.style.cursor !== "grab", surface.style.cursor);

  // A keyup that never arrives (tab switch) must not wedge pan mode.
  num.focus();
  await ui.act(() => num.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true })));
  t("Space re-enters pan mode from the field", surface.style.cursor === "grab", surface.style.cursor);
  await ui.act(() => window.dispatchEvent(new window.Event("blur")));
  t("a window blur releases a held Space instead of wedging the canvas", surface.style.cursor !== "grab", surface.style.cursor);

  inspector.remove();
}

// ── 6. Unmount detaches the wheel listener ─────────────────────────────────
{
  const s0 = ui.engine.snapshot();
  await ui.close();
  await ui.act(() =>
    surface.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, ctrlKey: true, clientX: 500, clientY: 400 })),
  );
  t("the wheel listener is removed with the canvas", ui.engine.snapshot().zoom === s0.zoom);
}

console.log(`canvasNavigation: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
