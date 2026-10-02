/**
 * Sections parity (Figma help 9771500257687):
 *   Shift+S activates the section tool.
 *   ⌫ deletes the section AND its contents.
 *   ⌘⌫ ungroups the section (delete section, keep contents on canvas).
 */
import { MemoryEngine, node, find, findParent } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

function makeSectionWithKids() {
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const a = node("rect", "a", 20, 20, 40, 40);
  const b = node("rect", "b", 80, 80, 40, 40);
  const sec = node("section", "MySection", 0, 0, 200, 200, { children: [a, b] });
  r.children.push(sec);
  return { engine, sec, a, b };
}

// 1. Delete with ⌫ removes section and contents.
{
  const { engine, sec, a, b } = makeSectionWithKids();
  engine.dispatch({ type: "select", ids: [sec.id] });
  engine.dispatch({ type: "delete" });
  const r = engine.snapshot().pages[0].root;
  t("Delete removes the section", !find(r, sec.id));
  t("Delete also removes the children", !find(r, a.id) && !find(r, b.id));
}

// 2. Ungroup (⌘⌫) removes section but keeps children at the same world position.
{
  const { engine, sec, a, b } = makeSectionWithKids();
  engine.dispatch({ type: "select", ids: [sec.id] });
  engine.dispatch({ type: "ungroup" });
  const r = engine.snapshot().pages[0].root;
  t("⌘⌫ removes the section", !find(r, sec.id));
  t("⌘⌫ keeps children (a)", !!find(r, a.id));
  t("⌘⌫ keeps children (b)", !!find(r, b.id));
  // Children land at the same canvas-relative positions (section is at 0,0 so they're unchanged).
  const aN = find(r, a.id), bN = find(r, b.id);
  t("⌘⌫ child a stays at (20,20)", aN.x === 20 && aN.y === 20);
  t("⌘⌫ child b stays at (80,80)", bN.x === 80 && bN.y === 80);
  t("Children are reparented to root (top-level)", findParent(r, a.id) === r && findParent(r, b.id) === r);
}

// 3. setTool to "section" via Shift+S.
{
  const engine = new MemoryEngine(false);
  engine.dispatch({ type: "setTool", tool: "section" });
  t("setTool('section') activates the section tool", engine.snapshot().tool === "section");
}

console.log(`\n${pass} passed, ${fail} failed`);
