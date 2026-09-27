import assert from "node:assert/strict";
import { decodeRustImport } from "../wasmImportAdapter.ts";
import { importsEquivalent } from "../wasmBridge.ts";
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log(`  ok ${name}`);}catch(e){failed++;console.error(`FAIL ${name}`,e);}}
const facts=(extra={})=>({fill:"solid",blend:null,effectCount:0,uniformCorners:true,...extra});
function payload(){const n={id:"box",name:"Box",kind:{t:"rect",radius:0},x:40,y:40,w:100,h:50,rotation:0,opacity:1,fill:{t:"solid",c:"#ff0000"}};return {ok:true,doc:{format:"x-native",version:1,pages:[{...n,id:"page",name:"Page 1",kind:{t:"frame"},x:0,y:0,w:800,h:600,children:[n]}]},figmaCoordinates:{version:1,nodes:{box:{x:10,y:20}}},figmaAppearance:{version:1,images:0,nodes:{box:facts()}}};}
const child=p=>p.doc.pages[0].children[0]; const decode=p=>decodeRustImport(JSON.stringify(p));
await test("source-backed defaults fill out the FIG contract without modifying the oracle",()=>{const r=decode(payload()),n=r.nodes[0];assert.equal(n.fillType,"solid");assert.equal(n.blendMode,"pass-through");assert.deepEqual(n.effects,[]);assert.deepEqual(n.cornerRadii,[0,0,0,0]);assert.equal(n.cornerIndependent,false);assert.equal(r.images,0);});
await test("unfilled source text overrides only the native fallback paint",()=>{const p=payload();child(p).kind={t:"text",text:"Keep me"};child(p).h=18;child(p).fill.c="#000000";p.figmaAppearance.nodes.box=facts({fill:"none",uniformCorners:false});p.textMetrics={version:1,nodes:{box:{width:100,height:24,fontSize:18}}};const n=decode(p).nodes[0];assert.equal(n.text,"Keep me");assert.equal(n.fill,"#00000000");assert.equal(n.fillVisible,false);assert.equal(n.fillType,undefined);assert.equal(n.h,24);});
await test("explicit NORMAL differs from an absent blend",()=>{const p=payload();p.figmaAppearance.nodes.box.blend="NORMAL";assert.equal(decode(p).nodes[0].blendMode,"Normal");});
await test("explicit blend must agree with the native enum",()=>{const p=payload();child(p).blend="soft-light";p.figmaAppearance.nodes.box.blend="SOFT_LIGHT";assert.equal(decode(p).nodes[0].blendMode,"Soft Light");});
await test("legacy FIG envelopes do not acquire guessed defaults",()=>{const p=payload();delete p.figmaAppearance;const n=decode(p).nodes[0];assert.equal(n.fillType,undefined);assert.equal(n.blendMode,undefined);assert.equal(n.effects,undefined);});
for(const [name,mutate] of [
 ["unknown version",p=>p.figmaAppearance.version=2],
 ["missing coordinate metadata",p=>delete p.figmaCoordinates],
 ["missing node facts",p=>p.figmaAppearance.nodes={}],
 ["unused node facts",p=>p.figmaAppearance.nodes.ghost=facts()],
 ["unsupported source fill",p=>p.figmaAppearance.nodes.box.fill="unsupported"],
 ["unknown source fill",p=>p.figmaAppearance.nodes.box.fill="mystery"],
 ["translucent native paint",p=>child(p).fill.c="#ff000080"],
 ["missing blend fact",p=>delete p.figmaAppearance.nodes.box.blend],
 ["unknown blend",p=>p.figmaAppearance.nodes.box.blend="FUTURE"],
 ["native blend contradicts source default",p=>child(p).blend="multiply"],
 ["native blend lost",p=>p.figmaAppearance.nodes.box.blend="MULTIPLY"],
 ["source effect dropped",p=>p.figmaAppearance.nodes.box.effectCount=1],
 ["negative count",p=>p.figmaAppearance.nodes.box.effectCount=-1],
 ["fractional count",p=>p.figmaAppearance.nodes.box.effectCount=0.5],
 ["unknown source property",p=>p.figmaAppearance.nodes.box.future=1],
 ["invalid corner flag",p=>p.figmaAppearance.nodes.box.uniformCorners=1],
 ["corners on ellipse",p=>child(p).kind={t:"ellipse"}],
 ["independent native corners",p=>child(p).corners=[1,2,3,4]],
 ["unsupported image count",p=>p.figmaAppearance.images=1],
]) await test(`decline ${name}`,()=>{const p=payload();mutate(p);assert.throws(()=>decode(p));});
await test("native appearance is not allowed to bypass unrelated contract differences",()=>{const a=decode(payload()),b=structuredClone(a);b.nodes[0].opacity=0.5;assert.equal(importsEquivalent(a,b),false);});
console.log(`wasmAppearance: ${passed} passed, ${failed} failed`);if(failed)process.exit(1);
