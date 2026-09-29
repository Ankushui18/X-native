/**
 * Effects-engine audit probe (steps 3–4 of the effects pipeline).
 *
 * Measures the three questions against *real* pixels: the app's own paint path
 * (`ui/Canvas.tsx` → `engine/paint.ts`) runs on a Skia backend (./realCanvas.mjs,
 * the engine family Chromium uses), so `ctx.filter` blur, `shadowBlur`, clip
 * after filter and — critically — **when the CTM is baked into a path** behave
 * the way a browser's do.
 *
 *   1. Drop shadow: the layer's alpha mask, or its bounding box?
 *   2. Layer blur: does it spill the way Figma's does, and does a parent's
 *      "Clip content" contain it?
 *   3. Effect stacking: layer blur + drop shadow — which is applied to which?
 *
 * The expected column is Figma's documented behaviour, quoted in
 * ../../../FIGMA_CREATE_DESIGNS_COMPARISON.md — in short: a drop shadow is cast
 * from the layer's rendered alpha and is not shown through its transparent
 * areas; the render order bottom-up is background blur → drop shadow → fills →
 * inner shadow → strokes → layer blur/noise/texture, and "layer blurs …
 * extend past a selection's boundary".
 *
 * Run:  npx vite-node tests/probes/effects/probe.mjs
 */
import { mountRealCanvas, makeImage, createCanvas } from "../../../src/ui/__tests__/realCanvas2d.mjs";
import { node, defaultEffect } from "../../../src/engine/memory.ts";

const RED = "#ff0000";
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

let failures = 0;
const out = (s = "") => console.log(s);
/** Print a measurement and whether it matches Figma. */
const measure = (label, actual, expected, ok, detail = "") => {
  if (!ok) failures++;
  out(
    `${ok ? " ok " : "DIFF"} ${label}\n       ours: ${actual}\n       figma: ${expected}${detail ? `\n       ${detail}` : ""}`,
  );
};

/** Classify one composited pixel of the red-layer / black-shadow scenes. */
const classify = (p) => {
  if (p.r > 180 && p.g < 80 && p.b < 80) return "layer";
  if (p.r < 60 && p.g < 60 && p.b < 60) return "shadow";
  if (p.r > 245 && p.g > 245 && p.b > 245) return "empty";
  return "soft";
};
/** Where the black ink is, over a box, as `x0..x1 y0..y1`. */
const inkBox = (P, box, pred = (p) => p.r < 60 && p.g < 60 && p.b < 60) => {
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++)
      if (pred(P(x, y))) {
        n++;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  return n ? `${n}px x${x0}..${x1} y${y0}..${y1}` : "none";
};

/* =================================================================== *
 * 0 · the primitive every path-based shadow depends on
 * =================================================================== */
{
  // WHATWG 2D context: "the points passed to the methods … must be
  // transformed according to the current transformation matrix before being
  // added to the path" — so translating *after* tracing does not move a path.
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
  out(
    `\n=== 0 · backend primitive ===\n     trace rect(10,10,20,20); translate(60,0); fill() → ` +
      `ink at x=15 ${at(15) === 0 ? "BLACK" : "white"}, at x=65 ${at(65) === 0 ? "BLACK" : "white"} ` +
      `(spec: the CTM is baked in when the point is added to the path, so x=15 inks)`,
  );
}

/* =================================================================== *
 * 1 · Drop shadow — alpha mask, silhouette source, offset
 * =================================================================== */

