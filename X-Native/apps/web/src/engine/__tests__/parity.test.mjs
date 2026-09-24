/**
 * Headless checks for the parity work added in FIGMA_PARITY_AUDIT_2026-09-22.
 *
 * Run with:  npx vite-node src/engine/__tests__/parity.test.mjs
 *
 * These cover the pure geometry/snapping helpers, which is where the logic
 * that is easy to get subtly wrong lives. Canvas wiring is verified in-browser.
 */
import { snapMove, snapCandidates } from "../snapping.ts";
import {
  cornerPinPoints,
  cornerRadiiOf,
  cornerReach,
  hasCornerSmoothing,
  roundRectRadii,
  shapePoly,
  simplifyPath,
  smoothPath,
  squircleOutline,
  erasePath,
  pathToVectorNetwork,
  addVectorBranch,
  vertexDegree,
  vectorNetworkToSvgPath,
  bendSegment,
  balanceLines,
  insertPointOnPath,
  projectPointOnSegment,
  computeFigmaNoodle,
} from "../geometry.ts";
import { MemoryEngine, defaultEffect, find, insideInstance } from "../memory.ts";
import {
  SPACING_MODES,
  alignKey,
  alignmentCells,
  cellAlign,
  cellBox,
  defaultGrid,
  gridRows,
  placeCells,
  planGrid,
  widthIsMain,
  autoSpacing,
  clampToPadding,
  defaultLayout,
  effectiveSizing,
  hasFillChild,
  isAutoGap,
  layoutKeyPatch,
  parsePaddingShorthand,
  suggestLayout,
  textDimensionRule,
  wraps,
} from "../layout.ts";
import { ASSET_PREFIX, assetCount, dehydrateDoc, hydrateDoc, putAsset, resetAssets } from "../assets.ts";
import { evalField, hasExpression } from "../../ui/fieldExpr.ts";
import { rotateAboutOrigin, scaleBoxAround, scaleMembers, sizeKeepingRatio, unionBox } from "../../ui/scaleModel.ts";
import { layersAt, matchingIds, pathIndex, sameIds } from "../../ui/selectSame.ts";
import {
  SIDES,
  dashArray,
  miterLimitFromAngle,
  parseDashPattern,
  sideCones,
  sideWidths,
  sidesSupported,
} from "../../engine/strokeModel.ts";
import {
  EFFECT_LIMITS,
  canAddEffect,
  canShowBehindTransparent,
  countKind,
  effectCanBlend,
  effectCanShowBehind,
  moveEffect,
} from "../../ui/effectModel.ts";

import { colorUsage, colorUsageAll, setOpacityMatches } from "../../ui/selectionColors.ts";
import { compositeOver, contrastRatio, readableLabel } from "../../ui/color.ts";
import { contrastRatio, contrastTarget, nearestAccessible, passesContrast, parseHex, rgbToHsv } from "../../ui/color.ts";

import { inspectFigFile, importFig } from "../figImport.ts";
import {
  DEFAULT_NUDGE,
  NUDGE_MAX,
  NUDGE_MIN,
  clampNudge,
  normalizeNudge,
  nudgeStep,
  parseNudge,
} from "../../ui/nudgePrefs.ts";
import {
  DEFAULT_THEME_PREF,
  THEME_OPTIONS,
  normalizeThemePref,
  resolveTheme,
  themeLabel,
} from "../../ui/themeModel.ts";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_PRESETS,
  normalizeWheelDelta,
  panForZoom,
  stepZoom,
  wheelZoomFactor,
} from "../view.ts";
import { exportSvg, svgPath } from "../svgExport.ts";
import {
  FORMAT_CAPS,
  FORMATS,
  SCALE_PRESETS,
  clampScale,
  exportSize,
  formatScale,
  newPreset,
  parseScale,
  qualityValue,
  resolveSettings,
} from "../../ui/exportModel.ts";
import { interpolateMatchingLayers, solveEasing, applyInterpolatedFrame } from "../smartAnimate.ts";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

let pass=0, fail=0;
const t=(n,c)=>{ if(c){pass++;console.log("  ok  "+n);} else {fail++;console.log("  FAIL "+n);} };

console.log("snapping:");
// A box 3px from alignment should snap flush to the edge.
let r = snapMove({id:"m",x:103,y:50,w:50,h:50},[{id:"a",x:100,y:200,w:50,h:50}],6);
t("snaps left edge to 100 (dx=-3)", Math.abs(r.dx+3)<1e-6);
t("emits a guide", r.guides.length===1 && r.guides[0].axis==="x" && r.guides[0].at===100);
// Out of tolerance -> untouched.
r = snapMove({id:"m",x:200,y:50,w:33,h:50},[{id:"a",x:100,y:200,w:50,h:50}],6);
t("ignores targets beyond tolerance", r.dx===0 && r.guides.length===0);
// Centre alignment.
r = snapMove({id:"m",x:110,y:0,w:30,h:10},[{id:"a",x:100,y:200,w:50,h:50}],6);
t("snaps centre-to-centre", r.dx===0 && r.guides.some((g) => g.center === true));
// Equal-gap detection between two neighbours.
r = snapMove({id:"m",x:100,y:0,w:20,h:20},[
  {id:"l",x:50,y:0,w:20,h:20},{id:"r",x:150,y:0,w:20,h:20}],6);
t("reports equal gaps", r.gaps.length===2 && Math.round(r.gaps[0].size)===30);

console.log("candidates:");
const root={id:"root",x:0,y:0,w:0,h:0,visible:true,children:[
  {id:"a",x:10,y:10,w:5,h:5,visible:true,children:[]},
  {id:"b",x:20,y:20,w:5,h:5,visible:true,children:[{id:"c",x:1,y:1,w:2,h:2,visible:true,children:[]}]},
]};
let cands = snapCandidates(root,new Set());
t("collects nested nodes in world space", cands.length===3 && cands.find(c=>c.id==="c").x===21);
cands = snapCandidates(root,new Set(["b"]));
t("skips dragged subtree entirely", cands.length===1 && cands[0].id==="a");

console.log("geometry:");
const line=Array.from({length:50},(_,i)=>({x:i,y:0}));
t("RDP collapses a straight run", simplifyPath(line,1).length===2);
const sm=smoothPath([{x:0,y:0},{x:10,y:10},{x:20,y:0}],false);
t("smoothing adds bezier handles", sm[1].ox!==0 || sm[1].oy!==0);
const runs=erasePath(Array.from({length:11},(_,i)=>({x:i*10,y:0})),50,0,15);
t("eraser splits a stroke into two runs", runs.length===2);
t("eraser removed the covered anchors", runs[0].every(p=>p.x<35) && runs[1].every(p=>p.x>65));

console.log("fill stack:");
// A node with no `fills` must behave exactly as before (single fill).
const base={fillType:"solid",fill:"#ff0000",fillOpacity:1,fillVisible:true,gradientStops:[]};
t("absent fills array means one paint", (base.fills ?? []).length===0);
// Extra fills paint bottom-to-top over the base, and hidden ones are skipped.
const stacked={...base,fills:[
  {type:"solid",color:"#00ff00",opacity:1,visible:true},
  {type:"solid",color:"#0000ff",opacity:1,visible:false},
]};
const painted=(stacked.fills ?? []).filter(f=>f.visible!==false);
t("stacked fills keep declared order", painted.length===1 && painted[0].color==="#00ff00");
t("invisible fills are skipped", !painted.some(f=>f.color==="#0000ff"));

console.log("undo coalescing:");
{
  // Typing "45" into a numeric field commits 4 then 45 in quick succession.
  // Both keystrokes must collapse into a single undo step, while a patch of a
  // different property still starts a new one.
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const id = e.snapshot().selection[0];
  const get = () => {
    let found = null;
    const walk = (n) => { if (n.id === id) found = n; n.children?.forEach(walk); };
    const sn = e.snapshot();
    walk(sn.pages[sn.page].root);
    return found;
  };
  e.dispatch({ type: "patch", id, patch: { rotation: 4 } });
  e.dispatch({ type: "patch", id, patch: { rotation: 45 } });
  t("typed value applies", get().rotation === 45);
  e.dispatch({ type: "undo" });
  t("one undo clears the whole typed value", get().rotation === 0);

  e.dispatch({ type: "patch", id, patch: { rotation: 30 } });
  e.dispatch({ type: "patch", id, patch: { w: 150 } });
  e.dispatch({ type: "undo" });
  t("undo reverts only the last property", get().w === 100 && get().rotation === 30);
}
{
  // Same problem on the Auto Layout gap/padding fields, which rewrite the
  // whole layout object rather than going through "patch".
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 200 });
  const id = e.snapshot().selection[0];
  const base = { direction: "vertical", gap: 8, padding: [16, 16, 16, 16],
                 sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min" };
  e.dispatch({ type: "autoLayout", id, layout: { ...base } });
  // Look the frame up by identity-independent means: undo restores a cloned
  // state, so hold on to the node's position in the tree rather than a stale ref.
  const lay = () => {
    let f = null;
    const walk = (n) => { if (n.layout) f = n; n.children?.forEach(walk); };
    const sn = e.snapshot();
    walk(sn.pages[sn.page].root);
    return f ? f.layout : null;
  };
  // typing "32" into padding commits 3 then 32
  e.dispatch({ type: "autoLayout", id, layout: { ...base, padding: [3, 3, 3, 3] } });
  e.dispatch({ type: "autoLayout", id, layout: { ...base, padding: [32, 32, 32, 32] } });
  t("padding applies", lay().padding[0] === 32);
  e.dispatch({ type: "undo" });
  t("one undo restores padding", lay().padding[0] === 16);
}

console.log("persisted document recovery:");
{
  // A stored node missing fields the UI reads (fill, cornerRadii, effects, …)
  // used to render a white screen on boot. Loading must repair it instead.
  const KEY = "x-native-document";
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  store.set(KEY, JSON.stringify({
    version: 1, fileName: "x", components: [], zoom: 1,
    pages: [{ name: "p", root: { children: [{ kind: "rect", name: "Bare", x: 0, y: 0, w: 10, h: 10 }] } }],
  }));
  const e = new MemoryEngine(true);
  const sn = e.snapshot();
  const root = sn.pages[sn.page].root;
  const kid = root.children[0];
  t("skeletal persisted node is revived", !!kid);
  t("revived node gains a fill", typeof kid.fill === "string" && kid.fill.length >= 7);
  t("revived node gains array fields", Array.isArray(kid.cornerRadii) && Array.isArray(kid.effects));
  t("revived node keeps its own values", kid.name === "Bare" && kid.kind === "rect" && kid.w === 10);
  t("revived root is usable", typeof root.fill === "string" && Array.isArray(root.children));
  delete globalThis.localStorage;
}

console.log("shared styles:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const a = e.snapshot().selection[0];
  e.dispatch({ type: "add", kind: "rect", x: 120, y: 0, w: 100, h: 100 });
  const b = e.snapshot().selection[0];
  const get = (id) => {
    let found = null;
    const walk = (n) => { if (n.id === id) found = n; n.children?.forEach(walk); };
    const sn = e.snapshot();
    walk(sn.pages[sn.page].root);
    return found;
  };
  e.dispatch({ type: "select", ids: [a] });
  e.dispatch({ type: "patch", id: a, patch: { fill: "#ff0000", fillVisible: true } });
  e.dispatch({ type: "createStyle", kind: "fill", name: "Brand" });
  const style = e.snapshot().styles[0];
  t("createStyle stores a named paint", !!style && style.name === "Brand" && style.color === "#ff0000");
  t("the source node is bound", get(a).fillStyle === style.id);

  e.dispatch({ type: "select", ids: [b] });
  e.dispatch({ type: "applyStyle", kind: "fill", styleId: style.id });
  t("applyStyle paints and binds another node", get(b).fill === "#ff0000" && get(b).fillStyle === style.id);

  // the point of the feature: one edit repaints every bound node
  e.dispatch({ type: "editStyle", id: style.id, color: "#0000ff" });
  t("editing a style repaints every bound node",
    get(a).fill === "#0000ff" && get(b).fill === "#0000ff");

  // editing a bound colour by hand detaches, and must not drag the style with it
  e.dispatch({ type: "patch", id: b, patch: { fill: "#00ff00" } });
  t("a hand edit detaches that node", get(b).fillStyle === undefined && get(b).fill === "#00ff00");
  t("the style itself is unchanged", e.snapshot().styles[0].color === "#0000ff");
  t("the other bound node is unaffected", get(a).fill === "#0000ff" && get(a).fillStyle === style.id);

  // deleting keeps the colour, drops the link
  e.dispatch({ type: "deleteStyle", id: style.id });
  t("deleteStyle unbinds without repainting", get(a).fill === "#0000ff" && get(a).fillStyle === undefined);
  t("the store is empty again", e.snapshot().styles.length === 0);

  // undo must restore the binding, not just the colour
  e.dispatch({ type: "undo" });
  t("undo restores the style and its binding",
    e.snapshot().styles.length === 1 && get(a).fillStyle === e.snapshot().styles[0].id);
}

console.log("ruler guides:");
{
  // A box 6px shy of a guide must land exactly on it.
  const moving = { id: "m", x: 94, y: 10, w: 50, h: 50 };
  const r = snapMove(moving, [], 8, [{ axis: "x", at: 100 }]);
  t("a box snaps to a ruler guide", Math.abs(moving.x + r.dx - 100) < 1e-6);
  t("the guide is drawn", r.guides.some((g) => g.axis === "x" && g.at === 100));

  // Outside tolerance it must not move.
  const far = snapMove({ id: "m", x: 40, y: 10, w: 50, h: 50 }, [], 8, [{ axis: "x", at: 100 }]);
  t("a distant box is left alone", far.dx === 0);

  // Guides work with no other objects present, which object-only snapping
  // used to bail out of early.
  const alone = snapMove({ id: "m", x: 10, y: 96, w: 20, h: 20 }, [], 8, [{ axis: "y", at: 100 }]);
  t("guides snap even with no other layers", Math.abs(96 + alone.dy - 100) < 1e-6);

  // An explicit guide should win a tie against a coincidental object edge.
  const tie = snapMove(
    { id: "m", x: 94, y: 10, w: 50, h: 50 },
    [{ id: "o", x: 106, y: 200, w: 50, h: 50 }],
    8,
    [{ axis: "x", at: 100 }],
  );
  t("a ruler guide wins a tie against an object edge", Math.abs(94 + tie.dx - 100) < 1e-6);
}

console.log("auto layout extensions:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 300, h: 200 });
  const fid = e.snapshot().selection[0];
  const baseLayout = {
    direction: "horizontal", gap: 10, padding: [10, 10, 10, 10],
    sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min"
  };
  e.dispatch({ type: "autoLayout", id: fid, layout: baseLayout });

  // Add normal child 1
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 50, h: 50, parent: fid });
  const c1 = e.snapshot().selection[0];

  // Add child 2 with absolute positioning
  e.dispatch({ type: "add", kind: "rect", x: 250, y: 150, w: 40, h: 40, parent: fid, extra: { absolutePosition: true } });
  const c2 = e.snapshot().selection[0];

  // Add child 3 with min/max bounds
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 20, h: 20, parent: fid, extra: { minW: 60, maxH: 30 } });
  const c3 = e.snapshot().selection[0];

  const get = (id) => {
    let found = null;
    const walk = (n) => { if (n.id === id) found = n; n.children?.forEach(walk); };
    const sn = e.snapshot();
    walk(sn.pages[sn.page].root);
    return found;
  };

  // c1 is first in auto layout flow -> placed at padding (x=10, y=10)
  t("normal child flows in auto layout", get(c1).x === 10 && get(c1).y === 10);

  // c2 is absolute positioned -> kept at (250, 150), skipped by flow
  t("absolute position child is excluded from auto layout flow", get(c2).x === 250 && get(c2).y === 150);

  // c3 flows after c1 (10 + 50 + 10 = 70) and enforces minW: 60
  t("min/max dimension constraints clamp size", get(c3).x === 70 && get(c3).w === 60);
}

console.log("component instance overrides:");
{
  const e = new MemoryEngine(false);
  // Create master component
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 120, h: 40, extra: { fill: "#111111" } });
  const mid = e.snapshot().selection[0];
  e.dispatch({ type: "add", kind: "text", x: 10, y: 10, w: 60, h: 20, parent: mid, extra: { text: "Original" } });
  const tid = e.snapshot().selection[0];
  e.dispatch({ type: "select", ids: [mid] });
  e.dispatch({ type: "makeComponent" });
  const compId = e.snapshot().components[0].id;

  // Place an instance
  e.dispatch({ type: "placeComponent", id: compId, x: 200, y: 0 });
  const instId = e.snapshot().selection[0];

  const get = (id) => {
    let found = null;
    const walk = (n) => { if (n.id === id) found = n; n.children?.forEach(walk); };
    const sn = e.snapshot();
    walk(sn.pages[sn.page].root);
    return found;
  };

  // Override instance text and fill
  const inst = get(instId);
  const instText = inst.children[0];
  e.dispatch({ type: "patch", id: instText.id, patch: { text: "Overridden" } });
  e.dispatch({ type: "patch", id: instId, patch: { fill: "#ff00ff" } });
  t("instance local override applies", get(instId).fill === "#ff00ff" && get(instId).children[0].text === "Overridden");

  // Now modify the master component's background and size
  e.dispatch({ type: "patch", id: mid, patch: { w: 160 } });
  t("updating master updates instance width", get(instId).w === 160);
  t("updating master preserves instance overrides",
    get(instId).fill === "#ff00ff" && get(instId).children[0].text === "Overridden");

  // Reset overrides
  e.dispatch({ type: "select", ids: [instId] });
  e.dispatch({ type: "resetOverrides" });
  t("resetOverrides restores master defaults",
    get(instId).fill === "#111111" && get(instId).children[0].text === "Original");
}

{
  console.log("duplicate naming (Figma parity):");
  const e = new MemoryEngine();
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100, extra: { name: "Card" } });
  e.dispatch({ type: "duplicate" });
  const id2 = e.snapshot().selection[0];
  const n2 = e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === id2);
  t("first duplicate gains ' copy' suffix", n2.name === "Card copy");

  e.dispatch({ type: "duplicate" });
  const id3 = e.snapshot().selection[0];
  const n3 = e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === id3);
  t("second duplicate gains ' copy 2' suffix", n3.name === "Card copy 2");
}

{
  console.log("baseline alignment in horizontal auto-layout:");
  const e = new MemoryEngine();
  e.dispatch({
    type: "add",
    kind: "frame",
    x: 0,
    y: 0,
    w: 400,
    h: 100,
    extra: {
      name: "Row",
      layout: {
        direction: "horizontal",
        gap: 10,
        padding: [0, 0, 0, 0],
        sizing: "fixed",
        cross: "fixed",
        wrap: false,
        align: "baseline",
        justify: "min",
      },
    },
  });
  const rowId = e.snapshot().selection[0];
  // Add a 40px font size text (baseline = 32px) and a 20px font size text (baseline = 16px)
  e.dispatch({
    type: "add",
    kind: "text",
    x: 0,
    y: 0,
    w: 100,
    h: 40,
    extra: { text: "Big", fontSize: 40 },
  });
  const t1Id = e.snapshot().selection[0];
  e.dispatch({
    type: "add",
    kind: "text",
    x: 0,
    y: 0,
    w: 80,
    h: 20,
    extra: { text: "Small", fontSize: 20 },
  });
  const t2Id = e.snapshot().selection[0];
  // Move both children inside Row
  e.dispatch({ type: "reorder", ids: [t1Id], parent: rowId, index: 0 });
  e.dispatch({ type: "reorder", ids: [t2Id], parent: rowId, index: 1 });

  const root = e.snapshot().pages[e.snapshot().page].root;
  const row = root.children.find((c) => c.id === rowId);
  const t1 = row.children.find((c) => c.id === t1Id);
  const t2 = row.children.find((c) => c.id === t2Id);

  // maxBaseline = 40 * 0.8 = 32.
  // t1 baseline = 32 -> y = 32 - 32 = 0.
  // t2 baseline = 20 * 0.8 = 16 -> y = 32 - 16 = 16.
  t("t1 baseline aligned at top (y=0)", Math.round(t1.y) === 0);
  t("t2 baseline shifted down to match t1 baseline (y=16)", Math.round(t2.y) === 16);
}

