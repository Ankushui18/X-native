/** Batch 3: real mounted Canvas gestures and inspector controls. */
import { installDom, mountPanel } from "./domEnv.mjs";
import { MemoryEngine, node, find, localToWorld } from "../../engine/memory.ts";
import { pathToVectorNetwork, vectorNetworkToPath, normalizeVectorNode } from "../../engine/geometry.ts";
import { variableWidthBlockReason, usesVariableWidth } from "../../engine/strokeModel.ts";
import { textDimensionRule as exclusiveTextLimits } from "../../engine/layout.ts";
import { pointBox, pointBoxHandles, resizePointNetwork } from "../pointBox.ts";
import { textMetrics } from "../textLayout.ts";
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
const near = (a, b) => Math.abs(a-b) < 1e-6;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const page = (...children) => node("frame", "Page", 0, 0, 2000, 2000, { children });
const window = installDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Canvas } = await import("../Canvas.tsx");
const { ThemeProvider } = await import("../theme.tsx");
const { act, useSyncExternalStore } = React;
let paints = [];
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({
    canvas: this,
    measureText: (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  }, {
    get(target, key) {
      return key in target ? target[key] : (...args) => paints.push([key, ...args]);
    },
  });
};
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 50, top: 30, x: 50, y: 30, width: 1000, height: 800, right: 1050, bottom: 830 });

