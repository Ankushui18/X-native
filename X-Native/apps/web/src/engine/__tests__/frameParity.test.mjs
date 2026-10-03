/**
 * Frame parity (pipeline run 13): the three container behaviours the Frames
 * article ([360041539473]) defines — resize runs constraints and never scales
 * children, Clip content masks in the frame's own rotated bounds, and
 * "Resize to fit" redraws the frame around the children's *outermost* bounds
 * (stroke spill included).
 *
 * The evidence for the expected numbers (Figma, "Frames in Figma Design"):
 *   - "Drag to resize a frame manually … Click the handle … and drag" +
 *     "To ignore any constraints on child objects, hold down the modifier key"
 *     + "If you have applied constraints to any child objects, Figma will
 *     resize them … Otherwise, objects inside the frame will stay at the
 *     original dimensions and position." — handle-drag resolves constraints;
 *     only the Scale tool (K) scales children.
 *   - "Clip Content: Hide any objects within the frame that extend beyond the
 *     frame's bounds." The bounds are the frame's own box — one rotated object
 *     — so the mask turns with it.
 *   - "Resize to fit … will redraw the frame around the outermost bounds of
 *     the objects within it." A stroke is part of an object's bounds (outside
 *     full weight, centre half).
 *
 * Sections A/C are engine measurements (the `resize` / `resizeToFit` commands
 * the canvas dispatches); section B reads real Skia pixels through the app's
 * own paint path (`mountRealCanvas`) on both paint routes — the direct path
 * and PR #43's composite-tile path (any drop shadow / layer blur / noise /
 * texture row routes an effected container through it).
 *
 * Sabotage (each verified to fail on this file, then restored):
 *   - route plain resize through `scaleProps`        -> A1, A2, A5 fail
 *   - re-apply the rotation inside the tile pass     -> B3, B4, B5, B6, B7 fail
 *   - drop the strokeSpill pad in `resizeToFit`      -> C1 fails
 *
 * Run with:  npx vite-node src/engine/__tests__/frameParity.test.mjs
 */
import { MemoryEngine, find, node, defaultEffect } from "../memory.ts";
import { mountRealCanvas } from "../../ui/__tests__/realCanvas2d.mjs";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const N = (e, id) => find(rootOf(e), id);
const engine = () => new MemoryEngine(false);
const addFrame = (e, x, y, w, h) => {
  e.dispatch({ type: "add", kind: "frame", x, y, w, h, parent: rootOf(e).id });
  return rootOf(e).children.at(-1).id;
};
const addRect = (e, parent, x, y, w, h, patch = {}) => {
  e.dispatch({ type: "add", kind: "rect", x, y, w, h, parent });
  const id = N(e, parent).children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const red = (p) => p.r > 180 && p.g < 90 && p.b < 90;
const white = (p) => p.r > 240 && p.g > 240 && p.b > 240;

/* =================================================================== *
 * A · Resize triggers constraints; only the Scale tool scales children
 * =================================================================== */
console.log("A · Resize vs Scale:");

{
  // The brief's case: 200x200 frame, 50x50 child pinned top-left, the right
  // handle dragged to 300 — the payload ui/Canvas.tsx sends for a plain drag.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const c = addRect(e, F, 10, 10, 50, 50);
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200 });
  t("A1 the top-left child keeps its size and place (Resize, not Group scale)",
    near(N(e, c).x, 10) && near(N(e, c).y, 10) && near(N(e, c).w, 50) && near(N(e, c).h, 50));
}

{
  // Constraints resolve exactly as the article describes.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const a = addRect(e, F, 10, 10, 50, 50, { constraintH: "max" });
  const b = addRect(e, F, 100, 100, 50, 50, { constraintH: "stretch" });
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200 });
  t("A2 max pins to the moving edge (+100) and stretch grows by the delta (50 -> 150)",
    near(N(e, a).x, 110) && near(N(e, a).w, 50) && near(N(e, b).w, 150) && near(N(e, b).h, 50));
}

