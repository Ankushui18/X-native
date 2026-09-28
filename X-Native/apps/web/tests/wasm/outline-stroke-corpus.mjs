/**
 * Independent filled-ink oracle for the guarded Outline Stroke promotion
 * corpus.  This intentionally does not call any x-core geometry helper: it
 * evaluates straight centre lines, SVG dash phase, caps, rectangular alignment
 * bands and NONZERO output paths in plain JavaScript.
 *
 * The caller supplies the low-level generated-bindgen session factory, so this
 * proof exercises RustDocumentSession.outlineStroke directly and independently
 * of the promoted web owner's admission and delta projection.
 */
import assert from "node:assert/strict";

const COLOR = "#236b9e";
const TRANSPARENT = "#00000000";
const EPS = 1e-8;

function style(overrides = {}) {
  return {
    width: 10,
    color: COLOR,
    align: "center",
    capStart: "none",
    capEnd: "none",
    join: "miter",
    dash: [],
    dashOffset: 0,
    miterLimit: 4,
    widthProfile: [],
    ...overrides,
  };
}

function strokeLayer(s) {
  return {
    color: s.color,
    width: s.width,
    opacity: 1,
    visible: true,
    blend: "normal",
    align: s.align,
    cap_start: s.capStart,
    cap_end: s.capEnd,
    join: s.join,
    dash: s.dash,
    dash_offset: s.dashOffset,
    miter: s.miterLimit,
    width_profile: s.widthProfile.map(({ position, widthMultiplier }) => ({
      position,
      width_multiplier: widthMultiplier,
    })),
  };
}

function sourceNode(test) {
  const s = test.style;
  return {
    id: test.id,
    name: test.label,
    kind: test.kind,
    x: test.x,
    y: test.y,
    w: test.w,
    h: test.h,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: { t: "solid", c: TRANSPARENT },
    // Both legacy and materialized values are supplied deliberately.  The
    // session must prove it can restore the original rich raw .x style.
    stroke: { color: s.color, width: s.width },
    fill_layers: [{ paint: { t: "solid", c: TRANSPARENT }, opacity: 1, visible: true, blend: "normal" }],
    stroke_layers: [strokeLayer(s)],
    effect_layers: [],
  };
}

function sourceDocument(test) {
  return JSON.stringify({
    format: "x-native",
    version: 1,
    pages: [{
      id: `page-${test.id}`,
      kind: { t: "frame" },
      x: 0,
      y: 0,
      w: 360,
      h: 260,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      fill: { t: "solid", c: "#ffffff" },
      children: [sourceNode(test)],
    }],
  });
}

function profileAt(profile, t) {
  if (!profile.length) return 1;
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped <= profile[0].position) return profile[0].widthMultiplier;
  const last = profile.at(-1);
  if (clamped >= last.position) return last.widthMultiplier;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    if (clamped <= b.position) {
      const f = (clamped - a.position) / (b.position - a.position);
      return a.widthMultiplier + (b.widthMultiplier - a.widthMultiplier) * f;
    }
  }
  return 1;
}

/** SVG's positive offset consumes pattern distance at the path start. */
function dashRuns(length, dash, offset) {
  if (!dash.length) return [[0, length]];
  const pattern = dash.length % 2 ? [...dash, ...dash] : [...dash];
  const period = pattern.reduce((sum, value) => sum + value, 0);
  let phase = ((offset % period) + period) % period;
  let index = 0;
  while (phase >= pattern[index] - EPS) {
    phase -= pattern[index];
    index = (index + 1) % pattern.length;
  }
  let remaining = Math.max(EPS, pattern[index] - phase);
  let cursor = 0;
  const runs = [];
  while (cursor < length - EPS) {
    const take = Math.min(remaining, length - cursor);
    if (index % 2 === 0 && take > EPS) runs.push([cursor, cursor + take]);
    cursor += take;
    remaining -= take;
    if (remaining <= EPS) {
      index = (index + 1) % pattern.length;
      remaining = pattern[index];
    }
  }
  return runs;
}

function triangleContains(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  return (d1 >= -EPS && d2 >= -EPS && d3 >= -EPS) || (d1 <= EPS && d2 <= EPS && d3 <= EPS);
}

