/**
 * Headless checks for the parity work added in FIGMA_PARITY_AUDIT_2026-09-22.
 *
 * Run with:  npx vite-node src/engine/__tests__/parity.test.mjs
 *
 * These cover the pure geometry/snapping helpers, which is where the logic
 * that is easy to get subtly wrong lives. Canvas wiring is verified in-browser.
 */
import { snapMove, snapCandidates } from "../snapping.ts";
import { simplifyPath, smoothPath, erasePath } from "../geometry.ts";
import { MemoryEngine } from "../memory.ts";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