async function mount(children, selection = [], view = {}) {
  const engine = new MemoryEngine(false, {
    pages: [{ id: "test-page", name: "Page", root: page(...children), guides: [], comments: [] }], page: 0,
    zoom: 1, panX: 0, panY: 0, ...view,
  });
  engine.dispatch({ type: "select", ids: selection });
  function Host() {
    const snap = useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.snapshot());
    return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap }));
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  paints = [];
  await act(async () => reactRoot.render(React.createElement(Host)));
  const surface = host.querySelector(".canvas-wrap");
  const ui = {
    engine, host, surface,
    snap: () => engine.snapshot(),
    node: (id) => find(engine.snapshot().pages[0].root, id),
    async dispatch(cmd) {
      paints = [];
      await act(async () => engine.dispatch(cmd));
    },
    async mouse(type, x, y, extra = {}) {
      await act(async () => surface.dispatchEvent(new window.MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x + 50, clientY: y + 30, button: 0, ...extra,
      })));
    },
    async click(x, y, extra = {}) {
      await ui.mouse("mousedown", x, y, extra);
      await ui.mouse("mouseup", x, y, extra);
    },
    async dbl(x, y) {
      await ui.click(x, y, { detail: 1 });
      await ui.click(x, y, { detail: 2 });
      await ui.mouse("dblclick", x, y, { detail: 2 });
    },
    async close() {
      await act(async () => reactRoot.unmount());
      host.remove();
    },
  };
  return ui;
}
const square = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
const profile = [{position:0,widthMultiplier:1},{position:1,widthMultiplier:2}];
const yNet = { vertices:[{x:0,y:0},{x:100,y:0},{x:50,y:50},{x:50,y:100}], segments:[{start:0,end:2},{start:1,end:2},{start:2,end:3}], regions:[] };
for (const [label, extra, reason] of [
  ['branch',{vectorNetwork:yNet},'Split vector'], ['legacy dash',{strokeDash:4},'Remove dashes'],
  ['pattern',{strokeDashPattern:[2,3]},'Remove dashes'], ['zero pattern',{strokeDashPattern:[0]},'Remove dashes'],
]) {
  const ui = await mountPanel({layer(e){
    e.dispatch({type:'add',kind:'vector',x:100,y:100,w:100,h:100,extra:{path:square,closed:true,strokeVisible:true,strokeWidth:10,strokePaint:'#000000',strokeWidthProfile:profile,...extra}});
    return e.snapshot().selection[0];
  }});
  const field = ui.one('fieldset.width-profile');
  t(`${label}: width controls visible but disabled with explanation`, !!field?.disabled && field.title.includes(reason));
  t(`${label}: render profile is disabled`, !usesVariableWidth(ui.node()) && !!variableWidthBlockReason(ui.node()));
  const before = JSON.stringify(ui.node().strokeWidthProfile);
  await act(async()=>ui.one('.width-profile svg').dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:0,clientX:180,clientY:50})));
  await ui.click(ui.one('.width-profile button'));
  t(`${label}: synthetic pointer and Reset cannot change profile`, JSON.stringify(ui.node().strokeWidthProfile)===before);
  await ui.dispatch({type:'patch',id:ui.id,patch:{vectorNetwork:pathToVectorNetwork(square,true),strokeDash:0,strokeDashPattern:[]}});
  t(`${label}: removing restriction restores stored profile`, !ui.one('fieldset.width-profile').disabled && usesVariableWidth(ui.node()));
  await ui.unmount();
}
{
  const ui=await mountPanel({layer(e){e.dispatch({type:'add',kind:'text',x:100,y:100,w:200,h:100,extra:{text:'one\ntwo\nthree',truncate:true,sizingH:'hug',sizingW:'fixed',maxLines:3}});return e.snapshot().selection[0]}});
  await ui.click(ui.byText('Type settings'));
  await ui.click(ui.byText('Add min/max width and height'));
  await ui.type(ui.byLabel('Max H'), 60);
  t('Max H clears lines in mounted inspector', ui.node().maxH===60 && ui.node().maxLines===0);
  await ui.type(ui.byLabel('Max lines'), 2);
  t('Max lines clears height in mounted inspector', ui.node().maxLines===2 && ui.node().maxH===undefined);
  for(const label of ['Max lines','Max H']) for(const invalid of ['0','-1','','bad','2bad','1/0']) {
    await ui.type(ui.byLabel(label),label==='Max H'?60:2);
    await ui.type(ui.byLabel(label),invalid);
    t(`${label} ${JSON.stringify(invalid)} clears both`, ui.node().maxLines===0 && ui.node().maxH===undefined);
  }
  for(const patch of [{maxLines:NaN},{maxLines:undefined},{maxH:Infinity},{maxH:-2},{maxH:undefined}]) {
    await ui.dispatch({type:'patch',id:ui.id,patch:{maxLines:3}});
    await ui.dispatch({type:'patch',id:ui.id,patch});
    t('API invalid/empty limit clears both',ui.node().maxLines===0 && ui.node().maxH===undefined);
  }
  await ui.dispatch({type:'patch',id:ui.id,patch:{maxLines:4,maxH:70}});
  t('explicit positive height wins simultaneous API patch',ui.node().maxLines===0 && ui.node().maxH===70);
  const unchanged={opacity:.5};t('unrelated patches leave limits untouched',exclusiveTextLimits(unchanged)===unchanged);
  await ui.dispatch({type:'patch',id:ui.id,patch:{maxLines:0}});
  t('cleared lines no longer silently truncate measurement to one',textMetrics({measureText:s=>({width:s.length*6})},ui.node(),ui.node().text).lines===3);
  await ui.unmount();
}
for(const tool of ['select','scale']) for(const multi of [false,true]) {
  const a=node('rect','A',100,100,100,100,{strokeWidth:10,strokeVisible:true});
  const b=node('rect','B',250,100,100,100,{strokeWidth:10,strokeVisible:true});
  const ui=await mount(multi?[a,b]:[a],multi?[a.id,b.id]:[a.id],{tool});
  await ui.dispatch({type:"setTool",tool});
  const commands=[];const dispatch=ui.engine.dispatch.bind(ui.engine);ui.engine.dispatch=c=>{commands.push(c);dispatch(c)};
  const right=multi?350:200, width=right-100;
  await ui.mouse('mousedown',right,200);
  await ui.mouse('mousemove',right+width*.5,250);
  await ui.mouse('mousemove',right+width,300);
  await ui.mouse('mouseup',right+width,300);
  const n=ui.node(a.id);
  t(`${tool} ${multi?'multi':'single'}: doubles dimensions`,near(n.w,200)&&near(n.h,200));
  t(`${tool} ${multi?'multi':'single'}: correct non-compounding stroke`,near(n.strokeWidth,tool==='scale'?20:10));
  const resizes=commands.filter(c=>c.type==='resize');
  t(`${tool} ${multi?'multi':'single'}: dispatch flags`,resizes.length>0&&resizes.every(c=>c.scaleProps===(tool==='scale') && c.ignoreConstraints===false));
  await ui.dispatch({type:'undo'});
  t(`${tool} ${multi?'multi':'single'}: gesture is one undo`,ui.node(a.id).w===100&&ui.node(a.id).strokeWidth===10);
  await ui.close();
}
// A storage order different from the editable walk, plus a branch/region that
// must not disappear. Four editable path points, one untouched branch endpoint.
const net={vertices:[{x:100,y:100},{x:0,y:0},{x:200,y:50},{x:0,y:100},{x:100,y:0}],segments:[{start:1,end:4},{start:4,end:0},{start:0,end:3},{start:3,end:1},{start:4,end:2,tangentEnd:{x:10,y:5}}],regions:[{windingRule:'nonzero',loops:[[0,1,2,3]]}]};
for(const [label, modifiers, expected, handle, dx, dy] of [
  ['free',{},[150,125,0,0],4,50,25],['Shift',{shiftKey:true},[150,150,-25,0],5,0,50],
  ['Alt',{altKey:true},[200,150,-50,-25],4,50,25],['Alt+Shift',{altKey:true,shiftKey:true},[200,200,-50,-50],5,0,50],
  ['Command is not Option',{metaKey:true},[150,125,0,0],4,50,25],
]) {
  const n=node('vector','Graph',100,100,200,100,{path:vectorNetworkToPath(net).path,closed:true,vectorNetwork:structuredClone(net)});
  const ui=await mount([n],[n.id]);
  await ui.dispatch({type:'setVecEdit',id:n.id,pointIndices:[0,1,2,3]});
  const root=ui.snap().pages[0].root;const box=pointBox(root,n.id,[0,1,2,3]);
  t(`${label}: editable points mapped to graph indices`,same(box.indices,[1,4,0,3]));
  const [x,y]=pointBoxHandles(box.bounds,1)[handle];
  await ui.mouse('mousedown',x,y);
  await ui.mouse('mousemove',x+dx*.4,y+dy*.4,modifiers);
  await ui.mouse('mousemove',x+dx,y+dy,modifiers);
  await ui.mouse('mouseup',x+dx,y+dy,modifiers);
  const got=ui.node(n.id).vectorNetwork;
  const [w,h,minx,miny]=expected;
  t(`${label}: real point-box drag gives expected size and pivot`,near(got.vertices[0].x,minx+w)&&near(got.vertices[0].y,miny+h)&&near(got.vertices[1].x,minx)&&near(got.vertices[1].y,miny));
  t(`${label}: preserves unselected vertex, branch, region`,same(got.vertices[2],net.vertices[2])&&same(got.regions,net.regions)&&got.segments.length===5&&same(got.segments[4].tangentEnd,net.segments[4].tangentEnd));
  await ui.dispatch({type:'undo'});t(`${label}: one-step undo`,same(ui.node(n.id).vectorNetwork,net));
  await ui.dispatch({type:'redo'});t(`${label}: redo`,same(ui.node(n.id).vectorNetwork,got));
  const before=got.vertices.map(v=>localToWorld(ui.snap().pages[0].root,n.id,v.x,v.y));
  await ui.dispatch({type:'setVecEdit',id:null});
  const after=ui.node(n.id).vectorNetwork;
  t(`${label}: exiting retains topology/world positions`,after.segments.length===5&&same(after.regions,net.regions)&&after.vertices.every((v,i)=>{const p=localToWorld(ui.snap().pages[0].root,n.id,v.x,v.y);return near(p.x,before[i].x)&&near(p.y,before[i].y)}));
  await ui.close();
}
for(const corner of [0,1,2,3,4,5,6,7]) for(const shift of [false,true]) {
  const n=node('vector','Points',100,100,100,100,{path:square,closed:true,vectorNetwork:pathToVectorNetwork(square,true)});const root=page(n),box=pointBox(root,n.id,[0,1,2,3]);
  const got=resizePointNetwork(root,n.id,box.network,box.indices,box.bounds,corner,10,20,shift,false);
  const xs=got.vertices.map(v=>v.x),ys=got.vertices.map(v=>v.y),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
  t(`handle ${corner} Shift=${shift}: finite, uniform when requested`,got.vertices.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.y))&&(!shift||near(w,h)));
  t(`handle ${corner} Shift=${shift}: immutable source`,same(n.vectorNetwork,pathToVectorNetwork(square,true)));
}
for(const rotation of [0,35,90]) for(const flipH of [false,true]) {
  const n=node('vector','Transformed',100,100,200,100,{rotation,flipH,path:vectorNetworkToPath(net).path,vectorNetwork:structuredClone(net)});
  const parent=node('frame','Rotated parent',50,50,500,400,{rotation:20,flipV:true,children:[n]});const root=page(parent),box=pointBox(root,n.id,[0,1,2,3]);
  const got=resizePointNetwork(root,n.id,box.network,box.indices,box.bounds,4,50,25,true,true);
  n.vectorNetwork=got;n.path=vectorNetworkToPath(got).path;
  const before=got.vertices.map(v=>localToWorld(root,n.id,v.x,v.y));normalizeVectorNode(n);
  t(`normalize ${rotation}/${flipH}: preserves every transformed graph position`,n.vectorNetwork.vertices.every((v,i)=>{const p=localToWorld(root,n.id,v.x,v.y);return near(p.x,before[i].x)&&near(p.y,before[i].y)}));
}
for(const path of [[{x:0,y:0},{x:0,y:100}],[{x:0,y:0},{x:100,y:0}],[{x:0,y:0},{x:0,y:0}]]) {
  const n=node('vector','Degenerate',100,100,100,100,{path,vectorNetwork:pathToVectorNetwork(path,false)}),root=page(n),box=pointBox(root,n.id,[0,1]);
  const got=resizePointNetwork(root,n.id,box.network,box.indices,box.bounds,4,50,25,true,true);
  t('degenerate selection does not create NaN',got.vertices.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.y)));
}
// Keep ordinary anchor movement distinct from the padded resize handles.
{
  const n=node('vector','Move anchors',100,100,100,100,{path:square,closed:true});
  const ui=await mount([n],[n.id]);await ui.dispatch({type:'setVecEdit',id:n.id,pointIndices:[0,1,2,3]});
  await ui.mouse('mousedown',100,100);await ui.mouse('mousemove',110,102,{shiftKey:true});
  await ui.mouse('mousemove',120,105,{shiftKey:true});await ui.mouse('mouseup',120,105);
  t('ordinary multi-anchor Shift drag still moves along one axis',ui.node(n.id).path.every((p,i)=>near(p.x,square[i].x+20)&&near(p.y,square[i].y)));
  await ui.close();
}
for(const zoom of [.5,2]) {
  const n=node('vector','Zoomed rotated points',100,100,100,100,{rotation:35,flipH:true,path:square,closed:true,vectorNetwork:pathToVectorNetwork(square,true)});
  const ui=await mount([n],[n.id],{zoom,panX:30,panY:20});await ui.dispatch({type:'setVecEdit',id:n.id,pointIndices:[0,1,2,3]});
  const box=pointBox(ui.snap().pages[0].root,n.id,[0,1,2,3]);const [wx,wy]=pointBoxHandles(box.bounds,zoom)[5];const x=30+wx*zoom,y=20+wy*zoom;
  const dy=box.bounds.h*.125*zoom;
  await ui.mouse('mousedown',x,y);await ui.mouse('mousemove',x,y+dy,{shiftKey:true,altKey:true});await ui.mouse('mouseup',x,y+dy);
  const next=pointBox(ui.snap().pages[0].root,n.id,[0,1,2,3]);
  t(`mounted rotated/flipped zoom ${zoom}: centered proportional edge resize`,near(next.bounds.w,box.bounds.w*1.25)&&near(next.bounds.h,box.bounds.h*1.25)&&near(next.bounds.x+next.bounds.w/2,box.bounds.x+box.bounds.w/2)&&near(next.bounds.y+next.bounds.h/2,box.bounds.y+box.bounds.h/2));
  await ui.close();
}
{
  const network=structuredClone(net);network.segments[4].tangentStart={x:5,y:10};
  const n=node('vector','Tangents',100,100,200,100,{path:vectorNetworkToPath(network).path,vectorNetwork:network});const root=page(n),box=pointBox(root,n.id,[0,1,2,3]);
  const resized=resizePointNetwork(root,n.id,network,box.indices,box.bounds,4,100,100,false,false);
  t('selected endpoint tangent scales with its vertex',same(resized.segments[4].tangentStart,{x:10,y:20}));
  t('unselected endpoint tangent remains unchanged',same(resized.segments[4].tangentEnd,network.segments[4].tangentEnd));
  n.locked=true;t('locked vector has no interactive point box',pointBox(root,n.id,[0,1,2,3])===null);
}
console.log(`\n${pass} passed, ${fail} failed`);
if(fail)process.exitCode=1;