function lineMetrics(test) {
  const dx = test.w, dy = test.h;
  const length = Math.hypot(dx, dy);
  return { length, ux: dx / length, uy: dy / length };
}

/** Analytic reference for a straight profile/dash/cap stroke. */
function lineInk(test, point) {
  const { length, ux, uy } = lineMetrics(test);
  const rx = point[0] - test.x, ry = point[1] - test.y;
  const distance = rx * ux + ry * uy;
  const normal = -rx * uy + ry * ux;
  const radiusAt = value => test.style.width * profileAt(test.style.widthProfile, value / length) / 2;
  for (const [start, end] of dashRuns(length, test.style.dash, test.style.dashOffset)) {
    if (distance >= start - EPS && distance <= end + EPS && Math.abs(normal) <= radiusAt(distance) + EPS) {
      return true;
    }
    const startRadius = radiusAt(start), endRadius = radiusAt(end);
    if (test.style.capStart === "square" && distance >= start - startRadius - EPS && distance <= start && Math.abs(normal) <= startRadius + EPS) return true;
    if (test.style.capEnd === "square" && distance >= end && distance <= end + endRadius + EPS && Math.abs(normal) <= endRadius + EPS) return true;
    if (test.style.capStart === "round" && (distance - start) ** 2 + normal ** 2 <= startRadius ** 2 + EPS) return true;
    if (test.style.capEnd === "round" && (distance - end) ** 2 + normal ** 2 <= endRadius ** 2 + EPS) return true;
    const capLength = cap => cap === "arrow" ? 3 : 2;
    if (["arrow", "triangle"].includes(test.style.capStart) && triangleContains(
      distance, normal, start, -startRadius, start, startRadius,
      start - capLength(test.style.capStart) * startRadius, 0,
    )) return true;
    if (["arrow", "triangle"].includes(test.style.capEnd) && triangleContains(
      distance, normal, end, -endRadius, end, endRadius,
      end + capLength(test.style.capEnd) * endRadius, 0,
    )) return true;
  }
  return false;
}

function maxMultiplier(s) {
  return Math.max(1, ...s.widthProfile.map(point => point.widthMultiplier));
}

function lineBounds(test) {
  const extent = test.style.width * maxMultiplier(test.style) * 2 + 12;
  return [Math.min(test.x, test.x + test.w) - extent, Math.min(test.y, test.y + test.h) - extent,
    Math.max(test.x, test.x + test.w) + extent, Math.max(test.y, test.y + test.h) + extent];
}

function rectPath(w, h) {
  return [["M", 0, 0], ["L", w, 0], ["L", w, h], ["L", 0, h], ["Z"]];
}

function inBox(x, y, left, top, right, bottom) {
  return x >= left - EPS && x <= right + EPS && y >= top - EPS && y <= bottom + EPS;
}

/** Exact mitered rectangular ring (outside corners are square miters). */
function miterRectInk(test, point) {
  const x = point[0] - test.x, y = point[1] - test.y;
  const { w, h, style: s } = test;
  const width = s.width;
  const outer = s.align === "inside" ? 0 : s.align === "outside" ? width : width / 2;
  const inner = s.align === "inside" ? width : s.align === "outside" ? 0 : width / 2;
  if (!inBox(x, y, -outer, -outer, w + outer, h + outer)) return false;
  if (w <= 2 * inner || h <= 2 * inner) return true;
  return !inBox(x, y, inner, inner, w - inner, h - inner);
}

/**
 * Rectangular edge oracle.  It intentionally returns null near corners where
 * bevel and round joins differ; explicit independent corner probes below cover
 * those styles.  It supports profiled closed strokes by evaluating perimeter t.
 */
