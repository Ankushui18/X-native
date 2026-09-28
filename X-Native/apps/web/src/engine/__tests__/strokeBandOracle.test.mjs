import assert from "node:assert/strict";
import { rectangleStrokeOracle, strokeMatchesRectangle, verifyStrokeDelta, STROKE_EQUIVALENCE_GUARD } from "../strokeBandOracle.ts";

const node = { id: "box", name: "Box", x: -23, y: 7, w: 100, h: 80 };
const style = { id: node.id, width: 10, color: "#234567", align: "outside", join: "bevel" };
const outside = rectangleStrokeOracle(node.w, node.h, style);
assert.deepEqual(outside.outer, [
  [-10, 0], [0, -10], [100, -10], [110, 0], [110, 80], [100, 90], [0, 90], [-10, 80],
]);
assert.deepEqual(outside.inner, [[0, 0], [100, 0], [100, 80], [0, 80]]);
const inside = rectangleStrokeOracle(node.w, node.h, { ...style, align: "inside", join: "miter" });
assert.deepEqual(inside.outer, outside.inner);
assert.deepEqual(inside.inner, [[10, 10], [90, 10], [90, 70], [10, 70]]);
const center = rectangleStrokeOracle(node.w, node.h, { ...style, align: "center", join: "miter" });
assert.deepEqual(center.outer, [[-5, -5], [105, -5], [105, 85], [-5, 85]]);
assert.deepEqual(center.inner, [[5, 5], [95, 5], [95, 75], [5, 75]]);
assert.deepEqual(rectangleStrokeOracle(10, 8, { ...style, align: "inside", width: 5 }).inner, [],
  "a collapsed inset cannot leave an inverted hole");
assert.deepEqual(rectangleStrokeOracle(10, 8, { ...style, width: 0 }), { outer: [], inner: [] });
assert.ok(strokeMatchesRectangle(node, { ...style, ...outside }));
assert.ok(!strokeMatchesRectangle(node, { ...style, ...outside, outer: outside.outer.map(([x, y], i) =>
  i === 0 ? [x + 1, y] : [x, y]) }));
const changed = { revision: 1, node: null, canUndo: true, canRedo: false, stroke: { ...style, ...outside } };
assert.equal(verifyStrokeDelta(changed, id => id === node.id ? node : null), changed);
assert.equal(STROKE_EQUIVALENCE_GUARD, true, "the guard remains until real-WASM parity is proven");
assert.throws(() => verifyStrokeDelta({ ...changed, stroke: { ...changed.stroke, inner: [] } }, () => node),
  /independent rectangle oracle/, "a Rust edit that fails parity must freeze, never replay in TS");
assert.throws(() => verifyStrokeDelta(changed, () => null), /independent rectangle oracle/);
console.log("Stroke guard: analytical contours, narrow holes, guarded mutation/refusal passed");
