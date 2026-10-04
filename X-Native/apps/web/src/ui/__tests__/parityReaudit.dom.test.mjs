/** Re-audit regressions: execute real Canvas handlers, not source regexes. */
import { installDom } from "./domEnv.mjs";
import { MemoryEngine, node, find } from "../../engine/memory.ts";
import { textMetrics, listGutter } from "../textLayout.ts";
import { rotationHandleHit } from "../canvasSelection.ts";
let pass=0,fail=0;
const t=(name,ok)=>{ok?pass++:fail++;console.log(`${ok?'ok  ':'FAIL'} ${name}`)};
const near=(a,b)=>Math.abs(a-b)<.11;
const page=(...children)=>node('frame','Page',0,0,2000,2000,{children});
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

for(const zoom of [.5,1,2]) {
 const a=node('rect','A',100,100,100,100),b=node('rect','B',300,100,100,100);
 const ui=await mount([a,b],[a.id,b.id],{zoom,panX:30,panY:20});
 const x=30+100*zoom-10,y=20+100*zoom-10,cx=30+250*zoom,cy=20+150*zoom;
 await ui.mouse('mousedown',x,y);await ui.mouse('mousemove',x,y);
 t(`multi-rotate zoom ${zoom}: stationary pointer cannot change angle`,near(ui.node(a.id).rotation,0)&&near(ui.node(b.id).rotation,0));
 const angle=Math.atan2(y-cy,x-cx)+Math.PI/12,reach=Math.hypot(x-cx,y-cy);
 const tx=cx+reach*Math.cos(angle),ty=cy+reach*Math.sin(angle);
 await ui.mouse('mousemove',tx,ty,{shiftKey:true});await ui.mouse('mouseup',tx,ty);
 t(`multi-rotate zoom ${zoom}: Shift gesture rotates exactly 15 degrees`,near(ui.node(a.id).rotation,15)&&near(ui.node(b.id).rotation,15));
 const rotated={x:ui.node(a.id).x,y:ui.node(a.id).y};
 await ui.dispatch({type:'undo'});t(`multi-rotate zoom ${zoom}: undo restores positions and angle`,near(ui.node(a.id).rotation,0)&&near(ui.node(a.id).x,100)&&near(ui.node(b.id).x,300));
 await ui.dispatch({type:'redo'});t(`multi-rotate zoom ${zoom}: redo restores transform`,near(ui.node(a.id).rotation,15)&&near(ui.node(a.id).x,rotated.x)&&near(ui.node(a.id).y,rotated.y));
 await ui.close();
}
for(const multi of [false,true]) {
 const a=node('rect','A',100,100,100,100),b=node('rect','B',300,100,100,100);
 const ui=await mount(multi?[a,b]:[a],multi?[a.id,b.id]:[a.id]);
 // Seven pixels from NW: the cursor advertises resize, not rotation.
 await ui.mouse('mousemove',93,100);
 t(`corner ${multi?'multi':'single'}: cursor advertises resize`,ui.surface.style.cursor==='nwse-resize');
 await ui.mouse('mousedown',93,100);await ui.mouse('mousemove',80,80);await ui.mouse('mouseup',80,80);
 t(`corner ${multi?'multi':'single'}: resize cursor starts resize`,ui.node(a.id).rotation===0&&ui.node(a.id).w>100&&ui.node(a.id).h>100);
 await ui.close();
}
for(const offset of [0,3,6,7.99])t(`rotation excludes resize radius ${offset}`,!rotationHandleHit('rect',100-offset,100,100,100,100,100));
// Rotation ring is now outside the top-right corner (200,100), not top-left.
t('rotation remains reachable outside top-right corner',rotationHandleHit('rect',200+16,100-16,100,100,100,100));
// Figma arms rotation at "one of the layer's bounds" corners (360039956914) -
// the single-selection ring matches the multi-selection one: all four.
t('every corner advertises rotation now',rotationHandleHit('rect',90,90,100,100,100,100)&&rotationHandleHit('rect',210,110,100,100,100,100));
for(const zoom of [.5,1,2]) {
 const a=node('rect','A',100,100,100,100),b=node('rect','B',300,100,100,100);
 const ui=await mount([a,b],[a.id,b.id],{zoom});
 const cmds=[];const dispatch=ui.engine.dispatch.bind(ui.engine);ui.engine.dispatch=c=>{cmds.push(c);dispatch(c)};
 await ui.mouse('mousedown',150*zoom,150*zoom);
 t(`multi-move zoom ${zoom}: pressing a selected object retains the set`,ui.snap().selection.length===2);
 await ui.mouse('mousemove',170*zoom,165*zoom,{ctrlKey:true});await ui.mouse('mouseup',170*zoom,165*zoom,{ctrlKey:true});
 t(`multi-move zoom ${zoom}: every selected object moves equally`,near(ui.node(a.id).x,120)&&near(ui.node(b.id).x,320)&&near(ui.node(a.id).y,115)&&near(ui.node(b.id).y,115));
 t(`multi-move zoom ${zoom}: uses move, never resize/constraints`,cmds.some(c=>c.type==='move'&&c.ids.length===2)&&!cmds.some(c=>c.type==='resize'));
 await ui.dispatch({type:'undo'});t(`multi-move zoom ${zoom}: one undo restores both`,ui.node(a.id).x===100&&ui.node(b.id).x===300);
 await ui.dispatch({type:'redo'});t(`multi-move zoom ${zoom}: redo restores both`,ui.node(a.id).x===120&&ui.node(b.id).x===320);
 await ui.close();
}
{
 const a=node('rect','A',100,100,100,100),b=node('rect','B',300,100,100,100),c=node('rect','C',500,100,100,100);
 const ui=await mount([a,b,c],[a.id,b.id]);
 await ui.click(150,150,{shiftKey:true});t('Shift-click still removes one selected layer',ui.snap().selection.length===1&&ui.snap().selection[0]===b.id);
 await ui.dispatch({type:'select',ids:[a.id,b.id]});await ui.click(550,150);t('clicking an unselected layer replaces the set',ui.snap().selection.length===1&&ui.snap().selection[0]===c.id);
 await ui.close();
}
for(const fontStyle of ['normal','italic']) for(const textCase of ['none','upper','small-caps']) {
 const n=node('text','Styled text',0,0,100,100,{fontStyle,textCase,fontFamily:'Arial',fontWeight:400,fontSize:20,sizingW:'hug',listStyle:'bulleted'});
 const seen=[];const ctx={font:'',measureText(text){seen.push({font:this.font,text});return {width:text.length*10}}};
 textMetrics(ctx,n,'aBc');
 t(`text metrics ${fontStyle}/${textCase}: use painted font and case`,seen.some(s=>s.text===(textCase==='upper'?'ABC':textCase==='small-caps'?'abc':'aBc'))&&ctx.font.includes('italic')===(fontStyle==='italic')&&ctx.font.includes('small-caps')===(textCase==='small-caps'));
 listGutter(ctx,n);t(`list metrics ${fontStyle}/${textCase}: use painted font`,ctx.font.includes('italic')===(fontStyle==='italic')&&ctx.font.includes('small-caps')===(textCase==='small-caps'));
}
// An ancestor already carries selected descendants in world space.
for(const type of ['move','nudge']) for(const reverse of [false,true]) {
 const child=node('rect','Child',20,20,80,40),grand=node('rect','Grandchild',5,5,10,10);
 child.children=[grand];
 const parent=node('frame','Parent',100,100,400,400,{children:[child]});
 const peer=node('rect','Peer',600,100,100,100);
 const ui=await mount([parent,peer],reverse?[grand.id,child.id,parent.id,peer.id]:[parent.id,child.id,grand.id,peer.id]);
 const ids=[...ui.snap().selection];
 await ui.dispatch({type:'begin'});
 await ui.dispatch({type,ids,dx:10,dy:5});await ui.dispatch({type:'end'});
 t(`${type} reverse=${reverse}: descendants move only with ancestor`,ui.node(parent.id).x===110&&ui.node(parent.id).y===105&&ui.node(child.id).x===20&&ui.node(grand.id).x===5);
 t(`${type} reverse=${reverse}: unrelated peer also moves`,ui.node(peer.id).x===610&&ui.node(peer.id).y===105);
 t(`${type} reverse=${reverse}: selection and sizes retained`,ui.snap().selection.join()===ids.join()&&ui.node(parent.id).w===400&&ui.node(child.id).w===80);
 await ui.dispatch({type:'undo'});
 t(`${type} reverse=${reverse}: undo restores all`,ui.node(parent.id).x===100&&ui.node(child.id).x===20&&ui.node(peer.id).x===600);
 await ui.dispatch({type:'redo'});
 t(`${type} reverse=${reverse}: redo moves child once`,ui.node(parent.id).x+ui.node(child.id).x===130&&ui.node(peer.id).x===610);
 await ui.close();
}
{
 const child=node('rect','Child',20,20,80,40),parent=node('frame','Locked',100,100,400,400,{locked:true,children:[child]});
 const peer=node('rect','Peer',600,100,100,100);const ui=await mount([parent,peer],[parent.id,child.id,peer.id]);
 await ui.dispatch({type:'move',ids:[parent.id,child.id,peer.id,peer.id],dx:10,dy:5});
 t('ancestor filtering retains effective lock protection',ui.node(parent.id).x===100&&ui.node(child.id).x===20);
 t('move deduplicates targets',ui.node(peer.id).x===610);
 await ui.close();
}
for(const type of ['move','nudge']) {
 const a=node('rect','A',0,0,40,40),b=node('rect','B',0,0,40,40);
 const parent=node('frame','Auto Layout',100,100,400,100,{children:[a,b],layout:{direction:'horizontal',gap:10,padding:[0,0,0,0],sizing:'fixed',cross:'fixed',align:'min',justify:'min',wrap:false}});
 const ui=await mount([parent],[parent.id,a.id]);const beforeX=ui.node(a.id).x;
 await ui.dispatch({type,ids:[parent.id,a.id],dx:10,dy:0});
 t(`${type}: selected layout ancestor carries its selected child without reordering`,ui.node(parent.id).children.map(n=>n.id).join()===[a.id,b.id].join()&&ui.node(a.id).x===beforeX);
 t(`${type}: layout parent moves without resizing`,ui.node(parent.id).x===110&&ui.node(parent.id).w===400);
 await ui.close();
}
console.log(`\n${pass} passed, ${fail} failed`);if(fail)process.exitCode=1;
