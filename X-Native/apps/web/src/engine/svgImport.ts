/**
 * SVG import — turns an SVG file into real, editable X-Native layers.
 *
 * Dropping an SVG used to embed it as a single image fill: one opaque node you
 * could move but not edit. That is the opposite of what a designer expects
 * from a vector format, and it meant the app could not open any existing
 * artwork at all.
 *
 * This is the inverse of `svgNode()` in the inspector, so a document exported
 * to SVG and re-imported comes back as layers rather than a picture. It
 * covers the shapes that exporter emits plus the common primitives real files
 * use: rect, circle, ellipse, line, polyline, polygon, path, text and nested
 * groups with transforms.
 *
 * Deliberately not a full SVG 1.1 implementation — filters, clip paths,
 * patterns, masks and CSS stylesheets are out of scope. Anything unrecognised
 * is skipped rather than guessed at, and the caller is told how many nodes
 * were dropped so the UI can be honest about it.
 *
 * Rust counterpart: `crates/x-format/src/svg_import.rs`, which is not reachable
 * from the web app. See docs/ARCHITECTURE_BOUNDARY.md — this is the
 * authoritative implementation today, and the Rust one is a migration
 * candidate, not the current authority.
 */

import type { VectorNetwork } from "./types";

export interface ImportedNode {
  kind: "rect" | "ellipse" | "line" | "text" | "vector";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  fillVisible: boolean;
  strokePaint: string;
  strokeVisible: boolean;
  strokeWidth: number;
  opacity: number;
  rotation: number;
  cornerRadii?: [number, number, number, number];
  path?: { x: number; y: number; ix?: number; iy?: number; ox?: number; oy?: number }[];
  vectorNetwork?: VectorNetwork;
  closed?: boolean;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: "left" | "center" | "right";
}

export interface ImportResult {
  nodes: ImportedNode[];
  width: number;
  height: number;
  /** Elements recognised as drawable but not representable; surfaced to the user. */
  skipped: number;
}

interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function apply(m: Mat, x: number, y: number) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** Parse an SVG transform list. Unsupported functions are ignored rather than
 *  aborting the element, so a stray `skewX` costs its shear, not the shape. */
function parseTransform(spec: string | null): Mat {
  if (!spec) return IDENTITY;
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(spec))) {
    const n = hit[2]
      .split(/[\s,]+/)
      .map((v) => parseFloat(v))
      .filter((v) => Number.isFinite(v));
    if (hit[1] === "matrix" && n.length >= 6) {
      m = mul(m, { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] });
    } else if (hit[1] === "translate") {
      m = mul(m, { ...IDENTITY, e: n[0] ?? 0, f: n[1] ?? 0 });
    } else if (hit[1] === "scale") {
      m = mul(m, { ...IDENTITY, a: n[0] ?? 1, d: n[1] ?? n[0] ?? 1 });
    } else if (hit[1] === "rotate") {
      const r = ((n[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      const rot: Mat = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (n.length >= 3) {
        m = mul(m, { ...IDENTITY, e: n[1], f: n[2] });
        m = mul(m, rot);
        m = mul(m, { ...IDENTITY, e: -n[1], f: -n[2] });
      } else {
        m = mul(m, rot);
      }
    }
  }
  return m;
}

/** Rotation in degrees carried by a matrix, so rotated artwork keeps its angle
 *  instead of silently snapping to axis-aligned. */
function matrixRotation(m: Mat): number {
  const deg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  return Math.abs(deg) < 0.01 ? 0 : deg;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  purple: "#800080",
  transparent: "#00000000",
};

/** Normalise an SVG paint to the #rrggbb / #rrggbbaa the engine stores.
 *  Returns null for `none` and for paints we cannot resolve (url(#…) refs). */
function parsePaint(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s || s === "none" || s.startsWith("url(")) return null;
  if (NAMED[s]) return NAMED[s];
  if (s.startsWith("#")) {
    if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    if (s.length === 7 || s.length === 9) return s;
    return null;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgb) {
    const p = rgb[1].split(/[\s,/]+/).filter(Boolean);
    const to255 = (t: string) =>
      t.endsWith("%") ? Math.round((parseFloat(t) / 100) * 255) : Math.round(parseFloat(t));
    const [r, g, bl] = [to255(p[0]), to255(p[1]), to255(p[2])];
    if (![r, g, bl].every((n) => Number.isFinite(n))) return null;
    const hex = `#${[r, g, bl].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("")}`;
    if (p[3] !== undefined) {
      const a = Math.round(Math.max(0, Math.min(1, parseFloat(p[3]))) * 255);
      return `${hex}${a.toString(16).padStart(2, "0")}`;
    }
    return hex;
  }
  return null;
}

function num(el: Element, name: string, dflt = 0): number {
  const v = parseFloat(el.getAttribute(name) ?? "");
  return Number.isFinite(v) ? v : dflt;
}

