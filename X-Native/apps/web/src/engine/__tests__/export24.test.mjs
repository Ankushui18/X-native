/**
 * Headless checks for §24 (export delivery): slice-region rendering, page
 * (content-box) export, outline-text and simplify-stroke defaults, the
 * show-in-exports fill flag, the bulk dialog's stored-preset math, the
 * .x.json validator, and the world-coordinate clipboard helper.
 *
 * Run with:  npx vite-node src/engine/__tests__/export24.test.mjs
 *
 * Everything asserted here is a pure function of the node model - no DOM, no
 * React - which is what lets the export renderer be checked in this run.
 * Text outlining under vite-node exercises the tracer's geometric fallback
 * (no canvas), so the paths asserted are boxes, not glyph curves.
 */
import { contentBox, exportClipSvg, exportSvg, svgNode } from "../svgExport.ts";
import { extrasOf, samePreset } from "../../ui/exportModel.ts";
import { isDocSeedLike } from "../files.ts";
import { worldClones } from "../clipboard.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

/** Minimal node; the exporter reads the shape/text/fill/stroke families plus w/h. */
let seq = 0;
const sn = (over = {}) => ({
  id: `n${++seq}`,
  name: "Layer",
  visible: true,
  kind: "rect",
  x: 0, y: 0, w: 100, h: 50,
  rotation: 0, opacity: 1,
  fill: "#112233", fillVisible: true, fillOpacity: 1, fillType: "solid", fillB: "#ffffff",
  gradientStops: [], fills: [],
  imageSrc: "", imageFit: "fill",
  strokeVisible: false, strokeWidth: 0, strokePaint: "", strokeOpacity: 1,
  strokeAlign: "inside", strokeCap: "butt", strokeJoin: "miter",
  strokeDash: 0,
  text: "Hi", fontFamily: "Inter", fontSize: 16, fontWeight: "400",
  textAlign: "left", textAlignVertical: "top", lineHeight: 0,
  letterSpacing: 0, textDecoration: "none", textCase: "none",
  truncate: false, maxLines: 1,
  sizingW: "fixed", sizingH: "fixed",
  overflow: "visible",
  cornerRadii: [0, 0, 0, 0],
  children: [], path: [], closed: false, effects: [],
  ...over,
});

const svgPreset = (over = {}) => ({ format: "SVG", scale: 1, suffix: "", ...over });

{
  console.log("slice export: the region's content, not the rectangle");
  const rect = sn({ id: "r", x: 50, y: 50, w: 100, h: 100, fill: "#112233" });
  const slice = sn({ id: "s", name: "Slice", isSlice: true, x: 40, y: 40, w: 120, h: 120, strokePaint: "#0d99ff" });
  const root = sn({ id: "root", kind: "frame", w: 400, h: 400, fill: "#00000000", children: [rect, slice] });
  const svg = exportSvg(slice, svgPreset(), { root });
  t("the viewBox is the slice rect", svg.includes('viewBox="40 40 120 120"'));
  t("region content renders", svg.includes("#112233"));
  t("the slice rectangle itself never renders", !svg.includes("#0d99ff") && svgNode(slice) === "");
  t("the file is named for the slice", svg.includes("<title>Slice</title>"));

  // "Ignore overlapping layers" off: the whole page, in root coordinates.
  const inner = sn({ id: "f", kind: "frame", x: 100, y: 0, w: 200, h: 200, children: [] });
  const nested = sn({ id: "s2", name: "Slice", isSlice: true, x: 10, y: 10, w: 50, h: 50 });
  inner.children.push(nested);
  const root2 = sn({ id: "root2", kind: "frame", w: 400, h: 400, fill: "#00000000", children: [inner] });
  const whole = exportSvg(nested, svgPreset({ ignoreOverlap: false }), { root: root2 });
  t("overlap-included slices locate in root coordinates", whole.includes('viewBox="110 10 50 50"'));
  const scoped = exportSvg(nested, svgPreset(), { root: root2 });
  t("scoped slices locate in their container", scoped.includes('viewBox="10 10 50 50"'));
}

{
  console.log("page export: sized to the content box, on transparency");
  const rect = sn({ id: "c", x: 100, y: 100, w: 50, h: 50, fill: "#445566" });
  const root = sn({ id: "page", kind: "frame", w: 4000, h: 4000, fill: "#ff0000", children: [rect] });
  const svg = exportSvg(root, svgPreset(), { page: true });
  t("the viewBox crops to the content", svg.includes('viewBox="100 100 50 50"'));
  t("the file size is the content size", svg.includes('width="50"') && svg.includes('height="50"'));
  t("content renders", svg.includes("#445566"));
  t("the page ground stays out", !svg.includes("#ff0000"));
  const empty = exportSvg(sn({ id: "e", kind: "frame", w: 4000, h: 4000, children: [] }), svgPreset(), { page: true });
  t("an empty page degrades to 1x1", empty.includes('viewBox="0 0 1 1"'));
}

{
  console.log("outline text: paths by default, live text when off");
  const text = sn({ id: "tx", kind: "text", w: 200, h: 40, text: "Hi" });
  const outlined = exportSvg(text, svgPreset());
  t("SVG outlines text by default", !outlined.includes("<text") && outlined.includes("<path"));
  const live = exportSvg(text, svgPreset({ outlineText: false }));
  t("off keeps a live text element", live.includes("<text") && live.includes("Hi"));
  const raster = exportSvg(text, { format: "PNG", scale: 2, suffix: "" });
  t("raster intermediates keep live text", raster.includes("<text"));
}