function edgeRectInk(test, point) {
  const x = point[0] - test.x, y = point[1] - test.y;
  const { w, h, style: s } = test;
  const fullMax = s.width * maxMultiplier(s);
  const margin = fullMax + 5;
  if (x < -margin || x > w + margin || y < -margin || y > h + margin) return false;
  const perimeter = 2 * (w + h);
  let q, at;
  if (x >= margin && x <= w - margin) {
    if (Math.abs(y) <= Math.abs(y - h)) {
      q = y; at = x; // top: positive q points into the clockwise rectangle
    } else {
      q = h - y; at = w + h + (w - x);
    }
  } else if (y >= margin && y <= h - margin) {
    if (Math.abs(x - w) <= Math.abs(x)) {
      q = w - x; at = w + y;
    } else {
      q = x; at = 2 * w + h + (h - y);
    }
  } else {
    return null;
  }
  const full = s.width * profileAt(s.widthProfile, at / perimeter);
  const inside = s.align === "inside" ? full : s.align === "center" ? full / 2 : 0;
  const outside = s.align === "outside" ? full : s.align === "center" ? full / 2 : 0;
  return q >= -outside - EPS && q <= inside + EPS;
}

function rectBounds(test) {
  const extent = test.style.width * maxMultiplier(test.style) + 14;
  return [test.x - extent, test.y - extent, test.x + test.w + extent, test.y + test.h + extent];
}

function joinProbes(test, effectiveJoin = test.style.join) {
  if (test.style.align !== "center") return [];
  const r = test.style.width / 2;
  const miterOnly = [test.x - .8 * r, test.y - .8 * r];
  const roundOnly = [test.x - .8 * r, test.y - .3 * r];
  return [
    { point: miterOnly, expected: effectiveJoin === "miter" },
    { point: roundOnly, expected: effectiveJoin === "miter" || effectiveJoin === "round" },
    { point: [test.x + test.w / 2, test.y - r * .6], expected: true },
  ];
}

function lineCase(id, label, axis, overrides = {}) {
  const horizontal = axis === "horizontal";
  const s = style(overrides);
  const test = {
    id, label, kind: { t: "line" },
    x: horizontal ? 62 : 236,
    y: horizontal ? 45 : 54,
    w: horizontal ? 180 : 0,
    h: horizontal ? 0 : 142,
    style: s,
  };
  test.bounds = lineBounds(test);
  test.oracle = point => lineInk(test, point);
  test.probes = [];
  return test;
}

function rectCase(id, label, source, overrides = {}) {
  const s = style(overrides);
  const test = {
    id, label,
    kind: source === "vector" ? { t: "vector", path: rectPath(126, 84) } : { t: "rect", radius: 0 },
    x: 86,
    y: 82,
    w: 126,
    h: 84,
    style: s,
  };
  test.bounds = rectBounds(test);
  const profiled = s.widthProfile.length > 0;
  const hasSquareMiter = s.join === "miter" && !profiled && s.miterLimit >= Math.SQRT2;
  test.oracle = hasSquareMiter ? point => miterRectInk(test, point) : point => edgeRectInk(test, point);
  const effectiveJoin = s.join === "miter" && s.miterLimit < Math.SQRT2 ? "bevel" : s.join;
  test.probes = (s.join === "bevel" || s.join === "round" || s.miterLimit < Math.SQRT2 || s.join === "miter")
    && !profiled ? joinProbes(test, effectiveJoin) : [];
  return test;
}

