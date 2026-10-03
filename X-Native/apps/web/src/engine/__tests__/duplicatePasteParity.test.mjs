/**
 * Copy / Paste / Duplicate parity (pipeline Run 16).
 *
 * Figma, Copy and paste objects (4409078832791) and Frames in Figma Design
 * (360041539473). What this pins (measured pre-fix by
 * tests/probes/clipboard/duplicatePasteParity.mjs, 11 DIFFs, 0 after):
 *
 *   A. Offsets: plain objects duplicate on top of the original, a top-level
 *      frame "will be placed to the right of the original", a nested child
 *      on top within its parent.
 *   B. Smart-Duplicate cascade: "Figma will continue the same distance
 *      between objects" — translation composes across drags and nudges,
 *      rotation repeats at "the degree amount of the original duplicate",
 *      and a fresh selection breaks the chain. An explicit dx/dy (frame
 *      quick-add) is exact and leaves the memory alone.
 *   C. Paste here: the group's TOP-LEFT lands on the cursor, arrangement
 *      kept; onto an auto layout frame the paste rides on top, not inside
 *      the flow. `anchor: "center"` remains for ⌘V at the viewport middle.
 *   D. Paste over selection (⌘⇧V): "on top of a selected frame, not inside
 *      it ... match the x, y position of the selected object".
 *   E. Paste to replace (⇧⌘R): the clipboard swaps each selected object at
 *      its own position and z-slot, and "the pasted object will adopt the
 *      constraints of the object it replaced"; locked layers and instance
 *      members refuse; one undo step covers the batch.
 *   F. Multi-paste: objects "pasted in the order that they are copied",
 *      repeating when frames outnumber objects, extras into the last frame.
 *   G. Clipboard isolation: the in-app clipboard is a deep-clone freeze —
 *      later mutations of the source, or of other pastes, never leak.
 *   H. Undo shape: pasteToReplace and paste undo as single steps.
 *
 * Sabotage (each restored byte-exact, md5-compared): remove the top-level-
 * frame-right rule -> A2/B4 fail; drop the rotation from the cascade ->
 * B3 fails; drop the constraint adoption in pasteToReplace -> E2 fails.
 *
 * Run with:  npx vite-node src/engine/__tests__/duplicatePasteParity.test.mjs
 */
import { MemoryEngine, find, findParent } from "../memory.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };

const rootOf = (e) => e.snapshot().pages[e.snapshot().page].root;
const N = (e, id) => find(rootOf(e), id);
const parentOf = (e, id) => findParent(rootOf(e), id);
const add = (e, kind, x, y, w, h, parent, patch = {}) => {
  e.dispatch({ type: "add", kind, x, y, w, h, parent: parent ?? rootOf(e).id });
  const id = N(e, parent ?? rootOf(e).id).children.at(-1).id;
  if (Object.keys(patch).length) e.dispatch({ type: "patch", id, patch });
  return id;
};
const select = (e, ...ids) => e.dispatch({ type: "select", ids });

console.log("A · duplicate offsets:");
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "duplicate" });
  const c = N(e, e.snapshot().selection[0]);
  t("A1 plain object duplicates on top of the original", c.x === 100 && c.y === 100);
}
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 100, 100, 200, 150);
  select(e, f);
  e.dispatch({ type: "duplicate" });
  const c = N(e, e.snapshot().selection[0]);
  // Sabotage S1: without the right-of-original rule this is 110.
  t("A2 top-level frame duplicates to the right (x + w + 20), same y", c.x === 320 && c.y === 100);
  t("A2b the copy cleared the original (no overlap)", c.x >= 300);
}
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 50, 50, 300, 300);
  const r = add(e, "rect", 20, 20, 40, 40, f);
  select(e, r);
  e.dispatch({ type: "duplicate" });
  const c = N(e, e.snapshot().selection[0]);
  t("A3 nested child duplicates on top within its parent",
    c.x === 20 && c.y === 20 && parentOf(e, c.id).id === f);
}
{
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 10, 10);
  add(e, "rect", 50, 0, 10, 10);
  select(e, a);
  e.dispatch({ type: "duplicate" });
  const kids = rootOf(e).children;
  const at = kids.findIndex((c) => c.id === a);
  t("A4 duplicate sits directly above the original in z-order", kids[at + 1].id === e.snapshot().selection[0]);
}

