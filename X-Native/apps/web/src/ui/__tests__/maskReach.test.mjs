/**
 * Run 6 - Figma parity, masks: the mask's reach stops at a frame or component
 * with clip content on.
 *
 * Source of truth: Figma's *Masks* article,
 * https://help.figma.com/hc/en-us/articles/360040450253-Masks
 *  - "Masks are positioned below masked layers on the z-axis. The mask applies
 *    to all siblings above it until it reaches:
 *      - Another mask or mask object
 *      - The mask's parent frame or group
 *      - A frame or component with clip content on"
 *
 * The third rule is the one under test: the boundary node is itself outside the
 * mask (the article's frame-with-clip-content example cannot be masked by a
 * sibling mask at all), and so is everything above it. A frame with clip
 * content *off* lets the reach continue, and a group has no such property, so
 * neither stops it.
 *
 * Measured before the fix (probe, deleted): every boundary kind was swallowed
 * into the masked run - `[mask Mask](Small, Clipped frame, Above)` - the
 * clipped frame's own fill read r=255 g=255 b=255 at (180,30) and the layer
 * above it r=255 at (130,20) (both punched out; the frame's fill is #1f2937 =
 * r31 and the layer's blue is #3b82f6 = r59), and the layers panel put the
 * masked-layer arrow on all three rows.
 *
 * The pixel half runs against the software Canvas2D in ./softCanvas2d.mjs, so
 * the readings are device pixels, not call logs.
 *
 * Run: vite-node src/ui/__tests__/maskReach.test.mjs
 */
import { node } from "../../engine/memory.ts";
import { partitionMaskRuns, stopsMaskReach } from "../../engine/paint.ts";
import { mountCanvas, mountPanel } from "./softCanvas2d.mjs";

