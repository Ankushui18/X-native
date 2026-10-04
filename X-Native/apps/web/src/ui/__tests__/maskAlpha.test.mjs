/**
 * Run 5 - Figma parity, masks: per-pixel alpha and the two mask indicators.
 *
 * Source of truth: Figma's *Masks* article,
 * https://help.figma.com/hc/en-us/articles/360040450253-Masks
 *  - "When working with alpha masks, masks are applied based on the opacity of
 *    the mask. The higher the opacity, the more that is revealed. Zero percent
 *    opacity reveals nothing. This means we can utilize blurs and opacity in our
 *    masks: ... Use layer blur effects to replicate feathering ... Add fills,
 *    strokes, and gradients with varying opacity"
 *  - "If a mask contains any area with an opacity of more than zero percent,
 *    then its outlines are used as the mask and the entire mask assumes 100%
 *    opacity." (vector)
 *  - "Luminance ... The brighter the area of a mask, the more that is revealed".
 *  - "Once the setting on, masks in your file are outlined in green. Note: If
 *    all layers being masked are hidden or have zero percent opacity, then the
 *    object's mask outlines won't appear."
 *  - "the mask icon identifies the mask, with an upward-facing arrow along the
 *    layers that are being masked"
 *  - "To stop using an object as a mask ... Right-click the mask and select
 *    Remove mask ... toggle it off"
 *
 * The alpha half runs against the software Canvas2D in ./softCanvas2d.mjs so
 * the feathered edge is *measured in pixel alpha*, not inferred from a call
 * log: the recorded-call tests in this folder can only prove that a composite
 * op was asked for. What this file cannot cover stays flagged in the
 * comparison doc: real GPU filtering, font rasterisation and browser cursor
 * feedback.
 *
 * Run: vite-node src/ui/__tests__/maskAlpha.test.mjs
 */
import { MemoryEngine, node } from "../../engine/memory.ts";
import { partitionMaskRuns, reduceMaskAlpha } from "../../engine/paint.ts";
import { runMenu, layerMenu, canvasMenu } from "../ContextMenu.tsx";
import { contexts, near, mountCanvas, mountPanel } from "./softCanvas2d.mjs";
import { CANVAS_CHROME_FALLBACK } from "../canvasChrome.ts";

