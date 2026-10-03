import { MemoryEngine, node, find, localToWorld } from '../memory.ts';
import { vectorNetworkToPath, pathToVectorNetwork } from '../geometry.ts';
let pass=0,fail=0;
const t=(label,ok)=>{ok?pass++:fail++;console.log(`${ok?'ok  ':'FAIL'} ${label}`)};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const near=(a,b)=>Math.abs(a-b)<1e-7;
function engine(children,selection=[]){const e=new MemoryEngine(false,{pages:[{id:'qa',name:'QA',root:node('frame','Root',0,0,2000,2000,{children}),guides:[],comments:[]}],page:0});e.dispatch({type:'select',ids:selection});return e;}
const get=(e,id)=>find(e.snapshot().pages[0].root,id);
const net=()=>({vertices:[{x:100,y:0,strokeCap:'round'},{x:0,y:0},{x:100,y:100},{x:220,y:50},{x:350,y:80}],segments:[{start:1,end:0,tangentStart:{x:20,y:10}},{start:0,end:2,tangentEnd:{x:0,y:-20}},{start:0,end:3,tangentStart:{x:30,y:15}}],regions:[{loops:[[1,0,2]],fill:'#ff0000',fillOpacity:.4}]});
for(const command of ['patchPath','bendSegment','setPointMirror','setPointCornerRadius','vectorAlign']) {
 const network=net(),v=node('vector','Branch',50,50,400,100,{path:vectorNetworkToPath(network).path,vectorNetwork:network});const e=engine([v],[v.id]);
 e.dispatch({type:'setVecEdit',id:v.id,pointIndices:[0,1,2]});
 const before=structuredClone(get(e,v.id));
 const cmd={patchPath:{type:command,id:v.id,path:before.path.map((p,i)=>i===1?{...p,x:p.x+10}:p)},bendSegment:{type:command,id:v.id,segIndex:0,dragX:20,dragY:40},setPointMirror:{type:command,id:v.id,pointIndex:0,mode:'angleAndLength'},setPointCornerRadius:{type:command,id:v.id,pointIndex:1,radius:8},vectorAlign:{type:command,alignment:'left'}}[command];
 e.dispatch({type:'begin'});e.dispatch(cmd);e.dispatch({type:'end'});
 let after=get(e,v.id);
 t(`${command}: all vertices retained`,after.vectorNetwork.vertices.length===5);
 t(`${command}: branches and off-walk tangents retained`,same(after.vectorNetwork.segments[2],before.vectorNetwork.segments[2]));
 t(`${command}: disconnected point retained`,same(after.vectorNetwork.vertices[4],before.vectorNetwork.vertices[4]));
 t(`${command}: region paint retained`,same(after.vectorNetwork.regions,before.vectorNetwork.regions));
 t(`${command}: endpoint metadata retained`,after.vectorNetwork.vertices[0].strokeCap==='round');
 const changed=structuredClone(after.vectorNetwork);
 e.dispatch({type:'undo'});t(`${command}: undo restores network`,same(get(e,v.id).vectorNetwork,before.vectorNetwork));
 e.dispatch({type:'redo'});t(`${command}: redo restores network`,same(get(e,v.id).vectorNetwork,changed));
}
// A fit uses the children's transformed boxes, and must not move ANY child.
for(const rotation of [0,37,90]) for(const flipH of [false,true]) for(const flipV of [false,true]) {
 const child=node('rect','Rotated child',100,100,100,20,{rotation:90});
 const hidden=node('rect','Hidden',-100,-200,10,10,{visible:false});
 const parent=node('frame','Parent',70,90,400,400,{rotation,flipH,flipV,children:[child,hidden]});
 const outer=node('frame','Outer',100,50,1000,1000,{rotation:-23,flipH:true,children:[parent]});
 const e=engine([outer],[parent.id]);const root=()=>e.snapshot().pages[0].root;
 const corners=id=>[[0,0],[get(e,id).w,0],[get(e,id).w,get(e,id).h],[0,get(e,id).h]].map(([x,y])=>localToWorld(root(),id,x,y));
 const before=corners(child.id),beforeHidden=corners(hidden.id);const initial=structuredClone(get(e,parent.id));
 e.dispatch({type:'resizeToFit'});
 const p=get(e,parent.id);
 t(`fit ${rotation}/${flipH}/${flipV}: transformed size`,near(p.w,20)&&near(p.h,100));
 t(`fit ${rotation}/${flipH}/${flipV}: visible child stationary`,corners(child.id).every((v,i)=>near(v.x,before[i].x)&&near(v.y,before[i].y)));
 t(`fit ${rotation}/${flipH}/${flipV}: hidden child stationary`,corners(hidden.id).every((v,i)=>near(v.x,beforeHidden[i].x)&&near(v.y,beforeHidden[i].y)));
 e.dispatch({type:'undo'});t(`fit ${rotation}/${flipH}/${flipV}: undo`,same(get(e,parent.id),initial));
 e.dispatch({type:'redo'});t(`fit ${rotation}/${flipH}/${flipV}: redo`,near(get(e,parent.id).w,20));
}
{
 const path=[{x:0,y:0,ix:-10,iy:0,ox:10,oy:20,mirrorMode:'angleAndLength'},{x:100,y:0},{x:100,y:100,ox:-20,oy:15}];
 const back=vectorNetworkToPath(pathToVectorNetwork(path,true));
 t('closed network retains closing outgoing tangent',back.path[2].ox===-20&&back.path[2].oy===15);
 t('closed network retains closing incoming tangent',back.path[0].ix===-10&&back.path[0].iy===0);
 t('network roundtrip retains mirroring metadata',back.path[0].mirrorMode==='angleAndLength');
}
console.log(`\n${pass} passed, ${fail} failed`);if(fail)process.exitCode=1;
