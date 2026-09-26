/**
 * Headless checks for §20: the contextual inspector against the Figma
 * properties/alignment evidence — shift-align as a rigid group (per-frame
 * groups), distribute/tidy-up in world coordinates with locked layers and
 * instance members sitting out, tidy-up's most-common-gap spacing and 2D
 * grid, per-layer multi-selection equations, and the ±180 rotation wrap.
 *
 * Run with:  npx vite-node src/engine/__tests__/inspector.test.mjs
 */
import { MemoryEngine, find } from "../memory.ts";
import { parentAlignDelta, rotateAboutOrigin, wrapRotationDeg } from "../../ui/scaleModel.ts";
import { evalFieldMany } from "../../ui/fieldExpr.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const rootOf = (e) => snapOf(e).pages[snapOf(e).page].root;
const N = (e, id) => find(rootOf(e), id);
const lastId = (e) => rootOf(e).children[rootOf(e).children.length - 1].id;
const add = (e, kind, x, y, w, h, extra = {}) => {
  e.dispatch({ type: "add", kind, x, y, w, h, ...extra });
  return lastId(e);
};
// A parented add leaves the root's children untouched, so the new id is the
// parent's last child — lastId would hand back a sibling instead.
const addKid = (e, parent, kind, x, y, w, h) => {
  e.dispatch({ type: "add", kind, x, y, w, h, parent });
  const p = find(rootOf(e), parent);
  return p.children[p.children.length - 1].id;
};

console.log("IN-001 shift-align plants a rigid group on the parent edge:");
{
  // Same-frame pair: both members take the union's delta, so their offsets survive.
  const d = parentAlignDelta("align-left", { x: 10, y: 20, w: 100, h: 50 }, 400, 300);
  t("left edge delta from the union box", d.dx === -10 && d.dy === 0);
  const r = parentAlignDelta("align-right", { x: 10, y: 20, w: 100, h: 50 }, 400, 300);
  t("right edge delta from the union box", r.dx === 290 && r.dy === 0);
  const hc = parentAlignDelta("align-hcenter", { x: 10, y: 20, w: 100, h: 50 }, 400, 300);
  t("h-center delta from the union box", hc.dx === 140 && hc.dy === 0);
  const tp = parentAlignDelta("align-top", { x: 10, y: 20, w: 100, h: 50 }, 400, 300);
  t("top edge delta from the union box", tp.dx === 0 && tp.dy === -20);
  const b = parentAlignDelta("align-bottom", { x: 10, y: 20, w: 100, h: 50 }, 400, 300);
  t("bottom edge delta from the union box", b.dx === 0 && b.dy === 230);
  const vc = parentAlignDelta("align-vcenter", { x: 10, y: 20, w: 100, h: 50 }, 400, 300);
  t("v-center delta from the union box", vc.dx === 0 && vc.dy === 105);
  // Cross-frame members group per frame: each union measures against its own parent.
  const other = parentAlignDelta("align-right", { x: 0, y: 0, w: 60, h: 60 }, 200, 200);
  t("per-frame group uses its own parent size", other.dx === 140 && other.dy === 0);
}

