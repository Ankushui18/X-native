import type {
  AutoLayout,
  SharedStyle,
  Command,
  ComponentMaster,
  Effect,
  Engine,
  NodeKind,
  Page,
  PathPoint,
  PixelPreview,
  Snapshot,
  Tool,
  XNode,
  BooleanOp,
  VariableItem,
  VariableCollection,
  AnnotationItem,
} from "./types";
import {
  BINDABLE_PROPS,
  applyBinding,
  fallbackForType,
  migrateCollections,
  resolveAllForMode,
  resolveVariable,
} from "./variables";
import { clipPlainText, copyText, nativeClipHtml, writeClipboard } from "./clipboard";
import { dehydrateNode } from "./assets";
import { computeMasterHash } from "./codegen";
import { exportClipSvg } from "./svgExport";
import { loadDoc, type PersistedDoc } from "./persist";
import { clampZoom, panForZoom } from "./view";
import {
  autoSpacing,
  cellAlign,
  cellAt,
  cellBox,
  fillPatch,
  clampToPadding,
  hugsCross,
  hugsMain,
  isAutoGap,
  gridSpotForPoint,
  planGrid,
  widthIsMain,
  textDimensionRule,
  wraps,
  type Spacing,
} from "./layout";
import {
  booleanPath,
  outlineStrokeNetwork,
  offsetPath,
  simplifyPath,
  vectorCleanup,
  shapePoly,
  transformedPoly,
  addVectorBranch,
  pathToVectorNetwork,
  vectorNetworkToPath,
  bendSegment,
  insertPointOnPath,
  pathBounds,
  normalizeVectorNode,
  samplePathPoints,
  outlineVariableStroke,
} from "./geometry";
import { maxWidthMultiplier, usesVariableWidth } from "./strokeModel";
import { convertTextToVectorPaths } from "./textVector";
import {
  type Transaction,
  type Operation,
  TransactionStream,
  invertOperation,
} from "./transaction";
import {
  evaluateModifierStack,
} from "./modifierStack";
import {
  evaluateExpression,
  DependencyGraph,
} from "./expressions";

let seq = 1;
export const uid = (p: string) => `${p}_${seq++}`;

/** Node factory. Exported so the file store can seed new documents from the
 *  dashboard templates with exactly the same defaults the editor uses. */
export function node(
  kind: NodeKind,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<XNode> = {},
): XNode {
  return {
    id: uid(kind),
    name,
    kind,
    x,
    y,
    w,
    h,
    rotation: 0,
    rotOrigin: [0.5, 0.5],
    fill:
      kind === "frame"
        ? "#ffffff"
        : kind === "text"
          ? "#0d1220"
          : kind === "line" || kind === "arrow"
            ? "#00000000"
            : "#d9d9d9",
    fillOpacity: 1,
    fillVisible: !(kind === "line" || kind === "arrow"),
    fillType: "solid",
    fillB: "#ffffff",
    gradientStops: [],
    fillBlend: "Normal",
    strokePaint: kind === "line" || kind === "arrow" ? "#1e1e1e" : "#00000000",
    strokeOpacity: 1,
    strokeVisible: kind === "line" || kind === "arrow",
    strokeWidth: kind === "line" || kind === "arrow" ? 1 : 0,
    effects: [] as Effect[],
    strokeAlign: kind === "line" || kind === "arrow" ? "center" : "inside",
    strokeDash: 0,
    strokeGap: 0,
    strokeCap: kind === "arrow" ? "arrow" : kind === "line" ? "round" : "none",
    strokeCapStart: kind === "line" ? "round" : "none",
    strokeCapEnd: kind === "arrow" ? "arrow" : kind === "line" ? "round" : "none",
    strokeJoin: "miter",
    opacity: 1,
    visible: true,
    locked: false,
    overflow: kind === "frame" ? "clip" : "visible",
    cornerRadii: [0, 0, 0, 0],
    cornerIndependent: false,
    cornerSmoothing: 0,
    strokeSides: "all",
    strokeSideW: [0, 0, 0, 0],
    strokeDashCap: "butt",
    strokeMiterAngle: 0,
    aspectLocked: false,
    sizingW: "fixed",
    sizingH: "fixed",
    constraintH: "min",
    constraintV: "min",
    count: kind === "star" ? 5 : kind === "poly" ? 3 : 0,
    starRatio: 0.4,
    showName: kind === "frame",
    exports: [],
    blendMode: kind === "frame" || kind === "group" ? "pass-through" : "normal",
    imageSrc: "",
    imageFit: "fill",
    imageRot: 0,
    imageExposure: 0,
    imageContrast: 0,
    imageSaturation: 0,
    imageTemperature: 0,
    imageTint: 0,
    imageHighlights: 0,
    imageShadows: 0,
    text: kind === "text" ? "Text" : "",
    fontFamily: "Inter",
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 0,
    letterSpacing: 0,
    paragraphSpacing: 0,
    textAlign: "left",
    textAlignVertical: "top",
    textWrap: "auto",
    listStyle: "none",
    paragraphIndent: 0,
    textDecoration: "none",
    textCase: "none",
    truncate: false,
    maxLines: 1,
    children: [],
    layout: null,
    path: [],
    closed: false,
    booleanOp: null,
    componentId: "",
    isComponent: false,
    interactions: [],
    flipH: false,
    flipV: false,
    fillGX: 0.5,
    fillGY: 0,
    fillHX: 0.5,
    fillHY: 1,
    isMask: false,
    maskType: "alpha",
    variant: "",
    ...extra,
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function walk(n: XNode, fn: (n: XNode, parent: XNode | null) => void, parent: XNode | null = null) {
  fn(n, parent);
  for (const c of n.children) walk(c, fn, n);
}

function find(root: XNode, id: string): XNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    const h = find(c, id);
    if (h) return h;
  }
  return null;
}

function findParent(root: XNode, id: string): XNode | null {
  for (const c of root.children) {
    if (c.id === id) return root;
    const p = findParent(c, id);
    if (p) return p;
  }
  return null;
}

function findInstanceRoot(root: XNode, id: string): XNode | null {
  const curr = find(root, id);
  if (!curr) return null;
  if (curr.componentId && !curr.isComponent) return curr;
  let p = findParent(root, id);
  while (p && p !== root) {
    if (p.componentId && !p.isComponent) return p;
    p = findParent(root, p.id);
  }
  return null;
}

/**
 * True when the layer is an instance or sits inside one. An instance refuses a small
 * set of edits there - the geometry belongs to the component, so per-corner
 * radii in particular can only be set on the master.
 */
/**
 * Strip auto layout from a node and from everything nested inside it, which is
 * what "Remove all auto layout" does on the frame's context menu.
 *
 * Instances are left alone: a nested instance's own layout belongs to its main
 * component, and the article is explicit that instance auto layout is not
 * removable from here.
 */
export function stripLayout(n: XNode): void {
  if (n.kind === "instance") return;
  // The model stores "no auto layout" as null, the same value the panel sends.
  n.layout = null;
  for (const c of n.children) stripLayout(c);
}

export function insideInstance(root: XNode, id: string): boolean {
  const node = find(root, id);
  if (!node) return false;
  return node.kind === "instance" || !!findInstanceRoot(root, id);
}

function clampDims(n: XNode) {
  if (n.minW != null && Number.isFinite(n.minW) && n.w < n.minW) n.w = n.minW;
  if (n.maxW != null && Number.isFinite(n.maxW) && n.w > n.maxW) n.w = n.maxW;
  if (n.minH != null && Number.isFinite(n.minH) && n.h < n.minH) n.h = n.minH;
  if (n.maxH != null && Number.isFinite(n.maxH) && n.h > n.maxH) n.h = n.maxH;
}

/** Every size in the tree, rounded: what "settled" means for a reflow. */
function sizeSignature(n: XNode): string {
  let s = `${Math.round(n.w * 100)}:${Math.round(n.h * 100)}`;
  for (const c of n.children) s += `|${sizeSignature(c)}`;
  return s;
}

function applyLayout(n: XNode, gesture = false) {
  for (const c of n.children) applyLayout(c, gesture);
  const l = n.layout;
  if (!l) {
    if (n.children.length && (n.sizingW === "hug" || n.sizingH === "hug")) {
      const vis = n.children.filter((c) => c.visible && !c.absolutePosition);
      if (vis.length) {
        if (n.sizingW === "hug") n.w = Math.max(1, Math.max(...vis.map((c) => c.x + c.w)));
        if (n.sizingH === "hug") n.h = Math.max(1, Math.max(...vis.map((c) => c.y + c.h)));
      }
    }
    clampDims(n);
    return;
  }
  const flow = n.children.filter((c) => c.visible && !c.absolutePosition);
  /* The grid flow is its own geometry: cells, tracks and spans instead of one
     run of objects. It shares the hug/fill rules above, so it is resolved with
     the same two questions before the cells are worked out. */
  if (l.direction === "grid") {
    const hugW = hugsMain(l, n, flow);
    const hugH = hugsCross(l, n, flow);
    // With automatic positioning off the objects stay where they are put - a
    // drop into a cell keeps it, empty cells and all - so their cells are read
    // off the arrangement the tracks were resolved from.
    const first = planGrid(n, flow, l, hugW, hugH);
    const plan =
      l.autoPosition === false && !gesture
        ? planGrid(n, flow, l, hugW, hugH, flow.map((c) => cellAt(first, l, c)))
        : first;
    const [gl, gr, gt, gb] = Array.isArray(l.padding) ? l.padding : [0, 0, 0, 0];
    flow.forEach((c, i) => {
      const cell = plan.cells[i];
      if (!cell) return;
      const box = cellBox(plan, cell);
      // Where the object landed is written back, so the panel and the object's
      // own record agree - and so switching automatic positioning off keeps the
      // arrangement that is on screen.
      c.gridCol = cell.col;
      c.gridRow = cell.row;
      // A gesture in a manually positioned grid is the one time an object is
      // allowed to sit between cells: it follows the pointer, and the drop
      // (the end of the gesture) is what puts it in a cell.
      if (gesture && l.autoPosition === false) return;
      const { h: ah, v: av } = cellAlign(c);
      if (c.sizingW === "fill") {
        const patch = fillPatch(c, "w", box.w, c.sizingH === "fill");
        if (patch.w != null) c.w = patch.w;
        if (patch.h != null) c.h = patch.h;
      }
      if (c.sizingH === "fill") {
        const patch = fillPatch(c, "h", box.h, c.sizingW === "fill");
        if (patch.w != null) c.w = patch.w;
        if (patch.h != null) c.h = patch.h;
      }
      clampDims(c);
      c.x = gl + box.x + (ah === "center" ? (box.w - c.w) / 2 : ah === "max" ? box.w - c.w : 0);
      c.y = gt + box.y + (av === "center" ? (box.h - c.h) / 2 : av === "max" ? box.h - c.h : 0);
    });
    if (hugW) n.w = Math.max(1, gl + plan.totalW + gr);
    if (hugH) n.h = Math.max(1, gt + plan.totalH + gb);
    clampToPadding(n);
    clampDims(n);
    return;
  }
  const [pl, pr, pt, pb] = Array.isArray(l.padding) ? l.padding : [0, 0, 0, 0];
  const horiz = l.direction === "horizontal";
  // Wrap is offered on a horizontal flow only, so a vertical frame that still
  // carries the flag lays out as a plain stack rather than wrapping.
  const doesWrap = wraps(l);
  const gap = typeof l.gap === "number" ? l.gap : 0;
  const innerW = n.w - pl - pr;
  const innerH = n.h - pt - pb;
  const crossInner = horiz ? innerH : innerW;
  // Fill is per dimension: a child of a vertical stack can fill its *width*,
  // which is what the nesting article's post and profile do ("Set their width
  // resizing to Fill container ... Set their height resizing to Hug contents").
  // This runs before anything is placed, since a cross-filling child also
  // decides how tall a wrapped row is.
  for (const c of flow) {
    const fillsCross = (horiz ? c.sizingH : c.sizingW) === "fill";
    if (!fillsCross) continue;
    const patch = fillPatch(c, horiz ? "h" : "w", crossInner, false);
    if (patch.w != null) c.w = patch.w;
    if (patch.h != null) c.h = patch.h;
    clampDims(c);
  }
  const auto = isAutoGap(l);
  const spacing: Spacing = l.spacing ?? "between";
  // Auto gap is the space left over, so it is zero whenever something is
  // claiming that space: a frame that hugs its contents, or a child filling
  // along the axis - which is also what the hug turns into, one rule above.
  const fillers = flow.filter((c) => (horiz ? c.sizingW : c.sizingH) === "fill");
  const packedGap = auto && fillers.length ? 0 : gap;
  if (fillers.length) {
    const used = flow.reduce(
      (s, c) => s + ((horiz ? c.sizingW : c.sizingH) === "fill" ? 0 : horiz ? c.w : c.h),
      0,
    );
    const leftover = Math.max(1, (horiz ? innerW : innerH) - used - packedGap * Math.max(0, flow.length - 1));
    const each = leftover / fillers.length;
    for (const c of fillers) {
      const otherFills = (horiz ? c.sizingH : c.sizingW) === "fill";
      const patch = fillPatch(c, horiz ? "w" : "h", each, otherFills);
      if (patch.w != null) c.w = patch.w;
      if (patch.h != null) c.h = patch.h;
      clampDims(c);
    }
  }
  // A hug with something filling inside it is a Fixed frame - the filler has
  // nothing to hug down to. `effectiveSizing` is the single answer to that, and
  // the panel shows the same one.
  const hugMain = hugsMain(l, n, flow);
  const hugCross = hugsCross(l, n, flow);
  if (doesWrap && flow.length) {
    let x = pl;
    let y = pt;
    let rowH = 0;
    let rowW = 0;
    const limit = horiz ? n.w - pr : n.h - pb;
    for (const c of flow) {
      const main = horiz ? c.w : c.h;
      const cur = horiz ? x : y;
      if (cur > (horiz ? pl : pt) && cur + main > limit) {
        if (horiz) {
          x = pl;
          y += rowH + gap;
        } else {
          y = pt;
          x += rowW + gap;
        }
        rowH = 0;
        rowW = 0;
      }
      c.x = x;
      c.y = y;
      if (horiz) {
        x += c.w + gap;
        rowH = Math.max(rowH, c.h);
      } else {
        y += c.h + gap;
        rowW = Math.max(rowW, c.w);
      }
    }
    if (hugMain) {
      if (horiz) n.w = Math.max(n.w, x + pr);
      else n.h = Math.max(n.h, y + pb);
    }
    if (hugCross) {
      if (horiz) n.h = y + rowH + pb;
      else n.w = x + rowW + pr;
    }
    for (const c of flow) clampDims(c);
    clampToPadding(n);
    clampDims(n);
    return;
  }
  const mainTotal = flow.reduce((s, c) => s + (horiz ? c.w : c.h), 0) + gap * Math.max(0, flow.length - 1);
  const inner = horiz ? innerW : innerH;
  const contentMain = flow.reduce((s, c) => s + (horiz ? c.w : c.h), 0);
  // Auto gap distributes whatever is left after the objects have taken their
  // share; a fixed gap and the older `justify` packing do what they always did.
  const slack = hugMain || fillers.length ? 0 : Math.max(0, inner - contentMain);
  const pack = auto ? autoSpacing(slack, flow.length, spacing) : { lead: 0, gap: packedGap };
  let origin = horiz ? pl : pt;
  if (!auto) {
    if (l.justify === "center") origin += Math.max(0, inner - mainTotal) / 2;
    if (l.justify === "max") origin += Math.max(0, inner - mainTotal);
    if (l.justify === "between" && flow.length > 1) {
      pack.gap = Math.max(0, inner - flow.reduce((s, c) => s + (horiz ? c.w : c.h), 0)) / (flow.length - 1);
    }
  }
  let cursor = origin + pack.lead;
  let crossMax = 0;
  const maxBaseline =
    horiz && l.align === "baseline"
      ? Math.max(
          ...flow.map((c) => (c.kind === "text" ? (c.fontSize || 14) * 0.8 : c.h * 0.8)),
        )
      : 0;
  for (let i = 0; i < flow.length; i++) {
    const c = flow[i];
    if (horiz) {
      c.x = cursor;
      const extra = crossInner - c.h;
      if (l.align === "baseline") {
        const itemBaseline = c.kind === "text" ? (c.fontSize || 14) * 0.8 : c.h * 0.8;
        c.y = pt + (maxBaseline - itemBaseline);
      } else {
        c.y = pt + (l.align === "center" ? extra / 2 : l.align === "max" ? extra : 0);
      }
      cursor += c.w + (i < flow.length - 1 ? pack.gap : 0);
      crossMax = Math.max(crossMax, c.h);
    } else {
      c.y = cursor;
      const extra = crossInner - c.w;
      c.x = pl + (l.align === "center" ? extra / 2 : l.align === "max" ? extra : 0);
      cursor += c.h + (i < flow.length - 1 ? pack.gap : 0);
      crossMax = Math.max(crossMax, c.w);
    }
    clampDims(c);
  }
  // The hug follows the packing that was actually used, lead and all, so a hug
  // never disagrees with where the objects were put.
  const packedMain = auto
    ? contentMain + pack.lead * 2 + pack.gap * Math.max(0, flow.length - 1)
    : contentMain + packedGap * Math.max(0, flow.length - 1);
  if (horiz) {
    if (hugMain) n.w = Math.max(1, pl + packedMain + pr);
    if (hugCross) n.h = Math.max(1, crossMax + pt + pb);
  } else {
    if (hugMain) n.h = Math.max(1, pt + packedMain + pb);
    if (hugCross) n.w = Math.max(1, crossMax + pl + pr);
  }
  // A frame is never narrower than its own padding.
  clampToPadding(n);
  clampDims(n);
}

