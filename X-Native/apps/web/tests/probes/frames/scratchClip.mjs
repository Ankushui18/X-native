/** Scratch: disambiguate the effects-tile clip bug under rotation. */
import { node, defaultEffect } from "../../../src/engine/memory.ts";
import { mountRealCanvas } from "../../../src/ui/__tests__/realCanvas2d.mjs";

const red = (p) => p.r > 180 && p.g < 90 && p.b < 90;

async function scene(effects, tag) {
  const child = node("rect", "Spill", 150, 0, 100, 200, {
    fill: "#ff0000", fillVisible: true, strokeVisible: false, strokePaint: "#00000000",
  });
  const frame = node("frame", "F", 100, 100, 200, 200, {
    fill: "#ffffff", overflow: "clip", children: [child], effects,
  });
  const ui = await mountRealCanvas([frame]);
  await ui.dispatch({ type: "patch", id: frame.id, patch: { rotation: 45 } });
  const P = ui.grab();
  // 1) Outward diagonal from centre (200,200): the frame's local +x axis at 45deg.
  let lastRed = null;
  for (let t = 40; t <= 180; t += 1) {
    const x = Math.round(200 + t * Math.SQRT1_2), y = Math.round(200 + t * Math.SQRT1_2);
    if (red(P(x, y))) lastRed = [x, y, t];
  }
  // 2) Red pixel set over the region of interest.
  const pts = [];
  for (let y = 120; y < 360; y++) for (let x = 120; x < 360; x++) if (red(P(x, y))) pts.push(`${x},${y}`);
  console.log(`${tag}: last red on outward diagonal = ${lastRed ? `${lastRed[0]},${lastRed[1]} (t=${lastRed[2]})` : "none"};  red px = ${pts.length}`);
  await ui.close();
  return new Set(pts);
}

const blur0 = [{ ...defaultEffect("layer-blur"), blur: 0, visible: true }];
const direct = await scene([], "direct path (no effects)      ");
const tile = await scene(blur0, "tile path (layer-blur 0)     ");

let onlyDirect = 0, onlyTile = 0;
for (const p of direct) if (!tile.has(p)) onlyDirect++;
for (const p of tile) if (!direct.has(p)) onlyTile++;
console.log(`red-set delta: direct-only ${onlyDirect}, tile-only ${onlyTile}`);
// Sample points from the CORRECT geometry (direct path defines ground truth):
// local (210,100) -> world (277.8, 277.8) must be clipped away.
// local (190,100) -> world (263.6, 263.6) must be inked.