/* ---- 1a · an image layer whose alpha is a disc --------------------------- */
{
  const url = await makeImage("probe-disc", 100, 100, (x) => {
    x.fillStyle = RED;
    x.beginPath();
    x.arc(50, 50, 50, 0, Math.PI * 2);
    x.fill();
  });
  const n = node("rect", "Alpha disc", 100, 100, 100, 100, {
    fillType: "image",
    imageSrc: url,
    imageFit: "fill",
    fill: "#00000000",
    effects: [shadow({ x: 20, y: 0 })],
  });
  const ui = await mountRealCanvas([n]);
  const P = ui.grab();
  const inDisc = (px, py, cx, cy) => (px - cx) ** 2 + (py - cy) ** 2 <= 50 * 50;
  // Every edge in this scene is a curve, so a pixel within the antialiasing
  // band of a disc boundary proves nothing either way.
  const onEdge = (px, py) =>
    Math.abs(Math.hypot(px - 150, py - 150) - 50) < 1.5 || Math.abs(Math.hypot(px - 170, py - 150) - 50) < 1.5;
  let wrong = 0, missing = 0, right = 0;
  for (let y = 90; y < 210; y++) {
    for (let x = 90; x < 230; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (onEdge(px, py)) continue;
      const want = inDisc(px, py, 150, 150) ? "layer" : inDisc(px, py, 170, 150) ? "shadow" : "empty";
      const got = classify(P(x, y));
      if (want === "empty" && (got === "shadow" || got === "soft")) wrong++;
      else if (want === "shadow" && got === "empty") missing++;
      else right++;
    }
  }
  measure(
    "1a · image fill whose alpha is a disc + drop shadow (20,0), blur 0",
    `corner (105,105) = ${classify(P(105, 105))}; ${wrong} px shadowed that Figma leaves empty, ` +
      `${missing} Figma shadow px missing (${right} agree, antialiased edge band excluded)`,
    "the shadow is the layer's alpha (the disc) offset (20,0): nothing in the image's " +
      "transparent corners, a crescent to the right of the disc",
    wrong === 0 && missing === 0,
    `shadow ink over the layer region: ${inkBox(P, { x: 90, y: 90, w: 140, h: 120 })}`,
  );
  await ui.close();
}

/* ---- 1b · a group of two disjoint rectangles ----------------------------- */
{
  const rects = [
    node("rect", "A", 0, 0, 40, 40, { fill: RED }),
    node("rect", "B", 60, 60, 40, 40, { fill: RED }),
  ];
  const g = node("group", "Group", 300, 300, 100, 100, {
    fill: "#00000000",
    fillVisible: false,
    children: rects,
    effects: [shadow({ x: 10, y: 10 })],
  });
  const ui = await mountRealCanvas([g]);
  const P = ui.grab();
  const inUnion = (px, py) =>
    (px >= 300 && px < 340 && py >= 300 && py < 340) || (px >= 360 && px < 400 && py >= 360 && py < 400);
  let want = 0;
  for (let y = 290; y < 420; y++)
    for (let x = 290; x < 420; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (!inUnion(px, py) && inUnion(px - 10, py - 10)) want++;
    }
  measure(
    "1b · group of two disjoint opaque rects + drop shadow (10,10)",
    `(345,320) = ${classify(P(345, 320))}; shadow pixels in the region: ${inkBox(P, { x: 290, y: 290, w: 130, h: 130 })}`,
    `the union silhouette of the children, offset (10,10) — ${want} shadow px at least`,
    classify(P(345, 320)) === "shadow",
  );
  await ui.close();
}