{
  // The Scale tool (K) is the only thing that scales children.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const c = addRect(e, F, 10, 10, 50, 50);
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200, scaleProps: true });
  t("A3 Scale tool (scaleProps) scales the child per axis: (15, 10) 75x50",
    near(N(e, c).x, 15) && near(N(e, c).y, 10) && near(N(e, c).w, 75) && near(N(e, c).h, 50));
}

{
  // Cmd/Ctrl-drag ignores constraints entirely — the article's Tip.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const a = addRect(e, F, 10, 10, 50, 50, { constraintH: "max" });
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200, ignoreConstraints: true });
  t("A4 cmd-drag leaves even a max-pinned child untouched",
    near(N(e, a).x, 10) && near(N(e, a).y, 10) && near(N(e, a).w, 50) && near(N(e, a).h, 50));
}

{
  // A nested frame follows its constraints; it is never group-scaled.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const inner = addFrame(e, 10, 10, 60, 60);
  e.dispatch({ type: "reparent", ids: [inner], parent: F });
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200 });
  t("A5 a nested frame child stays 60x60",
    near(N(e, inner).w, 60) && near(N(e, inner).h, 60) && near(N(e, inner).x, 10));
}

/* =================================================================== *
 * B · Clip content masks in the frame's OWN rotated bounds
 * =================================================================== */
console.log("B · Rotated clipping (Skia pixels):");

async function rotatedClipCase(withEffect) {
  // 200x200 clip frame at (100,100); red child local x 150..250 spills 50
  // past the right edge. At 45deg the rotated edge passes (270.71, 270.71):
  // ink must stop at t=100 on the outward diagonal, and the 7px-outside
  // sample (278, 278) must be white — an axis-aligned or double-rotated
  // mask leaves it red.
  const child = node("rect", "Spill", 150, 0, 100, 200, {
    fill: "#ff0000", fillVisible: true, strokeVisible: false, strokePaint: "#00000000",
  });
  const frame = node("frame", "F", 100, 100, 200, 200, {
    fill: "#ffffff", overflow: "clip", children: [child],
    // A layer-blur row routes the paint through the composite-tile pipeline
    // with no shadow to confuse the samples; blur 0 is a no-op filter.
    ...(withEffect ? { effects: [{ ...defaultEffect("layer-blur"), blur: 0, visible: true }] } : {}),
  });
  const ui = await mountRealCanvas([frame]);
  const P = ui.grab();
  const unrotIn = red(P(275, 200));
  const unrotOut = white(P(325, 200));
  await ui.dispatch({ type: "patch", id: frame.id, patch: { rotation: 45 } });
  const Q = ui.grab();
  const pin = red(Q(264, 264));
  const pout = white(Q(278, 278));
  const far = white(Q(316, 316));
  let lastRedT = -1;
  for (let tt = 40; tt <= 180; tt += 1) {
    const x = Math.round(200 + tt * Math.SQRT1_2), y = Math.round(200 + tt * Math.SQRT1_2);
    if (red(Q(x, y))) lastRedT = tt;
  }
  await ui.close();
  const tag = withEffect ? "effects tile" : "direct paint";
  t(`B1 ${tag}: unrotated clip cuts the spill at the frame edge`, unrotIn && unrotOut);
  t(`B2 ${tag}: at 45deg the ink is cut at the ROTATED edge (t≈100), (278,278) white`,
    pin && pout && far && Math.abs(lastRedT - 100) <= 2);
}
await rotatedClipCase(false);
await rotatedClipCase(true);