export function demoPage(): Page {
  const title = node("text", "Title", 24, 28, 300, 32, {
    text: "Explore Store",
    fontSize: 24,
    fontWeight: 700,
    fill: "#0d1220",
  });
  const notifSwitch = node("rect", "Notifications Switch", 316, 32, 48, 26, {
    fill: "#10b981",
    cornerRadii: [13, 13, 13, 13],
  });
  const searchInput = node("text", "Search Input", 24, 76, 342, 40, {
    text: "Search designs, icons, UI kits…",
    fontSize: 13,
    fill: "#64748b",
  });
  const body = node("text", "Body", 24, 126, 342, 36, {
    text: "Interactive prototypes with live form typing and S-curve noodles.",
    fontSize: 13,
    fill: "#5a5f6b",
  });
  const pill = node("rect", "View Details Button", 0, 0, 136, 32, {
    fill: "#0d99ff",
    cornerRadii: [16, 16, 16, 16],
  });
  const pillLabel = node("text", "Label", 17, 8, 102, 16, {
    text: "View Details →",
    fontSize: 12,
    fontWeight: 600,
    fill: "#ffffff",
  });
  pill.children = [pillLabel];

  const card = node("frame", "Card", 24, 192, 342, 170, {
    fill: "#f8fafc",
    cornerRadii: [16, 16, 16, 16],
    overflow: "clip",
    layout: {
      direction: "vertical",
      gap: 10,
      padding: [16, 16, 16, 16],
      sizing: "fixed",
      cross: "fixed",
      wrap: false,
      align: "min",
      justify: "min",
    },
  });
  const cardTitle = node("text", "Heading", 0, 0, 300, 22, {
    text: "Smart Animate Card",
    fontSize: 16,
    fontWeight: 600,
    fill: "#0d1220",
  });
  const cardBody = node("text", "Note", 0, 0, 300, 36, {
    text: "Click below to navigate with smooth Smart Animate transition.",
    fontSize: 12,
    fill: "#64748b",
  });
  card.children = [cardTitle, cardBody, pill];

  const filterBtn = node("rect", "Filter Options Button", 24, 380, 342, 44, {
    fill: "#f1f5f9",
    cornerRadii: [12, 12, 12, 12],
    strokePaint: "#cbd5e1",
    strokeWidth: 1,
    strokeVisible: true,
  });
  const filterLabel = node("text", "Filter Label", 110, 13, 140, 20, {
    text: "⚙ Open Filter Sheet",
    fontSize: 14,
    fontWeight: 600,
    fill: "#1e293b",
  });
  filterBtn.children = [filterLabel];

  const phone = node("frame", "iPhone 16 Pro", 80, 60, 390, 844, {
    fill: "#ffffff",
    cornerRadii: [48, 48, 48, 48],
    overflow: "clip",
    children: [title, notifSwitch, searchInput, body, card, filterBtn],
  });

  const back = node("text", "Back", 24, 28, 120, 24, {
    text: "← Back",
    fontSize: 16,
    fontWeight: 600,
    fill: "#0d99ff",
    interactions: [{ trigger: "onClick", action: "back", destination: "", animation: "dissolve", delay: 0 }],
  });
  const done = node("text", "Done", 24, 80, 320, 40, {
    text: "Success Screen 🎉",
    fontSize: 22,
    fontWeight: 700,
    fill: "#0d1220",
  });
  const doneDesc = node("text", "DoneDesc", 24, 125, 342, 60, {
    text: "Navigated via organic S-curve interaction connector. Click ← Back or press Esc to return.",
    fontSize: 14,
    fill: "#64748b",
  });
  const screen2 = node("frame", "Success", 540, 60, 390, 844, {
    fill: "#ffffff",
    cornerRadii: [48, 48, 48, 48],
    overflow: "clip",
    children: [back, done, doneDesc],
  });

  pill.interactions = [
    { trigger: "onClick", action: "navigate", destination: screen2.id, animation: "smart", delay: 0 },
  ];

  // Bottom sheet modal overlay
  const sheetHandle = node("rect", "Sheet Handle", 165, 12, 60, 5, {
    fill: "#cbd5e1",
    cornerRadii: [3, 3, 3, 3],
  });
  const sheetTitle = node("text", "Sheet Title", 24, 36, 260, 28, {
    text: "Filter Options (Overlay)",
    fontSize: 18,
    fontWeight: 700,
    fill: "#0f172a",
  });
  const sheetBody = node("text", "Sheet Body", 24, 70, 342, 40, {
    text: "Interactive bottom sheet with dimmed backdrop. Tap outside to dismiss.",
    fontSize: 13,
    fill: "#64748b",
  });
  const closeSheet = node("rect", "Close Sheet Button", 24, 240, 342, 44, {
    fill: "#0d99ff",
    cornerRadii: [12, 12, 12, 12],
    interactions: [{ trigger: "onClick", action: "closeOverlay", destination: "", animation: "dissolve", delay: 0 }],
  });
  const closeLabel = node("text", "Close Label", 125, 13, 120, 20, {
    text: "Apply & Close",
    fontSize: 14,
    fontWeight: 600,
    fill: "#ffffff",
  });
  closeSheet.children = [closeLabel];

  const filterSheet = node("frame", "Filter Sheet", 80, 960, 390, 320, {
    fill: "#ffffff",
    cornerRadii: [24, 24, 0, 0],
    overflow: "clip",
    children: [sheetHandle, sheetTitle, sheetBody, closeSheet],
  });

  filterBtn.interactions = [
    {
      trigger: "onClick",
      action: "openOverlay",
      destination: filterSheet.id,
      animation: "slideInBottom",
      delay: 0,
      overlayPosition: "bottom",
      overlayCloseOutside: true,
      overlayBackdrop: true,
    },
  ];

  const pageRoot = node("frame", "Page 1", 0, 0, 1400, 1400, {
    fill: "#00000000",
    overflow: "visible",
    children: [phone, screen2, filterSheet],
  });
  applyLayout(phone);
  applyLayout(card);
  return {
    id: uid("page"),
    name: "Page 1",
    root: pageRoot,
    comments: [],
    guides: [],
    pixelGrid: false,
    pixelGridColor: "#cccccc",
    pixelSnap: true,
    flowStart: phone.id,
  };
}

/** An empty page, the default new page layout: one invisible root frame
 *  that holds the top-level layers and no content of its own. */
export function blankPage(name = "Page 1"): Page {
  return {
    id: uid("page"),
    name,
    root: node("frame", name, 0, 0, 4000, 4000, {
      fill: "#00000000",
      overflow: "visible",
      showName: false,
    }),
    comments: [],
    guides: [],
    pixelGrid: false,
    pixelGridColor: "#cccccc",
    pixelSnap: true,
    flowStart: "",
  };
}

interface Internal {
  fileName: string;
  pages: Page[];
  page: number;
  selection: string[];
  /** See Snapshot.treeRev. */
  treeRev: number;
  tool: Tool;
  zoom: number;
  panX: number;
  panY: number;
  rightTab: Snapshot["rightTab"];
  leftTab: Snapshot["leftTab"];
  components: ComponentMaster[];
  styles: SharedStyle[];
  presentFrame: string;
  presentStack: string[];
  prototypeDevice: Snapshot["prototypeDevice"];
  prototypeOrientation: Snapshot["prototypeOrientation"];
  prototypeScale: Snapshot["prototypeScale"];
  prototypeHotspots: boolean;
  prototypeLiveInputs: boolean;
  prototypeSound: boolean;
  activeOverlay: Snapshot["activeOverlay"];
  showFlows: boolean;
  showRulers: boolean;
  showMinimap: boolean;
  showComments: boolean;
  outlineMode: boolean;
  pixelPreview: PixelPreview;
  viewLayoutGuides: boolean;
  propertyLabels: boolean;
  openComment: string;
  variables: VariableItem[];
  variableCollections: VariableCollection[];
  activeModes: Record<string, string>;
  annotations: AnnotationItem[];
  vecEdit: string | null;
  vecPoint: number | null;
  vecPoints: number[];
  booleanPreview: BooleanOp | null;
  /** Selected ruler guide; mutually exclusive with the layer selection. */
  selectedGuide: string | null;
}

/** Cap the undo stack. Each entry is a full document clone, so an unbounded
 *  stack grows memory without limit during a long editing session. */
const MAX_UNDO = 200;

/** Commands whose rapid repeats collapse into a single undo step. Only
 *  incremental, self-repeating gestures belong here — structural edits must
 *  always get their own entry. */
const COALESCABLE = new Set<string>(["nudge", "move", "resize", "patch", "autoLayout", "moveGuide"]);

/** Identity used to decide whether two consecutive history commands belong to
 *  the same burst. For `patch` this includes the target ids and the property
 *  names being written, so typing "45" into the rotation field coalesces into
 *  one undo step while a patch of a *different* property still starts a new
 *  one. Without this, each keystroke in a numeric field cost its own undo. */
function coalesceKey(cmd: Command, lastType: string | null = null): string {
  if (cmd.type === "patch") {
    const c = cmd as Extract<Command, { type: "patch" }>;
    const ids = "id" in c && c.id ? String(c.id) : "";
    return `patch:${ids}:${Object.keys(c.patch ?? {}).sort().join(",")}`;
  }
  if (cmd.type === "moveGuide") {
    // The drag that places a newborn guide joins the addGuide's undo step.
    if (lastType === "addGuide") return "addGuide";
    return `moveGuide:${(cmd as Extract<Command, { type: "moveGuide" }>).id}`;
  }
  if (cmd.type === "autoLayout") {
    // Typing into a gap/padding field rewrites the whole layout object, so key
    // on which layout properties actually differ is not available here; key on
    // the target instead. Consecutive edits to one frame's layout inside the
    // coalesce window are one undo step, which matches the field-typing case.
    const c = cmd as Extract<Command, { type: "autoLayout" }>;
    return `autoLayout:${String(c.id)}`;
  }
  return cmd.type;
}

/** Fill in anything a persisted node is missing, using the same defaults as a
 *  freshly created node, and recurse through children. Unknown extra keys are
 *  preserved. Throws if the value is not object-shaped, which the caller treats
 *  as a corrupt document. Exported because a node arriving from the system
 *  clipboard was serialised by some other session of this app — possibly an
 *  older one — and needs the same repair a stored document gets. */
export function reviveNode(raw: unknown): XNode {
  if (typeof raw !== "object" || raw === null) throw new Error("not a node");
  const r = raw as Partial<XNode> & Record<string, unknown>;
  const kind = (typeof r.kind === "string" ? r.kind : "frame") as NodeKind;
  const nm = typeof r.name === "string" ? r.name : "Layer";
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const defaults = node(kind, nm, n(r.x, 0), n(r.y, 0), n(r.w, 100), n(r.h, 100));
  const kids = Array.isArray(r.children) ? r.children.map(reviveNode) : [];
  return { ...defaults, ...r, kind, name: nm, id: typeof r.id === "string" && r.id ? r.id : defaults.id, children: kids };
}

/** The box a set of clipboard roots occupies, plus its centre. `paste` aims the
 *  centre at the point it is given, so a multi-layer copy arrives with the
 *  arrangement it was copied in. */
function clipBounds(nodes: XNode[]): { minX: number; minY: number; cx: number; cy: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + Math.max(1, n.w));
    maxY = Math.max(maxY, n.y + Math.max(1, n.h));
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, cx: 0, cy: 0 };
  return { minX, minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * Hand a copy to the OS clipboard as well as to the in-app one.
 *
 * The in-app clipboard is what makes ⌘V instant and lossless inside this
 * document. The system clipboard is what makes the same ⌘V work in another tab,
 * another file, or another program — and it carries two readings of the same
 * layers: this app's base64 payload (everything, including the properties no
 * vector format expresses) and an SVG (what standard renderers render).
 * Images go as asset refs, not inline data URLs, so copying a photograph does
 * not write megabytes of base64 into the clipboard.
 *
 * A clipboard that refuses — denied permission, an insecure context, a
 * headless test run — leaves the in-app copy untouched, so paste still works
 * here; nothing throws and no rejection escapes.
 */
function publishClip(nodes: XNode[], fileName: string): void {
  if (!nodes.length || typeof document === "undefined") return;
  const portable = nodes.map((n) => {
    try {
      return dehydrateNode(n);
    } catch {
      return n;
    }
  });
  let svg = "";
  try {
    svg = exportClipSvg(nodes);
  } catch {
    /* The vector flavour is a convenience for other apps; our own payload still
     * carries the layers in full. */
  }
  writeClipboard({ html: nativeClipHtml(portable, svg, fileName), text: clipPlainText(nodes) });
}


export class MemoryEngine implements Engine {
  private state: Internal;
  private undo: Internal[] = [];
  private redo: Internal[] = [];
  private listeners = new Set<() => void>();
  private snapCache: Snapshot;
  private grouping = false;
  /** True between `begin` and `end`: a pointer gesture is in flight, and a
   *  manually positioned grid lets its objects follow the pointer until the
   *  gesture ends and they settle into a cell. */
  private gesture = false;
  /** Last history-pushing command type and its timestamp, used to coalesce
   *  rapid repeats of the same command (e.g. holding an arrow key) into a
   *  single undo step. */
  private lastHist: { type: string; at: number } | null = null;
  private clip: XNode[] = [];
  private copiedProps: Partial<XNode> | null = null;
  private lastDupDelta: { dx: number; dy: number } | null = null;
  private lastFrameSize: { w: number; h: number } | null = null;
  private justDuplicated = false;

  /** Set when a stored document existed but could not be read, so the UI can
   *  tell the user their work was replaced rather than silently starting over. */
  readonly restoreFailed: boolean;

  constructor(restore = true, seed: Omit<PersistedDoc, "version"> | null = null) {
    const loaded = seed
      ? { doc: { version: 1, ...seed } as PersistedDoc, corrupt: false }
      : restore
        ? loadDoc()
        : { doc: null, corrupt: false };
    let doc = loaded.doc;
    let corrupt = loaded.corrupt;
    // A stored node that is missing fields the UI reads (fill, cornerRadii,
    // effects, …) used to render a white screen: persist.ts can only check the
    // document's shape, not every node property. Backfill against the same
    // factory that creates nodes normally, so a partial or older node is
    // repaired rather than crashing the app.
    if (doc) {
      try {
        doc = { ...doc, pages: doc.pages.map((pg) => ({ ...pg, root: reviveNode(pg.root) })) };
      } catch {
        doc = null;
        corrupt = true;
      }
    }
    this.restoreFailed = corrupt;
    // Variables predate persistence: documents written before them carry
    // neither variables nor collections, so seed both and derive collections
    // from whatever variables exist.
    const seedVariables: VariableItem[] = doc?.variables ?? [
      { id: "var-1", name: "primary", type: "color", value: "#0d99ff", collection: "Brand" },
      { id: "var-2", name: "secondary", type: "color", value: "#6366f1", collection: "Brand" },
      { id: "var-3", name: "spacing-sm", type: "number", value: 8, collection: "Spacing" },
      { id: "var-4", name: "spacing-md", type: "number", value: 16, collection: "Spacing" },
      { id: "var-5", name: "radius-md", type: "number", value: 8, collection: "Radius" },
    ];
    this.state = {
      fileName: doc?.fileName ?? "Untitled",
      pages: doc?.pages ?? [demoPage()],
      page: doc?.page ?? 0,
      selection: [],
      treeRev: 0,
      tool: "select",
      zoom: doc?.zoom ?? 0.75,
      panX: doc?.panX ?? 40,
      panY: doc?.panY ?? 20,
      rightTab: "design",
      leftTab: "layers",
      components: doc?.components ?? [],
      styles: doc?.styles ?? [],
      presentFrame: "",
      presentStack: [],
      prototypeDevice: "none",
      prototypeOrientation: "portrait",
      prototypeScale: "fit",
      prototypeHotspots: true,
      prototypeLiveInputs: true,
      prototypeSound: true,
      activeOverlay: null,
      showFlows: true,
      showRulers: doc?.showRulers ?? false,
      showMinimap: doc?.showMinimap ?? false,
      showComments: doc?.showComments ?? false,
      outlineMode: false,
      pixelPreview: "off",
      viewLayoutGuides: true,
      propertyLabels: false,
      openComment: "",
      variables: seedVariables,
      variableCollections: doc?.variableCollections ?? migrateCollections(seedVariables),
      activeModes: doc?.activeModes ?? {},
      // Handoff notes belong to the file, not to the session (see F1).
      annotations: doc?.annotations ?? [],
      vecEdit: null,
      vecPoint: null,
      vecPoints: [],
      booleanPreview: null,
      selectedGuide: null,
    };
    this.relayout();
    this.snapCache = this.build();
  }

  /** The persistable slice of state. Kept here so the storage format never has
   *  to reach into private fields from outside. */
  toDoc(): Omit<PersistedDoc, "version"> {
    return {
      fileName: this.state.fileName,
      pages: this.state.pages,
      components: this.state.components,
      styles: this.state.styles,
      page: this.state.page,
      zoom: this.state.zoom,
      panX: this.state.panX,
      panY: this.state.panY,
      showFlows: this.state.showFlows,
      showRulers: this.state.showRulers,
      showMinimap: this.state.showMinimap,
      showComments: this.state.showComments,
      annotations: this.state.annotations,
      variables: this.state.variables,
      variableCollections: this.state.variableCollections,
      activeModes: this.state.activeModes,
    };
  }