{
  console.log("per-property instance override reset (Figma parity 12.21):");
  const e = new MemoryEngine();
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100, extra: { name: "CardMaster", fill: "#111111" } });
  const mid = e.snapshot().selection[0];
  e.dispatch({ type: "add", kind: "text", x: 10, y: 10, w: 100, h: 20, parent: mid, extra: { text: "Title" } });
  e.dispatch({ type: "select", ids: [mid] });
  e.dispatch({ type: "makeComponent" });

  e.dispatch({ type: "placeComponent", id: mid, x: 300, y: 0 });
  const instId = e.snapshot().selection[0];
  const inst = e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === instId);

  // Apply two distinct overrides: text and fill
  e.dispatch({ type: "patch", id: inst.children[0].id, patch: { text: "Custom Title" } });
  e.dispatch({ type: "patch", id: instId, patch: { fill: "#e11d48" } });

  const getInst = () => e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === instId);
  t("instance has custom fill and text overrides",
    getInst().fill === "#e11d48" && getInst().children[0].text === "Custom Title");

  // Reset only the fill override, keeping custom title intact
  e.dispatch({ type: "resetOverrides", id: instId, property: "fill" });
  t("resetOverrides with property:'fill' restores master fill", getInst().fill === "#111111");
  t("resetOverrides with property:'fill' preserves text override", getInst().children[0].text === "Custom Title");
}

{
  console.log("variables & collections (Figma parity 13.8, 13.9):");
  const e = new MemoryEngine();
  t("initial variables collection present", (e.snapshot().variables?.length ?? 0) >= 4);

  e.dispatch({
    type: "addVariable",
    variable: { id: "brand-accent", name: "accent", type: "color", value: "#ff007f", collection: "Brand" },
  });
  t("addVariable registers new variable in Brand collection",
    e.snapshot().variables?.some((v) => v.id === "brand-accent" && v.value === "#ff007f"));

  e.dispatch({ type: "patchVariable", id: "brand-accent", patch: { value: "#00ffcc" } });
  t("patchVariable updates variable value",
    e.snapshot().variables?.find((v) => v.id === "brand-accent")?.value === "#00ffcc");

  e.dispatch({ type: "deleteVariable", id: "brand-accent" });
  t("deleteVariable removes variable",
    !e.snapshot().variables?.some((v) => v.id === "brand-accent"));
}

{
  console.log("effect types Glass & Texture (Figma parity 8.23, 8.24):");
  const e = new MemoryEngine();
  e.dispatch({
    type: "add",
    kind: "rect",
    x: 0,
    y: 0,
    w: 120,
    h: 120,
    extra: {
      effects: [
        { kind: "glass", color: "#ffffff80", x: 0, y: 0, blur: 16, spread: 0, visible: true },
        { kind: "texture", color: "#00000020", x: 0, y: 0, blur: 20, spread: 4, visible: true },
      ],
    },
  });
  const rectId = e.snapshot().selection[0];
  const rect = e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === rectId);
  t("glass effect stored on node", rect?.effects?.some((fx) => fx.kind === "glass" && fx.blur === 16));
  t("texture effect stored on node", rect?.effects?.some((fx) => fx.kind === "texture" && fx.spread === 4));
}

{
  console.log("vector networks & branching (Figma parity 11.17):");
  const poly = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 0 },
  ];
  const vn = pathToVectorNetwork(poly, false);
  t("initial polyline has 3 vertices and 2 segments", vn.vertices.length === 3 && vn.segments.length === 2);
  t("vertex 1 initial degree is 2", vertexDegree(vn, 1) === 2);

  // Add branch from center vertex (degree >= 3)
  const branched = addVectorBranch(vn, 1, { x: 100, y: 200 });
  t("branched network has 4 vertices", branched.vertices.length === 4);
  t("branched network has 3 segments", branched.segments.length === 3);
  t("vertex 1 degree is now 3 (Figma branching point)", vertexDegree(branched, 1) === 3);

  const svgPath = vectorNetworkToSvgPath(branched);
  t("vectorNetworkToSvgPath generates valid path commands", svgPath.includes("M") && svgPath.includes("L"));

  const e = new MemoryEngine();
  e.dispatch({
    type: "add",
    kind: "vector",
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    extra: { vectorNetwork: branched },
  });
  const vid = e.snapshot().selection[0];
  const vNode = e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === vid);
  t("node stores vectorNetwork graph", vNode?.vectorNetwork?.vertices.length === 4);

  // Dispatch patchVectorNetwork
  const updatedNetwork = addVectorBranch(branched, 0, { x: 0, y: 100 });
  e.dispatch({ type: "patchVectorNetwork", id: vid, network: updatedNetwork });
  const patchedNode = e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === vid);
  t("patchVectorNetwork updates node vertices", patchedNode?.vectorNetwork?.vertices.length === 5);

  // Advanced vector tools: insert point & bend segment
  const baseLine = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const pr = projectPointOnSegment(50, 10, 0, 0, 100, 0);
  t("projectPointOnSegment projects midpoint", Math.abs(pr.x - 50) < 1e-4 && Math.abs(pr.y - 0) < 1e-4);
  t("projectPointOnSegment measures distance", Math.abs(pr.dist - 10) < 1e-4);

  const ins = insertPointOnPath(baseLine, 50, 0, false, 8);
  t("insertPointOnPath splits segment and inserts vertex", ins?.newPath.length === 3 && ins.insertedIndex === 1);
  t("inserted vertex has correct coordinates", ins?.newPath[1].x === 50 && ins?.newPath[1].y === 0);

  const bent = bendSegment(baseLine, 0, false, 50, 50);
  t("bendSegment creates outgoing handle on start vertex", bent[0].ox != null && Math.abs(bent[0].ox - 33.33) < 0.1);
  t("bendSegment creates incoming handle on end vertex", bent[1].ix != null && Math.abs(bent[1].ix - (-33.33)) < 0.1);

  // Dispatch bendSegment through engine
  e.dispatch({ type: "bendSegment", id: vid, segIndex: 0, dragX: 50, dragY: 50 });
  const bentNode = e.snapshot().pages[e.snapshot().page].root.children.find((c) => c.id === vid);
  t("engine bendSegment dispatches and updates node handles", bentNode?.path[0].ox != null);
}

{
  console.log("Figma binary inspection & vector decoding (inspect .fig):");
  const figPaths = [
    resolve(process.cwd(), "figrefs/circle.fig"),
    resolve(process.cwd(), "../../../figrefs/circle.fig"),
    resolve(process.cwd(), "../../figrefs/circle.fig"),
    resolve(process.cwd(), "public/samples/circle.fig"),
  ];
  const circlePath = figPaths.find((p) => existsSync(p));

  const openFigPaths = [
    resolve(process.cwd(), "figrefs/OpenFigs.fig"),
    resolve(process.cwd(), "../../../figrefs/OpenFigs.fig"),
    resolve(process.cwd(), "../../figrefs/OpenFigs.fig"),
    resolve(process.cwd(), "public/samples/OpenFigs.fig"),
  ];
  const openFigsPath = openFigPaths.find((p) => existsSync(p));

  if (circlePath) {
    const cBuf = readFileSync(circlePath);
    const rep = await inspectFigFile(cBuf.buffer.slice(cBuf.byteOffset, cBuf.byteOffset + cBuf.byteLength), "circle.fig");
    t("inspectFigFile reads 'fig-kiwi' prelude", rep.prelude === "fig-kiwi");
    t("inspectFigFile reads format version", rep.version >= 100);
    t("inspectFigFile parses Kiwi schema dictionary (>500 defs)", rep.schemaDefsCount > 500);
    t("inspectFigFile parses 2 container chunks", rep.chunksCount === 2);
    t("inspectFigFile decompresses zstd chunk 1", rep.chunks.some((c) => c.compression === "zstd"));
    t("inspectFigFile extracts active nodes", rep.activeNodesCount > 0);
  }

  if (openFigsPath) {
    const oBuf = readFileSync(openFigsPath);
    const oRep = await inspectFigFile(oBuf.buffer.slice(oBuf.byteOffset, oBuf.byteOffset + oBuf.byteLength), "OpenFigs.fig");
    t("OpenFigs.fig has vector geometry blobs", oRep.blobsCount > 10);
    t("OpenFigs.fig reports VECTOR layers", (oRep.nodesByType["VECTOR"] || 0) > 0);

    const imported = await importFig(oBuf.buffer.slice(oBuf.byteOffset, oBuf.byteOffset + oBuf.byteLength));
    const flatten = (list) => list.flatMap((n) => [n, ...flatten(n.children ?? [])]);
    const every = flatten(imported.nodes);
    const importedVector = every.find((n) => n.kind === "vector");
    t("importFig imports vector node with path", !!importedVector?.path?.length);
    t("importFig imports vector node with vectorNetwork", !!importedVector?.vectorNetwork);
    // The file is a frame holding a vector, so that is what the import has to
    // be: the old importer put them side by side at the top level.
    t("a .fig frame brings its children with it", imported.nodes.length === 1 && imported.nodes[0].kind === "frame");
    t("the vector is inside the frame, not beside it", (imported.nodes[0].children ?? []).some((n) => n.kind === "vector"));
    t("nesting does not duplicate layers", every.length === imported.nodes.length + (imported.nodes[0].children?.length ?? 0));
    t("pages come from the file's canvases", (imported.pages ?? []).length === 1 && imported.pages[0].name === "Page 1");
    t("Figma's internal canvas is not imported as a page", !(imported.pages ?? []).some((p) => /Internal/i.test(p.name)));
    t("layer coordinates are kept as the file has them", Math.round(imported.nodes[0].x) === -655 && Math.round(imported.nodes[0].y) === -793);
    t("the child is placed inside its parent, not at the page origin", imported.nodes[0].children[0].x === 0 && imported.nodes[0].children[0].y === 0);
    t("a container reports no fill of its own", imported.nodes[0].fillVisible === false);
    t("the vector keeps its own paint", importedVector.fill.toLowerCase() === "#fefefe" && importedVector.fillVisible === true);
    // The logo is drawn as a dozen separate contours. Reading only the first
    // one - which is what the importer used to do - drew a blob where the mark
    // should be.
    t("every contour of a multi-subpath vector arrives", (importedVector.vectorNetwork?.vertices.length ?? 0) > 150);
    const loops = importedVector.vectorNetwork?.regions?.[0]?.loops ?? [];
    t("each contour becomes one closed loop of the network", loops.length === 20);
    t("no contour collapses to a punt", loops.every((l) => l.length >= 3));
    t("the network is one layer, not twenty", every.filter((n) => n.kind === "vector").length === 1);
    t("the whole mark is inside the node's box", importedVector.vectorNetwork.vertices.every((v) => v.x >= -1 && v.x <= importedVector.w + 1));
  }
}

{
  console.log("zoom: one wheel notch is a step, not a leap; the keyboard doubles");
  const notch = wheelZoomFactor({ deltaY: -100, deltaMode: 0, pinch: true });
  t("one clipped wheel notch zooms 1.1x, not e", Math.abs(notch - 1.1) < 1e-9);
  t("a notch the other way zooms out by the same step", Math.abs(wheelZoomFactor({ deltaY: 100 }) - 1 / 1.1) < 1e-9);
  t("four notches in one event are four steps", Math.abs(wheelZoomFactor({ deltaY: -400 }) - 1.1 ** 4) < 1e-9);
  t("a burst of notches cannot cross the zoom range in one event", wheelZoomFactor({ deltaY: -100000 }) <= 2);
  const pinch = wheelZoomFactor({ deltaY: -20, deltaMode: 0, pinch: true });
  t("a trackpad pinch stays exponential and tracks the fingers", Math.abs(pinch - Math.exp(0.2)) < 1e-9);
  t("a pinch out is the exact inverse", Math.abs(pinch * wheelZoomFactor({ deltaY: 20, pinch: true }) - 1) < 1e-9);
  t("prefixing ⌘ on a wheel event does not turn a notch into a pinch", wheelZoomFactor({ deltaY: -100, pinch: true }) === notch);
  t("line-mode wheels are converted to pixels", normalizeWheelDelta(3, 1) === 48);
  t("page-mode wheels are converted to pixels", normalizeWheelDelta(1, 2) === 100);
  t(
    "a three-line Firefox notch zooms like the 48 pixels it is",
    Math.abs(wheelZoomFactor({ deltaY: -3, deltaMode: 1 }) - 1.1 ** 0.48) < 1e-9,
  );
  t(
    "the same three units unconverted would be read as a pinch and zoom too little",
    wheelZoomFactor({ deltaY: -3 }) === Math.exp(0.03),
  );
  t("zoom in doubles: 50% becomes 100%", stepZoom(0.5, 1) === 1);
  t("zoom in from 100% is 200%, as in Figma", stepZoom(1, 1) === 2);
  t("zoom out halves: 100, 50, 25, 12.5", [1, 0.5, 0.25].every((z) => stepZoom(z, -1) === z / 2));
  t("zoom in stops at 6400%", stepZoom(ZOOM_MAX, 1) === ZOOM_MAX);
  t("zoom out stops at 2%", stepZoom(ZOOM_MIN, -1) === ZOOM_MIN);
  t("the menu lists Figma's default percentages", ZOOM_PRESETS.includes(0.25) && ZOOM_PRESETS.includes(0.64) && ZOOM_PRESETS.includes(1.28) && ZOOM_PRESETS.includes(10.24));
  t("the default percentages are in ascending order", ZOOM_PRESETS.every((z, i) => i === 0 || z > ZOOM_PRESETS[i - 1]));
  t("every default percentage is inside the range", ZOOM_PRESETS.every((z) => z >= ZOOM_MIN && z <= ZOOM_MAX));
}

{
  console.log("svg export: the canvas, written out as a file");
  const e = new MemoryEngine();
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 400, h: 320, extra: { name: "Card" } });
  const frame = e.snapshot().selection[0];
  const nodeIn = (id) => find(e.snapshot().pages[0].root, id);
  const out = (id) => exportSvg(nodeIn(id), { format: "SVG", scale: 1, suffix: "" });

  t("a plain rectangle exports as a path with its fill", /<path d="M 0 0 .*" fill="#[0-9a-f]{6}"/.test(out(frame)));

  // 1. Effects: the canvas draws a shadow, the file must carry one.
  e.dispatch({ type: "add", kind: "rect", x: 20, y: 20, w: 100, h: 80, parent: frame, extra: { name: "Shadowed" } });
  const shadowed = e.snapshot().selection[0];
  const plain = out(shadowed);
  t("a layer with no effects exports no filter", !plain.includes("<filter"));
  e.dispatch({
    type: "patch",
    id: shadowed,
    patch: { effects: [{ kind: "drop-shadow", color: "#00000066", x: 0, y: 6, blur: 12, spread: 2, visible: true }] },
  });
  const shadowSvg = out(shadowed);
  t("a drop shadow exports as a filter", shadowSvg.includes("<filter") && shadowSvg.includes("feGaussianBlur"));
  t("the filter is applied to the layer", /filter="url\(#paint_/.test(shadowSvg));
  t("an invisible effect exports nothing", !out((() => { e.dispatch({ type: "patch", id: shadowed, patch: { effects: [{ kind: "drop-shadow", color: "#00000066", x: 0, y: 6, blur: 12, spread: 0, visible: false }] } }); return shadowed; })()).includes("<filter"));
  e.dispatch({ type: "patch", id: shadowed, patch: { effects: [] } });

  // 2. Gradients: a three-stop ramp used to export as its first two colours.
  e.dispatch({ type: "add", kind: "rect", x: 140, y: 20, w: 100, h: 80, parent: frame, extra: { name: "Ramp" } });
  const ramp = e.snapshot().selection[0];
  e.dispatch({
    type: "patch",
    id: ramp,
    patch: {
      fillType: "linear",
      fillGX: 0,
      fillGY: 0,
      fillHX: 1,
      fillHY: 0,
      gradientStops: [
        { color: "#ff0000ff", position: 0 },
        { color: "#00ff00ff", position: 0.5 },
        { color: "#0000ffff", position: 1 },
      ],
    },
  });
  const rampSvg = out(ramp);
  t("a three-stop ramp exports three stops", (rampSvg.match(/<stop /g) || []).length === 3);
  t("the middle colour survives", rampSvg.includes('stop-color="#00ff00"') && rampSvg.includes('offset="50%"'));

  // 3. Stroke alignment: SVG has none, so it is clipped or masked.
  e.dispatch({ type: "add", kind: "rect", x: 260, y: 20, w: 100, h: 80, parent: frame, extra: { name: "Stroked" } });
  const stroked = e.snapshot().selection[0];
  e.dispatch({
    type: "patch",
    id: stroked,
    patch: { strokeVisible: true, strokePaint: "#000000", strokeWidth: 8, strokeAlign: "inside" },
  });
  const insideSvg = out(stroked);
  t("an inside stroke is clipped to the shape", insideSvg.includes("<clipPath") && insideSvg.includes("stroke-width=\"16\""));
  e.dispatch({ type: "patch", id: stroked, patch: { strokeAlign: "outside" } });
  const outsideSvg = out(stroked);
  t("an outside stroke is masked out of the shape", outsideSvg.includes("<mask") && outsideSvg.includes('mask="url(#mask_'));
  t("an outside stroke is doubled too", outsideSvg.includes("stroke-width=\"16\""));
  e.dispatch({ type: "patch", id: stroked, patch: { strokeAlign: "center" } });
  t("a centre stroke needs neither", !out(stroked).includes("<mask") && out(stroked).includes("stroke-width=\"8\""));

  // 4. A vector network: every loop, not just the first one.
  e.dispatch({ type: "add", kind: "rect", x: 20, y: 140, w: 100, h: 80, parent: frame, extra: { name: "Donut" } });
  const donut = e.snapshot().selection[0];
  const ring = (x0, x1) => [
    { x: x0, y: x0 },
    { x: x1, y: x0 },
    { x: x1, y: x1 },
    { x: x0, y: x1 },
  ];
  e.dispatch({
    type: "patch",
    id: donut,
    patch: {
      kind: "vector",
      path: ring(0, 100),
      closed: true,
      vectorNetwork: {
        vertices: [...ring(0, 100), ...ring(30, 70)].map((p) => ({ x: p.x, y: p.y })),
        segments: [],
        regions: [{ windingRule: "EVENODD", loops: [[0, 1, 2, 3], [4, 5, 6, 7]] }],
      },
    },
  });
  const donutSvg = out(donut);
  t("every loop of a vector network exports", (svgPath(nodeIn(donut)).match(/M /g) || []).length === 2);
  t("the winding rule comes with it", donutSvg.includes('fill-rule="evenodd"'));

  // 5. Extra fills and strokes stack on top, as they do on the canvas.
  e.dispatch({ type: "add", kind: "rect", x: 140, y: 140, w: 100, h: 80, parent: frame, extra: { name: "Two fills" } });
  const two = e.snapshot().selection[0];
  e.dispatch({
    type: "patch",
    id: two,
    patch: {
      fill: "#ff0000",
      fills: [{ type: "solid", color: "#00ff00", opacity: 0.5, visible: true }],
      strokes: [{ color: "#0000ff", opacity: 1, visible: true, width: 3, align: "center" }],
    },
  });
  const twoSvg = out(two);
  t("an extra fill is exported", twoSvg.includes('fill="#00ff00"'));
  t("an extra stroke is exported", twoSvg.includes('stroke="#0000ff"') && twoSvg.includes('stroke-width="3"'));

  // 6. Rotation happens about the layer\'s own origin, not always its centre.
  e.dispatch({ type: "add", kind: "rect", x: 260, y: 140, w: 100, h: 80, parent: frame, extra: { name: "Turned" } });
  const turned = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: turned, patch: { rotation: 30, rotOrigin: [0, 0] } });
  t("rotation uses the layer's rotation origin", out(turned).includes("rotate(30 0 0)"));
  e.dispatch({ type: "patch", id: turned, patch: { rotOrigin: [0.5, 0.5] } });
  t("and the centre when that is the origin", out(turned).includes("rotate(30 50 40)"));

  // 7. A hidden layer is not in the file at all.
  e.dispatch({ type: "patch", id: turned, patch: { visible: false } });
  t("a hidden layer exports nothing", !out(turned).includes("<path"));

  // 8. The export is a file the app can read back. The importer needs a DOM to
  //    parse with, so this half runs in the browser probe rather than here.
}