{
  // 90deg discriminator: an 80x20 bar must stand vertical after one turn. A
  // double-applied rotation renders it horizontal (180deg) — the artifact the
  // tile path used to produce for every effected container with children.
  const cases = [
    ["frame", false], ["frame", true], ["group", false], ["group", true],
  ];
  for (const [kind, withEffect] of cases) {
    const child = node("rect", "Bar", 10, 40, 80, 20, {
      fill: "#ff0000", fillVisible: true, strokeVisible: false, strokePaint: "#00000000",
    });
    const container = node(kind, "C", 100, 100, 100, 100, {
      fill: kind === "group" ? "#00000000" : "#ffffff",
      fillVisible: kind !== "group",
      overflow: kind === "group" ? "visible" : "clip",
      children: [child],
      ...(withEffect ? { effects: [{ ...defaultEffect("layer-blur"), blur: 0, visible: true }] } : {}),
    });
    const ui = await mountRealCanvas([container]);
    await ui.dispatch({ type: "patch", id: container.id, patch: { rotation: 90 } });
    const P = ui.grab();
    let horiz = 0, vert = 0;
    for (let y = 100; y < 200; y++) {
      for (let x = 100; x < 200; x++) {
        if (!red(P(x, y))) continue;
        if (Math.abs(y - 150) <= 12 && Math.abs(x - 150) <= 45) horiz++;
        if (Math.abs(x - 150) <= 12 && Math.abs(y - 150) <= 45) vert++;
      }
    }
    await ui.close();
    t(`B3 ${kind}${withEffect ? " (effects tile)" : " (direct)"} @90deg: the bar turns vertical exactly once`, vert > horiz);
  }
}

/* =================================================================== *
 * C · Resize to fit: the outermost bounds, stroke spill included
 * =================================================================== */
console.log("C · Resize to fit:");

{
  // A: outside stroke 10 (spill 10); B: centre stroke 20 (spill 10);
  // C: 45deg-rotated 50x50 (bbox 70.71). Outermost union:
  //   x 19.64..270, y 40..310.36  ->  (19.64, 40) 250.36x270.36.
  const e = engine();
  const F = addFrame(e, 0, 0, 400, 400);
  const a = addRect(e, F, 50, 50, 40, 40, {
    strokeVisible: true, strokePaint: "#000000", strokeWidth: 10, strokeAlign: "outside",
  });
  const b = addRect(e, F, 200, 100, 60, 60, {
    strokeVisible: true, strokePaint: "#000000", strokeWidth: 20, strokeAlign: "center",
  });
  const c = addRect(e, F, 30, 250, 50, 50, { rotation: 45 });
  e.dispatch({ type: "select", ids: [F] });
  e.dispatch({ type: "resizeToFit" });
  const f = N(e, F);
  t("C1 the frame shrinks to the children's outermost bounds, stroke spill included",
    near(f.x, 19.64, 0.1) && near(f.y, 40, 0.1) && near(f.w, 250.36, 0.1) && near(f.h, 270.36, 0.1));
  t("C2 the children keep their world positions through the refit",
    near(f.x + N(e, a).x, 50) && near(f.y + N(e, a).y, 50) &&
    near(f.x + N(e, b).x, 200) && near(f.y + N(e, b).y, 100) &&
    near(f.x + N(e, c).x, 30) && near(f.y + N(e, c).y, 250));
}

{
  // Hidden objects are not "within" the visible bounds.
  const e = engine();
  const F = addFrame(e, 0, 0, 400, 400);
  addRect(e, F, 100, 100, 50, 50);
  addRect(e, F, -200, -200, 50, 50, { visible: false });
  e.dispatch({ type: "select", ids: [F] });
  e.dispatch({ type: "resizeToFit" });
  const f = N(e, F);
  t("C3 hidden children are ignored by the fit",
    near(f.x, 100) && near(f.y, 100) && near(f.w, 50) && near(f.h, 50));
}

{
  // The fit redraws around the objects — the old frame box is not a member
  // of the union ("shrinks or grows to fit its child objects").
  const e = engine();
  const F = addFrame(e, 0, 0, 50, 50);
  addRect(e, F, 40, 0, 60, 30);
  e.dispatch({ type: "select", ids: [F] });
  e.dispatch({ type: "resizeToFit" });
  const f = N(e, F);
  t("C4 the fit grows to exactly the child's bounds (40, 0) 60x30",
    near(f.x, 40) && near(f.y, 0) && near(f.w, 60) && near(f.h, 30));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