let pass = 0,
  fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? ` - ${extra}` : ""}`);
};

/* The scene, in page coordinates: a 60px-wide opaque mask at the left, a
 * sibling frame with clip content on past its reach, and a layer above that
 * frame. Device pixels are 1:1 with these coordinates. */
const mask = (extra = {}) =>
  node("rect", "Mask", 0, 0, 60, 100, { isMask: true, fill: "#ffffff", fillVisible: true, ...extra });
const clipFrame = (extra = {}) =>
  node("frame", "Clipped frame", 100, 0, 90, 60, {
    fill: "#1f2937",
    fillVisible: true,
    overflow: "clip",
    ...extra,
  });
const above = () => node("rect", "Above", 110, 10, 60, 30, { fill: "#3b82f6", fillVisible: true });
const small = (name, x, w) => node("rect", name, x, 60, w, 20, { fill: "#3b82f6", fillVisible: true });
const container = (children) =>
  node("frame", "Mask object", 0, 0, 240, 100, { children, fill: "#ffffff", fillVisible: true });

const shape = (runs) => runs.map((r) => `${r.mask ? `mask(${r.mask.name})` : "plain"}:[${r.kids.map((k) => k.name).join(",")}]`).join(" | ");
const names = (kids) => kids.map((k) => k.name).join(",");

/* ------------------------------------------------------------------ *
 * 1. The stopping rule itself, and the kinds it does and does not cover.
 * ------------------------------------------------------------------ */
t(
  "clip frame stops the reach: the run ends before it",
  (() => {
    const runs = partitionMaskRuns([mask(), small("Small", 0, 20), clipFrame(), above()]);
    return runs.length === 2 && names(runs[0].kids) === "Small" && names(runs[1].kids) === "Clipped frame,Above" && runs[1].mask === null;
  })(),
  shape(partitionMaskRuns([mask(), small("Small", 0, 20), clipFrame(), above()])),
);
t(
  "the boundary frame is itself outside the mask",
  (() => {
    const runs = partitionMaskRuns([mask(), clipFrame(), above()]);
    return runs.length === 1 && runs[0].mask === null && names(runs[0].kids) === "Clipped frame,Above";
  })(),
  shape(partitionMaskRuns([mask(), clipFrame(), above()])),
);
t(
  "a component with clip content on stops the reach",
  (() => {
    const runs = partitionMaskRuns([mask(), small("Small", 0, 20), node("component", "Comp", 100, 0, 40, 40, { overflow: "clip", children: [] }), above()]);
    return runs.length === 2 && names(runs[0].kids) === "Small" && runs[1].mask === null;
  })(),
);
t(
  "an instance with clip content on stops the reach",
  (() => {
    const runs = partitionMaskRuns([mask(), small("Small", 0, 20), node("instance", "Inst", 100, 0, 40, 40, { overflow: "clip", children: [] }), above()]);
    return runs.length === 2 && names(runs[0].kids) === "Small" && runs[1].mask === null;
  })(),
);
t(
  "a scroll frame clips content, so it stops the reach too",
  (() => {
    const runs = partitionMaskRuns([mask(), small("Small", 0, 20), clipFrame({ overflow: "scrollboth" }), above()]);
    return runs.length === 2 && names(runs[0].kids) === "Small";
  })(),
);
t(
  "clip content OFF is no boundary: the reach continues",
  (() => {
    const runs = partitionMaskRuns([mask(), small("Small", 0, 20), clipFrame({ overflow: "visible" }), above()]);
    return runs.length === 1 && runs[0].mask?.name === "Mask" && names(runs[0].kids) === "Small,Clipped frame,Above";
  })(),
  shape(partitionMaskRuns([mask(), small("Small", 0, 20), clipFrame({ overflow: "visible" }), above()])),
);
t(
  "a group sibling has no clip content property, so it does not stop the reach",
  (() => {
    const runs = partitionMaskRuns([mask(), node("group", "Group", 100, 0, 40, 40, { children: [] }), above()]);
    return runs.length === 1 && runs[0].mask?.name === "Mask" && runs[0].kids.length === 2;
  })(),
);
t(
  "only frame-ish kinds clip: a clipped rect above the mask is still masked",
  (() => {
    const runs = partitionMaskRuns([mask(), node("rect", "Clipped rect", 100, 0, 40, 40, { overflow: "clip" }), above()]);
    return runs.length === 1 && runs[0].kids.length === 2;
  })(),
);
t(
  "the predicate itself: frames/components/instances that clip stop the reach",
  [
    stopsMaskReach({ kind: "frame", overflow: "clip" }) === true,
    stopsMaskReach({ kind: "frame", overflow: "scrollx" }) === true,
    stopsMaskReach({ kind: "component", overflow: "scrollboth" }) === true,
    stopsMaskReach({ kind: "instance", overflow: "clip" }) === true,
    stopsMaskReach({ kind: "frame", overflow: "visible" }) === false,
    stopsMaskReach({ kind: "group", overflow: "clip" }) === false,
    stopsMaskReach({ kind: "rect", overflow: "clip" }) === false,
    stopsMaskReach({ kind: "frame" }) === false,
  ].every(Boolean),
);
t(
  "a mask that reaches no layer leaves no run at all (no empty masked run)",
  (() => {
    const runs = partitionMaskRuns([mask(), clipFrame(), above()]);
    return runs.length === 1 && runs.every((r) => r.mask === null);
  })(),
  shape(partitionMaskRuns([mask(), clipFrame(), above()])),
);
t(
  "a boundary below the mask is irrelevant to it",
  (() => {
    const runs = partitionMaskRuns([clipFrame(), mask(), above()]);
    return runs.length === 2 && runs[0].mask === null && runs[0].kids.length === 1 && runs[1].mask?.name === "Mask" && names(runs[1].kids) === "Above";
  })(),
  shape(partitionMaskRuns([clipFrame(), mask(), above()])),
);
t(
  "a boundary between two masks closes the first and lets the second start",
  (() => {
    const runs = partitionMaskRuns([mask(), small("Small", 0, 20), clipFrame(), mask({ name: "Mask 2" }), above()]);
    return (
      runs.length === 3 &&
      runs[0].mask?.name === "Mask" &&
      names(runs[0].kids) === "Small" &&
      runs[1].mask === null &&
      names(runs[1].kids) === "Clipped frame" &&
      runs[2].mask?.name === "Mask 2" &&
      names(runs[2].kids) === "Above"
    );
  })(),
  shape(partitionMaskRuns([mask(), small("Small", 0, 20), clipFrame(), mask({ name: "Mask 2" }), above()])),
);

/* ------------------------------------------------------------------ *
 * 2. The painted pixels: the boundary and the layers above it keep their ink,
 *    and the mask still clips what is between it and the boundary.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([
    container([mask(), small("In the window", 10, 30), small("Past the mask", 70, 20), clipFrame(), above()]),
  ]);
  const frameFill = ui.pixelAt(180, 30);
  const aboveInk = ui.pixelAt(130, 20);
  const window = ui.pixelAt(20, 70);
  const past = ui.pixelAt(75, 70);
  t(
    "pixels: the clipped frame past the boundary keeps its own fill",
    frameFill.r === 31 && frameFill.g === 41 && frameFill.b === 55,
    `r=${frameFill.r} g=${frameFill.g} b=${frameFill.b} (fill is #1f2937 = 31,41,55)`,
  );
  t(
    "pixels: the layer above the boundary is not masked",
    aboveInk.r === 59 && aboveInk.g === 130 && aboveInk.b === 246,
    `r=${aboveInk.r} g=${aboveInk.g} b=${aboveInk.b} (blue is #3b82f6 = 59,130,246)`,
  );
  t(
    "pixels: the mask still reveals what sits in its window below the boundary",
    window.r === 59,
    `r=${window.r}`,
  );
  t(
    "pixels: the mask still hides what sits past its ink below the boundary",
    past.r === 255,
    `r=${past.r}`,
  );
  await ui.close();
}
{
  // Control: the same scene with clip content off. The reach has no boundary,
  // so the frame's fill and the layer above it are both punched out (the
  // article allows the mask to pass a frame that does not clip).
  const ui = await mountCanvas([container([mask(), clipFrame({ overflow: "visible" }), above()])]);
  const frameFill = ui.pixelAt(180, 30);
  const aboveInk = ui.pixelAt(130, 20);
  t(
    "pixels: with clip content off the reach continues through the frame",
    frameFill.r === 255 && aboveInk.r === 255,
    `frame r=${frameFill.r}, above r=${aboveInk.r}`,
  );
  await ui.close();
}
{
  // A mask inside a clipped frame: its parent ends the reach, so a sibling of
  // that frame is never affected, while the mask still clips its own siblings.
  const inner = small("Inner", 60, 20);
  const frame = clipFrame({ fillVisible: false, children: [mask(), inner] });
  const outside = node("rect", "Outside", 200, 0, 30, 30, { fill: "#3b82f6", fillVisible: true });
  const ui = await mountCanvas([container([frame, outside])]);
  const inInner = ui.pixelAt(170, 25);
  const inOutside = ui.pixelAt(210, 15);
  t(
    "pixels: inside a clipped frame the mask still applies to its own siblings",
    inInner.r === 255,
    `r=${inInner.r} (255 = punched out; the frame's fill is invisible)`,
  );
  t(
    "pixels: a layer outside that frame is untouched by the mask",
    inOutside.r === 59,
    `r=${inOutside.r}`,
  );
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 3. The layers panel: the masked-layer arrow stops where the reach stops.
 * ------------------------------------------------------------------ */
{
  const panel = await mountPanel([container([mask(), small("Small", 0, 20), clipFrame(), above()])]);
  const rows = panel.rows();
  const badged = rows.filter((r) => r.badged).map((r) => r.name);
  t(
    "panel: only the layers between the mask and the boundary carry the arrow",
    badged.length === 1 && badged[0] === "Small",
    JSON.stringify(badged),
  );
  t(
    "panel: the boundary frame and the layers above it are not marked",
    ["Clipped frame", "Above"].every((name) => !rows.find((r) => r.name === name)?.badged),
    JSON.stringify(rows.map((r) => `${r.name}:${r.badged}`)),
  );
  await panel.close();
}
{
  const panel = await mountPanel([container([mask(), small("Small", 0, 20), clipFrame({ overflow: "visible" }), above()])]);
  const badged = panel.rows().filter((r) => r.badged).map((r) => r.name);
  t(
    "panel: with clip content off the arrow keeps going up the stack",
    badged.length === 3 && badged.includes("Small") && badged.includes("Clipped frame") && badged.includes("Above"),
    JSON.stringify(badged),
  );
  await panel.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
