/**
 * Headless checks for §19: auto layout UX against the Figma Guide evidence -
 * vertical wrap, the wrap's second gap, inside strokes in layout math, the
 * hug-to-constraints settle, instance spacing fragments, delete-in-instance,
 * and positional canvas drops.
 *
 * Run with:  npx vite-node src/engine/__tests__/autolayout.test.mjs
 */
import { MemoryEngine, find, findParent } from "../memory.ts";
import { flowGapLine, flowInsertIndex, wraps } from "../layout.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const snapOf = (e) => e.snapshot();
const rootOf = (e) => snapOf(e).pages[snapOf(e).page].root;
const byId = (e, id) => find(rootOf(e), id);
const layout = (over = {}) => ({
  direction: "horizontal", gap: 0, padding: [0, 0, 0, 0],
  sizing: "fixed", cross: "fixed", wrap: false, align: "min", justify: "min", ...over,
});
const addFrame = (e, w, h, l) => {
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w, h, parent: rootOf(e).id });
  const id = rootOf(e).children.at(-1).id;
  if (l) e.dispatch({ type: "autoLayout", id, layout: l });
  return id;
};
const addKid = (e, parent, w, h) => {
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w, h, parent });
  return byId(e, parent).children.at(-1).id;
};

console.log("vertical wrap (AL-001-004):");
{
  const e = new MemoryEngine(false);
  t("wrap reads on a vertical flow", wraps(layout({ wrap: true, direction: "vertical" })));
  const V = addFrame(e, 200, 100, layout({ direction: "vertical", gap: 8, padding: [8, 8, 8, 8], wrap: true }));
  addKid(e, V, 40, 40); addKid(e, V, 40, 40); addKid(e, V, 40, 40);
  // One 40px column per 84px of inner height: three columns, top-aligned.
  const at = byId(e, V).children.map((c) => `${c.x},${c.y}`).join(" ");
  t("packs down, then starts a new column", at === "8,8 56,8 104,8");
}
{
  const e = new MemoryEngine(false);
  const V = addFrame(e, 200, 200, layout({ direction: "vertical", gap: 0, wrap: true }));
  addKid(e, V, 40, 80); addKid(e, V, 40, 80); addKid(e, V, 40, 80);
  const at = byId(e, V).children.map((c) => `${c.x},${c.y}`).join(" ");
  t("two stack, the third wraps to column two", at === "0,0 0,80 40,0");
}
{
  const e = new MemoryEngine(false);
  const V = addFrame(e, 200, 100, layout({ direction: "vertical", gap: 8, padding: [8, 8, 8, 8] }));
  addKid(e, V, 40, 40); addKid(e, V, 40, 40); addKid(e, V, 40, 40);
  const at = byId(e, V).children.map((c) => `${c.x},${c.y}`).join(" ");
  t("without the flag a vertical flow stays a plain stack", at === "8,8 8,56 8,104");
}
{
  const e = new MemoryEngine(false);
  const V = addFrame(
    e, 200, 100,
    layout({ direction: "vertical", gap: 8, padding: [8, 8, 8, 8], wrap: true, sizing: "fixed", cross: "hug" }),
  );
  const n = byId(e, V);
  n.sizingW = "hug";
  e.dispatch({ type: "patch", id: V, patch: { sizingW: "hug" } });
  addKid(e, V, 40, 40); addKid(e, V, 40, 40); addKid(e, V, 40, 40);
  // Three 40px columns + two 8px between-gaps + 16px padding = 152.
  t("a hug cross axis grows around the wrapped columns", byId(e, V).w === 152);
}