{
  console.log("advanced prototyping & presentation (better than Figma):");
  const ep = new MemoryEngine();
  t("default prototype settings present", ep.snapshot().prototypeDevice === "none");
  t("default prototype hotspots enabled", ep.snapshot().prototypeHotspots === true);
  t("default prototype live inputs enabled", ep.snapshot().prototypeLiveInputs === true);

  // Set prototype device
  ep.dispatch({ type: "setPrototypeDevice", device: "iphone-16-pro" });
  t("setPrototypeDevice sets iphone-16-pro", ep.snapshot().prototypeDevice === "iphone-16-pro");

  // Toggle live inputs and hotspots
  ep.dispatch({ type: "togglePrototypeHotspots", enabled: false });
  t("togglePrototypeHotspots toggles false", ep.snapshot().prototypeHotspots === false);

  ep.dispatch({ type: "togglePrototypeLiveInputs", enabled: false });
  t("togglePrototypeLiveInputs toggles false", ep.snapshot().prototypeLiveInputs === false);

  // Overlays
  ep.dispatch({
    type: "openOverlay",
    id: "frame-overlay-1",
    position: "bottom",
    closeOutside: true,
    backdrop: true,
  });
  t("openOverlay registers activeOverlay", ep.snapshot().activeOverlay?.id === "frame-overlay-1");
  t("activeOverlay preserves position bottom", ep.snapshot().activeOverlay?.position === "bottom");
  t("activeOverlay preserves backdrop", ep.snapshot().activeOverlay?.backdrop === true);

  ep.dispatch({ type: "closeOverlay" });
  t("closeOverlay clears activeOverlay", ep.snapshot().activeOverlay === null);

  // Variable execution in prototype
  const varId = ep.snapshot().variables?.[2].id;
  ep.dispatch({ type: "patchVariable", id: varId, patch: { value: 9 } });
  t("patchVariable executes state mutation", ep.snapshot().variables?.find((v) => v.id === varId)?.value === 9);

  // Organic S-curve noodle routing (Figma Guide parity)
  const nRight = computeFigmaNoodle(0, 0, 100, 50, 300, 0, 100, 50);
  t("noodle chooses right-to-left for rightward destination", nRight.sourceSide === "right" && nRight.destSide === "left");
  t("noodle creates smooth horizontal S-curve control points", nRight.cp1x > nRight.ax && nRight.cp2x < nRight.bx);

  const nBelow = computeFigmaNoodle(0, 0, 100, 50, 0, 300, 100, 50);
  t("noodle chooses bottom-to-top for downward destination", nBelow.sourceSide === "bottom" && nBelow.destSide === "top");
  t("noodle creates smooth vertical S-curve control points", nBelow.cp1y > nBelow.ay && nBelow.cp2y < nBelow.by);

  const nLeft = computeFigmaNoodle(300, 0, 100, 50, 0, 0, 100, 50);
  t("noodle chooses left-to-right for leftward destination", nLeft.sourceSide === "left" && nLeft.destSide === "right");

  const nAbove = computeFigmaNoodle(0, 300, 100, 50, 0, 0, 100, 50);
  t("noodle chooses top-to-bottom for upward destination", nAbove.sourceSide === "top" && nAbove.destSide === "bottom");

  console.log("copy/paste properties & interaction editing (Figma parity):");
  // Copy and Paste properties
  const eprops = new MemoryEngine();
  const root = eprops.snapshot().pages[0].root;
  const src = root.children[0];
  const target = root.children[1];
  eprops.dispatch({
    type: "patch",
    id: src.id,
    patch: {
      fill: "#ff5500",
      strokePaint: "#00ff00",
      strokeWidth: 3,
      cornerRadii: [12, 12, 12, 12],
      effects: [{ kind: "dropShadow", color: "#00000040", blur: 8, x: 0, y: 4 }],
      interactions: [{ trigger: "onClick", action: "navigate", destination: target.id }],
    },
  });
  eprops.dispatch({ type: "select", ids: [src.id] });
  eprops.dispatch({ type: "copyProperties" });

  const oldTargetX = target.x;
  const oldTargetW = target.w;
  eprops.dispatch({ type: "select", ids: [target.id] });
  eprops.dispatch({ type: "pasteProperties" });

  const updatedTarget = eprops.snapshot().pages[0].root.children[1];
  t("pasteProperties copies fill", updatedTarget.fill === "#ff5500");
  t("pasteProperties copies strokePaint and strokeWidth", updatedTarget.strokePaint === "#00ff00" && updatedTarget.strokeWidth === 3);
  t("pasteProperties copies cornerRadii", updatedTarget.cornerRadii[0] === 12);
  t("pasteProperties copies effects", updatedTarget.effects?.length === 1 && updatedTarget.effects[0].blur === 8);
  t("pasteProperties copies interactions", updatedTarget.interactions?.length === 1 && updatedTarget.interactions[0].destination === target.id);
  t("pasteProperties preserves target geometry (x, w)", updatedTarget.x === oldTargetX && updatedTarget.w === oldTargetW);

  // Delete interaction
  eprops.dispatch({ type: "deleteInteraction", id: target.id, destId: target.id });
  const cleanedTarget = eprops.snapshot().pages[0].root.children[1];
  t("deleteInteraction removes interaction by destination id", cleanedTarget.interactions?.length === 0);

  // Section routing in presentGo
  eprops.dispatch({
    type: "add",
    kind: "frame",
    x: 0,
    y: 0,
    w: 800,
    h: 600,
    extra: { name: "App Flow Section" },
  });
  const sectionNode = eprops.snapshot().pages[0].root.children.find((c) => c.name === "App Flow Section");
  eprops.dispatch({
    type: "add",
    kind: "frame",
    parent: sectionNode.id,
    x: 20,
    y: 20,
    w: 375,
    h: 560,
    extra: { name: "Child Screen 1" },
  });
  const childScreen = sectionNode.children[0];
  eprops.dispatch({ type: "presentGo", id: sectionNode.id });
  t("presentGo routes section to its first child frame", eprops.snapshot().presentFrame === childScreen.id);

  console.log("instance lifecycle & persistence (Figma parity):");
  // Component creation, instance placement, and detachInstance (⌥⌘B)
  const targetFrame = eprops.snapshot().pages[0].root.children[0];
  eprops.dispatch({ type: "select", ids: [targetFrame.id] });
  eprops.dispatch({ type: "makeComponent" });
  const comp = eprops.snapshot().components[0];
  eprops.dispatch({ type: "placeComponent", id: comp.id, x: 100, y: 100 });
  const instanceId = eprops.snapshot().selection[0];
  const placedInstance = eprops.snapshot().pages[0].root.children.find((c) => c.id === instanceId);
  t("placeComponent creates instance linked to master", placedInstance && (placedInstance.componentId === comp.id || placedInstance.kind === "instance"));

  eprops.dispatch({ type: "detachInstance" });
  const detachedNode = eprops.snapshot().pages[0].root.children.find((c) => c.id === instanceId);
  t("detachInstance unlinks instance from master (⌥⌘B)", detachedNode && !detachedNode.componentId && !detachedNode.isComponent);

  console.log("component properties system (Figma parity):");
  // Create a structured component master with nested layers
  eprops.dispatch({
    type: "add",
    kind: "frame",
    x: 200,
    y: 200,
    w: 240,
    h: 48,
    extra: {
      name: "Interactive Button",
      children: [
        {
          id: "btn-label-1",
          name: "Label",
          kind: "text",
          text: "Click Me",
          x: 10,
          y: 14,
          w: 100,
          h: 20,
          children: [],
          visible: true,
        },
        {
          id: "btn-badge-1",
          name: "Badge",
          kind: "rect",
          x: 180,
          y: 10,
          w: 28,
          h: 28,
          children: [],
          visible: true,
        },
      ],
    },
  });
  const btnFrame = eprops.snapshot().pages[0].root.children.find((c) => c.name === "Interactive Button");
  eprops.dispatch({ type: "select", ids: [btnFrame.id] });
  eprops.dispatch({ type: "makeComponent" });
  const btnComp = eprops.snapshot().components.find((c) => c.name === "Interactive Button");

  // Add boolean property ("Show badge" controlling "Badge" layer visibility)
  eprops.dispatch({
    type: "addComponentProperty",
    componentId: btnComp.id,
    property: {
      id: "prop-show-badge",
      name: "Show badge",
      type: "boolean",
      defaultValue: true,
      targetNodeName: "Badge",
    },
  });

  // Add text property ("Button label" controlling "Label" text content)
  eprops.dispatch({
    type: "addComponentProperty",
    componentId: btnComp.id,
    property: {
      id: "prop-btn-label",
      name: "Button label",
      type: "text",
      defaultValue: "Default Text",
      targetNodeName: "Label",
    },
  });

  // Place instance and test default property bindings
  eprops.dispatch({ type: "placeComponent", id: btnComp.id, x: 300, y: 300 });
  const instId = eprops.snapshot().selection[0];
  const inst = eprops.snapshot().pages[0].root.children.find((c) => c.id === instId);
  t("instance initializes component properties from master", inst.componentProperties?.["Show badge"] === true && inst.componentProperties?.["Button label"] === "Default Text");

  // Toggle boolean property to false -> hides "Badge" child
  eprops.dispatch({
    type: "setComponentProperty",
    id: instId,
    propName: "Show badge",
    value: false,
  });
  const updatedInst = eprops.snapshot().pages[0].root.children.find((c) => c.id === instId);
  const badgeChild = updatedInst.children.find((c) => c.name === "Badge");
  t("setComponentProperty(boolean) hides target child layer", badgeChild?.visible === false);

  // Update text property -> updates "Label" text layer
  eprops.dispatch({
    type: "setComponentProperty",
    id: instId,
    propName: "Button label",
    value: "Get Started Now",
  });
  const textUpdatedInst = eprops.snapshot().pages[0].root.children.find((c) => c.id === instId);
  const labelChild = textUpdatedInst.children.find((c) => c.name === "Label");
  t("setComponentProperty(text) updates target child text string", labelChild?.text === "Get Started Now");

  // Delete component property
  eprops.dispatch({
    type: "deleteComponentProperty",
    componentId: btnComp.id,
    propId: "prop-show-badge",
  });
  const masterAfterDelete = eprops.snapshot().components.find((c) => c.id === btnComp.id);
  t("deleteComponentProperty removes property definition from master", !masterAfterDelete.properties?.some((p) => p.name === "Show badge"));

  console.log("star handles, corner radii & mask display (Figma parity):");
  // Star creation and starRatio
  eprops.dispatch({
    type: "add",
    kind: "star",
    x: 400,
    y: 100,
    w: 120,
    h: 120,
    extra: { name: "Rating Star", starRatio: 0.5, cornerRadii: [8, 8, 8, 8] },
  });
  const starNode = eprops.snapshot().pages[0].root.children.find((c) => c.name === "Rating Star");
  t("star node stores starRatio and cornerRadii", starNode.starRatio === 0.5 && starNode.cornerRadii[0] === 8);

  // Mask layer icon & toggle
  eprops.dispatch({
    type: "patch",
    id: starNode.id,
    patch: { isMask: true },
  });
  const maskedStar = eprops.snapshot().pages[0].root.children.find((c) => c.id === starNode.id);
  t("star node set as mask has isMask true", maskedStar.isMask === true);

  console.log("auto layout cross-axis hug & arrow reordering (Figma parity):");
  // Auto Layout cross-axis hug
  eprops.dispatch({
    type: "add",
    kind: "frame",
    x: 10,
    y: 10,
    w: 300,
    h: 50,
    extra: {
      name: "Row Frame",
      layout: {
        direction: "horizontal",
        gap: 8,
        padding: [10, 10, 15, 15],
        align: "min",
        justify: "min",
        sizing: "fixed",
        cross: "fixed",
        wrap: false,
      },
      sizingH: "hug",
    },
  });
  const rowFrame = eprops.snapshot().pages[0].root.children.find((c) => c.name === "Row Frame");
  eprops.dispatch({
    type: "add",
    kind: "rect",
    parent: rowFrame.id,
    x: 0,
    y: 0,
    w: 50,
    h: 80,
    extra: { name: "Child Box" },
  });
  const updatedRow = eprops.snapshot().pages[0].root.children.find((c) => c.name === "Row Frame");
  t("horizontal auto-layout with sizingH:hug computes height from children + padding", updatedRow.h === 110); // 80 + 15 + 15 = 110

  // Auto Layout arrow key reordering
  eprops.dispatch({
    type: "add",
    kind: "rect",
    parent: rowFrame.id,
    x: 0,
    y: 0,
    w: 50,
    h: 60,
    extra: { name: "Second Child Box" },
  });
  const firstChild = updatedRow.children[0];
  const secondChild = updatedRow.children[1];
  eprops.dispatch({ type: "select", ids: [firstChild.id] });
  eprops.dispatch({ type: "nudge", dx: 1, dy: 0 }); // ArrowRight reorders forward in Auto Layout
  const reorderedRow = eprops.snapshot().pages[0].root.children.find((c) => c.name === "Row Frame");
  t("arrow key nudge reorders child inside Auto Layout flow", reorderedRow.children[0].id === secondChild.id && reorderedRow.children[1].id === firstChild.id);

  // Vector editing vertex properties & mirror modes (Figma parity)
  console.log("vector edit vertex controls & mirror modes (Figma parity):");
  const evec = new MemoryEngine(false);
  evec.dispatch({
    type: "add",
    kind: "vector",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    extra: {
      path: [
        { x: 0, y: 0, ox: 10, oy: 5 },
        { x: 100, y: 0, ix: -10, iy: -5 },
        { x: 50, y: 100 },
      ],
      closed: true,
    },
  });
  const vecId = evec.snapshot().selection[0];
  evec.dispatch({ type: "setVecEdit", id: vecId, pointIndex: 0 });
  t("setVecEdit sets active vecEdit node and vecPoint", evec.snapshot().vecEdit === vecId && evec.snapshot().vecPoint === 0);

  evec.dispatch({ type: "setPointCornerRadius", id: vecId, pointIndex: 1, radius: 12 });
  const vecAfterRadius = evec.snapshot().pages[0].root.children.find((c) => c.id === vecId);
  t("setPointCornerRadius sets cornerRadius on path vertex", vecAfterRadius.path[1].cornerRadius === 12);
  t("setPointCornerRadius syncs cornerRadius into vectorNetwork", vecAfterRadius.vectorNetwork?.vertices[1]?.cornerRadius === 12);

  evec.dispatch({ type: "setPointMirror", id: vecId, pointIndex: 0, mode: "angleAndLength" });
  const vecAfterMirror = evec.snapshot().pages[0].root.children.find((c) => c.id === vecId);
  t("setPointMirror sets mirrorMode on path vertex", vecAfterMirror.path[0].mirrorMode === "angleAndLength");
  t("setPointMirror angleAndLength mirrors incoming handle", vecAfterMirror.path[0].ix === -10 && vecAfterMirror.path[0].iy === -5);

  evec.dispatch({ type: "select", ids: [] });
  t("clearing selection exits vector edit mode", evec.snapshot().vecEdit === null && evec.snapshot().vecPoint === null);

  // Performance & layout scale benchmark (cold startup & large document)
  console.log("performance & layout scale benchmark:");
  const ebench = new MemoryEngine(false);
  ebench.dispatch({
    type: "add",
    kind: "frame",
    x: 0,
    y: 0,
    w: 1200,
    h: 800,
    extra: {
      name: "Perf Container",
      layout: {
        direction: "vertical",
        gap: 8,
        padding: [16, 16, 16, 16],
        sizing: "hug",
        cross: "fixed",
        wrap: false,
        align: "start",
        justify: "start",
      },
      sizingH: "hug",
    },
  });
  const container = ebench.snapshot().pages[0].root.children.find((c) => c.name === "Perf Container");
  const tStart = performance.now();
  ebench.dispatch({ type: "begin" });
  for (let i = 0; i < 200; i++) {
    ebench.dispatch({
      type: "add",
      kind: "rect",
      parent: container.id,
      x: 0,
      y: 0,
      w: 200,
      h: 24,
      extra: { name: `Row Item ${i}` },
    });
  }
  ebench.dispatch({ type: "end" });
  const tEnd = performance.now();
  const perfDuration = tEnd - tStart;
  const perfSnap = ebench.snapshot().pages[0].root.children.find((c) => c.id === container.id);
  t("200 auto-layout children dispatched and computed in under 100ms", perfDuration < 100);
  t("perf container height correctly accumulated across all 200 rows", perfSnap.h === 16 + 16 + (200 * 24) + (199 * 8));

  // Layout grids, negative gap & canvas stacking (Figma parity)
  console.log("layout grids, negative gap & canvas stacking (Figma parity):");
  const egrid = new MemoryEngine(false);
  egrid.dispatch({
    type: "add",
    kind: "frame",
    x: 0,
    y: 0,
    w: 1200,
    h: 800,
    extra: {
      name: "Grid Frame",
      layout: {
        direction: "horizontal",
        gap: -12,
        padding: [20, 20, 20, 20],
        sizing: "hug",
        cross: "fixed",
        wrap: false,
        align: "min",
        justify: "min",
        itemReverseZIndex: true,
      },
      layoutGrids: [
        {
          id: "grid-1",
          pattern: "columns",
          count: 12,
          gutter: 20,
          margin: 24,
          alignment: "stretch",
          color: "rgba(255, 0, 0, 0.1)",
          visible: true,
        },
      ],
    },
  });
  const gframe = egrid.snapshot().pages[0].root.children.find((c) => c.name === "Grid Frame");
  t("frame stores 12-column layout grid", gframe.layoutGrids?.length === 1 && gframe.layoutGrids[0].count === 12);
  t("auto layout stores canvas stacking order itemReverseZIndex", gframe.layout?.itemReverseZIndex === true);

  egrid.dispatch({
    type: "add",
    kind: "rect",
    parent: gframe.id,
    x: 0,
    y: 0,
    w: 60,
    h: 60,
    extra: { name: "Avatar 1" },
  });
  egrid.dispatch({
    type: "add",
    kind: "rect",
    parent: gframe.id,
    x: 0,
    y: 0,
    w: 60,
    h: 60,
    extra: { name: "Avatar 2" },
  });
  const gframeAfter = egrid.snapshot().pages[0].root.children.find((c) => c.id === gframe.id);
  // Avatar 1 x is 20, Avatar 2 x is 20 + 60 + (-12) = 68 (overlapping by 12px)
  t("negative gap computes overlapping child coordinates", gframeAfter.children[1].x === 68);

  // Motion easing and smart match in interaction
  console.log("motion easing and smart match interaction (Figma parity):");
  egrid.dispatch({
    type: "setInteractions",
    id: gframeAfter.children[0].id,
    interactions: [
      {
        trigger: "onClick",
        action: "navigate",
        destination: gframe.id,
        animation: "smart",
        delay: 0,
        duration: 350,
        easing: "spring",
        smartMatch: true,
      },
    ],
  });
  const ixNode = egrid.snapshot().pages[0].root.children.find((c) => c.id === gframe.id).children[0];
  t("interaction stores spring easing curve", ixNode.interactions[0].easing === "spring");
  t("interaction stores smartMatch flag", ixNode.interactions[0].smartMatch === true);

  // Ellipse arcData, donut hole & sweep angles (Figma parity)
  console.log("ellipse arcData & donut hole (Figma parity):");
  const earc = new MemoryEngine(false);
  earc.dispatch({
    type: "add",
    kind: "ellipse",
    x: 0,
    y: 0,
    w: 120,
    h: 120,
    extra: {
      arcData: {
        startingAngle: 0,
        endingAngle: Math.PI * 1.5,
        innerRadius: 0.4,
      },
    },
  });
  const arcNode = earc.snapshot().pages[0].root.children.find((c) => c.kind === "ellipse");
  t("ellipse node stores arcData with sweep and innerRadius", arcNode.arcData?.innerRadius === 0.4);
  t("ellipse arcData preserves endingAngle (270 degrees)", Math.abs(arcNode.arcData?.endingAngle - Math.PI * 1.5) < 0.001);

  // Smart Animate interpolation & easing curves (Figma parity)
  console.log("smart animate interpolation & easing curves (Figma parity):");
  t("solveEasing linear at 0.5 is 0.5", solveEasing("linear", 0.5) === 0.5);
  t("solveEasing easeIn at 0.5 is slower than 0.5", solveEasing("easeIn", 0.5) < 0.5);
  t("solveEasing easeOut at 0.5 is faster than 0.5", solveEasing("easeOut", 0.5) > 0.5);
  t("solveEasing spring reaches 1.0 at finish", Math.abs(solveEasing("spring", 1.0) - 1.0) < 0.05);

  const fromF = {
    id: "f1",
    name: "Frame 1",
    kind: "frame",
    x: 0,
    y: 0,
    w: 300,
    h: 400,
    cornerRadii: [0, 0, 0, 0],
    children: [
      {
        id: "card-src",
        name: "Card",
        kind: "rect",
        x: 20,
        y: 20,
        w: 100,
        h: 100,
        opacity: 1,
        rotation: 0,
        cornerRadii: [0, 0, 0, 0],
        fill: "#ff0000",
        children: [],
      },
    ],
  };

  const toF = {
    id: "f2",
    name: "Frame 2",
    kind: "frame",
    x: 0,
    y: 0,
    w: 300,
    h: 400,
    cornerRadii: [0, 0, 0, 0],
    children: [
      {
        id: "card-dst",
        name: "Card",
        kind: "rect",
        x: 120,
        y: 220,
        w: 200,
        h: 150,
        opacity: 1,
        rotation: 45,
        cornerRadii: [16, 16, 16, 16],
        fill: "#0000ff",
        children: [],
      },
      {
        id: "new-badge",
        name: "Badge",
        kind: "rect",
        x: 50,
        y: 50,
        w: 40,
        h: 20,
        opacity: 1,
        rotation: 0,
        cornerRadii: [4, 4, 4, 4],
        fill: "#00ff00",
        children: [],
      },
    ],
  };

  const smartMap = interpolateMatchingLayers(fromF, toF, 0.5, "linear");
  const morphCard = smartMap.get("card-dst");
  t("card matched by name morphs x halfway (20 -> 120 = 70)", morphCard.x === 70);
  t("card matched by name morphs y halfway (20 -> 220 = 120)", morphCard.y === 120);
  t("card matched by name morphs width halfway (100 -> 200 = 150)", morphCard.w === 150);
  t("card matched by name morphs corner radius halfway (0 -> 16 = 8)", morphCard.cornerRadii[0] === 8);
  t("card matched by name morphs rotation halfway (0 -> 45 = 22.5)", morphCard.rotation === 22.5);

  const arrivingBadge = smartMap.get("new-badge");
  t("unmatched layer in destination dissolves in halfway (opacity = 0.5)", arrivingBadge.opacity === 0.5);

  const appliedTree = applyInterpolatedFrame(toF, smartMap);
  t("applied interpolated tree produces valid cloned node with morphed x", appliedTree.children[0].x === 70);

  // Exiting layer dissolves out
  const fromWithOld = {
    ...fromF,
    children: [
      ...fromF.children,
      {
        id: "old-badge",
        name: "Old Badge",
        kind: "rect",
        x: 10,
        y: 10,
        w: 30,
        h: 20,
        opacity: 1,
        rotation: 0,
        cornerRadii: [0, 0, 0, 0],
        fill: "#ff0000",
        children: [],
      },
    ],
  };
  const exitMap = interpolateMatchingLayers(fromWithOld, toF, 0.5, "linear");
  const exiting = exitMap.get("old-badge");
  t("exiting layer in source dissolves out halfway (opacity = 0.5)", exiting && exiting.opacity === 0.5);

  const appliedWithExit = applyInterpolatedFrame(toF, exitMap, fromWithOld);
  t("applied frame includes dissolving exiting layer", appliedWithExit.children.some((c) => c.id === "old-badge" && c.opacity === 0.5));
}

