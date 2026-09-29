/**
 * Effects rendering regression (§6 "Apply effects to layers"), measured in real
 * pixels.
 *
 * Why this file does not use `softCanvas2d.mjs`: that backend records
 * `ctx.filter` and never executes it, and it has no shadow model at all, so it
 * cannot see what a blur or a shadow *does*. It also used to apply the CTM when
 * a path was painted instead of when its points were added - the opposite of the
 * HTML spec - which hid a real defect in the painter: the drop shadow traced the
 * layer and then translated by the shadow's offset, so every offset "worked"
 * here and did nothing in a browser. The last block in this file pins that
 * primitive on both backends.
 *
 * So these assertions run the app's own paint path (`ui/Canvas.tsx` ->
 * `engine/paint.ts`) on Skia (`@napi-rs/canvas`, a devDependency) and read the
 * composited pixels: `mountRealCanvas` in ./realCanvas2d.mjs.
 *
 * What is covered, and the Figma sentence each one answers to
 * (https://help.figma.com/hc/en-us/articles/360041488473-Apply-effects-to-layers):
 *
 *  A. A drop shadow is the layer's *rendered* alpha, per pixel, with the
 *     effect's offset - "By default, Figma doesn't display drop shadows through
 *     transparent areas of the layer"; the shadow's X/Y "offset the drop shadow
 *     along the x axis"/"y axis".
 *  B. A layer blur is applied once to the layer's composite and "extend[s] past
 *     a selection's boundary", while a parent frame's Clip content still holds.
 *  C. Effects render "in their specified order": a noise row listed after the
 *     layer blur stays crisp on top of it, and one listed before is blurred.
 *
 * Run with:  npx vite-node src/ui/__tests__/effects.test.mjs
 */