console.log("B · smart-duplicate cascade:");
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "duplicate" });           // on top at (100,100)
  const d1 = e.snapshot().selection[0];
  e.dispatch({ type: "move", ids: [d1], dx: 60, dy: 0 });
  e.dispatch({ type: "duplicate" });           // continues +60
  const d2 = N(e, e.snapshot().selection[0]);
  t("B1 move-then-⌘D continues the same distance", d2.x === 220 && d2.y === 100);
}
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "duplicate" });
  const d1 = e.snapshot().selection[0];
  e.dispatch({ type: "move", ids: [d1], dx: 30, dy: 0 });
  e.dispatch({ type: "nudge", dx: 10, dy: 0 }); // arrow-key fine-tune after the drag
  e.dispatch({ type: "duplicate" });
  const d2 = N(e, e.snapshot().selection[0]);
  t("B2 drag + nudge compose into one cascade delta (40, not 10 or 30)",
    d2.x === 100 + 40 + 40 && d2.y === 100);
}
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 200, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "duplicate" });
  const d1 = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: d1, patch: { rotation: 15 } });
  e.dispatch({ type: "duplicate" });
  const d2 = N(e, e.snapshot().selection[0]);
  // Sabotage S2: without dRot in the cascade this stays 15.
  t("B3 rotate-then-⌘D repeats the rotation (15 → 30), position on top",
    d2.rotation === 30 && d2.x === 200 && d2.y === 100);
  e.dispatch({ type: "duplicate" });
  const d3 = N(e, e.snapshot().selection[0]);
  t("B3b the repeat keeps repeating (30 → 45)", d3.rotation === 45);
}
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 100, 100, 200, 150);
  select(e, f);
  e.dispatch({ type: "duplicate" });           // right: 320
  e.dispatch({ type: "duplicate" });           // marches right again: 540
  const c2 = N(e, e.snapshot().selection[0]);
  t("B4 repeated frame ⌘D keeps marching right (320 → 540)", c2.x === 540 && c2.y === 100);
}
{
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 50, 50);
  const b = add(e, "rect", 500, 0, 50, 50);
  select(e, a);
  e.dispatch({ type: "duplicate" });
  e.dispatch({ type: "move", ids: [e.snapshot().selection[0]], dx: 80, dy: 0 });
  select(e, b);                                 // chain broken by a fresh selection
  e.dispatch({ type: "duplicate" });
  const bc = N(e, e.snapshot().selection[0]);
  t("B5 a fresh selection breaks the chain (on top, not +80)", bc.x === 500 && bc.y === 0);
}
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 100, 100, 200, 150);
  select(e, f);
  e.dispatch({ type: "duplicate" });           // seeds the right-march cascade
  select(e, f);
  e.dispatch({ type: "duplicate", dx: 5, dy: 7 });
  const quick = N(e, e.snapshot().selection[0]);
  t("B6 explicit dx/dy (quick-add) places exactly", quick.x === 105 && quick.y === 107);
}

console.log("C · paste anchoring:");
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "copy" });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 300 });
  const p = N(e, e.snapshot().selection[0]);
  t("C1 paste here puts the copy's top-left on the cursor", p.x === 500 && p.y === 300);
}
{
  const e = new MemoryEngine(false);
  const a = add(e, "rect", 0, 0, 50, 50);
  const b = add(e, "rect", 150, 20, 50, 50);
  select(e, a, b);
  e.dispatch({ type: "copy" });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 300 });
  const [pa, pb] = e.snapshot().selection.map((id) => N(e, id));
  t("C2 group paste here keeps the arrangement, group top-left on the cursor",
    pa.x === 500 && pa.y === 300 && pb.x === 650 && pb.y === 320);
}
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "copy" });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 300, anchor: "center" });
  const p = N(e, e.snapshot().selection[0]);
  t("C3 anchor:center keeps the ⌘V-at-viewport behaviour (475,275)", p.x === 475 && p.y === 275);
}
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 0, 0, 400, 300, null, { name: "Layout" });
  e.dispatch({ type: "autoLayout", id: f, layout: { mode: "row", gap: 10, padL: 0, padT: 0, padR: 0, padB: 0, align: "start", mainSizing: "fixed", crossSizing: "fixed" } });
  const r = add(e, "rect", 900, 900, 50, 50);
  select(e, r);
  e.dispatch({ type: "copy" });
  select(e, f);
  e.dispatch({ type: "paste", x: 100, y: 100 });
  const p = N(e, e.snapshot().selection[0]);
  t("C4 paste here onto an auto layout frame rides on top, not inside the flow",
    parentOf(e, p.id).id === f && p.absolutePosition === true);
}

