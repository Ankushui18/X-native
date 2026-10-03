/**
 * Headless checks for §12 (effects): spread kind-gate, fill composite alpha,
 * drop-shadow masking triggers, type-menu hover preview merge, background-blur
 * translucency rule, effect defaults/caps, and the masked-drop live fallback.
 *
 * Run with:  npx vite-node src/engine/__tests__/effects.test.mjs
 */
import { MemoryEngine, defaultEffect, find } from "../memory.ts";
import {
  dropMaskNeeds,
  fillCompositeAlpha,
  paintDropShadowsMasked,
  paintsAnyFill,
  spreadApplies,
} from "../paint.ts";
import { bgBlurSeesThrough, canAddEffect, withPreviewEffect } from "../../ui/effectModel.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

const node = (kind, patch) => {
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind, x: 0, y: 0, w: 100, h: 100 });
  const id = e.snapshot().selection[0];
  if (patch) e.dispatch({ type: "patch", id, patch });
  return find(e.snapshot().pages[e.snapshot().page].root, id);
};
const drops = (k) => Array.from({ length: k }, () => defaultEffect("drop-shadow"));

console.log("E-A spread kind gate:");
{
  t("rect takes spread", spreadApplies(node("rect")) === true);
  t("ellipse takes spread", spreadApplies(node("ellipse")) === true);
  t("instance takes spread", spreadApplies(node("instance")) === true);
  t("star ignores spread", spreadApplies(node("star")) === false);
  t("text ignores spread", spreadApplies(node("text")) === false);
  t("group ignores spread", spreadApplies(node("group")) === false);
  t("boolean ignores spread", spreadApplies(node("boolean")) === false);
  t("frame defaults qualify (clip + fill)", spreadApplies(node("frame")) === true);
  t("unclipped frame ignores spread", spreadApplies(node("frame", { overflow: "visible" })) === false);
  t("fill-less frame ignores spread", spreadApplies(node("frame", { fill: "#00000000" })) === false);
  t("component with clip + fill qualifies", spreadApplies(node("component", { overflow: "clip", fill: "#fff" })) === true);
}

console.log("E-B fill composite alpha:");
{
  t("opaque solid is 1", fillCompositeAlpha(node("rect", { fill: "#ff0000" })) === 1);
  t("fillOpacity scales", fillCompositeAlpha(node("rect", { fill: "#ff0000", fillOpacity: 0.5 })) === 0.5);
  const hexA = fillCompositeAlpha(node("rect", { fill: "#00000080" }));
  t("hex alpha counts", Math.abs(hexA - 128 / 255) < 0.01);
  t(
    "paints stack composites",
    Math.abs(
      fillCompositeAlpha(
        node("rect", {
          fill: "#00000000",
          fills: [
            { type: "solid", color: "#ff0000", opacity: 0.5, visible: true },
            { type: "solid", color: "#0000ff", opacity: 0.5, visible: true },
          ],
        }),
      ) - 0.75,
    ) < 1e-9,
  );
  t(
    "hidden paint ignored",
    fillCompositeAlpha(
      node("rect", { fill: "#00000000", fills: [{ type: "solid", color: "#ff0000", opacity: 1, visible: false }] }),
    ) === 0,
  );
  t(
    "transparent gradient stop caps",
    fillCompositeAlpha(
      node("rect", {
        fill: "#ff0000",
        fillType: "gradient",
        gradientStops: [
          { color: "#ff0000", position: 0 },
          { color: "#ff000000", position: 1 },
        ],
      }),
    ) === 0,
  );
  t("no fill is 0", fillCompositeAlpha(node("rect", { fill: "#00000000" })) === 0);
}

console.log("E-C drop mask triggers:");
{
  t("opaque rect needs no mask", dropMaskNeeds(node("rect", { fill: "#ff0000" })) === false);
  t("translucent fill needs a mask", dropMaskNeeds(node("rect", { fill: "#ff0000", fillOpacity: 0.5 })) === true);
  t(
    "stroke-only needs no mask (ring)",
    dropMaskNeeds(node("rect", { fill: "#00000000", strokePaint: "#000", strokeWidth: 4, strokeVisible: true })) === false,
  );
  t("lines never mask", dropMaskNeeds(node("line", { fillOpacity: 0.5 })) === false);
  t(
    "additional-only fill still paints",
    paintsAnyFill(
      node("rect", { fill: "#00000000", fills: [{ type: "solid", color: "#f00", opacity: 1, visible: true }] }),
    ) === true,
  );
  t("bare layer paints no fill", paintsAnyFill(node("rect", { fill: "#00000000" })) === false);
}