  snapshot(): Snapshot {
    return this.snapCache;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private transactionStream = new TransactionStream();

  public getTransactionStream(): TransactionStream {
    return this.transactionStream;
  }

  public dispatchTransaction(tx: Transaction): void {
    const executedOps: Operation[] = [];
    try {
      for (const op of tx.operations) {
        this.executeOperation(op);
        executedOps.push(op);
      }
      this.transactionStream.push(tx);
    } catch (err) {
      for (let i = executedOps.length - 1; i >= 0; i--) {
        try {
          this.executeOperation(invertOperation(executedOps[i]));
        } catch (rollbackErr) {
          console.error("Critical rollback error:", rollbackErr);
        }
      }
      throw err;
    }
    this.state.treeRev++;
    this.relayout();
    this.snapCache = this.build();
    this.listeners.forEach((f) => f());
  }

  private executeOperation(op: Operation): void {
    const s = this.state;
    switch (op.type) {
      case "setProperty": {
        const n = find(this.root(), op.targetId);
        if (!n) throw new Error(`Target node ${op.targetId} not found`);
        (n as any)[op.property] = op.newValue;
        this.publishMaster(n);
        break;
      }
      case "insertNode": {
        const parent = find(this.root(), op.parentId);
        if (!parent) throw new Error(`Parent node ${op.parentId} not found`);
        const idx = op.index !== undefined ? Math.min(op.index, parent.children.length) : parent.children.length;
        parent.children.splice(idx, 0, clone(op.node));
        break;
      }
      case "removeNode": {
        const parent = find(this.root(), op.parentId);
        if (!parent) throw new Error(`Parent node ${op.parentId} not found`);
        const idx = parent.children.findIndex((c) => c.id === op.nodeId);
        if (idx >= 0) parent.children.splice(idx, 1);
        break;
      }
      case "moveNode": {
        const oldParent = find(this.root(), op.oldParentId);
        const newParent = find(this.root(), op.newParentId);
        if (!oldParent || !newParent) throw new Error("Parent node not found for moveNode");
        const idx = oldParent.children.findIndex((c) => c.id === op.nodeId);
        if (idx < 0) throw new Error(`Node ${op.nodeId} not found in oldParent`);
        const [target] = oldParent.children.splice(idx, 1);
        const newIdx = Math.min(op.newIndex, newParent.children.length);
        newParent.children.splice(newIdx, 0, target);
        break;
      }
      case "setVariable": {
        const idx = s.variables.findIndex((v) => v.id === op.variableId);
        if (idx >= 0) {
          // A prototype write replaces the default slot; per-mode
          // overrides keep working on top of it.
          s.variables[idx].value = op.newValue;
        } else {
          s.variables.push({
            id: op.variableId,
            name: op.variableId,
            collection: "Brand",
            type: typeof op.newValue === "number" ? "number" : typeof op.newValue === "boolean" ? "boolean" : "string",
            value: op.newValue,
          });
          this.ensureCollection("Brand");
        }
        break;
      }
      case "setVectorNetwork": {
        const n = find(this.root(), op.targetId);
        if (!n) throw new Error(`Target node ${op.targetId} not found`);
        n.vectorNetwork = clone(op.newNetwork);
        const converted = vectorNetworkToPath(n.vectorNetwork);
        n.path = converted.path;
        n.closed = converted.closed;
        break;
      }
      case "applyModifier": {
        const n = find(this.root(), op.targetId);
        if (!n) throw new Error(`Target node ${op.targetId} not found`);
        if (!n.modifiers) n.modifiers = [];
        const idx = op.index !== undefined ? op.index : n.modifiers.length;
        n.modifiers.splice(idx, 0, clone(op.modifier));
        this.evaluateNodeModifiers(n);
        break;
      }
      case "removeModifier": {
        const n = find(this.root(), op.targetId);
        if (!n) throw new Error(`Target node ${op.targetId} not found`);
        if (n.modifiers && op.index < n.modifiers.length) {
          n.modifiers.splice(op.index, 1);
          this.evaluateNodeModifiers(n);
        }
        break;
      }
      case "setExpression": {
        const n = find(this.root(), op.targetId);
        if (!n) throw new Error(`Target node ${op.targetId} not found`);
        if (!n.expressions) n.expressions = {};
        n.expressions[op.property] = op.newExpr;
        break;
      }
    }
  }

  private evaluateNodeModifiers(n: XNode) {
    if (!n.modifiers || n.modifiers.length === 0) return;
    const baseInput = {
      path: n.path && n.path.length > 0 ? n.path : shapePoly(n),
      closed: n.closed !== false,
      vectorNetwork: n.vectorNetwork,
    };
    const evaluated = evaluateModifierStack(baseInput, n.modifiers);
    n.path = evaluated.path;
    n.closed = evaluated.closed;
    if (evaluated.vectorNetwork) n.vectorNetwork = evaluated.vectorNetwork;
    if (evaluated.bounds.w > 0 && evaluated.bounds.h > 0) {
      n.w = Math.round(evaluated.bounds.w);
      n.h = Math.round(evaluated.bounds.h);
    }
  }

  private evaluateExpressionsInTree(root: XNode) {
    // Expressions see literals resolved under the active modes, never raw
    // alias objects.
    const varMap: Record<string, any> = resolveAllForMode(
      this.state.variables,
      this.state.variableCollections,
      this.state.activeModes,
    );
    const graph = new DependencyGraph();

    const evaluateNode = (node: XNode, parent: XNode | null) => {
      // Variable bindings apply first; an explicit expression on the same
      // prop wins, since it is the more specific instruction.
      if (node.variableBindings) {
        for (const [prop, varId] of Object.entries(node.variableBindings)) {
          if (node.expressions?.[prop]) continue;
          const r = resolveVariable(
            this.state.variables,
            this.state.variableCollections,
            this.state.activeModes,
            varId,
          );
          if (r && !r.broken) applyBinding(node, prop, r.value);
        }
      }
      if (node.expressions) {
        for (const [prop, expr] of Object.entries(node.expressions)) {
          if (!expr) continue;
          const targetKey = `${node.id}.${prop}`;
          const res = evaluateExpression(
            expr,
            {
              vars: varMap,
              self: node as any,
              parent: parent as any,
              getNode: (id: string) => find(this.root(), id),
            },
            graph,
            targetKey,
          );
          if (res.error) {
            console.warn(`Expression error on ${targetKey}: ${res.error}`);
          } else if (typeof res.value === "number" && !isNaN(res.value)) {
            (node as any)[prop] = res.value;
          } else if (typeof res.value === "string" || typeof res.value === "boolean") {
            (node as any)[prop] = res.value;
          }
        }
      }
      for (const ch of node.children) {
        evaluateNode(ch, node);
      }
    };

    evaluateNode(root, null);
  }

  dispatch(cmd: Command): void {
    if (cmd.type === "begin") {
      this.undo.push(clone(this.state));
      this.redo = [];
      this.grouping = true;
      this.gesture = true;
      return;
    }
    if (cmd.type === "end") {
      this.grouping = false;
      // The end of a gesture is a drop: a grid in manual positioning reads the
      // cell the object was let go nearest to, so it settles here rather than
      // mid-drag.
      this.gesture = false;
      this.relayout();
      const previous = this.undo[this.undo.length - 1];
      if (previous && JSON.stringify(previous) === JSON.stringify(this.state)) {
        this.undo.pop();
        this.snapCache = this.build();
        this.listeners.forEach((f) => f());
      }
      return;
    }
    // Pure selection/view commands must never enter history: a user pressing
    // undo expects the last *document* change to revert, not to spend a step
    // undoing a select-all or a ruler toggle.
    const hist = ![
      "select",
      "selectAll",
      "toggleRulers",
      "setPixelPreview",
      "toggleLayoutGuides",
      "togglePropertyLabels",
      "toggleFlows",
      "toggleMinimap",
      // Comments are annotations layered over the design, not part of it.
      // Keep them off the design undo stack entirely: ⌘Z after posting
      // a comment reverts your last *design* edit, it does not delete the note.
      "toggleComments",
      "openComment",
      "addComment",
      "replyComment",
      "resolveComment",
      "deleteComment",
      "moveComment",
      "setTool",
      "setZoom",
      "pan",
      "setPan",
      "setRightTab",
      "setLeftTab",
      "setPage",
      "setFileName",
      "undo",
      "redo",
      "copy",
      "copyCode",
      "copyProperties",
      // Loading the clipboard is not a document edit; the paste that follows is.
      "loadClip",
      "presentGo",
      "presentBack",
      "presentStart",
      "presentStop",
      "setVecEdit",
      "setBooleanPreview",
      // Creation's second half (canvas- vs frame-level); the addGuide owns it.
      "setGuideFrame",
      // Guide selection, like layer selection, is not a document edit.
      "selectGuide",
    ].includes(cmd.type);
    if (hist && !this.grouping) {
      // Coalesce a burst of identical commands (arrow-key nudges, repeated
      // resize steps) into one undo entry so a single undo reverses the whole
      // gesture instead of one keypress at a time.
      const now = Date.now();
      const COALESCE_MS = 600;
      const key = coalesceKey(cmd, this.lastHist?.type ?? null);
      const repeat =
        COALESCABLE.has(cmd.type) &&
        this.lastHist !== null &&
        this.lastHist.type === key &&
        now - this.lastHist.at < COALESCE_MS;
      if (!repeat) {
        this.undo.push(clone(this.state));
        if (this.undo.length > MAX_UNDO) this.undo.shift();
      }
      this.redo = [];
      this.lastHist = { type: key, at: now };
    } else if (!hist && cmd.type !== "undo" && cmd.type !== "redo") {
      // A non-history command (select, zoom, ...) ends the current burst.
      this.lastHist = null;
    }
    this.apply(cmd);
    // Tree edits mutate nodes in place, so document panels cannot use reference
    // equality to detect them; the revision does that job instead. Pure
    // viewport moves leave it alone, letting those panels skip the frame.
    // Conservative by design: anything not provably viewport-only bumps.
    if (cmd.type !== "pan" && cmd.type !== "setPan" && cmd.type !== "setZoom") this.state.treeRev++;
    this.relayout();
    this.snapCache = this.build();
    this.listeners.forEach((f) => f());
  }

  private root(): XNode {
    return this.state.pages[this.state.page].root;
  }

  /**
   * The index a new object takes in `parent`'s children, so that a grid places
   * it in the cell it was aimed at rather than at the end of the flow.
   *
   * "When you add a cell object to the grid, it will place it
   * between the cell objects - in layer order - nearest your cursor." Anything
   * else - a frame with no layout, a linear flow, automatic positioning off -
   * appends, which is where it always went.
   */
  /**
   * The cell a point aims at in a grid parent, or null when it is not one.
   *
   * `x` and `y` are in the parent's own coordinates: `add` and `reparent` both
   * carry the point already mapped into the destination, which is where the new
   * object's own x/y are written from.
   */
  private gridSpotFor(parent: XNode, x: number, y: number): { index: number; col: number; row: number } | null {
    const l = parent.layout;
    if (!l || l.direction !== "grid" || l.autoPosition === false) return null;
    const flow = parent.children.filter((c) => c.visible && !c.absolutePosition);
    return gridSpotForPoint(parent, flow, l, hugsMain(l, parent, flow), hugsCross(l, parent, flow), x, y);
  }

  /**
   * Put an auto layout frame around what was selected.
   *
   * "Auto layout is only supported on frames. If you have one or
   * more layers selected, an auto layout frame wraps them."
   * A group is not wrapped but converted - it is already a container, and
   * pressing ⇧A on one has always turned it into a frame.
   *
   * The new frame is placed so the objects do not move: its origin is the
   * selection's bounding box minus the padding the layout puts around them, so
   * the first layout pass lands every object back where it was.
   */
  private wrapAutoLayout(ids: string[], layout: AutoLayout): void {
    const root = this.root();
    const nodes = ids
      .map((id) => find(root, id))
      .filter((n): n is XNode => !!n && !n.locked);
    if (!nodes.length) return;
    if (nodes.length === 1 && nodes[0].kind === "group") {
      nodes[0].kind = "frame";
      nodes[0].name = nodes[0].name === "Group" ? "Frame" : nodes[0].name;
      nodes[0].layout = layout;
      this.publishMaster(nodes[0]);
      return;
    }
    // Only siblings can be wrapped: the frame is created in their parent, and
    // the frame itself is the standard wrap.
    this.state.selection = nodes.map((n) => n.id);
    this.wrapSel("Frame", {
      kind: "frame",
      fill: "#00000000",
      fillVisible: false,
      overflow: "visible",
      layout,
    });
    const frame = find(this.root(), this.state.selection[0]);
    if (!frame || frame.kind !== "frame" || !frame.layout) return;
    // The frame takes the selection's bounding box plus the padding the layout
    // wants around it, so the objects do not move when it appears.
    const [pl, pr, pt, pb] = Array.isArray(layout.padding) ? layout.padding : [0, 0, 0, 0];
    if (pl || pr || pt || pb) {
      frame.x -= pl;
      frame.y -= pt;
      frame.w += pl + pr;
      frame.h += pt + pb;
      for (const c of frame.children) {
        c.x += pl;
        c.y += pt;
      }
    }
    this.publishMaster(frame);
  }

  private relayout() {
    this.evaluateExpressionsInTree(this.root());
    // Fill cascades through nesting: a parent's pass resizes a nested auto
    // layout frame, and that frame's own layout then has to run again at its new
    // size - which is the whole point of the nesting article ("when you resize
    // the frame ... the contents should resize and reflow accordingly"). Repeat
    // until every size in the tree has stopped changing, capped so a document
    // with a mutual dependency cannot spin.
    let last = "";
    for (let i = 0; i < 4; i++) {
      applyLayout(this.root(), this.gesture);
      const sig = sizeSignature(this.root());
      if (sig === last) break;
      last = sig;
    }
  }

  private build(): Snapshot {
    return {
      fileName: this.state.fileName,
      pages: this.state.pages,
      page: this.state.page,
      selection: this.state.selection,
      selectedGuide: this.state.selectedGuide,
      treeRev: this.state.treeRev,
      tool: this.state.tool,
      zoom: this.state.zoom,
      panX: this.state.panX,
      panY: this.state.panY,
      rightTab: this.state.rightTab,
      leftTab: this.state.leftTab,
      canUndo: this.undo.length > 0,
      canRedo: this.redo.length > 0,
      components: this.state.components,
      styles: this.state.styles,
      showFlows: this.state.showFlows,
      showRulers: this.state.showRulers,
      showMinimap: this.state.showMinimap,
      showComments: this.state.showComments,
      outlineMode: this.state.outlineMode ?? false,
      pixelPreview: this.state.pixelPreview,
      viewLayoutGuides: this.state.viewLayoutGuides,
      propertyLabels: this.state.propertyLabels,
      openComment: this.state.openComment,
      // View options live in the tab, not in the file:
      // explicit that zoom (and the menu beside it) applies to the current tab
      // only, so none of these are written into the document.
      presentFrame: this.state.presentFrame,
      presentStack: this.state.presentStack,
      prototypeDevice: this.state.prototypeDevice,
      prototypeOrientation: this.state.prototypeOrientation,
      prototypeScale: this.state.prototypeScale,
      prototypeHotspots: this.state.prototypeHotspots,
      prototypeLiveInputs: this.state.prototypeLiveInputs,
      prototypeSound: this.state.prototypeSound,
      activeOverlay: this.state.activeOverlay,
      variables: this.state.variables,
      variableCollections: this.state.variableCollections,
      activeModes: this.state.activeModes,
      annotations: this.state.annotations,
      vecEdit: this.state.vecEdit,
      vecPoint: this.state.vecPoint,
      vecPoints: this.state.vecPoints ?? [],
      booleanPreview: this.state.booleanPreview,
      lastFrameSize: this.lastFrameSize,
    };
  }

  private apply(cmd: Command) {
    const s = this.state;
    switch (cmd.type) {
      case "select":
        s.selection = cmd.ids;
        s.booleanPreview = null;
        s.selectedGuide = null;
        this.justDuplicated = false;
        if (s.vecEdit && !s.selection.includes(s.vecEdit)) {
          s.vecEdit = null;
          s.vecPoint = null;
          s.vecPoints = [];
        }
        break;
      case "selectGuide":
        s.selectedGuide = cmd.id;
        break;
      case "setTool":
        s.tool = cmd.tool;
        s.booleanPreview = null;
        break;
      case "setZoom": {
        const next = clampZoom(cmd.zoom);
        // A zoom that names an anchor keeps that point of the canvas still -
        // the middle of the viewport for the keyboard and the menu, the pointer
        // for a wheel. One without an anchor only changes the scale, which is
        // what restoring a saved viewport wants.
        if (cmd.anchorX != null && cmd.anchorY != null) {
          s.panX = panForZoom(s.panX, s.zoom, next, cmd.anchorX);
          s.panY = panForZoom(s.panY, s.zoom, next, cmd.anchorY);
        }
        s.zoom = next;
        break;
      }
      case "pan":
        s.panX += cmd.dx;
        s.panY += cmd.dy;
        break;
      case "setPan":
        s.panX = cmd.x;
        s.panY = cmd.y;
        break;
      case "setPixelPreview":
        s.pixelPreview = cmd.preview;
        break;
      case "toggleLayoutGuides":
        s.viewLayoutGuides = !s.viewLayoutGuides;
        break;
      case "togglePropertyLabels":
        s.propertyLabels = !s.propertyLabels;
        break;
      case "toggleRulers":
        s.showRulers = !s.showRulers;
        break;
      case "toggleFlows":
        s.showFlows = cmd.enabled ?? !s.showFlows;
        break;
      case "toggleMinimap":
        s.showMinimap = !s.showMinimap;
        break;
      case "toggleComments":
        s.showComments = !s.showComments;
        if (!s.showComments) s.openComment = "";
        break;
      case "toggleOutlines":
        s.outlineMode = !s.outlineMode;
        break;
      case "swapFillStroke": {
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (n && !n.locked) {
            const curFill = n.fill;
            const curStroke = n.strokePaint;
            const curFillVis = n.fillVisible ?? true;
            const curStrokeVis = n.strokeVisible ?? false;
            const curWidth = n.strokeWidth || 1;
            n.fill = curStroke || "#000000";
            n.strokePaint = curFill || "#000000";
            n.fillVisible = curStrokeVis;
            n.strokeVisible = curFillVis;
            if (!n.strokeWidth) n.strokeWidth = curWidth;
          }
        }
        break;
      }
      case "toggleStroke": {
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (n && !n.locked) {
            const isVis = n.strokeVisible && n.strokeWidth > 0;
            n.strokeVisible = !isVis;
            if (!isVis && !n.strokeWidth) n.strokeWidth = 1;
            if (!n.strokePaint || n.strokePaint === "#00000000") n.strokePaint = "#000000";
          }
        }
        break;
      }
      case "tidyUp": {
        const items = s.selection
          .map((id) => find(this.root(), id))
          .filter((n): n is XNode => !!n && !n.locked);
        if (items.length < 2) break;
        const xs = items.map((i) => i.x);
        const ys = items.map((i) => i.y);
        const spanX = Math.max(...xs) - Math.min(...xs);
        const spanY = Math.max(...ys) - Math.min(...ys);
        const isHoriz = cmd.axis === "h" || (cmd.axis !== "v" && spanX >= spanY);
        if (isHoriz) {
          items.sort((a, b) => a.x - b.x);
          const minX = items[0].x;
          const maxX = items[items.length - 1].x + items[items.length - 1].w;
          const totalW = items.reduce((sum, n) => sum + n.w, 0);
          const gap = Math.max(0, (maxX - minX - totalW) / (items.length - 1));
          let cur = minX;
          for (const item of items) {
            item.x = Math.round(cur);
            cur += item.w + gap;
          }
        } else {
          items.sort((a, b) => a.y - b.y);
          const minY = items[0].y;
          const maxY = items[items.length - 1].y + items[items.length - 1].h;
          const totalH = items.reduce((sum, n) => sum + n.h, 0);
          const gap = Math.max(0, (maxY - minY - totalH) / (items.length - 1));
          let cur = minY;
          for (const item of items) {
            item.y = Math.round(cur);
            cur += item.h + gap;
          }
        }
        break;
      }
      case "openComment":
        s.openComment = cmd.id;
        break;
      case "addComment": {
        const page = s.pages[s.page];
        const id = uid("cm");
        page.comments.push({
          id,
          x: cmd.x,
          y: cmd.y,
          body: cmd.body,
          at: Date.now(),
          resolved: false,
          replies: [],
        });
        s.showComments = true;
        s.openComment = id;
        break;
      }
      case "replyComment": {
        const t = s.pages[s.page].comments.find((c) => c.id === cmd.id);
        if (t) t.replies.push({ id: uid("cr"), body: cmd.body, at: Date.now() });
        break;
      }
      case "resolveComment": {
        const t = s.pages[s.page].comments.find((c) => c.id === cmd.id);
        if (t) t.resolved = cmd.resolved;
        if (cmd.resolved) s.openComment = "";
        break;
      }
      case "deleteComment": {
        const page = s.pages[s.page];
        page.comments = page.comments.filter((c) => c.id !== cmd.id);
        if (s.openComment === cmd.id) s.openComment = "";
        break;
      }
      case "moveComment": {
        const t = s.pages[s.page].comments.find((c) => c.id === cmd.id);
        if (t) {
          t.x = cmd.x;
          t.y = cmd.y;
        }
        break;
      }
        break;
      case "setRightTab":
        s.rightTab = cmd.tab;
        break;
      case "setLeftTab":
        s.leftTab = cmd.tab;
        break;
      case "setFileName":
        s.fileName = cmd.name;
        break;
      case "setPage":
        s.page = Math.max(0, Math.min(s.pages.length - 1, cmd.index));
        s.selection = [];
        break;
      case "addPage": {
        const p = demoPage();
        p.name = `Page ${s.pages.length + 1}`;
        p.root.children = [];
        p.comments = [];
        p.guides = [];
        p.flowStart = "";
        s.pages.push(p);
        s.page = s.pages.length - 1;
        s.selection = [];
        break;
      }
      case "add": {
        const grid = snapOn(this.state, s.page);
        const parent = cmd.parent ? find(this.root(), cmd.parent) : this.root();
        const n = node(
          cmd.kind,
          freshLabel(this.root(), cmd.kind),
          grid ? Math.round(cmd.x) : cmd.x,
          grid ? Math.round(cmd.y) : cmd.y,
          grid ? Math.max(1, Math.round(cmd.w)) : cmd.w,
          grid ? Math.max(1, Math.round(cmd.h)) : cmd.h,
          cmd.extra,
        );
        const into = parent ?? this.root();
        const spot = this.gridSpotFor(into, cmd.x, cmd.y);
        into.children.splice(spot?.index ?? into.children.length, 0, n);
        // "Place it between the cell objects - in layer order
        // - nearest your cursor", so the cell that was clicked is the one it
        // takes. The rest of the flow arranges itself around it.
        if (spot) {
          n.gridCol = spot.col;
          n.gridRow = spot.row;
          n.gridPinned = true;
        }
        s.selection = [n.id];
        if (cmd.kind === "text" || cmd.extra?.imageSrc) s.tool = "select";
        if (cmd.kind === "frame" && into === this.root()) this.lastFrameSize = { w: n.w, h: n.h };
        break;
      }
      case "move":
        if (this.justDuplicated) {
          this.lastDupDelta = { dx: cmd.dx, dy: cmd.dy };
          this.justDuplicated = false;
        }
        for (const id of cmd.ids) {
          const n = find(this.root(), id);
          if (n && !n.locked) {
            n.x += cmd.dx;
            n.y += cmd.dy;
            if (snapOn(this.state, s.page)) {
              n.x = Math.round(n.x);
              n.y = Math.round(n.y);
            }
          }
        }
        break;
      case "nudge":
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (!n || n.locked) continue;
          const parent = findParent(this.root(), id);
          if (parent?.layout && !n.absolutePosition) {
            const idx = parent.children.findIndex((c) => c.id === id);
            if (idx >= 0) {
              const forward = cmd.dx > 0 || cmd.dy > 0;
              const targetIdx = forward ? idx + 1 : idx - 1;
              if (targetIdx >= 0 && targetIdx < parent.children.length) {
                const [item] = parent.children.splice(idx, 1);
                parent.children.splice(targetIdx, 0, item);
              }
            }
          } else {
            n.x += cmd.dx;
            n.y += cmd.dy;
            if (snapOn(this.state, s.page)) {
              n.x = Math.round(n.x);
              n.y = Math.round(n.y);
            }
          }
        }
        break;
      case "resize": {
        const n = find(this.root(), cmd.id);
        if (n && !n.locked) {
          const oldW = n.w;
          const oldH = n.h;
          // What the person asked for, before snapping: an axis counts as
          // manually adjusted when its number changed, and a hug is only
          // measured to a fraction of a pixel, so comparing the snapped box
          // would call a typed width a change of height too - and fix a frame
          // that should still be hugging.
          const askedW = cmd.w;
          const askedH = cmd.h;
          n.x = snapOn(this.state, s.page) ? Math.round(cmd.x) : cmd.x;
          n.y = snapOn(this.state, s.page) ? Math.round(cmd.y) : cmd.y;
          n.w = Math.max(1, snapOn(this.state, s.page) ? Math.round(cmd.w) : cmd.w);
          n.h = Math.max(1, snapOn(this.state, s.page) ? Math.round(cmd.h) : cmd.h);
          if (n.kind === "text" && !cmd.scaleProps) {
            if (askedW !== oldW) n.sizingW = "fixed";
            if (askedH !== oldH) n.sizingH = "fixed";
          }
          // "Any manual adjustments you make will set the layer to Fixed
          // on the relevant axis" - so a typed width or a dragged edge turns a
          // hug into Fixed. An auto layout frame keeps its resizing in two
          // places, the layout's own pair and the layer's resizing menu, and the
          // engine hugs if *either* asks for it; a manual resize therefore has
          // to set both or the hug snaps back over the number just typed. The
          // Scale tool is exempt: it scales the frame and its resizing together.
          if (n.layout && !cmd.scaleProps) {
            const l = n.layout;
            const horiz = widthIsMain(l);
            if (askedW !== oldW) {
              if (horiz) l.sizing = "fixed";
              else l.cross = "fixed";
              // A fill would also keep looking for something to fill into.
              if (n.sizingW !== "fixed") n.sizingW = "fixed";
            }
            if (askedH !== oldH) {
              if (horiz) l.cross = "fixed";
              else l.sizing = "fixed";
              if (n.sizingH !== "fixed") n.sizingH = "fixed";
            }
          }
          // A child of an auto layout frame that is resized by hand stops
          // filling on the adjusted axis - "any manual adjustments you make
          // will set the layer to Fixed" - or the next layout pass would snap
          // it back to the fill size and the drag would do nothing.
          const par = findParent(this.root(), n.id);
          if (par?.layout && !cmd.scaleProps) {
            if (askedW !== oldW) n.sizingW = "fixed";
            if (askedH !== oldH) n.sizingH = "fixed";
          }
          // A locked box that was resized by hand takes its new ratio with it.
          if (n.aspectLocked && askedW !== oldW && askedH !== oldH && n.w > 0 && n.h > 0) {
            n.aspectRatio = n.h / n.w;
          }
          if (cmd.scaleProps && oldW > 0 && oldH > 0) {
            scaleProps(n, n.w / oldW, n.h / oldH);
          } else if (!cmd.ignoreConstraints) {
            applyConstraints(n, oldW, oldH, n.w, n.h);
          }
          this.publishMaster(n);
        }
        break;
      }
      case "reparent": {
        const dest = find(this.root(), cmd.parent) ?? this.root();
        for (const id of cmd.ids) {
          const p = findParent(this.root(), id);
          const n = find(this.root(), id);
          if (!p || !n || id === dest.id || !!find(n, dest.id)) continue;
          // Where it lands is worked out against the destination as it stands,
          // before this object joins it.
          const spot = this.gridSpotFor(dest, cmd.x, cmd.y);
          p.children = p.children.filter((c) => c.id !== id);
          n.x = cmd.x;
          n.y = cmd.y;
          dest.children.splice(spot?.index ?? dest.children.length, 0, n);
          if (spot) {
            n.gridCol = spot.col;
            n.gridRow = spot.row;
            n.gridPinned = true;
          }
        }
        break;
      }
      case "reorder": {
        const root = this.root();
        const dest = find(root, cmd.parent) ?? root;
        // Absolute position is preserved across the move, so dragging a layer
        // into a frame in the panel does not teleport it on the canvas.
        const moving: { node: XNode; wx: number; wy: number }[] = [];
        for (const id of cmd.ids) {
          const n = find(root, id);
          const wp = worldPos(root, id);
          // Refuse to drop a node into itself or its own subtree.
          if (!n || n.locked || id === dest.id || find(n, dest.id)) continue;
          moving.push({ node: n, wx: wp?.x ?? n.x, wy: wp?.y ?? n.y });
        }
        if (!moving.length) break;
        // Count how many of the moved nodes sit before the target slot in the
        // destination, so the index still points at the intended gap after
        // they are spliced out.
        let index = cmd.index;
        for (const { node } of moving) {
          const at = dest.children.indexOf(node);
          if (at >= 0 && at < index) index--;
        }
        for (const { node } of moving) {
          const p = findParent(root, node.id);
          if (p) p.children = p.children.filter((c) => c.id !== node.id);
        }
        const destWorld = dest === root ? { x: 0, y: 0 } : worldPos(root, dest.id);
        index = Math.max(0, Math.min(index, dest.children.length));
        dest.children.splice(index, 0, ...moving.map((m) => m.node));
        for (const m of moving) {
          m.node.x = m.wx - (destWorld?.x ?? 0);
          m.node.y = m.wy - (destWorld?.y ?? 0);
        }
        break;
      }
      case "delete": {
        for (const id of s.selection) {
          const p = findParent(this.root(), id);
          const n = find(this.root(), id);
          if (p && n && !n.locked) p.children = p.children.filter((c) => c.id !== id);
        }
        s.selection = s.selection.filter((id) => !!find(this.root(), id));
        // Frame-level guides die with their frame rather than going stale.
        const gone = new Set(
          s.pages[s.page].guides.map((g) => g.frameId).filter((f): f is string => !!f && !find(this.root(), f)),
        );
        if (gone.size) {
          s.pages[s.page].guides = s.pages[s.page].guides.filter((g) => !g.frameId || !gone.has(g.frameId));
          if (s.selectedGuide && !s.pages[s.page].guides.some((g) => g.id === s.selectedGuide)) s.selectedGuide = null;
        }
        break;
      }
      case "duplicate": {
        const created: string[] = [];
        // An explicit dx/dy (frame quick-add) places the copy exactly and
        // leaves the ⌘D cascade delta alone.
        const delta =
          cmd.dx !== undefined || cmd.dy !== undefined
            ? { dx: cmd.dx ?? 0, dy: cmd.dy ?? 0 }
            : (this.lastDupDelta ?? { dx: 10, dy: 10 });
        for (const id of s.selection) {
          const n = find(this.root(), id);
          const p = findParent(this.root(), id) ?? this.root();
          if (!n || n.locked) continue;
          const copy = clone(n);
          const masterId = n.isComponent ? n.componentId || n.id : n.componentId;
          reid(copy);
          copy.x += delta.dx;
          copy.y += delta.dy;
          const baseName = n.name;
          const copyMatch = baseName.match(/^(.*?)(?: copy(?: (\d+))?)?$/);
          if (copyMatch) {
            const rootName = copyMatch[1];
            const hasCopy = baseName.includes(" copy");
            const currentNum = copyMatch[2] ? parseInt(copyMatch[2], 10) : (hasCopy ? 1 : 0);
            const nextNum = currentNum + 1;
            copy.name = nextNum === 1 ? `${rootName} copy` : `${rootName} copy ${nextNum}`;
          }
          if (n.isComponent) {
            copy.isComponent = false;
            copy.componentId = masterId;
          }
          // Put the duplicate directly above the one it came from, and
          // "the new frames will fill the subsequent cells" - so a copy of an
          // object that was placed on purpose is not itself placed.
          copy.gridPinned = false;
          const at = p.children.findIndex((c) => c.id === n.id);
          if (at === -1) p.children.push(copy);
          else p.children.splice(at + 1, 0, copy);
          created.push(copy.id);
        }
        s.selection = created;
        this.justDuplicated = true;
        break;
      }
      case "patch": {
        const n = find(this.root(), cmd.id);
        if (n) {
          // A hand-typed name pins the layer name; automatic naming stops.
          if (cmd.patch.name !== undefined) n.nameLocked = true;
          // Editing a bound colour by hand detaches it from its style, as in
          // Standard behavior — the alternative is silently diverging from the style, or
          // silently reverting the user's edit. Re-binding is explicit.
          if (cmd.patch.fill !== undefined && cmd.patch.fillStyle === undefined && n.fillStyle) {
            delete n.fillStyle;
          }
          if (cmd.patch.strokePaint !== undefined && cmd.patch.strokeStyle === undefined && n.strokeStyle) {
            delete n.strokeStyle;
          }
          // Same detach rule for variables: editing a bound prop by hand
          // clears that binding, otherwise the next relayout would revert
          // the edit.
          if (n.variableBindings) {
            for (const k of Object.keys(cmd.patch)) {
              if (k in n.variableBindings) delete n.variableBindings[k];
            }
            if (Object.keys(n.variableBindings).length === 0) delete n.variableBindings;
          }
          // Text rule: a text layer cannot hold a max height and a max
          // line count at once - setting either clears the other - so the pair
          // is resolved here rather than in whichever panel did the writing.
          const patch = n.kind === "text" ? textDimensionRule(cmd.patch) : cmd.patch;
          // Turning the aspect lock on remembers the ratio it was taken at, so
          // a later size that clamps to a pixel cannot leave the box square.
          if (patch.aspectLocked === true && patch.aspectRatio === undefined && n.w > 0 && n.h > 0) {
            patch.aspectRatio = n.h / n.w;
          }
          if (patch.aspectLocked === false) patch.aspectRatio = undefined;
          Object.assign(n, patch);
          // Text layers follow their content until renamed.
          if (n.kind === "text" && patch.text !== undefined && !n.nameLocked) {
            const first = (patch.text || "").split("\n")[0].trim();
            n.name = first ? first.slice(0, 60) : "Text";
          }
          if (n.isComponent && n.componentId) {
            const lib = s.components.find((c) => c.id === n.componentId);
            if (lib) {
              lib.name = n.name;
              lib.node = clone(n);
            }
            syncInstances(s.pages, n);
          } else if (n.componentId && !n.isComponent) {
            n.overrides = { ...(n.overrides || {}), ...cmd.patch };
          } else {
            const inst = findInstanceRoot(this.root(), n.id);
            if (inst && inst !== n) {
              n.overrides = { ...(n.overrides || {}), ...cmd.patch };
            }
          }
        }
        break;
      }
      case "autoLayout": {
        const n = find(this.root(), cmd.id);
        if (n) {
          n.layout = cmd.layout;
          this.publishMaster(n);
        }
        break;
      }
      case "wrapAutoLayout": {
        this.wrapAutoLayout(cmd.ids, cmd.layout);
        break;
      }
      case "removeAllLayout": {
        const n = find(this.root(), cmd.id);
        // "Auto layout cannot be removed from component instances. You will
        // need to detach the instance from the component to make these edits."
        if (n && !insideInstance(this.root(), cmd.id)) {
          stripLayout(n);
          this.publishMaster(n);
        }
        break;
      }
      case "undo": {
        const prev = this.undo.pop();
        if (prev) {
          this.redo.push(clone(this.state));
          this.state = prev;
        }
        break;
      }
      case "redo": {
        const next = this.redo.pop();
        if (next) {
          this.undo.push(clone(this.state));
          this.state = next;
        }
        break;
      }
      case "copy": {
        this.clip = s.selection
          .map((id) => find(this.root(), id))
          .filter((n): n is XNode => !!n)
          .map(clone);
        publishClip(this.clip, this.state.fileName);
        break;
      }
      case "cut":
        this.apply({ type: "copy" });
        this.apply({ type: "delete" });
        break;
      case "loadClip": {
        // Layers from outside this document: another tab, another file, or a
        // payload this app wrote earlier. Repaired the way a stored document is,
        // because the writer may have been an older build with fewer fields.
        const incoming = (Array.isArray(cmd.nodes) ? cmd.nodes : [])
          .map((n) => {
            try {
              return reviveNode(n);
            } catch {
              return null;
            }
          })
          .filter((n): n is XNode => !!n);
        if (incoming.length) this.clip = incoming;
        break;
      }
      case "paste": {
        if (!this.clip.length) break;
        const created: string[] = [];
        const selected = s.selection.length === 1 ? find(this.root(), s.selection[0]) : null;
        const parent =
          selected && (selected.kind === "frame" || selected.kind === "group" || selected.kind === "boolean")
            ? selected
            : selected
              ? findParent(this.root(), selected.id) ?? this.root()
              : this.root();
        const parentWorld = parent === this.root() ? { x: 0, y: 0 } : worldPos(this.root(), parent.id) ?? { x: 0, y: 0 };
        const grid = snapOn(this.state, s.page);
        // "Paste here" aims the whole copy at one point, so the group's centre
        // lands there and the layers keep the arrangement they were copied in.
        // Stacking every root on the same coordinate — what an unadjusted
        // `copy.x = cmd.x` does — turns a three-layer copy into one visible
        // layer, which reads as a paste that silently dropped content.
        const clipBox = clipBounds(this.clip);
        const aimX = cmd.x != null ? cmd.x - clipBox.cx : 0;
        const aimY = cmd.y != null ? cmd.y - clipBox.cy : 0;
        for (const n of this.clip) {
          const copy = clone(n);
          reid(copy);
          if (cmd.inPlace) {
            copy.x = n.x;
            copy.y = n.y;
          } else if (cmd.x != null && cmd.y != null) {
            copy.x = n.x + aimX - parentWorld.x;
            copy.y = n.y + aimY - parentWorld.y;
          } else {
            copy.x = n.x + 16;
            copy.y = n.y + 16;
          }
          if (grid) {
            copy.x = Math.round(copy.x);
            copy.y = Math.round(copy.y);
          }
          parent.children.push(copy);
          created.push(copy.id);
        }
        s.selection = created;
        break;
      }
      case "selectAll": {
        const id = s.selection[0];
        const parent = id ? findParent(this.root(), id) ?? this.root() : this.root();
        s.selection = parent.children.filter((c) => c.visible && !c.locked).map((c) => c.id);
        if (s.vecEdit && !s.selection.includes(s.vecEdit)) {
          s.vecEdit = null;
          s.vecPoint = null;
          s.vecPoints = [];
        }
        break;
      }
      case "lockSel":
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (n) n.locked = !n.locked;
        }
        break;
      case "hideSel":
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (n) n.visible = !n.visible;
        }
        break;
      case "flip":
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (!n) continue;
          if (cmd.axis === "h") {
            n.flipH = !n.flipH;
            const [tl, tr, bl, br] = n.cornerRadii;
            n.cornerRadii = [tr, tl, br, bl];
            for (const c of n.children) c.x = n.w - c.x - c.w;
          } else {
            n.flipV = !n.flipV;
            const [tl, tr, bl, br] = n.cornerRadii;
            n.cornerRadii = [bl, br, tl, tr];
            for (const c of n.children) c.y = n.h - c.y - c.h;
          }
          this.publishMaster(n);
        }
        break;
      case "copyCode": {
        // Engine-level "copy the box as CSS". The Dev Mode UI no longer routes
        // through here: it renders through inspector.renderDevCode so the panel,
        // the Copy/paste as menu and ⌥⇧⌘C all honour the chosen language and units.
        // This stays because it is the command the menu-command parity list names.
        const n = s.selection[0] ? find(this.root(), s.selection[0]) : null;
        if (!n || typeof navigator === "undefined") break;
        const css = [
          `width: ${Math.round(n.w)}px;`,
          `height: ${Math.round(n.h)}px;`,
          n.cornerRadii[0] ? `border-radius: ${n.cornerRadii[0]}px;` : "",
          n.fillVisible ? `background: ${n.fill};` : "",
          n.opacity < 1 ? `opacity: ${n.opacity};` : "",
        ]
          .filter(Boolean)
          .join("\n");
        copyText(css);
        break;
      }
      case "copyProperties": {
        const id = s.selection[0];
        if (!id) break;
        const n = find(this.root(), id);
        if (!n) break;
        this.copiedProps = {
          fill: n.fill,
          fillVisible: n.fillVisible,
          fillOpacity: n.fillOpacity,
          fillType: n.fillType,
          fillGX: n.fillGX,
          fillGY: n.fillGY,
          fillHX: n.fillHX,
          fillHY: n.fillHY,
          gradientStops: n.gradientStops ? clone(n.gradientStops) : undefined,
          fills: n.fills ? clone(n.fills) : undefined,
          strokePaint: n.strokePaint,
          strokeWidth: n.strokeWidth,
          strokeVisible: n.strokeVisible,
          strokeOpacity: n.strokeOpacity,
          strokeDash: n.strokeDash,
          strokeGap: n.strokeGap,
          strokeCap: n.strokeCap,
          strokeCapStart: n.strokeCapStart,
          strokeCapEnd: n.strokeCapEnd,
          strokeJoin: n.strokeJoin,
          strokeAlign: n.strokeAlign,
          strokes: n.strokes ? clone(n.strokes) : undefined,
          effects: n.effects ? clone(n.effects) : undefined,
          opacity: n.opacity,
          blendMode: n.blendMode,
          cornerRadii: n.cornerRadii ? [...n.cornerRadii] : undefined,
          cornerIndependent: n.cornerIndependent,
          cornerSmoothing: n.cornerSmoothing,
          strokeSides: n.strokeSides,
          strokeSideW: n.strokeSideW ? [...n.strokeSideW] : undefined,
          strokeDashPattern: n.strokeDashPattern ? [...n.strokeDashPattern] : undefined,
          strokeDashCap: n.strokeDashCap,
          strokeMiterAngle: n.strokeMiterAngle,
          interactions: n.interactions ? clone(n.interactions) : undefined,
        };
        break;
      }
      case "pasteProperties": {
        if (!this.copiedProps || s.selection.length === 0) break;
        const p = this.copiedProps;
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (!n || n.locked) continue;
          if (p.fill !== undefined) n.fill = p.fill;
          if (p.fillVisible !== undefined) n.fillVisible = p.fillVisible;
          if (p.fillOpacity !== undefined) n.fillOpacity = p.fillOpacity;
          if (p.fillType !== undefined) n.fillType = p.fillType;
          if (p.fillGX !== undefined) n.fillGX = p.fillGX;
          if (p.fillGY !== undefined) n.fillGY = p.fillGY;
          if (p.fillHX !== undefined) n.fillHX = p.fillHX;
          if (p.fillHY !== undefined) n.fillHY = p.fillHY;
          if (p.gradientStops) n.gradientStops = clone(p.gradientStops);
          if (p.fills) n.fills = clone(p.fills);
          if (p.strokePaint !== undefined) n.strokePaint = p.strokePaint;
          if (p.strokeWidth !== undefined) n.strokeWidth = p.strokeWidth;
          if (p.strokeVisible !== undefined) n.strokeVisible = p.strokeVisible;
          if (p.strokeOpacity !== undefined) n.strokeOpacity = p.strokeOpacity;
          if (p.strokeDash !== undefined) n.strokeDash = p.strokeDash;
          if (p.strokeGap !== undefined) n.strokeGap = p.strokeGap;
          if (p.strokeCap !== undefined) n.strokeCap = p.strokeCap;
          if (p.strokeCapStart !== undefined) n.strokeCapStart = p.strokeCapStart;
          if (p.strokeCapEnd !== undefined) n.strokeCapEnd = p.strokeCapEnd;
          if (p.strokeJoin !== undefined) n.strokeJoin = p.strokeJoin;
          if (p.strokeAlign !== undefined) n.strokeAlign = p.strokeAlign;
          if (p.strokes) n.strokes = clone(p.strokes);
          if (p.effects) n.effects = clone(p.effects);
          if (p.opacity !== undefined) n.opacity = p.opacity;
          if (p.blendMode !== undefined) n.blendMode = p.blendMode;
          if (p.cornerRadii) n.cornerRadii = [...p.cornerRadii];
          if (p.cornerIndependent !== undefined) n.cornerIndependent = p.cornerIndependent;
          if (p.cornerSmoothing !== undefined) n.cornerSmoothing = p.cornerSmoothing;
          if (p.strokeSides !== undefined) n.strokeSides = p.strokeSides;
          if (p.strokeSideW) n.strokeSideW = [...p.strokeSideW];
          if (p.strokeDashPattern) n.strokeDashPattern = [...p.strokeDashPattern];
          if (p.strokeDashCap !== undefined) n.strokeDashCap = p.strokeDashCap;
          if (p.strokeMiterAngle !== undefined) n.strokeMiterAngle = p.strokeMiterAngle;
          if (p.interactions) n.interactions = clone(p.interactions);
        }
        break;
      }
      case "deleteInteraction": {
        const n = find(this.root(), cmd.id);
        if (!n || !n.interactions) break;
        n.interactions = n.interactions.filter((ix) => ix.destination !== cmd.destId);
        break;
      }
      case "group":
      case "wrapSection": {
        this.wrapSel(cmd.type === "wrapSection" ? "Section" : "Group", {
          kind: cmd.type === "wrapSection" ? "frame" : "group",
          fill: "#00000000",
          fillVisible: false,
          overflow: "visible",
        });
        break;
      }
      case "frameSelection": {
        // Plain frame around the selection: no auto layout, unlike ⇧A.
        this.wrapSel("Frame", {
          kind: "frame",
          fill: "#ffffff",
          fillVisible: true,
          overflow: "clip",
        });
        break;
      }
      case "resizeToFit": {
        // One-shot redraw of each selected frame around the outermost bounds
        // of its visible children; children keep their absolute positions.
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (!n || (n.kind !== "frame" && n.kind !== "group") || n.locked) continue;
          const kids = n.children.filter((c) => c.visible && !c.absolutePosition);
          if (!kids.length) continue;
          const x0 = Math.min(...kids.map((c) => c.x));
          const y0 = Math.min(...kids.map((c) => c.y));
          const x1 = Math.max(...kids.map((c) => c.x + c.w));
          const y1 = Math.max(...kids.map((c) => c.y + c.h));
          for (const c of kids) {
            c.x -= x0;
            c.y -= y0;
          }
          n.x += x0;
          n.y += y0;
          n.w = Math.max(1, x1 - x0);
          n.h = Math.max(1, y1 - y0);
        }
        break;
      }
      case "ungroup": {
        const id = s.selection[0];
        if (!id) break;
        const parent = findParent(this.root(), id);
        const n = find(this.root(), id);
        if (!parent || !n || !n.children.length) break;
        const i = parent.children.findIndex((c) => c.id === id);
        const kids = n.children.map((c) => {
          const k = clone(c);
          k.x += n.x;
          k.y += n.y;
          return k;
        });
        parent.children.splice(i, 1, ...kids);
        s.selection = kids.map((k) => k.id);
        break;
      }
      case "arrange": {
        const selected = new Set(s.selection);
        const groups = new Map<XNode, string[]>();
        const collect = (parent: XNode) => {
          const ids = parent.children.filter((c) => selected.has(c.id)).map((c) => c.id);
          if (ids.length) groups.set(parent, ids);
          parent.children.forEach(collect);
        };
        collect(this.root());
        for (const [parent, ids] of groups) {
          if (cmd.dir === "front" || cmd.dir === "back") {
            const picked = parent.children.filter((c) => ids.includes(c.id));
            const rest = parent.children.filter((c) => !ids.includes(c.id));
            parent.children = cmd.dir === "front" ? [...rest, ...picked] : [...picked, ...rest];
            continue;
          }
          const next = [...parent.children];
          if (cmd.dir === "forward") {
            for (let i = next.length - 2; i >= 0; i--) {
              if (selected.has(next[i].id) && !selected.has(next[i + 1].id)) {
                [next[i], next[i + 1]] = [next[i + 1], next[i]];
              }
            }
          } else {
            for (let i = 1; i < next.length; i++) {
              if (selected.has(next[i].id) && !selected.has(next[i - 1].id)) {
                [next[i], next[i - 1]] = [next[i - 1], next[i]];
              }
            }
          }
          parent.children = next;
        }
        break;
      }
      case "duplicatePage": {
        const p = clone(s.pages[s.page]);
        const ids = new Map<string, string>();
        const oldFlowStart = p.flowStart;
        p.id = uid("page");
        const baseName = p.name;
        const copyMatch = baseName.match(/^(.*?)(?: copy(?: (\d+))?)?$/);
        if (copyMatch) {
          const rootName = copyMatch[1];
          const hasCopy = baseName.includes(" copy");
          const currentNum = copyMatch[2] ? parseInt(copyMatch[2], 10) : (hasCopy ? 1 : 0);
          const nextNum = currentNum + 1;
          p.name = nextNum === 1 ? `${rootName} copy` : `${rootName} copy ${nextNum}`;
        } else {
          p.name = `${p.name} copy`;
        }
        reid(p.root, ids);
        p.flowStart = ids.get(oldFlowStart) ?? "";
        s.pages.splice(s.page + 1, 0, p);
        s.page += 1;
        s.selection = [];
        break;
      }
      case "deletePage": {
        if (s.pages.length < 2) break;
        s.pages.splice(s.page, 1);
        s.page = Math.min(s.page, s.pages.length - 1);
        s.selection = [];
        break;
      }
      case "renamePage":
        s.pages[s.page].name = cmd.name;
        break;
      case "patchPage":
        Object.assign(s.pages[s.page], cmd.patch);
        break;
      case "boolean": {
        s.booleanPreview = null;
        const ids = s.selection.filter((id) => {
          const n = find(this.root(), id);
          return !!n && n.kind !== "frame";
        });
        if (ids.length < 2) break;
        s.selection = ids;
        this.wrapSel(cmd.op === "union" ? "Union" : cmd.op[0].toUpperCase() + cmd.op.slice(1), {
          kind: "boolean",
          booleanOp: cmd.op,
          fill: "#d9d9d9",
          fillVisible: true,
          overflow: "visible",
        });
        const g = find(this.root(), s.selection[0]);
        if (g?.children.length) {
          const src = cmd.op === "subtract" ? g.children[0] : g.children[g.children.length - 1];
          g.fill = src.fill;
          g.fillVisible = src.fillVisible;
          g.fillType = src.fillType;
          g.fillB = src.fillB;
          g.fillOpacity = src.fillOpacity;
          g.strokePaint = src.strokePaint;
          g.strokeWidth = src.strokeWidth;
          g.strokeVisible = src.strokeVisible;
          g.strokeAlign = src.strokeAlign;
          g.effects = clone(src.effects);
          const baked = booleanPath(
            cmd.op,
            g.children.map((c) => ({ poly: transformedPoly(c), ox: c.x, oy: c.y })),
          );
          if (baked) {
            g.path = baked.path;
            g.closed = true;
            g.kind = "boolean";
            if (baked.network) g.vectorNetwork = baked.network;
            else g.vectorNetwork = pathToVectorNetwork(baked.path, true);
          }
        }
        break;
      }
      case "setBooleanPreview": {
        s.booleanPreview = cmd.op;
        break;
      }
      case "createStyle": {
        const nodes = s.selection.map((id) => find(this.root(), id)).filter((n): n is XNode => !!n);
        if (!nodes.length) break;
        const first = nodes[0];
        const color = cmd.kind === "fill" ? first.fill : first.strokePaint;
        const style: SharedStyle = { id: uid("style"), name: cmd.name.trim() || "Style", kind: "paint", color };
        s.styles.push(style);
        // Bind every selected node, so "create from selection" works on a
        // multi-selection cleanly.
        for (const n of nodes) {
          if (cmd.kind === "fill") {
            n.fillStyle = style.id;
            n.fill = color;
            n.fillVisible = true;
          } else {
            n.strokeStyle = style.id;
            n.strokePaint = color;
            n.strokeVisible = true;
            if (!(n.strokeWidth > 0)) n.strokeWidth = 1;
          }
        }
        break;
      }
      case "applyStyle": {
        const style = s.styles.find((x) => x.id === cmd.styleId);
        if (!style) break;
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (!n) continue;
          if (cmd.kind === "fill") {
            n.fillStyle = style.id;
            n.fill = style.color;
            n.fillVisible = true;
          } else {
            n.strokeStyle = style.id;
            n.strokePaint = style.color;
            n.strokeVisible = true;
            if (!(n.strokeWidth > 0)) n.strokeWidth = 1;
          }
        }
        break;
      }
      case "detachStyle": {
        // Keep the painted colour; only the link goes away.
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (!n) continue;
          if (cmd.kind === "fill") delete n.fillStyle;
          else delete n.strokeStyle;
        }
        break;
      }
      case "editStyle": {
        const style = s.styles.find((x) => x.id === cmd.id);
        if (!style) break;
        if (cmd.name !== undefined) style.name = cmd.name;
        if (cmd.color !== undefined) {
          style.color = cmd.color;
          // The binding is live: repaint every node pointing at this style.
          const walk = (n: XNode) => {
            if (n.fillStyle === style.id) n.fill = style.color;
            if (n.strokeStyle === style.id) n.strokePaint = style.color;
            n.children.forEach(walk);
          };
          for (const pg of s.pages) walk(pg.root);
        }
        break;
      }
      case "deleteStyle": {
        s.styles = s.styles.filter((x) => x.id !== cmd.id);
        // Bound nodes keep their colour and simply become unbound.
        const walk = (n: XNode) => {
          if (n.fillStyle === cmd.id) delete n.fillStyle;
          if (n.strokeStyle === cmd.id) delete n.strokeStyle;
          n.children.forEach(walk);
        };
        for (const pg of s.pages) walk(pg.root);
        break;
      }
      case "addGuide": {
        s.pages[s.page].guides.push({ id: uid("guide"), axis: cmd.axis, at: cmd.at, frameId: cmd.frameId });
        break;
      }
      case "moveGuide": {
        const g = s.pages[s.page].guides.find((x) => x.id === cmd.id);
        if (g) g.at = cmd.at;
        break;
      }
      case "setGuideFrame": {
        const g = s.pages[s.page].guides.find((x) => x.id === cmd.id);
        if (g) {
          if (cmd.frameId) g.frameId = cmd.frameId;
          else delete g.frameId;
        }
        break;
      }
      case "removeGuide": {
        const pg = s.pages[s.page];
        pg.guides = pg.guides.filter((x) => x.id !== cmd.id);
        if (s.selectedGuide === cmd.id) s.selectedGuide = null;
        break;
      }
      case "makeComponent": {
        const ids = s.selection;
        if (!ids.length) break;
        if (ids.length > 1) {
          this.wrapSel("Component", {
            kind: "frame",
            isComponent: true,
            fill: "#00000000",
            fillVisible: false,
            overflow: "visible",
          });
        }
        const n = find(this.root(), s.selection[0]);
        if (!n) break;
        const cid = n.componentId || uid("comp");
        n.isComponent = true;
        n.componentId = cid;
        if (!n.name || n.name === "Group" || n.name === "Rectangle") n.name = "Component";
        const existing = s.components.find((c) => c.id === cid);
        if (existing) existing.node = clone(n);
        else
          s.components.push({
            id: cid,
            name: n.name,
            node: clone(n),
            variants: [{ name: "Default", node: clone(n) }],
            property: "Variant",
            properties: [{ id: uid("prop"), name: "Variant", type: "variant", defaultValue: "Default" }],
          });
        s.selection = [n.id];
        break;
      }
      case "addComponentProperty": {
        const lib = s.components.find((c) => c.id === cmd.componentId || c.node.id === cmd.componentId);
        if (!lib) break;
        if (!lib.properties) lib.properties = [];
        if (!lib.properties.some((p) => p.name === cmd.property.name)) {
          lib.properties.push(cmd.property);
        }
        break;
      }
      case "deleteComponentProperty": {
        const lib = s.components.find((c) => c.id === cmd.componentId || c.node.id === cmd.componentId);
        if (!lib || !lib.properties) break;
        lib.properties = lib.properties.filter((p) => p.id !== cmd.propId && p.name !== cmd.propId);
        break;
      }
      case "setCodeMapping": {
        const lib = s.components.find((c) => c.id === cmd.componentId || c.node.id === cmd.componentId);
        if (!lib) break;
        if (!lib.codeMappings) lib.codeMappings = [];
        const ix = lib.codeMappings.findIndex((m) => m.id === cmd.mapping.id);
        // A mapping edit invalidates the last sync check: the pointer is
        // new, so "verified against the master" no longer holds.
        const mapping = { ...cmd.mapping, syncedAt: undefined, syncHash: undefined };
        if (ix >= 0) lib.codeMappings[ix] = mapping;
        else lib.codeMappings.push(mapping);
        break;
      }
      case "deleteCodeMapping": {
        const lib = s.components.find((c) => c.id === cmd.componentId || c.node.id === cmd.componentId);
        if (!lib?.codeMappings) break;
        lib.codeMappings = lib.codeMappings.filter((m) => m.id !== cmd.mappingId);
        break;
      }
      case "syncCodeMapping": {
        const lib = s.components.find((c) => c.id === cmd.componentId || c.node.id === cmd.componentId);
        const mapping = lib?.codeMappings?.find((m) => m.id === cmd.mappingId);
        if (!lib || !mapping) break;
        mapping.syncedAt = Date.now();
        mapping.syncHash = computeMasterHash(lib);
        break;
      }
      case "setComponentProperty": {
        const n = find(this.root(), cmd.id);
        if (!n) break;
        if (!n.componentProperties) n.componentProperties = {};
        n.componentProperties[cmd.propName] = cmd.value;
        const lib = s.components.find((c) => c.id === n.componentId || c.node.id === n.componentId);
        const propDef = lib?.properties?.find((p) => p.name === cmd.propName);
        if (propDef) {
          if (propDef.type === "boolean" && propDef.targetNodeName) {
            const child = n.children.find((c) => c.name.toLowerCase() === propDef.targetNodeName?.toLowerCase());
            if (child) child.visible = Boolean(cmd.value);
          }
          if (propDef.type === "text" && propDef.targetNodeName) {
            const child = n.children.find((c) => c.name.toLowerCase() === propDef.targetNodeName?.toLowerCase() && c.kind === "text");
            if (child) child.text = String(cmd.value);
          }
          if (propDef.type === "instance-swap" && propDef.targetNodeName) {
            const child = n.children.find(
              (c) => c.name.toLowerCase() === propDef.targetNodeName?.toLowerCase() && !!c.componentId && !c.isComponent,
            );
            if (child) this.swapNodeToComponent(child, String(cmd.value));
          }
          if (propDef.type === "variant") {
            const v = lib?.variants?.find((x) => x.name === String(cmd.value));
            if (v) {
              const x = n.x;
              const y = n.y;
              const id = n.id;
              const props = clone(n.componentProperties);
              Object.assign(n, clone(v.node), {
                x,
                y,
                id,
                isComponent: n.isComponent,
                componentId: n.componentId,
                variant: String(cmd.value),
                componentProperties: props,
              });
            }
          }
        }
        break;
      }
      case "detachInstance": {
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (!n || (!n.componentId && n.kind !== "instance")) continue;
          n.isComponent = false;
          n.componentId = "";
        }
        break;
      }
      case "placeComponent": {
        const lib = s.components.find((c) => c.id === cmd.id || c.node.id === cmd.id);
        if (!lib) break;
        const copy = clone(lib.node);
        reid(copy);
        copy.x = cmd.x;
        copy.y = cmd.y;
        copy.isComponent = false;
        copy.componentId = lib.id;
        copy.name = lib.name;
        copy.componentProperties = {};
        for (const p of lib.properties ?? []) {
          copy.componentProperties[p.name] = p.defaultValue;
        }
        this.root().children.push(copy);
        s.selection = [copy.id];
        s.tool = "select";
        break;
      }
      case "addPath": {
        if (cmd.points.length < 2) break;
        const xs = cmd.points.map((p) => p.x);
        const ys = cmd.points.map((p) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        const path = cmd.points.map((p) => ({
          x: p.x - minX,
          y: p.y - minY,
          ix: p.ix,
          iy: p.iy,
          ox: p.ox,
          oy: p.oy,
        }));
        const keepTool = s.tool === "pen" || s.tool === "pencil" || s.tool === "brush";
        const n = node("vector", "Vector", minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY), {
          path,
          closed: cmd.closed,
          fill: cmd.closed ? "#d9d9d9" : "#00000000",
          fillVisible: cmd.closed,
          strokePaint: "#1e1e1e",
          strokeVisible: true,
          strokeWidth: s.tool === "brush" ? 8 : cmd.closed ? 1 : 2,
          vectorNetwork: pathToVectorNetwork(path, cmd.closed),
        });
        this.root().children.push(n);
        s.selection = [n.id];
        if (!keepTool) s.tool = "select";
        break;
      }
      case "patchPath": {
        const n = find(this.root(), cmd.id);
        if (!n || n.locked) break;
        n.path = cmd.path;
        if (cmd.closed != null) n.closed = cmd.closed;
        n.kind = "vector";
        n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        const pb = pathBounds(n.path, n.closed);
        n.w = pb.w;
        n.h = pb.h;
        break;
      }
      case "patchVectorNetwork": {
        const n = find(this.root(), cmd.id);
        if (!n || n.locked) break;
        n.vectorNetwork = cmd.network;
        n.kind = "vector";
        const res = vectorNetworkToPath(cmd.network);
        n.path = res.path;
        if (res.closed) n.closed = true;
        const xs = cmd.network.vertices.map((v) => v.x);
        const ys = cmd.network.vertices.map((v) => v.y);
        if (xs.length) {
          n.w = Math.max(1, Math.max(...xs) - Math.min(0, ...xs));
          n.h = Math.max(1, Math.max(...ys) - Math.min(0, ...ys));
        }
        break;
      }
      case "addVectorBranch": {
        const n = find(this.root(), cmd.id);
        if (!n || n.locked) break;
        const currentVn = n.vectorNetwork || pathToVectorNetwork(n.path, n.closed);
        const updated = addVectorBranch(
          currentVn,
          cmd.fromVertexIndex,
          cmd.to,
          cmd.tangentStart,
          cmd.tangentEnd,
        );
        n.vectorNetwork = updated;
        n.kind = "vector";
        let net = updated;
        const res = vectorNetworkToPath(updated);
        n.path = res.path;
        if (res.closed) n.closed = true;
        // Vertices are local to the node, and every other command keeps the
        // origin at the top-left of the geometry. Drawing a branch beyond the
        // old box must therefore move the origin and grow the frame, or the
        // path would reach outside a frame that still has the old size.
        const vxs = net.vertices.map((v) => v.x);
        const vys = net.vertices.map((v) => v.y);
        const minX = Math.min(0, ...vxs);
        const minY = Math.min(0, ...vys);
        if (minX < 0 || minY < 0) {
          const dx = minX < 0 ? -minX : 0;
          const dy = minY < 0 ? -minY : 0;
          net = {
            ...net,
            vertices: net.vertices.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
          };
          n.x -= dx;
          n.y -= dy;
          n.path = n.path.map((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy }));
          n.vectorNetwork = net;
        }
        const wxs = n.path.map((pt) => pt.x);
        const wys = n.path.map((pt) => pt.y);
        if (wxs.length) {
          n.w = Math.max(1, Math.max(...wxs) - Math.min(0, ...wxs));
          n.h = Math.max(1, Math.max(...wys) - Math.min(0, ...wys));
        }
        break;
      }
      case "bendSegment": {
        const n = find(this.root(), cmd.id);
        if (!n || n.locked || n.path.length < 2) break;
        n.path = bendSegment(n.path, cmd.segIndex, n.closed, cmd.dragX, cmd.dragY);
        n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        const pb = pathBounds(n.path, n.closed);
        n.w = pb.w;
        n.h = pb.h;
        break;
      }
      case "insertPointOnPath": {
        const n = find(this.root(), cmd.id);
        if (!n || n.locked || n.path.length < 2) break;
        const res = insertPointOnPath(n.path, cmd.x, cmd.y, n.closed);
        if (res) {
          n.path = res.newPath;
          n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        }
        break;
      }
      case "setPointMirror": {
        const n = find(this.root(), cmd.id);
        if (!n || !n.path[cmd.pointIndex]) break;
        const pt = n.path[cmd.pointIndex];
        pt.mirrorMode = cmd.mode;
        if (cmd.mode === "angleAndLength" && (pt.ox || pt.oy)) {
          pt.ix = -(pt.ox || 0);
          pt.iy = -(pt.oy || 0);
        }
        n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        break;
      }
      case "setPointCornerRadius": {
        const n = find(this.root(), cmd.id);
        if (!n || !n.path[cmd.pointIndex]) break;
        n.path[cmd.pointIndex].cornerRadius = Math.max(0, cmd.radius);
        n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        break;
      }
      case "setVecEdit": {
        if (s.vecEdit && (cmd.id == null || cmd.id !== s.vecEdit)) {
          const prev = find(this.root(), s.vecEdit);
          if (prev) normalizeVectorNode(prev);
        }
        s.vecEdit = cmd.id;
        s.vecPoint = cmd.pointIndex ?? null;
        s.vecPoints = cmd.pointIndices ?? (cmd.pointIndex != null ? [cmd.pointIndex] : []);
        break;
      }
      case "flatten": {
        if (s.selection.length > 1) {
          const selectedNodes = s.selection
            .map((id) => find(this.root(), id))
            .filter((n): n is XNode => !!n);
          if (selectedNodes.length >= 2) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const worldItems: { node: XNode; wp: { x: number; y: number } }[] = [];
            for (const sn of selectedNodes) {
              const wp = worldPos(this.root(), sn.id);
              if (!wp) continue;
              worldItems.push({ node: sn, wp });
              minX = Math.min(minX, wp.x);
              minY = Math.min(minY, wp.y);
              maxX = Math.max(maxX, wp.x + sn.w);
              maxY = Math.max(maxY, wp.y + sn.h);
            }

            if (isFinite(minX)) {
              const mergedVertices: any[] = [];
              const mergedSegments: any[] = [];
              const mergedLoops: number[][] = [];
              const mergedPath: PathPoint[] = [];

              let dominantFill = "#d9d9d9";
              let dominantStroke = "#000000";
              let dominantStrokeWidth = 0;

              for (const item of worldItems) {
                const { node: n, wp } = item;
                if (n.fill && n.fillVisible !== false) dominantFill = n.fill;
                if (n.strokePaint && n.strokeVisible && n.strokeWidth > 0) {
                  dominantStroke = n.strokePaint;
                  dominantStrokeWidth = n.strokeWidth;
                }

                let vn: any = null;
                if (n.kind === "text") {
                  const res = convertTextToVectorPaths(n.text, n.fontSize, n.fontFamily, String(n.fontWeight || "400"), n.w, n.h);
                  vn = res.network;
                } else if (n.kind === "boolean" && n.children.length) {
                  const baked = booleanPath(
                    n.booleanOp || "union",
                    n.children.map((c) => ({ poly: transformedPoly(c), ox: c.x, oy: c.y })),
                  );
                  if (baked?.network) vn = baked.network;
                  else if (baked?.path) vn = pathToVectorNetwork(baked.path, true);
                } else if (n.vectorNetwork && n.vectorNetwork.vertices.length) {
                  vn = n.vectorNetwork;
                } else {
                  const poly = n.path.length ? n.path : shapePoly(n);
                  vn = pathToVectorNetwork(poly, n.closed || (n.kind !== "line" && n.kind !== "arrow"));
                }

                if (vn && vn.vertices.length) {
                  const offsetStart = mergedVertices.length;
                  const dx = wp.x - minX;
                  const dy = wp.y - minY;

                  for (const v of vn.vertices) {
                    mergedVertices.push({
                      x: v.x + dx,
                      y: v.y + dy,
                      strokeCap: v.strokeCap,
                      strokeJoin: v.strokeJoin,
                      cornerRadius: v.cornerRadius,
                    });
                    mergedPath.push({ x: v.x + dx, y: v.y + dy, cornerRadius: v.cornerRadius });
                  }

                  for (const seg of vn.segments) {
                    mergedSegments.push({
                      start: offsetStart + seg.start,
                      end: offsetStart + seg.end,
                      tangentStart: seg.tangentStart ? { ...seg.tangentStart } : undefined,
                      tangentEnd: seg.tangentEnd ? { ...seg.tangentEnd } : undefined,
                    });
                  }

                  if (vn.regions) {
                    for (const reg of vn.regions) {
                      for (const loop of reg.loops) {
                        mergedLoops.push(loop.map((i: number) => offsetStart + i));
                      }
                    }
                  }
                }
              }

              const combinedW = Math.max(1, maxX - minX);
              const combinedH = Math.max(1, maxY - minY);
              const flatNode = node("vector", "Flattened Vector", minX, minY, combinedW, combinedH, {
                path: mergedPath,
                vectorNetwork: {
                  vertices: mergedVertices,
                  segments: mergedSegments,
                  regions: mergedLoops.length ? [{ windingRule: "EVENODD", loops: mergedLoops }] : undefined,
                },
                closed: true,
                fill: dominantFill,
                fillVisible: true,
                strokePaint: dominantStroke,
                strokeWidth: dominantStrokeWidth,
                strokeVisible: dominantStrokeWidth > 0,
              });

              const firstId = selectedNodes[0].id;
              const container = findParent(this.root(), firstId) || this.root();
              const firstIdx = container.children.findIndex((c) => c.id === firstId);
              const selSet = new Set(s.selection);
              container.children = container.children.filter((c) => !selSet.has(c.id));
              container.children.splice(Math.max(0, firstIdx), 0, flatNode);
              s.selection = [flatNode.id];
              break;
            }
          }
        }

        const id = s.selection[0];
        const n = id ? find(this.root(), id) : null;
        if (!n) break;
        if (n.kind === "text") {
          const res = convertTextToVectorPaths(n.text, n.fontSize, n.fontFamily, String(n.fontWeight || "400"), n.w, n.h);
          n.kind = "vector";
          n.path = res.path;
          n.vectorNetwork = res.network;
          n.closed = true;
          n.w = res.w;
          n.h = res.h;
        } else if (n.kind === "boolean" && n.children.length) {
          const baked = booleanPath(
            n.booleanOp || "union",
            n.children.map((c) => ({ poly: transformedPoly(c), ox: c.x, oy: c.y })),
          );
          if (baked) {
            n.path = baked.path;
            n.vectorNetwork = baked.network || pathToVectorNetwork(baked.path, true);
            n.closed = true;
            n.kind = "vector";
            n.children = [];
            n.booleanOp = null;
            n.x += baked.x;
            n.y += baked.y;
            n.w = baked.w;
            n.h = baked.h;
          }
        } else if (n.kind === "group" && n.children.length) {
          const childPaths: PathPoint[] = [];
          for (const c of n.children) {
            const poly = c.path.length ? c.path : shapePoly(c);
            childPaths.push(...poly.map((p) => ({ x: p.x + c.x, y: p.y + c.y })));
          }
          n.path = childPaths;
          n.vectorNetwork = pathToVectorNetwork(childPaths, true);
          n.kind = "vector";
          n.children = [];
        } else if (!n.path.length) {
          n.path = shapePoly(n);
          n.vectorNetwork = pathToVectorNetwork(n.path, n.closed || (n.kind !== "line" && n.kind !== "arrow"));
          n.closed = n.kind !== "line" && n.kind !== "arrow";
          n.kind = "vector";
        }
        break;
      }
      case "outlineStroke": {
        const targetIds = cmd.id ? [cmd.id] : [...s.selection];
        for (const id of targetIds) {
          const n = find(this.root(), id);
          if (!n) continue;
          if (n.kind === "text") {
            const res = convertTextToVectorPaths(n.text, n.fontSize, n.fontFamily, String(n.fontWeight || "400"), n.w, n.h);
            n.kind = "vector";
            n.path = res.path;
            n.vectorNetwork = res.network;
            n.closed = true;
            n.w = res.w;
            n.h = res.h;
            continue;
          }
          if (n.strokeWidth <= 0 && n.kind !== "line" && n.kind !== "arrow") continue;
          const sw = n.strokeWidth > 0 ? n.strokeWidth : 1;
          const src = n.path.length ? n.path : shapePoly(n);
          // An open vector outlines to a ribbon, not a ring: forcing closed
          // here used to bake a degenerate loop (the closing chord has no
          // width). Shape outlines from shapePoly are closed loops already.
          const isClosed = n.path.length ? n.closed : n.kind !== "line" && n.kind !== "arrow";
          if (usesVariableWidth(n)) {
            const baked = outlineVariableStroke(
              src,
              sw,
              n.strokeWidthProfile,
              isClosed,
              n.strokeCap || "round",
              n.strokeJoin || "round",
            );
            n.path = baked;
            n.vectorNetwork = pathToVectorNetwork(baked, true);
          } else {
            const out = outlineStrokeNetwork(src, sw, isClosed, n.strokeCap || "round", n.strokeJoin || "round");
            n.path = out.path;
            n.vectorNetwork = out.network;
          }
          n.kind = "vector";
          n.closed = true;
          n.fill = n.strokePaint || "#000000";
          n.fillVisible = true;
          n.fillOpacity = n.strokeOpacity ?? 1;
          n.strokeWidth = 0;
          n.strokeVisible = false;
          n.strokeWidthProfile = undefined;
        }
        break;
      }
      case "offsetPath": {
        const targetIds = cmd.id ? [cmd.id] : [...s.selection];
        for (const id of targetIds) {
          const n = find(this.root(), id);
          if (!n) continue;
          const src = n.path.length ? n.path : shapePoly(n);
          n.path = offsetPath(src, cmd.distance, n.closed || (n.kind !== "line" && n.kind !== "arrow"), cmd.join || "round");
          n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
          n.kind = "vector";
        }
        break;
      }
      case "simplifyPath": {
        const targetId = cmd.id || s.vecEdit || s.selection[0];
        const n = targetId ? find(this.root(), targetId) : null;
        if (!n || !n.path.length) break;
        const tol = cmd.tolerance ?? 1.5;
        n.path = simplifyPath(n.path, tol);
        n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        break;
      }
      case "vectorCleanup": {
        const targetId = cmd.id || s.vecEdit || s.selection[0];
        const n = targetId ? find(this.root(), targetId) : null;
        if (!n || !n.path.length) break;
        n.path = vectorCleanup(n.path, n.closed);
        n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        normalizeVectorNode(n);
        break;
      }
      case "convertTextToVector": {
        const targetId = cmd.id || s.selection[0];
        const n = targetId ? find(this.root(), targetId) : null;
        if (!n || n.kind !== "text") break;
        const res = convertTextToVectorPaths(n.text, n.fontSize, n.fontFamily, String(n.fontWeight || "400"), n.w, n.h);
        n.kind = "vector";
        n.path = res.path;
        n.vectorNetwork = res.network;
        n.closed = true;
        n.w = res.w;
        n.h = res.h;
        break;
      }
      case "shapeBuilder": {
        if (s.selection.length < 2) break;
        const [idA, idB] = s.selection;
        const na = find(this.root(), idA);
        const nb = find(this.root(), idB);
        if (!na || !nb) break;
        const polyA = na.path.length ? na.path : shapePoly(na);
        const polyB = nb.path.length ? nb.path : shapePoly(nb);
        const baked = booleanPath(
          cmd.op === "merge" ? "union" : "subtract",
          [
            { poly: polyA, ox: na.x, oy: na.y },
            { poly: polyB, ox: nb.x, oy: nb.y },
          ],
        );
        if (baked) {
          na.kind = "vector";
          na.path = baked.path;
          na.vectorNetwork = baked.network || pathToVectorNetwork(baked.path, true);
          na.x = baked.x;
          na.y = baked.y;
          na.w = baked.w;
          na.h = baked.h;
          na.closed = true;
          const parentB = findParent(this.root(), idB) || this.root();
          parentB.children = parentB.children.filter((c) => c.id !== idB);
          s.selection = [idA];
        }
        break;
      }
      case "vectorAlign": {
        const vecId = s.vecEdit || s.selection[0];
        const n = vecId ? find(this.root(), vecId) : null;
        if (!n || !n.path.length) break;
        const ptIndices = s.vecPoints && s.vecPoints.length > 0
          ? s.vecPoints
          : (s.vecPoint !== null && s.vecPoint !== undefined ? [s.vecPoint] : n.path.map((_, i) => i));
        if (ptIndices.length < 2) break;

        const selPts = ptIndices.map((i) => n.path[i]).filter(Boolean);
        const xs = selPts.map((p) => p.x);
        const ys = selPts.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const midX = (minX + maxX) / 2;
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const midY = (minY + maxY) / 2;

        for (const idx of ptIndices) {
          const pt = n.path[idx];
          if (!pt) continue;
          switch (cmd.alignment) {
            case "left": pt.x = minX; break;
            case "center": pt.x = midX; break;
            case "right": pt.x = maxX; break;
            case "top": pt.y = minY; break;
            case "middle": pt.y = midY; break;
            case "bottom": pt.y = maxY; break;
          }
        }
        n.vectorNetwork = pathToVectorNetwork(n.path, n.closed);
        break;
      }
      case "addVariant": {
        const n = s.selection[0] ? find(this.root(), s.selection[0]) : null;
        if (!n?.isComponent || !n.componentId) break;
        const lib = s.components.find((c) => c.id === n.componentId);
        if (!lib) break;
        const copy = clone(n);
        reid(copy);
        copy.isComponent = true;
        copy.componentId = n.componentId;
        copy.variant = cmd.name;
        copy.x = n.x + n.w + 40;
        copy.y = n.y;
        this.root().children.push(copy);
        lib.variants = lib.variants || [];
        lib.variants.push({ name: cmd.name, node: clone(copy) });
        s.selection = [copy.id];
        break;
      }
      case "setVariant": {
        const n = find(this.root(), cmd.id);
        if (!n?.componentId) break;
        const lib = s.components.find((c) => c.id === n.componentId);
        const v = lib?.variants?.find((x) => x.name === cmd.name);
        if (!v) break;
        const x = n.x;
        const y = n.y;
        const id = n.id;
        Object.assign(n, clone(v.node), {
          x,
          y,
          id,
          isComponent: n.isComponent,
          componentId: n.componentId,
          variant: cmd.name,
        });
        break;
      }
      case "resetOverrides": {
        const ids = cmd.id ? [cmd.id] : s.selection;
        for (const id of ids) {
          const n = find(this.root(), id);
          if (!n) continue;
          const cid = n.componentId;
          if (!cid && n.kind !== "instance") continue;
          const lib = s.components.find((c) => c.id === cid || c.node.id === cid);
          if (!lib) continue;
          if (cmd.property) {
            if (n.overrides) delete n.overrides[cmd.property];
            const masterVal = (lib.node as unknown as Record<string, unknown>)[cmd.property];
            if (masterVal !== undefined) {
              (n as unknown as Record<string, unknown>)[cmd.property] = clone(masterVal);
            }
            continue;
          }
          const x = n.x;
          const y = n.y;
          const copy = clone(lib.node);
          reid(copy);
          copy.x = x;
          copy.y = y;
          copy.id = n.id;
          copy.isComponent = false;
          copy.componentId = cid;
          copy.overrides = undefined;
          walk(copy, (c) => { c.overrides = undefined; });
          Object.assign(n, copy);
        }
        break;
      }
      case "setInteractions": {
        const n = find(this.root(), cmd.id);
        if (n) n.interactions = cmd.interactions;
        break;
      }
      case "addVariable": {
        s.variables.push(cmd.variable);
        this.ensureCollection(cmd.variable.collection);
        break;
      }
      case "patchVariable": {
        const v = s.variables.find((x) => x.id === cmd.id);
        if (v) {
          const { values, ...rest } = cmd.patch;
          // A type change invalidates every stored slot: keep the raw
          // values and bindings would silently mis-resolve, so reset to
          // the new type's fallback instead.
          if (rest.type && rest.type !== v.type) {
            v.value = fallbackForType(rest.type);
            v.values = {};
          }
          Object.assign(v, rest);
          // Per-mode values merge slot by slot; a wholesale replace would
          // wipe every other mode's overrides.
          if (values) v.values = { ...(v.values ?? {}), ...values };
          if (rest.collection) this.ensureCollection(rest.collection);
        }
        break;
      }
      case "deleteVariable": {
        s.variables = s.variables.filter((x) => x.id !== cmd.id);
        // Bindings and aliases pointing at the id stay in place and report
        // broken, so undo heals them instead of leaving silent gaps.
        break;
      }
      case "addCollection": {
        const name = cmd.name.trim();
        if (!name || s.variableCollections.some((c) => c.name === name)) break;
        const id = uid("col");
        s.variableCollections.push({ id, name, modes: [{ id: `${id}-mode-1`, name: "Default" }] });
        break;
      }
      case "renameCollection": {
        const c = s.variableCollections.find((x) => x.id === cmd.id);
        const name = cmd.name.trim();
        if (!c || !name) break;
        if (s.variableCollections.some((x) => x.id !== c.id && x.name === name)) break;
        for (const v of s.variables) if (v.collection === c.name) v.collection = name;
        c.name = name;
        break;
      }
      case "deleteCollection": {
        const c = s.variableCollections.find((x) => x.id === cmd.id);
        if (!c) break;
        s.variableCollections = s.variableCollections.filter((x) => x.id !== cmd.id);
        s.variables = s.variables.filter((v) => v.collection !== c.name);
        delete s.activeModes[cmd.id];
        break;
      }
      case "addMode": {
        const c = s.variableCollections.find((x) => x.id === cmd.collectionId);
        const name = cmd.name.trim();
        if (!c || !name || c.modes.some((m) => m.name === name)) break;
        c.modes.push({ id: uid("mode"), name });
        break;
      }
      case "renameMode": {
        const c = s.variableCollections.find((x) => x.id === cmd.collectionId);
        const m = c?.modes.find((x) => x.id === cmd.modeId);
        const name = cmd.name.trim();
        if (!c || !m || !name) break;
        if (c.modes.some((x) => x.id !== m.id && x.name === name)) break;
        m.name = name;
        break;
      }
      case "deleteMode": {
        const c = s.variableCollections.find((x) => x.id === cmd.collectionId);
        if (!c || c.modes.length <= 1) break;
        c.modes = c.modes.filter((m) => m.id !== cmd.modeId);
        for (const v of s.variables) {
          if (v.collection === c.name && v.values) delete v.values[cmd.modeId];
        }
        if (s.activeModes[c.id] === cmd.modeId) s.activeModes[c.id] = c.modes[0].id;
        break;
      }
      case "setActiveMode": {
        const c = s.variableCollections.find((x) => x.id === cmd.collectionId);
        if (!c || !c.modes.some((m) => m.id === cmd.modeId)) break;
        s.activeModes[c.id] = cmd.modeId;
        this.evaluateExpressionsInTree(this.root());
        break;
      }
      case "bindVariable": {
        const n = find(this.root(), cmd.id);
        const v = s.variables.find((x) => x.id === cmd.variableId);
        const need = BINDABLE_PROPS[cmd.prop];
        if (!n || !v || !need || v.type !== need) break;
        if ((cmd.prop === "text" || cmd.prop === "fontSize") && n.kind !== "text") break;
        if (cmd.prop === "cornerRadii" && !n.cornerRadii) break;
        if (!n.variableBindings) n.variableBindings = {};
        n.variableBindings[cmd.prop] = cmd.variableId;
        // Apply immediately so the canvas updates before the next relayout.
        const r = resolveVariable(s.variables, s.variableCollections, s.activeModes, cmd.variableId);
        if (r && !r.broken) applyBinding(n, cmd.prop, r.value);
        break;
      }
      case "unbindVariable": {
        const n = find(this.root(), cmd.id);
        if (n?.variableBindings) {
          delete n.variableBindings[cmd.prop];
          if (Object.keys(n.variableBindings).length === 0) delete n.variableBindings;
        }
        break;
      }
      case "swapInstance": {
        const n = find(this.root(), cmd.id);
        if (n) this.swapNodeToComponent(n, cmd.componentId);
        break;
      }
      case "addAnnotation": {
        s.annotations.push(cmd.annotation);
        break;
      }
      case "deleteAnnotation": {
        s.annotations = s.annotations.filter((x) => x.id !== cmd.id);
        break;
      }
      case "presentStart": {
        const frames = framesOf(this.root());
        const id =
          cmd.id ||
          s.pages[s.page].flowStart ||
          (s.selection[0] && find(this.root(), s.selection[0])?.kind === "frame" ? s.selection[0] : "") ||
          frames[0]?.id ||
          "";
        s.presentFrame = id;
        s.presentStack = id ? [id] : [];
        s.rightTab = "prototype";
        if (id) focusFrame(s, this.root(), id);
        break;
      }
      case "presentGo": {
        if (!cmd.id) break;
        let destId = cmd.id;
        const targetNode = find(this.root(), destId);
        if (targetNode && (targetNode.kind === "group" || targetNode.name.toLowerCase().includes("section"))) {
          const childFrame = targetNode.children.find((c) => c.kind === "frame");
          if (childFrame) destId = childFrame.id;
        }
        s.presentStack = [...s.presentStack, destId];
        s.presentFrame = destId;
        focusFrame(s, this.root(), destId);
        break;
      }
      case "presentBack": {
        if (s.presentStack.length > 1) {
          s.presentStack = s.presentStack.slice(0, -1);
          s.presentFrame = s.presentStack[s.presentStack.length - 1];
          focusFrame(s, this.root(), s.presentFrame);
        } else {
          s.presentFrame = "";
          s.presentStack = [];
        }
        break;
      }
      case "presentStop":
        s.presentFrame = "";
        s.presentStack = [];
        s.activeOverlay = null;
        break;
      case "setPrototypeDevice":
        s.prototypeDevice = cmd.device;
        break;
      case "setPrototypeOrientation":
        s.prototypeOrientation = cmd.orientation;
        break;
      case "setPrototypeScale":
        s.prototypeScale = cmd.scale;
        break;
      case "togglePrototypeHotspots":
        s.prototypeHotspots = cmd.enabled !== undefined ? cmd.enabled : !s.prototypeHotspots;
        break;
      case "togglePrototypeLiveInputs":
        s.prototypeLiveInputs = cmd.enabled !== undefined ? cmd.enabled : !s.prototypeLiveInputs;
        break;
      case "togglePrototypeSound":
        s.prototypeSound = cmd.enabled !== undefined ? cmd.enabled : !s.prototypeSound;
        break;
      case "openOverlay":
        s.activeOverlay = {
          id: cmd.id,
          position: cmd.position || "center",
          closeOutside: cmd.closeOutside !== false,
          backdrop: cmd.backdrop !== false,
          backdropColor: cmd.backdropColor || "rgba(0, 0, 0, 0.45)",
        };
        break;
      case "closeOverlay":
        s.activeOverlay = null;
        break;
      case "distribute": {
        const items = s.selection
          .map((id) => find(this.root(), id))
          .filter((n): n is XNode => !!n && !n.locked);
        if (items.length < 3) break;
        if (cmd.axis === "h") {
          items.sort((a, b) => a.x - b.x);
          const min = items[0].x;
          const max = items[items.length - 1].x + items[items.length - 1].w;
          const total = items.reduce((sum, n) => sum + n.w, 0);
          const gap = (max - min - total) / (items.length - 1);
          let cursor = min;
          for (const n of items) {
            n.x = cursor;
            cursor += n.w + gap;
          }
        } else {
          items.sort((a, b) => a.y - b.y);
          const min = items[0].y;
          const max = items[items.length - 1].y + items[items.length - 1].h;
          const total = items.reduce((sum, n) => sum + n.h, 0);
          const gap = (max - min - total) / (items.length - 1);
          let cursor = min;
          for (const n of items) {
            n.y = cursor;
            cursor += n.h + gap;
          }
        }
        break;
      }
      case "commitTransaction":
        this.dispatchTransaction(cmd.transaction);
        break;
      case "applyModifier": {
        const n = find(this.root(), cmd.id);
        if (n) {
          if (!n.modifiers) n.modifiers = [];
          n.modifiers.push(clone(cmd.modifier));
          this.evaluateNodeModifiers(n);
        }
        break;
      }
      case "removeModifier": {
        const n = find(this.root(), cmd.id);
        if (n && n.modifiers && cmd.index < n.modifiers.length) {
          n.modifiers.splice(cmd.index, 1);
          this.evaluateNodeModifiers(n);
        }
        break;
      }
      case "setExpression": {
        const n = find(this.root(), cmd.id);
        if (n) {
          if (!n.expressions) n.expressions = {};
          n.expressions[cmd.property] = cmd.expression;
          this.evaluateExpressionsInTree(this.root());
        }
        break;
      }
      case "removeExpression": {
        const n = find(this.root(), cmd.id);
        if (n && n.expressions) {
          delete n.expressions[cmd.property];
          this.evaluateExpressionsInTree(this.root());
        }
        break;
      }
    }
  }

  /** Collections are named buckets; a variable whose collection name has no
   *  entry (prototype-created, legacy, renamed file) gets one on demand so
   *  resolution and the panel never see an orphan. */
  private ensureCollection(name: string) {
    const s = this.state;
    if (!name.trim() || s.variableCollections.some((c) => c.name === name)) return;
    const id = uid("col");
    s.variableCollections.push({ id, name, modes: [{ id: `${id}-mode-1`, name: "Default" }] });
  }

  /** Replace an instance's content with another component's master, keeping
   *  its identity (id, position, name) and same-named property values. */
  private swapNodeToComponent(n: XNode, componentId: string) {
    const s = this.state;
    const lib = s.components.find((c) => c.id === componentId || c.node.id === componentId);
    if (!lib || n.isComponent || !n.componentId) return;
    const keepProps = clone(n.componentProperties ?? {});
    const fresh = clone(lib.node);
    reid(fresh);
    const props: Record<string, string | boolean> = {};
    for (const p of lib.properties ?? []) props[p.name] = keepProps[p.name] ?? p.defaultValue;
    Object.assign(n, fresh, {
      x: n.x,
      y: n.y,
      id: n.id,
      name: n.name,
      isComponent: false,
      componentId: lib.id,
      variant: undefined,
      componentProperties: props,
    });
  }

  private publishMaster(n: XNode) {
    if (!n.isComponent || !n.componentId) return;
    const lib = this.state.components.find((c) => c.id === n.componentId);
    if (lib) {
      lib.name = n.name;
      lib.node = clone(n);
    }
    syncInstances(this.state.pages, n);
  }

  private wrapSel(name: string, extra: Partial<XNode>) {
    const s = this.state;
    const ids = s.selection;
    if (ids.length < 1) return;
    const parent = findParent(this.root(), ids[0]);
    if (!parent) return;
    const nodes = parent.children.filter((c) => ids.includes(c.id));
    if (nodes.length !== ids.length) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...nodes.map((n) => n.y + n.h));
    const g = node(extra.kind ?? "group", name, minX, minY, maxX - minX, maxY - minY, extra);
    g.children = nodes.map((n) => {
      const c = clone(n);
      c.x -= minX;
      c.y -= minY;
      return c;
    });
    const firstIndex = parent.children.findIndex((c) => ids.includes(c.id));
    parent.children = parent.children.filter((c) => !ids.includes(c.id));
    parent.children.splice(Math.max(0, Math.min(firstIndex, parent.children.length)), 0, g);
    if (g.kind === "frame" && parent === this.root()) this.lastFrameSize = { w: g.w, h: g.h };
    s.selection = [g.id];
  }
}