let pass = 0,
  fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? ` - ${extra}` : ""}`);
};
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const softMask = (extra = {}) =>
  node("rect", "Gradient mask", 0, 0, 100, 100, {
    isMask: true,
    fillType: "linear",
    fill: "#ffffff",
    fillVisible: true,
    fillGX: 0,
    fillGY: 0.5,
    fillHX: 1,
    fillHY: 0.5,
    gradientStops: [
      { color: "#ffffffff", position: 0 },
      { color: "#00000000", position: 1 },
    ],
    ...extra,
  });
const content = (extra = {}) => node("rect", "Content", 0, 0, 100, 100, { fill: "#3b82f6", ...extra });
const pair = (mask, kid = content(), extra = {}) =>
  node("frame", "Mask object", 0, 0, 100, 100, {
    // An explicit white background keeps the sampled pixels readable: the
    // revealed coverage is (255 - red) / (255 - 59) against white.
    fill: "#ffffff",
    fillVisible: true,
    children: [mask, kid],
    ...extra,
  });

/* ------------------------------------------------------------------ *
 * 1. Alpha masks are per-pixel: a gradient reveals a soft ramp.
 * ------------------------------------------------------------------ */
{
  const mask = softMask();
  const ui = await mountCanvas([pair(mask)]);
  const at = (x) => ui.alphaAt(x, 50).a;
  const ramp = [5, 25, 50, 75, 95].map(at);
  const monotone = ramp.every((v, i) => i === 0 || v <= ramp[i - 1] + 0.02);
  t("alpha mask: gradient mask reveals a monotone ramp", monotone, JSON.stringify(ramp.map((v) => +v.toFixed(3))));
  t("alpha mask: opaque end of the mask is fully revealed", near(ramp[0], 0.95, 0.08), `a(5px)=${ramp[0].toFixed(3)}`);
  t("alpha mask: transparent end reveals (almost) nothing", near(ramp[4], 0.05, 0.08), `a(95px)=${ramp[4].toFixed(3)}`);
  t("alpha mask: the midpoint is half revealed, not clipped", near(ramp[2], 0.5, 0.1), `a(50px)=${ramp[2].toFixed(3)}`);
  const soft = [];
  for (let x = 0; x < 100; x++) {
    const a = at(x);
    if (a > 0.05 && a < 0.95) soft.push(a);
  }
  t(
    "alpha mask: the edge is feathered across many pixels, not binary",
    soft.length >= 40,
    `${soft.length} pixels in the 0.05..0.95 band`,
  );
  // Every second sample has to stay near the analytic ramp (a linear gradient
  // in the mask is linear in the revealed alpha).
  const worst = [10, 20, 30, 40, 60, 70, 80, 90].reduce(
    (m, x) => Math.max(m, Math.abs(at(x) - (1 - x / 100))),
    0,
  );
  t("alpha mask: the ramp follows the mask's own opacity", worst < 0.08, `worst deviation ${worst.toFixed(3)}`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 2. Zero-percent opacity in the mask reveals nothing ("Zero percent
 *    opacity reveals nothing"), and a hidden mask hides its content.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([pair(softMask({ opacity: 0 }))]);
  t("alpha mask: a mask at 0% opacity reveals nothing", ui.alphaAt(50, 50).a === 0, `a=${ui.alphaAt(50, 50).a}`);
  await ui.close();
}
{
  const mask = softMask();
  mask.visible = false;
  const ui = await mountCanvas([pair(mask)]);
  t("hidden mask layer stops masking (no reveal at all)", ui.alphaAt(20, 50).a === 0 || ui.alphaAt(20, 50).a === 1);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 3. Vector masks ignore translucency: any painted pixel is fully opaque,
 *    so the same gradient cut as a vector mask has a hard edge.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([pair(softMask({ maskType: "vector" }))]);
  const vals = [5, 25, 50, 75, 95].map((x) => ui.alphaAt(x, 50).a);
  const binary = vals.every((v) => v < 0.02 || v > 0.98);
  t("vector mask: same gradient cuts hard, not soft", binary, JSON.stringify(vals.map((v) => +v.toFixed(3))));
  t("vector mask: painted area stays fully revealed", vals[0] > 0.98, `a(5px)=${vals[0].toFixed(3)}`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 4. Luminance masks follow brightness, and the reduction itself is the
 *    documented one.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([
    pair(
      softMask({
        maskType: "luminance",
        gradientStops: [
          { color: "#ffffffff", position: 0 },
          { color: "#000000ff", position: 1 },
        ],
      }),
    ),
  ]);
  const vals = [0, 25, 50, 75, 99].map((x) => ui.alphaAt(x, 50).a);
  const monotone = vals.every((v, i) => i === 0 || v <= vals[i - 1] + 0.02);
  t("luminance mask: brightness ramps the reveal", monotone && vals[0] > 0.9 && vals[4] < 0.1, JSON.stringify(vals.map((v) => +v.toFixed(3))));
  t("luminance mask: mid grey is about half", near(vals[2], 0.5, 0.12), `a(50px)=${vals[2].toFixed(3)}`);
  t("reduceMaskAlpha keeps Figma's three types apart", [
    reduceMaskAlpha("alpha", 10, 10, 10, 77) === 77,
    reduceMaskAlpha("vector", 10, 10, 10, 1) === 255,
    reduceMaskAlpha("vector", 10, 10, 10, 0) === 0,
    reduceMaskAlpha("luminance", 255, 255, 255, 255) === 255,
    reduceMaskAlpha("luminance", 0, 0, 0, 255) === 0,
  ].every(Boolean));
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 5. Feathering: a layer blur on the mask reaches the mask tile ("Use layer
 *    blur effects to replicate feathering"), and the mask's own paint is what
 *    feeds the clip - no reduction pass for alpha masks.
 * ------------------------------------------------------------------ */
{
  const mask = softMask();
  mask.effects = [
    { kind: "layer-blur", color: "#000000", x: 0, y: 0, blur: 12, spread: 0, visible: true },
  ];
  const ui = await mountCanvas([pair(mask)]);
  const filters = contexts.flatMap((c) => c.filters).filter((f) => f === "blur(12px)");
  t("blurred mask: the blur is applied while the mask is painted", filters.length >= 1, `${filters.length} blur(12px) assignments`);
  t("blurred mask: content is still revealed through it", ui.alphaAt(5, 50).a > 0.8, `a(5px)=${ui.alphaAt(5, 50).a.toFixed(3)}`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 6. Show mask outlines: in the mask role's ink, on the canvas, and gone when
 *    the article says it is gone.
 *
 * The ink is read from `canvasChrome` rather than typed here. It used to be a
 * hardcoded green (`#00c853`) on both sides, which meant a theme change could
 * silently stop outlining masks while this file stayed green — the run that
 * recoloured the mask role to amber (identity v3) is exactly that: the pixels
 * moved and the pin had to move with them, so the pin now names the role.
 * ------------------------------------------------------------------ */
// Each mount builds its own contexts (the canvas element included), so the
// count is scoped to the contexts created after the mark.
const mark = () => contexts.length;
const MASK_INK = CANVAS_CHROME_FALLBACK.mask.toLowerCase();
const maskStrokes = (from = 0) =>
  contexts
    .slice(from)
    .flatMap((ctx) => ctx.strokes.map((s) => ({ ...s, color: String(s.color) })))
    .filter((s) => s.color.toLowerCase() === MASK_INK);

