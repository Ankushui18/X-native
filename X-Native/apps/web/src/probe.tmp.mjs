import { MemoryEngine } from "./engine/memory.ts";
import { colorUsageAll, setOpacityMatches, recolorMatches } from "./ui/selectionColors.ts";
const e = new MemoryEngine(false);
e.dispatch({ type: "add", kind: "rectangle", x:0,y:0,w:100,h:100, extra:{ id:"s1", fill:"#ff0000" }});
e.dispatch({ type: "add", kind: "rectangle", x:200,y:0,w:100,h:100, extra:{ id:"s2", fill:"#ff0000" }});
let root = e.snapshot().pages[e.snapshot().page].root;
const get = (id) => { const f=(n)=> n.id===id?n:n.children.reduce((r,c)=>r??f(c),null); return f(root); };
const usages = colorUsageAll([get("s1"), get("s2")]);
console.log("usages:", JSON.stringify(usages));
const row = usages.find(u=>u.hex==="#ff0000");
if (row) {
  const touched = setOpacityMatches(e, root, row, 50);
  console.log("touched:", touched);
  root = e.snapshot().pages[e.snapshot().page].root;
  console.log("opacities:", get("s1").fillOpacity, get("s2").fillOpacity);
}
