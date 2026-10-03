/**
 * Frames probe (pipeline steps 3-4): the three frame behaviours the brief
 * names, measured against the real engine and the real Skia canvas.
 *
 *   A. Resize vs Scale — Figma's Frames article: dragging a frame's handle
 *      resizes it and "If you have applied constraints to any child objects,
 *      Figma will resize them to match the new frame preset. Otherwise, objects
 *      inside the frame will stay at the original dimensions and position."
 *      Handle-drag = constraints; only the Scale tool (K) scales children.
 *      Measure: a 50x50 child pinned top-left in a 200x200 frame whose right
 *      edge is dragged to 300 - does the child stay 50x50 (Resize) or become
 *      75x50/75x75 (Group/Scale behaviour)?
 *
 *   B. Rotation & clipping — "Clip Content: Hide any objects within the frame
 *      that extend beyond the frame's bounds." The bounds are the frame's own
 *      box in its local coordinate system: when the frame rotates, the clip
 *      mask must rotate with it.
 *      Measure (Skia pixels): a clip-content frame with a child spilling past
 *      its right edge, rotated 45 deg - is the ink cut at the *rotated* edge,
 *      or at an axis-aligned box (artifact)?
 *
 *   C. Resize to fit — "This will redraw the frame around the outermost bounds
 *      of the objects within it."
 *      Measure: frame W/H after `resizeToFit` vs the children's outermost
 *      bounds, stroke spill included.
 *
 * Run:  npx vite-node tests/probes/frames/edgeCases.mjs
 */
import { MemoryEngine, find, node, defaultEffect } from "../../../src/engine/memory.ts";
import { mountRealCanvas } from "../../../src/ui/__tests__/realCanvas2d.mjs";

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const N = (e, id) => find(rootOf(e), id);
const r2 = (n) => Math.round(n * 100) / 100;
const box = (n) => `(${r2(n.x)}, ${r2(n.y)}) ${r2(n.w)}x${r2(n.h)}`;
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

let fails = 0;
const say = (s = "") => console.log(s);
const expect = (label, actual, want, ok) => {
  if (!ok) fails++;
  say(`${ok ? "  ok " : " DIFF"} ${label}\n         measured: ${actual}\n         expected: ${want}`);
};

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

say("=== A · Resize (constraints) vs Scale (scaleProps) ===");
{
  // The brief's case: 200x200 frame, 50x50 child pinned top-left, right
  // handle dragged to 300. `ui/Canvas.tsx` dispatches the plain handle drag as
  // { type: "resize", scaleProps: tool === "scale" }, so this is the exact
  // payload a person's drag produces.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const c = addRect(e, F, 10, 10, 50, 50);
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200 });
  const k = N(e, c);
  expect(
    "A1 · right-edge drag 200 -> 300: top-left child keeps its size and place",
    box(k),
    "(10, 10) 50x50  — Resize triggers constraints; a 75x50/75x75 child would be Group/Scale behaviour",
    k.w === 50 && k.h === 50 && k.x === 10 && k.y === 10,
  );
}
{
  // Control per constraint: max pins to the moving edge, stretch grows.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const a = addRect(e, F, 10, 10, 50, 50, { constraintH: "max" });
  const b = addRect(e, F, 100, 100, 50, 50, { constraintH: "stretch" });
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200 });
  expect(
    "A2 · max pins to the moving edge (+100), stretch grows by the delta (50 -> 150)",
    `max ${box(N(e, a))};  stretch ${box(N(e, b))}`,
    "max (110, 10) 50x50;  stretch (100, 100) 150x50",
    N(e, a).x === 110 && N(e, a).w === 50 && N(e, b).w === 150 && N(e, b).h === 50,
  );
}
{
  // The Scale tool is the *only* thing that scales children: same payload with
  // scaleProps (snap.tool === "scale"). Side-drag is x1.5 / x1 -> children map
  // per axis, visual props by the mean.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const c = addRect(e, F, 10, 10, 50, 50);
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200, scaleProps: true });
  const k = N(e, c);
  expect(
    "A3 · Scale tool (scaleProps) DOES scale the child: x1.5/x1 -> (15, 10) 75x50",
    box(k),
    "(15, 10) 75x50",
    k.x === 15 && k.y === 10 && k.w === 75 && k.h === 50,
  );
}
{
  // Cmd/Ctrl-drag ignores the children's constraints entirely (Figma's tip).
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const a = addRect(e, F, 10, 10, 50, 50, { constraintH: "max" });
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200, ignoreConstraints: true });
  expect(
    "A4 · cmd-drag (ignoreConstraints) leaves even a max-pinned child untouched",
    box(N(e, a)),
    "(10, 10) 50x50",
    N(e, a).x === 10 && N(e, a).y === 10 && N(e, a).w === 50 && N(e, a).h === 50,
  );
}
{
  // Nested frames follow their own constraints, not a group scale.
  const e = engine();
  const F = addFrame(e, 0, 0, 200, 200);
  const inner = addFrame(e, 10, 10, 60, 60); // page-level add; reparent by patch is not the point
  e.dispatch({ type: "reparent", ids: [inner], parent: F });
  const g = addRect(e, F, 100, 10, 40, 40);
  e.dispatch({ type: "resize", id: F, x: 0, y: 0, w: 300, h: 200 });
  expect(
    "A5 · a nested frame child stays 60x60 (constraints), it is not scaled",
    `inner ${box(N(e, inner))};  sibling ${box(N(e, g))}`,
    "inner (10, 10) 60x60;  sibling (100, 10) 40x40",
    N(e, inner).w === 60 && N(e, inner).h === 60 && N(e, inner).x === 10,
  );
}

