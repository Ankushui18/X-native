/**
 * SVG export: the canvas, written out as a file.
 *
 * Every layer the editor can draw should survive the trip to SVG, because the
 * export is how the artwork leaves the app - into a browser, a deck, a code
 * handoff. The renderer paints from the node model, so the exporter reads the
 * same model: the vector network (not just its first contour), the whole
 * gradient ramp (not just two stops), the stroke's alignment, the effect
 * stack, and every fill and stroke row.
 *
 * It lives in `engine/` because it is pure logic over a node - no DOM, no
 * React - which is what lets the parity tests export a document and read the
 * result, and what lets the round trip through `svgImport` be checked in the
 * same run.
 *
 * Rust counterpart: `crates/x-format/src/svg.rs` is a migration candidate, not
 * the authority; see docs/ARCHITECTURE_BOUNDARY.md.
 */

import type { StrokeCap, XNode } from "./types";
import { outlineStroke, outlineVariableStroke, shapePoly } from "./geometry";
import { applyTextCase, valignApplies } from "../ui/textLayout";
import { miterLimitFromAngle, sideCones, sideWidths, sidesSupported, usesVariableWidth } from "./strokeModel";
import { convertTextToVectorPaths } from "./textVector";

export function escXml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch] || ch);
}

/** An id safe to put in `url(#…)`: layer ids may hold anything the app allows. */
function safeId(prefix: string, n: XNode): string {
  return `${prefix}_${n.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

const isNone = (hex: string | undefined): boolean => !hex || hex === "none" || hex.length < 7;

/** A colour as SVG wants it. Alpha is split out where the caller can pass it
 *  as `*-opacity`, because `rgba()` in a presentation attribute is not
 *  portable and `#rrggbbaa` is newer than the format. */
export function svgColor(value: string) {
  if (isNone(value) || value.length < 7) return "none";
  if (alphaOf(value) === 0) return "none";
  return `#${value.slice(1, 7)}`;
}

/** The alpha a colour carries in its own hex, which SVG keeps separate: a
 *  transparent fill used to export as opaque black, which painted the whole
 *  page. */
export const alphaOf = (value: string | undefined): number =>
  !value || value.length < 9 ? 1 : parseInt(value.slice(7, 9), 16) / 255;

/**
 * The shape as a path. A vector network with regions - the shape the pen tool
 * and the .fig importer produce - becomes one subpath per loop, so a shape
 * made of several contours (an icon, a donut with a hole) exports whole rather
 * than as its first contour.
 */
/** Kinds whose image fill the canvas clips to the layer outline: export
 *  wraps the bitmap in the same path so rounded and polygonal shapes keep
 *  their silhouette. Frames and groups fill the whole box unclipped. */
const SHAPE_CLIP = new Set(["rect", "ellipse", "poly", "star", "vector", "boolean"]);
export function svgPath(n: XNode) {
  const loops = networkLoops(n);
  if (loops) {
    return loops.map((loop) => loopPoints(n, loop)).filter(Boolean).join(" ");
  }
  const points = n.path.length ? n.path : shapePoly(n);
  if (!points.length) return "";
  const out = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    if ((prev.ox || prev.oy || point.ix || point.iy) && (prev.ox != null || prev.oy != null || point.ix != null || point.iy != null)) {
      out.push(
        `C ${prev.x + (prev.ox || 0)} ${prev.y + (prev.oy || 0)} ${point.x + (point.ix || 0)} ${point.y + (point.iy || 0)} ${point.x} ${point.y}`,
      );
    } else out.push(`L ${point.x} ${point.y}`);
  }
  if (n.closed || (n.kind !== "line" && n.kind !== "arrow" && n.kind !== "text")) out.push("Z");
  return out.join(" ");
}

/** Loop vertex indices of a network's regions, or null when it has none. */
function networkLoops(n: XNode): number[][] | null {
  const vn = n.vectorNetwork;
  if (!vn?.regions?.length || !vn.vertices.length) return null;
  const loops: number[][] = [];
  for (const region of vn.regions) for (const loop of region.loops) if (loop.length >= 2) loops.push(loop);
  return loops.length ? loops : null;
}