console.log("E-D hover preview merge:");
{
  const fx = drops(2);
  t("no preview returns the stack", withPreviewEffect(fx, null, "a") === fx);
  t(
    "wrong layer untouched",
    withPreviewEffect(fx, { id: "b", kind: "noise", effect: defaultEffect("noise") }, "a") === fx,
  );
  const merged = withPreviewEffect(fx, { id: "a", kind: "noise", effect: defaultEffect("noise") }, "a");
  t("matching preview appends", merged.length === 3 && merged[2].kind === "noise");
  t("stored stack not mutated", fx.length === 2);
  t(
    "capped kind shows no preview",
    withPreviewEffect(drops(8), { id: "a", kind: "drop-shadow", effect: defaultEffect("drop-shadow") }, "a").length ===
      8,
  );
  t(
    "kind mismatch shows no preview",
    withPreviewEffect(fx, { id: "a", kind: "noise", effect: defaultEffect("drop-shadow") }, "a") === fx,
  );
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const id = e.snapshot().selection[0];
  t("no preview by default", e.snapshot().previewEffect === null);
  e.dispatch({ type: "previewEffect", id, kind: "glass" });
  t(
    "preview sets",
    JSON.stringify(e.snapshot().previewEffect) === JSON.stringify({ id, kind: "glass" }),
  );
  e.dispatch({ type: "select", ids: [id] });
  t("select clears the preview", e.snapshot().previewEffect === null);
}

console.log("E-E background-blur translucency rule:");
{
  t("no fill: nothing to show", bgBlurSeesThrough(0) === false);
  t("below 0.10% hidden", bgBlurSeesThrough(0.0005) === false);
  t("0.10% shows", bgBlurSeesThrough(0.001) === true);
  t("half shows", bgBlurSeesThrough(0.5) === true);
  t("99.99% shows", bgBlurSeesThrough(0.9999) === true);
  t("opaque covers", bgBlurSeesThrough(1) === false);
}

console.log("E-F defaults and caps:");
{
  t("noise defaults to white", defaultEffect("noise").color === "#ffffff");
  t("noise density defaults to 40", defaultEffect("noise").blur === 40);
  t("drop sits at y 4", defaultEffect("drop-shadow").y === 4);
  t("blurs default to 12", defaultEffect("layer-blur").blur === 12 && defaultEffect("glass").blur === 12);
  t("eighth drop fits", canAddEffect(drops(7), "drop-shadow") === true);
  t("ninth drop capped", canAddEffect(drops(8), "drop-shadow") === false);
  t(
    "third noise capped",
    canAddEffect([defaultEffect("noise"), defaultEffect("noise")], "noise") === false,
  );
  t("second texture capped", canAddEffect([defaultEffect("texture")], "texture") === false);
}

console.log("E-G masked-drop live paths:");
{
  const mock = () => {
    const calls = { fill: 0, stroke: 0, clip: "" };
    return {
      calls,
      ctx: {
        save() {}, restore() {}, translate() {}, beginPath() {}, rect() {},
        clip(rule) { calls.clip = String(rule); },
        fill() { calls.fill++; }, stroke() { calls.stroke++; },
        set filter(v) {}, set globalCompositeOperation(v) {}, set fillStyle(v) {},
        set strokeStyle(v) {}, set lineWidth(v) {}, set lineJoin(v) {}, set lineCap(v) {},
      },
    };
  };
  const m1 = mock();
  paintDropShadowsMasked(
    m1.ctx,
    { ...node("rect", { fill: "#ff0000" }), effects: [defaultEffect("drop-shadow")] },
    1,
  );
  t("opaque drop paints unclipped", m1.calls.fill === 1 && m1.calls.clip === "");
  const m2 = mock();
  paintDropShadowsMasked(
    m2.ctx,
    { ...node("rect", { fill: "#ff0000", fillOpacity: 0.5 }), effects: [defaultEffect("drop-shadow")] },
    1,
    { trace() {} },
  );
  t("translucent drop paints inverse-clipped", m2.calls.fill === 1 && m2.calls.clip === "evenodd");
  const m2b = mock();
  paintDropShadowsMasked(
    m2b.ctx,
    {
      ...node("rect", { fill: "#ff0000", fillOpacity: 0.5 }),
      effects: [{ ...defaultEffect("drop-shadow"), showBehind: true }],
    },
    1,
    { trace() {} },
  );
  t("show-behind skips the mask", m2b.calls.fill === 1 && m2b.calls.clip === "");
  const m3 = mock();
  paintDropShadowsMasked(
    m3.ctx,
    { ...node("rect", { fill: "#ff0000" }), effects: [{ ...defaultEffect("drop-shadow"), color: "#00000000" }] },
    1,
  );
  t("fully transparent drop skipped", m3.calls.fill === 0 && m3.calls.stroke === 0);
}
