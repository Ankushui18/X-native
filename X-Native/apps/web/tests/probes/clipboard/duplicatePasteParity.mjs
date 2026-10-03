/**
 * Copy / Paste / Duplicate probe (pipeline Run 16, steps 1-2): the paste and
 * duplicate behaviours Figma documents, measured against the real engine.
 *
 * Figma, Copy and paste objects (4409078832791):
 *   - Duplicate: "If you are duplicating a top-level frame, the new frame
 *     will be placed to the right of the original. Otherwise, new objects
 *     are placed on top of the original."
 *   - Cascade: "If you use click and drag to duplicate, then use this
 *     keyboard shortcut to continue duplicating, Figma will continue the
 *     same distance between objects as you create the duplicate objects."
 *   - Rotation: "If you duplicate an object, rotate the new object, then
 *     continue duplicating ... the new objects will continue rotating at
 *     the degree amount of the original duplicate."
 *   - Paste here: "Position your cursor where you want the top left of your
 *     copied object to be placed."
 *   - Paste over selection (⌘⇧V): "place a copied object on top of a
 *     selected frame, not inside it. The pasted object will match the x, y
 *     position of the selected object."
 *   - Paste to replace (⇧⌘R): "remove a selected object ... and replace it
 *     with the object copied to your clipboard ... the pasted object will
 *     adopt the constraints of the object it replaced."
 *   - Multi-paste: "Objects are pasted in the order that they are copied and
 *     will repeat if there are additional frames. If the number of frames
 *     copied from is more than the number of frames you paste to, the extra
 *     objects are pasted into the last frame."
 *
 * Run:  npx vite-node tests/probes/clipboard/duplicatePasteParity.mjs
 */
import { MemoryEngine, find, findParent } from "../../../src/engine/memory.ts";

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const N = (e, id) => find(rootOf(e), id);
const parentOf = (e, id) => findParent(rootOf(e), id);

let fails = 0;
const say = (s = "") => console.log(s);
const expect = (label, actual, want, ok) => {
  if (!ok) fails++;
  say(`${ok ? "  ok " : " DIFF"} ${label}\n         measured: ${actual}\n         expected: ${want}`);
};