/* ---- 1c · the offset itself: opaque vs translucent fill ------------------ */
{
  const scene = (patch) =>
    node("rect", "Offset", 100, 100, 100, 100, { fill: "#ff0000", ...patch, effects: [shadow({ x: 40, y: 0, blur: 0 })] });
  const zeroed = await mountRealCanvas([scene({ fill: "#ff0000" })]);
  const moved = await mountRealCanvas([scene({ fill: "#ff0000" })]);
  await moved.dispatch({ type: "patch", id: moved.engine.snapshot().pages[0].root.children[0].id, patch: {} });
  // rebuild the same node with x=0 for comparison
  const at0 = await mountRealCanvas([
    node("rect", "Offset0", 100, 100, 100, 100, { fill: "#ff0000", effects: [shadow({ x: 0, y: 0, blur: 0 })] }),
  ]);
  const A = at0.grab(), B = zeroed.grab();
  let worst = 0;
  for (let y = 90; y < 210; y++)
    for (let x = 90; x < 260; x++) worst = Math.max(worst, Math.abs(A.coverage(x, y) - B.coverage(x, y)));
  measure(
    "1c · drop shadow x offset 40 on an opaque rect (blur 0)",
    `max |x=40 − x=0| over the region = ${worst.toFixed(3)}; ink: ${inkBox(B, { x: 90, y: 90, w: 180, h: 120 })}`,
    "a 20px black band at x=200..239 (the shadow is the layer's silhouette moved 40px right)",
    worst > 0.5,
  );
  // A blurred shadow whose direction is ignored bleeds symmetrically instead.
  const dir = await mountRealCanvas([
    node("rect", "Dir", 300, 600, 100, 100, { fill: "#000000", effects: [shadow({ x: 24, y: 0, blur: 6 })] }),
  ]);
  const D = dir.grab();
  measure(
    "1c″ · a blurred shadow (x=24, y=0, blur 6) has no direction",
    `bleed left x=293…297 [${D.row(650, 293, 297).map((v) => v.toFixed(2)).join(", ")}]; ` +
      `right x=403…407 [${D.row(650, 403, 407).map((v) => v.toFixed(2)).join(", ")}]`,
    "the shadow sits 24px right: x=403…407 is deep inside it (≈1.00) and the left bleed is " +
      "the layer's own soft edge only",
    D.coverage(405, 650) > 0.9,
  );
  await dir.close();
  await at0.close();

  // The translucent-fill path masks the shadow with an inverse clip, and that
  // path re-traces *after* the translate — so it does move.
  const softScene = (patch) =>
    node("rect", "Soft", 100, 400, 100, 100, { fill: "#00000080", effects: [shadow({ x: 40, y: 0, blur: 0, ...patch })] });
  const soft = await mountRealCanvas([softScene({})]);
  const S = soft.grab();
  const behindUi = await mountRealCanvas([softScene({ showBehind: true })]);
  const Sb = behindUi.grab();
  // A 50% fill casts a 50% shadow (the shadow is the layer's rendered alpha).
  // With "show behind transparent areas" off - the default - the shadow is not
  // displayed through the layer, so the band where the offset copy overlaps the
  // layer reads the layer alone; turning the option on shows it through.
  const overlap = S.coverage(150, 450);
  const crescent = S.coverage(220, 450);
  const shown = Sb.coverage(150, 450);
  measure(
    "1c′ · translucent fill (50%) + shadow x=40 — the masked path",
    `behind-the-layer band (150,450) = ${overlap.toFixed(3)}; shadow-only crescent (220,450) = ${crescent.toFixed(3)}; ` +
      `the same band with "show behind transparent areas" ON = ${shown.toFixed(3)}`,
    "0.500 in the band (the layer, over the shadow it hides), 0.500 in the crescent " +
      "(the layer's alpha, offset), 0.750 in the band once the shadow shows through",
    Math.abs(overlap - 0.5) < 0.02 && Math.abs(crescent - 0.5) < 0.02 && Math.abs(shown - 0.75) < 0.02,
  );
  await soft.close();
  await behindUi.close();
  await zeroed.close();
}

/* ---- 1d · text: the one path that does offset --------------------------- */
{
  const t = node("text", "T", 500, 100, 200, 60, {
    text: "I",
    fontSize: 48,
    fill: RED,
    effects: [shadow({ x: 20, y: 20, blur: 0 })],
  });
  const ui = await mountRealCanvas([t]);
  const P = ui.grab();
  const glyph = inkBox(P, { x: 500, y: 100, w: 200, h: 60 }, (p) => p.r > 180 && p.g < 80 && p.b < 80);
  const drop = inkBox(P, { x: 500, y: 100, w: 260, h: 120 });
  const bx = (s) => (s === "none" ? null : s.match(/x(\d+)\.\.(\d+) y(\d+)\.\.(\d+)/)?.slice(1).map(Number));
  const g = bx(glyph), d = bx(drop);
  const dx = g && d ? d[0] - g[0] : null;
  const dy = g && d ? d[2] - g[2] : null;
  measure(
    "1d · text layer + drop shadow (20,20)",
    `glyph ${glyph}; shadow ${drop} → offset (${dx},${dy})`,
    "a glyph-shaped shadow at the glyphs' position + (20,20) — text goes through " +
      "ctx.shadowOffset, which is applied when the glyphs are painted",
    dx === 20 && dy === 20,
  );
  await ui.close();
}

