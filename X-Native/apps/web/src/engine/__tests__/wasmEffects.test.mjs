import assert from "node:assert/strict";
import { decodeRustImport } from "../wasmImportAdapter.ts";
import { importsEquivalent } from "../wasmBridge.ts";
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ok ${name}`); } catch(e) { failed++; console.error(`FAIL ${name}`,e); } }
const effects = () => [{t:"drop",dx:5,dy:-3,blur:6,c:"#ff000080"}, {t:"inner",dx:-2,dy:4,blur:2,c:"#0000ff"}, {t:"blur",r:8}, {t:"bgblur",r:4}];
function payload(stacked = false) {
 const fill = {t:"solid",c:"#ffffff"};
 const n = { id:"box",name:"Box",kind:{t:"rect",radius:0},x:0,y:0,w:100,h:50,rotation:0,opacity:1,fill,effects:effects() };
 if(stacked) Object.assign(n,{fill_layers:[{paint:fill,opacity:1,visible:true,blend:"normal"}],stroke_layers:[],effect_layers:n.effects.map(effect=>({effect,opacity:1,visible:true,blend:"normal"}))});
 return {ok:true,doc:{format:"x-native",version:1,pages:[{id:"page",kind:{t:"frame"},x:0,y:0,w:400,h:300,rotation:0,opacity:1,fill,children:[n]}]}};
}
const child = p=>p.doc.pages[0].children[0];
const decode = p=>decodeRustImport(JSON.stringify(p));
for (const stacked of [false,true]) test(`ordered basic effects map from ${stacked ? "matching materialized" : "legacy"} data`,()=>{
 const n=decode(payload(stacked)).nodes[0];
 assert.deepEqual(n.effects.map(e=>e.kind),["drop-shadow","inner-shadow","layer-blur","background-blur"]);
 assert.deepEqual(n.effects[0],{kind:"drop-shadow",color:"#ff000080",x:5,y:-3,blur:6,spread:0,visible:true});
 assert.equal(n.effects[1].x,-2); assert.equal(n.effects[1].color,"#0000ff");
 assert.equal(n.effects[2].blur,8); assert.equal(n.effects[3].blur,4);
 assert.equal(n.effects[2].x,0); assert.equal(n.effects[2].spread,0);
});
test("zero blur and negative shadow offsets are valid",()=>{ const p=payload(); child(p).effects[0].blur=0; assert.equal(decode(p).nodes[0].effects[0].blur,0); });
test("known layer blend names map exactly to web labels",()=>{
 for(const [native,web] of Object.entries({normal:"Normal",darken:"Darken",multiply:"Multiply","color-burn":"Color Burn",lighten:"Lighten",screen:"Screen","color-dodge":"Color Dodge",overlay:"Overlay","soft-light":"Soft Light","hard-light":"Hard Light",difference:"Difference",exclusion:"Exclusion",hue:"Hue",saturation:"Saturation",color:"Color",luminosity:"Luminosity","plus-darker":"Plus Darker","plus-lighter":"Plus Lighter","pass-through":"pass-through"})) {
  const p=payload(); child(p).blend=native; assert.equal(decode(p).nodes[0].blendMode,web);
 }
});
test("absent layer blend stays absent",()=>assert.equal(decode(payload()).nodes[0].blendMode,undefined));
for(const [name,mutate] of [
 ["unsupported noise",n=>n.effects=[{t:"noise"}]],
 ["unknown effect",n=>n.effects=[{t:"future"}]],
 ["unknown effect property",n=>n.effects[0].spread=8],
 ["malformed effect array",n=>n.effects={}],
 ["negative blur",n=>n.effects[0].blur=-1],
 ["negative blur radius",n=>n.effects[2].r=-1],
 ["invalid number",n=>n.effects[0].dx="5"],
 ["nonfinite number",n=>n.effects[0].dy=Infinity],
 ["invalid color",n=>n.effects[0].c="red"],
 ["missing shadow color",n=>delete n.effects[0].c],
 ["oversized effects",n=>n.effects=Array(10001).fill({t:"blur",r:1})],
 ["unknown blend",n=>n.blend="mystery"],
]) test(`decline ${name}`,()=>{ const p=payload(); mutate(child(p)); assert.throws(()=>decode(p)); });
for(const [name,mutate] of [
 ["stack order differs",n=>n.effect_layers.reverse()],
 ["stack replaces radius",n=>n.effect_layers[2].effect={t:"blur",r:9}],
 ["stack removes legacy effects",n=>n.effect_layers=[]],
 ["legacy effects absent",n=>delete n.effects],
 ["hidden effect",n=>n.effect_layers[0].visible=false],
 ["effect opacity",n=>n.effect_layers[0].opacity=0.5],
 ["effect blend override",n=>n.effect_layers[0].blend="multiply"],
 ["unknown stack property",n=>n.effect_layers[0].future=true],
]) test(`decline ${name}`,()=>{ const p=payload(true); mutate(child(p)); assert.throws(()=>decode(p)); });
test("whole-result comparison still catches source-only effect properties",()=>{
 const a=decode(payload());
 for(const patch of [{spread:7},{visible:false},{blend:"Multiply"},{showBehind:true}]) {
  const b=structuredClone(a); Object.assign(b.nodes[0].effects[0],patch); assert.equal(importsEquivalent(a,b),false);
 }
});
console.log(`wasmEffects: ${passed} passed, ${failed} failed`); if(failed) process.exit(1);