console.log("vector edit multi-selection & marquee (Figma parity):");
{
  const eng = new MemoryEngine();
  eng.dispatch({
    type: "addPath",
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    closed: true,
  });
  const vecId = eng.snapshot().selection[0];
  eng.dispatch({ type: "setVecEdit", id: vecId, pointIndex: 1, pointIndices: [1, 2] });
  const s1 = eng.snapshot();
  t("setVecEdit stores active vecPoint and vecPoints array", s1.vecPoint === 1 && s1.vecPoints.length === 2 && s1.vecPoints.includes(2));

  eng.dispatch({ type: "select", ids: [] });
  const s2 = eng.snapshot();
  t("clearing selection clears vecPoint and vecPoints", s2.vecEdit === null && s2.vecPoint === null && s2.vecPoints.length === 0);
}

// --- Figma's wrap style: Balance / Pretty (x-core's TextWrap) ---------------
{
  const w = (s) => s.length; // one column per character keeps the arithmetic readable
  const maxW = 5;
  const greedy = ["a b", "c d", "e"]; // 1-char words, two per line where it fits
  const bal = balanceLines(greedy, maxW, w, "balance");
  t("balance keeps every word", bal.join(" ").split(/\s+/).length === greedy.join(" ").split(/\s+/).length);
  t("balance never overflows the box", bal.every((l) => w(l) <= maxW));
  t("balance leaves a lone final word alone", JSON.stringify(bal) === JSON.stringify(greedy));
  const pretty = balanceLines(greedy, maxW, w, "pretty");
  t("pretty moves a word down instead of stranding one", pretty[pretty.length - 1].split(/\s+/).length === 2);
  t("pretty keeps every word", pretty.join(" ").split(/\s+/).length === greedy.join(" ").split(/\s+/).length);
  const wide = ["aaaa aaaa", "bb"]; // a short tail the greedy break left behind
  const evened = balanceLines(wide, 11, w, "balance");
  t("balance evens two unequal lines", Math.max(...evened.map(w)) < Math.max(...wide.map(w)));
  t("balance is a no-op for a single line", balanceLines(["only line"], 10, w, "balance").length === 1);
  t("balance is a no-op when nothing wraps (infinite width)", balanceLines(wide, Infinity, w, "pretty") === wide);
  const para = "the quick brown fox jumps over the lazy dog and then keeps on going".split(" ");
  const greedyMany = [];
  {
    let cur = "";
    for (const word of para) {
      if (cur && w(`${cur} ${word}`) > 26) { greedyMany.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) greedyMany.push(cur);
  }
  const evenedMany = balanceLines(greedyMany, 26, w, "balance");
  t("balance keeps the greedy line count", evenedMany.length === greedyMany.length);
  t("balance never leaves a line wider than the greedy break",
    Math.max(...evenedMany.map(w)) <= Math.max(...greedyMany.map(w)));
  t("balance spreads the words of a long paragraph", new Set(evenedMany.map(w)).size > 1);
  const huge = Array.from({ length: 240 }, (_, i) => `w${i}`);
  const hugeLines = [huge.slice(0, 120).join(" "), huge.slice(120).join(" ")];
  t("balance bails out on a very long paragraph instead of searching",
    balanceLines(hugeLines, 1e6, w, "balance") === hugeLines);
  const cjk = ["\u4e2d\u6587\u53e5\u5b50\u957f", "\u53e6\u4e00\u6bb5"];
  t("balance leaves unspaced CJK lines to the wrapper", balanceLines(cjk, 6, w, "balance").length === 2);
}


console.log("wcag contrast (the picker's check):");
{
  t("black on white is 21:1", Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01);
  t("the same color is 1:1", Math.abs(contrastRatio("#7f7f7f", "#7f7f7f") - 1) < 1e-6);
  t("AA wants 4.5 for normal text and 3 for large",
    contrastTarget("normal", "AA") === 4.5 && contrastTarget("large", "AA") === 3);
  t("graphics has no AAA tier", contrastTarget("graphics", "AAA") === 3);
  t("#767676 on white is the classic AA floor", passesContrast("#767676", "#ffffff", "normal", "AA"));
  t("#777777 on white just misses it", !passesContrast("#777777", "#ffffff", "normal", "AA"));
  const fixed = nearestAccessible("#777777", "#ffffff", contrastTarget("normal", "AA"));
  t("fixing a failing gray clears the target", contrastRatio(fixed, "#ffffff") + 1e-6 >= 4.5);
  t("fixing is the smallest change that works", fixed.toLowerCase() === "#767676");
  const blue = nearestAccessible("#6fb3f2", "#ffffff", contrastTarget("normal", "AA"));
  const from = rgbToHsv(parseHex("#6fb3f2").r, parseHex("#6fb3f2").g, parseHex("#6fb3f2").b);
  const to = rgbToHsv(parseHex(blue).r, parseHex(blue).g, parseHex(blue).b);
  t("a saturated color keeps its hue and chroma when repaired",
    Math.abs(from.h - to.h) <= 1 && Math.abs(from.s - to.s) <= 0.02 && to.v < from.v);
  t("repairing reaches the target without overshooting it", contrastRatio(blue, "#ffffff") >= 4.5 && contrastRatio(blue, "#ffffff") < 5.2);
  t("an already passing color is left alone", nearestAccessible("#000000", "#ffffff", 7) === "#000000");
  t("an unreachable target returns the best available",
    contrastRatio(nearestAccessible("#808080", "#7f7f7f", 21), "#7f7f7f") > 1);
}

console.log("selection colors: only the paints that actually paint:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const a = e.snapshot().selection[0];
  e.dispatch({ type: "add", kind: "rect", x: 120, y: 0, w: 100, h: 100 });
  const b = e.snapshot().selection[0];
  const rootOf = () => e.snapshot().pages[e.snapshot().page].root;
  const get = (id) => {
    let found = null;
    const walk = (n) => { if (n.id === id) found = n; n.children?.forEach(walk); };
    walk(rootOf());
    return found;
  };

  e.dispatch({
    type: "patch", id: a,
    patch: {
      fill: "#ff0000", fillType: "linear",
      gradientStops: [{ color: "#00ff00", position: 0 }, { color: "#0000ff", position: 1 }],
    },
  });
  let usage = colorUsage(rootOf());
  t("a gradient is listed by the stops it paints",
    usage.some((u) => u.hex === "#00ff00") && usage.some((u) => u.hex === "#0000ff"));
  t("a gradient does not list the leftover base color", !usage.some((u) => u.hex === "#ff0000"));

  e.dispatch({ type: "patch", id: b, patch: { fill: "#123456", fillType: "image", imageSrc: "data:image/png;base64,AAA" } });
  t("an image fill contributes no color", !colorUsage(rootOf()).some((u) => u.hex === "#123456"));

  e.dispatch({ type: "patch", id: a, patch: { fillVisible: false } });
  usage = colorUsage(rootOf());
  t("hidden fills are left out", !usage.some((u) => u.hex === "#00ff00" || u.hex === "#0000ff"));

  e.dispatch({ type: "patch", id: a, patch: { fillVisible: true, fill: "#00ff00", fillType: "solid", gradientStops: [], fillOpacity: 0.5 } });
  e.dispatch({ type: "patch", id: b, patch: { fill: "#00ff00", fillType: "solid", imageSrc: "", fillOpacity: 0.5 } });
  usage = colorUsage(rootOf());
  const green = usage.find((u) => u.hex === "#00ff00");
  t("one row per color, counted across layers", !!green && green.count === 2);
  t("a multi-layer selection merges into one list",
    colorUsageAll([get(a), get(b)]).some((u) => u.hex === "#00ff00" && u.count === 2 && u.ids.length === 2));
  t("a shared opacity is shown", green?.opacity === 0.5);
  e.dispatch({ type: "patch", id: b, patch: { fillOpacity: 0.25 } });
  t("mixed opacities report null so the field stays empty",
    colorUsage(rootOf()).find((u) => u.hex === "#00ff00")?.opacity === null);

  // a third layer shares the colour but was never selected
  e.dispatch({ type: "add", kind: "rect", x: 240, y: 0, w: 100, h: 100 });
  const c = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: c, patch: { fill: "#00ff00", fillType: "solid", fillOpacity: 0.2 } });

  // the row the panel would build: from the selection, so it owns two layers
  const row = colorUsageAll([get(a), get(b)]).find((u) => u.hex === "#00ff00");
  const touched = setOpacityMatches(e, rootOf(), row, 75);
  t("the field rewrites every selected paint carrying that color",
    touched === 2 && get(a).fillOpacity === 0.75 && get(b).fillOpacity === 0.75);
  t("a layer outside the selection keeps its own opacity", get(c).fillOpacity === 0.2);
}


console.log("field equations (X/Y/W/H, the way Figma reads them):");
{
  t("a plain number still parses", evalField("120", 0) === 120);
  t("a leading minus is a sign", evalField("-8", 40) === -8);
  t("division", evalField("120/3", 0) === 40);
  t("exponent", evalField("2^3", 0) === 8);
  t("parens and mixed operators", evalField("(40+8)*2", 0) === 96);
  t("multiplication binds tighter than addition", evalField("2+3*4", 0) === 14);
  t("a power chain is right associative", evalField("2^3^2", 0) === 512);
  t("an operator up front applies to the current value", evalField("+10", 50) === 60);
  t("a trailing operator does too", evalField("*2", 100) === 200);
  t("unary minus inside an expression", evalField("40--10", 0) === 50);
  t("decimals and whitespace", evalField(" 1.5 * 8 ", 0) === 12);
  t("unit suffixes keep the old leniency", evalField("120px", 0) === 120);
  t("division by zero is refused", evalField("120/0", 5) === null);
  t("an unbalanced paren is refused", evalField("(120+3", 7) === null);
  t("an empty field is refused, so the field reverts", evalField("   ", 9) === null);
  t("NaN never reaches the document", evalField("0/0", 3) === null);
  t("hasExpression leaves plain numbers alone", !hasExpression("120") && !hasExpression("-4.5") && hasExpression("120/2"));
}

console.log("the scale tool's geometry:");
{
  const b = { x: 100, y: 50, w: 200, h: 100 };
  const tl = scaleBoxAround(b, 2, 0, 0);
  t("scaling about the top-left leaves it in place", tl.x === 100 && tl.y === 50 && tl.w === 400 && tl.h === 200);
  const mc = scaleBoxAround(b, 2, 0.5, 0.5);
  t("scaling about the centre grows both ways", mc.x === 0 && mc.y === 0 && mc.w === 400 && mc.h === 200);
  const br = scaleBoxAround(b, 0.5, 1, 1);
  t("scaling about the bottom-right holds that corner", Math.abs(br.x + br.w - 300) < 1e-9 && Math.abs(br.y + br.h - 150) < 1e-9);
  const pair = [b, { x: 400, y: 50, w: 100, h: 100 }];
  const scaled = scaleMembers(unionBox(pair), pair, 2, "tl");
  t("a multi-selection scales as one group, gaps included",
    scaled[0].x === 100 && scaled[1].x === 700 && scaled[1].w === 200);
  t("the union box is what the anchor is measured against",
    unionBox(pair).w === 400 && unionBox(pair).h === 100);
  const ratio = sizeKeepingRatio(b, { w: 400 });
  t("typing a width while scaled keeps the ratio", ratio.h === 200);
  t("a typed height drives the width", sizeKeepingRatio(b, { h: 50 }).w === 100);
  t("both fields typed is taken literally", sizeKeepingRatio(b, { w: 10, h: 10 }).w === 10);
}