say("\n=== B · Clip content under rotation (Skia pixels) ===");
const red = (p) => p.r > 180 && p.g < 90 && p.b < 90;
const white = (p) => p.r > 240 && p.g > 240 && p.b > 240;
async function rotatedClipCase(withEffect) {
  // Frame 200x200 at (100,100), clip ON, child red (local x 150..250) spilling
  // 50px past the right edge. Rotated 45 deg about its centre (200,200):
  //   the frame's local right edge passes world (270.71, 270.71);
  //   local (190, 100) -> world (263.64, 263.64)  — 7px INSIDE the rotated edge;
  //   local (210, 100) -> world (277.78, 277.78)  — 7px OUTSIDE it, still in
  //   the child's ink (which runs to world (306, 306)).
  const child = node("rect", "Spill", 150, 0, 100, 200, {
    fill: "#ff0000", fillVisible: true, strokeVisible: false, strokePaint: "#00000000",
  });
  const frame = node("frame", "F", 100, 100, 200, 200, {
    fill: "#ffffff", overflow: "clip", children: [child],
    // A layer-blur row routes the paint through the composite-tile pipeline
    // (PR #43) with no shadow to confuse the samples; blur 0 is a no-op filter.
    ...(withEffect ? { effects: [{ ...defaultEffect("layer-blur"), blur: 0, visible: true }] } : {}),
  });
  const ui = await mountRealCanvas([frame]);
  const P = ui.grab();
  // Unrotated controls first.
  const unrotIn = P(275, 200); // local (175,100): child ink inside the clip
  const unrotOut = P(325, 200); // local (225,100): past the clip edge
  await ui.dispatch({ type: "patch", id: frame.id, patch: { rotation: 45 } });
  const Q = ui.grab();
  const pin = Q(264, 264); // inside the rotated frame, inside child ink
  const pout = Q(278, 278); // outside the rotated edge, inside child ink
  const far = Q(316, 316); // local ~ (262,100): past the child too
  // The clip edge on the outward diagonal: red must stop at t=100
  // (world 270.71, 270.71) — not run on to the child's ink at t=150.
  let lastRedT = -1;
  for (let t = 40; t <= 180; t += 1) {
    const x = Math.round(200 + t * Math.SQRT1_2), y = Math.round(200 + t * Math.SQRT1_2);
    if (red(Q(x, y))) lastRedT = t;
  }
  await ui.close();
  const tag = withEffect ? "(effects tile path) " : "(direct paint path) ";
  expect(
    `${tag}unrotated: ink inside the clip, clean past its right edge`,
    `in ${JSON.stringify(unrotIn)};  out ${JSON.stringify(unrotOut)}`,
    "in = red;  out = white",
    red(unrotIn) && white(unrotOut),
  );
  expect(
    `${tag}rotated 45deg: the clip mask rotates with the frame`,
    `P_in(264,264) ${JSON.stringify(pin)};  P_out(278,278) ${JSON.stringify(pout)};  far ${JSON.stringify(far)};  ink ends at t=${lastRedT}`,
    "P_in = red;  P_out = white (cut at the ROTATED edge — an axis-aligned mask would leave it red);  far = white;  ink ends at t≈100 (the rotated edge at 270.7, 270.7)",
    red(pin) && white(pout) && white(far) && Math.abs(lastRedT - 100) <= 2,
  );
}
await rotatedClipCase(false);
await rotatedClipCase(true);
{
  // 90deg discriminator: an 80x20 bar must stand vertical after a 90deg turn.
  // A double-applied rotation (the tile baking the CTM, then paint re-applying
  // it) turns it 180deg — it looks unrotated. This catches the bug even for
  // containers without clipping, and on groups as well as frames.
  for (const [kind, withEffect] of [["frame", false], ["frame", true], ["group", false], ["group", true]]) {
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
    expect(
      `B3 · ${kind}${withEffect ? " (effects tile)" : " (direct)"} @90deg: the bar turns vertical exactly once`,
      `horiz ${horiz}px / vert ${vert}px`,
      "vert ≫ horiz (a 180deg double-turn leaves it horizontal)",
      vert > horiz,
    );
  }
}