import { mountRealCanvas, makeImage, createCanvas } from "./realCanvas2d.mjs";
import { node, defaultEffect } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` - ${detail}`}`);
  ok ? pass++ : fail++;
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
  if (fail) process.exitCode = 1;
});

const shadow = (patch = {}) => ({
  ...defaultEffect("drop-shadow"),
  color: "#000000",
  x: 0,
  y: 0,
  blur: 0,
  spread: 0,
  visible: true,
  showBehind: false,
  ...patch,
});
const blur = (n) => ({ ...defaultEffect("layer-blur"), blur: n, visible: true });
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

/* =================================================================== *
 * A · a drop shadow is the layer's rendered alpha
 * =================================================================== */
console.log("A · per-pixel drop shadow:");

/* ---- A1 · image fill whose alpha is a disc ------------------------------- */
{
  const url = await makeImage("fx-disc", 100, 100, (x) => {
    x.fillStyle = "#ff0000";
    x.beginPath();
    x.arc(50, 50, 50, 0, Math.PI * 2);
    x.fill();
  });
  const ui = await mountRealCanvas([
    node("rect", "Disc", 100, 100, 100, 100, {
      fillType: "image",
      imageSrc: url,
      imageFit: "fill",
      fill: "#00000000",
      effects: [shadow({ x: 20, y: 0 })],
    }),
  ]);
  const P = ui.grab();
  const inDisc = (px, py, cx, cy) => (px - cx) ** 2 + (py - cy) ** 2 <= 50 * 50;
  const edge = (px, py) =>
    Math.abs(Math.hypot(px - 150, py - 150) - 50) < 1.5 || Math.abs(Math.hypot(px - 170, py - 150) - 50) < 1.5;
  let wrong = 0, missing = 0, agree = 0;
  for (let y = 90; y < 210; y++) {
    for (let x = 90; x < 230; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (edge(px, py)) continue;
      const want = inDisc(px, py, 150, 150) ? "layer" : inDisc(px, py, 170, 150) ? "shadow" : "empty";
      const p = P(x, y);
      const got = p.r > 180 && p.g < 80 ? "layer" : p.r < 60 ? "shadow" : p.r > 245 ? "empty" : "soft";
      if (want === "empty" && got !== "empty" && got !== "layer") wrong++;
      else if (want === "shadow" && got !== "shadow" && got !== "soft") missing++;
      else agree++;
    }
  }
  t(
    "A1 image alpha: the shadow is the disc, not the layer's box",
    wrong === 0 && missing === 0 && agree > 14000,
    `${wrong} px shadowed where the image is transparent, ${missing} shadow px missing, ${agree} agree`,
  );
  const corner = P(105, 105); // the image's transparent corner, inside its box
  t("A1 image alpha: the image's box corner stays background", corner.r > 245 && corner.g > 245, JSON.stringify(corner));
  t("A1 image alpha: the offset crescent right of the disc is inked", P(205, 150).r < 60, JSON.stringify(P(205, 150)));
  await ui.close();
}

/* ---- A2 · a shape with a transparent centre (an image donut) ------------- */
{
  const url = await makeImage("fx-donut", 100, 100, (x) => {
    x.fillStyle = "#ff0000";
    x.beginPath();
    x.arc(50, 50, 50, 0, Math.PI * 2);
    x.arc(50, 50, 25, 0, Math.PI * 2, true);
    x.fill("evenodd");
  });
  const ui = await mountRealCanvas([
    node("rect", "Donut", 100, 100, 100, 100, {
      fillType: "image",
      imageSrc: url,
      imageFit: "fill",
      fill: "#00000000",
      effects: [shadow({ x: 20, y: 0 })],
    }),
  ]);
  const P = ui.grab();
  // The hole spans x=125…175 at y=150. The offset copy of the ring reaches only
  // its left part, so the hole shows a shadow crescent and a clean right side -
  // a box-shaped shadow would ink the whole hole.
  t("A2 transparent centre: the hole shows the offset silhouette, not a filled box", P(135, 150).r < 60, JSON.stringify(P(135, 150)));
  t("A2 transparent centre: the far side of the hole stays clean", P(168, 150).r > 245, JSON.stringify(P(168, 150)));
  await ui.close();
}

/* ---- A3 · the offset itself, on an opaque layer -------------------------- */
{
  const rect = (fx) => node("rect", "Offset", 100, 100, 100, 100, { fill: "#ff0000", effects: [fx] });
  const ui = await mountRealCanvas([rect(shadow({ x: 40, y: 0 }))]);
  const P = ui.grab();
  const black = (x, y) => P(x, y).r < 60 && P(x, y).g < 60;
  t(
    "A3 offset: a 40px x-offset lays the shadow at x=200…239 and nowhere else",
    black(200, 150) && black(239, 150) && !black(199, 150) && !black(240, 150) && P(150, 150).r > 180,
    `(199,150) ${P(199, 150).r} (200,150) ${P(200, 150).r} (239,150) ${P(239, 150).r} (240,150) ${P(240, 150).r}`,
  );
  t("A3 offset: nothing bleeds to the left of the layer", ![85, 90, 95, 99].some((x) => black(x, 150)), "left bleed");
  await ui.close();

  const diag = await mountRealCanvas([rect(shadow({ x: 20, y: 10 }))]);
  const D = diag.grab();
  const inkBox = (() => {
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    for (let y = 90; y < 240; y++)
      for (let x = 90; x < 260; x++)
        if (D(x, y).r < 60 && D(x, y).g < 60) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    return [x0, x1, y0, y1];
  })();
  t(
    "A3 offset: y is applied too - the layer at (100,100,100,100) casts (20,10) at x=120…219, y=110…209",
    JSON.stringify(inkBox) === JSON.stringify([120, 219, 110, 209]),
    JSON.stringify(inkBox),
  );
  await diag.close();
}

/* ---- A4 · a text layer casts a glyph-shaped shadow ----------------------- */
{
  const ui = await mountRealCanvas([
    node("text", "T", 500, 100, 200, 60, { text: "I", fontSize: 48, fill: "#ff0000", effects: [shadow({ x: 20, y: 20 })] }),
  ]);
  const P = ui.grab();
  const box = (pred) => {
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
    for (let y = 90; y < 240; y++)
      for (let x = 490; x < 760; x++)
        if (pred(P(x, y))) {
          n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    return { n, x0, x1, y0, y1 };
  };
  const glyph = box((p) => p.r > 180 && p.g < 80);
  const drop = box((p) => p.r < 60 && p.g < 60);
  t(
    "A4 text: the shadow follows the glyph stem, not the 200px text box",
    drop.n > 100 && drop.x1 - drop.x0 <= 12 && glyph.n > 100 && drop.x0 - glyph.x0 === 20 && drop.y0 - glyph.y0 === 20,
    `glyph ${JSON.stringify(glyph)} shadow ${JSON.stringify(drop)}`,
  );
  await ui.close();
}

/* =================================================================== *
 * B · a layer blur is applied once to the composite
 * =================================================================== */
console.log("B · composite layer blur:");

/* ---- B1 · clipped frame inside a clipped parent ------------------------- */
{
  const inner = node("frame", "Inner", 10, 100, 100, 100, {
    fill: "#000000",
    children: [node("rect", "Fill", 0, 0, 200, 200, { fill: "#000000" })],
    effects: [blur(12)],
  });
  const outer = node("frame", "Outer", 100, 600, 400, 300, { fill: "#ffffff", children: [inner] });
  const ui = await mountRealCanvas([outer]);
  const P = ui.grab();
  // Inner frame: x=110…210, y=700…800. Outer frame: x=100…500.
  t(
    "B1 clipped frame's own blur: reaches past its internal child's boundary",
    P.coverage(105, 750) > 0.02 && P.coverage(115, 750) > 0.05,
    `x=105 ${P.coverage(105, 750).toFixed(3)} x=115 ${P.coverage(115, 750).toFixed(3)}`,
  );
  t(
    "B1 the parent frame's Clip content still holds the blur",
    P.coverage(95, 750) === 0 && P.coverage(99, 750) === 0,
    `x=95 ${P.coverage(95, 750)} x=99 ${P.coverage(99, 750)}`,
  );
  await ui.close();
}

/* ---- B2 · a small child under a blurred clipped frame ------------------- */
{
  const frame = node("frame", "Blurred frame", 200, 600, 200, 200, {
    fill: "#00000000",
    fillVisible: false,
    children: [node("rect", "Small", 10, 10, 60, 60, { fill: "#000000" })],
    effects: [blur(10)],
  });
  const ui = await mountRealCanvas([frame]);
  const P = ui.grab();
  // Child: x=210…270, y=610…670. Frame: x=200…400. The child's own boundary is
  // at x=210; the blur has to reach the frame's edge at x=200 and cross it.
  t(
    "B2 the blur crosses the child's own boundary inside the frame",
    near(P.coverage(205, 640), 0.3, 0.15) && P.coverage(215, 640) > 0.6 && P.coverage(230, 640) > 0.98,
    `x=205 ${P.coverage(205, 640).toFixed(3)} x=215 ${P.coverage(215, 640).toFixed(3)} x=230 ${P.coverage(230, 640).toFixed(3)}`,
  );
  t(
    "B2 the blur extends past the frame's box (\"layer blurs … extend past a selection's boundary\")",
    P.coverage(196, 640) > 0.02 && P.coverage(150, 640) === 0,
    `x=196 ${P.coverage(196, 640).toFixed(3)} x=150 ${P.coverage(150, 640).toFixed(3)}`,
  );
  t("B2 the child's own core stays solid", near(P.coverage(240, 640), 1, 0.01), P.coverage(240, 640).toFixed(3));
  await ui.close();
}

/* ---- B3 · two abutting opaque children: no seam through the composite ---- */
{
  const frame = node("frame", "Seam", 100, 100, 200, 200, {
    fill: "#00000000",
    fillVisible: false,
    children: [
      node("rect", "Left half", 0, 0, 100, 200, { fill: "#000000" }),
      node("rect", "Right half", 100, 0, 100, 200, { fill: "#000000" }),
    ],
    effects: [blur(10)],
  });
  const ui = await mountRealCanvas([frame]);
  const P = ui.grab();
  const seam = Math.min(...P.row(200, 192, 208));
  t(
    "B3 two abutting opaque children show no background at their seam",
    seam > 0.97,
    `worst ${seam.toFixed(3)} across x=192…208 (per-op blur left 0.749)`,
  );
  await ui.close();
}

/* ---- B4 · one layer with a fill and an inside stroke -------------------- */
{
  const ui = await mountRealCanvas([
    node("rect", "Fill + stroke", 500, 600, 200, 200, {
      fill: "#000000",
      strokeVisible: true,
      strokePaint: "#000000",
      strokeWidth: 20,
      strokeAlign: "inside",
      effects: [blur(10)],
    }),
  ]);
  const P = ui.grab();
  const interior = Math.min(...P.row(700, 530, 680));
  t(
    "B4 a fill and an inside stroke are one composite before the blur",
    interior > 0.97,
    `worst ${interior.toFixed(3)} over the interior x=530…680`,
  );
  // The same composite, blurred once, from the same primitives: painting the
  // fill and the stroke each through their own filter (what the painter used to
  // do) leaves this edge at 0.48 where a single blur over the composite gives
  // 0.71 - a halo around every stroked layer.
  // The reference canvas is transparent, so its coverage is the alpha channel
  // (the RGB there is premultiplied and would read as full ink at the edge).
  const ref2 = createCanvas(1000, 100);
  const r2 = ref2.getContext("2d");
  r2.filter = "blur(10px)";
  r2.fillStyle = "#000000";
  r2.fillRect(500, 0, 200, 100);
  let worst = 0;
  for (let x = 495; x <= 525; x++) worst = Math.max(worst, Math.abs(r2.getImageData(x, 50, 1, 1).data[3] / 255 - P.coverage(x, 700)));
  t(
    "B4 the layer's own edge matches one blur over the composite",
    worst < 0.03,
    `worst |ours - a single blurred 200px edge| = ${worst.toFixed(3)} over x=495…525; ` +
      `ours [${P.row(700, 495, 520).map((v) => v.toFixed(2)).join(", ")}]`,
  );
  await ui.close();
}

/* =================================================================== *
 * C · effects render in their specified order
 * =================================================================== */
console.log("C · effect order:");

{
  const noise = { ...defaultEffect("noise"), visible: true, blur: 30, spread: 2, color: "#000000" };
  const scene = (effects) => node("rect", "Order", 700, 600, 100, 100, { fill: "#ffffff", effects });
  const specks = (P) => {
    let n = 0, dark = 255;
    for (let y = 601; y < 699; y++)
      for (let x = 701; x < 799; x++) {
        const r = P(x, y).r;
        if (r < 245) n++;
        dark = Math.min(dark, r);
      }
    return { n, dark };
  };
  const control = await mountRealCanvas([scene([noise])]);
  const controlSpecks = specks(control.grab());
  await control.close();

  const crisp = await mountRealCanvas([scene([blur(6), noise])]);
  const crispSpecks = specks(crisp.grab());
  await crisp.close();

  const blurred = await mountRealCanvas([scene([noise, blur(6)])]);
  const blurredSpecks = specks(blurred.grab());
  await blurred.close();

  t(
    "C control: noise alone renders its specks",
    controlSpecks.n > 300 && controlSpecks.dark < 220,
    `${controlSpecks.n} specks, darkest ${controlSpecks.dark}`,
  );
  t(
    "C [layer blur, noise]: the noise is listed after the blur and stays crisp on top",
    crispSpecks.n > 300 && crispSpecks.dark < 220,
    `${crispSpecks.n} specks (control ${controlSpecks.n}), darkest ${crispSpecks.dark}`,
  );
  t(
    "C [noise, layer blur]: the noise is listed before the blur and is blurred with it",
    blurredSpecks.n === 0 && blurredSpecks.dark > 235,
    `${blurredSpecks.n} specks, darkest ${blurredSpecks.dark}`,
  );
  t(
    "C the two orders are materially different renders",
    Math.abs(crispSpecks.n - blurredSpecks.n) > 300,
    `${crispSpecks.n} vs ${blurredSpecks.n}`,
  );
}

/* ---- C2 · the layer blur is the top step, over the drop shadow ---------- */
{
  const scene = (effects) =>
    node("rect", "Stack", 300, 600, 100, 100, { fill: "#000000", strokeVisible: false, strokeWidth: 0, effects });
  const ui = await mountRealCanvas([scene([shadow({ x: 0, y: 0, blur: 6 }), blur(10)])]);
  const P = ui.grab();
  await ui.close();

  // Figma's order, built from the same primitives: the layer's paints (the
  // shadow's blur, then the fill) composite first, then ONE blur over the lot.
  const own = createCanvas(1000, 800);
  const ox = own.getContext("2d");
  ox.filter = "blur(6px)";
  ox.fillStyle = "#000000";
  ox.fillRect(300, 600, 100, 100);
  ox.filter = "none";
  ox.fillStyle = "#000000";
  ox.fillRect(300, 600, 100, 100);
  const ordered = createCanvas(1000, 800);
  const fx = ordered.getContext("2d");
  fx.filter = "blur(10px)";
  fx.drawImage(own, 0, 0);
  let worst = 0;
  const row = [];
  for (let x = 395; x < 435; x++) {
    const want = fx.getImageData(x, 650, 1, 1).data[3] / 255;
    worst = Math.max(worst, Math.abs(want - P.coverage(x, 650)));
    row.push(want.toFixed(2));
  }
  t(
    "C2 drop shadow + layer blur matches the documented order (composite, then one blur)",
    worst < 0.02,
    `worst |ours - ordered composite| = ${worst.toFixed(3)} over the shadow's edge row ` +
      `(ours [${P.row(650, 395, 415).map((v) => v.toFixed(2)).join(", ")}] vs [${row.slice(0, 20).join(", ")}])`,
  );
}