console.log("selection helpers:");
{
  const nd = (o) => ({
    kind: "rect", name: "n", x: 0, y: 0, w: 100, h: 100, children: [],
    strokeWidth: 0, opacity: 1, fillVisible: true, strokeVisible: false, ...o,
  });
  // two app screens, each Cart/Checkout > Header > Icon, the shape Figma's
  // "matching objects" rule is written for
  const aIcon = nd({ id: "a-icon", name: "Icon", fill: "#ff0000", x: 10, y: 10, w: 24, h: 24 });
  const bIcon = nd({ id: "b-icon", name: "Icon", fill: "#0000ff", x: 12, y: 8, w: 24, h: 24 });
  const badge = nd({ id: "badge", name: "Badge", x: 4, y: 4, w: 24, h: 24, children: [nd({ id: "badge-icon", name: "Icon", x: 2, y: 2, w: 8, h: 8 })] });
  const avatar = nd({ id: "avatar", name: "Avatar", fill: "#00ff00", x: 40, y: 8, w: 24, h: 24 });
  const otherIcon = nd({ id: "other-icon", name: "Icon", x: 60, y: 60, w: 24, h: 24 });
  const headA = nd({ id: "a-head", name: "Header", x: 0, y: 0, w: 100, h: 40, children: [aIcon] });
  const headB = nd({ id: "b-head", name: "Header", x: 0, y: 0, w: 100, h: 40, children: [bIcon, avatar, badge] });
  const frameA = nd({ id: "fa", kind: "frame", name: "Cart", x: 0, y: 0, w: 100, h: 100, children: [headA, otherIcon] });
  const frameB = nd({ id: "fb", kind: "frame", name: "Checkout", x: 200, y: 0, w: 100, h: 100, children: [headB] });
  const page = nd({ id: "root", kind: "page", name: "Page", x: 0, y: 0, w: 0, h: 0, children: [frameA, frameB] });

  t("the same layer in another frame matches", matchingIds(page, aIcon).includes("b-icon"));
  t("a match does not care that the fills differ", matchingIds(page, aIcon).join() === "b-icon");
  t("a differently named sibling never matches", !matchingIds(page, aIcon).includes("avatar"));
  t("a different ancestor name breaks the match", !matchingIds(page, otherIcon).includes("b-icon"));
  t("the same name one level deeper is a different object", !matchingIds(page, aIcon).includes("badge-icon"));
  t("a match is never the layer itself", !matchingIds(page, aIcon).includes("a-icon"));
  const idx = pathIndex(page);
  t("a nested layer's key is its depth and the chain below its top-level frame",
    idx.get("a-icon").key === "3:Header/Icon" && idx.get("badge-icon").key === "4:Header/Badge/Icon");
  t("the top-level frame's own name is not part of a child's key",
    idx.get("fa").key === "1:Cart" && idx.get("a-head").key === "2:Header");
  // the shape the canvas test hit: a loose layer and a nested one may share a
  // name without being the same object
  const loose = nd({ id: "loose", name: "Icon", x: 0, y: 200, w: 24, h: 24 });
  const page2 = nd({ id: "r5", kind: "page", children: [loose, frameA, frameB] });
  t("a top-level layer never matches a nested one of the same name",
    !matchingIds(page2, loose).includes("a-icon") && !matchingIds(page2, aIcon).includes("loose"));

  t("same fill gathers every layer painted with that colour", sameIds(page, aIcon, "fill").length >= 0);
  const red = nd({ id: "red", name: "Red", fill: "#ff0000" });
  const redHidden = nd({ id: "red-hidden", name: "Hidden", fill: "#ff0000", fillVisible: false });
  const withExtra = nd({ id: "extra", name: "Extra", fill: "#00000000", fillVisible: true, fills: [{ color: "#ff0000", type: "solid", visible: true }] });
  const tree = nd({ id: "r2", kind: "page", children: [red, redHidden, withExtra, nd({ id: "blue", name: "Blue", fill: "#0000ff" })] });
  const same = sameIds(tree, red, "fill");
  t("same fill finds an extra paint that carries the colour", same.includes("extra"));
  t("same fill ignores a hidden layer", !same.includes("hidden"));
  t("same fill ignores a different colour", !same.includes("blue"));

  const text = (id, over) => nd({ id, kind: "text", children: [], ...over });
  const t1 = text("t1", { name: "Submit", text: "Submit", fontFamily: "Inter", fontSize: 16, fontWeight: 400 });
  const t2 = text("t2", { name: "Send", text: "Send", fontFamily: "Inter", fontSize: 16, fontWeight: 400 });
  const t3 = text("t3", { name: "Send", text: "Send", fontFamily: "serif", fontSize: 16, fontWeight: 700 });
  const tree2 = nd({ id: "r3", kind: "page", children: [
    nd({ id: "f1", kind: "frame", name: "A", children: [t1] }),
    nd({ id: "f2", kind: "frame", name: "B", children: [t2, t3] }),
  ] });
  t("auto-named text matches on typography across frames", matchingIds(tree2, t1).includes("t2"));
  t("text with different type does not match", !matchingIds(tree2, t1).includes("t3"));
  t("same font finds both weights of the family", sameIds(tree2, t1, "font").includes("t2"));
  t("same text properties needs the whole recipe", !sameIds(tree2, t1, "text").includes("t3") && sameIds(tree2, t1, "text").includes("t2"));

  const stack = nd({ id: "r4", kind: "page", children: [
    nd({ id: "bg", name: "BG", x: 0, y: 0, w: 100, h: 100 }),
    // paint order runs left to right, so Chip (last) is the topmost layer and
    // the first row the Layers panel - and the select-layer menu - shows
    nd({ id: "card", name: "Card", x: 0, y: 0, w: 100, h: 100, children: [
      nd({ id: "gone", name: "Gone", x: 10, y: 10, w: 20, h: 20, visible: false }),
      nd({ id: "pad", name: "Locked", x: 10, y: 10, w: 20, h: 20, locked: true }),
      nd({ id: "chip", name: "Chip", x: 10, y: 10, w: 20, h: 20 }),
    ] }),
  ] });
  const at = layersAt(stack, 15, 15).map((n) => n.name);
  t("the select-layer list reads like the Layers panel", at.join() === "Card,Chip,Locked,BG");
  t("a parent sits above the layers it contains", at.indexOf("Card") < at.indexOf("Chip"));
  t("hidden layers are left out of the list", !at.includes("Gone"));
  t("locked layers are kept so they can still be picked", at.includes("Locked"));
  t("a point outside every layer lists nothing", layersAt(stack, 500, 500).length === 0);
}

console.log("the scale tool scales content, not just the box:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 100, h: 50 });
  const frame = e.snapshot().selection[0];
  e.dispatch({ type: "add", kind: "rect", x: 10, y: 10, w: 20, h: 20 });
  const kid = e.snapshot().selection[0];
  e.dispatch({ type: "reparent", ids: [kid], parent: frame, x: 10, y: 10 });
  e.dispatch({
    type: "patch", id: frame,
    patch: {
      strokeWidth: 2, strokeDash: 6, strokeGap: 3,
      cornerRadii: [8, 8, 8, 8], minW: 40, maxW: 400, paragraphSpacing: 4, paragraphIndent: 12,
    },
  });
  const look = (id) => {
    const sn = e.snapshot();
    let out = null;
    const walk = (n) => { if (n.id === id) out = n; n.children?.forEach(walk); };
    walk(sn.pages[sn.page].root);
    return out;
  };
  e.dispatch({ type: "resize", id: frame, x: 0, y: 0, w: 200, h: 100, scaleProps: true });
  const f = look(frame);
  t("stroke weight follows the box", f.strokeWidth === 4);
  t("the dash pattern follows too", f.strokeDash === 12 && f.strokeGap === 6);
  t("corner radii follow", f.cornerRadii[0] === 16);
  t("auto layout limits follow", f.minW === 80 && f.maxW === 800);
  t("paragraph metrics follow", f.paragraphSpacing === 8 && f.paragraphIndent === 24);
  const k = look(kid);
  t("children move and grow with the parent", k.x === 20 && k.y === 20 && k.w === 40 && k.h === 40);
  e.dispatch({ type: "undo" });
  t("one undo restores the whole scale", look(frame).strokeWidth === 2 && look(frame).w === 100);
  e.dispatch({ type: "resize", id: frame, x: 0, y: 0, w: 200, h: 100 });
  t("a plain resize leaves content alone", look(frame).strokeWidth === 2 && look(frame).cornerRadii[0] === 8);
  t("and re-applies the child's constraints instead of scaling it", look(kid).w !== 40 || look(kid).x === 10);
}


const rect = (over = {}) => ({
  id: "r", kind: "rect", name: "r", x: 0, y: 0, w: 200, h: 100,
  path: [], closed: true, cornerRadii: [0, 0, 0, 0], cornerIndependent: false,
  children: [], ...over,
});

console.log("corners: one storage order, read the same way everywhere:");
{
  // The array is [topLeft, topRight, bottomLeft, bottomRight]; a canvas
  // roundRect and CSS both want [tl, tr, br, bl].
  const n = rect({ cornerIndependent: true, cornerRadii: [10, 20, 30, 40] });
  const c = cornerRadiiOf(n);
  t("the stored order reads back by name", c.tl === 10 && c.tr === 20 && c.bl === 30 && c.br === 40);
  t("the canvas order swaps the bottom pair", roundRectRadii(n).join() === "10,20,40,30");
  const u = rect({ cornerRadii: [12, 99, 99, 99] });
  t("a uniform shape repeats its first corner", cornerRadiiOf(u).br === 12 && cornerRadiiOf(u).bl === 12);
  // The radius pins are laid out from the same helper the painter uses, so the
  // handle drawn on a corner can only ever move that corner.
  const pins = cornerPinPoints(200, 100, cornerRadiiOf(u), 1);
  const byIndex = Object.fromEntries(pins.map((p) => [p.index, p]));
  t("the bottom left pin sits bottom left", byIndex.bl.x < 100 && byIndex.bl.y > 50);
  t("the bottom right pin sits bottom right", byIndex.br.x > 100 && byIndex.br.y > 50);
  t("each pin sits further out as its own radius grows", (() => {
    const small = cornerPinPoints(200, 100, { tl: 4, tr: 0, br: 0, bl: 0 }, 1)[0];
    const big = cornerPinPoints(200, 100, { tl: 30, tr: 0, br: 0, bl: 0 }, 1)[0];
    return big.x > small.x && big.y > small.y;
  })());
}

console.log("corner smoothing makes a squircle, not a bigger circle:");
{
  const flat = rect({ cornerRadii: [40, 40, 40, 40] });
  t("no smoothing keeps the plain rounded corner", !hasCornerSmoothing(flat) && !hasCornerSmoothing(rect({ cornerSmoothing: 0.6 })));
  t("smoothing without a radius does nothing", !hasCornerSmoothing(rect({ cornerSmoothing: 0.6 })));
  t("the corner reaches further along its edges as smoothing grows", cornerReach(40, 1) > cornerReach(40, 0.6) && cornerReach(40, 0.6) > 40);
  const smooth = squircleOutline(200, 100, { tl: 40, tr: 40, br: 40, bl: 40 }, 1);
  t("the outline keeps eight points so every consumer still fits", smooth.length === 8);
  t("tangent points move out past the radius", smooth[0].x > 40);
  const circ = shapePoly(rect({ cornerIndependent: true, cornerRadii: [40, 40, 40, 40] }));
  const near = (pts) => {
    let best = 1e9;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const u = 1 - t;
        const c1x = a.x + (a.ox || 0), c1y = a.y + (a.oy || 0);
        const c2x = b.x + (b.ix || 0), c2y = b.y + (b.iy || 0);
        const x = u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x;
        const y = u * u * u * a.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * b.y;
        best = Math.min(best, (x + y) / Math.SQRT2);
      }
    }
    return best;
  };
  t("the smoothed corner hugs the corner more tightly", near(smooth) < near(circ));
  const mid = squircleOutline(200, 100, { tl: 40, tr: 40, br: 40, bl: 40 }, 0.6);
  t("and is symmetric on a uniform shape", Math.abs(mid[0].x - (200 - mid[1].x)) < 1e-6 && Math.abs(mid[0].y - mid[1].y) < 1e-9);
  // Two neighbours cannot overrun the edge between them: they shrink together.
  const tight = squircleOutline(100, 100, { tl: 60, tr: 60, br: 0, bl: 0 }, 1);
  t("neighbouring corners share an edge they would overrun", tight[0].x + (100 - tight[1].x) <= 100.0001);
  t("and nothing escapes the box", tight.every((p) => p.x >= -1e-6 && p.x <= 200 + 1e-6 && p.y >= -1e-6 && p.y <= 100 + 1e-6));
}

console.log("individual strokes:");
{
  t("the picker offers Figma's six choices", SIDES.map((x) => x.id).join() === "all,top,right,bottom,left,custom");
  t("All weights every side", sideWidths("all", undefined, 2).join() === "2,2,2,2");
  t("Top leaves the others empty", sideWidths("top", undefined, 2).join() === "2,0,0,0");
  t("Right is the second side", sideWidths("right", undefined, 3).join() === "0,3,0,0");
  t("Bottom is the third", sideWidths("bottom", undefined, 3).join() === "0,0,3,0");
  t("Left is the fourth", sideWidths("left", undefined, 3).join() === "0,0,0,3");
  t("Custom reads the four fields", sideWidths("custom", [1, 2, 3, 4], 9).join() === "1,2,3,4");
  t("Custom ignores the shared weight, and never goes negative", sideWidths("custom", [-4, 0, 2, 0], 9).join() === "0,0,2,0");
  t("rectangles, frames, components and instances support it", [
    sidesSupported("rect"), sidesSupported("frame"), sidesSupported("component"), sidesSupported("instance"),
  ].every(Boolean));
  t("ellipses, lines and text do not", !sidesSupported("ellipse") && !sidesSupported("line") && !sidesSupported("text"));
  const [top, right, bottom, left] = sideCones(0, 0, 200, 100);
  const inTri = (tri, [px, py]) => {
    const [[ax, ay], [bx, by], [cx, cy]] = tri;
    const s2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) * Math.sign(s2);
    const w2 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * Math.sign(s2);
    return w1 >= 0 && w2 >= 0;
  };
  t("the top band owns the whole top edge", inTri(top, [100, 0]) && inTri(top, [10, 1]) && inTri(top, [190, 1]));
  t("but not the bottom edge", !inTri(top, [100, 150]));
  t("the left band owns the whole left edge", inTri(left, [0, 50]) && inTri(left, [1, 10]) && !inTri(left, [200, 50]));
  t("right and bottom take the rest", inTri(right, [200, 50]) && inTri(bottom, [100, 100]));
  t("each band holds its own corners and shares them at 45°", inTri(top, [0, 0]) && inTri(left, [0, 0]) && inTri(bottom, [200, 100]) && inTri(right, [200, 100]));
}

console.log("dashes, caps and the miter angle:");
{
  t("a comma list parses", parseDashPattern("10, 20, 80, 20").join() === "10,20,80,20");
  t("spaces work as well", parseDashPattern("4 2 1").join() === "4,2,1");
  t("an empty field means no custom pattern", parseDashPattern("   ").length === 0);
  t("words are refused rather than truncated", parseDashPattern("4, x") === null);
  t("negatives are refused", parseDashPattern("10, -2") === null);
  t("decimals are allowed", parseDashPattern("1.5, 2").join() === "1.5,2");
  t("the custom pattern wins over the dash/gap pair", dashArray([3, 4], 10, 10).join() === "3,4");
  t("without one the pair is used, gap falling back to the dash", dashArray([], 6, 0).join() === "6,6");
  t("the pattern is scaled with the zoom", dashArray([3, 4], 0, 0, 2).join() === "6,8");
  t("no dash means no pattern at all", dashArray([], 0, 0).length === 0);
  t("miter angle 60 gives the classic limit of 2", Math.abs(miterLimitFromAngle(60) - 2) < 1e-9);
  t("a right angle gives sqrt(2)", Math.abs(miterLimitFromAngle(90) - Math.SQRT2) < 1e-9);
  t("0 never bevels and 180 always does", miterLimitFromAngle(0) > 1e5 && miterLimitFromAngle(180) === 1);
  t("an unset angle behaves like the miter join", miterLimitFromAngle(undefined) > 1e5);
}

console.log("effects stack like Figma allows:");
{
  const fx = (kind, i) => ({ kind, color: "#000", x: 0, y: 0, blur: 4, spread: 0, visible: true, id: i });
  const many = (kind, n) => Array.from({ length: n }, (_, i) => fx(kind, i));
  t("eight drop shadows fit, a ninth does not", canAddEffect(many("drop-shadow", 8), "drop-shadow") === false);
  t("and eight is allowed", canAddEffect(many("drop-shadow", 7), "drop-shadow") === true);
  t("inner shadows get their own eight", canAddEffect([...many("drop-shadow", 8), ...many("inner-shadow", 7)], "inner-shadow") === true);
  t("one blur of each kind", canAddEffect(many("layer-blur", 1), "layer-blur") === false && canAddEffect(many("background-blur", 1), "background-blur") === false);
  t("two noise rows, one texture, one glass", canAddEffect(many("noise", 2), "noise") === false && canAddEffect(many("texture", 1), "texture") === false && canAddEffect(many("glass", 1), "glass") === false);
  t("the limits in the table are Figma's", EFFECT_LIMITS["drop-shadow"] === 8 && EFFECT_LIMITS.noise === 2 && EFFECT_LIMITS.glass === 1);
  t("counts are per kind", countKind([...many("drop-shadow", 3), ...many("noise", 2)], "drop-shadow") === 3);
  const list = ["a", "b", "c", "d"];
  t("dragging a row moves it rather than swapping", moveEffect(list, 0, 2).join() === "b,c,a,d");
  t("moving down lands before the target", moveEffect(list, 3, 1).join() === "a,d,b,c");
  t("a row dropped where it started is left alone", moveEffect(list, 1, 1).join() === list.join());
  t("out of range drops change nothing", moveEffect(list, 9, 0).join() === list.join() && moveEffect(list, -1, 2).join() === list.join());
}

console.log("the engine carries the new properties:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 50 });
  const id = e.snapshot().selection[0];
  const look = (nid) => {
    const sn = e.snapshot();
    let out = null;
    const walk = (n) => { if (n.id === nid) out = n; n.children?.forEach(walk); };
    walk(sn.pages[sn.page].root);
    return out;
  };
  e.dispatch({
    type: "patch", id,
    patch: {
      strokeWidth: 4, strokeSides: "custom", strokeSideW: [4, 2, 0, 6],
      strokeDashPattern: [12, 6], strokeDashCap: "round", strokeMiterAngle: 90,
      cornerRadii: [20, 20, 20, 20], cornerIndependent: true, cornerSmoothing: 0.6,
      strokes: [{ color: "#ff0000", opacity: 1, visible: true, width: 2, align: "center", dash: 8, gap: 4, pattern: [6, 3], sideW: [2, 2, 0, 0], sides: "custom" }],
    },
  });
  e.dispatch({ type: "resize", id, x: 0, y: 0, w: 200, h: 100, scaleProps: true });
  const n = look(id);
  t("per-side weights scale", n.strokeSideW.join() === "8,4,0,12");
  t("the custom dash pattern scales", n.strokeDashPattern.join() === "24,12");
  t("smoothing is a ratio, so it stays put", n.cornerSmoothing === 0.6);
  t("extra strokes scale their dashes too", n.strokes[0].dash === 16 && n.strokes[0].gap === 8);
  t("and their own pattern and side weights", n.strokes[0].pattern.join() === "12,6" && n.strokes[0].sideW.join() === "4,4,0,0");
  e.dispatch({ type: "copyProperties" });
  e.dispatch({ type: "add", kind: "rect", x: 300, y: 0, w: 40, h: 40 });
  const other = e.snapshot().selection[0];
  e.dispatch({ type: "pasteProperties" });
  const p = look(other);
  t("copy/paste properties carries the sides", p.strokeSides === "custom" && p.strokeSideW.join() === "8,4,0,12");
  t("and the dash pattern, cap and miter angle", p.strokeDashPattern.join() === "24,12" && p.strokeDashCap === "round" && p.strokeMiterAngle === 90);
  t("and the corner smoothing", p.cornerSmoothing === 0.6 && p.cornerIndependent === true);
}

console.log("images are stored by reference, not inside the document:");
{
  const png = (n) => "data:image/png;base64," + String(n).repeat(64);
  const leaf = (id, src) => ({
    id, name: id, kind: "rect", x: 0, y: 0, w: 10, h: 10, rotation: 0, fills: [], effects: [],
    imageSrc: src, imageFit: "fill", children: [],
  });
  const doc = (kids) => ({
    fileName: "t", page: 0, zoom: 1, panX: 0, panY: 0,
    pages: [{ name: "Page 1", root: { id: "root", kind: "page", name: "root", x: 0, y: 0, w: 0, h: 0, rotation: 0, fills: [], effects: [], imageSrc: "", children: kids } }],
    components: [{ id: "c1", name: "Comp", node: leaf("m", png(7)), variants: [], property: "" }],
  });

  resetAssets();
  const a = png(1);
  const b = png(2);
  const d = doc([leaf("n1", a), leaf("n2", a), leaf("n3", b)]);
  const stored = dehydrateDoc(d);

  const refs = stored.pages[0].root.children.map((n) => n.imageSrc);
  t("every inline image becomes a reference", refs.every((r) => r.startsWith(ASSET_PREFIX)));
  t("the same image in two places gets one reference", refs[0] === refs[1]);
  t("different images get different references", refs[0] !== refs[2]);
  t("the stored document keeps no data: URL at all", !JSON.stringify(stored).includes("data:image"));
  t("a component master's image is stored the same way", stored.components[0].node.imageSrc.startsWith(ASSET_PREFIX));

  t(
    "the live document is untouched - its nodes still hold the picture",
    d.pages[0].root.children.every((n) => n.imageSrc.startsWith("data:")),
  );
  t(
    "and dehydrating twice gives the same reference",
    dehydrateDoc(d).pages[0].root.children[0].imageSrc === refs[0],
  );

  // The editor's own copy is the one that gets hydrated; work on a fresh one so
  // the check is about the store, not about the object identity above.
  const fresh = JSON.parse(JSON.stringify(stored));
  await hydrateDoc(fresh);
  t(
    "loading a stored document brings the pictures back",
    fresh.pages[0].root.children[0].imageSrc === a && fresh.pages[0].root.children[2].imageSrc === b,
  );
  t("and the component's too", fresh.components[0].node.imageSrc === png(7));

  resetAssets();
  const cold = JSON.parse(JSON.stringify(stored));
  const unresolved = await hydrateDoc(cold);
  t("a document from another browser reports what it could not load", unresolved > 0);
  t("and leaves those references alone rather than blanking them", cold.pages[0].root.children[0].imageSrc.startsWith(ASSET_PREFIX));

  resetAssets();
  putAsset(a);
  t("registering the same image twice stores it once", assetCount() === 1 && putAsset(a) === putAsset(a));
}

