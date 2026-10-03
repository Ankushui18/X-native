import assert from "node:assert/strict";
import { decodeRustImport } from "../wasmImportAdapter.ts";
import { importsEquivalent } from "../wasmBridge.ts";
let passed=0, failed=0;
function test(name,fn) { try { fn(); passed++; console.log(`  ok ${name}`); } catch(e) { failed++; console.error(`FAIL ${name}`,e); } }
const rect=(id,extra={})=>({id,name:id,kind:{t:"rect",radius:0},x:40,y:40,w:100,h:50,rotation:0,opacity:1,fill:{t:"solid",c:"#ffffff"},...extra});
const page=(id,children)=>rect(id,{kind:{t:"frame"},x:0,y:0,w:800,h:600,children});
function payload() {return {ok:true,doc:{format:"x-native",version:1,pages:[page("empty",[]),page("one",[rect("outer",{children:[rect("inner",{x:10,y:20,w:20,h:60})]})]),page("two",[rect("other",{w:50,h:60})])]},figmaCoordinates:{version:1,nodes:{outer:{x:-120,y:-80},other:{x:300,y:200}}}};}
const decode=p=>decodeRustImport(JSON.stringify(p));
test("restore root positions without shifting descendants or flattening pages",()=>{
 const r=decode(payload()); assert.equal(r.pages.length,3); assert.equal(r.pages[0].nodes.length,0);
 assert.equal(r.nodes[0].name,"outer"); assert.equal(r.nodes[0].x,-120); assert.equal(r.nodes[0].y,-80);
 assert.equal(r.nodes[0].children[0].x,10); assert.equal(r.nodes[0].children[0].y,20);
 assert.equal(r.pages[2].nodes[0].x,300); assert.equal(r.pages[2].nodes[0].y,200);
 assert.equal(r.width,470); assert.equal(r.height,340);
});
test("descendant overflow contributes to content bounds",()=>{
 const p=payload(); p.doc.pages=p.doc.pages.slice(0,2); delete p.figmaCoordinates.nodes.other;
 const r=decode(p); assert.equal(r.width,100); assert.equal(r.height,80);
});
test("source precision is not reconstructed from rounded native offsets",()=>{
 const p=payload(); p.figmaCoordinates.nodes.outer={x:1e-12,y:-1e-12};
 const r=decode(p); assert.equal(r.nodes[0].x,1e-12); assert.equal(r.nodes[0].y,-1e-12);
});
test("legacy envelope keeps native page dimensions and first-page selection",()=>{
 const p=payload(); delete p.figmaCoordinates; const r=decode(p);
 assert.equal(r.nodes.length,0); assert.equal(r.width,800); assert.equal(r.height,600);
});
test("page names need not be unique; source positions use node IDs",()=>{
 const p=payload(); for(const page of p.doc.pages) page.name="Duplicate";
 const r=decode(p); assert.equal(r.nodes[0].x,-120); assert.equal(r.pages[2].nodes[0].x,300);
});
test("text source bounds, not native font size, contribute to file bounds",()=>{
 const p=payload(); p.doc.pages=[page("page",[rect("label",{kind:{t:"text",text:"hello"},h:18})])];
 p.figmaCoordinates.nodes={label:{x:-5,y:-10}};
 p.textMetrics={version:1,nodes:{label:{width:100,height:70,fontSize:18}}};
 const r=decode(p); assert.equal(r.nodes[0].fontSize,18); assert.equal(r.height,70); assert.equal(r.width,100);
});
test("source positions are applied before pivot rebase",()=>{
 const p=payload(); const n=p.doc.pages[1].children[0]; n.rotation=Math.PI/2; n.origin=[0,0];
 const r=decode(p); assert.equal(r.nodes[0].x,-195); assert.equal(r.nodes[0].y,-55);
});
for(const [name,mutate] of [
 ["wrong version",p=>p.figmaCoordinates.version=2],
 ["unknown metadata field",p=>p.figmaCoordinates.future=1],
 ["missing root position",p=>delete p.figmaCoordinates.nodes.outer],
 ["unused root position",p=>p.figmaCoordinates.nodes.ghost={x:0,y:0}],
 ["position for nested child",p=>p.figmaCoordinates.nodes.inner={x:0,y:0}],
 ["duplicate root ID",p=>p.doc.pages[2].children[0].id="outer"],
 ["invalid source x",p=>p.figmaCoordinates.nodes.outer.x="-120"],
 ["nonfinite source y",p=>p.figmaCoordinates.nodes.outer.y=Infinity],
 ["unknown position property",p=>p.figmaCoordinates.nodes.outer.z=3],
 ["nonidentity page transform",p=>p.doc.pages[1].x=10],
 ["rotated page",p=>p.doc.pages[1].rotation=1],
 ["non-frame page",p=>p.doc.pages[1].kind={t:"rect"}],
 ["bounds overflow",p=>{p.figmaCoordinates.nodes.outer.x=-1e308;p.figmaCoordinates.nodes.other.x=1e308;}],
]) test(`decline ${name}`,()=>{const p=payload();mutate(p);assert.throws(()=>decode(p));});
test("placement correction does not waive unrelated whole-contract differences",()=>{
 const r=decode(payload()), other=structuredClone(r); other.nodes[0].fillType="solid"; assert.equal(importsEquivalent(r,other),false);
});
console.log(`wasmCoordinates: ${passed} passed, ${failed} failed`); if(failed) process.exit(1);