/** Inherited presentation attributes. SVG resolves these up the tree, so a
 *  `fill` on a <g> must reach the children that do not set their own. */
interface Style {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  opacity: number;
}

function readStyle(el: Element, parent: Style): Style {
  // `style="fill:red"` wins over the presentation attribute, per SVG.
  const inline: Record<string, string> = {};
  for (const decl of (el.getAttribute("style") ?? "").split(";")) {
    const [k, v] = decl.split(":");
    if (k && v) inline[k.trim().toLowerCase()] = v.trim();
  }
  const attr = (n: string) => inline[n] ?? el.getAttribute(n);
  const rawFill = attr("fill");
  const rawStroke = attr("stroke");
  const rawWidth = attr("stroke-width");
  const rawOpacity = attr("opacity");
  const o = parseFloat(rawOpacity ?? "");
  return {
    fill: rawFill === null ? parent.fill : parsePaint(rawFill),
    stroke: rawStroke === null ? parent.stroke : parsePaint(rawStroke),
    strokeWidth: rawWidth === null ? parent.strokeWidth : parseFloat(rawWidth) || 0,
    opacity: (Number.isFinite(o) ? o : 1) * parent.opacity,
  };
}

/** Flatten a path's `d` into polyline points. Curves are sampled rather than
 *  preserved as control points: the engine's vector model stores polylines,
 *  and this matches what the pencil and boolean tools already produce. */
function samplePath(d: string): { pts: { x: number; y: number }[]; closed: boolean } {
  const pts: { x: number; y: number }[] = [];
  let closed = false;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cmd = "";
  const next = () => parseFloat(tokens[i++]);
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    const STEPS = 16;
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const u = 1 - t;
      pts.push({
        x: u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
        y: u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
      });
    }
    cx = x;
    cy = y;
  };
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(tok)) {
      cmd = tok;
      i++;
    }
    const rel = cmd === cmd.toLowerCase();
    const base = () => (rel ? { x: cx, y: cy } : { x: 0, y: 0 });
    switch (cmd.toUpperCase()) {
      case "M": {
        const b = base();
        cx = b.x + next();
        cy = b.y + next();
        sx = cx;
        sy = cy;
        pts.push({ x: cx, y: cy });
        cmd = rel ? "l" : "L"; // subsequent pairs are implicit lineto
        break;
      }
      case "L": {
        const b = base();
        cx = b.x + next();
        cy = b.y + next();
        pts.push({ x: cx, y: cy });
        break;
      }
      case "H": {
        cx = (rel ? cx : 0) + next();
        pts.push({ x: cx, y: cy });
        break;
      }
      case "V": {
        cy = (rel ? cy : 0) + next();
        pts.push({ x: cx, y: cy });
        break;
      }
      case "C": {
        const b = base();
        cubic(b.x + next(), b.y + next(), b.x + next(), b.y + next(), b.x + next(), b.y + next());
        break;
      }
      case "S":
      case "Q": {
        // Treat as a quadratic through its control point; close enough at the
        // sampling density we use, and keeps the shape rather than dropping it.
        const b = base();
        const x1 = b.x + next();
        const y1 = b.y + next();
        const x = b.x + next();
        const y = b.y + next();
        cubic(cx + (2 / 3) * (x1 - cx), cy + (2 / 3) * (y1 - cy), x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x, y);
        break;
      }
      case "T": {
        const b = base();
        cx = b.x + next();
        cy = b.y + next();
        pts.push({ x: cx, y: cy });
        break;
      }
      case "A": {
        // Skip the arc parameters and land on the endpoint; an arc becomes a
        // chord rather than vanishing.
        next();
        next();
        next();
        next();
        next();
        const b = base();
        cx = b.x + next();
        cy = b.y + next();
        pts.push({ x: cx, y: cy });
        break;
      }
      case "Z": {
        closed = true;
        cx = sx;
        cy = sy;
        break;
      }
      default:
        i++; // unknown command: step past it rather than spin
    }
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) break;
  }
  return { pts: pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), closed };
}

