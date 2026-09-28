import { MemoryEngine, worldPos } from "../memory.ts";
import { sameIds, selectSame } from "../../ui/selectSame.ts";

function t(name, ok) {
  if (!ok) {
    console.error(`  fail: ${name}`);
    process.exit(1);
  }
  console.log(`  ok  ${name}`);
}

function node(kind, name, x, y, w, h, extra = {}) {
  return {
    id: extra.id || `${kind}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind,
    x,
    y,
    w,
    h,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    children: [],
    ...extra,
  };
}

console.log("=== SPRINT 2 LAYER ENGINE TESTS ===");

// -----------------------------------------------------------------------------
// FIX 1: Native Batch Patching
// -----------------------------------------------------------------------------
console.log("Fix 1: Native Batch Patching");
{
  const COUNT = 100;
  const children = [];
  const ids = [];
  for (let i = 0; i < COUNT; i++) {
    const id = `layer_${i}`;
    ids.push(id);
    children.push(node("rect", `Layer ${i}`, (i % 10) * 30, Math.floor(i / 10) * 30, 25, 25, {
      id,
      fill: "#ff0000",
      strokePaint: "#000000",
      strokeWidth: 1,
      opacity: 1.0,
    }));
  }

  const engine = new MemoryEngine(false, {
    pages: [{
      id: "p",
      name: "P",
      root: node("frame", "R", 0, 0, 2000, 2000, { children }),
      guides: [],
      comments: [],
    }],
    page: 0,
  });

  const t0 = performance.now();
  engine.dispatch({ type: "patch", ids, patch: { fill: "#00ff00", strokePaint: "#0000ff", opacity: 0.5 } });
  const t1 = performance.now();
  const batchMs = t1 - t0;

  const root = engine.snapshot().pages[0].root;
  const allUpdated = ids.every(id => {
    const n = root.children.find(c => c.id === id);
    return n && n.fill === "#00ff00" && n.strokePaint === "#0000ff" && n.opacity === 0.5;
  });

  engine.dispatch({ type: "undo" });
  const rootAfterUndo = engine.snapshot().pages[0].root;
  const allUndone = ids.every(id => {
    const n = rootAfterUndo.children.find(c => c.id === id);
    return n && n.fill === "#ff0000" && n.strokePaint === "#0000ff" === false && n.opacity === 1.0;
  });

  t(`100-layer batch patch time is under 20ms (${batchMs.toFixed(2)}ms)`, batchMs < 20);
  t("all 100 layers updated correctly", allUpdated);
  t("single-step undo restored all 100 layers", allUndone);
}

// -----------------------------------------------------------------------------
// FIX 2: Reparenting Coordinate Preservation
// -----------------------------------------------------------------------------
console.log("Fix 2: Reparenting Coordinate Preservation");
{
  // 2A: Frame A (100, 100) to Frame B (300, 300)
  const layer = node("rect", "Card", 20, 30, 50, 50, { id: "card_1" });
  const frameA = node("frame", "FrameA", 100, 100, 200, 200, { id: "frame_A", children: [layer] });
  const frameB = node("frame", "FrameB", 300, 300, 200, 200, { id: "frame_B", children: [] });
  const root = node("frame", "Root", 0, 0, 2000, 2000, { id: "root", children: [frameA, frameB] });

  const engine = new MemoryEngine(false, {
    pages: [{ id: "p", name: "P", root, guides: [], comments: [] }],
    page: 0,
  });

  const snapBefore = engine.snapshot().pages[0].root;
  const worldBefore = worldPos(snapBefore, "card_1");

  engine.dispatch({ type: "reparent", ids: ["card_1"], parent: "frame_B" });

  const snapAfter = engine.snapshot().pages[0].root;
  const cardAfter = snapAfter.children.find(c => c.id === "frame_B")?.children.find(c => c.id === "card_1");
  const worldAfter = worldPos(snapAfter, "card_1");

  t("canvas world position preserved after reparent", worldAfter.x === worldBefore.x && worldAfter.y === worldBefore.y);
  t("local coordinates correctly translated to destination frame", cardAfter.x === -180 && cardAfter.y === -170);

  // 2B: 3-level deep frame
  const item = node("rect", "DeepItem", 50, 40, 30, 30, { id: "item_deep" });
  const frameL3 = node("frame", "L3", 20, 15, 100, 100, { id: "l3", children: [] });
  const frameL2 = node("frame", "L2", 30, 25, 200, 200, { id: "l2", children: [frameL3] });
  const frameL1 = node("frame", "L1", 100, 50, 400, 400, { id: "l1", children: [frameL2] });
  const rootNested = node("frame", "Root2", 0, 0, 2000, 2000, { id: "root2", children: [item, frameL1] });

  const engineNested = new MemoryEngine(false, {
    pages: [{ id: "p", name: "P", root: rootNested, guides: [], comments: [] }],
    page: 0,
  });

  engineNested.dispatch({ type: "reparent", ids: ["item_deep"], parent: "l3" });
  const snapNested = engineNested.snapshot().pages[0].root;
  const deepWorld = worldPos(snapNested, "item_deep");
  const deepNode = snapNested.children.find(c => c.id === "l1")
    ?.children.find(c => c.id === "l2")
    ?.children.find(c => c.id === "l3")
    ?.children.find(c => c.id === "item_deep");

  t("3-level nested frame world position preserved", deepWorld.x === 50 && deepWorld.y === 40);
  t("3-level nested frame local coordinates translated", deepNode.x === -100 && deepNode.y === -50);
}

// -----------------------------------------------------------------------------
// FIX 3: Auto-Layout Aware Constraints
// -----------------------------------------------------------------------------
console.log("Fix 3: Auto-Layout Aware Constraints");
{
  const flowKids = [];
  for (let i = 0; i < 10; i++) {
    flowKids.push(node("rect", `FlowKid_${i}`, 0, 0, 40, 20, {
      id: `flow_${i}`,
      constraintH: "stretch",
      constraintV: "stretch",
    }));
  }

  const autoParent = node("frame", "AutoParent", 0, 0, 200, 400, {
    id: "auto_p",
    layout: {
      direction: "vertical",
      gap: 10,
      padding: [10, 10, 10, 10],
      align: "start",
      justify: "start",
      wrap: false,
    },
    sizingW: "fixed",
    sizingH: "fixed",
    children: flowKids,
  });

  const engine = new MemoryEngine(false, {
    pages: [{ id: "p", name: "P", root: node("frame", "R", 0, 0, 2000, 2000, { children: [autoParent] }), guides: [], comments: [] }],
    page: 0,
  });

  engine.dispatch({ type: "resize", id: "auto_p", x: 0, y: 0, w: 300, h: 500 });
  const root = engine.snapshot().pages[0].root;
  const p = root.children.find(c => c.id === "auto_p");

  const modifiedByConstraintsCount = p.children.filter(c => c.w === 140).length;
  t("0 constraint solver modifications on auto-layout flow children", modifiedByConstraintsCount === 0);

  // Mixed flow and absolute children
  const mixedKids = [
    node("rect", "Flow1", 0, 0, 40, 20, { id: "m_flow_1", constraintH: "stretch" }),
    node("rect", "AbsolutePinRight", 100, 50, 30, 30, {
      id: "abs_right",
      absolutePosition: true,
      constraintH: "max",
      constraintV: "min",
    }),
  ];
  const mixedParent = node("frame", "MixedParent", 0, 0, 200, 300, {
    id: "mixed_p",
    layout: { direction: "vertical", gap: 10, padding: [10, 10, 10, 10], align: "start", justify: "start", wrap: false },
    sizingW: "fixed",
    sizingH: "fixed",
    children: mixedKids,
  });
  const engineMixed = new MemoryEngine(false, {
    pages: [{ id: "p", name: "P", root: node("frame", "R", 0, 0, 2000, 2000, { children: [mixedParent] }), guides: [], comments: [] }],
    page: 0,
  });

  engineMixed.dispatch({ type: "resize", id: "mixed_p", x: 0, y: 0, w: 300, h: 500 });
  const rootMixed = engineMixed.snapshot().pages[0].root;
  const mp = rootMixed.children.find(c => c.id === "mixed_p");
  const f1 = mp.children.find(c => c.id === "m_flow_1");
  const absR = mp.children.find(c => c.id === "abs_right");

  t("flow child bypassed constraint solver", f1.w === 40);
  t("absolute child followed constraints (pinned right)", absR.x === 200);
}

// -----------------------------------------------------------------------------
// FIX 4: Stroke Visibility Default
// -----------------------------------------------------------------------------
console.log("Fix 4: Stroke Visibility Default");
{
  const rect1 = node("rect", "Rect1_Default", 0, 0, 100, 100, {
    id: "rect_1",
    strokePaint: "#000000",
    strokeWidth: 2,
    strokeVisible: undefined,
  });
  const rect2 = node("rect", "Rect2_ExplicitTrue", 120, 0, 100, 100, {
    id: "rect_2",
    strokePaint: "#000000",
    strokeWidth: 2,
    strokeVisible: true,
  });
  const rect3 = node("rect", "Rect3_ExplicitFalse", 240, 0, 100, 100, {
    id: "rect_3",
    strokePaint: "#000000",
    strokeWidth: 2,
    strokeVisible: false,
  });

  const root = node("frame", "Root", 0, 0, 2000, 2000, {
    children: [rect1, rect2, rect3],
  });

  const engine = new MemoryEngine(false, {
    pages: [{ id: "p", name: "P", root, guides: [], comments: [] }],
    page: 0,
  });

  engine.dispatch({ type: "select", ids: ["rect_1"] });
  selectSame(engine, engine.snapshot(), "stroke");

  const finalSelection = engine.snapshot().selection;
  t("Select Same Stroke selected exactly 2 layers", finalSelection.length === 2);
  t("includes rect1 (default strokeVisible: undefined)", finalSelection.includes("rect_1"));
  t("includes rect2 (strokeVisible: true)", finalSelection.includes("rect_2"));
  t("excludes rect3 (strokeVisible: false)", !finalSelection.includes("rect_3"));
}
