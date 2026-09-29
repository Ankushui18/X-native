/** Scratch 2: does the double-rotation hit any effected container with children? */
import { node, defaultEffect } from "../../../src/engine/memory.ts";
import { mountRealCanvas } from "../../../src/ui/__tests__/realCanvas2d.mjs";

const red = (p) => p.r > 180 && p.g < 90 && p.b < 90;

async function scene(kind, effects, tag) {
  const child = node("rect", "Kid", 25, 25, 50, 50, {
    fill: "#ff0000", fillVisible: true, strokeVisible: false, strokePaint: "#00000000",
  });
  const container = node(kind, "G", 100, 100, 100, 100, {
    fill: kind === "group" ? "#00000000" : "#ffffff",
    fillVisible: kind !== "group",
    overflow: kind === "group" ? "visible" : "clip",
    children: [child],
    effects,
  });
  const ui = await mountRealCanvas([container]);
  const unrot = ui.grab();
  const uCount = (() => {
    let n = 0;
    for (let y = 80; y < 240; y++) for (let x = 80; x < 240; x++) if (red(unrot(x, y))) n++;
    return n;
  })();
  const uCentroid = (() => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 80; y < 240; y++) for (let x = 80; x < 240; x++) if (red(unrot(x, y))) { sx += x; sy += y; n++; }
    return n ? [Math.round(sx / n), Math.round(sy / n)] : null;
  })();
  await ui.dispatch({ type: "patch", id: container.id, patch: { rotation: 45 } });
  const P = ui.grab();
  let n = 0, sx = 0, sy = 0;
  for (let y = 80; y < 240; y++) for (let x = 80; x < 240; x++) if (red(P(x, y))) { sx += x; sy += y; n++; }
  const centroid = n ? [Math.round(sx / n), Math.round(sy / n)] : null;
  console.log(`${tag}: unrot red=${uCount} centroid=${uCentroid};  rot45 red=${n} centroid=${centroid}`);
  await ui.close();
}

// Child at (25,25) 50x50 in a 100x100 container at (100,100): child centre (150,150),
// container centre (150,150) — same. Correct 45deg: centroid stays (150,150).
// Double rotation (90deg) about the same centre: also (150,150) — so centroid is
// useless here; use the corner marker instead. Add an L-shaped second child? No —
// keep it simple: the child is square, so 90deg looks identical. Use a wide child.
async function sceneWide(kind, effects, tag) {
  const child = node("rect", "Kid", 10, 40, 80, 20, {
    fill: "#ff0000", fillVisible: true, strokeVisible: false, strokePaint: "#00000000",
  });
  const container = node(kind, "G", 100, 100, 100, 100, {
    fill: kind === "group" ? "#00000000" : "#ffffff",
    fillVisible: kind !== "group",
    overflow: kind === "group" ? "visible" : "clip",
    children: [child],
    effects,
  });
  const ui = await mountRealCanvas([container]);
  await ui.dispatch({ type: "patch", id: container.id, patch: { rotation: 90 } });
  const P = ui.grab();
  // Correct at 90deg: the 80x20 bar (centre 150,150) becomes 20x80 vertical.
  // Double (180deg): it stays 80x20 horizontal.
  let horiz = 0, vert = 0;
  for (let y = 100; y < 200; y++) for (let x = 100; x < 200; x++) {
    if (!red(P(x, y))) continue;
    if (Math.abs(y - 150) <= 12 && Math.abs(x - 150) <= 45) horiz++;
    if (Math.abs(x - 150) <= 12 && Math.abs(y - 150) <= 45) vert++;
  }
  console.log(`${tag} @90deg: bar-horiz px=${horiz}  bar-vert px=${vert}  -> ${vert > horiz ? "correct (bar rotated with container)" : "WRONG (bar not rotated / double-rotated)"}`);
  await ui.close();
}

const blur0 = [{ ...defaultEffect("layer-blur"), blur: 0, visible: true }];
await sceneWide("frame", [], "frame direct ");
await sceneWide("frame", blur0, "frame tile   ");
await sceneWide("group", [], "group direct ");
await sceneWide("group", blur0, "group tile   ");
