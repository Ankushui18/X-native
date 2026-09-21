import type {
  AutoLayout,
  Command,
  Engine,
  NodeKind,
  Page,
  Snapshot,
  Tool,
  XNode,
} from "./types";

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
    strokePaint: kind === "line" || kind === "arrow" ? "#1e1e1e" : "#00000000",
    strokeWidth: kind === "line" || kind === "arrow" ? 1 : 0,
    strokeAlign: "inside",
    opacity: 1,
    visible: true,
    locked: false,
    overflow: kind === "frame" ? "clip" : "visible",
    cornerRadii: [0, 0, 0, 0],
    blendMode: "normal",
    imageSrc: "",
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
  if (!l) return;
  const flow = n.children.filter((c) => c.visible);
  const [pl, pr, pt, pb] = l.padding;
  const horiz = l.direction === "horizontal";
  const gap = l.gap;
  const innerW = n.w - pl - pr;
  const innerH = n.h - pt - pb;
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
  if (l.sizing === "hug") {
    if (horiz) n.w = origin + mainTotal + pr - (l.justify === "min" ? 0 : 0);
    else n.h = (l.justify === "min" ? pt : pt) + mainTotal + pb;
    if (horiz) n.w = pl + mainTotal + pr;
    else n.h = pt + mainTotal + pb;
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
  const pageRoot = node("frame", "Page 1", 0, 0, 1200, 800, {
    fill: "#00000000",
    overflow: "visible",
    children: [phone],
  });
  applyLayout(phone);
  applyLayout(card);
  return { id: uid("page"), name: "Page 1", root: pageRoot };
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
}

export class MemoryEngine implements Engine {
  private state: Internal;
  private undo: Internal[] = [];
  private redo: Internal[] = [];
  private listeners = new Set<() => void>();
  private snapCache: Snapshot;
  private grouping = false;

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
      return;
    }
    const hist = ![
      "select",
      "setTool",
      "setZoom",
      "pan",
      "setPan",
      "setRightTab",
      "setLeftTab",
      "setPage",
      "undo",
      "redo",
    ].includes(cmd.type);
    if (hist && !this.grouping) {
      this.undo.push(clone(this.state));
      this.redo = [];
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
        s.pages.push(p);
        s.page = s.pages.length - 1;
        s.selection = [];
        break;
      }
      case "add": {
        const n = node(cmd.kind, labelFor(cmd.kind), cmd.x, cmd.y, cmd.w, cmd.h, cmd.extra);
        const parent = cmd.parent ? find(this.root(), cmd.parent) : this.root();
        (parent ?? this.root()).children.push(n);
        s.selection = [n.id];
        s.tool = "select";
        break;
      }
      case "move":
        for (const id of cmd.ids) {
          const n = find(this.root(), id);
          if (n && !n.locked) {
            n.x += cmd.dx;
            n.y += cmd.dy;
          }
        }
        break;
      case "nudge":
        for (const id of s.selection) {
          const n = find(this.root(), id);
          if (n && !n.locked) {
            n.x += cmd.dx;
            n.y += cmd.dy;
          }
        }
        break;
      case "resize": {
        const n = find(this.root(), cmd.id);
        if (n && !n.locked) {
          n.x = cmd.x;
          n.y = cmd.y;
          n.w = Math.max(1, cmd.w);
          n.h = Math.max(1, cmd.h);
        }
        break;
      }
      case "delete": {
        for (const id of s.selection) {
          const p = findParent(this.root(), id);
          if (p) p.children = p.children.filter((c) => c.id !== id);
        }
        s.selection = [];
        break;
      }
      case "duplicate": {
        const created: string[] = [];
        for (const id of s.selection) {
          const n = find(this.root(), id);
          const p = findParent(this.root(), id) ?? this.root();
          if (!n) continue;
          const copy = clone(n);
          reid(copy);
          copy.x += 16;
          copy.y += 16;
          p.children.push(copy);
          created.push(copy.id);
        }
        s.selection = created;
        break;
      }
      case "patch": {
        const n = find(this.root(), cmd.id);
        if (n) Object.assign(n, cmd.patch);
        break;
      }
      case "autoLayout": {
        const n = find(this.root(), cmd.id);
        if (n) n.layout = cmd.layout;
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
    }
  }
}

function reid(n: XNode) {
  n.id = uid(n.kind);
  n.children.forEach(reid);
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

export function hitTest(root: XNode, wx: number, wy: number): XNode | null {
  let hit: XNode | null = null;
  const visit = (n: XNode, px: number, py: number) => {
    if (!n.visible) return;
    const x = px + n.x;
    const y = py + n.y;
    for (let i = n.children.length - 1; i >= 0; i--) visit(n.children[i], x, y);
    if (n === root) return;
    if (wx >= x && wy >= y && wx <= x + n.w && wy <= y + n.h) {
      if (!hit) hit = n;
    }
  };
  visit(root, 0, 0);
  return hit;
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