console.log("the wrap's second gap (AL-005-008):");
{
  const e = new MemoryEngine(false);
  const H = addFrame(e, 100, 200, layout({ gap: 4, gapCross: 30, wrap: true }));
  addKid(e, H, 40, 20); addKid(e, H, 40, 20); addKid(e, H, 40, 20);
  const ys = byId(e, H).children.map((c) => c.y).join(",");
  t("gapCross spaces the rows", ys === "0,0,50");
  const xs = byId(e, H).children.map((c) => c.x).join(",");
  t("gap still spaces within the row", xs === "0,44,0");
}
{
  const e = new MemoryEngine(false);
  const H = addFrame(e, 100, 200, layout({ gap: 6, wrap: true }));
  addKid(e, H, 40, 20); addKid(e, H, 40, 20); addKid(e, H, 40, 20);
  t("rows fall back to gap without a gapCross", byId(e, H).children[2].y === 26);
}
{
  const e = new MemoryEngine(false);
  const V = addFrame(e, 200, 100, layout({ direction: "vertical", gap: 8, gapCross: 20, padding: [8, 8, 8, 8], wrap: true }));
  addKid(e, V, 40, 40); addKid(e, V, 40, 40);
  const at = byId(e, V).children.map((c) => `${c.x},${c.y}`).join(" ");
  t("a vertical wrap spaces its columns with gapCross", at === "8,8 68,8");
}

console.log("inside strokes in layout math (AL-009-014):");
{
  const e = new MemoryEngine(false);
  const S = addFrame(
    e, 10, 10,
    layout({ gap: 0, padding: [8, 8, 8, 8], sizing: "hug", cross: "hug" }),
  );
  e.dispatch({ type: "patch", id: S, patch: { strokeWidth: 10, strokeAlign: "inside", sizingW: "hug", sizingH: "hug" } });
  addKid(e, S, 50, 50);
  const n = byId(e, S);
  t("a hug grows around the inside stroke", n.w === 86 && n.h === 86);
  t("children start inside the stroke", n.children[0].x === 18 && n.children[0].y === 18);
  e.dispatch({ type: "patch", id: S, patch: { strokeAlign: "center" } });
  t("a center stroke is never counted", byId(e, S).w === 66 && byId(e, S).children[0].x === 8);
  e.dispatch({ type: "patch", id: S, patch: { strokeAlign: "outside" } });
  t("an outside stroke is never counted", byId(e, S).w === 66 && byId(e, S).children[0].x === 8);
}
{
  const e = new MemoryEngine(false);
  const S = addFrame(e, 20, 20, layout({ padding: [8, 8, 8, 8] }));
  e.dispatch({ type: "patch", id: S, patch: { strokeWidth: 10, strokeAlign: "inside" } });
  t("minimum size is padding plus inside stroke", byId(e, S).w === 36 && byId(e, S).h === 36);
}
{
  const e = new MemoryEngine(false);
  const S = addFrame(e, 100, 50, layout({}));
  e.dispatch({ type: "patch", id: S, patch: { strokeWidth: 10, strokeAlign: "inside" } });
  const k = addKid(e, S, 10, 10);
  e.dispatch({ type: "patch", id: k, patch: { sizingW: "fill" } });
  t("fill sizing shrinks by the stroke", byId(e, k).w === 80);
}
{
  const e = new MemoryEngine(false);
  const G = addFrame(e, 100, 60, layout({ direction: "grid", gap: 0, padding: [0, 0, 0, 0] }));
  e.dispatch({ type: "autoLayout", id: G, layout: { ...byId(e, G).layout, columns: 2, rows: 1 } });
  e.dispatch({ type: "patch", id: G, patch: { strokeWidth: 10, strokeAlign: "inside" } });
  addKid(e, G, 10, 10); addKid(e, G, 10, 10);
  const kids = byId(e, G).children;
  t("grid cells start inside the stroke", kids[0].x === 10 && kids[1].x === 50);
}

console.log("hug-to-constraints settle (AL-015-017):");
{
  const e = new MemoryEngine(false);
  const S = addFrame(e, 10, 10, layout({ gap: 0, padding: [8, 8, 8, 8], sizing: "hug", cross: "hug" }));
  e.dispatch({ type: "patch", id: S, patch: { sizingW: "hug", sizingH: "hug" } });
  const k = addKid(e, S, 50, 50);
  const a = addKid(e, S, 10, 10);
  e.dispatch({ type: "patch", id: a, patch: { absolutePosition: true, constraintH: "max", constraintV: "max", x: 56, y: 56 } });
  const ax0 = byId(e, a).x;
  e.dispatch({ type: "patch", id: k, patch: { w: 100 } });
  t("an end-pinned absolute child follows hug growth", byId(e, a).x === ax0 + 50);
  t("flow children keep their packed seats", byId(e, k).x === 8 && byId(e, k).y === 8);
}
{
  const e = new MemoryEngine(false);
  const S = addFrame(e, 10, 10, layout({ gap: 0, padding: [8, 8, 8, 8], sizing: "hug", cross: "hug" }));
  e.dispatch({ type: "patch", id: S, patch: { sizingW: "hug", sizingH: "hug" } });
  const k = addKid(e, S, 50, 50);
  const a = addKid(e, S, 10, 10);
  e.dispatch({ type: "patch", id: a, patch: { absolutePosition: true, x: 30, y: 30 } });
  e.dispatch({ type: "patch", id: k, patch: { w: 100 } });
  t("default constraints hold still through a hug", byId(e, a).x === 30 && byId(e, a).y === 30);
}