function reid(n: XNode, ids?: Map<string, string>) {
  const old = n.id;
  n.id = uid(n.kind);
  ids?.set(old, n.id);
  n.children.forEach((c) => reid(c, ids));
}


function focusFrame(s: Internal, root: XNode, id: string) {
  const wp = worldPos(root, id);
  if (!wp) return;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const availW = Math.max(300, vw - 160);
  const availH = Math.max(300, vh - 160);
  const z = Math.min(1.0, Math.max(0.2, Math.min(availW / Math.max(wp.node.w, 1), availH / Math.max(wp.node.h, 1))));
  s.zoom = clampZoom(z);
  s.panX = Math.round((vw - wp.node.w * z) / 2 - wp.x * z);
  s.panY = Math.round((vh - wp.node.h * z) / 2 - wp.y * z);
}

function framesOf(root: XNode): XNode[] {
  const out: XNode[] = [];
  walk(root, (n) => {
    if (n !== root && n.kind === "frame") out.push(n);
  });
  return out;
}

function syncInstances(pages: Page[], master: XNode) {
  const cid = master.componentId;
  if (!cid) return;

  function syncNode(instNode: XNode, masterDef: XNode) {
    const x = instNode.x;
    const y = instNode.y;
    const id = instNode.id;
    const interactions = instNode.interactions;
    const localOverrides = instNode.overrides ? { ...instNode.overrides } : {};

    const masterKids = masterDef.children ?? [];
    const instKids = instNode.children ?? [];
    const syncedKids: XNode[] = [];

    for (let i = 0; i < masterKids.length; i++) {
      const mk = masterKids[i];
      if (i < instKids.length) {
        const ik = instKids[i];
        syncNode(ik, mk);
        syncedKids.push(ik);
      } else {
        const newKid = clone(mk);
        reid(newKid);
        syncedKids.push(newKid);
      }
    }

    const masterProps: Partial<XNode> = { ...masterDef };
    delete masterProps.id;
    delete masterProps.children;

    Object.assign(instNode, masterProps, {
      x,
      y,
      id,
      interactions,
      isComponent: false,
      componentId: cid,
      children: syncedKids,
      overrides: localOverrides,
      ...localOverrides,
    });
  }

  for (const page of pages) {
    walk(page.root, (n) => {
      if (n === master) return;
      if (n.componentId !== cid || n.isComponent) return;
      syncNode(n, master);
    });
  }
}

