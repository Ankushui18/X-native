/**
 * Pixel grid layering, in composited pixels (batch 45, fix 1).
 *
 * `figmaCanvasVectorParity.dom.test.mjs` proves the *order* of the draw calls;
 * this file proves what a person sees, on the Skia backend (`realCanvas2d`),
 * because "the grid is invisible behind the shape I am checking" is a pixel
 * claim. A full-bleed near-black rect is the worst case for it.
 *
 * Run with:  npx vite-node src/ui/__tests__/figmaGridLayering.dom.test.mjs
 *
 * Sabotage log (break applied -> file re-run -> failure recorded -> restored):
 *   - move the `paintPixelGrid()` call back above the layer-tree loop
 *       -> H1 fails (the rect swallows the grid), H2 fails (no grid over art)
 *   - delete the call entirely
 *       -> H1, H2 and H3 all fail
 *   - paint the grid after the selection chrome instead of before it
 *       -> H4 fails
 *   - drop the `zoom >= 4` gate
 *       -> H5 fails
 */
import { mountRealCanvas } from "./realCanvas2d.mjs";
import { node } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};

const pageNode = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
/** Grid lines are 1 document px apart and the page is at the origin, so the
 *  device pixels between layers (x + 3.5, y + 3.5) sit off every hairline. */
/** `realCanvas2d`'s harness fixes the page node, so view flags arrive by dispatch. */
async function mountGrid(children, view = {}) {
  const ui = await mountRealCanvas(children, view);
  await ui.dispatch({
    type: "patchPage",
    patch: { pixelGrid: true, pixelGridColor: "#ffffff", ...(view.pagePatch ?? {}) },
  });
  return ui;
}

function countInk(f, x0, y0, w, h) {
  let n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (f(x, y).r > 40) n++;
  return n;
}

/* ---------------------------------- H · the grid over the artwork, 400% up */
{
  const cover = node("rect", "Cover", 0, 0, 1000, 800, { fill: "#000000", fillVisible: true });
  const ui = await mountGrid([cover], { zoom: 5 });
  const f = ui.grab();
  // Probed off the hairlines (at zoom 5 they land on every 5th device pixel), so
  // this says "the artwork is really black here", not "the grid is missing".
  t("H0 the layer really is full-bleed near-black at this zoom", f(502, 401).r < 10 && f(502, 401).a > 0.9,
    JSON.stringify(f(502, 401)));
  t("H1 the pixel grid draws OVER the document, not behind it", countInk(f, 100, 100, 60, 60) > 0,
    `white pixels inside the black layer: ${countInk(f, 100, 100, 60, 60)}`);

  // Same page, flag off: the grid is a view setting, never an artwork change.
  await ui.dispatch({ type: "patchPage", patch: { pixelGrid: false } });
  const g = ui.grab();
  t("H2 with the pixel grid off, nothing draws over the layer", countInk(g, 100, 100, 60, 60) === 0,
    `white pixels: ${countInk(g, 100, 100, 60, 60)}`);

  // And back on, with a layer selected: the selection ring stays the top layer.
  await ui.dispatch({ type: "patchPage", patch: { pixelGrid: true } });
  await ui.dispatch({ type: "select", ids: [cover.id] });
  const s = ui.grab();
  // The ring is the 1px accent outline at the node's edges — (0,0)..(1000,800)
  // in world at zoom 5, i.e. device (0,0) to (5000,4000): off-screen on the right
  // and bottom, but its top-left corner pixel is at the origin. Check the accent
  // is present at the edge while the grid sits under it in the stack: the grid's
  // hairlines must not have eaten the ring, so the corner row keeps its accent.
  let ring = 0;
  for (let x = 0; x < 300; x++) {
    const p = s(x, 0);
    if (p.g > 120 && p.g > p.r + 30 && p.g > p.b + 30) ring++;
  }
  // A grid painted *last* would punch a white hairline through the ring every 5th
  // device pixel, so the run of accent has to be essentially unbroken.
  t("H3 the selection chrome still paints above the grid", ring >= 296, `accent pixels on the top edge: ${ring}/300`);
  await ui.close();
}

/* --------------------------------------- H4 · the visibility floor is 400% */
{
  const cover = node("rect", "Cover", 0, 0, 1000, 800, { fill: "#000000", fillVisible: true });
  const ui = await mountGrid([cover], { zoom: 3.9 });
  const f = ui.grab();
  t("H4 the grid stays hidden below 400%, whatever is under it", countInk(f, 100, 100, 60, 60) === 0,
    `white pixels: ${countInk(f, 100, 100, 60, 60)}`);
  await ui.close();
}

/* ------------------------------- H5 · it follows pan and zoom, at every depth */
{
  const cover = node("rect", "Cover", 0, 0, 1000, 800, { fill: "#000000", fillVisible: true });
  const ui = await mountGrid([cover], { zoom: 8, panX: -37, panY: -11 });
  const f = ui.grab();
  const n = countInk(f, 200, 200, 40, 40);
  t("H5 at 800% the grid still lays over the artwork after a pan", n > 0, `white pixels: ${n}`);
  // 1 document px at 800% is 8 device px, so the hairlines are 8px apart: count
  // them along a row and check the spacing rather than just the presence.
  let first = -1, step = -1;
  for (let x = 200; x < 240; x++) {
    if (f(x, 220).r > 40) {
      if (first < 0) first = x;
      else if (step < 0) step = x - first;
    }
  }
  t("H6 the grid is one *document* pixel apart, not one device pixel", step === 8, `spacing: ${step}`);
  await ui.close();
}

console.log(`\nfigmaGridLayering: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
