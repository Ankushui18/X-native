/**
 * Layout grids (Figma help: layout grids & constraints): frames carry an
 * optional layoutGrids array (uniform square grids, columns, rows),
 * rendered as an overlay by Canvas.tsx; ⌘' toggles the pixel grid on the
 * page, ⇧⌘' toggles snap-to-pixel-grid.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const f = node("frame", "F", 0, 0, 1440, 900);
  r.children.push(f);
  t("frame starts without layout grids",
    f.layoutGrids === undefined || f.layoutGrids.length === 0);
  // Add a uniform 1px pixel grid (icon-grid tutorial default).
  engine.dispatch({ type: "patch", id: f.id, patch: {
    layoutGrids: [{ pattern: "grid", size: 1, color: "#ff0000", visible: true }],
  } });
  t("uniform grid added (1px)", find(r, f.id).layoutGrids.length === 1);
  t("grid pattern is 'grid'", find(r, f.id).layoutGrids[0].pattern === "grid");
  t("grid size is 1px", find(r, f.id).layoutGrids[0].size === 1);
}

{
  // 12-column web layout grid with 24px gutter.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const f = node("frame", "F", 0, 0, 1440, 900);
  r.children.push(f);
  engine.dispatch({ type: "patch", id: f.id, patch: {
    layoutGrids: [{ pattern: "columns", count: 12, gutter: 24, margin: 80, color: "#0000ff20", visible: true }],
  } });
  const g = find(r, f.id).layoutGrids[0];
  t("12-column grid added with count=12", g.count === 12);
  t("gutter is 24px", g.gutter === 24);
  t("margin is 80px", g.margin === 80);
}

{
  // ⌘' toggles the page-level pixel grid overlay; ⇧⌘' toggles pixel snap.
  const engine = new MemoryEngine(false);
  const page = engine.snapshot().pages[0];
  t("default pixel grid is off", page.pixelGrid === false);
  t("default pixel snap is on", (page.pixelSnap ?? true) === true);
  engine.dispatch({ type: "patchPage", patch: { pixelGrid: !page.pixelGrid } });
  t("patchPage flips pixelGrid to true", engine.snapshot().pages[0].pixelGrid === true);
  engine.dispatch({ type: "patchPage", patch: { pixelSnap: false } });
  t("patchPage can disable pixel snap", engine.snapshot().pages[0].pixelSnap === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
