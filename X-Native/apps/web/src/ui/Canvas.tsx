import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Engine, Interaction, NodeKind, PathPoint, ProtoAnim, ProtoTrigger, Snapshot, StrokeCap, Tool, VectorNetwork, XNode } from "../engine/types";
import { checkCondition, triggerInteractions } from "../engine/protoEval";
import { resolveVariable } from "../engine/variables";
import { prefersReducedMotion } from "./a11y";
import { deepestFrame, find, findParent, hitTest, insideInstance, previewBoolean, worldToLocal, worldPos } from "../engine/memory";
import { layersAt } from "./selectSame";
import { rememberImage, hydrateNodes } from "../engine/assets";
import { rotateAboutOrigin } from "./scaleModel";
import {
  erasePath,
  shapePoly,
  simplifyPath,
  smoothPath,
  vertexDegree,
  insertPointOnPath,
  projectPointOnSegment,
  computeConnectorNoodle,
  pathToVectorNetwork,
  balanceLines,
  cornerPinPoints,
  cornerRadiiOf,
  hasCornerSmoothing,
  roundRectRadii,
  pathBounds,
  fillNetworkRegionAtPoint,
  outlineVariableStroke,
  widthProfileStations,
} from "../engine/geometry";
import { dashArray, miterLimitFromAngle, sampleVariableWidth, sideCones, sideWidths, sidesSupported, usesVariableWidth } from "../engine/strokeModel";
import { interpolateMatchingLayers, solveEasing, applyInterpolatedFrame } from "../engine/smartAnimate";
import {
  roundBox,
  snapCandidates,
  snapMove,
  snapResize,
  wantsPixelSnap,
  type Box,
  type GapBadge,
  type Guide,
} from "../engine/snapping";
import { fillStyle, paintDropShadows, paintExtraStrokes, paintFill, paintImageFill, paintInnerShadows } from "../engine/paint";
import { registerPenFinisher } from "./penDraft";
import { clampZoom, normalizeWheelDelta, wheelZoomFactor } from "../engine/view";
import { Rulers } from "./Rulers";
import { Guides } from "./Guides";
import { Minimap } from "./Minimap";
import { Comments } from "./Comments";
import { useTheme } from "./theme";
import { hugSize, listGutter, listMarker, measureCached, textMetrics, wrapLines } from "./textLayout";
import { canvasBlend, cssRgba, eyedropArmed, isNone, parseHex, readableLabel, takeEyedrop, toHex } from "./color";
import { ContextMenu, canvasMenu, isGroupNode, runMenu } from "./ContextMenu";
import { importSvg, type ImportedNode } from "../engine/svgImport";
import { importSketch } from "../engine/sketchImport";
import { importFig, importFigContainer } from "../engine/figImport";
import {
  markPasteEvent,
  parseClipboard,
  pasteInPlace,
  readSystemClipboard,
  type ClipPayload,
} from "../engine/clipboard";
import { toast } from "./toast";
import { Icon } from "./icons";
import { zoomAtPoint, zoomToRect } from "./zoom";
import { getNudgePrefs } from "./nudgePrefs";
import { alignKey } from "../engine/layout";
import { ContextToolbar } from "./x-ui";
import { addAutoLayout, removeAutoLayout } from "./layoutActions";
import { align } from "./inspector";

/** Snap radius in screen pixels; divided by zoom to get world tolerance. */
const SNAP_PX = 6;
/** Eraser brush radius, in screen pixels. */
const ERASER_PX = 10;
/** RDP tolerance for freehand strokes, in screen pixels. */
const PENCIL_TOLERANCE_PX = 2;

/** X-Native signature brand accents (Graphite & Signal Emerald). */
const BRAND_ACCENT = "#10b981";
/** Component/prototype identity on canvas. Paired with `--comp` in styles.css
 *  (layer rows); canvas literals can't read CSS vars per-frame, so the two
 *  are kept in step by hand — change both. */
const COMP_PURPLE = "#a855f7";
const BRAND_ACCENT_WASH = "rgba(16, 185, 129, 0.14)";
const BRAND_ACCENT_GLOW = "rgba(16, 185, 129, 0.35)";

const CREATE: Tool[] = [
  "frame",
  "section",
  "rect",
  "ellipse",
  "text",
  "line",
  "arrow",
  "poly",
  "star",
  "image",
];

function kindOf(t: Tool): NodeKind | null {
  if (t === "section") return "frame";
  if (t === "slice") return "rect";
  if (t === "pen" || t === "pencil" || t === "brush") return null;
  if (t === "image") return "rect";
  if (CREATE.includes(t)) return t as NodeKind;
  return null;
}

/** Per-node state captured at the start of a group transform. */
interface MultiOrigin {
  id: string;
  /** World-space box before the transform. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Local (parent-relative) origin, which is what `resize` actually writes. */
  lx: number;
  ly: number;
}

type Drag =
  | {
      mode:
        | "pan"
        | "move"
        | "create"
        | "resize"
        | "marquee"
        | "rotate"
        | "vec"
        | "bend"
        | "grad"
        | "multiResize"
        | "multiRotate"
        | "autoPad"
        | "autoGap"
        | "protoConnect"
        | "starRatio"
        | "starRadius"
        | "starCount"
        | "polyRadius"
        | "polyCount"
        | "radius"
        | "arc"
        | "rotOrigin";
      /** Zoom-tool drag: the create block zooms to the rect instead of
       *  committing a node. */
      zoom?: boolean;
      point?: number;
      segIndex?: number;
      handle?: "in" | "out" | "g" | "h";
      padEdge?: "top" | "right" | "bottom" | "left";
      forcedSide?: "right" | "bottom" | "left" | "top";
      /** ⌥ at the padding handle: the opposite side follows. ⌥⇧: all four. */
      padOpp?: boolean;
      padAll?: boolean;
      /** A padding handle that was clicked rather than dragged opens a field to
       *  type a value into: "Click handles to open input fields and
       *  enter a numeric value". */
      moved?: boolean;
      origPad?: [number, number, number, number];
      origGap?: number;
      fromX?: number;
      fromY?: number;
      sx: number;
      sy: number;
      wx: number;
      wy: number;
      orig?: { x: number; y: number; w: number; h: number; rotation: number };
      /** The same node's box in its parent's space: a rotation about a moved
       *  origin slides the box, and sliding needs the local start to slide
       *  from, or the drag drifts with the pointer. */
      origLocal?: { x: number; y: number };
      corner?: number;
      id?: string;
      duped?: boolean;
      /** Selection when a ⇧-marquee started: the band unions with this, so
       *  shrinking the band lets go of layers instead of accumulating them. */
      sel0?: string[];
      axis?: "x" | "y" | null;
      /** Combined selection bounds at drag start (group transforms). */
      bounds?: { x: number; y: number; w: number; h: number };
      origs?: MultiOrigin[];
      origPts?: PathPoint[];
      startAngle?: number;
      origRotation?: number;
      cx?: number;
      cy?: number;
    };

/** Snapshot every selected node's world + local box before a group transform. */
function multiOrigins(root: XNode, ids: string[]): MultiOrigin[] {
  const out: MultiOrigin[] = [];
  for (const id of ids) {
    const wp = worldPos(root, id);
    if (!wp || wp.node.locked) continue;
    out.push({
      id,
      x: wp.x,
      y: wp.y,
      w: wp.node.w,
      h: wp.node.h,
      rotation: wp.node.rotation,
      lx: wp.node.x,
      ly: wp.node.y,
    });
  }
  return out;
}

/** Whether the selected layer, or the frame it sits inside, carries an auto
 *  layout - the question the context menu's Add/Remove entry turns on. */
function hasLayout(snap: Snapshot): boolean {
  const root = snap.pages[snap.page].root;
  const id = snap.selection[0];
  if (!id) return false;
  const n = find(root, id);
  if (!n) return false;
  return !!n.layout || !!findParent(root, id)?.layout;
}

/** Computes accurate visual bounding box for any node, factoring cubic Bézier curves for vectors. */
function nodeVisualBounds(wp: { x: number; y: number; node: XNode }): { x: number; y: number; w: number; h: number } {
  if ((wp.node.kind === "vector" || wp.node.kind === "boolean") && wp.node.path.length > 0) {
    const pb = pathBounds(wp.node.path, wp.node.closed);
    return {
      x: wp.x + pb.minX,
      y: wp.y + pb.minY,
      w: pb.w,
      h: pb.h,
    };
  }
  return {
    x: wp.x,
    y: wp.y,
    w: wp.node.w,
    h: wp.node.h,
  };
}