console.log("D · paste over selection (⌘⇧V):");
{
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 500, 300, 200, 200);
  const r = add(e, "rect", 100, 100, 60, 60);
  select(e, r);
  e.dispatch({ type: "copy" });
  select(e, f);
  e.dispatch({ type: "paste", over: true });
  const p = N(e, e.snapshot().selection[0]);
  t("D1 over lands at the selection's x,y", p.x === 500 && p.y === 300);
  t("D2 over lands in the selection's parent, not inside the frame", parentOf(e, p.id).id === rootOf(e).id);
  const kids = rootOf(e).children;
  t("D3 over sits directly above the selection in z-order",
    kids[kids.findIndex((c) => c.id === f) + 1].id === p.id);
  t("D4 the selection itself is untouched (over, not replace)", !!N(e, f));
}
{
  // A multi-object copy over a selection: group top-left on the selection,
  // arrangement kept, stacked in order above it.
  const e = new MemoryEngine(false);
  const f = add(e, "frame", 500, 300, 200, 200);
  const a = add(e, "rect", 10, 10, 40, 40);
  const b = add(e, "rect", 110, 10, 40, 40);
  select(e, a, b);
  e.dispatch({ type: "copy" });
  select(e, f);
  e.dispatch({ type: "paste", over: true });
  const [pa, pb] = e.snapshot().selection.map((id) => N(e, id));
  t("D5 multi-object over: group top-left on the selection, arrangement kept",
    pa.x === 500 && pa.y === 300 && pb.x === 600 && pb.y === 300);
}

console.log("E · paste to replace (⇧⌘R):");
{
  const e = new MemoryEngine(false);
  const src = add(e, "rect", 100, 100, 50, 50, null, { fill: "#ff0000", rotation: 45 });
  const tgt = add(e, "rect", 500, 300, 80, 80, null, { fill: "#0000ff", constraintH: "max", constraintV: "center" });
  const tgtSlot = rootOf(e).children.findIndex((c) => c.id === tgt);
  select(e, src);
  e.dispatch({ type: "copy" });
  select(e, tgt);
  e.dispatch({ type: "pasteToReplace" });
  const p = N(e, e.snapshot().selection[0]);
  t("E1 the pasted copy shows the clipboard visual (fill + rotation)",
    p.fill === "#ff0000" && p.rotation === 45);
  // Sabotage S3: without adoption these read the clipboard's own constraints.
  t("E2 the pasted copy adopts the replaced object's constraints",
    p.constraintH === "max" && p.constraintV === "center");
  t("E3 the copy sits at the replaced object's position", p.x === 500 && p.y === 300);
  t("E4 the target is gone (replace, not overlay)", !N(e, tgt));
  t("E5 the copy keeps the replaced object's z-slot", rootOf(e).children[tgtSlot]?.id === p.id);
  t("E6 the replaced copy gets a fresh id", p.id !== tgt);
}
{
  // Cross-kind replace (the doc's placeholder workflow): rect ← star keeps
  // the clipboard's kind.
  const e = new MemoryEngine(false);
  const star = add(e, "star", 0, 0, 60, 60, null, { fill: "#ffcc00" });
  const box = add(e, "rect", 400, 400, 100, 100);
  select(e, star);
  e.dispatch({ type: "copy" });
  select(e, box);
  e.dispatch({ type: "pasteToReplace" });
  const p = N(e, e.snapshot().selection[0]);
  t("E7 cross-kind replace takes the clipboard's kind", p.kind === "star" && p.fill === "#ffcc00" && p.x === 400 && p.y === 400);
}
{
  // Every selected object gets its own replacement.
  const e = new MemoryEngine(false);
  const src = add(e, "rect", 0, 0, 50, 50, null, { fill: "#ff0000" });
  const t1 = add(e, "rect", 100, 100, 10, 10);
  const t2 = add(e, "rect", 200, 200, 10, 10);
  const t3 = add(e, "rect", 300, 300, 10, 10);
  select(e, src);
  e.dispatch({ type: "copy" });
  select(e, t1, t2, t3);
  e.dispatch({ type: "pasteToReplace" });
  const ps = e.snapshot().selection.map((id) => N(e, id));
  t("E8 multi-target replace: three targets, three replacements at their spots",
    ps.length === 3 &&
    ps.every((p) => p.fill === "#ff0000") &&
    ps.some((p) => p.x === 100 && p.y === 100) &&
    ps.some((p) => p.x === 200 && p.y === 200) &&
    ps.some((p) => p.x === 300 && p.y === 300) &&
    !N(e, t1) && !N(e, t2) && !N(e, t3));
}
{
  const e = new MemoryEngine(false);
  const src = add(e, "rect", 0, 0, 50, 50);
  const locked = add(e, "rect", 100, 100, 10, 10, null, { locked: true });
  select(e, src);
  e.dispatch({ type: "copy" });
  select(e, locked);
  const before = e.snapshot().canUndo;
  e.dispatch({ type: "pasteToReplace" });
  t("E9 a locked target refuses the replace (no-op, no undo pushed)",
    !!N(e, locked) && e.snapshot().canUndo === before);
}
{
  const e = new MemoryEngine(false);
  const tgt = add(e, "rect", 100, 100, 10, 10);
  select(e, tgt);
  const before = e.snapshot().canUndo;
  e.dispatch({ type: "pasteToReplace" });        // empty clipboard
  t("E10 pasteToReplace with an empty clipboard is a silent no-op",
    !!N(e, tgt) && e.snapshot().canUndo === before);
}

