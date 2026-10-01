/** Color profile conversion, file behavior, and SVG output checks. */
import { convertColorValue, convertRgbProfile } from "../colorProfile.ts";
import { MemoryEngine, find } from "../memory.ts";
import { exportClipSvg, exportSvg, svgColor } from "../svgExport.ts";
import { getPreferredColorProfile, setPreferredColorProfile } from "../colorProfile.ts";
import { parseCssColor } from "../../ui/color.ts";

let pass = 0;
let fail = 0;
const t = (name, condition) => {
  if (condition) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
};
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

const greenInSrgb = convertColorValue("#00ff00", "display-p3", "srgb");
t("Display P3 green converts and clips to sRGB", greenInSrgb === "#00ff00");
const withAlpha = convertColorValue("#7f336699", "srgb", "display-p3");
t("conversion retains alpha", withAlpha.slice(7) === "99");
const roundTrip = convertColorValue(withAlpha, "display-p3", "srgb");
t("in-gamut round trip stays close", roundTrip.slice(1, 7).toLowerCase() === "7f3366");
const identity = convertRgbProfile({ r: 12, g: 80, b: 240 }, "srgb", "srgb");
t("same-profile conversion leaves RGB values intact", identity.r === 12 && identity.g === 80 && identity.b === 240);
t("P3 SVG uses an explicit profile color", svgColor("#336699", "display-p3").startsWith("color(display-p3 "));
t("sRGB SVG keeps hex output", svgColor("#336699", "srgb") === "#336699");
const authoredP3 = parseCssColor("color(display-p3 0.8 0.2 0.1)", "display-p3");
t("CSS P3 input retains its wide-gamut channels in a P3 file", authoredP3?.r === 204 && authoredP3.g === 51 && authoredP3.b === 26);
const p3InSrgbFile = parseCssColor("color(display-p3 0.8 0.2 0.1)", "srgb");
t("CSS P3 input is converted to the sRGB file profile", p3InSrgbFile?.r !== authoredP3?.r || p3InSrgbFile.g !== authoredP3?.g || p3InSrgbFile.b !== authoredP3?.b);

const engine = new MemoryEngine(false);
engine.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 20, h: 20, extra: { fill: "#336699" } });
const nodeId = engine.snapshot().selection[0];
engine.dispatch({ type: "addVariable", variable: { id: "brand-color", name: "Brand", type: "color", value: "#ff0000", collection: "Brand" } });
engine.dispatch({ type: "setColorProfile", profile: "display-p3", mode: "assign" });
const assignedNode = find(engine.snapshot().pages[engine.snapshot().page].root, nodeId);
t("assign changes file profile but preserves paint values", engine.snapshot().colorProfile === "display-p3" && assignedNode.fill === "#336699");
const p3Svg = exportSvg(assignedNode, { format: "SVG", scale: 1, suffix: "", colorProfile: "display-p3" });
t("SVG export override writes the selected P3 color", p3Svg.includes("color(display-p3 "));
const p3Clip = exportClipSvg([assignedNode], "display-p3");
t("SVG clipboard output can use the document profile", p3Clip.includes("color(display-p3 "));
engine.dispatch({ type: "setColorProfile", profile: "srgb", mode: "convert" });
const converted = find(engine.snapshot().pages[engine.snapshot().page].root, nodeId);
t("convert updates embedded node colors", converted.fill !== "#336699");
t("convert preserves stored variable values", engine.snapshot().variables.find((v) => v.id === "brand-color")?.value === "#ff0000");
engine.dispatch({ type: "undo" });
const restored = find(engine.snapshot().pages[engine.snapshot().page].root, nodeId);
t("profile conversion is one undoable document edit", engine.snapshot().colorProfile === "display-p3" && restored.fill === "#336699");
const serialized = engine.toDoc();
t("profile is saved with the file", serialized.colorProfile === "display-p3");

const preferenceStore = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key) => preferenceStore.get(key) ?? null,
    setItem: (key, value) => preferenceStore.set(key, value),
  },
});
setPreferredColorProfile("display-p3");
const preferredEngine = new MemoryEngine(false);
t("preferred profile is stored locally", getPreferredColorProfile() === "display-p3");
t("new documents inherit the preferred profile", preferredEngine.snapshot().colorProfile === "display-p3");
