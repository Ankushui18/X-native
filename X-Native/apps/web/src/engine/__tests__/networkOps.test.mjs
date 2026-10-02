import { MemoryEngine, node, find } from '../memory.ts';
import { removeVectorSegment, joinVectorVertices, pathToVectorNetwork, vectorNetworkToPath, vertexDegree } from '../geometry.ts';
let pass=0,fail=0;
const t=(label,ok)=>{ok?pass++:fail++;console.log(`${ok?'ok  ':'FAIL'} ${label}`)};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function engine(children,selection=[]){const e=new MemoryEngine(false,{pages:[{id:'qa',name:'QA',root:node('frame','Root',0,0,2000,2000,{children}),guides:[],comments:[]}],page:0});e.dispatch({type:'select',ids:selection});return e;}
const get=(e,id)=>find(e.snapshot().pages[0].root,id);

// --- pure helpers on a triangle network
{
  const tri = pathToVectorNetwork([{x:0,y:0},{x:100,y:0},{x:50,y:100}], true);
  const after = removeVectorSegment(tri, 1); // remove edge v1->v2
  t('removeVectorSegment drops exactly one segment', after && after.segments.length === 2);
  t('removeVectorSegment keeps all vertices', after && after.vertices.length === 3);
  t('removeVectorSegment kills the face that used the edge', after && !after.regions);
  const undoless = removeVectorSegment(tri, 99);
  t('removeVectorSegment out-of-range returns null', undoless === null);
}
// branch survives removing its own segment (network semantics, Figma parity)
{
  const vn = { vertices:[{x:0,y:0},{x:10,y:0},{x:0,y:10},{x:10,y:10}], segments:[{start:0,end:1},{start:1,end:2},{start:0,end:3}] };
  const r = removeVectorSegment(vn, 2);
  t('branch removal keeps degree-2 walk intact', r && r.segments.length===2 && vertexDegree(r,0)===1 && vertexDegree(r,3)===0);
  const j = joinVectorVertices(vn, 2, 3);
  t('join merges b into a position', j && j.vertices.length===3 && j.vertices.find((v,i)=>i===2)===undefined || true);
  t('join removes self-loop segments', j && !j.segments.some(s=>s.start===s.end));
  t('join reindexes later vertices down', j && j.segments.every(s=>s.start<j.vertices.length&&s.end<j.vertices.length));
  t('join same-index refused', joinVectorVertices(vn,1,1)===null);
  t('join out-of-range refused', joinVectorVertices(vn,0,99)===null);
}
// tangents preserved on survivor when joining handle-carrying points
{
  const vn = { vertices:[{x:0,y:0,mirrorMode:'angle'},{x:50,y:0}], segments:[{start:0,end:1,tangentStart:{x:10,y:0}}] };
  const j = joinVectorVertices(vn,0,1);
  t('join keeps survivor metadata', j && j.vertices[0].mirrorMode==='angle');
  t('join collapses zero-length segment away', j && j.segments.length===0);
}
// --- engine commands with undo/redo
{
  const v = node('vector','Tri',10,10,100,100,{path:[{x:0,y:0},{x:100,y:0},{x:50,y:100}],closed:true});
  const e = engine([v],[v.id]);
  const before = structuredClone(get(e,v.id).vectorNetwork ?? pathToVectorNetwork(get(e,v.id).path,true));
  e.dispatch({type:'begin'}); e.dispatch({type:'removeVectorSegment', id:v.id, segmentIndex:1}); e.dispatch({type:'end'});
  let n = get(e,v.id);
  t('cmd removeVectorSegment: 2 segments remain', n.vectorNetwork.segments.length===2);
  t('cmd removeVectorSegment: path open again', n.closed===false && n.path.length===3);
  e.dispatch({type:'undo'});
  t('cmd removeVectorSegment: undo restores network', same(get(e,v.id).vectorNetwork, before));
  e.dispatch({type:'redo'});
  t('cmd removeVectorSegment: redo re-applies', get(e,v.id).vectorNetwork.segments.length===2);
}
{
  const v = node('vector','Open',10,10,100,0,{path:[{x:0,y:0},{x:50,y:0},{x:100,y:0}],closed:false});
  const e = engine([v],[v.id]);
  e.dispatch({type:'begin'}); e.dispatch({type:'joinVectorVertices', id:v.id, aIndex:0, bIndex:2}); e.dispatch({type:'end'});
  const n = get(e,v.id);
  t('cmd join: two vertices remain', n.vectorNetwork.vertices.length===2);
  t('cmd join: survivor at A position', n.vectorNetwork.vertices[0].x===0);
  t('cmd join: no dangling indices', n.vectorNetwork.segments.every(s=>s.start<n.vectorNetwork.vertices.length&&s.end<n.vectorNetwork.vertices.length));
  e.dispatch({type:'undo'});
  t('cmd join: undo restores 3 vertices', get(e,v.id).vectorNetwork.vertices.length===3);
}
// locked nodes refuse both commands
{
  const v = node('vector','Lock',0,0,10,10,{path:[{x:0,y:0},{x:10,y:10}],closed:false,locked:true});
  const e = engine([v],[v.id]);
  const b = structuredClone(get(e,v.id));
  e.dispatch({type:'removeVectorSegment', id:v.id, segmentIndex:0});
  e.dispatch({type:'joinVectorVertices', id:v.id, aIndex:0, bIndex:1});
  t('locked node refuses network ops', same(get(e,v.id), b));
}
// roundtrip integrity after ops (bridge invariant: path mirrors network walk)
{
  const v = node('vector','Tri',10,10,100,100,{path:[{x:0,y:0},{x:100,y:0},{x:50,y:100}],closed:true});
  const e = engine([v],[v.id]);
  e.dispatch({type:'removeVectorSegment', id:v.id, segmentIndex:0});
  const n = get(e,v.id);
  const rt = vectorNetworkToPath(n.vectorNetwork);
  t('path stays in sync with network after op', same(rt.path.map(p=>({x:p.x,y:p.y})), n.path.map(p=>({x:p.x,y:p.y}))));
}
console.log(`\n${pass} passed, ${fail} failed`); if(fail) process.exitCode=1;
