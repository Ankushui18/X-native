import assert from "node:assert/strict";
import fs from "node:fs";
import { decodeRustImport } from "../wasmImportAdapter.ts";
import { importFig } from "../figImport.ts";
import { importsEquivalent } from "../wasmBridge.ts";
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log(`  ok ${name}`);}catch(e){failed++;console.error(`FAIL ${name}`,e);}}
const source = () => [
 {kind:"drop-shadow",color:"#ff000080",x:5,y:-3,blur:6,spread:7,visible:true,blend:"MULTIPLY",showBehind:true},
 {kind:"inner-shadow",color:"#0000ff",x:-2,y:4,blur:2,spread:-2,visible:false,blend:"NORMAL",showBehind:false},
 {kind:"layer-blur",color:"#000000",x:0,y:0,blur:8,spread:0,visible:true,blend:null,showBehind:false},
 {kind:"background-blur",color:"#00ff0080",x:0,y:0,blur:4,spread:0,visible:true,blend:null,showBehind:false},
];
function payload(stacked=false) {
 const fill={t:"solid",c:"#ffffff"};
 const n={id:"box",name:"Box",kind:{t:"rect",radius:0},x:40,y:40,w:100,h:50,rotation:0,opacity:1,fill,
 effects:[{t:"drop",c:"#ff000080",dx:5,dy:-3,blur:6},{t:"blur",r:8},{t:"bgblur",r:4}]};
 if(stacked)Object.assign(n,{fill_layers:[{paint:fill,visible:true,opacity:1,blend:"normal"}],stroke_layers:[],effect_layers:n.effects.map(effect=>({effect,visible:true,opacity:1,blend:"normal"}))});
 return {ok:true,doc:{format:"x-native",version:1,pages:[{...n,id:"page",kind:{t:"frame"},x:0,y:0,w:800,h:600,effects:[],children:[n],fill_layers:undefined,effect_layers:undefined,stroke_layers:undefined}]},
 figmaCoordinates:{version:1,nodes:{box:{x:20,y:40}}},figmaAppearance:{version:1,images:0,nodes:{box:{fill:"solid",blend:null,effectCount:4,uniformCorners:true}}},figmaEffects:{version:1,nodes:{box:source()}}};
}
const child=p=>p.doc.pages[0].children[0], decode=p=>decodeRustImport(JSON.stringify(p));
for(const stacked of [false,true])await test(`restore complete source effects after ${stacked?'materialized':'legacy'} projection validation`,()=>{
 const p=payload(stacked), n=decode(p).nodes[0];
 assert.deepEqual(n.effects,source().map(e=>({...e,blend:e.blend==='MULTIPLY'?'Multiply':e.blend==='NORMAL'?'Normal':undefined})));
 assert.equal(child(p).effects.length,3,"native projection remains unchanged");
});
await test("hidden-only source effects survive an empty native projection",()=>{const p=payload();p.figmaEffects.nodes.box=[source()[1]];p.figmaAppearance.nodes.box.effectCount=1;delete child(p).effects;assert.equal(decode(p).nodes[0].effects[0].visible,false);});
await test("empty source effects require empty native effects",()=>{const p=payload();p.figmaEffects.nodes.box=[];p.figmaAppearance.nodes.box.effectCount=0;delete child(p).effects;assert.deepEqual(decode(p).nodes[0].effects,[]);});
await test("legacy metadata-free envelopes retain native defaults",()=>{const p=payload();delete p.figmaEffects;p.figmaAppearance.nodes.box.effectCount=3;const es=decode(p).nodes[0].effects;assert.equal(es[0].spread,0);assert.equal(es[0].showBehind,undefined);assert.equal(es[1].color,"#00000000");});
for(const [name,mutate] of [
 ["unknown version",p=>p.figmaEffects.version=2], ["unknown envelope key",p=>p.figmaEffects.future=1],
 ["missing appearance",p=>delete p.figmaAppearance], ["missing facts",p=>delete p.figmaEffects.nodes.box],
 ["unused facts",p=>p.figmaEffects.nodes.ghost=[]], ["page facts",p=>p.figmaEffects.nodes.page=[]],
 ["unsupported type",p=>p.figmaEffects.nodes.box[0].kind="noise"], ["unknown field",p=>p.figmaEffects.nodes.box[0].future=1],
 ["missing blend",p=>delete p.figmaEffects.nodes.box[0].blend], ["unknown blend",p=>p.figmaEffects.nodes.box[0].blend="FUTURE"],
 ["invalid visibility",p=>p.figmaEffects.nodes.box[0].visible=1], ["invalid showBehind",p=>p.figmaEffects.nodes.box[0].showBehind="true"],
 ["nonfinite spread",p=>p.figmaEffects.nodes.box[0].spread=Infinity], ["negative blur",p=>p.figmaEffects.nodes.box[1].blur=-1],
 ["invalid color",p=>p.figmaEffects.nodes.box[1].color="blue"], ["invalid offset",p=>p.figmaEffects.nodes.box[1].x="5"],
 ["blur offset",p=>p.figmaEffects.nodes.box[2].x=1], ["oversized list",p=>p.figmaEffects.nodes.box=Array(10001).fill(source()[1])],
 ["native radius contradiction",p=>child(p).effects[0].blur=7], ["native color contradiction",p=>child(p).effects[0].c="#000000"],
 ["native order contradiction",p=>child(p).effects.reverse()], ["native omission",p=>child(p).effects.pop()],
 ["hidden native contradiction",p=>p.figmaEffects.nodes.box[0].visible=false], ["count contradiction",p=>p.figmaAppearance.nodes.box.effectCount=3],
])await test(`decline ${name}`,()=>{const p=payload();mutate(p);assert.throws(()=>decode(p));});
await test("source facts never override an inconsistent active stack",()=>{const p=payload(true);child(p).effect_layers[0].visible=false;assert.throws(()=>decode(p));});
await test("complete comparator still rejects source-only changes",()=>{const a=decode(payload());for(const patch of [{spread:8},{visible:false},{showBehind:false},{blend:"Screen"}]){const b=structuredClone(a);Object.assign(b.nodes[0].effects[0],patch);assert.equal(importsEquivalent(a,b),false);}});
await test("binary web importer retains both blur aliases and source shadow fields",async()=>{
 for(const [file,expect] of [["effects-blend.fig",3],["effect-source.fig",3]]) {
  const b=fs.readFileSync(new URL(`../../../e2e/fixtures/${file}`,import.meta.url));
  const r=await importFig(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
  assert.equal(r.nodes[1].effects[0].kind,"layer-blur");assert.equal(r.nodes[1].effects[0].blur,expect);
  if(file==='effect-source.fig'){assert.equal(r.nodes[0].effects[0].spread,7);assert.equal(r.nodes[0].effects[0].showBehind,true);assert.equal(r.nodes[0].effects[1].visible,false);assert.equal(r.nodes[0].effects[1].blend,"Normal");}
 }
});
console.log(`wasmSourceEffects: ${passed} passed, ${failed} failed`);if(failed)process.exit(1);