/* ---- C3 · the layer blur reaches the drop shadow at all ---------------- */
{
  const scene = (effects) => node("rect", "Reach", 300, 100, 100, 100, { fill: "#000000", effects });
  const only = await mountRealCanvas([scene([shadow({ x: 0, y: 0, blur: 6 })])]);
  const both = await mountRealCanvas([scene([shadow({ x: 0, y: 0, blur: 6 }), blur(10)])]);
  const A = only.grab(), B = both.grab();
  let worst = 0;
  for (let y = 74; y < 226; y++) for (let x = 274; x < 426; x++) worst = Math.max(worst, Math.abs(A.coverage(x, y) - B.coverage(x, y)));
  t(
    "C3 adding a layer blur changes the shadow's own edge (it is not overridden)",
    worst > 0.2,
    `worst change ${worst.toFixed(3)} (a shadow with its own blur used to replace the layer blur)`,
  );
  await only.close();
  await both.close();
}

/* =================================================================== *
 * D · background blur samples the backdrop beyond the selection
 * =================================================================== */
console.log("D · background blur:");
{
  const ui = await mountRealCanvas([
    node("rect", "Light", 100, 100, 110, 400, { fill: "#ffffff" }),
    node("rect", "Dark", 210, 100, 290, 400, { fill: "#000000" }),
    node("frame", "Glass", 200, 200, 200, 200, {
      fill: "#ffffff20",
      effects: [{ ...defaultEffect("background-blur"), blur: 12, visible: true }],
    }),
  ]);
  const P = ui.grab();
  const full = createCanvas(1000, 800);
  const fx = full.getContext("2d");
  fx.fillStyle = "#ffffff";
  fx.fillRect(100, 100, 110, 400);
  fx.fillStyle = "#000000";
  fx.fillRect(210, 100, 290, 400);
  const bl = createCanvas(1000, 800);
  const bx = bl.getContext("2d");
  bx.filter = "blur(12px)";
  bx.drawImage(full, 0, 0);
  bx.filter = "none";
  bx.fillStyle = "rgba(255,255,255,0.125)";
  bx.fillRect(200, 200, 200, 200);
  let worst = 0;
  for (let x = 202; x < 398; x++)
    for (let y = 240; y < 260; y++) {
      const want = (255 - bx.getImageData(x, y, 1, 1).data[0]) / 255;
      worst = Math.max(worst, Math.abs(want - P.coverage(x, y)));
    }
  t(
    "D background blur pulls in the backdrop just outside the selection's box",
    worst < 0.05,
    `worst |ours - the true backdrop blur| = ${worst.toFixed(3)} (the selection's own box only used to give 0.161 at its edge)`,
  );
  await ui.close();
}