/* =================================================================== *
 * 2 · Layer blur — spill, and the parent's Clip content
 * =================================================================== */
const profile = (P, y, x0, x1) => P.row(y, x0, x1).map((v) => v.toFixed(2));

/* ---- 2a · a blurred child inside a clipped parent (the asked case) ------- */
{
  const child = node("rect", "Blurred child", 20, 20, 100, 100, { fill: "#000000", effects: [blur(10)] });
  const parent = node("frame", "Clipped parent", 100, 300, 200, 200, { fill: "#ffffff", children: [child] });
  const ui = await mountRealCanvas([parent]);
  const P = ui.grab();
  measure(
    "2a · layer-blurred child inside a parent with Clip content",
    `5px outside the child, inside the parent = ${P.coverage(115, 370).toFixed(3)}; ` +
      `at the child's own edge = ${P.coverage(120, 370).toFixed(3)}; 5px outside the parent = ${P.coverage(95, 370).toFixed(3)}`,
    "> 0 inside the parent (Figma: \"layer blurs … extend past a selection's boundary\"), " +
      "0 outside the parent (Clip content holds)",
    P.coverage(115, 370) > 0.05 && P.coverage(95, 370) === 0,
  );
  await ui.close();
}

/* ---- 2b · the clipped frame's OWN layer blur ---------------------------- */
{
  const child = node("rect", "Filler", 0, 0, 200, 200, { fill: "#000000" });
  const frame = node("frame", "Clipped frame", 500, 300, 200, 200, {
    fill: "#00000000",
    fillVisible: false,
    children: [child],
    effects: [blur(10)],
  });
  const ui = await mountRealCanvas([frame]);
  const P = ui.grab();
  const right = P.row(400, 690, 719);
  out(`\n     profile across the frame's right edge (x=690…719):`);
  out(`       inward  [${profile(P, 400, 690, 699).join(", ")}]`);
  out(`       outward [${right.slice(10).map((v) => v.toFixed(2)).join(", ")}]`);
  measure(
    "2b · frame with Clip content + its own layer blur 10",
    `x=699 ${right[9].toFixed(2)} · x=700 ${right[10].toFixed(2)} · x=704 ${right[14].toFixed(2)} · ` +
      `x=712 ${right[22].toFixed(2)} · far inside (550,400) ${P.coverage(550, 400).toFixed(2)}`,
    "> 0 outside the frame — the layer blur is the top-most step, above the clip, so the " +
      "blurred composite spills past the frame's boundary",
    right[14] > 0.02,
  );
  await ui.close();
}

/* ---- 2c · one blurred layer, two paints: is the blur over the composite? - */
{
  const a = node("rect", "Left half", 0, 0, 100, 200, { fill: "#000000" });
  const b = node("rect", "Right half", 100, 0, 100, 200, { fill: "#000000" });
  const frame = node("frame", "Seam", 100, 600, 200, 200, {
    fill: "#00000000",
    fillVisible: false,
    children: [a, b],
    effects: [blur(10)],
  });
  const ui = await mountRealCanvas([frame]);
  const P = ui.grab();
  const seam = P.row(700, 192, 208);
  measure(
    "2c · two abutting opaque children + layer blur on the frame",
    `coverage across the shared edge x=192…208: [${profile(P, 700, 192, 208).join(", ")}] — worst ${Math.min(...seam).toFixed(3)}`,
    "1.00 across the seam — the union of two opaque halves is solid, and Figma blurs the " +
      "composited layer, so no background shows through",
    Math.min(...seam) > 0.97,
    `the frame's solid interior reads ${Math.min(...P.row(700, 140, 260)).toFixed(3)} at its worst`,
  );
  await ui.close();
}

/* ---- 2d · one layer, fill + inside stroke ------------------------------- */
{
  const r = node("rect", "Fill + stroke", 500, 600, 200, 200, {
    fill: "#000000",
    strokeVisible: true,
    strokePaint: "#000000",
    strokeWidth: 20,
    strokeAlign: "inside",
    effects: [blur(10)],
  });
  const ui = await mountRealCanvas([r]);
  const P = ui.grab();
  measure(
    "2d · one layer with a fill and an inside stroke, layer blur 10",
    `worst coverage across the interior x=530…680 = ${Math.min(...P.row(700, 530, 680)).toFixed(3)} ` +
      `(the layer's own blurred outer edge starts at x=500, the stroke/fill boundary is at x=520)`,
    "1.00 — the fill and the stroke are one composite before the blur",
    Math.min(...P.row(700, 530, 680)) > 0.97,
  );
  await ui.close();
}

