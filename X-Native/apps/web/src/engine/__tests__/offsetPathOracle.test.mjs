import assert from "node:assert/strict";
import { offsetCoverageEquivalent, guardOffsetPreview, OffsetGuardRejected, offsetRings, offsetAuditRequested, prominentMiterTips } from "../offsetPathOracle.ts";

const source = { id: "a", name: "Box", x: 10, y: 20, w: 70, h: 40, kind: "rect", radius: 0 };
const vector = (x, y, w, h, points) => ({ ...source, kind: "vector", x, y, w, h,
  path: [["M", ...points[0]], ...points.slice(1).map(p => ["L", ...p]), ["Z"]] });
const square = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const expanded = vector(4, 14, 82, 52, square(82, 52));
assert.equal(offsetCoverageEquivalent(source, expanded, 6, "miter"), true);
assert.equal(guardOffsetPreview(source, expanded, 6, "miter"), expanded);
const priorLocation = globalThis.location;
try {
  globalThis.location = { search: "?offset=audit" };
  assert.equal(offsetAuditRequested(), true);
  assert.equal(guardOffsetPreview(source, expanded, 6, "miter"), expanded);
} finally {
  if (priorLocation === undefined) delete globalThis.location;
  else globalThis.location = priorLocation;
}
assert.equal(offsetCoverageEquivalent(source, vector(15, 25, 60, 30, square(60, 30)), -5, "round"), true);
assert.equal(offsetCoverageEquivalent(source, { ...expanded, x: 10, y: 20, w: 1, h: 1, path: [] }, -40, "miter"), true);
const bevel = vector(4, 14, 82, 52, [[0, 6], [6, 0], [76, 0], [82, 6],
  [82, 46], [76, 52], [6, 52], [0, 46]]);
assert.equal(offsetCoverageEquivalent(source, bevel, 6, "bevel"), true);
const failureReasons = [];
assert.equal(offsetCoverageEquivalent(source, bevel, 6, "miter", reason => failureReasons.push(reason)), false);
assert.ok(failureReasons[0]?.includes("coverage") || failureReasons[0]?.includes("corner"));
// Inversion, wrong winding/identity/bounds and unproved curves must block.
for (const bad of [
  [expanded, -6, "miter"],
  [bevel, 6, "miter"],
  [{ ...expanded, id: "b" }, 6, "miter"],
  [{ ...expanded, w: 81 }, 6, "miter"],
  [{ ...expanded, path: [["M", 0, 0], ["C", 1, 2, 3, 4, 5, 6], ["Z"]] }, 6, "miter"],
]) {
  const [result, distance, join] = bad;
  assert.equal(offsetCoverageEquivalent(source, result, distance, join), false, join);
  assert.throws(() => guardOffsetPreview(source, result, distance, join), OffsetGuardRejected);
}
// A star's acute convex tips extend well beyond a circular distance field.
// The analytical miter-line reference must retain those tips, while inset
// cases have no outward-tip probes.
const star = { ...source, kind: "star", x: 12, y: 18, w: 90, h: 72, count: 5, ratio: 0.42 };
const tips = prominentMiterTips(star, 4);
assert.equal(tips.length, 5);
assert.ok(tips.some(([x, y]) => Math.abs(x - 45) < 1e-7 && Math.abs(y + 9.45) < 0.1));
assert.deepEqual(prominentMiterTips(star, -4), []);
assert.deepEqual(offsetRings(expanded.path), [square(82, 52)]);
assert.equal(offsetRings([["M", 0, 0], ["C", 1, 2, 3, 4, 5, 6], ["Z"]]), null);
console.log("Offset guard: TS nonzero/analytic coverage, both signs and join/mismatch refusals passed");