console.log("IN-002 distribute in world coordinates with guards and snap rounding:");
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 100, 0, 500, 200);
  const a = add(e, "rect", 0, 0, 40, 40);
  const b = addKid(e, f, "rect", 0, 60, 40, 40); // world x 100
  const c = add(e, "rect", 300, 0, 40, 40);
  e.dispatch({ type: "select", ids: [a, b, c] });
  e.dispatch({ type: "distribute", axis: "h" });
  // World span 0..340, widths 120, gap 110: middles lands at world 150, i.e. local 50.
  t("outermost layers stay put", N(e, a).x === 0 && N(e, c).x === 300);
  t("nested member distributes by world span", N(e, b).x === 50);
}
{
  // Locked layers and instance members sit out of the span entirely.
  const e = new MemoryEngine(false);
  const g = add(e, "frame", 0, 0, 400, 100);
  const k1 = addKid(e, g, "rect", 0, 0, 40, 40);
  const k2 = addKid(e, g, "rect", 100, 0, 40, 40);
  const k3 = addKid(e, g, "rect", 200, 0, 40, 40);
  e.dispatch({ type: "patch", id: g, patch: { locked: true } });
  // A deep-locked middle leaves too few movers: nothing moves.
  const solo = add(e, "rect", 300, 0, 40, 40);
  e.dispatch({ type: "select", ids: [k1, k2, solo] });
  e.dispatch({ type: "distribute", axis: "h" });
  t("deep-locked layers sit out (too few movers, no-op)", N(e, solo).x === 300 && N(e, k1).x === 0);
  e.dispatch({ type: "patch", id: g, patch: { locked: false } });
  void k3;
}
{
  const e = new MemoryEngine(false);
  // Fractional gap rounds only while the pixel grid is on.
  const a = add(e, "rect", 0, 0, 10, 10);
  const b = add(e, "rect", 20, 0, 10, 10);
  const c = add(e, "rect", 41, 0, 10, 10);
  e.dispatch({ type: "select", ids: [a, b, c] });
  e.dispatch({ type: "distribute", axis: "h" });
  // Span 0..51, widths 30, gap 10.5: middle at 20.5 rounds to 21 with snap on.
  t("snap-on rounds the distributed middle", N(e, b).x === 21);
  e.dispatch({ type: "patchPage", patch: { pixelSnap: false } });
  e.dispatch({ type: "patch", id: b, patch: { x: 20 } });
  e.dispatch({ type: "distribute", axis: "h" });
  t("snap-off keeps the fraction", N(e, b).x === 20.5);
}
{
  // Instance members sit out like locked layers.
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 0, 0, 200, 60);
  add(e, "rect", 10, 10, 40, 40, { parent: f });
  add(e, "rect", 60, 10, 40, 40, { parent: f });
  e.dispatch({ type: "select", ids: [f] });
  e.dispatch({ type: "makeComponent" });
  e.dispatch({ type: "duplicate" });
  const inst = e.snapshot().selection[0];
  const member = find(rootOf(e), inst).children[0].id;
  const before = find(rootOf(e), member).x;
  const r1 = add(e, "rect", 300, 0, 40, 40);
  const r2 = add(e, "rect", 400, 0, 40, 40);
  e.dispatch({ type: "select", ids: [member, r1, r2] });
  e.dispatch({ type: "distribute", axis: "h" });
  // The member sits out, leaving two movers: distribute needs three, so nothing moves.
  t("instance member sits out", find(rootOf(e), member).x === before && N(e, r1).x === 300);
}