/* =================================================================== *
 * 3 · Effect stacking — drop shadow + layer blur
 * =================================================================== */
{
  // Offset 0 so the offset defect above cannot confound the stacking question.
  const scene = (effects) =>
    node("rect", "Stack", 300, 600, 100, 100, { fill: "#000000", effects, strokeVisible: false, strokeWidth: 0 });
  const box = { x: 300, y: 600, w: 100, h: 100 };
  const only = await mountRealCanvas([scene([shadow({ x: 0, y: 0, blur: 6 })])]);
  const both = await mountRealCanvas([scene([shadow({ x: 0, y: 0, blur: 6 }), blur(10)])]);
  const A = only.grab(), B = both.grab();

  // What Figma's render order produces, in the app canvas's own coordinate
  // space: the layer's paints (shadow blur 6, then the fill) composited first,
  // then ONE blur(10) over that composite — built with the same Skia
  // primitives, so the rows compare pixel for pixel.
  const own = createCanvas(1000, 800);
  const ox = own.getContext("2d");
  ox.filter = "blur(6px)";
  ox.fillStyle = "#000000";
  ox.fillRect(box.x, box.y, box.w, box.h);
  ox.filter = "none";
  ox.fillStyle = "#000000";
  ox.fillRect(box.x, box.y, box.w, box.h);
  const ordered = createCanvas(1000, 800);
  const fx = ordered.getContext("2d");
  fx.filter = "blur(10px)";
  fx.drawImage(own, 0, 0);
  const refCov = (x, y) => fx.getImageData(x, y, 1, 1).data[3] / 255;
  let worstRef = 0;
  for (let x = box.x - 40; x < box.x + box.w + 60; x++) worstRef = Math.max(worstRef, Math.abs(refCov(x, 650) - B.coverage(x, 650)));
  let worstOwn = 0;
  for (let y = box.y - 26; y < box.y + box.h + 26; y++)
    for (let x = box.x - 26; x < box.x + box.w + 26; x++) worstOwn = Math.max(worstOwn, Math.abs(A.coverage(x, y) - B.coverage(x, y)));
  measure(
    "3a · layer blur 10 on a node that already carries a drop shadow (blur 6)",
    `worst |with − without the layer blur| = ${worstOwn.toFixed(3)}; ` +
      `worst |ours − Figma order| on the edge row = ${worstRef.toFixed(3)}`,
    "the layer blur is applied once over the composite (shadow + fill), so it softens the " +
      "shadow as well; ours applies it per paint op below the shadow's own blur",
    worstRef < 0.05,
    `ours        [${profile(B, 650, 395, 435).join(", ")}]\n` +
      `     figma order [${Array.from({ length: 41 }, (_, k) => refCov(395 + k, 650).toFixed(2)).join(", ")}]`,
  );
  await only.close();
  await both.close();
}

