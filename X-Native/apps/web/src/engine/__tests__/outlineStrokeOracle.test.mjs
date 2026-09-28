import assert from "node:assert/strict";
import { outlineAuditRequested, outlineInkVerdict, outlineReferenceRect, recordOutlineAudit } from "../outlineStrokeOracle.ts";
import { __enableBridgeAuditForTests, bridgeAuditSnapshot, resetBridgeAudit } from "../bridgeRuntimeAudit.ts";

const rect = { id: "a", name: "Box", x: 10, y: 20, w: 30, h: 40, kind: "rect", radius: 0 };
const style = (over = {}) => ({ width: 8, color: "#236b9e", align: "center", capStart: "none",
  capEnd: "none", join: "miter", dash: [], dashOffset: 0, miterLimit: 4, widthProfile: [], ...over });
/** A committed filled vector whose rings are written by hand, not measured. */
const committed = (x, y, w, h, rings, fill = "#236b9e") => ({ id: "a", name: "Box", x, y, w, h,
  kind: "vector", fill, stroke: null,
  path: rings.flatMap(ring => [["M", ring[0][0], ring[0][1]],
    ...ring.slice(1).map(([px, py]) => ["L", px, py]), ["Z"]]) });

// A centred 8-wide miter band on a 30x40 rectangle: the outer boundary is the
// source expanded by 4, the hole is the source inset by 4 with opposite
// winding. Both rings are hand-computed, so this is an independent check of
// the reference rather than a restatement of its own formulas.
const miterBand = committed(6, 16, 38, 48, [
  [[0, 0], [38, 0], [38, 48], [0, 48]],
  [[8, 8], [8, 40], [30, 40], [30, 8]],
]);
assert.deepEqual(outlineInkVerdict(rect, style(), miterBand), {
  verified: true, decisive: true, reason: "committed filled ink equals the independent rectangle band model",
});

// The same band with beveled outer corners: each corner is cut on the diagonal
// through the two offset edge points.
const bevelBand = committed(6, 16, 38, 48, [
  [[0, 4], [4, 0], [34, 0], [38, 4], [38, 44], [34, 48], [4, 48], [0, 44]],
  [[8, 8], [8, 40], [30, 40], [30, 8]],
]);
assert.equal(outlineInkVerdict(rect, style({ join: "bevel" }), bevelBand).verified, true);

// An inside band keeps the centreline as its outer boundary and insets by the
// full width, so the hole is the source inset by 8.
const insideBand = committed(10, 20, 30, 40, [
  [[0, 0], [30, 0], [30, 40], [0, 40]],
  [[8, 8], [8, 32], [22, 32], [22, 8]],
]);
assert.equal(outlineInkVerdict(rect, style({ align: "inside" }), insideBand).verified, true);

// Every wrong ink is a decisive finding: a filled box instead of a band, a
// band offset by the wrong width, dropped miter-limit fallback and a fill that
// is not the source stroke paint.
for (const [label, verdict] of [
  ["missing hole", outlineInkVerdict(rect, style(), committed(6, 16, 38, 48, [[[0, 0], [38, 0], [38, 48], [0, 48]]]))],
  ["wrong offset", outlineInkVerdict(rect, style(), committed(4, 14, 42, 52, [
    [[0, 0], [42, 0], [42, 52], [0, 52]], [[10, 10], [10, 42], [32, 42], [32, 10]]]))],
  ["miter limit fallback", outlineInkVerdict(rect, style({ miterLimit: 1 }), miterBand)],
  ["wrong paint", outlineInkVerdict(rect, style(), committed(6, 16, 38, 48, [
    [[0, 0], [38, 0], [38, 48], [0, 48]], [[8, 8], [8, 40], [30, 40], [30, 8]]], "#000000"))],
]) {
  assert.equal(verdict.verified, false, label);
  assert.equal(verdict.decisive, true, `${label} must be a finding, not a coverage gap`);
}
assert.throws(() => recordOutlineAudit({ verified: false, decisive: true, reason: "committed ink differs" }),
  /independent rectangle reference/);

// Styles and sources the reference does not model are reported as coverage
// gaps: they must never be asserted as a pass and never as a mismatch.
for (const [label, verdict] of [
  ["dashes", outlineInkVerdict(rect, style({ dash: [6, 3] }), miterBand)],
  ["variable width", outlineInkVerdict(rect, style({ widthProfile: [{ position: 0, widthMultiplier: 1 }] }), miterBand)],
  ["collapsed inner ring", outlineInkVerdict(rect, style({ width: 20, align: "inside" }), insideBand)],
  ["unmodelled corners", outlineInkVerdict({ ...rect, w: 4, h: 4, x: 0, y: 0 }, style({ width: 1 }),
    committed(-0.5, -0.5, 5, 5, [[[0, 0], [5, 0], [5, 5], [0, 5]], [[1, 1], [1, 4], [4, 4], [4, 1]]]))],
]) {
  assert.equal(verdict.verified, false, label);
  assert.equal(verdict.decisive, false, `${label} must stay a coverage gap`);
}
assert.equal(outlineInkVerdict(rect, style(), { ...miterBand, kind: "rect", radius: 0,
  path: undefined }).decisive, false, "a non-vector result is reported, never asserted");

assert.deepEqual(outlineReferenceRect(rect), { x: 10, y: 20, w: 30, h: 40 });
assert.equal(outlineReferenceRect({ ...rect, radius: 4 }), null, "rounded corners are not this model");
assert.equal(outlineReferenceRect({ ...rect, kind: "ellipse" }), null);
assert.equal(outlineReferenceRect({ ...rect, w: 0 }), null);

const priorLocation = globalThis.location;
try {
  globalThis.location = { search: "?outline=audit" };
  assert.equal(outlineAuditRequested(), true);
  globalThis.location = { search: "?offset=audit" };
  assert.equal(outlineAuditRequested(), false);
  globalThis.location = { search: "" };
  assert.equal(outlineAuditRequested(), false);
} finally {
  if (priorLocation === undefined) delete globalThis.location;
  else globalThis.location = priorLocation;
}

__enableBridgeAuditForTests(true);
try {
  resetBridgeAudit();
  recordOutlineAudit(outlineInkVerdict(rect, style(), miterBand));
  const passed = bridgeAuditSnapshot().decisions["session.outline"];
  assert.equal(passed.last.guard, "passed");
  assert.equal(passed.last.result, "rust");
  resetBridgeAudit();
  recordOutlineAudit(outlineInkVerdict(rect, style({ dash: [6, 3] }), miterBand));
  const notRun = bridgeAuditSnapshot().decisions["session.outline"];
  assert.equal(notRun.last.guard, "not-run");
  assert.equal(notRun.last.result, "none");
  assert.equal(notRun.blocked, 0, "a coverage gap is not a refusal");
} finally {
  resetBridgeAudit();
  __enableBridgeAuditForTests(false);
}
console.log("Outline ink reference: analytic rect band, joins/alignment, miter fallback and coverage-gap reporting passed");