{
  console.log("simplify strokes: filled outlines by default, construction when off");
  const base = { id: "st", w: 100, h: 80, fillVisible: false, strokeVisible: true, strokePaint: "#00ff00", strokeWidth: 8, strokeAlign: "inside" };
  const simple = exportSvg(sn(base), svgPreset());
  t("an inside stroke becomes a filled ring", simple.includes('fill="#00ff00"') && simple.includes('stroke="none"'));
  t("no clip or mask survives simplifying", !simple.includes("<clipPath") && !simple.includes("<mask"));
  const legacy = exportSvg(sn(base), svgPreset({ simplifyStroke: false }));
  t("off keeps the clipped construction", legacy.includes("<clipPath") && legacy.includes('stroke-width="16"'));
  const center = exportSvg(sn({ ...base, strokeAlign: "center" }), svgPreset());
  t("a centre stroke still needs neither", !center.includes("<clipPath") && center.includes('stroke-width="8"'));
  const dashed = exportSvg(sn({ ...base, strokeDash: 4 }), svgPreset());
  t("dashes fall back to the attribute construction", dashed.includes("stroke-dasharray") && dashed.includes("<clipPath"));
  const network = {
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }],
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
    regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2, 3]] }],
  };
  const multi = exportSvg(sn({ ...base, vectorNetwork: network }), svgPreset());
  t("multi-contour networks fall back too", multi.includes("<clipPath"));
}

{
  console.log("show in exports: hidden fills leave the canvas but not the file");
  const hidden = svgNode(sn({ fill: "#778899", fillExportVisible: false }));
  t("a hidden base fill exports as none", !hidden.includes("#778899"));
  const shown = svgNode(sn({ fill: "#778899" }));
  t("an absent flag keeps exporting", shown.includes("#778899"));
  const stacked = svgNode(
    sn({
      fill: "#111111",
      fills: [
        { type: "solid", color: "#222222", opacity: 1, visible: true, exportVisible: false },
        { type: "solid", color: "#333333", opacity: 1, visible: true },
      ],
    }),
  );
  t("a hidden stacked fill drops out", !stacked.includes("#222222"));
  t("its siblings stay", stacked.includes("#111111") && stacked.includes("#333333"));
}

{
  console.log("content box: the visible artwork, nothing else");
  const inner = sn({ id: "box", x: 5, y: 5, w: 30, h: 40 });
  const frame = sn({ id: "bf", kind: "frame", x: 10, y: 20, w: 200, h: 200, children: [inner] });
  const hidden = sn({ id: "bh", x: 500, y: 500, w: 50, h: 50, visible: false });
  const slice = sn({ id: "bs", isSlice: true, x: 600, y: 600, w: 50, h: 50 });
  const root = sn({ id: "broot", kind: "frame", w: 4000, h: 4000, children: [frame, hidden, slice] });
  const box = contentBox(root);
  t("frames count their own bounds", !!box && box.x === 10 && box.y === 20 && box.w === 200 && box.h === 200);
  const tight = contentBox(sn({ id: "troot", kind: "frame", w: 4000, h: 4000, children: [sn({ id: "tframe", kind: "group", x: 10, y: 20, w: 0, h: 0, children: [sn({ id: "tinner", x: 5, y: 5, w: 30, h: 40 })] })] }));
  t("nested offsets accumulate", !!tight && tight.x === 10 && tight.y === 20 && tight.w === 35 && tight.h === 45);
  t("an empty page has no box", contentBox(sn({ kind: "frame", children: [] })) === null);
}

{
  console.log("bulk extras: the dialog row plus the stored rest, never twice");
  const a = { format: "PNG", scale: 1, suffix: "" };
  const b = { format: "PNG", scale: 2, suffix: "@2x" };
  const c = { format: "SVG", scale: 1, suffix: "" };
  t("identical presets match", samePreset({ ...a }, { ...a }));
  t("a suffix differs", !samePreset(a, { ...a, suffix: "x" }));
  t("a scale differs", !samePreset(a, b));
  t("extras drop the dialog row", JSON.stringify(extrasOf([a, b, c], { ...a })) === JSON.stringify([b, c]));
  t("an edited row keeps every stored preset", extrasOf([a, b], { ...a, suffix: "once" }).length === 2);
  t("no stored presets means no extras", extrasOf(undefined, a).length === 0);
  t("a genuine duplicate still exports twice", extrasOf([a, a], { ...a }).length === 1);
}

{
  console.log(".x.json round trip: the validator");
  t("a document export validates", isDocSeedLike({ fileName: "x", pages: [{ root: { children: [] } }] }));
  t("an empty object does not", !isDocSeedLike({}));
  t("pages must be non-empty", !isDocSeedLike({ pages: [] }));
  t("every page needs a root with children", !isDocSeedLike({ pages: [{ root: { children: [] } }, {}] }));
  t("null does not", !isDocSeedLike(null));
}

{
  console.log("world clones: export copies at canvas position");
  const node = sn({ x: 3, y: 4 });
  const [clone] = worldClones([{ node, x: 100, y: 200 }]);
  t("the clone moves", clone.x === 100 && clone.y === 200);
  t("the original stays", node.x === 3 && node.y === 4);
  const svg = exportClipSvg([sn({ x: 10, y: 20, w: 100, h: 100 }), sn({ x: 200, y: 5, w: 50, h: 50 })]);
  t("the clip viewBox bounds the group", svg.includes('viewBox="10 5 240 115"'));
  t("each root keeps its offset", svg.includes("translate(10 20)") && svg.includes("translate(200 5)"));
}
