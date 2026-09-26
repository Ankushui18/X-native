/**
 * Headless checks for §11 (strokes): side weights, dashes, miter angles,
 * branching gates, stroke spill hit-testing, hover preview, and extras render.
 *
 * Run with:  npx vite-node src/engine/__tests__/strokes.test.mjs
 */
import { MemoryEngine, find, hitTest } from "../memory.ts";
import {
  dashArray,
  dashOffset,
  isBranchingNetwork,
  miterLimitFromAngle,
  parseDashPattern,
  sideWidths,
  strokeSpill,
  usesVariableWidth,
} from "../strokeModel.ts";
import { paintExtraStrokes } from "../paint.ts";

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
process.on("exit", () => console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`));

console.log("S-A individual strokes:");
{
  t("all sides take the weight", JSON.stringify(sideWidths("all", undefined, 3)) === "[3,3,3,3]");
  t("missing picker means all", JSON.stringify(sideWidths(undefined, undefined, 3)) === "[3,3,3,3]");
  t("top only", JSON.stringify(sideWidths("top", undefined, 3)) === "[3,0,0,0]");
  t("right only", JSON.stringify(sideWidths("right", undefined, 3)) === "[0,3,0,0]");
  t("bottom only", JSON.stringify(sideWidths("bottom", undefined, 3)) === "[0,0,3,0]");
  t("left only", JSON.stringify(sideWidths("left", undefined, 3)) === "[0,0,0,3]");
  t("custom reads per-side weights", JSON.stringify(sideWidths("custom", [1, 2, 0, 4], 9)) === "[1,2,0,4]");
  t("custom clamps negatives", JSON.stringify(sideWidths("custom", [-2, 1, 1, 1], 9)) === "[0,1,1,1]");
  t("weight clamps at zero", JSON.stringify(sideWidths("all", undefined, -5)) === "[0,0,0,0]");
}

console.log("S-B dashes:");
{
  t("dash+gap pair", JSON.stringify(dashArray(undefined, 10, 5)) === "[10,5]");
  t("gap falls back to dash", JSON.stringify(dashArray(undefined, 10, 0)) === "[10,10]");
  t("no dash means solid", dashArray(undefined, 0, 0).length === 0);
  t("pattern wins over fields", JSON.stringify(dashArray([4, 2, 1], 10, 5)) === "[4,2,1]");
  t("scale applies to all", JSON.stringify(dashArray([4, 2], 0, 0, 2)) === "[8,4]");
  t("offset is half the first dash", dashOffset([10, 5]) === 5);
  t("solid has no offset", dashOffset([]) === 0);
  t("pattern parses commas", JSON.stringify(parseDashPattern("10, 20, 10, 20")) === "[10,20,10,20]");
  t("pattern parses spaces", JSON.stringify(parseDashPattern("4 2 1")) === "[4,2,1]");
  t("empty pattern clears", JSON.stringify(parseDashPattern("  ")) === "[]");
  t("words are refused", parseDashPattern("10, x") === null);
  t("negatives are refused", parseDashPattern("10, -2") === null);
}

console.log("S-C miter angles:");
{
  t("0 never bevels", miterLimitFromAngle(0) > 9999);
  t("missing never bevels", miterLimitFromAngle(undefined) > 9999);
  t("180 always bevels", miterLimitFromAngle(180) === 1);
  t("90 gives root two", Math.abs(miterLimitFromAngle(90) - Math.SQRT2) < 1e-9);
  t("sharper angles raise the limit", miterLimitFromAngle(30) > miterLimitFromAngle(90));
}

console.log("S-D branching gate:");
{
  t("no network never branches", !isBranchingNetwork(undefined));
  t("single segment never branches", !isBranchingNetwork({ vertices: [], segments: [{ start: 0, end: 1 }] }));
  t(
    "chain never branches",
    !isBranchingNetwork({ vertices: [], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }] }),
  );
  t(
    "loop never branches",
    !isBranchingNetwork({
      vertices: [],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
    }),
  );
  t(
    "T-junction branches",
    isBranchingNetwork({
      vertices: [],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 1, end: 3 }],
    }),
  );
  const prof = [
    { position: 0, widthMultiplier: 1 },
    { position: 1, widthMultiplier: 2 },
  ];
  const vec = (over = {}) => ({
    kind: "vector",
    strokeWidth: 4,
    strokeVisible: true,
    strokePaint: "#000000",
    strokeWidthProfile: prof,
    ...over,
  });
  t("profiled chain varies", usesVariableWidth(vec()));
  t(
    "branching network stays uniform",
    !usesVariableWidth(
      vec({ vectorNetwork: { vertices: [], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 1, end: 3 }] } }),
    ),
  );
  t("rectangles never profile", !usesVariableWidth(vec({ kind: "rect" })));
  t(
    "uniform profile takes the fast path",
    !usesVariableWidth(vec({ strokeWidthProfile: [{ position: 0, widthMultiplier: 1 }, { position: 1, widthMultiplier: 1 }] })),
  );
}

console.log("S-E stroke spill:");
{
  const rect = (over = {}) => ({
    kind: "rect",
    strokeWidth: 10,
    strokeVisible: true,
    strokePaint: "#000000",
    strokeAlign: "outside",
    strokes: [],
    ...over,
  });
  t("outside spills full weight", strokeSpill(rect()) === 10);
  t("centre spills half", strokeSpill(rect({ strokeAlign: "center" })) === 5);
  t("inside never spills", strokeSpill(rect({ strokeAlign: "inside" })) === 0);
  t("hidden stroke never spills", strokeSpill(rect({ strokeVisible: false })) === 0);
  t("removed paint never spills", strokeSpill(rect({ strokePaint: "#00000000" })) === 0);
  t("extras count", strokeSpill(rect({ strokeAlign: "inside", strokes: [{ color: "#111", opacity: 1, visible: true, width: 6, align: "outside" }] })) === 6);
  t("hidden extras do not", strokeSpill(rect({ strokeAlign: "inside", strokes: [{ color: "#111", opacity: 1, visible: false, width: 6, align: "outside" }] })) === 0);
  t("lines force centre", strokeSpill({ ...rect(), kind: "line", strokeAlign: "outside" }) === 5);
}

console.log("S-F spilled strokes stay clickable:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const root = e.snapshot().pages[e.snapshot().page].root;
  const id = root.children[root.children.length - 1].id;
  const hit = (x, y) => hitTest(e.snapshot().pages[e.snapshot().page].root, x, y)?.id ?? null;
  t("box interior hits with no stroke", hit(50, 50) === id);
  t("outside the box misses with no stroke", hit(105, 50) === null);
  e.dispatch({ type: "patch", id, patch: { strokePaint: "#000000", strokeVisible: true, strokeWidth: 20, strokeAlign: "outside" } });
  t("spill hits with an outside stroke", hit(105, 50) === id);
  t("past the spill still misses", hit(125, 50) === null);
  e.dispatch({ type: "patch", id, patch: { strokeAlign: "inside" } });
  t("inside stroke spills nothing", hit(105, 50) === null);
}

console.log("S-G stroke hover preview:");
{
  const e = new MemoryEngine(false);
  e.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  const root = e.snapshot().pages[e.snapshot().page].root;
  const id = root.children[root.children.length - 1].id;
  t("no preview by default", e.snapshot().previewStroke === null);
  e.dispatch({ type: "previewStroke", id, align: "outside" });
  t("preview sets", JSON.stringify(e.snapshot().previewStroke) === JSON.stringify({ id, align: "outside" }));
  e.dispatch({ type: "previewStroke", id: null });
  t("preview clears", e.snapshot().previewStroke === null);
  e.dispatch({ type: "patch", id, patch: { strokeWidth: 7 } });
  e.dispatch({ type: "previewStroke", id, align: "center" });
  e.dispatch({ type: "undo" });
  t("preview owns no undo step", find(e.snapshot().pages[e.snapshot().page].root, id).strokeWidth !== 7);
  e.dispatch({ type: "previewStroke", id, align: "center" });
  e.dispatch({ type: "select", ids: [] });
  t("select clears the preview", e.snapshot().previewStroke === null);
}

console.log("S-H extras render dashes offset:");
{
  const seen = {};
  const ctx = {
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    clip() {},
    rect() {},
    stroke() {},
    setLineDash(d) {
      seen.dashes = d;
    },
  };
  paintExtraStrokes(
    ctx,
    {
      kind: "rect",
      strokeMiterAngle: 0,
      strokes: [{ color: "#000000", opacity: 1, visible: true, width: 2, align: "center", dash: 10, gap: 5 }],
    },
    2,
    () => {},
  );
  t("extras dash in device pixels", JSON.stringify(seen.dashes) === "[20,10]");
  t("extras start on a half dash", ctx.lineDashOffset === 10);
}