function corpusCases() {
  const taper = [
    { position: 0, widthMultiplier: .55 },
    { position: .48, widthMultiplier: 1.5 },
    { position: 1, widthMultiplier: .8 },
  ];
  const bulge = [
    { position: 0, widthMultiplier: .8 },
    { position: .3, widthMultiplier: 1.85 },
    { position: .7, widthMultiplier: 1.25 },
    { position: 1, widthMultiplier: .65 },
  ];
  const rectProfile = [
    { position: 0, widthMultiplier: .6 },
    { position: .25, widthMultiplier: 1.5 },
    { position: .62, widthMultiplier: 1.1 },
    { position: 1, widthMultiplier: .75 },
  ];
  return [
    // Axis-aligned line cases exercise the line endpoint-delta dialect (one
    // dimension is legitimately zero), all cap variants, and SVG dash phase.
    lineCase("outline-01", "horizontal butt", "horizontal", { width: 8 }),
    lineCase("outline-02", "vertical butt", "vertical", { width: 11 }),
    lineCase("outline-03", "horizontal round", "horizontal", { width: 12, capStart: "round", capEnd: "round" }),
    lineCase("outline-04", "vertical square", "vertical", { width: 9, capStart: "square", capEnd: "square" }),
    lineCase("outline-05", "arrow to triangle", "horizontal", { width: 9, capStart: "arrow", capEnd: "triangle" }),
    lineCase("outline-06", "triangle to arrow", "vertical", { width: 10, capStart: "triangle", capEnd: "arrow" }),
    lineCase("outline-07", "positive phase round dashes", "horizontal", { width: 9, capStart: "round", capEnd: "round", dash: [28, 12], dashOffset: 7 }),
    lineCase("outline-08", "negative phase square dashes", "vertical", { width: 10, capStart: "square", capEnd: "square", dash: [25, 11], dashOffset: -9 }),
    lineCase("outline-09", "odd SVG dash list", "horizontal", { width: 8, dash: [17, 9, 5], dashOffset: 6 }),
    lineCase("outline-10", "tapered profile", "vertical", { width: 12, capStart: "round", capEnd: "square", widthProfile: taper }),
    lineCase("outline-11", "bulged profile", "horizontal", { width: 9, capStart: "round", capEnd: "round", widthProfile: bulge }),
    lineCase("outline-12", "profiled round dashes", "vertical", { width: 10, capStart: "round", capEnd: "round", dash: [22, 8], dashOffset: 5, widthProfile: taper }),
    lineCase("outline-13", "profiled asymmetric caps", "horizontal", { width: 8, capStart: "arrow", capEnd: "triangle", widthProfile: bulge }),
    lineCase("outline-14", "open inside is centered", "vertical", { width: 10, align: "inside", capStart: "round", capEnd: "square" }),
    lineCase("outline-15", "open outside is centered", "horizontal", { width: 10, align: "outside", capStart: "square", capEnd: "round" }),
    lineCase("outline-16", "dense round dashes", "vertical", { width: 7, capStart: "round", capEnd: "round", dash: [8, 5], dashOffset: 3 }),
    lineCase("outline-17", "dense profiled dashes", "horizontal", { width: 8, capStart: "round", capEnd: "square", dash: [15, 6], dashOffset: -4, widthProfile: bulge }),
    lineCase("outline-18", "profiled square caps", "vertical", { width: 11, capStart: "square", capEnd: "square", widthProfile: taper }),

    // Primitive and raw-vector rectangles independently verify closed-path
    // alignment, all joins and the miter-limit bevel fallback.
    rectCase("outline-19", "rect center miter", "rect", { width: 10, join: "miter" }),
    rectCase("outline-20", "rect center bevel", "rect", { width: 10, join: "bevel" }),
    rectCase("outline-21", "rect center round", "rect", { width: 10, join: "round" }),
    rectCase("outline-22", "rect miter fallback", "rect", { width: 10, join: "miter", miterLimit: 1 }),
    rectCase("outline-23", "rect inside miter", "rect", { width: 11, align: "inside", join: "miter" }),
    rectCase("outline-24", "rect outside miter", "rect", { width: 11, align: "outside", join: "miter" }),
    rectCase("outline-25", "rect profiled center", "rect", { width: 9, join: "miter", widthProfile: rectProfile }),
    rectCase("outline-26", "rect profiled inside", "rect", { width: 9, align: "inside", join: "round", widthProfile: rectProfile }),
    rectCase("outline-27", "rect profiled outside", "rect", { width: 9, align: "outside", join: "bevel", widthProfile: rectProfile }),
    rectCase("outline-28", "vector center miter", "vector", { width: 10, join: "miter" }),
    rectCase("outline-29", "vector center round", "vector", { width: 10, join: "round" }),
    rectCase("outline-30", "vector profiled inside", "vector", { width: 9, align: "inside", join: "bevel", widthProfile: rectProfile }),
  ];
}

function outputContours(outline) {
  const contours = [];
  let current = null;
  for (const command of outline.path) {
    const [tag, ...values] = command;
    if (tag === "M") {
      if (current?.length) throw new Error("outline emitted an unclosed contour");
      current = [[outline.x + values[0], outline.y + values[1]]];
    } else if (tag === "L") {
      if (!current) throw new Error("outline emitted a line before move");
      current.push([outline.x + values[0], outline.y + values[1]]);
    } else if (tag === "Z") {
      if (!current || current.length < 3) throw new Error("outline emitted a degenerate contour");
      contours.push(current);
      current = null;
    } else {
      throw new Error(`outline emitted unsupported non-linear command ${tag}`);
    }
  }
  if (current) throw new Error("outline emitted an open fill contour");
  return contours;
}