function bounds(pts: { x: number; y: number }[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

export function importSvg(text: string): ImportResult {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("not valid SVG");
  const root = doc.documentElement;
  if (root.tagName.toLowerCase() !== "svg") throw new Error("not an SVG document");

  const vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = num(root, "width", vb.length === 4 ? vb[2] : 0) || (vb.length === 4 ? vb[2] : 100);
  const height = num(root, "height", vb.length === 4 ? vb[3] : 0) || (vb.length === 4 ? vb[3] : 100);

  const nodes: ImportedNode[] = [];
  let skipped = 0;

  const base = (el: Element, st: Style, name: string) => ({
    name: el.getAttribute("id") || name,
    fill: st.fill ?? "#00000000",
    fillVisible: st.fill !== null,
    strokePaint: st.stroke ?? "#00000000",
    strokeVisible: st.stroke !== null && st.strokeWidth > 0,
    strokeWidth: st.stroke !== null ? st.strokeWidth : 0,
    opacity: Math.max(0, Math.min(1, st.opacity)),
  });

  const walk = (el: Element, parentMat: Mat, parentStyle: Style) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const m = mul(parentMat, parseTransform(child.getAttribute("transform")));
      const st = readStyle(child, parentStyle);
      const rot = matrixRotation(m);

      if (tag === "g" || tag === "svg") {
        walk(child, m, st);
        continue;
      }
      if (tag === "defs" || tag === "title" || tag === "desc" || tag === "style" || tag === "metadata") {
        continue;
      }

      if (tag === "rect") {
        const x = num(child, "x");
        const y = num(child, "y");
        const w = num(child, "width");
        const h = num(child, "height");
        if (w <= 0 || h <= 0) continue;
        const p = apply(m, x, y);
        const r = num(child, "rx", num(child, "ry", 0));
        nodes.push({
          kind: "rect",
          ...base(child, st, "Rectangle"),
          x: p.x,
          y: p.y,
          w: w * Math.hypot(m.a, m.b),
          h: h * Math.hypot(m.c, m.d),
          rotation: rot,
          cornerRadii: r ? [r, r, r, r] : undefined,
        });
      } else if (tag === "circle" || tag === "ellipse") {
        const cx = num(child, "cx");
        const cy = num(child, "cy");
        const rx = tag === "circle" ? num(child, "r") : num(child, "rx");
        const ry = tag === "circle" ? num(child, "r") : num(child, "ry");
        if (rx <= 0 || ry <= 0) continue;
        const p = apply(m, cx - rx, cy - ry);
        nodes.push({
          kind: "ellipse",
          ...base(child, st, "Ellipse"),
          x: p.x,
          y: p.y,
          w: rx * 2 * Math.hypot(m.a, m.b),
          h: ry * 2 * Math.hypot(m.c, m.d),
          rotation: rot,
        });
      } else if (tag === "line") {
        const a = apply(m, num(child, "x1"), num(child, "y1"));
        const b2 = apply(m, num(child, "x2"), num(child, "y2"));
        nodes.push({
          kind: "line",
          ...base(child, st, "Line"),
          x: Math.min(a.x, b2.x),
          y: Math.min(a.y, b2.y),
          w: Math.abs(b2.x - a.x),
          h: Math.abs(b2.y - a.y),
          rotation: 0,
          path: [a, b2],
          closed: false,
        });
      } else if (tag === "polyline" || tag === "polygon" || tag === "path") {
        let pts: { x: number; y: number }[];
        let closed = tag === "polygon";
        if (tag === "path") {
          const s = samplePath(child.getAttribute("d") ?? "");
          pts = s.pts;
          closed = s.closed;
        } else {
          const raw = (child.getAttribute("points") ?? "").split(/[\s,]+/).map(Number).filter(Number.isFinite);
          pts = [];
          for (let k = 0; k + 1 < raw.length; k += 2) pts.push({ x: raw[k], y: raw[k + 1] });
        }
        if (pts.length < 2) {
          skipped++;
          continue;
        }
        const world = pts.map((p) => apply(m, p.x, p.y));
        const bb = bounds(world);
        nodes.push({
          kind: "vector",
          ...base(child, st, tag === "path" ? "Path" : "Polygon"),
          x: bb.x,
          y: bb.y,
          w: Math.max(1, bb.w),
          h: Math.max(1, bb.h),
          rotation: 0,
          // Vector paths are stored relative to the node's own origin.
          path: world.map((p) => ({ x: p.x - bb.x, y: p.y - bb.y })),
          closed,
        });
      } else if (tag === "text") {
        const content = (child.textContent ?? "").trim();
        if (!content) continue;
        const size = parseFloat(child.getAttribute("font-size") ?? "16") || 16;
        const anchor = child.getAttribute("text-anchor");
        const p = apply(m, num(child, "x"), num(child, "y"));
        nodes.push({
          kind: "text",
          ...base(child, st, content.slice(0, 40) || "Text"),
          // SVG y is the baseline; the engine positions text from its top edge.
          x: p.x,
          y: p.y - size,
          w: Math.max(8, content.length * size * 0.6),
          h: size * 1.4,
          rotation: rot,
          // Text with no explicit fill is black in SVG, not invisible.
          fill: st.fill ?? "#000000",
          fillVisible: true,
          text: content,
          fontSize: size,
          fontWeight: parseInt(child.getAttribute("font-weight") ?? "400", 10) || 400,
          textAlign: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
        });
      } else if (tag === "image" || tag === "use" || tag === "foreignobject") {
        skipped++;
      } else if (child.children.length) {
        walk(child, m, st);
      }
    }
  };

  walk(root, IDENTITY, { fill: null, stroke: null, strokeWidth: 1, opacity: 1 });
  return { nodes, width, height, skipped };
}
