import type {
  AutoLayout,
  Command,
  ComponentMaster,
  Effect,
  Engine,
  NodeKind,
  Page,
  PathPoint,
  Snapshot,
  Tool,
  XNode,
} from "./types";
import { booleanPath, outlineStroke as outlineStrokePath, shapePoly, transformedPoly } from "./geometry";

let seq = 1;
const uid = (p: string) => `${p}_${seq++}`;

function node(
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
    strokeAlign: "inside",
    strokeDash: 0,
    strokeGap: 0,
    strokeCap: kind === "arrow" ? "arrow" : "none",
    strokeJoin: "miter",
    opacity: 1,
    visible: true,
    locked: false,
    overflow: kind === "frame" ? "clip" : "visible",
    cornerRadii: [0, 0, 0, 0],
    cornerIndependent: false,
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

function applyLayout(n: XNode) {
  for (const c of n.children) applyLayout(c);
  const l = n.layout;
  if (!l) {
    if (n.children.length && (n.sizingW === "hug" || n.sizingH === "hug")) {
      const vis = n.children.filter((c) => c.visible);
      if (vis.length) {
        if (n.sizingW === "hug") n.w = Math.max(1, Math.max(...vis.map((c) => c.x + c.w)));
        if (n.sizingH === "hug") n.h = Math.max(1, Math.max(...vis.map((c) => c.y + c.h)));
      }
    }
    return;
  }
  const flow = n.children.filter((c) => c.visible);
  const [pl, pr, pt, pb] = l.padding;
  const horiz = l.direction === "horizontal";
  const gap = l.gap;
  const innerW = n.w - pl - pr;
  const innerH = n.h - pt - pb;
  const fillers = flow.filter((c) => (horiz ? c.sizingW : c.sizingH) === "fill");
  if (fillers.length) {
    const used = flow.reduce(
      (s, c) => s + ((horiz ? c.sizingW : c.sizingH) === "fill" ? 0 : horiz ? c.w : c.h),
      0,
    );
    const leftover = Math.max(1, (horiz ? innerW : innerH) - used - gap * Math.max(0, flow.length - 1));
    const each = leftover / fillers.length;
    for (const c of fillers) {
      if (horiz) c.w = Math.max(1, each);
      else c.h = Math.max(1, each);
    }
  }
  if (l.wrap && flow.length) {
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
    if (l.sizing === "hug" || n.sizingW === "hug" || n.sizingH === "hug") {
      if (horiz) n.w = Math.max(n.w, x + pr);
      else n.h = Math.max(n.h, y + pb);
    }
    if (l.cross === "hug") {
      if (horiz) n.h = y + rowH + pb;
      else n.w = x + rowW + pr;
    }
    return;
  }
  const mainTotal = flow.reduce((s, c) => s + (horiz ? c.w : c.h), 0) + gap * Math.max(0, flow.length - 1);
  let origin = horiz ? pl : pt;
  if (l.justify === "center") origin += Math.max(0, (horiz ? innerW : innerH) - mainTotal) / 2;
  if (l.justify === "max") origin += Math.max(0, (horiz ? innerW : innerH) - mainTotal);
  const free = Math.max(0, (horiz ? innerW : innerH) - flow.reduce((s, c) => s + (horiz ? c.w : c.h), 0));
  const between = l.justify === "between" && flow.length > 1 ? free / (flow.length - 1) : gap;
  let cursor = origin;
  let crossMax = 0;
  for (let i = 0; i < flow.length; i++) {
    const c = flow[i];
    if (horiz) {
      c.x = cursor;
      const extra = innerH - c.h;
      c.y = pt + (l.align === "center" ? extra / 2 : l.align === "max" ? extra : 0);
      cursor += c.w + (i < flow.length - 1 ? between : 0);
      crossMax = Math.max(crossMax, c.h);
    } else {
      c.y = cursor;
      const extra = innerW - c.w;
      c.x = pl + (l.align === "center" ? extra / 2 : l.align === "max" ? extra : 0);
      cursor += c.h + (i < flow.length - 1 ? between : 0);
      crossMax = Math.max(crossMax, c.w);
    }
  }
  if (l.sizing === "hug" || n.sizingW === "hug") {
    if (horiz) n.w = pl + mainTotal + pr;
  }
  if (l.sizing === "hug" || n.sizingH === "hug") {
    if (!horiz) n.h = pt + mainTotal + pb;
  }
  if (l.cross === "hug") {
    if (horiz) n.h = crossMax + pt + pb;
    else n.w = crossMax + pl + pr;
  }
}

function demoPage(): Page {
  const title = node("text", "Title", 24, 28, 300, 32, {
    text: "Product card",
    fontSize: 24,
    fontWeight: 600,
    fill: "#0d1220",
  });
  const body = node("text", "Body", 24, 68, 300, 40, {
    text: "Auto layout, clip, and type — same model as x-core.",
    fontSize: 13,
    fill: "#5a5f6b",
  });
  const pill = node("rect", "Chip", 0, 0, 72, 28, {
    fill: "#6b49f5",
    cornerRadii: [14, 14, 14, 14],
  });
  const pillLabel = node("text", "Label", 14, 6, 48, 16, {
    text: "Ship",
    fontSize: 12,
    fontWeight: 600,
    fill: "#ffffff",
  });
  pill.children = [pillLabel];
  const card = node("frame", "Card", 24, 128, 342, 160, {
    fill: "#f7f8fa",
    cornerRadii: [16, 16, 16, 16],
    overflow: "clip",
    layout: {
      direction: "vertical",
      gap: 8,
      padding: [16, 16, 16, 16],
      sizing: "fixed",
      cross: "fixed",
      wrap: false,
      align: "min",
      justify: "min",
    },
  });
  const cardTitle = node("text", "Heading", 0, 0, 300, 22, {
    text: "Frame with clip",
    fontSize: 16,
    fontWeight: 600,
    fill: "#0d1220",
  });
  const cardBody = node("text", "Note", 0, 0, 300, 36, {
    text: "Children that overflow are clipped when Clip content is on.",
    fontSize: 12,
    fill: "#5a5f6b",
  });
  card.children = [cardTitle, cardBody, pill];
  const phone = node("frame", "iPhone 14", 80, 60, 390, 844, {
    fill: "#ffffff",
    cornerRadii: [32, 32, 32, 32],
    overflow: "clip",
    children: [title, body, card],
  });
  const back = node("text", "Back", 24, 28, 120, 24, {
    text: "← Back",
    fontSize: 16,
    fontWeight: 600,
    fill: "#0d70f6",
    interactions: [{ trigger: "onClick", action: "back", destination: "", animation: "instant", delay: 0 }],
  });
  const done = node("text", "Done", 24, 80, 320, 40, {
    text: "Second screen — Esc or Back.",
    fontSize: 20,
    fontWeight: 600,
    fill: "#0d1220",
  });
  const screen2 = node("frame", "Success", 520, 60, 390, 844, {
    fill: "#ffffff",
    cornerRadii: [32, 32, 32, 32],
    overflow: "clip",
    children: [back, done],
  });
  pill.interactions = [
    { trigger: "onClick", action: "navigate", destination: screen2.id, animation: "instant", delay: 0 },
  ];
  const pageRoot = node("frame", "Page 1", 0, 0, 1200, 800, {
    fill: "#00000000",
    overflow: "visible",
    children: [phone, screen2],
  });
  applyLayout(phone);
  applyLayout(card);
  return {
    id: uid("page"),
    name: "Page 1",
    root: pageRoot,
    pixelGrid: false,
    pixelGridColor: "#cccccc",
    flowStart: phone.id,
  };
}

interface Internal {
  fileName: string;
  pages: Page[];
  page: number;
  selection: string[];
  tool: Tool;
  zoom: number;
  panX: number;
  panY: number;
  rightTab: Snapshot["rightTab"];
  leftTab: Snapshot["leftTab"];
  components: ComponentMaster[];
  presentFrame: string;
  presentStack: string[];
  showRulers: boolean;
}

/** Cap the undo stack. Each entry is a full document clone, so an unbounded
 *  stack grows memory without limit during a long editing session. */
const MAX_UNDO = 200;

/** Commands whose rapid repeats collapse into a single undo step. Only
 *  incremental, self-repeating gestures belong here — structural edits must
 *  always get their own entry. */
const COALESCABLE = new Set<string>(["nudge", "move", "resize"]);

export class MemoryEngine implements Engine {
  private state: Internal;
  private undo: Internal[] = [];
  private redo: Internal[] = [];
  private listeners = new Set<() => void>();
  private snapCache: Snapshot;
  private grouping = false;
  /** Last history-pushing command type and its timestamp, used to coalesce
   *  rapid repeats of the same command (e.g. holding an arrow key) into a
   *  single undo step, as Figma does. */
  private lastHist: { type: string; at: number } | null = null;
  private clip: XNode[] = [];

  constructor() {
    this.state = {
      fileName: "Untitled",
      pages: [demoPage()],
      page: 0,
      selection: [],
      tool: "select",
      zoom: 0.75,
      panX: 40,
      panY: 20,
      rightTab: "design",
      leftTab: "layers",
      components: [],
      presentFrame: "",
      presentStack: [],
      showRulers: false,
    };
    this.relayout();
    this.snapCache = this.build();
  }

  snapshot(): Snapshot {
    return this.snapCache;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(cmd: Command): void {
    if (cmd.type === "begin") {
      this.undo.push(clone(this.state));
      this.redo = [];
      this.grouping = true;
      return;
    }
    if (cmd.type === "end") {
      this.grouping = false;
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
      "presentGo",
      "presentBack",
      "presentStart",
      "presentStop",
    ].includes(cmd.type);
    if (hist && !this.grouping) {
      // Coalesce a burst of identical commands (arrow-key nudges, repeated
      // resize steps) into one undo entry so a single undo reverses the whole
      // gesture instead of one keypress at a time.
      const now = Date.now();
      const COALESCE_MS = 600;
      const repeat =
        COALESCABLE.has(cmd.type) &&
        this.lastHist !== null &&
        this.lastHist.type === cmd.type &&
        now - this.lastHist.at < COALESCE_MS;
      if (!repeat) {
        this.undo.push(clone(this.state));
        if (this.undo.length > MAX_UNDO) this.undo.shift();
      }
      this.redo = [];
      this.lastHist = { type: cmd.type, at: now };
    } else if (!hist && cmd.type !== "undo" && cmd.type !== "redo") {
      // A non-history command (select, zoom, ...) ends the current burst.
      this.lastHist = null;
    }
    this.apply(cmd);
    this.relayout();
    this.snapCache = this.build();
    this.listeners.forEach((f) => f());
  }

  private root(): XNode {
    return this.state.pages[this.state.page].root;
  }

  private relayout() {
    applyLayout(this.root());
  }

  private build(): Snapshot {
    return {
      fileName: this.state.fileName,
      pages: this.state.pages,
      page: this.state.page,
      selection: this.state.selection,
      tool: this.state.tool,
      zoom: this.state.zoom,
      panX: this.state.panX,
      panY: this.state.panY,
      rightTab: this.state.rightTab,
      leftTab: this.state.leftTab,
      canUndo: this.undo.length > 0,
      canRedo: this.redo.length > 0,
      components: this.state.components,
      showRulers: this.state.showRulers,
      presentFrame: this.state.presentFrame,
      presentStack: this.state.presentStack,
    };
  }

  private apply(cmd: Command) {
    const s = this.state;
    switch (cmd.type) {
      case "select":
        s.selection = cmd.ids;
        break;
      case "setTool":
        s.tool = cmd.tool;
        break;
      case "setZoom":
        s.zoom = Math.min(8, Math.max(0.1, cmd.zoom));
        break;
      case "pan":
        s.panX += cmd.dx;
        s.panY += cmd.dy;
        break;
      case "setPan":
        s.panX = cmd.x;
        s.panY = cmd.y;
        break;
      case "toggleRulers":
        s.showRulers = !s.showRulers;
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
        p.flowStart = "";
        s.pages.push(p);
        s.page = s.pages.length - 1;
        s.selection = [];
        break;
      }
      case "add": {
        const grid = s.pages[s.page].pixelGrid;
        const n = node(
          cmd.kind,
          labelFor(cmd.kind),
          grid ? Math.round(cmd.x) : cmd.x,
          grid ? Math.round(cmd.y) : cmd.y,
          grid ? Math.max(1, Math.round(cmd.w)) : cmd.w,
          grid ? Math.max(1, Math.round(cmd.h)) : cmd.h,
          cmd.extra,
        );
        const parent = cmd.parent ? find(this.root(), cmd.parent) : this.root();
        (parent ?? this.root()).children.push(n);
        s.selection = [n.id];
        if (cmd.kind === "text" || cmd.extra?.imageSrc) s.tool = "select";
        break;
      }
      case "move":
        for (const id of cmd.ids) {
          const n = find(this.root(), id);
          if (n && !n.locked) {
            n.x += cmd.dx;
            n.y += cmd.dy;
            if (s.pages[s.page].pixelGrid) {
              n.x = Math.round(n.x);
              n.y = Math.round(n.y);
            }
          }
        }
        break;
      case "nudge":
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (n && !n.locked) {
            n.x += cmd.dx;
            n.y += cmd.dy;
            if (s.pages[s.page].pixelGrid) {
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
          n.x = s.pages[s.page].pixelGrid ? Math.round(cmd.x) : cmd.x;
          n.y = s.pages[s.page].pixelGrid ? Math.round(cmd.y) : cmd.y;
          n.w = Math.max(1, s.pages[s.page].pixelGrid ? Math.round(cmd.w) : cmd.w);
          n.h = Math.max(1, s.pages[s.page].pixelGrid ? Math.round(cmd.h) : cmd.h);
          if (n.kind === "text" && !cmd.scaleProps) {
            if (n.w !== oldW) n.sizingW = "fixed";
            if (n.h !== oldH) n.sizingH = "fixed";
          }
          if (cmd.scaleProps && oldW > 0 && oldH > 0) {
            scaleProps(n, n.w / oldW, n.h / oldH);
          } else {
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
          p.children = p.children.filter((c) => c.id !== id);
          n.x = cmd.x;
          n.y = cmd.y;
          dest.children.push(n);
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
        break;
      }
      case "duplicate": {
        const created: string[] = [];
        for (const id of s.selection) {
          const n = find(this.root(), id);
          const p = findParent(this.root(), id) ?? this.root();
          if (!n || n.locked) continue;
          const copy = clone(n);
          const masterId = n.isComponent ? n.componentId || n.id : n.componentId;
          reid(copy);
          copy.x += 10;
          copy.y += 10;
          if (n.isComponent) {
            copy.isComponent = false;
            copy.componentId = masterId;
            copy.name = n.name;
          }
          p.children.push(copy);
          created.push(copy.id);
        }
        s.selection = created;
        break;
      }
      case "patch": {
        const n = find(this.root(), cmd.id);
        if (n) {
          Object.assign(n, cmd.patch);
          if (n.isComponent && n.componentId) {
            const lib = s.components.find((c) => c.id === n.componentId);
            if (lib) {
              lib.name = n.name;
              lib.node = clone(n);
            }
            syncInstances(s.pages, n);
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
      case "copy":
        this.clip = s.selection
          .map((id) => find(this.root(), id))
          .filter((n): n is XNode => !!n)
          .map(clone);
        break;
      case "cut":
        this.apply({ type: "copy" });
        this.apply({ type: "delete" });
        break;
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
        const grid = s.pages[s.page].pixelGrid;
        for (const n of this.clip) {
          const copy = clone(n);
          reid(copy);
          if (cmd.inPlace) {
            copy.x = n.x;
            copy.y = n.y;
          } else if (cmd.x != null && cmd.y != null) {
            copy.x = cmd.x - parentWorld.x;
            copy.y = cmd.y - parentWorld.y;
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
        void navigator.clipboard?.writeText(css);
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
        p.name = `${p.name} copy`;
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
          }
        }
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
        else s.components.push({ id: cid, name: n.name, node: clone(n), variants: [{ name: "Default", node: clone(n) }], property: "Variant" });
        s.selection = [n.id];
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
        const lib = s.components.find((c) => c.id === cmd.id);
        if (!lib) break;
        const copy = clone(lib.node);
        reid(copy);
        copy.x = cmd.x;
        copy.y = cmd.y;
        copy.isComponent = false;
        copy.componentId = lib.id;
        copy.name = lib.name;
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
        const xs = n.path.map((pt) => pt.x);
        const ys = n.path.map((pt) => pt.y);
        if (xs.length) {
          n.w = Math.max(1, Math.max(...xs) - Math.min(0, ...xs));
          n.h = Math.max(1, Math.max(...ys) - Math.min(0, ...ys));
        }
        break;
      }
      case "flatten": {
        const id = s.selection[0];
        const n = id ? find(this.root(), id) : null;
        if (!n) break;
        if (n.kind === "boolean" && n.children.length) {
          const baked = booleanPath(
            n.booleanOp || "union",
            n.children.map((c) => ({ poly: transformedPoly(c), ox: c.x, oy: c.y })),
          );
          if (baked) {
            n.path = baked.path;
            n.closed = true;
            n.kind = "vector";
            n.children = [];
            n.booleanOp = null;
            n.x += baked.x;
            n.y += baked.y;
            n.w = baked.w;
            n.h = baked.h;
          }
        } else if (!n.path.length) {
          n.path = shapePoly(n);
          n.closed = n.kind !== "line" && n.kind !== "arrow";
          n.kind = "vector";
        }
        break;
      }
      case "outlineStroke": {
        const id = s.selection[0];
        const n = id ? find(this.root(), id) : null;
        if (!n || n.strokeWidth <= 0) break;
        const src = n.path.length ? n.path : shapePoly(n);
        n.path = outlineStrokePath(src, n.strokeWidth, n.closed || n.kind !== "line");
        n.kind = "vector";
        n.closed = true;
        n.fill = n.strokePaint;
        n.fillVisible = true;
        n.strokeWidth = 0;
        n.strokeVisible = false;
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
      case "setInteractions": {
        const n = find(this.root(), cmd.id);
        if (n) n.interactions = cmd.interactions;
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
        s.presentStack = [...s.presentStack, cmd.id];
        s.presentFrame = cmd.id;
        focusFrame(s, this.root(), cmd.id);
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
    }
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
  const z = Math.min(1.2, Math.max(0.25, 720 / Math.max(wp.node.w, 1)));
  s.zoom = z;
  s.panX = 48 - wp.x * z;
  s.panY = 48 - wp.y * z;
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
  for (const page of pages) {
    walk(page.root, (n) => {
      if (n === master) return;
      if (n.componentId !== cid || n.isComponent) return;
      const x = n.x;
      const y = n.y;
      const id = n.id;
      const interactions = n.interactions;
      Object.assign(n, clone(master), { x, y, id, interactions, isComponent: false, componentId: cid });
    });
  }
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
    return segmentDistance(px, py, 0, n.h / 2, n.w, n.h / 2) <= Math.max(4, n.strokeWidth / 2);
  }
  if ((n.kind === "poly" || n.kind === "star" || n.kind === "vector" || n.kind === "boolean") && n.closed) {
    return polygonHit(shapePoly(n), px, py);
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
  let n: XNode | null = hit;
  while (n) {
    const p = findParent(root, n.id);
    if (!p || p === root) break;
    if (p.kind === "group" || p.kind === "boolean") {
      if (opts?.selection?.includes(p.id)) break;
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
  }
}

function scaleProps(n: XNode, sx: number, sy: number) {
  const s = (Math.abs(sx) + Math.abs(sy)) / 2;
  n.strokeWidth *= s;
  n.fontSize *= s;
  n.letterSpacing *= s;
  if (n.lineHeight) n.lineHeight *= s;
  n.cornerRadii = n.cornerRadii.map((r) => r * s) as [number, number, number, number];
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
    color: shadow ? "#00000040" : kind === "glass" ? "#ffffff80" : "#000000",
    x: 0,
    y: shadow ? 4 : 0,
    blur: kind === "noise" ? 40 : kind === "glass" || kind.includes("blur") ? 12 : shadow ? 4 : 4,
    spread: 0,
    visible: true,
  };
}

export function defaultLayout(): AutoLayout {
  return {
    direction: "horizontal",
    gap: 8,
    padding: [8, 8, 8, 8],
    sizing: "hug",
    cross: "hug",
    wrap: false,
    align: "min",
    justify: "min",
  };
}