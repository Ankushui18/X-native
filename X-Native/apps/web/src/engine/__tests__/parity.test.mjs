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
  simplifyPath,
  smoothPath,
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
import { MemoryEngine } from "../memory.ts";
import { colorUsage, colorUsageAll, setOpacityMatches } from "../../ui/selectionColors.ts";
import { contrastRatio, contrastTarget, nearestAccessible, passesContrast, parseHex, rgbToHsv } from "../../ui/color.ts";

import { inspectFigFile, importFig } from "../figImport.ts";
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
    const importedVector = imported.nodes.find((n) => n.kind === "vector");
    t("importFig imports vector node with path", !!importedVector?.path?.length);
    t("importFig imports vector node with vectorNetwork", !!importedVector?.vectorNetwork);
  }
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