const engine = () => new MemoryEngine(false);
const add = (e, kind, x, y, w, h, parent, patch = {}) => {
  e.dispatch({ type: "add", kind, x, y, w, h, parent: parent ?? rootOf(e).id });
  const id = N(e, parent ?? rootOf(e).id).children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const select = (e, ...ids) => e.dispatch({ type: "select", ids });
const pos = (n) => `(${n.x}, ${n.y}) ${n.w}x${n.h} rot ${n.rotation}`;

say("=== A · Duplicate offset rules (⌘D) ===");
{
  // A1: a plain object duplicates directly on top of the original.
  const e = engine();
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "duplicate" });
  const copy = N(e, e.snapshot().selection[0]);
  expect(
    "A1 · plain object → copy on top of the original",
    pos(copy),
    "(100, 100) — 'Otherwise, new objects are placed on top of the original'",
    copy.x === 100 && copy.y === 100,
  );
}
{
  // A2: a top-level frame goes to the right of the original, clearing it.
  const e = engine();
  const f = add(e, "frame", 100, 100, 200, 150);
  select(e, f);
  e.dispatch({ type: "duplicate" });
  const copy = N(e, e.snapshot().selection[0]);
  expect(
    "A2 · top-level frame → to the right, same y",
    pos(copy),
    `x >= 300 (right edge of original), y = 100 — 'the new frame will be placed to the right of the original'`,
    copy.x >= 300 && copy.y === 100,
  );
}
{
  // A3: a nested child duplicates on top inside its parent.
  const e = engine();
  const f = add(e, "frame", 50, 50, 300, 300);
  const c = add(e, "rect", 20, 20, 40, 40, f);
  select(e, c);
  e.dispatch({ type: "duplicate" });
  const copy = N(e, e.snapshot().selection[0]);
  expect(
    "A3 · nested child → on top within its parent",
    `${pos(copy)} in ${parentOf(e, copy.id).name}`,
    "(20, 20) in the same frame",
    copy.x === 20 && copy.y === 20 && parentOf(e, copy.id).id === f,
  );
}
{
  // A4: move-then-⌘D continues the user-set distance, from the moved copy.
  const e = engine();
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "duplicate" });
  const d1 = e.snapshot().selection[0];
  e.dispatch({ type: "move", ids: [d1], dx: 60, dy: 0 }); // the user's placement
  e.dispatch({ type: "duplicate" });
  const d2 = N(e, e.snapshot().selection[0]);
  expect(
    "A4 · ⌘D after moving the copy continues the same distance (160 → 220)",
    pos(d2),
    "(220, 100) — on-top dup at 100, user moved to 160, next continues +60",
    d2.x === 220 && d2.y === 100,
  );
}
{
  // A5: rotate-then-⌘D repeats the rotation, position stays on top.
  const e = engine();
  const r = add(e, "rect", 200, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "duplicate" });
  const d1 = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: d1, patch: { rotation: 15 } });
  e.dispatch({ type: "duplicate" });
  const d2 = N(e, e.snapshot().selection[0]);
  expect(
    "A5 · ⌘D after rotating the copy repeats the rotation (15 → 30), on top",
    pos(d2),
    "(200, 100) rot 30 — 'new objects will continue rotating at the degree amount'",
    d2.rotation === 30 && d2.x === 200 && d2.y === 100,
  );
}
{
  // A6 (control): an explicit dx/dy (frame quick-add) is exact and leaves
  // the cascade memory alone.
  const e = engine();
  const f = add(e, "frame", 100, 100, 200, 150);
  select(e, f);
  e.dispatch({ type: "duplicate" });
  const first = N(e, e.snapshot().selection[0]);
  const before = { x: first.x, y: first.y };
  select(e, f);
  e.dispatch({ type: "duplicate", dx: 5, dy: 7 });
  const quick = N(e, e.snapshot().selection[0]);
  expect(
    "A6 · explicit dx/dy places exactly (quick-add), control",
    pos(quick),
    "(105, 107)",
    quick.x === 105 && quick.y === 107 && before.x === first.x,
  );
}
{
  // A7 (control): the duplicate sits directly above its original in z-order.
  const e = engine();
  const a = add(e, "rect", 0, 0, 10, 10);
  add(e, "rect", 50, 0, 10, 10);
  select(e, a);
  e.dispatch({ type: "duplicate" });
  const rootKids = rootOf(e).children;
  const at = rootKids.findIndex((c) => c.id === a);
  expect(
    "A7 · duplicate sits at original index + 1, control",
    `index ${at + 1}`,
    "directly above the original",
    rootKids[at + 1].id === e.snapshot().selection[0],
  );
}

say("=== B · Paste here anchoring ===");
{
  // B1: single object — top-left lands on the cursor, not the centre.
  const e = engine();
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "copy" });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 300 });
  const p = N(e, e.snapshot().selection[0]);
  expect(
    "B1 · paste here puts the copy's top-left at the cursor",
    pos(p),
    "(500, 300) — 'Position your cursor where you want the top left of your copied object to be placed'",
    p.x === 500 && p.y === 300,
  );
}
{
  // B2: a multi-object copy keeps its arrangement, top-left of the group at
  // the cursor.
  const e = engine();
  const a = add(e, "rect", 0, 0, 50, 50);
  const b = add(e, "rect", 150, 20, 50, 50);
  select(e, a, b);
  e.dispatch({ type: "copy" });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 300 });
  const [pa, pb] = e.snapshot().selection.map((id) => N(e, id));
  expect(
    "B2 · group paste here: group top-left at cursor, arrangement kept",
    `a ${pos(pa)}; b ${pos(pb)}`,
    "a (500, 300); b (650, 320)",
    pa.x === 500 && pa.y === 300 && pb.x === 650 && pb.y === 320,
  );
}