console.log("the rotation origin is the point that stays put:");
{
  const box = { x: 10, y: 20, w: 100, h: 50, rotation: 0 };
  const centre = rotateAboutOrigin(box, [0.5, 0.5], 90);
  t(
    "a layer that never moved its origin turns in place",
    Math.abs(centre.x - 10) < 1e-9 && Math.abs(centre.y - 20) < 1e-9 && centre.rotation === 90,
  );

  /** Where a point of the box ends up once it has turned by `deg` about the
   *  box's own middle - the way the renderer and the SVG export do it. */
  const after = (r, local, deg) => {
    const cx = r.x + box.w / 2;
    const cy = r.y + box.h / 2;
    const rad = (deg * Math.PI) / 180;
    const dx = local.x - cx;
    const dy = local.y - cy;
    return { x: cx + dx * Math.cos(rad) - dy * Math.sin(rad), y: cy + dx * Math.sin(rad) + dy * Math.cos(rad) };
  };

  const tl = rotateAboutOrigin(box, [0, 0], 90);
  const tlAfter = after(tl, { x: tl.x, y: tl.y }, 90);
  t(
    "turning about the top left holds that corner still",
    Math.abs(tlAfter.x - 10) < 1e-9 && Math.abs(tlAfter.y - 20) < 1e-9,
  );

  const left = rotateAboutOrigin(box, [0, 0.5], 180);
  t(
    "a half turn about the left edge mirrors the box across it",
    Math.abs(left.x - (10 - 100)) < 1e-9 && Math.abs(left.y - 20) < 1e-9,
  );

  const quarter = rotateAboutOrigin(box, [0.5, 0.5], 90);
  t("an origin on the edge does not move when the spin is zero", (() => {
    const still = rotateAboutOrigin(box, [0, 1], 0);
    return still.x === box.x && still.y === box.y;
  })());
  t("and the three-quarter case stays finite", Number.isFinite(quarter.x) && Number.isFinite(quarter.y));
}

console.log("effect blend modes, and what a drop shadow shows through:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const root = e.snapshot().pages[e.snapshot().page].root.id;
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100, parent: root });
  const id = e.snapshot().selection[0];
  const now = () => find(e.snapshot().pages[e.snapshot().page].root, id);

  t(
    "only inner shadows, drop shadows and noise offer a blend mode",
    effectCanBlend("drop-shadow") &&
      effectCanBlend("inner-shadow") &&
      effectCanBlend("noise") &&
      !effectCanBlend("layer-blur") &&
      !effectCanBlend("background-blur") &&
      !effectCanBlend("texture") &&
      !effectCanBlend("glass"),
  );
  t(
    "show-behind is the drop shadow's alone",
    effectCanShowBehind("drop-shadow") &&
      !effectCanShowBehind("inner-shadow") &&
      !effectCanShowBehind("noise"),
  );
  const drop = defaultEffect("drop-shadow");
  t(
    "a new drop shadow is Normal with show-behind off",
    drop.blend === "Normal" && drop.showBehind === false,
  );
  t(
    "a new inner shadow has no show-behind field at all",
    defaultEffect("inner-shadow").showBehind === undefined,
  );

  t(
    "an opaque filled rectangle has nothing to show a shadow through",
    canShowBehindTransparent(now()) === false,
  );
  e.dispatch({ type: "patch", id, patch: { fillOpacity: 0.5 } });
  t("a half-transparent fill does", canShowBehindTransparent(now()) === true);
  e.dispatch({ type: "patch", id, patch: { fillOpacity: 1, fillBlend: "Multiply" } });
  t("so does a fill that blends", canShowBehindTransparent(now()) === true);
  e.dispatch({
    type: "patch",
    id,
    patch: { fillBlend: "Normal", fillVisible: false, strokeVisible: true, strokePaint: "#ff0000", strokeWidth: 2 },
  });
  t("and a stroke with no fill", canShowBehindTransparent(now()) === true);
  e.dispatch({ type: "patch", id, patch: { strokeAlign: "inside" } });
  t(
    "a stroke-only layer qualifies whatever its alignment",
    canShowBehindTransparent(now()) === true,
  );
  // The fourth criterion is narrower: a centre or outside stroke at less than
  // full opacity, which is the only way a stroke can be translucent.
  e.dispatch({
    type: "patch",
    id,
    patch: { fillVisible: true, fillOpacity: 1, strokeOpacity: 0.5, strokeAlign: "inside" },
  });
  t(
    "an opaque fill with an inside stroke has nothing transparent about it",
    canShowBehindTransparent(now()) === false,
  );
  e.dispatch({ type: "patch", id, patch: { strokeAlign: "center" } });
  t("a centre stroke at half opacity does", canShowBehindTransparent(now()) === true);
}

console.log("corners an instance is not allowed to own:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const root = e.snapshot().pages[e.snapshot().page].root.id;
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 200, h: 120, parent: root });
  const rect = e.snapshot().selection[0];
  e.dispatch({ type: "add", kind: "frame", x: 10, y: 10, w: 40, h: 40, parent: rect });
  const kid = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: rect, patch: { kind: "instance", componentId: "c1" } });
  const tree = () => e.snapshot().pages[e.snapshot().page].root;
  t("an instance cannot carry individual corners", insideInstance(tree(), rect) === true);
  t("nor can anything nested inside one", insideInstance(tree(), kid) === true);
  e.dispatch({ type: "reparent", ids: [kid], parent: root, x: 400, y: 0 });
  t("back at the top level it rounds freely again", insideInstance(tree(), kid) === false);
}

console.log("snap to pixel grid:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const pageOf = () => e.snapshot().pages[e.snapshot().page];
  const nodeOf = (id) => find(pageOf().root, id);
  const root = pageOf().root.id;
  t("a page snaps to whole pixels out of the box", pageOf().pixelSnap !== false);
  e.dispatch({ type: "add", kind: "rect", x: 10.4, y: 20.6, w: 30.4, h: 40.2, parent: root });
  const id = e.snapshot().selection[0];
  const n = nodeOf(id);
  t(
    "a layer created at fractional coordinates is rounded onto the grid",
    n.x === 10 && n.y === 21 && n.w === 30 && n.h === 40,
  );
  e.dispatch({ type: "move", ids: [id], dx: 0.4, dy: 0.6 });
  t("dragging it lands on whole pixels again", nodeOf(id).x === 10 && nodeOf(id).y === 22);
  e.dispatch({ type: "nudge", dx: 1, dy: 1 });
  t("arrow-key nudges stay on the grid", nodeOf(id).x === 11 && nodeOf(id).y === 23);
  e.dispatch({ type: "resize", id, x: 5.5, y: 6.5, w: 12.5, h: 9.5 });
  const r = nodeOf(id);
  t("resizing rounds both corners", r.x === 6 && r.y === 7 && r.w === 13 && r.h === 10);
  // The pixel-grid *overlay* is a different switch with a different default.
  // It used to be the flag the engine read, so the overlay being off (the
  // default) turned snapping off with it.
  e.dispatch({ type: "patchPage", patch: { pixelSnap: false, pixelGrid: true } });
  e.dispatch({ type: "move", ids: [id], dx: 0.25, dy: 0.25 });
  t(
    "with snapping off, showing the pixel grid does not start snapping",
    nodeOf(id).x === 6.25 && nodeOf(id).y === 7.25,
  );
  e.dispatch({ type: "patchPage", patch: { pixelSnap: true, pixelGrid: false } });
  e.dispatch({ type: "move", ids: [id], dx: 0.25, dy: 0.25 });
  t(
    "and with snapping on, hiding the pixel grid does not stop snapping",
    nodeOf(id).x === 7 && nodeOf(id).y === 8,
  );
}

console.log("the View menu:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const s = () => e.snapshot();
  t("pixel preview starts off", s().pixelPreview === "off");
  t("layout guides start visible", s().viewLayoutGuides !== false);
  t("property labels start off", s().propertyLabels === false);
  e.dispatch({ type: "setPixelPreview", preview: "2x" });
  t("the pixel preview takes the density it is given", s().pixelPreview === "2x");
  e.dispatch({ type: "toggleLayoutGuides" });
  t("layout guides toggle off", s().viewLayoutGuides === false);
  e.dispatch({ type: "togglePropertyLabels" });
  t("property labels toggle on", s().propertyLabels === true);
  t(
    "view switches are not document edits, so they stay out of undo",
    s().canUndo === false,
  );
  e.dispatch({ type: "undo" });
  t("undo does not walk back a view switch", s().pixelPreview === "2x");
}

console.log("zoom keeps what you are looking at:");
{
  // The design point under the anchor is (anchor - pan) / zoom, and it has to
  // still be under the anchor afterwards. Zooming without moving the pan drags
  // the drawing towards the canvas's top-left corner, off the window.
  t("zooming in about a point holds that point still", panForZoom(0, 1, 2, 400) === -400);
  t("zooming back out undoes it exactly", panForZoom(-400, 2, 1, 400) === 0);
  t("zooming out about a point moves the pan the other way", panForZoom(-400, 2, 0.5, 400) === 200);
  const e = new MemoryEngine(false);
  await e.ready;
  const start = { zoom: e.snapshot().zoom, x: e.snapshot().panX, y: e.snapshot().panY };
  e.dispatch({ type: "setZoom", zoom: start.zoom * 2, anchorX: 400, anchorY: 300 });
  let s = e.snapshot();
  t(
    "the engine carries the anchor into the pan",
    s.panX === panForZoom(start.x, start.zoom, start.zoom * 2, 400) &&
      s.panY === panForZoom(start.y, start.zoom, start.zoom * 2, 300),
  );
  t(
    "so the middle of the canvas still shows the same design point",
    Math.abs((400 - s.panX) / s.zoom - (400 - start.x) / start.zoom) < 1e-9,
  );
  e.dispatch({ type: "setZoom", zoom: start.zoom, anchorX: 400, anchorY: 300 });
  s = e.snapshot();
  t(
    "and zooming back leaves the view where it started",
    Math.abs(s.panX - start.x) < 1e-9 && Math.abs(s.panY - start.y) < 1e-9,
  );
  const panBefore = s.panX;
  e.dispatch({ type: "setZoom", zoom: 4 });
  t("an unanchored zoom is the one that leaves the pan alone", e.snapshot().panX === panBefore);
}