export function Canvas({
  engine,
  snap,
  onRunInteraction,
}: {
  engine: Engine;
  snap: Snapshot;
  onRunInteraction?: (runner: (ix: Interaction, sourceId?: string) => void) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  const imgs = useRef(new Map<string, HTMLImageElement>());
  // Layer-blur raster cache: a filtered node repaints identically every pan
  // frame while the blur dominates paint cost (profiled: 99.7% native in
  // d-pan), so each eligible leaf's filtered raster is kept offscreen and
  // blitted until its inputs change. The signature fully determines the
  // raster, so entries are safe to share across documents; bounded by bytes
  // with LRU eviction.
  const blurCache = useRef(new Map<string, { c: HTMLCanvasElement; pad: number; bytes: number }>());
  const blurCacheBytes = useRef(0);
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [frameEdit, setFrameEdit] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  const [draftComment, setDraftComment] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; wx: number; wy: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingImage = useRef<{ x: number; y: number } | null>(null);
  const vecEdit = snap.vecEdit ?? null;
  const setVecEdit = useCallback(
    (id: string | null, ptIndex: number | null = null, ptIndices: number[] = []) => {
      engine.dispatch({ type: "setVecEdit", id, pointIndex: ptIndex, pointIndices: ptIndices });
    },
    [engine],
  );
  const [vecSubTool, setVecSubTool] = useState<"select" | "bend" | "paint" | "shapeBuilder" | "eraser" | "lasso">("select");
  const [draft, setDraft] = useState<PathPoint[]>([]);
  const [ghost, setGhost] = useState<PathPoint | null>(null);
  const [hoverId, setHoverId] = useState("");
  const [panelHover, setPanelHover] = useState("");
  const [transition, setTransition] = useState<ProtoAnim | null>(null);
  const [animFrame, setAnimFrame] = useState<{
    frame: XNode;
    toFrame?: XNode;
    progress: number;
    type: ProtoAnim;
    targetId?: string;
  } | null>(null);
  const pencil = useRef<PathPoint[] | null>(null);
  const penDrag = useRef<{ i: number; x: number; y: number } | null>(null);
  /**
   * Set while the pen is drawing a branch into an existing vector network: the
   * node to keep adding to and the vertex index the next click connects from.
   * Vector networks "don't require a specific direction" — clicking a point of
   * the selected shape with the pen resumes drawing from that point, in any
   * direction, in the same layer.
   */
  const penBranch = useRef<{ id: string; vertex: number } | null>(null);
  const [closeHint, setCloseHint] = useState<number | null>(null);
  const vecPt = useRef(-1);
  useEffect(() => {
    if (snap.vecPoint !== undefined && snap.vecPoint !== null) {
      vecPt.current = snap.vecPoint;
    }
  }, [snap.vecPoint]);
  const hoverIx = useRef("");
  /** Present-mode drag origin for the onDrag trigger; cleared on pointer-up. */
  const dragIx = useRef<{ x: number; y: number; id: string; fired: boolean } | null>(null);
  /** Cursor implied by whatever selection chrome is under the pointer. */
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  /* Keeps the rotation origin out of the way until `⌥R` asks for it. */
  const [rotTarget, setRotTarget] = useState(false);
  /** An open padding entry, from clicking a handle on an auto layout frame. */
  const [padInput, setPadInput] = useState<{
    id: string;
    edge: "top" | "right" | "bottom" | "left";
    value: number;
    left: number;
    top: number;
    opp: boolean;
    all: boolean;
  } | null>(null);
  /** Viewport size, tracked so the ruler overlay can size its own canvas. */
  const [box, setBox] = useState({ w: 0, h: 0 });
  /** Live smart-guide overlay, produced by the snapping pass during a drag. */
  const [guides, setGuides] = useState<Guide[]>([]);
  const [gapBadges, setGapBadges] = useState<GapBadge[]>([]);
  /** Live Alt/Option distance measurement state */
  const [altMeasure, setAltMeasure] = useState(false);
  /** Live prototype connection dragging state */
  const [protoDrag, setProtoDrag] = useState<{
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    srcId?: string;
    targetId?: string;
    forcedSide?: "right" | "bottom" | "left" | "top";
  } | null>(null);
  /** Selected prototype connection for on-canvas deletion and details */
  const [selectedConn, setSelectedConn] = useState<{
    srcId: string;
    destId: string;
    midX: number;
    midY: number;
    label: string;
  } | null>(null);
  /** Static snap targets, captured once at drag start so they never shift mid-drag. */
  const snapTargets = useRef<Box[]>([]);
  const { theme } = useTheme();
  const runInteraction = useCallback(
    (ix: Interaction, sourceId?: string) => {
      // Conditions gate the whole interaction, animated or not.
      if (ix.condition) {
        const s = engine.snapshot();
        if (!checkCondition(s.variables ?? [], s.variableCollections ?? [], s.activeModes ?? {}, ix.condition)) return;
      }
      const reduced = prefersReducedMotion();
      const run = () => {
        if (ix.action === "back") engine.dispatch({ type: "presentBack" });
        else if (ix.action === "navigate" && ix.destination) engine.dispatch({ type: "presentGo", id: ix.destination });
        else if (ix.action === "openUrl" && ix.destination) {
          const url = /^https?:\/\//i.test(ix.destination) ? ix.destination : `https://${ix.destination}`;
          window.open(url, "_blank", "noopener,noreferrer");
        } else if (ix.action === "scrollTo" && ix.destination) {
          const root = engine.snapshot().pages[engine.snapshot().page].root;
          const target = worldPos(root, ix.destination);
          if (target) {
            engine.dispatch({
              type: "setPan",
              x: -target.x * engine.snapshot().zoom + 120,
              y: -target.y * engine.snapshot().zoom + 120,
            });
          }
        } else if (ix.action === "openOverlay" && ix.destination) {
          engine.dispatch({
            type: "openOverlay",
            id: ix.destination,
            position: ix.overlayPosition || "center",
            closeOutside: ix.overlayCloseOutside !== false,
            backdrop: ix.overlayBackdrop !== false,
            backdropColor: ix.overlayBackdropColor,
          });
        } else if (ix.action === "swapOverlay" && ix.destination) {
          engine.dispatch({
            type: "openOverlay",
            id: ix.destination,
            position: ix.overlayPosition || "center",
            closeOutside: ix.overlayCloseOutside !== false,
            backdrop: ix.overlayBackdrop !== false,
            backdropColor: ix.overlayBackdropColor,
          });
        } else if (ix.action === "closeOverlay") {
          engine.dispatch({ type: "closeOverlay" });
        } else if (ix.action === "setVariable" && ix.variableId) {
          const s = engine.snapshot();
          const vars = s.variables ?? [];
          const cur = resolveVariable(vars, s.variableCollections ?? [], s.activeModes ?? {}, ix.variableId);
          if (cur && !cur.broken) {
            let nextVal: string | number | boolean = ix.variableValue !== undefined ? ix.variableValue : cur.value;
            if (ix.variableOp === "increment" && typeof cur.value === "number") nextVal = cur.value + 1;
            else if (ix.variableOp === "decrement" && typeof cur.value === "number") nextVal = cur.value - 1;
            else if (ix.variableOp === "toggle" && typeof cur.value === "boolean") nextVal = !cur.value;
            engine.dispatch({ type: "patchVariable", id: ix.variableId, patch: { value: nextVal } });
          }
        } else if (ix.action === "setVariant" && ix.variantName && sourceId) {
          // Interactive components: swap the interaction's own instance.
          engine.dispatch({ type: "setVariant", id: sourceId, name: ix.variantName });
        }
      };
      if (reduced || ix.animation === "instant" || !ix.animation || ix.action === "openUrl" || ix.action === "scrollTo" || ix.action === "setVariable" || ix.action === "setVariant") {
        run();
        return;
      }

      const root = engine.snapshot().pages[engine.snapshot().page].root;
      const fromId = engine.snapshot().presentFrame;
      const fromNode = fromId ? find(root, fromId) : null;
      let destId: string | undefined = ix.destination;
      if (ix.action === "back") {
        const stack = engine.snapshot().presentStack;
        destId = stack.length > 1 ? stack[stack.length - 2] : undefined;
      }
      const toNode = destId ? find(root, destId) : null;

      if (fromNode && toNode && (ix.action === "navigate" || ix.action === "back")) {
        const dur = ix.duration || (ix.animation === "smart" ? 300 : 250);
        const easing = ix.easing || "easeOut";
        const start = performance.now();

        const tick = () => {
          const now = performance.now();
          const elapsed = now - start;
          const t = Math.min(1, Math.max(0, elapsed / dur));
          const easedT = solveEasing(easing, t);

          if (ix.animation === "smart") {
            const interpolated = interpolateMatchingLayers(fromNode, toNode, t, easing);
            const morphed = applyInterpolatedFrame(toNode, interpolated, fromNode);
            setAnimFrame({ frame: morphed, progress: easedT, type: "smart", targetId: toNode.id });
          } else {
            setAnimFrame({ frame: fromNode, toFrame: toNode, progress: easedT, type: ix.animation, targetId: toNode.id });
          }

          if (t < 1) {
            requestAnimationFrame(tick);
          } else {
            setAnimFrame(null);
            run();
          }
        };
        requestAnimationFrame(tick);
        return;
      }

      setTransition(ix.animation);
      const dur = ix.duration || (ix.animation === "smart" ? 260 : 220);
      window.setTimeout(() => {
        run();
        setTransition(null);
      }, dur);
    },
    [engine],
  );

  /** Run every match for a trigger (innermost node wins); true when any ran. */
  const runTrigger = useCallback(
    (root: XNode, startId: string, trigger: ProtoTrigger) => {
      const hit = triggerInteractions(root, startId, trigger);
      if (!hit) return false;
      for (const ix of hit.list) runInteraction(ix, hit.nodeId);
      return true;
    },
    [runInteraction],
  );

  useEffect(() => {
    if (onRunInteraction) onRunInteraction(runInteraction);
  }, [onRunInteraction, runInteraction]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement;
      const isTyping =
        targetEl?.tagName === "INPUT" ||
        targetEl?.tagName === "TEXTAREA" ||
        targetEl?.tagName === "SELECT" ||
        targetEl?.isContentEditable ||
        !!targetEl?.closest?.("input, textarea, select, [contenteditable='true'], .x-field, .x-popover, .inspector");
      if (isTyping && e.key !== "Escape") return;

      // Present-mode key triggers: every matching interaction in the frame runs.
      if (e.type === "keydown" && snap.presentFrame && e.key !== "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const root = snap.pages[snap.page].root;
        const frame = find(root, snap.presentFrame);
        if (frame) {
          const matches: { nodeId: string; ix: Interaction }[] = [];
          const collect = (n: XNode) => {
            for (const ix of n.interactions ?? []) {
              if (ix.trigger === "keyPress" && ix.keyKey === e.key) matches.push({ nodeId: n.id, ix });
            }
            for (const ch of n.children) collect(ch);
          };
          collect(frame);
          if (matches.length) {
            e.preventDefault();
            for (const m of matches) runInteraction(m.ix, m.nodeId);
            return;
          }
        }
      }

      // The alignment box in the right panel owns arrows and W/A/S/D while it
      // is focused, so the canvas does not nudge under it. Other letters still
      // reach the app's own shortcuts.
      if (
        !e.metaKey &&
        !e.ctrlKey &&
        alignKey(e.key) &&
        targetEl?.closest?.("[data-align-box]")
      )
        return;
      if (e.key === "Alt") {
        setAltMeasure(e.type === "keydown");
      }
      if (e.code === "Space") {
        space.current = e.type === "keydown";
        if (e.type === "keydown" && !isTyping)
          e.preventDefault();
      }
      if (e.type === "keydown" && (e.key === "Escape" || e.key === "Enter") && (draft.length >= 2 || penBranch.current)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (draft.length >= 2) engine.dispatch({ type: "addPath", points: draft, closed: false });
        setDraft([]);
        setCloseHint(null);
        penBranch.current = null;
        return;
      }
      if (e.type === "keydown" && e.key === "Escape" && snap.booleanPreview && draft.length < 2 && !penBranch.current) {
        engine.dispatch({ type: "setBooleanPreview", op: null });
        e.stopImmediatePropagation();
        return;
      }
      if (e.type === "keydown" && e.key === "Enter" && snap.booleanPreview && !draft.length && !penBranch.current && !edit && !vecEdit) {
        engine.dispatch({ type: "boolean", op: snap.booleanPreview });
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      if (e.type === "keydown" && e.key === "Escape" && draft.length < 2) {
        setDraft([]);
        setCloseHint(null);
        penBranch.current = null;
        return;
      }
      if (e.type === "keydown" && e.key === "Backspace" && draft.length && !edit) {
        e.stopImmediatePropagation();
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
        return;
      }
      // ⌥R reveals the rotation-origin target (e.code: macOS types ® for ⌥R).
      // Meta and shift stay out: ⌥⇧⌘R is resize-to-fit and must not also
      // toggle this, since both key handlers hear every keystroke.
      if (e.type === "keydown" && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyR" && !edit) {
        // It rotates about itself until it is moved, and Escape puts it away
        // again. A multi-selection turns about the middle of its bounds and
        // has nothing to drag.
        setRotTarget((v) => !v);
        if (!rotTarget && snap.selection.length > 1) {
          toast("Rotation origin · pick one layer to move it");
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.type === "keydown" && e.key === "Escape" && rotTarget) {
        setRotTarget(false);
        e.stopImmediatePropagation();
        return;
      }
      if (e.type === "keydown" && e.key === "Tab" && !edit && !draft.length) {
        const root = snap.pages[snap.page].root;
        const id = snap.selection[0];
        if (id) {
          const par = findParent(root, id) ?? root;
          const kids = par.children.filter((c) => c.visible && !c.locked);
          const i = kids.findIndex((c) => c.id === id);
          if (i >= 0 && kids.length) {
            const next = e.shiftKey ? kids[(i - 1 + kids.length) % kids.length] : kids[(i + 1) % kids.length];
            engine.dispatch({ type: "select", ids: [next.id] });
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
        }
      }
      if (e.type === "keydown" && e.key === "Enter" && !edit) {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
        const root = snap.pages[snap.page].root;
        const id = snap.selection[0];
        const n = id ? worldPos(root, id)?.node : null;
        if (e.shiftKey && id) {
          const par = findParent(root, id);
          if (par && par !== root) engine.dispatch({ type: "select", ids: [par.id] });
          e.stopImmediatePropagation();
          return;
        }
        if (n?.kind === "text") {
          // The editor is mounted from this very keystroke, so the browser would
          // deliver the Return to the new textarea as well - typing a line break
          // at the top of the copy before a character was entered.
          e.preventDefault();
          setEdit({ id: n.id, text: n.text });
        }
        else if (
          n &&
          (n.kind === "frame" || n.kind === "group" || (n.kind === "boolean" && n.children.length > 0)) &&
          n.children.length &&
          !vecEdit
        ) {
          const child = n.children.find((c) => c.visible && !c.locked) ?? n.children[0];
          engine.dispatch({ type: "select", ids: [child.id] });
          e.stopImmediatePropagation();
        } else if (
          n &&
          !vecEdit &&
          (n.kind === "vector" ||
            n.kind === "boolean" ||
            n.kind === "rect" ||
            n.kind === "ellipse" ||
            n.kind === "poly" ||
            n.kind === "star" ||
            n.kind === "line" ||
            n.kind === "arrow")
        ) {
          if (n.kind !== "vector") {
            engine.dispatch({ type: "flatten" });
            const newId = engine.snapshot().selection[0];
            setVecEdit(newId);
          } else {
            setVecEdit(n.id);
          }
          e.stopImmediatePropagation();
        } else if (vecEdit) {
          setVecEdit(null);
        }
      }
      if (e.type === "keydown" && e.key === "Escape" && vecEdit) {
        setVecEdit(null);
        e.stopImmediatePropagation();
      }
      if (e.type === "keydown" && (e.key === "Delete" || e.key === "Backspace") && selectedConn && !edit) {
        engine.dispatch({ type: "deleteInteraction", id: selectedConn.srcId, destId: selectedConn.destId });
        setSelectedConn(null);
        toast("Connection deleted");
        e.stopImmediatePropagation();
        return;
      }
      if (e.type === "keydown" && (e.key === "Delete" || e.key === "Backspace") && vecEdit && !edit) {
        const n = worldPos(snap.pages[snap.page].root, vecEdit)?.node;
        if (n?.path.length) {
          const selectedSet = new Set<number>(
            snap.vecPoints && snap.vecPoints.length > 0
              ? snap.vecPoints
              : vecPt.current >= 0
                ? [vecPt.current]
                : [n.path.length - 1],
          );
          const isHeal = e.shiftKey;
          let path = [...n.path];
          if (isHeal && path.length >= 3 && selectedSet.size === 1) {
            const i = Array.from(selectedSet)[0];
            const prevIdx = i > 0 ? i - 1 : (n.closed ? path.length - 1 : null);
            const nextIdx = i < path.length - 1 ? i + 1 : (n.closed ? 0 : null);
            if (prevIdx !== null && nextIdx !== null) {
              const p0 = path[prevIdx];
              const p1 = path[nextIdx];
              const dx = p1.x - p0.x;
              const dy = p1.y - p0.y;
              const dist = Math.hypot(dx, dy);
              if (dist > 0.001) {
                const tx = (dx / dist) * Math.min(dist / 3, 30);
                const ty = (dy / dist) * Math.min(dist / 3, 30);
                path[prevIdx] = { ...p0, ox: tx, oy: ty };
                path[nextIdx] = { ...p1, ix: -tx, iy: -ty };
              }
            }
            toast("Point deleted & healed");
          }
          path = path.filter((_, j) => !selectedSet.has(j));
          engine.dispatch({ type: "patchPath", id: n.id, path, closed: n.closed });
          const firstSel = Math.min(...Array.from(selectedSet));
          const nextPt = path.length ? Math.max(0, Math.min(path.length - 1, firstSel)) : -1;
          vecPt.current = nextPt;
          setVecEdit(n.id, nextPt >= 0 ? nextPt : null, nextPt >= 0 ? [nextPt] : []);
          e.stopImmediatePropagation();
        }
      }
      // Vector editing mirror modes: 1=Straight, 2=Mirrored, 3=Disconnected, 4=Asymmetric
      if (e.type === "keydown" && !e.metaKey && !e.ctrlKey && !e.altKey && vecEdit && !edit) {
        const ptIdx = snap.vecPoint ?? vecPt.current;
        if (ptIdx >= 0) {
          if (e.key === "1") {
            engine.dispatch({ type: "setPointMirror", id: vecEdit, pointIndex: ptIdx, mode: "none" });
            toast("Point: Straight");
            e.stopImmediatePropagation();
            return;
          }
          if (e.key === "2") {
            engine.dispatch({ type: "setPointMirror", id: vecEdit, pointIndex: ptIdx, mode: "angleAndLength" });
            toast("Point: Mirrored");
            e.stopImmediatePropagation();
            return;
          }
          if (e.key === "3") {
            engine.dispatch({ type: "setPointMirror", id: vecEdit, pointIndex: ptIdx, mode: "none" });
            toast("Point: Disconnected");
            e.stopImmediatePropagation();
            return;
          }
          if (e.key === "4") {
            engine.dispatch({ type: "setPointMirror", id: vecEdit, pointIndex: ptIdx, mode: "angle" });
            toast("Point: Asymmetric");
            e.stopImmediatePropagation();
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [snap, edit, draft, engine, vecEdit, runInteraction]);

  // Escape finishes the path and leaves it open. The finisher is published
  // to ui/penDraft.ts because that is the layer which actually decides Escape.
  useEffect(() => {
    if (!draft.length) {
      registerPenFinisher(null);
      return undefined;
    }
    registerPenFinisher(() => {
      if (draft.length >= 2) engine.dispatch({ type: "addPath", points: draft, closed: false });
      setDraft([]);
      setCloseHint(null);
      penBranch.current = null;
    });
    return () => registerPenFinisher(null);
  }, [draft, engine]);

  // When switching away from drawing tools (e.g. to select or hand), auto-commit any draft path so it appears in layers
  useEffect(() => {
    if (snap.tool !== "pen" && snap.tool !== "pencil" && snap.tool !== "brush" && draft.length) {
      if (draft.length >= 2) {
        engine.dispatch({ type: "addPath", points: draft, closed: false });
      }
      setDraft([]);
      setCloseHint(null);
      penBranch.current = null;
    }
  }, [snap.tool, draft, engine]);

  useEffect(() => {
    if (vecEdit && !snap.selection.includes(vecEdit)) setVecEdit(null);
  }, [snap.selection, vecEdit]);

  useEffect(() => {
    if (!snap.presentFrame) {
      hoverIx.current = "";
      return;
    }
    const root = snap.pages[snap.page].root;
    const n = snap.presentFrame ? find(root, snap.presentFrame) : null;
    const hit = n ? triggerInteractions(root, n.id, "afterDelay") : null;
    if (!hit) return;
    // Each action keeps its own delay.
    const timers = hit.list.map((ix) =>
      window.setTimeout(() => runInteraction(ix, hit.nodeId), Math.max(0, ix.delay ?? 800)),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [snap.presentFrame, snap.page, snap.pages, runInteraction]);

  useEffect(() => {
    const c = ref.current;
    const box = wrap.current;
    if (!c || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth;
    const h = box.clientHeight;
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    const mainCtx = c.getContext("2d");
    if (!mainCtx) return;
    // Swap slot for the blur cache: a cache miss re-enters paint() with ctx
    // pointed at an offscreen canvas, guarded by cachingBlur.
    let ctx: CanvasRenderingContext2D = mainCtx;
    let cachingBlur = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const canvasBg = css.getPropertyValue("--canvas").trim() || "#e5e5e5";
    const grid = css.getPropertyValue("--grid").trim() || "rgba(0,0,0,0.06)";
    const themeLabel = css.getPropertyValue("--canvas-label").trim() || "rgba(0,0,0,0.45)";
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, w, h);
    const pageRoot = snap.pages[snap.page].root;
    const pageFill =
      pageRoot.fillVisible !== false && !isNone(pageRoot.fill)
        ? cssRgba(pageRoot.fill, pageRoot.fillOpacity ?? 1)
        : "";
    if (pageFill) {
      ctx.fillStyle = pageFill;
      ctx.fillRect(0, 0, w, h);
    }
    // Layer names, ruler numbers and badges are text drawn straight onto the
    // canvas, so their colour has to be legible against whatever is actually
    // behind them - the page's own background when it has one, the theme's
    // canvas otherwise. The theme's label grey is a starting point; it is
    // pushed until it clears 4.5:1, which is the difference between a name you
    // read and a name you notice.
    const canvasLabel = readableLabel(themeLabel, pageFill || canvasBg, 4.5);
    const page = snap.pages[snap.page];
    // Pixel grid paints from 400% up: below that it is grey
    // noise rather than something you can align to.
    if (page.pixelGrid && snap.zoom >= 4) {
      ctx.strokeStyle = page.pixelGridColor || grid;
      ctx.lineWidth = 1;
      const step = snap.zoom;
      ctx.beginPath();
      for (let x = snap.panX % step; x < w; x += step) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = snap.panY % step; y < h; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
    }
    const root = page.root;
    const z = snap.zoom;
    const paint = (n: XNode, px: number, py: number) => {
      if (!n.visible) return;
      const x = px + n.x;
      const y = py + n.y;
      // Viewport culling. Leaf nodes and clipped-overflow containers (frames with
      // overflow: "clip" | "scroll*") cannot paint outside their bounding box.
      // Skipping them culls entire off-screen frames/subtrees instantly.
      // Bounds are padded for stroke width, shadow offset/blur, and rotation.
      if (!n.children.length || n.overflow !== "visible") {
        let pad = (n.strokeWidth ?? 0) + 2;
        for (const st of n.strokes ?? []) {
          if (st.visible) pad = Math.max(pad, st.width + 2);
        }
        for (const e of n.effects ?? []) {
          if (!e.visible) continue;
          pad = Math.max(pad, Math.abs(e.x ?? 0) + Math.abs(e.y ?? 0) + Math.abs(e.blur ?? 0) + Math.abs(e.spread ?? 0));
        }
        const half = n.rotation ? Math.hypot(n.w, n.h) / 2 - Math.min(n.w, n.h) / 2 : 0;
        const m = (pad + half) * z + 4;
        const sx0 = snap.panX + x * z;
        const sy0 = snap.panY + y * z;
        if (sx0 + n.w * z + m < 0 || sy0 + n.h * z + m < 0 || sx0 - m > w || sy0 - m > h) return;
      }
      ctx.save();
      if (n.rotation || n.flipH || n.flipV) {
        const cx = snap.panX + (x + n.w / 2) * z;
        const cy = snap.panY + (y + n.h / 2) * z;
        ctx.translate(cx, cy);
        if (n.rotation) ctx.rotate((n.rotation * Math.PI) / 180);
        if (n.flipH || n.flipV) ctx.scale(n.flipH ? -1 : 1, n.flipV ? -1 : 1);
        ctx.translate(-cx, -cy);
      }
      // Ancestor alpha, captured before this node's own applies: a cache blit
      // re-applies exactly this, since the raster already holds the node's.
      const parentAlpha = ctx.globalAlpha;
      ctx.globalAlpha *= n.opacity;
      ctx.globalCompositeOperation = canvasBlend(n.blendMode);
      const layerBlur = (n.effects ?? []).find((e) => e.kind === "layer-blur" && e.visible);
      if (layerBlur) ctx.filter = `blur(${Math.max(0, layerBlur.blur) * z}px)`;
      const sx = snap.panX + x * z;
      const sy = snap.panY + y * z;
      const sw = n.w * z;
      const sh = n.h * z;
      // Layer-blur raster cache. Eligible only when the node paints purely
      // from its own fields: leaves (no child recursion to sign), unrotated
      // (axis-aligned blit), source-over (associative compositing), no
      // background-blur/glass (reads the live canvas), no image fill and no
      // text (async loads would bake a half-painted raster). Blitting at
      // fractional offsets resamples vs direct rasterization (measured max
      // 7/255, mean 0.6/255 on the blur corpus at 32% zoom — visually
      // identical); only smooth filtered content is cached, never crisp.
      const cacheable =
        !!layerBlur &&
        !cachingBlur &&
        !n.children.length &&
        !n.rotation &&
        !n.flipH &&
        !n.flipV &&
        n.kind !== "text" &&
        ctx.globalCompositeOperation === "source-over" &&
        !(n.effects ?? []).some((e) => e.visible && (e.kind === "background-blur" || e.kind === "glass")) &&
        !(n.fillType === "image" || (n.imageSrc && isNone(n.fill)));
      if (cacheable && layerBlur) {
        const pad = Math.ceil(Math.max(0, layerBlur.blur) * z * 3) + 2;
        const sig = `${z.toFixed(4)}|${JSON.stringify(n)}`;
        let hit = blurCache.current.get(sig);
        if (hit) {
          blurCache.current.delete(sig);
          blurCache.current.set(sig, hit);
        } else if (sw > 0 && sh > 0 && sw + pad * 2 <= 2048 && sh + pad * 2 <= 2048) {
          // Miss: rasterize through the exact same paint path into an
          // offscreen, shifted so screen coords land inside the bitmap.
          const oc = document.createElement("canvas");
          oc.width = Math.max(1, Math.floor((sw + pad * 2) * dpr));
          oc.height = Math.max(1, Math.floor((sh + pad * 2) * dpr));
          const octx = oc.getContext("2d");
          if (octx) {
            octx.setTransform(dpr, 0, 0, dpr, (pad - sx) * dpr, (pad - sy) * dpr);
            const prev = ctx;
            ctx = octx;
            cachingBlur = true;
            try {
              paint(n, px, py);
            } finally {
              cachingBlur = false;
              ctx = prev;
            }
            hit = { c: oc, pad, bytes: oc.width * oc.height * 4 };
            blurCache.current.set(sig, hit);
            blurCacheBytes.current += hit.bytes;
            while (blurCacheBytes.current > 67108864 && blurCache.current.size > 1) {
              const oldest = blurCache.current.keys().next();
              if (oldest.done) break;
              const ev = blurCache.current.get(oldest.value);
              blurCache.current.delete(oldest.value);
              if (ev) blurCacheBytes.current -= ev.bytes;
            }
          }
        }
        if (hit) {
          ctx.globalAlpha = parentAlpha;
          ctx.filter = "none";
          ctx.drawImage(hit.c, sx - hit.pad, sy - hit.pad, sw + hit.pad * 2, sh + hit.pad * 2);
          ctx.restore();
          return;
        }
        // No hit and unrasterizable: fall through to the live paint below.
      }
      const rr = roundRectRadii(n).map((r) => Math.max(0, r * z)) as [number, number, number, number];
      const round = () => {
        ctx.beginPath();
        // A smoothed corner is not a roundRect: it goes through the same outline
        // the hit test and the SVG export use, so the three cannot drift apart.
        if (hasCornerSmoothing(n)) {
          tracePath(ctx, shapePoly(n), sx, sy, z, true);
          return;
        }
        if (typeof ctx.roundRect === "function") ctx.roundRect(sx, sy, sw, sh, rr);
        else ctx.rect(sx, sy, sw, sh);
      };
      if (n.kind === "boolean" && n.booleanOp && n.children.length) {
        const dropB = (n.effects ?? []).find((e) => e.kind === "drop-shadow" && e.visible);
        if (dropB) {
          ctx.shadowColor = cssRgba(dropB.color);
          ctx.shadowBlur = Math.max(0, dropB.blur) * z;
          ctx.shadowOffsetX = dropB.x * z;
          ctx.shadowOffsetY = dropB.y * z;
        }
        paintBoolean(ctx, n, x, y, snap);
        if (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)) {
          ctx.save();
          ctx.strokeStyle = cssRgba(n.strokePaint);
          ctx.globalAlpha *= n.strokeOpacity ?? 1;
          ctx.lineWidth = Math.max(0.5, n.strokeWidth * z);
          ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
          ctx.setLineDash(n.strokeDash > 0 ? [n.strokeDash * z, (n.strokeGap || n.strokeDash) * z] : []);
          tracePath(ctx, n.path.length ? n.path : shapePoly(n), snap.panX + x * z, snap.panY + y * z, z, true);
          ctx.stroke();
          ctx.restore();
        }
        paintExtraStrokes(
          ctx,
          n,
          z,
          () => tracePath(ctx, n.path.length ? n.path : shapePoly(n), snap.panX + x * z, snap.panY + y * z, z, true),
          { x: sx, y: sy, w: sw, h: sh },
        );
        ctx.restore();
        return;
      }
      // Named so extra stroke layers can re-trace the same outline; a stroke
      // pass changes lineWidth and may clip, so the path has to be rebuilt.
      const traceShape = () => {
        if (n.kind === "text") {
          ctx.beginPath();
        } else if ((n.kind === "vector" || n.kind === "boolean") && (n.vectorNetwork || n.path.length)) {
          if (n.vectorNetwork && n.vectorNetwork.segments.length > 0) {
            traceVectorNetwork(ctx, n.vectorNetwork, snap.panX + x * z, snap.panY + y * z, z);
          } else {
            tracePath(ctx, n.path, snap.panX + x * z, snap.panY + y * z, z, n.closed);
          }
        } else if (n.kind === "ellipse") {
          ctx.beginPath();
          if (n.arcData && (n.arcData.endingAngle < Math.PI * 2 - 0.001 || n.arcData.innerRadius > 0.001 || n.arcData.startingAngle > 0.001)) {
            const sa = n.arcData.startingAngle ?? 0;
            const ea = n.arcData.endingAngle ?? Math.PI * 2;
            const ir = Math.max(0, Math.min(0.99, n.arcData.innerRadius ?? 0));
            const cx = sx + sw / 2;
            const cy = sy + sh / 2;
            const rx = Math.abs(sw / 2);
            const ry = Math.abs(sh / 2);
            if (ir > 0.001) {
              ctx.ellipse(cx, cy, rx, ry, 0, sa, ea, false);
              ctx.lineTo(cx + Math.cos(ea) * rx * ir, cy + Math.sin(ea) * ry * ir);
              ctx.ellipse(cx, cy, rx * ir, ry * ir, 0, ea, sa, true);
              ctx.closePath();
            } else if (Math.abs(ea - sa) < Math.PI * 2 - 0.001) {
              ctx.moveTo(cx, cy);
              ctx.ellipse(cx, cy, rx, ry, 0, sa, ea, false);
              ctx.closePath();
            } else {
              ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            }
          } else {
            ctx.ellipse(sx + sw / 2, sy + sh / 2, Math.abs(sw / 2), Math.abs(sh / 2), 0, 0, Math.PI * 2);
          }
        } else if (n.kind === "line" || n.kind === "arrow") {
          ctx.beginPath();
          ctx.moveTo(sx, sy + sh / 2);
          ctx.lineTo(sx + sw, sy + sh / 2);
        } else if (n.kind === "star") {
          starPath(
            ctx,
            sx + sw / 2,
            sy + sh / 2,
            Math.abs(sw / 2),
            Math.abs(sh / 2),
            n.count || 5,
            n.starRatio || 0.4,
            n.cornerRadii[0] || 0,
          );
        } else if (n.kind === "poly") {
          polyPath(
            ctx,
            sx + sw / 2,
            sy + sh / 2,
            Math.abs(sw / 2),
            Math.abs(sh / 2),
            n.count || 3,
            n.cornerRadii[0] || 0,
          );
        } else {
          round();
        }
      };
      traceShape();
      if (snap.outlineMode) {
        ctx.save();
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        traceShape();
        ctx.stroke();
        ctx.restore();
        if (n.kind === "text" && edit?.id !== n.id) {
          paintText(ctx, n, sx, sy, sw, sh, z);
        }
        if (n.kind === "frame" && n.overflow !== "visible") {
          round();
          ctx.clip();
        }
        for (const ch of n.children) paint(ch, x, y);
        ctx.restore();
        return;
      }
      const bgBlur = (n.effects ?? []).find(
        (e) => (e.kind === "background-blur" || e.kind === "glass") && e.visible,
      );
      if (bgBlur && sw > 1 && sh > 1) {
        try {
          ctx.save();
          ctx.clip();
          ctx.filter = `blur(${Math.max(0, bgBlur.blur) * z}px)`;
          ctx.drawImage(c, sx, sy, sw, sh, sx, sy, sw, sh);
          ctx.restore();
        } catch {
          /* tainted canvas */
        }
      }
      const canShadow =
        n.kind !== "text" &&
        (!!n.imageSrc ||
          (n.fillVisible !== false && !!n.fill && !isNone(n.fill) && n.kind !== "line" && n.kind !== "arrow") ||
          (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)));
      if (canShadow) paintDropShadows(ctx, n, z);
      if (n.fillType === "image" || (n.imageSrc && isNone(n.fill))) {
        let im = n.imageSrc ? imgs.current.get(n.imageSrc) : undefined;
        if (n.imageSrc && !im) {
          im = new Image();
          im.src = n.imageSrc;
          im.onload = () => engine.dispatch({ type: "select", ids: snap.selection });
          imgs.current.set(n.imageSrc, im);
        }
        if (im?.complete && im.naturalWidth) {
          ctx.save();
          ctx.globalAlpha *= n.fillOpacity ?? 1;
          ctx.globalCompositeOperation = canvasBlend(n.fillBlend);
          paintImageFill(ctx, n, im, sx, sy, sw, sh);
          ctx.restore();
        }
      } else if (
        n.fillVisible !== false &&
        n.fill &&
        !isNone(n.fill) &&
        n.kind !== "line" &&
        n.kind !== "arrow"
      ) {
        ctx.save();
        ctx.globalAlpha *= n.fillOpacity ?? 1;
        ctx.globalCompositeOperation = canvasBlend(n.fillBlend);
        paintFill(ctx, n, sx, sy, sw, sh);
        ctx.restore();
      }
      if (n.kind === "vector" && n.vectorNetwork?.regions?.some((r) => r.fill)) {
        for (const reg of n.vectorNetwork.regions) {
          if (!reg.fill || isNone(reg.fill)) continue;
          ctx.save();
          ctx.fillStyle = cssRgba(reg.fill);
          ctx.globalAlpha = (n.opacity ?? 1) * (reg.fillOpacity ?? 1);
          ctx.beginPath();
          for (const loop of reg.loops) {
            if (!loop.length) continue;
            const v0 = n.vectorNetwork.vertices[loop[0]];
            if (!v0) continue;
            ctx.moveTo(snap.panX + (x + v0.x) * z, snap.panY + (y + v0.y) * z);
            for (let i = 0; i < loop.length; i++) {
              const curIdx = loop[i];
              const nxtIdx = loop[(i + 1) % loop.length];
              const curV = n.vectorNetwork.vertices[curIdx];
              const nxtV = n.vectorNetwork.vertices[nxtIdx];
              const seg = n.vectorNetwork.segments.find(
                (s) => (s.start === curIdx && s.end === nxtIdx) || (s.start === nxtIdx && s.end === curIdx),
              );
              if (seg && (seg.tangentStart || seg.tangentEnd)) {
                const isFwd = seg.start === curIdx;
                const tStart = isFwd ? seg.tangentStart : seg.tangentEnd;
                const tEnd = isFwd ? seg.tangentEnd : seg.tangentStart;
                ctx.bezierCurveTo(
                  snap.panX + (x + curV.x + (tStart?.x || 0)) * z,
                  snap.panY + (y + curV.y + (tStart?.y || 0)) * z,
                  snap.panX + (x + nxtV.x + (tEnd?.x || 0)) * z,
                  snap.panY + (y + nxtV.y + (tEnd?.y || 0)) * z,
                  snap.panX + (x + nxtV.x) * z,
                  snap.panY + (y + nxtV.y) * z,
                );
              } else {
                ctx.lineTo(snap.panX + (x + nxtV.x) * z, snap.panY + (y + nxtV.y) * z);
              }
            }
            ctx.closePath();
          }
          ctx.fill(reg.windingRule === "EVENODD" ? "evenodd" : "nonzero");
          ctx.restore();
        }
      }
      const noise = (n.effects ?? []).find((e) => e.kind === "noise" && e.visible);
      if (noise) {
        ctx.save();
        const op = canvasBlend(noise.blend);
        if (op !== "source-over") ctx.globalCompositeOperation = op;
        paintNoise(ctx, sx, sy, sw, sh, noise.blur);
        ctx.restore();
      }
      const glass = (n.effects ?? []).find((e) => e.kind === "glass" && e.visible);
      if (glass) {
        ctx.save();
        ctx.clip();
        ctx.globalAlpha *= 0.28;
        ctx.fillStyle = glass.color || "#ffffff";
        ctx.fill();
        ctx.restore();
      }
      const texture = (n.effects ?? []).find((e) => e.kind === "texture" && e.visible);
      if (texture) paintTexture(ctx, sx, sy, sw, sh, texture.blur || 16, texture.spread || 4);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      paintInnerShadows(ctx, n, z, traceShape, { x: sx, y: sy, w: sw, h: sh });
      if (n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint)) {
        ctx.save();
        ctx.globalAlpha *= n.strokeOpacity ?? 1;
        ctx.strokeStyle = cssRgba(n.strokePaint);
        ctx.lineCap = n.strokeCap === "round" ? "round" : n.strokeCap === "square" ? "square" : "butt";
        ctx.lineJoin = n.strokeJoin === "round" ? "round" : n.strokeJoin === "bevel" ? "bevel" : "miter";
        ctx.miterLimit = miterLimitFromAngle(n.strokeMiterAngle);
        const dashes = dashArray(n.strokeDashPattern, n.strokeDash, n.strokeGap, z);
        // Dashes carry their own cap: a dotted line is a 1px dash
        // with round caps, and only the segments take the rounding.
        ctx.lineCap = n.strokeDashPattern?.length || n.strokeDash > 0 ? n.strokeDashCap ?? ctx.lineCap : ctx.lineCap;
        if (dashes.length) ctx.setLineDash(dashes);
        else ctx.setLineDash([]);
        // Individual strokes: the outline is stroked once per side, each pass
        // clipped to a 45° cone from the centre, which is how CSS mitres a
        // border and keeps a rounded corner split evenly between its sides.
        const sides = sideWidths(n.strokeSides, n.strokeSideW, n.strokeWidth);
        const perSide = sidesSupported(n.kind) && (n.strokeSides ?? "all") !== "all";
        const pass = (lw: number) => {
          if (lw <= 0) return;
          const w = Math.max(0.5, lw * z);
          if (n.kind === "vector" && n.vectorNetwork && n.vectorNetwork.segments.length > 0) {
            traceVectorSegments(ctx, n.vectorNetwork, snap.panX + x * z, snap.panY + y * z, z);
          } else {
            traceShape();
          }
          // Lines are always centre-stroked: clipping an open two-point path
          // to "inside" would clip to a zero-area region and erase the shaft.
          const align = n.kind === "line" || n.kind === "arrow" ? "center" : n.strokeAlign;
          if (align === "inside") {
            ctx.save();
            ctx.clip();
            ctx.lineWidth = w * 2;
            ctx.stroke();
            ctx.restore();
          } else if (align === "outside") {
            ctx.lineWidth = w * 2;
            ctx.stroke();
            if (n.fillVisible && !isNone(n.fill) && n.kind !== "line" && n.kind !== "arrow") {
              ctx.save();
              ctx.globalCompositeOperation = "source-over";
              paintFill(ctx, n, sx, sy, sw, sh);
              ctx.restore();
            }
          } else {
            ctx.lineWidth = w;
            ctx.stroke();
          }
        };
        // Variable-width stroke: expand the centerline to a filled outline.
        // Centre-aligned by construction — dashes and per-side splits do not
        // apply to a filled outline — and a vector with no path centerline
        // (a bare branch network) keeps its uniform segment strokes.
        let varOutline: PathPoint[] | null = null;
        if (usesVariableWidth(n)) {
          const center =
            n.path.length >= 2 ? n.path : n.kind === "line" || n.kind === "arrow" ? shapePoly(n) : null;
          if (center && center.length >= 2) {
            varOutline = outlineVariableStroke(
              center,
              sides[0],
              n.strokeWidthProfile,
              n.closed,
              n.strokeCap,
              n.strokeJoin,
              miterLimitFromAngle(n.strokeMiterAngle),
            );
          }
        }
        if (varOutline && varOutline.length >= 2) {
          tracePath(ctx, varOutline, snap.panX + x * z, snap.panY + y * z, z, true);
          ctx.fillStyle = cssRgba(n.strokePaint);
          ctx.fill();
        } else if (perSide) {
          const cones = sideCones(sx, sy, sw, sh);
          for (let i = 0; i < 4; i++) {
            if (sides[i] <= 0) continue;
            ctx.save();
            ctx.beginPath();
            cones[i].forEach(([bx, by], k) => (k ? ctx.lineTo(bx, by) : ctx.moveTo(bx, by)));
            ctx.closePath();
            ctx.clip();
            // Building the cone replaced the current path, so the shape has to
            // be traced again before it can be stroked inside the band.
            traceShape();
            pass(sides[i]);
            ctx.restore();
          }
        } else {
          pass(sides[0]);
        }
        const isTip = (c?: StrokeCap) =>
          c === "arrow" || c === "triangle" || c === "reverse-triangle" || c === "diamond" || c === "circle";
        const effEndCap = n.strokeCapEnd ?? (isTip(n.strokeCap) ? n.strokeCap : (n.kind === "arrow" ? "triangle" : "none"));
        const effStartCap = n.strokeCapStart ?? "none";
        const hasArrowCap =
          n.kind === "arrow" ||
          ((n.kind === "line" || n.kind === "vector") && !n.closed && (isTip(effEndCap) || isTip(effStartCap)));
        if (hasArrowCap) {
          ctx.setLineDash([]);
          const ah = Math.max(6, n.strokeWidth * 3 * z);
          // Variable-width tips scale with the width at their end and vanish
          // where the stroke tapers to nothing.
          const varProf = usesVariableWidth(n) ? n.strokeWidthProfile : undefined;
          const tipScale = (at: 0 | 1) => (varProf ? sampleVariableWidth(varProf, at) : 1);
          // Tips are placed on ends of an open path, with individual caps
          const ends: { ex: number; ey: number; ux: number; uy: number; cap: StrokeCap; at: 0 | 1 }[] = [];
          const pts = n.kind === "vector" || n.kind === "line" || n.kind === "arrow" ? (n.path.length ? n.path : shapePoly(n)) : [];
          if (pts.length > 1) {
            // End point (pts[pts.length - 1]): points in the direction the path was traveling
            if (isTip(effEndCap)) {
              const lastA = pts[pts.length - 1];
              const lastB = pts[pts.length - 2];
              const dxEnd = (lastA.x - lastB.x) * z;
              const dyEnd = (lastA.y - lastB.y) * z;
              const lenEnd = Math.hypot(dxEnd, dyEnd) || 1;
              ends.push({ ex: sx + lastA.x * z, ey: sy + lastA.y * z, ux: dxEnd / lenEnd, uy: dyEnd / lenEnd, cap: effEndCap, at: 1 });
            }

            // Start point (pts[0]): only if start cap is explicitly configured
            if (isTip(effStartCap)) {
              const startA = pts[0];
              const startB = pts[1];
              const dxStart = (startA.x - startB.x) * z;
              const dyStart = (startA.y - startB.y) * z;
              const lenStart = Math.hypot(dxStart, dyStart) || 1;
              ends.push({ ex: sx + startA.x * z, ey: sy + startA.y * z, ux: dxStart / lenStart, uy: dyStart / lenStart, cap: effStartCap, at: 0 });
            }
          } else {
            if (isTip(effEndCap)) {
              ends.push({ ex: sx + sw, ey: sy + sh / 2, ux: 1, uy: 0, cap: effEndCap, at: 1 });
            }
            if (isTip(effStartCap)) {
              ends.push({ ex: sx, ey: sy + sh / 2, ux: -1, uy: 0, cap: effStartCap, at: 0 });
            }
          }
          for (const e of ends) {
            const eah = ah * tipScale(e.at);
            if (eah < 0.5) continue;
            const back = (be: { ex: number; ey: number; ux: number; uy: number }, k: number, s: number) => ({
              x: be.ex - be.ux * eah + be.uy * k * s,
              y: be.ey - be.uy * eah - be.ux * k * s,
            });
            ctx.beginPath();
            if (e.cap === "arrow") {
              // Two 45° lines, the same weight as the path.
              const p1 = back(e, eah * 0.72, 1);
              const p2 = back(e, eah * 0.72, -1);
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(e.ex, e.ey);
              ctx.lineTo(p2.x, p2.y);
              ctx.lineWidth = Math.max(0.5, n.strokeWidth * tipScale(e.at) * z);
              ctx.lineCap = "butt";
              ctx.lineJoin = "miter";
              ctx.stroke();
              continue;
            }
            if (e.cap === "circle") {
              // Ring on the endpoint, stroked at the path's own weight.
              ctx.arc(e.ex, e.ey, Math.max(1, eah * 0.55), 0, Math.PI * 2);
              ctx.lineWidth = Math.max(0.5, n.strokeWidth * tipScale(e.at) * z);
              ctx.strokeStyle = cssRgba(n.strokePaint);
              ctx.stroke();
              continue;
            }
            if (e.cap === "diamond") {
              const mid = { x: e.ex - e.ux * eah * 0.8, y: e.ey - e.uy * eah * 0.8 };
              ctx.moveTo(e.ex, e.ey);
              ctx.lineTo(mid.x - e.uy * eah * 0.5, mid.y + e.ux * eah * 0.5);
              ctx.lineTo(e.ex - e.ux * eah * 1.6, e.ey - e.uy * eah * 1.6);
              ctx.lineTo(mid.x + e.uy * eah * 0.5, mid.y - e.ux * eah * 0.5);
            } else if (e.cap === "reverse-triangle") {
              // Flipped: the base sits on the end point, the apex points inward.
              ctx.moveTo(e.ex, e.ey);
              ctx.lineTo(e.ex - e.uy * eah * 0.7, e.ey + e.ux * eah * 0.7);
              ctx.lineTo(e.ex - e.ux * eah * 1.1, e.ey - e.uy * eah * 1.1);
              ctx.lineTo(e.ex + e.uy * eah * 0.7, e.ey - e.ux * eah * 0.7);
            } else {
              ctx.moveTo(e.ex, e.ey);
              ctx.lineTo(back(e, eah * 0.75, 1).x, back(e, eah * 0.75, 1).y);
              ctx.lineTo(back(e, eah * 0.75, -1).x, back(e, eah * 0.75, -1).y);
            }
            ctx.closePath();
            ctx.fillStyle = cssRgba(n.strokePaint);
            ctx.fill();
          }
        }
        ctx.restore();
      }
      paintExtraStrokes(ctx, n, z, traceShape, { x: sx, y: sy, w: sw, h: sh });
      if (n.kind === "text" && edit?.id !== n.id) {
        paintText(ctx, n, sx, sy, sw, sh, z);
      }
      if (n.kind === "frame" && n.overflow !== "visible") {
        round();
        ctx.clip();
      }
      if (
        n.kind === "frame" &&
        n.layoutGrids?.length &&
        !snap.presentFrame &&
        // View > Layout guides hides every frame's grid at once without
        // deleting them - the switch you want while looking at spacing
        // rather than columns.
        snap.viewLayoutGuides !== false
      ) {
        ctx.save();
        for (const g of n.layoutGrids) {
          if (g.visible === false) continue;
          const color = g.color || "rgba(255, 0, 0, 0.08)";
          ctx.fillStyle = color;
          if (g.pattern === "columns") {
            const count = g.count || 12;
            const gutter = g.gutter !== undefined ? g.gutter : 20;
            const margin = g.margin !== undefined ? g.margin : 20;
            const avail = n.w - margin * 2 - gutter * (count - 1);
            const colW = Math.max(1, avail / count);
            for (let ci = 0; ci < count; ci++) {
              const cx = x + margin + ci * (colW + gutter);
              ctx.fillRect(snap.panX + cx * z, snap.panY + y * z, colW * z, n.h * z);
            }
          } else if (g.pattern === "rows") {
            const count = g.count || 8;
            const gutter = g.gutter !== undefined ? g.gutter : 20;
            const margin = g.margin !== undefined ? g.margin : 20;
            const avail = n.h - margin * 2 - gutter * (count - 1);
            const rowH = Math.max(1, avail / count);
            for (let ri = 0; ri < count; ri++) {
              const cy = y + margin + ri * (rowH + gutter);
              ctx.fillRect(snap.panX + x * z, snap.panY + cy * z, n.w * z, rowH * z);
            }
          } else if (g.pattern === "grid") {
            const sz = g.sectionSize || 10;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let gx = sz; gx < n.w; gx += sz) {
              ctx.moveTo(snap.panX + (x + gx) * z, snap.panY + y * z);
              ctx.lineTo(snap.panX + (x + gx) * z, snap.panY + (y + n.h) * z);
            }
            for (let gy = sz; gy < n.h; gy += sz) {
              ctx.moveTo(snap.panX + x * z, snap.panY + (y + gy) * z);
              ctx.lineTo(snap.panX + (x + n.w) * z, snap.panY + (y + gy) * z);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
      let maskOn = 0;
      const renderChildren = n.layout?.itemReverseZIndex ? [...n.children].reverse() : n.children;
      for (const ch of renderChildren) {
        if (ch.isMask && ch.visible) {
          ctx.save();
          const mx = snap.panX + (x + ch.x) * z;
          const my = snap.panY + (y + ch.y) * z;
          const mw = ch.w * z;
          const mh = ch.h * z;
          const mcx = mx + mw / 2;
          const mcy = my + mh / 2;
          ctx.save();
          if (ch.rotation || ch.flipH || ch.flipV) {
            ctx.translate(mcx, mcy);
            if (ch.rotation) ctx.rotate((ch.rotation * Math.PI) / 180);
            if (ch.flipH || ch.flipV) ctx.scale(ch.flipH ? -1 : 1, ch.flipV ? -1 : 1);
            ctx.translate(-mcx, -mcy);
          }
          ctx.beginPath();
          if (ch.kind === "ellipse") {
            ctx.ellipse(mcx, mcy, Math.abs(mw / 2), Math.abs(mh / 2), 0, 0, Math.PI * 2);
          } else if (ch.path.length) {
            tracePath(ctx, ch.path, mx, my, z, ch.closed);
          } else if (typeof ctx.roundRect === "function") {
            const rr = ch.cornerIndependent
              ? [ch.cornerRadii[0] * z, ch.cornerRadii[1] * z, ch.cornerRadii[3] * z, ch.cornerRadii[2] * z]
              : ch.cornerRadii[0] * z;
            ctx.roundRect(mx, my, mw, mh, rr);
          } else {
            ctx.rect(mx, my, mw, mh);
          }
          ctx.restore();
          ctx.clip();
          maskOn += 1;
          continue;
        }
        paint(ch, x, y);
      }
      while (maskOn--) ctx.restore();
      ctx.restore();
    };
    const present = snap.presentFrame ? find(root, snap.presentFrame) : null;
    if (animFrame) {
      if (animFrame.type === "smart") {
        const targetId = animFrame.targetId || (present ? present.id : animFrame.frame.id);
        const wp = worldPos(root, targetId) || (present ? worldPos(root, present.id) : null);
        paint(animFrame.frame, wp ? wp.x - animFrame.frame.x : 0, wp ? wp.y - animFrame.frame.y : 0);
      } else if (animFrame.type === "dissolve" && animFrame.toFrame) {
        const wp = worldPos(root, present ? present.id : animFrame.frame.id);
        const p = animFrame.progress;
        ctx.save();
        ctx.globalAlpha = 1 - p;
        paint(animFrame.frame, wp ? wp.x - animFrame.frame.x : 0, wp ? wp.y - animFrame.frame.y : 0);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = p;
        paint(animFrame.toFrame, wp ? wp.x - animFrame.toFrame.x : 0, wp ? wp.y - animFrame.toFrame.y : 0);
        ctx.restore();
      } else if (animFrame.type.startsWith("slide") || animFrame.type.startsWith("push")) {
        const wp = worldPos(root, present ? present.id : animFrame.frame.id);
        const p = animFrame.progress;
        const w = animFrame.frame.w;
        const h = animFrame.frame.h;
        let fromDx = 0, fromDy = 0, toDx = 0, toDy = 0;
        if (animFrame.type === "slideInRight") {
          toDx = (1 - p) * w;
        } else if (animFrame.type === "slideInLeft") {
          toDx = -(1 - p) * w;
        } else if (animFrame.type === "slideInTop") {
          toDy = -(1 - p) * h;
        } else if (animFrame.type === "slideInBottom") {
          toDy = (1 - p) * h;
        } else if (animFrame.type === "pushRight") {
          fromDx = p * w;
          toDx = -(1 - p) * w;
        } else if (animFrame.type === "pushLeft") {
          fromDx = -p * w;
          toDx = (1 - p) * w;
        }
        if (animFrame.type.startsWith("push")) {
          ctx.save();
          paint(animFrame.frame, (wp ? wp.x - animFrame.frame.x : 0) + fromDx, (wp ? wp.y - animFrame.frame.y : 0) + fromDy);
          ctx.restore();
        } else {
          paint(animFrame.frame, wp ? wp.x - animFrame.frame.x : 0, wp ? wp.y - animFrame.frame.y : 0);
        }
        if (animFrame.toFrame) {
          ctx.save();
          paint(animFrame.toFrame, (wp ? wp.x - animFrame.toFrame.x : 0) + toDx, (wp ? wp.y - animFrame.toFrame.y : 0) + toDy);
          ctx.restore();
        }
      }
    } else if (present) {
      const wp = worldPos(root, present.id);
      paint(present, wp ? wp.x - present.x : 0, wp ? wp.y - present.y : 0);

      // Paint active overlay if present
      if (snap.activeOverlay?.id) {
        const overlayNode = find(root, snap.activeOverlay.id);
        if (overlayNode && wp) {
          if (snap.activeOverlay.backdrop !== false) {
            ctx.save();
            ctx.fillStyle = snap.activeOverlay.backdropColor || "rgba(0, 0, 0, 0.45)";
            ctx.fillRect(
              snap.panX + wp.x * z,
              snap.panY + wp.y * z,
              present.w * z,
              present.h * z,
            );
            ctx.restore();
          }
          let ox = wp.x + (present.w - overlayNode.w) / 2;
          let oy = wp.y + (present.h - overlayNode.h) / 2;
          if (snap.activeOverlay.position === "bottom") {
            ox = wp.x + (present.w - overlayNode.w) / 2;
            oy = wp.y + present.h - overlayNode.h;
          } else if (snap.activeOverlay.position === "top") {
            ox = wp.x + (present.w - overlayNode.w) / 2;
            oy = wp.y;
          }
          paint(overlayNode, ox - overlayNode.x, oy - overlayNode.y);
        }
      }
    } else {
      for (const ch of root.children) paint(ch, 0, 0);
    }

    // View > Pixel preview. Frames are re-read as the raster they would export
    // as - one device pixel per design pixel at 1x, two at 2x - and drawn back
    // over themselves with smoothing off, so a fractional edge or a hairline
    // stroke shows up here instead of in the exported file. Doing it as a pass
    // over the finished canvas (rather than a second renderer) keeps it exactly
    // faithful: the pixels being resampled are the ones the exporter would see.
    if (snap.pixelPreview !== "off" && !snap.presentFrame) {
      const density = snap.pixelPreview === "2x" ? 2 : 1;
      for (const top of root.children) {
        if (top.kind !== "frame" || !top.visible) continue;
        const sx = snap.panX + top.x * z;
        const sy = snap.panY + top.y * z;
        const sw = top.w * z;
        const sh = top.h * z;
        // Only the on-screen slice, so a frame larger than the window costs a
        // buffer the size of the window rather than of the frame.
        const cx0 = Math.round(Math.max(0, sx));
        const cy0 = Math.round(Math.max(0, sy));
        const cx1 = Math.round(Math.min(w, sx + sw));
        const cy1 = Math.round(Math.min(h, sy + sh));
        if (cx1 - cx0 < 2 || cy1 - cy0 < 2) continue;
        const bw = Math.max(1, Math.round(((cx1 - cx0) / z) * density));
        const bh = Math.max(1, Math.round(((cy1 - cy0) / z) * density));
        if (bw * bh > 16_000_000) continue;
        const tmp = pixelScratch(bw, bh);
        const tctx = tmp.getContext("2d");
        if (!tctx) continue;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = "high";
        tctx.clearRect(0, 0, bw, bh);
        tctx.drawImage(
          c,
          cx0 * dpr,
          cy0 * dpr,
          (cx1 - cx0) * dpr,
          (cy1 - cy0) * dpr,
          0,
          0,
          bw,
          bh,
        );
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, bw, bh, cx0, cy0, cx1 - cx0, cy1 - cy0);
        ctx.imageSmoothingEnabled = true;
      }
    }

    // A frame's name sits above its top-left corner at a constant 11px, so it
    // stays the same size as the canvas zooms. Selected or hovered, it takes
    // the accent colour indicating the name belongs to the frame you
    // are about to act on.
    const labelNames = (n: XNode, parentIsFrame: boolean, px: number, py: number) => {
      const x = px + n.x;
      const y = py + n.y;
      const screenX = snap.panX + x * z;
      const screenY = snap.panY + y * z;
      if (
        n.kind === "frame" &&
        n.showName !== false &&
        // A frame nested in another frame lives in the content flow: its tag
        // would float over sibling layers (the demo card's "Card" sat 4px
        // under body text). Top-level frames, sections and groups keep theirs.
        !parentIsFrame &&
        // Skip names whose frame is off-screen: at any zoom a page can hold
        // hundreds of them, and fillText for each is the one thing on this
        // canvas that runs per layer rather than per visible pixel.
        screenX > -400 &&
        screenX < w + 400 &&
        screenY > -40 &&
        screenY < h + 400
      ) {
        const active = snap.selection.includes(n.id) || hoverId === n.id || panelHover === n.id;
        ctx.save();
        ctx.font = active ? "600 11px Inter, system-ui" : "500 11px Inter, system-ui";
        ctx.fillStyle = active ? BRAND_ACCENT : canvasLabel;
        ctx.textBaseline = "alphabetic";
        ctx.fillText(n.name, screenX, screenY - 8);
        ctx.restore();
      }
      for (const c of n.children) labelNames(c, n.kind === "frame", x, y);
    };
    if (!snap.presentFrame) {
      for (const ch of root.children) labelNames(ch, false, 0, 0);
    }

    if (penBranch.current && snap.tool === "pen") {
      // While a branch is armed the pointer has to show what the next click will
      // do: a live segment out of the anchor, and a ring marking the vertex the
      // branch is being drawn from.
      const anchorNode = find(snap.pages[snap.page].root, penBranch.current.id);
      const vn = anchorNode?.vectorNetwork;
      const v = anchorNode && vn ? vn.vertices[penBranch.current.vertex] : null;
      if (anchorNode && v) {
        const ax = snap.panX + (anchorNode.x + v.x) * z;
        const ay = snap.panY + (anchorNode.y + v.y) * z;
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1.5;
        if (ghost) {
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(snap.panX + ghost.x * z, snap.panY + ghost.y * z);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(ax, ay, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(ax, ay, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (draft.length) {
      ctx.strokeStyle = BRAND_ACCENT;
      ctx.lineWidth = 1.5;
      const preview = ghost ? [...draft, ghost] : draft;
      tracePath(ctx, preview, snap.panX, snap.panY, z, false);
      ctx.stroke();
      for (const p of draft) {
        const i = draft.indexOf(p);
        const px = snap.panX + p.x * z;
        const py = snap.panY + p.y * z;
        if ((p.ox && p.ox !== 0) || (p.oy && p.oy !== 0) || (p.ix && p.ix !== 0) || (p.iy && p.iy !== 0)) {
          ctx.strokeStyle = BRAND_ACCENT;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + (p.ix || 0) * z, py + (p.iy || 0) * z);
          ctx.lineTo(px + (p.ox || 0) * z, py + (p.oy || 0) * z);
          ctx.stroke();
          for (const [hx, hy] of [
            [px + (p.ix || 0) * z, py + (p.iy || 0) * z],
            [px + (p.ox || 0) * z, py + (p.oy || 0) * z],
          ] as const) {
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(hx, hy, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (closeHint === i) {
          // The ring says "this click joins here / closes the path", the same
          // cue placed next to the cursor.
          ctx.beginPath();
          ctx.arc(px, py, 7, 0, Math.PI * 2);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    if (snap.rightTab === "prototype" && snap.showFlows && !snap.presentFrame) {
      // 1. Render Flow Starting Point Badge ("Flow 1") on starting frame (parity)
      const flowStartId = snap.pages[snap.page].flowStart;
      if (flowStartId) {
        const startWp = worldPos(root, flowStartId);
        if (startWp) {
          const fx = snap.panX + startWp.x * z;
          const fy = snap.panY + startWp.y * z;
          const badgeText = "Flow 1";
          ctx.save();
          ctx.font = "600 11px Inter, system-ui";
          const tw = ctx.measureText(badgeText).width;
          const pw = tw + 28;
          const ph = 22;
          const px = fx;
          const py = fy - ph - 8;

          ctx.fillStyle = BRAND_ACCENT;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(px, py, pw, ph, 11);
          } else {
            ctx.rect(px, py, pw, ph);
          }
          ctx.fill();

          // Play icon
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.moveTo(px + 8, py + 6);
          ctx.lineTo(px + 16, py + 11);
          ctx.lineTo(px + 8, py + 16);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = "#ffffff";
          ctx.fillText(badgeText, px + 20, py + 15);
          ctx.restore();
        }
      }

      // 2. Render all interaction connection noodles with smooth S-curve geometry
      walkInteractions(root, 0, 0, (n, nx, ny, destId, _ix, isOverlay) => {
        const dest = worldPos(root, destId);
        if (!dest) return;

        const noodle = computeConnectorNoodle(
          nx,
          ny,
          n.w,
          n.h,
          dest.x,
          dest.y,
          dest.node.w,
          dest.node.h,
        );

        const sax = snap.panX + noodle.ax * z;
        const say = snap.panY + noodle.ay * z;
        const scp1x = snap.panX + noodle.cp1x * z;
        const scp1y = snap.panY + noodle.cp1y * z;
        const scp2x = snap.panX + noodle.cp2x * z;
        const scp2y = snap.panY + noodle.cp2y * z;
        const sbx = snap.panX + noodle.bx * z;
        const sby = snap.panY + noodle.by * z;

        const isSelected = selectedConn && selectedConn.srcId === n.id && selectedConn.destId === destId;

        ctx.save();
        if (isSelected) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 4.5;
          ctx.beginPath();
          ctx.moveTo(sax, say);
          ctx.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sbx, sby);
          ctx.stroke();
        }

        ctx.strokeStyle = isOverlay ? COMP_PURPLE : BRAND_ACCENT;
        ctx.lineWidth = isSelected ? 2.5 : 1.8;
        if (isOverlay) ctx.setLineDash([5, 4]);

        ctx.beginPath();
        ctx.moveTo(sax, say);
        ctx.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sbx, sby);
        ctx.stroke();

        // Source circular anchor dot
        ctx.fillStyle = isOverlay ? COMP_PURPLE : BRAND_ACCENT;
        ctx.beginPath();
        ctx.arc(sax, say, isSelected ? 5.5 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = isSelected ? 2 : 1.25;
        ctx.stroke();

        // Destination rotated arrowhead
        ctx.save();
        ctx.translate(sbx, sby);
        ctx.rotate(noodle.angle);
        ctx.fillStyle = isOverlay ? COMP_PURPLE : BRAND_ACCENT;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-8, -4.5);
        ctx.lineTo(-6.5, 0);
        ctx.lineTo(-8, 4.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        ctx.restore();
      });

      // 3. Hotspot connector handles on selected node (4 sides)
      if (snap.selection.length === 1) {
        const wp = worldPos(root, snap.selection[0]);
        if (wp) {
          const sx = snap.panX + wp.x * z;
          const sy = snap.panY + wp.y * z;
          const sw = wp.node.w * z;
          const sh = wp.node.h * z;

          const handles = [
            { x: sx + sw, y: sy + sh / 2 },
            { x: sx + sw / 2, y: sy + sh },
            { x: sx, y: sy + sh / 2 },
            { x: sx + sw / 2, y: sy },
          ];

          for (const h of handles) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(h.x, h.y, 6.5, 0, Math.PI * 2);
            ctx.fillStyle = BRAND_ACCENT;
            ctx.fill();
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Plus symbol inside handle
            ctx.beginPath();
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.moveTo(h.x - 3, h.y);
            ctx.lineTo(h.x + 3, h.y);
            ctx.moveTo(h.x, h.y - 3);
            ctx.lineTo(h.x, h.y + 3);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      // 4. Live dragging noodle using computeConnectorNoodle
      if (protoDrag) {
        const srcWp = protoDrag.srcId ? worldPos(root, protoDrag.srcId) : null;
        const twp = protoDrag.targetId ? worldPos(root, protoDrag.targetId) : null;

        const noodle = computeConnectorNoodle(
          srcWp ? srcWp.x : protoDrag.fromX,
          srcWp ? srcWp.y : protoDrag.fromY,
          srcWp ? srcWp.node.w : 0,
          srcWp ? srcWp.node.h : 0,
          twp ? twp.x : protoDrag.toX,
          twp ? twp.y : protoDrag.toY,
          twp ? twp.node.w : 0,
          twp ? twp.node.h : 0,
          protoDrag.forcedSide,
        );

        const sax = snap.panX + noodle.ax * z;
        const say = snap.panY + noodle.ay * z;
        const scp1x = snap.panX + noodle.cp1x * z;
        const scp1y = snap.panY + noodle.cp1y * z;
        const scp2x = snap.panX + noodle.cp2x * z;
        const scp2y = snap.panY + noodle.cp2y * z;
        const sbx = snap.panX + noodle.bx * z;
        const sby = snap.panY + noodle.by * z;

        ctx.save();
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(sax, say);
        ctx.bezierCurveTo(scp1x, scp1y, scp2x, scp2y, sbx, sby);
        ctx.stroke();

        // Source circle
        ctx.fillStyle = BRAND_ACCENT;
        ctx.beginPath();
        ctx.arc(sax, say, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Destination indicator / arrow
        if (twp) {
          ctx.save();
          ctx.translate(sbx, sby);
          ctx.rotate(noodle.angle);
          ctx.fillStyle = BRAND_ACCENT;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(-9, -5);
          ctx.lineTo(-7, 0);
          ctx.lineTo(-9, 5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = BRAND_ACCENT;
          ctx.beginPath();
          ctx.arc(sbx, sby, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Highlight candidate destination frame
        if (twp) {
          ctx.strokeStyle = BRAND_ACCENT;
          ctx.lineWidth = 2.5;
          ctx.strokeRect(
            snap.panX + twp.x * z,
            snap.panY + twp.y * z,
            twp.node.w * z,
            twp.node.h * z,
          );
        }
        ctx.restore();
      }
    }

    if (snap.presentFrame) return;

    if (snap.rightTab === "inspect" && snap.annotations?.length) {
      snap.annotations.forEach((ann, idx) => {
        const wp = worldPos(root, ann.nodeId);
        if (wp) {
          const ax = snap.panX + (wp.x + wp.node.w) * z;
          const ay = snap.panY + wp.y * z;
          const isSelected = snap.selection.includes(ann.nodeId);

          ctx.save();
          ctx.beginPath();
          ctx.arc(ax, ay, 9, 0, Math.PI * 2);
          ctx.fillStyle = "#10b981";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 10px Inter, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(idx + 1), ax, ay);
          ctx.restore();

          if (isSelected) {
            ctx.save();
            const cardX = ax + 14;
            const cardY = ay - 14;
            const text = ann.note || "Spec note";
            ctx.font = "11px Inter, system-ui, sans-serif";
            const textWidth = Math.min(240, Math.max(130, ctx.measureText(text).width + 24));
            const cardH = 36;

            ctx.fillStyle = "rgba(15, 23, 42, 0.95)";
            ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
            ctx.lineWidth = 1;
            if (typeof ctx.roundRect === "function") {
              ctx.beginPath();
              ctx.roundRect(cardX, cardY, textWidth, cardH, 6);
              ctx.fill();
              ctx.stroke();
            } else {
              ctx.fillRect(cardX, cardY, textWidth, cardH);
            }

            ctx.fillStyle = "#10b981";
            ctx.font = "bold 9px Inter, system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText(`SPEC #${idx + 1} · ${ann.author || "Dev"}`, cardX + 8, cardY + 6);

            ctx.fillStyle = "#f8fafc";
            ctx.font = "11px Inter, system-ui, sans-serif";
            const displayStr = text.length > 30 ? text.slice(0, 28) + "…" : text;
            ctx.fillText(displayStr, cardX + 8, cardY + 18);
            ctx.restore();
          }
        }
      });
    }

    // Either hover source — canvas pointer or Layers-panel row — draws the
    // same outline; the canvas pointer wins when both are set.
    const hovId = hoverId || panelHover;
    if (hovId && !snap.selection.includes(hovId)) {
      const hp = worldPos(root, hovId);
      if (hp) {
        ctx.save();
        const hb = nodeVisualBounds(hp);
        const hx = snap.panX + hb.x * z;
        const hy = snap.panY + hb.y * z;
        const hw = hb.w * z;
        const hh = hb.h * z;
        if (hp.node.rotation) {
          ctx.translate(hx + hw / 2, hy + hh / 2);
          ctx.rotate((hp.node.rotation * Math.PI) / 180);
          ctx.translate(-(hx + hw / 2), -(hy + hh / 2));
        }
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1;
        ctx.strokeRect(hx + 0.5, hy + 0.5, hw, hh);
        ctx.restore();
      }
    }

    // Frame tool: hovering a frame parks a + badge on each side edge for
    // one-click duplication; ⌥-click places a blank same-size frame instead.
    if (snap.tool === "frame" && hoverId && !snap.selection.includes(hoverId)) {
      const qf = worldPos(root, hoverId);
      const qb = qf && qf.node.kind === "frame" && !qf.node.rotation ? nodeVisualBounds(qf) : null;
      if (qf && qb) {
        const qx = snap.panX + qb.x * z;
        const qw = qb.w * z;
        const cy = snap.panY + (qb.y + qb.h / 2) * z;
        ctx.save();
        for (const cx of [qx, qx + qw]) {
          ctx.beginPath();
          ctx.arc(cx, cy, 9, 0, Math.PI * 2);
          ctx.fillStyle = BRAND_ACCENT;
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx - 4, cy);
          ctx.lineTo(cx + 4, cy);
          ctx.moveTo(cx, cy - 4);
          ctx.lineTo(cx, cy + 4);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    const multiSel = snap.selection.length > 1;
    for (const id of snap.selection) {
      if (edit?.id === id || vecEdit === id || (vecEdit && snap.selection.includes(vecEdit))) continue;
      const wp = worldPos(root, id);
      if (!wp) continue;
      const nb = nodeVisualBounds(wp);
      const sx = snap.panX + nb.x * z;
      const sy = snap.panY + nb.y * z;
      const sw = nb.w * z;
      const sh = nb.h * z;
      const accent = wp.node.isComponent || wp.node.componentId ? COMP_PURPLE : BRAND_ACCENT;
      // P0-A contextual chrome: frame/section/group vs shape vs vector vs text
      const kind = wp.node.kind;
      const isFrame = kind === "frame" || kind === "component" || kind === "instance";
      const isVectorLike = kind === "vector" || kind === "boolean" || kind === "star" || kind === "poly";
      const isText = kind === "text";
      const isLine = (kind === "line" || kind === "arrow") && (!wp.node.path.length || wp.node.path.every((p) => !p.ox && !p.oy && !p.ix && !p.iy));
      ctx.save();
      if (wp.node.rotation || wp.node.flipH || wp.node.flipV) {
        ctx.translate(sx + sw / 2, sy + sh / 2);
        if (wp.node.rotation) ctx.rotate((wp.node.rotation * Math.PI) / 180);
        if (wp.node.flipH || wp.node.flipV) ctx.scale(wp.node.flipH ? -1 : 1, wp.node.flipV ? -1 : 1);
        ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
      // With several layers picked, each member only gets a thin outline; the
      // handles, rotate stem and size badge belong to the combined box below.
      if (multiSel) {
        ctx.restore();
        continue;
      }
      // Contextual handles: frames show full 8, text shows side-only when hug, vector shows diamond corners
      const hsFull = handles(sx, sy, sw, sh);
      // For text hug, hide corner handles to hint resize behavior; for lines, only show end handles
      let hs = hsFull;
      if (isText && wp.node.sizingW === "hug" && wp.node.sizingH === "hug") {
        hs = [hsFull[1], hsFull[3], hsFull[5], hsFull[7]]; // only sides for auto text
      } else if (isLine) {
        hs = [[sx, sy + sh / 2], [sx + sw, sy + sh / 2]]; // only ends for line
      }
      for (const [hx, hy] of hs) {
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        if (isVectorLike && !isFrame) {
          // diamond handle for vector nodes vs square for frames/shapes
          ctx.beginPath();
          ctx.moveTo(hx, hy - 3.5);
          ctx.lineTo(hx + 3.5, hy);
          ctx.lineTo(hx, hy + 3.5);
          ctx.lineTo(hx - 3.5, hy);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (isFrame) {
          // frame handles: clean 7x7 square container affordance
          ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
          ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
        } else {
          ctx.fillRect(hx - 3, hy - 3, 6, 6);
          ctx.strokeRect(hx - 3, hy - 3, 6, 6);
        }
      }
      // Dynamic rotation angle readout badge when rotating
      const isRotating = drag.current?.mode === "rotate" && drag.current.id === wp.node.id;
      const dim = isRotating
        ? `${Math.round(wp.node.rotation ?? 0)}°`
        : `${Math.round(nb.w)} × ${Math.round(nb.h)}`;
      ctx.font = "500 11px Inter, system-ui";
      const tw = ctx.measureText(dim).width;
      const bw = tw + 16;
      const bh = 20;
      const bx = sx + sw / 2 - bw / 2;
      const by = sy + sh + 8;
      ctx.fillStyle = accent;
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();
      } else {
        ctx.fillRect(bx, by, bw, bh);
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(dim, bx + bw / 2, by + bh / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      const ft = wp.node.fillType;
      if (ft === "linear" || ft === "radial" || ft === "angular" || ft === "diamond") {
        const ax = sx + (wp.node.fillGX ?? 0.5) * sw;
        const ay = sy + (wp.node.fillGY ?? 0) * sh;
        const bx = sx + (wp.node.fillHX ?? 0.5) * sw;
        const by = sy + (wp.node.fillHY ?? 1) * sh;
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.fillStyle = wp.node.fill;
        ctx.beginPath();
        ctx.arc(ax, ay, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = wp.node.fillB || "#ffffff";
        ctx.beginPath();
        ctx.arc(bx, by, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (wp.node.kind === "star") {
        const cx = sx + sw / 2;
        const cy = sy + sh / 2;
        const rx = sw / 2;
        const ry = sh / 2;
        const pts = Math.max(3, Math.min(60, Math.round(wp.node.count || 5)));
        const a = Math.PI / pts - Math.PI / 2;
        const k = Math.max(0.05, Math.min(0.95, wp.node.starRatio ?? 0.4));
        const hx = cx + Math.cos(a) * rx * k;
        const hy = cy + Math.sin(a) * ry * k;

        // Ratio handle (valley)
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Count handle (second outer point)
        const aCount = (2 * Math.PI) / pts - Math.PI / 2;
        const cxCount = cx + Math.cos(aCount) * rx;
        const cyCount = cy + Math.sin(aCount) * ry;
        ctx.beginPath();
        ctx.arc(cxCount, cyCount, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Corner radius handle (near top tip)
        const cr = wp.node.cornerRadii[0] || 0;
        const radY = cy - ry + Math.min(ry * 0.4, Math.max(10, cr * z));
        ctx.beginPath();
        ctx.arc(cx, radY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (wp.node.kind === "poly") {
        const cx = sx + sw / 2;
        const cy = sy + sh / 2;
        const rx = sw / 2;
        const ry = sh / 2;
        const pts = Math.max(3, Math.min(60, Math.round(wp.node.count || 3)));

        // Count handle (second vertex)
        const aCount = (2 * Math.PI) / pts - Math.PI / 2;
        const cxCount = cx + Math.cos(aCount) * rx;
        const cyCount = cy + Math.sin(aCount) * ry;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cxCount, cyCount, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Corner radius handle (near top vertex)
        const cr = wp.node.cornerRadii[0] || 0;
        const radY = cy - ry + Math.min(ry * 0.4, Math.max(10, cr * z));
        ctx.beginPath();
        ctx.arc(cx, radY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (wp.node.kind === "ellipse" && sw >= 36 && sh >= 36) {
        const cx = sx + sw / 2;
        const cy = sy + sh / 2;
        const rx = sw / 2;
        const ry = sh / 2;
        const ea = wp.node.arcData?.endingAngle ?? Math.PI * 2;
        const ir = wp.node.arcData?.innerRadius ?? 0;
        const hx = cx + Math.cos(ea) * rx;
        const hy = cy + Math.sin(ea) * ry;

        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (ir > 0) {
          const rhx = cx + Math.cos(ea) * rx * ir;
          const rhy = cy + Math.sin(ea) * ry * ir;
          ctx.beginPath();
          ctx.arc(rhx, rhy, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      // Corner radius handles: only show these for a corner that is
      // actually rounded, and draws them as a small bracket hugging the corner.
      // Painting a dot at every corner regardless of radius read as "why is
      // there a dot in my frame", and clamping the offset to half the box could
      // push those dots to the middle of a small rounded frame.
      if (
        (wp.node.kind === "rect" || wp.node.kind === "frame" || wp.node.kind === "component" || wp.node.kind === "instance") &&
        !vecEdit &&
        sw >= 36 &&
        sh >= 36
      ) {
        const radii = cornerRadiiOf(wp.node);
        if (radii.tl + radii.tr + radii.br + radii.bl > 0) {
          const reach = Math.min(14, Math.min(sw, sh) * 0.28);
          // Read the corners through cornerRadiiOf: the stored array is
          // [tl, tr, bl, br], so indexing it directly marked the wrong corner
          // whenever the bottom two radii differed.
          const anchors: [number, number][] = [
            [sx, sy],
            [sx + sw, sy],
            [sx, sy + sh],
            [sx + sw, sy + sh],
          ];
          const dirs: [number, number][] = [
            [1, 1],
            [-1, 1],
            [1, -1],
            [-1, -1],
          ];
          const values = [radii.tl, radii.tr, radii.bl, radii.br];
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.lineCap = "round";
          for (let i = 0; i < 4; i++) {
            if (values[i] <= 0) continue;
            const [ax, ay] = anchors[i];
            const [dx, dy] = dirs[i];
            ctx.beginPath();
            ctx.moveTo(ax + dx * reach, ay + dy * 3.5);
            ctx.lineTo(ax + dx * 3.5, ay + dy * 3.5);
            ctx.lineTo(ax + dx * 3.5, ay + dy * reach);
            ctx.stroke();
          }
          ctx.lineCap = "butt";
        }
      }
      // Auto Layout visualisation: paints the padding and gap regions as
      // translucent pink bands across the frame, rather than parking four dots
      // on the edges: the bands show the extent, the dots showed only a point.
      if (wp.node.layout) {
        const l = wp.node.layout;
        const [pl, pr, pt, pb] = l.padding;
        const horiz = l.direction === "horizontal";
        ctx.save();
        ctx.fillStyle = "rgba(255, 45, 85, 0.14)";
        const band = (bx: number, by: number, bw: number, bh: number) => {
          if (bw > 0.5 && bh > 0.5) ctx.fillRect(bx, by, bw, bh);
        };
        band(sx, sy, sw, pt * z);
        band(sx, sy + sh - pb * z, sw, pb * z);
        band(sx, sy + pt * z, pl * z, Math.max(0, sh - (pt + pb) * z));
        band(sx + sw - pr * z, sy + pt * z, pr * z, Math.max(0, sh - (pt + pb) * z));

        // Gap band between each pair of flowed children.
        const flowKids = wp.node.children.filter((c) => c.visible && !c.absolutePosition);
        for (let i = 1; i < flowKids.length; i++) {
          const a = flowKids[i - 1];
          const b = flowKids[i];
          if (horiz) {
            const x0 = sx + (a.x + a.w) * z;
            const x1 = sx + b.x * z;
            band(x0, sy + (b.y || 0) * z, (x1 - x0) || l.gap * z, Math.max(2, b.h * z));
          } else {
            const y0 = sy + (a.y + a.h) * z;
            const y1 = sy + b.y * z;
            band(sx + (b.x || 0) * z, y0, Math.max(2, b.w * z), (y1 - y0) || l.gap * z);
          }
        }
        ctx.restore();
      }
      ctx.restore();
    }

    // The rotation origin, and only while `⌥R` has asked for it: a target on
    // each selected layer, drawn where that layer will turn about.
    if (rotTarget && snap.selection.length === 1) {
      for (const id of snap.selection) {
        const t = worldPos(root, id);
        if (!t) continue;
        const o = t.node.rotOrigin ?? [0.5, 0.5];
        const rad = ((t.node.rotation ?? 0) * Math.PI) / 180;
        const ccx = t.x + t.node.w / 2;
        const ccy = t.y + t.node.h / 2;
        const ddx = t.x + o[0] * t.node.w - ccx;
        const ddy = t.y + o[1] * t.node.h - ccy;
        const tx = snap.panX + (ccx + ddx * Math.cos(rad) - ddy * Math.sin(rad)) * z;
        const ty = snap.panY + (ccy + ddx * Math.sin(rad) + ddy * Math.cos(rad)) * z;
        ctx.save();
        ctx.beginPath();
        ctx.arc(tx, ty, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx - 4, ty);
        ctx.lineTo(tx + 4, ty);
        ctx.moveTo(tx, ty - 4);
        ctx.lineTo(tx, ty + 4);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }

    // Combined bounding box for a multi-selection: one set of handles, one
    // rotate zone, one size badge.
    if (multiSel && !vecEdit) {
      const bb = selectionBounds(root, snap.selection);
      if (bb) {
        const sx = snap.panX + bb.x * z;
        const sy = snap.panY + bb.y * z;
        const sw = bb.w * z;
        const sh = bb.h * z;
        ctx.save();
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
        for (const [hx, hy] of handles(sx, sy, sw, sh)) {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = BRAND_ACCENT;
          ctx.fillRect(hx - 3, hy - 3, 6, 6);
          ctx.strokeRect(hx - 3, hy - 3, 6, 6);
        }
        const dim = `${Math.round(bb.w)} × ${Math.round(bb.h)}`;
        ctx.font = "500 11px Inter, system-ui";
        const bw = ctx.measureText(dim).width + 16;
        const bx = sx + sw / 2 - bw / 2;
        const by = sy + sh + 8;
        ctx.fillStyle = BRAND_ACCENT;
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, 20, 4);
          ctx.fill();
        } else ctx.fillRect(bx, by, bw, 20);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(dim, bx + bw / 2, by + 10);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.restore();
      }
    }

    // Smart guides + equal-spacing badges, drawn on top of the selection chrome.
    if (guides.length) {
      ctx.save();
      ctx.strokeStyle = "#ff3b6b";
      ctx.lineWidth = 1;
      for (const g of guides) {
        ctx.setLineDash(g.center ? [4, 3] : []);
        ctx.beginPath();
        if (g.axis === "x") {
          const gx = Math.round(snap.panX + g.at * z) + 0.5;
          ctx.moveTo(gx, snap.panY + g.from * z);
          ctx.lineTo(gx, snap.panY + g.to * z);
        } else {
          const gy = Math.round(snap.panY + g.at * z) + 0.5;
          ctx.moveTo(snap.panX + g.from * z, gy);
          ctx.lineTo(snap.panX + g.to * z, gy);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    if (gapBadges.length) {
      ctx.save();
      ctx.font = "500 10px Inter, system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const g of gapBadges) {
        const cx = g.axis === "x" ? snap.panX + g.at * z : snap.panX + g.cross * z;
        const cy = g.axis === "x" ? snap.panY + g.cross * z : snap.panY + g.at * z;
        const label = `${Math.round(g.size)}`;
        const bw = ctx.measureText(label).width + 10;
        ctx.fillStyle = "#ff3b6b";
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(cx - bw / 2, cy - 8, bw, 16, 3);
          ctx.fill();
        } else ctx.fillRect(cx - bw / 2, cy - 8, bw, 16);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, cx, cy);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.restore();
    }

    // Boolean live preview: the armed op's result over the live selection,
    // recomputed every frame so it tracks drags and nudges until Apply/Esc.
    if (snap.booleanPreview && snap.selection.length >= 2 && !snap.presentFrame) {
      const prev = previewBoolean(snap.booleanPreview, root, snap.selection);
      if (prev && prev.path.length >= 3) {
        ctx.save();
        tracePath(ctx, prev.path, snap.panX + prev.x * z, snap.panY + prev.y * z, z, true);
        ctx.fillStyle = "rgba(16, 185, 129, 0.14)"; // BRAND_ACCENT at 14%
        ctx.fill();
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Variable-width control points on the selected stroke. Display-only —
    // the inspector's profile strip edits them — and hidden under rotation,
    // where the translation-only page offset would misplace them.
    if (snap.selection.length === 1 && !snap.presentFrame && !vecEdit) {
      const sel = find(root, snap.selection[0]);
      if (sel && usesVariableWidth(sel) && sel.path.length >= 2 && !sel.rotation && !sel.flipH && !sel.flipV) {
        const wp = worldPos(root, sel.id);
        if (wp) {
          const dots = widthProfileStations(sel.path, sel.closed, sel.strokeWidthProfile);
          if (dots.length) {
            ctx.save();
            for (const d of dots) {
              ctx.beginPath();
              ctx.arc(snap.panX + (wp.x + d.x) * z, snap.panY + (wp.y + d.y) * z, 3.5, 0, Math.PI * 2);
              ctx.fillStyle = "#ffffff";
              ctx.fill();
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = BRAND_ACCENT;
              ctx.stroke();
            }
            ctx.restore();
          }
        }
      }
    }

    if (vecEdit) {
      const wp = worldPos(root, vecEdit);
      if (wp) {
        const pts = wp.node.path.length ? wp.node.path : shapePoly(wp.node);
        const vsx = snap.panX + wp.x * z;
        const vsy = snap.panY + wp.y * z;
        const vsw = wp.node.w * z;
        const vsh = wp.node.h * z;
        ctx.save();
        if (wp.node.rotation || wp.node.flipH || wp.node.flipV) {
          ctx.translate(vsx + vsw / 2, vsy + vsh / 2);
          if (wp.node.rotation) ctx.rotate((wp.node.rotation * Math.PI) / 180);
          if (wp.node.flipH || wp.node.flipV) ctx.scale(wp.node.flipH ? -1 : 1, wp.node.flipV ? -1 : 1);
          ctx.translate(-(vsx + vsw / 2), -(vsy + vsh / 2));
        }
        ctx.strokeStyle = BRAND_ACCENT;
        ctx.lineWidth = 1;
        const vn = wp.node.vectorNetwork;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const px = snap.panX + (wp.x + p.x) * z;
          const py = snap.panY + (wp.y + p.y) * z;
          const isSelected = (snap.vecPoints && snap.vecPoints.includes(i)) || vecPt.current === i || snap.vecPoint === i;

          // Bézier tangent handles: only show for selected vertices (or when dragging) to keep canvas clean
          if (isSelected) {
            ctx.save();
            ctx.strokeStyle = "rgba(16, 185, 129, 0.75)";
            ctx.lineWidth = 1;
            if (p.ix != null && p.iy != null && (p.ix !== 0 || p.iy !== 0)) {
              const hx = px + p.ix * z;
              const hy = py + p.iy * z;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(hx, hy);
              ctx.stroke();
              ctx.fillStyle = "#ffffff";
              ctx.strokeStyle = BRAND_ACCENT;
              ctx.lineWidth = 1.25;
              ctx.beginPath();
              ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
            if (p.ox != null && p.oy != null && (p.ox !== 0 || p.oy !== 0)) {
              const hx = px + p.ox * z;
              const hy = py + p.oy * z;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(hx, hy);
              ctx.stroke();
              ctx.fillStyle = "#ffffff";
              ctx.strokeStyle = BRAND_ACCENT;
              ctx.lineWidth = 1.25;
              ctx.beginPath();
              ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
            ctx.restore();
          }

          const deg = vn ? vertexDegree(vn, i) : 2;
          if (deg >= 3) {
            // Branching node indicator (Vector Network Degree >= 3)
            ctx.save();
            ctx.fillStyle = isSelected ? BRAND_ACCENT_GLOW : "rgba(16, 185, 129, 0.25)";
            ctx.beginPath();
            ctx.arc(px, py, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = isSelected ? BRAND_ACCENT : "#10b981";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px, py - 5);
            ctx.lineTo(px + 5, py);
            ctx.lineTo(px, py + 5);
            ctx.lineTo(px - 5, py);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          } else {
            // Vector anchor point: clean circular anchor point
            ctx.fillStyle = isSelected ? BRAND_ACCENT : "#ffffff";
            ctx.strokeStyle = isSelected ? "#ffffff" : BRAND_ACCENT;
            ctx.lineWidth = isSelected ? 1.5 : 1.25;
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }

        // Segment mid-point hover affordance (insert anchor hint)
        if (cursorPos && !drag.current) {
          const local = nodeLocalPoint(cursorPos.x, cursorPos.y, wp.x, wp.y, wp.node);
          const npts = pts.length;
          const count = wp.node.closed ? npts : npts - 1;
          for (let si = 0; si < count; si++) {
            const p1 = pts[si];
            const p2 = pts[(si + 1) % npts];
            const pr = projectPointOnSegment(local.x, local.y, p1.x, p1.y, p2.x, p2.y);
            if (pr.dist < 12 / snap.zoom && pr.t > 0.05 && pr.t < 0.95) {
              const hx = snap.panX + (wp.x + pr.x) * z;
              const hy = snap.panY + (wp.y + pr.y) * z;
              ctx.save();
              ctx.fillStyle = BRAND_ACCENT;
              ctx.strokeStyle = "#ffffff";
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(hx, hy, 4, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
              ctx.restore();
              break;
            }
          }
        }
        ctx.restore();
      }
    }

    const isDevMode = snap.rightTab === "inspect";
    const shouldMeasure =
      (altMeasure || (isDevMode && hoverId && hoverId !== snap.selection[0])) &&
      snap.selection.length === 1 &&
      !drag.current;

    if (isDevMode && snap.selection.length === 1) {
      const selWp = worldPos(root, snap.selection[0]);
      if (selWp && selWp.node.layout?.padding) {
        const [pl, pr, pt, pb] = selWp.node.layout.padding;
        if (pl || pr || pt || pb) {
          const sx = snap.panX + selWp.x * z;
          const sy = snap.panY + selWp.y * z;
          const sw = selWp.node.w * z;
          const sh = selWp.node.h * z;
          ctx.save();
          ctx.fillStyle = "rgba(16, 185, 129, 0.08)";
          ctx.strokeStyle = "rgba(16, 185, 129, 0.4)";
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          if (pt > 0) ctx.fillRect(sx, sy, sw, pt * z);
          if (pb > 0) ctx.fillRect(sx, sy + sh - pb * z, sw, pb * z);
          if (pl > 0) ctx.fillRect(sx, sy + pt * z, pl * z, Math.max(0, selWp.node.h - pt - pb) * z);
          if (pr > 0) ctx.fillRect(sx + sw - pr * z, sy + pt * z, pr * z, Math.max(0, selWp.node.h - pt - pb) * z);
          ctx.strokeRect(sx + pl * z, sy + pt * z, Math.max(0, selWp.node.w - pl - pr) * z, Math.max(0, selWp.node.h - pt - pb) * z);
          ctx.restore();
        }
      }
    }

    if (shouldMeasure) {
      const A = worldPos(root, snap.selection[0]);
      if (A) {
        ctx.save();
        ctx.strokeStyle = "#ff3b6b";
        ctx.fillStyle = "#ff3b6b";
        ctx.lineWidth = 1;
        ctx.font = "500 10px Inter, system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const drawBadge = (label: string, x: number, y: number) => {
          const bw = ctx.measureText(label).width + 8;
          ctx.fillStyle = "#ff3b6b";
          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(x - bw / 2, y - 7, bw, 14, 3);
            ctx.fill();
          } else ctx.fillRect(x - bw / 2, y - 7, bw, 14);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(label, x, y);
          ctx.fillStyle = "#ff3b6b";
        };

        const drawMeasLine = (x1: number, y1: number, x2: number, y2: number, label: string) => {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          drawBadge(label, (x1 + x2) / 2, (y1 + y2) / 2);
        };

        const targetWp = hoverId && hoverId !== A.node.id ? worldPos(root, hoverId) : null;
        if (targetWp) {
          const B = targetWp;
          const bsx = snap.panX + B.x * z;
          const bsy = snap.panY + B.y * z;
          const bsw = B.node.w * z;
          const bsh = B.node.h * z;
          ctx.strokeRect(bsx + 0.5, bsy + 0.5, bsw, bsh);

          const asx = snap.panX + A.x * z;
          const asy = snap.panY + A.y * z;
          const asw = A.node.w * z;
          const ash = A.node.h * z;

          if (B.x >= A.x + A.node.w) {
            const d = Math.round(B.x - (A.x + A.node.w));
            const yMid = Math.max(asy, bsy) + Math.min(ash, bsh) / 2;
            drawMeasLine(asx + asw, yMid, bsx, yMid, `${d}`);
          } else if (A.x >= B.x + B.node.w) {
            const d = Math.round(A.x - (B.x + B.node.w));
            const yMid = Math.max(asy, bsy) + Math.min(ash, bsh) / 2;
            drawMeasLine(bsx + bsw, yMid, asx, yMid, `${d}`);
          }

          if (B.y >= A.y + A.node.h) {
            const d = Math.round(B.y - (A.y + A.node.h));
            const xMid = Math.max(asx, bsx) + Math.min(asw, bsw) / 2;
            drawMeasLine(xMid, asy + ash, xMid, bsy, `${d}`);
          } else if (A.y >= B.y + B.node.h) {
            const d = Math.round(A.y - (B.y + B.node.h));
            const xMid = Math.max(asx, bsx) + Math.min(asw, bsw) / 2;
            drawMeasLine(xMid, bsy + bsh, xMid, asy, `${d}`);
          }
        } else {
          const par = findParent(root, A.node.id);
          const parWp = par && par.id !== root.id ? worldPos(root, par.id) : null;
          if (parWp) {
            const psx = snap.panX + parWp.x * z;
            const psy = snap.panY + parWp.y * z;
            const psw = parWp.node.w * z;
            const psh = parWp.node.h * z;
            const asx = snap.panX + A.x * z;
            const asy = snap.panY + A.y * z;
            const asw = A.node.w * z;
            const ash = A.node.h * z;

            ctx.setLineDash([3, 2]);
            const topD = Math.round(A.y - parWp.y);
            if (topD > 0) drawMeasLine(asx + asw / 2, psy, asx + asw / 2, asy, `${topD}`);
            const botD = Math.round((parWp.y + parWp.node.h) - (A.y + A.node.h));
            if (botD > 0) drawMeasLine(asx + asw / 2, asy + ash, asx + asw / 2, psy + psh, `${botD}`);
            const leftD = Math.round(A.x - parWp.x);
            if (leftD > 0) drawMeasLine(psx, asy + ash / 2, asx, asy + ash / 2, `${leftD}`);
            const rightD = Math.round((parWp.x + parWp.node.w) - (A.x + A.node.w));
            if (rightD > 0) drawMeasLine(asx + asw, asy + ash / 2, psx + psw, asy + ash / 2, `${rightD}`);
          }
        }
        ctx.restore();
      }
    }

    if (band) {
      ctx.fillStyle = BRAND_ACCENT_WASH;
      ctx.strokeStyle = BRAND_ACCENT;
      ctx.lineWidth = 1;
      ctx.fillRect(band.x, band.y, band.w, band.h);
      ctx.strokeRect(band.x + 0.5, band.y + 0.5, band.w, band.h);
    }

    if (cursorPos && wrap.current) {
      const r = wrap.current.getBoundingClientRect();
      const cx = cursorPos.x - r.left;
      const cy = cursorPos.y - r.top;

      if (snap.tool === "eraser") {
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(cx, cy, ERASER_PX, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(cx, cy, ERASER_PX + 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (eyedropArmed()) {
        try {
          const d = ctx.getImageData(cx, cy, 1, 1).data;
          const hex = toHex(d[0], d[1], d[2]);
          const loupeR = 34;
          const loupeX = cx;
          const loupeY = Math.max(loupeR + 10, cy - 50);

          ctx.save();
          ctx.beginPath();
          ctx.arc(loupeX, loupeY, loupeR, 0, Math.PI * 2);
          ctx.fillStyle = hex;
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
          ctx.stroke();

          // Crosshair
          ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(loupeX - 8, loupeY);
          ctx.lineTo(loupeX + 8, loupeY);
          ctx.moveTo(loupeX, loupeY - 8);
          ctx.lineTo(loupeX, loupeY + 8);
          ctx.stroke();

          // HEX readout pill
          ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
          const tw = 60;
          const th = 20;
          const bx = loupeX - tw / 2;
          const by = loupeY + loupeR + 6;
          if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(bx, by, tw, th, 4);
            ctx.fill();
          } else {
            ctx.fillRect(bx, by, tw, th);
          }
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 10px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(hex.toUpperCase(), loupeX, by + th / 2);
          ctx.restore();
        } catch {
          // ignore tainted canvas
        }
      }
    }
  }, [snap, band, edit, engine, theme, draft, vecEdit, hoverId, panelHover, ghost, guides, gapBadges, altMeasure, protoDrag, selectedConn, animFrame, closeHint, rotTarget, cursorPos]);

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return {
      x: (cx - r.left - snap.panX) / snap.zoom,
      y: (cy - r.top - snap.panY) / snap.zoom,
    };
  };

  /**
   * Eraser: on a vector/freehand path it removes the anchors under
   * the brush and splits the remainder into separate paths; on any other layer
   * it falls back to deleting the layer.
   */
  const eraseAt = useCallback(
    (wx: number, wy: number) => {
      const root = engine.snapshot().pages[engine.snapshot().page].root;
      const hit = hitTest(root, wx, wy, { deep: true });
      if (!hit || hit.locked) return;
      const radius = ERASER_PX / engine.snapshot().zoom;
      // Vector paths get true partial erasure via erasePath; any other
      // drawable shape (rect, ellipse, line, poly, star, boolean) is first
      // converted to its outline polyline so the brush can split it too —
      // eraser works on any stroked shape,
      // not just pen paths. Frames/groups/text fall back to delete.
      const canPartial = (hit.kind === "vector" && hit.path.length) || ["rect", "ellipse", "line", "arrow", "poly", "star", "boolean"].includes(hit.kind);
      if (canPartial) {
        const wp = worldPos(root, hit.id);
        if (!wp) return;
        const srcPath = hit.path.length ? hit.path : shapePoly(hit);
        if (srcPath.length < 2) {
          engine.dispatch({ type: "select", ids: [hit.id] });
          engine.dispatch({ type: "delete" });
          return;
        }
        const runs = erasePath(srcPath, wx - wp.x, wy - wp.y, radius);
        if (runs.length === 1 && runs[0].length === srcPath.length) return;
        if (!runs.length) {
          engine.dispatch({ type: "select", ids: [hit.id] });
          engine.dispatch({ type: "delete" });
          return;
        }
        // Preserve visual style of the source: if it was not a vector, the split
        // pieces become vectors with the same fill/stroke so the result looks like
        // the original shape was cut.
        if (hit.kind === "vector") {
          engine.dispatch({ type: "patchPath", id: hit.id, path: runs[0], closed: false });
        } else {
          engine.dispatch({ type: "patch", id: hit.id, patch: { kind: "vector", path: runs[0], closed: false, vectorNetwork: undefined } as any });
          // For closed shapes, ensure fill remains if it had one
        }
        for (const extra of runs.slice(1)) {
          engine.dispatch({
            type: "addPath",
            points: extra.map((p) => ({ ...p, x: p.x + wp.x, y: p.y + wp.y })),
            closed: false,
          });
        }
        return;
      }
      engine.dispatch({ type: "select", ids: [hit.id] });
      engine.dispatch({ type: "delete" });
    },
    [engine],
  );

  const onDown = (e: React.MouseEvent) => {
    if (edit && (e.target as HTMLElement).closest(".text-edit")) return;
    if (e.button === 2) return;
    // Frame quick-add badges, painted beside the hover outline. Left badge
    // places the new frame to the left, right badge to the right; ⌥ makes
    // the new frame blank instead of a duplicate.
    if (snap.tool === "frame" && hoverId && !snap.selection.includes(hoverId)) {
      const qroot = snap.pages[snap.page].root;
      const qf = worldPos(qroot, hoverId);
      const qb = qf && qf.node.kind === "frame" && !qf.node.rotation ? nodeVisualBounds(qf) : null;
      if (qf && qb) {
        const c = ref.current;
        if (c) {
          const box = c.getBoundingClientRect();
          const px = e.clientX - box.left;
          const py = e.clientY - box.top;
          const qx = snap.panX + qb.x * snap.zoom;
          const qw = qb.w * snap.zoom;
          const cy = snap.panY + (qb.y + qb.h / 2) * snap.zoom;
          const side =
            Math.hypot(px - qx, py - cy) <= 11 ? -1
            : Math.hypot(px - (qx + qw), py - cy) <= 11 ? 1
            : 0;
          if (side !== 0) {
            e.preventDefault();
            const f = qf.node;
            if (e.altKey) {
              const par = findParent(qroot, f.id);
              engine.dispatch({
                type: "add",
                kind: "frame",
                x: side < 0 ? f.x - f.w - 24 : f.x + f.w + 24,
                y: f.y,
                w: f.w,
                h: f.h,
                parent: par && par !== qroot ? par.id : undefined,
                extra: { name: "Frame" },
              });
            } else {
              engine.dispatch({ type: "select", ids: [f.id] });
              engine.dispatch({ type: "duplicate", dx: side * (f.w + 24), dy: 0 });
            }
            return;
          }
        }
      }
    }
    if (eyedropArmed()) {
      const c = ref.current;
      if (c) {
        const box = c.getBoundingClientRect();
        const px = (e.clientX - box.left) * (window.devicePixelRatio || 1);
        const py = (e.clientY - box.top) * (window.devicePixelRatio || 1);
        const ctx = c.getContext("2d");
        if (ctx) {
          try {
            const p = ctx.getImageData(px, py, 1, 1).data;
            const hex = toHex(p[0], p[1], p[2]);
            const dropFn = takeEyedrop();
            if (dropFn) dropFn(hex);
            toast(`Sampled ${hex}`);
            e.preventDefault();
            return;
          } catch {
            // fallback to layer hit
          }
        }
      }
      const wpt = toWorld(e.clientX, e.clientY);
      const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { deep: true });
      const hex = hit?.fill || "#000000";
      const dropFn = takeEyedrop();
      if (dropFn) dropFn(hex);
      toast(`Sampled ${hex}`);
      e.preventDefault();
      return;
    }
    // Freeze the snap targets for this gesture: everything except the layers
    // being dragged (and their subtrees), so a node never snaps to itself.
    snapTargets.current = snapCandidates(
      snap.pages[snap.page].root,
      new Set(snap.selection),
    );
    if (snap.presentFrame) {
      const wpt = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      const pressHit = hitTest(root, wpt.x, wpt.y, { deep: true, includeLocked: true });
      dragIx.current = { x: wpt.x, y: wpt.y, id: pressHit ? pressHit.id : "", fired: false };

      // Handle active overlay clicks & dismiss
      if (snap.activeOverlay?.id) {
        const overlayNode = find(root, snap.activeOverlay.id);
        const presentNode = find(root, snap.presentFrame);
        if (overlayNode && presentNode) {
          const wp = worldPos(root, presentNode.id);
          if (wp) {
            let ox = wp.x + (presentNode.w - overlayNode.w) / 2;
            let oy = wp.y + (presentNode.h - overlayNode.h) / 2;
            if (snap.activeOverlay.position === "bottom") {
              ox = wp.x + (presentNode.w - overlayNode.w) / 2;
              oy = wp.y + presentNode.h - overlayNode.h;
            } else if (snap.activeOverlay.position === "top") {
              ox = wp.x + (presentNode.w - overlayNode.w) / 2;
              oy = wp.y;
            }
            if (
              wpt.x >= ox &&
              wpt.x <= ox + overlayNode.w &&
              wpt.y >= oy &&
              wpt.y <= oy + overlayNode.h
            ) {
              const n: XNode | null = hitTest(overlayNode, wpt.x - ox + overlayNode.x, wpt.y - oy + overlayNode.y, { includeLocked: true });
              if (n) runTrigger(overlayNode, n.id, "onClick");
              return;
            } else if (snap.activeOverlay.closeOutside !== false) {
              engine.dispatch({ type: "closeOverlay" });
              return;
            }
          }
        }
      }

      const n: XNode | null = hitTest(root, wpt.x, wpt.y, { includeLocked: true });
      if (n) runTrigger(root, n.id, "onClick");
      return;
    }
    if (snap.tool === "eraser") {
      const wpt = toWorld(e.clientX, e.clientY);
      engine.dispatch({ type: "begin" });
      eraseAt(wpt.x, wpt.y);
      drag.current = { mode: "marquee", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: "erase" };
      return;
    }
    if (snap.tool === "comment" && e.button === 0 && !space.current) {
      // Comments are annotations, not geometry. Previously this dropped a blue
      // ellipse into the layer tree, which exported and hit-tested like a real
      // shape; now it opens a draft thread anchored to the clicked point.
      // Space (and middle-click) must still pan, so defer to those.
      const wpt = toWorld(e.clientX, e.clientY);
      setDraftComment({ x: wpt.x, y: wpt.y });
      return;
    }
    if (snap.tool === "pen") {
      let wpt = toWorld(e.clientX, e.clientY);
      const rootForPen = snap.pages[snap.page].root;
      const near = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by) < 8 / snap.zoom;
      // A branch is anchored on a vertex of the selected vector, so the pen can
      // keep drawing in that shape instead of starting a second one.
      if (!penBranch.current && !draft.length && snap.selection.length === 1) {
        const sel = find(rootForPen, snap.selection[0]);
        if (sel && sel.kind === "vector" && !sel.locked) {
          const vn = sel.vectorNetwork ?? pathToVectorNetwork(sel.path, sel.closed);
          for (let i = 0; i < vn.vertices.length; i++) {
            const v = vn.vertices[i];
            if (near(wpt.x, wpt.y, sel.x + v.x, sel.y + v.y)) {
              penBranch.current = { id: sel.id, vertex: i };
              e.preventDefault();
              return;
            }
          }
        }
      } else if (penBranch.current) {
        const b = penBranch.current;
        const node = find(rootForPen, b.id);
        if (node) {
          engine.dispatch({
            type: "addVectorBranch",
            id: b.id,
            fromVertexIndex: b.vertex,
            to: { x: wpt.x - node.x, y: wpt.y - node.y },
          });
          // Re-anchor on the vertex that click produced. The helper reuses an
          // existing point when they coincide, so find it by position rather
          // than assuming it was appended.
          const after = find(engine.snapshot().pages[engine.snapshot().page].root, b.id);
          const vn = after?.vectorNetwork;
          if (after && vn) {
            const lx = wpt.x - after.x;
            const ly = wpt.y - after.y;
            const idx = vn.vertices.findIndex((v) => Math.abs(v.x - lx) < 0.5 && Math.abs(v.y - ly) < 0.5);
            if (idx >= 0) penBranch.current = { id: b.id, vertex: idx };
          }
        }
        return;
      }
      if (e.shiftKey && draft.length) {
        const last = draft[draft.length - 1];
        const ang = Math.round(Math.atan2(wpt.y - last.y, wpt.x - last.x) / (Math.PI / 4)) * (Math.PI / 4);
        const d = Math.hypot(wpt.x - last.x, wpt.y - last.y);
        wpt = { x: last.x + Math.cos(ang) * d, y: last.y + Math.sin(ang) * d };
      }
      if (draft.length >= 2) {
        const a = draft[0];
        if (Math.hypot(wpt.x - a.x, wpt.y - a.y) < 14 / snap.zoom) {
          engine.dispatch({ type: "addPath", points: draft, closed: true });
          setDraft([]);
          setCloseHint(null);
          penDrag.current = null;
          return;
        }
      }
      const pt: PathPoint = { x: wpt.x, y: wpt.y };
      setDraft((d) => [...d, pt]);
      penDrag.current = { i: draft.length, x: wpt.x, y: wpt.y };
      return;
    }
    if (snap.tool === "pencil" || snap.tool === "brush") {
      const wpt = toWorld(e.clientX, e.clientY);
      pencil.current = [wpt];
      setDraft([wpt]);
      return;
    }
    const drop = takeEyedrop();
    if (drop) {
      const c = ref.current;
      const box = wrap.current!.getBoundingClientRect();
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        const px = Math.max(0, Math.floor((e.clientX - box.left) * dpr));
        const py = Math.max(0, Math.floor((e.clientY - box.top) * dpr));
        const ctx = c.getContext("2d");
        if (ctx) {
          const d = ctx.getImageData(px, py, 1, 1).data;
          drop(toHex(d[0], d[1], d[2]));
        }
      }
      return;
    }
    if (e.button === 1 || snap.tool === "hand" || space.current) {
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, wx: 0, wy: 0 };
      return;
    }
    const wpt = toWorld(e.clientX, e.clientY);
    const root = snap.pages[snap.page].root;
    if (snap.tool === "image") {
      pendingImage.current = { x: wpt.x, y: wpt.y };
      fileRef.current?.click();
      return;
    }
    if (snap.tool === "zoom") {
      // Zoom tool: click to step in, ⌥-click to step out, or drag a
      // region to fit exactly that area. The drag reuses the create marquee so
      // the rubber band looks like every other drag on this canvas.
      drag.current = { mode: "create", zoom: true, sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y };
      return;
    }
    const create = kindOf(snap.tool);
    if (create && snap.tool !== "select") {
      drag.current = {
        mode: "create",
        sx: e.clientX,
        sy: e.clientY,
        wx: wpt.x,
        wy: wpt.y,
      };
      return;
    }
    // Multi-selection: hit-test the combined bounding box's handles first, so a
    // group of layers can be scaled and rotated as one.
    if (snap.selection.length > 1 && snap.tool === "select") {
      const bb = selectionBounds(root, snap.selection);
      if (bb) {
        const z = snap.zoom;
        const r = wrap.current!.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const bsx = snap.panX + bb.x * z;
        const bsy = snap.panY + bb.y * z;
        const bsw = bb.w * z;
        const bsh = bb.h * z;
        const bcx = bsx + bsw / 2;
        const bcy = bsy + bsh / 2;
        const hs = handles(bsx, bsy, bsw, bsh);
        for (let i = 0; i < hs.length; i += 2) {
          const d = Math.hypot(px - hs[i][0], py - hs[i][1]);
          if (d >= 6 && d <= 22) {
            engine.dispatch({ type: "begin" });
            const startAngle = Math.atan2(e.clientY - bcy, e.clientX - bcx);
            drag.current = {
              mode: "multiRotate",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              bounds: bb,
              origs: multiOrigins(root, snap.selection),
              startAngle,
              cx: bcx,
              cy: bcy,
            };
            return;
          }
        }
        for (let i = 0; i < hs.length; i++) {
          if (Math.hypot(px - hs[i][0], py - hs[i][1]) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "multiResize",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              corner: i,
              bounds: bb,
              origs: multiOrigins(root, snap.selection),
            };
            return;
          }
        }
      }
    }
    if (snap.selection.length === 1) {
      const wp = worldPos(root, snap.selection[0]);
      if (wp) {
        const z = snap.zoom;
        const nb = nodeVisualBounds(wp);
        const sx = snap.panX + nb.x * z;
        const sy = snap.panY + nb.y * z;
        const r = wrap.current!.getBoundingClientRect();
        const rawX = e.clientX - r.left;
        const rawY = e.clientY - r.top;
        let px = rawX;
        let py = rawY;
        if (wp.node.rotation || wp.node.flipH || wp.node.flipV) {
          const cx = sx + (nb.w * z) / 2;
          const cy = sy + (nb.h * z) / 2;
          const u = wp.node.rotation ? unrot(px, py, cx, cy, wp.node.rotation) : { x: px, y: py };
          px = wp.node.flipH ? cx - (u.x - cx) : u.x;
          py = wp.node.flipV ? cy - (u.y - cy) : u.y;
        }
        const ft = wp.node.fillType;
        if (snap.rightTab === "prototype") {
          // Flow starting point badge click
          const flowStartId = snap.pages[snap.page].flowStart;
          if (flowStartId) {
            const startWp = worldPos(root, flowStartId);
            if (startWp) {
              const fx = snap.panX + startWp.x * z;
              const fy = snap.panY + startWp.y * z;
              if (rawX >= fx && rawX <= fx + 75 && rawY >= fy - 32 && rawY <= fy - 8) {
                engine.dispatch({ type: "presentStart", id: flowStartId });
                return;
              }
            }
          }

          const sw = wp.node.w * z;
          const sh = wp.node.h * z;
          const handles = [
            { x: sx + sw, y: sy + sh / 2, side: "right" as const },
            { x: sx + sw / 2, y: sy + sh, side: "bottom" as const },
            { x: sx, y: sy + sh / 2, side: "left" as const },
            { x: sx + sw / 2, y: sy, side: "top" as const },
          ];
          for (const h of handles) {
            if (Math.hypot(rawX - h.x, rawY - h.y) <= 13) {
              const fromX = wp.x + (h.side === "right" ? wp.node.w : h.side === "left" ? 0 : wp.node.w / 2);
              const fromY = wp.y + (h.side === "bottom" ? wp.node.h : h.side === "top" ? 0 : wp.node.h / 2);
              drag.current = {
                mode: "protoConnect",
                sx: e.clientX,
                sy: e.clientY,
                wx: wpt.x,
                wy: wpt.y,
                fromX,
                fromY,
                id: wp.node.id,
                forcedSide: h.side,
              };
              setProtoDrag({
                srcId: wp.node.id,
                fromX,
                fromY,
                toX: wpt.x,
                toY: wpt.y,
                forcedSide: h.side,
              });
              return;
            }
          }
        }
        if (ft === "linear" || ft === "radial" || ft === "angular" || ft === "diamond") {
          const ax = sx + (wp.node.fillGX ?? 0.5) * wp.node.w * z;
          const ay = sy + (wp.node.fillGY ?? 0) * wp.node.h * z;
          const bx = sx + (wp.node.fillHX ?? 0.5) * wp.node.w * z;
          const by = sy + (wp.node.fillHY ?? 1) * wp.node.h * z;
          if (Math.hypot(px - ax, py - ay) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "grad", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, handle: "g" };
            return;
          }
          if (Math.hypot(px - bx, py - by) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "grad", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, handle: "h" };
            return;
          }
        }
        if (wp.node.kind === "star") {
          const sw = wp.node.w * z;
          const sh = wp.node.h * z;
          const cx = sx + sw / 2;
          const cy = sy + sh / 2;
          const rx = sw / 2;
          const ry = sh / 2;
          const pts = Math.max(3, Math.min(60, Math.round(wp.node.count || 5)));
          const a = Math.PI / pts - Math.PI / 2;
          const k = Math.max(0.05, Math.min(0.95, wp.node.starRatio ?? 0.4));
          const hx = cx + Math.cos(a) * rx * k;
          const hy = cy + Math.sin(a) * ry * k;
          if (Math.hypot(px - hx, py - hy) <= 9) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "starRatio",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            return;
          }
          const aCount = (2 * Math.PI) / pts - Math.PI / 2;
          const cxCount = cx + Math.cos(aCount) * rx;
          const cyCount = cy + Math.sin(aCount) * ry;
          if (Math.hypot(px - cxCount, py - cyCount) <= 9) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "starCount",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            return;
          }
          const cr = wp.node.cornerRadii[0] || 0;
          const radY = cy - ry + Math.min(ry * 0.4, Math.max(10, cr * z));
          if (Math.hypot(px - cx, py - radY) <= 9) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "starRadius",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            return;
          }
        }
        if (wp.node.kind === "poly") {
          const sw = wp.node.w * z;
          const sh = wp.node.h * z;
          const cx = sx + sw / 2;
          const cy = sy + sh / 2;
          const rx = sw / 2;
          const ry = sh / 2;
          const pts = Math.max(3, Math.min(60, Math.round(wp.node.count || 3)));
          const aCount = (2 * Math.PI) / pts - Math.PI / 2;
          const cxCount = cx + Math.cos(aCount) * rx;
          const cyCount = cy + Math.sin(aCount) * ry;
          if (Math.hypot(px - cxCount, py - cyCount) <= 9) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "polyCount",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            return;
          }
          const cr = wp.node.cornerRadii[0] || 0;
          const radY = cy - ry + Math.min(ry * 0.4, Math.max(10, cr * z));
          if (Math.hypot(px - cx, py - radY) <= 9) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "polyRadius",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            return;
          }
        }
        if (wp.node.kind === "ellipse") {
          const sw = wp.node.w * z;
          const sh = wp.node.h * z;
          const cx = sx + sw / 2;
          const cy = sy + sh / 2;
          const rx = sw / 2;
          const ry = sh / 2;
          const ea = wp.node.arcData?.endingAngle ?? Math.PI * 2;
          const ir = wp.node.arcData?.innerRadius ?? 0;
          const hx = cx + Math.cos(ea) * rx;
          const hy = cy + Math.sin(ea) * ry;
          if (Math.hypot(px - hx, py - hy) <= 9) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "arc",
              handle: "out",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            return;
          }
          if (ir > 0) {
            const rhx = cx + Math.cos(ea) * rx * ir;
            const rhy = cy + Math.sin(ea) * ry * ir;
            if (Math.hypot(px - rhx, py - rhy) <= 9) {
              engine.dispatch({ type: "begin" });
              drag.current = {
                mode: "arc",
                handle: "in",
                sx: e.clientX,
                sy: e.clientY,
                wx: wpt.x,
                wy: wpt.y,
                id: wp.node.id,
              };
              return;
            }
          }
        }
        if (
          (wp.node.kind === "rect" || wp.node.kind === "frame" || wp.node.kind === "component" || wp.node.kind === "instance") &&
          !vecEdit &&
          wp.node.w * z >= 36 &&
          wp.node.h * z >= 36
        ) {
          const sw = wp.node.w * z;
          const sh = wp.node.h * z;
          // Positions and storage order come from one helper now: the pins were
          // laid out TL, TR, BR, BL while the array is TL, TR, BL, BR, so the
          // handle drawn on the bottom right adjusted the bottom left radius.
          const pins = cornerPinPoints(sw, sh, cornerRadiiOf(wp.node), z);
          const PIN_INDEX = { tl: 0, tr: 1, bl: 2, br: 3 } as const;
          for (const pin of pins) {
            if (Math.hypot(px - (sx + pin.x), py - (sy + pin.y)) <= 7) {
              // Alt is "this corner only", which is refused on an instance -
              // the corners belong to the component. Explain instead of
              // starting a drag that silently rounds all four.
              if (e.altKey && insideInstance(snap.pages[snap.page].root, wp.node.id)) {
                toast("Individual corner radius cannot be set on an instance");
                return;
              }
              engine.dispatch({ type: "begin" });
              drag.current = {
                mode: "radius",
                corner: PIN_INDEX[pin.index],
                sx: e.clientX,
                sy: e.clientY,
                wx: wpt.x,
                wy: wpt.y,
                id: wp.node.id,
              };
              return;
            }
          }
        }
        if (vecEdit === wp.node.id) {
          const pts = wp.node.path.length ? wp.node.path : shapePoly(wp.node);
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const vx = snap.panX + (wp.x + p.x) * z;
            const vy = snap.panY + (wp.y + p.y) * z;
            if (Math.hypot(px - (vx + (p.ix || 0) * z), py - (vy + (p.iy || 0) * z)) < 7) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i, handle: "in" };
              return;
            }
            if (Math.hypot(px - (vx + (p.ox || 0) * z), py - (vy + (p.oy || 0) * z)) < 7) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i, handle: "out" };
              return;
            }
            if (Math.hypot(px - vx, py - vy) < 8) {
              engine.dispatch({ type: "begin" });
              const multi = e.shiftKey;
              let nextSel = snap.vecPoints && snap.vecPoints.length > 0 ? [...snap.vecPoints] : (vecPt.current >= 0 ? [vecPt.current] : []);
              if (multi) {
                if (nextSel.includes(i)) {
                  nextSel = nextSel.filter((idx) => idx !== i);
                } else {
                  nextSel.push(i);
                }
              } else {
                if (!nextSel.includes(i)) {
                  nextSel = [i];
                }
              }
              vecPt.current = i;
              setVecEdit(wp.node.id, i, nextSel);
              drag.current = { mode: "vec", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, point: i, origPts: pts.map((pt) => ({ ...pt })) };
              return;
            }
          }
          const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
          if (vecSubTool === "paint") {
            const nextFill = wp.node.fillVisible ? (wp.node.fill || "#d9d9d9") : "#10b981";
            const vn = wp.node.vectorNetwork || pathToVectorNetwork(wp.node.path, wp.node.closed);
            const updatedVn = fillNetworkRegionAtPoint(vn, local.x, local.y, nextFill);
            engine.dispatch({ type: "patchVectorNetwork", id: wp.node.id, network: updatedVn });
            engine.dispatch({ type: "patch", id: wp.node.id, patch: { fillVisible: true } });
            toast("Filled vector region (Paint Bucket)");
            return;
          }
          if (vecSubTool === "shapeBuilder") {
            if (e.altKey) {
              engine.dispatch({ type: "shapeBuilder", op: "subtract" });
              toast("Subtracted shape region (Option-click)");
            } else {
              engine.dispatch({ type: "shapeBuilder", op: "merge" });
              toast("Merged shape region");
            }
            return;
          }
          const meta = e.metaKey || e.ctrlKey || e.altKey || vecSubTool === "bend";
          if (meta) {
            const npts = pts.length;
            const count = wp.node.closed ? npts : npts - 1;
            for (let si = 0; si < count; si++) {
              const p1 = pts[si];
              const p2 = pts[(si + 1) % npts];
              const pr = projectPointOnSegment(local.x, local.y, p1.x, p1.y, p2.x, p2.y);
              if (pr.dist < 14 / snap.zoom && pr.t > 0.05 && pr.t < 0.95) {
                engine.dispatch({ type: "begin" });
                drag.current = { mode: "bend", id: wp.node.id, segIndex: si, sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y };
                toast("Bending segment (Bend tool)");
                return;
              }
            }
          } else {
            const res = insertPointOnPath(pts, local.x, local.y, wp.node.closed, 10 / snap.zoom);
            if (res) {
              engine.dispatch({ type: "insertPointOnPath", id: wp.node.id, x: local.x, y: local.y });
              vecPt.current = res.insertedIndex;
              setVecEdit(wp.node.id, res.insertedIndex);
              toast("Point added on path");
              return;
            }
          }
        }
        if (rotTarget && snap.selection.length === 1) {
          const o = wp.node.rotOrigin ?? [0.5, 0.5];
          const ox = wp.x + o[0] * wp.node.w;
          const oy = wp.y + o[1] * wp.node.h;
          const rot = ((wp.node.rotation ?? 0) * Math.PI) / 180;
          const cw = wp.x + wp.node.w / 2;
          const ch2 = wp.y + wp.node.h / 2;
          const dx = ox - cw;
          const dy = oy - ch2;
          const txs = snap.panX + (cw + dx * Math.cos(rot) - dy * Math.sin(rot)) * z;
          const tys = snap.panY + (ch2 + dx * Math.sin(rot) + dy * Math.cos(rot)) * z;
          if (Math.hypot(px - txs, py - tys) < 9) {
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "rotOrigin",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              id: wp.node.id,
            };
            toast("Rotation origin");
            return;
          }
        }
        const hs = handles(sx, sy, nb.w * z, nb.h * z);
        const cx = sx + (nb.w * z) / 2;
        const cy = sy + (nb.h * z) / 2;
        // Corner rotation zone: outside any of the 4 corner handles
        for (let i = 0; i < hs.length; i += 2) {
          const d = Math.hypot(px - hs[i][0], py - hs[i][1]);
          if (d >= 6 && d <= 22) {
            const startAngle = Math.atan2(rawY - cy, rawX - cx);
            engine.dispatch({ type: "begin" });
            drag.current = {
              mode: "rotate",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              orig: { x: nb.x, y: nb.y, w: nb.w, h: nb.h, rotation: wp.node.rotation || 0 },
              origLocal: { x: wp.node.x, y: wp.node.y },
              id: wp.node.id,
              startAngle,
              origRotation: wp.node.rotation || 0,
              cx,
              cy,
            };
            return;
          }
        }
        const isLine = wp.node.kind === "line" || wp.node.kind === "arrow";
        const isTextHug = wp.node.kind === "text" && wp.node.sizingW === "hug" && wp.node.sizingH === "hug";
        for (let i = 0; i < hs.length; i++) {
          if (isLine && i !== 3 && i !== 7) continue;
          if (isTextHug && i % 2 === 0) continue;
          if (Math.hypot(px - hs[i][0], py - hs[i][1]) < 8) {
            // The scale tool ignores layers nested inside an instance; a
            // plain resize is still allowed, because that is an override.
            if (snap.tool === "scale" && insideInstance(root, wp.node.id)) {
              toast("Not scalable · this layer is inside an instance");
              return;
            }
            drag.current = {
              mode: "resize",
              sx: e.clientX,
              sy: e.clientY,
              wx: wpt.x,
              wy: wpt.y,
              orig: { x: wp.node.x, y: wp.node.y, w: wp.node.w, h: wp.node.h, rotation: wp.node.rotation },
              corner: i,
              id: wp.node.id,
            };
            engine.dispatch({ type: "begin" });
            return;
          }
        }
        if (wp.node.layout) {
          const l = wp.node.layout;
          const [pl, pr, pt, pb] = l.padding;
          const sw = wp.node.w * z;
          const sh = wp.node.h * z;
          if (Math.hypot(px - (sx + sw / 2), py - (sy + pt * z)) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "autoPad", padEdge: "top", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, origPad: [...l.padding], padOpp: e.altKey, padAll: e.altKey && e.shiftKey, moved: false };
            return;
          }
          if (Math.hypot(px - (sx + sw / 2), py - (sy + sh - pb * z)) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "autoPad", padEdge: "bottom", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, origPad: [...l.padding], padOpp: e.altKey, padAll: e.altKey && e.shiftKey, moved: false };
            return;
          }
          if (Math.hypot(px - (sx + pl * z), py - (sy + sh / 2)) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "autoPad", padEdge: "left", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, origPad: [...l.padding], padOpp: e.altKey, padAll: e.altKey && e.shiftKey, moved: false };
            return;
          }
          if (Math.hypot(px - (sx + sw - pr * z), py - (sy + sh / 2)) < 8) {
            engine.dispatch({ type: "begin" });
            drag.current = { mode: "autoPad", padEdge: "right", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, origPad: [...l.padding], padOpp: e.altKey, padAll: e.altKey && e.shiftKey, moved: false };
            return;
          }
          const flowKids = wp.node.children.filter((c) => c.visible && !c.absolutePosition);
          if (flowKids.length >= 2) {
            const c0 = flowKids[0];
            const horiz = l.direction === "horizontal";
            const gx = horiz ? sx + (c0.x + c0.w + l.gap / 2) * z : sx + sw / 2;
            const gy = horiz ? sy + sh / 2 : sy + (c0.y + c0.h + l.gap / 2) * z;
            if (Math.hypot(px - gx, py - gy) < 8) {
              engine.dispatch({ type: "begin" });
              drag.current = { mode: "autoGap", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, id: wp.node.id, origGap: l.gap };
              return;
            }
          }
        }
      }
    }

    if (snap.rightTab === "prototype" && !snap.presentFrame) {
      const hitConn = findClickedNoodle(root, wpt, snap.zoom);
      if (hitConn) {
        setSelectedConn(hitConn);
        engine.dispatch({ type: "select", ids: [hitConn.srcId] });
        return;
      } else if (selectedConn) {
        setSelectedConn(null);
      }
    }

    const hit = hitTest(root, wpt.x, wpt.y, {
      deep: e.metaKey || e.ctrlKey,
      selection: snap.selection,
    });
    if (hit) {
      const ids = e.shiftKey
        ? snap.selection.includes(hit.id)
          ? snap.selection.filter((i) => i !== hit.id)
          : [...snap.selection, hit.id]
        : [hit.id];
      if (snap.tool === "scale" && ids.some((id) => insideInstance(root, id))) {
        toast("Not scalable · this layer is inside an instance");
        return;
      }
      engine.dispatch({ type: "select", ids });
      engine.dispatch({ type: "begin" });
      drag.current = {
        mode: "move",
        sx: e.clientX,
        sy: e.clientY,
        wx: wpt.x,
        wy: wpt.y,
      };
    } else {
      if (!vecEdit) {
        engine.dispatch({ type: "select", ids: [] });
      }
      drag.current = { mode: "marquee", sx: e.clientX, sy: e.clientY, wx: wpt.x, wy: wpt.y, sel0: [...snap.selection] };
    }
  };

  /** ⌥ inverts the Zoom tool, so the cursor has to follow the modifier. Only
   *  tracked while that tool is armed — a state write on every mousemove would
   *  re-render the whole editor. */
  const [zoomOutCursor, setZoomOutCursor] = useState(false);
  const onMove = (e: React.MouseEvent) => {
    if (eyedropArmed() || snap.tool === "eraser") {
      setCursorPos({ x: e.clientX, y: e.clientY });
    } else if (cursorPos) {
      setCursorPos(null);
    }
    if (snap.tool === "zoom") {
      const want = e.altKey;
      setZoomOutCursor((v) => (v === want ? v : want));
    } else if (zoomOutCursor) {
      setZoomOutCursor(false);
    }
    if (snap.presentFrame) {
      const wpt = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      const n: XNode | null = hitTest(root, wpt.x, wpt.y, { deep: true, includeLocked: true });
      const id = n ? n.id : "";
      if (id !== hoverIx.current) {
        const prev = hoverIx.current;
        hoverIx.current = id;
        if (prev) runTrigger(root, prev, "mouseLeave");
        // "While hovering" fires on entry, like before; mouse enter joins it.
        if (n) {
          runTrigger(root, n.id, "mouseEnter");
          runTrigger(root, n.id, "onHover");
        }
      }
      // Drag trigger: fire once per press-drag-release past the threshold.
      const d = dragIx.current;
      if (d && !d.fired && d.id && Math.hypot(wpt.x - d.x, wpt.y - d.y) > 8) {
        d.fired = true;
        runTrigger(root, d.id, "onDrag");
      }
      return;
    }
    if (!drag.current && !penDrag.current && !pencil.current && snap.tool === "select") {
      if (e.altKey !== altMeasure) setAltMeasure(e.altKey);
      const wpt = toWorld(e.clientX, e.clientY);
      const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { selection: snap.selection });
      const id = hit && !snap.selection.includes(hit.id) ? hit.id : "";
      if (id !== hoverId) setHoverId(id);
      // Mirror the mousedown hit-test so the cursor advertises what a press
      // would actually do: resize on a handle, rotate just outside a corner,
      // move over the selection itself.
      const root0 = snap.pages[snap.page].root;
      const r0 = wrap.current?.getBoundingClientRect();
      let next: string | null = null;
      if (r0 && snap.selection.length) {
        const z = snap.zoom;
        const px0 = e.clientX - r0.left;
        const py0 = e.clientY - r0.top;
        const bb = snap.selection.length === 1 ? worldPos(root0, snap.selection[0]) : null;
        const b = bb ? nodeVisualBounds(bb) : null;
        const box = bb && b
          ? { x: b.x, y: b.y, w: b.w, h: b.h, rot: bb.node.rotation }
          : (() => {
              const b = selectionBounds(root0, snap.selection);
              return b ? { x: b.x, y: b.y, w: b.w, h: b.h, rot: 0 } : null;
            })();
        if (box) {
          const sx0 = snap.panX + box.x * z;
          const sy0 = snap.panY + box.y * z;
          let hx = px0;
          let hy = py0;
          if (box.rot) {
            const cx = sx0 + (box.w * z) / 2;
            const cy = sy0 + (box.h * z) / 2;
            const u = unrot(hx, hy, cx, cy, box.rot);
            hx = u.x;
            hy = u.y;
          }
          const hs = handles(sx0, sy0, box.w * z, box.h * z);
          for (let i = 0; i < hs.length; i++) {
            if (Math.hypot(hx - hs[i][0], hy - hs[i][1]) < 8) {
              next = resizeCursor(i, box.rot);
              break;
            }
            // Just outside a corner is the rotate zone.
            if (i % 2 === 0 && Math.hypot(hx - hs[i][0], hy - hs[i][1]) <= 22 && Math.hypot(hx - hs[i][0], hy - hs[i][1]) >= 6) {
              next = ROT_CURSOR;
            }
          }
          if (!next && bb?.node.layout) {
            const l = bb.node.layout;
            const [pl, pr, pt, pb] = l.padding;
            const sw0 = box.w * z;
            const sh0 = box.h * z;
            if (Math.hypot(hx - (sx0 + sw0 / 2), hy - (sy0 + pt * z)) < 8) {
              next = "ns-resize";
            } else if (Math.hypot(hx - (sx0 + sw0 / 2), hy - (sy0 + sh0 - pb * z)) < 8) {
              next = "ns-resize";
            } else if (Math.hypot(hx - (sx0 + pl * z), hy - (sy0 + sh0 / 2)) < 8) {
              next = "ew-resize";
            } else if (Math.hypot(hx - (sx0 + sw0 - pr * z), hy - (sy0 + sh0 / 2)) < 8) {
              next = "ew-resize";
            } else {
              const flowKids = bb.node.children.filter((c) => c.visible && !c.absolutePosition);
              if (flowKids.length >= 2) {
                const c0 = flowKids[0];
                const horiz = l.direction === "horizontal";
                const gx = horiz ? sx0 + (c0.x + c0.w + l.gap / 2) * z : sx0 + sw0 / 2;
                const gy = horiz ? sy0 + sh0 / 2 : sy0 + (c0.y + c0.h + l.gap / 2) * z;
                if (Math.hypot(hx - gx, hy - gy) < 8) {
                  next = horiz ? "col-resize" : "row-resize";
                }
              }
            }
          }
          if (
            !next &&
            hx >= sx0 &&
            hx <= sx0 + box.w * z &&
            hy >= sy0 &&
            hy <= sy0 + box.h * z
          ) {
            next = "move";
          }
          if (snap.rightTab === "prototype" && bb) {
            const cx = sx0 + box.w * z;
            const cy = sy0 + (box.h * z) / 2;
            if (Math.hypot(px0 - cx, py0 - cy) <= 12) {
              next = "crosshair";
            }
          }
        }
      }
      if (next !== hoverCursor) setHoverCursor(next);
    } else if (hoverId && snap.tool !== "select") setHoverId("");
    if (snap.tool === "pen" && (draft.length || penBranch.current) && !penDrag.current) {
      let wpt = toWorld(e.clientX, e.clientY);
      if (e.shiftKey && draft.length) {
        const last = draft[draft.length - 1];
        const ang = Math.round(Math.atan2(wpt.y - last.y, wpt.x - last.x) / (Math.PI / 4)) * (Math.PI / 4);
        const d = Math.hypot(wpt.x - last.x, wpt.y - last.y);
        wpt = { x: last.x + Math.cos(ang) * d, y: last.y + Math.sin(ang) * d };
      }
      const gx = Math.round(wpt.x);
      const gy = Math.round(wpt.y);
      if (!ghost || Math.round(ghost.x) !== gx || Math.round(ghost.y) !== gy) setGhost({ x: gx, y: gy });
      // Which point would this click join? Mark it with a circle, and a
      // guess-the-target affordance is how a pen either feels precise or feels
      // like a trap.
      let hint: number | null = null;
      for (let i = 0; i < draft.length; i++) {
        if (Math.hypot(wpt.x - draft[i].x, wpt.y - draft[i].y) < 14 / snap.zoom) {
          hint = i;
          break;
        }
      }
      if (hint !== closeHint) setCloseHint(hint);
    } else if (ghost) setGhost(null);
    if (penDrag.current) {
      const wpt = toWorld(e.clientX, e.clientY);
      const p = penDrag.current;
      const ox = wpt.x - p.x;
      const oy = wpt.y - p.y;
      if (Math.hypot(ox, oy) > 2 / snap.zoom) {
        setDraft((d) => {
          const next = d.map((pt) => ({ ...pt }));
          const i = p.i;
          if (next[i]) {
            next[i].ox = ox;
            next[i].oy = oy;
            next[i].ix = -ox;
            next[i].iy = -oy;
          }
          return next;
        });
      }
      return;
    }
    if (pencil.current) {
      const wpt = toWorld(e.clientX, e.clientY);
      pencil.current.push(wpt);
      setDraft([...pencil.current]);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const box = wrap.current!.getBoundingClientRect();
    if (d.mode === "pan") {
      engine.dispatch({ type: "pan", dx: e.clientX - d.sx, dy: e.clientY - d.sy });
      d.sx = e.clientX;
      d.sy = e.clientY;
    } else if (d.mode === "protoConnect" && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const root = snap.pages[snap.page].root;
      let targetId: string | undefined = undefined;
      for (const ch of root.children) {
        if (ch.id !== d.id && ch.kind === "frame") {
          const wp = worldPos(root, ch.id);
          if (wp && wpt.x >= wp.x && wpt.x <= wp.x + wp.node.w && wpt.y >= wp.y && wpt.y <= wp.y + wp.node.h) {
            targetId = ch.id;
            break;
          }
        }
      }
      if (!targetId) {
        const hit = hitTest(root, wpt.x, wpt.y, { includeLocked: false });
        if (hit && hit.id !== d.id) targetId = hit.id;
      }
      setProtoDrag({
        srcId: d.id,
        fromX: d.fromX ?? wpt.x,
        fromY: d.fromY ?? wpt.y,
        toX: wpt.x,
        toY: wpt.y,
        targetId,
        forcedSide: d.forcedSide,
      });
      return;
    } else if (d.mode === "move" && (snap.tool === "select" || snap.tool === "scale")) {
      if (e.altKey && !d.duped) {
        engine.dispatch({ type: "duplicate" });
        d.duped = true;
      }
      let dx = (e.clientX - d.sx) / snap.zoom;
      let dy = (e.clientY - d.sy) / snap.zoom;
      if (e.shiftKey) {
        if (!d.axis) d.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        if (d.axis === "x") dy = 0;
        else dx = 0;
      } else {
        d.axis = null;
      }
      if (dx || dy) {
        const sel = engine.snapshot().selection;
        // Snap the moved bounding box to nearby geometry. Holding ⌘/Ctrl
        // bypasses snapping.
        if (!e.metaKey && !e.ctrlKey) {
          const root2 = snap.pages[snap.page].root;
          const bb = selectionBounds(root2, sel);
          if (bb) {
            const moved = { id: "sel", x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h };
            const res = snapMove(
              moved,
              snapTargets.current,
              SNAP_PX / snap.zoom,
              snap.pages[snap.page].guides,
            );
            dx += res.dx;
            dy += res.dy;
            setGuides(res.guides);
            setGapBadges(res.gaps);
          }
        } else if (guides.length || gapBadges.length) {
          setGuides([]);
          setGapBadges([]);
        }
        engine.dispatch({ type: "move", ids: sel, dx, dy });
        d.sx = e.clientX;
        d.sy = e.clientY;
      }
    } else if (d.mode === "multiResize" && d.bounds && d.origs && d.corner != null) {
      const b = toWorld(e.clientX, e.clientY);
      const next = resizeFrom(d.bounds, d.corner, b.x, b.y, {
        aspect: e.shiftKey,
        fromCenter: e.altKey,
      });
      const sxScale = next.w / Math.max(1e-6, d.bounds.w);
      const syScale = next.h / Math.max(1e-6, d.bounds.h);
      // Map each member through the same affine scale about the box origin.
      for (const o of d.origs) {
        const nx = next.x + (o.x - d.bounds.x) * sxScale;
        const ny = next.y + (o.y - d.bounds.y) * syScale;
        engine.dispatch({
          type: "resize",
          id: o.id,
          x: o.lx + (nx - o.x),
          y: o.ly + (ny - o.y),
          w: Math.max(1, o.w * sxScale),
          h: Math.max(1, o.h * syScale),
          scaleProps: snap.tool === "scale",
          ignoreConstraints: e.metaKey || e.ctrlKey,
        });
      }
    } else if (d.mode === "multiRotate" && d.bounds && d.origs) {
      const z = snap.zoom;
      const r = wrap.current?.getBoundingClientRect();
      const rawX = e.clientX - (r?.left ?? 0);
      const rawY = e.clientY - (r?.top ?? 0);
      const cx = d.cx ?? (snap.panX + (d.bounds.x + d.bounds.w / 2) * z);
      const cy = d.cy ?? (snap.panY + (d.bounds.y + d.bounds.h / 2) * z);
      const curAngle = Math.atan2(rawY - cy, rawX - cx);
      let deltaDeg = ((curAngle - (d.startAngle ?? 0)) * 180) / Math.PI;
      let ang = deltaDeg;
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      const rad = (ang * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const wcx = d.bounds.x + d.bounds.w / 2;
      const wcy = d.bounds.y + d.bounds.h / 2;
      for (const o of d.origs) {
        const ox = o.x + o.w / 2 - wcx;
        const oy = o.y + o.h / 2 - wcy;
        const wx = wcx + ox * cos - oy * sin - o.w / 2;
        const wy = wcy + ox * sin + oy * cos - o.h / 2;
        engine.dispatch({
          type: "resize",
          id: o.id,
          x: o.lx + (wx - o.x),
          y: o.ly + (wy - o.y),
          w: o.w,
          h: o.h,
        });
        engine.dispatch({
          type: "patch",
          id: o.id,
          patch: { rotation: Math.round(((o.rotation || 0) + ang) * 10) / 10 },
        });
      }
    } else if (d.mode === "marquee" && d.id === "erase") {
      const wpt = toWorld(e.clientX, e.clientY);
      eraseAt(wpt.x, wpt.y);
    } else if (d.mode === "create" || d.mode === "marquee") {
      let x = Math.min(d.sx, e.clientX) - box.left;
      let y = Math.min(d.sy, e.clientY) - box.top;
      let w = Math.abs(e.clientX - d.sx);
      let h = Math.abs(e.clientY - d.sy);
      if (d.mode === "create" && e.shiftKey) {
        const s = Math.max(w, h);
        w = s;
        h = s;
      }
      if (d.mode === "create" && e.altKey) {
        x = d.sx - box.left - w;
        y = d.sy - box.top - h;
        w *= 2;
        h *= 2;
      }
      setBand({ x, y, w, h });
    } else if (d.mode === "resize" && d.orig && d.id != null && d.corner != null) {
      const raw = toWorld(e.clientX, e.clientY);
      const current = worldPos(snap.pages[snap.page].root, d.id);
      const node = current?.node;
      const shape = node ? { ...node, x: d.orig.x, y: d.orig.y, w: d.orig.w, h: d.orig.h } : null;
      const local = shape ? nodeLocalPoint(raw.x, raw.y, d.orig.x, d.orig.y, shape) : { x: raw.x - d.orig.x, y: raw.y - d.orig.y };
      const b = shape ? { x: d.orig.x + local.x, y: d.orig.y + local.y } : raw;
      // Two escape hatches on this drag: the Scale tool always
      // holds the ratio, and Control releases a ratio that is locked on the layer.
      const forcing = snap.tool === "scale" || !!node?.aspectLocked;
      const lock = e.shiftKey ? true : forcing && !e.ctrlKey;
      const next = resizeFrom(d.orig, d.corner, b.x, b.y, {
        aspect: lock,
        fromCenter: e.altKey,
      });
      // Snap the edges the handle is actually moving (skipped while aspect is
      // locked, since a snap would break the ratio, and on ⌘/Ctrl).
      if (!lock && !e.altKey && !e.metaKey && !e.ctrlKey && current) {
        const worldBox = {
          id: d.id,
          x: current.x + (next.x - node!.x),
          y: current.y + (next.y - node!.y),
          w: next.w,
          h: next.h,
        };
        const r2 = snapResize(worldBox, d.corner, snapTargets.current, SNAP_PX / snap.zoom);
        setGuides(r2.guides);
        const movesLeft = d.corner === 0 || d.corner === 6 || d.corner === 7;
        const movesTop = d.corner === 0 || d.corner === 1 || d.corner === 2;
        if (r2.dx) {
          if (movesLeft) {
            next.x += r2.dx;
            next.w = Math.max(1, next.w - r2.dx);
          } else next.w = Math.max(1, next.w + r2.dx);
        }
        if (r2.dy) {
          if (movesTop) {
            next.y += r2.dy;
            next.h = Math.max(1, next.h - r2.dy);
          } else next.h = Math.max(1, next.h + r2.dy);
        }
      }
      engine.dispatch({
        type: "resize",
        id: d.id,
        ...next,
        scaleProps: snap.tool === "scale",
        // ⌘/Ctrl-drag resizes past the children's constraints.
        ignoreConstraints: e.metaKey || e.ctrlKey,
      });
    } else if (d.mode === "grad" && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const local = nodeLocalPoint(wpt.x, wpt.y, wp.x, wp.y, wp.node);
        const lx = local.x / Math.max(1, wp.node.w);
        const ly = local.y / Math.max(1, wp.node.h);
        if (d.handle === "g") engine.dispatch({ type: "patch", id: d.id, patch: { fillGX: lx, fillGY: ly } });
        else engine.dispatch({ type: "patch", id: d.id, patch: { fillHX: lx, fillHY: ly } });
      }
    } else if (d.mode === "vec" && d.id != null && d.point != null) {
      const wpt = toWorld(e.clientX, e.clientY);
      const loc = worldPos(snap.pages[snap.page].root, d.id);
      const n = loc?.node;
      if (n && loc) {
        const pts = (n.path.length ? n.path : shapePoly(n)).map((p) => ({ ...p }));
        const p = pts[d.point];
        const local = nodeLocalPoint(wpt.x, wpt.y, loc.x, loc.y, n);
        const lx = local.x;
        const ly = local.y;
        if (d.handle === "in") {
          p.ix = lx - p.x;
          p.iy = ly - p.y;
          if (p.mirrorMode === "angleAndLength" && !e.altKey) {
            p.ox = -p.ix;
            p.oy = -p.iy;
          } else if (p.mirrorMode === "angle" && !e.altKey && (p.ox || p.oy)) {
            const inLen = Math.hypot(p.ix, p.iy);
            const outLen = Math.hypot(p.ox || 0, p.oy || 0);
            if (inLen > 0.001) {
              p.ox = (-p.ix / inLen) * outLen;
              p.oy = (-p.iy / inLen) * outLen;
            }
          }
        } else if (d.handle === "out") {
          p.ox = lx - p.x;
          p.oy = ly - p.y;
          if (p.mirrorMode === "angleAndLength" && !e.altKey) {
            p.ix = -p.ox;
            p.iy = -p.oy;
          } else if (p.mirrorMode === "angle" && !e.altKey && (p.ix || p.iy)) {
            const outLen = Math.hypot(p.ox, p.oy);
            const inLen = Math.hypot(p.ix || 0, p.iy || 0);
            if (outLen > 0.001) {
              p.ix = (-p.ox / outLen) * inLen;
              p.iy = (-p.oy / outLen) * inLen;
            }
          }
        } else {
          const movingIndices = snap.vecPoints && snap.vecPoints.includes(d.point) ? snap.vecPoints : [d.point];
          if (movingIndices.length > 1 && d.origPts) {
            const origP = d.origPts[d.point];
            const totalDx = lx - origP.x;
            const totalDy = ly - origP.y;
            for (const idx of movingIndices) {
              if (d.origPts[idx] && pts[idx]) {
                pts[idx].x = d.origPts[idx].x + totalDx;
                pts[idx].y = d.origPts[idx].y + totalDy;
              }
            }
          } else {
            p.x = lx;
            p.y = ly;
          }
        }
        engine.dispatch({ type: "patchPath", id: n.id, path: pts, closed: n.closed });
      }
    } else if (d.mode === "bend" && d.id != null && d.segIndex != null) {
      const wpt = toWorld(e.clientX, e.clientY);
      const loc = worldPos(snap.pages[snap.page].root, d.id);
      if (loc) {
        const local = nodeLocalPoint(wpt.x, wpt.y, loc.x, loc.y, loc.node);
        engine.dispatch({
          type: "bendSegment",
          id: d.id,
          segIndex: d.segIndex,
          dragX: local.x,
          dragY: local.y,
        });
      }
    } else if (d.mode === "rotate" && d.orig && d.id) {
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (!wp) return;
      const z = snap.zoom;
      const r = wrap.current?.getBoundingClientRect();
      const rawX = e.clientX - (r?.left ?? 0);
      const rawY = e.clientY - (r?.top ?? 0);
      const cx = d.cx ?? (snap.panX + (wp.x + wp.node.w / 2) * z);
      const cy = d.cy ?? (snap.panY + (wp.y + wp.node.h / 2) * z);
      const curAngle = Math.atan2(rawY - cy, rawX - cx);
      let deltaDeg = ((curAngle - (d.startAngle ?? 0)) * 180) / Math.PI;
      let nextRot = (d.origRotation ?? d.orig.rotation ?? 0) + deltaDeg;
      if (e.shiftKey) nextRot = Math.round(nextRot / 15) * 15;
      else nextRot = Math.round(nextRot * 10) / 10;
      while (nextRot > 180) nextRot -= 360;
      while (nextRot <= -180) nextRot += 360;
      // A moved rotation origin means the box has to slide as it turns, so the
      // pivot is the point that stays put; the spin itself is unchanged.
      const next = rotateAboutOrigin(
        { x: d.orig.x, y: d.orig.y, w: d.orig.w, h: d.orig.h, rotation: d.orig.rotation },
        wp.node.rotOrigin ?? [0.5, 0.5],
        Math.round(nextRot),
      );
      engine.dispatch({
        type: "patch",
        id: d.id,
        patch: {
          x: (d.origLocal?.x ?? wp.node.x) + (next.x - d.orig.x),
          y: (d.origLocal?.y ?? wp.node.y) + (next.y - d.orig.y),
          rotation: next.rotation,
        },
      });
    } else if (d.mode === "rotOrigin" && d.id) {
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const pt = toWorld(e.clientX, e.clientY);
        const p = nodeLocalPoint(pt.x, pt.y, wp.x, wp.y, wp.node);
        engine.dispatch({
          type: "patch",
          id: d.id,
          patch: {
            rotOrigin: [
              wp.node.w ? (p.x - wp.x) / wp.node.w : 0.5,
              wp.node.h ? (p.y - wp.y) / wp.node.h : 0.5,
            ],
          },
        });
      }
    } else if (d.mode === "autoPad" && d.id && d.padEdge && d.origPad) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp?.node.layout) {
        const [pl, pr, pt, pb] = d.origPad;
        const dx = Math.round(wpt.x - d.wx);
        const dy = Math.round(wpt.y - d.wy);
        // On-canvas modifiers:
        // ⌥ sets the padding on the opposite side too, ⌥⇧ sets it on all four,
        // and ⇧ alone drags in big-nudge steps.
        const opp = e.altKey;
        const all = e.altKey && e.shiftKey;
        const big = e.shiftKey && !e.altKey ? getNudgePrefs().big : 1;
        const q = (v: number) => Math.max(0, Math.round(v / big) * big);
        let value = 0;
        if (d.padEdge === "top") value = q(pt + dy);
        else if (d.padEdge === "bottom") value = q(pb - dy);
        else if (d.padEdge === "left") value = q(pl + dx);
        else value = q(pr - dx);
        // A handle that has not changed anything yet is still a click, not a
        // drag: the field is opened on mouse-up instead of resizing.
        const was = d.padEdge === "top" ? pt : d.padEdge === "bottom" ? pb : d.padEdge === "left" ? pl : pr;
        if (value !== was) d.moved = true;
        const nextPad: [number, number, number, number] = [pl, pr, pt, pb];
        if (all) nextPad[0] = nextPad[1] = nextPad[2] = nextPad[3] = value;
        else if (d.padEdge === "top") {
          nextPad[2] = value;
          if (opp) nextPad[3] = value;
        } else if (d.padEdge === "bottom") {
          nextPad[3] = value;
          if (opp) nextPad[2] = value;
        } else if (d.padEdge === "left") {
          nextPad[0] = value;
          if (opp) nextPad[1] = value;
        } else {
          nextPad[1] = value;
          if (opp) nextPad[0] = value;
        }
        engine.dispatch({ type: "autoLayout", id: d.id, layout: { ...wp.node.layout, padding: nextPad } });
      }
    } else if (d.mode === "autoGap" && d.id && d.origGap != null) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp?.node.layout) {
        const horiz = wp.node.layout.direction === "horizontal";
        // ⇧ drags the gap in big-nudge steps, as it does for padding.
        const big = e.shiftKey && !e.altKey ? getNudgePrefs().big : 1;
        const delta = Math.round(horiz ? wpt.x - d.wx : wpt.y - d.wy);
        const nextGap = Math.max(0, Math.round((d.origGap + delta) / big) * big);
        engine.dispatch({ type: "autoLayout", id: d.id, layout: { ...wp.node.layout, gap: nextGap } });
      }
    } else if (d.mode === "starRatio" && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const cx = wp.x + wp.node.w / 2;
        const cy = wp.y + wp.node.h / 2;
        const maxR = Math.hypot(wp.node.w / 2, wp.node.h / 2);
        const curR = Math.hypot(wpt.x - cx, wpt.y - cy);
        const ratio = Math.max(0.05, Math.min(0.95, curR / (maxR || 1)));
        engine.dispatch({ type: "patch", id: d.id, patch: { starRatio: ratio } });
      }
    } else if ((d.mode === "starRadius" || d.mode === "polyRadius") && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const cy = wp.y + wp.node.h / 2;
        const topY = cy - wp.node.h / 2;
        const dist = Math.max(0, wpt.y - topY);
        const maxR = Math.min(wp.node.w, wp.node.h) * 0.4;
        const newR = Math.max(0, Math.min(maxR, Math.round(dist)));
        engine.dispatch({ type: "patch", id: d.id, patch: { cornerRadii: [newR, newR, newR, newR] } });
      }
    } else if ((d.mode === "starCount" || d.mode === "polyCount") && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const cx = wp.x + wp.node.w / 2;
        const cy = wp.y + wp.node.h / 2;
        const angle = Math.atan2(wpt.y - cy, wpt.x - cx) + Math.PI / 2;
        const normAngle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const count = Math.max(3, Math.min(60, Math.round((normAngle / (Math.PI * 2)) * 16) + 3));
        engine.dispatch({ type: "patch", id: d.id, patch: { count } });
      }
    } else if (d.mode === "radius" && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const ci = d.corner ?? 0;
        // Corner indices follow the stored order [tl, tr, bl, br], so the sign
        // of each edge comes from where that corner actually sits.
        const left = ci === 0 || ci === 2;
        const top = ci === 0 || ci === 1;
        const dx = left ? wpt.x - wp.x : wp.x + wp.node.w - wpt.x;
        const dy = top ? wpt.y - wp.y : wp.y + wp.node.h - wpt.y;
        const dist = Math.min(dx, dy);
        const maxR = Math.min(wp.node.w, wp.node.h) / 2;
        const newR = Math.max(0, Math.min(maxR, Math.round(dist)));
        if (e.altKey && !insideInstance(snap.pages[snap.page].root, d.id)) {
          const nextRadii: [number, number, number, number] = [...wp.node.cornerRadii];
          nextRadii[ci] = newR;
          engine.dispatch({
            type: "patch",
            id: d.id,
            patch: { cornerRadii: nextRadii, cornerIndependent: true },
          });
        } else {
          const nextRadii: [number, number, number, number] = [newR, newR, newR, newR];
          engine.dispatch({
            type: "patch",
            id: d.id,
            patch: { cornerRadii: nextRadii, cornerIndependent: false },
          });
        }
      }
    } else if (d.mode === "arc" && d.id) {
      const wpt = toWorld(e.clientX, e.clientY);
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp) {
        const cx = wp.x + wp.node.w / 2;
        const cy = wp.y + wp.node.h / 2;
        const curArc = wp.node.arcData ?? { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 };
        if (d.handle === "in") {
          const maxR = Math.min(wp.node.w, wp.node.h) / 2;
          const curR = Math.hypot(wpt.x - cx, wpt.y - cy);
          const ratio = Math.max(0, Math.min(0.95, curR / (maxR || 1)));
          engine.dispatch({
            type: "patch",
            id: d.id,
            patch: { arcData: { ...curArc, innerRadius: Math.round(ratio * 100) / 100 } },
          });
        } else {
          let ang = Math.atan2(wpt.y - cy, wpt.x - cx);
          if (ang < 0) ang += Math.PI * 2;
          if (e.shiftKey) ang = Math.round((ang * 180) / Math.PI / 15) * (Math.PI / 12);
          if (ang > Math.PI * 2 - 0.05) ang = Math.PI * 2;
          engine.dispatch({
            type: "patch",
            id: d.id,
            patch: { arcData: { ...curArc, endingAngle: ang } },
          });
        }
      }
    }
  };

  const onUp = (e: React.MouseEvent) => {
    dragIx.current = null;
    if (penDrag.current) {
      penDrag.current = null;
      return;
    }
    if (pencil.current) {
      const pts = pencil.current;
      pencil.current = null;
      if (pts.length >= 2) {
        // Raw pointer samples are dense and jagged: thin them with RDP, then
        // fit bezier handles so the stroke reads as a smooth curve. Tolerance
        // is in world units so it is consistent at any zoom.
        const tol = PENCIL_TOLERANCE_PX / snap.zoom;
        const thinned = simplifyPath(pts, tol);
        const smoothed = snap.tool === "pencil" ? smoothPath(thinned, false) : thinned;
        engine.dispatch({ type: "addPath", points: smoothed, closed: false });
      }
      setDraft([]);
      return;
    }
    const d = drag.current;
    drag.current = null;
    setBand(null);
    setGuides([]);
    setGapBadges([]);
    if (!d) return;
    if (d.mode === "protoConnect" && d.id) {
      if (protoDrag?.targetId) {
        const root = snap.pages[snap.page].root;
        const srcNode = find(root, d.id);
        const targetNode = find(root, protoDrag.targetId);
        if (srcNode && targetNode) {
          const prev = srcNode.interactions ?? [];
          engine.dispatch({
            type: "setInteractions",
            id: d.id,
            interactions: [
              ...prev,
              {
                trigger: "onClick",
                action: "navigate",
                destination: protoDrag.targetId,
                animation: "instant",
                delay: 0,
              },
            ],
          });
          // Auto-set flow starting point on first connection (parity)
          const currentPage = snap.pages[snap.page];
          if (!currentPage.flowStart) {
            let startFrame: XNode | null = srcNode.kind === "frame" ? srcNode : findParent(root, srcNode.id);
            while (startFrame && startFrame.kind !== "frame" && startFrame !== root) {
              startFrame = findParent(root, startFrame.id);
            }
            const flowId = startFrame && startFrame !== root ? startFrame.id : (srcNode.kind === "frame" ? srcNode.id : targetNode.id);
            if (flowId) {
              engine.dispatch({ type: "patchPage", patch: { flowStart: flowId } });
            }
          }
          toast(`Connected to ${targetNode.name}`);
        }
      }
      setProtoDrag(null);
      return;
    }
    if (d.mode === "autoPad" && d.id && d.padEdge && !d.moved) {
      // The handle was clicked, not dragged: open a field to type the value
      // into, as the article describes. ⌥ and ⌥⇧ were captured on the way down
      // and decide whether the opposite side, or all four, follow.
      const wp = worldPos(snap.pages[snap.page].root, d.id);
      if (wp?.node.layout) {
        const [pl, pr, pt, pb] = wp.node.layout.padding;
        const cur = d.padEdge === "top" ? pt : d.padEdge === "bottom" ? pb : d.padEdge === "left" ? pl : pr;
        const z = snap.zoom;
        const sx = wp.x * z + snap.panX;
        const sy = wp.y * z + snap.panY;
        setPadInput({
          id: d.id,
          edge: d.padEdge,
          value: cur,
          left: d.padEdge === "left" ? sx : d.padEdge === "right" ? sx + wp.node.w * z : sx + (wp.node.w * z) / 2,
          top: d.padEdge === "top" ? sy : d.padEdge === "bottom" ? sy + wp.node.h * z : sy + (wp.node.h * z) / 2,
          opp: !!d.padOpp,
          all: !!d.padAll,
        });
      }
    }
    // Pixel-grid settling runs before `end` so it joins the gesture's undo
    // step: moves land on whole pixels, resizes additionally whole their
    // sizes. Frames and main components always settle, even with snapping off.
    if (d.mode === "move" || d.mode === "resize" || d.mode === "multiResize") {
      const on = snap.pages[snap.page].pixelSnap ?? true;
      const root = snap.pages[snap.page].root;
      for (const id of engine.snapshot().selection) {
        const n = worldPos(root, id)?.node;
        if (!n || n.locked || !wantsPixelSnap(n, on)) continue;
        if (d.mode === "move") {
          const x = Math.round(n.x);
          const y = Math.round(n.y);
          if (x !== n.x || y !== n.y) engine.dispatch({ type: "patch", id, patch: { x, y } });
        } else {
          const b = roundBox(n);
          if (b.x !== n.x || b.y !== n.y || b.w !== n.w || b.h !== n.h)
            engine.dispatch({ type: "patch", id, patch: b });
        }
      }
    }
    if (
      d.mode === "move" ||
      d.mode === "resize" ||
      d.mode === "vec" ||
      d.mode === "grad" ||
      d.mode === "multiResize" ||
      d.mode === "multiRotate" ||
      d.mode === "rotOrigin" ||
      d.mode === "autoPad" ||
      d.mode === "autoGap" ||
      (d.mode === "marquee" && d.id === "erase")
    )
      engine.dispatch({ type: "end" });
    if (d.mode === "move") {
      const selection = engine.snapshot().selection;
      const sel = selection[0];
      const root = snap.pages[snap.page].root;
      const wp = sel ? worldPos(root, sel) : null;
      if (wp) {
        const cx = wp.x + wp.node.w / 2;
        const cy = wp.y + wp.node.h / 2;
        const frame = deepestFrame(root, cx, cy, new Set(selection));
        if (frame) {
          const frameWorld = worldPos(root, frame.id);
          for (const id of selection) {
            const item = worldPos(root, id);
            const parent = findParent(root, id);
            if (!item || item.node.id === frame.id || frame === parent || !frameWorld) continue;
            engine.dispatch({
              type: "reparent",
              ids: [item.node.id],
              parent: frame.id,
              x: item.x - frameWorld.x,
              y: item.y - frameWorld.y,
            });
          }
        }
      }
    }
    if (d.mode === "create") {
      const a = toWorld(d.sx, d.sy);
      const b = toWorld(e.clientX, e.clientY);
      const clicked = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4;
      if (d.zoom) {
        const cur = engine.snapshot().zoom;
        if (clicked || Math.abs(b.x - a.x) < 6 || Math.abs(b.y - a.y) < 6) {
          const factor = e.altKey ? 1 / 1.5 : 1.5;
          zoomAtPoint(engine, cur * factor, e.clientX, e.clientY);
        } else {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          zoomToRect(engine, { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
        }
        return;
      }
      let w = Math.abs(b.x - a.x);
      let h = Math.abs(b.y - a.y);
      let x = Math.min(a.x, b.x);
      let y = Math.min(a.y, b.y);
      const k = kindOf(snap.tool);
      if (!k) return;
      const shift = e.shiftKey;
      const alt = e.altKey;
      let rot = 0;
      if (clicked) {
        if (k === "text") {
          w = 24;
          h = 24;
        } else if (k === "line" || k === "arrow") {
          w = 100;
          h = 1;
        } else {
          w = 100;
          h = 100;
        }
        x = a.x;
        y = a.y;
      } else if (k === "line" || k === "arrow") {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        let ang = Math.atan2(dy, dx);
        if (shift) ang = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.max(1, Math.hypot(dx, dy));
        w = len;
        h = 1;
        const mx = a.x + Math.cos(ang) * (len / 2);
        const my = a.y + Math.sin(ang) * (len / 2);
        x = mx - w / 2;
        y = my - h / 2;
        rot = (ang * 180) / Math.PI;
      } else {
        if (shift) {
          const s = Math.max(w, h, 1);
          w = s;
          h = s;
        }
        if (alt) {
          x = a.x - w;
          y = a.y - h;
          w *= 2;
          h *= 2;
        }
      }
      if (k === "text" && !clicked) {
        w = Math.max(w, 8);
        h = Math.max(h, 8);
      } else if (k !== "line" && k !== "arrow" && k !== "text") {
        w = Math.max(w, 1);
        h = Math.max(h, 1);
      }
      const root = snap.pages[snap.page].root;
      const host = deepestFrame(root, x + w / 2, y + h / 2);
      let nodeX = x;
      let nodeY = y;
      let nodeW = w;
      let nodeH = h;
      let nodeRotation = rot;
      if (host) {
        const la = worldToLocal(root, host.id, a.x, a.y);
        const lb = worldToLocal(root, host.id, b.x, b.y);
        if (k === "line" || k === "arrow") {
          const dx = lb.x - la.x;
          const dy = lb.y - la.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          const ang = Math.atan2(dy, dx);
          nodeW = len;
          nodeH = 1;
          nodeX = (la.x + lb.x) / 2 - len / 2;
          nodeY = (la.y + lb.y) / 2 - 0.5;
          nodeRotation = (ang * 180) / Math.PI;
        } else if (clicked) {
          nodeX = la.x;
          nodeY = la.y;
        } else {
          nodeW = Math.max(1, Math.abs(lb.x - la.x));
          nodeH = Math.max(1, Math.abs(lb.y - la.y));
          if (shift) {
            const side = Math.max(nodeW, nodeH);
            nodeW = side;
            nodeH = side;
          }
          if (alt) {
            nodeX = la.x - nodeW;
            nodeY = la.y - nodeH;
            nodeW *= 2;
            nodeH *= 2;
          } else {
            nodeX = Math.min(la.x, lb.x);
            nodeY = Math.min(la.y, lb.y);
          }
        }
      }
      // Click-placed top-level frames reuse the last top-level size; nested
      // clicks stay 100x100.
      if (clicked && k === "frame" && !host && snap.lastFrameSize) {
        nodeW = snap.lastFrameSize.w;
        nodeH = snap.lastFrameSize.h;
      }
      const extra: Partial<XNode> =
        snap.tool === "section"
          ? { name: "Section", fill: "#00000000", overflow: "visible" }
          : snap.tool === "slice"
            ? {
                name: "Slice",
                fill: "#00000000",
                fillVisible: false,
                strokePaint: BRAND_ACCENT,
                strokeVisible: true,
                strokeWidth: 1,
                strokeDash: 4,
              }
          : k === "text"
            ? clicked
              ? { text: "", sizingW: "hug", sizingH: "hug", fontSize: 16 }
              : { text: "", sizingW: "fixed", sizingH: "hug", fontSize: 16 }
            : k === "line" || k === "arrow"
              ? { rotation: nodeRotation }
              : {};
      // Placed layers settle on whole pixels, like moved and resized ones.
      if (wantsPixelSnap({ kind: k, isComponent: false }, snap.pages[snap.page].pixelSnap ?? true)) {
        const b = roundBox({ x: nodeX, y: nodeY, w: nodeW, h: nodeH });
        nodeX = b.x;
        nodeY = b.y;
        nodeW = b.w;
        nodeH = b.h;
      }
      engine.dispatch({
        type: "add",
        kind: k,
        x: nodeX,
        y: nodeY,
        w: nodeW,
        h: nodeH,
        parent: host?.id,
        extra,
      });
      if (k === "text") {
        const id = engine.snapshot().selection[0];
        if (id) setEdit({ id, text: "" });
      }
      // Drops back to the move tool after a shape is committed, so the
      // next drag manipulates what you just drew instead of stamping another
      // copy. Slice is the documented exception: it stays armed for repeat cuts.
      if (snap.tool !== "slice") engine.dispatch({ type: "setTool", tool: "select" });
    }
    if (d.mode === "marquee" && d.id === "erase") return;
    if (d.mode === "marquee") {
      const a = toWorld(d.sx, d.sy);
      const b = toWorld(e.clientX, e.clientY);
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const x1 = Math.max(a.x, b.x);
      const y1 = Math.max(a.y, b.y);
      const isDrag = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 4;

      if (vecEdit) {
        const wp = worldPos(snap.pages[snap.page].root, vecEdit);
        if (wp) {
          const pts = wp.node.path.length ? wp.node.path : shapePoly(wp.node);
          if (isDrag) {
            const hitIndices: number[] = [];
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i];
              const wx = wp.x + p.x;
              const wy = wp.y + p.y;
              if (wx >= x0 && wx <= x1 && wy >= y0 && wy <= y1) {
                hitIndices.push(i);
              }
            }
            const shift = e.shiftKey;
            const prev = snap.vecPoints ?? (vecPt.current >= 0 ? [vecPt.current] : []);
            const finalIndices = shift ? Array.from(new Set([...prev, ...hitIndices])) : hitIndices;
            vecPt.current = finalIndices.length ? finalIndices[0] : -1;
            setVecEdit(vecEdit, finalIndices.length ? finalIndices[0] : null, finalIndices);
          } else {
            vecPt.current = -1;
            setVecEdit(vecEdit, null, []);
          }
          return;
        }
      }

      const ids: string[] = [];
      const deep = e.metaKey || e.ctrlKey;
      const visit = (n: XNode, px: number, py: number, top: boolean) => {
        const x = px + n.x;
        const y = py + n.y;
        if (n !== snap.pages[snap.page].root && n.visible && !n.locked) {
          const hit = x + n.w >= x0 && y + n.h >= y0 && x <= x1 && y <= y1;
          if (hit && (deep || top)) ids.push(n.id);
        }
        const nest = deep || n === snap.pages[snap.page].root;
        if (nest) for (const c of n.children) visit(c, x, y, n === snap.pages[snap.page].root);
      };
      visit(snap.pages[snap.page].root, 0, 0, false);
      // ⇧-marquee adds to the pre-drag selection instead of replacing it;
      // plain marquee still replaces.
      engine.dispatch({
        type: "select",
        ids: e.shiftKey ? Array.from(new Set([...(d.sel0 ?? []), ...ids])) : ids,
      });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/⌘ + wheel and trackpad pinch both zoom at the cursor: a pinch
      // stream tracks the fingers, a wheel notch is one fixed step, and line-
      // and page-mode wheels are converted to pixels first.
      const factor = wheelZoomFactor({ deltaY: e.deltaY, deltaMode: e.deltaMode, pinch: e.ctrlKey });
      const next = clampZoom(snap.zoom * factor);
      const box = wrap.current!.getBoundingClientRect();
      const cx = e.clientX - box.left;
      const cy = e.clientY - box.top;
      const wx = (cx - snap.panX) / snap.zoom;
      const wy = (cy - snap.panY) / snap.zoom;
      engine.dispatch({ type: "setZoom", zoom: next });
      engine.dispatch({ type: "setPan", x: cx - wx * next, y: cy - wy * next });
    } else if (e.shiftKey) {
      // ⇧ + wheel scrolls horizontally.
      const d = normalizeWheelDelta(e.deltaY || e.deltaX, e.deltaMode);
      engine.dispatch({ type: "pan", dx: -d, dy: 0 });
    } else {
      // Scrolling pans, and a line- or page-mode wheel pans as far as a pixel-
      // mode one so the canvas feels the same in every browser.
      engine.dispatch({
        type: "pan",
        dx: -normalizeWheelDelta(e.deltaX, e.deltaMode),
        dy: -normalizeWheelDelta(e.deltaY, e.deltaMode),
      });
    }
  };

  const onDbl = (e: React.MouseEvent) => {
    if ((snap.tool === "pen" || snap.tool === "pencil") && draft.length >= 2) {
      engine.dispatch({ type: "addPath", points: draft, closed: false });
      setDraft([]);
      setCloseHint(null);
      penBranch.current = null;
      return;
    }
    const wpt = toWorld(e.clientX, e.clientY);
    /* Double-clicking a bounding-box edge sets that axis's resizing, as the
     * guide's "From the canvas" table has it: hug contents on its own, or Fill
     * container with ⌥. This runs before the deep-select below, because the
     * edge of the selection is exactly where a double-click would otherwise
     * step into the layer. */
    const edgeHit = (() => {
      const id = snap.selection[0];
      if (!id || snap.selection.length > 1 || snap.tool !== "select") return null;
      const wp = worldPos(snap.pages[snap.page].root, id);
      if (!wp) return null;
      const z = snap.zoom;
      const x0 = wp.x * z + snap.panX;
      const y0 = wp.y * z + snap.panY;
      const w = wp.node.w * z;
      const h = wp.node.h * z;
      const px = wpt.x * z + snap.panX;
      const py = wpt.y * z + snap.panY;
      const near = 8;
      const withinX = px >= x0 - near && px <= x0 + w + near;
      const withinY = py >= y0 - near && py <= y0 + h + near;
      if (withinY && (Math.abs(px - x0) <= near || Math.abs(px - (x0 + w)) <= near)) {
        return { id, axis: "w" as const };
      }
      if (withinX && (Math.abs(py - y0) <= near || Math.abs(py - (y0 + h)) <= near)) {
        return { id, axis: "h" as const };
      }
      return null;
    })();
    if (edgeHit) {
      const root = snap.pages[snap.page].root;
      const node = worldPos(root, edgeHit.id)!.node;
      const fill = e.altKey;
      const width = edgeHit.axis === "w";
      if (fill && !findParent(root, edgeHit.id)?.layout) {
        // Fill container is only offered to a child of an auto layout frame:
        // there has to be something for the layer to fill.
        toast("Fill container needs an auto layout parent");
        return;
      }
      const want: "fill" | "hug" = fill ? "fill" : "hug";
      engine.dispatch({
        type: "patch",
        id: edgeHit.id,
        patch: width ? { sizingW: want } : { sizingH: want },
      });
      // On an auto layout frame the resizing also lives in the layout itself -
      // that is what the engine hangs on and what the panel reads - so the two
      // are kept in step rather than drifting apart.
      if (node.layout && !fill) {
        const horiz = node.layout.direction === "horizontal";
        const next = { ...node.layout };
        if (width) {
          if (horiz) next.sizing = "hug";
          else next.cross = "hug";
        } else if (horiz) next.cross = "hug";
        else next.sizing = "hug";
        engine.dispatch({ type: "autoLayout", id: edgeHit.id, layout: next });
      }
      return;
    }
    // Canvas frame-name inline rename: double-clicking the label above a
    // frame opens an input there.
    let frameLabelHit: XNode | null = null;
    {
      const root = snap.pages[snap.page].root;
      const r = wrap.current?.getBoundingClientRect();
      if (r) {
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const z = snap.zoom;
        let hitFrame: XNode | null = null;
        const walk = (n: XNode, parentIsFrame: boolean, px: number, py: number) => {
          const x = px + n.x;
          const y = py + n.y;
          if (n.kind === "frame" && n.showName !== false && !parentIsFrame) {
            const sx = snap.panX + x * z;
            const sy = snap.panY + y * z;
            const nameW = Math.max(40, n.name.length * 6.5);
            if (mx >= sx - 2 && mx <= sx + nameW + 10 && my >= sy - 18 && my <= sy - 2) {
              hitFrame = n;
            }
          }
          for (const c of n.children) walk(c, n.kind === "frame", x, y);
        };
        for (const ch of root.children) walk(ch, false, 0, 0);
        frameLabelHit = hitFrame;
      }
    }
    if (frameLabelHit) {
      const wp = worldPos(snap.pages[snap.page].root, (frameLabelHit as XNode).id);
      if (wp) {
        const sx = snap.panX + wp.x * snap.zoom;
        const sy = snap.panY + wp.y * snap.zoom;
        setFrameEdit({ id: (frameLabelHit as XNode).id, name: (frameLabelHit as XNode).name, x: sx, y: sy - 22 });
        engine.dispatch({ type: "select", ids: [(frameLabelHit as XNode).id] });
        return;
      }
    }
    const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y, { deep: true });
    if (hit?.kind === "text") setEdit({ id: hit.id, text: hit.text });
    else if (vecEdit && hit && hit.id === vecEdit && hit.path.length) {
      const loc = worldPos(snap.pages[snap.page].root, hit.id);
      if (loc) {
        const path = hit.path.map((pt) => ({ ...pt }));
        let best = -1;
        let bd = 8 / snap.zoom;
        for (let i = 0; i < path.length; i++) {
          const d = Math.hypot(wpt.x - (loc.x + path[i].x), wpt.y - (loc.y + path[i].y));
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        if (best >= 0) {
          const pt = path[best];
          const has = (pt.ox && pt.ox !== 0) || (pt.oy && pt.oy !== 0);
          if (has) {
            pt.ix = 0;
            pt.iy = 0;
            pt.ox = 0;
            pt.oy = 0;
          } else {
            pt.ox = 20;
            pt.oy = 0;
            pt.ix = -20;
            pt.iy = 0;
          }
          engine.dispatch({ type: "patchPath", id: hit.id, path, closed: hit.closed });
        }
      }
    } else if (
      hit &&
      (hit.kind === "vector" ||
        hit.kind === "boolean" ||
        hit.kind === "rect" ||
        hit.kind === "ellipse" ||
        hit.kind === "poly" ||
        hit.kind === "star" ||
        hit.kind === "line" ||
        hit.kind === "arrow")
    ) {
      engine.dispatch({ type: "select", ids: [hit.id] });
      if (hit.kind !== "vector") {
        engine.dispatch({ type: "flatten" });
        const newId = engine.snapshot().selection[0];
        setVecEdit(newId);
      } else {
        setVecEdit(hit.id);
      }
    } else if (hit && (hit.kind === "frame" || hit.kind === "group" || hit.kind === "boolean") && hit.children.length) {
      // Double-click drills one level: the child under the cursor if there
      // is one, else the first visible child, like the Enter key does.
      const root = snap.pages[snap.page].root;
      let pick: XNode | null = null;
      for (const c of hit.children) {
        if (!c.visible || c.locked) continue;
        const loc = worldPos(root, c.id);
        if (loc && wpt.x >= loc.x && wpt.x <= loc.x + c.w && wpt.y >= loc.y && wpt.y <= loc.y + c.h) {
          pick = c;
          break;
        }
      }
      const child = pick ?? hit.children.find((c) => c.visible && !c.locked) ?? hit.children[0];
      engine.dispatch({ type: "select", ids: [child.id] });
    } else if (hit) {
      engine.dispatch({ type: "select", ids: [hit.id] });
    } else if (vecEdit) {
      setVecEdit(null, null, []);
    }
  };

  const onLeave = (e: React.MouseEvent) => {
    onUp(e);
    hoverIx.current = "";
    setCursorPos(null);
  };

  /** SVG is a vector format, so it becomes editable layers rather than a flat
   *  image fill. Everything else is placed as an image as before. */
  const placeSvg = (file: File, at?: { x: number; y: number }) => {
    const reader = new FileReader();
    reader.onload = () => {
      let result;
      try {
        result = importSvg(String(reader.result));
      } catch {
        toast(`Could not read ${file.name}`);
        return;
      }
      placeNodes(result, file.name, at);
    };
    reader.readAsText(file);
  };

  /** Shared tail for every vector-ish import: place the produced nodes as one
   *  undo step and report what happened. */
  const placeNodes = (
    result: { nodes: ImportedNode[]; skipped: number },
    fileName: string,
    at?: { x: number; y: number },
    opts?: { centre?: boolean },
  ) => {
    if (!result.nodes.length) {
      toast(`Nothing importable in ${fileName}`);
      return;
    }
    const ox = at?.x ?? 80;
    const oy = at?.y ?? 80;
    const current = engine.snapshot();
    const root = current.pages[current.page].root;
    const host = deepestFrame(root, ox, oy);
    const origin = host ? worldToLocal(root, host.id, ox, oy) : { x: ox, y: oy };
    // An imported root carries the coordinates it had in its own file, so
    // placing it at `dx + n.x` puts the artwork wherever the source happened to
    // leave it. What lands on the target is the group's bounding box instead:
    // its top-left for a drop, its centre for a paste, which is standard drop behavior
    // a copy in the middle of the viewport. Several roots keep the arrangement
    // they were copied in rather than stacking on one point.
    const minX = Math.min(...result.nodes.map((n) => n.x));
    const minY = Math.min(...result.nodes.map((n) => n.y));
    const spanW = Math.max(...result.nodes.map((n) => n.x + Math.max(1, n.w))) - minX;
    const spanH = Math.max(...result.nodes.map((n) => n.y + Math.max(1, n.h))) - minY;
    const dx = -minX - (opts?.centre ? spanW / 2 : 0);
    const dy = -minY - (opts?.centre ? spanH / 2 : 0);
    engine.dispatch({ type: "begin" });
    // Containers come with their children - a .fig frame arrives holding what
    // was inside it - so the insert walks the tree. A child's coordinates are
    // relative to its parent, and only the outermost layers are moved to where
    // the file was dropped.
    let placed = 0;
    const insert = (n: ImportedNode, parent: string | undefined, dx: number, dy: number) => {
      const { kind, name, x, y, w, h, children, ...rest } = n;
      // Spreading an explicit `undefined` overwrites the node factory's
      // default (cornerRadii became undefined and crashed the inspector), so
      // unset optional fields must be dropped rather than passed through.
      for (const k of Object.keys(rest) as (keyof typeof rest)[]) {
        if (rest[k] === undefined) delete rest[k];
      }
      engine.dispatch({
        type: "add",
        kind,
        x: dx + x,
        y: dy + y,
        w: Math.max(1, w),
        h: Math.max(1, h),
        parent,
        extra: { name, ...rest } as Partial<XNode>,
      });
      placed++;
      const id = engine.snapshot().selection[0];
      for (const c of children ?? []) insert(c, id, 0, 0);
    };
    for (const n of result.nodes) insert(n, host?.id, origin.x + dx, origin.y + dy);
    engine.dispatch({ type: "end" });
    toast(
      result.skipped
        ? `Imported ${placed} layers · ${result.skipped} unsupported skipped`
        : `Imported ${placed} layers`,
    );
  };

  const placeSketch = (file: File, at?: { x: number; y: number }) => {
    file
      .arrayBuffer()
      .then((buf) => importSketch(buf))
      .then((result) => placeNodes(result, file.name, at))
      .catch((err: unknown) => {
        toast(`Could not read ${file.name}: ${err instanceof Error ? err.message : "unreadable"}`);
      });
  };

  const placeFig = (file: File, at?: { x: number; y: number }) => {
    file
      .arrayBuffer()
      .then((buf) => importFig(buf))
      .then((result) => placeNodes(result, file.name, at))
      .catch((err: unknown) => {
        toast(`Could not read ${file.name}: ${err instanceof Error ? err.message : "unreadable"}`);
      });
  };

  const placeFiles = (files: FileList | File[], at?: { x: number; y: number }) => {
    const all = Array.from(files);
    for (const f of all) {
      if (f.type === "image/svg+xml" || /\.svg$/i.test(f.name)) placeSvg(f, at);
      else if (/\.sketch$/i.test(f.name)) placeSketch(f, at);
      else if (/\.fig$/i.test(f.name)) placeFig(f, at);
    }
    const list = all.filter(
      (f) => f.type.startsWith("image/") && f.type !== "image/svg+xml" && !/\.svg$/i.test(f.name),
    );
    let ox = at?.x ?? 80;
    let oy = at?.y ?? 80;
    list.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result);
        // Written to the asset store now, not at the next save: the document
        // will only ever hold a reference to it.
        rememberImage(src);
        const im = new Image();
        im.onload = () => {
          const w = im.naturalWidth;
          const h = im.naturalHeight;
          const max = 480;
          const s = Math.min(1, max / Math.max(w, h));
          const current = engine.snapshot();
          const root = current.pages[current.page].root;
          const host = deepestFrame(root, ox, oy);
          const local = host ? worldToLocal(root, host.id, ox, oy) : { x: ox, y: oy };
          engine.dispatch({
            type: "add",
            kind: "rect",
            x: local.x,
            y: local.y,
            w: Math.max(8, w * s),
            h: Math.max(8, h * s),
            parent: host?.id,
            extra: {
              imageSrc: src,
              fillType: "image",
              imageFit: "fill",
              name: file.name.replace(/\.[^.]+$/, ""),
              fill: "#00000000",
              fillVisible: true,
            },
          });
          ox += 24;
          oy += 24;
        };
        im.src = src;
      };
      reader.readAsDataURL(file);
    });
  };

  /* ------------------------------------------------------- system clipboard */

  /** The world point under the middle of the viewport. A paste lands there, the
   *  so a layer copied from somewhere off-screen still
   *  arrives where the user is looking. */
  const viewCentre = () => {
    const r = wrap.current?.getBoundingClientRect();
    return r ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 };
  };

  /**
   * Put whatever the system clipboard holds onto the canvas.
   *
   * The ladder that decides *what* is on the clipboard lives in
   * `engine/clipboard.ts`; this is the half that needs a document — resolving
   * asset refs, picking the host frame, and saying what happened.
   *
   * Returns false only when the clipboard held nothing this app can read, which
   * is the caller's cue to fall back to the in-app clipboard: a denied
   * permission, or a browser that will not expose the clipboard, must not break
   * ⌘V for a copy made a moment ago in this very document.
   */
  const placeClipboard = async (
    payload: ClipPayload,
    at?: { x: number; y: number },
    inPlace = false,
  ): Promise<boolean> => {
    const target = at ?? viewCentre();
    switch (payload.kind) {
      case "none":
        return false;
      case "native": {
        // Refs are resolved before the nodes reach the engine: a copy from
        // another tab names images this session may never have loaded, and a
        // node that arrives still holding `asset:…` paints nothing.
        const missing = await hydrateNodes(payload.nodes);
        engine.dispatch({ type: "loadClip", nodes: payload.nodes });
        engine.dispatch({ type: "paste", x: target.x, y: target.y, inPlace });
        if (missing) toast(`${missing} image${missing > 1 ? "s" : ""} could not be loaded`);
        return true;
      }
      case "figma": {
        // The buffer is an imported scene, so it goes through the same reader
        // as a dropped archive and arrives as editable layers.
        toast("Pasting imported scene…");
        try {
          placeNodes(await importFigContainer(payload.buffer), "the imported clipboard", target, { centre: true });
        } catch (err) {
          toast(`Could not read clipboard data: ${err instanceof Error ? err.message : "unreadable"}`);
        }
        return true;
      }
      case "svg": {
        try {
          placeNodes(importSvg(payload.text), "the clipboard's SVG", target, { centre: true });
        } catch {
          toast("Could not read the SVG on the clipboard");
        }
        return true;
      }
      case "files":
        // A screenshot, an image, or a design file copied in the file manager:
        // the same routing as a drop on the canvas.
        placeFiles(payload.files, target);
        return true;
      case "text": {
        const text = payload.text.replace(/\r\n?/g, "\n");
        const current = engine.snapshot();
        const root = current.pages[current.page].root;
        const host = deepestFrame(root, target.x, target.y);
        const local = host ? worldToLocal(root, host.id, target.x, target.y) : target;
        engine.dispatch({
          type: "add",
          kind: "text",
          x: local.x,
          y: local.y,
          w: 100,
          h: 24,
          parent: host?.id,
          // The hug sizing the text tool gives a click, so the box grows to the
          // words instead of clipping them.
          extra: { text, sizingW: "hug", sizingH: "hug", fontSize: 16 },
        });
        toast("Pasted text");
        return true;
      }
    }
  };

  /** ⌘V. The keydown handler in `chrome.tsx` deliberately lets the keystroke
   *  through so the browser fires this event — `preventDefault()` on the key
   *  would suppress it, and with it any chance of seeing the system clipboard.
   *  The modifiers are not on a ClipboardEvent, so the keydown leaves them here. */
  const onPasteEvent = (e: ClipboardEvent) => {
    // Tells the key binding the browser did answer ⌘V, so its own fallback
    // stands down instead of pasting a second time.
    markPasteEvent();
    const t = e.target as HTMLElement | null;
    // A field keeps its own paste: renaming a layer or editing text must insert
    // the characters, not a rectangle on the canvas.
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (engine.snapshot().presentFrame) return;
    e.preventDefault();
    const inPlace = pasteInPlace();
    void placeClipboard(parseClipboard(e.clipboardData)).then((handled) => {
      // Nothing readable on the system clipboard: the copy made inside this
      // document still pastes, which is what ⌘V did before this existed.
      if (!handled) engine.dispatch({ type: "paste", inPlace });
    });
  };

  /* The handlers above close over the current document, viewport and tool, so
   * the listener is bound once and forwarded to whichever closure is live:
   * binding the effect to them would re-add and remove the listener on every
   * frame of a drag. */
  const pasteHandler = useRef(onPasteEvent);
  pasteHandler.current = onPasteEvent;

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => pasteHandler.current(e);
    window.addEventListener("paste", onPaste);
    // The context menu's Paste has no keystroke to ride, so it asks for the
    // system clipboard through the async API instead. That needs a permission
    // the event path does not, so a refusal falls back to the in-app clipboard
    // rather than reporting an error for a routine menu click.
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent<{ x?: number; y?: number; inPlace?: boolean }>).detail ?? {};
      const at = d.x != null && d.y != null ? { x: d.x, y: d.y } : undefined;
      void readSystemClipboard().then((src) =>
        placeClipboard(parseClipboard(src), at, !!d.inPlace).then((handled) => {
          if (!handled) engine.dispatch({ type: "paste", x: d.x, y: d.y, inPlace: d.inPlace });
        }),
      );
    };
    window.addEventListener("x-native-paste", onRequest);
    // ⇧B in vector-edit mode arms the Paint bucket; the subtool state lives
    // here, so the chrome shortcut asks through an event.
    const onSubTool = (e: Event) => {
      if ((e as CustomEvent<string>).detail === "paint" && engine.snapshot().vecEdit) {
        setVecSubTool("paint");
        toast("Paint bucket: fill region / face");
      }
    };
    window.addEventListener("x-native-vec-subtool", onSubTool);
    // Hovering a Layers-panel row outlines the layer on the canvas.
    const onPanelHover = (e: Event) => {
      setPanelHover((e as CustomEvent<string | null>).detail ?? "");
    };
    window.addEventListener("x-panel-hover", onPanelHover);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("x-native-paste", onRequest);
      window.removeEventListener("x-native-vec-subtool", onSubTool);
      window.removeEventListener("x-panel-hover", onPanelHover);
    };
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const cursor =
    snap.tool === "hand" || space.current
      ? "grab"
      : snap.tool === "zoom"
        ? zoomOutCursor
          ? "zoom-out"
          : "zoom-in"
      : snap.tool === "scale"
        ? "nwse-resize"
        : CREATE.includes(snap.tool) || snap.tool === "pen" || snap.tool === "pencil" || snap.tool === "brush"
          ? "crosshair"
          : snap.tool === "select" && hoverCursor
            ? hoverCursor
            : "default";

  /* A textarea focused in code lands with its caret at position zero, so the
   * first keystroke would be inserted before the copy. Put it after the copy,
   * which is where clicking into the layer leaves it. */
  useEffect(() => {
    if (!edit) return;
    const el = editRef.current;
    if (!el) return;
    const at = el.value.length;
    el.setSelectionRange(at, at);
  }, [edit?.id]);

  const editBox = (() => {
    if (!edit) return null;
    const wp = worldPos(snap.pages[snap.page].root, edit.id);
    if (!wp) return null;
    const measure = ref.current?.getContext("2d");
    let textW = wp.node.w;
    let textH = wp.node.h;
    if (measure && (wp.node.sizingW === "hug" || wp.node.sizingH === "hug")) {
      const m = textMetrics(measure, wp.node, edit.text);
      textW = Math.max(wp.node.w, m.maxW + 4);
      textH = Math.max(wp.node.h, m.lines * (wp.node.lineHeight || wp.node.fontSize * 1.2));
    }
    const gutter = listGutter(measure ?? null, wp.node);
    return {
      left: snap.panX + wp.x * snap.zoom,
      top: snap.panY + wp.y * snap.zoom,
      width: textW * snap.zoom,
      height: textH * snap.zoom,
      fontSize: wp.node.fontSize * snap.zoom,
      fontWeight: wp.node.fontWeight,
      lineHeight: `${(wp.node.lineHeight || wp.node.fontSize * 1.2) * snap.zoom}px`,
      letterSpacing: `${wp.node.letterSpacing * snap.zoom}px`,
      textAlign: wp.node.textAlign === "justified" ? "left" : wp.node.textAlign,
      color: wp.node.fill,
      fontFamily: wp.node.fontFamily,
      transform: wp.node.rotation ? `rotate(${wp.node.rotation}deg)` : undefined,
      transformOrigin: "center center",
      // The overlay is a real textarea, so the wrap style is handed to the
      // browser's own text-wrap - the standard editor rule.
      ...((wp.node.textWrap === "balance" || wp.node.textWrap === "pretty") ? { textWrap: wp.node.textWrap } : {}),
      ...(gutter ? { paddingLeft: Math.round(gutter * snap.zoom) } : {}),
    } as CSSProperties;
  })();

  return (
    <div
      className="canvas-wrap"
      ref={wrap}
      style={{ cursor }}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onLeave}
      onDoubleClick={onDbl}
      onWheel={onWheel}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const wpt = toWorld(e.clientX, e.clientY);
        if (e.dataTransfer.files?.length) placeFiles(e.dataTransfer.files, wpt);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const wpt = toWorld(e.clientX, e.clientY);
        const hit = hitTest(snap.pages[snap.page].root, wpt.x, wpt.y);
        if (hit && !snap.selection.includes(hit.id)) {
          engine.dispatch({ type: "select", ids: [hit.id] });
        }
        if (!hit) engine.dispatch({ type: "select", ids: [] });
        setMenu({ x: e.clientX, y: e.clientY, wx: wpt.x, wy: wpt.y });
      }}
    >
      <canvas ref={ref} role="img" aria-label="Design canvas" />
      {(snap.showComments || snap.tool === "comment") && (
        <Comments
          threads={snap.pages[snap.page].comments}
          engine={engine}
          zoom={snap.zoom}
          panX={snap.panX}
          panY={snap.panY}
          openId={snap.openComment}
          draft={draftComment}
          onDraftDone={() => setDraftComment(null)}
        />
      )}
      {snap.showRulers && (
        <Guides
          guides={snap.pages[snap.page].guides}
          engine={engine}
          zoom={snap.zoom}
          panX={snap.panX}
          panY={snap.panY}
          width={box.w}
          height={box.h}
        />
      )}
      {snap.showRulers && (
        <Rulers
          zoom={snap.zoom}
          panX={snap.panX}
          panY={snap.panY}
          width={box.w}
          height={box.h}
          theme={theme}
          selection={selectionBounds(snap.pages[snap.page].root, snap.selection)}
        />
      )}
      {snap.showMinimap && !snap.presentFrame && (
        <Minimap
          root={snap.pages[snap.page].root}
          engine={engine}
          zoom={snap.zoom}
          panX={snap.panX}
          panY={snap.panY}
          viewW={box.w}
          viewH={box.h}
          theme={theme}
        />
      )}
      {transition && <div className={`proto-transition ${transition}`} aria-hidden="true" />}
      {edit && editBox && (
        <textarea
          className="text-edit"
          ref={editRef}
          style={editBox}
          value={edit.text}
          autoFocus
          onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          onBlur={() => {
            const n = worldPos(snap.pages[snap.page].root, edit.id)?.node;
            const patch: Partial<XNode> = { text: edit.text };
            if (n && (n.sizingW === "hug" || n.sizingH === "hug"))
              Object.assign(patch, hugSize(n, edit.text));
            engine.dispatch({ type: "patch", id: edit.id, patch });
            setEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter"))
              (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      )}
      {frameEdit && (
        <div className="frame-name-edit" style={{ left: frameEdit.x, top: frameEdit.y, position: "absolute" }}>
          <input
            autoFocus
            value={frameEdit.name}
            onChange={(e) => setFrameEdit({ ...frameEdit, name: e.target.value })}
            onBlur={() => {
              const v = frameEdit.name.trim() || "Frame";
              engine.dispatch({ type: "patch", id: frameEdit.id, patch: { name: v } });
              setFrameEdit(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setFrameEdit(null);
              e.stopPropagation();
            }}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              font: "600 11px Inter, system-ui",
              padding: "2px 6px",
              border: "1px solid var(--accent, #10b981)",
              borderRadius: 4,
              background: "#ffffff",
              color: "#0f172a",
              minWidth: 80,
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        </div>
      )}
      {padInput && (
        /* On-canvas padding entry: one field, floated over the handle it
           came from. The label says whether it is setting one side, the
           opposite side, or all four. */
        <div className="pad-input" style={{ left: padInput.left, top: padInput.top }}>
          <span className="pad-input-what">
            {padInput.all
              ? "All sides"
              : padInput.opp
                ? "Opposite sides"
                : padInput.edge[0].toUpperCase() + padInput.edge.slice(1)}
          </span>
          <input
            autoFocus
            defaultValue={String(Math.round(padInput.value * 100) / 100)}
            aria-label="Padding value"
            onFocus={(e) => e.target.select()}
            onBlur={() => setPadInput(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setPadInput(null);
                return;
              }
              if (e.key !== "Enter") return;
              const v = Math.max(0, parseFloat((e.target as HTMLInputElement).value));
              const wp = worldPos(snap.pages[snap.page].root, padInput.id);
              if (wp?.node.layout && Number.isFinite(v)) {
                const p = [...wp.node.layout.padding] as [number, number, number, number];
                const i = padInput.edge === "left" ? 0 : padInput.edge === "right" ? 1 : padInput.edge === "top" ? 2 : 3;
                const opposite = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? 3 : 2;
                p[i] = v;
                if (padInput.opp || padInput.all) p[opposite] = v;
                if (padInput.all) p[0] = p[1] = p[2] = p[3] = v;
                engine.dispatch({ type: "autoLayout", id: padInput.id, layout: { ...wp.node.layout, padding: p } });
              }
              setPadInput(null);
            }}
          />
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg,.sketch,.fig,image/*"
        hidden
        onChange={(e) => {
          if (e.target.files) placeFiles(e.target.files, pendingImage.current ?? undefined);
          pendingImage.current = null;
          e.target.value = "";
        }}
      />
      {snap.pages[snap.page].root.children.length === 0 &&
        !draft.length &&
        snap.tool === "select" &&
        !edit &&
        !snap.presentFrame && (
        <div className="canvas-start">
          <div className="canvas-start-card">
            <b>Nothing on this page yet</b>
            <p>
              Press <kbd>F</kbd> for a frame, <kbd>R</kbd> for a rectangle, <kbd>T</kbd> for text — or{" "}
              <kbd>⌘</kbd>
              <kbd>K</kbd> to search every command.
            </p>
            <span>
              Every shortcut in the app is listed under <kbd>⌥</kbd>
              <kbd>⇧</kbd>
              <kbd>?</kbd>.
            </span>
          </div>
        </div>
      )}
      {snap.tool === "zoom" && !snap.presentFrame && (
        <div className="canvas-hud">
          <span>Zoom tool</span>
          <span>
            click <b>in</b> · ⌥ click <b>out</b> · drag to fit an area
          </span>
          <b>{Math.round(snap.zoom * 100)}%</b>
        </div>
      )}
      {selectedConn && snap.rightTab === "prototype" && !snap.presentFrame && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            left: snap.panX + selectedConn.midX * snap.zoom,
            top: snap.panY + selectedConn.midY * snap.zoom,
            transform: "translate(-50%, -50%)",
            background: "#18181b",
            color: "#ffffff",
            padding: "5px 10px",
            borderRadius: 14,
            fontSize: 11,
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 8,
            boxShadow: `0 4px 16px rgba(0,0,0,0.5), 0 0 0 1.5px ${BRAND_ACCENT}`,
            zIndex: 35,
            userSelect: "none",
          }}
        >
          <span>{selectedConn.label}</span>
          <button
            onClick={() => {
              engine.dispatch({
                type: "deleteInteraction",
                id: selectedConn.srcId,
                destId: selectedConn.destId,
              });
              setSelectedConn(null);
              toast("Connection deleted");
            }}
            title="Delete connection (⌫)"
            style={{
              background: "transparent",
              border: 0,
              color: "rgba(255,255,255,0.7)",
              cursor: "pointer",
              padding: 0,
              display: "flex",
              alignItems: "center",
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {snap.selection.length >= 1 &&
        !drag.current &&
        !edit &&
        !vecEdit &&
        !snap.presentFrame &&
        snap.tool === "select" && (() => {
          const root = snap.pages[snap.page].root;
          const wp = snap.selection.length === 1 ? worldPos(root, snap.selection[0]) : null;
          const bb = wp
            ? nodeVisualBounds(wp)
            : selectionBounds(root, snap.selection);
          if (!bb) return null;
          const node = wp?.node ?? null;
          const z = snap.zoom;
          const sw = bb.w * z;
          const sh = bb.h * z;
          const sx = snap.panX + bb.x * z;
          const sy = snap.panY + bb.y * z;
          const tx = sx + sw / 2 - 140;
          let ty = sy + sh + 28;
          if (ty > window.innerHeight - 70) ty = Math.max(12, sy - 44);
          return (
            <ContextToolbar
              x={tx}
              y={ty}
              node={node}
              multi={snap.selection.length > 1}
              onAutoLayout={() => {
                if (node?.layout) removeAutoLayout(engine, snap);
                else addAutoLayout(engine, snap);
              }}
              onAlign={(m) => align(engine, snap, m as any)}
              onGroup={() => engine.dispatch({ type: "group" })}
              onComponent={() => engine.dispatch({ type: "makeComponent" })}
              onDuplicate={() => engine.dispatch({ type: "duplicate" })}
              onDelete={() => engine.dispatch({ type: "delete" })}
              onFlipH={() => engine.dispatch({ type: "flip", axis: "h" })}
              onFlipV={() => engine.dispatch({ type: "flip", axis: "v" })}
            />
          );
        })()}
      {(vecEdit || snap.tool === "pen" || draft.length > 0) && !snap.presentFrame && (
        <div
          className="vector-edit-toolbar"
          style={{
            position: "absolute",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#18181b",
            borderRadius: 24,
            padding: "4px 8px",
            display: "flex",
            alignItems: "center",
            gap: 4,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px #27272a",
            zIndex: 40,
            userSelect: "none",
          }}
        >
          <button
            className={`tool-btn ${snap.tool === "select" && vecSubTool === "select" ? "on" : ""}`}
            style={{
              background: snap.tool === "select" && vecSubTool === "select" ? "rgba(255,255,255,0.12)" : "transparent",
              border: 0,
              color: snap.tool === "select" && vecSubTool === "select" ? "#ffffff" : "rgba(255,255,255,0.7)",
              padding: "6px 10px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 500,
            }}
            onClick={() => {
              if (draft.length >= 2) {
                engine.dispatch({ type: "addPath", points: draft, closed: false });
                setDraft([]);
                setCloseHint(null);
                penBranch.current = null;
              }
              setVecSubTool("select");
              engine.dispatch({ type: "setTool", tool: "select" });
            }}
            title="Move / Select (V)"
          >
            <Icon name="move" size={14} />
            <span>Select</span>
          </button>
          <button
            className={`tool-btn ${snap.tool === "pen" ? "on" : ""}`}
            style={{
              background: snap.tool === "pen" ? "rgba(255,255,255,0.12)" : "transparent",
              border: 0,
              color: snap.tool === "pen" ? "#ffffff" : "rgba(255,255,255,0.7)",
              padding: "6px 10px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 500,
            }}
            onClick={() => engine.dispatch({ type: "setTool", tool: "pen" })}
            title="Pen (P)"
          >
            <Icon name="pen" size={14} />
            <span>Pen</span>
          </button>
          <button
            className={`tool-btn ${vecSubTool === "bend" ? "on" : ""}`}
            style={{
              background: vecSubTool === "bend" ? "rgba(255,255,255,0.12)" : "transparent",
              border: 0,
              color: vecSubTool === "bend" ? "#ffffff" : "rgba(255,255,255,0.7)",
              padding: "6px 10px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 500,
            }}
            onClick={() => {
              setVecSubTool((t) => (t === "bend" ? "select" : "bend"));
              toast(vecSubTool === "bend" ? "Select mode" : "Bend tool active (drag segment to curve)");
            }}
            title="Bend Tool (⌥)"
          >
            <Icon name="bend" size={14} />
            <span>Bend</span>
          </button>
          <button
            className={`tool-btn ${vecSubTool === "paint" ? "on" : ""}`}
            style={{
              background: vecSubTool === "paint" ? "rgba(255,255,255,0.12)" : "transparent",
              border: 0,
              color: vecSubTool === "paint" ? "#ffffff" : "rgba(255,255,255,0.7)",
              padding: "6px 10px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 500,
            }}
            onClick={() => {
              setVecSubTool((t) => (t === "paint" ? "select" : "paint"));
              toast(vecSubTool === "paint" ? "Select mode" : "Paint bucket: fill region / face");
            }}
            title="Paint Bucket (B)"
          >
            <Icon name="paint" size={14} />
            <span>Paint</span>
          </button>
          <button
            className={`tool-btn ${vecSubTool === "shapeBuilder" ? "on" : ""}`}
            style={{
              background: vecSubTool === "shapeBuilder" ? "rgba(255,255,255,0.12)" : "transparent",
              border: 0,
              color: vecSubTool === "shapeBuilder" ? "#ffffff" : "rgba(255,255,255,0.7)",
              padding: "6px 10px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 500,
            }}
            onClick={() => {
              setVecSubTool((t) => (t === "shapeBuilder" ? "select" : "shapeBuilder"));
              toast(vecSubTool === "shapeBuilder" ? "Select mode" : "Shape Builder: drag to merge regions, ⌥-click to subtract");
            }}
            title="Shape Builder Tool"
          >
            <Icon name="shape-builder" size={14} />
            <span>Shape Builder</span>
          </button>
          <button
            className="tool-btn"
            style={{
              background: "transparent",
              border: 0,
              color: "rgba(255,255,255,0.7)",
              padding: "6px 8px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
            onClick={() => {
              if (vecEdit) {
                engine.dispatch({ type: "simplifyPath", id: vecEdit });
                toast("Simplified path");
              }
            }}
            title="Simplify path"
          >
            <Icon name="scissors" size={14} />
          </button>
          <button
            className="tool-btn"
            style={{
              background: "transparent",
              border: 0,
              color: "rgba(255,255,255,0.7)",
              padding: "6px 8px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            onClick={() => {
              if (vecEdit) {
                engine.dispatch({ type: "vectorCleanup", id: vecEdit });
                toast("Cleaned up vector (sketch to perfect Bézier)");
              }
            }}
            title="Clean up vector (sketch to perfect Bézier)"
          >
            <Icon name="visual-search" size={14} />
            <span style={{ fontSize: 11 }}>Clean up</span>
          </button>
          <button
            className="tool-btn"
            style={{
              background: "transparent",
              border: 0,
              color: "rgba(255,255,255,0.7)",
              padding: "6px 8px",
              borderRadius: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
            onClick={() => {
              if (draft.length > 0) {
                setDraft((d) => d.slice(0, -1));
                toast("Point deleted");
              } else if (vecPt.current != null && vecEdit) {
                const wp = worldPos(snap.pages[snap.page].root, vecEdit);
                if (wp && wp.node.path.length > 2) {
                  const newPath = wp.node.path.filter((_, i) => i !== vecPt.current);
                  engine.dispatch({ type: "patchPath", id: vecEdit, path: newPath, closed: wp.node.closed });
                  setVecEdit(vecEdit, null, []);
                  toast("Point deleted");
                }
              }
            }}
            title="Delete point (⌫)"
          >
            <Icon name="eraser" size={14} />
          </button>
          <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.15)", margin: "0 4px" }} />
          <button
            style={{
              background: "var(--accent)",
              border: 0,
              color: "#ffffff",
              padding: "5px 14px",
              borderRadius: 14,
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            onClick={() => {
              if (draft.length >= 2) {
                engine.dispatch({ type: "addPath", points: draft, closed: false });
                setDraft([]);
                setCloseHint(null);
                penBranch.current = null;
              } else if (draft.length < 2) {
                setDraft([]);
                setCloseHint(null);
                penBranch.current = null;
              }
              if (snap.tool === "pen") {
                engine.dispatch({ type: "setTool", tool: "select" });
              }
              setVecEdit(null);
            }}
            title="Done (Esc / ↵ / Double-click to finish)"
          >
            <Icon name="check" size={14} />
            Done
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={canvasMenu(
            snap.selection.length,
            isGroupNode(
              snap.selection[0]
                ? worldPos(snap.pages[snap.page].root, snap.selection[0])?.node
                : undefined,
            ),
            !!snap.selection[0] &&
              !!worldPos(snap.pages[snap.page].root, snap.selection[0])?.node.imageSrc,
            layersAt(snap.pages[snap.page].root, menu.wx, menu.wy),
            // Add auto layout / Remove auto layout are one entry or the other.
            // A child of an auto layout frame has a layout to remove too: its
            // parent's, which is what that entry takes away.
            hasLayout(snap),
          )}
          onRun={(id) => runMenu(engine, id, { x: menu.wx, y: menu.wy })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function paintNoise(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  density: number,
) {
  const d = Math.max(0, Math.min(1, density / 100));
  if (d <= 0 || sw < 1 || sh < 1) return;
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.35 * d;
  const count = Math.min(4000, Math.floor((sw * sh * d) / 18));
  const seed = Math.floor(sx * 13 + sy * 17);
  for (let i = 0; i < count; i++) {
    const h = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    const r = h - Math.floor(h);
    const h2 = Math.sin(seed * 4.1414 + i * 19.19) * 23421.631;
    const r2 = h2 - Math.floor(h2);
    ctx.fillRect(sx + r * sw, sy + r2 * sh, 1, 1);
  }
  ctx.restore();
}

function paintTexture(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  density = 16,
  scale = 4,
) {
  if (sw < 1 || sh < 1) return;
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#000000";
  ctx.globalAlpha = Math.max(0.04, Math.min(0.3, density / 100));
  const step = Math.max(2, Math.round(scale));
  for (let x = sx; x < sx + sw; x += step * 2) {
    for (let y = sy; y < sy + sh; y += step * 2) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
}

function unrot(px: number, py: number, cx: number, cy: number, deg: number) {
  const a = (-deg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

function nodeLocalPoint(px: number, py: number, x: number, y: number, n: XNode) {
  const cx = x + n.w / 2;
  const cy = y + n.h / 2;
  const p = n.rotation ? unrot(px, py, cx, cy, n.rotation) : { x: px, y: py };
  return {
    x: (n.flipH ? cx - (p.x - cx) : p.x) - x,
    y: (n.flipV ? cy - (p.y - cy) : p.y) - y,
  };
}

/** Axis-aligned world bounds enclosing every selected node. */
function selectionBounds(
  root: XNode,
  ids: string[],
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const wp = worldPos(root, id);
    if (!wp) continue;
    const b = nodeVisualBounds(wp);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/**
 * Resize cursor direction follows the handle *and* the
 * node's rotation, so a 90deg-rotated box still reads correctly. Handle order is
 * TL,T,TR,R,BR,B,BL,L (see `handles`); each sits 45deg apart, so rotating by the
 * node angle and snapping back to the nearest 45deg step picks the right glyph.
 */
const ROT_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none'%3E%3Cpath d='M21 12a9 9 0 1 1-3.2-6.9l2.2-2.1M20 3v6h-6' stroke='%23000' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' filter='drop-shadow(0 0 1.5px %23fff)'/%3E%3C/svg%3E\") 12 12, crosshair";

const RESIZE_CURSORS = [
  "nwse-resize", // TL
  "ns-resize", // T
  "nesw-resize", // TR
  "ew-resize", // R
  "nwse-resize", // BR
  "ns-resize", // B
  "nesw-resize", // BL
  "ew-resize", // L
];
function resizeCursor(handle: number, rotation = 0): string {
  const step = Math.round(rotation / 45);
  return RESIZE_CURSORS[(((handle + step) % 8) + 8) % 8];
}

function handles(sx: number, sy: number, sw: number, sh: number): [number, number][] {
  return [
    [sx, sy],
    [sx + sw / 2, sy],
    [sx + sw, sy],
    [sx + sw, sy + sh / 2],
    [sx + sw, sy + sh],
    [sx + sw / 2, sy + sh],
    [sx, sy + sh],
    [sx, sy + sh / 2],
  ];
}

function resizeFrom(
  o: { x: number; y: number; w: number; h: number },
  corner: number,
  bx: number,
  by: number,
  opts?: { aspect?: boolean; fromCenter?: boolean },
) {
  let { x, y, w, h } = o;
  const right = o.x + o.w;
  const bottom = o.y + o.h;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  // 0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w
  if (opts?.fromCenter) {
    if (corner === 0 || corner === 1 || corner === 2 || corner === 4 || corner === 5 || corner === 6) {
      h = Math.abs(by - cy) * 2;
      y = cy - h / 2;
    }
    if (corner === 0 || corner === 2 || corner === 3 || corner === 4 || corner === 6 || corner === 7) {
      w = Math.abs(bx - cx) * 2;
      x = cx - w / 2;
    }
  } else {
    if (corner === 0 || corner === 1 || corner === 2) {
      y = by;
      h = bottom - by;
    }
    if (corner === 4 || corner === 5 || corner === 6) {
      h = by - o.y;
    }
    if (corner === 0 || corner === 6 || corner === 7) {
      x = bx;
      w = right - bx;
    }
    if (corner === 2 || corner === 3 || corner === 4) {
      w = bx - o.x;
    }
  }
  if (opts?.aspect && o.w > 0 && o.h > 0) {
    const ratio = o.h / o.w;
    if (corner === 1 || corner === 5) {
      w = Math.max(1, h / ratio);
      if (opts.fromCenter) x = cx - w / 2;
      else x = cx - w / 2;
    } else {
      h = Math.max(1, w * ratio);
      if (opts.fromCenter) y = cy - h / 2;
      else if (corner === 0 || corner === 1 || corner === 2) y = bottom - h;
    }
  }
  if (w < 1) {
    x += w - 1;
    w = 1;
  }
  if (h < 1) {
    y += h - 1;
    h = 1;
  }
  return { x, y, w, h };
}

function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n: number,
  ratio = 0.4,
  cornerRadius = 0,
) {
  const pts = Math.max(3, Math.min(60, Math.round(n)));
  const inner = Math.max(0.05, Math.min(0.95, ratio));
  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < pts * 2; i++) {
    const a = (i * Math.PI) / pts - Math.PI / 2;
    const k = i % 2 === 0 ? 1 : inner;
    vertices.push({
      x: cx + Math.cos(a) * rx * k,
      y: cy + Math.sin(a) * ry * k,
    });
  }
  ctx.beginPath();
  const len = vertices.length;
  if (cornerRadius <= 0) {
    for (let i = 0; i < len; i++) {
      if (i === 0) ctx.moveTo(vertices[i].x, vertices[i].y);
      else ctx.lineTo(vertices[i].x, vertices[i].y);
    }
  } else {
    const cr = Math.min(cornerRadius, Math.min(rx, ry) * 0.4);
    for (let i = 0; i < len; i++) {
      const pPrev = vertices[(i - 1 + len) % len];
      const pCurr = vertices[i];
      const pNext = vertices[(i + 1) % len];
      if (i === 0) {
        ctx.moveTo((pPrev.x + pCurr.x) / 2, (pPrev.y + pCurr.y) / 2);
      }
      ctx.arcTo(pCurr.x, pCurr.y, pNext.x, pNext.y, cr);
    }
  }
  ctx.closePath();
}

function polyPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n: number,
  cornerRadius = 0,
) {
  ctx.beginPath();
  const pts = Math.max(3, Math.min(60, Math.round(n)));
  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < pts; i++) {
    const a = (i * 2 * Math.PI) / pts - Math.PI / 2;
    vertices.push({
      x: cx + Math.cos(a) * rx,
      y: cy + Math.sin(a) * ry,
    });
  }
  const len = vertices.length;
  if (cornerRadius <= 0) {
    for (let i = 0; i < len; i++) {
      if (i === 0) ctx.moveTo(vertices[i].x, vertices[i].y);
      else ctx.lineTo(vertices[i].x, vertices[i].y);
    }
  } else {
    const cr = Math.min(cornerRadius, Math.min(rx, ry) * 0.4);
    for (let i = 0; i < len; i++) {
      const pPrev = vertices[(i - 1 + len) % len];
      const pCurr = vertices[i];
      const pNext = vertices[(i + 1) % len];
      if (i === 0) {
        ctx.moveTo((pPrev.x + pCurr.x) / 2, (pPrev.y + pCurr.y) / 2);
      }
      ctx.arcTo(pCurr.x, pCurr.y, pNext.x, pNext.y, cr);
    }
  }
  ctx.closePath();
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  path: PathPoint[],
  ox: number,
  oy: number,
  z: number,
  closed: boolean,
) {
  ctx.beginPath();
  path.forEach((pt, i) => {
    const vx = ox + pt.x * z;
    const vy = oy + pt.y * z;
    if (i === 0) {
      ctx.moveTo(vx, vy);
      return;
    }
    const prev = path[i - 1];
    const has =
      (prev.ox && prev.ox !== 0) ||
      (prev.oy && prev.oy !== 0) ||
      (pt.ix && pt.ix !== 0) ||
      (pt.iy && pt.iy !== 0);
    if (has) {
      ctx.bezierCurveTo(
        ox + (prev.x + (prev.ox || 0)) * z,
        oy + (prev.y + (prev.oy || 0)) * z,
        ox + (pt.x + (pt.ix || 0)) * z,
        oy + (pt.y + (pt.iy || 0)) * z,
        vx,
        vy,
      );
    } else {
      ctx.lineTo(vx, vy);
    }
  });
  if (closed && path.length > 2) {
    const first = path[0];
    const last = path[path.length - 1];
    const has =
      (last.ox && last.ox !== 0) ||
      (last.oy && last.oy !== 0) ||
      (first.ix && first.ix !== 0) ||
      (first.iy && first.iy !== 0);
    if (has) {
      ctx.bezierCurveTo(
        ox + (last.x + (last.ox || 0)) * z,
        oy + (last.y + (last.oy || 0)) * z,
        ox + (first.x + (first.ix || 0)) * z,
        oy + (first.y + (first.iy || 0)) * z,
        ox + first.x * z,
        oy + first.y * z,
      );
    }
    ctx.closePath();
  }
}

function traceVectorSegments(
  ctx: CanvasRenderingContext2D,
  vn: VectorNetwork,
  ox: number,
  oy: number,
  z: number,
) {
  ctx.beginPath();
  for (const seg of vn.segments) {
    const v0 = vn.vertices[seg.start];
    const v1 = vn.vertices[seg.end];
    if (!v0 || !v1) continue;
    ctx.moveTo(ox + v0.x * z, oy + v0.y * z);
    if (seg.tangentStart || seg.tangentEnd) {
      ctx.bezierCurveTo(
        ox + (v0.x + (seg.tangentStart?.x || 0)) * z,
        oy + (v0.y + (seg.tangentStart?.y || 0)) * z,
        ox + (v1.x + (seg.tangentEnd?.x || 0)) * z,
        oy + (v1.y + (seg.tangentEnd?.y || 0)) * z,
        ox + v1.x * z,
        oy + v1.y * z,
      );
    } else {
      ctx.lineTo(ox + v1.x * z, oy + v1.y * z);
    }
  }
}

function traceVectorNetwork(
  ctx: CanvasRenderingContext2D,
  vn: VectorNetwork,
  ox: number,
  oy: number,
  z: number,
) {
  ctx.beginPath();
  if (vn.regions && vn.regions.length > 0) {
    for (const region of vn.regions) {
      for (const loop of region.loops) {
        if (!loop.length) continue;
        const v0 = vn.vertices[loop[0]];
        if (!v0) continue;
        ctx.moveTo(ox + v0.x * z, oy + v0.y * z);
        for (let i = 0; i < loop.length; i++) {
          const curIdx = loop[i];
          const nxtIdx = loop[(i + 1) % loop.length];
          const curV = vn.vertices[curIdx];
          const nxtV = vn.vertices[nxtIdx];
          const seg = vn.segments.find(
            (s) =>
              (s.start === curIdx && s.end === nxtIdx) ||
              (s.start === nxtIdx && s.end === curIdx),
          );
          if (seg && (seg.tangentStart || seg.tangentEnd)) {
            const isFwd = seg.start === curIdx;
            const tStart = isFwd ? seg.tangentStart : seg.tangentEnd;
            const tEnd = isFwd ? seg.tangentEnd : seg.tangentStart;
            ctx.bezierCurveTo(
              ox + (curV.x + (tStart?.x || 0)) * z,
              oy + (curV.y + (tStart?.y || 0)) * z,
              ox + (nxtV.x + (tEnd?.x || 0)) * z,
              oy + (nxtV.y + (tEnd?.y || 0)) * z,
              ox + nxtV.x * z,
              oy + nxtV.y * z,
            );
          } else {
            ctx.lineTo(ox + nxtV.x * z, oy + nxtV.y * z);
          }
        }
        ctx.closePath();
      }
    }
  } else {
    for (const seg of vn.segments) {
      const v0 = vn.vertices[seg.start];
      const v1 = vn.vertices[seg.end];
      if (!v0 || !v1) continue;
      ctx.moveTo(ox + v0.x * z, oy + v0.y * z);
      if (seg.tangentStart || seg.tangentEnd) {
        ctx.bezierCurveTo(
          ox + (v0.x + (seg.tangentStart?.x || 0)) * z,
          oy + (v0.y + (seg.tangentStart?.y || 0)) * z,
          ox + (v1.x + (seg.tangentEnd?.x || 0)) * z,
          oy + (v1.y + (seg.tangentEnd?.y || 0)) * z,
          ox + v1.x * z,
          oy + v1.y * z,
        );
      } else {
        ctx.lineTo(ox + v1.x * z, oy + v1.y * z);
      }
    }
  }
}


function paintText(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  z: number,
) {
  const textFill = fillStyle(ctx, n, sx, sy, sw, sh);
  const size = Math.max(1, n.fontSize * z);
  ctx.font = `${n.fontWeight} ${size}px ${n.fontFamily}, Inter, system-ui`;
  ctx.textBaseline = "top";
  ctx.textAlign = n.textAlign === "center" ? "center" : n.textAlign === "right" ? "right" : "left";
  const clipped = n.truncate;
  if (clipped) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();
  }
  let content = n.text;
  if (!content) {
    if (clipped) ctx.restore();
    return;
  }
  if (n.textCase === "upper" || n.textCase === "small-caps") content = content.toUpperCase();
  if (n.textCase === "lower") content = content.toLowerCase();
  if (n.textCase === "title") content = content.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
  const lh = Math.max(size, (n.lineHeight || n.fontSize * 1.2) * z);
  const ls = (n.letterSpacing || 0) * z;
  const paraGap = (n.paragraphSpacing || 0) * z;
  const wrap = n.sizingW !== "hug";
  const paras = content.split("\n");
  const indent = (n.paragraphIndent || 0) * z;
  type Row = { line: string; lastInPara: boolean; lead: number; marker: string };
  const rows: Row[] = [];
  const widthOfLine = (line: string) =>
    measureCached(ctx, line) + (ls ? ls * Math.max(0, line.length - 1) : 0);
  // A list hangs its marker in the gutter and shrinks the width the wrapper may
  // use; paragraphIndent then offsets the first line of each paragraph.
  paras.forEach((para, pi) => {
    const marker = listMarker(n.listStyle, pi);
    const gutter = marker ? widthOfLine(`${marker} `) : 0;
    const avail = wrap ? sw - gutter - indent : 1e6;
    let wrapped = wrapLines(ctx, para || " ", avail > 0 ? avail : 1e6, ls);
    // Wrap style only has something to say when the layer wraps: an
    // auto-width layer breaks a line exactly where Return was pressed.
    if (wrap && (n.textWrap === "balance" || n.textWrap === "pretty") && sw > 0)
      wrapped = balanceLines(wrapped, avail, widthOfLine, n.textWrap);
    wrapped.forEach((line, i) =>
      rows.push({
        line: para ? line : "",
        lastInPara: i === wrapped.length - 1,
        lead: gutter + (i === 0 ? indent : 0),
        marker: i === 0 && para ? marker : "",
      }),
    );
  });
  let lines = rows;
  if (n.truncate) {
    const limit = Math.max(1, n.maxLines || 1);
    if (lines.length > limit) {
      const clipped = lines.slice(0, limit);
      const last = clipped[clipped.length - 1];
      const widthOf = (s: string) =>
        measureCached(ctx, s) + (ls ? ls * Math.max(0, s.length - 1) : 0);
      const maxW = wrap ? sw : Infinity;
      let line = last.line;
      if (Number.isFinite(maxW)) {
        while (line && widthOf(`${line}…`) > maxW) line = line.slice(0, -1);
        line = `${line.replace(/\s+$/, "")}…`;
      } else {
        line = `${line}…`;
      }
      clipped[clipped.length - 1] = { ...last, line, lastInPara: true };
      lines = clipped;
    }
  }
  const blockH = lines.reduce((h, r) => h + lh + (r.lastInPara ? paraGap : 0), 0) - paraGap;
  let y0 = sy;
  if (n.textAlignVertical === "middle") y0 = sy + (sh - blockH) / 2;
  if (n.textAlignVertical === "bottom") y0 = sy + sh - blockH;
  const drop = (n.effects ?? []).find((e) => e.kind === "drop-shadow" && e.visible);
  if (drop) {
    const { r, g, b, a } = parseHex(drop.color);
    ctx.shadowColor = `rgba(${r},${g},${b},${a})`;
    ctx.shadowBlur = Math.max(0, drop.blur) * z;
    ctx.shadowOffsetX = drop.x * z;
    ctx.shadowOffsetY = drop.y * z;
  }
  let ty = y0;
  const fillOn = n.fillVisible !== false && !isNone(n.fill);
  const strokeOn = n.strokeVisible && n.strokeWidth > 0 && !isNone(n.strokePaint);
  const paintLine = (str: string, x: number, y: number, maxW?: number) => {
    if (fillOn) {
      ctx.save();
      ctx.fillStyle = textFill;
      ctx.globalAlpha *= n.fillOpacity ?? 1;
      ctx.fillText(str, x, y, maxW);
      ctx.restore();
    }
    if (strokeOn) {
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = cssRgba(n.strokePaint);
      ctx.globalAlpha *= n.strokeOpacity ?? 1;
      ctx.lineWidth = Math.max(0.5, n.strokeWidth * z);
      ctx.strokeText(str, x, y, maxW);
      ctx.restore();
    }
  };
  lines.forEach((row) => {
    const line = row.line;
    const left = sx + row.lead;
    const innerW = Math.max(0, sw - row.lead);
    if (row.marker) paintLine(row.marker, sx + (n.paragraphIndent || 0) * z, ty);
    const tx =
      n.textAlign === "center"
        ? left + innerW / 2
        : n.textAlign === "right"
          ? sx + sw
          : left;
    const justify = n.textAlign === "justified" && wrap && !row.lastInPara && line.includes(" ");
    if (justify) {
      const words = line.trim().split(/\s+/);
      const total = words.reduce((s, w) => s + measureCached(ctx, w), 0);
      const gap = words.length > 1 ? (innerW - total) / (words.length - 1) : 0;
      let x = left;
      ctx.textAlign = "left";
      for (const w of words) {
        paintLine(w, x, ty);
        x += measureCached(ctx, w) + gap;
      }
      ctx.textAlign = "left";
    } else if (ls) {
      let x = tx;
      if (n.textAlign === "center") x = tx - (measureCached(ctx, line) + ls * Math.max(0, line.length - 1)) / 2;
      if (n.textAlign === "right") x = tx - (measureCached(ctx, line) + ls * Math.max(0, line.length - 1));
      ctx.textAlign = "left";
      for (const ch of line) {
        paintLine(ch, x, ty);
        x += measureCached(ctx, ch) + ls;
      }
      ctx.textAlign = n.textAlign === "center" ? "center" : n.textAlign === "right" ? "right" : "left";
    } else {
      paintLine(line, tx, ty, wrap ? innerW : undefined);
    }
    if (fillOn && (n.textDecoration === "underline" || n.textDecoration === "strikethrough")) {
      const textWidth = measureCached(ctx, line) + ls * Math.max(0, line.length - 1);
      const yy = n.textDecoration === "underline" ? ty + size : ty + size / 2;
      const x0 = n.textAlign === "center" ? tx - textWidth / 2 : n.textAlign === "right" ? tx - textWidth : tx;
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.globalAlpha *= n.fillOpacity ?? 1;
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x0 + textWidth, yy);
      ctx.strokeStyle = cssRgba(n.fill);
      ctx.lineWidth = Math.max(1, z);
      ctx.stroke();
      ctx.restore();
    }
    ty += lh + (row.lastInPara ? paraGap : 0);
  });
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function walkInteractions(
  n: XNode,
  px: number,
  py: number,
  fn: (n: XNode, x: number, y: number, dest: string, ix: Interaction, isOverlay: boolean) => void,
) {
  const x = px + n.x;
  const y = py + n.y;
  for (const ix of n.interactions ?? []) {
    if (ix.destination) {
      const isOverlay = ix.action === "openOverlay" || ix.action === "swapOverlay";
      if (ix.action === "navigate" || isOverlay) {
        fn(n, x, y, ix.destination, ix, isOverlay);
      }
    }
  }
  for (const c of n.children) walkInteractions(c, x, y, fn);
}

function findClickedNoodle(
  root: XNode,
  wpt: { x: number; y: number },
  zoom: number,
): { srcId: string; destId: string; midX: number; midY: number; label: string } | null {
  let hit: { srcId: string; destId: string; midX: number; midY: number; label: string } | null = null;
  walkInteractions(root, 0, 0, (n, nx, ny, destId, ix) => {
    if (hit) return;
    const dest = worldPos(root, destId);
    if (!dest) return;
    const noodle = computeConnectorNoodle(nx, ny, n.w, n.h, dest.x, dest.y, dest.node.w, dest.node.h);
    for (let step = 0; step <= 16; step++) {
      const t = step / 16;
      const u = 1 - t;
      const px = u * u * u * noodle.ax + 3 * u * u * t * noodle.cp1x + 3 * u * t * t * noodle.cp2x + t * t * t * noodle.bx;
      const py = u * u * u * noodle.ay + 3 * u * u * t * noodle.cp1y + 3 * u * t * t * noodle.cp2y + t * t * t * noodle.by;
      if (Math.hypot(wpt.x - px, wpt.y - py) <= 12 / zoom) {
        const midX = (noodle.ax + noodle.bx) / 2;
        const midY = (noodle.ay + noodle.by) / 2;
        const trigLabel = ix.trigger === "onClick" ? "On click" : ix.trigger === "onHover" ? "While hovering" : "On drag";
        hit = { srcId: n.id, destId, midX, midY, label: `${trigLabel} → ${dest.node.name}` };
        break;
      }
    }
  });
  return hit;
}

/** Boolean raster cache: a boolean's composited mask+fill raster depends only
 *  on its own fields and its children, never on pan — so identical inputs
 *  share one offscreen (keyed by a picked-fields signature) instead of
 *  re-rasterizing every boolean every frame. Byte-bounded with LRU eviction;
 *  the old id-keyed map thrashed past 64 entries and re-fetched the 2D
 *  context per paint (7% of the live-edit profile). Strokes and drop-shadows
 *  stay live paint. */
const booleanRasters = new Map<string, { c: HTMLCanvasElement; bytes: number }>();
let booleanRasterBytes = 0;

/** One reused buffer for View > Pixel preview. Frames are resampled one at a
 *  time, so a single scratch canvas is enough. */
let pixelCanvas: HTMLCanvasElement | null = null;
function pixelScratch(w: number, h: number): HTMLCanvasElement {
  if (!pixelCanvas) pixelCanvas = document.createElement("canvas");
  if (pixelCanvas.width !== w || pixelCanvas.height !== h) {
    pixelCanvas.width = w;
    pixelCanvas.height = h;
  }
  return pixelCanvas;
}

function paintBoolean(
  ctx: CanvasRenderingContext2D,
  n: XNode,
  px: number,
  py: number,
  snap: Snapshot,
) {
  const z = snap.zoom;
  const w = Math.max(1, Math.ceil(n.w * z));
  const h = Math.max(1, Math.ceil(n.h * z));
  const kids = n.children.filter((c) => c.visible);
  if (!kids.length) return;
  // Every input of the raster below: zoom, op, box, the fill family, and the
  // visible children (positions are boolean-local, so pan-excluded). Only the
  // fields rasterizeBoolean/fillStyle/shapePoly actually read — a full-node
  // JSON here cost more than the rasterize it saved. If those readers ever
  // grow new inputs, this pick must grow with them.
  const sig = JSON.stringify([
    z.toFixed(4), n.booleanOp, w, h,
    n.fill, n.fillB, n.fillVisible, n.fillOpacity, n.fillType,
    n.fillGX, n.fillGY, n.fillHX, n.fillHY, n.gradientStops, n.fills,
    kids.map((c) => [c.x, c.y, c.w, c.h, c.rotation, c.flipH, c.flipV, c.visible, c.closed, c.kind,
      c.path, c.count, c.starRatio, c.cornerRadii, c.cornerIndependent, c.cornerSmoothing]),
  ]);
  let hit = booleanRasters.get(sig);
  if (hit) {
    booleanRasters.delete(sig);
    booleanRasters.set(sig, hit);
  } else if (w <= 2048 && h <= 2048) {
    const oc = document.createElement("canvas");
    oc.width = w;
    oc.height = h;
    const o = oc.getContext("2d");
    if (o) {
      rasterizeBoolean(o, n, kids, z, w, h);
      hit = { c: oc, bytes: w * h * 4 };
      booleanRasters.set(sig, hit);
      booleanRasterBytes += hit.bytes;
      while (booleanRasterBytes > 67108864 && booleanRasters.size > 1) {
        const oldest = booleanRasters.keys().next();
        if (oldest.done) break;
        const ev = booleanRasters.get(oldest.value);
        booleanRasters.delete(oldest.value);
        if (ev) booleanRasterBytes -= ev.bytes;
      }
    }
  }
  if (hit) {
    ctx.drawImage(hit.c, snap.panX + px * z, snap.panY + py * z);
    return;
  }
  // Unrasterizable (oversized / no context): live compositing, as before.
  const oc = document.createElement("canvas");
  oc.width = w;
  oc.height = h;
  const o = oc.getContext("2d");
  if (!o) return;
  rasterizeBoolean(o, n, kids, z, w, h);
  ctx.drawImage(oc, snap.panX + px * z, snap.panY + py * z);
}

/** Composite the children's mask and the boolean's fill into `o`. Pure of
 *  pan: everything is in boolean-local coordinates. */
function rasterizeBoolean(
  o: CanvasRenderingContext2D,
  n: XNode,
  kids: XNode[],
  z: number,
  w: number,
  h: number,
) {
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalAlpha = 1;
  o.globalCompositeOperation = "source-over";
  o.filter = "none";
  o.clearRect(0, 0, w, h);
  const draw = (c: XNode, op: GlobalCompositeOperation) => {
    o.globalCompositeOperation = op;
    o.save();
    const sx = c.x * z;
    const sy = c.y * z;
    const cx = sx + (c.w * z) / 2;
    const cy = sy + (c.h * z) / 2;
    if (c.rotation || c.flipH || c.flipV) {
      o.translate(cx, cy);
      if (c.rotation) o.rotate((c.rotation * Math.PI) / 180);
      if (c.flipH || c.flipV) o.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
      o.translate(-cx, -cy);
    }
    const path = shapePoly(c);
    tracePath(o, path, sx, sy, z, c.closed || (c.kind !== "line" && c.kind !== "arrow"));
    o.fillStyle = "#ffffff";
    o.fill();
    o.restore();
  };
  if (!kids.length) return;
  draw(kids[0], "source-over");
  for (let i = 1; i < kids.length; i++) {
    const op = n.booleanOp;
    if (op === "subtract") draw(kids[i], "destination-out");
    else if (op === "intersect") draw(kids[i], "destination-in");
    else if (op === "exclude") draw(kids[i], "xor");
    else draw(kids[i], "source-over");
  }
  o.globalCompositeOperation = "source-in";
  o.fillStyle = fillStyle(o, n, 0, 0, w, h);
  o.globalAlpha = n.fillVisible === false ? 0 : n.fillOpacity ?? 1;
  o.fillRect(0, 0, w, h);
}