{
  const from = mark();
  const ui = await mountCanvas([pair(softMask())]);
  const before = maskStrokes(from).length;
  await ui.dispatch({ type: "toggleMaskOutlines" });
  const on = maskStrokes(from);
  t("mask outlines off by default: no outline", before === 0, `${before} strokes`);
  t(`mask outlines on: the mask is outlined in the mask role (${MASK_INK})`, on.length === 1, `${on.length} strokes`);
  t("mask outlines land on the canvas, not inside a masked tile", on.every((s) => s.inDoc), JSON.stringify(on.map((s) => s.inDoc)));
  await ui.close();
}
{
  // "If all layers being masked are hidden or have zero percent opacity, then
  // the object's mask outlines won't appear."
  const hiddenKid = content();
  hiddenKid.visible = false;
  const from = mark();
  const ui = await mountCanvas([pair(softMask(), hiddenKid)]);
  await ui.dispatch({ type: "toggleMaskOutlines" });
  t("all masked layers hidden: no mask outline", maskStrokes(from).length === 0, `${maskStrokes(from).length} strokes`);
  await ui.close();
}
{
  const zeroKid = content({ opacity: 0 });
  const from = mark();
  const ui = await mountCanvas([pair(softMask(), zeroKid)]);
  await ui.dispatch({ type: "toggleMaskOutlines" });
  t("all masked layers at 0% opacity: no mask outline", maskStrokes(from).length === 0, `${maskStrokes(from).length} strokes`);
//reen strokes`);
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 7. The layers panel: the mask glyph, and the upward arrow on the layers
 *    being masked (the ones above the mask).
 * ------------------------------------------------------------------ */
{
  const mask = softMask();
  const panel = await mountPanel([pair(mask, content())]);
  const rows = panel.rows();
  const maskRow = rows.find((r) => r.name === "Gradient mask");
  const kidRow = rows.find((r) => r.name === "Content");
  t("panel: the mask row is flagged with the mask glyph", !!maskRow && maskRow.maskIcon);
  t("panel: the masked layer (above the mask) carries the arrow", !!kidRow && kidRow.badged);
  t("panel: that arrow points up at the mask below", !!kidRow && kidRow.upArrow);
  t("panel: the mask's own row carries no arrow", !!maskRow && !maskRow.badged);
  t("panel: rows below the mask are not marked", rows.filter((r) => r.badged).length === 1, JSON.stringify(rows));
  await panel.close();
}
{
  // A mask above its content masks nothing (Figma: "If the mask sits above the
  // image, it won't be masked"), so no row may be marked there either.
  const mask = softMask();
  const above = node("frame", "Mask above", 0, 0, 100, 100, { children: [content(), mask] });
  const panel = await mountPanel([above]);
  const rows = panel.rows();
  t("panel: a mask on top masks nothing, so nothing is marked", rows.every((r) => !r.badged), JSON.stringify(rows));
  await panel.close();
}
{
  const maskA = softMask();
  const maskB = softMask();
  const layers = node("frame", "Two masks", 0, 0, 100, 100, { children: [maskA, content(), maskB, content()] });
  const runs = partitionMaskRuns(layers.children);
  t(
    "painter: a mask clips the siblings above it until the next mask",
    runs.length === 2 &&
      runs[0].mask === maskA &&
      runs[0].kids.length === 1 &&
      runs[1].mask === maskB &&
      runs[1].kids.length === 1,
    JSON.stringify(runs.map((r) => ({ mask: r.mask?.name, kids: r.kids.length }))),
  );
  const panel = await mountPanel([layers]);
  const rows = panel.rows();
  t("panel: each mask marks only the layers between it and the next mask", rows.filter((r) => r.badged).length === 2, JSON.stringify(rows));
  await panel.close();
}

/* ------------------------------------------------------------------ *
 * 8. Use as mask toggles: the row reads "Remove mask" and ⌃⌘M's command clears
 *    the flag ("To stop using an object as a mask ... toggle it off").
 * ------------------------------------------------------------------ */
{
  const mask = softMask();
  mask.isMask = false;
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(pair(mask, content())), guides: [], comments: [] }],
    page: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  const livePair = () => engine.snapshot().pages[0].root.children[0];
  const liveMask = () => livePair().children[0];
  const label = (isMask) =>
    [
      ...layerMenu(false, false, { mask: isMask }),
      ...canvasMenu(1, false, false, [], false, { mask: isMask }),
    ]
      .filter((r) => r.id === "useAsMask")
      .map((r) => r.label);
  engine.dispatch({ type: "select", ids: [liveMask().id] });
  t("menu: the row offers Use as mask before masking", label(false).every((l) => l === "Use as mask"), JSON.stringify(label(false)));
  await runMenu(engine, "useAsMask");
  t("use as mask sets the flag", liveMask().isMask === true);
  t("menu: the row offers Remove mask once it is one", label(true).every((l) => l === "Remove mask"), JSON.stringify(label(true)));
  const ctx = liveMask().id;
  await runMenu(engine, "useAsMask");
  t("use as mask toggles back off (⌃⌘M removes the mask)", liveMask().isMask === false, `${ctx} isMask=${liveMask().isMask}`);
  t("removing the mask leaves the layers themselves alone", livePair().children.length === 2 && !liveMask().isMask);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