console.log("delete in an instance (AL-018-020):");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100 });
  const mid = snapOf(e).selection[0];
  addKid(e, mid, 40, 40);
  e.dispatch({ type: "select", ids: [mid] });
  e.dispatch({ type: "makeComponent" });
  const compId = snapOf(e).components[0].id;
  e.dispatch({ type: "placeComponent", id: compId, x: 300, y: 0 });
  const inst = snapOf(e).selection[0];
  const member = byId(e, inst).children[0].id;
  e.dispatch({ type: "select", ids: [member] });
  e.dispatch({ type: "delete" });
  t("delete keeps the member and hides it", !!byId(e, member) && byId(e, member).visible === false);
  e.dispatch({ type: "select", ids: [member] });
  e.dispatch({ type: "delete" });
  t("delete again toggles it back", byId(e, member).visible === true);
  e.dispatch({ type: "select", ids: [inst] });
  e.dispatch({ type: "delete" });
  t("deleting the instance root still deletes it", !byId(e, inst));
}

console.log("instance spacing fragments (AL-021-027):");
const fragmentSetup = () => {
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 200, h: 100 });
  const mid = snapOf(e).selection[0];
  e.dispatch({ type: "autoLayout", id: mid, layout: layout({ gap: 10, padding: [10, 10, 10, 10] }) });
  addKid(e, mid, 40, 40);
  addKid(e, mid, 40, 40);
  e.dispatch({ type: "select", ids: [mid] });
  e.dispatch({ type: "makeComponent" });
  const compId = snapOf(e).components[0].id;
  e.dispatch({ type: "placeComponent", id: compId, x: 300, y: 0 });
  return { e, mid, inst: snapOf(e).selection[0] };
};
{
  const { e, inst } = fragmentSetup();
  e.dispatch({ type: "autoLayout", id: inst, layout: { ...byId(e, inst).layout, gap: 99, padding: [1, 2, 3, 4], direction: "vertical" } });
  const l = byId(e, inst).layout;
  t("a root gap override sticks", l.gap === 99);
  t("a root padding override sticks", JSON.stringify(l.padding) === "[1,2,3,4]");
  t("a root direction change is refused", l.direction === "horizontal");
  t("the override record keeps fragments only", JSON.stringify(Object.keys(byId(e, inst).overrides.layout).sort()) === '["gap","padding"]');
}
{
  const { e, mid, inst } = fragmentSetup();
  e.dispatch({ type: "autoLayout", id: inst, layout: { ...byId(e, inst).layout, gap: 99 } });
  e.dispatch({ type: "autoLayout", id: mid, layout: { ...byId(e, mid).layout, direction: "vertical" } });
  const l = byId(e, inst).layout;
  t("master structure still flows under a spacing override", l.direction === "vertical" && l.gap === 99);
}
{
  const { e, inst } = fragmentSetup();
  const member = byId(e, inst).children[0].id;
  e.dispatch({ type: "patch", id: member, patch: { layout: layout({ gap: 5 }) } });
  t("a member layout patch is refused", byId(e, member).layout == null);
  e.dispatch({ type: "patch", id: inst, patch: { layout: { ...byId(e, inst).layout, gap: 7, wrap: true } } });
  const l = byId(e, inst).layout;
  t("the generic patch keeps root fragments too", l.gap === 7 && l.wrap === false);
}