say("=== C · Paste over selection (⌘⇧V) ===");
{
  // C1: the copy lands AT the selection's position, in the selection's
  // parent — over it, not inside it.
  const e = engine();
  const f = add(e, "frame", 500, 300, 200, 200);
  const r = add(e, "rect", 100, 100, 60, 60);
  select(e, r);
  e.dispatch({ type: "copy" });
  select(e, f);
  // Pre-fix the ⇧⌘V chord dispatches { paste, inPlace: true }; the fix adds
  // an explicit `over` mode. Measure the documented target behaviour via the
  // same command the keyboard will send.
  e.dispatch({ type: "paste", over: true });
  const p = N(e, e.snapshot().selection[0]);
  const par = parentOf(e, p.id);
  expect(
    "C1 · paste over selection matches the selection's x,y in its parent",
    `${pos(p)} in ${par.name}`,
    `(500, 300) in the page root — 'on top of a selected frame, not inside it'`,
    p.x === 500 && p.y === 300 && par.id === rootOf(e).id,
  );
}

say("=== D · Paste to replace (⇧⌘R) ===");
{
  // D1: the command must exist and the pasted content must (a) show the
  // clipboard visual, (b) sit at the replaced object's position, and (c)
  // adopt the replaced object's constraints.
  const e = engine();
  const src = add(e, "rect", 100, 100, 50, 50, null, { fill: "#ff0000" });
  const tgt = add(e, "rect", 500, 300, 80, 80, null, { fill: "#0000ff", constraintH: "max" });
  select(e, src);
  e.dispatch({ type: "copy" });
  select(e, tgt);
  e.dispatch({ type: "pasteToReplace" });
  const sel = e.snapshot().selection.map((id) => N(e, id)).filter(Boolean);
  const replacement = sel.find((n) => n.fill === "#ff0000");
  expect(
    "D1 · paste to replace: clipboard visual at the target's (500,300), constraints adopted",
    sel.length ? sel.map((n) => `${n.name} ${pos(n)} fill ${n.fill} cH ${n.constraintH}`).join("; ") : "nothing selected; nothing replaced",
    "fill #ff0000 at (500, 300), constraintH stays 'max' — 'the pasted object will adopt the constraints of the object it replaced'",
    !!replacement && replacement.x === 500 && replacement.y === 300 && replacement.constraintH === "max",
  );
}

