/**
 * Headless checks for §13 (images, crop, masks): crop-rect math, image-fill
 * geometry, stacked image paints, the mask-run compositor model, and the SVG
 * export image branch.
 *
 * Run with:  npx vite-node src/engine/__tests__/images.test.mjs
 *
 * The render functions draw on a recording stub instead of a real canvas, so
 * what is asserted is the geometry handed to the canvas API (drawImage boxes,
 * pattern scales, clip wrappers), not pixels.
 */
import {
  coverCrop,
  normalizeCropRect,
  paintFill,
  paintImageFill,
  partitionMaskRuns,
  reduceMaskAlpha,
} from "../paint.ts";
import {
  cropFullExtent,
  cropHandleRects,
  dragCropHandle,
  initialCropRect,
  layerToImage,
  moveCrop,
} from "../../ui/cropModel.ts";
import { svgNode } from "../svgExport.ts";

// paintImageFill probes `instanceof HTMLCanvasElement`; under vite-node the
// DOM globals do not exist, so a stub class stands in (no test below hits
// the adjusted-image path, which needs a real canvas).
globalThis.HTMLCanvasElement ??= class {};
globalThis.HTMLImageElement ??= class {};

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

/** Minimal node; the image painters only read the image family plus w/h. */
const node = (over = {}) => ({
  w: 200,
  h: 100,
  fill: "#ff0000",
  fillType: "solid",
  fillVisible: true,
  fillOpacity: 1,
  gradientStops: [],
  fills: [],
  ...over,
});

const fakeImg = (w, h) => ({ naturalWidth: w, naturalHeight: h });

function mockCtx() {
  const calls = { draws: [], patterns: [], scales: [], rects: [], fills: 0 };
  return {
    calls,
    ctx: {
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillStyle: "",
      save() {},
      restore() {},
      clip() {},
      fill() { calls.fills++; },
      translate() {},
      scale(x, y) { calls.scales.push([x, y]); },
      fillRect(...a) { calls.rects.push(a); },
      drawImage(...a) { calls.draws.push(a); },
      createPattern(src, rep) { calls.patterns.push([src, rep]); return {}; },
    },
  };
}

console.log("I-A normalizeCropRect:");
{
  t("missing rect is the full image", JSON.stringify(normalizeCropRect(undefined)) === JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }));
  t("valid rect passes through", JSON.stringify(normalizeCropRect({ x: 0.2, y: 0.3, w: 0.5, h: 0.4 })) === JSON.stringify({ x: 0.2, y: 0.3, w: 0.5, h: 0.4 }));
  const tiny = normalizeCropRect({ x: 0.5, y: 0.5, w: 0, h: -2 });
  t("sides clamp to at least 1%", near(tiny.w, 0.01) && near(tiny.h, 0.01));
  const over = normalizeCropRect({ x: -1, y: 0.9, w: 2, h: 0.5 });
  t("rect is pinned inside 0..1", near(over.x, 0) && near(over.w, 1) && near(over.y, 0.5) && near(over.h, 0.5));
}

console.log("I-B coverCrop:");
{
  const same = coverCrop(200, 100, 200, 100);
  t("same aspect shows the whole image", near(same.x, 0) && near(same.y, 0) && near(same.w, 1) && near(same.h, 1));
  const wide = coverCrop(400, 100, 100, 100);
  t("wide image crops the sides, centred", near(wide.x, 0.375) && near(wide.w, 0.25) && near(wide.y, 0) && near(wide.h, 1));
  const tall = coverCrop(100, 400, 100, 100);
  t("tall image crops top and bottom, centred", near(tall.y, 0.375) && near(tall.h, 0.25) && near(tall.x, 0) && near(tall.w, 1));
  t("degenerate sizes fall back to full", JSON.stringify(coverCrop(0, 100, 100, 100)) === JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }));
}