/**
 * Is "snap to pixel grid" (View menu / Shift+Cmd+') switched on for this
 * page? It is a *drawing* behaviour — objects are rounded to whole pixels as
 * they are created, moved and resized — and is separate from the pixel-grid
 * *overlay*, which is only a ruler-grade guide drawn above 400% zoom. The two
 * used to be the same flag here, which meant the overlay's default of off
 * silently disabled snapping for everyone.
 */
function snapOn(s: { pages: Page[]; page: number }, index: number): boolean {
  return s.pages[index]?.pixelSnap ?? true;
}

/**
 * Default name for a new layer: the kind, then the lowest number that
 * is not already taken in the page. "Frame" for every frame - which is what
 * this used to do - makes the Layers list and the names on the canvas
 * indistinguishable the moment there are two of them.
 */
function freshLabel(root: XNode, k: NodeKind): string {
  const base = labelFor(k);
  const taken = new Set<string>();
  const walk = (n: XNode) => {
    taken.add(n.name);
    for (const c of n.children) walk(c);
  };
  walk(root);
  // Always numbered, even the first: first frame is "Frame 1", not
  // "Frame", so a document's names never change shape as it grows.
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

function labelFor(k: NodeKind): string {
  switch (k) {
    case "frame":
      return "Frame";
    case "rect":
      return "Rectangle";
    case "ellipse":
      return "Ellipse";
    case "text":
      return "Text";
    case "line":
      return "Line";
    case "arrow":
      return "Arrow";
    case "poly":
      return "Polygon";
    case "star":
      return "Star";
    case "vector":
      return "Vector";
    case "boolean":
      return "Boolean";
    case "component":
      return "Component";
    case "instance":
      return "Instance";
    default:
      return "Layer";
  }
}

export function flatten(root: XNode): XNode[] {
  const out: XNode[] = [];
  walk(root, (n) => {
    if (n !== root) out.push(n);
  });
  return out;
}

export function worldPos(
  root: XNode,
  id: string,
): { x: number; y: number; node: XNode } | null {
  let accX = 0;
  let accY = 0;
  let found: XNode | null = null;
  const visit = (n: XNode, px: number, py: number) => {
    const x = px + n.x;
    const y = py + n.y;
    if (n.id === id) {
      found = n;
      accX = x;
      accY = y;
      return true;
    }
    for (const c of n.children) {
      if (visit(c, x, y)) return true;
    }
    return false;
  };
  // page root is a virtual frame at 0,0 — children carry world coords relative to it
  for (const c of root.children) {
    if (visit(c, 0, 0)) break;
  }
  return found ? { x: accX, y: accY, node: found } : null;
}

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(a: Matrix, b: Matrix): Matrix {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

function applyMatrix(m: Matrix, x: number, y: number) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

function inverse(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

function nodeMatrix(n: XNode): Matrix {
  const cx = n.w / 2;
  const cy = n.h / 2;
  const angle = (n.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local: Matrix = {
    a: cos * (n.flipH ? -1 : 1),
    b: sin * (n.flipH ? -1 : 1),
    c: -sin * (n.flipV ? -1 : 1),
    d: cos * (n.flipV ? -1 : 1),
    e: 0,
    f: 0,
  };
  const translate = (x: number, y: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  return multiply(
    translate(n.x + cx, n.y + cy),
    multiply(local, translate(-cx, -cy)),
  );
}

function worldMatrix(root: XNode, id: string): Matrix | null {
  let result: Matrix | null = null;
  const visit = (n: XNode, parent: Matrix) => {
    if (result) return;
    const world = n === root ? parent : multiply(parent, nodeMatrix(n));
    if (n.id === id) {
      result = world;
      return;
    }
    for (const child of n.children) visit(child, world);
  };
  visit(root, IDENTITY);
  return result;
}

/**
 * Boolean live preview, in page coordinates.
 *
 * Runs the same `booleanPath` the `boolean` command bakes, over the same
 * inputs (`transformedPoly` + node offsets), without touching the document.
 * Returns null unless the selection is exactly what the command would act
 * on: 2+ same-parent, non-frame nodes. Operand order is selection order, so
 * the overlay is the result the Apply button would commit.
 */
export function previewBoolean(
  op: BooleanOp,
  root: XNode,
  ids: string[],
): { path: PathPoint[]; x: number; y: number; w: number; h: number } | null {
  if (ids.length < 2) return null;
  const nodes = ids.map((id) => find(root, id)).filter((n): n is XNode => !!n && n.kind !== "frame");
  if (nodes.length < 2) return null;
  const parent = findParent(root, nodes[0].id);
  if (!parent || !nodes.every((n) => findParent(root, n.id) === parent)) return null;
  const baked = booleanPath(
    op,
    nodes.map((c) => ({ poly: transformedPoly(c), ox: c.x, oy: c.y })),
  );
  if (!baked) return null;
  // `boolean` wraps the selection in a group first, so its baked path is
  // group-relative; the preview adds the parent chain offset instead.
  const pw = worldPos(root, parent.id);
  const ox = pw ? pw.x : 0;
  const oy = pw ? pw.y : 0;
  return { path: baked.path, x: baked.x + ox, y: baked.y + oy, w: baked.w, h: baked.h };
}

/** Convert a point in page coordinates into a node's local coordinate system. */
export function worldToLocal(root: XNode, id: string, x: number, y: number) {
  const m = worldMatrix(root, id);
  return applyMatrix(m ? inverse(m) ?? IDENTITY : IDENTITY, x, y);
}

/** Convert a point in a node's local coordinate system into page coordinates. */
export function localToWorld(root: XNode, id: string, x: number, y: number) {
  const m = worldMatrix(root, id);
  return applyMatrix(m ?? IDENTITY, x, y);
}

function polygonHit(poly: PathPoint[], px: number, py: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y || 1e-9) + a.x) hit = !hit;
  }
  return hit;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function nodeShapeHit(n: XNode, px: number, py: number): boolean {
  if (n.kind === "ellipse") {
    const dx = (px - n.w / 2) / Math.max(1, n.w / 2);
    const dy = (py - n.h / 2) / Math.max(1, n.h / 2);
    const d = dx * dx + dy * dy;
    return n.fillVisible !== false && !n.fill.startsWith("#00000000") ? d <= 1 : Math.abs(Math.sqrt(d) - 1) <= Math.max(4, n.strokeWidth / 2);
  }
  if (n.kind === "line" || n.kind === "arrow") {
    return (
      segmentDistance(px, py, 0, n.h / 2, n.w, n.h / 2) <=
      Math.max(12, ((n.strokeWidth || 1) * maxWidthMultiplier(n.strokeWidthProfile)) / 2 + 4)
    );
  }
  if (n.kind === "vector" || n.kind === "boolean") {
    const rawPoly = n.path.length ? n.path : shapePoly(n);
    const isClosed = n.closed || (n.vectorNetwork?.regions?.length ?? 0) > 0;
    const poly = samplePathPoints(rawPoly, isClosed);
    if (isClosed) {
      if (n.fillVisible !== false && !n.fill.startsWith("#00000000") && n.fill !== "#00000000") {
        if (polygonHit(poly as any, px, py)) return true;
      }
      // Also allow selecting by clicking near stroke even when closed
      const strokeTol = Math.max(6, ((n.strokeWidth || 1) * maxWidthMultiplier(n.strokeWidthProfile)) / 2 + 3);
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i] as any;
        const b = poly[(i + 1) % poly.length] as any;
        if (!isClosed && i === poly.length - 1) break;
        if (segmentDistance(px, py, a.x, a.y, b.x, b.y) <= strokeTol) return true;
      }
      if (isClosed) return false;
    } else if (poly.length >= 2) {
      const strokeTol = Math.max(6, ((n.strokeWidth || 1) * maxWidthMultiplier(n.strokeWidthProfile)) / 2 + 4);
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i] as any;
        const b = poly[i + 1] as any;
        if (segmentDistance(px, py, a.x, a.y, b.x, b.y) <= strokeTol) return true;
      }
      return false;
    }
  }
  if ((n.kind === "poly" || n.kind === "star") && n.closed) {
    return polygonHit(shapePoly(n), px, py);
  }
  if ((n.kind === "poly" || n.kind === "star") && !n.closed) {
    const poly = shapePoly(n);
    const strokeTol = Math.max(6, (n.strokeWidth || 1) / 2 + 4);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as any;
      const b = poly[(i + 1) % poly.length] as any;
      if (segmentDistance(px, py, a.x, a.y, b.x, b.y) <= strokeTol) return true;
    }
    return false;
  }
  return px >= 0 && py >= 0 && px <= n.w && py <= n.h;
}