function windingContains(contours, point) {
  let winding = 0;
  for (const contour of contours) for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (a[1] <= point[1]) {
      if (b[1] > point[1] && cross > 0) winding++;
    } else if (b[1] <= point[1] && cross < 0) {
      winding--;
    }
  }
  return winding !== 0;
}

function edgeDistance(contours, point) {
  let best = Infinity;
  for (const contour of contours) for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const denom = dx * dx + dy * dy;
    const t = denom <= EPS ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denom));
    best = Math.min(best, Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)));
  }
  return best;
}

function verifyInk(test, outline) {
  const contours = outputContours(outline);
  assert.ok(contours.length > 0, `${test.id}: filled outline must contain ink contours`);
  const [left, top, right, bottom] = test.bounds;
  let checked = 0;
  const mismatches = [];
  // A dense, deterministic lattice deliberately avoids an image/raster shared
  // implementation.  Points close to a polygon edge are skipped so round-cap
  // faceting cannot turn an analytic boundary convention into test noise.
  for (let yi = 0; yi <= 32; yi++) for (let xi = 0; xi <= 56; xi++) {
    const point = [left + (right - left) * xi / 56, top + (bottom - top) * yi / 32];
    const expected = test.oracle(point);
    if (expected === null || edgeDistance(contours, point) < .42) continue;
    checked++;
    const actual = windingContains(contours, point);
    if (actual !== expected && mismatches.length < 8) mismatches.push({ point, expected, actual });
  }
  assert.ok(checked >= 150, `${test.id}: oracle did not retain enough non-boundary samples (${checked})`);
  assert.deepEqual(mismatches, [], `${test.id}: committed fill ink differs from independent reference`);
  for (const { point, expected } of test.probes) {
    assert.ok(edgeDistance(contours, point) > .2, `${test.id}: join probe landed on output boundary`);
    assert.equal(windingContains(contours, point), expected,
      `${test.id}: join reference disagrees at ${point.join(",")}`);
  }
}

function expectedUndoStyle(s) {
  return {
    width: s.width,
    color: s.color,
    align: s.align,
    capStart: s.capStart,
    capEnd: s.capEnd,
    join: s.join,
    dash: s.dash,
    dashOffset: s.dashOffset,
    miterLimit: s.miterLimit,
    widthProfile: s.widthProfile,
  };
}

async function assertRefusal(openRustSession, test, mutate, label) {
  const raw = JSON.parse(sourceDocument(test));
  mutate(raw.pages[0].children[0]);
  const owner = await openRustSession(JSON.stringify(raw));
  assert.ok(owner, `${label}: generated Rust session must open before refusal`);
  try {
    const before = owner.exportX();
    assert.throws(() => owner.outlineStroke(test.id), /.+/, `${label}: invalid outline input must reject`);
    assert.equal(owner.state().revision, 0, `${label}: refusal must not create history`);
    assert.equal(owner.exportX(), before, `${label}: refusal must not change a checkpoint`);
  } finally {
    owner.close();
  }
}

/** Run the genuine 30-case generated-WASM corpus. This is the evidence that
 * was recorded green BEFORE the public web guard was lifted; it still runs on
 * every real-artifact smoke so a native regression cannot hide behind the
 * promoted web route. The promotion itself (the public owner dispatching the
 * one Rust command with no TS oracle) is asserted in `real-bridges.mjs`. */