console.log("I-C cropModel:");
{
  t("stored rect passes through initial", JSON.stringify(initialCropRect({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 400, 100, 100, 100)) === JSON.stringify({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }));
  const init = initialCropRect(undefined, 400, 100, 100, 100);
  t("missing rect materialises the cover region", near(init.x, 0.375) && near(init.w, 0.25));
  const li = layerToImage({ x: 0.25, y: 0, w: 0.5, h: 1 }, 0.5, 0.5);
  t("layer centre maps to crop centre", near(li.u, 0.5) && near(li.v, 0.5));
  const full = cropFullExtent({ x: 10, y: 20, w: 100, h: 100 }, { x: 0, y: 0, w: 1, h: 1 });
  t("identity window extent is the box", near(full.x, 10) && near(full.y, 20) && near(full.w, 100) && near(full.h, 100));
  const half = cropFullExtent({ x: 10, y: 20, w: 100, h: 100 }, { x: 0.25, y: 0, w: 0.5, h: 1 });
  t("half-width window doubles the extent, offset left", near(half.w, 200) && near(half.x, -40) && near(half.h, 100) && near(half.y, 20));
  const hs = cropHandleRects({ x: 0, y: 0, w: 100, h: 60 }, 8);
  t("eight handles", hs.length === 8);
  const byH = Object.fromEntries(hs.map((h) => [h.handle, h]));
  t("corners sit on the box corners", near(byH.nw.x, -4) && near(byH.nw.y, -4) && near(byH.se.x, 96) && near(byH.se.y, 56));
  const east = dragCropHandle({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, "e", 0.9, 0.9);
  t("edge drag moves one side only", near(east.x, 0.1) && near(east.y, 0.1) && near(east.w, 0.8) && near(east.h, 0.5));
  const locked = dragCropHandle({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, "se", 0.8, 0.95, { lockAspect: true });
  t("corner drag keeps the region square", near(locked.w, locked.h) && near(locked.w, 0.85));
  const free = dragCropHandle({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, "se", 0.8, 0.95, { lockAspect: false });
  t("freed corner drag follows the pointer", near(free.w, 0.7) && near(free.h, 0.85));
  const sym = dragCropHandle({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, "e", 0.9, 0.5, { symmetric: true });
  t("symmetric drag mirrors about the centre", near(sym.x, 0.1) && near(sym.w, 0.8));
  const cross = dragCropHandle({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, "w", 0.9, 0.5);
  t("dragging past the far edge flips, never inverts", cross.w >= 0.01 && cross.x >= 0 && cross.x + cross.w <= 1);
  const mv = moveCrop({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 0.2, -0.05);
  t("pan shifts the window", near(mv.x, 0.3) && near(mv.y, 0.05) && near(mv.w, 0.5));
  const pin = moveCrop({ x: 0.4, y: 0.4, w: 0.5, h: 0.5 }, 0.5, 0.5);
  t("pan pins inside the image", near(pin.x, 0.5) && near(pin.y, 0.5));
}

console.log("I-D paintImageFill geometry:");
{
  const im = fakeImg(200, 100);
  const c1 = mockCtx();
  paintImageFill(c1.ctx, node({ fillType: "image", imageFit: "fill" }), im, 10, 20, 100, 100);
  t("fill covers, centred", c1.calls.draws.length === 1 && near(c1.calls.draws[0][1], -40) && near(c1.calls.draws[0][2], 20) && near(c1.calls.draws[0][3], 200) && near(c1.calls.draws[0][4], 100));
  const c2 = mockCtx();
  paintImageFill(c2.ctx, node({ fillType: "image", imageFit: "fit" }), im, 10, 20, 100, 100);
  t("fit letterboxes, centred", c2.calls.draws.length === 1 && near(c2.calls.draws[0][1], 10) && near(c2.calls.draws[0][2], 45) && near(c2.calls.draws[0][3], 100) && near(c2.calls.draws[0][4], 50));
  const c3 = mockCtx();
  paintImageFill(c3.ctx, node({ fillType: "image", imageFit: "crop", imageCrop: { x: 0.25, y: 0, w: 0.5, h: 1 } }), im, 10, 20, 100, 100);
  t("crop draws the stored rect", c3.calls.draws.length === 1 && c3.calls.draws[0].length === 9 && near(c3.calls.draws[0][1], 50) && near(c3.calls.draws[0][3], 100));
  const c4 = mockCtx();
  paintImageFill(c4.ctx, node({ fillType: "image", imageFit: "crop" }), im, 10, 20, 100, 100);
  t("crop without a rect falls back to cover", c4.calls.draws.length === 1 && c4.calls.draws[0].length === 5 && near(c4.calls.draws[0][3], 200));
  const c5 = mockCtx();
  paintImageFill(c5.ctx, node({ fillType: "image", imageFit: "tile", imageTile: 50, w: 200, h: 200 }), im, 0, 0, 100, 100);
  t("tile builds a repeating pattern", c5.calls.patterns.length === 1 && c5.calls.patterns[0][1] === "repeat");
  t("tile scale honours the percent and zoom", c5.calls.scales.length === 1 && near(c5.calls.scales[0][0], 0.25));
  t("tile rect shrinks in step", c5.calls.rects.length === 1 && near(c5.calls.rects[0][2], 400) && near(c5.calls.rects[0][3], 400));
  const c6 = mockCtx();
  paintImageFill(c6.ctx, node({ fillType: "image", imageFit: "fill" }), im, 0, 0, 0, 100);
  t("empty boxes paint nothing", c6.calls.draws.length === 0);
  const c7 = mockCtx();
  paintImageFill(c7.ctx, node({ fillType: "image", imageFit: "fill" }), fakeImg(0, 0), 0, 0, 100, 100);
  t("unloaded images paint nothing", c7.calls.draws.length === 0);
}

console.log("I-E stacked image paints:");
{
  const base = fakeImg(100, 100), a = fakeImg(50, 50), b = fakeImg(25, 25);
  const imgOf = (src) => (src === "base" ? base : src === "a" ? a : src === "b" ? b : undefined);
  const n = node({
    fillType: "image", imageSrc: "base", imageFit: "fill",
    fills: [
      { type: "image", image: "a", imageFit: "fit", color: "#000000", opacity: 1 },
      { type: "image", image: "b", imageFit: "fill", color: "#000000", opacity: 1 },
    ],
  });
  const c = mockCtx();
  paintFill(c.ctx, n, 0, 0, 100, 100, imgOf);
  t("base plus two paints paint three images", c.calls.draws.length === 3);
  t("stack order is base first, top paint last", c.calls.draws[0][0] === base && c.calls.draws[1][0] === a && c.calls.draws[2][0] === b);
  const hid = mockCtx();
  paintFill(hid.ctx, node({ fillType: "solid", fills: [{ type: "image", image: "a", color: "#000000", visible: false }] }), 0, 0, 100, 100, imgOf);
  t("hidden stack paints are skipped", hid.calls.draws.length === 0);
  const miss = mockCtx();
  paintFill(miss.ctx, node({ fillType: "solid", fills: [{ type: "image", image: "", color: "#000000" }] }), 0, 0, 100, 100, imgOf);
  t("stack paints without a source are skipped", miss.calls.draws.length === 0);
  const leak = mockCtx();
  paintFill(leak.ctx, node({
    fillType: "image", imageSrc: "base", imageFit: "crop", imageCrop: { x: 0.25, y: 0, w: 0.5, h: 1 },
    fills: [{ type: "image", image: "a", imageFit: "fill", color: "#000000" }],
  }), 0, 0, 100, 100, imgOf);
  t("stack paints never inherit the base crop", leak.calls.draws.length === 2 && leak.calls.draws[0].length === 9 && leak.calls.draws[1].length === 5);
}

console.log("I-F mask runs and reduction:");
{
  const run = (kids) => partitionMaskRuns(kids);
  t("no masks is one plain run", JSON.stringify(run([{ id: 1 }, { id: 2 }])) === JSON.stringify([{ mask: null, kids: [{ id: 1 }, { id: 2 }] }]));
  const r1 = run([{ isMask: true, visible: true, id: "m" }, { id: "a" }, { id: "b" }]);
  t("a mask opens a run over the siblings above", r1.length === 1 && r1[0].mask.id === "m" && r1[0].kids.length === 2);
  const r2 = run([{ id: "a" }, { isMask: true, visible: true, id: "m" }, { id: "b" }]);
  t("content below the mask paints plain", r2.length === 2 && r2[0].mask === null && r2[0].kids.length === 1 && r2[1].mask.id === "m");
  const r3 = run([{ isMask: true, visible: true, id: "m1" }, { id: "a" }, { isMask: true, visible: true, id: "m2" }, { id: "b" }]);
  t("a second mask ends the run", r3.length === 2 && r3[0].kids.length === 1 && r3[1].mask.id === "m2" && r3[1].kids.length === 1);
  const r4 = run([{ isMask: true, visible: false, id: "m" }, { id: "a" }]);
  t("a hidden mask is an ordinary child", r4.length === 1 && r4[0].mask === null && r4[0].kids.length === 2);
  const r5 = run([{ id: "a" }, { isMask: true, visible: true, id: "m" }]);
  t("a mask above content opens an empty run", r5.length === 2 && r5[1].mask.id === "m" && r5[1].kids.length === 0);
  t("alpha keeps painted alpha", reduceMaskAlpha("alpha", 10, 20, 30, 40) === 40);
  t("vector keeps any painted pixel fully", reduceMaskAlpha("vector", 10, 20, 30, 1) === 255 && reduceMaskAlpha("vector", 10, 20, 30, 0) === 0);
  t("luminance derives alpha from brightness", reduceMaskAlpha("luminance", 255, 255, 255, 0) === 255 && reduceMaskAlpha("luminance", 0, 0, 0, 255) === 0);
}

console.log("I-G svg export images:");
{
  const snode = (over = {}) => ({
    id: "n1", visible: true, x: 0, y: 0, w: 100, h: 50, rotation: 0, opacity: 1,
    fill: "#ff0000", fillVisible: true, fillType: "image", fillOpacity: 1,
    strokeVisible: false, strokeWidth: 0, strokePaint: "", strokeOpacity: 1,
    kind: "rect", imageSrc: "img1", imageFit: "fill", overflow: "hidden",
    cornerRadii: [0, 0, 0, 0],
    children: [], path: [], closed: false, effects: [], ...over,
  });
  t("fill exports as cover", svgNode(snode({ imageFit: "fill" })).includes('preserveAspectRatio="xMidYMid slice"'));
  t("fit exports as meet", svgNode(snode({ imageFit: "fit" })).includes('preserveAspectRatio="xMidYMid meet"'));
  t("crop falls back to centred cover", svgNode(snode({ imageFit: "crop" })).includes('preserveAspectRatio="xMidYMid slice"'));
  t("tile falls back to stretch", svgNode(snode({ imageFit: "tile" })).includes('preserveAspectRatio="none"'));
  t("a solid fill with a stale source exports the shape, not the image", !svgNode(snode({ fillType: "solid" })).includes("<image"));
  const shaped = svgNode(snode({ path: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] }));
  t("shaped layers clip the bitmap to their outline", shaped.includes("clipPath") && shaped.includes("<image"));
  t("frames fill the box unclipped", !svgNode(snode({ kind: "frame", overflow: "visible", path: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })).includes("imgclip"));
}
