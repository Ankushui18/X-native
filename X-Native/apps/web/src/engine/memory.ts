import type {
  AutoLayout,
  Command,
  Effect,
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
    fillOpacity: 1,
    fillVisible: !(kind === "line" || kind === "arrow"),
    fillType: "solid",
    fillB: "#ffffff",
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
  const pageRoot = node("frame", "Page 1", 0, 0, 1200, 800, {
    fill: "#00000000",
    overflow: "visible",
    children: [phone],
  });
  applyLayout(phone);
  applyLayout(card);
  return {
    id: uid("page"),
    name: "Page 1",
    root: pageRoot,
    pixelGrid: false,
    pixelGridColor: "#cccccc",
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
}

export class MemoryEngine implements Engine {
  private state: Internal;
  private undo: Internal[] = [];
  private redo: Internal[] = [];
  private listeners = new Set<() => void>();
  private snapCache: Snapshot;
  private grouping = false;
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
      "copy",
      "copyCode",
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
        const parent = this.root();
        for (const n of this.clip) {
          const copy = clone(n);
          reid(copy);
          copy.x = (cmd.x ?? copy.x) + (cmd.x != null ? 0 : 16);
          copy.y = (cmd.y ?? copy.y) + (cmd.y != null ? 0 : 16);
          parent.children.push(copy);
          created.push(copy.id);
        }
        s.selection = created;
        break;
      }
      case "selectAll":
        s.selection = this.root().children.map((c) => c.id);
        break;
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
          if (cmd.axis === "h") n.rotation = -n.rotation;
          else n.rotation = 180 - n.rotation;
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
        const ids = s.selection;
        if (ids.length < (cmd.type === "group" ? 2 : 1)) break;
        const parent = findParent(this.root(), ids[0]);
        if (!parent) break;
        const nodes = ids
          .map((id) => parent.children.find((c) => c.id === id))
          .filter((n): n is XNode => !!n);
        if (nodes.length !== ids.length) break;
        const minX = Math.min(...nodes.map((n) => n.x));
        const minY = Math.min(...nodes.map((n) => n.y));
        const maxX = Math.max(...nodes.map((n) => n.x + n.w));
        const maxY = Math.max(...nodes.map((n) => n.y + n.h));
        const g = node(
          cmd.type === "wrapSection" ? "frame" : "group",
          cmd.type === "wrapSection" ? "Section" : "Group",
          minX,
          minY,
          maxX - minX,
          maxY - minY,
          {
            fill: "#00000000",
            fillVisible: false,
            overflow: "visible",
          },
        );
        g.children = nodes.map((n) => {
          const c = clone(n);
          c.x -= minX;
          c.y -= minY;
          return c;
        });
        parent.children = parent.children.filter((c) => !ids.includes(c.id));
        parent.children.push(g);
        s.selection = [g.id];
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
        for (const id of s.selection) {
          const parent = findParent(this.root(), id);
          if (!parent) continue;
          const i = parent.children.findIndex((c) => c.id === id);
          if (i < 0) continue;
          const [row] = parent.children.splice(i, 1);
          if (cmd.dir === "front") parent.children.push(row);
          else if (cmd.dir === "back") parent.children.unshift(row);
          else if (cmd.dir === "forward") parent.children.splice(Math.min(parent.children.length, i + 1), 0, row);
          else parent.children.splice(Math.max(0, i - 1), 0, row);
        }
        break;
      }
      case "duplicatePage": {
        const p = clone(s.pages[s.page]);
        p.id = uid("page");
        p.name = `${p.name} copy`;
        reid(p.root);
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

export { find, findParent };

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
  return {
    kind,
    color: "#000000",
    x: 0,
    y: kind === "drop-shadow" || kind === "inner-shadow" ? 4 : 0,
    blur: kind.includes("blur") ? 8 : 16,
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