export async function runOutlineStrokeCorpus({ openRustSession, auditSnapshot }) {
  const tests = corpusCases();
  assert.equal(tests.length, 30, "promotion corpus is intentionally exactly 30 cases");
  const beforeAudit = auditSnapshot();
  const beforeCalls = beforeAudit.functions["x-wasm.RustDocumentSession.outlineStroke"]?.calls ?? 0;
  const beforeFailures = beforeAudit.functions["x-wasm.RustDocumentSession.outlineStroke"]?.failed ?? 0;

  for (const test of tests) {
    const owner = await openRustSession(sourceDocument(test));
    assert.ok(owner, `${test.id}: actual generated RustDocumentSession must open`);
    try {
      const before = owner.exportX();
      const applied = owner.outlineStroke(test.id);
      assert.equal(applied.revision, 1, `${test.id}: apply is exactly one history entry`);
      assert.equal(applied.node, null, `${test.id}: outline delta must not masquerade as a scalar node edit`);
      assert.equal(applied.outline?.id, test.id, `${test.id}: affected identity must be retained`);
      assert.equal(applied.outline?.kind, "vector", `${test.id}: stroke must become a vector layer`);
      assert.equal(applied.outline?.fill, COLOR, `${test.id}: stroke paint must become filled ink`);
      assert.equal(applied.outline?.stroke, null, `${test.id}: result cannot retain a live stroke`);
      assert.ok(applied.outline.path.some(command => command[0] === "Z"), `${test.id}: output must close filled geometry`);
      assert.ok(applied.outline.path.length <= 10_923, `${test.id}: output exceeds the binding path budget`);
      assert.ok(!JSON.stringify(applied).includes('"pages"'), `${test.id}: bounded delta must not contain a document`);
      verifyInk(test, applied.outline);

      const after = owner.exportX();
      const saved = JSON.parse(after);
      const layer = saved.pages[0].children[0];
      assert.equal(layer.id, test.id, `${test.id}: checkpoint must retain layer identity`);
      assert.equal(layer.kind.t, "vector", `${test.id}: checkpoint must commit vector geometry`);
      assert.equal(layer.stroke, undefined, `${test.id}: checkpoint must remove legacy stroke`);
      assert.equal(layer.fill.c, COLOR, `${test.id}: checkpoint must commit the stroke color as fill`);
      assert.equal(layer.stroke_layers?.length, 0, `${test.id}: checkpoint cannot retain stroke layers`);

      const undone = owner.undo();
      assert.equal(undone.revision, 2, `${test.id}: undo is exactly one history step`);
      assert.equal(undone.outline?.id, test.id);
      assert.equal(undone.outline?.kind, test.kind.t, `${test.id}: undo must project the original source kind`);
      assert.equal(undone.outline?.fill, null, `${test.id}: transparent source fill must round-trip as null`);
      assert.deepEqual(undone.outline?.stroke, expectedUndoStyle(test.style), `${test.id}: undo must restore rich stroke metadata`);
      assert.equal(owner.exportX(), before, `${test.id}: undo checkpoint must byte-round-trip the canonical source`);

      const redone = owner.redo();
      assert.equal(redone.revision, 3, `${test.id}: redo is exactly one history step`);
      assert.deepEqual(redone.outline, applied.outline, `${test.id}: redo must restore the exact filled vector delta`);
      assert.equal(owner.exportX(), after, `${test.id}: redo checkpoint must restore the filled vector`);
    } finally {
      owner.close();
    }
  }

  // Rejections are part of the bridge proof: malformed rich stroke styles and
  // a point-like line must remain no-op failures rather than partial history.
  await assertRefusal(openRustSession, tests[0], layer => { layer.stroke_layers[0].dash = [0, 4]; }, "zero dash");
  await assertRefusal(openRustSession, tests[1], layer => {
    layer.stroke_layers[0].width_profile = [
      { position: .8, width_multiplier: 1 }, { position: .2, width_multiplier: 1 },
    ];
  }, "unsorted width profile");
  await assertRefusal(openRustSession, tests[0], layer => { layer.w = 0; layer.h = 0; }, "point-like line");

  const afterAudit = auditSnapshot();
  assert.equal(afterAudit.functions["x-wasm.RustDocumentSession.outlineStroke"]?.calls, beforeCalls + 33,
    "30 committed and 3 refused calls must all reach generated RustDocumentSession.outlineStroke");
  assert.equal(afterAudit.functions["x-wasm.RustDocumentSession.outlineStroke"]?.failed, beforeFailures + 3,
    "only the deliberate malformed inputs may fail at the generated binding boundary");
  return { cases: tests.length };
}