say("=== E · Multi-paste across selected frames ===");
{
  // E1: two objects across two frames, in copied order, one each.
  const e = engine();
  const f1 = add(e, "frame", 0, 300, 200, 200);
  const f2 = add(e, "frame", 300, 300, 200, 200);
  const o1 = add(e, "rect", 10, 10, 40, 40, null, { name: "one" });
  const o2 = add(e, "rect", 10, 60, 40, 40, null, { name: "two" });
  select(e, o1, o2);
  e.dispatch({ type: "copy" });
  select(e, f1, f2);
  e.dispatch({ type: "paste" });
  const in1 = N(e, f1).children.map((c) => c.name);
  const in2 = N(e, f2).children.map((c) => c.name);
  expect(
    "E1 · two objects, two frames: one each, in copied order",
    `${f1 ? "F1" : "F1"}:[${in1}] F2:[${in2}]`,
    "F1:[one] F2:[two] — 'pasted in the order that they are copied'",
    in1.length === 1 && in1[0] === "one" && in2.length === 1 && in2[0] === "two",
  );
}
{
  // E2: two objects across three frames repeat.
  const e = engine();
  const f1 = add(e, "frame", 0, 600, 200, 200);
  const f2 = add(e, "frame", 300, 600, 200, 200);
  const f3 = add(e, "frame", 600, 600, 200, 200);
  const o1 = add(e, "rect", 10, 10, 40, 40, null, { name: "one" });
  const o2 = add(e, "rect", 10, 60, 40, 40, null, { name: "two" });
  select(e, o1, o2);
  e.dispatch({ type: "copy" });
  select(e, f1, f2, f3);
  e.dispatch({ type: "paste" });
  const in1 = N(e, f1).children.map((c) => c.name);
  const in2 = N(e, f2).children.map((c) => c.name);
  const in3 = N(e, f3).children.map((c) => c.name);
  expect(
    "E2 · more frames than objects: the objects repeat",
    `F1:[${in1}] F2:[${in2}] F3:[${in3}]`,
    "F1:[one] F2:[two] F3:[one] — 'will repeat if there are additional frames'",
    in1[0] === "one" && in2[0] === "two" && in3[0] === "one",
  );
}
{
  // E3 (control): more objects than frames — extras into the last frame.
  // With one selected frame all three land inside it, arrangement kept.
  // (The originals live in a holding frame so the page root stays clean and
  // any node at root with a source name would be a spilled paste.)
  const e = engine();
  const bin = add(e, "frame", 2000, 900, 400, 400, null, { name: "SourceBin" });
  const f1 = add(e, "frame", 0, 900, 400, 400);
  const o1 = add(e, "rect", 10, 10, 40, 40, bin, { name: "one" });
  const o2 = add(e, "rect", 10, 60, 40, 40, bin, { name: "two" });
  const o3 = add(e, "rect", 10, 110, 40, 40, bin, { name: "three" });
  select(e, o1, o2, o3);
  e.dispatch({ type: "copy" });
  select(e, f1);
  e.dispatch({ type: "paste" });
  const in1 = N(e, f1).children.map((c) => c.name);
  const spilled = rootOf(e).children.filter((c) => ["one", "two", "three"].includes(c.name)).length;
  expect(
    "E3 · one frame, three objects: all into it (extras to the last frame)",
    `F1:[${in1}] spilled:${spilled}`,
    "F1:[one,two,three] spilled:0",
    in1.length === 3 && spilled === 0,
  );
}

say("=== F · Clipboard isolation (deep-clone freeze) ===");
{
  // F1: mutating the original after the copy must not change what pastes.
  const e = engine();
  const r = add(e, "rect", 100, 100, 50, 50, null, { fill: "#aabbcc" });
  select(e, r);
  e.dispatch({ type: "copy" });
  e.dispatch({ type: "patch", id: r, patch: { fill: "#112233" } });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 500 });
  const p = N(e, e.snapshot().selection[0]);
  expect(
    "F1 · clipboard is frozen at copy time",
    `pasted fill ${p.fill}`,
    "#aabbcc — mutating the original after ⌘C must not affect the paste",
    p.fill === "#aabbcc",
  );
}
{
  // F2: two pastes are independent deep clones of each other and the source.
  const e = engine();
  const r = add(e, "rect", 100, 100, 50, 50, null, { fill: "#aabbcc" });
  select(e, r);
  e.dispatch({ type: "copy" });
  e.dispatch({ type: "paste", x: 500, y: 500 });
  const p1 = e.snapshot().selection[0];
  e.dispatch({ type: "paste", x: 700, y: 500 });
  const p2 = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: p1, patch: { fill: "#000000" } });
  expect(
    "F2 · pastes share no references with each other or the source",
    `source ${N(e, r).fill}; p1 ${N(e, p1).fill}; p2 ${N(e, p2).fill}`,
    "source #aabbcc; p1 #000000; p2 #aabbcc",
    N(e, r).fill === "#aabbcc" && N(e, p1).fill === "#000000" && N(e, p2).fill === "#aabbcc",
  );
}

say();
say(fails ? `${fails} DIFF(s) measured — these are the pre-fix deviations.` : "0 deviations — full parity.");
process.exitCode = fails ? 1 : 0;