say("\n=== C · Resize to fit ===");
{
  // Three scattered children: an outside stroke (spill 10), a centre stroke
  // (spill 10), and a 45deg-rotated box (bbox 70.71). "Redraw the frame around
  // the outermost bounds of the objects within it" — strokes are part of an
  // object's bounds.
  //   A: box (50,50)-(90,90)  + outside 10 -> (40,40)-(100,100)
  //   B: box (200,100)-(260,160) + centre 20 -> (190,90)-(270,170)
  //   C: box (30,250)-(80,300) @45deg -> (19.64,239.64)-(90.36,310.36)
  //   union: x 19.64..270, y 40..310.36  ->  w 250.36, h 270.36
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
  expect(
    "C1 · the frame shrinks to the children's outermost bounds, stroke spill included",
    box(f),
    "(19.64, 40) 250.36x270.36",
    Math.abs(f.w - 250.36) < 0.1 && Math.abs(f.h - 270.36) < 0.1,
  );
  expect(
    "C2 · the children keep their world positions through the refit (locals shift with the frame)",
    `frame ${box(f)};  A world (${r2(f.x + N(e, a).x)}, ${r2(f.y + N(e, a).y)});  B world (${r2(f.x + N(e, b).x)}, ${r2(f.y + N(e, b).y)});  C world (${r2(f.x + N(e, c).x)}, ${r2(f.y + N(e, c).y)})`,
    "A world (50, 50);  B world (200, 100);  C world (30, 250)",
    near(f.x + N(e, a).x, 50) && near(f.y + N(e, a).y, 50) &&
    near(f.x + N(e, b).x, 200) && near(f.y + N(e, b).y, 100) &&
    near(f.x + N(e, c).x, 30) && near(f.y + N(e, c).y, 250),
  );
}
{
  // A hidden child is not an object "within" the visible bounds; it must not
  // drag the frame out.
  const e = engine();
  const F = addFrame(e, 0, 0, 400, 400);
  addRect(e, F, 100, 100, 50, 50);
  addRect(e, F, -200, -200, 50, 50, { visible: false });
  e.dispatch({ type: "select", ids: [F] });
  e.dispatch({ type: "resizeToFit" });
  const f = N(e, F);
  expect(
    "C3 · hidden children are ignored by the fit",
    box(f),
    "(100, 100) 50x50",
    f.w === 50 && f.h === 50 && f.x === 100 && f.y === 100,
  );
}
{
  // Grows as well as shrinks: a child outside the frame widens it.
  const e = engine();
  const F = addFrame(e, 0, 0, 50, 50);
  addRect(e, F, 40, 0, 60, 30);
  e.dispatch({ type: "select", ids: [F] });
  e.dispatch({ type: "resizeToFit" });
  const f = N(e, F);
  expect(
    "C4 · the fit redraws around the OBJECTS' bounds (the old frame box is not a union member)",
    box(f),
    "(40, 0) 60x30  — the frame becomes exactly the child's outermost bounds",
    f.w === 60 && f.h === 30 && f.x === 40 && f.y === 0,
  );
}

say(fails === 0 ? "\n0 deviation(s) measured" : `\n${fails} deviation(s) measured`);
process.exit(fails === 0 ? 0 : 1);
