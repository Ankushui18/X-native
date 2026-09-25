/**
 * Headless checks for §10 (fills, gradients): gradient-handle targeting,
 * true-sweep angular gradients, circular radials, and stop colour mixing.
 *
 * Run with:  npx vite-node src/engine/__tests__/fills.test.mjs
 *
 * The render functions draw on a recording stub instead of a real canvas, so
 * what is asserted is the geometry handed to the canvas API (radii, angles,
 * stop ramps), not pixels.
 */
import { gradTarget, mixHex, paintFill } from "../paint.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

/** Minimal node; paintFill only reads the fill family plus vector/boolean flags. */
const node = (over = {}) => ({
  fill: "#ff0000",
  fillB: "#ffffff",
  fillType: "solid",
  fillVisible: true,
  gradientStops: [],
  fills: [],
  ...over,
});

function mockCtx() {
  const calls = { stops: [], conic: null, radial: null, linear: null, scaled: false };
  const grad = () => ({ addColorStop: (pos, color) => calls.stops.push([pos, color]) });
  return {
    calls,
    ctx: {
      save() {},
      restore() {},
      clip() {},
      fill() {},
      fillRect() {},
      translate() {},
      scale() {
        calls.scaled = true;
      },
      createLinearGradient(...a) {
        calls.linear = a;
        return grad();
      },
      createRadialGradient(...a) {
        calls.radial = a;
        return grad();
      },
      createConicGradient(...a) {
        calls.conic = a;
        return grad();
      },
    },
  };
}

console.log("F-A gradient-handle targeting:");
{
  t("solid fill has no handles", gradTarget(node()) === null);
  t(
    "base linear targets the base",
    (() => {
      const g = gradTarget(node({ fillType: "linear", fillGX: 0, fillGY: 0, fillHX: 1, fillHY: 0 }));
      return g && g.index === -1 && g.gx === 0 && g.hx === 1 && g.from === "#ff0000" && g.to === "#ffffff";
    })(),
  );
  t(
    "stop colours feed the handle dots",
    (() => {
      const g = gradTarget(
        node({
          fillType: "linear",
          gradientStops: [
            { color: "#00ff00", position: 0 },
            { color: "#0000ff", position: 1 },
          ],
        }),
      );
      return g && g.from === "#00ff00" && g.to === "#0000ff";
    })(),
  );
  t("hidden base gradient has no handles", gradTarget(node({ fillType: "linear", fillVisible: false })) === null);
  t("removed base fill has no handles", gradTarget(node({ fillType: "linear", fill: "#00000000" })) === null);
  t(
    "topmost visible gradient wins",
    (() => {
      const g = gradTarget(
        node({
          fillType: "linear",
          fills: [
            { type: "linear", color: "#111111", opacity: 1, visible: true, gx: 0, gy: 0, hx: 1, hy: 0 },
            { type: "solid", color: "#222222", opacity: 1, visible: true },
          ],
        }),
      );
      return g && g.index === 0 && g.from === "#111111";
    })(),
  );
  t(
    "hidden extras are skipped",
    (() => {
      const g = gradTarget(
        node({
          fillType: "radial",
          fills: [{ type: "linear", color: "#111111", opacity: 1, visible: false }],
        }),
      );
      return g && g.index === -1;
    })(),
  );
  t(
    "extras without geometry inherit the base handles",
    (() => {
      const g = gradTarget(
        node({
          fillType: "solid",
          fillGX: 0.1,
          fillGY: 0.2,
          fillHX: 0.3,
          fillHY: 0.4,
          fills: [{ type: "linear", color: "#111111", opacity: 1, visible: true }],
        }),
      );
      return g && g.index === 0 && g.gx === 0.1 && g.gy === 0.2 && g.hx === 0.3 && g.hy === 0.4;
    })(),
  );
}

console.log("F-B angular gradients sweep true:");
{
  // Two stops, due-east handle on a square: the sweep origin sits due east
  // (conic π/2) and the ramp runs red→blue unmirrored, seam and all.
  const { calls, ctx } = mockCtx();
  paintFill(
    ctx,
    node({
      fillType: "angular",
      fillGX: 0.5,
      fillGY: 0.5,
      fillHX: 1,
      fillHY: 0.5,
      gradientStops: [
        { color: "#ff0000", position: 0 },
        { color: "#0000ff", position: 1 },
      ],
    }),
    0,
    0,
    100,
    100,
  );
  t("conic origin tracks the handle", !!calls.conic && Math.abs(calls.conic[0] - Math.PI / 2) < 1e-9);
  t("conic centres on the start handle", !!calls.conic && calls.conic[1] === 50 && calls.conic[2] === 50);
  const last = calls.stops[calls.stops.length - 1];
  t(
    "ramp ends on the last stop, not mirrored back",
    calls.stops.length > 0 && last[0] === 1 && last[1].toLowerCase().startsWith("#0000ff"),
  );
  t(
    "ramp starts on the first stop",
    calls.stops.length > 0 && calls.stops[0][0] === 0 && calls.stops[0][1].toLowerCase().startsWith("#ff0000"),
  );
}

console.log("F-C radial gradients stay circular:");
{
  // A 2:1 frame: an elliptical render would scale the context; a circular
  // one hands the canvas a plain radius in pixels.
  const { calls, ctx } = mockCtx();
  paintFill(ctx, node({ fillType: "radial", fillGX: 0.5, fillGY: 0.5, fillHX: 1, fillHY: 0.5 }), 0, 0, 200, 100);
  t("no context scaling for radials", !calls.scaled);
  t(
    "radius is handle distance in pixels",
    !!calls.radial && calls.radial[0] === 100 && calls.radial[1] === 50 && calls.radial[5] === 100,
  );
}

console.log("F-D linear gradients follow the handles:");
{
  const { calls, ctx } = mockCtx();
  paintFill(ctx, node({ fillType: "linear", fillGX: 0, fillGY: 0, fillHX: 1, fillHY: 1 }), 10, 20, 100, 50);
  t(
    "endpoints land in shape space",
    !!calls.linear && calls.linear[0] === 10 && calls.linear[1] === 20 && calls.linear[2] === 110 && calls.linear[3] === 70,
  );
}

console.log("F-E stop colour mixing:");
{
  const mid = mixHex("#ff0000", "#0000ff", 0.5);
  t("mix returns an 8-digit hex", /^#[0-9a-f]{8}$/.test(mid));
  t("midpoint differs from both ends", !mid.startsWith("#ff0000") && !mid.startsWith("#0000ff"));
  t("t=0 keeps the first colour", mixHex("#ff0000", "#0000ff", 0).toLowerCase().startsWith("#ff0000"));
  t("t=1 keeps the second colour", mixHex("#ff0000", "#0000ff", 1).toLowerCase().startsWith("#0000ff"));
}