/* ---- 3b · does the effect list order matter? ---------------------------- */
{
  const noise = { ...defaultEffect("noise"), visible: true, blur: 30, spread: 2, color: "#000000" };
  const mk = (effects) => node("rect", "Order", 700, 600, 100, 100, { fill: "#ffffff", effects });
  const bFirst = await mountRealCanvas([mk([blur(6), noise])]);
  const nFirst = await mountRealCanvas([mk([noise, blur(6)])]);
  const [plainBlur, plainNoise, plainDark] = await (async () => {
    const a = await mountRealCanvas([mk([blur(6)])]);
    const b = await mountRealCanvas([mk([noise])]);
    const A = a.grab(), Bb = b.grab();
    const res = [Math.min(...Array.from({ length: 99 * 99 }, (_, k) => A(701 + (k % 99), 601 + Math.floor(k / 99)).r)),
                 Array.from({ length: 99 * 99 }, (_, k) => Bb(701 + (k % 99), 601 + Math.floor(k / 99)).r).filter((r) => r < 245).length,
                 Math.min(...Array.from({ length: 99 * 99 }, (_, k) => Bb(701 + (k % 99), 601 + Math.floor(k / 99)).r))];
    await a.close(); await b.close();
    return res;
  })();
  const B = bFirst.grab(), N = nFirst.grab();
  out(`     control — noise alone: ${plainNoise} dark specks, darkest ${plainDark}; blur alone: darkest ${plainBlur}`);
  let worst = 0, specksB = 0, specksN = 0;
  for (let y = 601; y < 699; y++)
    for (let x = 701; x < 799; x++) {
      worst = Math.max(worst, Math.abs(B.coverage(x, y) - N.coverage(x, y)));
      if (B(x, y).r < 245) specksB++;
      if (N(x, y).r < 245) specksN++;
    }
  measure(
    "3b · effect list order: [layer blur, noise] vs [noise, layer blur]",
    `max |order A − order B| = ${worst.toFixed(3)}; dark specks @2% density: ${specksB} vs ${specksN}; ` +
      `darkest pixel ${Math.min(...Array.from({ length: 99 * 99 }, (_, k) => B(701 + (k % 99), 601 + Math.floor(k / 99)).r))}`,
    "different renders — \"Layer blur, noise, texture (applied in their specified order)\"; " +
      "with the blur listed first the noise lands on top and stays crisp",
    worst > 0.02 || specksB > 200,
  );
  await bFirst.close();
  await nFirst.close();
}

/* ---- 4 · background blur (bonus) --------------------------------------- */
{
  // Figma: the background blur samples the layers *behind* the selection. The
  // paint code blits the canvas onto itself under a blur filter, but draws only
  // the selection's own box — so the kernel reads transparent outside it.
  // A backdrop with a hard light/dark edge just outside the selection makes the
  // difference visible: the correct blur pulls the light side in.
  const backdropA = node("rect", "Backdrop light", 100, 100, 110, 400, { fill: "#ffffff" });
  const backdropB = node("rect", "Backdrop dark", 210, 100, 290, 400, { fill: "#000000" });
  const glass = node("frame", "Glass", 200, 200, 200, 200, {
    fill: "#ffffff20",
    effects: [{ ...defaultEffect("background-blur"), blur: 12, visible: true }],
  });
  const ui = await mountRealCanvas([backdropA, backdropB, glass]);
  const P = ui.grab();
  // Reference: the same backdrop, blurred over the whole canvas, then the same
  // 12.5% white fill inside the selection — what Figma's sampling produces.
  const full = createCanvas(1000, 800);
  const fx = full.getContext("2d");
  fx.fillStyle = "#ffffff";
  fx.fillRect(100, 100, 110, 400);
  fx.fillStyle = "#000000";
  fx.fillRect(210, 100, 290, 400);
  const blurred = createCanvas(1000, 800);
  const bx = blurred.getContext("2d");
  bx.filter = "blur(12px)";
  bx.drawImage(full, 0, 0);
  bx.filter = "none";
  bx.fillStyle = "rgba(255,255,255,0.125)";
  bx.fillRect(200, 200, 200, 200);
  const refInk = (x, y) => (255 - bx.getImageData(x, y, 1, 1).data[0]) / 255;
  let worst = 0, worstX = 0;
  for (let x = 201; x < 399; x++)
    for (let y = 240; y < 260; y++) {
      const d = Math.abs(P.coverage(x, y) - refInk(x, y));
      if (d > worst) { worst = d; worstX = x; }
    }
  measure(
    "4 · background blur 12 next to a light/dark backdrop edge (x=210)",
    `worst |ours − true backdrop blur| = ${worst.toFixed(3)} (at x=${worstX}); ` +
      `row x=201…230 [${P.row(250, 201, 230).map((v) => v.toFixed(2)).join(", ")}]`,
    `the correct blur at that row [${Array.from({ length: 30 }, (_, k) => refInk(201 + k, 250).toFixed(2)).join(", ")}]`,
    worst < 0.05,
  );
  await ui.close();
}

out(`\n${failures} deviation group(s) measured`);