console.log("F · multi-paste across selected frames:");
{
  const e = new MemoryEngine(false);
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
  t("F1 two objects, two frames: one each, in copied order",
    in1.length === 1 && in1[0] === "one" && in2.length === 1 && in2[0] === "two");
  const c1 = N(e, f1).children[0];
  t("F1b each object centred in its frame", c1.x === 80 && c1.y === 80);
}
{
  const e = new MemoryEngine(false);
  const f1 = add(e, "frame", 0, 600, 200, 200);
  const f2 = add(e, "frame", 300, 600, 200, 200);
  const f3 = add(e, "frame", 600, 600, 200, 200);
  const o1 = add(e, "rect", 10, 10, 40, 40, null, { name: "one" });
  const o2 = add(e, "rect", 10, 60, 40, 40, null, { name: "two" });
  select(e, o1, o2);
  e.dispatch({ type: "copy" });
  select(e, f1, f2, f3);
  e.dispatch({ type: "paste" });
  const in3 = N(e, f3).children.map((c) => c.name);
  t("F2 more frames than objects: the objects repeat", in3.length === 1 && in3[0] === "one");
}
{
  const e = new MemoryEngine(false);
  const f1 = add(e, "frame", 0, 900, 400, 400);
  const f2 = add(e, "frame", 500, 900, 400, 400);
  const o1 = add(e, "rect", 10, 10, 40, 40, null, { name: "one" });
  const o2 = add(e, "rect", 10, 60, 40, 40, null, { name: "two" });
  const o3 = add(e, "rect", 10, 110, 40, 40, null, { name: "three" });
  select(e, o1, o2, o3);
  e.dispatch({ type: "copy" });
  select(e, f1, f2);
  e.dispatch({ type: "paste" });
  const in1 = N(e, f1).children.map((c) => c.name);
  const in2 = N(e, f2).children.map((c) => c.name);
  t("F3 more objects than frames: extras into the last frame",
    in1.length === 1 && in1[0] === "one" && in2.length === 2 && in2[0] === "two" && in2[1] === "three");
}

console.log("G · clipboard isolation:");
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50, null, { fill: "#aabbcc" });
  select(e, r);
  e.dispatch({ type: "copy" });
  e.dispatch({ type: "patch", id: r, patch: { fill: "#112233" } });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 500 });
  const p = N(e, e.snapshot().selection[0]);
  t("G1 the clipboard is frozen at copy time", p.fill === "#aabbcc");
}
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50, null, { fill: "#aabbcc" });
  select(e, r);
  e.dispatch({ type: "copy" });
  e.dispatch({ type: "paste", x: 500, y: 500 });
  const p1 = e.snapshot().selection[0];
  e.dispatch({ type: "paste", x: 700, y: 500 });
  const p2 = e.snapshot().selection[0];
  e.dispatch({ type: "patch", id: p1, patch: { fill: "#000000" } });
  t("G2 pastes share no references with each other or the source",
    N(e, r).fill === "#aabbcc" && N(e, p1).fill === "#000000" && N(e, p2).fill === "#aabbcc");
}

console.log("H · undo shape:");
{
  const e = new MemoryEngine(false);
  const src = add(e, "rect", 0, 0, 50, 50, null, { fill: "#ff0000" });
  const tgt = add(e, "rect", 100, 100, 10, 10);
  select(e, src);
  e.dispatch({ type: "copy" });
  select(e, tgt);
  e.dispatch({ type: "pasteToReplace" });
  t("H1 pasteToReplace is one history entry", !!N(e, e.snapshot().selection[0]));
  e.dispatch({ type: "undo" });
  t("H1b one undo restores the replaced object", !!N(e, tgt) && !e.snapshot().selection.includes(src));
  e.dispatch({ type: "redo" });
  t("H1c redo replaces again", !N(e, tgt));
}
{
  const e = new MemoryEngine(false);
  const r = add(e, "rect", 100, 100, 50, 50);
  select(e, r);
  e.dispatch({ type: "copy" });
  select(e);
  e.dispatch({ type: "paste", x: 500, y: 500 });
  const before = rootOf(e).children.length;
  e.dispatch({ type: "undo" });
  t("H2 paste is one history entry", rootOf(e).children.length === before - 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