console.log("positional drops (AL-028-037):");
{
  const e = new MemoryEngine(false);
  const R = addFrame(e, 300, 60, layout({ gap: 10, padding: [10, 10, 10, 10] }));
  addKid(e, R, 50, 40); addKid(e, R, 50, 40); addKid(e, R, 50, 40);
  const n = byId(e, R);
  t("kids pack at 10, 70, 130", n.children.map((c) => c.x).join(",") === "10,70,130");
  t("a point before everything means the front", flowInsertIndex(n, 5, 30) === 0);
  t("a point between means the gap", flowInsertIndex(n, 75, 30) === 1);
  t("a point past everything means the end", flowInsertIndex(n, 290, 30) === 3);
  const line = flowGapLine(n, 75, 30);
  t("the indicator line agrees with the gap", !!line && line.horiz && line.at === 65 && line.from === 10 && line.to === 50);
}
{
  const e = new MemoryEngine(false);
  const R = addFrame(e, 300, 60, layout({ gap: 10, padding: [10, 10, 10, 10] }));
  const a = addKid(e, R, 50, 40);
  e.dispatch({ type: "patch", id: a, patch: { absolutePosition: true, x: 200, y: 10 } });
  addKid(e, R, 50, 40); addKid(e, R, 50, 40);
  // The absolute child holds raw slot 0; the flow gap before everything is raw 1.
  t("absolute children keep their slots", flowInsertIndex(byId(e, R), 5, 30) === 1);
}
{
  const e = new MemoryEngine(false);
  const H = addFrame(e, 100, 200, layout({ gap: 4, wrap: true }));
  addKid(e, H, 40, 20); addKid(e, H, 40, 20); addKid(e, H, 40, 20);
  // Row two holds the third child alone; a point left of it means index 2.
  t("wrap drops find the pointed row", flowInsertIndex(byId(e, H), 5, 60) === 2);
  const line = flowGapLine(byId(e, H), 90, 60);
  t("wrap indicators sit in the pointed row", !!line && line.at === 40 && line.from === 24 && line.to === 44);
}
{
  const e = new MemoryEngine(false);
  const R = addFrame(e, 300, 60, layout({ gap: 10, padding: [10, 10, 10, 10] }));
  addKid(e, R, 50, 40); addKid(e, R, 50, 40); addKid(e, R, 50, 40);
  const before = byId(e, R).children.map((c) => c.id);
  e.dispatch({ type: "add", kind: "rect", x: 500, y: 500, w: 20, h: 20, parent: rootOf(e).id });
  const N = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "reparent", ids: [N], parent: R, x: 75, y: 30 });
  const after = byId(e, R).children.map((c) => c.id);
  t(
    "a drop lands in the pointed gap",
    after.length === 4 && after[0] === before[0] && after[1] === N && after[2] === before[1],
  );
}
{
  const e = new MemoryEngine(false);
  const R = addFrame(e, 300, 60, layout({ gap: 10, padding: [10, 10, 10, 10] }));
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 400, h: 10, parent: rootOf(e).id });
  const B = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "reparent", ids: [B], parent: R, x: 10, y: 10 });
  t("an oversize drop on a fixed frame is refused", findParent(rootOf(e), B).id === rootOf(e).id);
  e.dispatch({ type: "reparent", ids: [B], parent: R, x: 10, y: 10, bypassSizeGate: true });
  t("the bypass lands it", findParent(rootOf(e), B).id === R);
}
{
  const e = new MemoryEngine(false);
  const S = addFrame(e, 10, 10, layout({ gap: 0, padding: [8, 8, 8, 8], sizing: "hug", cross: "hug" }));
  e.dispatch({ type: "patch", id: S, patch: { sizingW: "hug", sizingH: "hug" } });
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 200, h: 40, parent: rootOf(e).id });
  const B = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "reparent", ids: [B], parent: S, x: 8, y: 8 });
  t("a hug frame grows around an oversize drop", findParent(rootOf(e), B).id === S && byId(e, S).w === 216);
}
{
  const e = new MemoryEngine(false);
  const R = addFrame(e, 300, 60, layout({ gap: 10, padding: [10, 10, 10, 10] }));
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 500, h: 500, parent: rootOf(e).id });
  const A = rootOf(e).children.at(-1).id;
  e.dispatch({ type: "reparent", ids: [A], parent: R, x: 33, y: 44, absolute: true });
  const n = byId(e, A);
  t(
    "an absolute drop lands out of the flow, where let go",
    findParent(rootOf(e), A).id === R && n.absolutePosition === true && n.x === 33 && n.y === 44,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