export function hitTest(
  root: XNode,
  wx: number,
  wy: number,
  opts?: { deep?: boolean; selection?: string[]; includeLocked?: boolean },
): XNode | null {
  let hit: XNode | null = null;
  const visit = (n: XNode, parentWorld: Matrix) => {
    if (!n.visible || (n.locked && !opts?.includeLocked)) return;
    const world = n === root ? parentWorld : multiply(parentWorld, nodeMatrix(n));
    const local = n === root ? { x: wx, y: wy } : applyMatrix(inverse(world) ?? IDENTITY, wx, wy);
    const inside =
      n === root ||
      (local.x >= 0 && local.y >= 0 && local.x <= n.w && local.y <= n.h);
    if (n === root || n.overflow === "visible" || inside) {
      for (let i = n.children.length - 1; i >= 0; i--) visit(n.children[i], world);
    }
    if (n === root || !inside || !nodeShapeHit(n, local.x, local.y) || hit) return;
    hit = n;
  };
  visit(root, IDENTITY);
  if (!hit || opts?.deep) return hit;
  // A plain click always lands on the group/boolean, even when that parent is
  // already selected: drilling in is double-click's and Enter's job, never a
  // single click's. Frames stay transparent, as in Figma.
  let n: XNode | null = hit;
  while (n) {
    const p = findParent(root, n.id);
    if (!p || p === root) break;
    if (p.kind === "group" || p.kind === "boolean") {
      n = p;
      continue;
    }
    break;
  }
  return n;
}