console.log("IN-002 tidy-up: most-common gap, 2D grid, guards:");
{
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 40, 40);
  const b = add(e, "rect", 50, 0, 40, 40);
  const c = add(e, "rect", 100, 0, 40, 40);
  const d = add(e, "rect", 170, 0, 40, 40);
  e.dispatch({ type: "select", ids: [a, b, c, d] });
  e.dispatch({ type: "tidyUp" });
  // Gaps 10, 10, 30: the repeated 10 wins, the stray layer pulls in to 150.
  t("first layer anchors the row", N(e, a).x === 0);
  t("repeated gap steps the row", N(e, b).x === 50 && N(e, c).x === 100 && N(e, d).x === 150);
}
{
  // Two layers have a single gap, so there is no mode: the even split is a no-op.
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 40, 40);
  const b = add(e, "rect", 90, 0, 40, 40);
  e.dispatch({ type: "select", ids: [a, b] });
  e.dispatch({ type: "tidyUp" });
  t("two layers hold their gap", N(e, a).x === 0 && N(e, b).x === 90);
}
{
  // Single column: Y-overlap-free stacking goes vertical, X untouched.
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 40, 40);
  const b = add(e, "rect", 5, 60, 40, 40);
  const c = add(e, "rect", 0, 150, 40, 40);
  e.dispatch({ type: "select", ids: [a, b, c] });
  e.dispatch({ type: "tidyUp" });
  // Gaps 20, 50: no mode, so even — span 0..190, heights 120, gap 35.
  t("column tidies vertically", N(e, a).y === 0 && N(e, b).y === 75 && N(e, c).y === 150);
  t("column keeps its X stagger", N(e, a).x === 0 && N(e, b).x === 5 && N(e, c).x === 0);
}
{
  // 2D grid: rows band by Y overlap, columns step from the selection's left.
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 40, 40);
  const b = add(e, "rect", 100, 5, 40, 40);
  const c = add(e, "rect", 5, 100, 40, 40);
  const d = add(e, "rect", 105, 105, 40, 40);
  e.dispatch({ type: "select", ids: [a, b, c, d] });
  e.dispatch({ type: "tidyUp" });
  t("grid top-left never moves", N(e, a).x === 0 && N(e, a).y === 0);
  t("grid columns align", N(e, b).x === 100 && N(e, c).x === 0 && N(e, d).x === 100);
  t("grid rows align", N(e, c).y === 100 && N(e, d).y === 105);
  t("within-row stagger survives", N(e, b).y === 5);
}
{
  // Locked layers sit out of tidy-up too.
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 40, 40);
  const b = add(e, "rect", 50, 0, 40, 40);
  const l = add(e, "rect", 200, 0, 40, 40);
  e.dispatch({ type: "patch", id: l, patch: { locked: true } });
  e.dispatch({ type: "select", ids: [a, b, l] });
  e.dispatch({ type: "tidyUp" });
  t("locked layer holds still", N(e, l).x === 200);
  t("movers tidy without it", N(e, a).x === 0 && N(e, b).x === 50);
}

console.log("IN-003 multi-selection equations evaluate per layer:");
{
  t("plain number lands on all", JSON.stringify(evalFieldMany("100", [10, 20])) === "[100,100]");
  t("+10 adds to each", JSON.stringify(evalFieldMany("+10", [10, 20])) === "[20,30]");
  t("Mixed+100 adds to each", JSON.stringify(evalFieldMany("Mixed+100", [10, 20])) === "[110,120]");
  t("x*2 doubles each", JSON.stringify(evalFieldMany("x*2", [10, 20])) === "[20,40]");
  t("empty draft reverts", evalFieldMany("  ", [10, 20]) === null);
  t("digitless draft reverts", evalFieldMany("abc", [10, 20]) === null);
  t("unparseable layer reverts all", evalFieldMany("1/0", [5, 10]) === null);
}

console.log("IN-004 rotation wraps to ±180 on every write:");
{
  t("190 becomes -170", wrapRotationDeg(190) === -170);
  t("-190 becomes 170", wrapRotationDeg(-190) === 170);
  t("360 becomes 0", wrapRotationDeg(360) === 0);
  t("180 stays 180", wrapRotationDeg(180) === 180);
  t("-180 becomes 180", wrapRotationDeg(-180) === 180);
  t("-0 becomes 0", Object.is(wrapRotationDeg(-0), 0));
  const turned = rotateAboutOrigin({ x: 0, y: 0, w: 100, h: 50, rotation: 0 }, [0.5, 0.5], 190);
  t("panel rotation wraps through the origin math", turned.rotation === -170);
  t("center-origin wrap does not slide the box", turned.x === 0 && turned.y === 0);
  // Ungroup inherits the group's turn, wrapped.
  const e = new MemoryEngine(false);
  const g = add(e, "frame", 0, 0, 100, 100);
  const k = addKid(e, g, "rect", 10, 10, 40, 40);
  e.dispatch({ type: "patch", id: g, patch: { rotation: 170 } });
  e.dispatch({ type: "patch", id: k, patch: { rotation: 30 } });
  e.dispatch({ type: "select", ids: [g] });
  e.dispatch({ type: "ungroup" });
  const kid = rootOf(e).children.map((c) => c.id).includes(k) ? N(e, k) : null;
  t("ungroup combine wraps past 180", kid !== null && kid.rotation === -160);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
