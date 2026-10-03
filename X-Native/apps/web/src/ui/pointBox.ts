import type { VectorNetwork, XNode } from "../engine/types";
import { find, isEffectivelyLocked, isInstanceMember, localToWorld, worldToLocal } from "../engine/memory";
import { pathToVectorNetwork, shapePoly } from "../engine/geometry";

export interface PointBounds { x: number; y: number; w: number; h: number }
const DIRECTIONS = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

/** vecPoints indexes the editable path walk, not the network's storage order.
 * Mirror vectorNetworkToPath's walk so arbitrary graph vertex IDs stay intact. */
export function editableVertexIndices(network: VectorNetwork): number[] {
  if (!network.segments.length) return network.vertices.map((_, i) => i);
  const indices = [network.segments[0].start];
  const seen = new Set(indices);
  for (;;) {
    const next = network.segments.find((s) => s.start === indices[indices.length - 1] && !seen.has(s.end));
    if (!next) return indices;
    indices.push(next.end);
    seen.add(next.end);
  }
}

export function pointBox(root: XNode, id: string | null, selected: number[]) {
  if (!id || isEffectivelyLocked(root, id) || isInstanceMember(root, id)) return null;
  const n = find(root, id);
  if (!n) return null;
  const network = n.vectorNetwork ?? pathToVectorNetwork(n.path.length ? n.path : shapePoly(n), n.path.length ? n.closed : n.kind !== "line" && n.kind !== "arrow");
  const order = editableVertexIndices(network);
  const indices = [...new Set(selected.map((i) => order[i]).filter((i) => network.vertices[i]))];
  if (indices.length < 2) return null;
  const points = indices.map((i) => localToWorld(root, id, network.vertices[i].x, network.vertices[i].y));
  const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
  const bounds = { x, y, w: Math.max(...points.map((p) => p.x)) - x, h: Math.max(...points.map((p) => p.y)) - y };
  return { network, indices, bounds };
}

/** Figma rotates from a point-box corner while Shift is held; edge handles
 * remain resize-only (Shift constrains their proportions). */
export function isPointBoxCorner(handle: number): boolean {
  return handle === 0 || handle === 2 || handle === 4 || handle === 6;
}

/** Eight padded screen-space handles leave the anchor circles free for moving.
 * The gesture uses pointer deltas, so padding never enters the scaling math. */
export function pointBoxHandles(b: PointBounds, zoom: number): [number, number][] {
  const pad = 10 / zoom;
  return DIRECTIONS.map(([dx, dy]) => [b.x + b.w / 2 + dx * (b.w / 2 + pad), b.y + b.h / 2 + dy * (b.h / 2 + pad)]);
}
export function pointBoxHit(b: PointBounds, x: number, y: number, zoom: number): number {
  return pointBoxHandles(b, zoom).findIndex(([hx, hy]) => Math.hypot(x - hx, y - hy) * zoom < 7);
}

/** Transform only selected vertices and their attached Bézier tangents, from
 * the gesture-start network. Regions/edges and unselected vertices are retained.
 * Bounds are page-axis aligned; conversions honor all ancestor transforms. */
export function resizePointNetwork(
  root: XNode, id: string, network: VectorNetwork, indices: number[], b: PointBounds,
  corner: number, dx: number, dy: number, shift: boolean, alt: boolean,
): VectorNetwork {
  const [hx, hy] = DIRECTIONS[corner];
  const centerFactor = alt ? 2 : 1;
  let sx = hx && b.w ? Math.max(0.0001, 1 + hx * dx * centerFactor / b.w) : 1;
  let sy = hy && b.h ? Math.max(0.0001, 1 + hy * dy * centerFactor / b.h) : 1;
  if (shift) sx = sy = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
  const px = b.x + b.w * (alt || !hx ? 0.5 : hx < 0 ? 1 : 0);
  const py = b.y + b.h * (alt || !hy ? 0.5 : hy < 0 ? 1 : 0);
  const map = (x: number, y: number) => {
    const p = localToWorld(root, id, x, y);
    return worldToLocal(root, id, px + (p.x - px) * sx, py + (p.y - py) * sy);
  };
  const selected = new Set(indices);
  const vertices = network.vertices.map((v, i) => selected.has(i) ? { ...v, ...map(v.x, v.y) } : { ...v });
  const tangent = (index: number, t: { x: number; y: number } | undefined) => {
    if (!t || !selected.has(index)) return t;
    const v = network.vertices[index], p = map(v.x + t.x, v.y + t.y);
    return { x: p.x - vertices[index].x, y: p.y - vertices[index].y };
  };
  const segments = network.segments.map((s) => ({ ...s, tangentStart: tangent(s.start, s.tangentStart), tangentEnd: tangent(s.end, s.tangentEnd) }));
  return { ...network, vertices, segments };
}

/** Rotate selected anchors and their handles in page space. `degrees` is an
 * unsnapped delta; the canvas applies Figma's 15-degree snap before calling. */
export function rotatePointNetwork(
  root: XNode, id: string, network: VectorNetwork, indices: number[],
  bounds: PointBounds, degrees: number,
): VectorNetwork {
  if (!Number.isFinite(degrees) || degrees === 0) return network;
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2;
  const map = (x: number, y: number) => {
    const p = localToWorld(root, id, x, y);
    return worldToLocal(root, id,
      cx + (p.x - cx) * cos - (p.y - cy) * sin,
      cy + (p.x - cx) * sin + (p.y - cy) * cos,
    );
  };
  return transformSelectedVertices(network, indices, map);
}

/** Temporarily reposition selected points while Space is held during a point-
 * box transform. Page-space deltas preserve behavior under nested transforms. */
export function translatePointNetwork(
  root: XNode, id: string, network: VectorNetwork, indices: number[], dx: number, dy: number,
): VectorNetwork {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return network;
  const map = (x: number, y: number) => {
    const p = localToWorld(root, id, x, y);
    return worldToLocal(root, id, p.x + dx, p.y + dy);
  };
  return transformSelectedVertices(network, indices, map);
}

function transformSelectedVertices(
  network: VectorNetwork,
  indices: number[],
  map: (x: number, y: number) => { x: number; y: number },
): VectorNetwork {
  const selected = new Set(indices);
  const vertices = network.vertices.map((v, i) => selected.has(i) ? { ...v, ...map(v.x, v.y) } : { ...v });
  const tangent = (index: number, t: { x: number; y: number } | undefined) => {
    if (!t || !selected.has(index)) return t ? { ...t } : undefined;
    const v = network.vertices[index], p = map(v.x + t.x, v.y + t.y);
    return { x: p.x - vertices[index].x, y: p.y - vertices[index].y };
  };
  const segments = network.segments.map((s) => ({
    ...s,
    tangentStart: tangent(s.start, s.tangentStart),
    tangentEnd: tangent(s.end, s.tangentEnd),
  }));
  return { ...network, vertices, segments };
}