function applyConstraints(parent: XNode, oldW: number, oldH: number, newW: number, newH: number) {
  const dw = newW - oldW;
  const dh = newH - oldH;
  if (!dw && !dh) return;
  for (const c of parent.children) {
    const h = c.constraintH;
    const v = c.constraintV;
    const cw = c.w;
    const ch = c.h;
    if (h === "max") c.x += dw;
    else if (h === "center") c.x += dw / 2;
    else if (h === "stretch") c.w = Math.max(1, c.w + dw);
    else if (h === "scale" && oldW > 0) {
      c.x *= newW / oldW;
      c.w = Math.max(1, c.w * (newW / oldW));
    }
    if (v === "max") c.y += dh;
    else if (v === "center") c.y += dh / 2;
    else if (v === "stretch") c.h = Math.max(1, c.h + dh);
    else if (v === "scale" && oldH > 0) {
      c.y *= newH / oldH;
      c.h = Math.max(1, c.h * (newH / oldH));
    }
    // A resized child is a resized parent for its own subtree: stretch /
    // scale must cascade, not stop at the first level.
    if ((c.w !== cw || c.h !== ch) && c.children.length) {
      applyConstraints(c, cw, ch, c.w, c.h);
    }
  }
}

function scaleProps(n: XNode, sx: number, sy: number) {
  const s = (Math.abs(sx) + Math.abs(sy)) / 2;
  n.strokeWidth *= s;
  n.strokeDash *= s;
  n.strokeGap *= s;
  // A dashed outline keeps its rhythm when the layer is scaled, and so do the
  // per-side weights. Smoothing is a ratio rather than a length, so it stays put.
  if (n.strokeDashPattern?.length) n.strokeDashPattern = n.strokeDashPattern.map((v) => v * s);
  if (n.strokeSideW) n.strokeSideW = n.strokeSideW.map((v) => v * s) as [number, number, number, number];
  n.fontSize *= s;
  n.letterSpacing *= s;
  n.paragraphSpacing *= s;
  n.paragraphIndent *= s;
  if (n.lineHeight) n.lineHeight *= s;
  // Auto layout limits travel with the box, or a shrunk layer would still refuse
  // to grow past the minimum it had before scaling.
  for (const key of ["minW", "maxW", "minH", "maxH"] as const) {
    const v = n[key];
    if (v) n[key] = v * s;
  }
  n.cornerRadii = n.cornerRadii.map((r) => r * s) as [number, number, number, number];
  if (n.strokes) {
    for (const st of n.strokes) {
      st.width *= s;
      // Extra strokes used to keep their dash and side weights unscaled,
      // which left them visibly wrong against the scaled outline.
      if (st.dash) st.dash *= s;
      if (st.gap) st.gap *= s;
      if (st.pattern?.length) st.pattern = st.pattern.map((v) => v * s);
      if (st.sideW) st.sideW = st.sideW.map((v) => v * s) as [number, number, number, number];
    }
  }
  if (n.effects) {
    for (const ef of n.effects) {
      if (ef.x != null) ef.x *= s;
      if (ef.y != null) ef.y *= s;
      if (ef.blur != null) ef.blur *= s;
      if (ef.spread != null) ef.spread *= s;
    }
  }
  n.path = n.path.map((p) => ({
    ...p,
    x: p.x * sx,
    y: p.y * sy,
    ix: p.ix == null ? p.ix : p.ix * sx,
    iy: p.iy == null ? p.iy : p.iy * sy,
    ox: p.ox == null ? p.ox : p.ox * sx,
    oy: p.oy == null ? p.oy : p.oy * sy,
  }));
  if (n.layout) {
    n.layout = {
      ...n.layout,
      gap: n.layout.gap * s,
      padding: n.layout.padding.map((p) => p * s) as [number, number, number, number],
    };
  }
  for (const c of n.children) {
    c.x *= sx;
    c.y *= sy;
    c.w = Math.max(1, c.w * sx);
    c.h = Math.max(1, c.h * sy);
    scaleProps(c, sx, sy);
  }
}