/** One loop as an SVG subpath, through the segment tangents. */
function loopPoints(n: XNode, loop: number[]): string {
  const vn = n.vectorNetwork!;
  const at = (i: number) => vn.vertices[loop[((i % loop.length) + loop.length) % loop.length]];
  const first = at(0);
  if (!first) return "";
  const out = [`M ${round(first.x)} ${round(first.y)}`];
  for (let i = 0; i < loop.length; i++) {
    const from = loop[i];
    const to = loop[(i + 1) % loop.length];
    const seg = vn.segments.find((s) => (s.start === from && s.end === to) || (s.start === to && s.end === from));
    const a = at(i);
    const b = at(i + 1);
    const t0 = seg && seg.start === from ? seg.tangentStart : seg?.tangentEnd;
    const t1 = seg && seg.start === from ? seg.tangentEnd : seg?.tangentStart;
    if (seg && ((t0 && (t0.x || t0.y)) || (t1 && (t1.x || t1.y)))) {
      out.push(
        `C ${round(a.x + (t0?.x ?? 0))} ${round(a.y + (t0?.y ?? 0))} ${round(b.x + (t1?.x ?? 0))} ${round(b.y + (t1?.y ?? 0))} ${round(b.x)} ${round(b.y)}`,
      );
    } else {
      out.push(`L ${round(b.x)} ${round(b.y)}`);
    }
  }
  out.push("Z");
  return out.join(" ");
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** The dash list as SVG wants it: custom pattern wins over the pair. */
export function svgDash(n: XNode): string {
  if (n.strokeDashPattern?.length) return n.strokeDashPattern.join(" ");
  if (n.strokeDash > 0) return `${n.strokeDash} ${n.strokeGap || n.strokeDash}`;
  return "none";
}

/** A gradient's stops: the ramp when the layer has one, otherwise default
 *  legacy two-colour pair. A three-stop ramp used to export as two. */
function stopsOf(n: XNode, fallbackB: string): { color: string; opacity: number; offset: number }[] {
  const ramp = n.gradientStops ?? [];
  if (ramp.length >= 2) {
    return ramp.map((s) => ({ color: svgColor(s.color), opacity: alphaOf(s.color), offset: s.position }));
  }
  return [
    { color: svgColor(n.fill), opacity: alphaOf(n.fill), offset: 0 },
    { color: svgColor(fallbackB), opacity: alphaOf(fallbackB), offset: 1 },
  ];
}

function gradientDefs(n: XNode, id: string): { def: string; paint: string } | null {
  if (n.fillType === "linear" || n.fillType === "radial") {
    const stops = stopsOf(n, n.fillB)
      .map((s) => `<stop offset="${Math.round(s.offset * 1000) / 10}%" stop-color="${s.color}" stop-opacity="${Math.round(s.opacity * 1000) / 1000}"/>`)
      .join("");
    if (n.fillType === "linear") {
      return {
        def: `<linearGradient id="${id}" x1="${n.fillGX}" y1="${n.fillGY}" x2="${n.fillHX}" y2="${n.fillHY}">${stops}</linearGradient>`,
        paint: `url(#${id})`,
      };
    }
    // The radius is the distance from the centre to the second handle, which is
    // how the canvas painter reads it too.
    const r = Math.max(0.001, Math.hypot((n.fillHX ?? 1) - (n.fillGX ?? 0), (n.fillHY ?? 1) - (n.fillGY ?? 0)));
    return {
      def: `<radialGradient id="${id}" cx="${n.fillGX}" cy="${n.fillGY}" r="${round(r)}">${stops}</radialGradient>`,
      paint: `url(#${id})`,
    };
  }
  if (n.fillType === "image" || n.imageSrc) return null;
  if (n.fillType === "angular" || n.fillType === "diamond") {
    // SVG has no conic gradient; a linear ramp across the box is the closest
    // shape-compatible stand-in, and it keeps the colours in order.
    const stops = stopsOf(n, n.fillB)
      .map((s) => `<stop offset="${Math.round(s.offset * 1000) / 10}%" stop-color="${s.color}" stop-opacity="${Math.round(s.opacity * 1000) / 1000}"/>`)
      .join("");
    return { def: `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient>`, paint: `url(#${id})` };
  }
  return null;
}

/** SVG filters for the effect stack. shadow radius is a CSS-style blur
 *  radius, so the Gaussian's standard deviation is half of it - the same
 *  relationship the canvas painter has. */
function effectFilters(n: XNode, id: string): { defs: string[]; filters: string[] } {
  const defs: string[] = [];
  const filters: string[] = [];
  const fx = (n.effects ?? []).filter((e) => e.visible);
  // Figma never rotates an effect with its layer, but the filter runs in the
  // element's rotated user space — so offsets are counter-rotated to world
  // axes, mirroring the canvas painter.
  const th = ((n.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const counter = (x: number, y: number): [number, number] => [
    Math.round((x * c + y * s) * 100) / 100,
    Math.round((-x * s + y * c) * 100) / 100,
  ];
  let i = 0;
  for (const e of fx) {
    const fid = `${id}_fx${i++}`;
    const base = e.color && !isNone(e.color) ? e.color : "#000000";
    const color = svgColor(base);
    const alpha = (alphaOf(base) * 1).toFixed(3);
    const sigma = Math.max(0, e.blur / 2);
    if (e.kind === "drop-shadow") {
      const spread = e.spread > 0 ? `<feMorphology operator="dilate" radius="${e.spread}" in="SourceAlpha" result="sp"/>` : "";
      const src = e.spread > 0 ? "sp" : "SourceAlpha";
      const [ox, oy] = counter(e.x, e.y);
      defs.push(
        `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">${spread}` +
          `<feOffset dx="${ox}" dy="${oy}" in="${src}" result="off"/>` +
          `<feGaussianBlur stdDeviation="${round(sigma)}" in="off" result="blur"/>` +
          `<feFlood flood-color="${color}" flood-opacity="${alpha}" result="col"/>` +
          `<feComposite operator="in" in="col" in2="blur" result="shadow"/>` +
          `<feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
      );
      filters.push(`url(#${fid})`);
    } else if (e.kind === "inner-shadow") {
      const [ox, oy] = counter(e.x, e.y);
      defs.push(
        `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">` +
          `<feOffset dx="${ox}" dy="${oy}" in="SourceAlpha" result="off"/>` +
          `<feGaussianBlur stdDeviation="${round(sigma)}" in="off" result="blur"/>` +
          `<feComposite operator="out" in="blur" in2="SourceAlpha" result="inv"/>` +
          `<feFlood flood-color="${color}" flood-opacity="${alpha}" result="col"/>` +
          `<feComposite operator="in" in="col" in2="inv" result="shadow"/>` +
          `<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="shadow"/></feMerge></filter>`,
      );
      filters.push(`url(#${fid})`);
    } else if (e.kind === "layer-blur") {
      defs.push(
        `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">` +
          `<feGaussianBlur stdDeviation="${round(sigma)}"/></filter>`,
      );
      filters.push(`url(#${fid})`);
    }
  }
  return { defs, filters };
}

/**
 * One shape's markup. Stroke alignment is the part SVG does not have, so it is
 * done the way the canvas does it: an inside stroke is the centred stroke
 * clipped to the shape, an outside stroke is the stroke masked to everything
 * but the shape, and in both cases the width is doubled so the visible half is
 * the width the layer asks for.
 */
/**
 * Variable-width stroke as a filled outline element. SVG has no variable
 * stroke, so the expanded outline — the same geometry the canvas paints —
 * exports as fill. Returns "" when the node has no active profile.
 */
function variableStrokeSvg(n: XNode, stroke: string): string {
  if (!usesVariableWidth(n)) return "";
  const center =
    n.path.length >= 2 ? n.path : n.kind === "line" || n.kind === "arrow" ? shapePoly(n) : null;
  if (!center || center.length < 2) return "";
  const outline = outlineVariableStroke(
    center,
    n.strokeWidth,
    n.strokeWidthProfile,
    n.closed,
    n.strokeCap,
    n.strokeJoin,
    miterLimitFromAngle(n.strokeMiterAngle),
  );
  if (outline.length < 3) return "";
  const d = outline.map((p, i) => `${i ? "L" : "M"} ${round(p.x)} ${round(p.y)}`).join(" ") + " Z";
  const opacity = Math.max(0, Math.min(1, n.strokeOpacity * alphaOf(n.strokePaint)));
  return `<path d="${d}" fill="${stroke}" fill-opacity="${opacity}" stroke="none"/>`;
}

export function svgShape(n: XNode, fill: string, stroke = "none", extra = "", opts: SvgOpts = {}): string {
  const path = svgPath(n);
  if (!path) return "";
  const caps = n.strokeCap === "round" ? "round" : n.strokeCap === "square" ? "square" : "butt";
  const dashCap = n.strokeDashPattern?.length || n.strokeDash > 0 ? (n.strokeDashCap ?? caps) : caps;
  const common = `stroke-opacity="${Math.max(0, Math.min(1, n.strokeOpacity))}" stroke-linecap="${dashCap}" stroke-linejoin="${n.strokeJoin}" stroke-miterlimit="${Math.round(miterLimitFromAngle(n.strokeMiterAngle) * 1000) / 1000}" stroke-dasharray="${svgDash(n)}"`;
  const fillAttrs = `fill="${fill}" fill-opacity="${Math.max(0, Math.min(1, n.fillOpacity * alphaOf(n.fill)))}" fill-rule="${fillRule(n)}"`;
  const align =
    n.kind === "line" || n.kind === "arrow" ? "center" : n.strokeVisible && n.strokeWidth > 0 ? (n.strokeAlign ?? "inside") : "inside";
  const defs: string[] = [];
  // The fill and the stroke are separate elements: an outside stroke needs a
  // mask that hides everything inside the shape, and a mask on one element
  // would hide the fill with it.
  const fillPath = fill === "none" ? "" : `<path d="${path}" ${fillAttrs}${extra}/>`;
  const strokePath = (attrs: string) => `<path d="${path}" fill="none" ${attrs}/>`;
  const perSideEarly = sidesSupported(n.kind) && (n.strokeSides ?? "all") !== "all";
  let strokeEl = stroke === "none" ? "" : variableStrokeSvg(n, stroke);
  if (stroke !== "none" && !strokeEl) {
    const opacity = Math.max(0, Math.min(1, n.strokeOpacity * alphaOf(n.strokePaint)));
    const attrs = `stroke="${stroke}" stroke-opacity="${opacity}" stroke-linecap="${caps}" stroke-linejoin="${n.strokeJoin}" stroke-miterlimit="${Math.round(miterLimitFromAngle(n.strokeMiterAngle) * 1000) / 1000}" stroke-dasharray="${svgDash(n)}"`;
    // "Simplify strokes": Figma's enabled output draws a non-centre stroke as
    // a filled outline instead of a clipped or masked stroke, which is what a
    // vector tool on the other end wants to receive. Centre strokes, dashes,
    // per-side strokes and multi-contour networks keep the attribute
    // construction - a dash pattern has no outline to take, and the ring
    // builder only knows single contours.
    if (
      opts.simplifyStroke &&
      align !== "center" &&
      svgDash(n) === "none" &&
      !perSideEarly &&
      !networkLoops(n)
    ) {
      const center = n.path.length >= 2 ? n.path : shapePoly(n);
      if (center.length >= 2) {
        const closed =
          n.kind === "line" || n.kind === "arrow" ? false : n.kind === "vector" ? !!n.closed : true;
        const ring = outlineStroke(center, n.strokeWidth, closed, caps as StrokeCap, n.strokeJoin);
        if (ring.length >= 3) {
          const d = `${ring.map((pt, i) => `${i ? "L" : "M"} ${round(pt.x)} ${round(pt.y)}`).join(" ")} Z`;
          strokeEl = `<path d="${d}" fill="${stroke}" fill-opacity="${opacity}" stroke="none"/>`;
        }
      }
    }
    if (!strokeEl && align === "center") {
      strokeEl = strokePath(`stroke-width="${n.strokeWidth}" ${attrs}`);
    } else if (!strokeEl && align === "inside") {
      // Doubled, then clipped to the shape: the visible half is the width asked
      // for, which is what the canvas paints.
      const clip = safeId("clip", n);
      defs.push(`<clipPath id="${clip}"><path d="${path}"/></clipPath>`);
      strokeEl = strokePath(`stroke-width="${n.strokeWidth * 2}" clip-path="url(#${clip})" ${attrs}`);
    } else if (!strokeEl) {
      const mask = safeId("mask", n);
      defs.push(
        `<mask id="${mask}" maskUnits="userSpaceOnUse" x="${-n.w}" y="${-n.h}" width="${n.w * 3}" height="${n.h * 3}">` +
          `<rect x="${-n.w}" y="${-n.h}" width="${n.w * 3}" height="${n.h * 3}" fill="#fff"/>` +
          `<path d="${path}" fill="#000"/></mask>`,
      );
      strokeEl = strokePath(`stroke-width="${n.strokeWidth * 2}" mask="url(#${mask})" ${attrs}`);
    }
  }
  let arrowEl = "";
  const tipCap =
    n.strokeCap === "arrow" ||
    n.strokeCap === "triangle" ||
    n.strokeCap === "reverse-triangle" ||
    n.strokeCap === "circle" ||
    n.strokeCap === "diamond";
  if (n.kind === "arrow" || ((n.kind === "line" || n.kind === "vector") && !n.closed && tipCap)) {
    const pts = n.path.length ? n.path : shapePoly(n);
    if (pts.length >= 2) {
      const a = pts[pts.length - 1];
      const b = pts[pts.length - 2];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const ah = Math.max(6, n.strokeWidth * 3);
      const strokeColor = svgColor(n.strokePaint);
      if (n.strokeCap === "arrow" || n.kind === "arrow") {
        const p1x = round(a.x - ux * ah + uy * ah * 0.72);
        const p1y = round(a.y - uy * ah - ux * ah * 0.72);
        const p2x = round(a.x - ux * ah - uy * ah * 0.72);
        const p2y = round(a.y - uy * ah + ux * ah * 0.72);
        arrowEl = `<path d="M ${p1x} ${p1y} L ${round(a.x)} ${round(a.y)} L ${p2x} ${p2y}" fill="none" stroke="${strokeColor}" stroke-width="${Math.max(0.5, n.strokeWidth)}" stroke-linecap="butt" stroke-linejoin="miter"/>`;
      } else if (n.strokeCap === "circle") {
        arrowEl = `<circle cx="${round(a.x)}" cy="${round(a.y)}" r="${round(ah * 0.55)}" fill="none" stroke="${strokeColor}" stroke-width="${Math.max(0.5, n.strokeWidth)}"/>`;
      } else {
        const p1x = round(a.x - ux * ah + uy * ah * 0.75);
        const p1y = round(a.y - uy * ah - ux * ah * 0.75);
        const p2x = round(a.x - ux * ah - uy * ah * 0.75);
        const p2y = round(a.y - uy * ah + ux * ah * 0.75);
        arrowEl = `<path d="M ${round(a.x)} ${round(a.y)} L ${p1x} ${p1y} L ${p2x} ${p2y} Z" fill="${strokeColor}"/>`;
      }
    }
  }
  const base = fillPath + strokeEl + arrowEl;

  // Extra fills stack on top of the base one, bottom to top, as they do on the
  // canvas; extra strokes stack on top of the base stroke.
  const extras: string[] = [];
  for (const row of n.fills ?? []) {
    if (!row.visible || row.exportVisible === false) continue;
    const c = svgColor(row.color);
    const paint = row.type === "linear" || row.type === "radial" ? c : c;
    extras.push(`<path d="${path}" fill="${paint}" fill-opacity="${Math.max(0, Math.min(1, row.opacity * alphaOf(row.color)))}" fill-rule="${fillRule(n)}"/>`);
  }
  const strokeRows = n.strokes ?? [];
  for (const row of strokeRows) {
    const c = row.visible === false ? "none" : svgColor(row.color);
    if (c === "none") continue;
    extras.push(`<path d="${path}" fill="none" stroke="${c}" stroke-width="${row.width}" stroke-opacity="${Math.max(0, Math.min(1, (row.opacity ?? 1) * alphaOf(row.color)))}" ${common}/>`);
  }

  // Individual strokes: SVG has no per-side border, so each side is the same
  // outline clipped to its own 45° cone - the identical construction the canvas
  // uses, which keeps the export and the editor showing one shape.
  const widths = sideWidths(n.strokeSides, n.strokeSideW, n.strokeWidth);
  const perSide = stroke !== "none" && sidesSupported(n.kind) && (n.strokeSides ?? "all") !== "all";
  if (!perSide) {
    const head = defs.length ? `<defs>${defs.join("")}</defs>` : "";
    return `${head}${base}${extras.join("")}`;
  }

  const cones = sideCones(0, 0, Math.max(1, n.w), Math.max(1, n.h));
  const coneDefs = widths
    .map((w, i) =>
      w > 0
        ? `<clipPath id="side_${safeId("c", n)}_${i}"><polygon points="${cones[i].map(([x, y]) => `${x},${y}`).join(" ")}"/></clipPath>`
        : "",
    )
    .join("");
  const sides = widths
    .map((w, i) =>
      w > 0
        ? strokePath(`stroke="${stroke}" stroke-width="${w}" clip-path="url(#side_${safeId("c", n)}_${i})" ${common}`)
        : "",
    )
    .join("");
  return `<defs>${coneDefs}${defs.join("")}</defs>${fillPath}${extras.join("")}${sides}`;
}

/** Nonzero unless the network says otherwise: a shape with a hole relies on it. */
function fillRule(n: XNode): string {
  const rule = n.vectorNetwork?.regions?.[0]?.windingRule;
  return rule === "EVENODD" ? "evenodd" : "nonzero";
}

/** The laid-out lines of a text layer: truncation, anchor, line rhythm and the
 *  vertical offset. Both the `<text>` branch and the outlined-text branch read
 *  this, so the two can never drift apart. */
function textLayout(n: XNode): {
  lines: string[];
  anchor: "start" | "middle" | "end";
  tx: number;
  lineHeight: number;
  yOffset: number;
} {
  const text = applyTextCase(n.text, n.textCase);
  let lines = text.split("\n");
  if (n.truncate && lines.length > Math.max(1, n.maxLines || 1)) {
    lines = lines.slice(0, Math.max(1, n.maxLines || 1));
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+$/, "")}…`;
  }
  const anchor = n.textAlign === "center" ? "middle" : n.textAlign === "right" ? "end" : "start";
  const tx = n.textAlign === "center" ? n.w / 2 : n.textAlign === "right" ? n.w : 0;
  const lineHeight = n.lineHeight || n.fontSize * 1.2;
  const blockHeight = lines.length * lineHeight;
  // Hug axes ignore vertical alignment, like the canvas painter.
  const valign = valignApplies(n) ? n.textAlignVertical : "top";
  const yOffset =
    valign === "middle" ? (n.h - blockHeight) / 2 : valign === "bottom" ? n.h - blockHeight : 0;
  return { lines, anchor, tx, lineHeight, yOffset };
}

/** "Outline text": the copy as filled paths instead of a `<text>` element, so
 *  the file survives a machine without the font. Each line is traced by the
 *  same vectoriser the editor's own outline-text command uses (with its
 *  geometric fallback outside a browser), then placed on the line grid the
 *  `<text>` branch would have used. Letter spacing, underlines and text
 *  strokes do not survive the trip - the tracer draws bare glyph bodies. */
function outlinedText(n: XNode, paint: string, filter: string): string {
  const { lines, anchor, tx, lineHeight, yOffset } = textLayout(n);
  const opacity = Math.max(0, Math.min(1, n.fillOpacity));
  const paths: string[] = [];
  lines.forEach((line, i) => {
    const traced = convertTextToVectorPaths(
      line === "" ? " " : line,
      n.fontSize || 16,
      n.fontFamily || "Inter",
      String(n.fontWeight ?? "400"),
    );
    const loops = traced.network.regions?.flatMap((r) => r.loops) ?? [];
    if (!loops.length) return;
    const verts = traced.network.vertices;
    const lx = tx - (anchor === "middle" ? traced.w / 2 : anchor === "end" ? traced.w : 0);
    const ly = yOffset + i * lineHeight;
    const d = loops
      .map((loop) => {
        const pts = loop
          .map((vi) => verts[vi])
          .filter((v): v is { x: number; y: number } => !!v);
        if (!pts.length) return "";
        return `${pts.map((v, j) => `${j ? "L" : "M"} ${round(lx + v.x)} ${round(ly + v.y)}`).join(" ")} Z`;
      })
      .filter(Boolean)
      .join(" ");
    if (d) paths.push(`<path d="${d}" fill="${paint}" fill-opacity="${opacity}" fill-rule="evenodd"/>`);
  });
  if (!paths.length) return "";
  return `<g${filter}>${paths.join("")}</g>`;
}

/** One layer, its effects, and the layers inside it. */
export function svgNode(n: XNode, top = false, opts: SvgOpts = {}): string {
  if (!n.visible) return "";
  // Slices never render: they are a crop region, not artwork. A frame that
  // contains one used to export the slice's own rectangle.
  if (n.isSlice === true) return "";
  const id = safeId("paint", n);
  const fill =
    n.fillVisible !== false && n.fillExportVisible !== false ? svgColor(n.fill) : "none";
  const stroke = n.strokeVisible && n.strokeWidth > 0 ? svgColor(n.strokePaint) : "none";
  const defs: string[] = [];
  let paint = fill;
  if (fill !== "none" && !n.imageSrc) {
    const g = gradientDefs(n, id);
    if (g) {
      defs.push(g.def);
      paint = g.paint;
    }
  }
  const fx = effectFilters(n, id);
  defs.push(...fx.defs);
  const filter = fx.filters.length ? ` filter="${fx.filters.join(" ")}"` : "";
  // The layer turns about its own rotation origin, which ⌥-drag can
  // move; rotating about the centre regardless had exported a different pose.
  const [ox, oy] = n.rotOrigin ?? [0.5, 0.5];
  const transform = [
    top ? "" : `translate(${round(n.x)} ${round(n.y)})`,
    n.rotation ? `rotate(${round(n.rotation)} ${round(ox * n.w)} ${round(oy * n.h)})` : "",
    n.flipH || n.flipV ? `translate(${n.flipH ? n.w : 0} ${n.flipV ? n.h : 0}) scale(${n.flipH ? -1 : 1} ${n.flipV ? -1 : 1})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body: string[] = [];
  if (defs.length) body.push(`<defs>${defs.join("")}</defs>`);
  if (n.kind === "text") {
    // Small caps lowers the copy and rides font-variant, exactly like the
    // canvas painter, instead of exporting full-height capitals.
    const smallCaps = n.textCase === "small-caps";
    const { lines, anchor, tx, lineHeight, yOffset } = textLayout(n);
    if (opts.outlineText) {
      const outlined = outlinedText(n, paint, filter);
      if (outlined) body.push(outlined);
    } else {
    const content = lines
      .map((line, i) => `<tspan x="${tx}" dy="${i ? lineHeight : yOffset + n.fontSize}">${escXml(line)}</tspan>`)
      .join("");
    const textStroke = n.strokeVisible && n.strokeWidth > 0 ? svgColor(n.strokePaint) : "none";
    body.push(
      `<text x="${tx}" y="0" text-anchor="${anchor}" dominant-baseline="hanging" fill="${paint}" fill-opacity="${Math.max(0, Math.min(1, n.fillOpacity))}" stroke="${textStroke}" stroke-opacity="${Math.max(0, Math.min(1, n.strokeOpacity))}" stroke-width="${Math.max(0, n.strokeWidth)}" font-family="${escXml(n.fontFamily)}" font-size="${n.fontSize}" font-weight="${n.fontWeight}"${n.fontStyle === "italic" ? ' font-style="italic"' : ""}${smallCaps ? ' font-variant="small-caps"' : ""} letter-spacing="${n.letterSpacing}" text-decoration="${n.textDecoration === "none" ? "none" : n.textDecoration}"${filter}>${content}</text>`,
    );
    }
  } else if (n.fillType === "image" && n.imageSrc && n.fillExportVisible !== false) {
    // Fill covers like the canvas does (slice, not stretch); the stored crop
    // rect and tile geometry need the bitmap's dimensions, which export does
    // not load, so crop falls back to a centred cover and tile to a stretch.
    const preserve =
      n.imageFit === "fit" ? "xMidYMid meet" : n.imageFit === "tile" ? "none" : "xMidYMid slice";
    const img = `<image href="${escXml(n.imageSrc)}" x="0" y="0" width="${round(n.w)}" height="${round(n.h)}" preserveAspectRatio="${preserve}" opacity="${Math.max(0, Math.min(1, n.fillOpacity))}"${filter}/>`;
    const d = SHAPE_CLIP.has(n.kind) ? svgPath(n) : "";
    if (d) {
      const clip = safeId("imgclip", n);
      body.push(`<defs><clipPath id="${clip}"><path d="${d}"/></clipPath></defs>`);
      body.push(`<g clip-path="url(#${clip})">${img}</g>`);
    } else {
      body.push(img);
    }
  } else if (n.kind !== "group" && n.kind !== "frame" && n.kind !== "component" && n.kind !== "instance") {
    body.push(svgShape(n, paint, stroke, filter, opts));
  } else if (fill !== "none" || stroke !== "none") {
    body.push(svgShape(n, paint, stroke, filter, opts));
  }
  if (n.kind === "frame" && n.overflow !== "visible") {
    const clip = safeId("fclip", n);
    body.unshift(`<defs><clipPath id="${clip}"><path d="${svgPath(n)}"/></clipPath></defs>`);
    body.push(`<g clip-path="url(#${clip})">${n.children.map((c) => svgNode(c, false, opts)).join("")}</g>`);
  } else {
    body.push(n.children.map((c) => svgNode(c, false, opts)).join(""));
  }
  return `<g${transform ? ` transform="${transform}"` : ""} opacity="${Math.max(0, Math.min(1, n.opacity))}">${body.join("")}</g>`;
}

export interface SvgPreset {
  format: string;
  scale: number | string;
  suffix: string;
  /** "Include id attribute": writes an id from the layer's name so a
   *  stylesheet or a script can reach the element. */
  includeId?: boolean;
  /** Format settings, read the same way `resolveSettings` resolves them:
   *  absent means the format default (on for SVG, off for raster), an
   *  explicit false forces the legacy construction. `ExportPreset` already
   *  carries these, so a stored preset passes straight through. */
  ignoreOverlap?: boolean;
  outlineText?: boolean;
  simplifyStroke?: boolean;
}

/** What tree a single-layer export renders. A slice renders its container
 *  (or the whole page when overlap is not ignored) cropped to the slice
 *  rect; a page renders the document root cropped to the content box. */
export interface SvgScope {
  root?: XNode;
  page?: boolean;
}

/** Resolved render options, threaded from `exportSvg` down to the shapes. */
export interface SvgOpts {
  outlineText?: boolean;
  simplifyStroke?: boolean;
}

/**
 * The id for a layer, when the export asks for one. bases it on the name
 * in the Layers panel, tidied into something an `id` selector accepts - a name
 * like "Card / Header" would otherwise end the attribute early and produce
 * markup no parser can read.
 */
function svgId(name: string): string {
  const clean = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "layer";
}

/** The parent of a layer, by id. `memory` has its own; this module stays free
 *  of the engine so the parity tests keep importing it alone. */
function findLocalParent(root: XNode, id: string): XNode | null {
  for (const c of root.children) {
    if (c.id === id) return root;
    const hit = findLocalParent(c, id);
    if (hit) return hit;
  }
  return null;
}

/** A layer's offset from the root, accumulating x/y down the chain. Rotation
 *  is ignored: slice math only needs the axis position. */
function offsetIn(root: XNode, id: string): { x: number; y: number } | null {
  if (root.id === id) return { x: root.x, y: root.y };
  for (const c of root.children) {
    const hit = offsetIn(c, id);
    if (hit) return { x: root.x + hit.x, y: root.y + hit.y };
  }
  return null;
}

/** The box around everything visible under a root: hidden layers and slices
 *  do not count, and neither does the root's own frame. Rotation, strokes,
 *  effects and clipping are ignored, so a rotated layer counts its unrotated
 *  box and content clipped by an overflow frame still pads the result. */
export function contentBox(root: XNode): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (n: XNode, ox: number, oy: number) => {
    for (const c of n.children) {
      if (c.visible === false || c.isSlice === true) continue;
      const x = ox + c.x;
      const y = oy + c.y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + Math.max(0, c.w));
      maxY = Math.max(maxY, y + Math.max(0, c.h));
      walk(c, x, y);
    }
  };
  walk(root, root.x, root.y);
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The whole document for one layer, at the preset's size. A slice renders
 *  its container cropped to the slice rect (or the whole page, in root
 *  coordinates, when overlap is not ignored); a page renders the root
 *  cropped to the content box, on a transparent ground. Both fall back to
 *  the plain layer render when no scope is given. */
export function exportSvg(n: XNode, p: SvgPreset, scope?: SvgScope) {
  const opts: SvgOpts = {
    outlineText: p.outlineText ?? p.format === "SVG",
    simplifyStroke: p.simplifyStroke ?? p.format === "SVG",
  };
  const id = p.includeId ? ` id="${escXml(svgId(n.name))}"` : "";
  const open = (width: number, height: number, vb: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg"${id} width="${width}" height="${height}" viewBox="${vb}"><title>${escXml(n.name)}</title>`;
  if (scope?.page) {
    const box = contentBox(n) ?? { x: 0, y: 0, w: 1, h: 1 };
    const size = svgSizeWH(box.w, box.h, p);
    // The page ground stays out of the file: a page export is transparent.
    const bare = { ...n, fill: "#00000000", imageSrc: "" };
    return `${open(size.width, size.height, `${round(box.x)} ${round(box.y)} ${round(Math.max(1, box.w))} ${round(Math.max(1, box.h))}`)}${svgNode(bare, true, opts)}</svg>`;
  }
  if (n.isSlice === true && scope?.root) {
    const size = svgSize(n, p);
    const whole = p.ignoreOverlap === false;
    const container = whole ? scope.root : (findLocalParent(scope.root, n.id) ?? scope.root);
    let vx = n.x;
    let vy = n.y;
    if (whole || container === scope.root) {
      const at = offsetIn(scope.root, n.id);
      if (at) {
        vx = at.x;
        vy = at.y;
      }
    }
    return `${open(size.width, size.height, `${round(vx)} ${round(vy)} ${round(Math.max(1, n.w))} ${round(Math.max(1, n.h))}`)}${svgNode(container, true, opts)}</svg>`;
  }
  const size = svgSize(n, p);
  return `${open(size.width, size.height, `0 0 ${Math.max(1, n.w)} ${Math.max(1, n.h)}`)}${svgNode(n, true, opts)}</svg>`;
}

/**
 * Several layers as one `<svg>`, at 1x, with their relative positions intact.
 *
 * This is the clipboard's vector flavour: what a browser, a slide deck or
 * SVG renders when ⌘C is pasted somewhere that does not
 * understand our own payload. `exportSvg` is per-layer and starts its viewBox at
 * the layer's own origin, so a multi-selection needs the bounding box of all of
 * them instead — each root keeps its offset and the viewBox starts at the
 * top-left of the group.
 */
export function exportClipSvg(nodes: XNode[]): string {
  if (!nodes.length) return "";
  const r = round;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + Math.max(1, n.w)));
  const maxY = Math.max(...nodes.map((n) => n.y + Math.max(1, n.h)));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const title = nodes.length === 1 ? `<title>${escXml(nodes[0].name)}</title>` : "";
  // svgNode(n) with top=false translates each root by its own x/y, so the
  // viewBox origin is what lines the group up inside the exported canvas.
  const body = nodes.map((n) => svgNode(n)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r(w)}" height="${r(h)}" viewBox="${r(minX)} ${r(minY)} ${r(w)} ${r(h)}">${title}${body}</svg>`;
}

/** The pixel size of the export. The scale field takes a multiplier or a size
 *  with a unit, and the viewBox stays the design size either way - which is
 *  what makes an SVG at 500w still readable as a vector. */
function svgSize(n: XNode, p: SvgPreset): { width: number; height: number } {
  return svgSizeWH(n.w, n.h, p);
}

/** The export size for an explicit box, which is what page exports size
 *  from - the root's own frame is the canvas, not the artwork. */
function svgSizeWH(w0: number, h0: number, p: SvgPreset): { width: number; height: number } {
  const w = Math.max(1, w0);
  const h = Math.max(1, h0);
  const raw = typeof p.scale === "number" ? String(p.scale) : String(p.scale ?? "1");
  const m = /^(\d*\.?\d+)\s*([xwh]?)$/.exec(raw.trim().toLowerCase().replace(",", "."));
  if (m) {
    const value = Number(m[1]);
    if (Number.isFinite(value) && value > 0) {
      if (m[2] === "w") {
        const width = Math.max(1, Math.round(value));
        return { width, height: Math.max(1, Math.round((h * value) / w)) };
      }
      if (m[2] === "h") {
        const height = Math.max(1, Math.round(value));
        return { width: Math.max(1, Math.round((w * value) / h)), height };
      }
      return { width: Math.max(1, Math.round(w * value)), height: Math.max(1, Math.round(h * value)) };
    }
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}