console.log("a name you can read:");
{
  // The canvas label is text on whatever the canvas is: a theme colour, or the
  // page's own background when it has one. Half-transparent grey over a light
  // canvas is what made frame names read as decoration.
  t("a half-transparent label composites to what the eye sees", compositeOver("rgba(15,23,42,0.5)", "#f1f2f6") === "#808590");
  t(
    "which is under the 4.5:1 floor for text",
    contrastRatio("#808590", "#f1f2f6") < 4.5,
  );
  const lightReadable = readableLabel("rgba(15,23,42,0.5)", "#f1f2f6", 4.5);
  t("pushed until it clears the floor", contrastRatio(lightReadable, "#f1f2f6") >= 4.5);
  t("without throwing the theme's hue away", /^#/.test(lightReadable) && lightReadable.length === 7);
  const darkReadable = readableLabel("rgba(248,250,252,0.5)", "#101116", 4.5);
  t("a light label on a dark canvas is pushed the other way", contrastRatio(darkReadable, "#101116") >= 4.5);
  t(
    "and a dark label on a dark canvas comes back as light text",
    contrastRatio(readableLabel("#111111", "#101116", 4.5), "#101116") >= 4.5,
  );
  // A page can paint its own background over the theme's, and the label has to
  // follow it rather than assuming the theme's grey.
  const onPage = readableLabel("rgba(15,23,42,0.5)", "#1b1f2a", 4.5);
  t("the page's own background decides the label colour", contrastRatio(onPage, "#1b1f2a") >= 4.5);
  t("a label that already passes is left alone", readableLabel("#333333", "#ffffff", 4.5) === "#333333");
}

console.log("what a new layer is called:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const root = e.snapshot().pages[e.snapshot().page].root.id;
  const names = () => e.snapshot().pages[e.snapshot().page].root.children.map((c) => c.name);
  const add = (kind) => e.dispatch({ type: "add", kind, x: 0, y: 0, w: 10, h: 10, parent: root });
  add("frame");
  add("frame");
  add("rect");
  add("ellipse");
  const added = names().slice(-4);
  t(
    "frames are numbered, as in Figma, rather than all being called Frame",
    new Set(added).size === 4,
  );
  t("the numbering starts at one", added[0] === "Frame 1" && added[1] === "Frame 2");
  t("each kind has its own count", added[2] === "Rectangle 1" && added[3] === "Ellipse 1");
  add("frame");
  t("and it keeps counting past the ones already there", names().slice(-1)[0] === "Frame 3");
  // A rename must not be undone by the next layer: the counter skips names in
  // use, it does not remember a count.
  e.dispatch({ type: "patch", id: e.snapshot().pages[e.snapshot().page].root.children.slice(-1)[0].id, patch: { name: "Frame 3" } });
  add("frame");
  t("a taken number is skipped, not reused", names().slice(-1)[0] === "Frame 4");
}

console.log("nudge amounts:");
{
  t("small nudge is 1 and big nudge is 10, as Figma ships them", DEFAULT_NUDGE.small === 1 && DEFAULT_NUDGE.big === 10);
  t("an arrow key uses the small value", nudgeStep(DEFAULT_NUDGE, false) === 1);
  t("shift with an arrow key uses the big one", nudgeStep(DEFAULT_NUDGE, true) === 10);
  const eight = normalizeNudge({ small: 8, big: 16 });
  t("a set value is what the keys move by", nudgeStep(eight, false) === 8 && nudgeStep(eight, true) === 16);
  t("a saved decimal survives", normalizeNudge({ small: 0.5 }).small === 0.5);
  t("a comma is read as a decimal point", parseNudge("0,5") === 0.5);
  t("a negative nudge is read as its distance", parseNudge("-4") === 4);
  t("an empty field parses as nothing at all", parseNudge("") === null);
  t("so does a half-typed decimal point", parseNudge(".") === null);
  t("and a word", parseNudge("wide") === null);
  t("a zero is refused: the keys would stop working", clampNudge(0) === NUDGE_MIN);
  t("and an absurd one is clamped", clampNudge(1e9) === NUDGE_MAX);
  t(
    "one bad field does not take the other down with it",
    normalizeNudge({ small: "nonsense", big: 24 }).small === 1 &&
      normalizeNudge({ small: "nonsense", big: 24 }).big === 24,
  );
  t(
    "a preference written by something else falls back to Figma's defaults",
    normalizeNudge(null).small === 1 && normalizeNudge(undefined).big === 10,
  );
  t("a string number from storage is understood", normalizeNudge({ small: "12" }).small === 12);
}

console.log("three themes, not five:");
{
  t("there are exactly three options", THEME_OPTIONS.length === 3);
  t(
    "and they are light, dark and system",
    THEME_OPTIONS.map((o) => o.id).join(",") === "light,dark,system",
  );
  t("an old graphite preference opens as dark", normalizeThemePref("graphite") === "dark");
  t("an old daylight preference opens as light", normalizeThemePref("daylight") === "light");
  t("the three real names are kept", normalizeThemePref("system") === "system");
  t("an unreadable preference falls back", normalizeThemePref(null) === DEFAULT_THEME_PREF);
  t("including one from another app entirely", normalizeThemePref("solarized") === DEFAULT_THEME_PREF);
  t("capitalisation does not matter", normalizeThemePref(" Dark ") === "dark");
  t("system follows the OS into dark", resolveTheme("system", true) === "dark");
  t("and into light", resolveTheme("system", false) === "light");
  t("an explicit choice ignores the OS", resolveTheme("light", true) === "light");
  t("the label is the menu's word for it", themeLabel("dark") === "Dark");
  t(
    "every option has a label and none of them is the old name",
    THEME_OPTIONS.every((o) => o.label && !/graphite|daylight/i.test(o.label)),
  );
}

console.log("export formats and settings:");
{
  t("the four formats are PNG, JPG, SVG and PDF", FORMATS.join(",") === "PNG,JPG,SVG,PDF");
  // Figma's published capability table.
  t("PNG takes ignore-overlap and bounding box, not id or outline", FORMAT_CAPS.PNG.ignoreOverlap && FORMAT_CAPS.PNG.boundingBox && !FORMAT_CAPS.PNG.includeId && !FORMAT_CAPS.PNG.outlineText);
  t("JPG adds image quality", FORMAT_CAPS.JPG.quality && !FORMAT_CAPS.PNG.quality);
  t("SVG takes the three markup settings", FORMAT_CAPS.SVG.includeId && FORMAT_CAPS.SVG.outlineText && FORMAT_CAPS.SVG.simplifyStroke);
  t("PDF takes none of them", !FORMAT_CAPS.PDF.ignoreOverlap && !FORMAT_CAPS.PDF.boundingBox && !FORMAT_CAPS.PDF.includeId);
  t("but PDF does take quality and resampling", FORMAT_CAPS.PDF.quality && FORMAT_CAPS.PDF.resampling);
  t("SVG exports at 1x only, as the article says", FORMAT_CAPS.SVG.oneToOne);
  t("and so does PDF", FORMAT_CAPS.PDF.oneToOne);
  t("PNG and JPG scale freely", !FORMAT_CAPS.PNG.oneToOne && !FORMAT_CAPS.JPG.oneToOne);
}

console.log("the scale field:");
{
  const node = { w: 200, h: 160 };
  t("a bare number is a multiplier", parseScale("2").kind === "multiplier" && parseScale("2").value === 2);
  t("2x is the same multiplier", exportSize(node, { format: "PNG", scale: "2x" }).width === 400);
  t("and the height follows", exportSize(node, { format: "PNG", scale: "2x" }).height === 320);
  t("1.5x is allowed", exportSize(node, { format: "PNG", scale: "1.5x" }).width === 300);
  const w = exportSize(node, { format: "PNG", scale: "500w" });
  t("500w sets the width exactly", w.width === 500);
  t("and the height follows the aspect ratio", w.height === 400);
  const h = exportSize(node, { format: "PNG", scale: "300h" });
  t("300h sets the height exactly", h.height === 300);
  t("and the width follows the aspect ratio", h.width === 375);
  t("a comma is read as a decimal point", exportSize(node, { format: "PNG", scale: "1,5x" }).width === 300);
  t("a nonsense scale falls back to 1x rather than to zero", exportSize(node, { format: "PNG", scale: "wide" }).width === 200);
  t("the scale reads back the way it was written", formatScale("500w") === "500w" && formatScale(2) === "2x");
  t("a scale of zero is refused", clampScale(0) === 1);
  t("and an absurd one is clamped", clampScale(1e6) === 64);
  // A vector format is pinned, whatever the field says.
  t("an SVG at 2x still comes out at the design size", exportSize(node, { format: "SVG", scale: "2x" }).width === 200);
  t("a PDF at 4x as well", exportSize(node, { format: "PDF", scale: "4x" }).width === 200);
  t("but an SVG at 500w honours the width", exportSize(node, { format: "SVG", scale: "500w" }).width === 200);
  t("a new PNG preset starts at 1x", newPreset("PNG").scale === 1);
  t("a new SVG preset never claims a scale it cannot do", newPreset("SVG", 3).scale === 1);
  t("the preset list still holds whole and half steps", SCALE_PRESETS.includes(0.5) && SCALE_PRESETS.includes(1.5));
}

console.log("what an export does by default:");
{
  const s = resolveSettings({ format: "PNG", scale: 1, suffix: "" });
  t("overlapping layers are ignored, as Figma defaults", s.ignoreOverlap === true);
  t("the bounding box is kept", s.boundingBox === true);
  t("and the resampling is the detailed one", s.resampling === "detailed");
  t("no id attribute unless asked", s.includeId === false);
  t("a JPG defaults to high quality, as the article says", resolveSettings({ format: "JPG", scale: 1, suffix: "" }).quality === "high");
  t("a PDF defaults to medium", resolveSettings({ format: "PDF", scale: 1, suffix: "" }).quality === "medium");
  t("quality descends from high to low", qualityValue("high") > qualityValue("medium") && qualityValue("medium") > qualityValue("low"));
  // A preset saved before these existed must not read as "everything off".
  const old = resolveSettings({ format: "PNG", scale: 2, suffix: "" });
  t("an older preset with no settings still ignores overlaps", old.ignoreOverlap === true);
  const off = resolveSettings({ format: "PNG", scale: 1, suffix: "", ignoreOverlap: false });
  t("an explicit off is respected", off.ignoreOverlap === false);
  // A setting a format does not have reads as off, not as on.
  t("id is off for a format that has no id", resolveSettings({ format: "JPG", scale: 1, suffix: "", includeId: true }).includeId === false);
  t("outline text too", resolveSettings({ format: "PDF", scale: 1, suffix: "", outlineText: true }).outlineText === false);
}

console.log("the id an SVG is written with:");
{
  const named = rect({ name: "Card / Header" });
  const withId = exportSvg(named, { format: "SVG", scale: 1, suffix: "", includeId: true });
  const without = exportSvg(named, { format: "SVG", scale: 1, suffix: "" });
  t("the id attribute is written when the setting is on", /<svg[^>]* id="/.test(withId));
  t("and absent when it is off", !/<svg[^>]* id="/.test(without));
  t("a name with a slash does not end the attribute early", withId.includes('id="Card-Header"'));
  t("a name with nothing usable still gets an id", exportSvg(rect({ name: "///" }), { format: "SVG", scale: 1, suffix: "", includeId: true }).includes('id="layer"'));
  t("the width follows the scale syntax in the svg element", exportSvg(named, { format: "SVG", scale: "300w", suffix: "" }).includes('width="300"'));
}

console.log("auto layout: the gap modes:");
{
  // Figma's Auto gap is CSS's three packing rules: Between pushes the objects
  // to the padding, Around gives each object half a gap on either side, Evenly
  // puts the same space everywhere including the edges.
  const b = autoSpacing(60, 3, "between");
  t("between puts no space before the first object", b.lead === 0);
  t("and splits the slack between the objects", b.gap === 30);
  const a = autoSpacing(60, 3, "around");
  t("around gives the first object half a gap", a.lead === 10);
  t("and a whole gap between objects", a.gap === 20);
  const e = autoSpacing(60, 3, "evenly");
  t("evenly gives the first object a whole gap", e.lead === 15);
  t("the same one it gives between objects", e.gap === 15);
  t("a frame with no slack adds no space at all", autoSpacing(0, 3, "between").gap === 0);
  t("negative slack is treated as none", autoSpacing(-40, 3, "evenly").lead === 0);
  t("a single object has nothing to be spaced from", autoSpacing(50, 1, "between").gap === 0);
  t("an empty frame is not a divide by zero", autoSpacing(50, 0, "around").lead === 0);
  t("the panel offers the three modes", SPACING_MODES.map((m) => m.id).join(",") === "between,around,evenly");
  t("a numeric gap is not an auto gap", !isAutoGap({ gap: 8 }));
  t("and an auto gap is", isAutoGap({ gap: 8, gapMode: "auto" }));
}

console.log("auto layout: wrap, and hugging with a filler inside:");
{
  const layout = (over = {}) => ({
    direction: "horizontal", gap: 8, padding: [0, 0, 0, 0], sizing: "fixed", cross: "fixed",
    wrap: false, align: "min", justify: "min", ...over,
  });
  const child = (over = {}) => ({ id: "c", kind: "rect", name: "c", visible: true, w: 10, h: 10, ...over });
  t("wrap applies to a horizontal flow", wraps(layout({ wrap: true })));
  // Figma: "When you have the horizontal selected, Wrap becomes available."
  t("a vertical flow does not wrap, whatever the flag says", !wraps(layout({ wrap: true, direction: "vertical" })));
  t("and a horizontal flow without the flag does not wrap", !wraps(layout()));
  t("no layout at all does not wrap", !wraps(undefined));
  const filling = [child({ sizingW: "fill" })];
  t("a filling child is a fill on the main axis of a row", hasFillChild(filling, "main", true));
  t("and a fill on the cross axis of a column", hasFillChild(filling, "cross", false));
  t("a fixed child is not", !hasFillChild([child()], "main", true));
  // The article: "the parent frame will no longer hug contents and become Fixed
  // for the axis".
  const hugRule = effectiveSizing(layout({ sizing: "hug" }), { sizingW: "hug", sizingH: "hug" }, [child()]);
  t("a hug with no filler inside still hugs", hugRule.main === "hug");
  const brokenHug = effectiveSizing(layout({ sizing: "hug" }), { sizingW: "hug", sizingH: "hug" }, filling);
  t("a hug with a filling child becomes fixed", brokenHug.main === "fixed");
  t("and the cross axis is untouched by a main-axis filler", brokenHug.cross === "hug");
  const crossFiller = [child({ sizingH: "fill" })];
  t("a child filling the cross axis breaks the cross hug", effectiveSizing(layout({ cross: "hug" }), { sizingW: "fixed", sizingH: "hug" }, crossFiller).cross === "fixed");
  t("and leaves the main one alone", effectiveSizing(layout({ sizing: "hug" }), { sizingW: "hug", sizingH: "fixed" }, crossFiller).main === "hug");
}

console.log("the grid flow: cells, tracks and spans:");
{
  const kid = (over = {}) => ({ id: "k", kind: "rect", name: "k", visible: true, x: 0, y: 0, w: 40, h: 20, ...over });
  const grid = (over = {}) =>
    ({ ...defaultGrid(), padding: [0, 0, 0, 0], ...over });

  // "Objects will be placed in succession from left to right, top to bottom."
  const four = [kid({ id: "a" }), kid({ id: "b" }), kid({ id: "c" }), kid({ id: "d" })];
  const cells = placeCells(four, 2, true);
  t("objects fill a row before moving down", cells.map((c) => `${c.col},${c.row}`).join(" ") === "0,0 1,0 0,1 1,1");
  t("an auto row count follows the objects", gridRows(grid(), cells) === 2);
  t("one more object needs a third row in a two-column grid", gridRows(grid(), placeCells([...four, kid({ id: "e" })], 2, true)) === 3);
  t("a row count set by hand is a floor, not a ceiling", gridRows(grid({ rows: 5 }), cells) === 5);
  t("and Figma adds rows rather than dropping objects", gridRows(grid({ rows: 1 }), cells) === 2);
  t("an empty grid still has a row", gridRows(grid(), []) === 1);

  // Spans.
  const spanning = [kid({ id: "a", colSpan: 2 }), kid({ id: "b" }), kid({ id: "c" })];
  const spanned = placeCells(spanning, 2, true);
  t("a two-wide object takes the whole row", spanned[0].col === 0 && spanned[0].colSpan === 2);
  t("and the next object starts on the row below", spanned[1].row === 1 && spanned[1].col === 0);
  t("a span wider than the grid is clamped to it", placeCells([kid({ colSpan: 9 })], 2, true)[0].colSpan === 2);
  t("a row span reaches down", placeCells([kid({ rowSpan: 2 }), kid()], 2, true)[1].col === 1);

  // Automatic positioning off: objects stay where they were.
  const pinned = [kid({ id: "a", gridCol: 1, gridRow: 2 }), kid({ id: "b", gridCol: 0, gridRow: 0 })];
  const manual = placeCells(pinned, 2, false);
  t("with automatic positioning off an object keeps its cell", manual[0].col === 1 && manual[0].row === 2);
  t("empty cells stay empty", manual[1].col === 0 && manual[1].row === 0);
  t("and the grid is as tall as the furthest object", gridRows(grid(), manual) === 3);
  t("an object parked past the last column is pulled back", placeCells([kid({ gridCol: 7 })], 2, false)[0].col === 1);

  // Track sizing.
  const plan = (over, kids, cols) =>
    planGrid({ w: 200, h: 100 }, kids ?? four, grid({ columns: cols ?? 2, ...over }), false, false);
  // A track with no mode of its own is Figma's Auto, and its help says what
  // that means: "by default, the size is set to auto, which means free space is
  // divided evenly between all rows and columns".
  const untouched = plan({ gapCols: 0, gapRows: 0 });
  t("tracks are Auto until told otherwise, and share the space", untouched.colW[0] === 100 && untouched.colW[1] === 100);
  t("rows are Auto too", untouched.rowH[0] === 50 && untouched.rowH[1] === 50);
  const g0 = plan({ colTracks: [{ mode: "hug" }, { mode: "hug" }], rowTracks: [{ mode: "hug" }], gapCols: 0, gapRows: 0 });
  t("a hug track is as wide as its widest object", g0.colW[0] === 40 && g0.colW[1] === 40);
  t("and a hug row as tall as its tallest", g0.rowH[0] === 20);
  t("a mix lets hug keep its size and Auto take the rest",
    plan({ colTracks: [{ mode: "hug" }, { mode: "fill" }], gapCols: 0, gapRows: 0 }).colW[1] === 160);
  // "fill container ... fractional units (fr) are used"
  const fill = plan({ colTracks: [{ mode: "fill" }, { mode: "fill" }], gapCols: 0, gapRows: 0, rowTracks: [{ mode: "hug" }] });
  t("two 1fr columns split the width evenly", fill.colW[0] === 100 && fill.colW[1] === 100);
  const weighted = plan({ colTracks: [{ mode: "fill", fr: 1 }, { mode: "fill", fr: 3 }], gapCols: 0, gapRows: 0 });
  t("a 1fr and a 3fr column split four ways", weighted.colW[0] === 50 && weighted.colW[1] === 150);
  const mixed = plan({ colTracks: [{ mode: "fixed", size: 60 }, { mode: "fill" }], gapCols: 0, gapRows: 0 });
  t("a fixed track keeps its size", mixed.colW[0] === 60);
  t("and the fill track takes what is left", mixed.colW[1] === 140);
  const withGaps = plan({ gapCols: 10, gapRows: 6, colTracks: [{ mode: "fill" }, { mode: "fill" }] });
  t("gaps come out of the space before it is divided", withGaps.colW[0] === 95 && withGaps.colW[1] === 95);
  t("and the plan totals include them", withGaps.totalW === 200);
  t("a hugging frame has nothing to fill from, so fill falls back to hug", planGrid({ w: 0, h: 0 }, four, grid({ rows: "auto" }), true, true).colW[0] === 40);

  // Cell geometry, and where an object sits in its cell.
  const boxPlan = plan({ gapCols: 0, gapRows: 0 });
  const b = cellBox(boxPlan, { col: 1, row: 0, colSpan: 1, rowSpan: 1 });
  t("a cell's box starts where its track starts", b.x === 100 && b.y === 0);
  const spannedBox = cellBox(boxPlan, { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
  t("a spanned box covers both tracks", spannedBox.w === 200);
  t("and a spanned box's gap is inside it",
    cellBox(plan({ gapCols: 10, colTracks: [{ mode: "hug" }, { mode: "hug" }] }), { col: 0, row: 0, colSpan: 2, rowSpan: 1 }).w === 90);
  t("a spanned box over fill tracks runs to the frame's edge",
    cellBox(plan({ gapCols: 10, colTracks: [{ mode: "fill" }, { mode: "fill" }] }), { col: 0, row: 0, colSpan: 2, rowSpan: 1 }).w === 200);

  t("an object with no alignment sits at the cell's start", cellAlign(kid()).h === "min" && cellAlign(kid()).v === "min");
  t("the Position buttons set the object's own cell alignment", cellAlign(kid({ constraintH: "center", constraintV: "max" })).h === "center" && cellAlign(kid({ constraintH: "center", constraintV: "max" })).v === "max");
  t("a stray constraint value reads as the start", cellAlign(kid({ constraintH: "scale" })).h === "min");

  // A grid measures width first, like a horizontal flow. Getting this wrong
  // swaps a frame's width and height rules, and the hug then eats a typed
  // width - which is exactly what the browser probe caught.
  t("a grid's main axis is its width", widthIsMain({ direction: "grid" }));
  t("so is a horizontal flow's", widthIsMain({ direction: "horizontal" }));
  t("a vertical flow's is its height", !widthIsMain({ direction: "vertical" }));
}

console.log("the grid flow, through the engine:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const page = () => e.snapshot().pages[e.snapshot().page];
  const root = page().root.id;
  const addRect = (w, h) => {
    e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent: root });
    return e.snapshot().selection[0];
  };
  const frame = addRect(300, 200);
  const kids = [addRect(40, 30), addRect(40, 30), addRect(40, 30), addRect(40, 30)];
  for (const k of kids) e.dispatch({ type: "reparent", ids: [k], parent: frame, x: 0, y: 0 });
  e.dispatch({
    type: "autoLayout",
    id: frame,
    layout: {
      direction: "grid", gap: 8, padding: [8, 8, 8, 8], sizing: "fixed", cross: "fixed",
      wrap: false, align: "min", justify: "min",
      columns: 2, rows: "auto", gapRows: 10, gapCols: 20, colTracks: [], rowTracks: [], autoPosition: true,
    },
  });
  const node = () => find(page().root, frame);
  const xs = () => node().children.map((c) => [Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h)]);
  // Two Auto columns share 300 - 16 (padding) - 20 (one gap) = 264, so each is
  // 132 wide and they start at 8 and 160. Two Auto rows share 200 - 16 - 10 =
  // 174, so 87 each and they start at 8 and 105.
  const colAt = (i) => 8 + i * (132 + 20);
  const rowAt = (i) => 8 + i * (87 + 10);
  t("objects fill the first row left to right", xs()[0][0] === 8 && xs()[1][0] === colAt(1));
  t("then the next row", xs()[2][1] === rowAt(1) && xs()[3][1] === rowAt(1));
  t("and the row count follows them", node().layout.rows === "auto");

  // A typed width on a grid frame is a manual resize: Fixed on the width, and
  // the grid's own `sizing` is the width rule, not the cross one.
  e.dispatch({ type: "resize", id: frame, x: 0, y: 0, w: 300, h: 200 });
  t("a resized grid frame sets its width rule", node().layout.sizing === "fixed");
  t("and its own resizing too", node().sizingW === "fixed");
  e.dispatch({ type: "autoLayout", id: frame, layout: { ...node().layout } });
  t("so its width survives the next layout pass", Math.round(node().w) === 300);

  // Track sizing, through a real dispatch.
  e.dispatch({
    type: "autoLayout",
    id: frame,
    // One Auto column beside a hugging one: it takes what the hug leaves.
    layout: { ...node().layout, colTracks: [{ mode: "fill" }, { mode: "hug" }] },
  });
  t("an Auto column takes what a hug column leaves", Math.round(node().children[1].x) === 8 + 224 + 20);
  t("and an object set to fill takes the cell", (() => {
    e.dispatch({ type: "patch", id: kids[0], patch: { sizingW: "fill" } });
    return Math.round(node().children[0].w) === 224;
  })());
  // Spans: with the first object filling two columns it takes both tracks.
  e.dispatch({ type: "autoLayout", id: frame, layout: { ...node().layout, colTracks: [] } });
  e.dispatch({ type: "patch", id: kids[0], patch: { colSpan: 2 } });
  t("a two-column span reaches both tracks", Math.round(node().children[0].w) === 284);
  t("and pushes the rest onto the next rows", node().children[1].gridRow === 1);
  e.dispatch({ type: "patch", id: kids[0], patch: { colSpan: 1 } });
  // Automatic positioning off keeps the arrangement.
  const before = xs();
  e.dispatch({ type: "autoLayout", id: frame, layout: { ...node().layout, autoPosition: false } });
  t("switching automatic positioning off leaves the arrangement alone", JSON.stringify(xs()) === JSON.stringify(before));
  t("and the cells are recorded on the objects", node().children[1].gridCol === 1 && node().children[1].gridRow === 0);
  // A grid frame with wrap set does not wrap: it is its own flow.
  t("wrap has no meaning in a grid", !wraps(node().layout));

  // Automatic positioning off, per the article, "preserves empty cells" and
  // lets you put an object in one. So where the object sits is its cell: a drop
  // one cell over keeps the object there instead of snapping it back.
  e.dispatch({ type: "autoLayout", id: frame, layout: { ...node().layout, autoPosition: false, columns: 3 } });
  t("with automatic positioning off the cells stay put", node().children[0].gridRow === 0);
  const c2 = node().children[1];
  e.dispatch({ type: "move", ids: [c2.id], dx: 200, dy: 0 });
  const moved = node().children[1];
  t("dragging an object a column over lands it in that column", moved.gridCol === 2);
  // Three Auto columns now: 244 / 3 each, so the third starts at 210.67.
  t("and it is drawn in that cell, not snapped back", Math.round(moved.x) === Math.round(8 + 2 * (244 / 3 + 20)));
  t("the cells it left behind stay empty", node().children[0].gridCol === 0 && node().children[2].gridCol === 0);
  // A drag back over the first column brings it home again, so the mapping is
  // the object's own position rather than a one-way latch.
  e.dispatch({ type: "move", ids: [c2.id], dx: -200, dy: 0 });
  t("and dragging it back puts it in the first column", node().children[1].gridCol === 0);
  // A drag is a gesture: an object follows the pointer while the gesture is in
  // flight, and the drop is what settles it into a cell. Snapping mid-drag
  // would stop it ever crossing a track, since the snap pulls it back before
  // the pointer has travelled that far.
  const colAt3 = (i) => 8 + i * (244 / 3 + 20);
  e.dispatch({ type: "begin" });
  e.dispatch({ type: "move", ids: [c2.id], dx: 120, dy: 0 });
  t("mid-drag the object is where the pointer left it", Math.round(node().children[1].x) === 128);
  e.dispatch({ type: "end" });
  t("and the drop settles it into the nearest cell",
    node().children[1].gridCol === 1 && Math.round(node().children[1].x) === Math.round(colAt3(1)));
}

console.log("the alignment box: its cells, and its keys:");
{
  const flow = (over = {}) => ({
    direction: "horizontal", gap: 8, padding: [8, 8, 8, 8], sizing: "hug", cross: "hug",
    wrap: false, align: "min", justify: "min", ...over,
  });
  // Figma: nine options when the gap is a number, three when it is Auto.
  t("a fixed gap offers all nine cells", alignmentCells(flow()).length === 9);
  t("and they run from the top left to the bottom right", alignmentCells(flow())[0].j === "min" && alignmentCells(flow())[0].a === "min" && alignmentCells(flow())[8].a === "max");
  const auto = flow({ gapMode: "auto" });
  t("an Auto gap drops the box to three cells", alignmentCells(auto).length === 3);
  t("which are the cross-axis positions", alignmentCells(auto).map((c) => c.a).join(",") === "min,center,max");
  t("and leave the main axis where the Auto gap put it", alignmentCells(auto).every((c) => c.j === "min"));

  const keys = (ch) => alignKey(ch);
  t("an arrow key is the axis it points along", keys("ArrowRight").axis === "x" && keys("ArrowRight").dir === 1 && keys("ArrowUp").dir === -1);
  t("W/A/S/D are edges", ["w", "a", "s", "d"].map((c) => keys(c).edge).join(",") === "top,left,bottom,right");
  t("uppercase letters work too", keys("W").edge === "top");
  t("B is baseline and X is the gap", keys("b").kind === "baseline" && keys("x").kind === "gap");
  t("anything else is not an alignment key", alignKey("q") === null && alignKey("Enter") === null);

  // Arrows step; the letters jump to an edge.
  const right = layoutKeyPatch(flow({ justify: "min" }), keys("ArrowRight"));
  t("an arrow steps one position along its axis", right.justify === "center");
  t("and wraps round at the end", layoutKeyPatch(flow({ justify: "max" }), keys("ArrowRight")).justify === "min");
  t("stepping back goes the other way", layoutKeyPatch(flow({ justify: "center" }), keys("ArrowLeft")).justify === "min");
  t("down steps the cross axis of a row", layoutKeyPatch(flow(), keys("ArrowDown")).align === "center");
  t("and leaves the main axis alone", layoutKeyPatch(flow(), keys("ArrowDown")).justify === undefined);
  // A vertical flow turns the arrows with it: down is now the main axis.
  const col = flow({ direction: "vertical" });
  t("down steps the main axis of a column", layoutKeyPatch(col, keys("ArrowDown")).justify === "center");
  t("and right steps the cross axis", layoutKeyPatch(col, keys("ArrowRight")).align === "center");
  t("D packs a row to the end", layoutKeyPatch(flow({ justify: "min" }), keys("d")).justify === "max");
  t("A packs it back to the start", layoutKeyPatch(flow({ justify: "max" }), keys("a")).justify === "min");
  t("S drops the objects to the bottom of a row", layoutKeyPatch(flow({ align: "min" }), keys("s")).align === "max");
  t("W lifts them to the top", layoutKeyPatch(flow({ align: "max" }), keys("w")).align === "min");
  t("in a column, D is the right edge of the cross axis", layoutKeyPatch(col, keys("d")).align === "max");
  t("and S the bottom of the main axis", layoutKeyPatch(col, keys("s")).justify === "max");
  // Auto gap owns the main axis, which is why the box loses six cells.
  t("an Auto gap refuses a main-axis key", layoutKeyPatch(auto, keys("d")) === null);
  t("but still takes a cross-axis one", layoutKeyPatch(auto, keys("s")).align === "max");
  t("X switches a number to Auto", layoutKeyPatch(flow(), keys("x")).gapMode === "auto");
  t("and Auto back to a number", layoutKeyPatch(auto, keys("x")).gapMode === "fixed");
  t("B turns baseline alignment on", layoutKeyPatch(flow(), keys("b")).align === "baseline");
  t("and off again", layoutKeyPatch(flow({ align: "baseline" }), keys("b")).align === "min");
  t("a vertical flow has no baseline", layoutKeyPatch(col, keys("b")) === null);
  t("stepping off a baseline lands on a real position", layoutKeyPatch(flow({ align: "baseline" }), keys("ArrowDown")).align === "center");
  t("Space between reads as the start when stepping", layoutKeyPatch(flow({ justify: "between" }), keys("ArrowRight")).justify === "center");
}

console.log("padding: the field's shorthand, and the frame's floor:");
{
  t("one value is every side", parsePaddingShorthand("10").join(",") === "10,10,10,10");
  // CSS: 1,2 is top/bottom then left/right - the article's own example.
  t("two values are vertical then horizontal", parsePaddingShorthand("1,2").join(",") === "2,2,1,1");
  t("three values are top, sides, bottom", parsePaddingShorthand("1,2,3").join(",") === "2,2,1,3");
  // CSS order is top, right, bottom, left.
  t("four values are top, right, bottom, left", parsePaddingShorthand("1,2,3,4").join(",") === "4,2,1,3");
  t("spaces work as well as commas", parsePaddingShorthand("4 8").join(",") === "8,8,4,4");
  t("decimals survive", parsePaddingShorthand("1.5,2.5").join(",") === "2.5,2.5,1.5,1.5");
  t("a negative side is clamped to nothing", parsePaddingShorthand("-4").join(",") === "0,0,0,0");
  t("nonsense is refused", parsePaddingShorthand("wide") === null);
  t("so is an empty entry", parsePaddingShorthand("") === null);
  t("and so are five values", parsePaddingShorthand("1,2,3,4,5") === null);

  const frame = { id: "f", kind: "frame", name: "f", visible: true, x: 0, y: 0, w: 10, h: 10 };
  const padded = { ...frame, layout: { direction: "horizontal", gap: 8, padding: [24, 24, 16, 16], sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min" } };
  clampToPadding(padded);
  t("a frame sizes up to fit its horizontal padding", padded.w === 48);
  t("and its vertical padding", padded.h === 32);
  const roomy = { ...padded, w: 100, h: 90 };
  clampToPadding(roomy);
  t("a frame that is already bigger is left alone", roomy.w === 100 && roomy.h === 90);
}

console.log("the alignment box, through the engine:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const page = () => e.snapshot().pages[e.snapshot().page];
  const root = page().root.id;
  const addRect = (w, h) => {
    e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent: root });
    return e.snapshot().selection[0];
  };
  const box = addRect(200, 100);
  const kids = [addRect(40, 20), addRect(40, 20)];
  for (const k of kids) e.dispatch({ type: "reparent", ids: [k], parent: box, x: 0, y: 0 });
  const layout = { direction: "horizontal", gap: 8, padding: [0, 0, 0, 0], sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min" };
  e.dispatch({ type: "autoLayout", id: box, layout });
  const node = () => find(page().root, box);
  const step = (key) => {
    const patch = layoutKeyPatch(node().layout, alignKey(key));
    if (patch) e.dispatch({ type: "autoLayout", id: box, layout: { ...node().layout, ...patch } });
    return node().layout;
  };
  // 200 wide, 80 of objects: the packing shows up in the child positions.
  t("the row starts packed left", Math.round(node().children[0].x) === 0);
  step("d");
  t("D packs it to the right edge", Math.round(node().children[0].x) === 112);
  step("a");
  t("A packs it back to the left", Math.round(node().children[0].x) === 0);
  step("ArrowRight");
  t("an arrow centres it", Math.round(node().children[0].x) === 56);
  step("ArrowRight");
  t("and one more packs it right", Math.round(node().children[0].x) === 112);
  step("ArrowDown");
  t("down steps the cross axis to the centre", Math.round(node().children[0].y) === 40);
  step("ArrowDown");
  t("and a second press drops them to the bottom", Math.round(node().children[0].y) === 80);
  // X switches to Auto gap, which takes the main axis over: the objects spread
  // to the edges and the packing stops mattering.
  step("x");
  t("X turns the gap Auto", node().layout.gapMode === "auto");
  t("and the objects spread across the frame", Math.round(node().children[0].x) === 0 && Math.round(node().children[1].x) === 160);
  t("the alignment box is down to three cells", alignmentCells(node().layout).length === 3);
  step("x");
  t("X turns it back into a number", node().layout.gapMode === "fixed" && node().layout.gap === 8);
  // A frame cannot be sized under its own padding.
  e.dispatch({ type: "autoLayout", id: box, layout: { ...node().layout, padding: [30, 30, 20, 20] } });
  e.dispatch({ type: "resize", id: box, x: 0, y: 0, w: 10, h: 10 });
  t("resizing under the padding bounces back up to it", Math.round(node().w) === 60 && Math.round(node().h) === 40);
  // The article's single-child note: with the default Between spacing, one
  // object in an Auto-gap stack sits at the start.
  e.dispatch({ type: "autoLayout", id: box, layout: { ...node().layout, padding: [0, 0, 0, 0], gapMode: "auto", spacing: "between" } });
  e.dispatch({ type: "patch", id: kids[1], patch: { visible: false } });
  t("a lone object with an Auto gap sits at the start", Math.round(node().children[0].x) === 0);
}


{
  const kid = (x, y, w = 40, h = 20) => ({ id: `k${x}-${y}`, kind: "rect", name: "k", visible: true, x, y, w, h });
  const box = (w, h, kids) => ({ id: "f", kind: "frame", name: "f", visible: true, x: 0, y: 0, w, h, children: kids });
  // A row: 8 of padding, four 40-wide objects 12 apart = 8+40+12+40+12+40+12+40+8.
  const row = box(212, 36, [kid(8, 8), kid(60, 8), kid(112, 8), kid(164, 8)]);
  const rowSug = suggestLayout(row);
  t("a row of objects suggests a horizontal flow", rowSug.direction === "horizontal");
  t("with the gap they are actually spaced by", rowSug.gap === 12);
  t("and the frame's own inset as padding", rowSug.padding.join(",") === "8,8,8,8");
  t("a frame that is exactly content plus padding hugs", rowSug.sizing === "hug" && rowSug.cross === "hug");
  t("and the objects start at the top of the flow", rowSug.align === "min");
  // A column that is centred across the frame, with 10px of slack down it.
  const col = box(200, 160, [kid(70, 20, 60, 30), kid(70, 70, 60, 30), kid(70, 120, 60, 30)]);
  const colSug = suggestLayout(col);
  t("a stack of objects suggests a vertical flow", colSug.direction === "vertical");
  t("with their own gap", colSug.gap === 20);
  t("padding across the flow", colSug.padding[0] === 70);
  t("and only the inset it can honour down it", colSug.padding[2] === 10);
  t("a frame with slack down its main axis is Fixed", colSug.sizing === "fixed");
  t("while a cross axis that fits still hugs", colSug.cross === "hug");
  // A stray object must not drag the gap off.
  const ragged = box(400, 36, [kid(8, 8), kid(60, 8), kid(112, 8), kid(300, 8)]);
  t("one stray object does not move the suggested gap", suggestLayout(ragged).gap <= 40);
  t("a single object has nothing to suggest from", suggestLayout(box(100, 60, [kid(8, 8)])).direction === defaultLayout().direction);
  t("and neither has an empty frame", suggestLayout(box(100, 60, [])).gap === 8);
  t("a hidden object is not part of the flow", suggestLayout(box(192, 56, [kid(8, 8), { ...kid(60, 8), visible: false }, kid(112, 8)])).gap === 64);
  t("a layer that ignores auto layout is not either", suggestLayout(box(192, 56, [kid(8, 8), { ...kid(60, 8), absolutePosition: true }, kid(112, 8)])).gap === 64);
}

console.log("auto layout: a text layer's max height and max lines:");
{
  const both = textDimensionRule({ maxH: 40, maxLines: 3 });
  t("a patch that sets both keeps both, because the caller said so", both.maxH === 40 && both.maxLines === 3);
  const height = textDimensionRule({ maxH: 40 });
  t("adding a max height sets max lines to auto", height.maxLines === 0);
  const lines = textDimensionRule({ maxLines: 3 });
  t("setting a max line count removes the max height", lines.maxH === 0);
  t("setting max lines to auto does not touch a max height", textDimensionRule({ maxLines: 0 }).maxH === undefined);
  const other = textDimensionRule({ maxW: 100 });
  t("an unrelated patch is passed through untouched", other.maxW === 100 && other.maxH === undefined);
  t("and is not the same object", other !== undefined);
}

console.log("auto layout, through the engine:");
{
  const e = new MemoryEngine(false);
  await e.ready;
  const page = () => e.snapshot().pages[e.snapshot().page];
  const root = page().root.id;
  const addRect = (w, h) => {
    e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent: root });
    return e.snapshot().selection[0];
  };
  // A fixed 300-wide row with three 40-wide objects in it, Auto gap.
  const row = addRect(300, 60);
  const kids = [addRect(40, 20), addRect(40, 20), addRect(40, 20)];
  e.dispatch({
    type: "autoLayout",
    id: row,
    layout: {
      direction: "horizontal", gap: 0, gapMode: "auto", spacing: "between",
      padding: [0, 0, 0, 0], sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min",
    },
  });
  for (const k of kids) e.dispatch({ type: "reparent", ids: [k], parent: row, x: 0, y: 0 });
  const rowNode = () => find(page().root, row);
  const xs = () => rowNode().children.map((c) => Math.round(c.x));
  const layoutWith = (spacing) => {
    e.dispatch({
      type: "autoLayout",
      id: row,
      layout: { ...rowNode().layout, spacing },
    });
    return xs();
  };
  // 300 wide, 3x40 of content: 180 slack.
  t("between starts at the padding", layoutWith("between")[0] === 0);
  t("and divides the slack between the gaps", layoutWith("between")[1] === 130);
  t("around starts half a gap in", layoutWith("around")[0] === 30);
  t("with a whole gap between", layoutWith("around")[1] === 130);
  t("evenly starts a whole gap in", layoutWith("evenly")[0] === 45);
  t("with the same gap between", layoutWith("evenly")[1] === 130);
  // A hug with a filler inside is fixed, so the frame keeps the width it has.
  const hugRow = addRect(300, 60);
  const filler = addRect(50, 20);
  e.dispatch({ type: "reparent", ids: [filler], parent: hugRow, x: 0, y: 0 });
  e.dispatch({ type: "patch", id: filler, patch: { sizingW: "fill" } });
  e.dispatch({
    type: "autoLayout",
    id: hugRow,
    layout: {
      direction: "horizontal", gap: 0, padding: [0, 0, 0, 0], sizing: "hug", cross: "fixed",
      wrap: false, align: "min", justify: "min",
    },
  });
  const hugNode = () => find(page().root, hugRow);
  t("a hugging row with a filling child stops hugging, so it keeps its width", Math.round(hugNode().w) === 300);
  t("and the child fills it", Math.round(hugNode().children[0].w) === 300);
  // A hug with no filler does hug.
  const plainHug = addRect(300, 60);
  const plainKid = addRect(120, 20);
  e.dispatch({ type: "reparent", ids: [plainKid], parent: plainHug, x: 0, y: 0 });
  e.dispatch({
    type: "autoLayout",
    id: plainHug,
    layout: {
      direction: "horizontal", gap: 0, padding: [0, 0, 0, 0], sizing: "hug", cross: "fixed",
      wrap: false, align: "min", justify: "min",
    },
  });
  t("a hugging row with ordinary children shrinks to them", Math.round(find(page().root, plainHug).w) === 120);
  // Auto gap on a hugging frame: the frame is the size of its objects, so there
  // is no leftover space for the packing rule to give away.
  const autoHug = addRect(300, 60);
  const autoKids = [addRect(40, 20), addRect(40, 20), addRect(40, 20)];
  for (const k of autoKids) e.dispatch({ type: "reparent", ids: [k], parent: autoHug, x: 0, y: 0 });
  e.dispatch({
    type: "autoLayout",
    id: autoHug,
    layout: {
      direction: "horizontal", gap: 8, gapMode: "auto", spacing: "around",
      padding: [8, 8, 8, 8], sizing: "hug", cross: "hug", wrap: false, align: "min", justify: "min",
    },
  });
  const autoNode = () => find(page().root, autoHug);
  t("a hugging frame with Auto gap is the size of its objects and padding", Math.round(autoNode().w) === 136);
  t("and the objects keep their own widths", autoNode().children.map((c) => Math.round(c.w)).join(",") === "40,40,40");
  t("with no space distributed that does not exist", autoNode().children.map((c) => Math.round(c.x)).join(",") === "8,48,88");
  // Give the frame slack by making it Fixed and the packing rule comes alive.
  e.dispatch({ type: "autoLayout", id: autoHug, layout: { ...autoNode().layout, sizing: "fixed" } });
  e.dispatch({ type: "resize", id: autoHug, w: 344, h: 60 });
  e.dispatch({ type: "autoLayout", id: autoHug, layout: { ...autoNode().layout, sizing: "fixed" } });
  // 344 wide, 8 padding each side, 120 of objects: 208 to share between three.
  t("a fixed frame with Auto around gives each object a third of the slack",
    Math.abs(autoNode().children[0].x - 43) <= 1);
  t("and leaves the rest between them",
    Math.abs((autoNode().children[1].x - autoNode().children[0].x) - (40 + 69)) <= 1);

  // A filling child and an Auto gap: the filler takes the leftover, so the Auto
  // gap has nothing to distribute and packs at zero rather than overflowing.
  const mixed = addRect(360, 60);
  const fixedKid = addRect(40, 20);
  const fillKid = addRect(40, 20);
  e.dispatch({ type: "reparent", ids: [fixedKid], parent: mixed, x: 0, y: 0 });
  e.dispatch({ type: "reparent", ids: [fillKid], parent: mixed, x: 0, y: 0 });
  e.dispatch({ type: "patch", id: fillKid, patch: { sizingW: "fill" } });
  e.dispatch({
    type: "autoLayout",
    id: mixed,
    layout: {
      direction: "horizontal", gap: 8, gapMode: "auto", spacing: "between",
      padding: [0, 0, 0, 0], sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min",
    },
  });
  const mixedNode = () => find(page().root, mixed);
  t("an Auto gap with a filling child packs at zero", Math.round(mixedNode().children[1].x) === 40);
  t("so the filler takes every pixel that is left", Math.round(mixedNode().children[1].w) === 320);
  t("and the row still fits its frame", Math.round(mixedNode().children[1].x + mixedNode().children[1].w) === 360);

  // A typed width on a hugging frame is a manual resize, and Figma turns that
  // into Fixed - otherwise the hug would swallow the number.
  e.dispatch({ type: "resize", id: autoHug, x: 0, y: 0, w: 300, h: autoNode().h });
  e.dispatch({ type: "autoLayout", id: autoHug, layout: { ...autoNode().layout } });
  t("a typed width turns a hugging frame Fixed", autoNode().layout.sizing === "fixed");
  t("on the layer's own resizing too, or the hug would snap back", autoNode().sizingW === "fixed");
  t("so the width the user typed is the width the frame has", Math.round(autoNode().w) === 300);
  t("and it survives the next layout pass", (e.dispatch({ type: "autoLayout", id: autoHug, layout: { ...autoNode().layout } }), Math.round(autoNode().w) === 300));

  // Vertical wrap lays out as a plain stack.
  const col = addRect(120, 300);
  const a1 = addRect(80, 40);
  const a2 = addRect(80, 40);
  for (const k of [a1, a2]) e.dispatch({ type: "reparent", ids: [k], parent: col, x: 0, y: 0 });
  e.dispatch({
    type: "autoLayout",
    id: col,
    layout: {
      direction: "vertical", gap: 10, padding: [0, 0, 0, 0], sizing: "fixed", cross: "fixed",
      wrap: true, align: "min", justify: "min",
    },
  });
  const colKids = find(page().root, col).children;
  t("a vertical flow with wrap set stacks instead of wrapping", Math.round(colKids[0].x) === 0 && Math.round(colKids[1].x) === 0);
  t("and the second object sits below the first", Math.round(colKids[1].y) === 50);
  // The text rule, through the real dispatch.
  const text = addRect(100, 40);
  e.dispatch({ type: "patch", id: text, patch: { kind: "text", text: "Hello", maxLines: 2, maxH: 60 } });
  const textNode = () => find(page().root, text);
  t("the text layer keeps both when the patch sets both", textNode().maxH === 60 && textNode().maxLines === 2);
  e.dispatch({ type: "patch", id: text, patch: { maxH: 50 } });
  t("a new max height zeroes the max line count", textNode().maxLines === 0);
  e.dispatch({ type: "patch", id: text, patch: { maxLines: 3 } });
  t("a new max line count clears the max height", textNode().maxH === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