export function deepestFrame(root: XNode, wx: number, wy: number, skip?: Set<string>): XNode | null {
  let hit: XNode | null = null;
  const visit = (n: XNode, parentWorld: Matrix) => {
    if (!n.visible || skip?.has(n.id)) return;
    const world = n === root ? parentWorld : multiply(parentWorld, nodeMatrix(n));
    const local = n === root ? { x: wx, y: wy } : applyMatrix(inverse(world) ?? IDENTITY, wx, wy);
    const inside = n === root || (local.x >= 0 && local.y >= 0 && local.x <= n.w && local.y <= n.h);
    if (n !== root && n.kind === "frame" && inside) hit = n;
    if (inside || n === root) {
      for (const c of n.children) visit(c, world);
    }
  };
  visit(root, IDENTITY);
  return hit;
}

export { find, findParent, framesOf };

export function collectColors(root: XNode): string[] {
  const out: string[] = [];
  walk(root, (n) => {
    if (n.fillVisible && n.fill && n.fill !== "#00000000") out.push(n.fill.slice(0, 7));
    if (n.strokeVisible && n.strokePaint && n.strokePaint !== "#00000000")
      out.push(n.strokePaint.slice(0, 7));
  });
  return out;
}

export function defaultEffect(kind: Effect["kind"]): Effect {
  const shadow = kind === "drop-shadow" || kind === "inner-shadow";
  return {
    kind,
    color: shadow
      ? "#00000040"
      : kind === "glass"
        ? "#ffffff80"
        : kind === "texture"
          ? "#00000020"
          : "#000000",
    x: 0,
    y: shadow ? 4 : 0,
    blur:
      kind === "noise"
        ? 40
        : kind === "texture"
          ? 16
          : kind === "glass" || kind.includes("blur")
            ? 12
            : shadow
              ? 4
              : 4,
    spread: kind === "texture" ? 4 : 0,
    visible: true,
    blend: "Normal",
    // Checkbox starts unchecked, and only a drop shadow has one.
    ...(kind === "drop-shadow" ? { showBehind: false } : {}),
  };
}

/* The default auto layout frame lives in `layout.ts` with the rest of the
 * auto layout rules; this re-export keeps the existing imports working. */
export { defaultLayout } from "./layout";