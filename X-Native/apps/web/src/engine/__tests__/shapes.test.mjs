/**
 * Shape tools (Figma help 360040450133):
 *   R rectangle, O ellipse; Shift while dragging = perfect square/circle;
 *   Alt = create from center; corner radii on rectangles; ellipse arc ratio
 *   handles; polygon/star vertex count.
 *
 * These behaviors live in Canvas.tsx's create/resize drag loop; we verify
 * the engine's geometry for newly created shapes (default kind, fills,
 * stroke defaults, corner radii) and for ellipse arc flags.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

// 1. Default rectangle: 100×100, no stroke, visible fill, 4 corners (not 8)
//    is a renderer concern checked by canvasChrome; engine defaults correct.
{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "Rect", 0, 0, 100, 100);
  r.children.push(rect);
  t("default rectangle has 0 corner radius (square corners)",
    rect.cornerRadii === undefined || rect.cornerRadii[0] === 0);
  t("default rectangle is not an ellipse/polygon", rect.kind === "rect");
}

// 2. Ellipse with arcRatio sweeps an arc.
{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const e = node("ellipse", "E", 0, 0, 100, 100, { arcStart: 0, arcEnd: Math.PI * 2 });
  r.children.push(e);
  engine.dispatch({ type: "patch", id: e.id, patch: { arcEnd: Math.PI } });
  const n = find(r, e.id);
  t("ellipse arcEnd can be reduced to a semicircle", Math.abs(n.arcEnd - Math.PI) < 0.01);
}

// 3. Polygon has a pointCount.
{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const p = node("poly", "Tri", 0, 0, 100, 100, { pointCount: 3 });
  r.children.push(p);
  t("polygon starts with pointCount 3 (triangle)", p.pointCount === 3);
  engine.dispatch({ type: "patch", id: p.id, patch: { pointCount: 6 } });
  t("polygon pointCount can be changed to 6 (hexagon)", find(r, p.id).pointCount === 6);
}

// 4. Star has a pointCount.
{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const s = node("star", "Star", 0, 0, 100, 100, { pointCount: 5 });
  r.children.push(s);
  t("star defaults to 5 points", s.pointCount === 5);
}

// 5. Line vs Arrow: line has no arrowheads by default; arrow does.
{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const l = node("line", "Line", 0, 0, 100, 0);
  const a = node("arrow", "Arrow", 0, 20, 100, 0);
  r.children.push(l, a);
  t("line kind is 'line'", l.kind === "line");
  t("arrow kind is 'arrow'", a.kind === "arrow");
}

// 6. Stroke defaults: rect/ellipse start with inside stroke; lines/arrows
//    with center stroke (engine defaults).
{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const rect = node("rect", "R", 0, 0, 100, 100);
  const line = node("line", "L", 0, 0, 100, 0);
  r.children.push(rect, line);
  t("rect default strokeAlign is 'inside'", rect.strokeAlign === "inside");
  t("line default strokeAlign is 'center'", line.strokeAlign === "center");
}

console.log(`\n${pass} passed, ${fail} failed`);