/* =================================================================== *
 * H · the instrument: path points take the CTM when they are added
 * =================================================================== */
console.log("H · harness invariants:");
{
  const c = createCanvas(120, 40);
  const x = c.getContext("2d");
  x.fillStyle = "#ffffff";
  x.fillRect(0, 0, 120, 40);
  x.beginPath();
  x.rect(10, 10, 20, 20);
  x.translate(60, 0);
  x.fillStyle = "#000000";
  x.fill();
  const at = (px) => x.getImageData(px, 20, 1, 1).data[0];
  t(
    "H1 real backend: trace, then translate, then fill - the path does not move",
    at(15) < 40 && at(65) > 200,
    `x=15 ${at(15)} x=65 ${at(65)} (a backend that transforms at paint time would ink x=65)`,
  );
}
{
  // The baseline's own software canvas has to agree, or every headless pixel
  // assertion built on it is a coin flip. Importing it swaps the canvas
  // prototype's getContext, so this runs last.
  await import("./softCanvas2d.mjs");
  const el = document.createElement("canvas");
  el.width = 120;
  el.height = 40;
  const x = el.getContext("2d");
  x.fillStyle = "#ffffff";
  x.fillRect(0, 0, 120, 40);
  x.beginPath();
  x.rect(10, 10, 20, 20);
  x.translate(60, 0);
  x.fillStyle = "#000000";
  x.fill();
  const at = (px) => {
    const d = x.getImageData(0, 0, 120, 40).data;
    return d[(20 * 120 + px) * 4];
  };
  t(
    "H2 software canvas (softCanvas2d.mjs): same primitive, same answer",
    at(15) < 40 && at(65) > 200,
    `x=15 ${at(15)} x=65 ${at(65)}`,
  );
}
