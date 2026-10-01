/** Pixel-level image adjustment regression tests on the Skia-backed app canvas.
 * Run: npx vite-node src/ui/__tests__/imageAdjustments.test.mjs
 */
import { mountRealCanvas, makeImage } from "./realCanvas2d.mjs";
import { node } from "../../engine/memory.ts";
import { processImage, rotatedImageSize } from "../../engine/paint.ts";

let pass = 0;
let fail = 0;
const t = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` - ${detail}`}`);
  ok ? pass++ : fail++;
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});

// Solid neutral source removes hue/content as confounders: the direction of
// each result should come only from Tint. Sample in the center, away from edges.
const graySrc = await makeImage("tint-neutral-gray", 20, 20, (ctx) => {
  ctx.fillStyle = "rgb(128, 128, 128)";
  ctx.fillRect(0, 0, 20, 20);
});

async function renderTint(tint) {
  const layer = node("rect", `Tint ${tint}`, 100, 100, 100, 100, {
    fill: "#00000000",
    fillVisible: true,
    fillType: "image",
    imageSrc: graySrc,
    imageFit: "fill",
    imageTint: tint,
  });
  const ui = await mountRealCanvas([layer]);
  const pixel = ui.px(150, 150);
  await ui.close();
  return pixel;
}

const positive = await renderTint(100);
t("Tint +100 shifts neutral gray toward magenta (R and B exceed G)",
  positive.r > positive.g && positive.b > positive.g,
  JSON.stringify(positive));

const negative = await renderTint(-100);
t("Tint -100 shifts neutral gray toward green (G exceeds R and B)",
  negative.g > negative.r && negative.g > negative.b,
  JSON.stringify(negative));

const rotatedSize = rotatedImageSize(80, 40, 45);
t("45° image rotation allocates the complete diagonal bounds", rotatedSize.w === 85 && rotatedSize.h === 85, JSON.stringify(rotatedSize));
const rotatedSrc = await makeImage("rotate-rectangular-probe", 80, 40, (ctx) => {
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 80, 40);
});
const rotatedUi = await mountRealCanvas([
  node("rect", "Free-rotated image", 100, 100, 100, 100, {
    fill: "#00000000", fillType: "image", imageSrc: rotatedSrc,
    imageFit: "fit", imageRot: 45,
  }),
]);
const rotatedCorner = rotatedUi.px(134, 102);
t("45° rotated fill keeps a source corner visible outside the old unrotated bounds",
  rotatedCorner.r > 220 && rotatedCorner.g < 100 && rotatedCorner.b < 100,
  JSON.stringify(rotatedCorner));
const probeImage = new Image();
probeImage.src = rotatedSrc;
const raster321 = processImage(probeImage, { imageSrc: rotatedSrc, imageRot: 32.1 });
const raster329 = processImage(probeImage, { imageSrc: rotatedSrc, imageRot: 32.9 });
t("free-rotation cache keys retain fractional degrees during pointer drags", raster321 !== raster329);
await rotatedUi.close();
