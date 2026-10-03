/**
 * Constraints per Figma help 360039957734:
 *   Left/Top pins to the min edge; Right/Bottom pins to the max;
 *   Left+Right (stretch) grows the child; Center stays centered;
 *   Scale maintains percentage position & size.
 *
 * Drives applyConstraints indirectly by resizing the parent frame via the
 * engine's resize action.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

function setup(constraintH, constraintV, childX=20, childY=20, childW=40, childH=30) {
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const child = node("rect", "c", childX, childY, childW, childH, { constraintH, constraintV });
  const parent = node("frame", "F", 0, 0, 200, 100, { fill: "#fff", fillVisible: true, children: [child] });
  r.children.push(parent);
  return { engine, parent, child };
}

function resizeParent(engine, parent, w, h) {
  engine.dispatch({ type: "select", ids: [parent.id] });
  engine.dispatch({ type: "resize", id: parent.id, w, h });
}

// Left (min) pinned horizontally, Top (min) pinned vertically - child stays at (20,20)
{
  const { engine, parent, child } = setup("min", "min");
  resizeParent(engine, parent, 400, 200);
  const c = find(engine.snapshot().pages[0].root, child.id);
  t("Left+Top pinned → x=20, y=20", c.x === 20 && c.y === 20);
  t("Left+Top pinned → size unchanged", c.w === 40 && c.h === 30);
}

// Right (max) pinned - x shifts by dw
{
  const { engine, parent, child } = setup("max", "min");
  // child.x = 20 in 200-wide frame → distance to right edge = 200 - (20+40) = 140
  resizeParent(engine, parent, 400, 200);
  const c = find(engine.snapshot().pages[0].root, child.id);
  t("Right pinned → x = 20+200 = 220", c.x === 220);
}

// Bottom (max) pinned - y shifts by dh
{
  const { engine, parent, child } = setup("min", "max");
  // child.y=20 in 100-tall frame → distance to bottom = 50
  resizeParent(engine, parent, 200, 200);
  const c = find(engine.snapshot().pages[0].root, child.id);
  t("Bottom pinned → y = 20+100 = 120", c.y === 120);
}

// Center
{
  const { engine, parent, child } = setup("center", "center", 80, 35, 40, 30);
  // Initially centered in 200x100. After 400x200, should stay centered.
  resizeParent(engine, parent, 400, 200);
  const c = find(engine.snapshot().pages[0].root, child.id);
  t("Center h → x=(400-40)/2=180", c.x === 180);
  t("Center v → y=(200-30)/2=85", c.y === 85);
}

// Stretch (left+right / top+bottom)
{
  const { engine, parent, child } = setup("stretch", "stretch", 20, 20, 160, 60);
  // Margins 20 on each side; w=160, h=60
  resizeParent(engine, parent, 400, 200);
  const c = find(engine.snapshot().pages[0].root, child.id);
  t("Stretch h → w=160+200=360, x=20 unchanged", c.x === 20 && c.w === 360);
  t("Stretch v → h=60+100=160, y=20 unchanged", c.y === 20 && c.h === 160);
}

// Scale
{
  const { engine, parent, child } = setup("scale", "scale", 20, 20, 40, 30);
  // x scales by 400/200 = 2; y scales by 200/100 = 2
  resizeParent(engine, parent, 400, 200);
  const c = find(engine.snapshot().pages[0].root, child.id);
  t("Scale h → x=40, w=80", c.x === 40 && c.w === 80);
  t("Scale v → y=40, h=60", c.y === 40 && c.h === 60);
}

console.log(`\n${pass} passed, ${fail} failed`);
